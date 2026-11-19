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
    ],
    { isEnabled: (id) => id !== 'plugin-disabled' }
  );

  assert.deepEqual(
    plan.active.map((a) => a.pluginId),
    ['plugin-a', 'plugin-b']
  );
  assert.equal(plan.disabled.length, 1);
  assert.equal(plan.disabled[0].pluginId, 'plugin-disabled');
  assert.equal(plan.rejected.length, 1);
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

    // Plugin 1 (loadOrder 10): mounts declared slot & tries to mount undeclared slot
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

    // Plugin 2 (loadOrder 20): throws (must not block Plugin 3)
    const p2Dir = path.join(pluginsRoot, 'plugin-boom');
    fs.mkdirSync(p2Dir, { recursive: true });
    fs.writeFileSync(path.join(p2Dir, 'entry.js'), 'throw new Error("BOOM_PEER");\n', 'utf8');
    fs.writeFileSync(
      path.join(addonsDir, 'plugin-boom.json'),
      JSON.stringify({
        schemaVersion: 1,
        pluginId: 'plugin-boom',
        displayName: 'Boom',
        version: '1.0.0',
        capabilities: ['renderer'],
        entry: { rendererScript: 'entry.js', mainHookScript: null },
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
        const attrs = new Map();
        const el = {
          tagName: tag.toUpperCase(),
          attrs,
          setAttribute(k, v) { attrs.set(k, String(v)); },
          getAttribute(k) { return attrs.get(k) ?? null; },
          textContent: '',
          parentNode: null,
        };
        createdEls.push(el);
        return el;
      },
    };
    const rendererWindow = { document: fakeDocument };
    const rendererCtx = vm.createContext({
      window: rendererWindow,
      document: fakeDocument,
      Map,
      Set,
      Error,
      Object,
      String,
      Array,
      Boolean,
    });

    let currentUrl = 'http://127.0.0.1:4173/home';
    const listeners = {};
    const fakeContents = {
      getType: () => 'window',
      getURL: () => currentUrl,
      on(evt, fn) { listeners[evt] = fn; },
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

    assert.equal(rendererWindow.__EVIL_RAN__, undefined, 'F1: traversal pluginId must never execute');
    assert.deepEqual(Array.from(rendererWindow.__ORDER__), ['first', 'second'], 'F3: must execute once in strict loadOrder');
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

    // F3: Disabling plugin-second via config.json must dispose its mainHook and stop onWebContentsCreated
    assert.equal(fakeApp.__hookState.wcCount, 1);
    assert.equal(fakeApp.__hookState.disposed, 0);
    fs.writeFileSync(configPath, JSON.stringify({ plugins: { 'plugin-second': { enabled: false } } }), 'utf8');
    mod.exports.attachWebContents({ getType: () => 'window', getURL: () => currentUrl, on() {} }, fakeApp);
    assert.equal(fakeApp.__hookState.disposed, 1, 'F3: disabled mainHook must be disposed');
    assert.equal(fakeApp.__hookState.wcCount, 1, 'F3: disabled mainHook must not receive onWebContentsCreated');

    // NB2: Diagnostics buffer must capture rejected traversal + throwing peer
    const diags = mod.exports.getDiagnostics();
    assert.ok(diags.some((d) => d.code === 'ERR_RENDERER_INJECT' && d.detail.includes('plugin-boom')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
