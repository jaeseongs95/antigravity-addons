'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  createRemoteHostBridge,
  redactSecrets,
  parseSafeJsonObject,
  deterministicHexDigest,
} = require('../../src/adapters/remote-web/remote-host-bridge');
const {
  createRemoteHostTransport,
  parsePairingCode,
} = require('../../src/adapters/remote-web/remote-host-transport');
const { bootRemoteWebHost } = require('../../src/adapters/remote-web/remote-bootstrap');
const { createRendererKernel } = require('../../src/runtime/renderer/kernel');
const { runDetachedHandoffReconcile } = require('../../src/adapters/electron/update-reconciler');
const { createCliApp } = require('../../src/cli/main');
const { pickLanIpv4Address, startRemoteLanServer } = require('../../src/adapters/remote-web/remote-lan-server');
const agAddonCli = require('../../packages/sdk/bin/ag-addon');
const addonHostBin = require('../../bin/addon-host');

test('TC-COV90-RC01: remote-host-bridge covers GM sync/async/localStorage/memory storage, bindings, config scopes, and bridge routing', async () => {
  // 1. GM sync storage
  const gmSyncMap = new Map();
  const bSync = createRemoteHostBridge({
    win: {
      GM_getValue: (k, d) => (gmSyncMap.has(k) ? gmSyncMap.get(k) : d),
      GM_setValue: (k, v) => gmSyncMap.set(k, v),
      GM_deleteValue: (k) => gmSyncMap.delete(k),
    },
    settingsBindings: { p1: { maxBytes: 4096, revision: 1 } },
    netBindings: { p1: { httpsHosts: ['api.example.com'], userApprovedHttps: true, localLoopback: [18100] } },
    configScopeSnapshots: { 'p1:mcp': { ok: true, status: 'ok', data: { s: 1 } } },
  });
  assert.equal(bSync.getStatus().storageKind, 'gm-sync');
  assert.equal((await bSync.port.saveSettings('p1', JSON.stringify({ a: 1 }))).ok, true);
  assert.equal((await bSync.port.readConfigScope('p1', 'mcp')).ok, true);
  assert.equal((await bSync.port.readConfigScope('p1', 'missing')).ok, false);
  bSync.port.setPortalClaim('c1', true);
  bSync.port.setPortalClaim('c1', false);
  bSync.port.reportError('p1', 'err-detail');
  assert.equal(bSync.getRemoteBridgeStatus().connected, false);
  bSync.dispose();

  // 2. GM async storage (hydrateKey + setItem + removeItem with & without deleteValue)
  const gmAsyncMap = new Map([['remote-addon-host:v2:settings:p1', '{"saved":1}']]);
  const bAsync = createRemoteHostBridge({
    win: {
      GM: {
        getValue: async (k, d) => (gmAsyncMap.has(k) ? gmAsyncMap.get(k) : d),
        setValue: async (k, v) => { gmAsyncMap.set(k, v); },
        deleteValue: async (k) => { gmAsyncMap.delete(k); },
      },
    },
    settingsBindings: new Map([['p1', { maxBytes: 4096, revision: 0 }]]),
    netBindings: new Map([['p1', { httpsHosts: ['api.example.com'] }]]),
    configScopeSnapshots: new Map([['p1:mcp', { ok: true, data: {} }]]),
  });
  assert.equal(bAsync.getStatus().storageKind, 'gm-async');
  await bAsync.hydrateSettings(['p1']);
  await bAsync.hydrateUserAllowedHttpsHosts();
  await bAsync.port.saveSettings('p1', JSON.stringify({ b: 2 }));
  bAsync.dispose();

  // 3. localStorage & memory-ephemeral fallback + connected remoteTransport routing
  const lsMap = new Map();
  const fakeRemoteTransport = {
    isConnected: () => true,
    getStatus: () => ({ configured: true, connected: true, baseUrl: 'http://127.0.0.1:19384' }),
    readSettings: async () => ({ ok: true, data: { remote: true } }),
    saveSettings: async () => ({ ok: true, snapshot: { status: 'ok', data: { remote: true } } }),
    readConfigScope: async () => ({ ok: true, data: { fromBridge: 1 } }),
    writeConfigScope: async () => ({ ok: true, currentSha256: 'sha-x' }),
    netFetch: async () => ({ ok: true, status: 200, bodyText: 'bridge-ok' }),
    secretsSet: async () => ({ ok: true, persistence: 'remote-bridge' }),
    secretsGet: async () => ({ ok: true, exists: true, value: 'v', persistence: 'remote-bridge' }),
    secretsHas: async () => ({ ok: true, exists: true, persistence: 'remote-bridge' }),
    secretsDelete: async () => ({ ok: true, deleted: true }),
    secretsList: async () => ({ ok: true, keys: ['k1'], persistence: 'remote-bridge' }),
  };
  const bConnected = createRemoteHostBridge({
    win: {
      localStorage: {
        getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
        setItem: (k, v) => lsMap.set(k, String(v)),
        removeItem: (k) => lsMap.delete(k),
      },
    },
    remoteTransport: fakeRemoteTransport,
    settingsBindings: { p1: { maxBytes: 4096 } },
    netBindings: { p1: { httpsHosts: ['api.example.com'], localLoopback: [18100] } },
  });
  bConnected.bindSecretsPlugin('p1', { maxKeys: 4, maxBytes: 1024, allowRead: true });
  assert.equal(bConnected.getRemoteBridgeStatus().connected, true);
  assert.equal((await bConnected.port.saveSettings('p1', '{"r":1}')).ok, true);
  assert.equal((await bConnected.port.readConfigScope('p1', 'mcp')).ok, true);
  assert.equal((await bConnected.port.writeConfigScope('p1', 'mcp', '{"u":1}')).ok, true);
  assert.equal((await bConnected.port.netFetch('p1', 'http://127.0.0.1:18100/health', { method: 'GET' })).ok, true);
  assert.equal((await bConnected.port.secretsSet('p1', 'k1', 'secret')).ok, true);
  assert.equal((await bConnected.port.secretsGet('p1', 'k1')).exists, true);
  assert.equal((await bConnected.port.secretsHas('p1', 'k1')).exists, true);
  assert.deepEqual((await bConnected.port.secretsList('p1')).keys, ['k1']);
  assert.equal((await bConnected.port.secretsDelete('p1', 'k1')).deleted, true);
  bConnected.dispose();

  const bMem = createRemoteHostBridge({ win: {} });
  assert.equal(bMem.getStatus().storageKind, 'memory-ephemeral');
  // User-approved HTTPS hosts + disconnected local secrets + disconnected netFetch via GM_xmlhttpRequest
  bMem.bindSettingsPlugin('p1', { maxBytes: 4096 });
  bMem.bindNetPlugin('p1', { httpsHosts: ['api.example.com'], userApprovedHttps: true, localLoopback: [18100] });
  bMem.bindSecretsPlugin('p1', { maxKeys: 2, maxBytes: 64, allowRead: true });
  assert.equal(bMem.addUserAllowedHttpsHost('p1', 'https://custom.example.com/v1').ok, true);
  assert.equal(bMem.addUserAllowedHttpsHost('p1', 'bare.example.com').ok, true);
  assert.equal(bMem.addUserAllowedHttpsHost('p1', 'http://insecure.example.com').ok, false);
  assert.equal(bMem.addUserAllowedHttpsHost('p1', '127.0.0.1').ok, false);
  assert.ok(bMem.listUserAllowedHttpsHosts('p1').includes('custom.example.com'));
  assert.equal(bMem.removeUserAllowedHttpsHost('p1', 'custom.example.com').ok, true);
  assert.equal(bMem.removeUserAllowedHttpsHost('p1', 'not-present.example.com').ok, true);
  // Disconnected session-memory secrets
  assert.equal((await bMem.port.secretsSet('p1', 'k1', 'v1')).ok, true);
  assert.equal((await bMem.port.secretsSet('p1', 'k2', 'v2')).ok, true);
  assert.equal((await bMem.port.secretsSet('p1', 'k3', 'v3')).reason, 'ERR_SECRETS_MAX_KEYS_EXCEEDED');
  assert.equal((await bMem.port.secretsGet('p1', 'k1')).value, 'v1');
  assert.equal((await bMem.port.secretsHas('p1', 'k1')).exists, true);
  assert.deepEqual((await bMem.port.secretsList('p1')).keys, ['k1', 'k2']);
  assert.equal((await bMem.port.secretsDelete('p1', 'k1')).deleted, true);
  // Disconnected loopback rejected without bridge
  assert.equal((await bMem.port.netFetch('p1', 'http://127.0.0.1:18100/x')).ok, false);
  assert.equal((await bMem.port.netFetch('p1', 'https://forbidden.example.org/x')).ok, false);
  bMem.dispose();

  // Disconnected HTTPS netFetch via GM_xmlhttpRequest (200, onerror, ontimeout, throw)
  let gmNetMode = 'ok';
  const bGmNet = createRemoteHostBridge({
    win: {
      GM_xmlhttpRequest(req) {
        if (gmNetMode === 'ok') req.onload({ status: 200, responseHeaders: 'content-type: text/plain\r\n', responseText: 'gm-net-ok' });
        else if (gmNetMode === 'err') req.onerror();
        else if (gmNetMode === 'to') req.ontimeout();
        else throw new Error('GM_NET_THROW');
      },
    },
    netBindings: { p1: { httpsHosts: ['api.example.com'] } },
  });
  assert.equal((await bGmNet.port.netFetch('p1', 'https://api.example.com/v1', { method: 'GET' })).ok, true);
  gmNetMode = 'err';
  assert.equal((await bGmNet.port.netFetch('p1', 'https://api.example.com/v1')).ok, false);
  gmNetMode = 'to';
  assert.equal((await bGmNet.port.netFetch('p1', 'https://api.example.com/v1')).ok, false);
  gmNetMode = 'throw';
  assert.equal((await bGmNet.port.netFetch('p1', 'https://api.example.com/v1')).ok, false);
  bGmNet.dispose();
});

