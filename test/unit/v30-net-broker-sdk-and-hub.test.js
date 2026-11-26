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
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('TC-V30-10: Remote Web host bridge netFetch allows httpsHosts via GM_xmlhttpRequest and blocks localLoopback', async () => {
  const seen = [];
  const bridge = createRemoteHostBridge({
    profileId: 'antigravity-remote-web',
    forbiddenNetHosts: ['antigravity.google.com', 'accounts.google.com'],
    netBindings: {
      'rw-addon': { httpsHosts: ['api.example.com'] },
    },
    netTransport(req) {
      seen.push(req);
      req.onload({ status: 200, statusText: 'OK', responseText: '{"ok":true}' });
    },
  });

  const ok = await bridge.port.netFetch('rw-addon', 'https://api.example.com/v1/ping', {
    headers: { Cookie: 'bad=1', 'X-Safe': '1' },
  });
  assert.equal(ok.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].anonymous, true);
  assert.deepEqual(seen[0].headers, { 'X-Safe': '1' });

  const loopDenied = await bridge.port.netFetch('rw-addon', 'http://127.0.0.1:11434/api/tags');
  assert.equal(loopDenied.ok, false);
  assert.equal(loopDenied.reason, 'ERR_NET_LOOPBACK_NOT_SUPPORTED');
});

test('TC-V30-11: @antigravity-addons/sdk parity harness (Desktop vs Remote Web) and ag-addon CLI init/check/pack', async () => {
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
  assert.equal(curated.includes('@require'), false);

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
