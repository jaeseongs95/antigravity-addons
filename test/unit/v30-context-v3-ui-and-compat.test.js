'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestHost, h } = require('../../packages/sdk/src');

test('TC-V30-05: AddonContextV3 enforces ISP separation (no hostProfileId, omitted undeclared capabilities) and lifecycle AbortSignal', async () => {
  const host = createTestHost({ surface: 'desktop', locale: 'ko-KR', themeMode: 'dark' });
  const ctx = await host.mountPlugin({
    schemaVersion: 3,
    pluginId: 'minimal-v3',
    displayName: 'Minimal V3',
    version: '1.0.0',
    capabilities: ['renderer'],
    entry: { rendererScript: 'index.js' },
  });

  assert.equal(ctx.apiVersion, 3);
  assert.equal(ctx.meta.pluginId, 'minimal-v3');
  assert.equal(ctx.env.surface, 'desktop');
  assert.equal(Object.prototype.hasOwnProperty.call(ctx.env, 'hostProfileId'), false);
  assert.equal(ctx.env.hostProfileId, undefined);
  assert.equal(ctx.net, undefined);
  assert.equal(ctx.dom, undefined);
  assert.equal(ctx.configBridge, undefined);
  assert.equal(ctx.i18n.getLocale(), 'ko-KR');
  assert.equal(ctx.i18n.t('greet', { ko: '안녕 {{name}}', en: 'Hi {{name}}' }, { name: 'AG' }), '안녕 AG');
  assert.equal(ctx.theme.getMode(), 'dark');
  assert.ok(ctx.theme.getTokens()['--ag-accent']);
  assert.equal(ctx.lifecycle.signal.aborted, false);

  let disposedCalled = false;
  ctx.lifecycle.onDispose(() => {
    disposedCalled = true;
  });
  host.disposePlugin('minimal-v3');
  assert.equal(disposedCalled, true);
  assert.equal(ctx.lifecycle.signal.aborted, true);
  assert.throws(() => ctx.ui.showToast('after dispose'), /ERR_PLUGIN_HANDLE_DISPOSED/);
});

test('TC-V30-06: Tier 1 UI (toast, confirm, prompt, statusItem delegation + fallback + modifiers, settingsPage)', async () => {
  const host = createTestHost({ surface: 'desktop' });
  const clicks = [];
  const ctxA = await host.mountPlugin({
    schemaVersion: 3,
    pluginId: 'plugin-a',
    displayName: 'Plugin A',
    version: '1.0.0',
    capabilities: ['renderer'],
    entry: { rendererScript: 'a.js' },
  });

  // Fallback statusbar when host.statusbar is absent
  const item = ctxA.ui.registerStatusItem({
    id: 'toggle',
    label: 'Translate',
    badge: 'ON',
    onClick: (ev) => clicks.push(ev),
  });
  assert.equal(host.getStatusItems().length, 1);
  assert.equal(host.getStatusItems()[0].delegated, false);

  // Trigger with modifier keys
  host.kernel.invokeStatusItem('plugin-a', 'toggle', { shiftKey: true, ctrlKey: false, altKey: true }, 'sdk-test-host-token-0123456789abcdef');
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].shiftKey, true);
  assert.equal(clicks[0].altKey, true);

  // BLK-01: Restricted plugin CANNOT hijack host.statusbar even by passing allowWellKnownHostServices
  assert.throws(
    () => ctxA.services.provide('host.statusbar', { registerItem() {} }, { allowWellKnownHostServices: true }),
    /ERR_SERVICE_HOST_TRUST_FORBIDDEN/
  );

  // NEW-BLK-01: World 998 primordial tampering (String.prototype.startsWith, Array.prototype.find, Map.prototype.get)
  // MUST NOT allow a restricted plugin to hijack host.statusbar or intercept delegated items
  const origStartsWith = String.prototype.startsWith;
  const origFind = Array.prototype.find;
  const origMapGet = Map.prototype.get;
  let hijackedViaMap = false;
  try {
    String.prototype.startsWith = function (prefix) {
      if (String(this) === 'host.statusbar' && prefix === 'host.') return false;
      if (String(this) === 'host.statusbar' && prefix === 'plugin-a.') return true;
      return origStartsWith.call(this, prefix);
    };
    Array.prototype.find = function () {
      return { name: 'host.statusbar', allowedCallers: ['*'] };
    };
    Map.prototype.get = function (k) {
      if (k === 'host.statusbar') {
        return {
          providerPluginId: 'plugin-a',
          name: 'host.statusbar',
          allowedCallers: ['*'],
          impl: {
            registerItem() {
              hijackedViaMap = true;
              return { dispose() {} };
            },
          },
        };
      }
      return origMapGet.call(this, k);
    };
    assert.throws(
      () => ctxA.services.provide('host.statusbar', { registerItem() {} }),
      /ERR_SERVICE_HOST_TRUST_FORBIDDEN/
    );
    const probeItem = ctxA.ui.registerStatusItem({ id: 'probe', label: 'Probe' });
    assert.equal(hijackedViaMap, false, 'NEW-BLK-01: Map.prototype.get tamper must NOT hijack host.statusbar');
    probeItem.dispose();
  } finally {
    String.prototype.startsWith = origStartsWith;
    Array.prototype.find = origFind;
    Map.prototype.get = origMapGet;
  }

  // Now mount a TRUSTED statusbar provider plugin providing `host.statusbar`
  const delegatedItems = [];
  const ctxBar = await host.mountPlugin({
    schemaVersion: 3,
    pluginId: 'statusbar-provider',
    displayName: 'Statusbar Provider',
    version: '1.0.0',
    trustLevel: 'trusted',
    capabilities: ['renderer'],
    entry: { rendererScript: 'bar.js' },
    permissions: {
      services: {
        provide: [{ name: 'host.statusbar', allowedCallers: ['*'] }],
      },
    },
  });
  ctxBar.services.provide('host.statusbar', {
    registerItem(spec) {
      delegatedItems.push(spec);
      return { dispose: () => {} };
    },
    updateItem() {},
    removeItem() {},
  });

  // Existing status item automatically re-delegates to `host.statusbar`
  assert.equal(delegatedItems.length, 1);
  assert.equal(delegatedItems[0].pluginId, 'plugin-a');
  assert.equal(host.getStatusItems()[0].delegated, true);

  // Toast with attribution badge
  const toast = ctxA.ui.showToast({ title: 'Saved', message: 'Done', variant: 'success', durationMs: 0 });
  assert.ok(toast.id);
  toast.dismiss();

  // Unified Settings Page (schema)
  const page = ctxA.ui.registerSettingsPage({
    id: 'general',
    title: 'General Settings',
    schema: h('stack', { id: 's-root' }, [h('text', { id: 's-txt', text: 'Settings Body' })]),
  });
  assert.equal(host.getSettingsPages().length, 1);
  const modal = page.open();
  assert.ok(modal);
  assert.equal(modal.attributionBadge.textContent, 'Addon: Plugin A');
  modal.close();
  item.dispose();
});

