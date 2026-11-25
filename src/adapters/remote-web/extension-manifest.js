'use strict';

/**
 * Vendor-neutral MV3 Browser Extension Manifest Builder (v2.6.0 — SOLID #0).
 *
 * - Pure Browser + Node CJS (ZERO Node built-in imports, ZERO vendor literals).
 * - Derives `content_scripts[0].matches` fail-closed strictly from `profile.allowedOrigins`
 *   (HTTPS only, zero wildcards, zero credentials, zero custom ports).
 * - Emits least-privilege Manifest V3 with explicit `"world": "ISOLATED"` and zero
 *   `permissions`, `host_permissions`, `background`, or `web_accessible_resources`.
 */

const { SecurityPolicyError } = require('./origin-guard');

const EXTENSION_CONTENT_SCRIPT_FILENAME = 'content-script.js';
const SAFE_SCRIPT_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MV3_NUMERIC_VERSION_RE = /^\d+(?:\.\d+){0,3}$/;
const SHA_HEX_RE = /^[a-f0-9]{6,64}$/i;

function normalizeMv3Version(rawVersion) {
  if (typeof rawVersion !== 'string' || !rawVersion.trim()) {
    throw new SecurityPolicyError('ERR_INVALID_EXTENSION_VERSION', 'Extension version must be a non-empty string.');
  }
  const stripped = rawVersion.trim().replace(/^v/i, '');
  const numericPart = stripped.split(/[+-]/)[0];
  if (!MV3_NUMERIC_VERSION_RE.test(numericPart)) {
    throw new SecurityPolicyError(
      'ERR_INVALID_EXTENSION_VERSION',
      `Invalid MV3 extension version: ${String(rawVersion)}`
    );
  }
  const segments = numericPart.split('.').map((part) => Number(part));
  let hasPositive = false;
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (!Number.isInteger(seg) || seg < 0 || seg > 65535) {
      throw new SecurityPolicyError(
        'ERR_INVALID_EXTENSION_VERSION',
        `MV3 extension version segment out of range (0..65535): ${String(rawVersion)}`
      );
    }
    if (seg > 0) hasPositive = true;
  }
  if (!hasPositive) {
    throw new SecurityPolicyError(
      'ERR_INVALID_EXTENSION_VERSION',
      `MV3 extension version must contain at least one positive segment: ${String(rawVersion)}`
    );
  }
  return segments.join('.');
}

function buildExtensionMatchPatterns(allowedOrigins) {
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
    throw new SecurityPolicyError(
      'ERR_EXTENSION_ALLOWED_ORIGINS_EMPTY',
      'MV3 extension requires at least one allowed HTTPS origin.'
    );
  }

  const patterns = new Set();
  for (let i = 0; i < allowedOrigins.length; i += 1) {
    const raw = allowedOrigins[i];
    if (typeof raw !== 'string') {
      throw new SecurityPolicyError(
        'ERR_EXTENSION_ALLOWED_ORIGINS_INVALID',
        'MV3 extension allowed origin entry must be a string.'
      );
    }
    const trimmed = raw.trim();
    if (!trimmed || trimmed.includes('*') || /\s/.test(trimmed)) {
      throw new SecurityPolicyError(
        'ERR_EXTENSION_ALLOWED_ORIGINS_INVALID',
        `Invalid MV3 extension origin entry: ${String(raw)}`
      );
    }

    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch (_err) {
      throw new SecurityPolicyError(
        'ERR_EXTENSION_ALLOWED_ORIGINS_INVALID',
        `Unparseable MV3 extension origin: ${String(raw)}`
      );
    }

    if (String(parsed.protocol || '').toLowerCase() !== 'https:') {
      throw new SecurityPolicyError(
        'ERR_EXTENSION_ALLOWED_ORIGINS_INVALID',
        `MV3 extension origin must use https: protocol: ${String(raw)}`
      );
    }
    if (parsed.username || parsed.password) {
      throw new SecurityPolicyError(
        'ERR_EXTENSION_ALLOWED_ORIGINS_INVALID',
        `MV3 extension origin must not include credentials: ${String(raw)}`
      );
    }
    if (parsed.port !== '') {
      throw new SecurityPolicyError(
        'ERR_EXTENSION_ALLOWED_ORIGINS_INVALID',
        `MV3 extension match patterns do not allow custom ports: ${String(raw)}`
      );
    }
    if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
      throw new SecurityPolicyError(
        'ERR_EXTENSION_ALLOWED_ORIGINS_INVALID',
        `MV3 extension origin must not include path, query, or fragment: ${String(raw)}`
      );
    }
    const hostname = String(parsed.hostname || '').toLowerCase();
    if (!hostname || hostname.includes('*') || hostname.startsWith('.') || hostname.endsWith('.')) {
      throw new SecurityPolicyError(
        'ERR_EXTENSION_ALLOWED_ORIGINS_INVALID',
        `Invalid MV3 extension hostname: ${String(raw)}`
      );
    }

    patterns.add(`https://${hostname}/*`);
  }

  if (patterns.size === 0) {
    throw new SecurityPolicyError(
      'ERR_EXTENSION_ALLOWED_ORIGINS_EMPTY',
      'MV3 extension requires at least one valid HTTPS match pattern.'
    );
  }
  return Object.freeze(Array.from(patterns).sort());
}

function buildMv3ExtensionManifest({
  profile,
  version,
  contentSha8 = null,
  contentScriptFile = EXTENSION_CONTENT_SCRIPT_FILENAME,
} = {}) {
  if (!profile || typeof profile !== 'object') {
    throw new SecurityPolicyError('ERR_INVALID_HOST_PROFILE', 'MV3 extension manifest requires a HostProfile object.');
  }
  if (
    typeof contentScriptFile !== 'string' ||
    !SAFE_SCRIPT_FILENAME_RE.test(contentScriptFile) ||
    contentScriptFile.includes('..')
  ) {
    throw new SecurityPolicyError(
      'ERR_INVALID_EXTENSION_SCRIPT_FILE',
      `Invalid MV3 extension content script filename: ${String(contentScriptFile)}`
    );
  }

  const rawDisplayName =
    (typeof profile.displayName === 'string' && profile.displayName.trim()) ||
    (typeof profile.id === 'string' && profile.id.trim()) ||
    'Remote Web';
  const name = `${rawDisplayName} Addon Host`.slice(0, 75);
  const mv3Version = normalizeMv3Version(version);
  const rawVerClean = String(version).trim().replace(/^v/i, '');
  const cleanSha8 =
    typeof contentSha8 === 'string' && SHA_HEX_RE.test(contentSha8.trim())
      ? contentSha8.trim().toLowerCase()
      : null;
  const versionName = cleanSha8 ? `${rawVerClean} (${cleanSha8})` : rawVerClean;
  const matches = buildExtensionMatchPatterns(profile.allowedOrigins);

  return {
    manifest_version: 3,
    name,
    version: mv3Version,
    version_name: versionName,
    description: `Self-contained AddonManifest.v2 renderer addon host for ${rawDisplayName}`,
    content_scripts: [
      {
        matches: Array.from(matches),
        js: [contentScriptFile],
        run_at: 'document_idle',
        all_frames: false,
        match_about_blank: false,
        match_origin_as_fallback: false,
        world: 'ISOLATED',
      },
    ],
  };
}

module.exports = {
  EXTENSION_CONTENT_SCRIPT_FILENAME,
  normalizeMv3Version,
  buildExtensionMatchPatterns,
  buildMv3ExtensionManifest,
};
