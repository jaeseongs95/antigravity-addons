'use strict';

/**
 * Vendor-neutral Remote Web Addon Collector (Node-side, Phase 1 Packing).
 *
 * Reuses core validation & lifecycle planning (`planAddonExecution`),
 * single-buffer SHA-256 trust verification (`readVerifiedRendererScript`),
 * and read-only config/settings readers — ZERO duplicated manifest or trust logic.
 *
 * Guarantees:
 * - Auto-includes existing AddonManifest.v2 renderer addons declaring a profile listed
 *   in `profile.compatibleHostProfiles`, unless opted out via `excludeHostProfiles`
 *   or an explicit `hostProfiles` list omitting `profile.id`.
 * - Fail-closed excludes `mainHook`: dual-capability (`['renderer', 'mainHook']`) addons
 *   safely skip `mainHook` and pack ONLY the verified `rendererScript`; `mainHook`-only
 *   addons are rejected with `ERR_UNSUPPORTED_HOST_CAPABILITY`.
 * - Zero machine-local absolute paths leaked into packed addon metadata.
 */

const fs = require('node:fs');
const path = require('node:path');
const { assertValidHostProfile } = require('../../core/host-profile-port');
const { planAddonExecution } = require('../../core/lifecycle-coordinator');
const { createNodeFileSystemPort } = require('../node-fs-port');
const { isPluginEnabledInConfig } = require('../electron/config-reader');
const { loadRawManifestsFromDir } = require('../../runtime/main/init-main');
const { loadTrustPolicyFile, readVerifiedRendererScript } = require('../../runtime/main/trust-verifier');
const { readSettingsFileSnapshot } = require('../../runtime/main/settings-bridge');

function buildPackedPluginMeta(addon, verified) {
  const manifest = addon.manifest;
  const settingsSpec =
    manifest.settingsBridge &&
    typeof manifest.settingsBridge === 'object' &&
    typeof manifest.settingsBridge.fileName === 'string' &&
    manifest.settingsBridge.fileName.length > 0
      ? {
          fileName: manifest.settingsBridge.fileName,
          maxBytes: manifest.settingsBridge.maxBytes,
        }
      : null;
  const hasSettingsBridge = Boolean(settingsSpec && verified.effectiveTrustLevel === 'trusted');

  const configSpec =
    manifest.configBridge &&
    typeof manifest.configBridge === 'object' &&
    Array.isArray(manifest.configBridge.scopes) &&
    manifest.configBridge.scopes.length > 0
      ? manifest.configBridge
      : null;
  const hasConfigBridge = Boolean(configSpec && verified.effectiveTrustLevel === 'trusted');
  const configScopes = hasConfigBridge
    ? configSpec.scopes.map((s) => ({
        scopeId: s.scopeId,
        access: s.access,
        maxBytes: s.maxBytes,
      }))
    : [];

  return {
    pluginMeta: {
      pluginId: addon.pluginId,
      displayName: typeof manifest.displayName === 'string' && manifest.displayName.trim() ? manifest.displayName.trim() : addon.pluginId,
      version: manifest.version || '0.0.0',
      sourceSchemaVersion: manifest.sourceSchemaVersion || 2,
      trustLevel: verified.effectiveTrustLevel,
      hasDocumentTransformSlot: Boolean(addon.hasDocumentTransformSlot),
      hasSettingsBridge,
      hasConfigBridge,
      configScopes,
      uiSlots: Array.isArray(manifest.uiSlots) ? manifest.uiSlots : [],
      isolation: manifest.isolation && typeof manifest.isolation === 'object' ? manifest.isolation : {},
      skippedCapabilities: Array.isArray(addon.skippedCapabilities) ? addon.skippedCapabilities.slice() : [],
    },
    settingsSpec: hasSettingsBridge ? settingsSpec : null,
  };
}

