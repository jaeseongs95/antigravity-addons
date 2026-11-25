'use strict';

/**
 * Deterministic Remote Web Bundle Builder & Acorn AST Security Verifier (v2.3.0).
 *
 * Uses ONLY Node built-ins + existing `acorn` + `scripts/build-runtime.js` (ZERO new npm deps):
 * 1. Bundles the shared renderer kernel (`buildRendererKernelBundleSource()`) alongside
 *    the vendor-neutral `src/adapters/remote-web/` browser modules and serialized
 *    `ANTIGRAVITY_REMOTE_WEB_PROFILE`.
 * 2. In `--no-addons` mode (CI / deterministic verification), emits a 0-addon host-only
 *    bundle with zero machine paths and zero personal data.
 * 3. In local packing mode, collects verified `AddonManifest.v2` renderer addons via
 *    `collectRemoteWebAddons` (auto-including `antigravity-desktop` renderer addons,
 *    fail-closed skipping `mainHook`, verifying single-read SHA-256 & trust policy) and
 *    embeds each verified renderer script as a static `'use strict'` closure (ZERO `eval`
 *    or `new Function`).
 * 4. Runs full `acorn` AST verification blocking HTML sinks (`innerHTML`, `outerHTML`,
 *    `insertAdjacentHTML`, `document.write`/`writeln`), dynamic code execution (`eval`,
 *    `new Function`), external `require`/`import()`, and forbidden `'default'` TrustedTypes
 *    policy creation.
 * 5. `--check` builds twice into clean `os.tmpdir()` directories to prove byte-exact
 *    reproducibility, runs full AST verification, and compares against `dist/remote/`
 *    when committed outputs exist on disk.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const acorn = require('acorn');

const { buildRendererKernelBundleSource } = require('./build-runtime');
const {
  ANTIGRAVITY_REMOTE_WEB_PROFILE,
  toBrowserRemoteWebProfile,
} = require('../src/profiles/antigravity-remote-web');
const { validateAddonManifest } = require('../src/core/manifest-validator');
const { collectRemoteWebAddons } = require('../src/adapters/remote-web/addon-collector');
const {
  EXTENSION_CONTENT_SCRIPT_FILENAME,
  buildMv3ExtensionManifest,
} = require('../src/adapters/remote-web/extension-manifest');
const { BOOKMARKLET_MAX_RUNNABLE_CHARS } = require('../src/runtime/shared/constants');
const { serializeSafeInlineJson } = require('../src/runtime/shared/safe-json');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DIST_REMOTE_DIR = path.join(REPO_ROOT, 'dist', 'remote');

const REMOTE_BROWSER_MODULES = Object.freeze([
  './origin-guard.js',
  './trusted-types-guard.js',
  './dom-guard.js',
  './remote-host-bridge.js',
  './remote-bootstrap.js',
]);

const FORBIDDEN_HTML_SINK_PROPERTIES = new Set([
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
  'setHTMLUnsafe',
  'srcdoc',
]);
const FORBIDDEN_DOM_PARSER_METHODS = new Set(['createContextualFragment', 'parseFromString']);
const FORBIDDEN_WORKER_CONSTRUCTORS = new Set(['Worker', 'SharedWorker']);
const FORBIDDEN_STRING_TIMER_CALLS = new Set(['setTimeout', 'setInterval']);
const FORBIDDEN_DOC_METHODS = new Set(['write', 'writeln']);
const FORBIDDEN_GLOBAL_CALLS = new Set(['eval']);

function toLf(text) {
  return String(text || '').replace(/\r\n/g, '\n');
}

function sha256Hex(bufOrStr) {
  return crypto.createHash('sha256').update(bufOrStr).digest('hex');
}

function writeFileLf(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const data = toLf(content);
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      fs.writeFileSync(filePath, data, 'utf8');
      return;
    } catch (err) {
      lastErr = err;
      if (!err || (err.code !== 'EBUSY' && err.code !== 'EPERM' && err.code !== 'EACCES')) {
        throw err;
      }
    }
  }
  if (lastErr) throw lastErr;
}

function syncRemoteDistInPlace(targetDir, fileMap) {
  fs.mkdirSync(targetDir, { recursive: true });
  const desiredRelPaths = new Set(Object.keys(fileMap));
  const neededDirs = new Set(['']);
  for (const rel of desiredRelPaths) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      neededDirs.add(parts.slice(0, i).join('/'));
    }
  }

  for (const [rel, content] of Object.entries(fileMap)) {
    const dest = path.join(targetDir, ...rel.split('/'));
    writeFileLf(dest, content);
  }

  function pruneStale(dir, relPrefix) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_err) {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        pruneStale(full, rel);
        if (!neededDirs.has(rel)) {
          try {
            if (fs.readdirSync(full).length === 0) {
              fs.rmdirSync(full);
            }
          } catch (_rmdirErr) {
            // Best-effort pruning of empty stale subdirectories.
          }
        }
      } else if (!desiredRelPaths.has(rel) && rel !== 'build-manifest.json') {
        try {
          fs.unlinkSync(full);
        } catch (_unlinkErr) {
          // Best-effort removal of stale output files.
        }
      }
    }
  }

  pruneStale(targetDir, '');
}

function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '2.7.0';
  } catch (_err) {
    return '2.7.0';
  }
}

function serializePackedAddonLiteral(addon) {
  const metaJson = serializeSafeInlineJson(addon.pluginMeta);
  const settingsSpecJson = serializeSafeInlineJson(addon.settingsSpec || null);
  const initSnapJson = serializeSafeInlineJson(addon.initialSettingsSnapshot || null);
  const shaJson = serializeSafeInlineJson(addon.rendererSha256 || null);
  const source = toLf(addon.rendererSource || '');
  return `{
    pluginMeta: ${metaJson},
    settingsSpec: ${settingsSpecJson},
    initialSettingsSnapshot: ${initSnapJson},
    rendererSha256: ${shaJson},
    run: function(addonHost) {
      'use strict';
${source}
    }
  }`;
}

function buildRemoteRuntimeBundleSource({ profile = ANTIGRAVITY_REMOTE_WEB_PROFILE, packedAddons = [] } = {}) {
  const browserProfile = toBrowserRemoteWebProfile(profile);
  const kernelSrc = toLf(buildRendererKernelBundleSource({ includeHostSettingsUi: false }));
  const remoteAdapterDir = path.join(REPO_ROOT, 'src', 'adapters', 'remote-web');

  const moduleEntries = REMOTE_BROWSER_MODULES.map((relId) => {
    const abs = path.join(remoteAdapterDir, relId.slice(2));
    const src = toLf(fs.readFileSync(abs, 'utf8'));
    return `  ${JSON.stringify(relId)}: function(module, exports, require) {\n${src}\n  }`;
  });

  const addonLiterals = (packedAddons || []).map(serializePackedAddonLiteral);

  return `'use strict';
// Auto-generated Remote Web Addon Host Runtime Bundle (zero external dependencies, zero HTML sinks).
(function(root) {
${kernelSrc}

  const __remoteMods = {
${moduleEntries.join(',\n')}
  };
  const __remoteCache = Object.create(null);
  function __remoteReq(id) {
    const key = id.endsWith('.js') ? id : id + '.js';
    if (__remoteCache[key]) return __remoteCache[key].exports;
    const fn = __remoteMods[key];
    if (!fn) throw new Error('ERR_REMOTE_BUNDLE_MISSING_MOD:' + key);
    const mod = { exports: {} };
    __remoteCache[key] = mod;
    fn(mod, mod.exports, __remoteReq);
    return mod.exports;
  }

  const REMOTE_WEB_PROFILE = Object.freeze(${serializeSafeInlineJson(browserProfile)});
  const PACKED_ADDONS = Object.freeze([
${addonLiterals.join(',\n')}
  ]);

  const bootstrapMod = __remoteReq('./remote-bootstrap.js');
  const originMod = __remoteReq('./origin-guard.js');
  const ttMod = __remoteReq('./trusted-types-guard.js');
  const bridgeMod = __remoteReq('./remote-host-bridge.js');

  function bootRemoteWebHost(overrides) {
    const opts = overrides && typeof overrides === 'object' ? overrides : {};
    return bootstrapMod.bootRemoteWebHost({
      profile: opts.profile || REMOTE_WEB_PROFILE,
      packedAddons: Array.isArray(opts.packedAddons) ? opts.packedAddons : PACKED_ADDONS,
      doc: opts.doc,
      win: opts.win,
      kernel: opts.kernel,
      docGenId: opts.docGenId,
      storage: opts.storage,
      remoteTransport: opts.remoteTransport,
      configScopeSnapshots: opts.configScopeSnapshots,
      allowedOrigins: opts.allowedOrigins,
      allowLoopbackHttp: opts.allowLoopbackHttp,
      mountDrawer: opts.mountDrawer,
      mountFallbackDock: opts.mountFallbackDock,
    });
  }

  function registerAddon(descriptor, opts) {
    return bootstrapMod.registerAddon(descriptor, opts);
  }

  function getRegisteredAddons(win) {
    return bootstrapMod.getRegisteredAddons(win);
  }

  const exported = Object.freeze({
    REMOTE_WEB_PROFILE,
    PACKED_ADDONS,
    bootRemoteWebHost,
    registerAddon,
    getRegisteredAddons,
    originGuard: originMod,
    trustedTypesGuard: ttMod,
    remoteHostBridge: bridgeMod,
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root && typeof root === 'object') {
    Object.defineProperty(root, '__addonHostRemoteRuntime', {
      value: exported,
      writable: false,
      configurable: true,
      enumerable: false,
    });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
`;
}

function buildAutoBootSnippet() {
  return `
(function() {
  'use strict';
  if (typeof globalThis !== 'undefined' && globalThis.__addonHostRemoteRuntime) {
    Promise.resolve(globalThis.__addonHostRemoteRuntime.bootRemoteWebHost())
      .then(function(res) {
        if (res && res.ok === false && typeof console !== 'undefined' && typeof console.warn === 'function') {
          console.warn('[addon-host-remote] boot skipped:', res.reason || 'UNKNOWN', res.error || '');
        }
      })
      .catch(function(err) {
        if (typeof console !== 'undefined' && typeof console.warn === 'function') {
          console.warn('[addon-host-remote] boot failed:', err && err.message ? err.message : String(err));
        }
      });
  }
})();
`;
}

function normalizeUpdateBaseUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch (_err) {
    throw new Error(`ERR_INVALID_UPDATE_BASE_URL:${rawUrl}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`ERR_UPDATE_BASE_URL_MUST_BE_HTTPS:${rawUrl}`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`ERR_UPDATE_BASE_URL_UNSAFE:${rawUrl}`);
  }
  return parsed.href.replace(/\/+$/, '');
}

function normalizeHostLibUrl(rawUrl, profile = ANTIGRAVITY_REMOTE_WEB_PROFILE) {
  const effective =
    typeof rawUrl === 'string' && rawUrl.trim()
      ? rawUrl.trim()
      : `${normalizeUpdateBaseUrl(profile.defaultUpdateBaseUrl)}/antigravity-remote-host.lib.js`;
  let parsed;
  try {
    parsed = new URL(effective);
  } catch (_err) {
    throw new Error(`ERR_INVALID_HOST_LIB_URL:${rawUrl}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`ERR_HOST_LIB_URL_MUST_BE_HTTPS:${rawUrl}`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`ERR_HOST_LIB_URL_UNSAFE:${rawUrl}`);
  }
  return parsed.href;
}

const CONNECT_HOST_RE =
  /^(?:localhost|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}|(?:\d{1,3}\.){3}\d{1,3})$/i;

function normalizeConnectHosts(rawHosts) {
  if (!Array.isArray(rawHosts) || rawHosts.length === 0) return [];
  const out = [];
  const seen = new Set();
  for (let i = 0; i < rawHosts.length; i += 1) {
    const h = String(rawHosts[i] || '').trim().toLowerCase();
    if (!h) continue;
    if (!CONNECT_HOST_RE.test(h)) {
      throw new Error(`ERR_INVALID_CONNECT_HOST:${rawHosts[i]}`);
    }
    if (!seen.has(h)) {
      seen.add(h);
      out.push(h);
    }
  }
  return out;
}

function buildModularAddonUserscriptMetaHeader({
  profile = ANTIGRAVITY_REMOTE_WEB_PROFILE,
  manifest,
  hostLibUrl,
  updateBaseUrl = null,
  connectHosts = [],
  grantXhr = false,
  namespace = 'https://github.com/jaeseongs95/antigravity-addons',
} = {}) {
  const browserProfile = toBrowserRemoteWebProfile(profile);
  const matchLines = (browserProfile.allowedOrigins || []).map((origin) => `// @match        ${origin}/*`);
  const safeHostLibUrl = normalizeHostLibUrl(hostLibUrl, profile);
  const safeBaseUrl = normalizeUpdateBaseUrl(updateBaseUrl);
  const safeConnects = normalizeConnectHosts(connectHosts);
  const grants = grantXhr ? [...USERSCRIPT_GRANTS, 'GM_xmlhttpRequest'] : USERSCRIPT_GRANTS.slice();
  const pluginId = manifest.pluginId;
  const displayName = String(manifest.displayName || pluginId).replace(/[\r\n]+/g, ' ').trim();
  const version = String(manifest.version || '1.0.0').replace(/[\r\n]+/g, ' ').trim();
  const userscriptFileName = `${pluginId}.user.js`;
  const metaFileName = `${pluginId}.meta.js`;

  const lines = [
    '// ==UserScript==',
    `// @name         ${displayName} (${browserProfile.displayName})`,
    `// @namespace    ${namespace}`,
    `// @version      ${version}`,
    `// @description  Modular AddonManifest.v2 Remote Web Userscript for ${displayName}`,
    ...matchLines,
    '// @run-at       document-idle',
    '// @inject-into  content',
    `// @require      ${safeHostLibUrl}`,
    ...grants.map((grant) => `// @grant        ${grant}`),
    ...safeConnects.map((host) => `// @connect      ${host}`),
  ];
  if (safeBaseUrl) {
    lines.push(`// @updateURL    ${safeBaseUrl}/${metaFileName}`);
    lines.push(`// @downloadURL  ${safeBaseUrl}/${userscriptFileName}`);
  }
  lines.push('// ==/UserScript==', '');
  return lines.join('\n');
}

function buildAddonUserscript({
  manifestPath,
  pluginDir = null,
  targetDir,
  profile = ANTIGRAVITY_REMOTE_WEB_PROFILE,
  hostLibUrl = null,
  updateBaseUrl = null,
  connectHosts = [],
  grantXhr = false,
  namespace = 'https://github.com/jaeseongs95/antigravity-addons',
} = {}) {
  if (typeof manifestPath !== 'string' || !manifestPath.trim()) {
    throw new Error('ERR_MANIFEST_PATH_REQUIRED');
  }
  if (typeof targetDir !== 'string' || !targetDir.trim()) {
    throw new Error('ERR_TARGET_DIR_REQUIRED');
  }
  const absManifest = path.resolve(manifestPath);
  const rawManifest = JSON.parse(fs.readFileSync(absManifest, 'utf8'));
  const validation = validateAddonManifest(rawManifest, {
    hostProfile: profile.id,
    compatibleHostProfiles: profile.compatibleHostProfiles,
    hostCapabilities: profile.capabilities,
    strictTrustPolicy: true,
    checkFilesExist: false,
  });
  if (!validation.ok) {
    throw new Error(
      `ERR_INVALID_ADDON_MANIFEST:${validation.reason || 'INVALID'}:${JSON.stringify(validation.errors || [])}`
    );
  }
  const manifest = validation.manifest;
  const caps = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
  if (!caps.includes('renderer')) {
    throw new Error(`ERR_UNSUPPORTED_HOST_CAPABILITY:${manifest.pluginId}:renderer_required`);
  }
  const relRenderer = manifest.entry && typeof manifest.entry.rendererScript === 'string' ? manifest.entry.rendererScript : '';
  if (!relRenderer) {
    throw new Error(`ERR_RENDERER_SCRIPT_REQUIRED:${manifest.pluginId}`);
  }
  const resolvedPluginDir = pluginDir ? path.resolve(pluginDir) : path.dirname(absManifest);
  const absRenderer = path.resolve(resolvedPluginDir, relRenderer);
  const relCheck = path.relative(resolvedPluginDir, absRenderer);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    throw new Error(`ERR_RENDERER_SCRIPT_OUTSIDE_PLUGIN_DIR:${relRenderer}`);
  }
  const realPluginDir = fs.realpathSync(resolvedPluginDir);
  const realRenderer = fs.realpathSync(absRenderer);
  const realRelCheck = path.relative(realPluginDir, realRenderer);
  if (realRelCheck.startsWith('..') || path.isAbsolute(realRelCheck)) {
    throw new Error(`ERR_RENDERER_SCRIPT_OUTSIDE_PLUGIN_DIR:${relRenderer}`);
  }
  const rendererBuf = fs.readFileSync(realRenderer);
  const rendererSha256 = sha256Hex(rendererBuf);
  const rendererSource = toLf(rendererBuf.toString('utf8'));

  const safeHostLibUrl = normalizeHostLibUrl(hostLibUrl, profile);
  const safeBaseUrl = normalizeUpdateBaseUrl(updateBaseUrl);
  const safeConnects = normalizeConnectHosts(connectHosts);

  const skippedCapabilities = Array.isArray(validation.skippedCapabilities)
    ? validation.skippedCapabilities.slice()
    : caps.filter((c) => c !== 'renderer');
  const effectiveTrustLevel = validation.trustLevel || manifest.trustLevel || 'restricted';
  const pluginMeta = {
    schemaVersion: 2,
    sourceSchemaVersion: manifest.sourceSchemaVersion || manifest.schemaVersion || 2,
    pluginId: manifest.pluginId,
    displayName: manifest.displayName || manifest.pluginId,
    version: manifest.version || '1.0.0',
    trustLevel: effectiveTrustLevel,
    capabilities: ['renderer'],
    skippedCapabilities,
    hasDocumentTransformSlot: Boolean(validation.hasDocumentTransformSlot),
    hasSettingsBridge: Boolean(validation.hasSettingsBridge && effectiveTrustLevel === 'trusted'),
    hasConfigBridge: false,
    configScopes: [],
    uiSlots: Array.isArray(manifest.uiSlots) ? manifest.uiSlots : [],
    isolation: manifest.isolation || {},
  };
  const settingsSpec =
    pluginMeta.hasSettingsBridge && manifest.settingsBridge && manifest.settingsBridge.fileName
      ? {
          fileName: manifest.settingsBridge.fileName,
          maxBytes: manifest.settingsBridge.maxBytes,
        }
      : null;

  const metaSource = buildModularAddonUserscriptMetaHeader({
    profile,
    manifest,
    hostLibUrl: safeHostLibUrl,
    updateBaseUrl: safeBaseUrl,
    connectHosts: safeConnects,
    grantXhr: Boolean(grantXhr),
    namespace,
  });

  const addonLiteral = serializePackedAddonLiteral({
    pluginMeta,
    settingsSpec,
    initialSettingsSnapshot: null,
    rendererSha256,
    rendererSource,
  });

  const bodySource = `'use strict';
(function() {
  var rt = typeof globalThis !== 'undefined' ? globalThis.__addonHostRemoteRuntime : null;
  if (!rt || typeof rt.registerAddon !== 'function' || typeof rt.bootRemoteWebHost !== 'function') {
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn('[addon-host-remote] @require host library missing for ${manifest.pluginId}');
    }
    return;
  }
  rt.registerAddon(${addonLiteral});
  Promise.resolve(rt.bootRemoteWebHost())
    .then(function(res) {
      if (res && res.ok === false && typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn('[addon-host-remote] boot skipped (${manifest.pluginId}):', res.reason || 'UNKNOWN', res.error || '');
      }
    })
    .catch(function(err) {
      if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn('[addon-host-remote] boot failed (${manifest.pluginId}):', err && err.message ? err.message : String(err));
      }
    });
})();
`;

  const userscriptSource = `${metaSource}${bodySource}`;
  const astCheck = verifyRemoteBundleAst(userscriptSource);
  if (!astCheck.ok) {
    throw new Error(`MODULAR_ADDON_USERSCRIPT_AST_VIOLATIONS:${JSON.stringify(astCheck.violations)}`);
  }

  const userscriptFile = `${manifest.pluginId}.user.js`;
  const metaFile = `${manifest.pluginId}.meta.js`;
  const outputFiles = {
    [userscriptFile]: userscriptSource,
    [metaFile]: metaSource,
  };
  syncRemoteDistInPlace(targetDir, outputFiles);

  const fileNames = Object.keys(outputFiles).sort();
  const fileHashes = {};
  const rootHasher = crypto.createHash('sha256');
  for (const name of fileNames) {
    const h = sha256Hex(fs.readFileSync(path.join(targetDir, name)));
    fileHashes[name] = h;
    rootHasher.update(name + '\0' + h + '\n', 'utf8');
  }
  const buildSha256 = rootHasher.digest('hex');
  const buildSha8 = buildSha256.slice(0, 8);

  const buildManifest = {
    schemaVersion: 1,
    mode: 'modular-addon-userscript',
    profileId: profile.id,
    pluginId: manifest.pluginId,
    version: manifest.version,
    rendererSha256,
    hostLibUrl: safeHostLibUrl,
    updateBaseUrl: safeBaseUrl,
    connectHosts: safeConnects,
    grantXhr: Boolean(grantXhr),
    buildSha8,
    buildSha256,
    userscriptFile,
    metaFile,
    files: fileHashes,
  };
  writeFileLf(path.join(targetDir, 'build-manifest.json'), JSON.stringify(buildManifest, null, 2) + '\n');
  return { ok: true, buildManifest, userscriptPath: path.join(targetDir, userscriptFile), metaPath: path.join(targetDir, metaFile) };
}

const USERSCRIPT_GRANTS = Object.freeze(['GM_getValue', 'GM_setValue', 'GM_deleteValue']);

function buildUserscriptMetaHeader({
  profile = ANTIGRAVITY_REMOTE_WEB_PROFILE,
  version = '2.7.0',
  updateBaseUrl = null,
  userscriptFileName = 'antigravity-remote.user.js',
  metaFileName = 'antigravity-remote.meta.js',
} = {}) {
  const browserProfile = toBrowserRemoteWebProfile(profile);
  const matchLines = (browserProfile.allowedOrigins || []).map((origin) => `// @match        ${origin}/*`);
  const safeBaseUrl = normalizeUpdateBaseUrl(updateBaseUrl);
  const lines = [
    '// ==UserScript==',
    `// @name         ${browserProfile.displayName} Addon Host`,
    `// @namespace    https://github.com/jaeseongs95/antigravity-addons`,
    `// @version      ${version}`,
    `// @description  Unified AddonManifest.v2 renderer addon host for ${browserProfile.displayName}`,
    ...matchLines,
    '// @run-at       document-idle',
    '// @inject-into  content',
    ...USERSCRIPT_GRANTS.map((grant) => `// @grant        ${grant}`),
  ];
  if (safeBaseUrl) {
    lines.push(`// @updateURL    ${safeBaseUrl}/${metaFileName}`);
    lines.push(`// @downloadURL  ${safeBaseUrl}/${userscriptFileName}`);
  }
  lines.push('// ==/UserScript==', '');
  return lines.join('\n');
}

function buildUserscriptSource(
  runtimeSource,
  { profile = ANTIGRAVITY_REMOTE_WEB_PROFILE, version = '2.7.0', updateBaseUrl = null } = {}
) {
  const header = buildUserscriptMetaHeader({ profile, version, updateBaseUrl });
  return `${header}${toLf(runtimeSource)}\n${buildAutoBootSnippet()}`;
}

function buildHostLibrarySource({ profile = ANTIGRAVITY_REMOTE_WEB_PROFILE } = {}) {
  return buildRemoteRuntimeBundleSource({
    profile,
    packedAddons: [],
  });
}

function buildExtensionContentScriptSource(runtimeSource) {
  return `${toLf(runtimeSource)}\n${buildAutoBootSnippet()}`;
}

function stripJsCommentsWithAcorn(source) {
  const text = toLf(source);
  const comments = [];
  acorn.parse(text, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    allowReturnOutsideFunction: true,
    onComment: comments,
  });
  if (comments.length === 0) return text;
  comments.sort((a, b) => a.start - b.start);
  const parts = [];
  let cursor = 0;
  for (let i = 0; i < comments.length; i += 1) {
    const c = comments[i];
    if (c.start < cursor) continue;
    parts.push(text.slice(cursor, c.start));
    if (c.type === 'Block') {
      const raw = text.slice(c.start, c.end);
      parts.push(/[\r\n\u2028\u2029]/.test(raw) ? '\n' : ' ');
    }
    cursor = c.end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

function buildBookmarkletText(userscriptBodyWithoutHeader) {
  const stripped = stripJsCommentsWithAcorn(userscriptBodyWithoutHeader).trim();
  return `javascript:${encodeURIComponent(stripped)}\n`;
}

function getStaticMemberName(memberExpr) {
  if (!memberExpr || memberExpr.type !== 'MemberExpression' || !memberExpr.property) return null;
  if (!memberExpr.computed && memberExpr.property.type === 'Identifier') {
    return memberExpr.property.name;
  }
  if (memberExpr.computed && memberExpr.property.type === 'Literal' && typeof memberExpr.property.value === 'string') {
    return memberExpr.property.value;
  }
  if (
    memberExpr.computed &&
    memberExpr.property.type === 'TemplateLiteral' &&
    memberExpr.property.expressions.length === 0 &&
    memberExpr.property.quasis.length === 1
  ) {
    return memberExpr.property.quasis[0].value.cooked;
  }
  return null;
}

const GLOBAL_SCOPE_IDENTIFIERS = new Set(['window', 'globalThis', 'self', 'top', 'parent', 'frames']);

function isGlobalScopeObject(node) {
  return Boolean(node && node.type === 'Identifier' && GLOBAL_SCOPE_IDENTIFIERS.has(node.name));
}

function isDocumentObject(node) {
  if (!node) return false;
  if (node.type === 'Identifier' && node.name === 'document') return true;
  if (node.type === 'MemberExpression' && isGlobalScopeObject(node.object) && getStaticMemberName(node) === 'document') {
    return true;
  }
  return false;
}

function isFunctionConstructorRef(node) {
  if (!node) return false;
  if (node.type === 'Identifier' && node.name === 'Function') return true;
  if (node.type === 'MemberExpression' && getStaticMemberName(node) === 'Function') return true;
  return false;
}

function isEvalRef(node) {
  if (!node) return false;
  if (node.type === 'Identifier' && node.name === 'eval') return true;
  if (node.type === 'MemberExpression' && isGlobalScopeObject(node.object) && getStaticMemberName(node) === 'eval') {
    return true;
  }
  return false;
}

function getStaticStringLiteral(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

function isStringOrTemplateNode(node) {
  return Boolean(
    node && ((node.type === 'Literal' && typeof node.value === 'string') || node.type === 'TemplateLiteral')
  );
}

function getWorkerConstructorName(node) {
  if (!node) return null;
  if (node.type === 'Identifier' && FORBIDDEN_WORKER_CONSTRUCTORS.has(node.name)) {
    return node.name;
  }
  if (node.type === 'MemberExpression' && isGlobalScopeObject(node.object)) {
    const prop = getStaticMemberName(node);
    if (prop && FORBIDDEN_WORKER_CONSTRUCTORS.has(prop)) {
      return prop;
    }
  }
  return null;
}

/**
 * Full Acorn AST security verifier for generated Remote Web bundles.
 * Checks syntax, zero HTML/TrustedTypes sinks, zero dynamic eval/Function/string timers,
 * zero Worker constructors, zero script element creation or inline on* handlers,
 * zero external Node requires, and zero forbidden 'default' TrustedTypes policy creation.
 */
