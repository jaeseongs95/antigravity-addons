'use strict';

/**
 * Deterministic Zero-Dependency Runtime Builder & AST Verifier (F4 / D-R4-5).
 *
 * Uses ONLY existing dependencies (`ajv`, `acorn`, Node built-ins — ZERO new npm deps):
 * 1. Compiles `addon-manifest.v1.schema.json` and `addon-manifest.v2.schema.json` using
 *    separate `new Ajv(...)` instances into `src/core/generated/validate-v{1,2}.cjs`.
 * 2. Localizes `fast-deep-equal/index.js` wrapped as `exports.default = equal;` into
 *    `src/core/generated/runtime/equal.cjs` and `ajv/dist/runtime/ucs2length.js` into
 *    `src/core/generated/runtime/ucs2length.cjs`.
 * 3. Packages complete 0-dep `dist/runtime/` (core, generated validators, schemas,
 *    node-fs-port, config-reader, shared/main runtime, single self-contained
 *    `preload/preload-bridge.cjs`, and single self-contained World 998
 *    `renderer/kernel-bundle.cjs`) with LF line endings and deterministic `build-manifest.json`.
 * 4. Runs full `acorn` AST 0-dep verification across ALL `.js`/`.cjs` files in `dist/runtime/`
 *    and `src/core/generated/` (blocking external `node_modules`, absolute paths, dynamic
 *    `require(expr)`, `import()`, `createRequire`, `process.dlopen`; enforcing ONLY
 *    `require('electron')` inside `preload-bridge.cjs`).
 * 5. `--check` mode rebuilds into `os.tmpdir()` and verifies byte-exact equality against
 *    committed `src/core/generated/` and `dist/runtime/`.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const moduleBuiltin = require('node:module');
const Ajv = require('ajv');
const standaloneCode = require('ajv/dist/standalone').default;
const acorn = require('acorn');

const REPO_ROOT = path.resolve(__dirname, '..');
const GENERATED_DIR = path.join(REPO_ROOT, 'src', 'core', 'generated');
const DIST_RUNTIME_DIR = path.join(REPO_ROOT, 'dist', 'runtime');

const NODE_BUILTINS = new Set(
  moduleBuiltin.builtinModules.flatMap((m) => [m, m.replace(/^node:/, '')])
);

function toLf(text) {
  return String(text || '').replace(/\r\n/g, '\n');
}

function sha256Hex(bufOrStr) {
  return crypto.createHash('sha256').update(bufOrStr).digest('hex');
}

function writeFileLf(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, toLf(content), 'utf8');
}

function buildGeneratedValidators(targetGenDir) {
  const runtimeDir = path.join(targetGenDir, 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });

  // Wrap fast-deep-equal (46-line 0-dep module) with exports.default = equal
  const fdeSrc = toLf(fs.readFileSync(require.resolve('fast-deep-equal'), 'utf8'));
  const equalWrapped = `'use strict';\n// Localized 0-dep fast-deep-equal wrapper for ajv standalone runtime\nconst _m = { exports: {} };\n(function(module, exports) {\n${fdeSrc}\n})(_m, _m.exports);\nexports.default = _m.exports;\n`;
  writeFileLf(path.join(runtimeDir, 'equal.cjs'), equalWrapped);

  // Localize ucs2length (0-dep helper)
  const ucsSrc = toLf(fs.readFileSync(require.resolve('ajv/dist/runtime/ucs2length'), 'utf8'));
  writeFileLf(path.join(runtimeDir, 'ucs2length.cjs'), ucsSrc);

  const schemas = [
    { version: 1, file: path.join(REPO_ROOT, 'schemas', 'addon-manifest.v1.schema.json'), out: 'validate-v1.cjs' },
    { version: 2, file: path.join(REPO_ROOT, 'schemas', 'addon-manifest.v2.schema.json'), out: 'validate-v2.cjs' },
    { version: 3, file: path.join(REPO_ROOT, 'schemas', 'addon-manifest.v3.schema.json'), out: 'validate-v3.cjs' },
  ];

  for (const spec of schemas) {
    const schema = JSON.parse(fs.readFileSync(spec.file, 'utf8'));
    // Separate Ajv instance per schema for deterministic output
    const ajv = new Ajv({ allErrors: true, strict: true, code: { source: true } });
    const validate = ajv.compile(schema);
    let code = standaloneCode(ajv, validate);
    code = code
      .replace(/require\(["']ajv\/dist\/runtime\/equal["']\)/g, 'require("./runtime/equal.cjs")')
      .replace(/require\(["']ajv\/dist\/runtime\/ucs2length["']\)/g, 'require("./runtime/ucs2length.cjs")');
    writeFileLf(path.join(targetGenDir, spec.out), code);
  }
}

/**
 * Bundles modular `src/runtime/renderer/*.js` into a single browser-executable World 998
 * IIFE bundle (`kernel-bundle.cjs`) with zero external dependencies and zero runtime Node require.
 */