test('TC-V30-07: Tier 2 openPopup placement flip/shift, mobile bottom-sheet switch, visibleWhen, and ID in-place patch', async () => {
  const host = createTestHost({ surface: 'desktop', viewport: { width: 1000, height: 600 } });
  const ctx = await host.mountPlugin({
    schemaVersion: 3,
    pluginId: 'translator-v3',
    displayName: 'Translator V3',
    version: '1.0.0',
    capabilities: ['renderer'],
    entry: { rendererScript: 'index.js' },
  });

  // Anchor near bottom-right corner forces vertical flip (bottom -> top) and horizontal shift clamping
  const anchorEl = host.doc.createElement('button');
  anchorEl.setMockRect({ left: 900, top: 550, right: 980, bottom: 590, width: 80, height: 40 });
  host.doc.body.appendChild(anchorEl);

  const makeTree = (statusText) =>
    h('stack', { id: 'root' }, [
      h('text', { id: 'status', text: statusText }),
      h('select', { id: 'provider', field: 'provider', label: 'Provider', options: ['google', 'ollama'] }),
      h('input', {
        id: 'local-url',
        field: 'localUrl',
        label: 'Local URL',
        visibleWhen: { field: 'provider', eq: 'ollama' },
      }),
    ]);

  const popup = ctx.ui.openPopup({
    title: 'Quick Settings',
    placement: { zone: 'anchor', anchorEl, prefer: 'bottom-start', width: 320, height: 240 },
    tree: makeTree('Idle'),
    state: { provider: 'google', localUrl: 'http://127.0.0.1:11434' },
  });

  // Attribution badge is always present and host-owned
  assert.equal(popup.attributionBadge.textContent, 'Addon: Translator V3');
  assert.equal(popup.bodyEl, null); // Schema-driven overlays keep DOM host-owned

  const p1 = popup.getPlacement();
  assert.equal(p1.zone, 'anchor');
  assert.equal(p1.flipped, true);
  assert.equal(p1.resolvedSide, 'top');
  assert.equal(p1.shifted, true);
  assert.ok(p1.left + 320 <= 1000);

  // visibleWhen hides local-url when provider === 'google'
  const urlInputBefore = popup.getElementById('local-url');
  assert.ok(urlInputBefore);
  assert.equal(urlInputBefore.parentNode.hidden, true);

  // In-place ID patch preserves exact DOM element reference & updates visibleWhen
  popup.update(makeTree('Connected'), { provider: 'ollama', localUrl: 'http://127.0.0.1:11434' });
  const urlInputAfter = popup.getElementById('local-url');
  assert.equal(urlInputAfter, urlInputBefore, 'ID-based patch must preserve exact input element identity');
  assert.equal(urlInputAfter.parentNode.hidden, false);
  assert.equal(popup.getElementById('status').textContent, 'Connected');

  // Shrinking viewport <= 640px automatically switches to mobile bottom-sheet
  host.setViewport(390, 844);
  const pMobile = popup.getPlacement();
  assert.equal(pMobile.zone, 'sheet');
  assert.equal(pMobile.autoMobileSheet, true);
  popup.close();
});

