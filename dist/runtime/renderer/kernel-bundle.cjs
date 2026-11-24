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

function preprocessCssInput(css) {
  // F4 (W3C CSS Syntax L3 §3.3): normalize CRLF -> LF, stray CR/FF -> LF, NUL -> U+FFFD
  return String(css || '')
    .replace(/\r\n/g, '\n')
    .replace(/[\r\f]/g, '\n')
    .replace(/\u0000/g, '\uFFFD');
}

function stripCssComments(css, replacement = ' ') {
  // F8: Default to `' '` (token separator) so `//**/*` NEVER coalesces into a live `/*` comment.
  // Callers checking keyword smuggling (`@im/**/port`) explicitly pass `''`.
  let out = '';
  let quote = null;
  const s = preprocessCssInput(css);
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
    // F6: Respect unquoted CSS backslash escapes so `\"` never desynchronizes quote state
    if (ch === '\\' && i + 1 < s.length) {
      out += ch + s[++i];
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
      out += replacement;
      continue;
    }
    out += ch;
  }
  return out;
}

function decodeCssEscapesRaw(s) {
  return preprocessCssInput(s)
    .replace(/\\\n/g, '')
    .replace(/\\([0-9a-fA-F]{1,6})[ \t\n]?/g, (_m, hex) => {
      const cp = parseInt(hex, 16);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return '';
      try {
        return String.fromCodePoint(cp);
      } catch (_e) {
        return '';
      }
    })
    .replace(/\\([^\n0-9a-fA-F])/g, '$1');
}

function decodeCssEscapesForCheck(css) {
  // S-2 + F4: Preprocess CRLF/CR/FF per CSS Syntax L3 §3.3, collapse comments (`''`) for `@im/**/port`, then decode escapes
  return decodeCssEscapesRaw(stripCssComments(preprocessCssInput(css), ''));
}

function decodeIdentEscapesForUrlCheck(css) {
  // F9: Decode ONLY ASCII ident escapes ([a-zA-Z0-9_-]) outside strings so hex quotes (\22/\27) NEVER synthesize string delimiters
  const s = preprocessCssInput(css);
  let out = '';
  let quote = null;
  let inComment = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const next = s[i + 1];
    if (inComment) {
      out += ch;
      if (ch === '*' && next === '/') {
        out += '/';
        inComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < s.length) {
        out += s[++i];
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '/*';
      inComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '\\') {
      const hexMatch = s.slice(i + 1).match(/^([0-9a-fA-F]{1,6})[ \t\n]?/);
      if (hexMatch) {
        const cp = parseInt(hexMatch[1], 16);
        const decodedCh = Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
        if (/^[a-zA-Z0-9_-]$/.test(decodedCh)) {
          out += decodedCh;
          i += hexMatch[0].length;
          continue;
        }
        out += ' ';
        i += hexMatch[0].length;
        continue;
      }
      if (i + 1 < s.length) {
        out += /^[a-zA-Z0-9_-]$/.test(next) ? next : ' ';
        i++;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function validateCssSyntaxBalanced(cssText) {
  const s = preprocessCssInput(cssText);
  // F11: Enforce full W3C CSS Syntax L3 LIFO block stack (`{}`, `()`, `[]`) and reject unquoted CDO/CDC (`<!--`/`-->`)
  const stack = [];
  let quote = null;
  let inComment = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const next = s[i + 1];
    if (inComment) {
      if (ch === '*' && next === '/') {
        inComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (ch === '\\') {
        if (i + 1 >= s.length) return false;
        i++;
        continue;
      }
      if (ch === '\n') {
        return false; // unescaped newline/CR/FF inside CSS string (CSS Syntax L3 bad-string token bypass)
      }
      if (ch === quote) quote = null;
      continue;
    }
    // F6: Respect unquoted backslash escapes (reject trailing EOF `\` or unquoted `\<newline>`)
    if (ch === '\\') {
      if (i + 1 >= s.length || next === '\n') return false;
      i++;
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
    if ((ch === '<' && s.slice(i, i + 4) === '<!--') || (ch === '-' && s.slice(i, i + 3) === '-->')) {
      return false;
    }
    if (ch === '{') stack.push('}');
    else if (ch === '(') stack.push(')');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ')' || ch === ']') {
      if (stack.length === 0 || stack[stack.length - 1] !== ch) return false;
      stack.pop();
    }
  }
  return !quote && !inComment && stack.length === 0;
}

const DANGEROUS_UNQUOTED_ESCAPED_CHARS = new Set([
  '"',
  "'",
  '{',
  '}',
  '(',
  ')',
  '[',
  ']',
  '/',
  '*',
  '\\',
  ';',
  ':',
  '@',
  ',',
  '+',
  '~',
  '>',
  '<',
]);

function hasDangerousUnquotedEscape(cssText) {
  // F6 + F9: Reject both literal (`\"`) and hex (`\22`, `\27`, `\2f`, `\7b`, etc.) unquoted escapes
  // that decode to syntax/delimiter/control characters.
  const s = preprocessCssInput(cssText);
  let quote = null;
  let inComment = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const next = s[i + 1];
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
    if (ch === '\\') {
      const hexMatch = s.slice(i + 1).match(/^([0-9a-fA-F]{1,6})[ \t\n]?/);
      if (hexMatch) {
        const cp = parseInt(hexMatch[1], 16);
        if (!Number.isFinite(cp) || cp <= 0x20 || cp === 0x7f || cp > 0x10ffff) return true;
        const decodedCh = String.fromCodePoint(cp);
        if (DANGEROUS_UNQUOTED_ESCAPED_CHARS.has(decodedCh)) return true;
        i += hexMatch[0].length;
        continue;
      }
      if (i + 1 >= s.length || next === '\n' || DANGEROUS_UNQUOTED_ESCAPED_CHARS.has(next)) {
        return true;
      }
      i++;
    }
  }
  return false;
}

function hasInvalidUnquotedUrlToken(str) {
  const s = preprocessCssInput(str);
  let quote = null;
  let inComment = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const next = s[i + 1];
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
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\') {
      i++;
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
    if (
      (ch === 'u' || ch === 'U') &&
      s.slice(i, i + 4).toLowerCase() === 'url(' &&
      (i === 0 || !/[a-z0-9_-]/i.test(s[i - 1]))
    ) {
      let k = i + 4;
      while (k < s.length && /\s/.test(s[k])) k++;
      if (k >= s.length) return true;
      if (s[k] === '"' || s[k] === "'") {
        i += 3;
        continue;
      }
      // F4: W3C CSS Syntax L3 §4.3.6 unquoted <url-token> — reject any <bad-url-token> / quote / brace desync chars
      let closed = false;
      for (; k < s.length; k++) {
        const c = s[k];
        if (c === ')') {
          closed = true;
          break;
        }
        if (/\s/.test(c)) {
          while (k < s.length && /\s/.test(s[k])) k++;
          if (k < s.length && s[k] === ')') {
            closed = true;
            break;
          }
          return true; // whitespace-split remnant inside unquoted url(...)
        }
        const code = c.charCodeAt(0);
        // F10: Also reject `/*` inside unquoted url(...) so comment stripping cannot desync from CSS Syntax L3 §4.3.6
        if (
          (c === '/' && s[k + 1] === '*') ||
          c === '"' ||
          c === "'" ||
          c === '(' ||
          c === '\\' ||
          c === '{' ||
          c === '}' ||
          code <= 0x1f ||
          code === 0x7f
        ) {
          return true;
        }
      }
      if (!closed) return true;
      i = k;
    }
  }
  return false;
}

function splitTopLevelSelectorList(selList) {
  // F7 + F11: Split on top-level commas ONLY (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0, quote & backslash safe)
  const out = [];
  let start = 0;
  let quote = null;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  for (let i = 0; i < selList.length; i++) {
    const ch = selList[i];
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(') parenDepth++;
    else if (ch === ')' && parenDepth > 0) parenDepth--;
    else if (ch === '[') bracketDepth++;
    else if (ch === ']' && bracketDepth > 0) bracketDepth--;
    else if (ch === '{') braceDepth++;
    else if (ch === '}' && braceDepth > 0) braceDepth--;
    else if (ch === ',' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      out.push(selList.slice(start, i));
      start = i + 1;
    }
  }
  out.push(selList.slice(start));
  return out;
}

function getFirstTopLevelCombinator(selector) {
  // F7 + F11: Return the first top-level combinator ('+', '~', '>', ' ') outside quotes/parens/brackets/braces
  const s = selector.trim();
  let quote = null;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let sawSpace = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\') {
      if (sawSpace && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) return ' ';
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (sawSpace && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) return ' ';
      quote = ch;
      continue;
    }
    if (ch === '(') {
      if (sawSpace && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) return ' ';
      parenDepth++;
      continue;
    }
    if (ch === ')' && parenDepth > 0) {
      parenDepth--;
      continue;
    }
    if (ch === '[') {
      if (sawSpace && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) return ' ';
      bracketDepth++;
      continue;
    }
    if (ch === ']' && bracketDepth > 0) {
      bracketDepth--;
      continue;
    }
    if (ch === '{') {
      if (sawSpace && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) return ' ';
      braceDepth++;
      continue;
    }
    if (ch === '}' && braceDepth > 0) {
      braceDepth--;
      continue;
    }
    if (parenDepth > 0 || bracketDepth > 0 || braceDepth > 0) continue;
    if (/\s/.test(ch)) {
      sawSpace = true;
      continue;
    }
    if (ch === '+' || ch === '~' || ch === '>') {
      return ch;
    }
    if (sawSpace) {
      return ' ';
    }
  }
  return null;
}

function hasForbiddenOwnerSiblingSelector(cleanCss) {
  let i = 0;
  const len = cleanCss.length;
  while (i < len) {
    const braceIdx = findNextTopLevelChar(cleanCss, i, '{');
    if (braceIdx === -1) break;
    const semiIdx = findNextTopLevelChar(cleanCss, i, ';');
    if (semiIdx !== -1 && semiIdx < braceIdx) {
      i = semiIdx + 1;
      continue;
    }
    const prelude = cleanCss.slice(i, braceIdx);
    const closeIdx = findMatchingCloseBrace(cleanCss, braceIdx);
    const body = cleanCss.slice(braceIdx + 1, closeIdx);
    const lowerPrelude = prelude.trim().toLowerCase();
    if (lowerPrelude.startsWith('@media') || lowerPrelude.startsWith('@supports') || lowerPrelude.startsWith('@layer')) {
      if (hasForbiddenOwnerSiblingSelector(body)) return true;
    } else if (!lowerPrelude.startsWith('@')) {
      const selectors = splitTopLevelSelectorList(prelude);
      for (let sIdx = 0; sIdx < selectors.length; sIdx++) {
        const trimmed = selectors[sIdx].trim();
        if (!trimmed) continue;
        if (trimmed[0] === '+' || trimmed[0] === '~') return true;
        if (/^(?:\[\s*data-addon-host-owner\b|(?:html|body|:root)(?![a-z0-9_-]))/i.test(trimmed)) {
          const firstComb = getFirstTopLevelCombinator(trimmed);
          if (firstComb === '+' || firstComb === '~') return true;
        }
      }
    }
    i = closeIdx + 1;
  }
  return false;
}

function hasForbiddenOwnerNesting(cleanCss, inKeyframes = false) {
  let i = 0;
  const len = cleanCss.length;
  while (i < len) {
    const braceIdx = findNextTopLevelChar(cleanCss, i, '{');
    if (braceIdx === -1) break;
    const semiIdx = findNextTopLevelChar(cleanCss, i, ';');
    if (semiIdx !== -1 && semiIdx < braceIdx) {
      i = semiIdx + 1;
      continue;
    }
    const prelude = cleanCss.slice(i, braceIdx).trim().toLowerCase();
    const closeIdx = findMatchingCloseBrace(cleanCss, braceIdx);
    const body = cleanCss.slice(braceIdx + 1, closeIdx);
    if (inKeyframes) {
      if (findNextTopLevelChar(body, 0, '{') !== -1) return true;
    } else if (prelude.startsWith('@media') || prelude.startsWith('@supports') || prelude.startsWith('@layer')) {
      if (hasForbiddenOwnerNesting(body, false)) return true;
    } else if (prelude.startsWith('@keyframes') || prelude.startsWith('@-webkit-keyframes')) {
      if (hasForbiddenOwnerNesting(body, true)) return true;
    } else {
      // F5: Structurally disallow CSS Nesting Level 1 (`{` inside any non-@ style rule body) in owner scope
      if (findNextTopLevelChar(body, 0, '{') !== -1) return true;
    }
    i = closeIdx + 1;
  }
  return false;
}

function validateSafeCssText(cssText, { scope = 'owner' } = {}) {
  if (typeof cssText !== 'string') {
    return { ok: false, reason: 'ERR_CSS_NOT_STRING' };
  }
  const normalized = preprocessCssInput(cssText);
  const strippedSpace = stripCssComments(normalized, ' ');
  // F8: Verify BOTH pre-strip and space-stripped CSS are syntax-balanced (blocks `//**/*` comment synthesis)
  if (!validateCssSyntaxBalanced(normalized) || !validateCssSyntaxBalanced(strippedSpace)) {
    return { ok: false, reason: 'ERR_FORBIDDEN_CSS_SYNTAX' };
  }
  const decoded = decodeCssEscapesForCheck(normalized);
  // F10: Also check escape-decoded text WITHOUT comment stripping so unquoted `url(http://x/*)` cannot mask escaped keywords
  const decodedNoStrip = decodeCssEscapesRaw(normalized);
  for (let i = 0; i < DANGEROUS_CSS_PATTERNS.length; i++) {
    if (
      DANGEROUS_CSS_PATTERNS[i].test(decoded) ||
      DANGEROUS_CSS_PATTERNS[i].test(decodedNoStrip) ||
      DANGEROUS_CSS_PATTERNS[i].test(normalized)
    ) {
      return { ok: false, reason: 'ERR_UNSAFE_CSS_CONSTRUCT' };
    }
  }
  // F4 + F6 + F9 + F10: Reject unquoted <bad-url-token> (using ident-only decode so \22/\27 never open fake quotes),
  // unquoted `url(.../*...)`, and dangerous literal/hex unquoted escapes.
  const identDecoded = decodeIdentEscapesForUrlCheck(normalized);
  if (
    hasInvalidUnquotedUrlToken(normalized) ||
    hasInvalidUnquotedUrlToken(strippedSpace) ||
    hasInvalidUnquotedUrlToken(identDecoded) ||
    hasDangerousUnquotedEscape(normalized)
  ) {
    return { ok: false, reason: 'ERR_FORBIDDEN_CSS_SYNTAX' };
  }
  if (scope === 'owner') {
    // S-2: Reject backslash escapes inside @-rule identifiers (prevents @\media / @\6d edia scoping bypass)
    const strippedCollapsed = stripCssComments(normalized, '');
    if (/@[^;{}\s"'()]*\\/.test(strippedSpace) || /@[^;{}\s"'()]*\\/.test(strippedCollapsed)) {
      return { ok: false, reason: 'ERR_FORBIDDEN_CSS_AT_RULE' };
    }
    // Enforce strict lowercased @-rule allowlist (rejects @scope, @property, @starting-style, @font-face, @container, etc.)
    const atMatches = decoded.match(/@[a-z-]+/gi) || [];
    for (let i = 0; i < atMatches.length; i++) {
      if (!ALLOWED_OWNER_AT_RULES.has(atMatches[i].toLowerCase())) {
        return { ok: false, reason: 'ERR_FORBIDDEN_CSS_AT_RULE' };
      }
    }
    // F7: Paren/bracket-aware sibling-combinator escape check out of owner/body/root (blocks `:is(*, .x) ~ *`)
    if (hasForbiddenOwnerSiblingSelector(strippedSpace) || hasForbiddenOwnerSiblingSelector(decoded)) {
      return { ok: false, reason: 'ERR_FORBIDDEN_CSS_SELECTOR' };
    }
    if (
      /(?:&[^;{}]*[+~]|:\s*has\s*\()/i.test(decoded) ||
      hasForbiddenOwnerNesting(strippedSpace) ||
      hasForbiddenOwnerNesting(decoded)
    ) {
      return { ok: false, reason: 'ERR_FORBIDDEN_CSS_NESTING' };
    }
  }
  return { ok: true };
}

function findNextTopLevelChar(str, startIdx, targetChar) {
  // F11: Match targetChar ONLY at top level (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0)
  let quote = null;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
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
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && ch === targetChar) {
      return i;
    }
    if (ch === '(') parenDepth++;
    else if (ch === ')' && parenDepth > 0) parenDepth--;
    else if (ch === '[') bracketDepth++;
    else if (ch === ']' && bracketDepth > 0) bracketDepth--;
    else if (ch === '{') braceDepth++;
    else if (ch === '}' && braceDepth > 0) braceDepth--;
  }
  return -1;
}

function findMatchingCloseBrace(str, openBraceIdx) {
  // F11: Track parenDepth & bracketDepth so braces inside `(...)` or `[...]` never desync block matching
  let depth = 1;
  let parenDepth = 0;
  let bracketDepth = 0;
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
    if (ch === '\\') {
      j++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(') {
      parenDepth++;
      continue;
    }
    if (ch === ')' && parenDepth > 0) {
      parenDepth--;
      continue;
    }
    if (ch === '[') {
      bracketDepth++;
      continue;
    }
    if (ch === ']' && bracketDepth > 0) {
      bracketDepth--;
      continue;
    }
    if (parenDepth === 0 && bracketDepth === 0) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return j;
      }
    }
  }
  return str.length;
}

