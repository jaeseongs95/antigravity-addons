'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');

const { buildHubToDir } = require('../../scripts/build-hub');
const { buildGeneratedValidators, buildDistRuntime, verifyZeroDepTree } = require('../../scripts/build-runtime');
const { createRendererKernel } = require('../../src/runtime/renderer/kernel');
const { bootRemoteWebHost } = require('../../src/adapters/remote-web/remote-bootstrap');
const { createRemoteHostBridge } = require('../../src/adapters/remote-web/remote-host-bridge');
const { startRemoteLanServer } = require('../../src/adapters/remote-web/remote-lan-server');
const {
  createRemoteHostTransport,
  normalizeBridgeBaseUrl,
  parsePairingCode,
} = require('../../src/adapters/remote-web/remote-host-transport');
const { createToastAndDialogManager } = require('../../src/runtime/renderer/toast-manager');
const { createThemeAndI18n } = require('../../src/runtime/renderer/theme-i18n');
const { createHostSettingsUi } = require('../../src/runtime/renderer/host-settings-ui');
const { createConfigBridge } = require('../../src/runtime/main/config-bridge');
const { createHostRuntimeController, loadRawManifestsFromDir } = require('../../src/runtime/main/init-main');
const { ANTIGRAVITY_REMOTE_WEB_PROFILE } = require('../../src/profiles/antigravity-remote-web');
const { createTestHost } = require('../../packages/sdk/src/test-host');

function createSimpleDom() {
  function makeNode(tag) {
    const attrs = Object.create(null);
    const listeners = Object.create(null);
    const node = {
      nodeType: 1,
      tagName: String(tag || 'div').toUpperCase(),
      className: '',
      textContent: '',
      value: '',
      disabled: false,
      open: false,
      isConnected: true,
      style: {},
      children: [],
      childNodes: [],
      parentNode: null,
      parentElement: null,
      shadowRoot: null,
      get firstChild() {
        return this.children[0] || null;
      },
      setAttribute(k, v) {
        attrs[k] = String(v);
        if (k === 'id') this.id = String(v);
      },
      getAttribute(k) {
        return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null;
      },
      hasAttribute(k) {
        return Object.prototype.hasOwnProperty.call(attrs, k);
      },
      removeAttribute(k) {
        delete attrs[k];
      },
      appendChild(ch) {
        ch.parentNode = this;
        ch.parentElement = this;
        this.children.push(ch);
        this.childNodes.push(ch);
        return ch;
      },
      removeChild(ch) {
        this.children = this.children.filter((c) => c !== ch);
        this.childNodes = this.childNodes.filter((c) => c !== ch);
        ch.parentNode = null;
        ch.parentElement = null;
        return ch;
      },
      remove() {
        if (this.parentNode && typeof this.parentNode.removeChild === 'function') {
          this.parentNode.removeChild(this);
        }
      },
      attachShadow() {
        const sr = makeNode('#shadow-root');
        sr.host = this;
        this.shadowRoot = sr;
        return sr;
      },
      showModal() {
        this.open = true;
      },
      close() {
        this.open = false;
        this.dispatch('close', {});
      },
      focus() {
        this.focused = true;
      },
      addEventListener(ev, fn) {
        if (!listeners[ev]) listeners[ev] = [];
        listeners[ev].push(fn);
      },
      removeEventListener(ev, fn) {
        if (listeners[ev]) listeners[ev] = listeners[ev].filter((f) => f !== fn);
      },
      dispatch(ev, evtObj = {}) {
        for (const fn of (listeners[ev] || []).slice()) fn(evtObj);
      },
      querySelectorAll(sel) {
        const res = [];
        const parts = sel.split(',').map((p) => p.trim()).filter(Boolean);
        const matchesPart = (el, part) => {
          if (!el || el.nodeType !== 1 || typeof el.getAttribute !== 'function') return false;
          if (part.startsWith('[') && part.endsWith(']')) {
            const inner = part.slice(1, -1);
            const eqIdx = inner.indexOf('=');
            if (eqIdx !== -1) {
              const k = inner.slice(0, eqIdx);
              const v = inner.slice(eqIdx + 1).replace(/^"|"$/g, '');
              return el.getAttribute(k) === v;
            }
            return el.hasAttribute(inner);
          }
          return el.tagName === part.toUpperCase();
        };
        const walk = (n) => {
          for (const ch of n.children || []) {
            if (parts.some((p) => matchesPart(ch, p))) res.push(ch);
            walk(ch);
          }
          if (n.shadowRoot) walk(n.shadowRoot);
        };
        walk(this);
        return res;
      },
      querySelector(sel) {
        return this.querySelectorAll(sel)[0] || null;
      },
    };
    return node;
  }

  const body = makeNode('body');
  const head = makeNode('head');
  const docEl = makeNode('html');
  docEl.lang = 'en';
  docEl.appendChild(head);
  docEl.appendChild(body);
  const doc = {
    body,
    head,
    documentElement: docEl,
    activeElement: null,
    createElement: makeNode,
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t), parentNode: null }),
    getElementById(id) {
      const find = (n) => {
        if (n.id === id) return n;
        for (const ch of n.children || []) {
          const hit = find(ch);
          if (hit) return hit;
        }
        return null;
      };
      return find(docEl);
    },
    querySelector: (sel) => docEl.querySelector(sel),
    querySelectorAll: (sel) => docEl.querySelectorAll(sel),
    addEventListener(ev, fn) {
      docEl.addEventListener(ev, fn);
    },
    removeEventListener(ev, fn) {
      docEl.removeEventListener(ev, fn);
    },
  };
  return { doc, body, head, docEl, makeNode };
}

