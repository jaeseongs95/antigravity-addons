'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const { normalizeManifestToV2 } = require('../../src/core/manifest-normalizer');
const { validateAddonManifest, isReservedSettingsFileName } = require('../../src/core/manifest-validator');
const { ANTIGRAVITY_HOST_PROFILE } = require('../../src/profiles/antigravity');
const { buildHostLoaderScriptSource } = require('../../src/adapters/electron/host-loader-builder');
const { createSettingsBridge } = require('../../src/runtime/main/settings-bridge');
const { createConfigBridge } = require('../../src/runtime/main/config-bridge');
const { createNetFetchBroker } = require('../../src/runtime/main/net-fetch-broker');
const { createRemoteBridgeServer, decodePairingCode } = require('../../src/runtime/main/remote-bridge-server');
const { createHostAdminService } = require('../../src/runtime/main/host-admin-service');
const { createRemoteHostTransport, parsePairingCode } = require('../../src/adapters/remote-web/remote-host-transport');
const { bootRemoteWebHost, DRAWER_HOST_ID } = require('../../src/adapters/remote-web/remote-bootstrap');
const { createRendererKernel } = require('../../src/runtime/renderer/kernel');
const { createHostSettingsUi } = require('../../src/runtime/renderer/host-settings-ui');
const { createTestHost } = require('../../packages/sdk/src/test-host');

function sha256Hex(bufOrStr) {
  return crypto.createHash('sha256').update(bufOrStr).digest('hex');
}

