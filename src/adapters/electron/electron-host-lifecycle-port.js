'use strict';

/**
 * Electron implementation of `HostLifecyclePort` (ISP / DIP / SRP — v2.0.0).
 *
 * - Uses internal `AsarPatchTransport` (the ONLY production boot transport for packaged apps).
 * - Immutable content-addressed runtime staging (`${RUNTIME_DIR}/${buildSha8}/`) +
 *   single-file atomic swap of `addon-host-loader.js` shim (`writeAtomicSync`).
 * - Full compensation rollback on ASAR failure (restores prior shim + removes staged immutable dir).
 * - Default `strictTrustPolicy = true` (D-R4-7).
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
const { createAsarPatchTransport } = require('./asar-patch-transport');
const { buildHostLoaderScriptSource } = require('./host-loader-builder');

const DIST_RUNTIME_DIR = path.resolve(__dirname, '..', '..', '..', 'dist', 'runtime');
const DEFAULT_CLI_ENTRY_PATH = path.resolve(__dirname, '..', '..', '..', 'bin', 'addon-host.js');
const HOST_CLI_META_FILENAME = 'host-cli.json';
const REQUIRED_RUNTIME_FILES = Object.freeze([
  'build-manifest.json',
  'main/init-main.js',
  'preload/preload-bridge.cjs',
  'renderer/kernel-bundle.cjs',
]);

function writeHostCliMetaIfAvailable(hostDataDir, cliEntryPath) {
  if (!hostDataDir || typeof hostDataDir !== 'string' || !cliEntryPath || typeof cliEntryPath !== 'string') {
    return null;
  }
  try {
    const resolvedCli = path.resolve(cliEntryPath);
    if (!fs.existsSync(resolvedCli) || !fs.statSync(resolvedCli).isFile()) {
      return null;
    }
    const metaPath = path.join(hostDataDir, HOST_CLI_META_FILENAME);
    if (fs.existsSync(metaPath)) {
      const lstat = fs.lstatSync(metaPath);
      if (lstat.isSymbolicLink() || !lstat.isFile()) {
        return null;
      }
    }
    const payload =
      JSON.stringify(
        {
          schemaVersion: 1,
          cliEntryPath: resolvedCli,
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      ) + '\n';
    writeAtomicSync(metaPath, payload);
    return metaPath;
  } catch (_err) {
    return null;
  }
}

function copyDirRecursive(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, ent.name);
    const d = path.join(dstDir, ent.name);
    if (ent.isDirectory()) {
      copyDirRecursive(s, d);
    } else if (ent.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

function readDistRuntimeBuildInfo(distRuntimeDir = DIST_RUNTIME_DIR) {
  const manifestPath = path.join(distRuntimeDir, 'build-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (data && typeof data.buildSha8 === 'string' && /^[a-f0-9]{8}$/.test(data.buildSha8)) {
      return { distRuntimeDir, buildSha8: data.buildSha8, manifest: data };
    }
  } catch (_err) {}
  return null;
}

function verifyStagedRuntimeIntegrity(runtimeDir, expectedBuildSha8 = null) {
  if (!runtimeDir || !fs.existsSync(runtimeDir)) {
    return { ok: false, reason: 'ERR_STAGED_RUNTIME_MISSING' };
  }
  const info = readDistRuntimeBuildInfo(runtimeDir);
  if (!info) {
    return { ok: false, reason: 'ERR_STAGED_RUNTIME_MANIFEST_INVALID' };
  }
  if (expectedBuildSha8 && info.buildSha8 !== expectedBuildSha8) {
    return { ok: false, reason: 'ERR_STAGED_RUNTIME_SHA_MISMATCH', buildSha8: info.buildSha8 };
  }
  for (const rel of REQUIRED_RUNTIME_FILES) {
    const full = path.join(runtimeDir, ...rel.split('/'));
    try {
      if (!fs.statSync(full).isFile()) {
        return { ok: false, reason: `ERR_STAGED_RUNTIME_FILE_MISSING:${rel}` };
      }
    } catch (_err) {
      return { ok: false, reason: `ERR_STAGED_RUNTIME_FILE_MISSING:${rel}` };
    }
  }
  return { ok: true, buildSha8: info.buildSha8, runtimeDir };
}

function inspectInstalledLoader(loaderScriptPath, runtimeBaseDir) {
  if (!loaderScriptPath || !fs.existsSync(loaderScriptPath)) {
    return {
      loaderScriptPresent: false,
      installedBuildSha8: null,
      stagedRuntimeDir: null,
      stagedRuntimePresent: false,
      stagedRuntimeReason: 'ERR_LOADER_SCRIPT_MISSING',
    };
  }
  let src = '';
  try {
    src = fs.readFileSync(loaderScriptPath, 'utf8');
  } catch (_err) {
    return {
      loaderScriptPresent: false,
      installedBuildSha8: null,
      stagedRuntimeDir: null,
      stagedRuntimePresent: false,
      stagedRuntimeReason: 'ERR_LOADER_SCRIPT_UNREADABLE',
    };
  }
  const shaMatch =
    src.match(/"buildSha8"\s*:\s*"([a-f0-9]{8})"/) || src.match(/,\s*build\s+([a-f0-9]{8})\)/);
  const installedBuildSha8 = shaMatch ? shaMatch[1] : null;
  const loaderDir = path.dirname(loaderScriptPath);
  let stagedRuntimeDir = null;
  const relMatch = src.match(/const\s+RUNTIME_DIR\s*=\s*path\.resolve\(__dirname,\s*"([^"]+)"\)/);
  if (relMatch) {
    stagedRuntimeDir = path.resolve(loaderDir, relMatch[1]);
  } else {
    const absMatch = src.match(/const\s+RUNTIME_DIR\s*=\s*"([^"]+)"/);
    if (absMatch) {
      try {
        stagedRuntimeDir = JSON.parse(`"${absMatch[1]}"`);
      } catch (_e) {
        stagedRuntimeDir = absMatch[1];
      }
    } else if (installedBuildSha8 && runtimeBaseDir) {
      stagedRuntimeDir = path.join(runtimeBaseDir, installedBuildSha8);
    }
  }
  const integrity = verifyStagedRuntimeIntegrity(stagedRuntimeDir, installedBuildSha8);
  return {
    loaderScriptPresent: true,
    installedBuildSha8: installedBuildSha8 || integrity.buildSha8 || null,
    stagedRuntimeDir,
    stagedRuntimePresent: integrity.ok,
    stagedRuntimeReason: integrity.ok ? null : integrity.reason,
  };
}

function resolveElectronPaths(profile, env = process.env, pathOverrides = null) {
  const activeProfile = assertValidElectronHostProfile(profile);
  const base = activeProfile.resolvePaths(env);
  const overrides = pathOverrides && typeof pathOverrides === 'object' ? pathOverrides : {};
  const resolved = { ...(base && typeof base === 'object' ? base : {}), ...overrides };

  const addonsDirOverridden =
    typeof overrides.ADDONS_DIR === 'string' &&
    overrides.ADDONS_DIR.trim() !== '' &&
    (!base || overrides.ADDONS_DIR !== base.ADDONS_DIR);
  const lockExplicitlyOverridden =
    typeof overrides.ADDONS_LOCK_PATH === 'string' && overrides.ADDONS_LOCK_PATH.trim() !== '';

  if ((!resolved.ADDONS_LOCK_PATH || (addonsDirOverridden && !lockExplicitlyOverridden)) && resolved.ADDONS_DIR) {
    resolved.ADDONS_LOCK_PATH = path.join(path.dirname(resolved.ADDONS_DIR), 'addon-host-addons.lock');
  }

  const hostDataDir =
    resolved.HOST_DATA_DIR ||
    (resolved.LOADER_SCRIPT_PATH && path.dirname(resolved.LOADER_SCRIPT_PATH)) ||
    (resolved.ADDONS_DIR && path.dirname(resolved.ADDONS_DIR));
  if (hostDataDir) {
    if (!resolved.HOST_DATA_DIR) resolved.HOST_DATA_DIR = hostDataDir;
    if (!resolved.BACKUPS_DIR) resolved.BACKUPS_DIR = path.join(hostDataDir, 'backups');
    if (!resolved.TRUST_POLICY_PATH) resolved.TRUST_POLICY_PATH = path.join(hostDataDir, 'trust-policy.json');
    if (!resolved.RUNTIME_DIR) resolved.RUNTIME_DIR = path.join(hostDataDir, 'runtime');
  }

  assertValidResolvedElectronPaths(resolved, ELECTRON_REQUIRED_PATH_KEYS);
  return { hostProfileId: activeProfile.id, activeProfile, paths: resolved };
}

function createElectronHostLifecyclePort({
  transport = null,
  distRuntimeDir = DIST_RUNTIME_DIR,
  cliEntryPath = DEFAULT_CLI_ENTRY_PATH,
} = {}) {
  const activeTransport = transport || createAsarPatchTransport();

  function stageAndApply(
    ctx,
    mode,
    {
      replaceLegacy = false,
      refreshOrig = false,
      hostVersion = pkg.version,
      strictTrustPolicy = true,
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
    let stagedRuntimeDir = null;
    let createdNewRuntimeDir = false;

    const compensateStaged = () => {
      let ok = true;
      if (loaderStaged) {
        try {
          if (hadPrevLoader && prevLoaderContent !== null) {
            writeAtomicSync(paths.LOADER_SCRIPT_PATH, prevLoaderContent);
          } else if (fs.existsSync(paths.LOADER_SCRIPT_PATH)) {
            fs.unlinkSync(paths.LOADER_SCRIPT_PATH);
          }
        } catch (_compErr) {
          ok = false;
        }
      }
      if (createdNewRuntimeDir && stagedRuntimeDir && fs.existsSync(stagedRuntimeDir)) {
        try {
          fs.rmSync(stagedRuntimeDir, { recursive: true, force: true });
        } catch (_rmErr) {
          ok = false;
        }
      }
      return ok;
    };

    try {
      if (hadPrevLoader) {
        prevLoaderContent = fs.readFileSync(paths.LOADER_SCRIPT_PATH, 'utf8');
      }

      // O-2: Fail closed when dist/runtime build-manifest.json or required files are missing (never embed 'dev' repo path)
      const buildInfo = readDistRuntimeBuildInfo(distRuntimeDir);
      const sourceIntegrity = buildInfo
        ? verifyStagedRuntimeIntegrity(buildInfo.distRuntimeDir, buildInfo.buildSha8)
        : { ok: false, reason: 'ERR_DIST_RUNTIME_MISSING' };
      if (!buildInfo || !sourceIntegrity.ok) {
        return {
          ok: false,
          status: 'FAILED',
          phase: 'DIST_RUNTIME_MISSING',
          reason: 'ERR_DIST_RUNTIME_MISSING',
          error: `Missing or invalid dist/runtime bundle in ${distRuntimeDir} (${sourceIntegrity.reason})`,
          loaderScriptPath: paths.LOADER_SCRIPT_PATH,
        };
      }

      const buildSha8 = buildInfo.buildSha8;
      let runtimeEntryDir = buildInfo.distRuntimeDir;

      if (paths.RUNTIME_DIR) {
        stagedRuntimeDir = path.join(paths.RUNTIME_DIR, buildSha8);
        const existingCheck = verifyStagedRuntimeIntegrity(stagedRuntimeDir, buildSha8);
        if (!existingCheck.ok) {
          const tmpStage = `${stagedRuntimeDir}.tmp-${process.pid}-${Date.now()}`;
          let displacedCorruptDir = null;
          try {
            copyDirRecursive(buildInfo.distRuntimeDir, tmpStage);
            if (fs.existsSync(stagedRuntimeDir)) {
              displacedCorruptDir = `${stagedRuntimeDir}.corrupt-${process.pid}-${Date.now()}`;
              fs.renameSync(stagedRuntimeDir, displacedCorruptDir);
            }
            fs.renameSync(tmpStage, stagedRuntimeDir);
            createdNewRuntimeDir = true;
            if (displacedCorruptDir) {
              try {
                fs.rmSync(displacedCorruptDir, { recursive: true, force: true });
              } catch (_rmOld) {}
            }
          } catch (stageErr) {
            try {
              fs.rmSync(tmpStage, { recursive: true, force: true });
            } catch (_e) {}
            if (displacedCorruptDir && fs.existsSync(displacedCorruptDir) && !fs.existsSync(stagedRuntimeDir)) {
              try {
                fs.renameSync(displacedCorruptDir, stagedRuntimeDir);
              } catch (_restoreErr) {}
            }
            return {
              ok: false,
              status: 'FAILED',
              phase: 'RUNTIME_STAGE_FAILED',
              reason: 'ERR_RUNTIME_STAGE_FAILED',
              error: stageErr && stageErr.message ? stageErr.message : String(stageErr),
              loaderScriptPath: paths.LOADER_SCRIPT_PATH,
            };
          }
        }
        runtimeEntryDir = stagedRuntimeDir;
      }

      try {
        writeAtomicSync(
          paths.LOADER_SCRIPT_PATH,
          buildHostLoaderScriptSource(paths, activeProfile, {
            hostVersion,
            strictTrustPolicy,
            mainHookTimeoutMs,
            rendererExecTimeoutMs,
            runtimeEntryDir,
            buildSha8,
          })
        );
        loaderStaged = true;
      } catch (err) {
        compensateStaged();
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
        asar =
          mode === 'upgrade'
            ? activeTransport.upgrade(paths, activeProfile, { replaceLegacy, refreshOrig })
            : activeTransport.install(paths, activeProfile, { replaceLegacy, refreshOrig });
      } catch (err) {
        const compensated = compensateStaged();
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
        asar.status === 'UPGRADED' ||
        asar.status === 'ALREADY_INSTALLED' ||
        asar.status === 'SKIPPED_NO_ASAR';

      if (!asarOk) {
        const compensated = compensateStaged();
        return {
          ok: false,
          status: 'FAILED',
          phase: 'ASAR_PATCH_FAILED',
          compensated,
          loaderScriptPath: paths.LOADER_SCRIPT_PATH,
          asar,
        };
      }

      writeHostCliMetaIfAvailable(paths.HOST_DATA_DIR, cliEntryPath);

      const status =
        asar.status === 'SKIPPED_NO_ASAR'
          ? 'SKIPPED_NO_ASAR'
          : asar.status === 'UPGRADED'
            ? 'UPGRADED'
            : 'INSTALLED';
      return {
        ok: true,
        status,
        phase: 'COMMITTED',
        buildSha8,
        runtimeEntryDir,
        loaderScriptPath: paths.LOADER_SCRIPT_PATH,
        asar,
      };
    } finally {
      releaseExclusiveLock(paths.ADDONS_LOCK_PATH, lockRes.token);
    }
  }

  return Object.freeze({
    validateProfile(profile) {
      return assertValidElectronHostProfile(profile);
    },

    resolveContext(profile, env = process.env, pathOverrides = null) {
      return resolveElectronPaths(profile, env, pathOverrides);
    },

    getHostStatus(ctx) {
      const { activeProfile, paths } = ctx;
      const installed = activeTransport.isInstalled(paths, activeProfile);
      const buildInfo = readDistRuntimeBuildInfo(distRuntimeDir);
      const loaderInfo = inspectInstalledLoader(paths.LOADER_SCRIPT_PATH, paths.RUNTIME_DIR);
      return {
        installed,
        transport: activeTransport.id,
        patchMarker: activeProfile.patchMarker,
        buildSha8: loaderInfo.installedBuildSha8 || (buildInfo ? buildInfo.buildSha8 : null),
        installedBuildSha8: loaderInfo.installedBuildSha8,
        packageBuildSha8: buildInfo ? buildInfo.buildSha8 : null,
        loaderScriptPresent: loaderInfo.loaderScriptPresent,
        stagedRuntimePresent: loaderInfo.stagedRuntimePresent,
        addonsDir: paths.ADDONS_DIR,
      };
    },

    diagnoseHost(ctx) {
      const { activeProfile, paths } = ctx;
      const asarDiag = activeTransport.diagnose(paths, activeProfile);
      const buildInfo = readDistRuntimeBuildInfo(distRuntimeDir);
      const loaderInfo = inspectInstalledLoader(paths.LOADER_SCRIPT_PATH, paths.RUNTIME_DIR);
      const backupHealthy =
        !asarDiag.asarExists || !asarDiag.hostInstalled || Boolean(asarDiag.origBackupValid);
      const integrityHealthy =
        !asarDiag.origBuildMismatch && !asarDiag.patchedShaMismatch && !asarDiag.updatedUnpatched;
      const runtimeHealthy =
        !asarDiag.hostInstalled || (loaderInfo.loaderScriptPresent && loaderInfo.stagedRuntimePresent);
      return {
        ...asarDiag,
        transport: activeTransport.id,
        buildSha8: loaderInfo.installedBuildSha8 || (buildInfo ? buildInfo.buildSha8 : null),
        installedBuildSha8: loaderInfo.installedBuildSha8,
        packageBuildSha8: buildInfo ? buildInfo.buildSha8 : null,
        loaderScriptPresent: loaderInfo.loaderScriptPresent,
        stagedRuntimePresent: loaderInfo.stagedRuntimePresent,
        stagedRuntimeReason: loaderInfo.stagedRuntimeReason,
        healthy:
          !asarDiag.hasLegacyConflict &&
          !asarDiag.needsUpgrade &&
          backupHealthy &&
          integrityHealthy &&
          runtimeHealthy,
      };
    },

    installHost(ctx, opts = {}) {
      return stageAndApply(ctx, 'install', opts);
    },

    upgradeHost(ctx, opts = {}) {
      return stageAndApply(ctx, 'upgrade', opts);
    },

    rollbackHost(ctx, { force = false } = {}) {
      const { activeProfile, paths } = ctx;
      const out = activeTransport.rollback(paths, activeProfile, { force: Boolean(force) });
      const ok =
        out.status === 'ROLLED_BACK' ||
        out.status === 'ALREADY_UNPATCHED' ||
        out.status === 'SKIPPED_NO_ASAR';
      return { ok, ...out };
    },
  });
}

module.exports = {
  DIST_RUNTIME_DIR,
  readDistRuntimeBuildInfo,
  resolveElectronPaths,
  createElectronHostLifecyclePort,
};