function verifyRemoteBundleAst(code) {
  const violations = [];
  let ast;
  try {
    ast = acorn.parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowReturnOutsideFunction: true,
    });
  } catch (err) {
    return {
      ok: false,
      violations: [`AST_PARSE_ERROR:${err && err.message ? err.message : String(err)}`],
    };
  }

  function walk(node) {
    if (!node || typeof node !== 'object') return;

    if (node.type === 'ImportExpression') {
      violations.push('FORBIDDEN_DYNAMIC_IMPORT');
    }

    if (node.type === 'NewExpression') {
      if (isFunctionConstructorRef(node.callee)) {
        violations.push('FORBIDDEN_NEW_FUNCTION');
      }
      const workerName = getWorkerConstructorName(node.callee);
      if (workerName) {
        violations.push(`FORBIDDEN_WORKER_CONSTRUCTOR:${workerName}`);
      }
    }

    if (node.type === 'MemberExpression') {
      const prop = getStaticMemberName(node);
      if (prop) {
        if (FORBIDDEN_HTML_SINK_PROPERTIES.has(prop)) {
          violations.push(`FORBIDDEN_HTML_SINK:${prop}`);
        }
        if (prop === 'createRequire' || prop === 'dlopen') {
          violations.push(`FORBIDDEN_NODE_CAPABILITY:${prop}`);
        }
      }
    }

    if (node.type === 'CallExpression') {
      if (node.callee && node.callee.type === 'Identifier') {
        const fnName = node.callee.name;
        if (FORBIDDEN_GLOBAL_CALLS.has(fnName)) {
          violations.push(`FORBIDDEN_GLOBAL_CALL:${fnName}`);
        }
        if (fnName === 'Function') {
          violations.push('FORBIDDEN_FUNCTION_CONSTRUCTOR');
        }
        if (FORBIDDEN_STRING_TIMER_CALLS.has(fnName) && isStringOrTemplateNode(node.arguments[0])) {
          violations.push(`FORBIDDEN_STRING_TIMER:${fnName}`);
        }
        if (fnName === 'require') {
          const arg = node.arguments[0];
          if (!arg || arg.type !== 'Literal' || typeof arg.value !== 'string') {
            violations.push('FORBIDDEN_DYNAMIC_REQUIRE');
          } else if (!arg.value.startsWith('./')) {
            violations.push(`FORBIDDEN_EXTERNAL_REQUIRE:${arg.value}`);
          }
        }
      }

      if (node.callee && node.callee.type === 'MemberExpression') {
        const methodName = getStaticMemberName(node.callee);
        if (methodName) {
          if (FORBIDDEN_DOC_METHODS.has(methodName) && isDocumentObject(node.callee.object)) {
            violations.push(`FORBIDDEN_DOCUMENT_SINK:document.${methodName}`);
          }
          if (FORBIDDEN_DOM_PARSER_METHODS.has(methodName)) {
            violations.push(`FORBIDDEN_DOM_PARSER_SINK:${methodName}`);
          }
          if (FORBIDDEN_GLOBAL_CALLS.has(methodName) && isGlobalScopeObject(node.callee.object)) {
            violations.push(`FORBIDDEN_GLOBAL_CALL:${methodName}`);
          }
          if (
            FORBIDDEN_STRING_TIMER_CALLS.has(methodName) &&
            isGlobalScopeObject(node.callee.object) &&
            isStringOrTemplateNode(node.arguments[0])
          ) {
            violations.push(`FORBIDDEN_STRING_TIMER:${methodName}`);
          }
          if (methodName === 'Function' && isGlobalScopeObject(node.callee.object)) {
            violations.push('FORBIDDEN_FUNCTION_CONSTRUCTOR');
          }
          if (methodName === 'createElement') {
            const tagLit = getStaticStringLiteral(node.arguments[0]);
            if (typeof tagLit === 'string' && tagLit.trim().toLowerCase() === 'script') {
              violations.push('FORBIDDEN_SCRIPT_ELEMENT_CREATE');
            }
          }
          if (methodName === 'createElementNS') {
            const tagLit = getStaticStringLiteral(node.arguments[1]);
            if (typeof tagLit === 'string' && tagLit.trim().toLowerCase() === 'script') {
              violations.push('FORBIDDEN_SCRIPT_ELEMENT_CREATE');
            }
          }
          if (methodName === 'setAttribute') {
            const attrLit = getStaticStringLiteral(node.arguments[0]);
            if (typeof attrLit === 'string' && /^on/i.test(attrLit.trim())) {
              violations.push('FORBIDDEN_INLINE_EVENT_ATTR');
            }
          }
          if (methodName === 'setAttributeNS') {
            const attrLit = getStaticStringLiteral(node.arguments[1]);
            if (typeof attrLit === 'string' && /^on/i.test(attrLit.trim())) {
              violations.push('FORBIDDEN_INLINE_EVENT_ATTR');
            }
          }
          if (
            methodName === 'construct' &&
            node.callee.object &&
            node.callee.object.type === 'Identifier' &&
            node.callee.object.name === 'Reflect' &&
            isFunctionConstructorRef(node.arguments[0])
          ) {
            violations.push('FORBIDDEN_REFLECT_CONSTRUCT_FUNCTION');
          }
          if (
            methodName === 'apply' &&
            node.callee.object &&
            node.callee.object.type === 'Identifier' &&
            node.callee.object.name === 'Reflect' &&
            (isEvalRef(node.arguments[0]) || isFunctionConstructorRef(node.arguments[0]))
          ) {
            violations.push('FORBIDDEN_REFLECT_APPLY_EVAL');
          }
          if (methodName === 'createPolicy' && node.arguments[0]) {
            const polName = getStaticStringLiteral(node.arguments[0]);
            if (typeof polName === 'string' && polName.toLowerCase() === 'default') {
              violations.push('FORBIDDEN_DEFAULT_TRUSTED_TYPES_POLICY');
            }
          }
        }
      }
    }

    const keys = Object.keys(node);
    for (let i = 0; i < keys.length; i += 1) {
      const val = node[keys[i]];
      if (Array.isArray(val)) {
        for (let j = 0; j < val.length; j += 1) walk(val[j]);
      } else if (val && typeof val.type === 'string') {
        walk(val);
      }
    }
  }

  walk(ast);
  return { ok: violations.length === 0, violations };
}

