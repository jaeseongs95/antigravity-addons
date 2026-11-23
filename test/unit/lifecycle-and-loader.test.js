'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { planAddonExecution } = require('../../src/core/lifecycle-coordinator');
const {
  isAllowedRendererUrl,
  buildHostLoaderScriptSource,
} = require('../../src/adapters/electron/host-loader-builder');
const { ANTIGRAVITY_HOST_PROFILE } = require('../../src/profiles/antigravity');
const { createHostRuntimeController } = require('../../src/runtime/main/init-main');
const { snapshotPluginBundleInMemory, sha256Hex } = require('../../src/runtime/main/trust-verifier');

const KERNEL_BUNDLE_PATH = path.resolve(__dirname, '..', '..', 'dist', 'runtime', 'renderer', 'kernel-bundle.cjs');
const PRELOAD_BRIDGE_PATH = path.resolve(__dirname, '..', '..', 'dist', 'runtime', 'preload', 'preload-bridge.cjs');

function createFakeDomEnv({ url = 'http://127.0.0.1:4173/home', anchors = {} } = {}) {
  function makeNode(tag) {
    const attrs = Object.create(null);
    const listeners = Object.create(null);
    const node = {
      tagName: String(tag || 'div').toUpperCase(),
      className: '',
      attrs,
      style: {},
      children: [],
      parentNode: null,
      textContent: '',
      focused: false,
      open: false,
      popoverOpen: false,
      shadowRoot: null,
      _rootNode: null,
      setAttribute(k, v) {
        attrs[k] = String(v);
      },
      getAttribute(k) {
        return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null;
      },
      hasAttribute(k) {
        return Object.prototype.hasOwnProperty.call(attrs, k);
      },
      appendChild(ch) {
        ch.parentNode = this;
        this.children.push(ch);
        if (this._isShadowRoot) ch._rootNode = this;
        return ch;
      },
      removeChild(ch) {
        this.children = this.children.filter((c) => c !== ch);
        ch.parentNode = null;
      },
      attachShadow() {
        const sr = makeNode('#shadow-root');
        sr._isShadowRoot = true;
        sr.host = this;
        this.shadowRoot = sr;
        return sr;
      },
      getRootNode() {
        let cur = this;
        while (cur) {
          if (cur._rootNode) return cur._rootNode;
          if (cur._isShadowRoot) return cur;
          cur = cur.parentNode;
        }
        return doc;
      },
      showModal() {
        this.open = true;
      },
      close() {
        this.open = false;
      },
      showPopover() {
        this.popoverOpen = true;
      },
      hidePopover() {
        this.popoverOpen = false;
      },
      matches(sel) {
        if (sel === ':popover-open') return Boolean(this.popoverOpen);
        return false;
      },
      addEventListener(ev, fn) {
        if (!listeners[ev]) listeners[ev] = [];
        listeners[ev].push(fn);
      },
      removeEventListener(ev, fn) {
        if (listeners[ev]) listeners[ev] = listeners[ev].filter((f) => f !== fn);
      },
      dispatch(ev, evtObj) {
        for (const fn of (listeners[ev] || []).slice()) fn(evtObj);
      },
      focus() {
        this.focused = true;
      },
    };
    return node;
  }

  const body = makeNode('body');
  const head = makeNode('head');
  const docListeners = Object.create(null);
  const winListeners = Object.create(null);
  const anchorNodes = {};
  for (const [sel, tag] of Object.entries(anchors)) {
    const n = makeNode(tag || 'div');
    body.appendChild(n);
    anchorNodes[sel] = n;
  }

  const doc = {
    body,
    head,
    documentElement: body,
    activeElement: null,
    createElement: makeNode,
    querySelector(sel) {
      if (Object.prototype.hasOwnProperty.call(anchorNodes, sel)) return anchorNodes[sel];
      if (sel === 'body') return body;
      return null;
    },
    addEventListener(ev, fn) {
      if (!docListeners[ev]) docListeners[ev] = [];
      docListeners[ev].push(fn);
    },
    removeEventListener(ev, fn) {
      if (docListeners[ev]) docListeners[ev] = docListeners[ev].filter((f) => f !== fn);
    },
    dispatch(ev, evtObj) {
      for (const fn of (docListeners[ev] || []).slice()) fn(evtObj);
    },
  };

  const parsed = new URL(url);
  const win = {
    document: doc,
    location: { protocol: parsed.protocol, host: parsed.host, origin: parsed.origin },
    addEventListener(ev, fn) {
      if (!winListeners[ev]) winListeners[ev] = [];
      winListeners[ev].push(fn);
    },
    removeEventListener(ev, fn) {
      if (winListeners[ev]) winListeners[ev] = winListeners[ev].filter((f) => f !== fn);
    },
    dispatch(ev, evtObj) {
      for (const fn of (winListeners[ev] || []).slice()) fn(evtObj);
    },
  };
  win.window = win;
  const ctx = vm.createContext({
    window: win,
    globalThis: win,
    document: doc,
    setTimeout,
    clearTimeout,
    Promise,
  });
  return { doc, body, head, win, ctx, anchorNodes, makeNode };
}

function createFakeElectronDeps() {
  const defaultSession = {
    _preloads: [],
    getPreloadScripts() {
      return this._preloads.slice();
    },
    registerPreloadScript(spec) {
      this._preloads.push(spec);
      return spec.id;
    },
    unregisterPreloadScript(id) {
      this._preloads = this._preloads.filter((p) => p.id !== id);
    },
  };
  const appListeners = new Map();
  const app = {
    isReady: () => true,
    whenReady: () => Promise.resolve(),
    on(ev, fn) {
      if (!appListeners.has(ev)) appListeners.set(ev, new Set());
      appListeners.get(ev).add(fn);
    },
    removeListener(ev, fn) {
      if (appListeners.has(ev)) appListeners.get(ev).delete(fn);
    },
  };
  const ipcHandlers = new Map();
  const ipcOn = new Map();
  const ipcMain = {
    on(ch, fn) {
      ipcOn.set(ch, fn);
    },
    handle(ch, fn) {
      ipcHandlers.set(ch, fn);
    },
    removeHandler(ch) {
      ipcHandlers.delete(ch);
    },
  };
  return { app, session: { defaultSession }, ipcMain, defaultSession, ipcHandlers, ipcOn };
}

function createMockWebContents({ id = 1, url = 'http://127.0.0.1:4173/home', session, ctx, onExec } = {}) {
  const listeners = new Map();
  let curUrl = url;
  let destroyed = false;
  const wc = {
    id,
    session,
    getType: () => 'window',
    getURL: () => curUrl,
    setURL(u) {
      curUrl = u;
    },
    isDestroyed: () => destroyed,
    destroy() {
      destroyed = true;
      wc.emit('destroyed');
    },
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev).add(fn);
    },
    once(ev, fn) {
      const wrap = (...args) => {
        wc.removeListener(ev, wrap);
        return fn(...args);
      };
      wc.on(ev, wrap);
    },
    removeListener(ev, fn) {
      if (listeners.has(ev)) listeners.get(ev).delete(fn);
    },
    emit(ev, ...args) {
      for (const fn of Array.from(listeners.get(ev) || [])) fn(...args);
    },
    async executeJavaScriptInIsolatedWorld(worldId, sources) {
      assert.equal(worldId, 998, 'v2.0.0 must execute in isolated World 998 (never 0 or 999)');
      const code = sources[0].code;
      if (onExec) return onExec(code, ctx);
      return vm.runInContext(code, ctx);
    },
  };
  return wc;
}

