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
    forbiddenNetHosts = undefined,
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
    forbiddenNetHosts,
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

function scanStringValueLiterals(text) {
  const out = [];
  const tokenRe = /"(?:\\.|[^"\\])*"/g;
  let m;
  while ((m = tokenRe.exec(text)) !== null) {
    const end = m.index + m[0].length;
    if (text[end] === ':') continue; // Skip object keys
    out.push(m[0]);
  }
  return out;
}

// BLK-03: Token-aware replacement that ONLY replaces JSON string values, NEVER object keys
function replaceStringValueLiterals(text, repMap) {
  if (!repMap || repMap.size === 0) return text;
  const tokenRe = /"(?:\\.|[^"\\])*"/g;
  let out = '';
  let lastIdx = 0;
  let m;
  while ((m = tokenRe.exec(text)) !== null) {
    const end = m.index + m[0].length;
    if (text[end] === ':') continue; // Never mutate object keys!
    const rep = repMap.get(m[0]);
    if (rep !== undefined) {
      out += text.slice(lastIdx, m.index) + rep;
      lastIdx = end;
    }
  }
  return lastIdx === 0 ? text : out + text.slice(lastIdx);
}

// Token-aware object-key unquoting for valid JS identifiers (preserves "hostVersion" & legacy regex-matched keys)
const SAFE_JS_IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const KEEP_QUOTED_KEYS = new Set([
  'hostVersion',
  '__proto__',
  'settingsUi',
  'uiSurfaces',
  'uiSectionTargets',
  'remoteProfileId',
  'remotePrefsPath',
  'remoteDistDir',
]);

function unquoteSafeObjectKeys(text) {
  const tokenRe = /"(?:\\.|[^"\\])*"/g;
  let out = '';
  let lastIdx = 0;
  let m;
  while ((m = tokenRe.exec(text)) !== null) {
    const end = m.index + m[0].length;
    if (text[end] !== ':') continue;
    const prev = m.index > 0 ? text[m.index - 1] : '';
    if (prev !== '{' && prev !== ',') continue;
    const key = m[0].slice(1, -1);
    if (!KEEP_QUOTED_KEYS.has(key) && SAFE_JS_IDENT_RE.test(key)) {
      out += text.slice(lastIdx, m.index) + key;
      lastIdx = end;
    }
  }
  return lastIdx === 0 ? text : out + text.slice(lastIdx);
}

