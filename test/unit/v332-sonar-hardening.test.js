'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { validateSafeCssText } = require('../../src/runtime/renderer/style-manager');
const { createSectionActionRegistry } = require('../../src/runtime/renderer/section-action-registry');
const { createThemeAndI18n } = require('../../src/runtime/renderer/theme-i18n');
const { normalizePublicUrl, encodePairingCode } = require('../../src/runtime/main/remote-bridge-server');
const { normalizeBridgeBaseUrl } = require('../../src/adapters/remote-web/remote-host-transport');
const { createManifestValidator, resolveConfinedScriptPath } = require('../../src/core/manifest-validator');
const { snapshotPluginBundleInMemory, executeInMemoryMainHookBundle } = require('../../src/runtime/main/trust-verifier');
const { createHostRuntimeController } = require('../../src/runtime/main/init-main');
const { ANTIGRAVITY_HOST_PROFILE } = require('../../src/profiles/antigravity');
const { transformExactSize } = require('../../src/adapters/electron/asar-patcher');
const { normalizeUpdateBaseUrl, normalizeHostLibUrl, buildBookmarkletText } = require('../../scripts/build-remote');
const { createTestHost } = require('../../packages/sdk/src/index');

const KERNEL_BUNDLE_PATH = path.resolve(__dirname, '..', '..', 'dist', 'runtime', 'renderer', 'kernel-bundle.cjs');
const PRELOAD_BRIDGE_PATH = path.resolve(__dirname, '..', '..', 'dist', 'runtime', 'preload', 'preload-bridge.cjs');

test('TC-V332-SONAR-01: style-manager linear regexes, NUL replacement, hex parseInt, and unquoted url() lexer branches', () => {
  // NUL char preprocessing + valid owner CSS
  assert.equal(validateSafeCssText('.ok { content: "a\0b"; }', { scope: 'owner' }).ok, true);

  // Unquoted url(...) lexer branches: comment, quoted string with escape, outside backslash, quoted url, valid/invalid unquoted url
  assert.equal(
    validateSafeCssText(
      '/* block comment */ .a\\-b { content: "hi \\"quote\\""; background: url("https://example.com/a.png"); }',
      { scope: 'owner' }
    ).ok,
    true
  );
  assert.equal(
    validateSafeCssText('.a { background: url(https://example.com/a.png   ); }', { scope: 'owner' }).ok,
    true
  );
  assert.equal(
    validateSafeCssText('.a { background: url(foo bar); }', { scope: 'owner' }).ok,
    false
  );
  assert.equal(
    validateSafeCssText('.a { background: url(unclosed', { scope: 'owner' }).ok,
    false
  );
  assert.equal(
    validateSafeCssText('.a { background: url(foo/*bar*/); }', { scope: 'owner' }).ok,
    false
  );
  assert.equal(
    validateSafeCssText('.a { background: url(   ', { scope: 'owner' }).ok,
    false
  );
  assert.equal(
    validateSafeCssText('.a { content: "\\61\\62"; }', { scope: 'owner' }).ok,
    true
  );

  // Backtracking-free @-escape and & sibling checks
  assert.equal(
    validateSafeCssText(`${'@'.repeat(500)}x { color: red; }`, { scope: 'owner' }).ok,
    false
  );
  assert.equal(
    validateSafeCssText('@\\media screen { .x { color: red; } }', { scope: 'owner' }).reason,
    'ERR_FORBIDDEN_CSS_AT_RULE'
  );
  assert.equal(
    validateSafeCssText('.x { & + .y { color: red; } }', { scope: 'owner' }).reason,
    'ERR_FORBIDDEN_CSS_NESTING'
  );
  assert.equal(
    validateSafeCssText(`.x { ${'&'.repeat(300)} .y { color: red; } }`, { scope: 'owner' }).reason,
    'ERR_FORBIDDEN_CSS_NESTING'
  );
});

