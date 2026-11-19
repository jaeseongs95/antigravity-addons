'use strict';

/**
 * Electron/ASAR Adapter HostProfile Port validator (ISP / DIP / OCP).
 *
 * Extends the vendor-neutral core HostProfile contract with Electron-specific
 * ASAR patch fields, URL allowlists, no-translate attributes, and resolved path validation.
 */

const { validateHostProfile } = require('../../core/host-profile-port');

const ELECTRON_REQUIRED_STRING_FIELDS = Object.freeze([
  'patchMarker',
  'mainEntry',
  'mainAnchorTarget',
  'mainAnchorReplacement',
  'loaderEnvVar',
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
  if (/[\r\n\u2028\u2029]/.test(profile.patchMarker)) {
    return { ok: false, reason: 'INVALID_PATCH_MARKER_NEWLINE' };
  }
  if (!profile.mainAnchorReplacement.includes(profile.patchMarker)) {
    return { ok: false, reason: 'INVALID_MAIN_ANCHOR_REPLACEMENT_MISSING_MARKER' };
  }
  if (
    profile.isolatedWorldId !== undefined &&
    (!Number.isInteger(profile.isolatedWorldId) || profile.isolatedWorldId <= 0 || profile.isolatedWorldId >= 100000)
  ) {
    return { ok: false, reason: 'INVALID_ISOLATED_WORLD_ID' };
  }
  if (profile.legacyPatchMarkers !== undefined && !Array.isArray(profile.legacyPatchMarkers)) {
    return { ok: false, reason: 'INVALID_LEGACY_PATCH_MARKERS' };
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
