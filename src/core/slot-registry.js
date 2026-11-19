'use strict';

/**
 * Vendor-neutral UI Slot ownership and collision detector.
 * Prevents two plugins from claiming the same `slotId` or colliding on an `exclusive: true` slot.
 */

function createSlotRegistry() {
  const ownersBySlotId = new Map();
  const entriesBySlotKind = new Map();

  function registerManifestSlots(manifest) {
    const pluginId = manifest && manifest.pluginId;
    const uiSlots = Array.isArray(manifest && manifest.uiSlots) ? manifest.uiSlots : [];
    const conflicts = [];

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

    if (conflicts.length > 0) {
      return { ok: false, reason: 'ERR_SLOT_CONFLICT', conflicts };
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
      });
    }

    return { ok: true, conflicts: [] };
  }

  function snapshot() {
    const bySlotId = {};
    for (const [k, v] of ownersBySlotId.entries()) bySlotId[k] = v;
    const bySlot = {};
    for (const [k, v] of entriesBySlotKind.entries()) bySlot[k] = v.map((x) => ({ ...x }));
    return { bySlotId, bySlot };
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
