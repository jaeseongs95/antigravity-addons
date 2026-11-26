'use strict';

/**
 * Pure vendor- & runtime-neutral Secrets Storage & Header Injection Policy (v3.3.0 — SOLID #0).
 *
 * ZERO Node.js built-in imports, ZERO vendor literals.
 *
 * Enforces:
 * 1. Strict key validation (`SECRET_KEY_RE`, prototype-pollution rejection).
 * 2. Bounded secret values (`MAX_SINGLE_SECRET_VALUE_BYTES = 8192`, non-empty, NUL-free).
 * 3. Trusted-only `permissions.secrets` gating (`maxKeys`, `maxBytes`, `allowRead` opt-in).
 * 4. Structured `secretHeaders` validation & resolution for host-side `net.fetch` injection,
 *    blocking forbidden/hop-by-hop/host-reserved headers and CR/LF/NUL header injection.
 * 5. Cross-host redirect sensitive header strip list (`SENSITIVE_REDIRECT_STRIP_HEADERS`).
 */

const SECRET_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9-]+$/;
const FORBIDDEN_SECRET_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const FORBIDDEN_SECRET_REQUEST_HEADERS = Object.freeze([
  'cookie',
  'cookie2',
  'host',
  'origin',
  'referer',
  'proxy-authorization',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-real-ip',
]);

const DEFAULT_MAX_SECRET_KEYS = 32;
const MAX_SECRET_KEYS_LIMIT = 64;
const DEFAULT_MAX_SECRET_BYTES = 32768;
const MIN_MAX_SECRET_BYTES = 1024;
const MAX_SECRET_BYTES_LIMIT = 65536;
const MAX_SINGLE_SECRET_VALUE_BYTES = 8192;
const MAX_SECRET_HEADERS_PER_REQUEST = 8;
const MAX_SECRET_HEADER_AFFIX_LEN = 64;

const SENSITIVE_REDIRECT_STRIP_HEADERS = Object.freeze([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
  'x-auth-token',
  'x-access-token',
  'x-secret',
]);

function utf8ByteLength(str) {
  const s = String(str || '');
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(s).length;
  }
  if (typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') {
    return Buffer.byteLength(s, 'utf8');
  }
  let bytes = 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

function validateSecretKey(rawKey) {
  if (typeof rawKey !== 'string') {
    return { ok: false, reason: 'ERR_SECRETS_INVALID_KEY' };
  }
  const key = rawKey.trim();
  if (!key || FORBIDDEN_SECRET_KEYS.has(key) || !SECRET_KEY_RE.test(key)) {
    return { ok: false, reason: 'ERR_SECRETS_INVALID_KEY' };
  }
  return { ok: true, key };
}

function validateSecretValue(rawValue, { maxSingleBytes = MAX_SINGLE_SECRET_VALUE_BYTES } = {}) {
  if (typeof rawValue !== 'string') {
    return { ok: false, reason: 'ERR_SECRETS_INVALID_VALUE' };
  }
  if (rawValue.length === 0) {
    return { ok: false, reason: 'ERR_SECRETS_EMPTY_VALUE' };
  }
  if (rawValue.indexOf('\0') !== -1) {
    return { ok: false, reason: 'ERR_SECRETS_INVALID_VALUE' };
  }
  const byteLength = utf8ByteLength(rawValue);
  if (byteLength > maxSingleBytes) {
    return { ok: false, reason: 'ERR_SECRETS_VALUE_TOO_LARGE' };
  }
  return { ok: true, value: rawValue, byteLength };
}

