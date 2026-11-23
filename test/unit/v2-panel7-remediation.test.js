'use strict';

/**
 * TC-V2-008: Panel #7 Blocking Remediation Regression Suite
 *
 * Covers every verified P0/P1 blocking action from Independent Deliberation Panel #7:
 *   - S-1: CSP-safe two-phase staged-handle hostToken isolation under syntax breakout
 *   - S-2: 4 owner-CSS isolation bypasses (@\media, @layer a; body, nested :has, string line-continuation)
 *   - S-3: Pre-trust OOM DoS short-circuit, stat.size pre-check, and directory count limit
 *   - S-4: Fail-closed verifyClaimedEvent on omitted/non-integer docGenId + error detail truncation
 *   - R-1: Aborted navigation non-bricking & unconditional same-URL reload() rotation
 *   - R-2: Popover mounted inside active modal <dialog> to avoid Chromium inertness
 *   - R-3: mountSlot() isConnected detach recovery & stale ShadowRoot cleanup
 *   - R-4: app.prependOnceListener('ready') ordering & KERNEL_BOOT_NO_BRIDGE diagnostic warning
 *   - R-5: ignore-guard.js DOM-node-first classification for <a>/<form>/<area>/<base>
 *   - R-6: ModalPortal shadow downgrade guard, close/toggle stack sync, IME Escape guard,
 *          and StyleManager Map<slotId, Set<ShadowRoot>> multi-surface isolation
 *   - O-1: Linux CI Electron flags in scripts/e2e-isolated-runtime.cjs
 *   - O-2: Fail-closed ERR_DIST_RUNTIME_MISSING & corrupt staged runtime atomic re-staging
 *   - O-3: --status/--doctor installed buildSha8, staged runtime presence, and trustPolicy health
 *   - O-4: Legacy V1->V2 .orig migration writes zero files inside vendor resources/
 *   - S-5 / O-5: v2.0.0 documentation accuracy & Option S1 require()-blocking wording
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const { ANTIGRAVITY_HOST_PROFILE } = require('../../src/profiles/antigravity');
const { createRendererKernel } = require('../../src/runtime/renderer/kernel');
const { createRendererInjector } = require('../../src/runtime/main/renderer-injector');
const { createHostOriginResolver } = require('../../src/runtime/main/host-origin-resolver');
const { createPortalArbiter } = require('../../src/runtime/main/portal-arbiter');
const { createPreloadRegistrar } = require('../../src/runtime/main/preload-registrar');
const { validateSafeCssText, scopeCssToOwner, createStyleManager } = require('../../src/runtime/renderer/style-manager');
const { createSlotManager } = require('../../src/runtime/renderer/slot-manager');
const { createModalPortal } = require('../../src/runtime/renderer/modal-portal');
const { isElementInsideIgnored } = require('../../src/runtime/renderer/ignore-guard');
const { snapshotPluginBundleInMemory, loadVerifiedMainHookModule, readVerifiedRendererScript } = require('../../src/runtime/main/trust-verifier');
const {
  createElectronHostLifecyclePort,
  resolveElectronPaths,
  readDistRuntimeBuildInfo,
} = require('../../src/adapters/electron/electron-host-lifecycle-port');
const { createElectronAddonStorePort } = require('../../src/adapters/electron/electron-addon-store-port');
const { createElectronTrustPolicyPort } = require('../../src/adapters/electron/trust-policy-store');
const { installAsarAddonHost } = require('../../src/adapters/electron/asar-patcher');
const { createCliApp } = require('../../src/cli/main');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const KERNEL_BUNDLE_SRC = fs.readFileSync(
  path.join(REPO_ROOT, 'dist', 'runtime', 'renderer', 'kernel-bundle.cjs'),
  'utf8'
);

function createMockElement(tagName = 'div') {
  const attrs = new Map();
  const listeners = new Map();
  const el = {
    nodeType: 1,
    tagName: String(tagName).toUpperCase(),
    className: '',
    textContent: '',
    style: {},
    children: [],
    parentNode: null,
    isConnected: true,
    open: false,
    shadowRoot: null,
    setAttribute(k, v) {
      attrs.set(String(k), String(v));
    },
    getAttribute(k) {
      return attrs.has(String(k)) ? attrs.get(String(k)) : null;
    },
    appendChild(child) {
      if (child.parentNode && child.parentNode.children) {
        const idx = child.parentNode.children.indexOf(child);
        if (idx >= 0) child.parentNode.children.splice(idx, 1);
      }
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    removeChild(child) {
      const idx = el.children.indexOf(child);
      if (idx >= 0) el.children.splice(idx, 1);
      child.parentNode = null;
      return child;
    },
    attachShadow() {
      const sr = {
        nodeType: 11,
        host: el,
        children: [],
        appendChild(child) {
          child.parentNode = sr;
          sr.children.push(child);
          return child;
        },
        removeChild(child) {
          const idx = sr.children.indexOf(child);
          if (idx >= 0) sr.children.splice(idx, 1);
          child.parentNode = null;
          return child;
        },
      };
      el.shadowRoot = sr;
      return sr;
    },
    addEventListener(type, fn) {
      let list = listeners.get(type);
      if (!list) {
        list = [];
        listeners.set(type, list);
      }
      list.push(fn);
    },
    dispatchEvent(type, ev = {}) {
      const list = listeners.get(type) || [];
      for (const fn of list.slice()) fn(ev);
    },
    showModal() {
      el.open = true;
    },
    close() {
      if (!el.open) return;
      el.open = false;
      el.dispatchEvent('close', {});
    },
    showPopover() {
      el.popoverOpen = true;
    },
    hidePopover() {
      if (!el.popoverOpen) return;
      el.popoverOpen = false;
      el.dispatchEvent('toggle', { newState: 'closed' });
    },
    focus() {},
  };
  return el;
}

function createMockDocAndWin() {
  const head = createMockElement('head');
  const body = createMockElement('body');
  const documentElement = createMockElement('html');
  const winListeners = new Map();
  const docListeners = new Map();
  const anchorEl = createMockElement('div');
  body.appendChild(anchorEl);

  const doc = {
    head,
    body,
    documentElement,
    activeElement: null,
    createElement: (tag) => createMockElement(tag),
    querySelector: (sel) => (sel === '[data-testid="live-anchor"]' ? anchorEl : null),
    addEventListener(type, fn) {
      let list = docListeners.get(type);
      if (!list) {
        list = [];
        docListeners.set(type, list);
      }
      list.push(fn);
    },
    dispatchEvent(type, ev) {
      for (const fn of (docListeners.get(type) || []).slice()) fn(ev);
    },
  };
  const win = {
    document: doc,
    addEventListener(type, fn) {
      let list = winListeners.get(type);
      if (!list) {
        list = [];
        winListeners.set(type, list);
      }
      list.push(fn);
    },
    dispatchEvent(type, ev) {
      for (const fn of (winListeners.get(type) || []).slice()) fn(ev);
    },
  };
  return { doc, win, anchorEl };
}

function buildMinimalSyntheticAsar(targetPath, version = '2.34.0') {
  const pkgBuf = Buffer.from(JSON.stringify({ name: 'antigravity', version }), 'utf8');
  const mainLines = [
    "'use strict';",
    "const electron_1 = require('electron');",
    ...Array.from({ length: 14 }, (_, i) => `// headroom comment line ${i} for exact size padding`),
    ANTIGRAVITY_HOST_PROFILE.mainAnchorTarget,
    '  void contents;',
    '});',
  ];
  const mainSrc = mainLines.join('\n') + '\n';
  const mainBuf = Buffer.from(mainSrc, 'utf8');
  const header = {
    files: {
      'package.json': { size: pkgBuf.length, offset: '0' },
      dist: {
        files: {
          'main.js': { size: mainBuf.length, offset: String(pkgBuf.length) },
        },
      },
    },
  };
  const headerStrBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const alignedStrSize = Math.ceil(headerStrBuf.length / 4) * 4;
  const u8 = 4 + alignedStrSize;
  const u4 = 4 + u8;
  const headerBuf = Buffer.alloc(8 + u4, 0);
  headerBuf.writeUInt32LE(4, 0);
  headerBuf.writeUInt32LE(u4, 4);
  headerBuf.writeUInt32LE(u8, 8);
  headerBuf.writeUInt32LE(headerStrBuf.length, 12);
  headerStrBuf.copy(headerBuf, 16);
  const full = Buffer.concat([headerBuf, pkgBuf, mainBuf]);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, full);
  return full;
}

test('TC-V2-008a (S-1): CSP-safe two-phase staged-handle isolates hostToken from restricted plugin syntax breakout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-p7-s1-'));
  try {
    const evilScript = path.join(dir, 'evil.js');
    // Attempt syntax breakout + Function.prototype.toString inspection to steal hostToken + replay staged nonce
    fs.writeFileSync(
      evilScript,
      `
      });
      async function __leak() {
        const src = String(__leak);
        globalThis.__LEAKED_SRC__ = src;
        try {
          globalThis.__addonHostKernel.createPluginHandle({ pluginId: 'forged', trustLevel: 'trusted', uiSlots: [] }, 'wrong');
          globalThis.__FORGE_OK__ = true;
        } catch (err) {
          globalThis.__FORGE_ERR__ = err.message;
        }
        try {
          globalThis.__addonHostKernel.consumeStagedHandle('rn-1-fake');
        } catch (err2) {
          globalThis.__REPLAY_ERR__ = err2.message;
        }
      }
      await __leak();
      const __noop = (function() {
      `,
      'utf8'
    );

    const { doc, win } = createMockDocAndWin();
    const sandbox = {
      document: doc,
      window: win,
      console,
      setTimeout,
      clearTimeout,
      Map,
      Set,
      Promise,
    };
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);

    const fakeSession = { id: 'default' };
    const originResolver = createHostOriginResolver({
      profile: ANTIGRAVITY_HOST_PROFILE,
      getDefaultSession: () => fakeSession,
    });
    const wc = new EventEmitter();
    wc.id = 101;
    wc.session = fakeSession;
    wc.isDestroyed = () => false;
    wc.getURL = () => 'http://127.0.0.1:41234/index.html';
    const executedCodes = [];
    wc.executeJavaScriptInIsolatedWorld = async (_worldId, scripts) => {
      const code = scripts[0].code;
      executedCodes.push(code);
      return await vm.runInContext(code, ctx);
    };

    const injector = createRendererInjector({
      kernelBundleSource: KERNEL_BUNDLE_SRC,
      originResolver,
      profile: ANTIGRAVITY_HOST_PROFILE,
      planProvider: () => ({
        active: [
          {
            pluginId: 'evil-restricted',
            manifest: { version: '2.0.0', sourceSchemaVersion: 2, uiSlots: [], isolation: {} },
            resolvedEntries: { rendererScript: evilScript },
            hasDocumentTransformSlot: false,
          },
        ],
      }),
      policyProvider: () => ({ schemaVersion: 1, approved: {} }),
    });

    injector.attachWebContents(wc);
    await injector.scheduleSync(wc);

    // Phase 2 script containing plugin code MUST NOT contain the booted hostToken or new Function
    const bootScript = executedCodes[0] || '';
    const tokenMatch = bootScript.match(/"hostToken":"([a-f0-9]+)"/);
    assert.ok(tokenMatch, 'boot script should carry a CSPRNG hostToken');
    const bootedHostToken = tokenMatch[1];

    const pluginExecScript = executedCodes.find((c) => c.includes('__leak'));
    assert.ok(pluginExecScript, 'Phase 2 plugin script should have executed');
    assert.equal(pluginExecScript.includes(bootedHostToken), false, 'Phase 2 script MUST NOT contain hostToken');
    assert.equal(pluginExecScript.includes('new Function'), false, 'Phase 2 script MUST be CSP-safe (no new Function)');
    assert.equal(sandbox.__FORGE_OK__, undefined);
    assert.match(String(sandbox.__FORGE_ERR__), /ERR_FORBIDDEN_HOST_TOKEN/);
    assert.match(String(sandbox.__REPLAY_ERR__), /ERR_INVALID_OR_CONSUMED_RUN_NONCE/);
    assert.equal(String(sandbox.__LEAKED_SRC__).includes(bootedHostToken), false, 'Function.toString leak MUST NOT reveal hostToken');
    assert.equal(String(sandbox.__LEAKED_SRC__).includes('disposePlugin'), false);

    // Direct kernel unit verification: staged handle nonce is strictly single-use & clearable
    const k = createRendererKernel(doc, win);
    k.boot({ docGenId: 1, hostToken: '0123456789abcdef0123456789abcdef' });
    const st = k.stagePluginHandle({ pluginId: 'p1', trustLevel: 'restricted', uiSlots: [] }, '0123456789abcdef0123456789abcdef');
    assert.equal(st.ok, true);
    const h = k.consumeStagedHandle(st.runNonce);
    assert.equal(h.pluginId, 'p1');
    assert.throws(() => k.consumeStagedHandle(st.runNonce), /ERR_INVALID_OR_CONSUMED_RUN_NONCE/);
    const st2 = k.stagePluginHandle({ pluginId: 'p2', trustLevel: 'restricted', uiSlots: [] }, '0123456789abcdef0123456789abcdef');
    assert.equal(k.clearStagedHandle(st2.runNonce, '0123456789abcdef0123456789abcdef'), true);
    assert.throws(() => k.consumeStagedHandle(st2.runNonce), /ERR_INVALID_OR_CONSUMED_RUN_NONCE/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TC-V2-008b (S-2): closes all 4 owner-CSS isolation bypasses', () => {
  // (a) Backslash escape inside @-rule (@\media)
  const r1 = validateSafeCssText('@\\media all { body { display: none !important; } }', { scope: 'owner' });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'ERR_FORBIDDEN_CSS_AT_RULE');

  // (b) @layer statement prelude followed by body selector
  const cssLayer = '@layer a; body { display: none !important; }';
  assert.equal(validateSafeCssText(cssLayer, { scope: 'owner' }).ok, true);
  const scopedLayer = scopeCssToOwner(cssLayer, 'evil');
  assert.match(scopedLayer, /^@layer a;\s*\[data-addon-host-owner="evil"\]\s*\{/);
  assert.equal(/\bbody\b/.test(scopedLayer), false, 'body must be rewritten to ownerPrefix');

  // (c) Nested parentheses inside :has(...)
  const r3 = validateSafeCssText(
    '[data-addon-host-owner="evil"] { html:has(:is(head) &) body { display: none !important; } }',
    { scope: 'owner' }
  );
  assert.equal(r3.ok, false);
  assert.equal(r3.reason, 'ERR_FORBIDDEN_CSS_NESTING');

  // (d) CSS string line continuation splitting javascript:
  const r4 = validateSafeCssText('.a { background: url("java\\\nscript:alert(1)"); }', { scope: 'owner' });
  assert.equal(r4.ok, false);
  assert.equal(r4.reason, 'ERR_UNSAFE_CSS_CONSTRUCT');

  // (e) Audit F1a: CSS Syntax L3 Form Feed (\f, U+000C) bad-string token bypass
  const r5 = validateSafeCssText('.a { content: "\f} body { display: none !important; } /*"; }', { scope: 'owner' });
  assert.equal(r5.ok, false);
  assert.equal(r5.reason, 'ERR_FORBIDDEN_CSS_SYNTAX');

  // (f) Audit F1b: :is(&) ~ * sibling combinator escape in Light DOM
  const r6 = validateSafeCssText('[data-addon-host-owner="evil"] { :is(&) ~ * { color: red; } }', { scope: 'owner' });
  assert.equal(r6.ok, false);
  assert.equal(r6.reason, 'ERR_FORBIDDEN_CSS_NESTING');

  // (g) Audit F4: Unquoted <bad-url-token> quote desynchronization escape
  const r7 = validateSafeCssText('.a { background: url(x") } body { display: none !important; } /* "); }', { scope: 'owner' });
  assert.equal(r7.ok, false);
  assert.equal(r7.reason, 'ERR_FORBIDDEN_CSS_SYNTAX');
  const r7Esc = validateSafeCssText('.a { background: \\75 rl(x") } body { display: none !important; } /* "); }', { scope: 'owner' });
  assert.equal(r7Esc.ok, false);
  assert.equal(r7Esc.reason, 'ERR_FORBIDDEN_CSS_SYNTAX');

  // (h) Audit F5: CSS Nesting Level 1 implicit-& relative sibling combinators & nested @media inside rule
  for (const nestedPayload of [
    'body { ~ * { display: none !important; } }',
    '[data-addon-host-owner="evil"] { + * { display: none !important; } }',
    'body { @media all { ~ * { display: none !important; } } }',
    '@media all { body { .a, ~ * { color: red; } } }',
  ]) {
    const rNested = validateSafeCssText(nestedPayload, { scope: 'owner' });
    assert.equal(rNested.ok, false, `Expected nesting bypass rejection for: ${nestedPayload}`);
    assert.equal(rNested.reason, 'ERR_FORBIDDEN_CSS_NESTING');
  }

  // Valid @media, @keyframes, quoted brace in content, and unquoted data: URL remain allowed
  assert.equal(
    validateSafeCssText('@media (max-width: 600px) { .btn { content: "{"; background: url(data:image/png;base64,AAAA); } }', { scope: 'owner' }).ok,
    true
  );
  assert.equal(
    validateSafeCssText('@keyframes fade { from { opacity: 0; } to { opacity: 1; } }', { scope: 'owner' }).ok,
    true
  );
});

test('TC-V2-008c (S-3 & S-4): pre-trust mainHook OOM DoS guards + fail-closed verifyClaimedEvent & error cap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-p7-s34-'));
  try {
    // S-3a: Unapproved mainHook short-circuits BEFORE touching disk (nonexistent dir would throw if walked)
    const missingRoot = path.join(dir, 'never-walked-dir');
    const unapproved = loadVerifiedMainHookModule(
      path.join(missingRoot, 'hook.cjs'),
      missingRoot,
      { pluginId: 'unapproved-p', trustLevel: 'trusted', capabilities: ['mainHook'] },
      { schemaVersion: 1, approved: {} },
      { strictTrustPolicy: true }
    );
    assert.equal(unapproved.ok, false);
    assert.equal(unapproved.reason, 'ERR_TRUST_POLICY_NOT_APPROVED');

    // S-3b: Oversized file rejected before readFileSync via st.size
    const bigDir = path.join(dir, 'big-plugin');
    fs.mkdirSync(bigDir, { recursive: true });
    const bigFile = path.join(bigDir, 'huge.js');
    const fd = fs.openSync(bigFile, 'w');
    fs.ftruncateSync(fd, 9 * 1024 * 1024);
    fs.closeSync(fd);
    assert.throws(() => snapshotPluginBundleInMemory(bigDir), /ERR_BUNDLE_SIZE_LIMIT_EXCEEDED/);

    // NB-3: Oversized renderer script rejected by readVerifiedRendererScript before readFileSync
    const bigRendererCheck = readVerifiedRendererScript(
      bigFile,
      { pluginId: 'big-r', trustLevel: 'restricted', capabilities: ['renderer'] },
      { schemaVersion: 1, approved: {} }
    );
    assert.equal(bigRendererCheck.ok, false);
    assert.equal(bigRendererCheck.reason, 'ERR_RENDERER_SCRIPT_SIZE_LIMIT_EXCEEDED');

    // S-3c: Excessive directory count rejected
    const manyDir = path.join(dir, 'many-dirs');
    fs.mkdirSync(manyDir, { recursive: true });
    for (let i = 0; i < 260; i++) {
      fs.mkdirSync(path.join(manyDir, `d-${i}`));
    }
    assert.throws(() => snapshotPluginBundleInMemory(manyDir), /ERR_BUNDLE_DIR_LIMIT_EXCEEDED/);

    // S-4: verifyClaimedEvent fails closed on undefined / null / non-integer docGenId
    const ses = { id: 'default' };
    const resolver = createHostOriginResolver({
      profile: ANTIGRAVITY_HOST_PROFILE,
      getDefaultSession: () => ses,
    });
    const mainFrame = { url: 'http://127.0.0.1:41234/app', origin: 'http://127.0.0.1:41234' };
    const ev = { sender: { id: 77, session: ses, mainFrame }, senderFrame: mainFrame };
    const v = resolver.verifyFrameEvent(ev);
    assert.equal(v.ok, true);
    const st = resolver.getState(77);
    assert.equal(resolver.consumeClaimNonce(ev, st.activeNonce).ok, true);

    assert.equal(resolver.verifyClaimedEvent(ev, undefined).reason, 'ERR_STALE_DOCUMENT_GENERATION');
    assert.equal(resolver.verifyClaimedEvent(ev, null).reason, 'ERR_STALE_DOCUMENT_GENERATION');
    assert.equal(resolver.verifyClaimedEvent(ev, String(v.docGenId)).reason, 'ERR_STALE_DOCUMENT_GENERATION');
    assert.equal(resolver.verifyClaimedEvent(ev, v.docGenId).ok, true);

    // S-4: recordRendererError truncates detail <= 2048 and pluginId <= 128
    const inj = createRendererInjector({
      kernelBundleSource: '',
      originResolver: resolver,
      planProvider: () => ({ active: [] }),
      policyProvider: () => ({ schemaVersion: 1, approved: {} }),
    });
    inj.recordRendererError('p'.repeat(500), 'x'.repeat(10000));
    const errs = inj.collectRendererErrors();
    assert.equal(errs[0].pluginId.length, 128);
    assert.equal(errs[0].detail.length, 2048);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TC-V2-008d (R-1 & R-4): aborted did-start-navigation preserves live bridge/PortalArbiter, same-URL did-navigate rotates, and preload registers before app.on(ready)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-p7-r14-'));
  try {
    // R-4a: prependOnceListener('ready') runs BEFORE synchronous app.on('ready') window creation
    const fakeApp = new EventEmitter();
    let readyState = false;
    fakeApp.isReady = () => readyState;
    fakeApp.whenReady = () =>
      readyState ? Promise.resolve() : new Promise((resolve) => fakeApp.once('ready', resolve));

    const order = [];
    const fakePreload = path.join(dir, 'preload.cjs');
    fs.writeFileSync(fakePreload, '// preload\n', 'utf8');
    const fakeSession = {
      defaultSession: {
        getPreloadScripts: () => [],
        registerPreloadScript: (spec) => {
          order.push('preload-registered');
          return spec.id;
        },
      },
    };
    const registrar = createPreloadRegistrar({
      app: fakeApp,
      sessionModule: fakeSession,
      preloadPath: fakePreload,
    });
    registrar.ensureRegistered();
    fakeApp.on('ready', () => {
      order.push('host-window-created');
    });
    readyState = true;
    fakeApp.emit('ready');
    assert.deepEqual(order, ['preload-registered', 'host-window-created']);

    // R-1: Aborted did-start-navigation keeps bridge + PortalArbiter + SPA reconcile alive; same-URL did-navigate rotates
    const ses = { id: 'default' };
    const resolver = createHostOriginResolver({
      profile: ANTIGRAVITY_HOST_PROFILE,
      getDefaultSession: () => ses,
    });
    const nativeCalls = [];
    const fakeIpc = {
      handle(_ch, fn) {
        this._fn = fn;
      },
      removeHandler() {},
    };
    const arbiter = createPortalArbiter({
      ipcMain: fakeIpc,
      portalBridge: { channel: 'wcv:set-portal-overlay-open' },
    });
    arbiter.install();
    fakeIpc.handle('wcv:set-portal-overlay-open', (_ev, open) => {
      nativeCalls.push(open);
    });

    const { doc, win } = createMockDocAndWin();
    const sandbox = { document: doc, window: win, console, setTimeout, clearTimeout, Map, Set, Promise };
    sandbox.globalThis = sandbox;
    const vmCtx = vm.createContext(sandbox);

    const wc = new EventEmitter();
    wc.id = 88;
    wc.session = ses;
    wc.mainFrame = { url: 'http://127.0.0.1:41234/page', origin: 'http://127.0.0.1:41234' };
    wc.isDestroyed = () => false;
    wc.getURL = () => wc.mainFrame.url;
    wc.executeJavaScriptInIsolatedWorld = async (_wid, scripts) => vm.runInContext(scripts[0].code, vmCtx);

    const diags = [];
    const inj = createRendererInjector({
      kernelBundleSource: KERNEL_BUNDLE_SRC,
      originResolver: resolver,
      profile: ANTIGRAVITY_HOST_PROFILE,
      planProvider: () => ({ active: [] }),
      policyProvider: () => ({ schemaVersion: 1, approved: {} }),
      recordDiag: (level, code, detail) => diags.push({ level, code, detail }),
    });
    arbiter.attachWebContentsLifecycle(wc);
    inj.attachWebContents(wc);

    await inj.scheduleSync(wc);
    // R-4b: kernel booted without preload bootstrap -> KERNEL_BOOT_NO_BRIDGE warning emitted
    assert.ok(diags.some((d) => d.code === 'KERNEL_BOOT_NO_BRIDGE'));

    const ev = { sender: wc, senderFrame: wc.mainFrame };
    const stBefore = resolver.getState(wc.id);
    const gen1 = stBefore.docGenId;
    assert.equal(resolver.consumeClaimNonce(ev, stBefore.activeNonce).ok, true);
    arbiter.setPluginClaim(wc, 'modal-1', true);
    assert.deepEqual(nativeCalls, [true]);

    // Simulate pre-commit aborted navigation (e.g., download or HTTP 204): did-start-navigation WITHOUT did-navigate
    wc.emit('did-start-navigation', {}, 'http://127.0.0.1:41234/download.zip', false, true);
    assert.equal(resolver.getState(wc.id).docGenId, gen1, 'aborted nav must NOT rotate docGenId');
    assert.equal(resolver.verifyClaimedEvent(ev, gen1).ok, true, 'live bridge IPC must keep working');
    assert.deepEqual(nativeCalls, [true], 'PortalArbiter must NOT revoke on aborted nav');

    // Subsequent SPA did-navigate-in-page reconcile must NOT fail with ERR_KERNEL_ALREADY_BOOTED
    await inj.scheduleSync(wc);
    assert.equal(
      diags.some((d) => String(d.detail).includes('ERR_KERNEL_ALREADY_BOOTED')),
      false
    );

    // Same-URL reload() fires did-navigate -> MUST unconditionally rotate docGenId and revoke PortalArbiter
    wc.emit('did-navigate', {}, 'http://127.0.0.1:41234/page');
    assert.equal(resolver.getState(wc.id).docGenId, gen1 + 1);
    assert.deepEqual(nativeCalls, [true, false]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TC-V2-008e (R-2, R-3, R-5, R-6): popover-in-dialog, mountSlot isConnected, <a>/<form> ignore-guard, ModalPortal guards & multi-ShadowRoot StyleManager', () => {
  const { doc, win, anchorEl } = createMockDocAndWin();
  const styleManager = createStyleManager(doc);
  const slotManager = createSlotManager(doc, {
    uiAnchors: { live: ['[data-testid="live-anchor"]'] },
    styleManager,
  });
  const portalClaims = [];
  const modalPortal = createModalPortal(doc, win, {
    styleManager,
    onPortalClaimChange: (id, active) => portalClaims.push({ id, active }),
  });

  const restrictedMeta = {
    pluginId: 'p-ui',
    trustLevel: 'restricted',
    uiSlots: [
      { slot: 'page-section', slotId: 'p-ui.sec', anchor: 'live', shadow: true },
      { slot: 'modal', slotId: 'p-ui.mod', shadow: true },
      { slot: 'overlay', slotId: 'p-ui.pop', shadow: true },
    ],
    isolation: { noTranslate: true },
  };

  // R-3: React anchor unmount sets isConnected = false while parentNode stays non-null
  const root1 = slotManager.mountSlot(restrictedMeta, 'p-ui.sec');
  const host1 = anchorEl.children[0];
  assert.ok(host1.shadowRoot);
  host1.isConnected = false; // detached while host1.parentNode === anchorEl!
  const root2 = slotManager.mountSlot(restrictedMeta, 'p-ui.sec');
  assert.notEqual(root2, root1, 'mountSlot must remount when isConnected === false');

  // R-5: <a> and <form> elements have `.target` property and MUST NOT be misclassified as Events
  const slotContainer = createMockElement('div');
  slotContainer.setAttribute('data-addon-host-slot', 'p-ui.sec');
  const anchorNode = createMockElement('a');
  anchorNode.target = '_blank';
  const formNode = createMockElement('form');
  formNode.target = '';
  slotContainer.appendChild(anchorNode);
  slotContainer.appendChild(formNode);
  assert.equal(isElementInsideIgnored(anchorNode), true);
  assert.equal(isElementInsideIgnored(formNode), true);

  // R-6a: Restricted v2 plugin cannot downgrade shadow: true via { shadow: false }
  const m1 = modalPortal.openModal(restrictedMeta, 'p-ui.mod', { shadow: false });
  assert.ok(m1.element.children[0].shadowRoot, 'restricted modal must retain ShadowRoot');
  const m2 = modalPortal.openModal(restrictedMeta, 'p-ui.mod');
  assert.ok(m2.element.children[0].shadowRoot);

  // R-6d (Ruling 1): Targeted slotId style injects into BOTH open modals and closing m1 leaves m2's <style> intact
  styleManager.injectStyle(restrictedMeta, 'mod-css', '.btn { color: green; }', { slotId: 'p-ui.mod' });
  const sr1 = m1.element.children[0].shadowRoot;
  const sr2 = m2.element.children[0].shadowRoot;
  assert.equal(sr1.children.filter((c) => c.tagName === 'STYLE').length, 1);
  assert.equal(sr2.children.filter((c) => c.tagName === 'STYLE').length, 1);
  m1.close();
  assert.equal(sr2.children.filter((c) => c.tagName === 'STYLE').length, 1, 'sibling modal style must remain intact');

  // R-2: Popover opened over open modal <dialog> mounts INSIDE that <dialog> (not doc.body)
  const pop = modalPortal.openPopover(restrictedMeta, 'p-ui.pop', { shadow: false });
  assert.equal(pop.element.parentNode, m2.element, 'popover must mount inside active modal <dialog>');
  assert.ok(pop.element.shadowRoot, 'restricted popover must retain ShadowRoot');

  // R-6c: Escape during IME composition (isComposing / keyCode 229 / defaultPrevented) is ignored
  win.dispatchEvent('keydown', { key: 'Escape', isComposing: true });
  assert.equal(modalPortal.getStackSize(), 2);
  win.dispatchEvent('keydown', { key: 'Escape', keyCode: 229 });
  assert.equal(modalPortal.getStackSize(), 2);
  win.dispatchEvent('keydown', { key: 'Escape', defaultPrevented: true });
  assert.equal(modalPortal.getStackSize(), 2);

  // R-6b: Programmatic hidePopover() & dlg.close() sync stack & release PortalArbiter
  pop.element.hidePopover();
  assert.equal(modalPortal.getStackSize(), 1);
  m2.element.close();
  assert.equal(modalPortal.getStackSize(), 0);
  assert.equal(portalClaims[0].active, true);
  assert.equal(portalClaims[portalClaims.length - 1].active, false);

  // Audit F2: Closing parent modal <dialog> directly MUST cascade-close R-2 child popover,
  // run pop.onClose, unregister child ShadowRoot, and release PortalArbiter once (no wedged stack!)
  const claimsBeforeF2 = portalClaims.length;
  let childPopClosed = 0;
  const m3 = modalPortal.openModal(restrictedMeta, 'p-ui.mod');
  const childPop = modalPortal.openPopover(restrictedMeta, 'p-ui.pop', {
    onClose: () => {
      childPopClosed++;
    },
  });
  styleManager.injectStyle(restrictedMeta, 'pop-css', '.p { color: blue; }', { slotId: 'p-ui.pop' });
  const childPopSr = childPop.element.shadowRoot;
  assert.equal(childPopSr.children.filter((c) => c.tagName === 'STYLE').length, 1);
  assert.equal(modalPortal.getStackSize(), 2);

  m3.close();
  assert.equal(modalPortal.getStackSize(), 0, 'F2: parent modal close must cascade-close child popover');
  assert.equal(childPopClosed, 1, 'F2: child popover onClose must fire');
  assert.equal(childPopSr.children.filter((c) => c.tagName === 'STYLE').length, 0, 'F2: child popover ShadowRoot must be unregistered');
  const f2Claims = portalClaims.slice(claimsBeforeF2).map((c) => c.active);
  assert.deepEqual(f2Claims, [true, false], 'F2: PortalArbiter must transition true -> false cleanly once');

  // Audit F2 re-entrancy: closing parent modal when child popB.onClose closes sibling popA OR re-calls parent.close()
  const claimsBeforeReent = portalClaims.length;
  const mReent = modalPortal.openModal(restrictedMeta, 'p-ui.mod');
  const popA = modalPortal.openPopover(restrictedMeta, 'p-ui.pop');
  modalPortal.openPopover(restrictedMeta, 'p-ui.pop', {
    onClose: () => {
      popA.close();
      mReent.close();
    },
  });
  assert.equal(modalPortal.getStackSize(), 3);
  assert.doesNotThrow(() => mReent.close());
  assert.equal(modalPortal.getStackSize(), 0, 'F2 re-entrancy: stack must drain cleanly to 0');
  assert.deepEqual(portalClaims.slice(claimsBeforeReent).map((c) => c.active), [true, false]);
});

test('TC-V2-008f (O-1, O-2, O-3, O-4, S-5, O-5): CI flags, fail-closed dist/runtime, corrupt restage, doctor/status health, zero resources/ write, and docs sync', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-p7-o15-'));
  try {
    // O-1: scripts/e2e-isolated-runtime.cjs passes Linux CI Electron flags
    const e2eIsoSrc = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'e2e-isolated-runtime.cjs'), 'utf8');
    assert.match(e2eIsoSrc, /--no-sandbox/);
    assert.match(e2eIsoSrc, /--disable-gpu/);
    assert.match(e2eIsoSrc, /--disable-dev-shm-usage/);

    const resourcesDir = path.join(dir, 'resources');
    const asarPath = path.join(resourcesDir, 'app.asar');
    const hostDataDir = path.join(dir, 'host-data');
    const pluginsRoot = path.join(dir, 'plugins');
    const addonsDir = path.join(hostDataDir, 'addons.d');
    const configPath = path.join(dir, 'config.json');
    fs.mkdirSync(pluginsRoot, { recursive: true });
    fs.mkdirSync(addonsDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ plugins: {} }), 'utf8');
    const pureAsarBuf = buildMinimalSyntheticAsar(asarPath, '2.34.0');

    const overrides = {
      HOST_DATA_DIR: hostDataDir,
      ADDONS_DIR: addonsDir,
      PLUGINS_ROOT_DIR: pluginsRoot,
      LOADER_SCRIPT_PATH: path.join(hostDataDir, 'addon-host-loader.js'),
      ASAR_PATH: asarPath,
      ASAR_LOCK_PATH: path.join(hostDataDir, 'asar.lock'),
      CONFIG_JSON_PATH: configPath,
      BACKUPS_DIR: path.join(hostDataDir, 'backups'),
      TRUST_POLICY_PATH: path.join(hostDataDir, 'trust-policy.json'),
      RUNTIME_DIR: path.join(hostDataDir, 'runtime'),
    };

    // O-2a: Missing dist/runtime fails closed with ERR_DIST_RUNTIME_MISSING (zero loader/ASAR mutation)
    const missingDistLifecycle = createElectronHostLifecyclePort({
      distRuntimeDir: path.join(dir, 'nonexistent-dist-runtime'),
    });
    const ctx = missingDistLifecycle.resolveContext(ANTIGRAVITY_HOST_PROFILE, process.env, overrides);
    const failMissing = missingDistLifecycle.installHost(ctx);
    assert.equal(failMissing.ok, false);
    assert.equal(failMissing.reason, 'ERR_DIST_RUNTIME_MISSING');
    assert.equal(fs.existsSync(overrides.LOADER_SCRIPT_PATH), false);
    assert.deepEqual(fs.readFileSync(asarPath), pureAsarBuf);

    // O-4: Legacy V1 resources/app.asar.v2.34.0.orig WITHOUT .json migrates with ZERO writes inside vendor resources/
    const legacyOrigPath = path.join(resourcesDir, 'app.asar.v2.34.0.orig');
    fs.writeFileSync(legacyOrigPath, pureAsarBuf);
    const resourcesBefore = fs.readdirSync(resourcesDir).sort();
    const resInst = installAsarAddonHost(ctx.paths, ANTIGRAVITY_HOST_PROFILE);
    assert.equal(resInst.status, 'INSTALLED');
    const resourcesAfter = fs.readdirSync(resourcesDir).sort();
    assert.deepEqual(resourcesAfter, resourcesBefore, 'O-4: must NOT write .orig.json into vendor resources/');
    assert.equal(fs.existsSync(`${legacyOrigPath}.json`), false);
    assert.equal(fs.existsSync(resInst.backupPath), true);
    assert.equal(fs.existsSync(`${resInst.backupPath}.json`), true);

    // Roll back so lifecycle.installHost can run full install + O-2b corrupt runtime re-stage
    fs.writeFileSync(asarPath, pureAsarBuf);
    fs.rmSync(overrides.BACKUPS_DIR, { recursive: true, force: true });
    fs.unlinkSync(legacyOrigPath);

    // O-2b: Pre-existing corrupt/empty runtime/<buildSha8>/ is detected and re-staged cleanly
    const realBuildInfo = readDistRuntimeBuildInfo();
    const corruptRuntimeDir = path.join(overrides.RUNTIME_DIR, realBuildInfo.buildSha8);
    fs.mkdirSync(corruptRuntimeDir, { recursive: true });
    fs.writeFileSync(path.join(corruptRuntimeDir, 'junk.txt'), 'broken', 'utf8');

    const lifecycle = createElectronHostLifecyclePort();
    const instOk = lifecycle.installHost(ctx);
    assert.equal(instOk.ok, true);
    assert.equal(fs.existsSync(path.join(corruptRuntimeDir, 'main', 'init-main.js')), true);
    assert.equal(fs.existsSync(path.join(corruptRuntimeDir, 'junk.txt')), false);

    // O-3: getHostStatus & diagnoseHost detect installed loader buildSha8 & missing loader/runtime
    assert.equal(lifecycle.getHostStatus(ctx).installedBuildSha8, realBuildInfo.buildSha8);
    assert.equal(lifecycle.diagnoseHost(ctx).healthy, true);

    // Deleting staged runtime breaks diagnoseHost health
    fs.unlinkSync(path.join(corruptRuntimeDir, 'main', 'init-main.js'));
    const diagBrokenRuntime = lifecycle.diagnoseHost(ctx);
    assert.equal(diagBrokenRuntime.stagedRuntimePresent, false);
    assert.equal(diagBrokenRuntime.healthy, false);

    // Restore staged runtime & test CLI --doctor trustPolicy checks
    fs.copyFileSync(
      path.join(realBuildInfo.distRuntimeDir, 'main', 'init-main.js'),
      path.join(corruptRuntimeDir, 'main', 'init-main.js')
    );
    const store = createElectronAddonStorePort();
    const trustPort = createElectronTrustPolicyPort();
    const cli = createCliApp({
      hostLifecycle: lifecycle,
      addonStore: store,
      trustPolicy: trustPort,
      defaultProfile: ANTIGRAVITY_HOST_PROFILE,
    });

    // Register active trusted plugin without approval -> doctor.healthy === false
    const trustedDir = path.join(pluginsRoot, 'trusted-unapproved');
    fs.mkdirSync(trustedDir, { recursive: true });
    fs.writeFileSync(path.join(trustedDir, 'hook.cjs'), 'module.exports = {};\n', 'utf8');
    fs.writeFileSync(
      path.join(addonsDir, 'trusted-unapproved.json'),
      JSON.stringify({
        schemaVersion: 2,
        pluginId: 'trusted-unapproved',
        displayName: 'Trusted Unapproved',
        version: '2.0.0',
        trustLevel: 'trusted',
        capabilities: ['mainHook'],
        entry: { mainHookScript: 'hook.cjs' },
        isolation: { noTranslate: true, i18nSelfManaged: true },
        loadOrder: 10,
      }),
      'utf8'
    );
    const docUnapproved = cli.buildDoctorReport(overrides);
    assert.equal(docUnapproved.healthy, false);
    assert.deepEqual(docUnapproved.trustPolicy.unapprovedTrustedAddons, ['trusted-unapproved']);

    // Corrupt trust-policy.json -> listApproved preserves reason & doctor.healthy === false
    fs.writeFileSync(overrides.TRUST_POLICY_PATH, '{broken json', 'utf8');
    const listed = trustPort.listApproved(ctx);
    assert.equal(listed.ok, false);
    assert.equal(listed.reason, 'ERR_TRUST_POLICY_READ_FAILED');
    const docCorrupt = cli.buildDoctorReport(overrides);
    assert.equal(docCorrupt.healthy, false);
    assert.equal(docCorrupt.trustPolicy.ok, false);

    // S-5 & O-5: Documentation reflects v2.0.0 accurately without stale v1.1.0 or overstated sandbox wording
    const archDoc = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'ARCHITECTURE.md'), 'utf8');
    const tcDoc = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'TEST_CASES.md'), 'utf8');
    const readmeEn = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
    const readmeKo = fs.readFileSync(path.join(REPO_ROOT, 'README.ko.md'), 'utf8');
    assert.match(archDoc, /v2\.0\.0/);
    assert.equal(archDoc.includes('main-world fallback'), false);
    assert.match(tcDoc, /v2\.0\.0/);
    assert.match(tcDoc, /TC-V2-008/);
    assert.match(readmeEn, /blocks `require\(\)` of/);
    assert.match(readmeKo, /`require\(\)` 호출을 차단/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
