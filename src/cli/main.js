'use strict';

/**
 * Zero-Daemon Explicit CLI for antigravity-native-addon-host.
 *
 * Commands:
 *   --help / -h                    Show usage help
 *   --version / -v                 Show host version
 *   --profile <file.js>            Load a custom HostProfile module (default: antigravity-desktop)
 *   --status                       Read-only JSON status report
 *   --doctor                       Read-only conflict & legacy direct-patch diagnostics
 *   --validate <file.json>         Validate an AddonManifest.v1 JSON file
 *   --register <file.json>         Validate + check slot/namespace/IPC conflicts + atomically register manifest
 *   --unregister <pluginId>        Remove a registered manifest from addons.d and refresh loader
 *   --install [--replace-legacy]   Generate loader & install single app.asar bootstrap hook
 *   --rollback [--force]           Restore byte-identical pure .orig app.asar
 */

const fs = require('node:fs');
const path = require('node:path');
const pkg = require('../../package.json');
const { assertValidHostProfile } = require('../core/host-profile-port');
const { validateAddonManifest } = require('../core/manifest-validator');
const { detectSlotConflicts } = require('../core/slot-registry');
const { ANTIGRAVITY_HOST_PROFILE } = require('../profiles/antigravity');
const {
  acquireExclusiveLockDetailed,
  releaseExclusiveLock,
  writeAtomicSync,
  isAsarHostInstalled,
  installAsarAddonHost,
  rollbackAsarAddonHost,
  diagnoseAsarState,
} = require('../adapters/electron/asar-patcher');
const {
  loadRawManifestsFromDir,
  collectExecutableAddons,
  buildHostLoaderScriptSource,
} = require('../adapters/electron/host-loader-builder');

function loadHostProfileFromFile(profilePath) {
  const abs = path.resolve(profilePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`ERR_PROFILE_NOT_FOUND:${abs}`);
  }
  const mod = require(abs);
  const candidate = (mod && (mod.HOST_PROFILE || mod.default)) || mod;
  return assertValidHostProfile(candidate);
}

function resolveEffectivePaths(pathOverrides = null, profile = ANTIGRAVITY_HOST_PROFILE) {
  const activeProfile = assertValidHostProfile(profile || ANTIGRAVITY_HOST_PROFILE);
  const resolved = { ...activeProfile.resolvePaths(process.env), ...(pathOverrides || {}) };
  if (!resolved.ADDONS_LOCK_PATH && resolved.ADDONS_DIR) {
    resolved.ADDONS_LOCK_PATH = path.join(path.dirname(resolved.ADDONS_DIR), 'addon-host-addons.lock');
  }
  return { activeProfile, paths: resolved };
}