test('TC-V332-SONAR-02: section-action-registry linear stripCountSuffix covers all branches without backtracking', () => {
  function makeMockNode(tag, text = '') {
    const attrs = Object.create(null);
    const node = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      textContent: text,
      children: [],
      childNodes: [],
      parentElement: null,
      parentNode: null,
      style: {},
      setAttribute(k, v) {
        attrs[k] = String(v);
      },
      getAttribute(k) {
        return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null;
      },
      removeAttribute(k) {
        delete attrs[k];
      },
      appendChild(ch) {
        ch.parentElement = this;
        ch.parentNode = this;
        this.children.push(ch);
        this.childNodes.push(ch);
        return ch;
      },
      insertBefore(ch, ref) {
        ch.parentElement = this;
        ch.parentNode = this;
        const idx = this.children.indexOf(ref);
        if (idx === -1) {
          this.children.push(ch);
          this.childNodes.push(ch);
        } else {
          this.children.splice(idx, 0, ch);
          this.childNodes.splice(idx, 0, ch);
        }
        return ch;
      },
      removeChild(ch) {
        this.children = this.children.filter((c) => c !== ch);
        this.childNodes = this.childNodes.filter((c) => c !== ch);
        ch.parentElement = null;
        ch.parentNode = null;
      },
      addEventListener() {},
      removeEventListener() {},
      querySelector(sel) {
        if (sel === 'button, a, [role="button"]') {
          return this.children.find((c) => c.tagName === 'BUTTON') || null;
        }
        return null;
      },
      querySelectorAll(sel) {
        const res = [];
        const walk = (n) => {
          for (const ch of n.children) {
            if (sel.includes('h2') && ch.tagName === 'H2') res.push(ch);
            walk(ch);
          }
        };
        walk(this);
        return res;
      },
    };
    return node;
  }

  for (const labelText of ['MCP Servers (12)', 'MCP Servers ( 3 )', 'MCP Servers 42', 'MCP Servers']) {
    const body = makeMockNode('body');
    const row = makeMockNode('div');
    const heading = makeMockNode('h2', labelText);
    const actionsBox = makeMockNode('div');
    actionsBox.appendChild(makeMockNode('button', 'Refresh'));
    row.appendChild(heading);
    row.appendChild(actionsBox);
    body.appendChild(row);

    const doc = {
      body,
      head: makeMockNode('head'),
      documentElement: body,
      createElement: (tag) => makeMockNode(tag),
      querySelectorAll: (sel) => body.querySelectorAll(sel),
    };
    const reg = createSectionActionRegistry(doc, {}, {
      uiSectionTargets: {
        'mcp-servers': {
          headingTexts: ['MCP Servers'],
          labelSelectors: ['h2'],
          allowCountSuffix: true,
        },
      },
    });
    const h = reg.registerSectionAction('p1', { target: 'mcp-servers', id: 'btn', label: 'Manage', onClick() {} });
    reg.syncDomNow();
    assert.equal(actionsBox.children.length, 2, `Should mount on heading "${labelText}"`);
    h.dispose();
    reg.dispose();
  }

  // Non-numeric / mismatched parenthetical / plain unrelated heading must NOT match
  for (const nonMatching of ['MCP Servers (beta)', 'MCP Servers 12)', 'Other Section', '   ']) {
    const body2 = makeMockNode('body');
    const row2 = makeMockNode('div');
    row2.appendChild(makeMockNode('h2', nonMatching));
    const actions2 = makeMockNode('div');
    actions2.appendChild(makeMockNode('button', 'Refresh'));
    row2.appendChild(actions2);
    body2.appendChild(row2);
    const doc2 = {
      body: body2,
      head: makeMockNode('head'),
      documentElement: body2,
      createElement: (tag) => makeMockNode(tag),
      querySelectorAll: (sel) => body2.querySelectorAll(sel),
    };
    const reg2 = createSectionActionRegistry(doc2, {}, {
      uiSectionTargets: {
        'mcp-servers': { headingTexts: ['MCP Servers'], labelSelectors: ['h2'], allowCountSuffix: true },
      },
    });
    reg2.registerSectionAction('p1', { target: 'mcp-servers', id: 'btn', label: 'Manage', onClick() {} });
    reg2.syncDomNow();
    assert.equal(actions2.children.length, 1, `Should not match "${nonMatching}"`);
    reg2.dispose();
  }
});

