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
    compatibleHostProfiles = undefined,
    supportedCapabilities = undefined,
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
    compatibleHostProfiles,
    supportedCapabilities,
    hostVersion,
    strictTrustPolicy,
    fsPort: activeFsPort,
    isEnabled: (pluginId) => isPluginEnabledInConfig(paths.CONFIG_JSON_PATH, pluginId),
  });
}

function compactUiSurfacesForShim(uiSurfaces, uiAnchors) {
  if (!uiSurfaces || typeof uiSurfaces !== 'object') return {};
  const out = {};
  const anchors = uiAnchors && typeof uiAnchors === 'object' ? uiAnchors : {};
  for (const [id, raw] of Object.entries(uiSurfaces)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = {};
    if (Number.isFinite(raw.priority)) entry.priority = raw.priority;
    const anchorSel = Array.isArray(anchors[id]) ? anchors[id] : null;
    if (Array.isArray(raw.selectors) && raw.selectors.length > 0) {
      if (!anchorSel || JSON.stringify(raw.selectors) !== JSON.stringify(anchorSel)) {
        entry.selectors = raw.selectors;
      }
    }
    if (Array.isArray(raw.excludeLeftSelectors) && raw.excludeLeftSelectors.length > 0) {
      entry.excludeLeftSelectors = raw.excludeLeftSelectors;
    }
    if (Array.isArray(raw.excludeRightSelectors) && raw.excludeRightSelectors.length > 0) {
      entry.excludeRightSelectors = raw.excludeRightSelectors;
    }
    if (Array.isArray(raw.excludeTopSelectors) && raw.excludeTopSelectors.length > 0) {
      entry.excludeTopSelectors = raw.excludeTopSelectors;
    }
    if (Array.isArray(raw.excludeBottomSelectors) && raw.excludeBottomSelectors.length > 0) {
      entry.excludeBottomSelectors = raw.excludeBottomSelectors;
    }
    if (raw.safeInsets && typeof raw.safeInsets === 'object') {
      const insets = {};
      for (const side of ['top', 'right', 'bottom', 'left']) {
        if (Number.isFinite(raw.safeInsets[side]) && raw.safeInsets[side] > 0) {
          insets[side] = raw.safeInsets[side];
        }
      }
      if (Object.keys(insets).length > 0) entry.safeInsets = insets;
    }
    out[id] = entry;
  }
  return out;
}

function serializeDeduplicatedConfigJs(obj) {
  const raw = serializeSafeInlineJson(obj);
  const defs = [];
  let expr = raw;

  // 1. Deduplicate repeated non-trivial string-array literals (e.g. selector lists shared across surfaces)
  const counts = new Map();
  const arrRe = /\["(?:\\.|[^"\\]){4,}"(?:,"(?:\\.|[^"\\]){1,}")*\]/g;
  let m;
  while ((m = arrRe.exec(raw)) !== null) {
    if (m[0].length >= 28) {
      counts.set(m[0], (counts.get(m[0]) || 0) + 1);
    }
  }
  let idx = 0;
  for (const [literal, count] of counts.entries()) {
    if (count < 2) continue;
    const varName = `_A${idx}`;
    idx += 1;
    defs.push(`const ${varName} = ${literal};`);
    expr = expr.split(literal).join(varName);
  }

  // 2. Deduplicate a shared base directory prefix repeated across 3+ path values (e.g. long Windows/CI temp paths)
  const dirPrefixCounts = new Map();
  const strRe = /"(?:\\.|[^"\\]){20,}"/g;
  const matchedStrings = [];
  while ((m = strRe.exec(expr)) !== null) {
    matchedStrings.push(m[0]);
    try {
      const val = JSON.parse(m[0]);
      if (typeof val === 'string' && (val.includes('\\') || val.startsWith('/'))) {
        const sep = val.includes('\\') ? '\\' : '/';
        const lastSep = val.lastIndexOf(sep);
        if (lastSep >= 16) {
          const dirPrefix = val.slice(0, lastSep);
          dirPrefixCounts.set(dirPrefix, (dirPrefixCounts.get(dirPrefix) || 0) + 1);
        }
      }
    } catch (_e) {}
  }
  let bestPrefix = null;
  let bestSavings = 0;
  for (const [prefix, count] of dirPrefixCounts.entries()) {
    if (count < 3) continue;
    const savings = count * prefix.length - (prefix.length + 20);
    if (savings > bestSavings) {
      bestSavings = savings;
      bestPrefix = prefix;
    }
  }
  if (bestPrefix && bestSavings >= 40) {
    const uniqueMatches = Array.from(new Set(matchedStrings));
    const replacements = [];
    for (const lit of uniqueMatches) {
      try {
        const val = JSON.parse(lit);
        if (typeof val === 'string' && val.startsWith(bestPrefix)) {
          const rest = val.slice(bestPrefix.length);
          const rep = rest.length === 0 ? '_B' : `_B+${serializeSafeInlineJson(rest)}`;
          replacements.push([lit, rep]);
        }
      } catch (_e) {}
    }
    if (replacements.length >= 3) {
      defs.push(`const _B = ${serializeSafeInlineJson(bestPrefix)};`);
      for (const [lit, rep] of replacements) {
        expr = expr.split(lit).join(rep);
      }
    }
  }

  return { defs, expr };
}

