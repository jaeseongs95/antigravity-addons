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
        activate(ctx) {
          globalThis.__TC008_HOOK_STATE__ = {
            get disposed(){ return disposed; },
            get wcCount(){ return wcCount; },
            appFrozen: Object.isFrozen(ctx.app),
            appQuitHidden: typeof ctx.app.quit === 'undefined',
          };
        },
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
    assert.equal(globalThis.__TC008_HOOK_STATE__.appFrozen, true, 'P1: mainHook ctx.app broker must be frozen');
    assert.equal(globalThis.__TC008_HOOK_STATE__.appQuitHidden, true, 'P1: mainHook ctx.app broker must hide raw app.quit');
    assert.equal(globalThis.__TC008_HOOK_STATE__.wcCount, 1);
    assert.equal(globalThis.__TC008_HOOK_STATE__.disposed, 0);
    assert.equal(rendererWindow.__SECOND_DISPOSED__, undefined);
    rendererWindow.__WATCH_DISPOSE_CALL__ = true;
    fs.writeFileSync(configPath, JSON.stringify({ plugins: { 'plugin-second': { enabled: false } } }), 'utf8');
    listeners['did-finish-load']();
    await new Promise((r) => setTimeout(r, 30));
    rendererWindow.__WATCH_DISPOSE_CALL__ = false;
    assert.equal(rendererWindow.__FN_CALL_DURING_DISPOSE__, 0, 'R6-F3: dispose() must invoke Function.prototype.call 0 times (Reflect.apply)');
    assert.equal(rendererWindow.__BOOM_RUN_COUNT__, 1, 'R6-F4: failed plugin must NOT re-execute on subsequent did-finish-load');
    assert.equal(globalThis.__TC008_HOOK_STATE__.disposed, 1, 'R2-F4: disabled mainHook must be disposed on single-window reload');
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
    assert.equal(globalThis.__TC008_HOOK_STATE__.wcCount, 1, 'F3: disabled mainHook must not receive onWebContentsCreated');

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
    delete globalThis.__TC008_HOOK_STATE__;
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
    delete globalThis.__TC008_HOOK_STATE__;
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
    delete globalThis.__TC008_HOOK_STATE__;
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