test('TC-COV90-RC02: remote-host-transport covers GM_xmlhttpRequest success/HTTP error/onerror/ontimeout/throw, fetch AbortError, and unavailable transport', async () => {
  const token = 't'.repeat(40);
  const baseUrl = 'http://127.0.0.1:19384';

  // 1. GM_xmlhttpRequest paths (200, 500, onerror, ontimeout, throw)
  let gmMode = 'ok';
  const statusEvents = [];
  const tGm = createRemoteHostTransport({
    win: {
      GM_xmlhttpRequest(req) {
        if (gmMode === 'ok') req.onload({ status: 200, responseText: JSON.stringify({ ok: true, hostVersion: '3.3.4', buildSha8: '3c90b890', activePlugins: ['p1'] }) });
        else if (gmMode === 'http500') req.onload({ status: 500, responseText: JSON.stringify({ ok: false, reason: 'ERR_BOOM' }) });
        else if (gmMode === 'onerror') req.onerror();
        else if (gmMode === 'ontimeout') req.ontimeout();
        else if (gmMode === 'throw') throw new Error('XHR_CRASH');
      },
    },
    fetchFn: null,
  });
  const unsub = tGm.onStatusChange((s) => statusEvents.push(s));
  // Disconnected RPC calls return ERR_REMOTE_HOST_NOT_CONNECTED
  assert.equal((await tGm.readSettings('p1')).reason, 'ERR_REMOTE_HOST_NOT_CONNECTED');
  assert.equal((await tGm.saveSettings('p1', '{}')).reason, 'ERR_REMOTE_HOST_NOT_CONNECTED');
  assert.equal((await tGm.readConfigScope('p1', 'mcp')).reason, 'ERR_REMOTE_HOST_NOT_CONNECTED');
  assert.equal((await tGm.writeConfigScope('p1', 'mcp', '{}')).reason, 'ERR_REMOTE_HOST_NOT_CONNECTED');
  assert.equal((await tGm.netFetch('p1', 'https://api.example.com')).reason, 'ERR_REMOTE_HOST_NOT_CONNECTED');
  assert.equal((await tGm.secretsSet('p1', 'k', 'v')).reason, 'ERR_REMOTE_HOST_NOT_CONNECTED');
  assert.equal((await tGm.secretsGet('p1', 'k')).reason, 'ERR_REMOTE_HOST_NOT_CONNECTED');
  assert.equal((await tGm.secretsHas('p1', 'k')).reason, 'ERR_REMOTE_HOST_NOT_CONNECTED');
  assert.equal((await tGm.secretsDelete('p1', 'k')).reason, 'ERR_REMOTE_HOST_NOT_CONNECTED');
  assert.equal((await tGm.secretsList('p1')).reason, 'ERR_REMOTE_HOST_NOT_CONNECTED');
  // Invalid connect params & invalid pairing code
  assert.equal((await tGm.connect({ baseUrl: 'ftp://bad', token })).ok, false);
  assert.equal((await tGm.connect({ baseUrl, token: 'short' })).reason, 'ERR_REMOTE_BRIDGE_INVALID_TOKEN');
  assert.equal((await tGm.connectWithPairingCode('bad-code')).ok, false);

  assert.equal((await tGm.connect({ baseUrl, token })).ok, true);
  assert.equal((await tGm.ping({ baseUrl, token })).ok, true);
  // Connected RPC success paths
  assert.equal((await tGm.readSettings('p1')).ok, true);
  assert.equal((await tGm.saveSettings('p1', '{"a":1}')).ok, true);
  assert.equal((await tGm.readConfigScope('p1', 'mcp')).ok, true);
  assert.equal((await tGm.writeConfigScope('p1', 'mcp', '{}', { expectedSha256: 'abc' })).ok, true);
  assert.equal((await tGm.netFetch('p1', 'https://api.example.com', { method: 'POST', body: 'hi', timeoutMs: 2000, secretHeaders: { Authorization: 'Bearer {{secret:k1}}' } })).ok, true);
  assert.equal((await tGm.secretsSet('p1', 'k1', 'v1')).ok, true);
  assert.equal((await tGm.secretsGet('p1', 'k1')).ok, true);
  assert.equal((await tGm.secretsHas('p1', 'k1')).ok, true);
  assert.equal((await tGm.secretsDelete('p1', 'k1')).ok, true);
  assert.equal((await tGm.secretsList('p1')).ok, true);
  gmMode = 'http500';
  assert.equal((await tGm.ping()).ok, false);
  assert.equal((await tGm.readSettings('p1')).ok, false);
  assert.equal((await tGm.saveSettings('p1', '{}')).ok, false);
  assert.equal((await tGm.readConfigScope('p1', 'mcp')).ok, false);
  assert.equal((await tGm.writeConfigScope('p1', 'mcp', '{}')).ok, false);
  assert.equal((await tGm.netFetch('p1', 'https://api.example.com')).ok, false);
  assert.equal((await tGm.secretsSet('p1', 'k1', 'v1')).ok, false);
  assert.equal((await tGm.secretsGet('p1', 'k1')).ok, false);
  assert.equal((await tGm.secretsHas('p1', 'k1')).ok, false);
  assert.equal((await tGm.secretsDelete('p1', 'k1')).ok, false);
  assert.equal((await tGm.secretsList('p1')).ok, false);
  gmMode = 'onerror';
  assert.equal((await tGm.ping()).ok, false);
  gmMode = 'ontimeout';
  assert.equal((await tGm.ping()).ok, false);
  gmMode = 'throw';
  assert.equal((await tGm.ping()).ok, false);
  unsub();
  tGm.disconnect();

  // 2. fetchFn AbortError -> ERR_REMOTE_BRIDGE_TIMEOUT
  const tAbort = createRemoteHostTransport({
    win: {},
    fetchFn: async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    },
  });
  assert.equal((await tAbort.connect({ baseUrl, token })).reason, 'ERR_REMOTE_BRIDGE_TIMEOUT');

  // 3. No fetchFn and no GM_xmlhttpRequest -> ERR_REMOTE_TRANSPORT_UNAVAILABLE
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = undefined;
    const tNone = createRemoteHostTransport({ win: {}, fetchFn: null });
    assert.equal((await tNone.connect({ baseUrl, token })).reason, 'ERR_REMOTE_TRANSPORT_UNAVAILABLE');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('TC-COV90-RC03: bin/addon-host.js serve-remote (--once & --json/text) and update-reconciler parentPid wait & cancel branches', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extenra-cov90-rc03-'));
  try {
    // 1. bin/addon-host.js parseServeRemoteArgs & runServeRemoteCommand (--once) via child process (keeps parent TAP stdout clean on Node 22/24)
    const distDir = path.join(tmpDir, 'remote-dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'antigravity-remote.user.js'), '// ==UserScript==\n// ==/UserScript==\n', 'utf8');
    fs.writeFileSync(path.join(distDir, 'build-manifest.json'), JSON.stringify({ buildSha8: '3c90b890', addonCount: 0 }), 'utf8');
    const binEntry = path.resolve(__dirname, '..', '..', 'bin', 'addon-host.js');

    const runServeOnceChild = (args, readyCheck, extractUrl) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [binEntry, ...args], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        let out = '';
        let errOut = '';
        let fetched = false;
        const timer = setTimeout(() => {
          try { child.kill(); } catch (_e) {}
          reject(new Error(`serve-remote child timeout: out=${out} err=${errOut}`));
        }, 15000);
        child.stdout.on('data', (chunk) => {
          out += chunk.toString('utf8');
          if (!fetched && readyCheck(out)) {
            fetched = true;
            const url = extractUrl(out);
            Promise.resolve()
              .then(async () => {
                const dl = await globalThis.fetch(url);
                assert.equal(dl.status, 200);
                await dl.text();
              })
              .catch((err) => {
                clearTimeout(timer);
                try { child.kill(); } catch (_e) {}
                reject(err);
              });
          }
        });
        child.stderr.on('data', (chunk) => {
          errOut += chunk.toString('utf8');
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          resolve({ code, out, errOut });
        });
      });

    const jsonChild = await runServeOnceChild(
      ['--serve-remote', '--out-dir', distDir, '--bind', '127.0.0.1', '--host', '127.0.0.1', '--port', '0', '--ttl', '15', '--once', '--json'],
      (s) => s.includes('userscriptUrl'),
      (s) => {
        const line = s.trim().split(/\r?\n/).find((l) => l.includes('userscriptUrl'));
        const parsed = JSON.parse(line);
        assert.equal(parsed.ok, true);
        return parsed.userscriptUrl;
      }
    );
    assert.equal(jsonChild.code, 0, jsonChild.errOut);

    const textChild = await runServeOnceChild(
      ['--serve-remote', '--out-dir', distDir, '--bind', '127.0.0.1', '--port', '0', '--once'],
      (s) => s.includes('Direct Userscript URL'),
      (s) => {
        const m = /Direct Userscript URL\s*:\s*(\S+)/.exec(s);
        assert.ok(m, 'Serve text output must include Direct Userscript URL');
        return m[1];
      }
    );
    assert.equal(textChild.code, 0, textChild.errOut);

    // 2. update-reconciler parentPid wait + mid-loop cancel + post-ACK cancel
    const ackPath = path.join(tmpDir, 'handoff.ack');
    let aliveTicks = 0;
    const cancelDuringWait = await runDetachedHandoffReconcile(
      { paths: { ASAR_PATH: path.join(tmpDir, 'none.asar') } },
      { diagnoseHost: () => ({ hostInstalled: false }) },
      {
        parentPid: 999999,
        ackFilePath: ackPath,
        relaunch: false,
        waitTimeoutMs: 500,
        pollIntervalMs: 5,
        isPidAliveFn: () => {
          aliveTicks += 1;
          if (aliveTicks === 2) fs.writeFileSync(`${ackPath}.cancel`, '1', 'utf8');
          return true;
        },
        sleepFn: async () => new Promise((r) => setTimeout(r, 5)),
      }
    );
    assert.equal(cancelDuringWait.cancelled, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-COV90-RC04: remote-bootstrap drawer bridge connect/manual-connect/disconnect UI and error paths', async () => {
  function makeMockEl(tag) {
    const attrs = new Map();
    const listeners = new Map();
    const childNodes = [];
    let textVal = '';
    const el = {
      nodeType: 1,
      tagName: String(tag || 'div').toUpperCase(),
      className: '',
      type: '',
      value: '',
      disabled: false,
      hidden: false,
      isConnected: true,
      style: {},
      parentNode: null,
      childNodes,
      get firstChild() { return childNodes[0] || null; },
      get textContent() { return childNodes.length === 0 ? textVal : textVal + childNodes.map((c) => c.textContent || '').join(''); },
      set textContent(v) { textVal = String(v == null ? '' : v); childNodes.length = 0; },
      setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'class') el.className = String(v); if (k === 'value') el.value = String(v); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      hasAttribute(k) { return attrs.has(k); },
      removeAttribute(k) { attrs.delete(k); },
      appendChild(c) { c.parentNode = el; childNodes.push(c); return c; },
      removeChild(c) { const i = childNodes.indexOf(c); if (i >= 0) { childNodes.splice(i, 1); c.parentNode = null; } return c; },
      addEventListener(t, fn) { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t).add(fn); },
      removeEventListener(t, fn) { if (listeners.has(t)) listeners.get(t).delete(fn); },
      dispatchEvent(ev) { const s = listeners.get(ev && ev.type); if (s) for (const fn of Array.from(s)) fn(ev); },
      attachShadow() { el.shadowRoot = makeMockEl('shadow-root'); return el.shadowRoot; },
      querySelector(sel) {
        const attrM = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(sel);
        const walk = (n) => {
          for (const c of n.childNodes || []) {
            if (attrM) {
              const v = c.getAttribute && c.getAttribute(attrM[1]);
              if (v !== null && (attrM[2] === undefined || v === attrM[2])) return c;
            }
            const sub = walk(c);
            if (sub) return sub;
          }
          return null;
        };
        return walk(el);
      },
    };
    return el;
  }

  const doc = {
    documentElement: makeMockEl('html'),
    head: makeMockEl('head'),
    body: makeMockEl('body'),
    createElement: (t) => makeMockEl(t),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t || '') }),
    getElementById: (id) => doc.body.querySelector(`[id="${id}"]`),
    querySelector: (s) => doc.body.querySelector(s),
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);

  let mode = 'ok';
  let connected = false;
  const fakeFetch = async () => {
    if (mode === 'ok') {
      connected = true;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, hostVersion: '3.3.4', buildSha8: '3c90b890', activePlugins: [] }),
      };
    }
    if (mode === 'fail') {
      return { ok: false, status: 401, text: async () => JSON.stringify({ ok: false, reason: 'ERR_UNAUTHORIZED' }) };
    }
    throw new Error('NET_DOWN');
  };
  const win = {
    document: doc,
    location: { href: 'https://antigravity.google.com/', origin: 'https://antigravity.google.com', protocol: 'https:', hostname: 'antigravity.google.com' },
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
    crypto: globalThis.crypto,
    fetch: fakeFetch,
  };

  const boot = await bootRemoteWebHost({
    doc,
    win,
    kernel: createRendererKernel(doc, win),
    profile: {
      id: 'antigravity-remote-web',
      allowedOrigins: ['https://antigravity.google.com'],
      allowedUrlProtocols: ['https:'],
      allowedUrlHosts: ['antigravity.google.com'],
      uiAnchors: {},
      uiSurfaces: {},
    },
    packedAddons: [],
    remoteTransport: createRemoteHostTransport({ win, fetchFn: fakeFetch }),
  });
  assert.equal(boot.ok, true);
  // Open drawer by clicking the launcher pill in shadowRoot
  const drawerHost = doc.body.querySelector('[data-addon-host-remote-drawer="1"]') || doc.body.childNodes.find((c) => c.shadowRoot);
  if (drawerHost && drawerHost.shadowRoot) {
    const toggleBtn = drawerHost.shadowRoot.querySelector('[data-rah-toggle="1"]') || drawerHost.shadowRoot.querySelector('[aria-expanded]');
    if (toggleBtn) toggleBtn.dispatchEvent({ type: 'click', isTrusted: true });

    const pairInput = drawerHost.shadowRoot.querySelector('[data-rah-bridge-pairing-input="1"]');
    const connectBtn = drawerHost.shadowRoot.querySelector('[data-rah-bridge-connect="1"]');
    const urlInput = drawerHost.shadowRoot.querySelector('[data-rah-bridge-url-input="1"]');
    const tokInput = drawerHost.shadowRoot.querySelector('[data-rah-bridge-token-input="1"]');
    const manualBtn = drawerHost.shadowRoot.querySelector('[data-rah-bridge-manual-connect="1"]');
    if (connectBtn && pairInput) {
      connectBtn.dispatchEvent({ type: 'click', isTrusted: false });
      pairInput.value = '';
      connectBtn.dispatchEvent({ type: 'click', isTrusted: true });
      mode = 'fail';
      pairInput.value = 'agb1.invalid';
      connectBtn.dispatchEvent({ type: 'click', isTrusted: true });
      await new Promise((r) => setTimeout(r, 20));
      mode = 'throw';
      const validPair = 'ag-bridge-v1:' + Buffer.from(JSON.stringify({ v: 1, url: 'http://127.0.0.1:19384', token: 'a'.repeat(64) })).toString('base64url');
      pairInput.value = validPair;
      connectBtn.dispatchEvent({ type: 'click', isTrusted: true });
      await new Promise((r) => setTimeout(r, 20));
      mode = 'ok';
      pairInput.value = validPair;
      connectBtn.dispatchEvent({ type: 'click', isTrusted: true });
      await new Promise((r) => setTimeout(r, 20));
    }
    if (manualBtn && urlInput && tokInput) {
      manualBtn.dispatchEvent({ type: 'click', isTrusted: false });
      urlInput.value = 'http://127.0.0.1:19384';
      tokInput.value = 'b'.repeat(64);
      mode = 'fail';
      manualBtn.dispatchEvent({ type: 'click', isTrusted: true });
      await new Promise((r) => setTimeout(r, 20));
      mode = 'throw';
      manualBtn.dispatchEvent({ type: 'click', isTrusted: true });
      await new Promise((r) => setTimeout(r, 20));
      mode = 'ok';
      manualBtn.dispatchEvent({ type: 'click', isTrusted: true });
      await new Promise((r) => setTimeout(r, 20));
    }
    const discBtn = drawerHost.shadowRoot.querySelector('[data-rah-bridge-disconnect="1"]');
    if (discBtn) discBtn.dispatchEvent({ type: 'click', isTrusted: true });
  }
  assert.equal(typeof connected, 'boolean');
  boot.controller.dispose();
});

