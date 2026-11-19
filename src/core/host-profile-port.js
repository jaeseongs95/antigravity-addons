'use strict';

/**
 * Vendor-neutral HostProfile Port validator.
 * Any desktop host supplies a HostProfile matching this contract without modifying `src/core/`
 * or host-runtime adapters.
 */

const REQUIRED_STRING_FIELDS = Object.freeze([
  'id',
  'patchMarker',
  'mainEntry',
  'mainAnchorTarget',
  'mainAnchorReplacement',
  'loaderEnvVar',
]);

function validateHostProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return { ok: false, reason: 'INVALID_HOST_PROFILE_OBJECT' };
  }
  for (const key of REQUIRED_STRING_FIELDS) {
    if (typeof profile[key] !== 'string' || !profile[key].trim()) {
      return { ok: false, reason: `MISSING_HOST_PROFILE_FIELD:${key}` };
    }
  }
  if (typeof profile.resolvePaths !== 'function') {
    return { ok: false, reason: 'MISSING_HOST_PROFILE_RESOLVE_PATHS' };
  }
  if (profile.legacyPatchMarkers !== undefined && !Array.isArray(profile.legacyPatchMarkers)) {
    return { ok: false, reason: 'INVALID_LEGACY_PATCH_MARKERS' };
  }
  return { ok: true };
}

function assertValidHostProfile(profile) {
  const res = validateHostProfile(profile);
  if (!res.ok) {
    throw new Error(res.reason);
  }
  return profile;
}

module.exports = {
  REQUIRED_STRING_FIELDS,
  validateHostProfile,
  assertValidHostProfile,
};
