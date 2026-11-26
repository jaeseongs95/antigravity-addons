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

  // R3-BLK-01..04 & R3-NB-03: Adversarial World 998 prototype-pollution regression suite
  const victimCtx = await host.mountPlugin({
    schemaVersion: 3,
    pluginId: 'r3-victim',
    displayName: 'R3 Victim',
    version: '1.0.0',
    trustLevel: 'trusted',
    capabilities: ['renderer'],
    entry: { rendererScript: 'v.js' },
    permissions: {
      services: {
        provide: [
          { name: 'r3-victim.secret', allowedCallers: ['trusted-partner'] },
          { name: 'r3-victim.defaultdeny' },
          { name: 'r3-victim.echo', allowedCallers: ['*'] },
        ],
      },
    },
  });
  const partnerCtx = await host.mountPlugin({
    schemaVersion: 3,
    pluginId: 'trusted-partner',
    displayName: 'Trusted Partner',
    version: '1.0.0',
    capabilities: ['renderer'],
    entry: { rendererScript: 'tp.js' },
  });
  const evilCtx = await host.mountPlugin({
    schemaVersion: 3,
    pluginId: 'r3-evil',
    displayName: 'R3 Evil',
    version: '1.0.0',
    capabilities: ['renderer'],
    entry: { rendererScript: 'e.js' },
    permissions: { storage: { maxBytes: 1024 } },
  });

  // R3-BLK-01a & R3-BLK-01b: Array.prototype['0'] setter & Array.prototype[Symbol.iterator]
  let stolenCallArg = null;
  const origArrayIter = Array.prototype[Symbol.iterator];
  Object.defineProperty(Array.prototype, '0', {
    configurable: true,
    set(v) {
      if (v === 'trusted-partner') {
        Object.defineProperty(this, 0, { value: '*', writable: true, enumerable: true, configurable: true });
        return;
      }
      if (v === 'SECRET_ARG') {
        stolenCallArg = v;
        Object.defineProperty(this, 0, { value: 'TAMPERED_ARG', writable: true, enumerable: true, configurable: true });
        return;
      }
      Object.defineProperty(this, 0, { value: v, writable: true, enumerable: true, configurable: true });
    },
  });
  Array.prototype[Symbol.iterator] = function () {
    if (this.length > 0 && this[0] === 'SECRET_ARG') {
      stolenCallArg = this[0];
      return origArrayIter.call(['TAMPERED_ARG']);
    }
    return origArrayIter.call(this);
  };
  try {
    victimCtx.services.provide('r3-victim.secret', { getSecret: () => 'TOP_SECRET_KEY' });
    victimCtx.services.provide('r3-victim.echo', { echo: (x) => ({ echoed: x }) });
    assert.throws(
      () => evilCtx.services.call('r3-victim.secret', 'getSecret'),
      /ERR_SERVICE_CALLER_FORBIDDEN/,
      'R3-BLK-01: Array.prototype["0"] setter must NOT widen allowedCallers'
    );
    const echoRes = partnerCtx.services.call('r3-victim.echo', 'echo', 'SECRET_ARG');
    assert.equal(stolenCallArg, null, 'R3-BLK-01: Array.prototype[Symbol.iterator]/0 setter must NOT steal args');
    assert.equal(echoRes.echoed, 'SECRET_ARG', 'R3-BLK-01: call arguments must NOT be tampered');
  } finally {
    delete Array.prototype['0'];
    Array.prototype[Symbol.iterator] = origArrayIter;
  }

  // R3-BLK-02: Array.prototype.sort tampering must NOT hijack another plugin's status item onClick
  let victimStatusClicked = 0;
  let evilHijackedStatusClick = 0;
  const victimItem = victimCtx.ui.registerStatusItem({
    id: 'pay',
    label: 'Pay',
    onClick: () => {
      victimStatusClicked += 1;
    },
  });
  const origArraySort = Array.prototype.sort;
  Array.prototype.sort = function (cmp) {
    for (let i = 0; i < this.length; i += 1) {
      if (this[i] && this[i].pluginId === 'r3-victim') {
        this[i].onClick = () => {
          evilHijackedStatusClick += 1;
        };
      }
    }
    return origArraySort.call(this, cmp);
  };
  try {
    const evilItem = evilCtx.ui.registerStatusItem({ id: 'trigger', label: 'Trigger' });
    host.kernel.invokeStatusItem('r3-victim', 'pay', {}, 'sdk-test-host-token-0123456789abcdef');
    assert.equal(evilHijackedStatusClick, 0, 'R3-BLK-02: Array.prototype.sort must NOT hijack victim status item');
    assert.equal(victimStatusClicked, 1);
    evilItem.dispose();
  } finally {
    Array.prototype.sort = origArraySort;
    victimItem.dispose();
  }

  // R3-BLK-03: Object.prototype.allowedCallers / services / then / allowWellKnownHostServices
  let stolenRawReturn = null;
  Object.defineProperty(Object.prototype, 'allowedCallers', { configurable: true, writable: true, value: ['*'] });
  Object.defineProperty(Object.prototype, 'services', {
    configurable: true,
    writable: true,
    value: { provide: [{ name: 'r3-evil.undeclared', allowedCallers: ['*'] }] },
  });
  Object.defineProperty(Object.prototype, 'allowWellKnownHostServices', { configurable: true, writable: true, value: true });
  Object.defineProperty(Object.prototype, 'then', {
    configurable: true,
    writable: true,
    value() {
      stolenRawReturn = this;
      return { hijackedFn: () => 'pwned' };
    },
  });
  try {
    victimCtx.services.provide('r3-victim.defaultdeny', { getSecret: () => ({ secret: 'DEFAULT_DENY_SECRET' }) });
    assert.throws(
      () => evilCtx.services.call('r3-victim.defaultdeny', 'getSecret'),
      /ERR_SERVICE_CALLER_FORBIDDEN/,
      'R3-BLK-03: Object.prototype.allowedCallers must NOT widen default-deny service'
    );
    assert.throws(
      () => evilCtx.services.provide('r3-evil.undeclared', { ping: () => 1 }),
      /ERR_SERVICE_NOT_DECLARED/,
      'R3-BLK-03: Object.prototype.services must NOT bypass v3 declaration enforcement'
    );
    const ownRes = victimCtx.services.call('r3-victim.defaultdeny', 'getSecret');
    assert.equal(stolenRawReturn, null, 'R3-BLK-03: Object.prototype.then must NOT intercept plain return values');
    assert.equal(ownRes.secret, 'DEFAULT_DENY_SECRET');
    assert.equal(typeof ownRes.hijackedFn, 'undefined');
  } finally {
    delete Object.prototype.allowedCallers;
    delete Object.prototype.services;
    delete Object.prototype.allowWellKnownHostServices;
    delete Object.prototype.then;
  }

  // R3-BLK-04 & R3-NB-03: RegExp.prototype.exec & Date[Symbol.hasInstance]
  const { validateServiceName, sanitizeBusPayload } = require('../../src/core/service-bus-policy');
  const origRegExpExec = RegExp.prototype.exec;
  const origDateHasInstance = Object.getOwnPropertyDescriptor(Date, Symbol.hasInstance);
  try {
    RegExp.prototype.exec = () => ['matched'];
    assert.equal(
      validateServiceName('r3-evil', 'r3-evil.BAD NAME WITH SPACES\n\0').ok,
      false,
      'R3-BLK-04: RegExp.prototype.exec spoof must NOT bypass SERVICE_NAME_RE'
    );
    RegExp.prototype.exec = () => null;
    assert.equal(
      validateServiceName('statusbar-provider', 'host.statusbar', { allowWellKnownHostServices: true }).ok,
      true,
      'R3-BLK-04: RegExp.prototype.exec=null must NOT DoS host.statusbar'
    );
    Object.defineProperty(Date, Symbol.hasInstance, {
      configurable: true,
      value() {
        throw new Error('poisoned-hasInstance');
      },
    });
    assert.deepEqual(sanitizeBusPayload({ ok: 1 }), { ok: 1 }, 'R3-NB-03: Date[Symbol.hasInstance] poison must NOT break sanitizeBusPayload');
  } finally {
    RegExp.prototype.exec = origRegExpExec;
    if (origDateHasInstance) {
      Object.defineProperty(Date, Symbol.hasInstance, origDateHasInstance);
    } else {
      delete Date[Symbol.hasInstance];
    }
  }

  // R4-BLK-01 & R4-NB-01..02: Async Promise[Symbol.species]/constructor/then attacks & own-property hardening
  const asyncVaultCtx = await host.mountPlugin({
    schemaVersion: 3,
    pluginId: 'r4-async-victim',
    displayName: 'R4 Async Victim',
    version: '1.0.0',
    trustLevel: 'trusted',
    capabilities: ['renderer'],
    entry: { rendererScript: 'av.js' },
    permissions: {
      services: {
        provide: [{ name: 'r4-async-victim.vault', allowedCallers: ['trusted-partner'] }],
      },
    },
  });
  const preResolvedArrayPromise = Promise.resolve(['ARR-SECRET-1']);
  const preResolvedDatePromise = Promise.resolve(new Date('2026-01-01T00:00:00.000Z'));
  asyncVaultCtx.services.provide('r4-async-victim.vault', {
    getSecret: async () => ({ apiKey: 'SK-LIVE-9999-SECRET' }),
    getNullProtoSecret: () => Promise.resolve(Object.assign(Object.create(null), { apiKey: 'SK-NULL-PROTO-SECRET' })),
    getArraySecret: () => preResolvedArrayPromise,
    getDateSecret: () => preResolvedDatePromise,
    getFrozenSecret: () => Object.freeze(Promise.resolve({ apiKey: 'FROZEN-SECRET' })),
  });

  const OrigPromise = Promise;
  const origSpeciesDesc = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
  const origProtoCtorDesc = Object.getOwnPropertyDescriptor(Promise.prototype, 'constructor');
  const origProtoThen = Promise.prototype.then;
  let stolenViaSpecies = null;
  let injectedFnRan = false;
  try {
    // Variant A: Promise[Symbol.species] getter poisoning (tested with BOTH await and .then())
    Object.defineProperty(Promise, Symbol.species, {
      configurable: true,
      get() {
        return function EvilSpecies(executor) {
          executor(
            (v) => {
              stolenViaSpecies = v;
            },
            () => {}
          );
          return OrigPromise.resolve({
            apiKey: 'FORGED_VIA_SPECIES',
            runEvil: () => {
              injectedFnRan = true;
            },
          });
        };
      },
    });
    const r4AwaitRes = await partnerCtx.services.call('r4-async-victim.vault', 'getSecret');
    assert.equal(stolenViaSpecies, null, 'R4-BLK-01: Promise[Symbol.species] must NOT steal async service payload');
    assert.equal(r4AwaitRes.apiKey, 'SK-LIVE-9999-SECRET');
    assert.equal(typeof r4AwaitRes.runEvil, 'undefined');

    const r4ThenRes = await new OrigPromise((resolve, reject) => {
      partnerCtx.services.call('r4-async-victim.vault', 'getSecret').then(resolve, reject);
    });
    assert.equal(stolenViaSpecies, null, 'R4-BLK-01: .then() chain must NOT invoke Promise[Symbol.species]');
    assert.equal(r4ThenRes.apiKey, 'SK-LIVE-9999-SECRET');

    // Non-extensible frozen Promise while Symbol.species is poisoned MUST fail closed
    assert.throws(
      () => partnerCtx.services.call('r4-async-victim.vault', 'getFrozenSecret'),
      /ERR_SERVICE_PROMISE_UNSAFE/,
      'R4-BLK-01: non-extensible Promise under poisoned Promise[Symbol.species] must fail closed'
    );

    // Variant B: Promise.prototype.constructor + Promise.prototype.then poisoning
    Object.defineProperty(Promise.prototype, 'constructor', {
      configurable: true,
      writable: true,
      value: {
        [Symbol.species]: function EvilProtoCtor(executor) {
          executor(
            (v) => {
              stolenViaSpecies = v;
            },
            () => {}
          );
          return OrigPromise.resolve({ apiKey: 'FORGED_KEY' });
        },
      },
    });
    Promise.prototype.then = function () {
      injectedFnRan = true;
      return OrigPromise.resolve({ apiKey: 'FORGED_THEN' });
    };
    const r4ProtoRes = await partnerCtx.services.call('r4-async-victim.vault', 'getSecret');
    assert.equal(stolenViaSpecies, null, 'R4-BLK-01: Promise.prototype.constructor must NOT steal async payload');
    assert.equal(injectedFnRan, false, 'R4-BLK-01: Promise.prototype.then must NOT hijack returned Promise');
    assert.equal(r4ProtoRes.apiKey, 'SK-LIVE-9999-SECRET');
  } finally {
    if (origSpeciesDesc) Object.defineProperty(Promise, Symbol.species, origSpeciesDesc);
    if (origProtoCtorDesc) Object.defineProperty(Promise.prototype, 'constructor', origProtoCtorDesc);
    Promise.prototype.then = origProtoThen;
  }

  // R5-BLK-01 & R5-BLK-02: Async Object.prototype.then & Promise.prototype.catch/finally attacks
  let stolenViaObjProtoThen = null;
  let stolenViaCatchOrFinally = null;
  let finallyRan = 0;
  const origProtoCatch = Promise.prototype.catch;
  const origProtoFinally = Promise.prototype.finally;
  Object.defineProperty(Object.prototype, 'then', {
    configurable: true,
    writable: true,
    value(resolve) {
      stolenViaObjProtoThen = this;
      const forged = Object.create(null);
      forged.apiKey = 'FORGED_VIA_OBJ_PROTO_THEN';
      forged.evilFn = () => 'pwned';
      resolve(forged);
    },
  });
  Promise.prototype.catch = function () {
    this.then((v) => {
      stolenViaCatchOrFinally = v;
    });
    return OrigPromise.resolve({ apiKey: 'FORGED_VIA_CATCH' });
  };
  Promise.prototype.finally = function () {
    this.then((v) => {
      stolenViaCatchOrFinally = v;
    });
    return OrigPromise.resolve({ apiKey: 'FORGED_VIA_FINALLY' });
  };
  try {
    const r5Obj = await partnerCtx.services.call('r4-async-victim.vault', 'getNullProtoSecret');
    assert.equal(stolenViaObjProtoThen, null, 'R5-BLK-01: Object.prototype.then must NOT exfiltrate async object payload');
    assert.equal(r5Obj.apiKey, 'SK-NULL-PROTO-SECRET');
    assert.equal(typeof r5Obj.evilFn, 'undefined');
    assert.deepEqual(Object.keys(r5Obj), ['apiKey']);

    const r5Arr = await partnerCtx.services.call('r4-async-victim.vault', 'getArraySecret');
    assert.equal(stolenViaObjProtoThen, null, 'R5-BLK-01: Object.prototype.then must NOT exfiltrate async Array payload');
    assert.deepEqual(r5Arr, ['ARR-SECRET-1']);

    const r5Date = await partnerCtx.services.call('r4-async-victim.vault', 'getDateSecret');
    assert.equal(stolenViaObjProtoThen, null, 'R5-BLK-01: Object.prototype.then must NOT exfiltrate async Date payload');
    assert.equal(r5Date instanceof Date, true);
    assert.equal(r5Date.toISOString(), '2026-01-01T00:00:00.000Z');

    const r5CatchRes = await partnerCtx.services.call('r4-async-victim.vault', 'getNullProtoSecret').catch(() => null);
    assert.equal(stolenViaCatchOrFinally, null, 'R5-BLK-02: Promise.prototype.catch must NOT hijack returned Promise');
    assert.equal(r5CatchRes.apiKey, 'SK-NULL-PROTO-SECRET');

    const r5FinallyRes = await partnerCtx.services
      .call('r4-async-victim.vault', 'getNullProtoSecret')
      .finally(() => {
        finallyRan += 1;
      });
    assert.equal(stolenViaCatchOrFinally, null, 'R5-BLK-02: Promise.prototype.finally must NOT hijack returned Promise');
    assert.equal(finallyRan, 1);
    assert.equal(r5FinallyRes.apiKey, 'SK-NULL-PROTO-SECRET');
  } finally {
    delete Object.prototype.then;
    Promise.prototype.catch = origProtoCatch;
    Promise.prototype.finally = origProtoFinally;
  }

  // R4-NB-01: Inherited Object.prototype.updateItem/removeItem must NOT intercept status item updates/dispose
  const minimalBarCtx = await host.mountPlugin({
    schemaVersion: 3,
    pluginId: 'r4-minimal-bar',
    displayName: 'Minimal Bar',
    version: '1.0.0',
    trustLevel: 'trusted',
    capabilities: ['renderer'],
    entry: { rendererScript: 'mb.js' },
    permissions: { services: { provide: [{ name: 'host.statusbar', allowedCallers: ['*'] }] } },
  });
  const barHandle = minimalBarCtx.services.provide('host.statusbar', {
    registerItem() {
      return {};
    },
  });
  let stolenUpdate = null;
  let stolenRemove = null;
  Object.defineProperty(Object.prototype, 'updateItem', {
    configurable: true,
    writable: true,
    value(pid, id, patch) {
      stolenUpdate = { pid, id, patch };
    },
  });
  Object.defineProperty(Object.prototype, 'removeItem', {
    configurable: true,
    writable: true,
    value(pid, id) {
      stolenRemove = { pid, id };
    },
  });
  try {
    const r4Item = victimCtx.ui.registerStatusItem({ id: 'r4-secret-btn', label: 'Init' });
    r4Item.update({ label: 'Balance: $999' });
    r4Item.dispose();
    assert.equal(stolenUpdate, null, 'R4-NB-01: Object.prototype.updateItem must NOT steal status updates');
    assert.equal(stolenRemove, null, 'R4-NB-01: Object.prototype.removeItem must NOT intercept status disposal');
  } finally {
    delete Object.prototype.updateItem;
    delete Object.prototype.removeItem;
    barHandle.dispose();
  }

  // R4-NB-02: Inherited Object.prototype.net/dom must NOT expose ctx.net or ctx.dom on minimal v3 plugin
  Object.defineProperty(Object.prototype, 'net', {
    configurable: true,
    writable: true,
    value: { httpsHosts: ['api.example.com'] },
  });
  Object.defineProperty(Object.prototype, 'dom', {
    configurable: true,
    writable: true,
    value: { anchors: ['sidebar'] },
  });
  try {
    const r4MinCtx = await host.mountPlugin({
      schemaVersion: 3,
      pluginId: 'r4-minimal-v3',
      displayName: 'R4 Minimal',
      version: '1.0.0',
      capabilities: ['renderer'],
      entry: { rendererScript: 'm.js' },
    });
    assert.equal(Object.prototype.hasOwnProperty.call(r4MinCtx, 'net'), false, 'R4-NB-02: Object.prototype.net must NOT expose ctx.net');
    assert.equal(Object.prototype.hasOwnProperty.call(r4MinCtx, 'dom'), false, 'R4-NB-02: Object.prototype.dom must NOT expose ctx.dom');
    assert.equal(r4MinCtx.env.capabilities.hasNetHttps, false);
  } finally {
    delete Object.prototype.net;
    delete Object.prototype.dom;
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
