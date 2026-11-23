'use strict';

/**
 * Vendor-neutral Fail-Closed Origin & URL Boundary Guard (Browser + Node CJS).
 *
 * - Zero Node built-in dependencies (bundles directly into remote web runtime).
 * - Rejects credentials in URLs, non-HTTPS schemes (unless explicit loopback test opt-in),
 *   null origins, excluded protocols, and lookalike subdomains.
 */

const DEFAULT_EXCLUDED_PROTOCOLS = Object.freeze([
  'data:',
  'about:',
  'javascript:',
  'blob:',
  'file:',
  'chrome:',
  'chrome-extension:',
]);

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

class SecurityPolicyError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'SecurityPolicyError';
    this.code = code;
  }
}

function normalizeOrigin(rawUrlOrOrigin, { allowLoopbackHttp = false, excludedProtocols = DEFAULT_EXCLUDED_PROTOCOLS } = {}) {
  if (typeof rawUrlOrOrigin !== 'string' || !rawUrlOrOrigin.trim()) {
    return null;
  }
  const trimmed = rawUrlOrOrigin.trim();
  const excludedSet = new Set(
    (Array.isArray(excludedProtocols) ? excludedProtocols : DEFAULT_EXCLUDED_PROTOCOLS).map((p) =>
      String(p || '').toLowerCase()
    )
  );

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (_err) {
    return null;
  }

  const protocol = String(parsed.protocol || '').toLowerCase();
  if (excludedSet.has(protocol)) {
    return null;
  }
  if (parsed.username || parsed.password) {
    return null;
  }

  const host = String(parsed.hostname || '').toLowerCase();
  const isLoopback = LOOPBACK_HOSTS.has(host);

  if (protocol === 'https:') {
    if (!parsed.origin || parsed.origin === 'null') return null;
    return parsed.origin.toLowerCase();
  }

  if (protocol === 'http:' && allowLoopbackHttp === true && isLoopback) {
    if (!parsed.origin || parsed.origin === 'null') return null;
    return parsed.origin.toLowerCase();
  }

  return null;
}

function isOriginAllowed(currentUrlOrOrigin, policy = {}) {
  const allowLoopbackHttp = Boolean(policy && policy.allowLoopbackHttp === true);
  const excludedProtocols =
    policy && Array.isArray(policy.excludedProtocols) ? policy.excludedProtocols : DEFAULT_EXCLUDED_PROTOCOLS;

  const normalized = normalizeOrigin(currentUrlOrOrigin, { allowLoopbackHttp, excludedProtocols });
  if (!normalized) {
    return { ok: false, origin: null, reason: 'ERR_ORIGIN_INVALID_OR_FORBIDDEN_SCHEME' };
  }

  const rawAllowed = policy && Array.isArray(policy.allowedOrigins) ? policy.allowedOrigins : [];
  if (rawAllowed.length === 0) {
    return { ok: false, origin: normalized, reason: 'ERR_ORIGIN_ALLOWLIST_EMPTY' };
  }

  for (let i = 0; i < rawAllowed.length; i += 1) {
    const allowedNorm = normalizeOrigin(rawAllowed[i], { allowLoopbackHttp, excludedProtocols });
    if (allowedNorm && allowedNorm === normalized) {
      return { ok: true, origin: normalized, reason: null };
    }
  }

  return { ok: false, origin: normalized, reason: 'ERR_ORIGIN_NOT_ALLOWED' };
}

function assertAllowedOrigin(currentUrlOrOrigin, policy = {}) {
  const check = isOriginAllowed(currentUrlOrOrigin, policy);
  if (!check.ok) {
    throw new SecurityPolicyError(
      check.reason || 'ERR_ORIGIN_NOT_ALLOWED',
      `Blocked remote web host execution on disallowed origin (${check.reason}): ${String(currentUrlOrOrigin || '')}`
    );
  }
  return check.origin;
}

function isSameOriginUrl(targetUrl, expectedOrigin, opts = {}) {
  const targetNorm = normalizeOrigin(targetUrl, opts);
  const expectedNorm = normalizeOrigin(expectedOrigin, opts);
  if (!targetNorm || !expectedNorm) return false;
  return targetNorm === expectedNorm;
}

module.exports = {
  DEFAULT_EXCLUDED_PROTOCOLS,
  LOOPBACK_HOSTS,
  SecurityPolicyError,
  normalizeOrigin,
  isOriginAllowed,
  assertAllowedOrigin,
  isSameOriginUrl,
};
