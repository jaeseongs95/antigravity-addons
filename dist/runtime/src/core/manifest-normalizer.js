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

function normalizePermissionsV3(manifest, rawConfigBridge) {
  const perms = manifest && manifest.permissions && typeof manifest.permissions === 'object' ? manifest.permissions : {};
  const ui = perms.ui && typeof perms.ui === 'object' ? perms.ui : {};
  const storage = perms.storage && typeof perms.storage === 'object' ? perms.storage : {};
  const events = perms.events && typeof perms.events === 'object' ? perms.events : {};
  const services = perms.services && typeof perms.services === 'object' ? perms.services : {};
  const net = perms.net && typeof perms.net === 'object' ? perms.net : null;
  const dom = perms.dom && typeof perms.dom === 'object' ? perms.dom : null;

  return {
    ui: {
      toasts: ui.toasts !== false,
      dialogs: ui.dialogs !== false,
      overlays: ui.overlays !== false,
      commands: ui.commands !== false,
      statusItems: ui.statusItems !== false,
      settingsPages: ui.settingsPages !== false,
      canvas: ui.canvas !== false,
    },
    storage: {
      maxBytes:
        Number.isInteger(storage.maxBytes) && storage.maxBytes >= 1024 && storage.maxBytes <= 262144
          ? storage.maxBytes
          : 65536,
      namespace: typeof storage.namespace === 'string' && storage.namespace ? storage.namespace : manifest.pluginId,
    },
    events: {
      subscribe: Array.isArray(events.subscribe) ? events.subscribe.slice() : [],
      emit: Array.isArray(events.emit) ? events.emit.slice() : [],
    },
    services: {
      provide: Array.isArray(services.provide)
        ? services.provide.map((p) => ({
            name: p.name,
            allowedCallers: Array.isArray(p.allowedCallers) ? p.allowedCallers.slice() : [],
          }))
        : [],
      consume: Array.isArray(services.consume) ? services.consume.slice() : [],
    },
    net: net
      ? {
          httpsHosts: Array.isArray(net.httpsHosts) ? net.httpsHosts.map((h) => String(h).trim().toLowerCase()) : [],
          localLoopback: Array.isArray(net.localLoopback) ? net.localLoopback.slice() : [],
          ...(net.userApprovedHttps === true ? { userApprovedHttps: true } : {}),
        }
      : null,
    dom: dom
      ? {
          documentTransform: Boolean(dom.documentTransform),
          anchors: Array.isArray(dom.anchors) ? dom.anchors.slice() : [],
        }
      : null,
    configBridge: rawConfigBridge && rawConfigBridge.scopes.length > 0 ? rawConfigBridge : null,
  };
}

function normalizeManifestToV2(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('ERR_INVALID_MANIFEST_FOR_NORMALIZATION');
  }
  const sourceSchemaVersion = manifest.schemaVersion === 3 ? 3 : manifest.schemaVersion === 2 ? 2 : 1;
  const rawSlots = Array.isArray(manifest.uiSlots) ? manifest.uiSlots : [];
  const rawIsolation = manifest.isolation && typeof manifest.isolation === 'object' ? manifest.isolation : {};
  const rawSettingsBridge =
    manifest.settingsBridge &&
    typeof manifest.settingsBridge === 'object' &&
    typeof manifest.settingsBridge.fileName === 'string' &&
    manifest.settingsBridge.fileName.length > 0
      ? {
          fileName: manifest.settingsBridge.fileName,
          maxBytes:
            Number.isInteger(manifest.settingsBridge.maxBytes) &&
            manifest.settingsBridge.maxBytes >= 1024 &&
            manifest.settingsBridge.maxBytes <= 262144
              ? manifest.settingsBridge.maxBytes
              : 65536,
        }
      : null;

  const rawConfigSource =
    manifest.configBridge ||
    (manifest.permissions && typeof manifest.permissions === 'object' ? manifest.permissions.configBridge : null);
  const rawConfigBridge =
    rawConfigSource &&
    typeof rawConfigSource === 'object' &&
    Array.isArray(rawConfigSource.scopes) &&
    rawConfigSource.scopes.length > 0
      ? {
          scopes: rawConfigSource.scopes
            .filter((s) => s && typeof s === 'object' && typeof s.scopeId === 'string' && s.scopeId.length > 0)
            .map((s) => ({
              scopeId: s.scopeId,
              access: s.access === 'rw' ? 'rw' : 'ro',
              maxBytes:
                Number.isInteger(s.maxBytes) && s.maxBytes >= 1024 && s.maxBytes <= 262144 ? s.maxBytes : 262144,
            })),
        }
      : null;

  const normalizedSlots = rawSlots.map((s) => normalizeSlotToV2(s, sourceSchemaVersion));
  const normalizedPermissions = sourceSchemaVersion === 3 ? normalizePermissionsV3(manifest, rawConfigBridge) : null;

  return {
    ...manifest,
    schemaVersion: sourceSchemaVersion === 3 ? 3 : 2,
    apiVersion: sourceSchemaVersion === 3 ? 3 : 2,
    sourceSchemaVersion,
    loadOrder: typeof manifest.loadOrder === 'number' ? manifest.loadOrder : 100,
    uiSlots: normalizedSlots,
    isolation: {
      noTranslate: rawIsolation.noTranslate !== false,
      i18nSelfManaged: Boolean(rawIsolation.i18nSelfManaged),
      ...rawIsolation,
      respectsNoTranslate: rawIsolation.respectsNoTranslate !== false,
    },
    settingsBridge: rawSettingsBridge,
    configBridge: rawConfigBridge && rawConfigBridge.scopes.length > 0 ? rawConfigBridge : null,
    ...(normalizedPermissions ? { permissions: normalizedPermissions } : {}),
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
  normalizePermissionsV3,
  normalizeManifestToV2,
  normalizeManifest: normalizeManifestToV2,
};
