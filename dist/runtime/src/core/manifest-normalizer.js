'use strict';

/**
 * Pure vendor- & runtime-neutral AddonManifest v1/v2 -> normalized v2 converter (SRP / DIP).
 *
 * Rules:
 * - v1 manifests preserve `shadow: false` on all slots (non-breaking v1 compat).
 * - v2 manifests default `shadow: true` on UI slots unless explicitly `shadow: false`.
 * - `document-transform` slots are ALWAYS forced to `shadow: false`.
 * - Downstream registries and runtimes consume ONLY the normalized v2 shape.
 */

function normalizeSlotToV2(slot, sourceSchemaVersion) {
  const isDocTransform = slot.slot === 'document-transform';
  let shadow;
  if (isDocTransform) {
    shadow = false;
  } else if (sourceSchemaVersion === 1) {
    shadow = false;
  } else {
    shadow = slot.shadow !== false;
  }
  return {
    ...slot,
    exclusive: Boolean(slot.exclusive),
    scope: slot.scope || 'addon-owned-slot',
    shadow,
  };
}

function normalizeManifestToV2(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('ERR_INVALID_MANIFEST_FOR_NORMALIZATION');
  }
  const sourceSchemaVersion = manifest.schemaVersion === 2 ? 2 : 1;
  const rawSlots = Array.isArray(manifest.uiSlots) ? manifest.uiSlots : [];
  const rawIsolation = manifest.isolation && typeof manifest.isolation === 'object' ? manifest.isolation : {};

  return {
    ...manifest,
    schemaVersion: 2,
    sourceSchemaVersion,
    loadOrder: typeof manifest.loadOrder === 'number' ? manifest.loadOrder : 100,
    uiSlots: rawSlots.map((s) => normalizeSlotToV2(s, sourceSchemaVersion)),
    isolation: {
      ...rawIsolation,
      respectsNoTranslate: rawIsolation.respectsNoTranslate !== false,
    },
    integrity:
      manifest.integrity && typeof manifest.integrity === 'object'
        ? {
            rendererSha256: manifest.integrity.rendererSha256 || null,
            mainHookBundleSha256: manifest.integrity.mainHookBundleSha256 || null,
          }
        : {
            rendererSha256: null,
            mainHookBundleSha256: null,
          },
  };
}

module.exports = {
  normalizeSlotToV2,
  normalizeManifestToV2,
};
