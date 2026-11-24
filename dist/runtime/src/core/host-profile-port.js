'use strict';

/**
 * Vendor- and runtime-neutral HostProfile Core Port validator (DIP / ISP / OCP).
 *
 * `src/core/` MUST NOT depend on or require any host-runtime-specific fields.
 * Runtime-specific adapters extend this base contract with their own required
 * fields and resolved path checks.
 */

const CORE_PROFILE_STRING_FIELDS = Object.freeze(['id']);

function validateHostProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return { ok: false, reason: 'INVALID_HOST_PROFILE_OBJECT' };
  }
  for (const key of CORE_PROFILE_STRING_FIELDS) {
    if (typeof profile[key] !== 'string' || !profile[key].trim()) {
      return { ok: false, reason: `MISSING_HOST_PROFILE_FIELD:${key}` };
    }
  }
  if (typeof profile.resolvePaths !== 'function') {
    return { ok: false, reason: 'MISSING_HOST_PROFILE_RESOLVE_PATHS' };
  }
  if (profile.compatibleHostProfiles !== undefined) {
    if (
      !Array.isArray(profile.compatibleHostProfiles) ||
      profile.compatibleHostProfiles.some((p) => typeof p !== 'string' || !p.trim())
    ) {
      return { ok: false, reason: 'INVALID_HOST_PROFILE_COMPATIBLE_PROFILES' };
    }
  }
  if (profile.supportedCapabilities !== undefined) {
    if (
      !Array.isArray(profile.supportedCapabilities) ||
      profile.supportedCapabilities.length === 0 ||
      profile.supportedCapabilities.some((c) => typeof c !== 'string' || !c.trim())
    ) {
      return { ok: false, reason: 'INVALID_HOST_PROFILE_SUPPORTED_CAPABILITIES' };
    }
  }
  if (profile.resolveConfigScopes !== undefined && typeof profile.resolveConfigScopes !== 'function') {
    return { ok: false, reason: 'INVALID_HOST_PROFILE_RESOLVE_CONFIG_SCOPES' };
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
  CORE_PROFILE_STRING_FIELDS,
  validateHostProfile,
  assertValidHostProfile,
};
