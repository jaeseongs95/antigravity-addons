'use strict';

/**
 * Zero-Daemon Host-Agnostic CLI Factory (SOLID: SRP / OCP / LSP / ISP / DIP).
 *
 * Depends exclusively on `src/core/host-ports` and two segregated host-neutral ports:
 *   - `hostLifecycle` (HostLifecyclePort)
 *   - `addonStore`    (AddonStorePort)
 *
 * Treats `ctx` returned by `hostLifecycle.resolveContext()` as an opaque host context
 * (resolving it at most once per CLI invocation) and contains ZERO file writes, file locks,
 * archive/runtime fields, or vendor literals.
 */

const fs = require('node:fs');
const path = require('node:path');
const pkg = require('../../package.json');
const { assertHostLifecyclePort, assertAddonStorePort } = require('../core/host-ports');

function getProfileIdFromContext(ctx, fallbackProfile) {
  if (ctx && typeof ctx.hostProfileId === 'string' && ctx.hostProfileId) {
    return ctx.hostProfileId;
  }
  if (ctx && ctx.activeProfile && typeof ctx.activeProfile.id === 'string' && ctx.activeProfile.id) {
    return ctx.activeProfile.id;
  }
  return fallbackProfile && typeof fallbackProfile.id === 'string' ? fallbackProfile.id : 'unknown';
}