function buildDistRemote({
  targetDir = DEFAULT_DIST_REMOTE_DIR,
  profile = ANTIGRAVITY_REMOTE_WEB_PROFILE,
  noAddons = false,
  addonsDir = undefined,
  pluginsRootDir = undefined,
  configJsonPath = undefined,
  trustPolicyPath = undefined,
  remotePrefsPath = undefined,
  settingsDataDir = undefined,
  strictTrustPolicy = true,
  includeSettingsSnapshots = false,
  includeOfflineConfigBridge = false,
  updateBaseUrl = null,
  hostVersion = null,
  isEnabled = null,
} = {}) {
  const effectiveVersion = hostVersion || readPackageVersion();
  const safeUpdateBaseUrl = normalizeUpdateBaseUrl(updateBaseUrl);
  let collection = {
    ok: true,
    profileId: profile.id,
    addons: [],
    disabled: [],
    rejected: [],
    skippedMainHookPlugins: [],
    stats: {
      discoveredCount: 0,
      packedCount: 0,
      disabledCount: 0,
      rejectedCount: 0,
      skippedMainHookCount: 0,
    },
  };

  if (!noAddons) {
    collection = collectRemoteWebAddons({
      profile,
      addonsDir,
      pluginsRootDir,
      configJsonPath,
      trustPolicyPath,
      remotePrefsPath,
      settingsDataDir,
      hostVersion: effectiveVersion,
      strictTrustPolicy,
      includeSettingsSnapshots,
      includeOfflineConfigBridge,
      isEnabled,
    });
  }

  const runtimeSource = buildRemoteRuntimeBundleSource({
    profile,
    packedAddons: collection.addons,
  });
  const hostLibSource = buildHostLibrarySource({ profile });
  const userscriptMetaSource = buildUserscriptMetaHeader({
    profile,
    version: effectiveVersion,
    updateBaseUrl: safeUpdateBaseUrl,
  });
  const userscriptSource = buildUserscriptSource(runtimeSource, {
    profile,
    version: effectiveVersion,
    updateBaseUrl: safeUpdateBaseUrl,
  });
  const extensionContentScriptSource = buildExtensionContentScriptSource(runtimeSource);

  const runtimeAst = verifyRemoteBundleAst(runtimeSource);
  if (!runtimeAst.ok) {
    throw new Error(`REMOTE_RUNTIME_AST_VIOLATIONS:${JSON.stringify(runtimeAst.violations)}`);
  }
  const hostLibAst = verifyRemoteBundleAst(hostLibSource);
  if (!hostLibAst.ok) {
    throw new Error(`REMOTE_HOST_LIB_AST_VIOLATIONS:${JSON.stringify(hostLibAst.violations)}`);
  }
  const userscriptAst = verifyRemoteBundleAst(userscriptSource);
  if (!userscriptAst.ok) {
    throw new Error(`REMOTE_USERSCRIPT_AST_VIOLATIONS:${JSON.stringify(userscriptAst.violations)}`);
  }
  const extensionAst = verifyRemoteBundleAst(extensionContentScriptSource);
  if (!extensionAst.ok) {
    throw new Error(`REMOTE_EXTENSION_AST_VIOLATIONS:${JSON.stringify(extensionAst.violations)}`);
  }

  const contentSha8 = sha256Hex(toLf(extensionContentScriptSource)).slice(0, 8);
  const extensionManifestObj = buildMv3ExtensionManifest({
    profile: toBrowserRemoteWebProfile(profile),
    version: effectiveVersion,
    contentSha8,
    contentScriptFile: EXTENSION_CONTENT_SCRIPT_FILENAME,
  });
  const extensionManifestJson = JSON.stringify(extensionManifestObj, null, 2) + '\n';

  const bookmarkletText = buildBookmarkletText(
    runtimeSource + '\nglobalThis.__addonHostRemoteRuntime&&globalThis.__addonHostRemoteRuntime.bootRemoteWebHost();'
  );
  const bookmarkletChars = bookmarkletText.trim().length;
  const bookmarkletRunnable = bookmarkletChars > 0 && bookmarkletChars <= BOOKMARKLET_MAX_RUNNABLE_CHARS;
  if (bookmarkletRunnable) {
    if (!bookmarkletText.startsWith('javascript:')) {
      throw new Error('REMOTE_BOOKMARKLET_INVALID_PREFIX');
    }
    const decodedBookmarklet = decodeURIComponent(bookmarkletText.trim().slice('javascript:'.length));
    const bookmarkletAst = verifyRemoteBundleAst(decodedBookmarklet);
    if (!bookmarkletAst.ok) {
      throw new Error(`REMOTE_BOOKMARKLET_AST_VIOLATIONS:${JSON.stringify(bookmarkletAst.violations)}`);
    }
  }

  const extensionManifestRel = 'extension/manifest.json';
  const extensionContentScriptRel = `extension/${EXTENSION_CONTENT_SCRIPT_FILENAME}`;

  const outputFiles = {
    'antigravity-remote-host.lib.js': hostLibSource,
    'antigravity-remote.meta.js': userscriptMetaSource,
    'antigravity-remote.user.js': userscriptSource,
    [extensionContentScriptRel]: extensionContentScriptSource,
    [extensionManifestRel]: extensionManifestJson,
    'remote-runtime.cjs': runtimeSource,
  };
  if (bookmarkletRunnable) {
    outputFiles['bookmarklet.txt'] = bookmarkletText;
  }

  syncRemoteDistInPlace(targetDir, outputFiles);

  const fileNames = Object.keys(outputFiles).sort();
  const fileHashes = {};
  const rootHasher = crypto.createHash('sha256');
  for (const name of fileNames) {
    const h = sha256Hex(fs.readFileSync(path.join(targetDir, ...name.split('/'))));
    fileHashes[name] = h;
    rootHasher.update(name + '\0' + h + '\n', 'utf8');
  }

  const buildSha256 = rootHasher.digest('hex');
  const buildSha8 = buildSha256.slice(0, 8);

  const buildManifest = {
    schemaVersion: 1,
    profileId: profile.id,
    mode: noAddons ? 'host-only' : 'packed',
    buildSha8,
    buildSha256,
    addonCount: collection.addons.length,
    addons: collection.addons.map((a) => ({
      pluginId: a.pluginMeta.pluginId,
      version: a.pluginMeta.version,
      trustLevel: a.pluginMeta.trustLevel,
      rendererSha256: a.rendererSha256,
      skippedCapabilities: a.pluginMeta.skippedCapabilities,
    })),
    skippedMainHookPlugins: collection.skippedMainHookPlugins,
    rejectedCount: collection.rejected.length,
    rejected: collection.rejected.map((r) => ({
      pluginId: r.pluginId,
      reason: r.reason,
    })),
    userscript: {
      file: 'antigravity-remote.user.js',
      metaFile: 'antigravity-remote.meta.js',
      hostLibFile: 'antigravity-remote-host.lib.js',
      injectInto: 'content',
      grants: USERSCRIPT_GRANTS.slice(),
      updateBaseUrl: safeUpdateBaseUrl,
    },
    extension: {
      dir: 'extension',
      manifestVersion: extensionManifestObj.manifest_version,
      manifestFile: extensionManifestRel,
      contentScriptFile: extensionContentScriptRel,
      world: extensionManifestObj.content_scripts[0].world,
      version: extensionManifestObj.version,
      versionName: extensionManifestObj.version_name,
      matches: extensionManifestObj.content_scripts[0].matches,
    },
    bookmarklet: {
      emitted: bookmarkletRunnable,
      runnable: bookmarkletRunnable,
      reason: bookmarkletRunnable ? null : 'ERR_BOOKMARKLET_EXCEEDS_BROWSER_LIMIT',
      charLength: bookmarkletChars,
      maxChars: BOOKMARKLET_MAX_RUNNABLE_CHARS,
    },
    files: fileHashes,
  };

  writeFileLf(path.join(targetDir, 'build-manifest.json'), JSON.stringify(buildManifest, null, 2) + '\n');
  return {
    ok: true,
    buildManifest,
    collection,
  };
}

