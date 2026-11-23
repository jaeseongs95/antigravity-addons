'use strict';

/**
 * Zero-TOCTOU TrustVerifier & Memory-Backed Isolated CJS Loader (D-R4-7).
 *
 * - Single-Buffer Read-Then-Execute for `rendererScript`: reads disk ONCE, computes SHA-256,
 *   evaluates Default-Deny `trust-policy.json`, and returns that EXACT buffer string.
 * - Memory-Backed CJS Loader for `mainHookScript`:
 *   1) Resolves `pluginRoot` via `fs.realpathSync` and reads all `.js`/`.cjs`/`.json` files
 *      inside `realRoot` ONCE into a normalized POSIX-keyed `Map` (rejecting any symlink escape).
 *   2) Computes deterministic `bundleSha256` from sorted `(relPosixPath + "\0" + sha256(buf))`.
 *   3) Enforces Default-Deny `evaluateTrustDecision` against host `trust-policy.json`.
 *   4) Compiles and runs modules via `vm.runInThisContext` with a restricted `require`:
 *      - Relative specs (`./`, `../`, `.js`/`.cjs`/`.json`/`/index.js`/`/index.cjs`) resolved
 *        EXCLUSIVELY from the verified memory `Map` (ZERO post-hash disk reads).
 *      - Pre-registers `moduleCache` BEFORE executing module body (supports circular CJS requires).
 *      - Minimal safe built-in allowlist (`path`, `crypto`, `events`, `util`, `url`).
 *      - Blocks `require()` of absolute paths, `file://`, `node_modules`, `.mjs`, `electron`, `fs`,
 *        `child_process`, and `module` (TOCTOU & casual-`require()` guard on SHA-256-pinned trusted
 *        Node code — NOT an OS sandbox; full OS process isolation is deferred to SidecarBridge v2.1.0).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { evaluateTrustDecision, SHA256_HEX_RE } = require('../../core/trust-policy-port');
const { parseSafeJson } = require('../shared/safe-json');

const SAFE_MAIN_HOOK_BUILTINS = Object.freeze({
  path: require('node:path'),
  'node:path': require('node:path'),
  crypto: require('node:crypto'),
  'node:crypto': require('node:crypto'),
  events: require('node:events'),
  'node:events': require('node:events'),
  util: require('node:util'),
  'node:util': require('node:util'),
  url: require('node:url'),
  'node:url': require('node:url'),
});

const ALLOWED_BUNDLE_EXTS = new Set(['.js', '.cjs', '.json']);
const MAX_BUNDLE_FILES = 256;
const MAX_BUNDLE_DIRS = 256;
const MAX_BUNDLE_TOTAL_BYTES = 8 * 1024 * 1024;

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function toPosixPath(rel) {
  return String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function loadTrustPolicyFile(trustPolicyPath) {
  if (!trustPolicyPath || !fs.existsSync(trustPolicyPath)) {
    return { ok: true, policy: { schemaVersion: 1, approved: {} }, missing: true };
  }
  try {
    const raw = fs.readFileSync(trustPolicyPath, 'utf8');
    const parsed = parseSafeJson(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'ERR_TRUST_POLICY_CORRUPTED', policy: { schemaVersion: 1, approved: {} } };
    }
    const approved = parsed.approved && typeof parsed.approved === 'object' && !Array.isArray(parsed.approved) ? parsed.approved : {};
    return { ok: true, policy: { schemaVersion: 1, approved }, missing: false };
  } catch (err) {
    return {
      ok: false,
      reason: 'ERR_TRUST_POLICY_READ_FAILED',
      error: err && err.message ? err.message : String(err),
      policy: { schemaVersion: 1, approved: {} },
    };
  }
}

/**
 * Single-pass realpath-confined snapshot of plugin JS/CJS/JSON tree for mainHook bundle hashing.
 * Tracks `visitedDirs` to prevent symlink/junction directory cycle DoS (D-05 / SEC-07).
 */