function createCliApp({ hostLifecycle, addonStore, defaultProfile, hostVersion = pkg.version } = {}) {
  const lifecycle = assertHostLifecyclePort(hostLifecycle);
  const store = assertAddonStorePort(addonStore);
  const baseProfile = lifecycle.validateProfile(defaultProfile);

  function loadHostProfileFromFile(profilePath) {
    const abs = path.resolve(profilePath);
    if (!fs.existsSync(abs)) {
      throw new Error(`ERR_PROFILE_NOT_FOUND:${abs}`);
    }
    const mod = require(abs);
    const candidate = (mod && (mod.HOST_PROFILE || mod.default)) || mod;
    return lifecycle.validateProfile(candidate);
  }

  function resolveContext(overrides = null, profile = baseProfile) {
    return lifecycle.resolveContext(profile || baseProfile, process.env, overrides);
  }

  function buildStatusReportFromCtx(ctx, fallbackProfile = baseProfile) {
    const hostStatus = lifecycle.getHostStatus(ctx);
    const plan = store.planAddons(ctx, { checkFilesExist: true, hostVersion });
    return {
      hostVersion,
      hostProfileId: getProfileIdFromContext(ctx, fallbackProfile),
      hostInstalled: Boolean(hostStatus && hostStatus.installed),
      hostStatus,
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

  function buildDoctorReportFromCtx(ctx, fallbackProfile = baseProfile) {
    const hostDiag = lifecycle.diagnoseHost(ctx);
    const plan = store.planAddons(ctx, { checkFilesExist: true, hostVersion });
    return {
      hostVersion,
      hostProfileId: getProfileIdFromContext(ctx, fallbackProfile),
      host: hostDiag,
      addons: {
        activeCount: plan.active.length,
        disabledCount: plan.disabled.length,
        rejectedCount: plan.rejected.length,
        rejected: plan.rejected,
      },
      healthy: Boolean(hostDiag && hostDiag.healthy) && plan.rejected.length === 0,
    };
  }

  function readManifestFile(manifestFilePath) {
    if (!manifestFilePath || String(manifestFilePath).startsWith('-') || !fs.existsSync(manifestFilePath)) {
      return { ok: false, reason: 'ERR_MANIFEST_FILE_NOT_FOUND' };
    }
    try {
      return { ok: true, manifest: JSON.parse(fs.readFileSync(manifestFilePath, 'utf8')) };
    } catch (_err) {
      return { ok: false, reason: 'ERR_MANIFEST_INVALID_JSON' };
    }
  }

  function validateAddonManifestFileFromCtx(ctx, manifestFilePath) {
    const read = readManifestFile(manifestFilePath);
    if (!read.ok) return read;
    return store.validateManifest(ctx, read.manifest, { checkFilesExist: false, hostVersion });
  }

  function registerAddonManifestFileFromCtx(ctx, manifestFilePath) {
    const read = readManifestFile(manifestFilePath);
    if (!read.ok) return read;
    return store.registerManifest(ctx, read.manifest, { hostVersion });
  }

  function unregisterAddonManifestFromCtx(ctx, pluginId) {
    // R9-F1: CLI checks only flag-like arg syntax; pluginId domain invariant belongs to AddonStorePort
    if (!pluginId || String(pluginId).startsWith('-')) {
      return { ok: false, reason: 'ERR_INVALID_PLUGIN_ID' };
    }
    return store.unregisterManifest(ctx, pluginId, { hostVersion });
  }

  function buildStatusReport(overrides = null, profile = baseProfile) {
    const ctx = resolveContext(overrides, profile);
    return buildStatusReportFromCtx(ctx, profile);
  }

  function buildDoctorReport(overrides = null, profile = baseProfile) {
    const ctx = resolveContext(overrides, profile);
    return buildDoctorReportFromCtx(ctx, profile);
  }

  function validateAddonManifestFile(manifestFilePath, overrides = null, profile = baseProfile) {
    const ctx = resolveContext(overrides, profile);
    return validateAddonManifestFileFromCtx(ctx, manifestFilePath);
  }

  function registerAddonManifestFile(manifestFilePath, overrides = null, profile = baseProfile) {
    const ctx = resolveContext(overrides, profile);
    return registerAddonManifestFileFromCtx(ctx, manifestFilePath);
  }

  function unregisterAddonManifest(pluginId, overrides = null, profile = baseProfile) {
    const ctx = resolveContext(overrides, profile);
    return unregisterAddonManifestFromCtx(ctx, pluginId);
  }

  function getHelpText() {
    return [
      `native-addon-host v${hostVersion}`,
      '',
      'Usage: addon-host [options] <command>',
      '',
      'Commands:',
      '  --status                       Read-only JSON status report',
      '  --doctor                       Read-only conflict & host integrity diagnostics',
      '  --validate <manifest.json>     Validate an AddonManifest.v1 file',
      '  --register <manifest.json>     Validate & atomically register a manifest',
      '  --unregister <pluginId>        Unregister a plugin manifest',
      '  --install [--replace-legacy]   Install single shared host bootstrap hook',
      '  --rollback [--force]           Restore original host bundle byte-identically',
      '  --version, -v                  Print version',
      '  --help, -h                     Print this help',
      '',
      'Options:',
      '  --profile <path-to-profile.js> Use a custom HostProfile module',
    ].join('\n');
  }

  async function runCli(argv = process.argv.slice(2), overrides = null, profile = baseProfile) {
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

    // R7-F1: Resolve opaque host context strictly ONCE per CLI invocation
    const ctx = resolveContext(overrides, effectiveProfile);

    if (args.includes('--status') || args.length === 0) {
      const out = buildStatusReportFromCtx(ctx, effectiveProfile);
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      return out;
    }

    if (args.includes('--doctor')) {
      const out = buildDoctorReportFromCtx(ctx, effectiveProfile);
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      return out;
    }

    const valIdx = args.indexOf('--validate');
    if (valIdx !== -1) {
      const out = validateAddonManifestFileFromCtx(ctx, args[valIdx + 1]);
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      if (!out.ok) process.exitCode = 1;
      return out;
    }

    const regIdx = args.indexOf('--register');
    if (regIdx !== -1) {
      const out = registerAddonManifestFileFromCtx(ctx, args[regIdx + 1]);
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      if (!out.ok) process.exitCode = 1;
      return out;
    }

    const unregIdx = args.indexOf('--unregister');
    if (unregIdx !== -1) {
      const out = unregisterAddonManifestFromCtx(ctx, args[unregIdx + 1]);
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      if (!out.ok) process.exitCode = 1;
      return out;
    }

    if (args.includes('--install')) {
      const out = lifecycle.installHost(ctx, {
        replaceLegacy: args.includes('--replace-legacy'),
        hostVersion,
      });
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      if (!out || !out.ok) process.exitCode = 1;
      return out;
    }

    if (args.includes('--rollback')) {
      const out = lifecycle.rollbackHost(ctx, { force: args.includes('--force') });
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      if (!out || !out.ok) process.exitCode = 1;
      return out;
    }

    throw new Error(`Unsupported CLI arguments: ${args.join(' ')}`);
  }

  return Object.freeze({
    loadHostProfileFromFile,
    resolveContext,
    buildStatusReport,
    buildDoctorReport,
    validateAddonManifestFile,
    registerAddonManifestFile,
    unregisterAddonManifest,
    getHelpText,
    runCli,
  });
}

module.exports = {
  createCliApp,
};
