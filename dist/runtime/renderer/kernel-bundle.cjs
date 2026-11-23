'use strict';
// Auto-generated World 998 Renderer Kernel Bundle (zero external dependencies).
(function() {
  const __mods = {
  "./ignore-guard.js": function(module, exports, require) {
'use strict';

/**
 * Shadow-DOM-aware Ignore & No-Translate Guard (FV4 / D-R4-8 / TC-025).
 *
 * - Safely uses `evt.composedPath()` when available (handles real ShadowRoot events
 *   as well as mock unit-test events that omit `composedPath`).
 * - Walks across ShadowRoot host boundaries (`node.parentNode || node.host`).
 */

function isNodeIgnored(node, extraNoTranslateAttributes = [], ignoreElements = []) {
  const ignoreSet = new Set(Array.isArray(ignoreElements) ? ignoreElements : []);
  const extraAttrs = Array.isArray(extraNoTranslateAttributes) ? extraNoTranslateAttributes : [];
  let cur = node;
  let guard = 0;
  while (cur && guard < 128) {
    guard++;
    if (ignoreSet.has(cur)) return true;
    if (typeof cur.getAttribute === 'function') {
      if (
        cur.getAttribute('translate') === 'no' ||
        cur.getAttribute('data-addon-host-no-translate') === 'true' ||
        cur.getAttribute('data-addon-host-slot') !== null
      ) {
        return true;
      }
      for (let i = 0; i < extraAttrs.length; i++) {
        const attrVal = cur.getAttribute(extraAttrs[i]);
        if (attrVal !== null && attrVal !== 'false') return true;
      }
    }
    if (cur.parentNode) {
      cur = cur.parentNode;
    } else if (cur.host) {
      cur = cur.host;
    } else {
      break;
    }
  }
  return false;
}

function isElementInsideIgnored(nodeOrEvent, { extraNoTranslateAttributes = [], ignoreElements = [] } = {}) {
  if (!nodeOrEvent) return false;
  const ignoreSet = new Set(Array.isArray(ignoreElements) ? ignoreElements : []);

  // R-5: Distinguish DOM nodes (e.g. <a>, <form>, <area>, <base> which have a `.target` property) from Events
  const isDomNode = typeof nodeOrEvent.nodeType === 'number';
  if (!isDomNode && typeof nodeOrEvent === 'object' && ('target' in nodeOrEvent || typeof nodeOrEvent.composedPath === 'function')) {
    const pathNodes =
      typeof nodeOrEvent.composedPath === 'function'
        ? nodeOrEvent.composedPath()
        : nodeOrEvent.target
          ? [nodeOrEvent.target]
          : [];
    for (let i = 0; i < pathNodes.length; i++) {
      const n = pathNodes[i];
      if (!n) continue;
      if (ignoreSet.has(n)) return true;
      if (isNodeIgnored(n, extraNoTranslateAttributes, ignoreElements)) return true;
    }
    return false;
  }

  return isNodeIgnored(nodeOrEvent, extraNoTranslateAttributes, ignoreElements);
}

module.exports = {
  isNodeIgnored,
  isElementInsideIgnored,
};

  },
  "./style-manager.js": function(module, exports, require) {
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
      if (ch === '\n' || ch === '\r') {
        return false; // unescaped newline inside CSS string (bad-string token bypass)
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
    if (/(?:&\s*[+~]|:\s*has\s*\()/i.test(decoded)) {
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

  },
  "./slot-manager.js": function(module, exports, require) {
'use strict';

/**
 * UI Slot Manager — Option B2 Shadow DOM Contract (T-B, F3).
 *
 * - `mountSlot(pluginMeta, slotId, opts)`:
 *   - Enforces manifest slot ownership (`slotId` must be declared in `pluginMeta.uiSlots`).
 *   - Resolves `shadow` from normalized v2 manifest (`v1` defaults `false`, `v2` defaults `true`,
 *     `document-transform` ALWAYS `false`).
 *   - Option B2 (`shadow: true`): creates open `ShadowRoot` on host wrapper element and returns
 *     inner `<div class="addon-host-slot-root" data-addon-host-owner="...">` (`HTMLElement`),
 *     preserving `.style`/`.classList`/`.setAttribute()` while exposing `ShadowRoot` via `el.getRootNode()`.
 *   - Anchor miss: returns `null` (NEVER auto-opens ModalPortal!).
 */

function createSlotManager(doc, { uiAnchors = {}, extraNoTranslateAttributes = [], styleManager = null } = {}) {
  const mountedByKey = new Map(); // `${pluginId}:${slotId}` -> { hostEl, rootEl, shadowRoot, slotDef }

  function findSlotDef(pluginMeta, slotId) {
    const slots = Array.isArray(pluginMeta && pluginMeta.uiSlots) ? pluginMeta.uiSlots : [];
    return slots.find((s) => s && s.slotId === slotId) || null;
  }

  function resolveAnchorContainer(slotDef, opts = {}) {
    if (opts && opts.container) return opts.container;
    const anchorKey = (opts && opts.anchor) || (slotDef && slotDef.anchor) || (slotDef && slotDef.slot);
    if (anchorKey && uiAnchors && Array.isArray(uiAnchors[anchorKey])) {
      const selectors = uiAnchors[anchorKey];
      for (let i = 0; i < selectors.length; i++) {
        try {
          const found = typeof doc.querySelector === 'function' ? doc.querySelector(selectors[i]) : null;
          if (found) return found;
        } catch (_e) {}
      }
      // Anchor was explicitly defined in HostProfile but not present in current DOM -> return null!
      return null;
    }
    return opts && opts.fallbackToBody ? doc.body : null;
  }

  function applyNoTranslateAttrs(el, pluginMeta) {
    const noTranslate = !pluginMeta.isolation || pluginMeta.isolation.noTranslate !== false;
    if (!noTranslate) return;
    el.setAttribute('translate', 'no');
    el.setAttribute('data-addon-host-no-translate', 'true');
    for (let i = 0; i < extraNoTranslateAttributes.length; i++) {
      el.setAttribute(extraNoTranslateAttributes[i], 'true');
    }
  }

  function mountSlot(pluginMeta, slotId, opts = {}) {
    const slotDef = findSlotDef(pluginMeta, slotId);
    if (!slotDef) {
      throw new Error(`ERR_UNDECLARED_SLOT:${pluginMeta.pluginId}:${slotId}`);
    }

    const key = `${pluginMeta.pluginId}:${slotId}`;
    const existing = mountedByKey.get(key);
    if (existing && existing.hostEl) {
      // R-3: Check isConnected (fallback to parentNode for lightweight mocks) so React anchor unmount triggers clean remount
      const stillConnected =
        existing.hostEl.isConnected !== undefined
          ? Boolean(existing.hostEl.isConnected)
          : Boolean(existing.hostEl.parentNode);
      if (stillConnected) {
        return existing.rootEl;
      }
      if (existing.shadowRoot && styleManager) {
        styleManager.unregisterShadowRoot(pluginMeta.pluginId, slotId, existing.shadowRoot);
      }
      mountedByKey.delete(key);
    }

    const container = resolveAnchorContainer(slotDef, opts);
    if (!container || typeof container.appendChild !== 'function') {
      return null;
    }

    const ALLOWED_SLOT_TAGS = new Set(['div', 'span', 'section', 'aside', 'nav', 'header', 'footer']);
    const useShadow =
      slotDef.slot === 'document-transform'
        ? false
        : typeof opts.shadow === 'boolean' && (opts.shadow === true || pluginMeta.trustLevel === 'trusted' || !slotDef.shadow)
          ? opts.shadow
          : Boolean(slotDef.shadow);

    const requestedTag = typeof opts.tagName === 'string' ? opts.tagName.toLowerCase() : 'div';
    const safeTag = ALLOWED_SLOT_TAGS.has(requestedTag) ? requestedTag : 'div';
    const hostEl = doc.createElement(safeTag);
    hostEl.setAttribute('data-addon-host-owner', pluginMeta.pluginId);
    hostEl.setAttribute('data-addon-host-slot', slotId);
    hostEl.setAttribute('data-addon-host-slot-kind', slotDef.slot);
    applyNoTranslateAttrs(hostEl, pluginMeta);
    container.appendChild(hostEl);

    let rootEl = hostEl;
    let shadowRoot = null;

    if (useShadow && typeof hostEl.attachShadow === 'function') {
      shadowRoot = hostEl.attachShadow({ mode: 'open' });
      const inner = doc.createElement('div');
      inner.className = 'addon-host-slot-root';
      inner.setAttribute('data-addon-host-owner', pluginMeta.pluginId);
      inner.setAttribute('data-addon-host-slot', slotId);
      if (typeof shadowRoot.appendChild === 'function') {
        shadowRoot.appendChild(inner);
      }
      rootEl = inner;
      if (styleManager) {
        styleManager.registerShadowRoot(pluginMeta.pluginId, slotId, shadowRoot);
      }
    }

    mountedByKey.set(key, { hostEl, rootEl, shadowRoot, slotDef });
    return rootEl;
  }

  function unmountSlot(pluginId, slotId) {
    const key = `${pluginId}:${slotId}`;
    const rec = mountedByKey.get(key);
    if (!rec) {
      for (const existingKey of mountedByKey.keys()) {
        if (existingKey.endsWith(`:${slotId}`) && !existingKey.startsWith(`${pluginId}:`)) {
          throw new Error(`ERR_FORBIDDEN_CROSS_PLUGIN_UNMOUNT:${pluginId}:${slotId}`);
        }
      }
      return false;
    }
    if (rec.shadowRoot && styleManager) {
      styleManager.unregisterShadowRoot(pluginId, slotId, rec.shadowRoot);
    }
    if (rec.hostEl && rec.hostEl.parentNode && typeof rec.hostEl.parentNode.removeChild === 'function') {
      try {
        rec.hostEl.parentNode.removeChild(rec.hostEl);
      } catch (_e) {}
    }
    mountedByKey.delete(key);
    return true;
  }

  function disposePluginSlots(pluginId) {
    for (const [key, rec] of Array.from(mountedByKey.entries())) {
      if (key.startsWith(`${pluginId}:`)) {
        unmountSlot(pluginId, rec.slotDef.slotId);
      }
    }
  }

  return Object.freeze({
    mountSlot,
    unmountSlot,
    disposePluginSlots,
  });
}

module.exports = {
  createSlotManager,
};

  },
  "./modal-portal.js": function(module, exports, require) {
'use strict';

/**
 * Host Modal & Popover Portal Stack (FV4 / P1-5 / Option B2 / T-C).
 *
 * - Validates `openModal` slot kind is strictly `'modal'` or `'overlay'` (FV4 fix).
 * - Uses native `<dialog>.showModal()` + `popover="manual"` when available (with safe
 *   degradation for lightweight unit-test DOM mocks).
 * - Capture-phase `Escape` keydown listener + `<dialog>` `cancel` `preventDefault()` LIFO stack
 *   (empirically verified on Electron 45.4.1 `sendInputEvent('Escape')` in P1-5!).
 * - Option B2 `bodyEl`: `<div class="addon-host-slot-root">` inside `ShadowRoot` when `shadow !== false`.
 * - Applies `titleBarOverlay` safe top inset (`env(titlebar-area-height, 36px)`).
 * - Emits `onPortalClaimChange(claimId, active)` ONLY on stack `0 -> 1` and `1 -> 0` transitions.
 */

function isEventInsideElements(ev, elements) {
  if (!ev || !Array.isArray(elements) || elements.length === 0) return false;
  const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [ev.target];
  for (let i = 0; i < path.length; i++) {
    const node = path[i];
    if (!node) continue;
    for (let j = 0; j < elements.length; j++) {
      const target = elements[j];
      if (!target) continue;
      if (node === target) return true;
      if (typeof target.contains === 'function' && target.contains(node)) return true;
    }
  }
  return false;
}

function createModalPortal(
  doc,
  win,
  { extraNoTranslateAttributes = [], styleManager = null, onPortalClaimChange = () => {} } = {}
) {
  const stack = []; // LIFO: { id, kind: 'modal'|'popover', pluginId, slotId, el, bodyEl, shadowRoot, prevFocus, ignoreOutsideClickEls, onClose }
  let seq = 0;
  let globalListenersInstalled = false;

  function notifyPortalState(prevCount, nextCount) {
    if (prevCount === 0 && nextCount > 0) {
      try {
        onPortalClaimChange('host-modal-portal-stack', true);
      } catch (_e) {}
    } else if (prevCount > 0 && nextCount === 0) {
      try {
        onPortalClaimChange('host-modal-portal-stack', false);
      } catch (_e) {}
    }
  }

  function closeEntry(entry) {
    const idx = stack.indexOf(entry);
    if (idx === -1) return false;
    const prevCount = stack.length;
    stack.splice(idx, 1);

    if (entry.shadowRoot && styleManager) {
      styleManager.unregisterShadowRoot(entry.pluginId, entry.slotId, entry.shadowRoot);
    }
    try {
      if (entry.kind === 'modal' && typeof entry.el.close === 'function' && entry.el.open) {
        entry.el.close();
      } else if (entry.kind === 'popover' && typeof entry.el.hidePopover === 'function') {
        entry.el.hidePopover();
      }
    } catch (_e) {}

    if (entry.el && entry.el.parentNode && typeof entry.el.parentNode.removeChild === 'function') {
      try {
        entry.el.parentNode.removeChild(entry.el);
      } catch (_e) {}
    }
    if (entry.prevFocus && typeof entry.prevFocus.focus === 'function') {
      try {
        entry.prevFocus.focus();
      } catch (_e) {}
    }
    if (typeof entry.onClose === 'function') {
      try {
        entry.onClose();
      } catch (_e) {}
    }
    notifyPortalState(prevCount, stack.length);
    return true;
  }

  function closeTop() {
    if (stack.length === 0) return false;
    return closeEntry(stack[stack.length - 1]);
  }

  function ensureGlobalListeners() {
    if (globalListenersInstalled) return;
    globalListenersInstalled = true;

    if (win && typeof win.addEventListener === 'function') {
      // Capture-phase Escape intercepts BEFORE Chromium CloseWatcher closes underlying <dialog> (P1-5)
      win.addEventListener(
        'keydown',
        (ev) => {
          if (!ev || ev.key !== 'Escape' || stack.length === 0) return;
          // R-6c: Do not intercept CJK IME composition cancellation or already-handled Escape events
          if (ev.isComposing || ev.keyCode === 229 || ev.defaultPrevented) return;
          if (typeof ev.preventDefault === 'function') ev.preventDefault();
          if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
          closeTop();
        },
        true
      );
    }

    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener(
        'pointerdown',
        (ev) => {
          if (stack.length === 0) return;
          const top = stack[stack.length - 1];
          if (top.kind !== 'popover') return;
          const ignoreEls = [top.el, ...(top.ignoreOutsideClickEls || [])];
          if (isEventInsideElements(ev, ignoreEls)) {
            return;
          }
          closeEntry(top);
        },
        true
      );
    }
  }

  function findSlotDef(pluginMeta, slotId) {
    const slots = Array.isArray(pluginMeta && pluginMeta.uiSlots) ? pluginMeta.uiSlots : [];
    return slots.find((s) => s && s.slotId === slotId) || null;
  }

  function createSurfaceBody(el, pluginMeta, slotId, useShadow) {
    if (useShadow) {
      // WHATWG DOM: <dialog> cannot call attachShadow() directly; attach open ShadowRoot to an inner host <div>.
      const shadowHost =
        String(el.tagName || '').toLowerCase() === 'dialog'
          ? (() => {
              const wrap = doc.createElement('div');
              wrap.className = 'addon-host-modal-shadow-host';
              wrap.setAttribute('data-addon-host-owner', pluginMeta.pluginId);
              wrap.setAttribute('data-addon-host-slot', slotId);
              el.appendChild(wrap);
              return wrap;
            })()
          : el;
      if (typeof shadowHost.attachShadow === 'function') {
        const sr = shadowHost.attachShadow({ mode: 'open' });
        const inner = doc.createElement('div');
        inner.className = 'addon-host-slot-root';
        inner.setAttribute('data-addon-host-owner', pluginMeta.pluginId);
        inner.setAttribute('data-addon-host-slot', slotId);
        if (typeof sr.appendChild === 'function') sr.appendChild(inner);
        if (styleManager) styleManager.registerShadowRoot(pluginMeta.pluginId, slotId, sr);
        return { bodyEl: inner, shadowRoot: sr };
      }
    }
    return { bodyEl: el, shadowRoot: null };
  }

  function resolveUseShadow(pluginMeta, slotDef, opts = {}) {
    // R-6a: Match slot-manager.js shadow guard — restricted v2 plugins cannot downgrade shadow: true to false
    return typeof opts.shadow === 'boolean' && (opts.shadow === true || pluginMeta.trustLevel === 'trusted' || !slotDef.shadow)
      ? opts.shadow
      : Boolean(slotDef.shadow);
  }

  function openModal(pluginMeta, slotId, opts = {}) {
    const slotDef = findSlotDef(pluginMeta, slotId);
    if (!slotDef) {
      throw new Error(`ERR_UNDECLARED_SLOT:${pluginMeta.pluginId}:${slotId}`);
    }
    if (slotDef.slot !== 'modal' && slotDef.slot !== 'overlay') {
      throw new Error(`ERR_INVALID_MODAL_SLOT_KIND:${slotDef.slot}`);
    }

    ensureGlobalListeners();
    const prevCount = stack.length;
    const prevFocus = doc.activeElement || null;
    const dlg = doc.createElement('dialog');
    dlg.setAttribute('data-addon-host-modal-dialog', '1');
    dlg.setAttribute('data-addon-host-owner', pluginMeta.pluginId);
    dlg.setAttribute('data-addon-host-slot', slotId);
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('translate', 'no');
    dlg.setAttribute('data-addon-host-no-translate', 'true');
    for (let i = 0; i < extraNoTranslateAttributes.length; i++) {
      dlg.setAttribute(extraNoTranslateAttributes[i], 'true');
    }
    if (dlg.style) {
      dlg.style.marginTop = 'max(env(titlebar-area-height, 36px), 36px)';
      dlg.style.zIndex = String(2147483000 + stack.length + 1);
    }

    const useShadow = resolveUseShadow(pluginMeta, slotDef, opts);
    const { bodyEl, shadowRoot } = createSurfaceBody(dlg, pluginMeta, slotId, useShadow);

    const hostBody = doc.body || doc.documentElement;
    hostBody.appendChild(dlg);

    const entry = {
      id: `modal-${++seq}`,
      kind: 'modal',
      pluginId: pluginMeta.pluginId,
      slotId,
      el: dlg,
      bodyEl,
      shadowRoot,
      prevFocus,
      ignoreOutsideClickEls: Array.isArray(opts.ignoreOutsideClickEls) ? opts.ignoreOutsideClickEls : [],
      onClose: opts.onClose || null,
    };

    if (typeof dlg.addEventListener === 'function') {
      dlg.addEventListener('cancel', (ev) => {
        if (ev && ev.cancelable && typeof ev.preventDefault === 'function') {
          ev.preventDefault();
        }
        closeTop();
      });
      // R-6b: Sync stack if <dialog> is closed programmatically or via <form method="dialog">
      dlg.addEventListener('close', () => {
        closeEntry(entry);
      });
    }

    stack.push(entry);
    if (typeof dlg.showModal === 'function') {
      try {
        dlg.showModal();
      } catch (_e) {}
    }
    notifyPortalState(prevCount, stack.length);

    return Object.freeze({
      id: entry.id,
      element: dlg,
      bodyEl,
      close: () => closeEntry(entry),
    });
  }

  function openPopover(pluginMeta, slotId, opts = {}) {
    const slotDef = findSlotDef(pluginMeta, slotId);
    if (!slotDef) {
      throw new Error(`ERR_UNDECLARED_SLOT:${pluginMeta.pluginId}:${slotId}`);
    }
    if (slotDef.slot !== 'overlay' && slotDef.slot !== 'modal') {
      throw new Error(`ERR_INVALID_POPOVER_SLOT_KIND:${slotDef.slot}`);
    }

    ensureGlobalListeners();
    const prevCount = stack.length;
    const prevFocus = doc.activeElement || null;
    const pop = doc.createElement('div');
    pop.setAttribute('popover', 'manual');
    pop.setAttribute('data-addon-host-popover', '1');
    pop.setAttribute('data-addon-host-owner', pluginMeta.pluginId);
    pop.setAttribute('data-addon-host-slot', slotId);
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('translate', 'no');
    pop.setAttribute('data-addon-host-no-translate', 'true');
    for (let i = 0; i < extraNoTranslateAttributes.length; i++) {
      pop.setAttribute(extraNoTranslateAttributes[i], 'true');
    }
    if (pop.style) {
      pop.style.zIndex = String(2147483000 + stack.length + 1);
    }

    const useShadow = resolveUseShadow(pluginMeta, slotDef, opts);
    const { bodyEl, shadowRoot } = createSurfaceBody(pop, pluginMeta, slotId, useShadow);

    // R-2: Mount inside topmost open modal <dialog> when active so Chromium's modal inertness does not disable the popover
    let mountParent = doc.body || doc.documentElement;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].kind === 'modal' && stack[i].el && stack[i].el.isConnected !== false) {
        mountParent = stack[i].el;
        break;
      }
    }
    mountParent.appendChild(pop);

    const entry = {
      id: `popover-${++seq}`,
      kind: 'popover',
      pluginId: pluginMeta.pluginId,
      slotId,
      el: pop,
      bodyEl,
      shadowRoot,
      prevFocus,
      ignoreOutsideClickEls: Array.isArray(opts.ignoreOutsideClickEls) ? opts.ignoreOutsideClickEls : [],
      onClose: opts.onClose || null,
    };

    if (typeof pop.addEventListener === 'function') {
      // R-6b: Sync stack if popover is hidden externally via hidePopover()
      pop.addEventListener('toggle', (ev) => {
        if (ev && ev.newState === 'closed') {
          closeEntry(entry);
        }
      });
    }

    stack.push(entry);
    if (typeof pop.showPopover === 'function') {
      try {
        pop.showPopover();
      } catch (_e) {}
    }
    notifyPortalState(prevCount, stack.length);

    return Object.freeze({
      id: entry.id,
      element: pop,
      bodyEl,
      close: () => closeEntry(entry),
    });
  }

  function disposePluginPortals(pluginId) {
    for (const entry of stack.slice()) {
      if (entry.pluginId === pluginId) {
        closeEntry(entry);
      }
    }
  }

  return Object.freeze({
    openModal,
    openPopover,
    closeTop,
    disposePluginPortals,
    getStackSize: () => stack.length,
  });
}

module.exports = {
  createModalPortal,
};

  },
  "./region-observer.js": function(module, exports, require) {
'use strict';

/**
 * Throttled DOM Region Observer with automatic per-plugin disposal.
 */

function createRegionObserver(doc, win) {
  const observersByPlugin = new Map(); // pluginId -> Set<{ disconnect }>

  function observeRegion(pluginId, selector, callback, { debounceMs = 50 } = {}) {
    if (typeof callback !== 'function') throw new Error('ERR_OBSERVER_CALLBACK_REQUIRED');
    const MutationObs = (win && win.MutationObserver) || globalThis.MutationObserver;
    let timer = null;
    let disconnected = false;
    let lastMatch = null;

    const checkNow = () => {
      if (disconnected) return;
      let el = null;
      try {
        el = typeof doc.querySelector === 'function' ? doc.querySelector(selector) : null;
      } catch (_e) {
        return;
      }
      if (el && el !== lastMatch) {
        lastMatch = el;
        try {
          callback(el);
        } catch (_err) {}
      } else if (!el) {
        lastMatch = null;
      }
    };

    checkNow();

    let mo = null;
    if (typeof MutationObs === 'function' && (doc.body || doc.documentElement)) {
      mo = new MutationObs(() => {
        if (disconnected) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(checkNow, debounceMs);
      });
      try {
        mo.observe(doc.body || doc.documentElement, { childList: true, subtree: true });
      } catch (_e) {}
    }

    const handle = {
      disconnect() {
        disconnected = true;
        lastMatch = null;
        if (timer) clearTimeout(timer);
        if (mo && typeof mo.disconnect === 'function') {
          try {
            mo.disconnect();
          } catch (_e) {}
        }
        const ownerSet = observersByPlugin.get(pluginId);
        if (ownerSet) ownerSet.delete(handle);
      },
    };

    let set = observersByPlugin.get(pluginId);
    if (!set) {
      set = new Set();
      observersByPlugin.set(pluginId, set);
    }
    set.add(handle);
    return handle;
  }

  function disposePluginObservers(pluginId) {
    const set = observersByPlugin.get(pluginId);
    if (!set) return;
    for (const h of set) h.disconnect();
    observersByPlugin.delete(pluginId);
  }

  return Object.freeze({
    observeRegion,
    disposePluginObservers,
  });
}

module.exports = {
  createRegionObserver,
};

  },
  "./settings-tab-coordinator.js": function(module, exports, require) {
'use strict';

/**
 * Fail-Open Settings Tab Coordinator with per-plugin cleanup.
 */

function createSettingsTabCoordinator() {
  const tabsByPlugin = new Map(); // pluginId -> Map<tabId, { tabId, label, onSelect }>

  function registerSettingsTab(pluginId, tabId, { label, onSelect } = {}) {
    if (!tabId || typeof tabId !== 'string') throw new Error('ERR_INVALID_TAB_ID');
    let map = tabsByPlugin.get(pluginId);
    if (!map) {
      map = new Map();
      tabsByPlugin.set(pluginId, map);
    }
    map.set(tabId, { tabId, label: String(label || tabId), onSelect: typeof onSelect === 'function' ? onSelect : null });
    return {
      unregister() {
        map.delete(tabId);
      },
    };
  }

  function listTabs() {
    const out = [];
    for (const [pluginId, map] of tabsByPlugin.entries()) {
      for (const tab of map.values()) {
        out.push({ pluginId, tabId: tab.tabId, label: tab.label });
      }
    }
    return out;
  }

  function disposePluginTabs(pluginId) {
    tabsByPlugin.delete(pluginId);
  }

  return Object.freeze({
    registerSettingsTab,
    listTabs,
    disposePluginTabs,
  });
}

module.exports = {
  createSettingsTabCoordinator,
};

  },
  "./kernel.js": function(module, exports, require) {
'use strict';

/**
 * Isolated World 998 Renderer Kernel (v2.0.0 — T-A Option A1 + T-B Option B2).
 *
 * - Claims `window.__addonHostBootstrap.claim(cfg.claimNonce)` ONCE per document generation.
 * - Composes modular `ignore-guard`, `style-manager`, `slot-manager`, `modal-portal`,
 *   `region-observer`, and `settings-tab-coordinator`.
 * - Provides each plugin an isolated, capability-scoped `addonHost` API handle with
 *   deterministic `dispose()` cleanup.
 */

const { isElementInsideIgnored } = require('./ignore-guard');
const { createStyleManager } = require('./style-manager');
const { createSlotManager } = require('./slot-manager');
const { createModalPortal } = require('./modal-portal');
const { createRegionObserver } = require('./region-observer');
const { createSettingsTabCoordinator } = require('./settings-tab-coordinator');

function createRendererKernel(doc = globalThis.document, win = globalThis.window || globalThis) {
  let booted = false;
  let docGenId = 0;
  let hostToken = null;
  let hostBridge = null;
  let extraNoTranslateAttributes = [];
  let styleManager = null;
  let slotManager = null;
  let modalPortal = null;
  let regionObserver = null;
  let settingsTabs = null;

  const pluginDisposers = new Map(); // pluginId -> Set<Function>
  const pluginMarkDisposed = new Map(); // pluginId -> Set<Function>
  const pluginActions = new Map(); // pluginId -> Map<actionId, object>
  const stagedHandles = new Map(); // runNonce -> { pluginId, handle } (S-1 CSP-safe two-phase execution)
  const recordedErrors = [];
  let nonceSeq = 0;

  function generateRunNonce() {
    nonceSeq += 1;
    try {
      const cryptoObj = (win && win.crypto) || (typeof globalThis !== 'undefined' && globalThis.crypto);
      if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
        const bytes = new Uint8Array(16);
        cryptoObj.getRandomValues(bytes);
        let hex = '';
        for (let i = 0; i < bytes.length; i++) {
          hex += bytes[i].toString(16).padStart(2, '0');
        }
        return `rn-${nonceSeq}-${hex}`;
      }
    } catch (_e) {}
    return `rn-${nonceSeq}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }

  function assertHostToken(providedToken) {
    if (hostToken !== null && providedToken !== hostToken) {
      throw new Error('ERR_FORBIDDEN_HOST_TOKEN');
    }
  }

  function reportPluginError(pluginId, detail) {
    const entry = { pluginId: String(pluginId || 'unknown'), detail: String(detail || '') };
    recordedErrors.push(entry);
    if (recordedErrors.length > 200) recordedErrors.shift();
    if (hostBridge && typeof hostBridge.reportError === 'function') {
      try {
        hostBridge.reportError(entry.pluginId, entry.detail);
      } catch (_e) {}
    }
  }

  function boot(cfg = {}) {
    if (booted) {
      if (hostToken !== null && cfg.hostToken !== hostToken) {
        return { ok: false, reason: 'ERR_KERNEL_ALREADY_BOOTED' };
      }
      return { ok: true, alreadyBooted: true, docGenId };
    }
    if (typeof cfg.hostToken === 'string' && cfg.hostToken.length >= 16) {
      hostToken = cfg.hostToken;
    }
    docGenId = Number(cfg.docGenId) || 1;
    extraNoTranslateAttributes = Array.isArray(cfg.extraNoTranslateAttributes)
      ? cfg.extraNoTranslateAttributes.slice()
      : [];

    // T-A Option A1: claim preload bridge ONCE per document generation
    const bootstrap = win && win.__addonHostBootstrap;
    if (bootstrap && typeof bootstrap.claim === 'function' && cfg.claimNonce) {
      try {
        hostBridge = bootstrap.claim(cfg.claimNonce);
      } catch (err) {
        return {
          ok: false,
          reason: err && err.message ? err.message : 'ERR_BRIDGE_CLAIM_FAILED',
        };
      }
    }

    styleManager = createStyleManager(doc);
    slotManager = createSlotManager(doc, {
      uiAnchors: cfg.uiAnchors || {},
      extraNoTranslateAttributes,
      styleManager,
    });
    modalPortal = createModalPortal(doc, win, {
      extraNoTranslateAttributes,
      styleManager,
      onPortalClaimChange: (claimId, active) => {
        if (hostBridge && typeof hostBridge.setPortalClaim === 'function') {
          try {
            hostBridge.setPortalClaim(claimId, active);
          } catch (_e) {}
        }
      },
    });
    regionObserver = createRegionObserver(doc, win);
    settingsTabs = createSettingsTabCoordinator();
    booted = true;
    return { ok: true, alreadyBooted: false, docGenId, hasBridge: Boolean(hostBridge) };
  }

  function addPluginDisposer(pluginId, fn) {
    if (typeof fn !== 'function') return;
    let set = pluginDisposers.get(pluginId);
    if (!set) {
      set = new Set();
      pluginDisposers.set(pluginId, set);
    }
    set.add(fn);
  }

  function disposePluginInternal(pluginId) {
    const markers = pluginMarkDisposed.get(pluginId);
    if (markers) {
      for (const mark of Array.from(markers)) {
        try {
          mark();
        } catch (_e) {}
      }
      markers.clear();
      pluginMarkDisposed.delete(pluginId);
    }
    const set = pluginDisposers.get(pluginId);
    if (set) {
      for (const fn of Array.from(set)) {
        try {
          fn();
        } catch (err) {
          reportPluginError(pluginId, err && err.message ? err.message : String(err));
        }
      }
      set.clear();
      pluginDisposers.delete(pluginId);
    }
    if (slotManager) slotManager.disposePluginSlots(pluginId);
    if (styleManager) styleManager.disposePluginStyles(pluginId);
    if (modalPortal) modalPortal.disposePluginPortals(pluginId);
    if (regionObserver) regionObserver.disposePluginObservers(pluginId);
    if (settingsTabs) settingsTabs.disposePluginTabs(pluginId);
    pluginActions.delete(pluginId);
    return true;
  }

  function disposePlugin(pluginId, token) {
    assertHostToken(token);
    return disposePluginInternal(pluginId);
  }

  function createPluginHandle(pluginMeta, token) {
    assertHostToken(token);
    if (!booted) {
      throw new Error('ERR_KERNEL_NOT_BOOTED');
    }
    const pluginId = pluginMeta.pluginId;
    let disposed = false;

    let markers = pluginMarkDisposed.get(pluginId);
    if (!markers) {
      markers = new Set();
      pluginMarkDisposed.set(pluginId, markers);
    }
    markers.add(() => {
      disposed = true;
    });

    const assertActive = () => {
      if (disposed) throw new Error(`ERR_PLUGIN_HANDLE_DISPOSED:${pluginId}`);
    };

    const handle = Object.freeze({
      pluginId,
      version: pluginMeta.version || '0.0.0',
      trustLevel: pluginMeta.trustLevel || 'restricted',
      schemaVersion: 2,
      sourceSchemaVersion: pluginMeta.sourceSchemaVersion || 2,

      mountSlot(slotId, opts) {
        assertActive();
        return slotManager.mountSlot(pluginMeta, slotId, opts);
      },

      unmountSlot(slotId) {
        assertActive();
        return slotManager.unmountSlot(pluginId, slotId);
      },

      injectStyle(styleId, cssText, opts) {
        assertActive();
        return styleManager.injectStyle(pluginMeta, styleId, cssText, opts);
      },

      removeStyle(styleId) {
        assertActive();
        return styleManager.removeStyle(pluginId, styleId);
      },

      openModal(slotId, opts) {
        assertActive();
        return modalPortal.openModal(pluginMeta, slotId, opts);
      },

      openPopover(slotId, opts) {
        assertActive();
        return modalPortal.openPopover(pluginMeta, slotId, opts);
      },

      observeRegion(selector, callback, opts) {
        assertActive();
        return regionObserver.observeRegion(pluginId, selector, callback, opts);
      },

      registerSettingsTab(tabId, opts) {
        assertActive();
        return settingsTabs.registerSettingsTab(pluginId, tabId, opts);
      },

      registerAction(actionId, spec = {}) {
        assertActive();
        if (!actionId || typeof actionId !== 'string') throw new Error('ERR_INVALID_ACTION_ID');
        let map = pluginActions.get(pluginId);
        if (!map) {
          map = new Map();
          pluginActions.set(pluginId, map);
        }
        const entry = {
          pluginId,
          actionId,
          label: String(spec.label || actionId),
          run: typeof spec.run === 'function' ? spec.run : null,
        };
        map.set(actionId, entry);
        return Object.freeze({
          unregister() {
            map.delete(actionId);
          },
        });
      },

      listActions() {
        const out = [];
        for (const map of pluginActions.values()) {
          for (const a of map.values()) {
            out.push({ pluginId: a.pluginId, actionId: a.actionId, label: a.label });
          }
        }
        return out;
      },

      invokeAction(targetPluginId, actionId, ...args) {
        assertActive();
        const map = pluginActions.get(targetPluginId);
        const a = map && map.get(actionId);
        if (!a || !a.run) throw new Error(`ERR_ACTION_NOT_FOUND:${targetPluginId}:${actionId}`);
        return a.run(...args);
      },

      isElementInsideIgnored(nodeOrEvent, opts = {}) {
        return isElementInsideIgnored(nodeOrEvent, {
          extraNoTranslateAttributes,
          ignoreElements: (opts && opts.ignoreElements) || [],
        });
      },

      addManagedListener(target, type, listener, opts) {
        assertActive();
        if (!target || typeof target.addEventListener !== 'function') {
          throw new Error('ERR_INVALID_EVENT_TARGET');
        }
        const safeListener = (ev) => {
          if (disposed) return;
          try {
            const ret = listener(ev);
            if (ret && typeof ret.then === 'function') {
              ret.catch((err) => reportPluginError(pluginId, err && err.message ? err.message : String(err)));
            }
          } catch (err) {
            reportPluginError(pluginId, err && err.message ? err.message : String(err));
          }
        };
        target.addEventListener(type, safeListener, opts);
        const remove = () => {
          if (typeof target.removeEventListener === 'function') {
            try {
              target.removeEventListener(type, safeListener, opts);
            } catch (_e) {}
          }
        };
        addPluginDisposer(pluginId, remove);
        return remove;
      },

      runSafe(fn) {
        if (disposed || typeof fn !== 'function') return undefined;
        try {
          const ret = fn();
          if (ret && typeof ret.then === 'function') {
            return ret.catch((err) => {
              reportPluginError(pluginId, err && err.message ? err.message : String(err));
              return undefined;
            });
          }
          return ret;
        } catch (err) {
          reportPluginError(pluginId, err && err.message ? err.message : String(err));
          return undefined;
        }
      },

      onDispose(fn) {
        assertActive();
        addPluginDisposer(pluginId, fn);
      },

      dispose() {
        if (disposed) return;
        disposed = true;
        disposePluginInternal(pluginId);
      },
    });

    return handle;
  }

  function stagePluginHandle(pluginMeta, token) {
    assertHostToken(token);
    const handle = createPluginHandle(pluginMeta, token);
    const runNonce = generateRunNonce();
    stagedHandles.set(runNonce, { pluginId: pluginMeta.pluginId, handle });
    return { ok: true, runNonce };
  }

  function consumeStagedHandle(runNonce) {
    if (typeof runNonce !== 'string' || !stagedHandles.has(runNonce)) {
      throw new Error('ERR_INVALID_OR_CONSUMED_RUN_NONCE');
    }
    const entry = stagedHandles.get(runNonce);
    stagedHandles.delete(runNonce);
    return entry.handle;
  }

  function clearStagedHandle(runNonce, token) {
    assertHostToken(token);
    if (typeof runNonce !== 'string') return false;
    return stagedHandles.delete(runNonce);
  }

  const api = Object.freeze({
    boot,
    createPluginHandle,
    stagePluginHandle,
    consumeStagedHandle,
    clearStagedHandle,
    disposePlugin,
    reportPluginError,
    getErrors: () => recordedErrors.slice(),
    getBridgeStatus: () => ({ booted, docGenId, hasBridge: Boolean(hostBridge) }),
    listSettingsTabs: () => (settingsTabs ? settingsTabs.listTabs() : []),
  });

  return api;
}

if (typeof globalThis !== 'undefined' && typeof globalThis.document !== 'undefined') {
  if (!globalThis.__addonHostKernel) {
    Object.defineProperty(globalThis, '__addonHostKernel', {
      value: createRendererKernel(globalThis.document, globalThis.window || globalThis),
      writable: false,
      configurable: false,
      enumerable: false,
    });
  }
}

module.exports = {
  createRendererKernel,
};

  }
  };
  const __cache = Object.create(null);
  function __req(id) {
    const key = id.endsWith('.js') ? id : id + '.js';
    if (__cache[key]) return __cache[key].exports;
    const fn = __mods[key];
    if (!fn) throw new Error('ERR_KERNEL_BUNDLE_MISSING_MOD:' + key);
    const mod = { exports: {} };
    __cache[key] = mod;
    fn(mod, mod.exports, __req);
    return mod.exports;
  }
  const kernelMod = __req('./kernel.js');
  if (typeof globalThis !== 'undefined' && typeof globalThis.document !== 'undefined') {
    if (!globalThis.__addonHostKernel) {
      Object.defineProperty(globalThis, '__addonHostKernel', {
        value: kernelMod.createRendererKernel(globalThis.document, globalThis.window || globalThis),
        writable: false,
        configurable: false,
        enumerable: false,
      });
    }
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = kernelMod;
  }
})();
