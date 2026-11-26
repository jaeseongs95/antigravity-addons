'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { createNetFetchBroker } = require('../../src/runtime/main/net-fetch-broker');
const { createRemoteHostBridge } = require('../../src/adapters/remote-web/remote-host-bridge');
const { defineAddon, h, createTestHost } = require('../../packages/sdk/src');
const { cmdInit, cmdCheck, cmdBuildOrPack } = require('../../packages/sdk/bin/ag-addon');
const { buildCuratedAllInOneUserscript, buildHubFiles } = require('../../scripts/build-hub');

test('TC-V30-09: Main-process net-fetch-broker blocks DNS-rebinding/IMDS and enforces 0-redirect localLoopback', async () => {
  // 1. DNS pre-resolution returning IMDS / RFC1918 / loopback MUST fail before connecting
  const brokerImds = createNetFetchBroker({
    lookupFn: async () => [{ address: '169.254.169.254', family: 4 }],
  });
  const imdsRes = await brokerImds.fetchForPlugin(
    { httpsHosts: ['rebind.example.com'], localLoopback: [], allowLoopback: false },
    'https://rebind.example.com/latest/meta-data/'
  );
  assert.equal(imdsRes.ok, false);
  assert.match(imdsRes.reason, /ERR_NET_PRIVATE_IP_BLOCKED:169\.254\.169\.254/);

  // 2. Real local loopback HTTP server verifies explicit port allowlist & 0-redirect enforcement
  const server = http.createServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'leak=1' });
      res.end(JSON.stringify({ ok: true, host: req.headers.host, cookie: req.headers.cookie || null }));
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: 'http://127.0.0.1:9999/secret' });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const broker = createNetFetchBroker();
    // Allowed port via localhost -> normalized to 127.0.0.1, Cookie stripped, Set-Cookie stripped
    const ok = await broker.fetchForPlugin(
      { httpsHosts: [], localLoopback: [port], allowLoopback: true },
      `http://localhost:${port}/ok`,
      { headers: { Cookie: 'forbidden=1', 'X-Test': 'yes' } }
    );
    assert.equal(ok.ok, true);
    assert.equal(ok.status, 200);
    assert.equal(ok.channel, 'localLoopback');
    assert.equal(ok.headers['set-cookie'], undefined);
    const body = JSON.parse(ok.bodyText);
    assert.equal(body.cookie, null);
    assert.equal(body.host, `127.0.0.1:${port}`);

    // Undeclared port rejected
    const deniedPort = await broker.fetchForPlugin(
      { httpsHosts: [], localLoopback: [port + 1], allowLoopback: true },
      `http://127.0.0.1:${port}/ok`
    );
    assert.equal(deniedPort.ok, false);
    assert.match(deniedPort.reason, /ERR_NET_LOOPBACK_PORT_NOT_ALLOWED/);

    // Redirect on localLoopback strictly forbidden (0 redirects)
    const redir = await broker.fetchForPlugin(
      { httpsHosts: [], localLoopback: [port], allowLoopback: true },
      `http://127.0.0.1:${port}/redirect`
    );
    assert.equal(redir.ok, false);
    assert.equal(redir.reason, 'ERR_NET_LOOPBACK_REDIRECT_FORBIDDEN');

    // BLK-07: GET with body must NOT send Content-Length header; cross-host HTTPS redirect MUST strip Authorization
    const capturedReqOpts = [];
    const mockHttps = {
      request(opts, cb) {
        capturedReqOpts.push(opts);
        const listeners = {};
        const reqObj = {
          setTimeout() {},
          on(ev, fn) {
            listeners[ev] = fn;
          },
          write() {},
          destroy() {},
          end() {
            const isFirst = capturedReqOpts.length === 1;
            const resListeners = {};
            const resObj = {
              statusCode: isFirst ? 302 : 200,
              statusMessage: isFirst ? 'Found' : 'OK',
              headers: isFirst ? { location: 'https://cdn.b.example/final' } : {},
              resume() {},
              on(ev, fn) {
                resListeners[ev] = fn;
              },
            };
            cb(resObj);
            if (!isFirst) {
              if (resListeners.data) resListeners.data(Buffer.from('DONE'));
              if (resListeners.end) resListeners.end();
            }
          },
        };
        return reqObj;
      },
    };
    const brokerRedir = createNetFetchBroker({
      lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
      httpsModule: mockHttps,
    });
    const redirRes = await brokerRedir.fetchForPlugin(
      { httpsHosts: ['api.a.example', 'cdn.b.example'], localLoopback: [], allowLoopback: false },
      'https://api.a.example/start',
      { method: 'GET', body: 'ignored-on-get', headers: { Authorization: 'Bearer SECRET', 'X-Keep': 'yes' } }
    );
    assert.equal(redirRes.ok, true);
    assert.equal(capturedReqOpts.length, 2);
    assert.equal(capturedReqOpts[0].headers['Content-Length'], undefined, 'BLK-07: GET must not emit Content-Length');
    assert.equal(capturedReqOpts[0].headers.Authorization, 'Bearer SECRET');
    assert.equal(capturedReqOpts[1].headers.Authorization, undefined, 'BLK-07: Cross-host redirect must strip Authorization');
    assert.equal(capturedReqOpts[1].headers['X-Keep'], 'yes');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('TC-V30-10: Remote Web host bridge netFetch allows httpsHosts via GM_xmlhttpRequest and blocks localLoopback', async () => {
  const seen = [];
  let mockResp = { status: 200, statusText: 'OK', responseText: '{"ok":true}' };
  const bridge = createRemoteHostBridge({
    profileId: 'antigravity-remote-web',
    forbiddenNetHosts: ['antigravity.google.com', 'accounts.google.com'],
    netBindings: {
      'rw-addon': { httpsHosts: ['api.example.com'] },
    },
    netTransport(req) {
      seen.push(req);
      req.onload(mockResp);
    },
  });

  const ok = await bridge.port.netFetch('rw-addon', 'https://api.example.com/v1/ping', {
    headers: { Cookie: 'bad=1', 'X-Safe': '1' },
  });
  assert.equal(ok.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].anonymous, true);
  assert.deepEqual(seen[0].headers, { 'X-Safe': '1' });

  // NB-03: Redirect finalUrl to disallowed host MUST fail closed, and oversized body MUST fail
  mockResp = { status: 200, statusText: 'OK', responseText: 'secret', finalUrl: 'https://evil.example.com/leak' };
  const badRedirect = await bridge.port.netFetch('rw-addon', 'https://api.example.com/v1/redir');
  assert.equal(badRedirect.ok, false);
  assert.match(badRedirect.reason, /ERR_NET_REDIRECT_FORBIDDEN/);

  mockResp = { status: 200, statusText: 'OK', responseText: 'x'.repeat(2048) };
  const tooLarge = await bridge.port.netFetch('rw-addon', 'https://api.example.com/v1/big', { maxResponseBytes: 1024 });
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.reason, 'ERR_NET_RESPONSE_TOO_LARGE');

  // NEW-NB-02 / R3-NB-02: Multi-byte UTF-8 response (500 UTF-16 code units = 1500 UTF-8 bytes) MUST trip 1024-byte cap
  mockResp = { status: 200, statusText: 'OK', responseText: '한'.repeat(500) };
  const tooLargeUtf8 = await bridge.port.netFetch('rw-addon', 'https://api.example.com/v1/utf8', { maxResponseBytes: 1024 });
  assert.equal(tooLargeUtf8.ok, false);
  assert.equal(tooLargeUtf8.reason, 'ERR_NET_RESPONSE_TOO_LARGE');

  const loopDenied = await bridge.port.netFetch('rw-addon', 'http://127.0.0.1:11434/api/tags');
  assert.equal(loopDenied.ok, false);
  assert.equal(loopDenied.reason, 'ERR_NET_LOOPBACK_NOT_SUPPORTED');
});