test('TC-V30-08: services default-deny ACL, storage TTL + onDidChange, and v2 compat adapter coexistence', async () => {
  const host = createTestHost({ surface: 'desktop' });
  const ctxA = await host.mountPlugin({
    schemaVersion: 3,
    pluginId: 'svc-provider',
    displayName: 'Provider',
    version: '1.0.0',
    capabilities: ['renderer'],
    entry: { rendererScript: 'p.js' },
    permissions: {
      storage: { maxBytes: 120 },
      services: {
        provide: [
          { name: 'svc-provider.secret', allowedCallers: [] },
          { name: 'svc-provider.open', allowedCallers: ['svc-caller'] },
        ],
      },
    },
  });
  const ctxB = await host.mountPlugin({
    schemaVersion: 3,
    pluginId: 'svc-caller',
    displayName: 'Caller',
    version: '1.0.0',
    capabilities: ['renderer'],
    entry: { rendererScript: 'c.js' },
  });

  // BLK-01: Undeclared service rejected on v3 & runtime opts cannot widen manifest allowedCallers
  assert.throws(
    () => ctxA.services.provide('svc-provider.undeclared', { ping: () => 1 }),
    /ERR_SERVICE_NOT_DECLARED/
  );
  ctxA.services.provide(
    'svc-provider.secret',
    { ping: (x) => ({ pong: x }) },
    { allowedCallers: ['*'] } // Attempt to widen manifest's [] must be ignored
  );
  assert.throws(() => ctxB.services.call('svc-provider.secret', 'ping', 'hi'), /ERR_SERVICE_CALLER_FORBIDDEN/);

  // Explicit allowlist permits ctxB & strips __proto__
  ctxA.services.provide('svc-provider.open', {
    echo: (obj) => obj,
  });
  const res = ctxB.services.call('svc-provider.open', 'echo', JSON.parse('{"a":1,"__proto__":{"x":9}}'));
  assert.equal(res.a, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(res, '__proto__'), false);

  // Storage KV + onDidChange + TTL + NB-04 total bucket quota
  const changes = [];
  ctxA.storage.onDidChange((ev) => changes.push(ev));
  await ctxA.storage.set('k1', { n: 7 });
  assert.deepEqual(await ctxA.storage.get('k1'), { n: 7 });
  assert.equal(changes.length, 1);
  await assert.rejects(
    () => ctxA.storage.set('k2', 'x'.repeat(110)),
    /ERR_STORAGE_QUOTA_EXCEEDED/
  );
  await ctxA.storage.set('ephemeral', 'bye', { ttlMs: 1 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(await ctxA.storage.get('ephemeral'), undefined);

  // BLK-02: World 998 Object.prototype.net setter & Object.prototype.get pollution MUST NOT steal capabilities or crash
  let stolenNet = null;
  Object.defineProperty(Object.prototype, 'net', {
    configurable: true,
    set(v) {
      stolenNet = v;
    },
    get() {
      return stolenNet;
    },
  });
  Object.defineProperty(Object.prototype, 'get', {
    configurable: true,
    writable: true,
    value() {
      return 'polluted';
    },
  });
  try {
    const trustedNetCtx = await host.mountPlugin({
      schemaVersion: 3,
      pluginId: 'trusted-net-target',
      displayName: 'Trusted Net',
      version: '1.0.0',
      trustLevel: 'trusted',
      capabilities: ['renderer'],
      entry: { rendererScript: 't.js' },
      permissions: { net: { httpsHosts: ['api.example.com'] } },
    });
    assert.equal(stolenNet, null, 'BLK-02: Object.prototype.net setter must NOT steal ctx.net');
    assert.equal(typeof trustedNetCtx.net.fetch, 'function');
  } finally {
    delete Object.prototype.net;
    delete Object.prototype.get;
  }

  // v2 plugin mounted on the SAME v3 kernel receives full v2 compat adapter
  const v2Handle = await host.mountPlugin({
    schemaVersion: 2,
    pluginId: 'legacy-v2',
    displayName: 'Legacy V2',
    version: '2.0.0',
    capabilities: ['renderer'],
    entry: { rendererScript: 'v2.js' },
  });
  assert.equal(v2Handle.schemaVersion, 2);
  assert.equal(v2Handle.pluginId, 'legacy-v2');
  assert.equal(typeof v2Handle.mountSlot, 'function');
  assert.equal(typeof v2Handle.registerAction, 'function');
  assert.equal(v2Handle.v3.apiVersion, 3);
});