function snapshotPluginBundleInMemory(pluginRootDir) {
  const realRoot = fs.realpathSync(pluginRootDir);
  const files = new Map(); // posixRel -> { buf, sha256, realPath }
  const visitedDirs = new Set([realRoot]);
  let totalBytes = 0;

  function walk(dirPath) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      const full = path.join(dirPath, ent.name);
      const realFull = fs.realpathSync(full);
      const relFromRoot = path.relative(realRoot, realFull);
      if (!relFromRoot || relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
        throw new Error(`ERR_BUNDLE_SYMLINK_ESCAPE:${ent.name}`);
      }
      const st = fs.statSync(realFull);
      if (st.isDirectory()) {
        if (visitedDirs.has(realFull)) {
          throw new Error(`ERR_BUNDLE_SYMLINK_CYCLE:${ent.name}`);
        }
        if (visitedDirs.size >= MAX_BUNDLE_DIRS) {
          throw new Error('ERR_BUNDLE_DIR_LIMIT_EXCEEDED');
        }
        visitedDirs.add(realFull);
        walk(realFull);
      } else if (st.isFile()) {
        const ext = path.extname(realFull).toLowerCase();
        if (!ALLOWED_BUNDLE_EXTS.has(ext)) continue;
        if (files.size >= MAX_BUNDLE_FILES) {
          throw new Error('ERR_BUNDLE_FILE_LIMIT_EXCEEDED');
        }
        // S-3: Enforce byte budget via stat BEFORE allocating memory with readFileSync
        if (st.size > MAX_BUNDLE_TOTAL_BYTES || totalBytes + st.size > MAX_BUNDLE_TOTAL_BYTES) {
          throw new Error('ERR_BUNDLE_SIZE_LIMIT_EXCEEDED');
        }
        const buf = fs.readFileSync(realFull);
        totalBytes += buf.length;
        if (totalBytes > MAX_BUNDLE_TOTAL_BYTES) {
          throw new Error('ERR_BUNDLE_SIZE_LIMIT_EXCEEDED');
        }
        const posixKey = toPosixPath(relFromRoot);
        files.set(posixKey, { buf, sha256: sha256Hex(buf), realPath: realFull });
      }
    }
  }

  walk(realRoot);

  const sortedKeys = Array.from(files.keys()).sort();
  const hasher = crypto.createHash('sha256');
  for (const k of sortedKeys) {
    hasher.update(k, 'utf8');
    hasher.update('\0', 'utf8');
    hasher.update(files.get(k).sha256, 'utf8');
    hasher.update('\n', 'utf8');
  }
  const bundleSha256 = hasher.digest('hex');

  return { realRoot, files, bundleSha256 };
}

function resolveInMemorySpec(fromPosixKey, spec, filesMap) {
  if (typeof spec !== 'string' || !spec) {
    throw new Error('ERR_INVALID_REQUIRE_SPEC');
  }
  if (spec.includes('\0') || /^file:/i.test(spec) || path.isAbsolute(spec) || /^[A-Za-z]:/.test(spec)) {
    throw new Error(`ERR_FORBIDDEN_REQUIRE_PATH:${spec}`);
  }
  if (spec.endsWith('.mjs')) {
    throw new Error(`ERR_FORBIDDEN_ESM_REQUIRE:${spec}`);
  }
  if (!spec.startsWith('./') && !spec.startsWith('../')) {
    throw new Error(`ERR_FORBIDDEN_EXTERNAL_REQUIRE:${spec}`);
  }

  const fromDir = path.posix.dirname(fromPosixKey);
  const joined = path.posix.normalize(path.posix.join(fromDir === '.' ? '' : fromDir, spec));
  if (!joined || joined === '..' || joined.startsWith('../') || joined.startsWith('/')) {
    throw new Error(`ERR_REQUIRE_ESCAPES_PLUGIN_ROOT:${spec}`);
  }

  const candidates = [joined, `${joined}.js`, `${joined}.cjs`, `${joined}.json`, `${joined}/index.js`, `${joined}/index.cjs`];
  for (const cand of candidates) {
    if (filesMap.has(cand)) return cand;
  }
  throw new Error(`ERR_BUNDLE_MODULE_NOT_FOUND:${spec}`);
}