function buildRendererKernelBundleSource({ includeHostSettingsUi = true } = {}) {
  const rendererDir = path.join(REPO_ROOT, 'src', 'runtime', 'renderer');
  const coreDir = path.join(REPO_ROOT, 'src', 'core');
  const modules = [
    { id: '../../core/ui-schema-validator.js', abs: path.join(coreDir, 'ui-schema-validator.js') },
    { id: '../../core/service-bus-policy.js', abs: path.join(coreDir, 'service-bus-policy.js') },
    { id: '../../core/net-policy.js', abs: path.join(coreDir, 'net-policy.js') },
    { id: '../../core/secrets-policy.js', abs: path.join(coreDir, 'secrets-policy.js') },
    { id: './ignore-guard.js', abs: path.join(rendererDir, 'ignore-guard.js') },
    { id: './style-manager.js', abs: path.join(rendererDir, 'style-manager.js') },
    { id: './slot-manager.js', abs: path.join(rendererDir, 'slot-manager.js') },
    { id: './surface-geometry.js', abs: path.join(rendererDir, 'surface-geometry.js') },
    { id: './placement-engine.js', abs: path.join(rendererDir, 'placement-engine.js') },
    { id: './modal-portal.js', abs: path.join(rendererDir, 'modal-portal.js') },
    { id: './region-observer.js', abs: path.join(rendererDir, 'region-observer.js') },
    { id: './settings-tab-coordinator.js', abs: path.join(rendererDir, 'settings-tab-coordinator.js') },
    { id: './theme-i18n.js', abs: path.join(rendererDir, 'theme-i18n.js') },
    { id: './ui-schema-renderer.js', abs: path.join(rendererDir, 'ui-schema-renderer.js') },
    { id: './toast-manager.js', abs: path.join(rendererDir, 'toast-manager.js') },
    { id: './service-bus.js', abs: path.join(rendererDir, 'service-bus.js') },
    { id: './event-bus.js', abs: path.join(rendererDir, 'event-bus.js') },
    { id: './storage-v3.js', abs: path.join(rendererDir, 'storage-v3.js') },
    { id: './status-item-registry.js', abs: path.join(rendererDir, 'status-item-registry.js') },
    { id: './section-action-registry.js', abs: path.join(rendererDir, 'section-action-registry.js') },
    { id: './settings-page-coordinator.js', abs: path.join(rendererDir, 'settings-page-coordinator.js') },
    { id: './context-v3.js', abs: path.join(rendererDir, 'context-v3.js') },
    { id: './v2-compat-adapter.js', abs: path.join(rendererDir, 'v2-compat-adapter.js') },
    { id: './host-bridge-port.js', abs: path.join(rendererDir, 'host-bridge-port.js') },
    { id: './host-settings-ui.js', abs: path.join(rendererDir, 'host-settings-ui.js') },
    { id: './kernel.js', abs: path.join(rendererDir, 'kernel.js') },
  ];

  const entries = modules.map((mod) => {
    if (mod.id === './host-settings-ui.js' && includeHostSettingsUi === false) {
      return `  ${JSON.stringify(mod.id)}: function(module, exports) {\n    exports.createHostSettingsUi = null;\n  }`;
    }
    const src = toLf(fs.readFileSync(mod.abs, 'utf8'));
    return `  ${JSON.stringify(mod.id)}: function(module, exports, require) {\n${src}\n  }`;
  });

  return `'use strict';
// Auto-generated World 998 Renderer Kernel Bundle (zero external dependencies).
(function() {
  const __mods = {
${entries.join(',\n')}
  };
  const __cache = Object.create(null);
  function __req(id) {
    const key = id.endsWith('.js') ? id : id + '.js';
    if (__cache[key]) return __cache[key].exports;
    const fn = __mods[key];
    if (!fn) throw new Error('ERR_KERNEL_BUNDLE_MISSING_MOD:' + key);
    const mod = { exports: {} };
    __cache[key] = mod;
    fn(mod, mod.exports, __req);
    return mod.exports;
  }
  const kernelMod = __req('./kernel.js');
  if (typeof globalThis !== 'undefined' && typeof globalThis.document !== 'undefined') {
    if (!globalThis.__addonHostKernel) {
      Object.defineProperty(globalThis, '__addonHostKernel', {
        value: kernelMod.createRendererKernel(globalThis.document, globalThis.window || globalThis),
        writable: false,
        configurable: false,
        enumerable: false,
      });
    }
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = kernelMod;
  }
})();
`;
}