function validateSecretsPermissions(secretsPerm, { trustLevel = 'restricted' } = {}) {
  if (secretsPerm === null || secretsPerm === undefined) {
    return {
      ok: true,
      enabled: false,
      maxKeys: 0,
      maxBytes: 0,
      allowRead: false,
    };
  }
  if (typeof secretsPerm !== 'object' || Array.isArray(secretsPerm)) {
    return {
      ok: false,
      reason: 'ERR_INVALID_SECRETS_PERMISSIONS',
      errors: ['permissions.secrets must be an object'],
    };
  }
  if (trustLevel !== 'trusted') {
    return {
      ok: false,
      reason: 'ERR_RESTRICTED_SECRETS_FORBIDDEN',
      errors: ['permissions.secrets requires trustLevel: "trusted" and host trust approval'],
    };
  }

  const errors = [];
  let maxKeys = DEFAULT_MAX_SECRET_KEYS;
  if (secretsPerm.maxKeys !== undefined) {
    if (!Number.isInteger(secretsPerm.maxKeys) || secretsPerm.maxKeys < 1 || secretsPerm.maxKeys > MAX_SECRET_KEYS_LIMIT) {
      errors.push(`permissions.secrets.maxKeys must be an integer between 1 and ${MAX_SECRET_KEYS_LIMIT}`);
    } else {
      maxKeys = secretsPerm.maxKeys;
    }
  }

  let maxBytes = DEFAULT_MAX_SECRET_BYTES;
  if (secretsPerm.maxBytes !== undefined) {
    if (
      !Number.isInteger(secretsPerm.maxBytes) ||
      secretsPerm.maxBytes < MIN_MAX_SECRET_BYTES ||
      secretsPerm.maxBytes > MAX_SECRET_BYTES_LIMIT
    ) {
      errors.push(
        `permissions.secrets.maxBytes must be an integer between ${MIN_MAX_SECRET_BYTES} and ${MAX_SECRET_BYTES_LIMIT}`
      );
    } else {
      maxBytes = secretsPerm.maxBytes;
    }
  }

  let allowRead = false;
  if (secretsPerm.allowRead !== undefined) {
    if (typeof secretsPerm.allowRead !== 'boolean') {
      errors.push('permissions.secrets.allowRead must be a boolean');
    } else {
      allowRead = secretsPerm.allowRead;
    }
  }

  if (errors.length > 0) {
    return { ok: false, reason: 'ERR_INVALID_SECRETS_PERMISSIONS', errors };
  }

  return {
    ok: true,
    enabled: true,
    maxKeys,
    maxBytes,
    allowRead,
  };
}

function isForbiddenSecretHeaderName(lowerName) {
  if (!lowerName) return true;
  if (FORBIDDEN_SECRET_KEYS.has(lowerName)) return true;
  if (FORBIDDEN_SECRET_REQUEST_HEADERS.includes(lowerName)) return true;
  if (lowerName.startsWith('sec-fetch-') || lowerName.startsWith('proxy-') || lowerName.startsWith('x-addon-host-')) {
    return true;
  }
  return false;
}

