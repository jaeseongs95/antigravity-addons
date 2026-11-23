'use strict';

/**
 * Electron/ASAR Adapter HostProfile Port validator (ISP / DIP / OCP).
 *
 * Extends the vendor-neutral core HostProfile contract with Electron-specific
 * ASAR patch fields, World 998 isolation guard (rejecting reserved preload World 999),
 * anchor env-override prohibition, portalBridge validation, URL allowlists,
 * no-translate attributes, and resolved path validation.
 */

const { validateHostProfile } = require('../../core/host-profile-port');

const ELECTRON_REQUIRED_STRING_FIELDS = Object.freeze([
  'patchMarker',
  'mainEntry',
  'mainAnchorTarget',
  'mainAnchorReplacement',
]);

const ELECTRON_REQUIRED_PATH_KEYS = Object.freeze([
  'ADDONS_DIR',
  'PLUGINS_ROOT_DIR',
  'LOADER_SCRIPT_PATH',
  'ASAR_PATH',
  'ASAR_LOCK_PATH',
]);

function validateElectronHostProfile(profile) {
  const base = validateHostProfile(profile);
  if (!base.ok) return base;

  for (const key of ELECTRON_REQUIRED_STRING_FIELDS) {
    if (typeof profile[key] !== 'string' || !profile[key].trim()) {
      return { ok: false, reason: `MISSING_ELECTRON_PROFILE_FIELD:${key}` };
    }
  }
  if (profile.loaderEnvVar !== undefined && (typeof profile.loaderEnvVar !== 'string' || !profile.loaderEnvVar.trim())) {
    return { ok: false, reason: 'INVALID_LOADER_ENV_VAR' };
  }
  if (/[\r\n\u2028\u2029]/.test(profile.patchMarker)) {
    return { ok: false, reason: 'INVALID_PATCH_MARKER_NEWLINE' };
  }
  if (!profile.mainAnchorReplacement.includes(profile.patchMarker)) {
    return { ok: false, reason: 'INVALID_MAIN_ANCHOR_REPLACEMENT_MISSING_MARKER' };
  }
  if (/\bprocess\s*(?:\.\s*env\b|\[\s*['"`]env['"`]\s*\])/.test(profile.mainAnchorReplacement)) {
    return { ok: false, reason: 'ERR_ANCHOR_ENV_OVERRIDE_FORBIDDEN' };
  }
  if (profile.isolatedWorldId !== undefined) {
    if (!Number.isInteger(profile.isolatedWorldId) || profile.isolatedWorldId <= 0 || profile.isolatedWorldId >= 100000) {
      return { ok: false, reason: 'INVALID_ISOLATED_WORLD_ID' };
    }
    if (profile.isolatedWorldId === 999) {
      return { ok: false, reason: 'ERR_RESERVED_PRELOAD_WORLD_999' };
    }
  }
  if (profile.priorHostMarkers !== undefined) {
    if (
      !Array.isArray(profile.priorHostMarkers) ||
      profile.priorHostMarkers.some((m) => typeof m !== 'string' || !m.trim() || /[\r\n\u2028\u2029]/.test(m))
    ) {
      return { ok: false, reason: 'INVALID_PRIOR_HOST_MARKERS' };
    }
  }
  if (profile.legacyPatchMarkers !== undefined && !Array.isArray(profile.legacyPatchMarkers)) {
    return { ok: false, reason: 'INVALID_LEGACY_PATCH_MARKERS' };
  }
  if (profile.windowOrigin !== undefined) {
    if (typeof profile.windowOrigin !== 'string' || !/^https?:\/\/[^/\s]+$/i.test(profile.windowOrigin)) {
      return { ok: false, reason: 'INVALID_WINDOW_ORIGIN' };
    }
  }
  if (profile.defaultSessionOnly !== undefined && typeof profile.defaultSessionOnly !== 'boolean') {
    return { ok: false, reason: 'INVALID_DEFAULT_SESSION_ONLY' };
  }
  if (profile.portalBridge !== undefined && profile.portalBridge !== null) {
    if (
      typeof profile.portalBridge !== 'object' ||
      Array.isArray(profile.portalBridge) ||
      typeof profile.portalBridge.channel !== 'string' ||
      !profile.portalBridge.channel.trim()
    ) {
      return { ok: false, reason: 'INVALID_PORTAL_BRIDGE' };
    }
  }
  if (profile.extraNoTranslateAttributes !== undefined) {
    if (
      !Array.isArray(profile.extraNoTranslateAttributes) ||
      profile.extraNoTranslateAttributes.some((a) => typeof a !== 'string' || !/^[a-z0-9-]+$/i.test(a))
    ) {
      return { ok: false, reason: 'INVALID_EXTRA_NO_TRANSLATE_ATTRIBUTES' };
    }
  }
  if (profile.allowedUrlHosts !== undefined) {
    if (
      !Array.isArray(profile.allowedUrlHosts) ||
      profile.allowedUrlHosts.some((h) => typeof h !== 'string' || !h.trim())
    ) {
      return { ok: false, reason: 'INVALID_ALLOWED_URL_HOSTS' };
    }
  }
  if (profile.allowedUrlProtocols !== undefined) {
    if (
      !Array.isArray(profile.allowedUrlProtocols) ||
      profile.allowedUrlProtocols.some((p) => typeof p !== 'string' || !/^[a-z][a-z0-9+.-]*:$/.test(p))
    ) {
      return { ok: false, reason: 'INVALID_ALLOWED_URL_PROTOCOLS' };
    }
  }
  if (profile.uiAnchors !== undefined) {
    if (!profile.uiAnchors || typeof profile.uiAnchors !== 'object' || Array.isArray(profile.uiAnchors)) {
      return { ok: false, reason: 'INVALID_UI_ANCHORS' };
    }
    for (const [anchorKey, selectors] of Object.entries(profile.uiAnchors)) {
      if (
        typeof anchorKey !== 'string' ||
        !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(anchorKey) ||
        !Array.isArray(selectors) ||
        selectors.length === 0 ||
        selectors.some((s) => typeof s !== 'string' || !s.trim())
      ) {
        return { ok: false, reason: `INVALID_UI_ANCHOR_ENTRY:${anchorKey}` };
      }
    }
  }
  return { ok: true };
}

function assertValidElectronHostProfile(profile) {
  const res = validateElectronHostProfile(profile);
  if (!res.ok) {
    throw new Error(res.reason);
  }
  return profile;
}

function validateResolvedElectronPaths(paths, requiredKeys = ELECTRON_REQUIRED_PATH_KEYS) {
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) {
    return { ok: false, reason: 'INVALID_RESOLVED_PATHS_OBJECT' };
  }
  for (const key of requiredKeys) {
    if (typeof paths[key] !== 'string' || !paths[key].trim()) {
      return { ok: false, reason: `MISSING_RESOLVED_PATH:${key}` };
    }
  }
  return { ok: true };
}

function assertValidResolvedElectronPaths(paths, requiredKeys = ELECTRON_REQUIRED_PATH_KEYS) {
  const res = validateResolvedElectronPaths(paths, requiredKeys);
  if (!res.ok) {
    throw new Error(res.reason);
  }
  return paths;
}

module.exports = {
  ELECTRON_REQUIRED_STRING_FIELDS,
  ELECTRON_REQUIRED_PATH_KEYS,
  validateElectronHostProfile,
  assertValidElectronHostProfile,
  validateResolvedElectronPaths,
  assertValidResolvedElectronPaths,
};