function copyTreeFiltered(srcDir, dstDir, filterFn = () => true) {
  if (!fs.existsSync(srcDir)) return;
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const s = path.join(srcDir, ent.name);
    const d = path.join(dstDir, ent.name);
    if (ent.isDirectory()) {
      copyTreeFiltered(s, d, filterFn);
    } else if (ent.isFile() && filterFn(s, ent.name)) {
      writeFileLf(d, fs.readFileSync(s, 'utf8'));
    }
  }
}

function buildDistRuntime(targetDistDir, sourceGenDir) {
  fs.rmSync(targetDistDir, { recursive: true, force: true });
  fs.mkdirSync(targetDistDir, { recursive: true });

  // 1. Copy schemas (needed by manifest-validator.js relative require '../../schemas/...')
  for (const name of ['addon-manifest.v1.schema.json', 'addon-manifest.v2.schema.json', 'addon-manifest.v3.schema.json']) {
    writeFileLf(
      path.join(targetDistDir, 'schemas', name),
      fs.readFileSync(path.join(REPO_ROOT, 'schemas', name), 'utf8')
    );
  }

  // 2. Copy pure src/core/*.js + generated standalone validators
  copyTreeFiltered(path.join(REPO_ROOT, 'src', 'core'), path.join(targetDistDir, 'src', 'core'), (_p, name) =>
    name.endsWith('.js')
  );
  copyTreeFiltered(sourceGenDir, path.join(targetDistDir, 'src', 'core', 'generated'));

  // 3. Copy runtime-shared adapters (`node-fs-port.js`, `config-reader.js`)
  writeFileLf(
    path.join(targetDistDir, 'src', 'adapters', 'node-fs-port.js'),
    fs.readFileSync(path.join(REPO_ROOT, 'src', 'adapters', 'node-fs-port.js'), 'utf8')
  );
  writeFileLf(
    path.join(targetDistDir, 'src', 'adapters', 'electron', 'config-reader.js'),
    fs.readFileSync(path.join(REPO_ROOT, 'src', 'adapters', 'electron', 'config-reader.js'), 'utf8')
  );

  // 4. Copy src/runtime/{shared,main}
  copyTreeFiltered(path.join(REPO_ROOT, 'src', 'runtime', 'shared'), path.join(targetDistDir, 'src', 'runtime', 'shared'));
  copyTreeFiltered(path.join(REPO_ROOT, 'src', 'runtime', 'main'), path.join(targetDistDir, 'src', 'runtime', 'main'));

  // 5. Emit single self-contained sandboxed preload (`dist/runtime/preload/preload-bridge.cjs`)
  const preloadSrc = toLf(
    fs.readFileSync(path.join(REPO_ROOT, 'src', 'runtime', 'preload', 'preload-bridge.js'), 'utf8')
  );
  writeFileLf(path.join(targetDistDir, 'preload', 'preload-bridge.cjs'), preloadSrc);

  // 6. Emit single self-contained World 998 renderer kernel (`dist/runtime/renderer/kernel-bundle.cjs`)
  const kernelBundleSrc = buildRendererKernelBundleSource();
  writeFileLf(path.join(targetDistDir, 'renderer', 'kernel-bundle.cjs'), kernelBundleSrc);

  // 7. Emit canonical main entry facade (`dist/runtime/main/init-main.js`)
  writeFileLf(
    path.join(targetDistDir, 'main', 'init-main.js'),
    `'use strict';\nmodule.exports = require('../src/runtime/main/init-main.js');\n`
  );

  // 8. Compute deterministic file inventory + buildSha8 manifest
  const fileHashes = {};
  function hashWalk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        hashWalk(full);
      } else if (ent.isFile()) {
        const rel = path.relative(targetDistDir, full).replace(/\\/g, '/');
        if (rel === 'build-manifest.json') continue;
        fileHashes[rel] = sha256Hex(fs.readFileSync(full));
      }
    }
  }
  hashWalk(targetDistDir);

  const sortedKeys = Object.keys(fileHashes).sort();
  const rootHasher = crypto.createHash('sha256');
  for (const k of sortedKeys) {
    rootHasher.update(k + '\0' + fileHashes[k] + '\n', 'utf8');
  }
  const buildSha256 = rootHasher.digest('hex');
  const buildSha8 = buildSha256.slice(0, 8);

  const buildManifest = {
    schemaVersion: 1,
    buildSha8,
    buildSha256,
    fileCount: sortedKeys.length,
    files: fileHashes,
  };
  writeFileLf(path.join(targetDistDir, 'build-manifest.json'), JSON.stringify(buildManifest, null, 2) + '\n');
  return buildManifest;
}

