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
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '2.6.0';
  } catch (_err) {
    return '2.6.0';
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

  const exported = Object.freeze({
    REMOTE_WEB_PROFILE,
    PACKED_ADDONS,
    bootRemoteWebHost,
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

function buildUserscriptSource(runtimeSource, { profile = ANTIGRAVITY_REMOTE_WEB_PROFILE, version = '2.6.0' } = {}) {
  const browserProfile = toBrowserRemoteWebProfile(profile);
  const matchLines = (browserProfile.allowedOrigins || []).map((origin) => `// @match        ${origin}/*`);
  const header = [
    '// ==UserScript==',
    `// @name         ${browserProfile.displayName} Addon Host`,
    `// @namespace    https://github.com/jaeseongs95/antigravity-addons`,
    `// @version      ${version}`,
    `// @description  Unified AddonManifest.v2 renderer addon host for ${browserProfile.displayName}`,
    ...matchLines,
    '// @run-at       document-idle',
    '// @grant        none',
    '// ==/UserScript==',
    '',
  ].join('\n');

  return `${header}${toLf(runtimeSource)}\n${buildAutoBootSnippet()}`;
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
  hostVersion = null,
  isEnabled = null,
} = {}) {
  const effectiveVersion = hostVersion || readPackageVersion();
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
      isEnabled,
    });
  }

  const runtimeSource = buildRemoteRuntimeBundleSource({
    profile,
    packedAddons: collection.addons,
  });
  const userscriptSource = buildUserscriptSource(runtimeSource, {
    profile,
    version: effectiveVersion,
  });
  const extensionContentScriptSource = buildExtensionContentScriptSource(runtimeSource);

  const runtimeAst = verifyRemoteBundleAst(runtimeSource);
  if (!runtimeAst.ok) {
    throw new Error(`REMOTE_RUNTIME_AST_VIOLATIONS:${JSON.stringify(runtimeAst.violations)}`);
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
    check: false,
    noAddons: false,
    includeSettingsSnapshots: false,
    strictTrustPolicy: true,
    outDir: DEFAULT_DIST_REMOTE_DIR,
    addonsDir: undefined,
    pluginsRootDir: undefined,
    configJsonPath: undefined,
    trustPolicyPath: undefined,
    remotePrefsPath: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--check') opts.check = true;
    else if (a === '--no-addons') opts.noAddons = true;
    else if (a === '--include-settings-snapshots') opts.includeSettingsSnapshots = true;
    else if (a === '--allow-untrusted-dev') opts.strictTrustPolicy = false;
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
      extensionDir: path.join(opts.outDir, 'extension'),
      bundleMode: res.buildManifest.mode,
      buildSha8: res.buildManifest.buildSha8,
      addonCount: res.buildManifest.addonCount,
      skippedMainHookPlugins: res.buildManifest.skippedMainHookPlugins,
      rejectedCount: res.buildManifest.rejectedCount,
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
  buildRemoteRuntimeBundleSource,
  buildUserscriptSource,
  buildExtensionContentScriptSource,
  buildBookmarkletText,
  verifyRemoteBundleAst,
  syncRemoteDistInPlace,
  buildDistRemote,
  parseCliArgs,
};