test('TC-BR-01: build-hub and build-runtime build deterministic zero-dep artifacts into temp dirs', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extenra-br-build-'));
  try {
    const hubDir = path.join(tmpDir, 'hub');
    const hubRes = buildHubToDir(hubDir);
    assert.equal(hubRes.ok, true);
    assert.deepEqual(hubRes.files, ['hub-manifest.json', 'hub.js', 'index.html']);

    const genDir = path.join(tmpDir, 'generated');
    const distDir = path.join(tmpDir, 'dist-runtime');
    buildGeneratedValidators(genDir);
    const manifest = buildDistRuntime(distDir, genDir);
    assert.equal(manifest.schemaVersion, 1);
    assert.ok(manifest.fileCount > 20);
    const astCheck = verifyZeroDepTree(distDir);
    assert.equal(astCheck.ok, true);
    assert.equal(astCheck.errors.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-BR-02: direct kernel.js, remote-bootstrap WebCrypto/ping failure paths, remote-host-bridge secretsList, and LAN server TTL expiry', async () => {
  // 1. Direct src/runtime/renderer/kernel.js require (covers win.crypto path & fail-closed ERR_WEBCRYPTO_UNAVAILABLE)
  const { doc } = createSimpleDom();
  const win = {
    document: doc,
    crypto: globalThis.crypto,
    location: { protocol: 'http:', host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173' },
    addEventListener() {},
    removeEventListener() {},
  };
  const kernel = createRendererKernel(doc, win);
  assert.equal(kernel.boot({ hostToken: 'ht-1', docGenId: 1 }).ok, true);
  const staged = kernel.stagePluginHandle(
    { pluginId: 'p1', trustLevel: 'restricted', capabilities: ['renderer'] },
    'ht-1'
  );
  assert.ok(staged && staged.runNonce && staged.runNonce.startsWith('rn-1-'));
  kernel.disposePlugin('p1', 'ht-1');

  // 2. kernel.js win.crypto fallback & fail-closed + remote-bootstrap generateHostToken fail-closed when WebCrypto is absent
  const origCrypto = globalThis.crypto;
  const kernelPath = require.resolve('../../src/runtime/renderer/kernel');
  try {
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
    delete require.cache[kernelPath];
    const { createRendererKernel: createKernelNoGlobalCrypto } = require(kernelPath);
    // 2a. kernel.js falls back to win.crypto.getRandomValues when globalThis.crypto is undefined
    const kDomFallback = createSimpleDom();
    const kWinFallback = {
      document: kDomFallback.doc,
      crypto: origCrypto,
      addEventListener() {},
      removeEventListener() {},
    };
    const kFallback = createKernelNoGlobalCrypto(kDomFallback.doc, kWinFallback);
    kFallback.boot({ hostToken: 'ht-fb', docGenId: 1 });
    const fbStaged = kFallback.stagePluginHandle(
      { pluginId: 'p-fb', trustLevel: 'restricted', capabilities: ['renderer'] },
      'ht-fb'
    );
    assert.ok(fbStaged.runNonce.startsWith('rn-1-'));
    kFallback.disposePlugin('p-fb', 'ht-fb');

    // 2b. kernel.js fails closed when BOTH globalThis.crypto and win.crypto are absent
    const kDomNone = createSimpleDom();
    const kWinNone = { document: kDomNone.doc, addEventListener() {}, removeEventListener() {} };
    const kNone = createKernelNoGlobalCrypto(kDomNone.doc, kWinNone);
    kNone.boot({ hostToken: 'ht-none', docGenId: 1 });
    assert.throws(
      () => kNone.stagePluginHandle({ pluginId: 'p-none', trustLevel: 'restricted', capabilities: ['renderer'] }, 'ht-none'),
      /ERR_WEBCRYPTO_UNAVAILABLE/
    );

    const bareDom = createSimpleDom();
    const bareWin = {
      document: bareDom.doc,
      location: {
        href: 'https://antigravity.google.com/',
        protocol: 'https:',
        host: 'antigravity.google.com',
        hostname: 'antigravity.google.com',
        origin: 'https://antigravity.google.com',
      },
      addEventListener() {},
      removeEventListener() {},
    };
    await assert.rejects(
      () =>
        bootRemoteWebHost({
          doc: bareDom.doc,
          win: bareWin,
          profile: ANTIGRAVITY_REMOTE_WEB_PROFILE,
          kernel: createKernelNoGlobalCrypto(bareDom.doc, bareWin),
          allowedOrigins: ['https://antigravity.google.com'],
          packedAddons: [],
        }),
      /ERR_WEBCRYPTO_UNAVAILABLE/
    );
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: origCrypto, configurable: true, writable: true });
    delete require.cache[kernelPath];
    require(kernelPath);
  }

  // 3. remote-host-bridge standalone secretsList deterministic sorting (multiple keys)
  const storeMap = new Map();
  const bridge = createRemoteHostBridge({
    profile: ANTIGRAVITY_REMOTE_WEB_PROFILE,
    storage: {
      getItem: (k) => (storeMap.has(k) ? storeMap.get(k) : null),
      setItem: (k, v) => storeMap.set(k, String(v)),
      removeItem: (k) => storeMap.delete(k),
    },
  });
  bridge.bindSecretsPlugin('p1', { maxKeys: 8, maxBytes: 4096, allowRead: true });
  bridge.bindNetPlugin('p1', { httpsHosts: ['api.openai.com'], userApprovedHttps: true });
  await bridge.port.secretsSet('p1', 'z_key', 'v1');
  await bridge.port.secretsSet('p1', 'a_key', 'v2');
  const sList = await bridge.port.secretsList('p1');
  assert.equal(sList.ok, true);
  assert.deepEqual(sList.keys, ['a_key', 'z_key']);
  bridge.addUserAllowedHttpsHost('p1', 'z.example.com');
  bridge.addUserAllowedHttpsHost('p1', 'a.example.com');
  assert.deepEqual(bridge.listUserAllowedHttpsHosts('p1'), ['a.example.com', 'z.example.com']);
  bridge.dispose();

  // 4. remote-bootstrap Test Connection button handles rejecting controls.ping() without unhandled rejection
  const rDom = createSimpleDom();
  const storageObj = new Map();
  const rWin = {
    document: rDom.doc,
    crypto: globalThis.crypto,
    location: {
      href: 'https://antigravity.google.com/',
      protocol: 'https:',
      host: 'antigravity.google.com',
      hostname: 'antigravity.google.com',
      origin: 'https://antigravity.google.com',
    },
    localStorage: {
      getItem: (k) => (storageObj.has(k) ? storageObj.get(k) : null),
      setItem: (k, v) => storageObj.set(k, String(v)),
      removeItem: (k) => storageObj.delete(k),
    },
    addEventListener() {},
    removeEventListener() {},
  };
  let pingCount = 0;
  const fakeTransport = {
    hydrate: async () => {},
    getStatus: () => ({ configured: true, connected: true, baseUrl: 'http://127.0.0.1:19384', tokenHint: 'abcd...1234' }),
    isConnected: () => true,
    onStatusChange: () => () => {},
    ping: async () => {
      pingCount += 1;
      if (pingCount === 1) throw new Error('PING_FAIL_TEST');
      return { ok: true };
    },
    disconnect: () => {},
    connectWithPairingCode: async () => ({ ok: true }),
    connect: async () => ({ ok: true }),
  };
  const boot = await bootRemoteWebHost({
    doc: rDom.doc,
    win: rWin,
    profile: ANTIGRAVITY_REMOTE_WEB_PROFILE,
    kernel: createRendererKernel(rDom.doc, rWin),
    allowedOrigins: ['https://antigravity.google.com'],
    packedAddons: [],
    remoteTransport: fakeTransport,
  });
  assert.equal(boot.ok, true);
  // Open drawer via pill button, switch to Host Bridge tab, click Test Connection (rejecting + resolving ping)
  const pillBtn = rDom.doc.querySelector('[aria-controls="rah-drawer-panel"]');
  assert.ok(pillBtn, 'Drawer pill button must be mounted');
  pillBtn.dispatch('click', { isTrusted: true });
  const tabs = rDom.doc.querySelectorAll('[role="tab"]');
  const bridgeTab = tabs.find((t) => t.textContent === 'Host Bridge');
  assert.ok(bridgeTab, 'Host Bridge tab must exist');
  bridgeTab.dispatch('click', { isTrusted: true });
  const testBtn = rDom.doc.querySelector('[data-rah-bridge-test="1"]');
  assert.ok(testBtn, 'Test Connection button must be rendered when bridge is configured');
  testBtn.dispatch('click', { isTrusted: true });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(testBtn.disabled, false);
  testBtn.dispatch('click', { isTrusted: true });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(pingCount, 2);
  // Language switcher buttons
  const koBtn = rDom.doc.querySelector('[data-rah-lang="ko"]');
  const enBtn = rDom.doc.querySelector('[data-rah-lang="en"]');
  if (koBtn) koBtn.dispatch('click', { isTrusted: true });
  if (enBtn) enBtn.dispatch('click', { isTrusted: true });
  boot.controller.dispose();

  // 5. remote-lan-server once auto-close, HEAD/404/405/install routes, and TTL expiry branch
  const tmpDist = fs.mkdtempSync(path.join(os.tmpdir(), 'extenra-lan-once-'));
  try {
    fs.writeFileSync(path.join(tmpDist, 'antigravity-remote.user.js'), '// ==UserScript==\n// ==/UserScript==\n', 'utf8');
    fs.writeFileSync(path.join(tmpDist, 'build-manifest.json'), JSON.stringify({ buildSha8: '12345678', addonCount: 0 }), 'utf8');
    let closedReason = null;
    const srv = await startRemoteLanServer({
      distDir: tmpDist,
      bindHost: '127.0.0.1',
      port: 0,
      once: true,
      onClose: ({ reason }) => {
        closedReason = reason;
      },
    });
    const postRes = await globalThis.fetch(srv.installUrl, { method: 'POST' });
    assert.equal(postRes.status, 405);
    const notFoundRes = await globalThis.fetch(srv.installUrl.replace(/\/[^/]+\/$/, '/wrongtoken/'));
    assert.equal(notFoundRes.status, 404);
    const headInstall = await globalThis.fetch(srv.installUrl, { method: 'HEAD' });
    assert.equal(headInstall.status, 200);
    const getInstall = await globalThis.fetch(srv.installUrl);
    assert.equal(getInstall.status, 200);
    assert.ok((await getInstall.text()).includes('antigravity-remote.user.js'));
    const resp = await globalThis.fetch(srv.userscriptUrl);
    assert.equal(resp.status, 200);
    await resp.text();
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(srv.isClosed(), true);
    assert.equal(closedReason, 'once_completed');

    // TTL expiry branch (MIN_TTL_SEC = 5)
    let ttlClosedReason = null;
    const ttlSrv = await startRemoteLanServer({
      distDir: tmpDist,
      bindHost: '127.0.0.1',
      port: 0,
      ttlSec: 5,
      once: false,
      onClose: ({ reason }) => {
        ttlClosedReason = reason;
      },
    });
    await new Promise((r) => setTimeout(r, 5200));
    assert.equal(ttlSrv.isClosed(), true);
    assert.equal(ttlClosedReason, 'ttl_expired');
  } finally {
    fs.rmSync(tmpDist, { recursive: true, force: true });
  }
});

