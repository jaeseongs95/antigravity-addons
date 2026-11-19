'use strict';

/**
 * Vendor-neutral Addon Lifecycle Coordinator.
 * - Validates every manifest against Ajv schema, confinement, and host compatibility.
 * - Deterministic sorting by (loadOrder ASC, pluginId ASC).
 * - Filters out disabled plugins via injected `isEnabled(pluginId)` read-only gate.
 * - Isolates invalid manifests and slot/namespace/IPC conflicts without blocking healthy peers.
 */

const { validateAddonManifest } = require('./manifest-validator');
const { createSlotRegistry } = require('./slot-registry');

function planAddonExecution(
  rawManifestEntries,
  {
    pluginsRootDir = null,
    checkFilesExist = false,
    hostProfileId = null,
    hostVersion = null,
    isEnabled = () => true,
  } = {}
) {
  const validItems = [];
  const rejected = [];

  for (const item of rawManifestEntries || []) {
    const source = item && item.source ? item.source : 'unknown';
    const raw = item && item.manifest !== undefined ? item.manifest : item;
    const check = validateAddonManifest(raw, {
      pluginsRootDir,
      checkFilesExist,
      hostProfileId,
      hostVersion,
    });
    if (!check.ok) {
      rejected.push({
        source,
        pluginId: raw && typeof raw.pluginId === 'string' ? raw.pluginId : null,
        reason: check.reason,
        errors: check.errors || [],
      });
      continue;
    }
    validItems.push({ source, ...check });
  }

  validItems.sort((a, b) => {
    if (a.loadOrder !== b.loadOrder) return a.loadOrder - b.loadOrder;
    return a.pluginId.localeCompare(b.pluginId);
  });

  const slotRegistry = createSlotRegistry();
  const active = [];
  const disabled = [];

  for (const item of validItems) {
    let enabled = false;
    try {
      enabled = Boolean(isEnabled(item.pluginId));
    } catch (_err) {
      enabled = false;
    }
    if (!enabled) {
      disabled.push({
        source: item.source,
        pluginId: item.pluginId,
        reason: 'SKIPPED_DISABLED',
      });
      continue;
    }

    const slotCheck = slotRegistry.registerManifestSlots(item.manifest);
    if (!slotCheck.ok) {
      rejected.push({
        source: item.source,
        pluginId: item.pluginId,
        reason: slotCheck.reason,
        conflicts: slotCheck.conflicts,
      });
      continue;
    }

    active.push(item);
  }

  return {
    active,
    disabled,
    rejected,
    slots: slotRegistry.snapshot(),
  };
}

module.exports = {
  planAddonExecution,
};
