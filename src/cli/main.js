'use strict';

/**
 * Zero-Daemon Explicit CLI Factory (DIP / SRP / OCP).
 *
 * Strictly decoupled from concrete Electron/ASAR adapters and Antigravity profiles:
 * depends ONLY on `src/core/*` and the injected `hostAdapter` port + `defaultProfile`.
 * Concrete wiring happens exclusively in the composition roots (`bin/addon-host.js`, `src/index.js`).
 */

const fs = require('node:fs');
const path = require('node:path');
const pkg = require('../../package.json');
const { validateAddonManifest } = require('../core/manifest-validator');
const { detectSlotConflicts } = require('../core/slot-registry');

const REQUIRED_ADAPTER_METHODS = Object.freeze([
  'validateProfile',
  'resolvePaths',
  'isHostInstalled',
  'diagnoseHostState',
  'installHost',
  'rollbackHost',
  'collectExecutableAddons',
  'loadRawManifestsFromDir',
  'buildLoaderSource',
  'acquireLock',
  'releaseLock',
  'writeAtomicSync',
]);

function assertValidHostAdapter(hostAdapter) {
  if (!hostAdapter || typeof hostAdapter !== 'object') {
    throw new Error('ERR_INVALID_HOST_ADAPTER');
  }
  for (const method of REQUIRED_ADAPTER_METHODS) {
    if (typeof hostAdapter[method] !== 'function') {
      throw new Error(`ERR_HOST_ADAPTER_MISSING_METHOD:${method}`);
    }
  }
  return hostAdapter;
}

