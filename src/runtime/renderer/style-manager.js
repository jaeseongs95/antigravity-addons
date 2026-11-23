'use strict';

/**
 * ShadowRoot-aware & Owner-Scoped CSS Style Manager (FV4 / D-R4-8 / TC-021 / TC-024).
 *
 * - Rejects dangerous CSS constructs (`@import`, `expression(`, `javascript:`,
 *   `behavior:`, `-moz-binding`, `</style`, `url(javascript:...)`, unicode escapes hiding them).
 * - Preserves `{ scope: 'owner' | 'global', slotId }` API contract.
 * - Restricts `scope: 'global'` strictly to trusted plugins.
 * - Routes styles into ShadowRoot (`<style>` inside ShadowRoot, compatible with strict CSP
 *   and mock DOMs) AND syncs owner styles automatically when Shadow slots mount later.
 */

const DANGEROUS_CSS_PATTERNS = [
  /@import\b/i,
  /expression\s*\(/i,
  /javascript\s*:/i,
  /vbscript\s*:/i,
  /-moz-binding\s*:/i,
  /behavior\s*:/i,
  /<\s*\/\s*style/i,
  /@charset\b/i,
];

const ALLOWED_OWNER_AT_RULES = new Set([
  '@media',
  '@supports',
  '@keyframes',
  '@-webkit-keyframes',
  '@layer',
]);

function stripCssComments(css) {
  // Always remove comments identically ('') so `@im/**/port` collapses to `@import` before checks
  let out = '';
  let quote = null;
  const s = String(css || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const next = s[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < s.length) {
        out += s[++i];
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function decodeCssEscapesForCheck(css) {
  // S-2: Strip comments AND CSS string line-continuations (`\<newline>`) before decoding hex/single-char escapes
  return stripCssComments(css)
    .replace(/\\(?:\r\n|[\r\n\f])/g, '')
    .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_m, hex) => {
      const cp = parseInt(hex, 16);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return '';
      try {
        return String.fromCodePoint(cp);
      } catch (_e) {
        return '';
      }
    })
    .replace(/\\([^\r\n\f0-9a-fA-F])/g, '$1');
}

function validateCssSyntaxBalanced(cssText) {
  let depth = 0;
  let quote = null;
  let inComment = false;
  for (let i = 0; i < cssText.length; i++) {
    const ch = cssText[i];
    const next = cssText[i + 1];
    if (inComment) {
      if (ch === '*' && next === '/') {
        inComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '\n' || ch === '\r' || ch === '\f') {
        return false; // unescaped newline/form-feed inside CSS string (CSS Syntax L3 bad-string token bypass)
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '*') {
      inComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth < 0) return false;
    }
  }
  return !quote && !inComment && depth === 0;
}

function validateSafeCssText(cssText, { scope = 'owner' } = {}) {
  if (typeof cssText !== 'string') {
    return { ok: false, reason: 'ERR_CSS_NOT_STRING' };
  }
  if (!validateCssSyntaxBalanced(cssText)) {
    return { ok: false, reason: 'ERR_FORBIDDEN_CSS_SYNTAX' };
  }
  const decoded = decodeCssEscapesForCheck(cssText);
  for (let i = 0; i < DANGEROUS_CSS_PATTERNS.length; i++) {
    if (DANGEROUS_CSS_PATTERNS[i].test(decoded) || DANGEROUS_CSS_PATTERNS[i].test(cssText)) {
      return { ok: false, reason: 'ERR_UNSAFE_CSS_CONSTRUCT' };
    }
  }
  if (scope === 'owner') {
    // S-2: Reject backslash escapes inside @-rule identifiers (prevents @\media / @\6d edia scoping bypass)
    const strippedRaw = stripCssComments(cssText);
    if (/@[^;{}\s"'()]*\\/.test(strippedRaw)) {
      return { ok: false, reason: 'ERR_FORBIDDEN_CSS_AT_RULE' };
    }
    // Enforce strict lowercased @-rule allowlist (rejects @scope, @property, @starting-style, @font-face, @container, etc.)
    const atMatches = decoded.match(/@[a-z-]+/gi) || [];
    for (let i = 0; i < atMatches.length; i++) {
      if (!ALLOWED_OWNER_AT_RULES.has(atMatches[i].toLowerCase())) {
        return { ok: false, reason: 'ERR_FORBIDDEN_CSS_AT_RULE' };
      }
    }
    // Reject sibling-combinator escape out of owner/body/root, :has() relational host-escape (including nested parens), and & sibling escapes
    if (/(?:\[data-addon-host-owner\s*=|\b(?:html|body|:root)\b)[^,{};]*[+~]/i.test(decoded)) {
      return { ok: false, reason: 'ERR_FORBIDDEN_CSS_SELECTOR' };
    }
    if (/(?:&[^;{}]*[+~]|:\s*has\s*\()/i.test(decoded)) {
      return { ok: false, reason: 'ERR_FORBIDDEN_CSS_NESTING' };
    }
  }
  return { ok: true };
}

function findNextTopLevelChar(str, startIdx, targetChar) {
  let quote = null;
  for (let i = startIdx; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === targetChar) return i;
  }
  return -1;
}

function findMatchingCloseBrace(str, openBraceIdx) {
  let depth = 1;
  let quote = null;
  for (let j = openBraceIdx + 1; j < str.length; j++) {
    const ch = str[j];
    if (quote) {
      if (ch === '\\') {
        j++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return str.length;
}

function scopeCssToOwner(cssText, pluginId) {
  const ownerPrefix = `[data-addon-host-owner="${String(pluginId).replace(/"/g, '\\"')}"]`;
  const clean = stripCssComments(cssText);
  let out = '';
  let i = 0;
  const len = clean.length;

  function prefixSelectorList(selList) {
    return selList
      .split(',')
      .map((s) => {
        const trimmed = s.trim();
        if (!trimmed) return '';
        if (trimmed.startsWith(':host')) return trimmed;
        // Only treat exact leading ownerPrefix as already rooted (NEVER `includes(ownerPrefix)` which allows `body:not([owner])`)
        if (trimmed === ownerPrefix || trimmed.startsWith(`${ownerPrefix} `) || trimmed.startsWith(`${ownerPrefix}>`) || trimmed.startsWith(`${ownerPrefix}.`) || trimmed.startsWith(`${ownerPrefix}#`) || trimmed.startsWith(`${ownerPrefix}:`)) {
          return trimmed;
        }
        if (/^(?:html|body|:root)\b/i.test(trimmed)) {
          return trimmed.replace(/^(?:html|body|:root)\b/i, ownerPrefix);
        }
        return `${ownerPrefix} ${trimmed}`;
      })
      .filter(Boolean)
      .join(', ');
  }

  while (i < len) {
    const braceIdx = findNextTopLevelChar(clean, i, '{');
    if (braceIdx === -1) {
      out += clean.slice(i);
      break;
    }
    // S-2: Split top-level `;`-terminated statements (e.g. `@layer a;`) before `{` so subsequent selectors are scoped
    const semiIdx = findNextTopLevelChar(clean, i, ';');
    if (semiIdx !== -1 && semiIdx < braceIdx) {
      out += clean.slice(i, semiIdx + 1);
      i = semiIdx + 1;
      continue;
    }
    const prelude = clean.slice(i, braceIdx);
    const closeIdx = findMatchingCloseBrace(clean, braceIdx);
    const body = clean.slice(braceIdx + 1, closeIdx);
    const lowerPrelude = prelude.trim().toLowerCase();
    if (lowerPrelude.startsWith('@media') || lowerPrelude.startsWith('@supports') || lowerPrelude.startsWith('@layer')) {
      out += `${prelude}{${scopeCssToOwner(body, pluginId)}}`;
    } else if (lowerPrelude.startsWith('@')) {
      out += `${prelude}{${body}}`;
    } else {
      out += `${prefixSelectorList(prelude)} {${body}}`;
    }
    i = closeIdx + 1;
  }
  return out;
}

function createStyleManager(doc) {
  const recordsByKey = new Map(); // `${pluginId}:${styleId}` -> { pluginId, styleId, scope, slotId, finalCss, headEl, shadowEls: Map<ShadowRoot, Element> }
  const shadowRootsByOwner = new Map(); // pluginId -> Map<slotId, Set<ShadowRoot>> (R-6d Ruling 1)

  function upsertStyleElement(parentNode, existingEl, pluginId, styleId, scope, finalCss) {
    if (!parentNode || typeof parentNode.appendChild !== 'function') return null;
    let el = existingEl;
    if (!el || !el.parentNode) {
      el = doc.createElement('style');
      el.setAttribute('data-addon-host-owner', pluginId);
      el.setAttribute('data-addon-host-style', `${pluginId}:${styleId}`);
      el.setAttribute('data-addon-host-style-scope', scope);
      parentNode.appendChild(el);
    }
    el.textContent = finalCss;
    return el;
  }

  function removeHeadStyle(rec) {
    if (rec && rec.headEl && rec.headEl.parentNode && typeof rec.headEl.parentNode.removeChild === 'function') {
      try {
        rec.headEl.parentNode.removeChild(rec.headEl);
      } catch (_e) {}
    }
    if (rec) rec.headEl = null;
  }

  function registerShadowRoot(pluginId, slotId, shadowRoot) {
    if (!shadowRoot) return;
    let map = shadowRootsByOwner.get(pluginId);
    if (!map) {
      map = new Map();
      shadowRootsByOwner.set(pluginId, map);
    }
    let srSet = map.get(slotId);
    if (!srSet) {
      srSet = new Set();
      map.set(slotId, srSet);
    }
    srSet.add(shadowRoot);
    // Sync all existing owner-scoped styles (and matching slotId styles) into this newly mounted ShadowRoot
    for (const rec of recordsByKey.values()) {
      if (rec.pluginId !== pluginId) continue;
      if (rec.slotId && rec.slotId !== slotId) continue;
      const el = upsertStyleElement(shadowRoot, rec.shadowEls.get(shadowRoot), pluginId, rec.styleId, rec.scope, rec.finalCss);
      if (el) rec.shadowEls.set(shadowRoot, el);
      // D-11: If this style was specifically targeted to this slotId and previously fell back to document.head, clean up headEl
      if (rec.slotId === slotId && rec.headEl) {
        removeHeadStyle(rec);
      }
    }
  }

  function unregisterShadowRoot(pluginId, slotId, shadowRoot = null) {
    const map = shadowRootsByOwner.get(pluginId);
    if (!map) return;
    const srSet = map.get(slotId);
    if (!srSet) return;
    const targets = shadowRoot ? (srSet.has(shadowRoot) ? [shadowRoot] : []) : Array.from(srSet);
    for (const sr of targets) {
      srSet.delete(sr);
      for (const rec of recordsByKey.values()) {
        if (rec.pluginId !== pluginId) continue;
        const el = rec.shadowEls.get(sr);
        if (el && el.parentNode && typeof el.parentNode.removeChild === 'function') {
          try {
            el.parentNode.removeChild(el);
          } catch (_e) {}
        }
        rec.shadowEls.delete(sr);
      }
    }
    if (srSet.size === 0) {
      map.delete(slotId);
    }
    if (map.size === 0) {
      shadowRootsByOwner.delete(pluginId);
    }
  }

  function injectStyle(pluginMeta, styleId, cssText, opts = {}) {
    const pluginId = pluginMeta.pluginId;
    if (!styleId || typeof styleId !== 'string') {
      throw new Error('ERR_INVALID_STYLE_ID');
    }
    const defaultScope =
      pluginMeta.trustLevel === 'trusted' && pluginMeta.hasDocumentTransformSlot ? 'global' : 'owner';
    const scope = opts && opts.scope ? String(opts.scope) : defaultScope;
    if (scope !== 'owner' && scope !== 'global') {
      throw new Error(`ERR_INVALID_STYLE_SCOPE:${scope}`);
    }
    if (scope === 'global' && pluginMeta.trustLevel !== 'trusted') {
      throw new Error('ERR_RESTRICTED_GLOBAL_CSS_FORBIDDEN');
    }

    const safeCheck = validateSafeCssText(cssText, { scope });
    if (!safeCheck.ok) {
      throw new Error(safeCheck.reason);
    }

    const slotId = opts && typeof opts.slotId === 'string' && opts.slotId ? opts.slotId : null;
    const finalCss = scope === 'global' ? cssText : scopeCssToOwner(cssText, pluginId);
    const key = `${pluginId}:${styleId}`;
    let rec = recordsByKey.get(key);
    if (!rec) {
      rec = { pluginId, styleId, scope, slotId, finalCss, headEl: null, shadowEls: new Map() };
      recordsByKey.set(key, rec);
    } else {
      rec.scope = scope;
      rec.slotId = slotId;
      rec.finalCss = finalCss;
    }

    const ownerShadows = shadowRootsByOwner.get(pluginId);
    const specificSet = slotId && ownerShadows ? ownerShadows.get(slotId) : null;
    const hasSpecificShadow = Boolean(specificSet && specificSet.size > 0);

    if (hasSpecificShadow) {
      // Targeted shadow slot(s): inject directly into every open ShadowRoot for this slotId (zero document.head pollution!)
      removeHeadStyle(rec);
      let firstEl = null;
      for (const sr of specificSet) {
        const el = upsertStyleElement(sr, rec.shadowEls.get(sr), pluginId, styleId, scope, finalCss);
        if (el) {
          rec.shadowEls.set(sr, el);
          if (!firstEl) firstEl = el;
        }
      }
      return firstEl;
    }

    // Inject into document.head (for light DOM / global / v1 slots) AND sync to any open owner ShadowRoots
    const head = doc.head || doc.documentElement || doc.body;
    rec.headEl = upsertStyleElement(head, rec.headEl, pluginId, styleId, scope, finalCss);
    if (ownerShadows && scope === 'owner') {
      for (const [sId, srSet] of ownerShadows.entries()) {
        if (slotId && slotId !== sId) continue;
        for (const sr of srSet) {
          const el = upsertStyleElement(sr, rec.shadowEls.get(sr), pluginId, styleId, scope, finalCss);
          if (el) rec.shadowEls.set(sr, el);
        }
      }
    }

    return rec.headEl;
  }

  function removeStyle(pluginId, styleId) {
    const key = `${pluginId}:${styleId}`;
    const rec = recordsByKey.get(key);
    if (!rec) return false;
    if (rec.headEl && rec.headEl.parentNode && typeof rec.headEl.parentNode.removeChild === 'function') {
      try {
        rec.headEl.parentNode.removeChild(rec.headEl);
      } catch (_e) {}
    }
    for (const el of rec.shadowEls.values()) {
      if (el && el.parentNode && typeof el.parentNode.removeChild === 'function') {
        try {
          el.parentNode.removeChild(el);
        } catch (_e) {}
      }
    }
    recordsByKey.delete(key);
    return true;
  }

  function disposePluginStyles(pluginId) {
    for (const [key, rec] of Array.from(recordsByKey.entries())) {
      if (rec.pluginId === pluginId) {
        removeStyle(pluginId, rec.styleId);
      }
    }
    shadowRootsByOwner.delete(pluginId);
  }

  return Object.freeze({
    registerShadowRoot,
    unregisterShadowRoot,
    injectStyle,
    removeStyle,
    disposePluginStyles,
  });
}

module.exports = {
  validateSafeCssText,
  scopeCssToOwner,
  createStyleManager,
};