/**
 * Executes a verified in-memory plugin bundle strictly from `snapshot.files`.
 */
function executeInMemoryMainHookBundle(snapshot, entryRelPosix) {
  if (!snapshot.files.has(entryRelPosix)) {
    throw new Error(`ERR_MAIN_HOOK_ENTRY_MISSING_IN_SNAPSHOT:${entryRelPosix}`);
  }
  const moduleCache = new Map();

  function loadKey(posixKey) {
    if (moduleCache.has(posixKey)) {
      return moduleCache.get(posixKey).exports;
    }
    const rec = snapshot.files.get(posixKey);
    if (!rec) {
      throw new Error(`ERR_BUNDLE_MODULE_NOT_FOUND:${posixKey}`);
    }
    const mod = { exports: {}, id: posixKey, filename: rec.realPath, loaded: false };
    // Pre-register before execution for circular CJS require compatibility
    moduleCache.set(posixKey, mod);

    if (posixKey.endsWith('.json')) {
      mod.exports = parseSafeJson(rec.buf.toString('utf8'));
      mod.loaded = true;
      return mod.exports;
    }

    const localRequire = (spec) => {
      if (Object.prototype.hasOwnProperty.call(SAFE_MAIN_HOOK_BUILTINS, spec)) {
        return SAFE_MAIN_HOOK_BUILTINS[spec];
      }
      const targetKey = resolveInMemorySpec(posixKey, spec, snapshot.files);
      return loadKey(targetKey);
    };

    const source = rec.buf.toString('utf8').replace(/^#![^\r\n]*/, '');
    // Trust boundary (SEC-01): executes explicitly SHA-256-approved trusted Node code in Main
    // strictly from the verified in-memory bundle (eliminating post-hash TOCTOU & casual external requires,
    // shadowing `process` as defense-in-depth; full OS process isolation belongs to SidecarBridge in v2.1.0).
    const wrapper = `(function(exports, require, module, __filename, __dirname, process) {\n${source}\n})`;
    const fn = vm.runInThisContext(wrapper, {
      filename: `addon-main-hook://${posixKey}`,
      displayErrors: true,
    });
    const dirname = path.dirname(rec.realPath);
    fn.call(mod.exports, mod.exports, localRequire, mod, rec.realPath, dirname, undefined);
    mod.loaded = true;
    return mod.exports;
  }

  return loadKey(entryRelPosix);
}

function readVerifiedRendererScript(scriptPath, manifest, policy, { strictTrustPolicy = true } = {}) {
  let buf;
  try {
    buf = fs.readFileSync(scriptPath);
  } catch (err) {
    return { ok: false, reason: 'ERR_RENDERER_SCRIPT_READ_FAILED', error: err && err.message ? err.message : String(err) };
  }
  const rendererSha256 = sha256Hex(buf);
  // If manifest itself declares integrity.rendererSha256, verify consistency too
  if (manifest.integrity && manifest.integrity.rendererSha256 && manifest.integrity.rendererSha256 !== rendererSha256) {
    return {
      ok: false,
      reason: 'ERR_MANIFEST_INTEGRITY_MISMATCH',
      expectedSha256: manifest.integrity.rendererSha256,
      actualSha256: rendererSha256,
    };
  }

  const decision = evaluateTrustDecision(manifest, { rendererSha256 }, policy, {
    strictTrustPolicy,
    checkTarget: 'renderer',
  });
  if (!decision.ok) {
    return {
      ok: false,
      reason: decision.reason,
      sha256: rendererSha256,
      decision,
    };
  }
  return {
    ok: true,
    source: buf.toString('utf8'),
    sha256: rendererSha256,
    effectiveTrustLevel: decision.effectiveTrustLevel,
    pinned: decision.pinned,
  };
}

function loadVerifiedMainHookModule(entryPath, pluginRootDir, manifest, policy, { strictTrustPolicy = true } = {}) {
  // S-3: Fail-fast default-deny BEFORE walking/reading disk for unapproved mainHook plugins
  if (strictTrustPolicy) {
    const approvedMap =
      policy && policy.approved && typeof policy.approved === 'object' && !Array.isArray(policy.approved)
        ? policy.approved
        : null;
    const pluginId = manifest && manifest.pluginId;
    const record =
      approvedMap && pluginId && Object.prototype.hasOwnProperty.call(approvedMap, pluginId)
        ? approvedMap[pluginId]
        : null;
    if (!record || typeof record !== 'object') {
      return {
        ok: false,
        reason: 'ERR_TRUST_POLICY_NOT_APPROVED',
        decision: { ok: false, reason: 'ERR_TRUST_POLICY_NOT_APPROVED', effectiveTrustLevel: 'restricted' },
      };
    }
    if (!record.mainHookBundleSha256 || !SHA256_HEX_RE.test(record.mainHookBundleSha256)) {
      return {
        ok: false,
        reason: 'ERR_TRUST_POLICY_MISSING_MAIN_HOOK_PIN',
        decision: { ok: false, reason: 'ERR_TRUST_POLICY_MISSING_MAIN_HOOK_PIN', effectiveTrustLevel: 'restricted' },
      };
    }
  }

  let snapshot;
  try {
    snapshot = snapshotPluginBundleInMemory(pluginRootDir);
  } catch (err) {
    return { ok: false, reason: err && err.message ? err.message : 'ERR_BUNDLE_SNAPSHOT_FAILED' };
  }

  let realEntry;
  try {
    realEntry = fs.realpathSync(entryPath);
  } catch (err) {
    return {
      ok: false,
      reason: 'ERR_MAIN_HOOK_ENTRY_MISSING',
      error: err && err.message ? err.message : String(err),
    };
  }
  const relEntry = path.relative(snapshot.realRoot, realEntry);
  if (!relEntry || relEntry.startsWith('..') || path.isAbsolute(relEntry)) {
    return { ok: false, reason: 'ERR_MAIN_HOOK_ESCAPES_PLUGIN_ROOT' };
  }
  const entryPosix = toPosixPath(relEntry);

  if (manifest.integrity && manifest.integrity.mainHookBundleSha256 && manifest.integrity.mainHookBundleSha256 !== snapshot.bundleSha256) {
    return {
      ok: false,
      reason: 'ERR_MANIFEST_BUNDLE_INTEGRITY_MISMATCH',
      expectedSha256: manifest.integrity.mainHookBundleSha256,
      actualSha256: snapshot.bundleSha256,
    };
  }

  const decision = evaluateTrustDecision(
    manifest,
    { mainHookBundleSha256: snapshot.bundleSha256 },
    policy,
    { strictTrustPolicy, checkTarget: 'mainHook' }
  );
  if (!decision.ok) {
    return {
      ok: false,
      reason: decision.reason,
      bundleSha256: snapshot.bundleSha256,
      decision,
    };
  }

  try {
    const exportsObj = executeInMemoryMainHookBundle(snapshot, entryPosix);
    return {
      ok: true,
      exports: exportsObj,
      bundleSha256: snapshot.bundleSha256,
      effectiveTrustLevel: decision.effectiveTrustLevel,
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'ERR_MAIN_HOOK_COMPILE_OR_EXEC_FAILED',
      error: err && err.message ? err.message : String(err),
      bundleSha256: snapshot.bundleSha256,
    };
  }
}

module.exports = {
  SAFE_MAIN_HOOK_BUILTINS,
  sha256Hex,
  loadTrustPolicyFile,
  snapshotPluginBundleInMemory,
  executeInMemoryMainHookBundle,
  readVerifiedRendererScript,
  loadVerifiedMainHookModule,
};