function serializeDeduplicatedConfigJs(obj) {
  const raw = serializeSafeInlineJson(obj);
  const arrBindings = [];
  const baseDefs = [];
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
    arrBindings.push(`${varName}=${literal}`);
    expr = expr.split(literal).join(varName);
  }

  // 1b. Deduplicate repeated surface-chrome trailing fragments (e.g. shared exclude* + safeInsets across uiSurfaces)
  const objBindings = [];
  const chromeRe = /"excludeLeftSelectors":_A\d+,"excludeRightSelectors":_A\d+,"excludeBottomSelectors":_A\d+,"safeInsets":\{"top":\d+\}/g;
  const chromeCounts = new Map();
  while ((m = chromeRe.exec(expr)) !== null) {
    chromeCounts.set(m[0], (chromeCounts.get(m[0]) || 0) + 1);
  }
  let cIdx = 0;
  for (const [frag, count] of chromeCounts.entries()) {
    if (count < 2) continue;
    const varName = `_C${cIdx}`;
    cIdx += 1;
    objBindings.push(`${varName}={${frag}}`);
    expr = expr.split(frag).join(`...${varName}`);
  }

  // 2. Deduplicate up to 2 shared base directory prefixes repeated across path values (e.g. long Windows/Linux CI paths)
  for (let pass = 0; pass < 2; pass += 1) {
    const varName = pass === 0 ? '_B' : '_B1';
    const minCount = pass === 0 ? 3 : 2;
    const minSavings = pass === 0 ? 40 : 20;
    const dirPrefixCounts = new Map();
    const matchedStrings = [];
    for (const lit of scanStringValueLiterals(expr)) {
      if (lit.length < (pass === 0 ? 22 : 12)) continue;
      matchedStrings.push(lit);
      try {
        const val = JSON.parse(lit);
        if (typeof val === 'string' && (val.includes('\\') || (val.includes('/') && !val.includes('://')))) {
          const sep = val.includes('\\') ? '\\' : '/';
          let cut = val.lastIndexOf(sep);
          let depth = 0;
          while (cut >= 12 && depth < 3) {
            const dirPrefix = val.slice(0, cut);
            dirPrefixCounts.set(dirPrefix, (dirPrefixCounts.get(dirPrefix) || 0) + 1);
            cut = val.lastIndexOf(sep, cut - 1);
            depth += 1;
          }
        }
      } catch (_e) {}
    }
    let bestPrefix = null;
    let bestSavings = 0;
    for (const [prefix, count] of dirPrefixCounts.entries()) {
      if (count < minCount) continue;
      const savings = count * prefix.length - (prefix.length + 20);
      if (savings > bestSavings) {
        bestSavings = savings;
        bestPrefix = prefix;
      }
    }
    if (!bestPrefix || bestSavings < minSavings) break;
    const uniqueMatches = Array.from(new Set(matchedStrings));
    const repMap = new Map();
    for (const lit of uniqueMatches) {
      try {
        const val = JSON.parse(lit);
        if (typeof val === 'string' && val.startsWith(bestPrefix)) {
          const rest = val.slice(bestPrefix.length);
          const rep = rest.length === 0 ? varName : `${varName}+${serializeSafeInlineJson(rest)}`;
          repMap.set(lit, rep);
        }
      } catch (_e) {}
    }
    if (repMap.size < minCount) break;
    baseDefs.push(
      pass === 0
        ? `const ${varName} = ${serializeSafeInlineJson(bestPrefix)};`
        : `const ${varName}=${serializeSafeInlineJson(bestPrefix)};`
    );
    expr = replaceStringValueLiterals(expr, repMap);
  }

  // 3. Deduplicate repeated non-key string value literals shared across defs & expr (e.g. uiAnchors & uiSurfaces selectors)
  const valCounts = new Map();
  for (const chunk of [...arrBindings, ...objBindings, expr]) {
    for (const lit of scanStringValueLiterals(chunk)) {
      if (lit.length >= 6) {
        valCounts.set(lit, (valCounts.get(lit) || 0) + 1);
      }
    }
  }
  const strBindings = [];
  const strRepMap = new Map();
  let sIdx = 0;
  for (const [literal, count] of valCounts.entries()) {
    if (count < 2) continue;
    const varName = `_S${sIdx}`;
    const bindingOverhead = sIdx === 0 ? 8 + varName.length : 2 + varName.length;
    const savings = count * literal.length - (literal.length + bindingOverhead + count * varName.length);
    if (savings < 4) continue;
    sIdx += 1;
    strBindings.push(`${varName}=${literal}`);
    strRepMap.set(literal, varName);
  }
  if (strRepMap.size > 0) {
    for (let i = 0; i < arrBindings.length; i += 1) {
      arrBindings[i] = replaceStringValueLiterals(arrBindings[i], strRepMap);
    }
    for (let i = 0; i < objBindings.length; i += 1) {
      objBindings[i] = replaceStringValueLiterals(objBindings[i], strRepMap);
    }
    expr = replaceStringValueLiterals(expr, strRepMap);
  }

  // 4. Hoist up to 6 high-frequency common string prefixes across remaining non-key string values (keeps thin shim well <4096 B)
  for (let pPass = 0; pPass < 6; pPass += 1) {
    const pVar = pPass === 0 ? '_P' : `_P${pPass}`;
    const prefCounts = new Map();
    const allTargets = [...strBindings, ...arrBindings, ...objBindings, expr];
    const prefLiterals = new Set();
    for (const chunk of allTargets) {
      for (const lit of scanStringValueLiterals(chunk)) {
        if (lit.length < 12) continue;
        prefLiterals.add(lit);
        try {
          const val = JSON.parse(lit);
          if (typeof val !== 'string' || val.length < 10) continue;
          for (const delim of ['="', ':', '/', '-']) {
            const pos = val.indexOf(delim);
            if (pos >= 5 && pos + delim.length < val.length - 2) {
              const pfx = val.slice(0, pos + delim.length);
              prefCounts.set(pfx, (prefCounts.get(pfx) || 0) + 1);
            }
          }
        } catch (_e) {}
      }
    }
    let bestValPfx = null;
    let bestValPfxSavings = 0;
    for (const [pfx, count] of prefCounts.entries()) {
      if (count < 3) continue;
      const encLen = serializeSafeInlineJson(pfx).length - 2;
      const savings = count * (encLen - (pVar.length + 1)) - (encLen + 10);
      if (savings > bestValPfxSavings) {
        bestValPfxSavings = savings;
        bestValPfx = pfx;
      }
    }
    if (!bestValPfx || bestValPfxSavings < 8) break;
    const pfxRepMap = new Map();
    for (const lit of prefLiterals) {
      try {
        const val = JSON.parse(lit);
        if (typeof val === 'string' && val.startsWith(bestValPfx) && val.length > bestValPfx.length) {
          const rest = val.slice(bestValPfx.length);
          pfxRepMap.set(lit, `${pVar}+${serializeSafeInlineJson(rest)}`);
        }
      } catch (_e) {}
    }
    if (pfxRepMap.size >= 3) {
      for (let i = 0; i < strBindings.length; i += 1) {
        strBindings[i] = replaceStringValueLiterals(strBindings[i], pfxRepMap);
      }
      for (let i = 0; i < arrBindings.length; i += 1) {
        arrBindings[i] = replaceStringValueLiterals(arrBindings[i], pfxRepMap);
      }
      for (let i = 0; i < objBindings.length; i += 1) {
        objBindings[i] = replaceStringValueLiterals(objBindings[i], pfxRepMap);
      }
      expr = replaceStringValueLiterals(expr, pfxRepMap);
      strBindings.unshift(`${pVar}=${serializeSafeInlineJson(bestValPfx)}`);
    }
  }

  // 5. Hoist high-frequency common string suffix (e.g. ".google.com") across remaining non-key string values
  const sufCounts = new Map();
  const sufLiterals = new Set();
  for (const chunk of [...strBindings, ...arrBindings, ...objBindings, expr]) {
    for (const lit of scanStringValueLiterals(chunk)) {
      if (lit.length < 14) continue;
      sufLiterals.add(lit);
      try {
        const val = JSON.parse(lit);
        if (typeof val !== 'string' || val.length < 12) continue;
        const dotPos = val.indexOf('.');
        if (dotPos >= 2 && val.length - dotPos >= 8) {
          const sfx = val.slice(dotPos);
          sufCounts.set(sfx, (sufCounts.get(sfx) || 0) + 1);
        }
      } catch (_e) {}
    }
  }
  let bestSfx = null;
  let bestSfxSavings = 0;
  for (const [sfx, count] of sufCounts.entries()) {
    if (count < 3) continue;
    const encLen = serializeSafeInlineJson(sfx).length - 2;
    const savings = count * (encLen - 3) - (encLen + 10);
    if (savings > bestSfxSavings) {
      bestSfxSavings = savings;
      bestSfx = sfx;
    }
  }
  if (bestSfx && bestSfxSavings >= 8) {
    const sfxRepMap = new Map();
    for (const lit of sufLiterals) {
      try {
        const val = JSON.parse(lit);
        if (typeof val === 'string' && val.endsWith(bestSfx) && val.length > bestSfx.length) {
          const head = val.slice(0, val.length - bestSfx.length);
          sfxRepMap.set(lit, `${serializeSafeInlineJson(head)}+_X`);
        }
      } catch (_e) {}
    }
    if (sfxRepMap.size >= 3) {
      for (let i = 0; i < strBindings.length; i += 1) {
        strBindings[i] = replaceStringValueLiterals(strBindings[i], sfxRepMap);
      }
      for (let i = 0; i < arrBindings.length; i += 1) {
        arrBindings[i] = replaceStringValueLiterals(arrBindings[i], sfxRepMap);
      }
      for (let i = 0; i < objBindings.length; i += 1) {
        objBindings[i] = replaceStringValueLiterals(objBindings[i], sfxRepMap);
      }
      expr = replaceStringValueLiterals(expr, sfxRepMap);
      strBindings.unshift(`_X=${serializeSafeInlineJson(bestSfx)}`);
    }
  }

  for (let i = 0; i < objBindings.length; i += 1) {
    objBindings[i] = unquoteSafeObjectKeys(objBindings[i]);
  }
  expr = unquoteSafeObjectKeys(expr);

  const defs = [];
  const merged = [...strBindings, ...arrBindings, ...objBindings];
  if (merged.length > 0) defs.push(`const ${merged.join(',')};`);
  if (baseDefs.length > 0) defs.push(...baseDefs);

  return { defs, expr };
}