function scopeCssToOwner(cssText, pluginId) {
  const ownerPrefix = `[data-addon-host-owner="${String(pluginId).replace(/"/g, '\\"')}"]`;
  // F8: Replace comments with a token-separating space (' ') so emitted CSS can NEVER synthesize `/*`
  const clean = stripCssComments(preprocessCssInput(cssText), ' ');
  let out = '';
  let i = 0;
  const len = clean.length;

  function prefixSelectorList(selList) {
    return splitTopLevelSelectorList(selList)
      .map((s) => {
        const trimmed = s.trim();
        if (!trimmed) return '';
        if (trimmed.startsWith(':host')) return trimmed;
        // Only treat exact leading ownerPrefix as already rooted (NEVER `includes(ownerPrefix)` which allows `body:not([owner])`)
        if (
          trimmed === ownerPrefix ||
          trimmed.startsWith(`${ownerPrefix} `) ||
          trimmed.startsWith(`${ownerPrefix}>`) ||
          trimmed.startsWith(`${ownerPrefix}.`) ||
          trimmed.startsWith(`${ownerPrefix}#`) ||
          trimmed.startsWith(`${ownerPrefix}:`) ||
          trimmed.startsWith(`${ownerPrefix}[`)
        ) {
          return trimmed;
        }
        if (/^(?:html|body|:root)(?![a-z0-9_-])/i.test(trimmed)) {
          return trimmed.replace(/^(?:html|body|:root)(?![a-z0-9_-])/i, ownerPrefix);
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
  "./surface-geometry.js": function(module, exports, require) {
'use strict';

/**
 * Vendor-neutral Per-Surface Content Bounds & Center-Point Geometry Engine (v2.4.0 — SOLID #0).
 *
 * - ZERO vendor/app-specific literals: every surface selector, priority, chrome-exclusion
 *   selector, and safe inset comes declaratively from `HostProfile.uiSurfaces` / `uiAnchors`.
 * - Ignores addon-host modal/popover portals (`[data-addon-host-modal-dialog]`,
 *   `[data-addon-host-popover]`) so open plugin overlays never distort host surface measurements.
 * - Resolution order per surface:
 *   1. Direct visible container matching `selectors` (`source: 'selector'`).
 *   2. Viewport minus visible edge chrome matching `exclude{Left,Right,Top,Bottom}Selectors`
 *      (`source: 'chrome-subtracted'`).
 *   3. Safe viewport fallback (`source: 'viewport'`).
 * - Always returns finite, viewport-clamped, deep-frozen coordinates including `centerX`,
 *   `centerY`, bounding box (`left/top/right/bottom/width/height`), and CSS fixed insets
 *   (`insetLeft/insetTop/insetRight/insetBottom`).
 */

const _ObjectFreeze = Object.freeze;
const _ObjectKeys = Object.keys;
const _ArrayIsArray = Array.isArray;
const _Number = Number;
const _NumberIsFinite = Number.isFinite;
const _MathMax = Math.max;
const _MathMin = Math.min;
const _MathRound = Math.round;

const EDGE_TOUCH_TOLERANCE_PX = 12;

function toNonNegativeNumber(value, fallback = 0) {
  const n = _Number(value);
  return _NumberIsFinite(n) && n >= 0 ? n : fallback;
}

function roundCoord(value) {
  return _MathRound(value * 100) / 100;
}

function normalizeStringList(list) {
  if (!_ArrayIsArray(list)) return [];
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const s = list[i];
    if (typeof s === 'string' && s.trim()) {
      out.push(s.trim());
    }
  }
  return out;
}

function normalizeSafeInsets(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return _ObjectFreeze({
    top: toNonNegativeNumber(src.top, 0),
    right: toNonNegativeNumber(src.right, 0),
    bottom: toNonNegativeNumber(src.bottom, 0),
    left: toNonNegativeNumber(src.left, 0),
  });
}

function createSurfaceGeometry(doc, win, { uiSurfaces = {}, uiAnchors = {} } = {}) {
  const surfaceSpecs = new Map();
  const orderedIds = [];

  if (uiSurfaces && typeof uiSurfaces === 'object') {
    const keys = _ObjectKeys(uiSurfaces);
    for (let i = 0; i < keys.length; i += 1) {
      const id = keys[i];
      if (!id || id === 'viewport' || id === 'auto' || id === 'active') continue;
      const raw = uiSurfaces[id];
      if (!raw || typeof raw !== 'object' || _ArrayIsArray(raw)) continue;
      const anchorFallback = uiAnchors && _ArrayIsArray(uiAnchors[id]) ? uiAnchors[id] : [];
      const selectors = normalizeStringList(raw.selectors);
      const mergedSelectors = selectors.length > 0 ? selectors : normalizeStringList(anchorFallback);
      const spec = _ObjectFreeze({
        id,
        priority: _NumberIsFinite(_Number(raw.priority)) ? _Number(raw.priority) : 0,
        selectors: _ObjectFreeze(mergedSelectors),
        excludeLeftSelectors: _ObjectFreeze(normalizeStringList(raw.excludeLeftSelectors)),
        excludeRightSelectors: _ObjectFreeze(normalizeStringList(raw.excludeRightSelectors)),
        excludeTopSelectors: _ObjectFreeze(normalizeStringList(raw.excludeTopSelectors)),
        excludeBottomSelectors: _ObjectFreeze(normalizeStringList(raw.excludeBottomSelectors)),
        safeInsets: normalizeSafeInsets(raw.safeInsets),
      });
      surfaceSpecs.set(id, spec);
      orderedIds.push(id);
    }
  }

  // Sort surfaces by priority descending (stable tie-break by id)
  orderedIds.sort((a, b) => {
    const pa = surfaceSpecs.get(a).priority;
    const pb = surfaceSpecs.get(b).priority;
    if (pb !== pa) return pb - pa;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  // Compute default viewport safeInsets from the highest-priority declared surface if any
  let defaultSafeTop = 0;
  let defaultSafeRight = 0;
  let defaultSafeBottom = 0;
  let defaultSafeLeft = 0;
  for (let i = 0; i < orderedIds.length; i += 1) {
    const s = surfaceSpecs.get(orderedIds[i]).safeInsets;
    if (s.top > defaultSafeTop) defaultSafeTop = s.top;
    if (s.right > defaultSafeRight) defaultSafeRight = s.right;
    if (s.bottom > defaultSafeBottom) defaultSafeBottom = s.bottom;
    if (s.left > defaultSafeLeft) defaultSafeLeft = s.left;
  }
  const defaultSafeInsets = _ObjectFreeze({
    top: defaultSafeTop,
    right: defaultSafeRight,
    bottom: defaultSafeBottom,
    left: defaultSafeLeft,
  });

  function getViewportSize() {
    const docEl = doc && doc.documentElement ? doc.documentElement : null;
    const w =
      win && _NumberIsFinite(_Number(win.innerWidth)) && _Number(win.innerWidth) > 0
        ? _Number(win.innerWidth)
        : docEl && _NumberIsFinite(_Number(docEl.clientWidth)) && _Number(docEl.clientWidth) > 0
          ? _Number(docEl.clientWidth)
          : 0;
    const h =
      win && _NumberIsFinite(_Number(win.innerHeight)) && _Number(win.innerHeight) > 0
        ? _Number(win.innerHeight)
        : docEl && _NumberIsFinite(_Number(docEl.clientHeight)) && _Number(docEl.clientHeight) > 0
          ? _Number(docEl.clientHeight)
          : 0;
    return { width: w, height: h };
  }

  function isInsideAddonPortal(el) {
    if (!el) return false;
    if (typeof el.closest === 'function') {
      try {
        if (el.closest('[data-addon-host-modal-dialog]') || el.closest('[data-addon-host-popover]')) {
          return true;
        }
      } catch (_e) {}
    }
    let cur = el;
    let guard = 0;
    while (cur && guard < 64) {
      guard += 1;
      if (typeof cur.getAttribute === 'function') {
        try {
          if (cur.getAttribute('data-addon-host-modal-dialog') || cur.getAttribute('data-addon-host-popover')) {
            return true;
          }
        } catch (_e) {}
      }
      cur = cur.parentNode;
    }
    return false;
  }

  function readVisibleRect(el) {
    if (!el || isInsideAddonPortal(el)) return null;
    if (el.isConnected === false) return null;
    if (win && typeof win.getComputedStyle === 'function') {
      try {
        const cs = win.getComputedStyle(el);
        if (cs) {
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') {
            return null;
          }
        }
      } catch (_e) {}
    }
    if (typeof el.getBoundingClientRect !== 'function') return null;
    let rect;
    try {
      rect = el.getBoundingClientRect();
    } catch (_e) {
      return null;
    }
    if (!rect || typeof rect !== 'object') return null;
    const left = _Number(rect.left);
    const top = _Number(rect.top);
    const width = _Number(rect.width);
    const height = _Number(rect.height);
    if (!_NumberIsFinite(left) || !_NumberIsFinite(top) || !_NumberIsFinite(width) || !_NumberIsFinite(height)) {
      return null;
    }
    if (width <= 0 || height <= 0) return null;
    const right = _NumberIsFinite(_Number(rect.right)) ? _Number(rect.right) : left + width;
    const bottom = _NumberIsFinite(_Number(rect.bottom)) ? _Number(rect.bottom) : top + height;
    return { left, top, right, bottom, width, height };
  }

  function queryMatchingElements(selector) {
    if (!doc || !selector) return [];
    if (typeof doc.querySelectorAll === 'function') {
      try {
        const list = doc.querySelectorAll(selector);
        if (list && typeof list.length === 'number') {
          const out = [];
          for (let i = 0; i < list.length; i += 1) {
            if (list[i]) out.push(list[i]);
          }
          return out;
        }
      } catch (_e) {
        return [];
      }
    }
    if (typeof doc.querySelector === 'function') {
      try {
        const one = doc.querySelector(selector);
        return one ? [one] : [];
      } catch (_e) {
        return [];
      }
    }
    return [];
  }

  function findFirstVisibleSelectorRect(selectors) {
    for (let i = 0; i < selectors.length; i += 1) {
      const els = queryMatchingElements(selectors[i]);
      for (let j = 0; j < els.length; j += 1) {
        const rect = readVisibleRect(els[j]);
        if (rect) return rect;
      }
    }
    return null;
  }

  function computeSafeViewportRect(safeInsets, vw, vh) {
    const left = _MathMin(vw, toNonNegativeNumber(safeInsets.left, 0));
    const top = _MathMin(vh, toNonNegativeNumber(safeInsets.top, 0));
    const right = _MathMax(left, vw - toNonNegativeNumber(safeInsets.right, 0));
    const bottom = _MathMax(top, vh - toNonNegativeNumber(safeInsets.bottom, 0));
    return { left, top, right, bottom };
  }

  function buildBoundsDto({ surfaceId, requestedSurfaceId, matched, source, left, top, right, bottom, vw, vh }) {
    const clampedLeft = vw > 0 ? _MathMax(0, _MathMin(vw, left)) : _MathMax(0, left);
    const clampedTop = vh > 0 ? _MathMax(0, _MathMin(vh, top)) : _MathMax(0, top);
    const clampedRight = vw > 0 ? _MathMax(clampedLeft, _MathMin(vw, right)) : _MathMax(clampedLeft, right);
    const clampedBottom = vh > 0 ? _MathMax(clampedTop, _MathMin(vh, bottom)) : _MathMax(clampedTop, bottom);
    const width = clampedRight - clampedLeft;
    const height = clampedBottom - clampedTop;
    const insetRight = vw > 0 ? _MathMax(0, vw - clampedRight) : 0;
    const insetBottom = vh > 0 ? _MathMax(0, vh - clampedBottom) : 0;

    return _ObjectFreeze({
      surfaceId,
      requestedSurfaceId,
      matched: Boolean(matched),
      source,
      left: roundCoord(clampedLeft),
      top: roundCoord(clampedTop),
      right: roundCoord(clampedRight),
      bottom: roundCoord(clampedBottom),
      width: roundCoord(width),
      height: roundCoord(height),
      centerX: roundCoord(clampedLeft + width / 2),
      centerY: roundCoord(clampedTop + height / 2),
      insetLeft: roundCoord(clampedLeft),
      insetTop: roundCoord(clampedTop),
      insetRight: roundCoord(insetRight),
      insetBottom: roundCoord(insetBottom),
      viewport: _ObjectFreeze({
        width: roundCoord(vw),
        height: roundCoord(vh),
      }),
    });
  }

  function measureBySelector(spec, safeRect, vw, vh) {
    if (!spec || spec.selectors.length === 0) return null;
    const rect = findFirstVisibleSelectorRect(spec.selectors);
    if (!rect) return null;
    const left = vw > 0 ? _MathMax(safeRect.left, rect.left) : rect.left;
    const top = vh > 0 ? _MathMax(safeRect.top, rect.top) : rect.top;
    const right = vw > 0 ? _MathMin(safeRect.right, rect.right) : rect.right;
    const bottom = vh > 0 ? _MathMin(safeRect.bottom, rect.bottom) : rect.bottom;
    if (right <= left || bottom <= top) return null;
    return { left, top, right, bottom };
  }

  function measureByChromeSubtraction(spec, safeRect, vw, vh) {
    if (!spec || vw <= 0 || vh <= 0) return null;
    const hasChrome =
      spec.excludeLeftSelectors.length > 0 ||
      spec.excludeRightSelectors.length > 0 ||
      spec.excludeTopSelectors.length > 0 ||
      spec.excludeBottomSelectors.length > 0;
    if (!hasChrome) return null;

    let left = safeRect.left;
    let top = safeRect.top;
    let right = safeRect.right;
    let bottom = safeRect.bottom;
    let subtracted = false;

    for (let i = 0; i < spec.excludeLeftSelectors.length; i += 1) {
      const els = queryMatchingElements(spec.excludeLeftSelectors[i]);
      for (let j = 0; j < els.length; j += 1) {
        const r = readVisibleRect(els[j]);
        if (!r) continue;
        if (r.left <= safeRect.left + EDGE_TOUCH_TOLERANCE_PX && r.height >= vh * 0.4 && r.right < vw * 0.65) {
          if (r.right > left) {
            left = r.right;
            subtracted = true;
          }
        }
      }
    }

    for (let i = 0; i < spec.excludeRightSelectors.length; i += 1) {
      const els = queryMatchingElements(spec.excludeRightSelectors[i]);
      for (let j = 0; j < els.length; j += 1) {
        const r = readVisibleRect(els[j]);
        if (!r) continue;
        if (r.right >= safeRect.right - EDGE_TOUCH_TOLERANCE_PX && r.height >= vh * 0.4 && r.left > vw * 0.35) {
          if (r.left < right) {
            right = r.left;
            subtracted = true;
          }
        }
      }
    }

    for (let i = 0; i < spec.excludeTopSelectors.length; i += 1) {
      const els = queryMatchingElements(spec.excludeTopSelectors[i]);
      for (let j = 0; j < els.length; j += 1) {
        const r = readVisibleRect(els[j]);
        if (!r) continue;
        if (r.top <= safeRect.top + EDGE_TOUCH_TOLERANCE_PX && r.width >= vw * 0.4 && r.bottom < vh * 0.4) {
          if (r.bottom > top) {
            top = r.bottom;
            subtracted = true;
          }
        }
      }
    }

    for (let i = 0; i < spec.excludeBottomSelectors.length; i += 1) {
      const els = queryMatchingElements(spec.excludeBottomSelectors[i]);
      for (let j = 0; j < els.length; j += 1) {
        const r = readVisibleRect(els[j]);
        if (!r) continue;
        if (r.bottom >= safeRect.bottom - EDGE_TOUCH_TOLERANCE_PX && r.width >= vw * 0.4 && r.top > vh * 0.6) {
          if (r.top < bottom) {
            bottom = r.top;
            subtracted = true;
          }
        }
      }
    }

    if (!subtracted) return null;
    const minWidth = _MathMin(200, vw * 0.25);
    const minHeight = _MathMin(120, vh * 0.25);
    if (right - left < minWidth || bottom - top < minHeight) {
      return null;
    }
    return { left, top, right, bottom };
  }

  function getActiveSurface() {
    const { width: vw, height: vh } = getViewportSize();

    // Pass 1: highest-priority direct selector match wins
    for (let i = 0; i < orderedIds.length; i += 1) {
      const id = orderedIds[i];
      const spec = surfaceSpecs.get(id);
      const safeRect = computeSafeViewportRect(spec.safeInsets, vw, vh);
      const matchedRect = measureBySelector(spec, safeRect, vw, vh);
      if (matchedRect) {
        return buildBoundsDto({
          surfaceId: id,
          requestedSurfaceId: 'auto',
          matched: true,
          source: 'selector',
          left: matchedRect.left,
          top: matchedRect.top,
          right: matchedRect.right,
          bottom: matchedRect.bottom,
          vw,
          vh,
        });
      }
    }

    // Pass 2: highest-priority chrome-subtracted match wins
    for (let i = 0; i < orderedIds.length; i += 1) {
      const id = orderedIds[i];
      const spec = surfaceSpecs.get(id);
      const safeRect = computeSafeViewportRect(spec.safeInsets, vw, vh);
      const chromeRect = measureByChromeSubtraction(spec, safeRect, vw, vh);
      if (chromeRect) {
        return buildBoundsDto({
          surfaceId: id,
          requestedSurfaceId: 'auto',
          matched: true,
          source: 'chrome-subtracted',
          left: chromeRect.left,
          top: chromeRect.top,
          right: chromeRect.right,
          bottom: chromeRect.bottom,
          vw,
          vh,
        });
      }
    }

    const fallbackRect = computeSafeViewportRect(defaultSafeInsets, vw, vh);
    return buildBoundsDto({
      surfaceId: 'viewport',
      requestedSurfaceId: 'auto',
      matched: false,
      source: 'viewport',
      left: fallbackRect.left,
      top: fallbackRect.top,
      right: fallbackRect.right,
      bottom: fallbackRect.bottom,
      vw,
      vh,
    });
  }

  function getSurfaceBounds(surfaceIdOrOpts) {
    let requested = 'auto';
    if (typeof surfaceIdOrOpts === 'string' && surfaceIdOrOpts.trim()) {
      requested = surfaceIdOrOpts.trim();
    } else if (surfaceIdOrOpts && typeof surfaceIdOrOpts === 'object' && typeof surfaceIdOrOpts.surface === 'string' && surfaceIdOrOpts.surface.trim()) {
      requested = surfaceIdOrOpts.surface.trim();
    }

    if (requested === 'auto' || requested === 'active') {
      return getActiveSurface();
    }

    const { width: vw, height: vh } = getViewportSize();

    if (requested === 'viewport') {
      const safeRect = computeSafeViewportRect(defaultSafeInsets, vw, vh);
      return buildBoundsDto({
        surfaceId: 'viewport',
        requestedSurfaceId: 'viewport',
        matched: true,
        source: 'viewport',
        left: safeRect.left,
        top: safeRect.top,
        right: safeRect.right,
        bottom: safeRect.bottom,
        vw,
        vh,
      });
    }

    const spec = surfaceSpecs.get(requested);
    if (spec) {
      const safeRect = computeSafeViewportRect(spec.safeInsets, vw, vh);
      const matchedRect = measureBySelector(spec, safeRect, vw, vh);
      if (matchedRect) {
        return buildBoundsDto({
          surfaceId: requested,
          requestedSurfaceId: requested,
          matched: true,
          source: 'selector',
          left: matchedRect.left,
          top: matchedRect.top,
          right: matchedRect.right,
          bottom: matchedRect.bottom,
          vw,
          vh,
        });
      }
      const chromeRect = measureByChromeSubtraction(spec, safeRect, vw, vh);
      if (chromeRect) {
        return buildBoundsDto({
          surfaceId: requested,
          requestedSurfaceId: requested,
          matched: true,
          source: 'chrome-subtracted',
          left: chromeRect.left,
          top: chromeRect.top,
          right: chromeRect.right,
          bottom: chromeRect.bottom,
          vw,
          vh,
        });
      }
      return buildBoundsDto({
        surfaceId: requested,
        requestedSurfaceId: requested,
        matched: false,
        source: 'viewport',
        left: safeRect.left,
        top: safeRect.top,
        right: safeRect.right,
        bottom: safeRect.bottom,
        vw,
        vh,
      });
    }

    // Fallback to uiAnchors[requested] if declared only in uiAnchors
    if (uiAnchors && _ArrayIsArray(uiAnchors[requested])) {
      const anchorSelectors = normalizeStringList(uiAnchors[requested]);
      const safeRect = computeSafeViewportRect(defaultSafeInsets, vw, vh);
      const rect = findFirstVisibleSelectorRect(anchorSelectors);
      if (rect) {
        const left = vw > 0 ? _MathMax(safeRect.left, rect.left) : rect.left;
        const top = vh > 0 ? _MathMax(safeRect.top, rect.top) : rect.top;
        const right = vw > 0 ? _MathMin(safeRect.right, rect.right) : rect.right;
        const bottom = vh > 0 ? _MathMin(safeRect.bottom, rect.bottom) : rect.bottom;
        if (right > left && bottom > top) {
          return buildBoundsDto({
            surfaceId: requested,
            requestedSurfaceId: requested,
            matched: true,
            source: 'selector',
            left,
            top,
            right,
            bottom,
            vw,
            vh,
          });
        }
      }
    }

    const fallbackRect = computeSafeViewportRect(defaultSafeInsets, vw, vh);
    return buildBoundsDto({
      surfaceId: 'viewport',
      requestedSurfaceId: requested,
      matched: false,
      source: 'viewport',
      left: fallbackRect.left,
      top: fallbackRect.top,
      right: fallbackRect.right,
      bottom: fallbackRect.bottom,
      vw,
      vh,
    });
  }

  function listSurfaces() {
    return _ObjectFreeze([...orderedIds, 'viewport']);
  }

  return _ObjectFreeze({
    getSurfaceBounds,
    getActiveSurface,
    listSurfaces,
  });
}

module.exports = {
  createSurfaceGeometry,
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
  { extraNoTranslateAttributes = [], styleManager = null, surfaceGeometry = null, onPortalClaimChange = () => {} } = {}
) {
  const stack = []; // LIFO: { id, kind: 'modal'|'popover', pluginId, slotId, el, bodyEl, shadowRoot, prevFocus, ignoreOutsideClickEls, onClose }
  let seq = 0;
  let globalListenersInstalled = false;
  let portalClaimActive = false;

  function notifyPortalState(_prevCount, nextCount) {
    const nextActive = nextCount > 0;
    if (nextActive === portalClaimActive) return;
    portalClaimActive = nextActive;
    try {
      onPortalClaimChange('host-modal-portal-stack', nextActive);
    } catch (_e) {}
  }

  function isNestedInside(parentEl, childEl) {
    if (!parentEl || !childEl || parentEl === childEl) return false;
    if (childEl.parentNode === parentEl) return true;
    if (typeof parentEl.contains === 'function') {
      try {
        return Boolean(parentEl.contains(childEl));
      } catch (_e) {}
    }
    let cur = childEl.parentNode;
    let guard = 0;
    while (cur && guard < 64) {
      guard++;
      if (cur === parentEl) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  function closeEntry(entry) {
    const idx = stack.indexOf(entry);
    if (idx === -1) return false;
    // NB-4: Mark closing before cascading so any popover opened inside a child onClose() will not mount into this dying <dialog>
    entry.closing = true;
    const prevCount = stack.length;

    // F2: Cascade-close nested child entries using a snapshot so re-entrant onClose() mutations cannot skip or throw
    for (const candidate of stack.slice().reverse()) {
      if (candidate && candidate !== entry && stack.includes(candidate) && isNestedInside(entry.el, candidate.el)) {
        closeEntry(candidate);
      }
    }

    const curIdx = stack.indexOf(entry);
    if (curIdx === -1) return true;
    stack.splice(curIdx, 1);

    if (entry.shadowRoot && styleManager) {
      styleManager.unregisterShadowRoot(entry.pluginId, entry.slotId, entry.shadowRoot);
    }
    if (typeof entry.onResizeCleanup === 'function') {
      try {
        entry.onResizeCleanup();
      } catch (_e) {}
      entry.onResizeCleanup = null;
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
      // Center <dialog> inside the safe viewport region below the titlebar even under app CSS resets (* { margin: 0 }).
      dlg.style.position = 'fixed';
      dlg.style.inset = '0';
      dlg.style.top = '36px';
      dlg.style.top = 'max(env(titlebar-area-height, 36px), 36px)';
      dlg.style.right = '0';
      dlg.style.bottom = '0';
      dlg.style.left = '0';
      dlg.style.margin = 'auto';
      dlg.style.width = 'fit-content';
      dlg.style.height = 'fit-content';
      dlg.style.maxWidth = 'calc(100vw - 24px)';
      dlg.style.maxHeight = 'calc(100vh - 56px)';
      dlg.style.zIndex = String(2147483000 + stack.length + 1);
    }

    const useShadow = resolveUseShadow(pluginMeta, slotDef, opts);
    const { bodyEl, shadowRoot } = createSurfaceBody(dlg, pluginMeta, slotId, useShadow);

    const hostBody = doc.body || doc.documentElement;
    hostBody.appendChild(dlg);

    const requestedSurface =
      typeof opts.surface === 'string' && opts.surface.trim()
        ? opts.surface.trim()
        : opts.align === 'surface'
          ? 'auto'
          : null;

    const applySurfaceBounds = (targetSurface) => {
      if (!surfaceGeometry || typeof surfaceGeometry.getSurfaceBounds !== 'function') {
        return null;
      }
      const bounds = surfaceGeometry.getSurfaceBounds(targetSurface || 'auto');
      if (bounds && dlg.style) {
        dlg.setAttribute('data-addon-host-modal-surface', bounds.surfaceId);
        if (bounds.viewport && bounds.viewport.width > 0 && bounds.viewport.height > 0) {
          dlg.style.position = 'fixed';
          dlg.style.inset = '';
          dlg.style.left = `${bounds.insetLeft}px`;
          dlg.style.top = `${bounds.insetTop}px`;
          dlg.style.right = `${bounds.insetRight}px`;
          dlg.style.bottom = `${bounds.insetBottom}px`;
          dlg.style.margin = 'auto';
          dlg.style.maxWidth = `${Math.max(120, Math.floor(bounds.width - 24))}px`;
          dlg.style.maxHeight = `${Math.max(120, Math.floor(bounds.height - 24))}px`;
        }
      }
      return bounds;
    };

    const entry = {
      id: `modal-${++seq}`,
      kind: 'modal',
      pluginId: pluginMeta.pluginId,
      slotId,
      el: dlg,
      bodyEl,
      shadowRoot,
      prevFocus,
      surfaceTarget: requestedSurface,
      onResizeCleanup: null,
      ignoreOutsideClickEls: Array.isArray(opts.ignoreOutsideClickEls) ? opts.ignoreOutsideClickEls : [],
      onClose: opts.onClose || null,
    };

    if (requestedSurface && surfaceGeometry) {
      applySurfaceBounds(requestedSurface);
      if (win && typeof win.addEventListener === 'function') {
        const handleResize = () => {
          if (entry.closing || !stack.includes(entry)) return;
          applySurfaceBounds(entry.surfaceTarget);
        };
        win.addEventListener('resize', handleResize);
        entry.onResizeCleanup = () => {
          if (typeof win.removeEventListener === 'function') {
            win.removeEventListener('resize', handleResize);
          }
        };
      }
    }

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
      reposition: (nextSurface) => {
        if (entry.closing || !stack.includes(entry)) return null;
        if (typeof nextSurface === 'string' && nextSurface.trim()) {
          entry.surfaceTarget = nextSurface.trim();
        } else if (!entry.surfaceTarget) {
          entry.surfaceTarget = 'auto';
        }
        return applySurfaceBounds(entry.surfaceTarget);
      },
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

    // R-2 + NB-4: Mount inside topmost non-closing connected modal <dialog> when active
    let mountParent = doc.body || doc.documentElement;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].kind === 'modal' && !stack[i].closing && stack[i].el && stack[i].el.isConnected !== false) {
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
  "./host-bridge-port.js": function(module, exports, require) {
'use strict';

/**
 * Renderer-side HostBridgePort contract (v2.3.0 — DIP / LSP / ISP).
 *
 * Unifies the transport boundary between the shared renderer `kernel.js` and
 * host-specific bridge implementations:
 * - Desktop Electron: `preload-bridge.js` (`window.__addonHostBootstrap.claim(nonce)`)
 * - Remote Web: `src/adapters/remote-web/*` (injected via `kernel.boot({ hostBridge })`
 *   or `window.__addonHostBootstrap.claim(nonce)`)
 *
 * Uses captured primordials to remain immune to shared-world prototype tampering (I4).
 */

const _Error = Error;
const _Number = Number;
const _ObjectFreeze = Object.freeze;
const _ReflectApply = Reflect.apply;

const HOST_BRIDGE_PORT_REQUIRED_METHODS = _ObjectFreeze([
  'setPortalClaim',
  'saveSettings',
  'reportError',
  'ping',
]);

const HOST_BRIDGE_PORT_OPTIONAL_METHODS = _ObjectFreeze([
  'readConfigScope',
  'writeConfigScope',
]);

function isValidHostBridgePort(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  for (let i = 0; i < HOST_BRIDGE_PORT_REQUIRED_METHODS.length; i += 1) {
    if (typeof candidate[HOST_BRIDGE_PORT_REQUIRED_METHODS[i]] !== 'function') {
      return false;
    }
  }
  return true;
}

function wrapHostBridgePort(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    throw new _Error('ERR_INVALID_HOST_BRIDGE_PORT');
  }
  for (let i = 0; i < HOST_BRIDGE_PORT_REQUIRED_METHODS.length; i += 1) {
    const name = HOST_BRIDGE_PORT_REQUIRED_METHODS[i];
    if (typeof candidate[name] !== 'function') {
      throw new _Error(`ERR_HOST_BRIDGE_PORT_MISSING_METHOD:${name}`);
    }
  }

  const docGenId = _Number(candidate.docGenId) || 0;
  const profileId = typeof candidate.profileId === 'string' && candidate.profileId ? candidate.profileId : null;
  const fnSetPortalClaim = candidate.setPortalClaim;
  const fnSaveSettings = candidate.saveSettings;
  const fnReportError = candidate.reportError;
  const fnPing = candidate.ping;
  const fnReadConfigScope = typeof candidate.readConfigScope === 'function' ? candidate.readConfigScope : null;
  const fnWriteConfigScope = typeof candidate.writeConfigScope === 'function' ? candidate.writeConfigScope : null;

  const wrapped = {
    docGenId,
    profileId,
    setPortalClaim(claimId, active) {
      return _ReflectApply(fnSetPortalClaim, candidate, [claimId, active]);
    },
    saveSettings(pluginId, rawJson) {
      return _ReflectApply(fnSaveSettings, candidate, [pluginId, rawJson]);
    },
    reportError(pluginId, detail) {
      return _ReflectApply(fnReportError, candidate, [pluginId, detail]);
    },
    ping() {
      return _ReflectApply(fnPing, candidate, []);
    },
  };

  if (fnReadConfigScope) {
    wrapped.readConfigScope = function readConfigScope(pluginId, scopeId) {
      return _ReflectApply(fnReadConfigScope, candidate, [pluginId, scopeId]);
    };
  }
  if (fnWriteConfigScope) {
    wrapped.writeConfigScope = function writeConfigScope(pluginId, scopeId, rawJson, opts) {
      return _ReflectApply(fnWriteConfigScope, candidate, [pluginId, scopeId, rawJson, opts]);
    };
  }

  return _ObjectFreeze(wrapped);
}

module.exports = {
  HOST_BRIDGE_PORT_REQUIRED_METHODS,
  HOST_BRIDGE_PORT_OPTIONAL_METHODS,
  isValidHostBridgePort,
  wrapHostBridgePort,
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
const { createSurfaceGeometry } = require('./surface-geometry');
const { createModalPortal } = require('./modal-portal');
const { createRegionObserver } = require('./region-observer');
const { createSettingsTabCoordinator } = require('./settings-tab-coordinator');
const { wrapHostBridgePort } = require('./host-bridge-port');

// I4: Capture JS primordials BEFORE any plugin executes in shared Isolated World 998
const _Error = Error;
const _String = String;
const _Number = Number;
const _NumberIsFinite = Number.isFinite;
const _ReflectApply = Reflect.apply;
const _ObjectKeys = Object.keys;
const _ObjectFreeze = Object.freeze;
const _ObjectHasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
const _ObjectDefineProperty = Object.defineProperty;
const _ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const _ArrayIsArray = Array.isArray;
const _ArrayPush = Function.prototype.call.bind(Array.prototype.push);
const _ArrayShift = Function.prototype.call.bind(Array.prototype.shift);
const _ArraySlice = Function.prototype.call.bind(Array.prototype.slice);
const _Map = Map;
const _MapGet = Function.prototype.call.bind(Map.prototype.get);
const _MapSet = Function.prototype.call.bind(Map.prototype.set);
const _MapHas = Function.prototype.call.bind(Map.prototype.has);
const _MapDelete = Function.prototype.call.bind(Map.prototype.delete);
const _MapForEach = Function.prototype.call.bind(Map.prototype.forEach);
const _Set = Set;
const _SetAdd = Function.prototype.call.bind(Set.prototype.add);
const _SetHas = Function.prototype.call.bind(Set.prototype.has);
const _SetDelete = Function.prototype.call.bind(Set.prototype.delete);
const _SetClear = Function.prototype.call.bind(Set.prototype.clear);
const _SetForEach = Function.prototype.call.bind(Set.prototype.forEach);
const _SetSize = Function.prototype.call.bind(_ObjectGetOwnPropertyDescriptor(Set.prototype, 'size').get);
const _WeakMap = WeakMap;
const _WeakMapGet = Function.prototype.call.bind(WeakMap.prototype.get);
const _WeakMapSet = Function.prototype.call.bind(WeakMap.prototype.set);
const _WeakMapHas = Function.prototype.call.bind(WeakMap.prototype.has);
const _WeakSet = WeakSet;
const _WeakSetAdd = Function.prototype.call.bind(WeakSet.prototype.add);
const _WeakSetHas = Function.prototype.call.bind(WeakSet.prototype.has);
const _WeakSetDelete = Function.prototype.call.bind(WeakSet.prototype.delete);
const _Uint8Array = Uint8Array;
const _NumberToString = Function.prototype.call.bind(Number.prototype.toString);
const _StringPadStart = Function.prototype.call.bind(String.prototype.padStart);
const _StringSlice = Function.prototype.call.bind(String.prototype.slice);
const _DateNow = Date.now;
const _MathRandom = Math.random;
const _JSONStringify = JSON.stringify;
const _PromiseResolve = Promise.resolve.bind(Promise);
const _PromiseReject = Promise.reject.bind(Promise);
const _GlobalCrypto = typeof globalThis !== 'undefined' && globalThis.crypto ? globalThis.crypto : null;
const _CryptoGetRandomValues =
  _GlobalCrypto && typeof _GlobalCrypto.getRandomValues === 'function'
    ? Function.prototype.bind.call(_GlobalCrypto.getRandomValues, _GlobalCrypto)
    : null;

const FORBIDDEN_CLONE_KEYS = new _Set(['__proto__', 'constructor', 'prototype']);

function deepFreezeClone(value, seen = new _WeakMap()) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (_WeakMapHas(seen, value)) {
    return _WeakMapGet(seen, value);
  }
  if (_ArrayIsArray(value)) {
    const out = [];
    _WeakMapSet(seen, value, out);
    for (let i = 0; i < value.length; i++) {
      _ObjectDefineProperty(out, i, {
        value: deepFreezeClone(value[i], seen),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return _ObjectFreeze(out);
  }
  const out = {};
  _WeakMapSet(seen, value, out);
  const keys = _ObjectKeys(value);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (_SetHas(FORBIDDEN_CLONE_KEYS, k)) continue;
    _ObjectDefineProperty(out, k, {
      value: deepFreezeClone(value[k], seen),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return _ObjectFreeze(out);
}

function sanitizeJsonPayload(value, seen = new _WeakSet()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return _NumberIsFinite(value) ? value : null;
  }
  if (typeof value !== 'object') {
    return undefined;
  }
  if (_WeakSetHas(seen, value)) {
    throw new _Error('ERR_SETTINGS_INVALID_JSON');
  }
  _WeakSetAdd(seen, value);
  try {
    if (_ArrayIsArray(value)) {
      const out = [];
      for (let i = 0; i < value.length; i++) {
        const item = sanitizeJsonPayload(value[i], seen);
        _ObjectDefineProperty(out, i, {
          value: item === undefined ? null : item,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return out;
    }
    const out = {};
    const keys = _ObjectKeys(value);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (_SetHas(FORBIDDEN_CLONE_KEYS, k)) {
        throw new _Error('ERR_SETTINGS_UNSAFE_PROTO_KEY');
      }
      const nextVal = sanitizeJsonPayload(value[k], seen);
      if (nextVal !== undefined) {
        _ObjectDefineProperty(out, k, {
          value: nextVal,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
    return out;
  } finally {
    _WeakSetDelete(seen, value);
  }
}

function createRendererKernel(doc = globalThis.document, win = globalThis.window || globalThis) {
  let booted = false;
  let docGenId = 0;
  let hostProfileId = null;
  let hostToken = null;
  let hostBridge = null;
  let extraNoTranslateAttributes = [];
  let styleManager = null;
  let slotManager = null;
  let surfaceGeometry = null;
  let modalPortal = null;
  let regionObserver = null;
  let settingsTabs = null;

  const pluginDisposers = new _Map(); // pluginId -> Set<Function>
  const pluginMarkDisposed = new _Map(); // pluginId -> Set<Function>
  const disposingPlugins = new _Set(); // pluginId (I10: re-entrancy guard during onDispose)
  const pluginActions = new _Map(); // pluginId -> Map<actionId, object>
  const pluginTrustLevels = new _Map(); // pluginId -> 'trusted' | 'restricted' (I4)
  const pluginSettingsAllowed = new _Set(); // pluginId (trusted + settingsBridge declared)
  const pluginSettingsSnapshots = new _Map(); // pluginId -> frozen snapshot
  const pluginSettingsListeners = new _Map(); // pluginId -> Set<Function>
  const pluginConfigScopes = new _Map(); // pluginId -> Map<scopeId, { scopeId, access, maxBytes }>
  const stagedHandles = new _Map(); // runNonce -> { pluginId, handle } (S-1 CSP-safe two-phase execution)
  const recordedErrors = [];
  let nonceSeq = 0;

  function generateRunNonce() {
    nonceSeq += 1;
    try {
      const getRandom =
        _CryptoGetRandomValues ||
        (win && win.crypto && typeof win.crypto.getRandomValues === 'function'
          ? (arr) => win.crypto.getRandomValues(arr)
          : null);
      if (getRandom) {
        const bytes = new _Uint8Array(16);
        getRandom(bytes);
        let hex = '';
        for (let i = 0; i < 16; i++) {
          hex += _StringPadStart(_NumberToString(bytes[i], 16), 2, '0');
        }
        return `rn-${nonceSeq}-${hex}`;
      }
    } catch (_e) {}
    return `rn-${nonceSeq}-${_NumberToString(_DateNow(), 36)}-${_StringSlice(_NumberToString(_MathRandom(), 36), 2)}-${_StringSlice(_NumberToString(_MathRandom(), 36), 2)}`;
  }

  function assertHostToken(providedToken) {
    if (hostToken !== null && providedToken !== hostToken) {
      throw new _Error('ERR_FORBIDDEN_HOST_TOKEN');
    }
  }

  function reportPluginError(pluginId, detail) {
    const entry = { pluginId: _String(pluginId || 'unknown'), detail: _String(detail || '') };
    _ArrayPush(recordedErrors, entry);
    if (recordedErrors.length > 200) _ArrayShift(recordedErrors);
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
      return { ok: true, alreadyBooted: true, docGenId, hostProfileId };
    }
    if (typeof cfg.hostToken === 'string' && cfg.hostToken.length >= 16) {
      hostToken = cfg.hostToken;
    }
    docGenId = _Number(cfg.docGenId) || 1;
    hostProfileId = typeof cfg.hostProfileId === 'string' && cfg.hostProfileId ? cfg.hostProfileId : null;
    extraNoTranslateAttributes = _ArrayIsArray(cfg.extraNoTranslateAttributes)
      ? _ArraySlice(cfg.extraNoTranslateAttributes)
      : [];

    // v2.3.0 HostBridgePort: accept direct cfg.hostBridge injection (e.g. Remote Web adapter)
    // OR T-A Option A1 single-claim Electron preload bootstrap (`claim(nonce)`).
    if (cfg.hostBridge !== undefined && cfg.hostBridge !== null) {
      try {
        hostBridge = wrapHostBridgePort(cfg.hostBridge);
      } catch (err) {
        return {
          ok: false,
          reason: err && err.message ? err.message : 'ERR_INVALID_HOST_BRIDGE_PORT',
        };
      }
    } else {
      const bootstrap = win && win.__addonHostBootstrap;
      if (bootstrap && typeof bootstrap.claim === 'function' && cfg.claimNonce) {
        try {
          hostBridge = wrapHostBridgePort(bootstrap.claim(cfg.claimNonce));
        } catch (err) {
          return {
            ok: false,
            reason: err && err.message ? err.message : 'ERR_BRIDGE_CLAIM_FAILED',
          };
        }
      }
    }
    if (!hostProfileId && hostBridge && hostBridge.profileId) {
      hostProfileId = hostBridge.profileId;
    }

    styleManager = createStyleManager(doc);
    slotManager = createSlotManager(doc, {
      uiAnchors: cfg.uiAnchors || {},
      extraNoTranslateAttributes,
      styleManager,
    });
    surfaceGeometry = createSurfaceGeometry(doc, win, {
      uiSurfaces: cfg.uiSurfaces || {},
      uiAnchors: cfg.uiAnchors || {},
    });
    modalPortal = createModalPortal(doc, win, {
      extraNoTranslateAttributes,
      styleManager,
      surfaceGeometry,
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
    return { ok: true, alreadyBooted: false, docGenId, hostProfileId, hasBridge: !!hostBridge };
  }

  function addPluginDisposer(pluginId, fn) {
    if (typeof fn !== 'function') return;
    let set = _MapGet(pluginDisposers, pluginId);
    if (!set) {
      set = new _Set();
      _MapSet(pluginDisposers, pluginId, set);
    }
    _SetAdd(set, fn);
  }

  function disposePluginInternal(pluginId) {
    if (_SetHas(disposingPlugins, pluginId)) {
      return true;
    }
    _SetAdd(disposingPlugins, pluginId);
    try {
      // I10: Run registered onDispose callbacks BEFORE marking handle disposed so cleanup calls (e.g. removeStyle) succeed cleanly
      const set = _MapGet(pluginDisposers, pluginId);
      if (set) {
        const fns = [];
        _SetForEach(set, (fn) => {
          _ArrayPush(fns, fn);
        });
        for (let i = 0; i < fns.length; i++) {
          try {
            fns[i]();
          } catch (err) {
            reportPluginError(pluginId, err && err.message ? err.message : _String(err));
          }
        }
        _SetClear(set);
        _MapDelete(pluginDisposers, pluginId);
      }
      const markers = _MapGet(pluginMarkDisposed, pluginId);
      if (markers) {
        const marks = [];
        _SetForEach(markers, (mark) => {
          _ArrayPush(marks, mark);
        });
        for (let i = 0; i < marks.length; i++) {
          try {
            marks[i]();
          } catch (_e) {}
        }
        _SetClear(markers);
        _MapDelete(pluginMarkDisposed, pluginId);
      }
      if (slotManager) slotManager.disposePluginSlots(pluginId);
      if (styleManager) styleManager.disposePluginStyles(pluginId);
      if (modalPortal) modalPortal.disposePluginPortals(pluginId);
      if (regionObserver) regionObserver.disposePluginObservers(pluginId);
      if (settingsTabs) settingsTabs.disposePluginTabs(pluginId);
      _MapDelete(pluginActions, pluginId);
      _MapDelete(pluginTrustLevels, pluginId);
      _SetDelete(pluginSettingsAllowed, pluginId);
      _MapDelete(pluginSettingsSnapshots, pluginId);
      _MapDelete(pluginConfigScopes, pluginId);
      const settingsSubs = _MapGet(pluginSettingsListeners, pluginId);
      if (settingsSubs) {
        _SetClear(settingsSubs);
        _MapDelete(pluginSettingsListeners, pluginId);
      }
      return true;
    } finally {
      _SetDelete(disposingPlugins, pluginId);
    }
  }

  function disposePlugin(pluginId, token) {
    assertHostToken(token);
    return disposePluginInternal(pluginId);
  }

  function createPluginHandle(pluginMeta, token, initialSettingsSnapshot = null) {
    assertHostToken(token);
    if (!booted) {
      throw new _Error('ERR_KERNEL_NOT_BOOTED');
    }
    const pluginId = pluginMeta.pluginId;
    const effectiveTrustLevel = pluginMeta.trustLevel || 'restricted';
    const hasSettingsBridge = !!(pluginMeta.hasSettingsBridge && effectiveTrustLevel === 'trusted');
    const scopeMap = new _Map();
    const declaredConfigScopes = [];
    if (pluginMeta.hasConfigBridge && effectiveTrustLevel === 'trusted' && _ArrayIsArray(pluginMeta.configScopes)) {
      for (let i = 0; i < pluginMeta.configScopes.length; i += 1) {
        const s = pluginMeta.configScopes[i];
        if (!s || typeof s.scopeId !== 'string' || !s.scopeId) continue;
        const access = s.access === 'rw' ? 'rw' : 'ro';
        const maxBytes = _NumberIsFinite(s.maxBytes) ? s.maxBytes : 262144;
        const frozenEntry = _ObjectFreeze({
          scopeId: s.scopeId,
          access,
          maxBytes,
        });
        _MapSet(scopeMap, s.scopeId, frozenEntry);
        _ArrayPush(declaredConfigScopes, frozenEntry);
      }
    }
    const frozenConfigScopes = _ObjectFreeze(declaredConfigScopes);
    const hasConfigBridge = frozenConfigScopes.length > 0;
    let disposed = false;

    _MapSet(pluginTrustLevels, pluginId, effectiveTrustLevel);

    if (hasSettingsBridge) {
      _SetAdd(pluginSettingsAllowed, pluginId);
      _MapSet(
        pluginSettingsSnapshots,
        pluginId,
        initialSettingsSnapshot && typeof initialSettingsSnapshot === 'object'
          ? deepFreezeClone(initialSettingsSnapshot)
          : null
      );
    }
    if (hasConfigBridge) {
      _MapSet(pluginConfigScopes, pluginId, scopeMap);
    }

    let markers = _MapGet(pluginMarkDisposed, pluginId);
    if (!markers) {
      markers = new _Set();
      _MapSet(pluginMarkDisposed, pluginId, markers);
    }
    _SetAdd(markers, () => {
      disposed = true;
    });

    const assertActive = () => {
      if (disposed) throw new _Error(`ERR_PLUGIN_HANDLE_DISPOSED:${pluginId}`);
    };

    const handle = _ObjectFreeze({
      pluginId,
      version: pluginMeta.version || '0.0.0',
      trustLevel: effectiveTrustLevel,
      hostProfileId,
      schemaVersion: 2,
      sourceSchemaVersion: pluginMeta.sourceSchemaVersion || 2,
      hasSettingsBridge,
      hasConfigBridge,
      configScopes: frozenConfigScopes,

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

      getSurfaceBounds(surfaceIdOrOpts) {
        assertActive();
        return surfaceGeometry.getSurfaceBounds(surfaceIdOrOpts);
      },

      getActiveSurface() {
        assertActive();
        return surfaceGeometry.getActiveSurface();
      },

      listSurfaces() {
        assertActive();
        return surfaceGeometry.listSurfaces();
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
        if (!actionId || typeof actionId !== 'string') throw new _Error('ERR_INVALID_ACTION_ID');
        let map = _MapGet(pluginActions, pluginId);
        if (!map) {
          map = new _Map();
          _MapSet(pluginActions, pluginId, map);
        }
        const entry = {
          pluginId,
          actionId,
          label: _String(spec.label || actionId),
          run: typeof spec.run === 'function' ? spec.run : null,
        };
        _MapSet(map, actionId, entry);
        return _ObjectFreeze({
          unregister() {
            _MapDelete(map, actionId);
          },
        });
      },

      listActions() {
        assertActive();
        const out = [];
        _MapForEach(pluginActions, (map) => {
          _MapForEach(map, (a) => {
            const ownerTrust = _MapGet(pluginTrustLevels, a.pluginId) || 'restricted';
            if (effectiveTrustLevel !== 'trusted' && ownerTrust === 'trusted' && a.pluginId !== pluginId) {
              return;
            }
            _ArrayPush(out, { pluginId: a.pluginId, actionId: a.actionId, label: a.label });
          });
        });
        return out;
      },

      invokeAction(targetPluginId, actionId, ...args) {
        assertActive();
        const targetTrust = _MapGet(pluginTrustLevels, targetPluginId) || 'restricted';
        if (effectiveTrustLevel !== 'trusted' && targetTrust === 'trusted' && targetPluginId !== pluginId) {
          throw new _Error(`ERR_ACTION_TRUST_FORBIDDEN:${targetPluginId}:${actionId}`);
        }
        const map = _MapGet(pluginActions, targetPluginId);
        const a = map && _MapGet(map, actionId);
        if (!a || !a.run) throw new _Error(`ERR_ACTION_NOT_FOUND:${targetPluginId}:${actionId}`);
        return _ReflectApply(a.run, undefined, args);
      },

      isElementInsideIgnored(nodeOrEvent, opts = {}) {
        return isElementInsideIgnored(nodeOrEvent, {
          extraNoTranslateAttributes,
          ignoreElements: (opts && opts.ignoreElements) || [],
        });
      },

      getSettings() {
        assertActive();
        if (!hasSettingsBridge) return null;
        return _MapGet(pluginSettingsSnapshots, pluginId) || null;
      },

      onSettingsChange(callback) {
        assertActive();
        if (typeof callback !== 'function') {
          throw new _Error('ERR_INVALID_SETTINGS_CALLBACK');
        }
        if (!hasSettingsBridge) {
          throw new _Error('ERR_SETTINGS_BRIDGE_NOT_DECLARED');
        }
        let subs = _MapGet(pluginSettingsListeners, pluginId);
        if (!subs) {
          subs = new _Set();
          _MapSet(pluginSettingsListeners, pluginId, subs);
        }
        _SetAdd(subs, callback);
        return () => {
          _SetDelete(subs, callback);
        };
      },

      saveSettings(nextData) {
        assertActive();
        if (!hasSettingsBridge) {
          return _PromiseReject(new _Error('ERR_SETTINGS_BRIDGE_NOT_DECLARED'));
        }
        if (!nextData || typeof nextData !== 'object' || _ArrayIsArray(nextData)) {
          return _PromiseReject(new _Error('ERR_SETTINGS_MUST_BE_OBJECT'));
        }
        if (!hostBridge || typeof hostBridge.saveSettings !== 'function') {
          return _PromiseReject(new _Error('ERR_SETTINGS_SAVE_UNAVAILABLE'));
        }
        let rawJson;
        try {
          const clean = sanitizeJsonPayload(nextData);
          rawJson = _JSONStringify(clean);
        } catch (err) {
          return _PromiseReject(new _Error(err && err.message ? err.message : 'ERR_SETTINGS_INVALID_JSON'));
        }
        if (typeof rawJson !== 'string') {
          return _PromiseReject(new _Error('ERR_SETTINGS_INVALID_JSON'));
        }
        return _PromiseResolve(hostBridge.saveSettings(pluginId, rawJson)).then((res) => {
          if (res && res.ok === true && res.snapshot && typeof res.snapshot === 'object') {
            const frozen = deepFreezeClone(res.snapshot);
            return _ObjectFreeze({ ok: true, reason: null, snapshot: frozen });
          }
          return _ObjectFreeze({
            ok: false,
            reason: (res && res.reason) || 'ERR_SETTINGS_SAVE_FAILED',
            snapshot: null,
          });
        });
      },

      readConfigScope(scopeId) {
        assertActive();
        if (!hasConfigBridge) {
          return _PromiseReject(new _Error('ERR_CONFIG_BRIDGE_NOT_DECLARED'));
        }
        if (typeof scopeId !== 'string' || !scopeId) {
          return _PromiseReject(new _Error('ERR_INVALID_CONFIG_SCOPE_ID'));
        }
        const boundScopes = _MapGet(pluginConfigScopes, pluginId);
        if (!boundScopes || !_MapHas(boundScopes, scopeId)) {
          return _PromiseReject(new _Error(`ERR_CONFIG_SCOPE_NOT_DECLARED:${scopeId}`));
        }
        if (!hostBridge || typeof hostBridge.readConfigScope !== 'function') {
          return _PromiseReject(new _Error('ERR_CONFIG_BRIDGE_UNAVAILABLE'));
        }
        return _PromiseResolve(hostBridge.readConfigScope(pluginId, scopeId)).then((res) => {
          if (res && typeof res === 'object') {
            return deepFreezeClone(res);
          }
          return _ObjectFreeze({
            ok: false,
            scopeId,
            status: 'error',
            data: null,
            rawText: null,
            sha256: null,
            reason: 'ERR_CONFIG_READ_FAILED',
          });
        });
      },

      writeConfigScope(scopeId, nextDataOrRawJson, opts) {
        assertActive();
        if (!hasConfigBridge) {
          return _PromiseReject(new _Error('ERR_CONFIG_BRIDGE_NOT_DECLARED'));
        }
        if (typeof scopeId !== 'string' || !scopeId) {
          return _PromiseReject(new _Error('ERR_INVALID_CONFIG_SCOPE_ID'));
        }
        const boundScopes = _MapGet(pluginConfigScopes, pluginId);
        const scopeEntry = boundScopes ? _MapGet(boundScopes, scopeId) : null;
        if (!scopeEntry) {
          return _PromiseReject(new _Error(`ERR_CONFIG_SCOPE_NOT_DECLARED:${scopeId}`));
        }
        if (scopeEntry.access !== 'rw') {
          return _PromiseReject(new _Error(`ERR_CONFIG_SCOPE_READ_ONLY:${scopeId}`));
        }
        if (!hostBridge || typeof hostBridge.writeConfigScope !== 'function') {
          return _PromiseReject(new _Error('ERR_CONFIG_BRIDGE_UNAVAILABLE'));
        }
        let rawJson;
        if (typeof nextDataOrRawJson === 'string') {
          rawJson = nextDataOrRawJson;
        } else if (nextDataOrRawJson && typeof nextDataOrRawJson === 'object' && !_ArrayIsArray(nextDataOrRawJson)) {
          try {
            const clean = sanitizeJsonPayload(nextDataOrRawJson);
            rawJson = _JSONStringify(clean);
          } catch (err) {
            const msg = err && err.message ? err.message : 'ERR_CONFIG_INVALID_JSON';
            return _PromiseReject(
              new _Error(
                msg === 'ERR_SETTINGS_UNSAFE_PROTO_KEY'
                  ? 'ERR_CONFIG_UNSAFE_PROTO_KEY'
                  : msg === 'ERR_SETTINGS_INVALID_JSON'
                    ? 'ERR_CONFIG_INVALID_JSON'
                    : msg
              )
            );
          }
        } else {
          return _PromiseReject(new _Error('ERR_CONFIG_MUST_BE_OBJECT'));
        }
        if (typeof rawJson !== 'string') {
          return _PromiseReject(new _Error('ERR_CONFIG_INVALID_JSON'));
        }
        const forwardOpts = {};
        if (opts && typeof opts === 'object' && _ObjectHasOwn(opts, 'expectedSha256') && opts.expectedSha256 !== undefined) {
          if (opts.expectedSha256 !== null && typeof opts.expectedSha256 !== 'string') {
            return _PromiseReject(new _Error('ERR_INVALID_EXPECTED_SHA256'));
          }
          forwardOpts.expectedSha256 = opts.expectedSha256;
        }
        return _PromiseResolve(hostBridge.writeConfigScope(pluginId, scopeId, rawJson, forwardOpts)).then((res) => {
          if (res && typeof res === 'object') {
            return deepFreezeClone(res);
          }
          return _ObjectFreeze({
            ok: false,
            reason: 'ERR_CONFIG_WRITE_FAILED',
            currentSha256: null,
            snapshot: null,
          });
        });
      },

      addManagedListener(target, type, listener, opts) {
        assertActive();
        if (!target || typeof target.addEventListener !== 'function') {
          throw new _Error('ERR_INVALID_EVENT_TARGET');
        }
        const safeListener = (ev) => {
          if (disposed) return;
          try {
            const ret = listener(ev);
            if (ret && typeof ret.then === 'function') {
              ret.catch((err) => reportPluginError(pluginId, err && err.message ? err.message : _String(err)));
            }
          } catch (err) {
            reportPluginError(pluginId, err && err.message ? err.message : _String(err));
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
              reportPluginError(pluginId, err && err.message ? err.message : _String(err));
              return undefined;
            });
          }
          return ret;
        } catch (err) {
          reportPluginError(pluginId, err && err.message ? err.message : _String(err));
          return undefined;
        }
      },

      onDispose(fn) {
        assertActive();
        addPluginDisposer(pluginId, fn);
      },

      dispose() {
        if (disposed) return;
        disposePluginInternal(pluginId);
      },
    });

    return handle;
  }

  function stagePluginHandle(pluginMeta, token, initialSettingsSnapshot = null) {
    assertHostToken(token);
    const handle = createPluginHandle(pluginMeta, token, initialSettingsSnapshot);
    const runNonce = generateRunNonce();
    _MapSet(stagedHandles, runNonce, { pluginId: pluginMeta.pluginId, handle });
    return { ok: true, runNonce };
  }

  function pushPluginSettings(pluginId, snapshot, token) {
    assertHostToken(token);
    if (!booted) {
      return { ok: false, reason: 'ERR_KERNEL_NOT_BOOTED', delivered: 0 };
    }
    if (!_SetHas(pluginSettingsAllowed, pluginId)) {
      return { ok: false, reason: 'ERR_SETTINGS_BRIDGE_NOT_BOUND', delivered: 0 };
    }
    const frozen = snapshot && typeof snapshot === 'object' ? deepFreezeClone(snapshot) : null;
    _MapSet(pluginSettingsSnapshots, pluginId, frozen);
    const subs = _MapGet(pluginSettingsListeners, pluginId);
    if (!subs || _SetSize(subs) === 0) {
      return { ok: true, delivered: 0 };
    }
    const cbs = [];
    _SetForEach(subs, (cb) => {
      _ArrayPush(cbs, cb);
    });
    let delivered = 0;
    for (let i = 0; i < cbs.length; i++) {
      delivered += 1;
      try {
        const ret = cbs[i](frozen);
        if (ret && typeof ret.then === 'function') {
          ret.catch((err) => reportPluginError(pluginId, err && err.message ? err.message : _String(err)));
        }
      } catch (err) {
        reportPluginError(pluginId, err && err.message ? err.message : _String(err));
      }
    }
    return { ok: true, delivered };
  }

  function consumeStagedHandle(runNonce) {
    if (typeof runNonce !== 'string' || !_MapHas(stagedHandles, runNonce)) {
      throw new _Error('ERR_INVALID_OR_CONSUMED_RUN_NONCE');
    }
    const entry = _MapGet(stagedHandles, runNonce);
    _MapDelete(stagedHandles, runNonce);
    return entry.handle;
  }

  function clearStagedHandle(runNonce, token) {
    assertHostToken(token);
    if (typeof runNonce !== 'string') return false;
    return _MapDelete(stagedHandles, runNonce);
  }

  const api = _ObjectFreeze({
    boot,
    createPluginHandle,
    stagePluginHandle,
    pushPluginSettings,
    consumeStagedHandle,
    clearStagedHandle,
    disposePlugin,
    reportPluginError,
    getErrors: () => _ArraySlice(recordedErrors),
    getBridgeStatus: () => ({ booted, docGenId, hostProfileId, hasBridge: !!hostBridge }),
    listSettingsTabs: () => (settingsTabs ? settingsTabs.listTabs() : []),
    getSurfaceBounds: (surfaceIdOrOpts) => (surfaceGeometry ? surfaceGeometry.getSurfaceBounds(surfaceIdOrOpts) : null),
    getActiveSurface: () => (surfaceGeometry ? surfaceGeometry.getActiveSurface() : null),
    listSurfaces: () => (surfaceGeometry ? surfaceGeometry.listSurfaces() : _ObjectFreeze(['viewport'])),
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
