'use strict';

/**
 * Zero-Daemon Explicit CLI for antigravity-native-addon-host.
 *
 * Commands:
 *   --status                 Read-only JSON status report
 *   --doctor                 Read-only conflict & legacy direct-patch diagnostics
 *   --validate <file.json>   Validate an AddonManifest.v1 JSON file
 *   --register <file.json>   Validate + check slot conflicts + atomically register manifest
 *   --unregister <pluginId>  Remove a registered manifest from addons.d
 *   --install [--replace-legacy]  Generate loader & install single app.asar bootstrap hook
 *   --rollback [--force]     Restore byte-identical pure .orig app.asar
 */

const fs = require('node:fs');
const path = require('node:path');
const pkg = require('../../package.json');
const { assertValidHostProfile } = require('../core/host-profile-port');
const { validateAddonManifest } = require('../core/manifest-validator');
const { detectSlotConflicts } = require('../core/slot-registry');
const { ANTIGRAVITY_HOST_PROFILE } = require('../profiles/antigravity');
const {
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

function resolveEffectivePaths(pathOverrides = null, profile = ANTIGRAVITY_HOST_PROFILE) {
  const activeProfile = assertValidHostProfile(profile || ANTIGRAVITY_HOST_PROFILE);
  return {
    activeProfile,
    paths: { ...activeProfile.resolvePaths(process.env), ...(pathOverrides || {}) },
  };
}

function buildStatusReport(pathOverrides = null, profile = ANTIGRAVITY_HOST_PROFILE) {
  const { activeProfile, paths } = resolveEffectivePaths(pathOverrides, profile);
  const plan = collectExecutableAddons(paths, { checkFilesExist: true });
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
  const plan = collectExecutableAddons(paths, { checkFilesExist: true });
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
  });
  if (!check.ok) {
    return { ok: false, reason: check.reason, errors: check.errors };
  }

  const existingValid = loadRawManifestsFromDir(paths.ADDONS_DIR)
    .map((e) => e.manifest)
    .filter((m) => m && typeof m.pluginId === 'string' && m.pluginId !== manifest.pluginId);
  const slotCheck = detectSlotConflicts([...existingValid, manifest]);
  if (!slotCheck.ok) {
    return { ok: false, reason: 'ERR_SLOT_CONFLICT', conflicts: slotCheck.conflicts };
  }

  const targetPath = path.join(paths.ADDONS_DIR, `${manifest.pluginId}.json`);
  writeAtomicSync(targetPath, JSON.stringify(manifest, null, 2) + '\n');
  writeAtomicSync(paths.LOADER_SCRIPT_PATH, buildHostLoaderScriptSource(paths, activeProfile, { hostVersion: pkg.version }));
  return { ok: true, pluginId: manifest.pluginId, manifestPath: targetPath };
}

function unregisterAddonManifest(pluginId, pathOverrides = null, profile = ANTIGRAVITY_HOST_PROFILE) {
  const { paths } = resolveEffectivePaths(pathOverrides, profile);
  if (!pluginId || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(pluginId)) {
    return { ok: false, reason: 'ERR_INVALID_PLUGIN_ID' };
  }
  const targetPath = path.join(paths.ADDONS_DIR, `${pluginId}.json`);
  if (!fs.existsSync(targetPath)) {
    return { ok: true, removed: false, pluginId };
  }
  fs.unlinkSync(targetPath);
  return { ok: true, removed: true, pluginId };
}

async function runCli(argv = process.argv.slice(2), pathOverrides = null, profile = ANTIGRAVITY_HOST_PROFILE) {
  const { activeProfile, paths } = resolveEffectivePaths(pathOverrides, profile);

  if (argv.includes('--status') || argv.length === 0) {
    const out = buildStatusReport(paths, activeProfile);
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return out;
  }

  if (argv.includes('--doctor')) {
    const out = buildDoctorReport(paths, activeProfile);
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return out;
  }

  const valIdx = argv.indexOf('--validate');
  if (valIdx !== -1) {
    const file = argv[valIdx + 1];
    let out;
    if (!file || !fs.existsSync(file)) {
      out = { ok: false, reason: 'ERR_MANIFEST_FILE_NOT_FOUND' };
    } else {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        out = validateAddonManifest(parsed, {
          pluginsRootDir: paths.PLUGINS_ROOT_DIR,
          checkFilesExist: false,
        });
      } catch (_err) {
        out = { ok: false, reason: 'ERR_MANIFEST_INVALID_JSON' };
      }
    }
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    if (!out.ok) process.exitCode = 1;
    return out;
  }

  const regIdx = argv.indexOf('--register');
  if (regIdx !== -1) {
    const out = registerAddonManifestFile(argv[regIdx + 1], paths, activeProfile);
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    if (!out.ok) process.exitCode = 1;
    return out;
  }

  const unregIdx = argv.indexOf('--unregister');
  if (unregIdx !== -1) {
    const out = unregisterAddonManifest(argv[unregIdx + 1], paths, activeProfile);
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    if (!out.ok) process.exitCode = 1;
    return out;
  }

  if (argv.includes('--install')) {
    writeAtomicSync(
      paths.LOADER_SCRIPT_PATH,
      buildHostLoaderScriptSource(paths, activeProfile, { hostVersion: pkg.version })
    );
    const asar = installAsarAddonHost(
      { ...paths, ALLOW_REPLACE_LEGACY: argv.includes('--replace-legacy') },
      activeProfile
    );
    const ok =
      asar.status === 'INSTALLED' ||
      asar.status === 'ALREADY_INSTALLED' ||
      asar.status === 'SKIPPED_NO_ASAR';
    const out = { status: ok ? 'INSTALLED' : 'FAILED', loaderScriptPath: paths.LOADER_SCRIPT_PATH, asar };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    if (!ok) process.exitCode = 1;
    return out;
  }

  if (argv.includes('--rollback')) {
    const out = rollbackAsarAddonHost(paths, activeProfile, { force: argv.includes('--force') });
    const ok =
      out.status === 'ROLLED_BACK' ||
      out.status === 'ALREADY_UNPATCHED' ||
      out.status === 'SKIPPED_NO_ASAR';
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    if (!ok) process.exitCode = 1;
    return out;
  }

  throw new Error(`Unsupported CLI arguments: ${argv.join(' ')}`);
}

module.exports = {
  buildStatusReport,
  buildDoctorReport,
  registerAddonManifestFile,
  unregisterAddonManifest,
  runCli,
};