function parseCliArgs(argv) {
  const opts = {
    buildAddonUserscript: false,
    manifestPath: null,
    pluginDir: null,
    hostLibUrl: null,
    connectHosts: [],
    grantXhr: false,
    namespace: 'https://github.com/jaeseongs95/antigravity-addons',
    check: false,
    noAddons: false,
    includeSettingsSnapshots: false,
    includeOfflineConfigBridge: false,
    strictTrustPolicy: true,
    updateBaseUrl: null,
    outDir: DEFAULT_DIST_REMOTE_DIR,
    addonsDir: undefined,
    pluginsRootDir: undefined,
    configJsonPath: undefined,
    trustPolicyPath: undefined,
    remotePrefsPath: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--build-addon-userscript') opts.buildAddonUserscript = true;
    else if (a === '--manifest' && argv[i + 1]) opts.manifestPath = path.resolve(argv[++i]);
    else if (a === '--plugin-dir' && argv[i + 1]) opts.pluginDir = path.resolve(argv[++i]);
    else if (a === '--host-lib-url' && argv[i + 1]) opts.hostLibUrl = argv[++i];
    else if (a === '--connect' && argv[i + 1]) opts.connectHosts.push(argv[++i]);
    else if (a === '--grant-xhr') opts.grantXhr = true;
    else if (a === '--namespace' && argv[i + 1]) opts.namespace = argv[++i];
    else if (a === '--check') opts.check = true;
    else if (a === '--no-addons') opts.noAddons = true;
    else if (a === '--include-settings-snapshots') opts.includeSettingsSnapshots = true;
    else if (a === '--include-offline-config-bridge') opts.includeOfflineConfigBridge = true;
    else if (a === '--allow-untrusted-dev') opts.strictTrustPolicy = false;
    else if (a === '--update-base-url' && argv[i + 1]) opts.updateBaseUrl = argv[++i];
    else if (a === '--out-dir' && argv[i + 1]) opts.outDir = path.resolve(argv[++i]);
    else if (a === '--addons-dir' && argv[i + 1]) opts.addonsDir = path.resolve(argv[++i]);
    else if (a === '--plugins-root' && argv[i + 1]) opts.pluginsRootDir = path.resolve(argv[++i]);
    else if (a === '--config-json' && argv[i + 1]) opts.configJsonPath = path.resolve(argv[++i]);
    else if (a === '--trust-policy' && argv[i + 1]) opts.trustPolicyPath = path.resolve(argv[++i]);
    else if (a === '--remote-prefs' && argv[i + 1]) opts.remotePrefsPath = path.resolve(argv[++i]);
  }
  return opts;
}