function collectRemoteWebAddons({
  profile,
  addonsDir = null,
  pluginsRootDir = null,
  configJsonPath = undefined,
  trustPolicyPath = undefined,
  settingsDataDir = null,
  hostVersion = '2.3.0',
  strictTrustPolicy = true,
  includeSettingsSnapshots = false,
  fsPort = null,
  isEnabled = null,
  env = process.env,
} = {}) {
  assertValidHostProfile(profile);

  const resolvedPaths = typeof profile.resolvePaths === 'function' ? profile.resolvePaths(env) : {};
  const effectiveAddonsDir = addonsDir || resolvedPaths.ADDONS_DIR || null;
  const effectivePluginsRoot = pluginsRootDir || resolvedPaths.PLUGINS_ROOT_DIR || null;
  const effectiveConfigPath = configJsonPath !== undefined ? configJsonPath : resolvedPaths.CONFIG_JSON_PATH || null;
  const effectiveTrustPath = trustPolicyPath !== undefined ? trustPolicyPath : resolvedPaths.TRUST_POLICY_PATH || null;
  const effectiveSettingsDir =
    settingsDataDir ||
    (effectiveAddonsDir ? path.dirname(path.resolve(effectiveAddonsDir)) : resolvedPaths.HOST_DATA_DIR || null);

  const activeFsPort = fsPort || createNodeFileSystemPort();
  const enabledCheck =
    typeof isEnabled === 'function'
      ? isEnabled
      : (pluginId) => {
          if (!effectiveConfigPath || !fs.existsSync(effectiveConfigPath)) {
            return true;
          }
          return isPluginEnabledInConfig(effectiveConfigPath, pluginId);
        };

  const rawEntries = loadRawManifestsFromDir(effectiveAddonsDir);
  const plan = planAddonExecution(rawEntries, {
    pluginsRootDir: effectivePluginsRoot,
    checkFilesExist: true,
    hostProfileId: profile.id,
    compatibleHostProfiles: Array.isArray(profile.compatibleHostProfiles) ? profile.compatibleHostProfiles : null,
    supportedCapabilities: Array.isArray(profile.supportedCapabilities) ? profile.supportedCapabilities : ['renderer'],
    hostVersion,
    strictTrustPolicy,
    fsPort: activeFsPort,
    isEnabled: enabledCheck,
  });

  const policyRes = loadTrustPolicyFile(effectiveTrustPath);
  const policy = policyRes.policy;

  const packed = [];
  const rejected = (plan.rejected || []).map((r) => ({
    pluginId: r.pluginId || null,
    reason: r.reason,
    errors: Array.isArray(r.errors) ? r.errors.slice() : [],
  }));
  const disabled = (plan.disabled || []).map((d) => ({
    pluginId: d.pluginId || null,
    reason: d.reason,
  }));
  const skippedMainHookPlugins = [];

  for (const addon of plan.active || []) {
    if (Array.isArray(addon.skippedCapabilities) && addon.skippedCapabilities.includes('mainHook')) {
      skippedMainHookPlugins.push(addon.pluginId);
    }

    const scriptPath = addon && addon.resolvedEntries ? addon.resolvedEntries.rendererScript : null;
    if (!scriptPath) {
      rejected.push({
        pluginId: addon.pluginId,
        reason: 'ERR_MISSING_RENDERER_ENTRY',
        errors: ['No resolved rendererScript available for remote web packing'],
      });
      continue;
    }

    const verified = readVerifiedRendererScript(scriptPath, addon.manifest, policy, {
      strictTrustPolicy,
    });
    if (!verified.ok) {
      rejected.push({
        pluginId: addon.pluginId,
        reason: verified.reason,
        errors: [verified.error || verified.reason],
      });
      continue;
    }

    const { pluginMeta, settingsSpec } = buildPackedPluginMeta(addon, verified);

    let initialSettingsSnapshot = null;
    if (includeSettingsSnapshots === true && settingsSpec && effectiveSettingsDir) {
      const snap = readSettingsFileSnapshot(effectiveSettingsDir, settingsSpec, {
        reservedFilePaths: [effectiveTrustPath, effectiveConfigPath].filter(Boolean),
      });
      if (snap && snap.status === 'ok' && snap.data && typeof snap.data === 'object') {
        initialSettingsSnapshot = {
          status: 'ok',
          data: snap.data,
          sha256: snap.sha256 || null,
          reason: null,
          revision: 1,
          updatedAt: null,
          persistence: 'packed-initial',
        };
      }
    }

    packed.push({
      pluginMeta,
      settingsSpec,
      initialSettingsSnapshot,
      rendererSha256: verified.sha256,
      rendererSource: verified.source,
    });
  }

  return {
    ok: true,
    profileId: profile.id,
    hostVersion,
    trustPolicyOk: policyRes.ok,
    addons: packed,
    disabled,
    rejected,
    skippedMainHookPlugins,
    stats: {
      discoveredCount: rawEntries.length,
      packedCount: packed.length,
      disabledCount: disabled.length,
      rejectedCount: rejected.length,
      skippedMainHookCount: skippedMainHookPlugins.length,
    },
  };
}

module.exports = {
  buildPackedPluginMeta,
  collectRemoteWebAddons,
};