function scanAstZeroDepFile(filePath, { preloadStrict = false } = {}) {
  const src = fs.readFileSync(filePath, 'utf8');
  const ast = acorn.parse(src, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    allowReturnOutsideFunction: true,
  });
  const violations = [];

  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ImportExpression') {
      violations.push('FORBIDDEN_DYNAMIC_IMPORT');
    }
    if (node.type === 'MemberExpression' && !node.computed && node.property) {
      if (node.property.name === 'createRequire' || node.property.name === 'dlopen') {
        violations.push(`FORBIDDEN_MEMBER:${node.property.name}`);
      }
    }
    if (
      node.type === 'CallExpression' &&
      node.callee &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'require'
    ) {
      const arg = node.arguments[0];
      if (!arg || arg.type !== 'Literal' || typeof arg.value !== 'string') {
        violations.push('FORBIDDEN_DYNAMIC_REQUIRE');
      } else {
        const spec = arg.value;
        if (preloadStrict) {
          if (spec !== 'electron') {
            violations.push(`FORBIDDEN_PRELOAD_REQUIRE:${spec}`);
          }
        } else {
          const isRel = spec.startsWith('./') || spec.startsWith('../');
          const isNode = spec.startsWith('node:') || NODE_BUILTINS.has(spec);
          if (!isRel && !isNode && spec !== 'electron') {
            violations.push(`FORBIDDEN_EXTERNAL_REQUIRE:${spec}`);
          }
        }
      }
    }
    for (const key of Object.keys(node)) {
      const val = node[key];
      if (Array.isArray(val)) val.forEach(walk);
      else if (val && typeof val.type === 'string') walk(val);
    }
  }

  walk(ast);
  return violations;
}

