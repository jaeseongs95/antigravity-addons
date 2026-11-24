'use strict';

/**
 * Vendor-neutral Scoped TrustedTypes Policy Guard (Browser + Node CJS).
 *
 * - Strictly forbids creating or clobbering reserved/global policies
 *   (`default`, `dompurify`, `angular`, `goog#html`, `lit-html`).
 * - Refuses HTML string sinks unconditionally (`createHTML` always throws).
 * - Permits only same-origin `https:` script URLs when `trustedTypes` is active.
 */

const { SecurityPolicyError, isSameOriginUrl } = require('./origin-guard');

const POLICY_NAME_RE = /^[a-z][a-z0-9-]{2,63}$/;
const FORBIDDEN_POLICY_NAMES = Object.freeze([
  'default',
  'dompurify',
  'angular',
  'goog#html',
  'lit-html',
]);

const policyCacheByWindow = new WeakMap();

function assertValidPolicyName(policyName) {
  if (typeof policyName !== 'string' || !policyName.trim()) {
    throw new SecurityPolicyError('ERR_INVALID_TRUSTED_TYPES_POLICY_NAME', 'TrustedTypes policy name must be a non-empty string');
  }
  const normalized = policyName.trim();
  const lower = normalized.toLowerCase();
  if (FORBIDDEN_POLICY_NAMES.includes(lower)) {
    throw new SecurityPolicyError(
      'ERR_FORBIDDEN_TRUSTED_TYPES_POLICY',
      `Refusing to register forbidden TrustedTypes policy "${normalized}"`
    );
  }
  if (!POLICY_NAME_RE.test(normalized)) {
    throw new SecurityPolicyError(
      'ERR_INVALID_TRUSTED_TYPES_POLICY_NAME',
      `TrustedTypes policy name "${normalized}" does not match ${POLICY_NAME_RE}`
    );
  }
  return normalized;
}

function createScopedTrustedTypesGuard(win, { policyName = 'remote-web-addon-host', allowedOrigin = null, allowLoopbackHttp = false } = {}) {
  const validName = assertValidPolicyName(policyName);
  const tt = win && win.trustedTypes && typeof win.trustedTypes.createPolicy === 'function' ? win.trustedTypes : null;

  let policy = null;
  let createError = null;

  if (tt) {
    let perWin = policyCacheByWindow.get(win);
    if (!perWin) {
      perWin = new Map();
      policyCacheByWindow.set(win, perWin);
    }
    if (perWin.has(validName)) {
      policy = perWin.get(validName);
    } else {
      try {
        policy = tt.createPolicy(validName, {
          createHTML() {
            throw new SecurityPolicyError('ERR_HTML_SINK_FORBIDDEN', 'Remote web addon host forbids HTML string sinks');
          },
          createScript() {
            throw new SecurityPolicyError('ERR_DYNAMIC_SCRIPT_SINK_FORBIDDEN', 'Remote web addon host forbids dynamic script strings');
          },
          createScriptURL(urlStr) {
            const origin =
              allowedOrigin ||
              (win && win.location && typeof win.location.origin === 'string' ? win.location.origin : null);
            if (!origin || !isSameOriginUrl(String(urlStr || ''), origin, { allowLoopbackHttp })) {
              throw new SecurityPolicyError('ERR_UNTRUSTED_SCRIPT_URL', `Blocked non-same-origin script URL: ${String(urlStr || '')}`);
            }
            return String(urlStr);
          },
        });
        perWin.set(validName, policy);
      } catch (err) {
        createError = err && err.message ? err.message : String(err);
        policy = null;
      }
    }
  }

  return Object.freeze({
    policyName: validName,
    supported: Boolean(tt),
    hasPolicy: Boolean(policy),
    createError,
    createSafeScriptUrl(urlStr) {
      const origin =
        allowedOrigin ||
        (win && win.location && typeof win.location.origin === 'string' ? win.location.origin : null);
      if (!origin || !isSameOriginUrl(String(urlStr || ''), origin, { allowLoopbackHttp })) {
        throw new SecurityPolicyError('ERR_UNTRUSTED_SCRIPT_URL', `Blocked non-same-origin script URL: ${String(urlStr || '')}`);
      }
      if (policy && typeof policy.createScriptURL === 'function') {
        return policy.createScriptURL(String(urlStr));
      }
      return String(urlStr);
    },
    assertNoHtmlSink() {
      throw new SecurityPolicyError('ERR_HTML_SINK_FORBIDDEN', 'Remote web addon host forbids HTML string sinks');
    },
  });
}

module.exports = {
  POLICY_NAME_RE,
  FORBIDDEN_POLICY_NAMES,
  assertValidPolicyName,
  createScopedTrustedTypesGuard,
};