test('TC-BR-03: host-settings-ui exercises all action buttons and toast-manager covers toasts/confirm/prompt/dispose', async () => {
  // 1. host-settings-ui click handlers (refresh, bridge toggle/save/copy/rotate, bundle copy buttons)
  const { doc, body } = createSimpleDom();
  const modal = doc.createElement('div');
  const sidebarCol = doc.createElement('aside');
  const sidebarTitle = doc.createElement('div');
  sidebarTitle.textContent = '설정';
  const navList = doc.createElement('nav');
  const nativeBtn1 = doc.createElement('button');
  nativeBtn1.textContent = '일반';
  const nativeBtn2 = doc.createElement('button');
  nativeBtn2.textContent = '브라우저';
  navList.appendChild(nativeBtn1);
  navList.appendChild(nativeBtn2);
  sidebarCol.appendChild(sidebarTitle);
  sidebarCol.appendChild(navList);
  const contentPane = doc.createElement('main');
  const nativeBody = doc.createElement('div');
  nativeBody.textContent = '일반 설정 내용';
  contentPane.appendChild(nativeBody);
  modal.appendChild(sidebarCol);
  modal.appendChild(contentPane);
  body.appendChild(modal);

  const copied = [];
  const win = {
    document: doc,
    navigator: {
      clipboard: {
        writeText: async (text) => {
          copied.push(text);
        },
      },
    },
    addEventListener() {},
    removeEventListener() {},
  };

  let calls = { refresh: 0, config: 0, rotate: 0, rebuild: 0 };
  const sampleState = {
    ok: true,
    host: { version: '3.3.2', buildSha8: 'e54d5486' },
    summary: { totalCount: 0, desktopActiveCount: 0, remoteEligibleCount: 0, remoteEnabledCount: 0 },
    addons: [],
    remoteBridge: {
      enabled: true,
      running: true,
      port: 19384,
      listeningPort: 19384,
      bindHost: '127.0.0.1',
      publicUrl: '',
      pairingCode: 'ag-bridge-v1:demo',
      connectUrl: 'http://127.0.0.1:19384',
      tokenHint: 'abcd...1234',
    },
    remoteBundle: {
      built: true,
      needsRebuild: false,
      buildSha8: 'c08ff007',
      addonCount: 0,
      buildCommand: 'extenra --build-remote',
      hasUserscript: true,
      userscriptPath: '/tmp/extenra.user.js',
      serveCommand: 'extenra --serve-remote',
      hasExtension: true,
      extensionDir: '/tmp/ext',
      hasBookmarklet: true,
      bookmarkletRunnable: true,
      bookmarkletText: 'javascript:void(0)',
    },
  };
  const hostBridge = {
    getHostAdminState: async () => {
      calls.refresh += 1;
      return sampleState;
    },
    configureRemoteBridge: async () => {
      calls.config += 1;
      return { ok: true, state: sampleState };
    },
    rotateRemoteBridgeToken: async () => {
      calls.rotate += 1;
      return { ok: true, state: sampleState };
    },
    rebuildRemoteBundle: async () => {
      calls.rebuild += 1;
      return { ok: true, buildSha8: 'c08ff007', state: sampleState };
    },
    setRemoteAddonPreference: async () => ({ ok: true, state: sampleState }),
  };

  const ui = createHostSettingsUi(doc, win, {
    hostBridge,
  });
  ui.ensureMount();
  ui.openPanel();
  await new Promise((r) => setTimeout(r, 30));

  const paneShadow = ui.getElements().shadowRoot;
  assert.ok(paneShadow);
  const clickSel = (sel) => {
    const el = paneShadow.querySelector(sel);
    if (el) el.dispatch('click', { isTrusted: true });
  };
  // Click refresh, bridge controls, rebuild, and all 5 copy buttons
  const refreshBtns = paneShadow.querySelectorAll('button');
  for (const b of refreshBtns) {
    if (b.textContent === 'Refresh' || b.textContent === '새로고침') b.dispatch('click', { isTrusted: true });
  }
  await new Promise((r) => setTimeout(r, 20));
  clickSel('[data-ah-bridge-toggle="1"]');
  await new Promise((r) => setTimeout(r, 20));
  clickSel('[data-ah-bridge-save="1"]');
  await new Promise((r) => setTimeout(r, 20));
  clickSel('[data-ah-bridge-copy-pairing="1"]');
  await new Promise((r) => setTimeout(r, 20));
  clickSel('[data-ah-bridge-rotate-token="1"]');
  await new Promise((r) => setTimeout(r, 20));
  clickSel('[data-ah-action="rebuild-bundle"]');
  await new Promise((r) => setTimeout(r, 20));
  for (const act of ['copy-command', 'copy-userscript-path', 'copy-serve-command', 'copy-extension-path', 'copy-bookmarklet']) {
    clickSel(`[data-ah-action="${act}"]`);
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(calls.config >= 2);
  assert.equal(calls.rotate, 1);
  assert.equal(calls.rebuild, 1);
  assert.ok(copied.length >= 5);
  ui.dispose();

  // 2. toast-manager: toast, confirm, prompt, cancel, dispose
  const tDom = createSimpleDom();
  const tWin = { document: tDom.doc, addEventListener() {}, removeEventListener() {} };
  const theme = createThemeAndI18n(tDom.doc, tWin);
  const tm = createToastAndDialogManager(tDom.doc, tWin, { themeAndI18n: theme });

  const toastHandle = tm.showToast(
    { pluginId: 'p1', displayName: 'P1' },
    {
      title: 'Saved',
      message: 'Done',
      variant: 'success',
      durationMs: 0,
      actions: [{ label: 'Undo', onClick() {} }],
    }
  );
  assert.ok(toastHandle && typeof toastHandle.dismiss === 'function');
  toastHandle.dismiss();

  const confirmP = tm.confirm(
    { pluginId: 'p1', displayName: 'P1' },
    {
      title: 'Delete?',
      message: 'Are you sure?',
      danger: true,
    }
  );
  const confirmBtns = tDom.doc.querySelectorAll('button');
  const confirmBtn = confirmBtns.find((b) => b.className && b.className.includes('primary')) || confirmBtns[confirmBtns.length - 1];
  assert.ok(confirmBtn);
  confirmBtn.dispatch('click', { isTrusted: true });
  assert.equal(await confirmP, true);

  const promptP = tm.prompt(
    { pluginId: 'p1', displayName: 'P1' },
    {
      title: 'Enter name',
      defaultValue: 'hello',
      placeholder: 'name',
    }
  );
  const promptInput = tDom.doc.querySelector('input');
  assert.ok(promptInput);
  promptInput.value = 'world';
  const promptBtns = tDom.doc.querySelectorAll('button');
  const promptOkBtn = promptBtns.find((b) => b.className && b.className.includes('primary')) || promptBtns[promptBtns.length - 1];
  promptOkBtn.dispatch('click', { isTrusted: true });
  assert.equal(await promptP, 'world');

  // Pending dialog resolves cleanly on disposePlugin
  const pendingP = tm.confirm({ pluginId: 'p1', displayName: 'P1' }, { title: 'Pending' });
  tm.disposePlugin('p1');
  assert.equal(await pendingP, false);
  theme.dispose();
});

test('TC-BR-04: remote-host-transport covers HTTP success, error, unauthorized, timeout, and secret routes', async () => {
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${'t'.repeat(40)}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'ERR_UNAUTHORIZED' }));
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/v1/health') return res.end(JSON.stringify({ ok: true, hostVersion: '3.3.2' }));
      if (req.url.startsWith('/v1/settings/')) return res.end(JSON.stringify({ ok: true, data: { a: 1 }, sha256: 'abc' }));
      if (req.url.startsWith('/v1/config/')) return res.end(JSON.stringify({ ok: true, data: { k: 'v' }, sha256: 'def' }));
      if (req.url === '/v1/net/fetch') return res.end(JSON.stringify({ ok: true, status: 200, bodyText: 'hi' }));
      if (req.url.startsWith('/v1/secrets/')) return res.end(JSON.stringify({ ok: true, exists: true, keys: ['k1'], value: 's', deleted: true }));
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = 't'.repeat(40);
  const store = new Map();
  const transport = createRemoteHostTransport({
    profile: ANTIGRAVITY_REMOTE_WEB_PROFILE,
    storage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    fetchFn: globalThis.fetch,
  });

  try {
    // Disconnected error paths
    assert.equal((await transport.readSettings('p1')).ok, false);
    assert.equal((await transport.secretsList('p1')).ok, false);

    // Bad token -> unauthorized
    const badConn = await transport.connect({ baseUrl, token: 'x'.repeat(40) });
    assert.equal(badConn.ok, false);

    // Valid connect + all endpoints
    const okConn = await transport.connect({ baseUrl, token });
    assert.equal(okConn.ok, true);
    assert.equal(transport.isConnected(), true);
    assert.equal((await transport.ping()).ok, true);
    assert.equal((await transport.readSettings('p1')).ok, true);
    assert.equal((await transport.saveSettings('p1', { a: 2 })).ok, true);
    assert.equal((await transport.readConfigScope('p1', 'mcp')).ok, true);
    assert.equal((await transport.writeConfigScope('p1', 'mcp', { k: 'v2' })).ok, true);
    assert.equal((await transport.netFetch('p1', 'https://api.example.com', { method: 'GET' })).ok, true);
    assert.equal((await transport.secretsSet('p1', 'k1', 'v1')).ok, true);
    assert.equal((await transport.secretsGet('p1', 'k1')).ok, true);
    assert.equal((await transport.secretsHas('p1', 'k1')).ok, true);
    assert.equal((await transport.secretsList('p1')).ok, true);
    assert.equal((await transport.secretsDelete('p1', 'k1')).ok, true);

    transport.disconnect();
    assert.equal(transport.isConnected(), false);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('TC-BR-05: @extenra/sdk createTestHost exercises Desktop/Remote parity, DOM harness, secrets, configBridge, and netFetch', async () => {
  // 1. Desktop test host with netHandler, configScopes, initialSettings
  const capturedNet = [];
  const desktopHost = createTestHost({
    surface: 'desktop',
    viewport: { width: 1024, height: 768 },
    locale: 'ko',
    themeMode: 'dark',
    configScopes: {
      mcp: { data: { servers: { a: 1 } }, sha256: 'sha-init' },
    },
    initialSettings: {
      'sdk-p1': { status: 'ok', data: { enabled: true } },
    },
    netHandler: (pid, url, init) => {
      capturedNet.push({ pid, url, init });
      return { ok: true, status: 200, bodyText: 'ok' };
    },
  });

  // Exercise mock DOM primitives on host.doc & host.win
  const box = desktopHost.doc.createElement('div');
  const childA = desktopHost.doc.createElement('button');
  const childB = desktopHost.doc.createElement('span');
  const txt = desktopHost.doc.createTextNode('hello');
  childB.appendChild(txt);
  childA.setAttribute('class', 'btn-primary');
  childA.setAttribute('data-role', 'go');
  childA.setAttribute('hidden', 'true');
  assert.equal(childA.hasAttribute('hidden'), true);
  assert.equal(childA.hidden, true);
  childA.removeAttribute('hidden');
  assert.equal(childA.hidden, false);
  assert.equal(childA.getAttribute('missing'), null);
  box.appendChild(childA);
  box.insertBefore(childB, childA);
  assert.equal(box.firstChild, childB);
  assert.equal(box.children.length, 2);
  assert.equal(box.contains(childA), true);
  assert.equal(box.contains(desktopHost.doc.createElement('p')), false);
  assert.equal(box.textContent, 'hello');
  childB.textContent = 'updated';
  assert.equal(childB.textContent, 'updated');
  const srOpen = box.attachShadow({ mode: 'open' });
  assert.equal(box.shadowRoot, srOpen);
  const closedHost = desktopHost.doc.createElement('div');
  closedHost.attachShadow({ mode: 'closed' });
  assert.equal(closedHost.shadowRoot, null);
  let clicked = 0;
  const onClick = () => {
    clicked += 1;
  };
  childA.addEventListener('click', onClick);
  childA.click();
  childA.removeEventListener('click', onClick);
  childA.click();
  assert.equal(clicked, 1);
  childA.focus();
  assert.equal(desktopHost.doc.activeElement, childA);
  childA.showModal();
  assert.equal(childA.open, true);
  childA.close();
  assert.equal(childA.open, false);
  childA.showPopover();
  assert.equal(childA.open, true);
  childA.hidePopover();
  assert.equal(childA.open, false);
  childA.setMockRect({ left: 10, top: 20 });
  assert.equal(childA.getBoundingClientRect().left, 10);
  desktopHost.doc.body.appendChild(box);
  assert.equal(desktopHost.doc.querySelector('button[data-role="go"]'), childA);
  assert.equal(desktopHost.doc.querySelectorAll('span, button[data-role]').length, 2);
  box.removeChild(childB);
  desktopHost.win.localStorage.setItem('k', 'v');
  assert.equal(desktopHost.win.localStorage.getItem('k'), 'v');
  desktopHost.win.localStorage.removeItem('k');
  assert.equal(desktopHost.win.localStorage.getItem('k'), null);
  const docFn = () => {};
  desktopHost.doc.addEventListener('keydown', docFn);
  desktopHost.doc.removeEventListener('keydown', docFn);
  let resized = 0;
  const onResize = () => {
    resized += 1;
  };
  desktopHost.win.addEventListener('resize', onResize);
  desktopHost.setViewport(1440, 900);
  desktopHost.win.removeEventListener('resize', onResize);
  assert.equal(resized, 1);

  // Mount trusted v3 plugin with secrets(allowRead: true, maxKeys: 2), settingsBridge, configBridge, net
  const ctx = await desktopHost.mountPlugin(
    {
      schemaVersion: 3,
      pluginId: 'sdk-p1',
      displayName: 'SDK Plugin 1',
      version: '1.2.3',
      trustLevel: 'trusted',
      settingsBridge: { enabled: true },
      permissions: {
        configBridge: { scopes: [{ scopeId: 'mcp', access: 'rw' }] },
        secrets: { maxKeys: 2, maxBytes: 1024, allowRead: true },
        net: { httpsHosts: ['api.example.com'] },
      },
    },
    (c) => {
      c.ui.registerStatusItem({ id: 'st1', label: 'Ready' });
      c.ui.registerSettingsPage({
        id: 'pg1',
        title: 'Main',
        schema: { fields: [{ key: 'enabled', type: 'toggle', label: 'Enabled' }] },
      });
    }
  );
  assert.ok(ctx);
  assert.equal(desktopHost.getStatusItems().length, 1);
  assert.equal(desktopHost.getSettingsPages().length, 1);
  assert.ok(Array.isArray(desktopHost.getSectionActions()));
  desktopHost.setLocale('en');

  // Secrets full lifecycle + validation + maxKeys + sorted secretsList
  assert.equal((await ctx.secrets.set('zeta_key', 'val-z')).ok, true);
  assert.equal((await ctx.secrets.set('alpha_key', 'val-a')).ok, true);
  assert.equal((await ctx.secrets.set('third_key', 'val-3')).reason, 'ERR_SECRETS_MAX_KEYS_EXCEEDED');
  assert.equal((await ctx.secrets.set('bad key!', 'v')).ok, false);
  assert.equal((await ctx.secrets.set('alpha_key', 12345)).ok, false);
  assert.equal(await ctx.secrets.has('alpha_key'), true);
  assert.equal(await ctx.secrets.has('bad key!'), false);
  assert.equal(await ctx.secrets.get('alpha_key'), 'val-a');
  assert.equal(await ctx.secrets.get('missing_key'), undefined);
  assert.equal(await ctx.secrets.get('bad key!'), undefined);
  assert.deepEqual(await ctx.secrets.keys(), ['alpha_key', 'zeta_key']);
  assert.equal(ctx.secrets.getPersistenceMode(), 'os-encrypted');

  // netFetch with secretHeaders (success + missing secret)
  const nfOk = await ctx.net.fetch('https://api.example.com/v1', {
    method: 'POST',
    secretHeaders: { Authorization: { secretKey: 'alpha_key', prefix: 'Bearer ' } },
  });
  assert.equal(nfOk.ok, true);
  assert.equal(capturedNet[0].init.headers.Authorization, 'Bearer val-a');
  const nfMiss = await ctx.net.fetch('https://api.example.com/v1', {
    secretHeaders: { Authorization: { secretKey: 'nope_key', prefix: 'Bearer ' } },
  });
  assert.equal(nfMiss.ok, false);

  assert.equal(await ctx.secrets.delete('zeta_key'), true);
  assert.equal(await ctx.secrets.delete('bad key!'), false);

  // Config bridge read (existing) & write + settings save
  assert.equal((await ctx.configBridge.read('mcp')).ok, true);
  assert.equal((await ctx.configBridge.write('mcp', { servers: { b: 2 } })).ok, true);
  if (ctx.settingsBridge && typeof ctx.settingsBridge.save === 'function') {
    assert.equal((await ctx.settingsBridge.save({ enabled: false })).ok, true);
  }

  // Mount trusted plugin with allowRead: false to verify ctx.secrets.get is omitted
  const ctxWriteOnly = await desktopHost.mountPlugin({
    schemaVersion: 3,
    pluginId: 'sdk-p2',
    trustLevel: 'trusted',
    permissions: { secrets: { allowRead: false } },
  });
  await ctxWriteOnly.secrets.set('k1', 'secret');
  assert.equal(ctxWriteOnly.secrets.get, undefined);

  // Mount restricted v2 plugin + remote-web host (connected + disconnected, no netHandler)
  await desktopHost.mountPlugin({ schemaVersion: 2, pluginId: 'sdk-v2', trustLevel: 'restricted' });
  desktopHost.disposePlugin('sdk-p1');
  desktopHost.disposePlugin('sdk-p2');
  desktopHost.disposePlugin('sdk-v2');

  const remoteConnHost = createTestHost({
    surface: 'remote-web',
    remoteBridgeConnected: true,
    configScopes: { mcp: { data: { ok: true } } },
  });
  const rCtx = await remoteConnHost.mountPlugin({
    schemaVersion: 3,
    pluginId: 'sdk-r1',
    trustLevel: 'trusted',
    permissions: {
      configBridge: { scopes: [{ scopeId: 'mcp', access: 'ro' }] },
      net: { httpsHosts: ['api.example.com'] },
    },
  });
  assert.equal((await rCtx.net.fetch('https://api.example.com/test')).reason, 'ERR_TEST_HOST_NET_HANDLER_NOT_CONFIGURED');
  assert.equal(
    (await rCtx.net.fetch('https://api.example.com/test', { secretHeaders: { 'X-K': { secretKey: 'k1' } } })).reason,
    'ERR_SECRETS_NOT_DECLARED'
  );
  remoteConnHost.disposePlugin('sdk-r1');

  const remoteOfflineHost = createTestHost({ surface: 'remote-web', remoteBridgeConnected: false });
  assert.equal(remoteOfflineHost.surface, 'remote-web');
});

test('TC-BR-06: preload-bridge.js enforces mainFrame/contextIsolated/verify-frame/single-claim guards and maps every IPC channel', async () => {
  const preloadPath = require.resolve('../../src/runtime/preload/preload-bridge.js');
  const origLoad = Module._load;
  const origIsMainFrame = Object.getOwnPropertyDescriptor(process, 'isMainFrame');
  const origContextIsolated = Object.getOwnPropertyDescriptor(process, 'contextIsolated');

  function runPreloadWith({ isMainFrame = true, contextIsolated = true, verifyDecision = { ok: true, worldId: 998 }, verifyThrows = false, exposeThrows = false, claimRes = { ok: true, docGenId: 42 }, sendThrows = false } = {}) {
    const exposed = [];
    const invoked = [];
    const sent = [];
    const fakeElectron = {
      contextBridge: {
        exposeInIsolatedWorld(worldId, name, api) {
          if (exposeThrows) throw new Error('EXPOSE_ERR');
          exposed.push({ worldId, name, api });
        },
      },
      ipcRenderer: {
        sendSync(channel, arg) {
          if (channel === 'addon-host:v2:verify-frame') {
            if (verifyThrows) throw new Error('VERIFY_ERR');
            return verifyDecision;
          }
          if (channel === 'addon-host:v2:claim-nonce') {
            return typeof claimRes === 'function' ? claimRes(arg) : claimRes;
          }
          return null;
        },
        invoke(channel, payload) {
          invoked.push({ channel, payload });
          return Promise.resolve({ ok: true, channel, payload });
        },
        send(channel, payload) {
          if (sendThrows) throw new Error('SEND_ERR');
          sent.push({ channel, payload });
        },
      },
    };
    Object.defineProperty(process, 'isMainFrame', { value: isMainFrame, configurable: true, writable: true });
    Object.defineProperty(process, 'contextIsolated', { value: contextIsolated, configurable: true, writable: true });
    delete require.cache[preloadPath];
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'electron') return fakeElectron;
      return origLoad.call(this, request, parent, isMain);
    };
    try {
      require(preloadPath);
    } finally {
      Module._load = origLoad;
      delete require.cache[preloadPath];
    }
    return { exposed, invoked, sent };
  }

  try {
    // 1. Subframe / non-isolated / verify-frame failure / expose error guards
    assert.equal(runPreloadWith({ isMainFrame: false }).exposed.length, 0);
    assert.equal(runPreloadWith({ contextIsolated: false }).exposed.length, 0);
    assert.equal(runPreloadWith({ verifyThrows: true }).exposed.length, 0);
    assert.equal(runPreloadWith({ verifyDecision: { ok: false } }).exposed.length, 0);
    assert.equal(runPreloadWith({ exposeThrows: true }).exposed.length, 0);

    // 2. World ID fallback (999 -> 998) and custom valid worldId (997)
    const fbWorld = runPreloadWith({ verifyDecision: { ok: true, worldId: 999 } });
    assert.equal(fbWorld.exposed[0].worldId, 998);
    const customWorld = runPreloadWith({ verifyDecision: { ok: true, worldId: 997 } });
    assert.equal(customWorld.exposed[0].worldId, 997);

    // 3. Single-claim nonce validation + rejection + full IPC method coverage
    let claimStep = 0;
    const okRun = runPreloadWith({
      verifyDecision: { ok: true, worldId: 998 },
      claimRes: () => {
        claimStep += 1;
        if (claimStep === 1) return { ok: false, reason: 'ERR_EXPIRED' };
        if (claimStep === 2) return { ok: false };
        return { ok: true, docGenId: 77 };
      },
    });
    const bootstrap = okRun.exposed[0].api;
    assert.throws(() => bootstrap.claim('short'), /ERR_INVALID_CLAIM_NONCE/);
    assert.throws(() => bootstrap.claim(1234567890123456), /ERR_INVALID_CLAIM_NONCE/);
    assert.throws(() => bootstrap.claim('0123456789abcdef0123'), /ERR_EXPIRED/);
    assert.throws(() => bootstrap.claim('0123456789abcdef0123'), /ERR_CLAIM_NONCE_REJECTED/);

    const bridge = bootstrap.claim('0123456789abcdef0123');
    assert.equal(bridge.docGenId, 77);
    assert.throws(() => bootstrap.claim('0123456789abcdef0123'), /ERR_BRIDGE_ALREADY_CLAIMED/);

    await bridge.setPortalClaim('c1', true);
    await bridge.saveSettings('p1', '{"a":1}');
    await bridge.saveSettings('p1', 123);
    await bridge.readConfigScope('p1', 'mcp');
    await bridge.writeConfigScope('p1', 'mcp', '{"x":1}', { expectedSha256: 'abc' });
    await bridge.writeConfigScope('p1', 'mcp', null);
    await bridge.getHostAdminState();
    await bridge.setRemoteAddonPreference('p1', true);
    await bridge.configureRemoteBridge({ enabled: true });
    await bridge.configureRemoteBridge(null);
    await bridge.rotateRemoteBridgeToken();
    await bridge.rebuildRemoteBundle();
    await bridge.netFetch('p1', 'https://api.example.com', {
      method: 'POST',
      headers: { 'X-A': '1' },
      body: 'hi',
      timeoutMs: 3000,
      secretHeaders: { Authorization: { secretKey: 'k1' } },
    });
    await bridge.netFetch('p1', 'https://api.example.com', null);
    await bridge.secretsSet('p1', 'k1', 'val');
    await bridge.secretsSet('p1', 'k1', null);
    await bridge.secretsGet('p1', 'k1');
    await bridge.secretsHas('p1', 'k1');
    await bridge.secretsDelete('p1', 'k1');
    await bridge.secretsList('p1');
    bridge.reportError('p1', 'boom');
    await bridge.ping();

    assert.equal(okRun.invoked.length, 21);
    assert.equal(okRun.sent.length, 1);

    // 4. reportError swallows ipcRenderer.send exceptions cleanly
    const errSendRun = runPreloadWith({ sendThrows: true });
    const errBridge = errSendRun.exposed[0].api.claim('0123456789abcdef0123');
    assert.doesNotThrow(() => errBridge.reportError('p1', 'err'));
  } finally {
    Module._load = origLoad;
    if (origIsMainFrame) Object.defineProperty(process, 'isMainFrame', origIsMainFrame);
    else delete process.isMainFrame;
    if (origContextIsolated) Object.defineProperty(process, 'contextIsolated', origContextIsolated);
    else delete process.contextIsolated;
  }
});

