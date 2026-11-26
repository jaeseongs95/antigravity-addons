'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const {
  validateSecretKey,
  validateSecretValue,
  validateSecretsPermissions,
  normalizeSecretHeadersSpec,
  resolveSecretHeaders,
} = require('../../src/core/secrets-policy');
const { validateAddonManifest } = require('../../src/core/manifest-validator');
const { createSecretsVault } = require('../../src/runtime/main/secrets-vault');
const { createNetFetchBroker } = require('../../src/runtime/main/net-fetch-broker');
const { createRemoteBridgeServer } = require('../../src/runtime/main/remote-bridge-server');
const { createRemoteHostBridge } = require('../../src/adapters/remote-web/remote-host-bridge');
const { createRemoteHostTransport } = require('../../src/adapters/remote-web/remote-host-transport');
const { createTestHost } = require('../../packages/sdk/src/index');

function createMockSafeStorage({ available = true } = {}) {
  const prefix = 'ENC_V1:';
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(prefix + Buffer.from(String(plain), 'utf8').toString('hex'), 'utf8'),
    decryptString: (buf) => {
      const s = Buffer.from(buf).toString('utf8');
      if (!s.startsWith(prefix)) throw new Error('BAD_CIPHERTEXT');
      return Buffer.from(s.slice(prefix.length), 'hex').toString('utf8');
    },
  };
}

function makeTrustedSecretsManifest(overrides = {}) {
  return {
    schemaVersion: 3,
    apiVersion: 3,
    pluginId: 'demo-secrets-addon',
    displayName: 'Demo Secrets Addon',
    version: '1.0.0',
    trustLevel: 'trusted',
    capabilities: ['renderer'],
    entry: { rendererScript: 'dist/renderer.js' },
    permissions: {
      secrets: { maxKeys: 8, maxBytes: 4096, allowRead: false },
      net: { httpsHosts: ['api.openai.com', 'api.anthropic.com'] },
    },
    ...overrides,
  };
}

test('TC-V330-01: secrets-policy validates keys, values, permissions, and secretHeaders strictly', () => {
  assert.equal(validateSecretKey('openai_api_key').ok, true);
  assert.equal(validateSecretKey('__proto__').ok, false);
  assert.equal(validateSecretKey('bad key!').ok, false);
  assert.equal(validateSecretValue('sk-test-1234').ok, true);
  assert.equal(validateSecretValue('').ok, false);
  assert.equal(validateSecretValue('abc\0def').ok, false);
  assert.equal(validateSecretValue('a'.repeat(9000)).ok, false);

  const restrictedCheck = validateSecretsPermissions({ maxKeys: 4 }, { trustLevel: 'restricted' });
  assert.equal(restrictedCheck.ok, false);
  assert.equal(restrictedCheck.reason, 'ERR_RESTRICTED_SECRETS_FORBIDDEN');

  const trustedCheck = validateSecretsPermissions({ maxKeys: 4, maxBytes: 2048, allowRead: true }, { trustLevel: 'trusted' });
  assert.equal(trustedCheck.ok, true);
  assert.equal(trustedCheck.allowRead, true);

  const forbiddenHdr = normalizeSecretHeadersSpec({ Cookie: { secretKey: 'openai_api_key' } });
  assert.equal(forbiddenHdr.ok, false);

  const resolved = resolveSecretHeaders(
    {
      Authorization: { secretKey: 'openai_api_key', prefix: 'Bearer ' },
      'x-api-key': 'anthropic_api_key',
    },
    (k) => ({ ok: true, value: k === 'openai_api_key' ? 'sk-openai-xyz' : 'sk-ant-abc' })
  );
  assert.equal(resolved.ok, true);
  assert.equal(resolved.headers.Authorization, 'Bearer sk-openai-xyz');
  assert.equal(resolved.headers['x-api-key'], 'sk-ant-abc');
  assert.deepEqual(resolved.injectedHeaderNames, ['authorization', 'x-api-key']);
});