function buildHostLoaderScriptSource(
  paths,
  profile,
  {
    hostVersion = '3.0.0',
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
      ...(Array.isArray(profile.remoteAllowedOrigins) && profile.remoteAllowedOrigins.length > 0
        ? { remoteAllowedOrigins: profile.remoteAllowedOrigins }
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
      ...(Array.isArray(profile.uiGridMerges) && profile.uiGridMerges.length > 0
        ? { uiGridMerges: profile.uiGridMerges }
        : {}),
      ...(profile.uiSectionTargets && Object.keys(profile.uiSectionTargets).length > 0
        ? { uiSectionTargets: profile.uiSectionTargets }
        : {}),
      ...(profile.settingsUi ? { settingsUi: profile.settingsUi } : {}),
      ...(profile.portalBridge ? { portalBridge: profile.portalBridge } : {}),
      ...(profile.updateSurvival ? { updateSurvival: profile.updateSurvival } : {}),
      ...(Array.isArray(profile.forbiddenNetHosts) && profile.forbiddenNetHosts.length > 0
        ? { forbiddenNetHosts: profile.forbiddenNetHosts }
        : {}),
      ...(profile.namedLoopbackTargets && Object.keys(profile.namedLoopbackTargets).length > 0
        ? { namedLoopbackTargets: profile.namedLoopbackTargets }
        : {}),
    },
  };

  const { defs: cfgDefs, expr: cfgExpr } = serializeDeduplicatedConfigJs(hostCfg);
  const cfgPrefix = cfgDefs.length > 0 ? cfgDefs.join('\n') + '\n' : '';
  const runtimeLookupExpr = relRuntimeDir
    ? `path.resolve(__dirname,${serializeSafeInlineJson(relRuntimeDir)})`
    : serializeSafeInlineJson(path.resolve(runtimeEntryDir || path.resolve(__dirname, '..', '..', '..', 'dist', 'runtime')));

  return `'use strict';
// Auto-generated thin v${hostCfg.hostVersion} entry shim (${profile.patchMarker},${buildSha8}).
const path=require('node:path');
${cfgPrefix}const HOST_CFG=${cfgExpr};
const RUNTIME_DIR=${runtimeLookupExpr};
const j=(...p)=>path.join(RUNTIME_DIR,...p),rt=require(j('main','init-main.js')),cfg=()=>({...HOST_CFG,preloadBridgePath:j('preload','preload-bridge.cjs'),kernelBundlePath:j('renderer','kernel-bundle.cjs')});
module.exports={HOST_CFG,RUNTIME_DIR,initMain:(a,d)=>rt.initMain(a,cfg(),d),createHostRuntimeController:d=>rt.createHostRuntimeController(cfg(),d),getBuildInfo:()=>({hostVersion:HOST_CFG.hostVersion,buildSha8:HOST_CFG.buildSha8,patchMarker:HOST_CFG.profile.patchMarker})};
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