function buildHostLoaderScriptSource(
  paths,
  profile,
  {
    hostVersion = '2.5.1',
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

  const resolvedConfigScopes =
    typeof profile.resolveConfigScopes === 'function' ? profile.resolveConfigScopes(paths) : {};

  const effectiveStrictTrust = strictTrustPolicy !== false;
  const effectiveMainHookTimeout =
    Number.isInteger(mainHookTimeoutMs) && mainHookTimeoutMs >= 100 ? mainHookTimeoutMs : 5000;
  const effectiveRendererTimeout =
    Number.isInteger(rendererExecTimeoutMs) && rendererExecTimeoutMs >= 100 ? rendererExecTimeoutMs : 10000;
  const effectiveWorldId =
    Number.isInteger(profile.isolatedWorldId) && profile.isolatedWorldId > 0 && profile.isolatedWorldId !== 999
      ? profile.isolatedWorldId
      : 998;

  const hostCfg = {
    hostVersion,
    buildSha8,
    ...(!effectiveStrictTrust ? { strictTrustPolicy: false } : {}),
    ...(effectiveMainHookTimeout !== 5000 ? { mainHookTimeoutMs: effectiveMainHookTimeout } : {}),
    ...(effectiveRendererTimeout !== 10000 ? { rendererExecTimeoutMs: effectiveRendererTimeout } : {}),
    ...(effectiveWorldId !== 998 ? { isolatedWorldId: effectiveWorldId } : {}),
    addonsDir: paths.ADDONS_DIR,
    settingsDataDir: paths.HOST_DATA_DIR || loaderDir || (paths.ADDONS_DIR ? path.dirname(path.resolve(paths.ADDONS_DIR)) : null),
    pluginsRootDir: paths.PLUGINS_ROOT_DIR,
    configJsonPath: paths.CONFIG_JSON_PATH || null,
    trustPolicyPath:
      paths.TRUST_POLICY_PATH || (loaderDir ? path.join(loaderDir, 'trust-policy.json') : null),
    ...(paths.REMOTE_PREFS_PATH ? { remotePrefsPath: paths.REMOTE_PREFS_PATH } : {}),
    ...(paths.REMOTE_DIST_DIR ? { remoteDistDir: paths.REMOTE_DIST_DIR } : {}),
    configScopes:
      resolvedConfigScopes && typeof resolvedConfigScopes === 'object' && !Array.isArray(resolvedConfigScopes)
        ? resolvedConfigScopes
        : {},
    profile: {
      id: profile.id,
      ...(Array.isArray(profile.compatibleHostProfiles) ? { compatibleHostProfiles: profile.compatibleHostProfiles } : {}),
      ...(Array.isArray(profile.supportedCapabilities) ? { supportedCapabilities: profile.supportedCapabilities } : {}),
      ...(typeof profile.remoteProfileId === 'string' && profile.remoteProfileId
        ? { remoteProfileId: profile.remoteProfileId }
        : {}),
      ...(Array.isArray(profile.remoteSupportedCapabilities)
        ? { remoteSupportedCapabilities: profile.remoteSupportedCapabilities }
        : {}),
      patchMarker: profile.patchMarker,
      windowOrigin: profile.windowOrigin || null,
      ...(profile.strictWindowOrigin ? { strictWindowOrigin: true } : {}),
      ...(profile.defaultSessionOnly === false ? { defaultSessionOnly: false } : {}),
      allowedUrlProtocols: profile.allowedUrlProtocols || DEFAULT_ALLOWED_PROTOCOLS,
      allowedUrlHosts: profile.allowedUrlHosts || DEFAULT_ALLOWED_HOSTS,
      ...(profile.excludedUrlProtocols ? { excludedUrlProtocols: profile.excludedUrlProtocols } : {}),
      extraNoTranslateAttributes: profile.extraNoTranslateAttributes || [],
      uiAnchors: profile.uiAnchors || {},
      ...(profile.uiSurfaces && Object.keys(profile.uiSurfaces).length > 0
        ? { uiSurfaces: compactUiSurfacesForShim(profile.uiSurfaces, profile.uiAnchors) }
        : {}),
      ...(profile.settingsUi ? { settingsUi: profile.settingsUi } : {}),
      ...(profile.portalBridge ? { portalBridge: profile.portalBridge } : {}),
    },
  };

  const { defs: cfgDefs, expr: cfgExpr } = serializeDeduplicatedConfigJs(hostCfg);
  const cfgPrefix = cfgDefs.length > 0 ? cfgDefs.join('\n') + '\n' : '';
  const runtimeLookupExpr = relRuntimeDir
    ? `path.resolve(__dirname, ${serializeSafeInlineJson(relRuntimeDir)})`
    : serializeSafeInlineJson(path.resolve(runtimeEntryDir || path.resolve(__dirname, '..', '..', '..', 'dist', 'runtime')));

  return `'use strict';
// Auto-generated thin v${hostCfg.hostVersion} entry shim (${profile.patchMarker}, ${buildSha8}).
const path = require('node:path');
${cfgPrefix}const HOST_CFG = ${cfgExpr};
const RUNTIME_DIR = ${runtimeLookupExpr};
const rt = require(path.join(RUNTIME_DIR, 'main', 'init-main.js'));
const cfg = () => ({ ...HOST_CFG, preloadBridgePath: path.join(RUNTIME_DIR, 'preload', 'preload-bridge.cjs'), kernelBundlePath: path.join(RUNTIME_DIR, 'renderer', 'kernel-bundle.cjs') });
module.exports = {
  HOST_CFG,
  RUNTIME_DIR,
  initMain: (app, deps) => rt.initMain(app, cfg(), deps),
  createHostRuntimeController: (deps) => rt.createHostRuntimeController(cfg(), deps),
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