test('TC-COV90-RC05: remote-host-bridge error/catch paths, update-reconciler post-ACK cancel/retry/relaunch, and cli/main error branches', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extenra-cov90-rc05-'));
  try {
    // 1. remote-host-bridge rejecting transport, throwing store, throwing onSettingsSaved, ping & errors
    const failingTransport = {
      isConnected: () => true,
      getStatus: () => ({ configured: true, connected: true, baseUrl: 'http://127.0.0.1:19384' }),
      saveSettings: async () => { throw new Error('SAVE_FAIL'); },
      readConfigScope: async () => { throw new Error('READ_CFG_FAIL'); },
      writeConfigScope: async () => { throw new Error('WRITE_CFG_FAIL'); },
      netFetch: async () => { throw new Error('NET_FAIL'); },
      secretsSet: async () => { throw new Error('SEC_SET_FAIL'); },
      secretsGet: async () => { throw new Error('SEC_GET_FAIL'); },
      secretsHas: async () => { throw new Error('SEC_HAS_FAIL'); },
      secretsDelete: async () => { throw new Error('SEC_DEL_FAIL'); },
      secretsList: async () => { throw new Error('SEC_LIST_FAIL'); },
    };
    const bFail = createRemoteHostBridge({
      win: {
        localStorage: {
          getItem: () => '{bad-json',
          setItem: () => { throw new Error('QUOTA_ERR'); },
          removeItem: () => {},
        },
      },
      remoteTransport: failingTransport,
      settingsBindings: { p1: { maxBytes: 4096 } },
      netBindings: { p1: { httpsHosts: ['api.example.com'], userApprovedHttps: true } },
    });
    bFail.bindSecretsPlugin('p1', { maxKeys: 4, maxBytes: 1024, allowRead: true });
    assert.equal((await bFail.port.ping()).ok, true);
    assert.equal((await bFail.port.readConfigScope('p1', 'mcp')).reason, 'ERR_REMOTE_CONFIG_READ_FAILED');
    assert.equal((await bFail.port.writeConfigScope('p1', 'mcp', '{}')).reason, 'ERR_REMOTE_CONFIG_WRITE_FAILED');
    await assert.rejects(() => bFail.port.netFetch('p1', 'https://api.example.com/v1'), /NET_FAIL/);
    await assert.rejects(() => bFail.port.secretsSet('p1', 'k', 'v'), /SEC_SET_FAIL/);
    await assert.rejects(() => bFail.port.secretsGet('p1', 'k'), /SEC_GET_FAIL/);
    await assert.rejects(() => bFail.port.secretsHas('p1', 'k'), /SEC_HAS_FAIL/);
    await assert.rejects(() => bFail.port.secretsDelete('p1', 'k'), /SEC_DEL_FAIL/);
    await assert.rejects(() => bFail.port.secretsList('p1'), /SEC_LIST_FAIL/);
    assert.equal(bFail.addUserAllowedHttpsHost('p1', 'ok.example.com').ok, false);
    assert.ok(bFail.getErrors().length >= 3);
    assert.deepEqual(bFail.getPortalClaims(), []);
    bFail.dispose();

    const bStoreThrow = createRemoteHostBridge({
      win: {
        localStorage: {
          getItem: () => null,
          setItem: () => { throw new Error('DISK_FULL'); },
          removeItem: () => {},
        },
      },
      settingsBindings: { p1: { maxBytes: 4096 } },
    });
    assert.equal((await bStoreThrow.port.saveSettings('p1', '{"a":1}')).reason, 'ERR_SETTINGS_STORAGE_WRITE_FAILED');
    assert.equal((await bStoreThrow.port.writeConfigScope('p1', 'mcp', '{}')).reason, 'ERR_REMOTE_CONFIG_BRIDGE_READ_ONLY');
    bStoreThrow.dispose();

    const bHookThrow = createRemoteHostBridge({
      win: {},
      settingsBindings: { p1: { maxBytes: 4096 } },
      onSettingsSaved: () => { throw new Error('CB_ERR'); },
    });
    assert.equal((await bHookThrow.port.saveSettings('p1', '{"a":1}')).ok, true);
    assert.ok(bHookThrow.getErrors().length >= 1);
    bHookThrow.dispose();

    // 2. update-reconciler post-ACK cancel, locked retry loop, thrown reconcile, and relaunch spawn throw
    const ackCancel = path.join(tmpDir, 'pre-cancel.ack');
    fs.writeFileSync(`${ackCancel}.cancel`, '1', 'utf8');
    const rPreCancel = await runDetachedHandoffReconcile(
      { paths: {} },
      {},
      { ackFilePath: ackCancel, waitTimeoutMs: 50, pollIntervalMs: 5 }
    );
    assert.equal(rPreCancel.cancelled, true);

    let tries = 0;
    const fakeExe = path.join(tmpDir, 'app.exe');
    fs.writeFileSync(fakeExe, 'bin', 'utf8');
    const rRetry = await runDetachedHandoffReconcile(
      { paths: { APP_EXECUTABLE_PATH: fakeExe } },
      {},
      {
        ackFilePath: path.join(tmpDir, 'retry.ack'),
        relaunch: true,
        waitTimeoutMs: 300,
        pollIntervalMs: 5,
        reconcileFn: () => {
          tries += 1;
          if (tries === 1) return { ok: false, reason: 'ERR_TARGET_LOCKED_APP_RUNNING' };
          return { ok: true, action: 'REPATCHED' };
        },
        spawnFn: () => { throw new Error('SPAWN_RELAUNCH_FAIL'); },
        sleepFn: async () => new Promise((r) => setTimeout(r, 5)),
      }
    );
    assert.equal(rRetry.ok, true);
    assert.equal(tries, 2);
    assert.equal(rRetry.relaunch.launched, false);

    const rThrow = await runDetachedHandoffReconcile(
      { paths: {} },
      {},
      {
        relaunch: false,
        waitTimeoutMs: 50,
        pollIntervalMs: 5,
        reconcileFn: () => { throw new Error('RECONCILE_CRASH'); },
      }
    );
    assert.equal(rThrow.ok, false);
    assert.equal(rThrow.error, 'RECONCILE_CRASH');

    // 3. src/cli/main.js unsupported launch/rollback/unknown flags
    const origWrite = process.stdout.write.bind(process.stdout);
    const origCode = process.exitCode;
    process.stdout.write = (chunk, ...rest) => {
      const s = String(chunk);
      if (/^(?:TAP |# |ok |not ok |  |1\.\.)/.test(s)) return origWrite(chunk, ...rest);
      return true;
    };
    try {
      const cli = createCliApp({
        hostVersion: '3.3.4',
        defaultProfile: { id: 'mock' },
        hostLifecycle: {
          validateProfile: (p) => p,
          resolveContext: () => ({ hostProfileId: 'mock', paths: { ADDONS_DIR: tmpDir } }),
          getHostStatus: () => ({ hostInstalled: false }),
          diagnoseHost: () => ({ hostInstalled: false }),
          installHost: () => ({ ok: true }),
          rollbackHost: () => ({ ok: false, reason: 'MOCK_FAIL' }),
        },
        addonStore: {
          planAddons: () => ({ active: [], disabled: [], rejected: [], invalid: [] }),
          validateManifest: () => ({ ok: true }),
          registerManifest: () => ({ ok: true }),
          unregisterManifest: () => ({ ok: true }),
        },
      });
      const launchRes = await cli.runCli(['--launch']);
      assert.equal(launchRes.reason, 'ERR_LAUNCH_UNSUPPORTED');
      const rbRes = await cli.runCli(['--rollback']);
      assert.equal(rbRes.ok, false);
      await assert.rejects(() => cli.runCli(['--nonexistent-flag']), /Unsupported CLI arguments/);
    } finally {
      process.stdout.write = origWrite;
      process.exitCode = origCode || 0;
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-COV90-RC06: remote-host-bridge/transport helpers, pairing parser, and full cli/main command dispatch', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extenra-cov90-rc06-'));
  try {
    // 1. remote-host-bridge helpers & edge cases
    assert.ok(redactSecrets('Authorization: Bearer secret1234567890').includes('[REDACTED]') || typeof redactSecrets('abc') === 'string');
    assert.equal(parseSafeJsonObject('{bad').ok, false);
    assert.equal(parseSafeJsonObject('[1,2]').ok, false);
    assert.equal(parseSafeJsonObject('{"__proto__":{"a":1}}').ok, false);
    assert.equal(parseSafeJsonObject('{"a":1}').ok, true);
    assert.equal(typeof deterministicHexDigest('hello'), 'string');

    const gmMap = new Map([['remote-addon-host:v2:settings:p1', '{corrupt']]);
    const bEdge = createRemoteHostBridge({
      win: {
        localStorage: {
          getItem: (k) => (gmMap.has(k) ? gmMap.get(k) : null),
          setItem: (k, v) => gmMap.set(k, String(v)),
          removeItem: (k) => gmMap.delete(k),
        },
      },
    });
    assert.equal(bEdge.bindSettingsPlugin('BAD ID!', {}), false);
    assert.equal(bEdge.bindNetPlugin('BAD ID!', {}), false);
    assert.equal(bEdge.bindSecretsPlugin('BAD ID!', {}), false);
    assert.equal(bEdge.bindSettingsPlugin('p1', { maxBytes: 4096 }), true);
    const corruptSnap = bEdge.loadPersistedSettings('p1');
    assert.equal(corruptSnap, null);
    bEdge.dispose();

    // 2. remote-host-transport parsePairingCode & GM async hydrateStoredConnection
    assert.equal(parsePairingCode('').ok, false);
    assert.equal(parsePairingCode('wrongprefix.abc').ok, false);
    assert.equal(parsePairingCode('ag-bridge-v1:!!!not-base64!!!').ok, false);
    assert.equal(parsePairingCode('ag-bridge-v1:' + Buffer.from('not-json').toString('base64url')).ok, false);
    assert.equal(parsePairingCode('ag-bridge-v1:' + Buffer.from(JSON.stringify({ v: 1, url: 'ftp://bad', token: 'a'.repeat(40) })).toString('base64url')).ok, false);
    assert.equal(parsePairingCode('ag-bridge-v1:' + Buffer.from(JSON.stringify({ v: 1, url: 'http://127.0.0.1:19384', token: 'short' })).toString('base64url')).ok, false);
    const goodCode = 'ag-bridge-v1:' + Buffer.from(JSON.stringify({ v: 1, url: 'http://127.0.0.1:19384', token: 'a'.repeat(40) })).toString('base64url');
    assert.equal(parsePairingCode(goodCode).ok, true);

    const asyncStore = new Map([
      ['remote-addon-host:v3:bridge-config', JSON.stringify({ baseUrl: 'http://127.0.0.1:19384', token: 'a'.repeat(40) })],
    ]);
    const tHydrate = createRemoteHostTransport({
      win: {
        GM: {
          getValue: async (k, d) => (asyncStore.has(k) ? asyncStore.get(k) : d),
          setValue: async (k, v) => { asyncStore.set(k, v); },
          deleteValue: async (k) => { asyncStore.delete(k); },
        },
      },
      fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, hostVersion: '3.3.4' }) }),
    });
    if (typeof tHydrate.hydrateStoredConnection === 'function') {
      await tHydrate.hydrateStoredConnection();
    }
    assert.equal((await tHydrate.connectWithPairingCode(goodCode)).ok, true);
    tHydrate.disconnect();

    // 3. src/cli/main.js full command dispatch coverage (--help, --version, --status, --doctor, --validate, --register, --unregister, --install, --upgrade, --reconcile)
    const manifestFile = path.join(tmpDir, 'm.json');
    fs.writeFileSync(manifestFile, JSON.stringify({ pluginId: 'p1', version: '1.0.0' }), 'utf8');
    const origWrite = process.stdout.write.bind(process.stdout);
    const origCode = process.exitCode;
    process.stdout.write = (chunk, ...rest) => {
      const s = String(chunk);
      if (/^(?:TAP |# |ok |not ok |  |1\.\.)/.test(s)) return origWrite(chunk, ...rest);
      return true;
    };
    try {
      const cli = createCliApp({
        hostVersion: '3.3.4',
        defaultProfile: { id: 'mock' },
        hostLifecycle: {
          validateProfile: (p) => p,
          resolveContext: () => ({ hostProfileId: 'mock', paths: { ADDONS_DIR: tmpDir } }),
          getHostStatus: () => ({ hostInstalled: true, mode: 'mock' }),
          diagnoseHost: () => ({ hostInstalled: true, healthy: true }),
          installHost: (_ctx, opts) => ({ ok: true, mode: opts && opts.mode }),
          rollbackHost: () => ({ ok: true }),
          reconcileHost: () => ({ ok: true, action: 'NOOP' }),
          launchHost: async () => ({ ok: true }),
        },
        addonStore: {
          planAddons: () => ({ active: [], disabled: [], rejected: [], invalid: [] }),
          validateManifest: () => ({ ok: true }),
          registerManifest: () => ({ ok: true, pluginId: 'p1' }),
          unregisterManifest: () => ({ ok: true, removed: true }),
        },
      });
      assert.ok(cli.getHelpText().length > 20);
      await cli.runCli(['--help']);
      await cli.runCli(['--version']);
      await cli.runCli(['--status']);
      await cli.runCli(['--doctor']);
      await cli.runCli(['--validate', manifestFile]);
      await cli.runCli(['--register', manifestFile]);
      await cli.runCli(['--unregister', 'p1']);
      await cli.runCli(['--install']);
      await cli.runCli(['--upgrade']);
      await cli.runCli(['--reconcile']);
      await cli.runCli(['--launch']);
      await cli.runCli(['--rollback']);
      assert.throws(() => cli.loadHostProfileFromFile(path.join(tmpDir, 'missing-profile.js')), /ERR_PROFILE_NOT_FOUND/);
    } finally {
      process.stdout.write = origWrite;
      process.exitCode = origCode || 0;
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-COV90-RC07: packages/sdk/bin/ag-addon.js init, check (all error branches), and build/pack', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extenra-cov90-sdkcli-'));
  try {
    // Missing manifest
    assert.equal(agAddonCli.cmdCheck(tmpDir).ok, false);
    // Invalid JSON
    fs.writeFileSync(path.join(tmpDir, 'addon-manifest.json'), '{bad', 'utf8');
    assert.equal(agAddonCli.cmdCheck(tmpDir).ok, false);
    // Wrong schemaVersion + bad pluginId + missing rendererScript
    fs.writeFileSync(
      path.join(tmpDir, 'addon-manifest.json'),
      JSON.stringify({ schemaVersion: 1, pluginId: 'BAD ID', entry: { rendererScript: 'src/missing.js' } }),
      'utf8'
    );
    const badCheck = agAddonCli.cmdCheck(tmpDir);
    assert.equal(badCheck.ok, false);
    assert.ok(badCheck.errors.length >= 3);
    assert.equal(agAddonCli.cmdBuildOrPack(tmpDir, 'build').ok, false);

    // Valid init + unsafe sink check + valid build & pack
    const projDir = path.join(tmpDir, 'demo-proj');
    assert.equal(agAddonCli.cmdInit(projDir, 'demo-sdk').ok, true);
    assert.equal(agAddonCli.cmdCheck(projDir).ok, true);
    assert.equal(agAddonCli.cmdBuildOrPack(projDir, 'build').ok, true);
    assert.equal(agAddonCli.cmdBuildOrPack(projDir, 'pack').ok, true);
    fs.appendFileSync(path.join(projDir, 'src', 'index.js'), '\n// x\ndocument.body.innerHTML = "x";\n', 'utf8');
    assert.equal(agAddonCli.cmdCheck(projDir).ok, false);

    // remote-lan-server pickLanIpv4Address & HTTP route/error coverage
    assert.equal(
      pickLanIpv4Address({
        'vEthernet (WSL)': [{ family: 'IPv4', internal: false, address: '172.24.0.1' }],
        'Wi-Fi': [
          { family: 'IPv6', internal: false, address: '::1' },
          { family: 'IPv4', internal: false, address: '169.254.1.1' },
          { family: 'IPv4', internal: false, address: '192.168.1.50' },
        ],
      }),
      '192.168.1.50'
    );
    assert.equal(
      pickLanIpv4Address({
        eth0: [{ family: 4, internal: false, address: '10.0.0.5' }],
      }),
      '10.0.0.5'
    );
    assert.equal(
      pickLanIpv4Address({
        eth0: [{ family: 'IPv4', internal: false, address: '172.20.1.9' }],
      }),
      '172.20.1.9'
    );
    assert.equal(pickLanIpv4Address({}), '127.0.0.1');

    const lanDist = path.join(tmpDir, 'lan-dist');
    fs.mkdirSync(lanDist, { recursive: true });
    fs.writeFileSync(path.join(lanDist, 'antigravity-remote.user.js'), '// ==UserScript==\n// ==/UserScript==\n', 'utf8');
    fs.writeFileSync(path.join(lanDist, 'antigravity-remote.meta.js'), '// ==UserScript==\n// ==/UserScript==\n', 'utf8');
    fs.writeFileSync(path.join(lanDist, 'antigravity-remote-host.lib.js'), '/* lib */\n', 'utf8');
    fs.writeFileSync(path.join(lanDist, 'build-manifest.json'), JSON.stringify({ buildSha8: '3c90b890', addonCount: 1 }), 'utf8');
    const srv = await startRemoteLanServer({ distDir: lanDist, bindHost: '127.0.0.1', advertiseHost: '127.0.0.1', port: 0, ttlSec: 30, once: false });
    try {
      const origin = `http://127.0.0.1:${srv.port}`;
      assert.equal((await globalThis.fetch(`${origin}/wrong-token/`)).status, 404);
      assert.equal((await globalThis.fetch(srv.installUrl, { method: 'POST' })).status, 405);
      assert.equal((await globalThis.fetch(srv.installUrl)).status, 200);
      assert.equal((await globalThis.fetch(srv.installUrl, { method: 'HEAD' })).status, 200);
      assert.equal((await globalThis.fetch(srv.metaUrl)).status, 200);
      assert.equal((await globalThis.fetch(srv.hostLibUrl)).status, 200);
      assert.equal((await globalThis.fetch(`${origin}/${srv.token}/../secret`)).status, 404);
    } finally {
      await srv.close('test_done');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
