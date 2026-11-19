'use strict';

/**
 * Vendor-neutral UI Slot, Storage Namespace, and IPC Channel Prefix ownership & collision detector.
 * - Blocks duplicate `slotId` across plugins.
 * - Blocks exclusive slot kind collision (except `custom` slots, which are isolated per `slotId`).
 * - Blocks duplicate `isolation.storageNamespace` and colliding `isolation.ipcChannelPrefix`.
 */

function createSlotRegistry() {
  const ownersBySlotId = new Map();
  const entriesBySlotKind = new Map();
  const ownersByStorageNs = new Map();
  const ownersByIpcPrefix = new Map();

  function registerManifestSlots(manifest) {
    const pluginId = manifest && manifest.pluginId;
    const uiSlots = Array.isArray(manifest && manifest.uiSlots) ? manifest.uiSlots : [];
    const isolation = (manifest && manifest.isolation) || {};
    const conflicts = [];

    // 1) Duplicate slotId within the same manifest
    const localSeen = new Set();
    for (const s of uiSlots) {
      if (localSeen.has(s.slotId)) {
        conflicts.push({
          code: 'ERR_SLOT_CONFLICT',
          kind: 'DUPLICATE_SLOT_ID_IN_MANIFEST',
          slot: s.slot,
          slotId: s.slotId,
          existingPluginId: pluginId,
          incomingPluginId: pluginId,
        });
      }
      localSeen.add(s.slotId);
    }

    // 2) Cross-plugin slotId and exclusive slot collisions
    for (const s of uiSlots) {
      const existingOwner = ownersBySlotId.get(s.slotId);
      if (existingOwner && existingOwner !== pluginId) {
        conflicts.push({
          code: 'ERR_SLOT_CONFLICT',
          kind: 'DUPLICATE_SLOT_ID',
          slot: s.slot,
          slotId: s.slotId,
          existingPluginId: existingOwner,
          incomingPluginId: pluginId,
        });
      }

      if (s.slot !== 'custom') {
        const existingKindEntries = entriesBySlotKind.get(s.slot) || [];
        for (const ex of existingKindEntries) {
          if (ex.pluginId === pluginId) continue;
          if (ex.exclusive || Boolean(s.exclusive)) {
            conflicts.push({
              code: 'ERR_SLOT_CONFLICT',
              kind: 'EXCLUSIVE_SLOT_CONFLICT',
              slot: s.slot,
              slotId: s.slotId,
              existingPluginId: ex.pluginId,
              incomingPluginId: pluginId,
            });
          }
        }
      }
    }

    // 3) Storage namespace collision (defaults to pluginId when omitted so implicit defaults cannot collide)
    const storageNs =
      typeof isolation.storageNamespace === 'string' && isolation.storageNamespace.trim()
        ? isolation.storageNamespace.trim()
        : typeof pluginId === 'string' && pluginId.trim()
          ? pluginId.trim()
          : null;
    if (storageNs) {
      const exNsOwner = ownersByStorageNs.get(storageNs);
      if (exNsOwner && exNsOwner !== pluginId) {
        conflicts.push({
          code: 'ERR_NAMESPACE_CONFLICT',
          kind: 'STORAGE_NAMESPACE_CONFLICT',
          storageNamespace: storageNs,
          existingPluginId: exNsOwner,
          incomingPluginId: pluginId,
        });
      }
    }

    // 4) IPC channel prefix collision (exact or prefix overlap)
    const ipcPrefix = typeof isolation.ipcChannelPrefix === 'string' && isolation.ipcChannelPrefix.trim()
      ? isolation.ipcChannelPrefix.trim()
      : null;
    if (ipcPrefix) {
      for (const [existingPrefix, exIpcOwner] of ownersByIpcPrefix.entries()) {
        if (exIpcOwner === pluginId) continue;
        if (
          existingPrefix === ipcPrefix ||
          existingPrefix.startsWith(ipcPrefix) ||
          ipcPrefix.startsWith(existingPrefix)
        ) {
          conflicts.push({
            code: 'ERR_IPC_PREFIX_CONFLICT',
            kind: 'IPC_CHANNEL_PREFIX_CONFLICT',
            ipcChannelPrefix: ipcPrefix,
            existingPrefix,
            existingPluginId: exIpcOwner,
            incomingPluginId: pluginId,
          });
        }
      }
    }

    if (conflicts.length > 0) {
      return { ok: false, reason: conflicts[0].code, conflicts };
    }

    for (const s of uiSlots) {
      ownersBySlotId.set(s.slotId, pluginId);
      if (!entriesBySlotKind.has(s.slot)) {
        entriesBySlotKind.set(s.slot, []);
      }
      entriesBySlotKind.get(s.slot).push({
        pluginId,
        slotId: s.slotId,
        exclusive: Boolean(s.exclusive),
        scope: s.scope || 'addon-owned-slot',
        anchor: typeof s.anchor === 'string' && s.anchor ? s.anchor : null,
      });
    }
    if (storageNs) ownersByStorageNs.set(storageNs, pluginId);
    if (ipcPrefix) ownersByIpcPrefix.set(ipcPrefix, pluginId);

    return { ok: true, conflicts: [] };
  }

  function snapshot() {
    const bySlotId = Object.create(null);
    for (const [k, v] of ownersBySlotId.entries()) bySlotId[k] = v;
    const bySlot = Object.create(null);
    for (const [k, v] of entriesBySlotKind.entries()) bySlot[k] = v.map((x) => ({ ...x }));
    const storageNamespaces = Object.create(null);
    for (const [k, v] of ownersByStorageNs.entries()) storageNamespaces[k] = v;
    const ipcPrefixes = Object.create(null);
    for (const [k, v] of ownersByIpcPrefix.entries()) ipcPrefixes[k] = v;
    return { bySlotId, bySlot, storageNamespaces, ipcPrefixes };
  }

  return {
    registerManifestSlots,
    snapshot,
  };
}

function detectSlotConflicts(manifests) {
  const registry = createSlotRegistry();
  const allConflicts = [];
  for (const m of manifests || []) {
    const res = registry.registerManifestSlots(m);
    if (!res.ok) {
      allConflicts.push(...res.conflicts);
    }
  }
  return {
    ok: allConflicts.length === 0,
    conflicts: allConflicts,
    slots: registry.snapshot(),
  };
}

module.exports = {
  createSlotRegistry,
  detectSlotConflicts,
};