function makeFakeDom({ href = 'https://remote.example.test/app' } = {}) {
  const storageMap = new Map();
  const winListeners = new Map();
  const docListeners = new Map();

  function makeEl(tagName) {
    const attrs = new Map();
    const listeners = new Map();
    const childNodes = [];
    const style = {
      setProperty(k, v) {
        this[k] = v;
      },
      removeProperty(k) {
        delete this[k];
      },
    };
    let textContentValue = '';
    let shadowRoot = null;

    const el = {
      tagName: String(tagName || 'div').toUpperCase(),
      nodeName: String(tagName || 'div').toUpperCase(),
      nodeType: 1,
      parentNode: null,
      get parentElement() {
        return el.parentNode && el.parentNode.nodeType === 1 ? el.parentNode : null;
      },
      childNodes,
      get children() {
        return childNodes.filter((c) => c && c.nodeType === 1);
      },
      get firstChild() {
        return childNodes[0] || null;
      },
      get nextSibling() {
        if (!el.parentNode) return null;
        const siblings = el.parentNode.childNodes;
        const idx = siblings.indexOf(el);
        return idx >= 0 && idx + 1 < siblings.length ? siblings[idx + 1] : null;
      },
      style,
      className: '',
      value: '',
      disabled: false,
      hidden: false,
      isConnected: true,
      get shadowRoot() {
        return shadowRoot;
      },
      get textContent() {
        if (childNodes.length === 0) return textContentValue;
        return textContentValue + childNodes.map((c) => c.textContent || '').join('');
      },
      set textContent(v) {
        textContentValue = String(v === undefined || v === null ? '' : v);
        childNodes.length = 0;
      },
      setAttribute(k, v) {
        const key = String(k);
        const val = String(v);
        attrs.set(key, val);
        if (key === 'class') el.className = val;
        if (key === 'hidden') el.hidden = true;
        if (key === 'value') el.value = val;
      },
      getAttribute(k) {
        return attrs.has(String(k)) ? attrs.get(String(k)) : null;
      },
      removeAttribute(k) {
        attrs.delete(String(k));
        if (k === 'hidden') el.hidden = false;
      },
      hasAttribute(k) {
        return attrs.has(String(k));
      },
      appendChild(child) {
        if (!child) return child;
        if (child.parentNode && typeof child.parentNode.removeChild === 'function') {
          child.parentNode.removeChild(child);
        }
        child.parentNode = el;
        childNodes.push(child);
        return child;
      },
      insertBefore(child, refNode) {
        if (!child) return child;
        if (child.parentNode && typeof child.parentNode.removeChild === 'function') {
          child.parentNode.removeChild(child);
        }
        const idx = refNode ? childNodes.indexOf(refNode) : -1;
        child.parentNode = el;
        if (idx === -1) childNodes.push(child);
        else childNodes.splice(idx, 0, child);
        return child;
      },
      removeChild(child) {
        const idx = childNodes.indexOf(child);
        if (idx !== -1) {
          childNodes.splice(idx, 1);
          child.parentNode = null;
        }
        return child;
      },
      contains(target) {
        if (target === el) return true;
        for (let i = 0; i < childNodes.length; i += 1) {
          if (childNodes[i] === target || (typeof childNodes[i].contains === 'function' && childNodes[i].contains(target))) {
            return true;
          }
        }
        return false;
      },
      cloneNode(deep) {
        const cloned = makeEl(el.tagName.toLowerCase());
        for (const [k, v] of attrs.entries()) cloned.setAttribute(k, v);
        if (childNodes.length === 0) {
          cloned.textContent = textContentValue;
        } else if (deep) {
          for (const c of childNodes) {
            if (c.nodeType === 3) cloned.appendChild(doc.createTextNode(c.textContent));
            else if (typeof c.cloneNode === 'function') cloned.appendChild(c.cloneNode(true));
          }
        }
        return cloned;
      },
      attachShadow({ mode } = {}) {
        const sr = makeEl('#shadow-root');
        sr.mode = mode || 'open';
        sr.host = el;
        if (mode !== 'closed') shadowRoot = sr;
        return sr;
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        if (listeners.has(type)) listeners.get(type).delete(fn);
      },
      dispatchEvent(ev) {
        const set = listeners.get(ev && ev.type);
        if (set) {
          for (const fn of Array.from(set)) fn(ev);
        }
        return true;
      },
      click() {
        return el.dispatchEvent({ type: 'click', isTrusted: true, preventDefault() {}, stopPropagation() {} });
      },
      focus() {
        doc.activeElement = el;
      },
      querySelector(sel) {
        return el.querySelectorAll(sel)[0] || null;
      },
      querySelectorAll(sel) {
        const out = [];
        const parts = String(sel || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const matchOne = (node, p) => {
          if (!node || node.nodeType !== 1) return false;
          const attrM = p.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
          if (attrM) {
            const val = node.getAttribute(attrM[1]);
            return val !== null && (attrM[2] === undefined || val === attrM[2]);
          }
          if (p.startsWith('.')) {
            return String(node.className || '').split(/\s+/).includes(p.slice(1));
          }
          if (p.startsWith('#')) {
            return node.getAttribute('id') === p.slice(1);
          }
          return node.tagName.toLowerCase() === p.toLowerCase();
        };
        const walk = (n) => {
          for (const c of n.childNodes || []) {
            if (!c || c.nodeType !== 1) continue;
            if (parts.some((p) => matchOne(c, p))) out.push(c);
            walk(c);
          }
        };
        walk(el);
        return out;
      },
      closest(sel) {
        let cur = el;
        while (cur && cur.nodeType === 1) {
          const attrM = String(sel || '').match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
          if (attrM) {
            const v = cur.getAttribute(attrM[1]);
            if (v !== null && (attrM[2] === undefined || v === attrM[2])) return cur;
          }
          cur = cur.parentElement;
        }
        return null;
      },
    };
    return el;
  }

  const doc = {
    activeElement: null,
    createElement: (tag) => makeEl(tag),
    createTextNode: (text) => ({ nodeType: 3, nodeName: '#text', textContent: String(text || ''), nodeValue: String(text || '') }),
    getElementById(id) {
      return doc.documentElement.querySelector(`#${id}`);
    },
    querySelector: (sel) => doc.documentElement.querySelector(sel),
    querySelectorAll: (sel) => doc.documentElement.querySelectorAll(sel),
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (docListeners.has(type)) docListeners.get(type).delete(fn);
    },
  };
  doc.documentElement = makeEl('html');
  doc.documentElement.lang = 'ko';
  doc.head = makeEl('head');
  doc.body = makeEl('body');
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);

  const win = {
    document: doc,
    location: new URL(href),
    innerWidth: 1280,
    innerHeight: 800,
    navigator: {
      language: 'ko-KR',
      clipboard: {
        written: null,
        async writeText(txt) {
          this.written = txt;
        },
      },
    },
    localStorage: {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(String(k), String(v)),
      removeItem: (k) => storageMap.delete(String(k)),
    },
    fetch: globalThis.fetch.bind(globalThis),
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (winListeners.has(type)) winListeners.get(type).delete(fn);
    },
    getComputedStyle: () => ({ backgroundColor: 'rgba(0, 0, 0, 0)', color: '#94a3b8' }),
  };

  return { doc, win, storageMap };
}