test('TC-V330-02: manifest-validator enforces trusted-only secrets & reserves secrets-vault.json', () => {
  const restrictedManifest = makeTrustedSecretsManifest({ trustLevel: 'restricted' });
  const r1 = validateAddonManifest(restrictedManifest);
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'ERR_RESTRICTED_SECRETS_FORBIDDEN');

  const trustedManifest = makeTrustedSecretsManifest();
  const r2 = validateAddonManifest(trustedManifest);
  assert.equal(r2.ok, true);
  assert.equal(r2.hasSecrets, true);
  assert.equal(r2.requiresTrustApproval, true);
  assert.equal(r2.manifest.permissions.secrets.allowRead, false);

  const reservedSettingsManifest = makeTrustedSecretsManifest({
    settingsBridge: { fileName: 'secrets-vault.json' },
  });
  const r3 = validateAddonManifest(reservedSettingsManifest);
  assert.equal(r3.ok, false);
  assert.equal(r3.reason, 'ERR_RESERVED_SETTINGS_BRIDGE_FILE');
});

test('TC-V330-03: secrets-vault encrypts at rest, fails closed when unavailable, and gates allowRead', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extenra-v330-vault-'));
  try {
    const vaultPath = path.join(tmpDir, 'secrets-vault.json');

    // Unavailable OS encryption -> fail-closed (never writes plaintext)
    const unavailVault = createSecretsVault({ vaultPath, safeStorage: createMockSafeStorage({ available: false }) });
    const failSet = unavailVault.setSecret('demo-secrets-addon', { maxKeys: 4, maxBytes: 4096, allowRead: false }, 'openai_api_key', 'sk-secret-value');
    assert.equal(failSet.ok, false);
    assert.equal(failSet.reason, 'ERR_SECRETS_ENCRYPTION_UNAVAILABLE');
    assert.equal(fs.existsSync(vaultPath), false);

    // Available OS encryption -> encrypts on disk
    const vault = createSecretsVault({ vaultPath, safeStorage: createMockSafeStorage({ available: true }) });
    const bindingNoRead = { maxKeys: 2, maxBytes: 1024, allowRead: false };
    const setRes = vault.setSecret('demo-secrets-addon', bindingNoRead, 'openai_api_key', 'sk-real-secret-999');
    assert.equal(setRes.ok, true);
    assert.equal(setRes.persistence, 'os-encrypted');

    const rawFile = fs.readFileSync(vaultPath, 'utf8');
    assert.equal(rawFile.includes('sk-real-secret-999'), false, 'plaintext secret must never appear on disk');

    // has / list / delete / quota
    assert.equal(vault.hasSecret('demo-secrets-addon', bindingNoRead, 'openai_api_key').exists, true);
    assert.deepEqual(vault.listSecretKeys('demo-secrets-addon', bindingNoRead).keys, ['openai_api_key']);
    // Cross-plugin isolation
    assert.equal(vault.hasSecret('other-plugin', bindingNoRead, 'openai_api_key').exists, false);

    // allowRead: false blocks getSecret, but allows resolveSecretForHost
    const blockedGet = vault.getSecret('demo-secrets-addon', bindingNoRead, 'openai_api_key');
    assert.equal(blockedGet.ok, false);
    assert.equal(blockedGet.reason, 'ERR_SECRETS_READ_NOT_ALLOWED');

    const hostResolve = vault.resolveSecretForHost('demo-secrets-addon', bindingNoRead, 'openai_api_key');
    assert.equal(hostResolve.ok, true);
    assert.equal(hostResolve.value, 'sk-real-secret-999');

    // allowRead: true permits getSecret
    const bindingWithRead = { maxKeys: 2, maxBytes: 1024, allowRead: true };
    const okGet = vault.getSecret('demo-secrets-addon', bindingWithRead, 'openai_api_key');
    assert.equal(okGet.ok, true);
    assert.equal(okGet.value, 'sk-real-secret-999');

    // maxKeys enforcement
    assert.equal(vault.setSecret('demo-secrets-addon', bindingNoRead, 'key_2', 'val2').ok, true);
    const overMax = vault.setSecret('demo-secrets-addon', bindingNoRead, 'key_3', 'val3');
    assert.equal(overMax.ok, false);
    assert.equal(overMax.reason, 'ERR_SECRETS_MAX_KEYS_EXCEEDED');

    // delete
    assert.equal(vault.deleteSecret('demo-secrets-addon', bindingNoRead, 'openai_api_key').deleted, true);
    assert.equal(vault.hasSecret('demo-secrets-addon', bindingNoRead, 'openai_api_key').exists, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-V330-04: netFetchBroker injects secretHeaders after URL allowlist and strips them on cross-host redirect', async () => {
  let secretLookups = 0;
  const capturedRequests = [];

  const mockHttps = {
    request(opts, cb) {
      capturedRequests.push({ host: opts.headers.Host, path: opts.path, headers: { ...opts.headers } });
      const { EventEmitter } = require('node:events');
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.write = () => {};
      req.destroy = () => {};
      req.end = () => {
        const res = new EventEmitter();
        res.resume = () => {};
        if (opts.path === '/redirect-cross-host') {
          res.statusCode = 302;
          res.statusMessage = 'Found';
          res.headers = { location: 'https://api.anthropic.com/v1/messages' };
          cb(res);
          return;
        }
        res.statusCode = 200;
        res.statusMessage = 'OK';
        res.headers = { 'content-type': 'application/json' };
        cb(res);
        res.emit('data', Buffer.from('{"ok":true}'));
        res.emit('end');
      };
      return req;
    },
  };

  const broker = createNetFetchBroker({
    lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
    httpsModule: mockHttps,
    resolvePluginSecret: (pid, key) => {
      secretLookups += 1;
      if (pid === 'demo-secrets-addon' && key === 'openai_api_key') {
        return { ok: true, value: 'sk-injected-secret' };
      }
      return { ok: false, reason: `ERR_SECRET_NOT_FOUND:${key}` };
    },
  });

  const binding = {
    pluginId: 'demo-secrets-addon',
    httpsHosts: ['api.openai.com', 'api.anthropic.com'],
    localLoopback: [],
    allowLoopback: false,
    secretsBinding: { pluginId: 'demo-secrets-addon', maxKeys: 8, maxBytes: 4096, allowRead: false },
  };

  // Disallowed host must fail BEFORE decrypting any secret
  const denied = await broker.fetchForPlugin(binding, 'https://evil.example.com/steal', {
    method: 'POST',
    secretHeaders: { Authorization: { secretKey: 'openai_api_key', prefix: 'Bearer ' } },
  });
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /^ERR_NET_HOST_NOT_ALLOWED/);
  assert.equal(secretLookups, 0, 'secret must not be decrypted for disallowed URL');

  // Allowed host gets secret injected server-side
  const okRes = await broker.fetchForPlugin(binding, 'https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'spoofed' },
    secretHeaders: {
      Authorization: { secretKey: 'openai_api_key', prefix: 'Bearer ' },
      'x-api-key': { secretKey: 'openai_api_key' },
    },
    body: '{}',
  });
  assert.equal(okRes.ok, true);
  assert.equal(capturedRequests[0].headers.Authorization, 'Bearer sk-injected-secret');
  assert.equal(capturedRequests[0].headers['x-api-key'], 'sk-injected-secret');

  // Cross-host redirect must strip Authorization AND x-api-key
  capturedRequests.length = 0;
  const redirRes = await broker.fetchForPlugin(binding, 'https://api.openai.com/redirect-cross-host', {
    method: 'GET',
    secretHeaders: {
      Authorization: { secretKey: 'openai_api_key', prefix: 'Bearer ' },
      'x-api-key': { secretKey: 'openai_api_key' },
    },
  });
  assert.equal(redirRes.ok, true);
  assert.equal(capturedRequests.length, 2);
  assert.equal(capturedRequests[0].headers['x-api-key'], 'sk-injected-secret');
  assert.equal(capturedRequests[1].headers.Authorization, undefined);
  assert.equal(capturedRequests[1].headers['x-api-key'], undefined);
});