test('TC-V332-SONAR-03: linear trailing-slash/separator strippers, RGB regex, comment stripper, bookmarklet, and vm.compileFunction', () => {
  // Trailing slashes (no backtracking) across remote-bridge-server, remote-host-transport, build-remote
  const pub = normalizePublicUrl('https://bridge.example.com///');
  assert.equal(pub.ok, true);
  assert.equal(pub.value, 'https://bridge.example.com');
  const pubClean = normalizePublicUrl('https://bridge.example.com/api');
  assert.equal(pubClean.ok, true);
  assert.equal(pubClean.value, 'https://bridge.example.com/api');

  const tr = normalizeBridgeBaseUrl('http://127.0.0.1:19384///');
  assert.equal(tr.ok, true);
  assert.equal(tr.baseUrl, 'http://127.0.0.1:19384');

  const pair = encodePairingCode({ url: 'https://bridge.example.com///', token: 'a'.repeat(40) });
  assert.ok(pair && pair.startsWith('ag-bridge-v1:'));

  assert.equal(normalizeUpdateBaseUrl('https://cdn.example.com/extenra///'), 'https://cdn.example.com/extenra');
  assert.equal(normalizeUpdateBaseUrl('https://cdn.example.com/extenra/path'), 'https://cdn.example.com/extenra/path');
  const sha = 'a'.repeat(64);
  assert.equal(
    normalizeHostLibUrl(`https://cdn.example.com/lib.js#sha256=${sha}`),
    `https://cdn.example.com/lib.js#sha256=${sha}`
  );
  assert.equal(normalizeHostLibUrl('https://cdn.example.com/lib.js'), 'https://cdn.example.com/lib.js');
  assert.ok(buildBookmarkletText('console.log(1);').startsWith('javascript:'));

  // Trailing path separators in manifest-validator without fsPort
  const conf = resolveConfinedScriptPath('dist/renderer.js', '/opt/plugins/demo///\\\\', { checkExists: false });
  assert.equal(conf.ok, true);
  assert.equal(conf.resolvedPath, '/opt/plugins/demo/dist/renderer.js');

  const validator = createManifestValidator();
  const vRes = validator.validate(
    {
      schemaVersion: 3,
      apiVersion: 3,
      pluginId: 'demo-plugin',
      displayName: 'Demo',
      version: '1.0.0',
      trustLevel: 'restricted',
      capabilities: ['renderer'],
      entry: { rendererScript: 'dist/renderer.js' },
    },
    { pluginsRootDir: '/opt/plugins///\\\\', checkFilesExist: false }
  );
  assert.equal(vRes.ok, true);
  assert.equal(vRes.resolvedEntries.rendererScript, '/opt/plugins/demo-plugin/dist/renderer.js');

  // asar-patcher linear isSafeStandaloneAsciiComment (strips safe ASCII comment, preserves non-ASCII)
  const origJs = [
    '\t//   Safe ASCII comment with enough padding bytes for replacement',
    '// 한글 주석 보존',
    'const x = 1;',
    '',
  ].join('\n');
  const patchedBuf = transformExactSize(Buffer.from(origJs, 'utf8'), 'const x = 1;', 'const x = 1234567890;', 'MARKER');
  assert.equal(patchedBuf.length, Buffer.byteLength(origJs, 'utf8'));
  assert.ok(patchedBuf.toString('utf8').includes('const x = 1234567890;'));
  assert.ok(patchedBuf.toString('utf8').includes('한글 주석 보존'));

  // Theme RGB color parsing (comma and space syntax)
  for (const [bg, expectedMode] of [
    ['rgb(245, 245, 250)', 'light'],
    ['rgb(245 245 250 / 0.9)', 'light'],
    ['rgba(18, 20, 24, 1)', 'dark'],
  ]) {
    const doc = {
      documentElement: { lang: 'ko', getAttribute: () => null },
      body: {},
    };
    const win = {
      getComputedStyle: () => ({ backgroundColor: bg }),
    };
    const ti = createThemeAndI18n(doc, win);
    assert.equal(ti.getSnapshot().mode, expectedMode, `Expected ${expectedMode} for ${bg}`);
    ti.dispose();
  }

  // vm.compileFunction CJS execution in trust-verifier (process shadowed, accurate CJS contract)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extenra-sonar-vm-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'hook.js'),
      'module.exports = { hasProcess: typeof process !== "undefined", file: __filename, dir: __dirname };\n',
      'utf8'
    );
    const snap = snapshotPluginBundleInMemory(dir);
    const mod = executeInMemoryMainHookBundle(snap, 'hook.js');
    assert.equal(mod.hasProcess, false);
    assert.ok(mod.file.endsWith('hook.js'));
    assert.equal(mod.dir, snap.realRoot);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TC-V332-SONAR-04: failure-path WebCrypto fail-closed, SDK sorted secretsList, and init-main async disposal safety', async () => {
  // 1. kernel.js must fail closed with ERR_WEBCRYPTO_UNAVAILABLE instead of falling back to Math.random()
  const kernelSrc = fs.readFileSync(KERNEL_BUNDLE_PATH, 'utf8');
  const bareWin = {
    document: { body: {}, head: {}, documentElement: {}, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }) },
    location: { protocol: 'http:', host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173' },
    addEventListener() {},
    removeEventListener() {},
  };
  bareWin.window = bareWin;
  const noCryptoCtx = vm.createContext({
    window: bareWin,
    globalThis: bareWin,
    document: bareWin.document,
    setTimeout,
    clearTimeout,
    Promise,
  });
  vm.runInContext(kernelSrc, noCryptoCtx);
  const bootRes = bareWin.__addonHostKernel.boot({ hostToken: 'tok-test', docGenId: 1 });
  assert.equal(bootRes.ok, true);
  assert.throws(
    () =>
      bareWin.__addonHostKernel.stagePluginHandle(
        { pluginId: 'demo', trustLevel: 'restricted', capabilities: ['renderer'] },
        'tok-test'
      ),
    /ERR_WEBCRYPTO_UNAVAILABLE/
  );

  // 2. SDK test-host secretsList uses deterministic comparator
  const host = createTestHost({ surface: 'desktop' });
  const sdkCtx = await host.mountPlugin({
    schemaVersion: 3,
    apiVersion: 3,
    pluginId: 'demo-sdk',
    displayName: 'Demo SDK',
    version: '1.0.0',
    trustLevel: 'trusted',
    capabilities: ['renderer'],
    entry: { rendererScript: 'dist/renderer.js' },
    permissions: { secrets: { maxKeys: 4, maxBytes: 1024, allowRead: true } },
  });
  await sdkCtx.secrets.set('z_key', '1');
  await sdkCtx.secrets.set('a_key', '2');
  await sdkCtx.secrets.set('m_key', '3');
  const listRes = await sdkCtx.secrets.keys();
  assert.deepEqual(listRes, ['a_key', 'm_key', 'z_key']);

  // 3. init-main will-quit & dispose handle async disposal cleanly without floating promise rejections
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extenra-sonar-init-'));
  try {
    const addonsDir = path.join(dir, 'addons');
    const pluginsRoot = path.join(dir, 'plugins');
    const configPath = path.join(dir, 'config.json');
    const trustPath = path.join(dir, 'trust.json');
    fs.mkdirSync(addonsDir, { recursive: true });
    fs.mkdirSync(pluginsRoot, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ plugins: {} }), 'utf8');
    fs.writeFileSync(trustPath, JSON.stringify({ schemaVersion: 1, trustedPlugins: {} }), 'utf8');

    const listeners = new Map();
    const app = {
      isReady: () => true,
      whenReady: () => Promise.resolve(),
      on(ev, fn) {
        if (!listeners.has(ev)) listeners.set(ev, new Set());
        listeners.get(ev).add(fn);
      },
      removeListener(ev, fn) {
        if (listeners.has(ev)) listeners.get(ev).delete(fn);
      },
    };
    const defaultSession = {
      getPreloadScripts: () => [],
      registerPreloadScript: () => 'p1',
      unregisterPreloadScript: () => {},
    };
    const ipcMain = { on() {}, handle() {}, removeHandler() {} };

    const controller = createHostRuntimeController(
      {
        addonsDir,
        pluginsRootDir: pluginsRoot,
        configJsonPath: configPath,
        trustPolicyPath: trustPath,
        profile: ANTIGRAVITY_HOST_PROFILE,
        preloadBridgePath: PRELOAD_BRIDGE_PATH,
        kernelBundlePath: KERNEL_BUNDLE_PATH,
      },
      { app, session: { defaultSession }, ipcMain }
    );
    controller.start();
    await new Promise((r) => setTimeout(r, 30));
    for (const fn of listeners.get('will-quit') || []) {
      fn();
    }
    await controller.dispose();
    assert.ok(Array.isArray(controller.getDiagnostics()));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
