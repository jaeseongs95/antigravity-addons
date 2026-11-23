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