test('TC-V30-11: @extenra/sdk parity harness (Desktop vs Remote Web) and extenra-addon / ag-addon CLI init/check/pack', async () => {
  const addon = defineAddon({
    setup(ctx) {
      ctx.ui.registerStatusItem({ id: 'btn', label: ctx.env.surface });
      ctx.ui.openPopup({
        title: 'Demo',
        tree: h('stack', { id: 'r' }, [h('text', { id: 't', text: ctx.env.surface })]),
      });
    },
  });
  const manifest = {
    schemaVersion: 3,
    pluginId: 'parity-addon',
    displayName: 'Parity Addon',
    version: '1.0.0',
    trustLevel: 'trusted',
    capabilities: ['renderer'],
    entry: { rendererScript: 'src/index.js' },
    permissions: {
      net: { httpsHosts: ['api.example.com'], localLoopback: [11434] },
      configBridge: { scopes: [{ scopeId: 'host:cfg', access: 'ro' }] },
    },
  };

  const desktopHost = createTestHost({ surface: 'desktop' });
  const remoteHost = createTestHost({ surface: 'remote-web' });
  const dCtx = await desktopHost.mountPlugin(manifest, addon.setup);
  const rCtx = await remoteHost.mountPlugin(manifest, addon.setup);

  assert.equal(dCtx.env.surface, 'desktop');
  assert.equal(dCtx.env.capabilities.hasLocalLoopback, true);
  assert.ok(dCtx.configBridge);

  assert.equal(rCtx.env.surface, 'remote-web');
  assert.equal(rCtx.env.capabilities.hasLocalLoopback, false);
  assert.equal(rCtx.configBridge, undefined);

  // CLI init -> check -> pack + unsafe sink detection
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-sdk-cli-'));
  try {
    const initRes = cmdInit(tmpDir, 'demo-sdk-addon');
    assert.equal(initRes.ok, true);
    const checkOk = cmdCheck(tmpDir);
    assert.equal(checkOk.ok, true);
    const packOk = cmdBuildOrPack(tmpDir, 'pack');
    assert.equal(packOk.ok, true);
    assert.ok(fs.existsSync(path.join(tmpDir, 'dist', 'SHA256SUMS.txt')));

    // Inject unsafe innerHTML sink -> check MUST fail
    fs.appendFileSync(path.join(tmpDir, 'src', 'index.js'), '\ndocument.body.innerHTML = "xss";\n', 'utf8');
    const checkBad = cmdCheck(tmpDir);
    assert.equal(checkBad.ok, false);
    assert.ok(checkBad.errors.some((e) => /Unsafe DOM\/eval sink/i.test(e)));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-V30-12: 1-Click Hub Safari routing guard & curated all-in-one closed Shadow DOM + GM_* closure shadowing', () => {
  const curated = buildCuratedAllInOneUserscript({
    packedAddons: [
      {
        pluginMeta: { pluginId: 'demo-v3', displayName: 'Demo V3', version: '1.0.0', sourceSchemaVersion: 3 },
        rendererSource: 'addonHost.ui.showToast("hi");',
      },
    ],
    connectHosts: ['api.example.com'],
  });
  assert.ok(curated.includes('drawerShadowMode: opts.drawerShadowMode || "closed"'));
  assert.ok(curated.includes('GM, GM_xmlhttpRequest, GM_getValue, GM_setValue'));
  assert.ok(curated.includes('GM_info, GM_openInTab, GM_registerMenuCommand, GM_notification, GM_download, GM_cookie'));
  assert.ok(curated.includes('bootRemoteWebHost()'), 'BLK-05: Curated All-in-One bundle MUST include auto-boot snippet');
  assert.equal(curated.includes('@require'), false);

  // BLK-06: Remote Web collector forwards v3 apiVersion & sanitized permissions (stripping localLoopback)
  const { collectRemoteWebAddons } = require('../../src/adapters/remote-web/addon-collector');
  const { ANTIGRAVITY_REMOTE_WEB_PROFILE } = require('../../src/profiles/antigravity-remote-web');
  const tmpPack = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-v3-remote-pack-'));
  try {
    const addonsDir = path.join(tmpPack, 'addons.d');
    const pluginsRoot = path.join(tmpPack, 'plugins');
    fs.mkdirSync(addonsDir, { recursive: true });
    fs.mkdirSync(path.join(pluginsRoot, 'v3-net-addon'), { recursive: true });
    fs.writeFileSync(path.join(pluginsRoot, 'v3-net-addon', 'index.js'), 'addonHost.ui.showToast("ok");', 'utf8');
    fs.writeFileSync(
      path.join(addonsDir, 'v3-net-addon.json'),
      JSON.stringify({
        schemaVersion: 3,
        pluginId: 'v3-net-addon',
        displayName: 'V3 Net Addon',
        version: '1.0.0',
        capabilities: ['renderer'],
        entry: { rendererScript: 'index.js' },
        permissions: { net: { httpsHosts: ['api.example.com'] } },
      }),
      'utf8'
    );
    const collected = collectRemoteWebAddons({
      profile: ANTIGRAVITY_REMOTE_WEB_PROFILE,
      addonsDir,
      pluginsRootDir: pluginsRoot,
      configJsonPath: null,
      trustPolicyPath: null,
      remotePrefsPath: null,
    });
    assert.equal(collected.addons.length, 1);
    assert.equal(collected.addons[0].pluginMeta.apiVersion, 3);
    assert.deepEqual(collected.addons[0].pluginMeta.permissions.net.httpsHosts, ['api.example.com']);
    assert.deepEqual(collected.addons[0].pluginMeta.permissions.net.localLoopback, []);

    // NEW-NB-01 / R3-NB-02: Electron addon store & collectExecutableAddons forward profile.forbiddenNetHosts
    const { createElectronAddonStorePort } = require('../../src/adapters/electron/electron-addon-store-port');
    const { collectExecutableAddons } = require('../../src/adapters/electron/host-loader-builder');
    const { ANTIGRAVITY_HOST_PROFILE } = require('../../src/profiles/antigravity');
    fs.mkdirSync(path.join(pluginsRoot, 'v3-forbidden-net'), { recursive: true });
    fs.writeFileSync(path.join(pluginsRoot, 'v3-forbidden-net', 'index.js'), 'addonHost.ui.showToast("no");', 'utf8');
    const forbiddenManifestObj = {
      schemaVersion: 3,
      pluginId: 'v3-forbidden-net',
      displayName: 'Forbidden Net Host',
      version: '1.0.0',
      capabilities: ['renderer'],
      entry: { rendererScript: 'index.js' },
      permissions: { net: { httpsHosts: ['accounts.google.com'] } },
    };
    fs.writeFileSync(path.join(addonsDir, 'v3-forbidden-net.json'), JSON.stringify(forbiddenManifestObj), 'utf8');
    const storeCtx = {
      activeProfile: ANTIGRAVITY_HOST_PROFILE,
      paths: {
        ADDONS_DIR: addonsDir,
        PLUGINS_ROOT_DIR: pluginsRoot,
      },
    };
    const storePort = createElectronAddonStorePort();
    const valRes = storePort.validateManifest(storeCtx, forbiddenManifestObj, { checkFilesExist: true });
    assert.equal(valRes.ok, false, 'NEW-NB-01: storePort.validateManifest must reject profile-forbidden net host');
    const planRes = storePort.planAddons(storeCtx);
    assert.ok(
      planRes.rejected.some((r) => r.pluginId === 'v3-forbidden-net'),
      'NEW-NB-01: storePort.planAddons must reject profile-forbidden net host'
    );
    const execRes = collectExecutableAddons(storeCtx.paths, {
      hostProfileId: ANTIGRAVITY_HOST_PROFILE.id,
      compatibleHostProfiles: ANTIGRAVITY_HOST_PROFILE.compatibleHostProfiles,
      supportedCapabilities: ANTIGRAVITY_HOST_PROFILE.supportedCapabilities,
      forbiddenNetHosts: ANTIGRAVITY_HOST_PROFILE.forbiddenNetHosts,
    });
    assert.equal(
      (execRes.active || []).some((a) => a.pluginId === 'v3-forbidden-net'),
      false,
      'NEW-NB-01: collectExecutableAddons must exclude profile-forbidden net host'
    );
    assert.ok(
      (execRes.rejected || []).some((r) => r.pluginId === 'v3-forbidden-net'),
      'NEW-NB-01: collectExecutableAddons must record forbidden net host in rejected'
    );
  } finally {
    fs.rmSync(tmpPack, { recursive: true, force: true });
  }

  const hubFiles = buildHubFiles({ version: '3.0.0', hostLibSha256: 'a'.repeat(64) });
  assert.ok(hubFiles['index.html'].includes('#sha256=' + 'a'.repeat(64)));
  assert.equal(/<script>/.test(hubFiles['index.html']), false, 'Hub HTML must have zero inline scripts');

  // Verify hub.js Safari routing guard
  const mod = { exports: {} };
  const fn = new Function('module', 'exports', hubFiles['hub.js']);
  fn(mod, mod.exports);
  const { detectBrowserEnv } = mod.exports;
  assert.equal(
    detectBrowserEnv('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15').isSafari,
    true
  );
  assert.equal(
    detectBrowserEnv('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36').isSafari,
    false
  );
});