test('TC-BR-07: config-bridge error/RO guards, remote-host-transport pairing/GM storage, init-main lifecycle/error capture, and build-runtime --check', async () => {
  // 1. config-bridge failure & permission boundary paths
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extenra-br07-'));
  try {
    const cfgFile = path.join(tmpDir, 'scope.json');
    const reservedFile = path.join(tmpDir, 'reserved.json');
    fs.writeFileSync(cfgFile, '{"a":1}', 'utf8');
    fs.writeFileSync(reservedFile, '{"secret":true}', 'utf8');

    const cb = createConfigBridge({
      configScopes: {
        rwScope: { kind: 'file', access: 'rw', filePath: cfgFile, maxBytes: 4096 },
        roScope: { kind: 'file', access: 'ro', filePath: cfgFile, maxBytes: 4096 },
        reservedScope: { kind: 'file', access: 'rw', filePath: reservedFile, maxBytes: 4096 },
        ignoredScope: { kind: 'unknown', access: 'ro' },
      },
      reservedFilePaths: [reservedFile],
    });
    assert.equal(cb.getStatus().scopeCount, 3);
    const binding = {
      scopes: [
        { scopeId: 'rwScope', access: 'ro', maxBytes: 1024 },
        { scopeId: 'roScope', access: 'rw', maxBytes: 1024 },
        { scopeId: 'reservedScope', access: 'rw', maxBytes: 1024 },
        { scopeId: 'missingHostScope', access: 'rw', maxBytes: 1024 },
      ],
    };
    assert.equal(cb.readScopeForPlugin('p1', binding, '').reason, 'ERR_INVALID_CONFIG_SCOPE_ID');
    assert.equal(cb.readScopeForPlugin('p1', binding, 'undeclared').reason, 'ERR_CONFIG_SCOPE_NOT_DECLARED');
    assert.equal(cb.readScopeForPlugin('p1', binding, 'missingHostScope').reason, 'ERR_CONFIG_SCOPE_NOT_SUPPORTED');
    assert.equal(cb.readScopeForPlugin('p1', binding, 'reservedScope').ok, false);
    assert.equal(cb.writeScopeForPlugin('p1', binding, '', '{}').reason, 'ERR_INVALID_CONFIG_SCOPE_ID');
    assert.equal(cb.writeScopeForPlugin('p1', binding, 'undeclared', '{}').reason, 'ERR_CONFIG_SCOPE_NOT_DECLARED');
    assert.equal(cb.writeScopeForPlugin('p1', binding, 'rwScope', '{}').reason, 'ERR_CONFIG_SCOPE_READ_ONLY');
    assert.equal(cb.writeScopeForPlugin('p1', binding, 'missingHostScope', '{}').reason, 'ERR_CONFIG_SCOPE_NOT_SUPPORTED');
    assert.equal(cb.writeScopeForPlugin('p1', binding, 'roScope', '{}').reason, 'ERR_CONFIG_SCOPE_READ_ONLY');
    assert.equal(cb.writeScopeForPlugin('p1', binding, 'reservedScope', '{}').ok, false);

    // Faulty fsImpl triggers catch branches
    const diags = [];
    const faultyCb = createConfigBridge({
      configScopes: { rwScope: { kind: 'file', access: 'rw', filePath: cfgFile, maxBytes: 4096 } },
      fsImpl: {
        ...fs,
        lstatSync: () => {
          throw new Error('FS_BOOM');
        },
        realpathSync: () => {
          throw new Error('FS_BOOM');
        },
      },
      recordDiag: (lvl, code) => diags.push({ lvl, code }),
    });
    const rwBinding = { scopes: [{ scopeId: 'rwScope', access: 'rw', maxBytes: 4096 }] };
    assert.equal(faultyCb.readScopeForPlugin('p1', rwBinding, 'rwScope').ok, false);
    assert.equal(faultyCb.writeScopeForPlugin('p1', rwBinding, 'rwScope', '{"x":1}').ok, false);

    // 2. remote-host-transport URL, pairing code, prototype pollution, GM sync/async storage, and memory fallback
    assert.equal(normalizeBridgeBaseUrl('').reason, 'ERR_REMOTE_BRIDGE_INVALID_URL');
    assert.equal(normalizeBridgeBaseUrl('not-a-url').reason, 'ERR_REMOTE_BRIDGE_INVALID_URL');
    assert.equal(normalizeBridgeBaseUrl('https://user:pass@example.com').reason, 'ERR_REMOTE_BRIDGE_INVALID_URL');
    assert.equal(normalizeBridgeBaseUrl('http://example.com').reason, 'ERR_REMOTE_BRIDGE_HTTPS_REQUIRED');
    assert.equal(normalizeBridgeBaseUrl('ftp://127.0.0.1:8080').reason, 'ERR_REMOTE_BRIDGE_HTTPS_REQUIRED');
    assert.equal(normalizeBridgeBaseUrl('http://127.0.0.1:19384///').baseUrl, 'http://127.0.0.1:19384');

    assert.equal(parsePairingCode(123).reason, 'ERR_INVALID_PAIRING_CODE');
    assert.equal(parsePairingCode('wrong:abc').reason, 'ERR_INVALID_PAIRING_CODE');
    assert.equal(parsePairingCode('ag-bridge-v1:!!!bad!!!').reason, 'ERR_INVALID_PAIRING_CODE');
    const protoPayload = Buffer.from('{"v":1,"__proto__":{"polluted":true},"url":"http://127.0.0.1:19384","token":"' + 'a'.repeat(40) + '"}').toString('base64url');
    assert.equal(parsePairingCode(`ag-bridge-v1:${protoPayload}`).reason, 'ERR_INVALID_PAIRING_CODE');
    const badVerPayload = Buffer.from(JSON.stringify({ v: 2, url: 'http://127.0.0.1:19384', token: 'a'.repeat(40) })).toString('base64url');
    assert.equal(parsePairingCode(`ag-bridge-v1:${badVerPayload}`).reason, 'ERR_INVALID_PAIRING_CODE');
    const badTokPayload = Buffer.from(JSON.stringify({ v: 1, url: 'http://127.0.0.1:19384', token: 'short' })).toString('base64url');
    assert.equal(parsePairingCode(`ag-bridge-v1:${badTokPayload}`).reason, 'ERR_INVALID_PAIRING_CODE_TOKEN');
    const goodPayload = Buffer.from(JSON.stringify({ v: 1, url: 'http://127.0.0.1:19384/', token: 'a'.repeat(40) })).toString('base64url');
    const parsedGood = parsePairingCode(`ag-bridge-v1:${goodPayload}`);
    assert.equal(parsedGood.ok, true);
    assert.equal(parsedGood.baseUrl, 'http://127.0.0.1:19384');

    // Sync GM_getValue/GM_setValue storage resolution
    const gmMap = new Map();
    const tSyncGm = createRemoteHostTransport({
      win: {
        GM_getValue: (k, d) => (gmMap.has(k) ? gmMap.get(k) : d),
        GM_setValue: (k, v) => gmMap.set(k, v),
        GM_deleteValue: (k) => gmMap.delete(k),
      },
      fetchFn: async () => {
        throw new Error('NET_DOWN');
      },
    });
    assert.equal((await tSyncGm.connectWithPairingCode('invalid')).ok, false);
    assert.equal((await tSyncGm.connectWithPairingCode(`ag-bridge-v1:${goodPayload}`)).ok, false);
    tSyncGm.disconnect();

    // Async GM.getValue/GM.setValue storage resolution + hydrate
    const gmAsyncMap = new Map();
    const tAsyncGm = createRemoteHostTransport({
      win: {
        GM: {
          getValue: async (k, d) => (gmAsyncMap.has(k) ? gmAsyncMap.get(k) : d),
          setValue: async (k, v) => gmAsyncMap.set(k, v),
          deleteValue: async (k) => gmAsyncMap.delete(k),
        },
      },
      fetchFn: async () => ({ ok: false, status: 503, text: async () => 'unavailable' }),
    });
    await tAsyncGm.hydrate();
    tAsyncGm.disconnect();

    // Memory fallback transport
    const tMem = createRemoteHostTransport({ win: {} });
    assert.equal(tMem.isConnected(), false);

    // 3. init-main loadRawManifestsFromDir & createHostRuntimeController lifecycle/will-quit/dispose
    const addonsDir = path.join(tmpDir, 'addons');
    fs.mkdirSync(addonsDir, { recursive: true });
    fs.writeFileSync(path.join(addonsDir, 'b.json'), '{"pluginId":"b"}', 'utf8');
    fs.writeFileSync(path.join(addonsDir, 'a.json'), '{"pluginId":"a"}', 'utf8');
    fs.writeFileSync(path.join(addonsDir, 'bad.json'), '{not-json', 'utf8');
    fs.writeFileSync(path.join(addonsDir, 'ignore.txt'), 'hi', 'utf8');
    const loaded = loadRawManifestsFromDir(addonsDir);
    assert.equal(loaded.length, 3);
    assert.ok(loaded[0].source.endsWith('a.json'));
    assert.ok(loaded[2].parseError);
    assert.deepEqual(loadRawManifestsFromDir(path.join(tmpDir, 'does-not-exist')), []);

    const appListeners = new Map();
    let resolveReady;
    const readyPromise = new Promise((r) => {
      resolveReady = r;
    });
    const fakeApp = {
      isReady: () => true,
      whenReady: () => readyPromise,
      on(ev, fn) {
        if (!appListeners.has(ev)) appListeners.set(ev, []);
        appListeners.get(ev).push(fn);
      },
    };
    const fakeIpc = {
      handlers: new Map(),
      listeners: new Map(),
      handle(ch, fn) {
        this.handlers.set(ch, fn);
      },
      on(ch, fn) {
        this.listeners.set(ch, fn);
      },
      removeHandler(ch) {
        this.handlers.delete(ch);
      },
    };
    const fakeSession = {
      defaultSession: {
        registerPreloadScript() {},
        setPreloads() {},
        getPreloads: () => [],
      },
    };
    const ctrl = createHostRuntimeController(
      {
        profile: { id: 'test-host', supportedCapabilities: ['renderer'] },
        addonsDir,
        pluginsRootDir: path.join(tmpDir, 'plugins'),
        settingsDataDir: tmpDir,
        trustPolicyPath: path.join(tmpDir, 'trust-policy.json'),
        configJsonPath: path.join(tmpDir, 'config.json'),
      },
      { app: fakeApp, ipcMain: fakeIpc, session: fakeSession }
    );
    ctrl.start();
    resolveReady();
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(Array.isArray(ctrl.getDiagnostics()));
    assert.ok(ctrl.getPortalArbiterStatus());
    assert.ok(ctrl.getUpdateSurvivalStatus());
    assert.ok(ctrl.getPreloadStatus());
    assert.ok(ctrl.getSettingsBridgeStatus());
    assert.ok(ctrl.getConfigBridgeStatus());
    assert.ok(ctrl.getSecretsVaultStatus());
    assert.ok(ctrl.getRemoteBridgeStatus());
    assert.ok(ctrl.getHostAdminState());
    for (const fn of appListeners.get('will-quit') || []) fn();
    await new Promise((r) => setTimeout(r, 20));
    await ctrl.dispose();

    // 4. scripts/build-runtime.js --check subprocess verification (covers compareTrees & zero-drift)
    const checkOut = execFileSync(process.execPath, [path.resolve(__dirname, '..', '..', 'scripts', 'build-runtime.js'), '--check'], {
      cwd: path.resolve(__dirname, '..', '..'),
      encoding: 'utf8',
    });
    const parsedCheck = JSON.parse(checkOut.trim());
    assert.equal(parsedCheck.ok, true);
    assert.equal(parsedCheck.astViolations, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