test('TC-006: planAddonExecution sorts by loadOrder, skips disabled plugins, and isolates invalid manifests', () => {
  const plan = planAddonExecution(
    [
      {
        source: 'b.json',
        manifest: {
          schemaVersion: 1,
          pluginId: 'plugin-b',
          displayName: 'B',
          version: '1.0.0',
          capabilities: ['renderer'],
          entry: { rendererScript: 'index.js', mainHookScript: null },
          isolation: { noTranslate: true, i18nSelfManaged: true },
          loadOrder: 50,
        },
      },
      {
        source: 'a.json',
        manifest: {
          schemaVersion: 1,
          pluginId: 'plugin-a',
          displayName: 'A',
          version: '1.0.0',
          capabilities: ['renderer'],
          entry: { rendererScript: 'index.js', mainHookScript: null },
          isolation: { noTranslate: true, i18nSelfManaged: true },
          loadOrder: 10,
        },
      },
      {
        source: 'disabled.json',
        manifest: {
          schemaVersion: 1,
          pluginId: 'plugin-disabled',
          displayName: 'Disabled',
          version: '1.0.0',
          capabilities: ['renderer'],
          entry: { rendererScript: 'index.js', mainHookScript: null },
          isolation: { noTranslate: true, i18nSelfManaged: true },
          loadOrder: 5,
        },
      },
      { source: 'bad.json', manifest: { schemaVersion: 99 } },
      {
        source: 'a-duplicate.json',
        manifest: {
          schemaVersion: 1,
          pluginId: 'plugin-a',
          displayName: 'A Dup',
          version: '1.0.0',
          capabilities: ['renderer'],
          entry: { rendererScript: 'index.js', mainHookScript: null },
          isolation: { noTranslate: true, i18nSelfManaged: true },
          loadOrder: 10,
        },
      },
    ],
    { isEnabled: (id) => id !== 'plugin-disabled' }
  );

  assert.deepEqual(
    plan.active.map((a) => a.pluginId),
    ['plugin-a', 'plugin-b']
  );
  assert.equal(plan.disabled.length, 1);
  assert.equal(plan.disabled[0].pluginId, 'plugin-disabled');
  assert.equal(plan.rejected.length, 2);
  assert.ok(plan.rejected.some((r) => r.reason === 'ERR_DUPLICATE_PLUGIN_ID'));
});

test('TC-007 (F5): isAllowedRendererUrl honors HostProfile protocols/hosts and blocks devtools/file/external', () => {
  assert.equal(isAllowedRendererUrl('http://127.0.0.1:4173/', ANTIGRAVITY_HOST_PROFILE), true);
  assert.equal(isAllowedRendererUrl('https://localhost:5387/app', ANTIGRAVITY_HOST_PROFILE), true);
  assert.equal(isAllowedRendererUrl('devtools://devtools/bundled/inspector.html', ANTIGRAVITY_HOST_PROFILE), false);
  assert.equal(isAllowedRendererUrl('file:///C:/index.html', ANTIGRAVITY_HOST_PROFILE), false);
  assert.equal(isAllowedRendererUrl('https://evil.example.com/', ANTIGRAVITY_HOST_PROFILE), false);

  const customProfile = {
    allowedUrlProtocols: ['app:'],
    allowedUrlHosts: ['internal.local'],
  };
  assert.equal(isAllowedRendererUrl('app://internal.local/main', customProfile), true);
  assert.equal(isAllowedRendererUrl('http://127.0.0.1:4173/', customProfile), false);
});