function normalizeSecretHeadersSpec(rawSecretHeaders) {
  if (rawSecretHeaders === null || rawSecretHeaders === undefined) {
    return { ok: true, entries: [] };
  }
  if (typeof rawSecretHeaders !== 'object' || Array.isArray(rawSecretHeaders)) {
    return { ok: false, reason: 'ERR_NET_INVALID_SECRET_HEADERS' };
  }

  const keys = Object.keys(rawSecretHeaders);
  if (keys.length > MAX_SECRET_HEADERS_PER_REQUEST) {
    return { ok: false, reason: 'ERR_NET_TOO_MANY_SECRET_HEADERS' };
  }

  const entries = [];
  const seenLower = new Set();
  for (let i = 0; i < keys.length; i += 1) {
    const rawHeaderName = String(keys[i] || '').trim();
    const lower = rawHeaderName.toLowerCase();
    if (!rawHeaderName || !HEADER_NAME_RE.test(rawHeaderName) || isForbiddenSecretHeaderName(lower)) {
      return { ok: false, reason: `ERR_NET_SECRET_HEADER_FORBIDDEN:${rawHeaderName || 'empty'}` };
    }
    if (seenLower.has(lower)) {
      return { ok: false, reason: `ERR_NET_SECRET_HEADER_DUPLICATE:${lower}` };
    }
    seenLower.add(lower);

    const spec = rawSecretHeaders[keys[i]];
    let secretKeyRaw;
    let prefix = '';
    let suffix = '';
    if (typeof spec === 'string') {
      secretKeyRaw = spec;
    } else if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
      secretKeyRaw = spec.secretKey;
      if (spec.prefix !== undefined) {
        if (typeof spec.prefix !== 'string' || spec.prefix.length > MAX_SECRET_HEADER_AFFIX_LEN || /[\r\n\0]/.test(spec.prefix)) {
          return { ok: false, reason: 'ERR_NET_INVALID_SECRET_HEADER_PREFIX' };
        }
        prefix = spec.prefix;
      }
      if (spec.suffix !== undefined) {
        if (typeof spec.suffix !== 'string' || spec.suffix.length > MAX_SECRET_HEADER_AFFIX_LEN || /[\r\n\0]/.test(spec.suffix)) {
          return { ok: false, reason: 'ERR_NET_INVALID_SECRET_HEADER_SUFFIX' };
        }
        suffix = spec.suffix;
      }
    } else {
      return { ok: false, reason: 'ERR_NET_INVALID_SECRET_HEADERS' };
    }

    const keyCheck = validateSecretKey(secretKeyRaw);
    if (!keyCheck.ok) {
      return { ok: false, reason: keyCheck.reason };
    }

    entries.push({
      headerName: rawHeaderName,
      lowerName: lower,
      secretKey: keyCheck.key,
      prefix,
      suffix,
    });
  }

  return { ok: true, entries };
}

function resolveSecretHeaders(rawSecretHeaders, lookupFn) {
  const specRes = normalizeSecretHeadersSpec(rawSecretHeaders);
  if (!specRes.ok) {
    return { ok: false, reason: specRes.reason, headers: {}, injectedHeaderNames: [] };
  }
  if (specRes.entries.length === 0) {
    return { ok: true, reason: null, headers: {}, injectedHeaderNames: [] };
  }
  if (typeof lookupFn !== 'function') {
    return { ok: false, reason: 'ERR_SECRETS_NOT_DECLARED', headers: {}, injectedHeaderNames: [] };
  }

  const headers = {};
  const injectedHeaderNames = [];
  for (let i = 0; i < specRes.entries.length; i += 1) {
    const entry = specRes.entries[i];
    const lookupRes = lookupFn(entry.secretKey);
    if (!lookupRes || lookupRes.ok !== true || typeof lookupRes.value !== 'string' || lookupRes.value.length === 0) {
      return {
        ok: false,
        reason: (lookupRes && lookupRes.reason) || `ERR_SECRET_NOT_FOUND:${entry.secretKey}`,
        headers: {},
        injectedHeaderNames: [],
      };
    }
    if (/[\r\n\0]/.test(lookupRes.value)) {
      return {
        ok: false,
        reason: 'ERR_SECRET_INVALID_HEADER_VALUE',
        headers: {},
        injectedHeaderNames: [],
      };
    }
    headers[entry.headerName] = `${entry.prefix}${lookupRes.value}${entry.suffix}`;
    injectedHeaderNames.push(entry.lowerName);
  }

  return { ok: true, reason: null, headers, injectedHeaderNames };
}

module.exports = {
  SECRET_KEY_RE,
  HEADER_NAME_RE,
  FORBIDDEN_SECRET_KEYS,
  DEFAULT_MAX_SECRET_KEYS,
  MAX_SECRET_KEYS_LIMIT,
  DEFAULT_MAX_SECRET_BYTES,
  MIN_MAX_SECRET_BYTES,
  MAX_SECRET_BYTES_LIMIT,
  MAX_SINGLE_SECRET_VALUE_BYTES,
  MAX_SECRET_HEADERS_PER_REQUEST,
  SENSITIVE_REDIRECT_STRIP_HEADERS,
  utf8ByteLength,
  validateSecretKey,
  validateSecretValue,
  validateSecretsPermissions,
  normalizeSecretHeadersSpec,
  resolveSecretHeaders,
};
