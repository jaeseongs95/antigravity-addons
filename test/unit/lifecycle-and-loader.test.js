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
      // R2-F2: duplicate pluginId in a separate manifest file must be rejected
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

test('TC-008 (F1, F2, F3, NB2): generated loader blocks traversal pluginId, enforces capability-scoped addonHost, serializes concurrent events in loadOrder, skips SPA pushState re-inject, and disposes disabled mainHooks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-loader-'));
  try {
    const pluginsRoot = path.join(dir, 'plugins');
    const addonsDir = path.join(dir, 'addons.d');
    const configPath = path.join(dir, 'config.json');
    fs.mkdirSync(addonsDir, { recursive: true });
    fs.mkdirSync(pluginsRoot, { recursive: true });

    // F1: Malicious manifest attempting pluginId traversal "../../outside"
    fs.mkdirSync(path.join(dir, 'outside'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'outside', 'evil.js'), 'window.__EVIL_RAN__ = true;\n', 'utf8');
    fs.writeFileSync(
      path.join(addonsDir, '00-evil.json'),
      JSON.stringify({
        schemaVersion: 1,
        pluginId: '../../outside',
        displayName: 'Evil',
        version: '1.0.0',
        capabilities: ['renderer'],
        entry: { rendererScript: 'evil.js', mainHookScript: null },
        isolation: { noTranslate: true, i18nSelfManaged: true },
        loadOrder: 1,
      }),
      'utf8'
    );

    // Plugin 1 (loadOrder 10): mounts declared slot, tries undeclared slot, AND hooks Map.prototype.set (R2-F3 attack)
    const p1Dir = path.join(pluginsRoot, 'plugin-first');
    fs.mkdirSync(p1Dir, { recursive: true });
    fs.writeFileSync(
      path.join(p1Dir, 'entry.js'),
      `
      window.__ORDER__ = window.__ORDER__ || [];
      window.__ORDER__.push('first');
      // R2-F3 & R3-F2 attacks: hook Map.prototype.set, Function.prototype.call, Array.prototype.slice/push
      window.__STOLEN_TOKENS__ = [];
      const origSet = Map.prototype.set;
      Map.prototype.set = function(k, v) {
        window.__STOLEN_TOKENS__.push(k);
        return origSet.call(this, k, v);
      };
      const origCall = Function.prototype.call;
      window.__FN_CALL_DURING_DISPOSE__ = 0;
      Function.prototype.call = function(thisArg, ...args) {
        if (window.__WATCH_DISPOSE_CALL__) {
          window.__FN_CALL_DURING_DISPOSE__++;
        }
        for (const a of args) {
          if (typeof a === 'string' && /^[a-f0-9]{48}$/.test(a)) {
            window.__STOLEN_TOKENS__.push(a);
          }
        }
        return origCall.apply(this, [thisArg, ...args]);
      };
      const origSlice = Array.prototype.slice;
      Array.prototype.slice = function(...args) {
        window.__SLICE_HOOKED_BY_HOST__ = (window.__SLICE_HOOKED_BY_HOST__ || 0) + 1;
        return origSlice.apply(this, args);
      };
      const origPush = Array.prototype.push;
      Array.prototype.push = function(...args) {
        window.__PUSH_HOOKED_BY_HOST__ = (window.__PUSH_HOOKED_BY_HOST__ || 0) + 1;
        return origPush.apply(this, args);
      };
      // R4-F2 attack: define Array.prototype['0'] setter to hijack arr[0]=... assignments
      window.__SETTER0_HIJACKED__ = [];
      Object.defineProperty(Array.prototype, '0', {
        configurable: true,
        set(v) { window.__SETTER0_HIJACKED__.push(v); },
        get() { return undefined; },
      });
      // R5-F3 attack: pollute Object.prototype.get to trigger TypeError on non-null-proto descriptors
      Object.defineProperty(Object.prototype, 'get', {
        configurable: true,
        writable: true,
        value: function() { return 'polluted-getter'; },
      });
      const el = addonHost.mountSlot('plugin-first.bar');
      el.textContent = 'FIRST';
      addonHost.injectStyle('theme', '.p1{color:green}');
      // R5-F5: exercise unmountSlot and removeStyle directly, then re-mount for subsequent checks
      window.__STYLE_REMOVED__ = addonHost.removeStyle('theme');
      window.__SLOT_UNMOUNTED__ = addonHost.unmountSlot('plugin-first.bar');
      const el2 = addonHost.mountSlot('plugin-first.bar');
      el2.textContent = 'FIRST_REMOUNTED';
      addonHost.injectStyle('theme', '.p1{color:blue}');
      addonHost.onDispose(function() {
        window.__FIRST_DISPOSE_THIS_TYPE__ = typeof this;
        window.__FIRST_DISPOSED__ = true;
      });
      window.__FIRST_SLOTS__ = addonHost.listOwnedSlots();
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
        uiSlots: [{ slot: 'status-bar', slotId: 'plugin-first.bar', exclusive: true }],
        isolation: { noTranslate: true, i18nSelfManaged: true, storageNamespace: 'plugin-first' },
        loadOrder: 10,
      }),
      'utf8'
    );

    // Plugin 2 (loadOrder 20): mounts slot + style BEFORE throwing (R6-F4: must be cleaned up immediately & never re-run!)
    const p2Dir = path.join(pluginsRoot, 'plugin-boom');
    fs.mkdirSync(p2Dir, { recursive: true });
    fs.writeFileSync(
      path.join(p2Dir, 'entry.js'),
      `
      window.__BOOM_RUN_COUNT__ = (window.__BOOM_RUN_COUNT__ || 0) + 1;
      addonHost.mountSlot('plugin-boom.partial');
      addonHost.injectStyle('partial-css', '.boom{display:none}');
      throw new Error("BOOM_PEER");
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

    // Plugin 3 (loadOrder 30): tries to unmount plugin-first's slot via scoped handle (must fail!) + has mainHook
    const p3Dir = path.join(pluginsRoot, 'plugin-second');
    fs.mkdirSync(p3Dir, { recursive: true });
    fs.writeFileSync(
      path.join(p3Dir, 'entry.js'),
      `
      window.__ORDER__ = window.__ORDER__ || [];
      window.__ORDER__.push('second');
      // R4-F2 & R5-F3: mounting plugin-second's declared slot + style must succeed despite Array.prototype['0'] and Object.prototype.get
      const s2 = addonHost.mountSlot('plugin-second.overlay');
      s2.textContent = 'SECOND';
      addonHost.injectStyle('overlay-css', '.p2{color:red}');
      window.__SECOND_SLOTS__ = addonHost.listOwnedSlots();
      window.__SECOND_HANDLE__ = addonHost;
      addonHost.onDispose(function() {
        'use strict';
        window.__SECOND_DISPOSE_THIS_IS_UNDEFINED__ = this === undefined;
        window.__SECOND_DISPOSED__ = true;
      });
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
      let wcCount = 0;
      module.exports = {
        activate(ctx) { ctx.app.__hookState = { get disposed(){return disposed;}, get wcCount(){return wcCount;} }; },
        onWebContentsCreated() { wcCount++; },
        dispose() { disposed++; },
      };
      `,
      'utf8'
    );
    fs.writeFileSync(
      path.join(addonsDir, 'plugin-second.json'),
      JSON.stringify({
        schemaVersion: 1,
        pluginId: 'plugin-second',
        displayName: 'Second',
        version: '1.0.0',
        capabilities: ['mainHook', 'renderer'],
        entry: { rendererScript: 'entry.js', mainHookScript: 'hook.cjs' },
        uiSlots: [{ slot: 'overlay', slotId: 'plugin-second.overlay' }],
        isolation: { noTranslate: true, i18nSelfManaged: true, storageNamespace: 'plugin-second' },
        loadOrder: 30,
      }),
      'utf8'
    );

    fs.writeFileSync(configPath, JSON.stringify({ plugins: {} }), 'utf8');

    const loaderSrc = buildHostLoaderScriptSource(
      { ADDONS_DIR: addonsDir, PLUGINS_ROOT_DIR: pluginsRoot, CONFIG_JSON_PATH: configPath },
      ANTIGRAVITY_HOST_PROFILE
    );
    const mod = { exports: {} };
    vm.runInNewContext(loaderSrc, { require, module: mod, exports: mod.exports, URL, console });

    // Minimal isolated renderer DOM sandbox
    const createdEls = [];
    const body = {
      children: [],
      appendChild(el) { el.parentNode = this; this.children.push(el); },
      removeChild(el) { this.children = this.children.filter((c) => c !== el); el.parentNode = null; },
    };
    const fakeDocument = {
      body,
      head: body,
      createElement(tag) {
        const attrs = Object.create(null);
        const el = {
          tagName: tag.toUpperCase(),
          attrs,
          setAttribute(k, v) { attrs[k] = String(v); },
          getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
          textContent: '',
          parentNode: null,
        };
        createdEls.push(el);
        return el;
      },
    };
    const rendererWindow = {
      document: fakeDocument,
      location: { protocol: 'http:', host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173' },
    };
    const rendererCtx = vm.createContext({
      window: rendererWindow,
      document: fakeDocument,
    });

    let currentUrl = 'http://127.0.0.1:4173/home';
    const listeners = {};
    let isolatedWorldCalls = 0;
    const fakeContents = {
      getType: () => 'window',
      getURL: () => currentUrl,
      on(evt, fn) { listeners[evt] = fn; },
      async executeJavaScriptInIsolatedWorld(worldId, sources) {
        assert.equal(worldId, 999);
        isolatedWorldCalls++;
        return vm.runInContext(sources[0].code, rendererCtx);
      },
      async executeJavaScript(code) {
        return vm.runInContext(code, rendererCtx);
      },
    };
    const fakeApp = {};

    mod.exports.attachWebContents(fakeContents, fakeApp);

    // F3: Fire dom-ready and did-finish-load CONCURRENTLY — must inject strictly ONCE in exact loadOrder!
    listeners['dom-ready']();
    listeners['did-finish-load']();
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(isolatedWorldCalls > 0, 'R7-NB1: must prefer executeJavaScriptInIsolatedWorld when available');

    assert.equal(rendererWindow.__EVIL_RAN__, undefined, 'F1: traversal pluginId must never execute');
    assert.deepEqual(Array.from(rendererWindow.__ORDER__), ['first', 'second'], 'F3: must execute once in strict loadOrder');
    assert.equal(rendererWindow.__BOOM_RUN_COUNT__, 1, 'R6-F4: throwing plugin runs once and is isolated');
    assert.equal(
      body.children.some((c) => c.getAttribute('data-addon-host-owner') === 'plugin-boom'),
      false,
      'R6-F4: partial slots/styles mounted before throw must be cleaned up immediately'
    );
    assert.equal(rendererWindow.__STOLEN_TOKENS__.length, 0, 'R2-F3/R3-F2: prototype hooks must steal 0 capability tokens');
    assert.equal(rendererWindow.__SLICE_HOOKED_BY_HOST__, undefined, 'R3-F2: host must not invoke Array.prototype.slice');
    assert.equal(rendererWindow.__SETTER0_HIJACKED__.length, 0, 'R4-F2: Array.prototype["0"] setter must hijack 0 values');
    assert.equal(rendererWindow.__STYLE_REMOVED__, true, 'R5-F5: removeStyle must succeed');
    assert.equal(rendererWindow.__SLOT_UNMOUNTED__, true, 'R5-F5: unmountSlot must succeed');
    assert.deepEqual(Array.from(rendererWindow.__FIRST_SLOTS__), ['plugin-first.bar'], 'R5-F3: listOwnedSlots intact despite Object.prototype.get');
    assert.deepEqual(Array.from(rendererWindow.__SECOND_SLOTS__), ['plugin-second.overlay'], 'R4-F2/R5-F3: listOwnedSlots intact despite setter & Object.prototype.get');
    // Note: plugin-second calls window.__ORDER__.push('second') once; host itself invokes Array.prototype.push 0 times
    assert.equal(rendererWindow.__PUSH_HOOKED_BY_HOST__, 1, 'R3-F2: host must not invoke Array.prototype.push');
    assert.equal(rendererWindow.__UNDECLARED_ALLOWED__, undefined, 'F2: undeclared slot must be rejected');
    assert.match(String(rendererWindow.__UNDECLARED_ERR__), /ERR_UNDECLARED_SLOT/);
    assert.equal(rendererWindow.__CROSS_UNMOUNT_ALLOWED__, undefined, 'F2: cross-plugin unmount must be rejected');
    assert.match(String(rendererWindow.__CROSS_UNMOUNT_ERR__), /ERR_FORBIDDEN_CROSS_PLUGIN_UNMOUNT/);

    // F2: Global __ADDON_HOST_API__ must NOT expose destructive methods
    assert.equal(typeof rendererWindow.__ADDON_HOST_API__.mountSlot, 'undefined');
    assert.equal(typeof rendererWindow.__ADDON_HOST_API__.unmountSlot, 'undefined');
    assert.equal(typeof rendererWindow.__ADDON_HOST_API__.disposePlugin, 'undefined');
    assert.equal(
      rendererWindow.__ADDON_HOST_API__.getNoTranslateSelector(),
      '[data-addon-host-owner], [translate="no"], [data-agy-no-translate="true"]'
    );

    // F3: SPA pushState changes URL while keeping __ADDON_HOST_API__ -> must NOT re-inject
    currentUrl = 'http://127.0.0.1:4173/settings';
    listeners['did-finish-load']();
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(Array.from(rendererWindow.__ORDER__), ['first', 'second'], 'F3: SPA URL change must not re-inject');

    // R2-F4, R5-F5, R6-F3, R6-F4, NB3: Disabling plugin-second via config.json must dispose BOTH its mainHook AND renderer handle
    // with 0 calls to polluted Function.prototype.call (Reflect.apply), must NOT re-run plugin-boom, and handle becomes unusable after dispose
    assert.equal(fakeApp.__hookState.wcCount, 1);
    assert.equal(fakeApp.__hookState.disposed, 0);
    assert.equal(rendererWindow.__SECOND_DISPOSED__, undefined);
    rendererWindow.__WATCH_DISPOSE_CALL__ = true;
    fs.writeFileSync(configPath, JSON.stringify({ plugins: { 'plugin-second': { enabled: false } } }), 'utf8');
    listeners['did-finish-load']();
    await new Promise((r) => setTimeout(r, 30));
    rendererWindow.__WATCH_DISPOSE_CALL__ = false;
    assert.equal(rendererWindow.__FN_CALL_DURING_DISPOSE__, 0, 'R6-F3: dispose() must invoke Function.prototype.call 0 times (Reflect.apply)');
    assert.equal(rendererWindow.__BOOM_RUN_COUNT__, 1, 'R6-F4: failed plugin must NOT re-execute on subsequent did-finish-load');
    assert.equal(fakeApp.__hookState.disposed, 1, 'R2-F4: disabled mainHook must be disposed on single-window reload');
    assert.equal(rendererWindow.__SECOND_DISPOSED__, true, 'R5-F5/R5-F3: disabled renderer addon must be disposed even under Object.prototype.get pollution');
    assert.equal(rendererWindow.__SECOND_DISPOSE_THIS_IS_UNDEFINED__, true, 'NB2: onDispose callback must not receive internal bucket as `this`');
    assert.equal(
      body.children.some((c) => c.getAttribute('data-addon-host-owner') === 'plugin-second'),
      false,
      'R5-F5/R5-F3: disabled renderer addon slots & styles must be removed from DOM'
    );
    assert.throws(
      () => rendererWindow.__SECOND_HANDLE__.mountSlot('plugin-second.overlay'),
      /ERR_HANDLE_DISPOSED/,
      'NB3: disposed handle must reject subsequent mountSlot calls'
    );
    mod.exports.attachWebContents({ getType: () => 'window', getURL: () => currentUrl, on() {} }, fakeApp);
    assert.equal(fakeApp.__hookState.wcCount, 1, 'F3: disabled mainHook must not receive onWebContentsCreated');

    // NB2: Diagnostics buffer must capture rejected traversal + throwing peer
    const diags = mod.exports.getDiagnostics();
    assert.ok(diags.some((d) => d.code === 'ERR_RENDERER_INJECT' && d.detail.includes('plugin-boom')));

    // R3-F1 & R4-F1: Both FULL spoofing and PARTIAL spoofing across dom-ready + did-finish-load must leak 0 secrets
    for (const mode of ['full-spoof', 'partial-register-spoof']) {
      const spoofedSecrets = [];
      const spoofWindow = { document: fakeDocument };
      if (mode === 'full-spoof') {
        Object.defineProperty(spoofWindow, '__ADDON_HOST_VERIFY__', {
          value: () => true,
          writable: false,
          configurable: false,
        });
      }
      Object.defineProperty(spoofWindow, '__ADDON_HOST_REGISTER_CAP__', {
        value: (secret, token) => { spoofedSecrets.push({ secret, token }); },
        writable: false,
        configurable: false,
      });
      const spoofCtx = vm.createContext({ window: spoofWindow, document: fakeDocument });
      const spoofListeners = {};
      mod.exports.attachWebContents(
        {
          getType: () => 'window',
          getURL: () => `http://127.0.0.1:4173/${mode}`,
          on(evt, fn) { spoofListeners[evt] = fn; },
          async executeJavaScript(code) { return vm.runInContext(code, spoofCtx); },
        },
        fakeApp
      );
      // Fire BOTH dom-ready AND did-finish-load sequentially to prove failed bootstrap never commits instanceNonce
      spoofListeners['dom-ready']();
      await new Promise((r) => setTimeout(r, 25));
      spoofListeners['did-finish-load']();
      await new Promise((r) => setTimeout(r, 25));
      assert.equal(spoofedSecrets.length, 0, `R4-F1 (${mode}): must leak 0 hostSecret/capToken across 2 events`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TC-015 (R5-F2): mid-loop async executeJavaScript redirect to disallowed origin aborts immediately without leaking hostSecret/capToken to subsequent addons', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-toctou-'));
  try {
    const pluginsRoot = path.join(dir, 'plugins');
    const addonsDir = path.join(dir, 'addons.d');
    const configPath = path.join(dir, 'config.json');
    fs.mkdirSync(addonsDir, { recursive: true });
    fs.mkdirSync(path.join(pluginsRoot, 'p-one'), { recursive: true });
    fs.mkdirSync(path.join(pluginsRoot, 'p-two'), { recursive: true });

    fs.writeFileSync(path.join(pluginsRoot, 'p-one', 'entry.js'), 'window.__P1_RAN__ = true;\n', 'utf8');
    fs.writeFileSync(path.join(pluginsRoot, 'p-two', 'entry.js'), 'window.__P2_RAN__ = true;\n', 'utf8');
    fs.writeFileSync(
      path.join(addonsDir, 'p-one.json'),
      JSON.stringify({
        schemaVersion: 1,
        pluginId: 'p-one',
        displayName: 'P1',
        version: '1.0.0',
        capabilities: ['renderer'],
        entry: { rendererScript: 'entry.js', mainHookScript: null },
        isolation: { noTranslate: true, i18nSelfManaged: true, storageNamespace: 'p-one' },
        loadOrder: 10,
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(addonsDir, 'p-two.json'),
      JSON.stringify({
        schemaVersion: 1,
        pluginId: 'p-two',
        displayName: 'P2',
        version: '1.0.0',
        capabilities: ['renderer'],
        entry: { rendererScript: 'entry.js', mainHookScript: null },
        isolation: { noTranslate: true, i18nSelfManaged: true, storageNamespace: 'p-two' },
        loadOrder: 20,
      }),
      'utf8'
    );
    fs.writeFileSync(configPath, JSON.stringify({ plugins: {} }), 'utf8');

    const loaderSrc = buildHostLoaderScriptSource(
      { ADDONS_DIR: addonsDir, PLUGINS_ROOT_DIR: pluginsRoot, CONFIG_JSON_PATH: configPath },
      ANTIGRAVITY_HOST_PROFILE
    );
    const mod = { exports: {} };
    vm.runInNewContext(loaderSrc, { require, module: mod, exports: mod.exports, URL, console });

    const rendererWindow = {
      location: { protocol: 'http:', host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173' },
    };
    const rendererCtx = vm.createContext({ window: rendererWindow, document: {} });
    let currentUrl = 'http://127.0.0.1:4173/app';
    let registerCapCount = 0;
    let isolatedCalls = 0;
    const listeners = {};

    mod.exports.attachWebContents(
      {
        getType: () => 'window',
        getURL: () => currentUrl,
        on(evt, fn) { listeners[evt] = fn; },
        async executeJavaScriptInIsolatedWorld(worldId, sources) {
          assert.equal(worldId, 999);
          isolatedCalls++;
          const code = sources[0].code;
          if (code.startsWith('window.__ADDON_HOST_REGISTER_CAP__(')) {
            registerCapCount++;
          }
          const res = vm.runInContext(code, rendererCtx);
          // Simulate mid-loop did-start-navigation + redirect to disallowed external origin right after p-one executes
          if (code.includes('window.__P1_RAN__')) {
            currentUrl = 'https://evil.example.com/phish';
            if (typeof listeners['did-start-navigation'] === 'function') {
              listeners['did-start-navigation']({}, currentUrl, false, true);
            }
          }
          return res;
        },
      },
      {}
    );

    listeners['dom-ready']();
    await new Promise((r) => setTimeout(r, 40));

    assert.ok(isolatedCalls > 0);
    assert.equal(rendererWindow.__P1_RAN__, true, 'p-one executes while origin is allowed');
    assert.equal(rendererWindow.__P2_RAN__, undefined, 'R5-F2: p-two must NOT execute after redirect');
    assert.equal(registerCapCount, 1, 'R5-F2: REGISTER_CAP must NOT be called for p-two after redirect');
    assert.ok(
      mod.exports.getDiagnostics().some((d) => d.code === 'ERR_RENDERER_TOCTOU_ABORT'),
      'R5-F2: diagnostics must record ERR_RENDERER_TOCTOU_ABORT'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TC-017 (R7-F3 & R7-F4): custom protocol origin comparison, null-origin frame rejection, mid-exec navGeneration guard, and aborted-navigation non-deadlock', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-r7-f3-f4-'));
  try {
    const pluginsRoot = path.join(dir, 'plugins');
    const addonsDir = path.join(dir, 'addons.d');
    const configPath = path.join(dir, 'config.json');
    fs.mkdirSync(addonsDir, { recursive: true });
    fs.mkdirSync(path.join(pluginsRoot, 'custom-p1'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginsRoot, 'custom-p1', 'entry.js'),
      'window.__CUSTOM_RUNS__ = (window.__CUSTOM_RUNS__ || 0) + 1;\naddonHost.onDispose(() => { window.__CUSTOM_DISPOSED__ = true; });\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(addonsDir, 'custom-p1.json'),
      JSON.stringify({
        schemaVersion: 1,
        pluginId: 'custom-p1',
        displayName: 'Custom P1',
        version: '1.0.0',
        capabilities: ['renderer'],
        entry: { rendererScript: 'entry.js', mainHookScript: null },
        isolation: { noTranslate: true, i18nSelfManaged: true, storageNamespace: 'custom-p1' },
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
    const loaderSrc = buildHostLoaderScriptSource(
      { ADDONS_DIR: addonsDir, PLUGINS_ROOT_DIR: pluginsRoot, CONFIG_JSON_PATH: configPath },
      customProfile
    );
    const mod = { exports: {} };
    vm.runInNewContext(loaderSrc, { require, module: mod, exports: mod.exports, URL, console });

    // 1) R7-F3: Custom scheme app://internal.local/main works with privileged origin AND unprivileged 'null' origin
    for (const rendererOrigin of ['app://internal.local', 'null']) {
      const win = {
        location: { protocol: 'app:', host: 'internal.local', origin: rendererOrigin },
      };
      const ctx = vm.createContext({ window: win, document: {} });
      const listeners = {};
      mod.exports.attachWebContents(
        {
          getType: () => 'window',
          getURL: () => 'app://internal.local/main',
          on(evt, fn) { listeners[evt] = fn; },
          async executeJavaScriptInIsolatedWorld(_id, sources) {
            return vm.runInContext(sources[0].code, ctx);
          },
        },
        {}
      );
      listeners['dom-ready']();
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(win.__CUSTOM_RUNS__, 1, `R7-F3: custom scheme must succeed with renderer origin="${rendererOrigin}"`);

      // 2) R7-F4: Aborted navigation (did-start-navigation -> did-fail-load on SAME live document)
      //    must NOT wipe credentials or deadlock with TypeError: Cannot redefine property
      listeners['did-start-navigation']({}, 'app://internal.local/other', false, true);
      listeners['did-fail-load']({}, -3, 'ERR_ABORTED', 'app://internal.local/other', true);
      fs.writeFileSync(configPath, JSON.stringify({ plugins: { 'custom-p1': { enabled: false } } }), 'utf8');
      listeners['did-finish-load']();
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(win.__CUSTOM_DISPOSED__, true, 'R7-F4: aborted navigation must keep live document credentials intact for dispose');
      fs.writeFileSync(configPath, JSON.stringify({ plugins: {} }), 'utf8');
    }

    // 3) R7-F3: 'null'-origin frame (about:blank) or wrong custom host (app://evil.local) must fail closed
    for (const badLoc of [
      { protocol: 'about:', host: '', origin: 'null' },
      { protocol: 'app:', host: 'evil.local', origin: 'app://evil.local' },
    ]) {
      const win = { location: badLoc };
      const ctx = vm.createContext({ window: win, document: {} });
      const listeners = {};
      mod.exports.attachWebContents(
        {
          getType: () => 'window',
          getURL: () => 'app://internal.local/main',
          on(evt, fn) { listeners[evt] = fn; },
          async executeJavaScriptInIsolatedWorld(_id, sources) {
            return vm.runInContext(sources[0].code, ctx);
          },
        },
        {}
      );
      listeners['dom-ready']();
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(win.__CUSTOM_RUNS__, undefined, `R7-F3: mismatched location ${JSON.stringify(badLoc)} must NOT execute`);
    }

    // 4) R7-F4: did-start-navigation firing DURING execInRenderer(wrapped) must NOT pollute injectedIds
    let docWin = { location: { protocol: 'app:', host: 'internal.local', origin: 'app://internal.local' } };
    let docCtx = vm.createContext({ window: docWin, document: {} });
    const navListeners = {};
    let firstExec = true;
    mod.exports.attachWebContents(
      {
        getType: () => 'window',
        getURL: () => 'app://internal.local/main',
        on(evt, fn) { navListeners[evt] = fn; },
        async executeJavaScriptInIsolatedWorld(_id, sources) {
          const code = sources[0].code;
          const res = vm.runInContext(code, docCtx);
          if (firstExec && code.includes('__CUSTOM_RUNS__')) {
            firstExec = false;
            // Fire did-start-navigation BEFORE execInRenderer resolves!
            navListeners['did-start-navigation']({}, 'app://internal.local/next', false, true);
          }
          return res;
        },
      },
      {}
    );
    navListeners['dom-ready']();
    await new Promise((r) => setTimeout(r, 30));
    // Now commit navigation to a brand-new document (did-navigate) and verify custom-p1 runs cleanly (not polluted in injectedIds)
    docWin = { location: { protocol: 'app:', host: 'internal.local', origin: 'app://internal.local' } };
    docCtx = vm.createContext({ window: docWin, document: {} });
    navListeners['did-navigate']();
    navListeners['dom-ready']();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(docWin.__CUSTOM_RUNS__, 1, 'R7-F4: new committed document must inject custom-p1 cleanly');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TC-018 (R8-F2): untrusted !trustedLocBeforeExec/catch never sends REVOKE_CAP secrets, and did-navigate during postVerify never commits credentials', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-r8-f2-'));
  try {
    const pluginsRoot = path.join(dir, 'plugins');
    const addonsDir = path.join(dir, 'addons.d');
    const configPath = path.join(dir, 'config.json');
    fs.mkdirSync(addonsDir, { recursive: true });
    fs.mkdirSync(path.join(pluginsRoot, 'p-r8'), { recursive: true });
    fs.writeFileSync(path.join(pluginsRoot, 'p-r8', 'entry.js'), 'window.__R8_RAN__ = true;\n', 'utf8');
    fs.writeFileSync(
      path.join(addonsDir, 'p-r8.json'),
      JSON.stringify({
        schemaVersion: 1,
        pluginId: 'p-r8',
        displayName: 'R8 Plugin',
        version: '1.0.0',
        capabilities: ['renderer'],
        entry: { rendererScript: 'entry.js', mainHookScript: null },
        isolation: { noTranslate: true, i18nSelfManaged: true, storageNamespace: 'p-r8' },
        loadOrder: 10,
      }),
      'utf8'
    );
    fs.writeFileSync(configPath, JSON.stringify({ plugins: {} }), 'utf8');

    const loaderSrc = buildHostLoaderScriptSource(
      { ADDONS_DIR: addonsDir, PLUGINS_ROOT_DIR: pluginsRoot, CONFIG_JSON_PATH: configPath },
      ANTIGRAVITY_HOST_PROFILE
    );
    const mod = { exports: {} };
    vm.runInNewContext(loaderSrc, { require, module: mod, exports: mod.exports, URL, console });

    // (a) !trustedLocBeforeExec: URL redirects to disallowed origin right after REGISTER_CAP
    //     -> must NOT call __ADDON_HOST_REVOKE_CAP__ (0 hostSecret/instanceNonce/capToken sent to untrusted renderer)
    {
      const win = { location: { protocol: 'http:', host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173' } };
      const ctx = vm.createContext({ window: win, document: {} });
      let currentUrl = 'http://127.0.0.1:4173/app';
      let revokeCalls = 0;
      const listeners = {};
      mod.exports.attachWebContents(
        {
          getType: () => 'window',
          getURL: () => currentUrl,
          on(evt, fn) { listeners[evt] = fn; },
          async executeJavaScriptInIsolatedWorld(_id, sources) {
            const code = sources[0].code;
            if (code.includes('window.__ADDON_HOST_REVOKE_CAP__(')) revokeCalls++;
            const res = vm.runInContext(code, ctx);
            if (code.startsWith('window.__ADDON_HOST_REGISTER_CAP__(')) {
              // Simulate renderer navigating to disallowed origin between REGISTER_CAP and execution
              currentUrl = 'https://evil.example.com/hijack';
            }
            return res;
          },
        },
        {}
      );
      listeners['dom-ready']();
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(revokeCalls, 0, 'R8-F2(a): must NEVER send REVOKE_CAP secrets to untrusted renderer');
      assert.equal(win.__R8_RAN__, undefined, 'R8-F2(a): addon must NOT execute after origin switch');
    }

    // (b) postVerify race: did-navigate to disallowed origin occurs DURING await verifyLiveNonce(nextNonce)
    //     -> must NOT commit hostSecret/instanceNonce and must call REGISTER_CAP 0 times
    {
      const win = { location: { protocol: 'http:', host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173' } };
      const ctx = vm.createContext({ window: win, document: {} });
      let currentUrl = 'http://127.0.0.1:4173/app';
      let registerCapCalls = 0;
      let verifyCalls = 0;
      const listeners = {};
      mod.exports.attachWebContents(
        {
          getType: () => 'window',
          getURL: () => currentUrl,
          on(evt, fn) { listeners[evt] = fn; },
          async executeJavaScriptInIsolatedWorld(_id, sources) {
            const code = sources[0].code;
            if (code.startsWith('window.__ADDON_HOST_REGISTER_CAP__(')) registerCapCalls++;
            const res = vm.runInContext(code, ctx);
            if (code.includes('window.__ADDON_HOST_VERIFY__(')) {
              verifyCalls++;
              // During postVerify's await verifyLiveNonce(nextNonce), simulate committed navigation to evil origin
              if (verifyCalls === 1) {
                currentUrl = 'https://evil.example.com/post-verify-race';
                listeners['did-navigate']();
              }
            }
            return res;
          },
        },
        {}
      );
      listeners['dom-ready']();
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(registerCapCalls, 0, 'R8-F2(b): postVerify race must NOT commit credentials or call REGISTER_CAP');
      assert.equal(win.__R8_RAN__, undefined, 'R8-F2(b): addon must NOT execute after postVerify race');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
