'use strict';

/**
 * Thin Entry Shim Builder & Manifest Collector (v2.0.0 — replaces the 2,638-line v1 template).
 *
 * - Zero local development repository paths leaked into generated `addon-host-loader.js`.
 * - Zero runtime `require('ajv')`.
 * - Emits a ~60-line CJS shim pointing to the immutable content-addressed `runtime/<buildSha8>/`
 *   bundle staged beside `addon-host-loader.js` (or an explicit `runtimeEntryDir`).
 * - Preserves public helper exports (`isAllowedRendererUrl`, `loadRawManifestsFromDir`,
 *   `collectExecutableAddons`, `serializeSafeInlineJson`, `buildHostLoaderScriptSource`).
 */

const fs = require('node:fs');
const path = require('node:path');
const { planAddonExecution } = require('../../core/lifecycle-coordinator');
const { createNodeFileSystemPort } = require('../node-fs-port');
const { isPluginEnabledInConfig } = require('./config-reader');
const { assertValidElectronHostProfile } = require('./electron-host-profile-port');
const {
  DEFAULT_ALLOWED_PROTOCOLS,
  DEFAULT_ALLOWED_HOSTS,
  isAllowedRendererUrl,
} = require('../../runtime/main/host-origin-resolver');
const { parseSafeJson } = require('../../runtime/shared/safe-json');

function serializeSafeInlineJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function loadRawManifestsFromDir(addonsDir) {
  const entries = [];
  if (!addonsDir || !fs.existsSync(addonsDir)) return entries;
  const files = fs.readdirSync(addonsDir).filter((f) => f.endsWith('.json')).sort();
  for (const name of files) {
    const full = path.join(addonsDir, name);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      const manifest = parseSafeJson(fs.readFileSync(full, 'utf8'));
      entries.push({ source: full, manifest });
    } catch (err) {
      entries.push({
        source: full,
        manifest: null,
        parseError: err && err.message ? err.message : String(err),
      });
    }
  }
  return entries;
}

function collectExecutableAddons(
  paths,
  {
    checkFilesExist = true,
    hostProfileId = null,
    hostVersion = undefined,
    strictTrustPolicy = true,
    fsPort = null,
  } = {}
) {
  const activeFsPort = fsPort || createNodeFileSystemPort();
  const rawEntries = loadRawManifestsFromDir(paths.ADDONS_DIR);
  return planAddonExecution(rawEntries, {
    pluginsRootDir: paths.PLUGINS_ROOT_DIR,
    checkFilesExist,
    hostProfileId,
    hostVersion,
    strictTrustPolicy,
    fsPort: activeFsPort,
    isEnabled: (pluginId) => isPluginEnabledInConfig(paths.CONFIG_JSON_PATH, pluginId),
  });
}

function buildHostLoaderScriptSource(
  paths,
  profile,
  {
    hostVersion = '2.0.0',
    strictTrustPolicy = true,
    mainHookTimeoutMs = 5000,
    rendererExecTimeoutMs = 10000,
    runtimeEntryDir = null,
    buildSha8 = 'dev',
  } = {}
) {
  assertValidElectronHostProfile(profile);

  const loaderDir = paths.LOADER_SCRIPT_PATH ? path.dirname(path.resolve(paths.LOADER_SCRIPT_PATH)) : null;
  let relRuntimeDir = null;
  if (runtimeEntryDir && loaderDir) {
    const rel = path.relative(loaderDir, path.resolve(runtimeEntryDir));
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      relRuntimeDir = './' + rel.replace(/\\/g, '/');
    }
  }

  const hostCfg = {
    hostVersion,
    buildSha8,
    strictTrustPolicy: strictTrustPolicy !== false,
    mainHookTimeoutMs: Number.isInteger(mainHookTimeoutMs) && mainHookTimeoutMs >= 100 ? mainHookTimeoutMs : 5000,
    rendererExecTimeoutMs:
      Number.isInteger(rendererExecTimeoutMs) && rendererExecTimeoutMs >= 100 ? rendererExecTimeoutMs : 10000,
    isolatedWorldId:
      Number.isInteger(profile.isolatedWorldId) && profile.isolatedWorldId > 0 && profile.isolatedWorldId !== 999
        ? profile.isolatedWorldId
        : 998,
    addonsDir: paths.ADDONS_DIR,
    pluginsRootDir: paths.PLUGINS_ROOT_DIR,
    configJsonPath: paths.CONFIG_JSON_PATH || null,
    trustPolicyPath:
      paths.TRUST_POLICY_PATH || (loaderDir ? path.join(loaderDir, 'trust-policy.json') : null),
    profile: {
      id: profile.id,
      patchMarker: profile.patchMarker,
      windowOrigin: profile.windowOrigin || null,
      strictWindowOrigin: Boolean(profile.strictWindowOrigin),
      defaultSessionOnly: profile.defaultSessionOnly !== false,
      allowedUrlProtocols: profile.allowedUrlProtocols || DEFAULT_ALLOWED_PROTOCOLS,
      allowedUrlHosts: profile.allowedUrlHosts || DEFAULT_ALLOWED_HOSTS,
      excludedUrlProtocols: profile.excludedUrlProtocols || null,
      extraNoTranslateAttributes: profile.extraNoTranslateAttributes || [],
      uiAnchors: profile.uiAnchors || {},
      portalBridge: profile.portalBridge || null,
    },
  };

  const runtimeLookupExpr = relRuntimeDir
    ? `path.resolve(__dirname, ${serializeSafeInlineJson(relRuntimeDir)})`
    : serializeSafeInlineJson(path.resolve(runtimeEntryDir || path.resolve(__dirname, '..', '..', '..', 'dist', 'runtime')));

  return `'use strict';
// Auto-generated thin v2.0.0 entry shim (${profile.patchMarker}, build ${buildSha8}).
// ZERO development repo paths and ZERO runtime npm dependencies.
const path = require('node:path');

const HOST_CFG = ${serializeSafeInlineJson(hostCfg)};
const RUNTIME_DIR = ${runtimeLookupExpr};
const { initMain, createHostRuntimeController } = require(path.join(RUNTIME_DIR, 'main', 'init-main.js'));

function resolveRuntimeCfg() {
  return {
    ...HOST_CFG,
    preloadBridgePath: path.join(RUNTIME_DIR, 'preload', 'preload-bridge.cjs'),
    kernelBundlePath: path.join(RUNTIME_DIR, 'renderer', 'kernel-bundle.cjs'),
  };
}

function bootMain(app, deps) {
  return initMain(app, resolveRuntimeCfg(), deps);
}

function createController(deps) {
  return createHostRuntimeController(resolveRuntimeCfg(), deps);
}

module.exports = {
  HOST_CFG,
  RUNTIME_DIR,
  initMain: bootMain,
  createHostRuntimeController: createController,
  getBuildInfo: () => ({ hostVersion: HOST_CFG.hostVersion, buildSha8: HOST_CFG.buildSha8, patchMarker: HOST_CFG.profile.patchMarker }),
};
`;
}

module.exports = {
  DEFAULT_ALLOWED_PROTOCOLS,
  DEFAULT_ALLOWED_HOSTS,
  isAllowedRendererUrl,
  isAllowedHubUrl: isAllowedRendererUrl,
  serializeSafeInlineJson,
  loadRawManifestsFromDir,
  collectExecutableAddons,
  buildHostLoaderScriptSource,
};
