'use strict';

/**
 * Electron implementation of `HostLifecyclePort` (ISP / DIP / SRP).
 * Owns Electron profile/path resolution, ASAR status/diagnostics, atomic install+loader write,
 * and byte-identical rollback.
 */

const fs = require('node:fs');
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
} = require('../fs-lock-atomic');
const {
  isAsarHostInstalled,
  installAsarAddonHost,
  rollbackAsarAddonHost,
  diagnoseAsarState,
} = require('./asar-patcher');
const { buildHostLoaderScriptSource } = require('./host-loader-builder');

function resolveElectronPaths(profile, env = process.env, pathOverrides = null) {
  const activeProfile = assertValidElectronHostProfile(profile);
  const base = activeProfile.resolvePaths(env);
  const overrides = pathOverrides && typeof pathOverrides === 'object' ? pathOverrides : {};
  const resolved = { ...(base && typeof base === 'object' ? base : {}), ...overrides };

  // NB2: If caller overrides ADDONS_DIR without explicitly overriding ADDONS_LOCK_PATH,
  // re-derive ADDONS_LOCK_PATH next to the overridden ADDONS_DIR so locks stay co-located.
  const addonsDirOverridden =
    typeof overrides.ADDONS_DIR === 'string' &&
    overrides.ADDONS_DIR.trim() !== '' &&
    (!base || overrides.ADDONS_DIR !== base.ADDONS_DIR);
  const lockExplicitlyOverridden =
    typeof overrides.ADDONS_LOCK_PATH === 'string' && overrides.ADDONS_LOCK_PATH.trim() !== '';

  if ((!resolved.ADDONS_LOCK_PATH || (addonsDirOverridden && !lockExplicitlyOverridden)) && resolved.ADDONS_DIR) {
    resolved.ADDONS_LOCK_PATH = path.join(path.dirname(resolved.ADDONS_DIR), 'addon-host-addons.lock');
  }

  assertValidResolvedElectronPaths(resolved, ELECTRON_REQUIRED_PATH_KEYS);
  return { activeProfile, paths: resolved };
}

function createElectronHostLifecyclePort() {
  return Object.freeze({
    validateProfile(profile) {
      return assertValidElectronHostProfile(profile);
    },

    resolveContext(profile, env = process.env, pathOverrides = null) {
      return resolveElectronPaths(profile, env, pathOverrides);
    },

    getHostStatus(ctx) {
      const { activeProfile, paths } = ctx;
      const installed = isAsarHostInstalled(paths.ASAR_PATH, activeProfile);
      return {
        installed,
        patchMarker: activeProfile.patchMarker,
        loaderScriptPresent: fs.existsSync(paths.LOADER_SCRIPT_PATH),
        addonsDir: paths.ADDONS_DIR,
      };
    },

    diagnoseHost(ctx) {
      const { activeProfile, paths } = ctx;
      const asarDiag = diagnoseAsarState(paths, activeProfile);
      const backupHealthy =
        !asarDiag.asarExists || !asarDiag.hostInstalled || Boolean(asarDiag.origBackupValid);
      return {
        ...asarDiag,
        healthy: !asarDiag.hasLegacyConflict && backupHealthy,
      };
    },

    installHost(ctx, { replaceLegacy = false, hostVersion = '1.0.1' } = {}) {
      const { activeProfile, paths } = ctx;
      const asar = installAsarAddonHost(
        { ...paths, ALLOW_REPLACE_LEGACY: Boolean(replaceLegacy) },
        activeProfile
      );
      const asarOk =
        asar.status === 'INSTALLED' ||
        asar.status === 'ALREADY_INSTALLED' ||
        asar.status === 'SKIPPED_NO_ASAR';

      if (asarOk) {
        const lockRes = acquireExclusiveLockDetailed(paths.ADDONS_LOCK_PATH, 30000);
        if (!lockRes.ok) {
          return {
            ok: false,
            status: 'FAILED',
            reason: lockRes.code,
            error: lockRes.error,
            loaderScriptPath: paths.LOADER_SCRIPT_PATH,
            asar,
          };
        }
        try {
          writeAtomicSync(
            paths.LOADER_SCRIPT_PATH,
            buildHostLoaderScriptSource(paths, activeProfile, { hostVersion })
          );
        } finally {
          releaseExclusiveLock(paths.ADDONS_LOCK_PATH, lockRes.token);
        }
      }

      const status =
        asar.status === 'SKIPPED_NO_ASAR' ? 'SKIPPED_NO_ASAR' : asarOk ? 'INSTALLED' : 'FAILED';
      return {
        ok: asarOk,
        status,
        loaderScriptPath: paths.LOADER_SCRIPT_PATH,
        asar,
      };
    },

    rollbackHost(ctx, { force = false } = {}) {
      const { activeProfile, paths } = ctx;
      const out = rollbackAsarAddonHost(paths, activeProfile, { force: Boolean(force) });
      const ok =
        out.status === 'ROLLED_BACK' ||
        out.status === 'ALREADY_UNPATCHED' ||
        out.status === 'SKIPPED_NO_ASAR';
      return { ok, ...out };
    },
  });
}

module.exports = {
  resolveElectronPaths,
  createElectronHostLifecyclePort,
};