function verifyZeroDepTree(rootDir) {
  const errors = [];
  let checkedCount = 0;

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile() && (ent.name.endsWith('.js') || ent.name.endsWith('.cjs'))) {
        checkedCount++;
        const rel = path.relative(rootDir, full).replace(/\\/g, '/');
        const preloadStrict = rel === 'preload/preload-bridge.cjs';
        const viols = scanAstZeroDepFile(full, { preloadStrict });
        if (viols.length > 0) {
          errors.push({ file: rel, violations: viols });
        }
      }
    }
  }

  walk(rootDir);
  return { ok: errors.length === 0, checkedCount, errors };
}

function snapshotDirHashes(rootDir) {
  const out = {};
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) {
        const rel = path.relative(rootDir, full).replace(/\\/g, '/');
        out[rel] = sha256Hex(fs.readFileSync(full));
      }
    }
  }
  walk(rootDir);
  return out;
}

function compareTrees(label, expectedDir, actualDir) {
  const exp = snapshotDirHashes(expectedDir);
  const act = snapshotDirHashes(actualDir);
  const expKeys = Object.keys(exp).sort();
  const actKeys = Object.keys(act).sort();
  const diffs = [];
  for (const k of expKeys) {
    if (!Object.prototype.hasOwnProperty.call(act, k)) diffs.push(`${label}: MISSING ${k}`);
    else if (act[k] !== exp[k]) diffs.push(`${label}: DRIFT ${k}`);
  }
  for (const k of actKeys) {
    if (!Object.prototype.hasOwnProperty.call(exp, k)) diffs.push(`${label}: EXTRA ${k}`);
  }
  return diffs;
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-build-runtime-'));
  const tmpGenDir = path.join(tmpDir, 'generated');
  const tmpDistDir = path.join(tmpDir, 'dist-runtime');

  try {
    buildGeneratedValidators(tmpGenDir);
    const manifest = buildDistRuntime(tmpDistDir, tmpGenDir);

    const genAst = verifyZeroDepTree(tmpGenDir);
    if (!genAst.ok) {
      throw new Error(`AST 0-dep failure in generated validators: ${JSON.stringify(genAst.errors)}`);
    }
    const distAst = verifyZeroDepTree(tmpDistDir);
    if (!distAst.ok) {
      throw new Error(`AST 0-dep failure in dist/runtime: ${JSON.stringify(distAst.errors)}`);
    }

    if (checkOnly) {
      const genDiffs = compareTrees('src/core/generated', tmpGenDir, GENERATED_DIR);
      const distDiffs = compareTrees('dist/runtime', tmpDistDir, DIST_RUNTIME_DIR);
      const allDiffs = [...genDiffs, ...distDiffs];
      if (allDiffs.length > 0) {
        process.stderr.write(`BUILD_RUNTIME_DRIFT_DETECTED:\n${allDiffs.join('\n')}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(
        JSON.stringify({
          ok: true,
          mode: 'check',
          buildSha8: manifest.buildSha8,
          checkedFiles: distAst.checkedCount,
          astViolations: 0,
        }) + '\n'
      );
      return;
    }

    // Commit rebuilt outputs cleanly
    fs.rmSync(GENERATED_DIR, { recursive: true, force: true });
    copyTreeFiltered(tmpGenDir, GENERATED_DIR);
    fs.rmSync(DIST_RUNTIME_DIR, { recursive: true, force: true });
    copyTreeFiltered(tmpDistDir, DIST_RUNTIME_DIR);

    process.stdout.write(
      JSON.stringify({
        ok: true,
        mode: 'build',
        buildSha8: manifest.buildSha8,
        fileCount: manifest.fileCount,
        checkedFiles: distAst.checkedCount,
        astViolations: 0,
      }) + '\n'
    );
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_e) {}
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildGeneratedValidators,
  buildRendererKernelBundleSource,
  buildDistRuntime,
  scanAstZeroDepFile,
  verifyZeroDepTree,
};