function createCliApp({ hostAdapter, defaultProfile, hostVersion = pkg.version } = {}) {
  const adapter = assertValidHostAdapter(hostAdapter);
  const baseProfile = adapter.validateProfile(defaultProfile);

  function loadHostProfileFromFile(profilePath) {
    const abs = path.resolve(profilePath);
    if (!fs.existsSync(abs)) {
      throw new Error(`ERR_PROFILE_NOT_FOUND:${abs}`);
    }
    const mod = require(abs);
    const candidate = (mod && (mod.HOST_PROFILE || mod.default)) || mod;
    return adapter.validateProfile(candidate);
  }

  function resolveEffectivePaths(pathOverrides = null, profile = baseProfile) {
    return adapter.resolvePaths(profile || baseProfile, process.env, pathOverrides);
  }

  function buildStatusReport(pathOverrides = null, profile = baseProfile) {
    const { activeProfile, paths } = resolveEffectivePaths(pathOverrides, profile);
    const plan = adapter.collectExecutableAddons(paths, {
      checkFilesExist: true,
      hostProfileId: activeProfile.id,
      hostVersion,
    });
    return {
      hostVersion,
      hostProfileId: activeProfile.id,
      patchMarker: activeProfile.patchMarker || null,
      asarHostInstalled: adapter.isHostInstalled(paths, activeProfile),
      loaderScriptPresent: Boolean(paths.LOADER_SCRIPT_PATH && fs.existsSync(paths.LOADER_SCRIPT_PATH)),
      addonsDir: paths.ADDONS_DIR,
      activeAddons: plan.active.map((a) => ({
        pluginId: a.pluginId,
        version: a.manifest.version,
        loadOrder: a.loadOrder,
        capabilities: a.manifest.capabilities,
      })),
      disabledAddons: plan.disabled,
      rejectedAddons: plan.rejected,
      slots: plan.slots,
    };
  }

  function buildDoctorReport(pathOverrides = null, profile = baseProfile) {
    const { activeProfile, paths } = resolveEffectivePaths(pathOverrides, profile);
    const asarDiag = adapter.diagnoseHostState(paths, activeProfile);
    const plan = adapter.collectExecutableAddons(paths, {
      checkFilesExist: true,
      hostProfileId: activeProfile.id,
      hostVersion,
    });
    const backupHealthy =
      !asarDiag.asarExists || !asarDiag.hostInstalled || Boolean(asarDiag.origBackupValid);
    return {
      hostVersion,
      hostProfileId: activeProfile.id,
      asar: asarDiag,
      addons: {
        activeCount: plan.active.length,
        disabledCount: plan.disabled.length,
        rejectedCount: plan.rejected.length,
        rejected: plan.rejected,
      },
      healthy: !asarDiag.hasLegacyConflict && plan.rejected.length === 0 && backupHealthy,
    };
  }

  function registerAddonManifestFile(manifestFilePath, pathOverrides = null, profile = baseProfile) {
    const { activeProfile, paths } = resolveEffectivePaths(pathOverrides, profile);
    if (!manifestFilePath || String(manifestFilePath).startsWith('-') || !fs.existsSync(manifestFilePath)) {
      return { ok: false, reason: 'ERR_MANIFEST_FILE_NOT_FOUND' };
    }
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestFilePath, 'utf8'));
    } catch (_err) {
      return { ok: false, reason: 'ERR_MANIFEST_INVALID_JSON' };
    }

    const check = validateAddonManifest(manifest, {
      pluginsRootDir: paths.PLUGINS_ROOT_DIR,
      checkFilesExist: true,
      hostProfileId: activeProfile.id,
      hostVersion,
    });
    if (!check.ok) {
      return { ok: false, reason: check.reason, errors: check.errors };
    }

    const lockRes = adapter.acquireLock(paths.ADDONS_LOCK_PATH, 30000);
    if (!lockRes.ok) {
      return { ok: false, reason: lockRes.code, error: lockRes.error };
    }
    try {
      const existingValid = adapter
        .loadRawManifestsFromDir(paths.ADDONS_DIR)
        .map((e) => e.manifest)
        .filter((m) => m && typeof m.pluginId === 'string' && m.pluginId !== manifest.pluginId);
      const slotCheck = detectSlotConflicts([...existingValid, manifest]);
      if (!slotCheck.ok) {
        return { ok: false, reason: slotCheck.conflicts[0].code, conflicts: slotCheck.conflicts };
      }

      const targetPath = path.join(paths.ADDONS_DIR, `${manifest.pluginId}.json`);
      adapter.writeAtomicSync(targetPath, JSON.stringify(manifest, null, 2) + '\n');
      adapter.writeAtomicSync(
        paths.LOADER_SCRIPT_PATH,
        adapter.buildLoaderSource(paths, activeProfile, { hostVersion })
      );
      return { ok: true, pluginId: manifest.pluginId, manifestPath: targetPath };
    } finally {
      adapter.releaseLock(paths.ADDONS_LOCK_PATH, lockRes.token);
    }
  }

  function unregisterAddonManifest(pluginId, pathOverrides = null, profile = baseProfile) {
    const { activeProfile, paths } = resolveEffectivePaths(pathOverrides, profile);
    if (!pluginId || String(pluginId).startsWith('-') || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(pluginId)) {
      return { ok: false, reason: 'ERR_INVALID_PLUGIN_ID' };
    }
    const lockRes = adapter.acquireLock(paths.ADDONS_LOCK_PATH, 30000);
    if (!lockRes.ok) {
      return { ok: false, reason: lockRes.code, error: lockRes.error };
    }
    try {
      const targetPath = path.join(paths.ADDONS_DIR, `${pluginId}.json`);
      if (!fs.existsSync(targetPath)) {
        return { ok: true, removed: false, pluginId };
      }
      fs.unlinkSync(targetPath);
      if (paths.LOADER_SCRIPT_PATH && fs.existsSync(paths.LOADER_SCRIPT_PATH)) {
        adapter.writeAtomicSync(
          paths.LOADER_SCRIPT_PATH,
          adapter.buildLoaderSource(paths, activeProfile, { hostVersion })
        );
      }
      return { ok: true, removed: true, pluginId };
    } finally {
      adapter.releaseLock(paths.ADDONS_LOCK_PATH, lockRes.token);
    }
  }

  function getHelpText() {
    return [
      `antigravity-native-addon-host v${hostVersion}`,
      '',
      'Usage: addon-host [options] <command>',
      '',
      'Commands:',
      '  --status                       Read-only JSON status report',
      '  --doctor                       Read-only conflict & legacy patch diagnostics',
      '  --validate <manifest.json>     Validate an AddonManifest.v1 file',
      '  --register <manifest.json>     Validate & atomically register a manifest',
      '  --unregister <pluginId>        Unregister a plugin manifest',
      '  --install [--replace-legacy]   Install single shared app.asar bootstrap hook',
      '  --rollback [--force]           Restore pure .orig app.asar byte-identically',
      '  --version, -v                  Print version',
      '  --help, -h                     Print this help',
      '',
      'Options:',
      '  --profile <path-to-profile.js> Use a custom HostProfile module',
    ].join('\n');
  }

  async function runCli(argv = process.argv.slice(2), pathOverrides = null, profile = baseProfile) {
    const args = Array.isArray(argv) ? argv.slice() : [];
    if (args.includes('--help') || args.includes('-h')) {
      const text = getHelpText();
      process.stdout.write(text + '\n');
      return { ok: true, help: text };
    }
    if (args.includes('--version') || args.includes('-v')) {
      process.stdout.write(hostVersion + '\n');
      return { ok: true, version: hostVersion };
    }

    let effectiveProfile = profile || baseProfile;
    const profIdx = args.indexOf('--profile');
    if (profIdx !== -1) {
      const profileFile = args[profIdx + 1];
      if (!profileFile || profileFile.startsWith('-')) {
        throw new Error('ERR_MISSING_PROFILE_PATH');
      }
      effectiveProfile = loadHostProfileFromFile(profileFile);
      args.splice(profIdx, 2);
    }

    const { activeProfile, paths } = resolveEffectivePaths(pathOverrides, effectiveProfile);

    if (args.includes('--status') || args.length === 0) {
      const out = buildStatusReport(paths, activeProfile);
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      return out;
    }

    if (args.includes('--doctor')) {
      const out = buildDoctorReport(paths, activeProfile);
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      return out;
    }

    const valIdx = args.indexOf('--validate');
    if (valIdx !== -1) {
      const file = args[valIdx + 1];
      let out;
      if (!file || file.startsWith('-') || !fs.existsSync(file)) {
        out = { ok: false, reason: 'ERR_MANIFEST_FILE_NOT_FOUND' };
      } else {
        try {
          const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
          out = validateAddonManifest(parsed, {
            pluginsRootDir: paths.PLUGINS_ROOT_DIR,
            checkFilesExist: false,
            hostProfileId: activeProfile.id,
            hostVersion,
          });
        } catch (_err) {
          out = { ok: false, reason: 'ERR_MANIFEST_INVALID_JSON' };
        }
      }
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      if (!out.ok) process.exitCode = 1;
      return out;
    }

    const regIdx = args.indexOf('--register');
    if (regIdx !== -1) {
      const out = registerAddonManifestFile(args[regIdx + 1], paths, activeProfile);
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      if (!out.ok) process.exitCode = 1;
      return out;
    }

    const unregIdx = args.indexOf('--unregister');
    if (unregIdx !== -1) {
      const out = unregisterAddonManifest(args[unregIdx + 1], paths, activeProfile);
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      if (!out.ok) process.exitCode = 1;
      return out;
    }

    if (args.includes('--install')) {
      const asar = adapter.installHost(paths, activeProfile, {
        replaceLegacy: args.includes('--replace-legacy'),
      });
      const ok =
        asar.status === 'INSTALLED' ||
        asar.status === 'ALREADY_INSTALLED' ||
        asar.status === 'SKIPPED_NO_ASAR';
      if (ok) {
        const lockRes = adapter.acquireLock(paths.ADDONS_LOCK_PATH, 30000);
        if (!lockRes.ok) {
          const out = { status: 'FAILED', reason: lockRes.code, error: lockRes.error, asar };
          process.stdout.write(JSON.stringify(out, null, 2) + '\n');
          process.exitCode = 1;
          return out;
        }
        try {
          adapter.writeAtomicSync(
            paths.LOADER_SCRIPT_PATH,
            adapter.buildLoaderSource(paths, activeProfile, { hostVersion })
          );
        } finally {
          adapter.releaseLock(paths.ADDONS_LOCK_PATH, lockRes.token);
        }
      }
      const status =
        asar.status === 'SKIPPED_NO_ASAR' ? 'SKIPPED_NO_ASAR' : ok ? 'INSTALLED' : 'FAILED';
      const out = { status, loaderScriptPath: paths.LOADER_SCRIPT_PATH, asar };
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      if (!ok) process.exitCode = 1;
      return out;
    }

    if (args.includes('--rollback')) {
      const out = adapter.rollbackHost(paths, activeProfile, { force: args.includes('--force') });
      const ok =
        out.status === 'ROLLED_BACK' ||
        out.status === 'ALREADY_UNPATCHED' ||
        out.status === 'SKIPPED_NO_ASAR';
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      if (!ok) process.exitCode = 1;
      return out;
    }

    throw new Error(`Unsupported CLI arguments: ${args.join(' ')}`);
  }

  return Object.freeze({
    loadHostProfileFromFile,
    resolveEffectivePaths,
    buildStatusReport,
    buildDoctorReport,
    registerAddonManifestFile,
    unregisterAddonManifest,
    getHelpText,
    runCli,
  });
}

module.exports = {
  REQUIRED_ADAPTER_METHODS,
  assertValidHostAdapter,
  createCliApp,
};
