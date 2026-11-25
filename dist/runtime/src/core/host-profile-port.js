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
  if (profile.uiSurfaces !== undefined) {
    if (!profile.uiSurfaces || typeof profile.uiSurfaces !== 'object' || Array.isArray(profile.uiSurfaces)) {
      return { ok: false, reason: 'INVALID_HOST_PROFILE_UI_SURFACES' };
    }
    for (const [surfaceId, spec] of Object.entries(profile.uiSurfaces)) {
      if (!surfaceId || !spec || typeof spec !== 'object' || Array.isArray(spec)) {
        return { ok: false, reason: `INVALID_HOST_PROFILE_UI_SURFACE:${surfaceId}` };
      }
      const listKeys = [
        'selectors',
        'excludeLeftSelectors',
        'excludeRightSelectors',
        'excludeTopSelectors',
        'excludeBottomSelectors',
      ];
      for (const k of listKeys) {
        if (
          spec[k] !== undefined &&
          (!Array.isArray(spec[k]) || spec[k].some((item) => typeof item !== 'string' || !item.trim()))
        ) {
          return { ok: false, reason: `INVALID_HOST_PROFILE_UI_SURFACE_SELECTORS:${surfaceId}:${k}` };
        }
      }
      if (spec.priority !== undefined && (typeof spec.priority !== 'number' || !Number.isFinite(spec.priority))) {
        return { ok: false, reason: `INVALID_HOST_PROFILE_UI_SURFACE_PRIORITY:${surfaceId}` };
      }
      if (spec.safeInsets !== undefined) {
        if (!spec.safeInsets || typeof spec.safeInsets !== 'object' || Array.isArray(spec.safeInsets)) {
          return { ok: false, reason: `INVALID_HOST_PROFILE_UI_SURFACE_INSETS:${surfaceId}` };
        }
        for (const edge of ['top', 'right', 'bottom', 'left']) {
          const val = spec.safeInsets[edge];
          if (val !== undefined && (typeof val !== 'number' || !Number.isFinite(val) || val < 0)) {
            return { ok: false, reason: `INVALID_HOST_PROFILE_UI_SURFACE_INSETS:${surfaceId}:${edge}` };
          }
        }
      }
    }
  }
  if (profile.uiGridMerges !== undefined) {
    if (!Array.isArray(profile.uiGridMerges)) {
      return { ok: false, reason: 'INVALID_HOST_PROFILE_UI_GRID_MERGES' };
    }
    for (let i = 0; i < profile.uiGridMerges.length; i += 1) {
      const spec = profile.uiGridMerges[i];
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        return { ok: false, reason: `INVALID_HOST_PROFILE_UI_GRID_MERGE:${i}` };
      }
      if (typeof spec.section !== 'string' || !spec.section.trim() || typeof spec.secondary !== 'string' || !spec.secondary.trim()) {
        return { ok: false, reason: `INVALID_HOST_PROFILE_UI_GRID_MERGE_SELECTORS:${i}` };
      }
      if (spec.minWidthPx !== undefined && (typeof spec.minWidthPx !== 'number' || !Number.isFinite(spec.minWidthPx) || spec.minWidthPx < 0)) {
        return { ok: false, reason: `INVALID_HOST_PROFILE_UI_GRID_MERGE_MIN_WIDTH:${i}` };
      }
      if (spec.columns !== undefined && (!Number.isInteger(spec.columns) || spec.columns < 2 || spec.columns > 12)) {
        return { ok: false, reason: `INVALID_HOST_PROFILE_UI_GRID_MERGE_COLUMNS:${i}` };
      }
      if (spec.gapPx !== undefined && (typeof spec.gapPx !== 'number' || !Number.isFinite(spec.gapPx) || spec.gapPx < 0)) {
        return { ok: false, reason: `INVALID_HOST_PROFILE_UI_GRID_MERGE_GAP:${i}` };
      }
      if (spec.headerGapPx !== undefined && (typeof spec.headerGapPx !== 'number' || !Number.isFinite(spec.headerGapPx) || spec.headerGapPx < 0)) {
        return { ok: false, reason: `INVALID_HOST_PROFILE_UI_GRID_MERGE_HEADER_GAP:${i}` };
      }
    }
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
