'use strict';

/**
 * Electron implementation of `AddonStorePort` (ISP / DIP / SRP).
 * Owns manifest directory planning, locked atomic registration/unregistration,
 * duplicate non-canonical manifest cleanup (NB1), and loader script refresh.
 */

const fs = require('node:fs');
const path = require('node:path');
const { validateAddonManifest } = require('../../core/manifest-validator');
const { detectSlotConflicts } = require('../../core/slot-registry');
const {
  acquireExclusiveLockDetailed,
  releaseExclusiveLock,
  writeAtomicSync,
} = require('../fs-lock-atomic');
const {
  loadRawManifestsFromDir,
  collectExecutableAddons,
  buildHostLoaderScriptSource,
} = require('./host-loader-builder');

function createElectronAddonStorePort() {
  return Object.freeze({
    planAddons(ctx, { checkFilesExist = true, hostVersion = '1.0.1' } = {}) {
      const { activeProfile, paths } = ctx;
      return collectExecutableAddons(paths, {
        checkFilesExist,
        hostProfileId: activeProfile.id,
        hostVersion,
      });
    },

    validateManifest(ctx, manifest, { checkFilesExist = false, hostVersion = '1.0.1' } = {}) {
      const { activeProfile, paths } = ctx;
      return validateAddonManifest(manifest, {
        pluginsRootDir: paths.PLUGINS_ROOT_DIR,
        checkFilesExist,
        hostProfileId: activeProfile.id,
        hostVersion,
      });
    },

    registerManifest(ctx, manifest, { hostVersion = '1.0.1' } = {}) {
      const { activeProfile, paths } = ctx;
      const lockRes = acquireExclusiveLockDetailed(paths.ADDONS_LOCK_PATH, 30000);
      if (!lockRes.ok) {
        return { ok: false, reason: lockRes.code, error: lockRes.error };
      }
      try {
        // NB5: Validate manifest + check slot conflicts + write atomically under the single exclusive lock
        const check = validateAddonManifest(manifest, {
          pluginsRootDir: paths.PLUGINS_ROOT_DIR,
          checkFilesExist: true,
          hostProfileId: activeProfile.id,
          hostVersion,
        });
        if (!check.ok) {
          return { ok: false, reason: check.reason, errors: check.errors };
        }
        const existingEntries = loadRawManifestsFromDir(paths.ADDONS_DIR);
        const existingOther = existingEntries
          .map((e) => e.manifest)
          .filter((m) => m && typeof m.pluginId === 'string' && m.pluginId !== manifest.pluginId);
        const slotCheck = detectSlotConflicts([...existingOther, manifest]);
        if (!slotCheck.ok) {
          return { ok: false, reason: slotCheck.conflicts[0].code, conflicts: slotCheck.conflicts };
        }

        const targetPath = path.join(paths.ADDONS_DIR, `${manifest.pluginId}.json`);
        // NB1: Remove any stale non-canonical filename holding the same pluginId before writing canonical file
        for (const entry of existingEntries) {
          if (
            entry.manifest &&
            entry.manifest.pluginId === manifest.pluginId &&
            path.resolve(entry.source) !== path.resolve(targetPath) &&
            fs.existsSync(entry.source)
          ) {
            fs.unlinkSync(entry.source);
          }
        }

        writeAtomicSync(targetPath, JSON.stringify(manifest, null, 2) + '\n');
        writeAtomicSync(
          paths.LOADER_SCRIPT_PATH,
          buildHostLoaderScriptSource(paths, activeProfile, { hostVersion })
        );
        return { ok: true, pluginId: manifest.pluginId, manifestPath: targetPath };
      } finally {
        releaseExclusiveLock(paths.ADDONS_LOCK_PATH, lockRes.token);
      }
    },

    unregisterManifest(ctx, pluginId, { hostVersion = '1.0.1' } = {}) {
      const { activeProfile, paths } = ctx;
      const lockRes = acquireExclusiveLockDetailed(paths.ADDONS_LOCK_PATH, 30000);
      if (!lockRes.ok) {
        return { ok: false, reason: lockRes.code, error: lockRes.error };
      }
      try {
        const targetPath = path.join(paths.ADDONS_DIR, `${pluginId}.json`);
        const toDelete = new Set();
        if (fs.existsSync(targetPath)) {
          toDelete.add(path.resolve(targetPath));
        }
        // NB1: Also remove any non-canonical JSON files in addons.d/ that declare the same pluginId
        for (const entry of loadRawManifestsFromDir(paths.ADDONS_DIR)) {
          if (entry.manifest && entry.manifest.pluginId === pluginId && fs.existsSync(entry.source)) {
            toDelete.add(path.resolve(entry.source));
          }
        }
        if (toDelete.size === 0) {
          return { ok: true, removed: false, pluginId };
        }
        for (const filePath of toDelete) {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
        if (paths.LOADER_SCRIPT_PATH && fs.existsSync(paths.LOADER_SCRIPT_PATH)) {
          writeAtomicSync(
            paths.LOADER_SCRIPT_PATH,
            buildHostLoaderScriptSource(paths, activeProfile, { hostVersion })
          );
        }
        return { ok: true, removed: true, removedCount: toDelete.size, pluginId };
      } finally {
        releaseExclusiveLock(paths.ADDONS_LOCK_PATH, lockRes.token);
      }
    },
  });
}

module.exports = {
  createElectronAddonStorePort,
};