test('TC-V330-05: Remote Web standalone keeps secrets strictly in session-memory (zero localStorage writes) and clears on dispose', async () => {
  const persistedCalls = [];
  const mockStore = {
    getItem: () => null,
    setItem: (k, v) => persistedCalls.push({ k, v }),
    removeItem: () => {},
  };
  let capturedXhrHeaders = null;

  const bridge = createRemoteHostBridge({
    storage: mockStore,
    netTransport: (opts) => {
      capturedXhrHeaders = opts.headers;
      opts.onload({ status: 200, statusText: 'OK', responseText: '{"ok":true}', finalUrl: opts.url });
    },
  });
  bridge.bindSecretsPlugin('demo-secrets-addon', { maxKeys: 4, maxBytes: 4096, allowRead: false });
  bridge.bindNetPlugin('demo-secrets-addon', { httpsHosts: ['api.openai.com'] });

  const setRes = await bridge.port.secretsSet('demo-secrets-addon', 'openai_api_key', 'sk-ephemeral-123');
  assert.equal(setRes.ok, true);
  assert.equal(setRes.persistence, 'session-memory');
  assert.equal(persistedCalls.length, 0, 'standalone Remote Web must NEVER write secrets to localStorage/GM');

  assert.equal((await bridge.port.secretsHas('demo-secrets-addon', 'openai_api_key')).exists, true);
  assert.equal((await bridge.port.secretsGet('demo-secrets-addon', 'openai_api_key')).reason, 'ERR_SECRETS_READ_NOT_ALLOWED');

  const fetchRes = await bridge.port.netFetch('demo-secrets-addon', 'https://api.openai.com/v1/models', {
    method: 'GET',
    secretHeaders: { Authorization: { secretKey: 'openai_api_key', prefix: 'Bearer ' } },
  });
  assert.equal(fetchRes.ok, true);
  assert.equal(capturedXhrHeaders.Authorization, 'Bearer sk-ephemeral-123');

  bridge.dispose();
  assert.equal((await bridge.port.secretsHas('demo-secrets-addon', 'openai_api_key')).exists, false);
});

