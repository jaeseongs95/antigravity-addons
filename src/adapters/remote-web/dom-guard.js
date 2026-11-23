'use strict';

/**
 * Vendor-neutral Zero-HTML-Sink DOM Helper Guard (Browser + Node CJS).
 *
 * - Constructs DOM trees exclusively via `createElement`, `textContent`,
 *   and validated `setAttribute` calls.
 * - Blocks dangerous element tags (`script`, `iframe`, `object`, `embed`, `base`, `link`),
 *   inline event attributes (`on*`), and executable URL attributes (`javascript:`, `data:`).
 */

const { SecurityPolicyError } = require('./origin-guard');

const FORBIDDEN_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'base', 'link', 'meta', 'style']);
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'formaction', 'action']);
const FORBIDDEN_URL_SCHEME_RE = /^(?:javascript|vbscript|data):/i;
const SAFE_EXTRA_ATTR_NAME_RE = /^[a-z][a-z0-9-]*$/i;

function hasForbiddenUrlScheme(value) {
  const normalized = String(value || '').replace(/[\u0000-\u0020]+/g, '');
  return FORBIDDEN_URL_SCHEME_RE.test(normalized);
}

function isSafeExtraAttrName(attr) {
  if (typeof attr !== 'string') return false;
  const trimmed = attr.trim();
  if (!trimmed || !SAFE_EXTRA_ATTR_NAME_RE.test(trimmed)) return false;
  if (trimmed.toLowerCase().startsWith('on')) return false;
  return true;
}

function createElementSafe(doc, tagName, attrs = null, text = null) {
  if (!doc || typeof doc.createElement !== 'function') {
    throw new SecurityPolicyError('ERR_INVALID_DOCUMENT', 'Document with createElement is required');
  }
  const tag = String(tagName || '').trim().toLowerCase();
  if (!tag || !/^[a-z][a-z0-9-]*$/.test(tag) || FORBIDDEN_TAGS.has(tag)) {
    throw new SecurityPolicyError('ERR_FORBIDDEN_DOM_TAG', `Forbidden or invalid tag: ${String(tagName || '')}`);
  }
  const el = doc.createElement(tag);
  if (attrs && typeof attrs === 'object') {
    const keys = Object.keys(attrs);
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      const v = attrs[k];
      if (v === undefined || v === null) continue;
      const lowerKey = k.toLowerCase();
      if (lowerKey.startsWith('on')) {
        throw new SecurityPolicyError('ERR_FORBIDDEN_INLINE_HANDLER_ATTR', `Forbidden event attribute: ${k}`);
      }
      const strVal = String(v);
      if (URL_ATTRS.has(lowerKey) && hasForbiddenUrlScheme(strVal)) {
        throw new SecurityPolicyError('ERR_FORBIDDEN_URL_ATTR_SCHEME', `Forbidden URL scheme in attribute ${k}`);
      }
      el.setAttribute(k, strVal);
    }
  }
  if (text !== undefined && text !== null) {
    el.textContent = String(text);
  }
  return el;
}

function clearChildrenSafe(el) {
  if (!el) return;
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

function setTextSafe(el, text) {
  if (!el) return;
  el.textContent = text === undefined || text === null ? '' : String(text);
}

function createStyleElementSafe(doc, cssText) {
  if (!doc || typeof doc.createElement !== 'function') {
    throw new SecurityPolicyError('ERR_INVALID_DOCUMENT', 'Document with createElement is required');
  }
  const styleEl = doc.createElement('style');
  styleEl.textContent = String(cssText || '');
  return styleEl;
}

function createShadowContainer(
  doc,
  hostId,
  { mode = 'open', noTranslateAttrs = [], cssText = '', parent = null } = {}
) {
  if (!doc || typeof doc.createElement !== 'function') {
    throw new SecurityPolicyError('ERR_INVALID_DOCUMENT', 'Document with createElement is required');
  }
  const containerParent = parent || doc.body || doc.documentElement;
  if (!containerParent || typeof containerParent.appendChild !== 'function') {
    throw new SecurityPolicyError('ERR_NO_DOM_MOUNT_PARENT', 'No valid DOM mount parent available');
  }

  let hostEl = typeof doc.getElementById === 'function' ? doc.getElementById(hostId) : null;
  if (hostEl && hostEl.shadowRoot) {
    return { hostEl, shadowRoot: hostEl.shadowRoot, reused: true };
  }

  hostEl = createElementSafe(doc, 'div', {
    id: hostId,
    translate: 'no',
    'data-addon-host-ignore': 'true',
    'data-addon-host-no-translate': 'true',
  });
  for (let i = 0; i < noTranslateAttrs.length; i += 1) {
    const attr = String(noTranslateAttrs[i] || '').trim();
    if (isSafeExtraAttrName(attr)) {
      hostEl.setAttribute(attr, 'true');
    }
  }

  containerParent.appendChild(hostEl);

  let shadowRoot = null;
  if (typeof hostEl.attachShadow === 'function') {
    shadowRoot = hostEl.attachShadow({ mode: mode === 'closed' ? 'closed' : 'open' });
    if (cssText) {
      shadowRoot.appendChild(createStyleElementSafe(doc, cssText));
    }
  } else if (cssText) {
    hostEl.appendChild(createStyleElementSafe(doc, cssText));
  }

  return { hostEl, shadowRoot: shadowRoot || hostEl, reused: false };
}

module.exports = {
  FORBIDDEN_TAGS,
  hasForbiddenUrlScheme,
  isSafeExtraAttrName,
  createElementSafe,
  clearChildrenSafe,
  setTextSafe,
  createStyleElementSafe,
  createShadowContainer,
};
