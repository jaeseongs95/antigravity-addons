'use strict';

/**
 * Electron implementation of `HostLifecyclePort` (ISP / DIP / SRP).
 * Owns Electron profile/path resolution, ASAR status/diagnostics, transactional
 * loader-first install with automatic compensation rollback, and verified rollback.
 */

const fs = require('node:fs');
const path = require('node:path');
const pkg = require('../../../package.json');
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
  return { hostProfileId: activeProfile.id, activeProfile, paths: resolved };
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
      const integrityHealthy = !asarDiag.origBuildMismatch && !asarDiag.patchedShaMismatch;
      return {
        ...asarDiag,
        healthy: !asarDiag.hasLegacyConflict && backupHealthy && integrityHealthy,
      };
    },

    /**
     * Transactional Install (P2):
     * 1. Acquire addons lock and stage `addon-host-loader.js` FIRST (saving any prior loader bytes).
     *    If loader lock/write fails, `app.asar` is NEVER touched.
     * 2. Patch `app.asar` via `installAsarAddonHost`.
     * 3. If ASAR patching fails, automatically compensate by restoring or removing the staged loader
     *    so zero half-installed state remains.
     */
    installHost(
      ctx,
      {
        replaceLegacy = false,
        refreshOrig = false,
        hostVersion = pkg.version,
        strictTrustPolicy = false,
        mainHookTimeoutMs = 5000,
        rendererExecTimeoutMs = 10000,
      } = {}
    ) {
      const { activeProfile, paths } = ctx;
      const lockRes = acquireExclusiveLockDetailed(paths.ADDONS_LOCK_PATH, 30000);
      if (!lockRes.ok) {
        return {
          ok: false,
          status: 'FAILED',
          phase: 'LOADER_LOCK_FAILED',
          reason: lockRes.code,
          error: lockRes.error,
          loaderScriptPath: paths.LOADER_SCRIPT_PATH,
        };
      }

      const hadPrevLoader = fs.existsSync(paths.LOADER_SCRIPT_PATH);
      let prevLoaderContent = null;
      let loaderStaged = false;

      const compensateStagedLoader = () => {
        if (!loaderStaged) return false;
        try {
          if (hadPrevLoader && prevLoaderContent !== null) {
            writeAtomicSync(paths.LOADER_SCRIPT_PATH, prevLoaderContent);
          } else if (fs.existsSync(paths.LOADER_SCRIPT_PATH)) {
            fs.unlinkSync(paths.LOADER_SCRIPT_PATH);
          }
          return true;
        } catch (_compErr) {
          return false;
        }
      };

      try {
        if (hadPrevLoader) {
          prevLoaderContent = fs.readFileSync(paths.LOADER_SCRIPT_PATH, 'utf8');
        }
        try {
          writeAtomicSync(
            paths.LOADER_SCRIPT_PATH,
            buildHostLoaderScriptSource(paths, activeProfile, {
              hostVersion,
              strictTrustPolicy,
              mainHookTimeoutMs,
              rendererExecTimeoutMs,
            })
          );
          loaderStaged = true;
        } catch (err) {
          return {
            ok: false,
            status: 'FAILED',
            phase: 'LOADER_STAGE_FAILED',
            reason: 'ERR_LOADER_WRITE_FAILED',
            error: err && err.message ? err.message : String(err),
            loaderScriptPath: paths.LOADER_SCRIPT_PATH,
          };
        }

        let asar;
        try {
          asar = installAsarAddonHost(
            {
              ...paths,
              ALLOW_REPLACE_LEGACY: Boolean(replaceLegacy),
              ALLOW_REFRESH_ORIG: Boolean(refreshOrig),
            },
            activeProfile
          );
        } catch (err) {
          const compensated = compensateStagedLoader();
          return {
            ok: false,
            status: 'FAILED',
            phase: 'ASAR_PATCH_THREW',
            compensated,
            error: err && err.message ? err.message : String(err),
            loaderScriptPath: paths.LOADER_SCRIPT_PATH,
          };
        }

        const asarOk =
          asar.status === 'INSTALLED' ||
          asar.status === 'ALREADY_INSTALLED' ||
          asar.status === 'SKIPPED_NO_ASAR';

        if (!asarOk) {
          const compensated = compensateStagedLoader();
          return {
            ok: false,
            status: 'FAILED',
            phase: 'ASAR_PATCH_FAILED',
            compensated,
            loaderScriptPath: paths.LOADER_SCRIPT_PATH,
            asar,
          };
        }

        const status = asar.status === 'SKIPPED_NO_ASAR' ? 'SKIPPED_NO_ASAR' : 'INSTALLED';
        return {
          ok: true,
          status,
          phase: 'COMMITTED',
          loaderScriptPath: paths.LOADER_SCRIPT_PATH,
          asar,
        };
      } finally {
        releaseExclusiveLock(paths.ADDONS_LOCK_PATH, lockRes.token);
      }
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