test('TC-008 (v2 Runtime): blocks traversal pluginId, isolates crashing peer with partial DOM cleanup, serializes loadOrder in World 998, preserves SPA generation, rejects cross-plugin unmount, and disposes disabled addons', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-v2-tc008-'));
  try {
    const pluginsRoot = path.join(dir, 'plugins');
    const addonsDir = path.join(dir, 'addons.d');
    const configPath = path.join(dir, 'config.json');
    const trustPath = path.join(dir, 'trust-policy.json');
    fs.mkdirSync(addonsDir, { recursive: true });
    fs.mkdirSync(pluginsRoot, { recursive: true });

    // Malicious traversal pluginId -> rejected by manifest validator
    fs.mkdirSync(path.join(dir, 'outside'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'outside', 'evil.js'), 'window.__EVIL_RAN__ = true;\n', 'utf8');
    fs.writeFileSync(
      path.join(addonsDir, '00-evil.json'),
      JSON.stringify({
        schemaVersion: 2,
        pluginId: '../../outside',
        displayName: 'Evil',
        version: '1.0.0',
        capabilities: ['renderer'],
        entry: { rendererScript: 'evil.js' },
        isolation: { noTranslate: true, i18nSelfManaged: true },
        loadOrder: 1,
      }),
      'utf8'
    );

    // Plugin 1 (loadOrder 10)
    const p1Dir = path.join(pluginsRoot, 'plugin-first');
    fs.mkdirSync(p1Dir, { recursive: true });
    fs.writeFileSync(
      path.join(p1Dir, 'entry.js'),
      `
      window.__ORDER__ = window.__ORDER__ || [];
      window.__ORDER__.push('first');
      const el = addonHost.mountSlot('plugin-first.bar');
      el.textContent = 'FIRST';
      addonHost.injectStyle('theme', '.p1{color:green}');
      window.__STYLE_REMOVED__ = addonHost.removeStyle('theme');
      window.__SLOT_UNMOUNTED__ = addonHost.unmountSlot('plugin-first.bar');
      const el2 = addonHost.mountSlot('plugin-first.bar');
      el2.textContent = 'FIRST_REMOUNTED';
      addonHost.injectStyle('theme', '.p1{color:blue}');
      addonHost.onDispose(() => { window.__FIRST_DISPOSED__ = true; });
      try {
        addonHost.mountSlot('undeclared.slot');
        window.__UNDECLARED_ALLOWED__ = true;
      } catch (e) {
        window.__UNDECLARED_ERR__ = e.message;
      }
      `,
      'utf8'
    );
    fs.writeFileSync(
      path.join(addonsDir, 'plugin-first.json'),
      JSON.stringify({
        schemaVersion: 1,
        pluginId: 'plugin-first',
        displayName: 'First',
        version: '1.0.0',
        capabilities: ['renderer'],
        entry: { rendererScript: 'entry.js', mainHookScript: null },
        uiSlots: [{ slot: 'status-bar', slotId: 'plugin-first.bar', anchor: 'status-bar', exclusive: true }],
        isolation: { noTranslate: true, i18nSelfManaged: true, storageNamespace: 'plugin-first' },
        loadOrder: 10,
      }),
      'utf8'
    );

    // Plugin 2 (loadOrder 20): mounts partial slot + style then throws -> must clean up immediately & never re-run
    const p2Dir = path.join(pluginsRoot, 'plugin-boom');
    fs.mkdirSync(p2Dir, { recursive: true });
    fs.writeFileSync(
      path.join(p2Dir, 'entry.js'),
      `
      window.__BOOM_RUN_COUNT__ = (window.__BOOM_RUN_COUNT__ || 0) + 1;
      addonHost.mountSlot('plugin-boom.partial', { fallbackToBody: true });
      addonHost.injectStyle('partial-css', '.boom{display:none}');
      throw new Error('BOOM_PEER');
      `,
      'utf8'
    );
    fs.writeFileSync(
      path.join(addonsDir, 'plugin-boom.json'),
      JSON.stringify({
        schemaVersion: 1,
        pluginId: 'plugin-boom',
        displayName: 'Boom',
        version: '1.0.0',
        capabilities: ['renderer'],
        entry: { rendererScript: 'entry.js', mainHookScript: null },
        uiSlots: [{ slot: 'overlay', slotId: 'plugin-boom.partial' }],
        isolation: { noTranslate: true, i18nSelfManaged: true, storageNamespace: 'plugin-boom' },
        loadOrder: 20,
      }),
      'utf8'
    );

    // Plugin 3 (loadOrder 30): trusted with SHA-256 pinned mainHook + renderer
    const p3Dir = path.join(pluginsRoot, 'plugin-second');
    fs.mkdirSync(p3Dir, { recursive: true });
    const p3Renderer = path.join(p3Dir, 'entry.js');
    fs.writeFileSync(
      p3Renderer,
      `
      window.__ORDER__ = window.__ORDER__ || [];
      window.__ORDER__.push('second');
      const s2 = addonHost.mountSlot('plugin-second.overlay', { fallbackToBody: true });
      s2.textContent = 'SECOND';
      addonHost.injectStyle('overlay-css', '.p2{color:red}');
      window.__SECOND_HANDLE__ = addonHost;
      addonHost.onDispose(() => { window.__SECOND_DISPOSED__ = true; });
      try {
        addonHost.unmountSlot('plugin-first.bar');
        window.__CROSS_UNMOUNT_ALLOWED__ = true;
      } catch (e) {
        window.__CROSS_UNMOUNT_ERR__ = e.message;
      }
      `,
      'utf8'
    );
    fs.writeFileSync(
      path.join(p3Dir, 'hook.cjs'),
      `
      let disposed = 0;
      module.exports = {
        onMainReady(broker) {
          globalThis.__TC008_HOOK_STATE__ = {
            get disposed() { return disposed; },
            brokerFrozen: Object.isFrozen(broker),
            hasQuit: typeof broker.quit !== 'undefined',
          };
          broker.onDispose(() => { disposed++; });
        },
      };
      `,
      'utf8'
    );
    fs.writeFileSync(
      path.join(addonsDir, 'plugin-second.json'),
      JSON.stringify({
        schemaVersion: 2,
        pluginId: 'plugin-second',
        displayName: 'Second',
        version: '1.0.0',
        trustLevel: 'trusted',
        capabilities: ['mainHook', 'renderer'],
        entry: { rendererScript: 'entry.js', mainHookScript: 'hook.cjs' },
        uiSlots: [{ slot: 'overlay', slotId: 'plugin-second.overlay', shadow: false }],
        isolation: { noTranslate: true, i18nSelfManaged: true, storageNamespace: 'plugin-second' },
        loadOrder: 30,
      }),
      'utf8'
    );

    const p3Bundle = snapshotPluginBundleInMemory(p3Dir);
    fs.writeFileSync(
      trustPath,
      JSON.stringify({
        schemaVersion: 1,
        approved: {
          'plugin-second': {
            pluginId: 'plugin-second',
            version: '1.0.0',
            rendererSha256: sha256Hex(fs.readFileSync(p3Renderer)),
            mainHookBundleSha256: p3Bundle.bundleSha256,
            approvedAt: new Date().toISOString(),
          },
        },
      }),
      'utf8'
    );
    fs.writeFileSync(configPath, JSON.stringify({ plugins: {} }), 'utf8');

    const deps = createFakeElectronDeps();
    const env = createFakeDomEnv({
      anchors: { '[data-testid="status-bar"]': 'div' },
    });
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
      deps
    );
    controller.start();
    await controller.reconcileMainHooks();

    const wc = createMockWebContents({ id: 1, session: deps.defaultSession, ctx: env.ctx });
    controller.attachWebContents(wc);

    // Concurrent dom-ready + did-finish-load serialize cleanly and inject once in loadOrder
    wc.emit('dom-ready');
    wc.emit('did-finish-load');
    await new Promise((r) => setTimeout(r, 60));

    assert.equal(env.win.__EVIL_RAN__, undefined);
    assert.deepEqual(Array.from(env.win.__ORDER__), ['first', 'second']);
    assert.equal(env.win.__BOOM_RUN_COUNT__, 1);
    assert.equal(
      env.body.children.some((c) => c.getAttribute('data-addon-host-owner') === 'plugin-boom'),
      false,
      'Crashing plugin partial DOM must be cleaned up immediately'
    );
    assert.equal(env.win.__STYLE_REMOVED__, true);
    assert.equal(env.win.__SLOT_UNMOUNTED__, true);
    assert.equal(env.win.__UNDECLARED_ALLOWED__, undefined);
    assert.match(String(env.win.__UNDECLARED_ERR__), /ERR_UNDECLARED_SLOT/);
    assert.equal(env.win.__CROSS_UNMOUNT_ALLOWED__, undefined);
    assert.match(String(env.win.__CROSS_UNMOUNT_ERR__), /ERR_FORBIDDEN_CROSS_PLUGIN_UNMOUNT/);

    // SPA in-page navigation does NOT re-inject
    wc.setURL('http://127.0.0.1:4173/settings');
    wc.emit('did-navigate-in-page');
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(Array.from(env.win.__ORDER__), ['first', 'second']);

    // Disable plugin-second -> disposes BOTH mainHook and renderer handle cleanly
    assert.equal(globalThis.__TC008_HOOK_STATE__.brokerFrozen, true);
    assert.equal(globalThis.__TC008_HOOK_STATE__.hasQuit, false);
    assert.equal(globalThis.__TC008_HOOK_STATE__.disposed, 0);

    fs.writeFileSync(configPath, JSON.stringify({ plugins: { 'plugin-second': { enabled: false } } }), 'utf8');
    await controller.reconcileMainHooks();
    wc.emit('did-finish-load');
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(env.win.__BOOM_RUN_COUNT__, 1);
    assert.equal(globalThis.__TC008_HOOK_STATE__.disposed, 1);
    assert.equal(env.win.__SECOND_DISPOSED__, true);
    assert.equal(
      env.body.children.some((c) => c.getAttribute('data-addon-host-owner') === 'plugin-second'),
      false
    );
    assert.ok(controller.collectRendererErrors().some((e) => e.pluginId === 'plugin-boom' && e.detail.includes('BOOM_PEER')));

    // Thin shim smoke check
    const shimSrc = buildHostLoaderScriptSource(
      { ADDONS_DIR: addonsDir, PLUGINS_ROOT_DIR: pluginsRoot, CONFIG_JSON_PATH: configPath, TRUST_POLICY_PATH: trustPath },
      ANTIGRAVITY_HOST_PROFILE
    );
    assert.match(shimSrc, /initMain/);
    assert.equal(shimSrc.length < 4096, true, 'v2.0.0 loader must be a thin shim, not a 1100-line monolith');

    await controller.dispose();
  } finally {
    delete globalThis.__TC008_HOOK_STATE__;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TC-015 (TOCTOU Navigation Guard): mid-loop redirect to disallowed origin aborts immediately without executing subsequent addons', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-v2-tc015-'));
  try {
    const pluginsRoot = path.join(dir, 'plugins');
    const addonsDir = path.join(dir, 'addons.d');
    const configPath = path.join(dir, 'config.json');
    fs.mkdirSync(addonsDir, { recursive: true });
    fs.mkdirSync(path.join(pluginsRoot, 'p-one'), { recursive: true });
    fs.mkdirSync(path.join(pluginsRoot, 'p-two'), { recursive: true });

    fs.writeFileSync(path.join(pluginsRoot, 'p-one', 'entry.js'), 'window.__P1_RAN__ = true;\n', 'utf8');
    fs.writeFileSync(path.join(pluginsRoot, 'p-two', 'entry.js'), 'window.__P2_RAN__ = true;\n', 'utf8');
    for (const [id, order] of [['p-one', 10], ['p-two', 20]]) {
      fs.writeFileSync(
        path.join(addonsDir, `${id}.json`),
        JSON.stringify({
          schemaVersion: 2,
          pluginId: id,
          displayName: id,
          version: '1.0.0',
          capabilities: ['renderer'],
          entry: { rendererScript: 'entry.js' },
          isolation: { noTranslate: true, i18nSelfManaged: true },
          loadOrder: order,
        }),
        'utf8'
      );
    }
    fs.writeFileSync(configPath, JSON.stringify({ plugins: {} }), 'utf8');

    const deps = createFakeElectronDeps();
    const env = createFakeDomEnv();
    const controller = createHostRuntimeController(
      {
        addonsDir,
        pluginsRootDir: pluginsRoot,
        configJsonPath: configPath,
        profile: ANTIGRAVITY_HOST_PROFILE,
        preloadBridgePath: PRELOAD_BRIDGE_PATH,
        kernelBundlePath: KERNEL_BUNDLE_PATH,
      },
      deps
    );
    controller.start();

    let wc = null;
    wc = createMockWebContents({
      id: 2,
      session: deps.defaultSession,
      ctx: env.ctx,
      onExec(code, ctx) {
        const res = vm.runInContext(code, ctx);
        if (code.includes('window.__P1_RAN__')) {
          wc.setURL('https://evil.example.com/phish');
          wc.emit('did-start-navigation', {}, 'https://evil.example.com/phish', false, true);
        }
        return res;
      },
    });
    controller.attachWebContents(wc);
    wc.emit('dom-ready');
    await new Promise((r) => setTimeout(r, 60));

    assert.equal(env.win.__P1_RAN__, true);
    assert.equal(env.win.__P2_RAN__, undefined, 'p-two MUST NOT execute after navigation to disallowed origin');
    await controller.dispose();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TC-017 (Custom Protocol & Document Generation Rotation): custom scheme passes while disallowed origin is rejected and new committed document re-injects cleanly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-v2-tc017-'));
  try {
    const pluginsRoot = path.join(dir, 'plugins');
    const addonsDir = path.join(dir, 'addons.d');
    const configPath = path.join(dir, 'config.json');
    fs.mkdirSync(addonsDir, { recursive: true });
    fs.mkdirSync(path.join(pluginsRoot, 'custom-p1'), { recursive: true });
    fs.writeFileSync(path.join(pluginsRoot, 'custom-p1', 'entry.js'), 'window.__CUSTOM_RUNS__ = (window.__CUSTOM_RUNS__ || 0) + 1;\n', 'utf8');
    fs.writeFileSync(
      path.join(addonsDir, 'custom-p1.json'),
      JSON.stringify({
        schemaVersion: 2,
        pluginId: 'custom-p1',
        displayName: 'Custom P1',
        version: '1.0.0',
        capabilities: ['renderer'],
        entry: { rendererScript: 'entry.js' },
        isolation: { noTranslate: true, i18nSelfManaged: true },
        loadOrder: 10,
      }),
      'utf8'
    );
    fs.writeFileSync(configPath, JSON.stringify({ plugins: {} }), 'utf8');

    const customProfile = {
      ...ANTIGRAVITY_HOST_PROFILE,
      id: 'custom-scheme-host',
      allowedUrlProtocols: ['app:'],
      allowedUrlHosts: ['internal.local'],
    };
    const deps = createFakeElectronDeps();
    const controller = createHostRuntimeController(
      {
        addonsDir,
        pluginsRootDir: pluginsRoot,
        configJsonPath: configPath,
        profile: customProfile,
        preloadBridgePath: PRELOAD_BRIDGE_PATH,
        kernelBundlePath: KERNEL_BUNDLE_PATH,
      },
      deps
    );
    controller.start();

    // 1) Allowed custom scheme succeeds
    const envOk = createFakeDomEnv({ url: 'app://internal.local/main' });
    const wcOk = createMockWebContents({ id: 10, url: 'app://internal.local/main', session: deps.defaultSession, ctx: envOk.ctx });
    controller.attachWebContents(wcOk);
    wcOk.emit('dom-ready');
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(envOk.win.__CUSTOM_RUNS__, 1);

    // 2) Disallowed custom host & about:blank fail closed
    for (const badUrl of ['about:blank', 'app://evil.local/main']) {
      const envBad = createFakeDomEnv({ url: 'http://127.0.0.1:4173/' });
      const wcBad = createMockWebContents({ id: 11, url: badUrl, session: deps.defaultSession, ctx: envBad.ctx });
      controller.attachWebContents(wcBad);
      wcBad.emit('dom-ready');
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(envBad.win.__CUSTOM_RUNS__, undefined);
    }

    // 3) Committed navigation (`did-navigate`) rotates docGenId and injects cleanly on fresh document
    const envNext = createFakeDomEnv({ url: 'app://internal.local/next' });
    const wcNext = createMockWebContents({ id: 12, url: 'app://internal.local/main', session: deps.defaultSession, ctx: envNext.ctx });
    controller.attachWebContents(wcNext);
    wcNext.setURL('app://internal.local/next');
    wcNext.emit('did-navigate', {}, 'app://internal.local/next');
    wcNext.emit('dom-ready');
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(envNext.win.__CUSTOM_RUNS__, 1);

    await controller.dispose();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TC-018 (Preload Nonce Single-Claim & Isolated Session Rejection): verifyFrame blocks non-defaultSession & subframes; claimNonce is single-use per docGenId', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-v2-tc018-'));
  try {
    const deps = createFakeElectronDeps();
    const controller = createHostRuntimeController(
      {
        addonsDir: path.join(dir, 'addons.d'),
        pluginsRootDir: path.join(dir, 'plugins'),
        configJsonPath: path.join(dir, 'config.json'),
        profile: ANTIGRAVITY_HOST_PROFILE,
        preloadBridgePath: PRELOAD_BRIDGE_PATH,
        kernelBundlePath: KERNEL_BUNDLE_PATH,
      },
      deps
    );
    controller.start();

    const verifyHandler = deps.ipcOn.get('addon-host:v2:verify-frame');
    const claimHandler = deps.ipcOn.get('addon-host:v2:claim-nonce');
    assert.equal(typeof verifyHandler, 'function');
    assert.equal(typeof claimHandler, 'function');

    // Non-default session rejected
    const foreignEv = {
      sender: { id: 99, session: { other: true }, getURL: () => 'http://127.0.0.1:4173/' },
      senderFrame: { parent: null, url: 'http://127.0.0.1:4173/' },
      returnValue: null,
    };
    verifyHandler(foreignEv);
    assert.equal(foreignEv.returnValue.ok, false);
    assert.equal(foreignEv.returnValue.reason, 'ERR_DISALLOWED_SESSION');

    // Subframe (`parent !== null`) rejected
    const subframeEv = {
      sender: { id: 100, session: deps.defaultSession, getURL: () => 'http://127.0.0.1:4173/' },
      senderFrame: { parent: { id: 1 }, url: 'http://127.0.0.1:4173/frame' },
      returnValue: null,
    };
    verifyHandler(subframeEv);
    assert.equal(subframeEv.returnValue.ok, false);
    assert.equal(subframeEv.returnValue.reason, 'ERR_SUBFRAME_OR_DETACHED');

    // Disallowed origin rejected
    const evilEv = {
      sender: { id: 101, session: deps.defaultSession, getURL: () => 'https://evil.example.com/' },
      senderFrame: { parent: null, url: 'https://evil.example.com/' },
      returnValue: null,
    };
    verifyHandler(evilEv);
    assert.equal(evilEv.returnValue.ok, false);
    assert.equal(evilEv.returnValue.reason, 'ERR_DISALLOWED_FRAME_URL');

    // Valid main frame verifies OK, but invalid claimNonce is rejected
    const validEv = {
      sender: { id: 102, session: deps.defaultSession, getURL: () => 'http://127.0.0.1:4173/home' },
      senderFrame: { parent: null, url: 'http://127.0.0.1:4173/home' },
      returnValue: null,
    };
    verifyHandler(validEv);
    assert.equal(validEv.returnValue.ok, true);
    claimHandler(validEv, 'wrong-nonce-1234567890');
    assert.equal(validEv.returnValue.ok, false);
    assert.equal(validEv.returnValue.reason, 'ERR_INVALID_NONCE');

    await controller.dispose();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TC-021 (Option B2 Shadow DOM & CSS Isolation + Trust Policy): v2 mountSlot returns HTMLElement inside ShadowRoot, routes styles into ShadowRoot, blocks dangerous/global CSS for restricted, and gates trusted addons via trust-policy.json', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-v2-tc021-'));
  try {
    const pluginsRoot = path.join(dir, 'plugins');
    const addonsDir = path.join(dir, 'addons.d');
    const configPath = path.join(dir, 'config.json');
    const trustPath = path.join(dir, 'trust-policy.json');
    fs.mkdirSync(addonsDir, { recursive: true });
    fs.mkdirSync(path.join(pluginsRoot, 'restricted-ui'), { recursive: true });
    fs.mkdirSync(path.join(pluginsRoot, 'trusted-transform'), { recursive: true });

    // 1) Restricted v2 UI addon (default shadow: true -> Option B2 HTMLElement inside ShadowRoot)
    fs.writeFileSync(
      path.join(pluginsRoot, 'restricted-ui', 'entry.js'),
      `
      const rootEl = addonHost.mountSlot('restricted-ui.panel', { fallbackToBody: true });
      rootEl.style.padding = '4px';
      window.__ROOT_IS_SHADOW_CHILD__ = Boolean(rootEl.getRootNode() && rootEl.getRootNode()._isShadowRoot);
      window.__ROOT_TAG__ = rootEl.tagName;
      const st = addonHost.injectStyle('base', 'body { margin: 0 } .btn, #id { color: red } @media (min-width: 1px) { .m { display: flex } }', { slotId: 'restricted-ui.panel' });
      window.__SCOPED_CSS__ = st.textContent;
      window.__SCOPED_ATTR__ = st.getAttribute('data-addon-host-style-scope');
      window.__STYLE_IN_SHADOW__ = Boolean(st.parentNode && st.parentNode._isShadowRoot);
      const errs = {};
      for (const [k, fn] of [
        ['import', () => addonHost.injectStyle('bad1', '@import url("https://evil.example/x.css");')],
        ['jsUrl', () => addonHost.injectStyle('bad2', '.a{background:url(javascript:alert(1))}')],
        ['expr', () => addonHost.injectStyle('bad3', '.a{width:expression(alert(1))}')],
        ['globalDenied', () => addonHost.injectStyle('bad4', 'body{display:none}', { scope: 'global' })],
      ]) {
        try { fn(); errs[k] = 'ALLOWED'; } catch (e) { errs[k] = e.message; }
      }
      window.__CSS_ERRORS__ = errs;
      `,
      'utf8'
    );
    fs.writeFileSync(
      path.join(addonsDir, 'restricted-ui.json'),
      JSON.stringify({
        schemaVersion: 2,
        pluginId: 'restricted-ui',
        displayName: 'Restricted UI',
        version: '1.0.0',
        trustLevel: 'restricted',
        capabilities: ['renderer'],
        entry: { rendererScript: 'entry.js' },
        uiSlots: [{ slot: 'overlay', slotId: 'restricted-ui.panel' }],
        isolation: { noTranslate: true, i18nSelfManaged: true },
        loadOrder: 10,
      }),
      'utf8'
    );

    // 2) Trusted document-transform addon (approved via SHA-256 in trust-policy.json)
    const transformScript = path.join(pluginsRoot, 'trusted-transform', 'entry.js');
    fs.writeFileSync(
      transformScript,
      `
      const st = addonHost.injectStyle('overlay', '.cursor-edit { display: block }');
      window.__GLOBAL_CSS__ = st.textContent;
      window.__GLOBAL_SCOPE__ = st.getAttribute('data-addon-host-style-scope');
      try {
        addonHost.injectStyle('bad-global', '@import url("x.css");');
        window.__GLOBAL_IMPORT_ERR__ = 'ALLOWED';
      } catch (e) {
        window.__GLOBAL_IMPORT_ERR__ = e.message;
      }
      `,
      'utf8'
    );
    fs.writeFileSync(
      path.join(addonsDir, 'trusted-transform.json'),
      JSON.stringify({
        schemaVersion: 2,
        pluginId: 'trusted-transform',
        displayName: 'Trusted Transform',
        version: '1.0.0',
        trustLevel: 'trusted',
        capabilities: ['renderer'],
        entry: { rendererScript: 'entry.js' },
        uiSlots: [{ slot: 'document-transform', slotId: 'trusted-transform.doc', scope: 'native-host-only' }],
        isolation: { noTranslate: false, i18nSelfManaged: true, respectsNoTranslate: true },
        loadOrder: 20,
      }),
      'utf8'
    );

    fs.writeFileSync(
      trustPath,
      JSON.stringify({
        schemaVersion: 1,
        approved: {
          'trusted-transform': {
            pluginId: 'trusted-transform',
            version: '1.0.0',
            rendererSha256: sha256Hex(fs.readFileSync(transformScript)),
            approvedAt: new Date().toISOString(),
          },
        },
      }),
      'utf8'
    );
    fs.writeFileSync(configPath, JSON.stringify({ plugins: {} }), 'utf8');

    const deps = createFakeElectronDeps();
    const env = createFakeDomEnv();
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
      deps
    );
    controller.start();

    const wc = createMockWebContents({ id: 21, session: deps.defaultSession, ctx: env.ctx });
    controller.attachWebContents(wc);
    wc.emit('dom-ready');
    await new Promise((r) => setTimeout(r, 60));

    assert.equal(env.win.__ROOT_IS_SHADOW_CHILD__, true, 'Option B2: rootEl.getRootNode() must be ShadowRoot');
    assert.equal(env.win.__ROOT_TAG__, 'DIV', 'Option B2: returned mountSlot value is inner HTMLElement');
    assert.equal(env.win.__STYLE_IN_SHADOW__, true, 'Targeted slotId style routes directly into ShadowRoot');
    assert.equal(env.win.__SCOPED_ATTR__, 'owner');
    assert.match(env.win.__SCOPED_CSS__, /\[data-addon-host-owner="restricted-ui"\]\s*\{\s*margin: 0\s*\}/);
    assert.equal(env.win.__CSS_ERRORS__.import, 'ERR_UNSAFE_CSS_CONSTRUCT');
    assert.equal(env.win.__CSS_ERRORS__.jsUrl, 'ERR_UNSAFE_CSS_CONSTRUCT');
    assert.equal(env.win.__CSS_ERRORS__.expr, 'ERR_UNSAFE_CSS_CONSTRUCT');
    assert.equal(env.win.__CSS_ERRORS__.globalDenied, 'ERR_RESTRICTED_GLOBAL_CSS_FORBIDDEN');

    assert.equal(env.win.__GLOBAL_SCOPE__, 'global');
    assert.match(env.win.__GLOBAL_CSS__, /\.cursor-edit/);
    assert.equal(env.win.__GLOBAL_IMPORT_ERR__, 'ERR_UNSAFE_CSS_CONSTRUCT');

    await controller.dispose();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TC-022 (Async Fault Isolation): async rejecting/hanging mainHooks, async failing renderer with cleanup, runSafe, and addManagedListener auto-detach on dispose', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-v2-tc022-'));
  try {
    const pluginsRoot = path.join(dir, 'plugins');
    const addonsDir = path.join(dir, 'addons.d');
    const configPath = path.join(dir, 'config.json');
    const trustPath = path.join(dir, 'trust-policy.json');
    fs.mkdirSync(addonsDir, { recursive: true });
    for (const id of ['async-reject-hook', 'async-timeout-hook', 'async-fail-renderer', 'healthy-peer']) {
      fs.mkdirSync(path.join(pluginsRoot, id), { recursive: true });
    }

    fs.writeFileSync(
      path.join(pluginsRoot, 'async-reject-hook', 'hook.cjs'),
      `
      let cleaned = 0;
      exports.onMainReady = async (broker) => {
        broker.onDispose(() => { cleaned++; globalThis.__TC022_REJECT_CLEANED__ = cleaned; });
        await new Promise((r) => setTimeout(r, 15));
        throw new Error('ASYNC_HOOK_BOOM');
      };
      `,
      'utf8'
    );
    fs.writeFileSync(
      path.join(pluginsRoot, 'async-timeout-hook', 'hook.cjs'),
      `
      exports.onMainReady = (broker) => {
        broker.onDispose(() => { globalThis.__TC022_TIMEOUT_CLEANED__ = true; });
        return new Promise(() => {});
      };
      `,
      'utf8'
    );
    fs.writeFileSync(
      path.join(pluginsRoot, 'async-fail-renderer', 'entry.js'),
      `
      addonHost.mountSlot('async-fail-renderer.slot', { fallbackToBody: true });
      return Promise.reject(new Error('ASYNC_RENDERER_BOOM'));
      `,
      'utf8'
    );
    fs.writeFileSync(
      path.join(pluginsRoot, 'healthy-peer', 'entry.js'),
      `
      const el = addonHost.mountSlot('healthy-peer.slot', { fallbackToBody: true });
      el.textContent = 'HEALTHY_OK';
      addonHost.runSafe(async () => { throw new Error('CONTAINED_ASYNC_ERROR'); });
      addonHost.addManagedListener(window.__FAKE_TARGET__, 'ping', async () => {
        window.__PING_COUNT__ = (window.__PING_COUNT__ || 0) + 1;
        throw new Error('CONTAINED_LISTENER_ERROR');
      });
      `,
      'utf8'
    );

    const manifests = [
      {
        schemaVersion: 2,
        pluginId: 'async-reject-hook',
        displayName: 'Reject Hook',
        version: '1.0.0',
        trustLevel: 'trusted',
        capabilities: ['mainHook'],
        entry: { mainHookScript: 'hook.cjs' },
        isolation: { noTranslate: true, i18nSelfManaged: true },
        loadOrder: 10,
      },
      {
        schemaVersion: 2,
        pluginId: 'async-timeout-hook',
        displayName: 'Timeout Hook',
        version: '1.0.0',
        trustLevel: 'trusted',
        capabilities: ['mainHook'],
        entry: { mainHookScript: 'hook.cjs' },
        isolation: { noTranslate: true, i18nSelfManaged: true },
        loadOrder: 20,
      },
      {
        schemaVersion: 2,
        pluginId: 'async-fail-renderer',
        displayName: 'Fail Renderer',
        version: '1.0.0',
        capabilities: ['renderer'],
        entry: { rendererScript: 'entry.js' },
        uiSlots: [{ slot: 'overlay', slotId: 'async-fail-renderer.slot', shadow: false }],
        isolation: { noTranslate: true, i18nSelfManaged: true },
        loadOrder: 30,
      },
      {
        schemaVersion: 2,
        pluginId: 'healthy-peer',
        displayName: 'Healthy Peer',
        version: '1.0.0',
        capabilities: ['renderer'],
        entry: { rendererScript: 'entry.js' },
        uiSlots: [{ slot: 'status-bar', slotId: 'healthy-peer.slot', shadow: false }],
        isolation: { noTranslate: true, i18nSelfManaged: true },
        loadOrder: 40,
      },
    ];
    for (const m of manifests) {
      fs.writeFileSync(path.join(addonsDir, `${m.pluginId}.json`), JSON.stringify(m), 'utf8');
    }

    fs.writeFileSync(
      trustPath,
      JSON.stringify({
        schemaVersion: 1,
        approved: {
          'async-reject-hook': {
            pluginId: 'async-reject-hook',
            version: '1.0.0',
            mainHookBundleSha256: snapshotPluginBundleInMemory(path.join(pluginsRoot, 'async-reject-hook')).bundleSha256,
          },
          'async-timeout-hook': {
            pluginId: 'async-timeout-hook',
            version: '1.0.0',
            mainHookBundleSha256: snapshotPluginBundleInMemory(path.join(pluginsRoot, 'async-timeout-hook')).bundleSha256,
          },
        },
      }),
      'utf8'
    );
    fs.writeFileSync(configPath, JSON.stringify({ plugins: {} }), 'utf8');

    const deps = createFakeElectronDeps();
    const env = createFakeDomEnv({
      anchors: { '[data-testid="status-bar"]': 'div' },
    });
    const targetListeners = new Set();
    env.win.__FAKE_TARGET__ = {
      addEventListener(_ev, fn) { targetListeners.add(fn); },
      removeEventListener(_ev, fn) { targetListeners.delete(fn); },
      emit() { for (const fn of Array.from(targetListeners)) fn(); },
    };

    const controller = createHostRuntimeController(
      {
        addonsDir,
        pluginsRootDir: pluginsRoot,
        configJsonPath: configPath,
        trustPolicyPath: trustPath,
        profile: ANTIGRAVITY_HOST_PROFILE,
        preloadBridgePath: PRELOAD_BRIDGE_PATH,
        kernelBundlePath: KERNEL_BUNDLE_PATH,
        mainHookTimeoutMs: 120,
      },
      deps
    );
    controller.start();
    await controller.reconcileMainHooks();

    const wc = createMockWebContents({ id: 22, session: deps.defaultSession, ctx: env.ctx });
    controller.attachWebContents(wc);
    wc.emit('dom-ready');
    await new Promise((r) => setTimeout(r, 220));

    const states = controller.getAddonLifecycleStates();
    assert.equal(states['async-reject-hook'], 'FAILED');
    assert.equal(states['async-timeout-hook'], 'FAILED');
    assert.equal(globalThis.__TC022_REJECT_CLEANED__, 1);
    assert.equal(globalThis.__TC022_TIMEOUT_CLEANED__, true);

    assert.equal(states['async-fail-renderer'], 'FAILED');
    assert.equal(
      env.body.children.some((c) => c.getAttribute('data-addon-host-owner') === 'async-fail-renderer'),
      false,
      'Async-failing renderer partial DOM must be cleaned up'
    );

    assert.equal(states['healthy-peer'], 'ACTIVE');
    assert.equal(targetListeners.size, 1);
    env.win.__FAKE_TARGET__.emit();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(env.win.__PING_COUNT__, 1);

    // Disable healthy-peer -> managed listener auto-detached & state DISPOSED
    fs.writeFileSync(configPath, JSON.stringify({ plugins: { 'healthy-peer': { enabled: false } } }), 'utf8');
    wc.emit('did-finish-load');
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(targetListeners.size, 0);
    assert.equal(controller.getAddonLifecycleStates()['healthy-peer'], 'DISPOSED');

    await controller.dispose();
  } finally {
    delete globalThis.__TC022_REJECT_CLEANED__;
    delete globalThis.__TC022_TIMEOUT_CLEANED__;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TC-024 (CSS Bypass Elimination, Exec Timeout & Broker Disposed Guard): blocks CSS escapes/at-rules/nesting/bad-strings, times out hanging renderer without starving peer, and guards disposed mainHook broker', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-v2-tc024-'));
  try {
    const pluginsRoot = path.join(dir, 'plugins');
    const addonsDir = path.join(dir, 'addons.d');
    const configPath = path.join(dir, 'config.json');
    const trustPath = path.join(dir, 'trust-policy.json');
    fs.mkdirSync(addonsDir, { recursive: true });
    for (const id of ['css-attacker', 'hanging-addon', 'after-hang-peer', 'slow-dispose-hook']) {
      fs.mkdirSync(path.join(pluginsRoot, id), { recursive: true });
    }

    fs.writeFileSync(
      path.join(pluginsRoot, 'css-attacker', 'entry.js'),
      `
      const blocked = {};
      const payloads = [
        ['ownerSibling', '[data-addon-host-owner="css-attacker"] ~ * { color: red }'],
        ['bodySibling', 'body ~ * { color: red }'],
        ['hexImport', '@\\\\69mport url("https://evil.example/x.css");'],
        ['hexJsUrl', '.a { background: url(j\\\\61vascript:alert(1)); }'],
        ['atScope', '@scope (body) { div { color: red } }'],
        ['atProperty', '@property --x { syntax: "*"; inherits: false; }'],
        ['atStarting', '@starting-style { body { opacity: 0 } }'],
        ['atFontFace', '@font-face { font-family: evil; }'],
        ['badStringBody', '.a { content: "\\n} body { color: red } }'],
        ['unclosedString', '.a { content: "unterminated }'],
        ['unbalancedBrace', '.a { color: red'],
        ['strayBrace', '} body { color: red }'],
        ['nestingAmpSibling', '[data-addon-host-owner="css-attacker"] { & ~ * { color: red } }'],
        ['nestingBodyHas', '[data-addon-host-owner="css-attacker"] { body:has(&) { color: red } }'],
      ];
      for (const [k, css] of payloads) {
        try { addonHost.injectStyle('b_' + k, css); blocked[k] = 'ALLOWED'; } catch (e) { blocked[k] = e.message; }
      }
      window.__TC024_CSS_BLOCKED__ = blocked;
      `,
      'utf8'
    );
    fs.writeFileSync(
      path.join(pluginsRoot, 'hanging-addon', 'entry.js'),
      `
      addonHost.mountSlot('hanging-addon.slot', { fallbackToBody: true });
      return new Promise(() => {});
      `,
      'utf8'
    );
    fs.writeFileSync(
      path.join(pluginsRoot, 'after-hang-peer', 'entry.js'),
      `
      const el = addonHost.mountSlot('after-hang-peer.slot', { fallbackToBody: true });
      el.textContent = 'SURVIVED_HANG';
      window.__AFTER_HANG_RAN__ = true;
      `,
      'utf8'
    );
    fs.writeFileSync(
      path.join(pluginsRoot, 'slow-dispose-hook', 'hook.cjs'),
      `
      exports.onMainReady = (broker) => {
        globalThis.__TC024_ACTIVATIONS__ = (globalThis.__TC024_ACTIVATIONS__ || 0) + 1;
        globalThis.__TC024_HOOK__ = { activations: globalThis.__TC024_ACTIVATIONS__, broker };
      };
      exports.dispose = () => new Promise((r) => setTimeout(r, 50));
      `,
      'utf8'
    );

    const manifests = [
      { schemaVersion: 2, pluginId: 'css-attacker', displayName: 'CSS', version: '1.0.0', capabilities: ['renderer'], entry: { rendererScript: 'entry.js' }, isolation: { noTranslate: true, i18nSelfManaged: true }, loadOrder: 10 },
      { schemaVersion: 2, pluginId: 'hanging-addon', displayName: 'Hang', version: '1.0.0', capabilities: ['renderer'], entry: { rendererScript: 'entry.js' }, uiSlots: [{ slot: 'overlay', slotId: 'hanging-addon.slot', shadow: false }], isolation: { noTranslate: true, i18nSelfManaged: true }, loadOrder: 20 },
      { schemaVersion: 2, pluginId: 'after-hang-peer', displayName: 'Peer', version: '1.0.0', capabilities: ['renderer'], entry: { rendererScript: 'entry.js' }, uiSlots: [{ slot: 'status-bar', slotId: 'after-hang-peer.slot', shadow: false }], isolation: { noTranslate: true, i18nSelfManaged: true }, loadOrder: 30 },
      { schemaVersion: 2, pluginId: 'slow-dispose-hook', displayName: 'Slow', version: '1.0.0', trustLevel: 'trusted', capabilities: ['mainHook'], entry: { mainHookScript: 'hook.cjs' }, isolation: { noTranslate: true, i18nSelfManaged: true }, loadOrder: 40 },
    ];
    for (const m of manifests) {
      fs.writeFileSync(path.join(addonsDir, `${m.pluginId}.json`), JSON.stringify(m), 'utf8');
    }
    fs.writeFileSync(
      trustPath,
      JSON.stringify({
        schemaVersion: 1,
        approved: {
          'slow-dispose-hook': {
            pluginId: 'slow-dispose-hook',
            version: '1.0.0',
            mainHookBundleSha256: snapshotPluginBundleInMemory(path.join(pluginsRoot, 'slow-dispose-hook')).bundleSha256,
          },
        },
      }),
      'utf8'
    );
    fs.writeFileSync(configPath, JSON.stringify({ plugins: {} }), 'utf8');

    const deps = createFakeElectronDeps();
    const env = createFakeDomEnv({
      anchors: { '[data-testid="status-bar"]': 'div' },
    });
    const controller = createHostRuntimeController(
      {
        addonsDir,
        pluginsRootDir: pluginsRoot,
        configJsonPath: configPath,
        trustPolicyPath: trustPath,
        profile: ANTIGRAVITY_HOST_PROFILE,
        preloadBridgePath: PRELOAD_BRIDGE_PATH,
        kernelBundlePath: KERNEL_BUNDLE_PATH,
        mainHookTimeoutMs: 200,
        rendererExecTimeoutMs: 120,
      },
      deps
    );
    controller.start();
    await controller.reconcileMainHooks();

    const wc = createMockWebContents({ id: 24, session: deps.defaultSession, ctx: env.ctx });
    controller.attachWebContents(wc);
    wc.emit('dom-ready');
    await new Promise((r) => setTimeout(r, 260));

    const b = env.win.__TC024_CSS_BLOCKED__;
    assert.equal(b.ownerSibling, 'ERR_FORBIDDEN_CSS_SELECTOR');
    assert.equal(b.bodySibling, 'ERR_FORBIDDEN_CSS_SELECTOR');
    assert.equal(b.hexImport, 'ERR_UNSAFE_CSS_CONSTRUCT');
    assert.equal(b.hexJsUrl, 'ERR_UNSAFE_CSS_CONSTRUCT');
    assert.equal(b.atScope, 'ERR_FORBIDDEN_CSS_AT_RULE');
    assert.equal(b.atProperty, 'ERR_FORBIDDEN_CSS_AT_RULE');
    assert.equal(b.atStarting, 'ERR_FORBIDDEN_CSS_AT_RULE');
    assert.equal(b.atFontFace, 'ERR_FORBIDDEN_CSS_AT_RULE');
    assert.equal(b.badStringBody, 'ERR_FORBIDDEN_CSS_SYNTAX');
    assert.equal(b.unclosedString, 'ERR_FORBIDDEN_CSS_SYNTAX');
    assert.equal(b.unbalancedBrace, 'ERR_FORBIDDEN_CSS_SYNTAX');
    assert.equal(b.strayBrace, 'ERR_FORBIDDEN_CSS_SYNTAX');
    assert.equal(b.nestingAmpSibling, 'ERR_FORBIDDEN_CSS_NESTING');
    assert.equal(b.nestingBodyHas, 'ERR_FORBIDDEN_CSS_NESTING');

    assert.equal(controller.getAddonLifecycleStates()['hanging-addon'], 'FAILED');
    assert.equal(env.body.children.some((c) => c.getAttribute('data-addon-host-owner') === 'hanging-addon'), false);
    assert.equal(env.win.__AFTER_HANG_RAN__, true, 'Healthy peer after hanging addon must still execute');

    // Disposed mainHook broker guard & serialized re-activation
    const oldBroker = globalThis.__TC024_HOOK__.broker;
    fs.writeFileSync(configPath, JSON.stringify({ plugins: { 'slow-dispose-hook': { enabled: false } } }), 'utf8');
    const disposeP = controller.reconcileMainHooks();
    fs.writeFileSync(configPath, JSON.stringify({ plugins: {} }), 'utf8');
    const reactivateP = controller.reconcileMainHooks();
    await disposeP;
    assert.throws(() => oldBroker.log('info', 'stale'), /ERR_MAIN_HOOK_BROKER_DISPOSED/);
    await reactivateP;
    assert.equal(globalThis.__TC024_HOOK__.activations, 2);
    assert.equal(controller.getAddonLifecycleStates()['slow-dispose-hook'], 'ACTIVE');

    await controller.dispose();
  } finally {
    delete globalThis.__TC024_HOOK__;
    delete globalThis.__TC024_ACTIVATIONS__;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TC-025 (Framework UI Standard v2): anchor miss returns null (never auto-opens modal), native <dialog> + popover LIFO Escape stack with focus restore, composedPath ignore guard, and Action Contribution Port', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-v2-tc025-'));
  try {
    const pluginsRoot = path.join(dir, 'plugins');
    const addonsDir = path.join(dir, 'addons.d');
    const configPath = path.join(dir, 'config.json');
    fs.mkdirSync(addonsDir, { recursive: true });
    fs.mkdirSync(path.join(pluginsRoot, 'ko-contributor'), { recursive: true });
    fs.mkdirSync(path.join(pluginsRoot, 'surface-bar'), { recursive: true });

    fs.writeFileSync(
      path.join(pluginsRoot, 'ko-contributor', 'entry.js'),
      `
      window.__MISSING_ANCHOR__ = addonHost.mountSlot('ko-contributor.overview');
      const autoSlot = addonHost.mountSlot('ko-contributor.automation');
      autoSlot.textContent = 'KO_AUTO';
      addonHost.registerAction('engine-btn', {
        label: 'Toggle Engine',
        run(arg) { window.__ACTION_ARG__ = arg; return 'RAN_OK'; },
      });
      window.__KO_HANDLE__ = addonHost;
      `,
      'utf8'
    );
    fs.writeFileSync(
      path.join(addonsDir, '01-ko-contributor.json'),
      JSON.stringify({
        schemaVersion: 2,
        pluginId: 'ko-contributor',
        displayName: 'KO Contributor',
        version: '1.0.0',
        capabilities: ['renderer'],
        entry: { rendererScript: 'entry.js' },
        uiSlots: [
          { slot: 'overview-pane', slotId: 'ko-contributor.overview', anchor: 'overview-pane' },
          { slot: 'page-section', slotId: 'ko-contributor.automation', anchor: 'automation-page' },
          { slot: 'modal', slotId: 'ko-contributor.dialog' },
          { slot: 'overlay', slotId: 'ko-contributor.popover' },
        ],
        isolation: { noTranslate: true, i18nSelfManaged: true },
        loadOrder: 20,
      }),
      'utf8'
    );

    fs.writeFileSync(
      path.join(pluginsRoot, 'surface-bar', 'entry.js'),
      `
      const s2 = addonHost.mountSlot('surface-bar.automation');
      s2.textContent = 'SB_AUTO';
      window.__ACTIONS__ = addonHost.listActions();
      window.__ACTION_RESULT__ = addonHost.invokeAction('ko-contributor', 'engine-btn', 'hello');
      `,
      'utf8'
    );
    fs.writeFileSync(
      path.join(addonsDir, '02-surface-bar.json'),
      JSON.stringify({
        schemaVersion: 2,
        pluginId: 'surface-bar',
        displayName: 'Surface Bar',
        version: '1.0.0',
        capabilities: ['renderer'],
        entry: { rendererScript: 'entry.js' },
        uiSlots: [
          { slot: 'status-bar', slotId: 'surface-bar.root', anchor: 'status-bar', exclusive: true },
          { slot: 'page-section', slotId: 'surface-bar.automation', anchor: 'automation-page' },
        ],
        isolation: { noTranslate: true, i18nSelfManaged: true },
        loadOrder: 50,
      }),
      'utf8'
    );
    fs.writeFileSync(configPath, JSON.stringify({ plugins: {} }), 'utf8');

    const deps = createFakeElectronDeps();
    const env = createFakeDomEnv({
      anchors: { '[data-testid="automation-view"]': 'div' },
    });
    const triggerBtn = env.makeNode('button');
    env.body.appendChild(triggerBtn);
    env.doc.activeElement = triggerBtn;

    const controller = createHostRuntimeController(
      {
        addonsDir,
        pluginsRootDir: pluginsRoot,
        configJsonPath: configPath,
        profile: ANTIGRAVITY_HOST_PROFILE,
        preloadBridgePath: PRELOAD_BRIDGE_PATH,
        kernelBundlePath: KERNEL_BUNDLE_PATH,
      },
      deps
    );
    controller.start();

    const wc = createMockWebContents({ id: 25, session: deps.defaultSession, ctx: env.ctx });
    controller.attachWebContents(wc);
    wc.emit('dom-ready');
    await new Promise((r) => setTimeout(r, 60));

    // Anchor miss returns null cleanly (never falls back to modal)
    assert.equal(env.win.__MISSING_ANCHOR__, null);
    assert.equal(env.anchorNodes['[data-testid="automation-view"]'].children.length, 2);
    assert.equal(env.win.__ACTION_RESULT__, 'RAN_OK');
    assert.equal(env.win.__ACTION_ARG__, 'hello');

    // Invalid slot kind rejected by openModal (FV4)
    assert.throws(
      () => env.win.__KO_HANDLE__.openModal('ko-contributor.automation'),
      /ERR_INVALID_MODAL_SLOT_KIND/
    );

    // Native <dialog> + popover LIFO Escape stack & composedPath outside-click guard
    let modalClosed = 0;
    let popClosed = 0;
    const modal = env.win.__KO_HANDLE__.openModal('ko-contributor.dialog', { onClose: () => { modalClosed++; } });
    const pop = env.win.__KO_HANDLE__.openPopover('ko-contributor.popover', {
      ignoreOutsideClickEls: [triggerBtn],
      onClose: () => { popClosed++; },
    });
    assert.equal(modal.element.open, true);
    assert.equal(pop.element.popoverOpen, true);

    // Pointerdown inside ignored triggerBtn via composedPath does NOT dismiss popover
    env.doc.dispatch('pointerdown', { target: triggerBtn, composedPath: () => [triggerBtn, env.body] });
    assert.equal(popClosed, 0);

    // First Escape closes popover only; dialog stays open
    env.win.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
    assert.equal(popClosed, 1);
    assert.equal(modalClosed, 0);
    assert.equal(modal.element.open, true);

    // Second Escape closes dialog and restores focus to triggerBtn
    triggerBtn.focused = false;
    env.win.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
    assert.equal(modalClosed, 1);
    assert.equal(triggerBtn.focused, true);

    await controller.dispose();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