test('TC-021 (P1): CSS owner auto-scoping, dangerous CSS rejection, global scope enforcement, shadow mount, and least-privilege mainHook/contents brokers with auto-cleanup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-tc021-'));
  try {
    const pluginsRoot = path.join(dir, 'plugins');
    const addonsDir = path.join(dir, 'addons.d');
    const configPath = path.join(dir, 'config.json');
    fs.mkdirSync(addonsDir, { recursive: true });
    fs.mkdirSync(path.join(pluginsRoot, 'restricted-ui'), { recursive: true });
    fs.mkdirSync(path.join(pluginsRoot, 'trusted-transform'), { recursive: true });
    fs.mkdirSync(path.join(pluginsRoot, 'trusted-hook'), { recursive: true });

    // 1) Restricted UI addon: owner auto-scoping, shadow mount, dangerous CSS & global scope rejection
    fs.writeFileSync(
      path.join(pluginsRoot, 'restricted-ui', 'entry.js'),
      `
      const shadowRoot = addonHost.mountSlot('restricted-ui.panel', null, { shadow: true });
      window.__SHADOW_ATTACHED__ = Boolean(shadowRoot && shadowRoot.__isShadowRoot);
      const st = addonHost.injectStyle('base', 'body { margin: 0 } .btn, #id { color: red } @media (min-width: 1px) { .m { display: flex } } @keyframes spin { from { opacity: 0 } to { opacity: 1 } }');
      window.__SCOPED_CSS__ = st.textContent;
      window.__SCOPED_ATTR__ = st.getAttribute('data-addon-host-style-scope');
      window.__TRUST_LEVEL__ = addonHost.trustLevel;
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
        schemaVersion: 1,
        pluginId: 'restricted-ui',
        displayName: 'Restricted UI',
        version: '1.0.0',
        trustLevel: 'restricted',
        capabilities: ['renderer'],
        entry: { rendererScript: 'entry.js', mainHookScript: null },
        uiSlots: [{ slot: 'overlay', slotId: 'restricted-ui.panel' }],
        isolation: { noTranslate: true, i18nSelfManaged: true, storageNamespace: 'restricted-ui' },
        loadOrder: 10,
      }),
      'utf8'
    );

    // 2) Trusted document-transform addon: global style scope allowed (still blocks @import)
    fs.writeFileSync(
      path.join(pluginsRoot, 'trusted-transform', 'entry.js'),
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
        schemaVersion: 1,
        pluginId: 'trusted-transform',
        displayName: 'Trusted Transform',
        version: '1.0.0',
        trustLevel: 'trusted',
        capabilities: ['renderer'],
        entry: { rendererScript: 'entry.js', mainHookScript: null },
        uiSlots: [{ slot: 'document-transform', slotId: 'trusted-transform.doc', scope: 'native-host-only' }],
        isolation: { noTranslate: false, i18nSelfManaged: true, respectsNoTranslate: true, storageNamespace: 'trusted-transform' },
        loadOrder: 20,
      }),
      'utf8'
    );

    // 3) Trusted mainHook addon: tests least-privilege app & webContents brokers + auto-cleanup on dispose
    fs.writeFileSync(
      path.join(pluginsRoot, 'trusted-hook', 'hook.cjs'),
      `
      module.exports = {
        activate(ctx) {
          const probe = {
            appFrozen: Object.isFrozen(ctx.app),
            quitHidden: typeof ctx.app.quit === 'undefined',
            exitHidden: typeof ctx.app.exit === 'undefined',
            relaunchHidden: typeof ctx.app.relaunch === 'undefined',
            version: ctx.app.getVersion(),
            userData: ctx.app.getPath('userData'),
          };
          try { ctx.app.getPath('exe'); probe.exePathErr = 'ALLOWED'; } catch (e) { probe.exePathErr = e.message; }
          ctx.app.onBeforeQuit(() => {});
          globalThis.__TC021_BROKER_PROBE__ = probe;
        },
        async onWebContentsCreated({ contents }) {
          const p = globalThis.__TC021_BROKER_PROBE__;
          p.wcFrozen = Object.isFrozen(contents);
          p.loadUrlHidden = typeof contents.loadURL === 'undefined';
          p.sessionHidden = typeof contents.session === 'undefined';
          p.rawExecHidden = typeof contents.executeJavaScript === 'undefined';
          try { contents.on('will-navigate', () => {}); p.badEvtErr = 'ALLOWED'; } catch (e) { p.badEvtErr = e.message; }
          contents.on('dom-ready', () => {});
          contents.on('did-finish-load', () => {});
          try {
            await contents.executeJavaScriptInIsolatedWorld(0, [{ code: '1' }], true);
            p.world0Err = 'ALLOWED';
          } catch (e) {
            p.world0Err = e.message;
          }
          p.allowedExecResult = await contents.executeInIsolatedWorld('1 + 41');
        },
        dispose() {},
      };
      `,
      'utf8'
    );
    fs.writeFileSync(
      path.join(addonsDir, 'trusted-hook.json'),
      JSON.stringify({
        schemaVersion: 1,
        pluginId: 'trusted-hook',
        displayName: 'Trusted Hook',
        version: '1.0.0',
        trustLevel: 'trusted',
        capabilities: ['mainHook'],
        entry: { rendererScript: null, mainHookScript: 'hook.cjs' },
        isolation: { noTranslate: true, i18nSelfManaged: true, storageNamespace: 'trusted-hook' },
        loadOrder: 30,
      }),
      'utf8'
    );
    fs.writeFileSync(configPath, JSON.stringify({ plugins: {} }), 'utf8');

    const loaderSrc = buildHostLoaderScriptSource(
      { ADDONS_DIR: addonsDir, PLUGINS_ROOT_DIR: pluginsRoot, CONFIG_JSON_PATH: configPath },
      ANTIGRAVITY_HOST_PROFILE,
      { strictTrustPolicy: true }
    );
    const mod = { exports: {} };
    vm.runInNewContext(loaderSrc, { require, module: mod, exports: mod.exports, URL, console, setTimeout, clearTimeout });

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
        return {
          tagName: tag.toUpperCase(),
          attrs,
          shadowRoot: null,
          attachShadow() { this.shadowRoot = { __isShadowRoot: true }; return this.shadowRoot; },
          setAttribute(k, v) { attrs[k] = String(v); },
          getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
          textContent: '',
          parentNode: null,
        };
      },
    };
    const win = {
      document: fakeDocument,
      location: { protocol: 'http:', host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173' },
    };
    const ctx = vm.createContext({ window: win, document: fakeDocument });

    const appListeners = new Map();
    const fakeApp = {
      getVersion: () => '2.33.0',
      getPath: (name) => `/fake/${name}`,
      quit() { throw new Error('MUST_NOT_EXPOSE_QUIT'); },
      exit() { throw new Error('MUST_NOT_EXPOSE_EXIT'); },
      relaunch() { throw new Error('MUST_NOT_EXPOSE_RELAUNCH'); },
      on(ev, fn) { if (!appListeners.has(ev)) appListeners.set(ev, new Set()); appListeners.get(ev).add(fn); },
      removeListener(ev, fn) { if (appListeners.has(ev)) appListeners.get(ev).delete(fn); },
    };

    const currentUrl = 'http://127.0.0.1:4173/app';
    const wcListeners = new Map();
    const fakeContents = {
      getType: () => 'window',
      getURL: () => currentUrl,
      isDestroyed: () => false,
      loadURL() { throw new Error('MUST_NOT_EXPOSE_LOADURL'); },
      session: { secret: true },
      on(ev, fn) { if (!wcListeners.has(ev)) wcListeners.set(ev, new Set()); wcListeners.get(ev).add(fn); },
      removeListener(ev, fn) { if (wcListeners.has(ev)) wcListeners.get(ev).delete(fn); },
      async executeJavaScriptInIsolatedWorld(worldId, sources) {
        assert.equal(worldId, 999);
        return vm.runInContext(sources[0].code, ctx);
      },
    };

    mod.exports.attachWebContents(fakeContents, fakeApp);
    for (const fn of Array.from(wcListeners.get('dom-ready') || [])) fn();
    await new Promise((r) => setTimeout(r, 40));

    // Verify CSS auto-scoping & danger filtering
    assert.equal(win.__SHADOW_ATTACHED__, true);
    assert.equal(win.__TRUST_LEVEL__, 'restricted');
    assert.equal(win.__SCOPED_ATTR__, 'owner');
    assert.match(win.__SCOPED_CSS__, /\[data-addon-host-owner="restricted-ui"\]\s*\{\s*margin: 0\s*\}/);
    assert.match(win.__SCOPED_CSS__, /\[data-addon-host-owner="restricted-ui"\] \.btn, \[data-addon-host-owner="restricted-ui"\] #id/);
    assert.match(win.__SCOPED_CSS__, /@media \(min-width: 1px\)\s*\{\s*\[data-addon-host-owner="restricted-ui"\] \.m/);
    assert.match(win.__SCOPED_CSS__, /@keyframes spin/);
    assert.equal(win.__CSS_ERRORS__.import, 'ERR_FORBIDDEN_CSS_CONSTRUCT');
    assert.equal(win.__CSS_ERRORS__.jsUrl, 'ERR_FORBIDDEN_CSS_CONSTRUCT');
    assert.equal(win.__CSS_ERRORS__.expr, 'ERR_FORBIDDEN_CSS_CONSTRUCT');
    assert.match(win.__CSS_ERRORS__.globalDenied, /ERR_FORBIDDEN_GLOBAL_STYLE_SCOPE/);

    // Verify trusted document-transform global CSS allowance + @import guard
    assert.equal(win.__GLOBAL_SCOPE__, 'global');
    assert.match(win.__GLOBAL_CSS__, /\.cursor-edit/);
    assert.equal(win.__GLOBAL_IMPORT_ERR__, 'ERR_FORBIDDEN_CSS_CONSTRUCT');

    // Verify mainHook & webContents least-privilege brokers
    const p = globalThis.__TC021_BROKER_PROBE__;
    assert.equal(p.appFrozen, true);
    assert.equal(p.quitHidden, true);
    assert.equal(p.exitHidden, true);
    assert.equal(p.relaunchHidden, true);
    assert.equal(p.version, '2.33.0');
    assert.equal(p.userData, '/fake/userData');
    assert.match(p.exePathErr, /ERR_FORBIDDEN_APP_PATH:exe/);
    assert.equal(p.wcFrozen, true);
    assert.equal(p.loadUrlHidden, true);
    assert.equal(p.sessionHidden, true);
    assert.equal(p.rawExecHidden, true);
    assert.match(p.badEvtErr, /ERR_FORBIDDEN_WEBCONTENTS_EVENT:will-navigate/);
    assert.match(p.world0Err, /ERR_FORBIDDEN_WORLD_ID:0/);
    assert.equal(p.allowedExecResult, 42);
    assert.equal((appListeners.get('before-quit') || new Set()).size, 1);
    const wcDomReadyBeforeDispose = (wcListeners.get('dom-ready') || new Set()).size;
    assert.ok(wcDomReadyBeforeDispose >= 2);

    // Disable trusted-hook -> broker must auto-detach BOTH before-quit and webContents listeners!
    fs.writeFileSync(configPath, JSON.stringify({ plugins: { 'trusted-hook': { enabled: false } } }), 'utf8');
    mod.exports.syncMainHooks(fakeApp);
    assert.equal((appListeners.get('before-quit') || new Set()).size, 0, 'P1: before-quit listener must auto-detach on dispose');
    assert.equal(
      (wcListeners.get('dom-ready') || new Set()).size,
      wcDomReadyBeforeDispose - 1,
      'P1: webContents listener must auto-detach on dispose'
    );
  } finally {
    delete globalThis.__TC021_BROKER_PROBE__;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TC-022 (P1): async fault isolation (mainHook rejection/timeout, renderer Promise rejection, runSafe, addManagedListener) and explicit lifecycle state machine', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-tc022-'));
  try {
    const pluginsRoot = path.join(dir, 'plugins');
    const addonsDir = path.join(dir, 'addons.d');
    const configPath = path.join(dir, 'config.json');
    fs.mkdirSync(addonsDir, { recursive: true });
    for (const id of ['async-reject-hook', 'async-timeout-hook', 'async-fail-renderer', 'healthy-peer']) {
      fs.mkdirSync(path.join(pluginsRoot, id), { recursive: true });
    }

    // 1) Async rejecting mainHook (registers before-quit listener BEFORE rejecting -> must auto-clean)
    fs.writeFileSync(
      path.join(pluginsRoot, 'async-reject-hook', 'hook.cjs'),
      `
      module.exports = {
        async activate(ctx) {
          ctx.app.onBeforeQuit(() => {});
          await new Promise((r) => setTimeout(r, 15));
          throw new Error('ASYNC_HOOK_BOOM');
        },
      };
      `,
      'utf8'
    );
    fs.writeFileSync(
      path.join(addonsDir, '01-async-reject-hook.json'),
      JSON.stringify({
        schemaVersion: 1,
        pluginId: 'async-reject-hook',
        displayName: 'Async Reject Hook',
        version: '1.0.0',
        trustLevel: 'trusted',
        capabilities: ['mainHook'],
        entry: { rendererScript: null, mainHookScript: 'hook.cjs' },
        isolation: { noTranslate: true, i18nSelfManaged: true, storageNamespace: 'async-reject-hook' },
        loadOrder: 10,
      }),
      'utf8'
    );

    // 2) Async hanging mainHook -> times out at mainHookTimeoutMs: 120
    fs.writeFileSync(
      path.join(pluginsRoot, 'async-timeout-hook', 'hook.cjs'),
      `
      module.exports = {
        activate(ctx) {
          ctx.app.onBeforeQuit(() => {});
          return new Promise(() => {});
        },
      };
      `,
      'utf8'
    );
    fs.writeFileSync(
      path.join(addonsDir, '02-async-timeout-hook.json'),
      JSON.stringify({
        schemaVersion: 1,
        pluginId: 'async-timeout-hook',
        displayName: 'Async Timeout Hook',
        version: '1.0.0',
        trustLevel: 'trusted',
        capabilities: ['mainHook'],
        entry: { rendererScript: null, mainHookScript: 'hook.cjs' },
        isolation: { noTranslate: true, i18nSelfManaged: true, storageNamespace: 'async-timeout-hook' },
        loadOrder: 20,
      }),
      'utf8'
    );

    // 3) Renderer addon returning a rejected Promise after mounting a partial slot
    fs.writeFileSync(
      path.join(pluginsRoot, 'async-fail-renderer', 'entry.js'),
      `
      addonHost.mountSlot('async-fail-renderer.slot');
      return Promise.reject(new Error('ASYNC_RENDERER_BOOM'));
      `,
      'utf8'
    );
    fs.writeFileSync(
      path.join(addonsDir, '03-async-fail-renderer.json'),
      JSON.stringify({
        schemaVersion: 1,
        pluginId: 'async-fail-renderer',
        displayName: 'Async Fail Renderer',
        version: '1.0.0',
        capabilities: ['renderer'],
        entry: { rendererScript: 'entry.js', mainHookScript: null },
        uiSlots: [{ slot: 'overlay', slotId: 'async-fail-renderer.slot' }],
        isolation: { noTranslate: true, i18nSelfManaged: true, storageNamespace: 'async-fail-renderer' },
        loadOrder: 30,
      }),
      'utf8'
    );

    // 4) Healthy peer using runSafe + addManagedListener (auto-cleaned on dispose)
    fs.writeFileSync(
      path.join(pluginsRoot, 'healthy-peer', 'entry.js'),
      `
      const el = addonHost.mountSlot('healthy-peer.slot');
      el.textContent = 'HEALTHY_OK';
      window.__RUN_SAFE_DONE__ = addonHost.runSafe(async () => {
        throw new Error('CONTAINED_ASYNC_ERROR');
      });
      addonHost.addManagedListener(window.__FAKE_TARGET__, 'ping', async () => {
        window.__PING_COUNT__ = (window.__PING_COUNT__ || 0) + 1;
        throw new Error('CONTAINED_LISTENER_ERROR');
      });
      `,
      'utf8'
    );
    fs.writeFileSync(
      path.join(addonsDir, '04-healthy-peer.json'),
      JSON.stringify({
        schemaVersion: 1,
        pluginId: 'healthy-peer',
        displayName: 'Healthy Peer',
        version: '1.0.0',
        capabilities: ['renderer'],
        entry: { rendererScript: 'entry.js', mainHookScript: null },
        uiSlots: [{ slot: 'status-bar', slotId: 'healthy-peer.slot' }],
        isolation: { noTranslate: true, i18nSelfManaged: true, storageNamespace: 'healthy-peer' },
        loadOrder: 40,
      }),
      'utf8'
    );
    fs.writeFileSync(configPath, JSON.stringify({ plugins: {} }), 'utf8');

    const loaderSrc = buildHostLoaderScriptSource(
      { ADDONS_DIR: addonsDir, PLUGINS_ROOT_DIR: pluginsRoot, CONFIG_JSON_PATH: configPath },
      ANTIGRAVITY_HOST_PROFILE,
      { mainHookTimeoutMs: 120 }
    );
    const mod = { exports: {} };
    vm.runInNewContext(loaderSrc, { require, module: mod, exports: mod.exports, URL, console, setTimeout, clearTimeout });

    const beforeQuitSet = new Set();
    const fakeApp = {
      on(ev, fn) { if (ev === 'before-quit') beforeQuitSet.add(fn); },
      removeListener(ev, fn) { if (ev === 'before-quit') beforeQuitSet.delete(fn); },
    };

    const targetListeners = new Set();
    const fakeTarget = {
      addEventListener(_ev, fn) { targetListeners.add(fn); },
      removeEventListener(_ev, fn) { targetListeners.delete(fn); },
      emit() { for (const fn of Array.from(targetListeners)) fn(); },
    };
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
        return {
          tagName: tag.toUpperCase(),
          attrs,
          setAttribute(k, v) { attrs[k] = String(v); },
          getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
          textContent: '',
          parentNode: null,
        };
      },
    };
    const win = {
      document: fakeDocument,
      __FAKE_TARGET__: fakeTarget,
      location: { protocol: 'http:', host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173' },
    };
    const ctx = vm.createContext({ window: win, document: fakeDocument });
    const listeners = {};
    mod.exports.attachWebContents(
      {
        getType: () => 'window',
        getURL: () => 'http://127.0.0.1:4173/home',
        on(ev, fn) { listeners[ev] = fn; },
        async executeJavaScriptInIsolatedWorld(_id, sources) {
          return vm.runInContext(sources[0].code, ctx);
        },
      },
      fakeApp
    );

    listeners['dom-ready']();
    await new Promise((r) => setTimeout(r, 200));

    const states = mod.exports.getAddonLifecycleStates();
    assert.equal(states['async-reject-hook'].mainHook.state, 'FAILED');
    assert.match(states['async-reject-hook'].mainHook.lastError, /ASYNC_HOOK_BOOM/);
    assert.equal(states['async-timeout-hook'].mainHook.state, 'FAILED');
    assert.match(states['async-timeout-hook'].mainHook.lastError, /ERR_MAIN_HOOK_ACTIVATE_TIMEOUT/);
    assert.equal(beforeQuitSet.size, 0, 'P1: failed/timed-out async mainHooks must auto-clean broker listeners');

    assert.equal(states['async-fail-renderer'].renderer.state, 'FAILED');
    assert.match(states['async-fail-renderer'].renderer.lastError, /ASYNC_RENDERER_BOOM/);
    assert.equal(
      body.children.some((c) => c.getAttribute('data-addon-host-owner') === 'async-fail-renderer'),
      false,
      'P1: async-failing renderer addon partial slots must be cleaned up'
    );

    assert.equal(states['healthy-peer'].renderer.state, 'ACTIVE');
    assert.equal(targetListeners.size, 1);
    fakeTarget.emit();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(win.__PING_COUNT__, 1);

    // Disable healthy-peer -> managed listener must be removed automatically and state transitions to DISPOSED
    fs.writeFileSync(configPath, JSON.stringify({ plugins: { 'healthy-peer': { enabled: false } } }), 'utf8');
    listeners['did-finish-load']();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(targetListeners.size, 0, 'P1: addManagedListener must auto-detach on dispose');
    assert.equal(mod.exports.getAddonLifecycleStates()['healthy-peer'].renderer.state, 'DISPOSED');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TC-024 (R1-F1, R1-F2, R1-F3 & NB2/NB4): CSS bypass elimination, renderer exec timeout + polluted Promise immunity, mainHook disposed broker guard + async dispose serialization, and renderer error reader', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-tc024-'));
  try {
    const pluginsRoot = path.join(dir, 'plugins');
    const addonsDir = path.join(dir, 'addons.d');
    const configPath = path.join(dir, 'config.json');
    fs.mkdirSync(addonsDir, { recursive: true });
    for (const id of ['css-attacker', 'hanging-addon', 'pollute-and-reject', 'after-hang-peer', 'slow-dispose-hook']) {
      fs.mkdirSync(path.join(pluginsRoot, id), { recursive: true });
    }

    // 1) R1-F1: CSS attacker attempting :not(), :is(), ~ sibling, hex @\69mport, @scope, @property, @starting-style, @\6d edia
    fs.writeFileSync(
      path.join(pluginsRoot, 'css-attacker', 'entry.js'),
      `
      const sNot = addonHost.injectStyle('not', ':not([data-addon-host-owner="css-attacker"]) { color: red }');
      const sIs = addonHost.injectStyle('is', ':is([data-addon-host-owner="css-attacker"], body) { color: red }');
      window.__TC024_CSS_NOT__ = sNot.textContent;
      window.__TC024_CSS_IS__ = sIs.textContent;
      const blocked = {};
      const payloads = [
        ['ownerSibling', '[data-addon-host-owner="css-attacker"] ~ * { color: red }'],
        ['bodySibling', 'body ~ * { color: red }'],
        ['bodyClassPlus', 'body.dark + div { color: red }'],
        ['hexImport', '@\\\\69mport url("https://evil.example/x.css");'],
        ['hexJsUrl', '.a { background: url(j\\\\61vascript:alert(1)); }'],
        ['atScope', '@scope (body) { div { color: red } }'],
        ['atProperty', '@property --x { syntax: "*"; inherits: false; }'],
        ['atStarting', '@starting-style { body { opacity: 0 } }'],
        ['atEscMedia', '@\\\\6d edia screen { .a { color: red } }'],
        ['atFontFace', '@font-face { font-family: evil; }'],
      ];
      for (const [k, css] of payloads) {
        try { addonHost.injectStyle('b_' + k, css); blocked[k] = 'ALLOWED'; } catch (e) { blocked[k] = e.message; }
      }
      window.__TC024_CSS_BLOCKED__ = blocked;
      // R1-F2: Also pollute Promise.prototype.catch and Promise.resolve to attack subsequent plugins
      Promise.prototype.catch = function() { throw new Error('HIJACKED_PROMISE_CATCH'); };
      Promise.resolve = function() { throw new Error('HIJACKED_PROMISE_RESOLVE'); };
      `,
      'utf8'
    );
    fs.writeFileSync(
      path.join(addonsDir, '01-css-attacker.json'),
      JSON.stringify({
        schemaVersion: 1,
        pluginId: 'css-attacker',
        displayName: 'CSS Attacker',
        version: '1.0.0',
        trustLevel: 'restricted',
        capabilities: ['renderer'],
        entry: { rendererScript: 'entry.js', mainHookScript: null },
        uiSlots: [{ slot: 'overlay', slotId: 'css-attacker.slot' }],
        isolation: { noTranslate: true, i18nSelfManaged: true, storageNamespace: 'css-attacker' },
        loadOrder: 10,
      }),
      'utf8'
    );

    // 2) R1-F2: Plugin returning rejected Promise AFTER Promise.prototype.catch & Promise.resolve were polluted
    fs.writeFileSync(
      path.join(pluginsRoot, 'pollute-and-reject', 'entry.js'),
      `
      addonHost.mountSlot('pollute-and-reject.slot');
      return new Promise((_, reject) => reject(new Error('POLLUTED_REJECT_CAUGHT')));
      `,
      'utf8'
    );
    fs.writeFileSync(
      path.join(addonsDir, '02-pollute-and-reject.json'),
      JSON.stringify({
        schemaVersion: 1,
        pluginId: 'pollute-and-reject',
        displayName: 'Pollute Reject',
        version: '1.0.0',
        capabilities: ['renderer'],
        entry: { rendererScript: 'entry.js', mainHookScript: null },
        uiSlots: [{ slot: 'overlay', slotId: 'pollute-and-reject.slot' }],
        isolation: { noTranslate: true, i18nSelfManaged: true, storageNamespace: 'pollute-and-reject' },
        loadOrder: 20,
      }),
      'utf8'
    );

    // 3) R1-F2: Hanging renderer addon (unresolved Promise) -> must time out & clean partial DOM without starving peer!
    fs.writeFileSync(
      path.join(pluginsRoot, 'hanging-addon', 'entry.js'),
      `
      addonHost.mountSlot('hanging-addon.slot');
      return new Promise(() => {});
      `,
      'utf8'
    );
    fs.writeFileSync(
      path.join(addonsDir, '03-hanging-addon.json'),
      JSON.stringify({
        schemaVersion: 1,
        pluginId: 'hanging-addon',
        displayName: 'Hanging Addon',
        version: '1.0.0',
        capabilities: ['renderer'],
        entry: { rendererScript: 'entry.js', mainHookScript: null },
        uiSlots: [{ slot: 'overlay', slotId: 'hanging-addon.slot' }],
        isolation: { noTranslate: true, i18nSelfManaged: true, storageNamespace: 'hanging-addon' },
        loadOrder: 30,
      }),
      'utf8'
    );

    // 4) R1-F2: Healthy peer AFTER hanging-addon -> MUST still run to ACTIVE!
    fs.writeFileSync(
      path.join(pluginsRoot, 'after-hang-peer', 'entry.js'),
      `
      const el = addonHost.mountSlot('after-hang-peer.slot');
      el.textContent = 'SURVIVED_HANG';
      addonHost.reportError(new Error('RECORDED_DIAG_ERR'));
      window.__AFTER_HANG_RAN__ = true;
      `,
      'utf8'
    );
    fs.writeFileSync(
      path.join(addonsDir, '04-after-hang-peer.json'),
      JSON.stringify({
        schemaVersion: 1,
        pluginId: 'after-hang-peer',
        displayName: 'After Hang Peer',
        version: '1.0.0',
        capabilities: ['renderer'],
        entry: { rendererScript: 'entry.js', mainHookScript: null },
        uiSlots: [{ slot: 'status-bar', slotId: 'after-hang-peer.slot' }],
        isolation: { noTranslate: true, i18nSelfManaged: true, storageNamespace: 'after-hang-peer' },
        loadOrder: 40,
      }),
      'utf8'
    );

    // 5) R1-F3 & NB2: mainHook testing broker disposed-guard, slow async dispose serialization, & destroyed contents cleanup
    fs.writeFileSync(
      path.join(pluginsRoot, 'slow-dispose-hook', 'hook.cjs'),
      `
      let activations = 0;
      module.exports = {
        activate(ctx) {
          activations++;
          globalThis.__TC024_HOOK__ = {
            activations,
            appBridge: ctx.app,
            wcBridge: null,
          };
        },
        onWebContentsCreated({ contents }) {
          if (globalThis.__TC024_HOOK__) globalThis.__TC024_HOOK__.wcBridge = contents;
          contents.on('dom-ready', () => {});
        },
        dispose() {
          return new Promise((r) => setTimeout(r, 60));
        },
      };
      `,
      'utf8'
    );
    fs.writeFileSync(
      path.join(addonsDir, '05-slow-dispose-hook.json'),
      JSON.stringify({
        schemaVersion: 1,
        pluginId: 'slow-dispose-hook',
        displayName: 'Slow Dispose Hook',
        version: '1.0.0',
        trustLevel: 'trusted',
        capabilities: ['mainHook'],
        entry: { rendererScript: null, mainHookScript: 'hook.cjs' },
        isolation: { noTranslate: true, i18nSelfManaged: true, storageNamespace: 'slow-dispose-hook' },
        loadOrder: 50,
      }),
      'utf8'
    );
    fs.writeFileSync(configPath, JSON.stringify({ plugins: {} }), 'utf8');

    const loaderSrc = buildHostLoaderScriptSource(
      { ADDONS_DIR: addonsDir, PLUGINS_ROOT_DIR: pluginsRoot, CONFIG_JSON_PATH: configPath },
      ANTIGRAVITY_HOST_PROFILE,
      { mainHookTimeoutMs: 120, rendererExecTimeoutMs: 120 }
    );
    const mod = { exports: {} };
    vm.runInNewContext(loaderSrc, { require, module: mod, exports: mod.exports, URL, console, setTimeout, clearTimeout });

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
        return {
          tagName: tag.toUpperCase(),
          attrs,
          setAttribute(k, v) { attrs[k] = String(v); },
          getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
          textContent: '',
          parentNode: null,
        };
      },
    };
    const win = {
      document: fakeDocument,
      location: { protocol: 'http:', host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173' },
    };
    const ctx = vm.createContext({ window: win, document: fakeDocument });

    const wcListeners = new Map();
    const fakeContents = {
      getType: () => 'window',
      getURL: () => 'http://127.0.0.1:4173/app',
      isDestroyed: () => false,
      on(ev, fn) { if (!wcListeners.has(ev)) wcListeners.set(ev, new Set()); wcListeners.get(ev).add(fn); },
      removeListener(ev, fn) { if (wcListeners.has(ev)) wcListeners.get(ev).delete(fn); },
      async executeJavaScriptInIsolatedWorld(_id, sources) {
        return vm.runInContext(sources[0].code, ctx);
      },
    };
    const fakeApp = { on() {}, removeListener() {} };

    mod.exports.attachWebContents(fakeContents, fakeApp);
    for (const fn of Array.from(wcListeners.get('dom-ready') || [])) fn();
    await new Promise((r) => setTimeout(r, 260));

    // Verify R1-F1 CSS bypass defenses
    assert.match(win.__TC024_CSS_NOT__, /^\[data-addon-host-owner="css-attacker"\] :not\(/);
    assert.match(win.__TC024_CSS_IS__, /^\[data-addon-host-owner="css-attacker"\] :is\(/);
    assert.equal(win.__TC024_CSS_BLOCKED__.ownerSibling, 'ERR_FORBIDDEN_CSS_SELECTOR');
    assert.equal(win.__TC024_CSS_BLOCKED__.bodySibling, 'ERR_FORBIDDEN_CSS_SELECTOR');
    assert.equal(win.__TC024_CSS_BLOCKED__.bodyClassPlus, 'ERR_FORBIDDEN_CSS_SELECTOR');
    assert.equal(win.__TC024_CSS_BLOCKED__.hexImport, 'ERR_FORBIDDEN_CSS_CONSTRUCT');
    assert.equal(win.__TC024_CSS_BLOCKED__.hexJsUrl, 'ERR_FORBIDDEN_CSS_CONSTRUCT');
    assert.equal(win.__TC024_CSS_BLOCKED__.atScope, 'ERR_FORBIDDEN_CSS_AT_RULE');
    assert.equal(win.__TC024_CSS_BLOCKED__.atProperty, 'ERR_FORBIDDEN_CSS_AT_RULE');
    assert.equal(win.__TC024_CSS_BLOCKED__.atStarting, 'ERR_FORBIDDEN_CSS_AT_RULE');
    assert.equal(win.__TC024_CSS_BLOCKED__.atEscMedia, 'ERR_FORBIDDEN_CSS_AT_RULE');
    assert.equal(win.__TC024_CSS_BLOCKED__.atFontFace, 'ERR_FORBIDDEN_CSS_AT_RULE');

    // Verify R1-F2 polluted Promise immunity + hanging addon timeout + healthy peer survival
    const states = mod.exports.getAddonLifecycleStates();
    assert.equal(states['pollute-and-reject'].renderer.state, 'FAILED');
    assert.match(states['pollute-and-reject'].renderer.lastError, /POLLUTED_REJECT_CAUGHT/);
    assert.equal(body.children.some((c) => c.getAttribute('data-addon-host-owner') === 'pollute-and-reject'), false);

    assert.equal(states['hanging-addon'].renderer.state, 'FAILED');
    assert.match(states['hanging-addon'].renderer.lastError, /ERR_RENDERER_EXEC_TIMEOUT/);
    assert.equal(body.children.some((c) => c.getAttribute('data-addon-host-owner') === 'hanging-addon'), false);

    assert.equal(win.__AFTER_HANG_RAN__, true, 'R1-F2: healthy peer after hanging addon must NOT be starved');
    assert.equal(states['after-hang-peer'].renderer.state, 'ACTIVE');

    // Verify NB4: host-authenticated collectRendererErrors reads __ADDON_HOST_GET_ERRORS__
    const peerErrs = await mod.exports.collectRendererErrors(fakeContents, 'after-hang-peer');
    assert.ok(peerErrs.some((e) => e.message === 'RECORDED_DIAG_ERR'));

    // Verify NB2: emitting destroyed on a second contents immediately removes its plugin listeners
    const tempListeners = new Map();
    const tempContents = {
      getType: () => 'window',
      getURL: () => 'http://127.0.0.1:4173/temp',
      isDestroyed: () => false,
      on(ev, fn) { if (!tempListeners.has(ev)) tempListeners.set(ev, new Set()); tempListeners.get(ev).add(fn); },
      removeListener(ev, fn) { if (tempListeners.has(ev)) tempListeners.get(ev).delete(fn); },
      async executeJavaScriptInIsolatedWorld() { return true; },
    };
    mod.exports.attachWebContents(tempContents, fakeApp);
    assert.ok((tempListeners.get('dom-ready') || new Set()).size >= 2);
    for (const fn of Array.from(tempListeners.get('destroyed') || [])) fn();
    assert.equal((tempListeners.get('dom-ready') || new Set()).size, 1, 'NB2: plugin listener removed immediately on destroyed');

    // Verify R1-F3: disable slow-dispose-hook -> old bridges MUST reject immediately with ERR_MAIN_HOOK_DISPOSED
    const oldAppBridge = globalThis.__TC024_HOOK__.appBridge;
    const oldWcBridge = globalThis.__TC024_HOOK__.wcBridge;
    fs.writeFileSync(configPath, JSON.stringify({ plugins: { 'slow-dispose-hook': { enabled: false } } }), 'utf8');
    mod.exports.syncMainHooks(fakeApp);
    assert.throws(() => oldAppBridge.onBeforeQuit(() => {}), /ERR_MAIN_HOOK_DISPOSED/);
    assert.throws(() => oldWcBridge.on('dom-ready', () => {}), /ERR_MAIN_HOOK_DISPOSED/);
    await assert.rejects(() => oldWcBridge.executeInIsolatedWorld('1'), /ERR_MAIN_HOOK_DISPOSED/);

    // Immediately re-enable while 60ms async dispose is still in flight -> must serialize & end in ACTIVE (never overwritten by stale DISPOSED!)
    fs.writeFileSync(configPath, JSON.stringify({ plugins: {} }), 'utf8');
    mod.exports.syncMainHooks(fakeApp);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(globalThis.__TC024_HOOK__.activations, 2, 'R1-F3: re-activation must run after async dispose settles');
    assert.equal(mod.exports.getAddonLifecycleStates()['slow-dispose-hook'].mainHook.state, 'ACTIVE', 'R1-F3: stale async dispose must NOT overwrite new ACTIVE state');
  } finally {
    delete globalThis.__TC024_HOOK__;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TC-025 (Framework UI Standard): multi-region anchors with loadOrder ordering, host modal/popover stack (ESC, focus restore, ignoreOutsideClickEls, cross-plugin guard), and Action Contribution Port', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-tc025-'));
  try {
    const pluginsRoot = path.join(dir, 'plugins');
    const addonsDir = path.join(dir, 'addons.d');
    const configPath = path.join(dir, 'config.json');
    fs.mkdirSync(addonsDir, { recursive: true });
    fs.mkdirSync(path.join(pluginsRoot, 'surface-bar'), { recursive: true });
    fs.mkdirSync(path.join(pluginsRoot, 'ko-contributor'), { recursive: true });

    // 1) Contributor plugin (loadOrder 20): mounts into automation-page anchor, registers status-bar action, opens popover + nested dialog
    fs.writeFileSync(
      path.join(pluginsRoot, 'ko-contributor', 'entry.js'),
      `
      window.__KO_MISSING_ANCHOR__ = addonHost.mountSlot('ko-contributor.overview');
      const autoSlot = addonHost.mountSlot('ko-contributor.automation');
      autoSlot.textContent = 'KO_AUTO';
      addonHost.registerAction({
        surface: 'status-bar',
        id: 'engine-btn',
        label: '번역:구글',
        title: '번역 설정',
        description: '번역 엔진 전환',
        order: 30,
        onClick(ctx) {
          window.__LAST_ACTION_CTX__ = { shift: Boolean(ctx.event && ctx.event.shiftKey), sessionId: ctx.sessionId };
          addonHost.updateAction('engine-btn', { label: '번역:LLM' });
        },
      });
      window.__KO_MODAL_API__ = addonHost;
      `,
      'utf8'
    );
    fs.writeFileSync(
      path.join(addonsDir, '01-ko-contributor.json'),
      JSON.stringify({
        schemaVersion: 1,
        pluginId: 'ko-contributor',
        displayName: 'KO Contributor',
        version: '1.0.0',
        trustLevel: 'restricted',
        capabilities: ['renderer'],
        entry: { rendererScript: 'entry.js', mainHookScript: null },
        uiSlots: [
          { slot: 'overview-pane', slotId: 'ko-contributor.overview', anchor: 'overview-pane' },
          { slot: 'page-section', slotId: 'ko-contributor.automation', anchor: 'automation-page' },
          { slot: 'modal', slotId: 'ko-contributor.popover' },
          { slot: 'modal', slotId: 'ko-contributor.dialog' },
        ],
        isolation: { noTranslate: true, i18nSelfManaged: true, storageNamespace: 'ko-contributor' },
        loadOrder: 20,
      }),
      'utf8'
    );

    // 2) Surface owner plugin (loadOrder 50): mounts into SAME automation-page anchor (ordered AFTER loadOrder 20) & subscribes to status-bar actions
    fs.writeFileSync(
      path.join(pluginsRoot, 'surface-bar', 'entry.js'),
      `
      const autoSlot2 = addonHost.mountSlot('surface-bar.automation');
      autoSlot2.textContent = 'SB_AUTO';
      window.__ACTION_UPDATES__ = [];
      window.__INITIAL_ACTIONS__ = addonHost.listActions('status-bar');
      addonHost.onActionsChanged('status-bar', (list) => {
        window.__ACTION_UPDATES__.push(list.map((a) => a.label));
      });
      window.__SB_HANDLE__ = addonHost;
      `,
      'utf8'
    );
    fs.writeFileSync(
      path.join(addonsDir, '02-surface-bar.json'),
      JSON.stringify({
        schemaVersion: 1,
        pluginId: 'surface-bar',
        displayName: 'Surface Bar',
        version: '1.0.0',
        trustLevel: 'restricted',
        capabilities: ['renderer'],
        entry: { rendererScript: 'entry.js', mainHookScript: null },
        uiSlots: [
          { slot: 'status-bar', slotId: 'surface-bar.root', exclusive: true },
          { slot: 'page-section', slotId: 'surface-bar.automation', anchor: 'automation-page' },
        ],
        isolation: { noTranslate: true, i18nSelfManaged: true, storageNamespace: 'surface-bar' },
        loadOrder: 50,
      }),
      'utf8'
    );
    fs.writeFileSync(configPath, JSON.stringify({ plugins: {} }), 'utf8');

    const loaderSrc = buildHostLoaderScriptSource(
      { ADDONS_DIR: addonsDir, PLUGINS_ROOT_DIR: pluginsRoot, CONFIG_JSON_PATH: configPath },
      ANTIGRAVITY_HOST_PROFILE
    );
    const mod = { exports: {} };
    vm.runInNewContext(loaderSrc, { require, module: mod, exports: mod.exports, URL, console, setTimeout, clearTimeout });

    function makeNode(tag) {
      const attrs = Object.create(null);
      const listeners = Object.create(null);
      const node = {
        tagName: tag.toUpperCase(),
        attrs,
        style: {},
        children: [],
        parentNode: null,
        textContent: '',
        focused: false,
        setAttribute(k, v) { attrs[k] = String(v); },
        getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
        appendChild(ch) { ch.parentNode = this; this.children.push(ch); return ch; },
        insertBefore(ch, ref) {
          ch.parentNode = this;
          const idx = ref ? this.children.indexOf(ref) : -1;
          if (idx === -1) this.children.push(ch);
          else this.children.splice(idx, 0, ch);
          return ch;
        },
        removeChild(ch) { this.children = this.children.filter((c) => c !== ch); ch.parentNode = null; },
        contains(target) {
          if (target === this) return true;
          return this.children.some((c) => typeof c.contains === 'function' && c.contains(target));
        },
        addEventListener(ev, fn) { if (!listeners[ev]) listeners[ev] = []; listeners[ev].push(fn); },
        removeEventListener(ev, fn) { if (listeners[ev]) listeners[ev] = listeners[ev].filter((f) => f !== fn); },
        dispatch(ev, evtObj) { for (const fn of (listeners[ev] || []).slice()) fn(evtObj); },
        focus() { this.focused = true; },
        getBoundingClientRect() { return { top: 700, bottom: 730, left: 800, right: 920 }; },
      };
      return node;
    }

    const body = makeNode('body');
    const automationView = makeNode('div');
    automationView.setAttribute('data-testid', 'automation-view');
    body.appendChild(automationView);
    const triggerBtn = makeNode('button');
    body.appendChild(triggerBtn);

    const winListeners = Object.create(null);
    const fakeDocument = {
      body,
      head: body,
      activeElement: triggerBtn,
      createElement: makeNode,
      querySelector(sel) {
        if (sel === '[data-testid="automation-view"]') return automationView;
        if (sel === 'body') return body;
        return null;
      },
    };
    const win = {
      document: fakeDocument,
      innerWidth: 1280,
      innerHeight: 800,
      location: { protocol: 'http:', host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173' },
      addEventListener(ev, fn) { if (!winListeners[ev]) winListeners[ev] = []; winListeners[ev].push(fn); },
      removeEventListener(ev, fn) { if (winListeners[ev]) winListeners[ev] = winListeners[ev].filter((f) => f !== fn); },
      dispatch(ev, evtObj) { for (const fn of (winListeners[ev] || []).slice()) fn(evtObj); },
    };
    const ctx = vm.createContext({ window: win, document: fakeDocument });
    const listeners = {};
    mod.exports.attachWebContents(
      {
        getType: () => 'window',
        getURL: () => 'http://127.0.0.1:4173/app',
        on(ev, fn) { listeners[ev] = fn; },
        async executeJavaScriptInIsolatedWorld(_id, sources) {
          return vm.runInContext(sources[0].code, ctx);
        },
      },
      {}
    );

    listeners['dom-ready']();
    await new Promise((r) => setTimeout(r, 40));

    // 1) Multi-region anchors & deterministic loadOrder ordering
    assert.equal(win.__KO_MISSING_ANCHOR__, null, 'Unmounted anchor returns null cleanly');
    assert.equal(automationView.children.length, 2);
    assert.equal(automationView.children[0].getAttribute('data-addon-host-owner'), 'ko-contributor');
    assert.equal(automationView.children[1].getAttribute('data-addon-host-owner'), 'surface-bar');

    // 2) Host-Neutral Action Contribution Port (loadOrder-independent + dynamic label + event forwarding)
    assert.equal(win.__INITIAL_ACTIONS__.length, 1);
    assert.equal(win.__INITIAL_ACTIONS__[0].label, '번역:구글');
    win.__INITIAL_ACTIONS__[0].invoke({ event: { shiftKey: true }, buttonEl: triggerBtn, sessionId: 'sess-1' });
    assert.deepEqual({ ...win.__LAST_ACTION_CTX__ }, { shift: true, sessionId: 'sess-1' });
    assert.deepEqual(Array.from(win.__ACTION_UPDATES__[0]), ['번역:LLM']);

    // 3) Host Standard Popover + Nested Modal Stack (zIndex, ignoreOutsideClickEls, ESC top-most only, focus restore, cross-plugin guard)
    let popoverClosedCount = 0;
    let dialogClosedCount = 0;
    const pop = win.__KO_MODAL_API__.openModal('ko-contributor.popover', {
      mode: 'popover',
      anchorEl: triggerBtn,
      placement: 'top-end',
      ignoreOutsideClickEls: [triggerBtn],
      onClose: () => { popoverClosedCount++; },
    });
    assert.equal(pop.rootEl.getAttribute('data-addon-host-owner'), 'ko-contributor');
    assert.ok(pop.rootEl.style.bottom, 'Popover positioned above bottom anchor');
    // Clicking ignored trigger button must NOT dismiss popover
    win.dispatch('mousedown', { target: triggerBtn });
    assert.equal(win.__KO_MODAL_API__.isModalOpen('ko-contributor.popover'), true);

    // Open nested centered dialog on top of popover
    const dlg = win.__KO_MODAL_API__.openModal('ko-contributor.dialog', {
      mode: 'dialog',
      title: '한글 번역 설정',
      badge: 'v2.2.0',
      onClose: () => { dialogClosedCount++; },
    });
    assert.ok(dlg.zIndex > pop.zIndex, 'Nested dialog stacks strictly above popover');
    assert.throws(
      () => win.__SB_HANDLE__.closeModal('ko-contributor.dialog'),
      /ERR_FORBIDDEN_CROSS_PLUGIN_MODAL/,
      'Cross-plugin modal close must be rejected'
    );

    // First ESC closes ONLY top-most dialog (popover stays open!)
    win.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
    assert.equal(dialogClosedCount, 1);
    assert.equal(win.__KO_MODAL_API__.isModalOpen('ko-contributor.dialog'), false);
    assert.equal(win.__KO_MODAL_API__.isModalOpen('ko-contributor.popover'), true);

    // Second ESC closes popover and restores focus to triggerBtn
    triggerBtn.focused = false;
    win.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
    assert.equal(popoverClosedCount, 1);
    assert.equal(triggerBtn.focused, true, 'Closing modal/popover restores focus to previousFocusEl');

    // Disable ko-contributor -> action automatically removed & surface-bar notified
    fs.writeFileSync(configPath, JSON.stringify({ plugins: { 'ko-contributor': { enabled: false } } }), 'utf8');
    listeners['did-finish-load']();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(win.__SB_HANDLE__.listActions('status-bar').length, 0, 'Disposed contributor actions auto-removed');
    assert.equal(automationView.children.length, 1, 'Disposed contributor slot removed from shared page anchor');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