function buildStatusReport(pathOverrides = null, profile = ANTIGRAVITY_HOST_PROFILE) {
  const { activeProfile, paths } = resolveEffectivePaths(pathOverrides, profile);
  const plan = collectExecutableAddons(paths, {
    checkFilesExist: true,
    hostProfileId: activeProfile.id,
    hostVersion: pkg.version,
  });
  return {
    hostVersion: pkg.version,
    hostProfileId: activeProfile.id,
    patchMarker: activeProfile.patchMarker,
    asarHostInstalled: isAsarHostInstalled(paths.ASAR_PATH, activeProfile),
    loaderScriptPresent: fs.existsSync(paths.LOADER_SCRIPT_PATH),
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

function buildDoctorReport(pathOverrides = null, profile = ANTIGRAVITY_HOST_PROFILE) {
  const { activeProfile, paths } = resolveEffectivePaths(pathOverrides, profile);
  const asarDiag = diagnoseAsarState(paths, activeProfile);
  const plan = collectExecutableAddons(paths, {
    checkFilesExist: true,
    hostProfileId: activeProfile.id,
    hostVersion: pkg.version,
  });
  return {
    hostVersion: pkg.version,
    hostProfileId: activeProfile.id,
    asar: asarDiag,
    addons: {
      activeCount: plan.active.length,
      disabledCount: plan.disabled.length,
      rejectedCount: plan.rejected.length,
      rejected: plan.rejected,
    },
    healthy: !asarDiag.hasLegacyConflict && plan.rejected.length === 0,
  };
}

function registerAddonManifestFile(manifestFilePath, pathOverrides = null, profile = ANTIGRAVITY_HOST_PROFILE) {
  const { activeProfile, paths } = resolveEffectivePaths(pathOverrides, profile);
  if (!manifestFilePath || !fs.existsSync(manifestFilePath)) {
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
    hostVersion: pkg.version,
  });
  if (!check.ok) {
    return { ok: false, reason: check.reason, errors: check.errors };
  }

  const lockRes = acquireExclusiveLockDetailed(paths.ADDONS_LOCK_PATH, 30000);
  if (!lockRes.ok) {
    return { ok: false, reason: lockRes.code, error: lockRes.error };
  }
  try {
    const existingValid = loadRawManifestsFromDir(paths.ADDONS_DIR)
      .map((e) => e.manifest)
      .filter((m) => m && typeof m.pluginId === 'string' && m.pluginId !== manifest.pluginId);
    const slotCheck = detectSlotConflicts([...existingValid, manifest]);
    if (!slotCheck.ok) {
      return { ok: false, reason: slotCheck.conflicts[0].code, conflicts: slotCheck.conflicts };
    }

    const targetPath = path.join(paths.ADDONS_DIR, `${manifest.pluginId}.json`);
    writeAtomicSync(targetPath, JSON.stringify(manifest, null, 2) + '\n');
    writeAtomicSync(
      paths.LOADER_SCRIPT_PATH,
      buildHostLoaderScriptSource(paths, activeProfile, { hostVersion: pkg.version })
    );
    return { ok: true, pluginId: manifest.pluginId, manifestPath: targetPath };
  } finally {
    releaseExclusiveLock(paths.ADDONS_LOCK_PATH, lockRes.token);
  }
}

function unregisterAddonManifest(pluginId, pathOverrides = null, profile = ANTIGRAVITY_HOST_PROFILE) {
  const { activeProfile, paths } = resolveEffectivePaths(pathOverrides, profile);
  if (!pluginId || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(pluginId)) {
    return { ok: false, reason: 'ERR_INVALID_PLUGIN_ID' };
  }
  const lockRes = acquireExclusiveLockDetailed(paths.ADDONS_LOCK_PATH, 30000);
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
      writeAtomicSync(
        paths.LOADER_SCRIPT_PATH,
        buildHostLoaderScriptSource(paths, activeProfile, { hostVersion: pkg.version })
      );
    }
    return { ok: true, removed: true, pluginId };
  } finally {
    releaseExclusiveLock(paths.ADDONS_LOCK_PATH, lockRes.token);
  }
}

function getHelpText() {
  return [
    `antigravity-native-addon-host v${pkg.version}`,
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

async function runCli(argv = process.argv.slice(2), pathOverrides = null, profile = ANTIGRAVITY_HOST_PROFILE) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  if (args.includes('--help') || args.includes('-h')) {
    const text = getHelpText();
    process.stdout.write(text + '\n');
    return { ok: true, help: text };
  }
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(pkg.version + '\n');
    return { ok: true, version: pkg.version };
  }

  let effectiveProfile = profile || ANTIGRAVITY_HOST_PROFILE;
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
    if (!file || !fs.existsSync(file)) {
      out = { ok: false, reason: 'ERR_MANIFEST_FILE_NOT_FOUND' };
    } else {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        out = validateAddonManifest(parsed, {
          pluginsRootDir: paths.PLUGINS_ROOT_DIR,
          checkFilesExist: false,
          hostProfileId: activeProfile.id,
          hostVersion: pkg.version,
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
    const asar = installAsarAddonHost(
      { ...paths, ALLOW_REPLACE_LEGACY: args.includes('--replace-legacy') },
      activeProfile
    );
    const ok =
      asar.status === 'INSTALLED' ||
      asar.status === 'ALREADY_INSTALLED' ||
      asar.status === 'SKIPPED_NO_ASAR';
    if (ok) {
      writeAtomicSync(
        paths.LOADER_SCRIPT_PATH,
        buildHostLoaderScriptSource(paths, activeProfile, { hostVersion: pkg.version })
      );
    }
    const status =
      asar.status === 'SKIPPED_NO_ASAR' ? 'SKIPPED_NO_ASAR' : ok ? 'INSTALLED' : 'FAILED';
    const out = { status, loaderScriptPath: paths.LOADER_SCRIPT_PATH, asar };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    if (!ok) process.exitCode = 1;
    return out;
  }

  if (args.includes('--rollback')) {
    const out = rollbackAsarAddonHost(paths, activeProfile, { force: args.includes('--force') });
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

module.exports = {
  loadHostProfileFromFile,
  buildStatusReport,
  buildDoctorReport,
  registerAddonManifestFile,
  unregisterAddonManifest,
  getHelpText,
  runCli,
};
