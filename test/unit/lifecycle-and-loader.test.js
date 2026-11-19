'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { planAddonExecution } = require('../../src/core/lifecycle-coordinator');
const {
  isAllowedHubUrl,
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

test('TC-007: isAllowedHubUrl permits only local HTTP(S) URLs', () => {
  assert.equal(isAllowedHubUrl('http://127.0.0.1:4173/'), true);
  assert.equal(isAllowedHubUrl('https://localhost:5387/app'), true);
  assert.equal(isAllowedHubUrl('devtools://devtools/bundled/inspector.html'), false);
  assert.equal(isAllowedHubUrl('file:///C:/index.html'), false);
  assert.equal(isAllowedHubUrl('https://evil.example.com/'), false);
});

test('TC-008: generated host loader enforces fault isolation, config.json enabled gate, and DOM translate=no ownership', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-loader-'));
  try {
    const pluginsRoot = path.join(dir, 'plugins');
    const addonsDir = path.join(dir, 'addons.d');
    const configPath = path.join(dir, 'config.json');
    fs.mkdirSync(addonsDir, { recursive: true });

    // 1) Throwing plugin (must NOT block healthy peer)
    const badDir = path.join(pluginsRoot, 'bad-plugin');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'entry.js'), 'throw new Error("BOOM_BAD_PLUGIN");\n', 'utf8');
    fs.writeFileSync(
      path.join(addonsDir, 'bad-plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        pluginId: 'bad-plugin',
        displayName: 'Bad',
        version: '1.0.0',
        capabilities: ['renderer'],
        entry: { rendererScript: 'entry.js', mainHookScript: null },
        isolation: { noTranslate: true, i18nSelfManaged: true },
        loadOrder: 10,
      }),
      'utf8'
    );

    // 2) Healthy plugin mounting an isolated slot
    const goodDir = path.join(pluginsRoot, 'good-plugin');
    fs.mkdirSync(goodDir, { recursive: true });
    fs.writeFileSync(
      path.join(goodDir, 'entry.js'),
      'const el = window.__ADDON_HOST_API__.mountSlot("good-plugin", "good-plugin.bar"); el.textContent = "OK";\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(addonsDir, 'good-plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        pluginId: 'good-plugin',
        displayName: 'Good',
        version: '1.0.0',
        capabilities: ['renderer'],
        entry: { rendererScript: 'entry.js', mainHookScript: null },
        isolation: { noTranslate: true, i18nSelfManaged: true },
        loadOrder: 20,
      }),
      'utf8'
    );

    // 3) Disabled plugin via config.json
    const offDir = path.join(pluginsRoot, 'off-plugin');
    fs.mkdirSync(offDir, { recursive: true });
    fs.writeFileSync(path.join(offDir, 'entry.js'), 'window.__OFF_RAN__ = true;\n', 'utf8');
    fs.writeFileSync(
      path.join(addonsDir, 'off-plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        pluginId: 'off-plugin',
        displayName: 'Off',
        version: '1.0.0',
        capabilities: ['renderer'],
        entry: { rendererScript: 'entry.js', mainHookScript: null },
        isolation: { noTranslate: true, i18nSelfManaged: true },
        loadOrder: 30,
      }),
      'utf8'
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify({ plugins: { 'off-plugin': { enabled: false } } }),
      'utf8'
    );

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
      appendChild(el) {
        el.parentNode = this;
        this.children.push(el);
      },
      removeChild(el) {
        this.children = this.children.filter((c) => c !== el);
        el.parentNode = null;
      },
    };
    const fakeDocument = {
      body,
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
    const rendererCtx = vm.createContext({ window: rendererWindow, document: fakeDocument, Map, Set, Error, Object, String });

    const listeners = {};
    const fakeContents = {
      getType: () => 'window',
      getURL: () => 'http://127.0.0.1:4173/',
      on(evt, fn) { listeners[evt] = fn; },
      async executeJavaScript(code) {
        vm.runInContext(code, rendererCtx);
      },
    };

    mod.exports.attachWebContents(fakeContents, {});
    listeners['dom-ready']();
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(rendererWindow.__OFF_RAN__, undefined, 'Disabled plugin must not execute');
    assert.equal(createdEls.length, 1, 'Healthy plugin must execute even when peer threw');
    const slotEl = createdEls[0];
    assert.equal(slotEl.getAttribute('translate'), 'no');
    assert.equal(slotEl.getAttribute('data-agy-no-translate'), 'true');
    assert.equal(slotEl.getAttribute('data-addon-host-owner'), 'good-plugin');
    assert.equal(slotEl.getAttribute('data-addon-host-slot'), 'good-plugin.bar');

    // Cross-plugin unmount must be rejected
    assert.throws(
      () => rendererWindow.__ADDON_HOST_API__.unmountSlot('bad-plugin', 'good-plugin.bar'),
      /ERR_FORBIDDEN_CROSS_PLUGIN_UNMOUNT/
    );
    assert.equal(
      rendererWindow.__ADDON_HOST_API__.getNoTranslateSelector(),
      '[data-addon-host-owner], [translate="no"], [data-agy-no-translate="true"]'
    );

    // Owner-scoped style injection blocks cross-plugin overwrite
    const styleEl = rendererWindow.__ADDON_HOST_API__.injectStyle('good-plugin', 'good-theme', '.x{color:red}');
    assert.equal(styleEl.getAttribute('data-addon-host-owner'), 'good-plugin');
    assert.throws(
      () => rendererWindow.__ADDON_HOST_API__.injectStyle('bad-plugin', 'good-theme', '.x{color:blue}'),
      /ERR_STYLE_OWNED_BY_ANOTHER_PLUGIN/
    );
    assert.equal(rendererWindow.__ADDON_HOST_API__.removeStyle('good-plugin', 'good-theme'), true);
    assert.equal(rendererWindow.__ADDON_HOST_API__.unmountSlot('good-plugin', 'good-plugin.bar'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
