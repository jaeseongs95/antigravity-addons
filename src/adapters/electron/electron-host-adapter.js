'use strict';

/**
 * Electron Host Adapter Facade (DIP / SRP).
 * Implements the HostAdapter port consumed by `src/cli/main.js`, keeping the CLI decoupled
 * from concrete Electron/ASAR/Antigravity modules.
 */

const path = require('node:path');
const {
  assertValidElectronHostProfile,
  assertValidResolvedElectronPaths,
  ELECTRON_REQUIRED_PATH_KEYS,
} = require('./electron-host-profile-port');
const {
  acquireExclusiveLockDetailed,
  releaseExclusiveLock,
  writeAtomicSync,
  isAsarHostInstalled,
  installAsarAddonHost,
  rollbackAsarAddonHost,
  diagnoseAsarState,
} = require('./asar-patcher');
const {
  loadRawManifestsFromDir,
  collectExecutableAddons,
  buildHostLoaderScriptSource,
} = require('./host-loader-builder');

function createElectronHostAdapter() {
  return Object.freeze({
    validateProfile(profile) {
      return assertValidElectronHostProfile(profile);
    },

    resolvePaths(profile, env = process.env, pathOverrides = null, requiredKeys = ELECTRON_REQUIRED_PATH_KEYS) {
      const activeProfile = assertValidElectronHostProfile(profile);
      const base = activeProfile.resolvePaths(env);
      const resolved = { ...(base && typeof base === 'object' ? base : {}), ...(pathOverrides || {}) };
      if (!resolved.ADDONS_LOCK_PATH && resolved.ADDONS_DIR) {
        resolved.ADDONS_LOCK_PATH = path.join(path.dirname(resolved.ADDONS_DIR), 'addon-host-addons.lock');
      }
      assertValidResolvedElectronPaths(resolved, requiredKeys);
      return { activeProfile, paths: resolved };
    },

    isHostInstalled(paths, profile) {
      return isAsarHostInstalled(paths.ASAR_PATH, profile);
    },

    diagnoseHostState(paths, profile) {
      return diagnoseAsarState(paths, profile);
    },

    installHost(paths, profile, options = {}) {
      return installAsarAddonHost(
        { ...paths, ALLOW_REPLACE_LEGACY: Boolean(options.replaceLegacy) },
        profile
      );
    },

    rollbackHost(paths, profile, options = {}) {
      return rollbackAsarAddonHost(paths, profile, { force: Boolean(options.force) });
    },

    collectExecutableAddons(paths, options) {
      return collectExecutableAddons(paths, options);
    },

    loadRawManifestsFromDir(addonsDir) {
      return loadRawManifestsFromDir(addonsDir);
    },

    buildLoaderSource(paths, profile, options) {
      return buildHostLoaderScriptSource(paths, profile, options);
    },

    acquireLock(lockPath, staleMs) {
      return acquireExclusiveLockDetailed(lockPath, staleMs);
    },

    releaseLock(lockPath, token) {
      return releaseExclusiveLock(lockPath, token);
    },

    writeAtomicSync(targetPath, data, options) {
      return writeAtomicSync(targetPath, data, options);
    },
  });
}

module.exports = {
  createElectronHostAdapter,
};