test('TC-V310-01: manifest-normalizer preserves permissions.net.userApprovedHttps: true', () => {
  const raw = {
    schemaVersion: 3,
    pluginId: 'demo-user-https',
    displayName: 'Demo User HTTPS',
    version: '1.0.0',
    capabilities: ['renderer'],
    entry: { rendererScript: 'renderer.js' },
    permissions: {
      net: {
        httpsHosts: ['api.example.com'],
        userApprovedHttps: true,
      },
    },
  };
  const normalized = normalizeManifestToV2(raw);
  assert.equal(normalized.permissions.net.userApprovedHttps, true);
  assert.deepEqual(normalized.permissions.net.httpsHosts, ['api.example.com']);

  const validated = validateAddonManifest(raw, { checkFilesExist: false });
  assert.equal(validated.ok, true);
  assert.equal(validated.manifest.permissions.net.userApprovedHttps, true);

  const withoutFlag = normalizeManifestToV2({
    ...raw,
    permissions: { net: { httpsHosts: ['api.example.com'] } },
  });
  assert.equal(Object.prototype.hasOwnProperty.call(withoutFlag.permissions.net, 'userApprovedHttps'), false);
});

test('TC-V310-02: remote-bridge-server enforces reserved file, strict CORS, Bearer auth, and token rotation', async () => {
  assert.equal(isReservedSettingsFileName('remote-bridge.json'), true);
  assert.equal(isReservedSettingsFileName('remote-preferences.json'), true);
  assert.equal(isReservedSettingsFileName('host-cli.json'), true);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-v310-sec-'));
  const configPath = path.join(tmpDir, 'remote-bridge.json');
  const bridgeServer = createRemoteBridgeServer({
    configPath,
    hostVersion: '3.1.0',
    buildSha8: 'test3100',
    profileId: 'test-desktop',
    allowedOrigins: ['https://allowed.example'],
  });

  try {
    // Disabled by default
    assert.equal(bridgeServer.getStatus().enabled, false);
    assert.equal(bridgeServer.getStatus().running, false);

    // Enable on ephemeral port
    const cfgRes = await bridgeServer.configure({ enabled: true, port: 0, bindHost: '127.0.0.1' });
    assert.equal(cfgRes.ok, true);
    assert.equal(cfgRes.status.running, true);
    assert.ok(cfgRes.status.listeningPort > 0);
    assert.ok(cfgRes.status.pairingCode.startsWith('ag-bridge-v1:'));

    const decoded = decodePairingCode(cfgRes.status.pairingCode);
    assert.equal(decoded.ok, true);
    assert.equal(decoded.token, cfgRes.status.token);
    const baseUrl = decoded.url;

    // 1. Missing token -> 401
    const rUnauth = await fetch(`${baseUrl}/v1/ping`);
    assert.equal(rUnauth.status, 401);
    assert.equal(rUnauth.headers.get('cache-control'), 'no-store');
    assert.equal(rUnauth.headers.get('x-content-type-options'), 'nosniff');

    // 2. Disallowed Origin -> 403 and NO ACAO header
    const rBadOrigin = await fetch(`${baseUrl}/v1/ping`, {
      headers: {
        Origin: 'https://evil.example',
        Authorization: `Bearer ${decoded.token}`,
      },
    });
    assert.equal(rBadOrigin.status, 403);
    assert.equal(rBadOrigin.headers.get('access-control-allow-origin'), null);

    // 3. Allowed Origin + valid Bearer token -> 200 + exact ACAO
    const rOk = await fetch(`${baseUrl}/v1/ping`, {
      headers: {
        Origin: 'https://allowed.example',
        Authorization: `Bearer ${decoded.token}`,
      },
    });
    assert.equal(rOk.status, 200);
    assert.equal(rOk.headers.get('access-control-allow-origin'), 'https://allowed.example');
    const pingBody = await rOk.json();
    assert.equal(pingBody.ok, true);
    assert.equal(pingBody.hostVersion, '3.1.0');

    // 3b. Chrome Private Network Access (PNA) OPTIONS preflight: allowed origin only
    const rPnaOk = await fetch(`${baseUrl}/v1/ping`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://allowed.example',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Private-Network': 'true',
      },
    });
    assert.equal(rPnaOk.status, 204);
    assert.equal(rPnaOk.headers.get('access-control-allow-origin'), 'https://allowed.example');
    assert.equal(rPnaOk.headers.get('access-control-allow-private-network'), 'true');

    const rPnaBad = await fetch(`${baseUrl}/v1/ping`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Private-Network': 'true',
      },
    });
    assert.equal(rPnaBad.status, 403);
    assert.equal(rPnaBad.headers.get('access-control-allow-origin'), null);
    assert.equal(rPnaBad.headers.get('access-control-allow-private-network'), null);

    // 4. Token rotation invalidates previous token immediately
    const rot = bridgeServer.rotateToken();
    assert.equal(rot.ok, true);
    assert.notEqual(rot.status.token, decoded.token);

    const rOldTok = await fetch(`${baseUrl}/v1/ping`, {
      headers: { Authorization: `Bearer ${decoded.token}` },
    });
    assert.equal(rOldTok.status, 401);

    const rNewTok = await fetch(`${baseUrl}/v1/ping`, {
      headers: { Authorization: `Bearer ${rot.status.token}` },
    });
    assert.equal(rNewTok.status, 200);
  } finally {
    await bridgeServer.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-V310-03: End-to-End Unified Remote Host Bridge routes settings, config, and trusted localLoopback via Pairing Code', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-v310-e2e-'));
  const pluginDir = path.join(tmpDir, 'plugins', 'unified-demo');
  fs.mkdirSync(pluginDir, { recursive: true });
  const rendererFile = path.join(pluginDir, 'renderer.js');
  const rendererSrc = '/* trusted v3 demo */';
  fs.writeFileSync(rendererFile, rendererSrc, 'utf8');
  const rendererSha = sha256Hex(Buffer.from(rendererSrc, 'utf8'));

  // 1. Start a real local loopback sidecar server
  let lastSidecarHeaders = null;
  const sidecarServer = http.createServer((req, res) => {
    lastSidecarHeaders = req.headers;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, fromSidecar: true, path: req.url }));
  });
  await new Promise((resolve) => sidecarServer.listen(0, '127.0.0.1', resolve));
  const sidecarPort = sidecarServer.address().port;

  // 2. Wire real settingsBridge, configBridge, netFetchBroker, and remoteBridgeServer
  const settingsDataDir = path.join(tmpDir, 'host-data');
  fs.mkdirSync(settingsDataDir, { recursive: true });
  const mcpConfigPath = path.join(tmpDir, 'mcp_config.json');
  fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { demo: { command: 'node' } } }, null, 2), 'utf8');

  const manifest = normalizeManifestToV2({
    schemaVersion: 3,
    pluginId: 'unified-demo',
    displayName: 'Unified Demo',
    version: '1.0.0',
    trustLevel: 'trusted',
    capabilities: ['renderer'],
    entry: { rendererScript: 'renderer.js' },
    settingsBridge: { fileName: 'unified-demo-settings.json', maxBytes: 16384 },
    permissions: {
      net: { localLoopback: [sidecarPort] },
      configBridge: {
        scopes: [{ scopeId: 'demo:mcp-config', access: 'rw', maxBytes: 65536 }],
      },
    },
  });

  const policy = {
    schemaVersion: 1,
    approved: {
      'unified-demo': { rendererSha256: rendererSha },
    },
  };

  const settingsBridge = createSettingsBridge({ settingsDataDir });
  const configBridge = createConfigBridge({
    configScopes: {
      'demo:mcp-config': { kind: 'file', access: 'rw', maxBytes: 65536, path: mcpConfigPath },
    },
  });
  const netFetchBroker = createNetFetchBroker();

  const bridgeServer = createRemoteBridgeServer({
    configPath: path.join(settingsDataDir, 'remote-bridge.json'),
    hostVersion: '3.1.0',
    buildSha8: 'e2e31000',
    profileId: 'test-desktop',
    allowedOrigins: ['https://remote.example.test'],
    planCurrentAddons: () => ({
      active: [
        {
          pluginId: 'unified-demo',
          manifest,
          resolvedEntries: { rendererScript: rendererFile },
        },
      ],
      disabled: [],
      rejected: [],
    }),
    readCurrentPolicy: () => policy,
    settingsBridge,
    configBridge,
    netFetchBroker,
  });

  let remoteController = null;
  try {
    const started = await bridgeServer.configure({ enabled: true, port: 0, bindHost: '127.0.0.1' });
    assert.equal(started.ok, true);
    const pairingCode = started.status.pairingCode;
    assert.equal(parsePairingCode(pairingCode).ok, true);

    // 3. Boot Remote Web Host with real Renderer Kernel and v3 plugin
    const { doc, win } = makeFakeDom({ href: 'https://remote.example.test/workspace' });
    const kernel = createRendererKernel(doc, win);
    const transport = createRemoteHostTransport({
      win,
      storageNamespace: 'test-remote-host',
      fetchFn: (url, init) =>
        fetch(url, {
          ...init,
          headers: { ...(init && init.headers ? init.headers : {}), Origin: 'https://remote.example.test' },
        }),
    });

    let pluginCtx = null;
    const bridgeEvents = [];
    const bootRes = await bootRemoteWebHost({
      doc,
      win,
      kernel,
      remoteTransport: transport,
      profile: {
        id: 'test-remote-web',
        displayName: 'Test Remote Web',
        allowedOrigins: ['https://remote.example.test'],
      },
      packedAddons: [
        {
          pluginMeta: {
            pluginId: 'unified-demo',
            displayName: 'Unified Demo',
            version: '1.0.0',
            apiVersion: 3,
            sourceSchemaVersion: 3,
            trustLevel: 'trusted',
            hasSettingsBridge: true,
            hasConfigBridge: true,
            configScopes: [{ scopeId: 'demo:mcp-config', access: 'rw', maxBytes: 65536 }],
            permissions: { net: { httpsHosts: [], localLoopback: [sidecarPort] } },
          },
          settingsSpec: { fileName: 'unified-demo-settings.json', maxBytes: 16384 },
          run(ctx) {
            pluginCtx = ctx;
            ctx.events.on('host:remote-bridge-changed', (payload) => bridgeEvents.push(payload));
          },
        },
      ],
    });

    assert.equal(bootRes.ok, true);
    remoteController = bootRes.controller;
    assert.ok(remoteController);
    assert.ok(pluginCtx);

    // Drawer keeps existing tab order: [Addons(0), Settings Tabs(1), Diagnostics(2), Host Bridge(3)]
    const drawerHostEl = doc.getElementById(DRAWER_HOST_ID);
    assert.ok(drawerHostEl && drawerHostEl.shadowRoot);
    const tabs = drawerHostEl.shadowRoot.querySelectorAll('.rah-tab');
    assert.equal(tabs.length, 4);
    assert.equal(tabs[1].textContent, 'Settings Tabs');
    assert.equal(tabs[3].textContent, 'Host Bridge');

    // Before pairing: disconnected
    assert.equal(pluginCtx.env.capabilities.hasRemoteHostBridge, false);
    assert.equal(pluginCtx.env.capabilities.hasLocalLoopback, false);
    const preNet = await pluginCtx.net.fetch(`http://127.0.0.1:${sidecarPort}/status`);
    assert.equal(preNet.ok, false);
    assert.equal(preNet.reason, 'ERR_REMOTE_HOST_NOT_CONNECTED');

    // Pair ONCE with 1-line Pairing Code
    const connectRes = await remoteController.connectRemoteHost(pairingCode);
    assert.equal(connectRes.ok, true);
    assert.equal(bridgeEvents.length >= 1, true);
    assert.equal(bridgeEvents[bridgeEvents.length - 1].connected, true);
    assert.equal(pluginCtx.env.capabilities.hasRemoteHostBridge, true);
    assert.equal(pluginCtx.env.capabilities.hasLocalLoopback, true);

    // 4. Plugin calls ctx.net.fetch to local loopback sidecar seamlessly!
    const netRes = await pluginCtx.net.fetch(`http://127.0.0.1:${sidecarPort}/status`);
    assert.equal(netRes.ok, true);
    assert.equal(netRes.status, 200);
    assert.deepEqual(JSON.parse(netRes.bodyText), { ok: true, fromSidecar: true, path: '/status' });
    assert.equal(lastSidecarHeaders['x-addon-host-broker'], '1');
    assert.equal(lastSidecarHeaders['x-addon-host-plugin'], 'unified-demo');

    // 5. Plugin writes settingsBridge -> persisted directly on Desktop Host disk!
    const saveRes = await pluginCtx.settingsBridge.saveSettings({ mode: 'pro', pollMs: 3000 });
    assert.equal(saveRes.ok, true);
    const diskSettings = JSON.parse(fs.readFileSync(path.join(settingsDataDir, 'unified-demo-settings.json'), 'utf8'));
    assert.deepEqual(diskSettings, { mode: 'pro', pollMs: 3000 });

    // 6. Plugin reads & writes configBridge -> persisted directly on Desktop Host disk!
    const cfgRead = await pluginCtx.configBridge.read('demo:mcp-config');
    assert.equal(cfgRead.ok, true);
    assert.equal(cfgRead.data.mcpServers.demo.command, 'node');

    const cfgWrite = await pluginCtx.configBridge.write(
      'demo:mcp-config',
      { mcpServers: { demo: { command: 'node', disabled: true } } },
      { expectedSha256: cfgRead.sha256 }
    );
    assert.equal(cfgWrite.ok, true);
    const diskMcp = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
    assert.equal(diskMcp.mcpServers.demo.disabled, true);

    // 7. Disconnect revokes live bridge access immediately
    remoteController.disconnectRemoteHost();
    assert.equal(pluginCtx.env.capabilities.hasRemoteHostBridge, false);
    assert.equal(pluginCtx.env.capabilities.hasLocalLoopback, false);
    const postDiscNet = await pluginCtx.net.fetch(`http://127.0.0.1:${sidecarPort}/status`);
    assert.equal(postDiscNet.ok, false);
    assert.equal(postDiscNet.reason, 'ERR_REMOTE_HOST_NOT_CONNECTED');
  } finally {
    try {
      if (remoteController && typeof remoteController.dispose === 'function') remoteController.dispose();
    } catch (_e) {}
    try {
      settingsBridge.dispose();
    } catch (_e) {}
    await bridgeServer.dispose();
    await new Promise((resolve) => {
      sidecarServer.close(() => resolve());
      if (typeof sidecarServer.closeAllConnections === 'function') sidecarServer.closeAllConnections();
    });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-V310-04: Desktop host-admin-service + host-settings-ui Remote Bridge & 1-click rebuild + thin shim < 4096 B', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-v310-admin-'));
  const bridgeServer = createRemoteBridgeServer({
    configPath: path.join(tmpDir, 'remote-bridge.json'),
    hostVersion: '3.1.0',
    buildSha8: 'adm31000',
    allowedOrigins: ['https://allowed.example'],
  });
  let rebuildCalls = 0;
  const adminSvc = createHostAdminService({
    hostVersion: '3.1.0',
    buildSha8: 'adm31000',
    profile: { id: 'test-desktop', remoteProfileId: 'test-remote' },
    addonsDir: path.join(tmpDir, 'addons.d'),
    pluginsRootDir: path.join(tmpDir, 'plugins'),
    remoteDistDir: path.join(tmpDir, 'remote-dist'),
    remoteBridgeServer: bridgeServer,
    runBuildRemote: async ({ outDir }) => {
      rebuildCalls += 1;
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(
        path.join(outDir, 'build-manifest.json'),
        JSON.stringify({ buildSha8: 'rebuilt1', addons: [], files: { 'remote.user.js': 'abc' } }),
        'utf8'
      );
      fs.writeFileSync(path.join(outDir, 'remote.user.js'), '// rebuilt\n', 'utf8');
      return { ok: true };
    },
  });

  try {
    const initState = adminSvc.getState();
    assert.equal(initState.ok, true);
    assert.equal(initState.remoteBridge.enabled, false);
    assert.equal(initState.remoteBundle.canRebuildInApp, true);

    const cfgRes = await adminSvc.configureRemoteBridge({ enabled: true, port: 0, bindHost: '127.0.0.1' });
    assert.equal(cfgRes.ok, true);
    assert.equal(cfgRes.state.remoteBridge.running, true);
    assert.ok(cfgRes.state.remoteBridge.pairingCode.startsWith('ag-bridge-v1:'));

    const rebRes = await adminSvc.rebuildRemoteBundle();
    assert.equal(rebRes.ok, true);
    assert.equal(rebuildCalls, 1);
    assert.equal(rebRes.buildSha8, 'rebuilt1');

    // Verify Desktop UI renders Remote Bridge card + 1-click rebuild button
    const { doc, win } = makeFakeDom();
    const modal = doc.createElement('div');
    const sidebar = doc.createElement('div');
    const b1 = doc.createElement('button');
    b1.textContent = 'General';
    const b2 = doc.createElement('button');
    b2.textContent = 'Account';
    sidebar.appendChild(b1);
    sidebar.appendChild(b2);
    const content = doc.createElement('div');
    const inner = doc.createElement('div');
    inner.textContent = 'Native settings body content that is definitely longer than forty characters';
    content.appendChild(inner);
    modal.appendChild(sidebar);
    modal.appendChild(content);
    doc.body.appendChild(modal);

    const ui = createHostSettingsUi(doc, win, {
      hostBridge: {
        getHostAdminState: () => adminSvc.getState(),
        setRemoteAddonPreference: (pid, en) => adminSvc.setRemoteAddonPreference(pid, en),
        configureRemoteBridge: (p) => adminSvc.configureRemoteBridge(p),
        rotateRemoteBridgeToken: () => adminSvc.rotateRemoteBridgeToken(),
        rebuildRemoteBundle: () => adminSvc.rebuildRemoteBundle(),
      },
    });
    ui.start();
    const navBtn = sidebar.querySelector('[data-addon-host-admin-nav="true"]');
    assert.ok(navBtn);
    navBtn.click();
    await new Promise((r) => setTimeout(r, 20));

    const pane = content.querySelector('[data-addon-host-admin-pane="true"]');
    assert.ok(pane && pane.shadowRoot);
    assert.ok(pane.shadowRoot.querySelector('[data-ah-section="remote-bridge"]'));
    assert.ok(pane.shadowRoot.querySelector('[data-ah-bridge-toggle="1"]'));
    assert.ok(pane.shadowRoot.querySelector('[data-ah-bridge-copy-pairing="1"]'));
    const rebuildBtn = pane.shadowRoot.querySelector('[data-ah-action="rebuild-bundle"]');
    assert.ok(rebuildBtn);
    rebuildBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(rebuildCalls, 2);
    ui.dispose();

    // Verify thin shim size stays strictly < 4096 bytes with remoteAllowedOrigins on both Windows & Linux
    const paths = ANTIGRAVITY_HOST_PROFILE.resolvePaths(
      process.platform === 'win32'
        ? {
            USERPROFILE: 'C:\\Users\\demo',
            LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local',
          }
        : {
            HOME: '/home/runner/work/antigravity-addons/antigravity-addons/.tmp-v310',
          }
    );
    const shimSrc = buildHostLoaderScriptSource(paths, ANTIGRAVITY_HOST_PROFILE, {
      hostVersion: '3.1.0',
      buildSha8: 'abcd1234',
      runtimeEntryDir: path.join(paths.RUNTIME_DIR, 'abcd1234'),
    });
    assert.ok(Buffer.byteLength(shimSrc, 'utf8') < 4096, `Thin shim too large: ${Buffer.byteLength(shimSrc, 'utf8')} B`);
  } finally {
    await bridgeServer.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-V310-05: @extenra/sdk createTestHost supports optional remoteBridgeConnected parity', async () => {
  const manifest = {
    schemaVersion: 3,
    pluginId: 'sdk-bridge-demo',
    displayName: 'SDK Bridge Demo',
    version: '1.0.0',
    trustLevel: 'trusted',
    capabilities: ['renderer'],
    entry: { rendererScript: 'renderer.js' },
    permissions: {
      net: { localLoopback: [18910] },
      configBridge: { scopes: [{ scopeId: 'demo:cfg', access: 'rw' }] },
    },
  };

  const offlineHost = createTestHost({ surface: 'remote-web' });
  const offlineCtx = await offlineHost.mountPlugin(manifest);
  assert.equal(offlineCtx.env.capabilities.hasLocalLoopback, false);
  assert.equal(offlineCtx.configBridge, undefined);

  const onlineHost = createTestHost({
    surface: 'remote-web',
    remoteBridgeConnected: true,
    configScopes: { 'demo:cfg': { data: { enabled: true } } },
    netHandler: async () => ({ ok: true, status: 200, bodyText: '{"alive":true}' }),
  });
  const onlineCtx = await onlineHost.mountPlugin(manifest);
  assert.equal(onlineCtx.env.capabilities.hasLocalLoopback, true);
  assert.equal(onlineCtx.env.capabilities.hasRemoteHostBridge, true);
  assert.ok(onlineCtx.configBridge);
  const readRes = await onlineCtx.configBridge.read('demo:cfg');
  assert.equal(readRes.ok, true);
  assert.equal(readRes.data.enabled, true);
  const netRes = await onlineCtx.net.fetch('http://127.0.0.1:18910/health');
  assert.equal(netRes.ok, true);
});