test('TC-V330-06: Remote Bridge server routes /v1/secrets/* and injects secretHeaders on Desktop vault', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extenra-v330-bridge-'));
  const pluginScript = path.join(tmpDir, 'renderer.js');
  fs.writeFileSync(pluginScript, "'use strict';\n", 'utf8');
  const crypto = require('node:crypto');
  const scriptSha = crypto.createHash('sha256').update(fs.readFileSync(pluginScript)).digest('hex');

  const vault = createSecretsVault({
    vaultPath: path.join(tmpDir, 'secrets-vault.json'),
    safeStorage: createMockSafeStorage({ available: true }),
  });

  let capturedServerAuth = null;
  const netBroker = createNetFetchBroker({
    lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
    httpsModule: {
      request(opts, cb) {
        capturedServerAuth = opts.headers.Authorization;
        const { EventEmitter } = require('node:events');
        const req = new EventEmitter();
        req.setTimeout = () => {};
        req.write = () => {};
        req.destroy = () => {};
        req.end = () => {
          const res = new EventEmitter();
          res.statusCode = 200;
          res.statusMessage = 'OK';
          res.headers = {};
          cb(res);
          res.emit('data', Buffer.from('{"choices":[]}'));
          res.emit('end');
        };
        return req;
      },
    },
    resolvePluginSecret: (pid, key, binding) => vault.resolveSecretForHost(pid, binding.secretsBinding, key),
  });

  const manifest = makeTrustedSecretsManifest();
  const bridgeServer = createRemoteBridgeServer({
    configPath: path.join(tmpDir, 'remote-bridge.json'),
    allowedOrigins: ['https://antigravity.google.com'],
    strictTrustPolicy: true,
    planCurrentAddons: () => ({
      active: [{ pluginId: manifest.pluginId, manifest, resolvedEntries: { rendererScript: pluginScript } }],
      disabled: [],
      rejected: [],
    }),
    readCurrentPolicy: () => ({
      schemaVersion: 1,
      approved: { [manifest.pluginId]: { rendererSha256: scriptSha } },
    }),
    netFetchBroker: netBroker,
    secretsVault: vault,
  });

  try {
    const cfgRes = await bridgeServer.configure({ enabled: true, bindHost: '127.0.0.1', port: 0 });
    assert.equal(cfgRes.ok, true);
    const st = bridgeServer.getStatus({ includeSecrets: true });
    const baseUrl = st.localUrl || `http://127.0.0.1:${st.listeningPort}`;

    const transport = createRemoteHostTransport({ fetchFn: globalThis.fetch.bind(globalThis) });
    const conn = await transport.connect({ baseUrl, token: st.token });
    assert.equal(conn.ok, true);

    const rBridge = createRemoteHostBridge({ remoteTransport: transport });
    rBridge.bindSecretsPlugin(manifest.pluginId, manifest.permissions.secrets);
    rBridge.bindNetPlugin(manifest.pluginId, manifest.permissions.net);

    const setRes = await rBridge.port.secretsSet(manifest.pluginId, 'openai_api_key', 'sk-desktop-vault-key');
    assert.equal(setRes.ok, true);
    assert.equal(setRes.persistence, 'remote-bridge');
    assert.equal((await rBridge.port.secretsHas(manifest.pluginId, 'openai_api_key')).exists, true);
    assert.equal((await rBridge.port.secretsGet(manifest.pluginId, 'openai_api_key')).reason, 'ERR_SECRETS_READ_NOT_ALLOWED');

    const netRes = await rBridge.port.netFetch(manifest.pluginId, 'https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: '{}',
      secretHeaders: { Authorization: { secretKey: 'openai_api_key', prefix: 'Bearer ' } },
    });
    assert.equal(netRes.ok, true);
    assert.equal(capturedServerAuth, 'Bearer sk-desktop-vault-key');
  } finally {
    await bridgeServer.stop();
    bridgeServer.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-V330-07: AddonContextV3 & @extenra/sdk createTestHost enforce ISP gating for ctx.secrets and secretHeaders', async () => {
  let seenHeaders = null;
  const host = createTestHost({
    surface: 'desktop',
    netHandler: (_pid, _url, init) => {
      seenHeaders = init.headers;
      return { ok: true, status: 200, bodyText: '{"ok":true}' };
    },
  });

  // 1. Default allowRead: false -> ctx.secrets.get is strictly omitted
  const ctxNoRead = await host.mountPlugin(makeTrustedSecretsManifest({ pluginId: 'addon-no-read' }));
  assert.equal(ctxNoRead.env.capabilities.hasSecrets, true);
  assert.equal(ctxNoRead.env.capabilities.secretsPersistence, 'os-encrypted');
  assert.equal(typeof ctxNoRead.secrets.set, 'function');
  assert.equal(typeof ctxNoRead.secrets.has, 'function');
  assert.equal(typeof ctxNoRead.secrets.delete, 'function');
  assert.equal(typeof ctxNoRead.secrets.keys, 'function');
  assert.equal(ctxNoRead.secrets.get, undefined, 'ctx.secrets.get must be omitted unless allowRead: true');

  await ctxNoRead.secrets.set('openai_api_key', 'sk-sdk-test');
  assert.equal(await ctxNoRead.secrets.has('openai_api_key'), true);
  assert.deepEqual(await ctxNoRead.secrets.keys(), ['openai_api_key']);
  const netRes = await ctxNoRead.net.fetch('https://api.openai.com/v1/models', {
    method: 'GET',
    secretHeaders: { Authorization: { secretKey: 'openai_api_key', prefix: 'Bearer ' } },
  });
  assert.equal(netRes.ok, true);
  assert.equal(seenHeaders.Authorization, 'Bearer sk-sdk-test');

  // 2. Opt-in allowRead: true -> ctx.secrets.get is exposed
  const ctxWithRead = await host.mountPlugin(
    makeTrustedSecretsManifest({
      pluginId: 'addon-with-read',
      permissions: { secrets: { allowRead: true } },
    })
  );
  assert.equal(typeof ctxWithRead.secrets.get, 'function');
  await ctxWithRead.secrets.set('custom_tok', 'tok-123');
  assert.equal(await ctxWithRead.secrets.get('custom_tok'), 'tok-123');

  // 3. Undeclared permissions.secrets -> ctx.secrets is strictly omitted
  const ctxPlain = await host.mountPlugin({
    schemaVersion: 3,
    pluginId: 'addon-plain',
    displayName: 'Plain',
    version: '1.0.0',
    trustLevel: 'restricted',
    capabilities: ['renderer'],
    entry: { rendererScript: 'dist/renderer.js' },
  });
  assert.equal(ctxPlain.env.capabilities.hasSecrets, false);
  assert.equal(ctxPlain.env.capabilities.secretsPersistence, 'none');
  assert.equal(ctxPlain.secrets, undefined);
});
