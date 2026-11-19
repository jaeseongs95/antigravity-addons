'use strict';

/**
 * Electron implementation of `AddonStorePort` (ISP / DIP / SRP).
 * Owns manifest directory planning, locked atomic registration/unregistration,
 * duplicate non-canonical manifest cleanup with strict ADDONS_DIR confinement (R10-NB1),
 * injected Node FileSystemPort binding, and loader script refresh.
 */

const fs = require('node:fs');
const path = require('node:path');
const pkg = require('../../../package.json');
const { validateAddonManifest, validatePluginId } = require('../../core/manifest-validator');
const { detectSlotConflicts } = require('../../core/slot-registry');
const { createNodeFileSystemPort } = require('../node-fs-port');
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

function isDirectChildOfDir(dirPath, candidatePath) {
  const resolvedDir = path.resolve(dirPath);
  const resolvedCandidate = path.resolve(candidatePath);
  const rel = path.relative(resolvedDir, resolvedCandidate);
  return Boolean(rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep));
}

function createElectronAddonStorePort({ fsPort = null } = {}) {
  const activeFsPort = fsPort || createNodeFileSystemPort();

  return Object.freeze({
    planAddons(ctx, { checkFilesExist = true, hostVersion = pkg.version, strictTrustPolicy = false } = {}) {
      const { activeProfile, paths } = ctx;
      return collectExecutableAddons(paths, {
        checkFilesExist,
        hostProfileId: activeProfile.id,
        hostVersion,
        strictTrustPolicy,
        fsPort: activeFsPort,
      });
    },

    validateManifest(
      ctx,
      manifest,
      { checkFilesExist = false, hostVersion = pkg.version, strictTrustPolicy = false } = {}
    ) {
      const { activeProfile, paths } = ctx;
      return validateAddonManifest(manifest, {
        pluginsRootDir: paths.PLUGINS_ROOT_DIR,
        checkFilesExist,
        hostProfileId: activeProfile.id,
        hostVersion,
        strictTrustPolicy,
        fsPort: activeFsPort,
      });
    },

    registerManifest(ctx, manifest, { hostVersion = pkg.version, strictTrustPolicy = false } = {}) {
      const { activeProfile, paths } = ctx;
      const lockRes = acquireExclusiveLockDetailed(paths.ADDONS_LOCK_PATH, 30000);
      if (!lockRes.ok) {
        return { ok: false, reason: lockRes.code, error: lockRes.error };
      }
      try {
        const check = validateAddonManifest(manifest, {
          pluginsRootDir: paths.PLUGINS_ROOT_DIR,
          checkFilesExist: true,
          hostProfileId: activeProfile.id,
          hostVersion,
          strictTrustPolicy,
          fsPort: activeFsPort,
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
        if (!isDirectChildOfDir(paths.ADDONS_DIR, targetPath)) {
          return { ok: false, reason: 'ERR_INVALID_PLUGIN_ID' };
        }
        // R10-NB1: Symmetric isDirectChildOfDir confinement on non-canonical manifest cleanup
        for (const entry of existingEntries) {
          if (
            entry.manifest &&
            entry.manifest.pluginId === manifest.pluginId &&
            path.resolve(entry.source) !== path.resolve(targetPath) &&
            isDirectChildOfDir(paths.ADDONS_DIR, entry.source) &&
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
        return {
          ok: true,
          pluginId: manifest.pluginId,
          trustLevel: check.trustLevel,
          manifestPath: targetPath,
        };
      } finally {
        releaseExclusiveLock(paths.ADDONS_LOCK_PATH, lockRes.token);
      }
    },

    unregisterManifest(ctx, pluginId, { hostVersion = pkg.version } = {}) {
      const { activeProfile, paths } = ctx;
      const idCheck = validatePluginId(pluginId);
      if (!idCheck.ok) {
        return { ok: false, reason: 'ERR_INVALID_PLUGIN_ID', detail: idCheck.reason };
      }
      const targetPath = path.join(paths.ADDONS_DIR, `${pluginId}.json`);
      if (!isDirectChildOfDir(paths.ADDONS_DIR, targetPath)) {
        return { ok: false, reason: 'ERR_INVALID_PLUGIN_ID' };
      }

      const lockRes = acquireExclusiveLockDetailed(paths.ADDONS_LOCK_PATH, 30000);
      if (!lockRes.ok) {
        return { ok: false, reason: lockRes.code, error: lockRes.error };
      }
      try {
        const toDelete = new Set();
        if (fs.existsSync(targetPath)) {
          toDelete.add(path.resolve(targetPath));
        }
        for (const entry of loadRawManifestsFromDir(paths.ADDONS_DIR)) {
          if (
            entry.manifest &&
            entry.manifest.pluginId === pluginId &&
            isDirectChildOfDir(paths.ADDONS_DIR, entry.source) &&
            fs.existsSync(entry.source)
          ) {
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