function main() {
  const opts = parseCliArgs(process.argv.slice(2));

  if (opts.buildAddonUserscript) {
    if (opts.check) {
      const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-addon-us-a-'));
      const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-addon-us-b-'));
      try {
        const resA = buildAddonUserscript({ ...opts, targetDir: tmpA });
        const resB = buildAddonUserscript({ ...opts, targetDir: tmpB });
        if (resA.buildManifest.buildSha256 !== resB.buildManifest.buildSha256) {
          process.stderr.write(
            `ADDON_USERSCRIPT_NONDETERMINISTIC: ${resA.buildManifest.buildSha256} !== ${resB.buildManifest.buildSha256}\n`
          );
          process.exitCode = 1;
          return;
        }
        process.stdout.write(
          JSON.stringify({
            ok: true,
            mode: 'check',
            bundleMode: resA.buildManifest.mode,
            pluginId: resA.buildManifest.pluginId,
            buildSha8: resA.buildManifest.buildSha8,
            buildSha256: resA.buildManifest.buildSha256,
            astViolations: 0,
          }) + '\n'
        );
      } finally {
        try {
          fs.rmSync(tmpA, { recursive: true, force: true });
        } catch (_eA) {}
        try {
          fs.rmSync(tmpB, { recursive: true, force: true });
        } catch (_eB) {}
      }
      return;
    }
    const built = buildAddonUserscript({ ...opts, targetDir: opts.outDir });
    process.stdout.write(
      JSON.stringify({
        ok: true,
        mode: 'build',
        bundleMode: built.buildManifest.mode,
        pluginId: built.buildManifest.pluginId,
        version: built.buildManifest.version,
        outDir: opts.outDir,
        userscriptPath: built.userscriptPath,
        metaPath: built.metaPath,
        hostLibUrl: built.buildManifest.hostLibUrl,
        updateBaseUrl: built.buildManifest.updateBaseUrl,
        buildSha8: built.buildManifest.buildSha8,
        astViolations: 0,
      }) + '\n'
    );
    return;
  }

  if (opts.check) {
    const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-build-remote-a-'));
    const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-build-remote-b-'));
    try {
      const resA = buildDistRemote({ ...opts, targetDir: tmpA });
      const resB = buildDistRemote({ ...opts, targetDir: tmpB });
      if (resA.buildManifest.buildSha256 !== resB.buildManifest.buildSha256) {
        process.stderr.write(
          `REMOTE_BUILD_NONDETERMINISTIC: ${resA.buildManifest.buildSha256} !== ${resB.buildManifest.buildSha256}\n`
        );
        process.exitCode = 1;
        return;
      }

      const committedManifestPath = path.join(opts.outDir, 'build-manifest.json');
      let comparedCommittedManifest = false;
      if (fs.existsSync(committedManifestPath)) {
        const committed = JSON.parse(fs.readFileSync(committedManifestPath, 'utf8'));
        if (committed && committed.mode === resA.buildManifest.mode) {
          comparedCommittedManifest = true;
          if (committed.buildSha256 !== resA.buildManifest.buildSha256) {
            process.stderr.write(
              `REMOTE_BUILD_DRIFT_DETECTED: expected=${resA.buildManifest.buildSha256} actual=${committed.buildSha256}\n`
            );
            process.exitCode = 1;
            return;
          }
        }
      }

      process.stdout.write(
        JSON.stringify({
          ok: true,
          mode: 'check',
          bundleMode: resA.buildManifest.mode,
          buildSha8: resA.buildManifest.buildSha8,
          buildSha256: resA.buildManifest.buildSha256,
          addonCount: resA.buildManifest.addonCount,
          comparedCommittedManifest,
          astViolations: 0,
        }) + '\n'
      );
    } finally {
      try {
        fs.rmSync(tmpA, { recursive: true, force: true });
      } catch (_cleanupErrA) {
        // Best-effort temporary directory cleanup after check comparison.
      }
      try {
        fs.rmSync(tmpB, { recursive: true, force: true });
      } catch (_cleanupErrB) {
        // Best-effort temporary directory cleanup after check comparison.
      }
    }
    return;
  }

  const res = buildDistRemote({ ...opts, targetDir: opts.outDir });
  process.stdout.write(
    JSON.stringify({
      ok: true,
      mode: 'build',
      outDir: opts.outDir,
      userscriptPath: path.join(opts.outDir, 'antigravity-remote.user.js'),
      hostLibPath: path.join(opts.outDir, 'antigravity-remote-host.lib.js'),
      metaPath: path.join(opts.outDir, 'antigravity-remote.meta.js'),
      extensionDir: path.join(opts.outDir, 'extension'),
      bundleMode: res.buildManifest.mode,
      buildSha8: res.buildManifest.buildSha8,
      addonCount: res.buildManifest.addonCount,
      skippedMainHookPlugins: res.buildManifest.skippedMainHookPlugins,
      rejectedCount: res.buildManifest.rejectedCount,
      rejected: res.buildManifest.rejected,
      bookmarkletEmitted: res.buildManifest.bookmarklet.emitted,
      bookmarkletRunnable: res.buildManifest.bookmarklet.runnable,
      bookmarkletChars: res.buildManifest.bookmarklet.charLength,
      astViolations: 0,
    }) + '\n'
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  REMOTE_BROWSER_MODULES,
  BOOKMARKLET_MAX_RUNNABLE_CHARS,
  USERSCRIPT_GRANTS,
  normalizeUpdateBaseUrl,
  normalizeHostLibUrl,
  normalizeConnectHosts,
  buildRemoteRuntimeBundleSource,
  buildHostLibrarySource,
  buildUserscriptMetaHeader,
  buildModularAddonUserscriptMetaHeader,
  buildUserscriptSource,
  buildExtensionContentScriptSource,
  buildBookmarkletText,
  verifyRemoteBundleAst,
  syncRemoteDistInPlace,
  buildDistRemote,
  buildAddonUserscript,
  parseCliArgs,
};
