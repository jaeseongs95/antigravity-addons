'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { validateAddonManifest } = require('../../src/core/manifest-validator');
const { planAddonExecution } = require('../../src/core/lifecycle-coordinator');
const { createSlotRegistry } = require('../../src/core/slot-registry');
const { getPrivilegedRequirements } = require('../../src/core/trust-policy-port');
const { validateHostProfile } = require('../../src/core/host-profile-port');
const {
  ANTIGRAVITY_HOST_PROFILE,
  resolveAntigravityPaths,
  resolveAntigravityConfigScopes,
} = require('../../src/profiles/antigravity');
const { buildHostLoaderScriptSource } = require('../../src/adapters/electron/host-loader-builder');
const { createNodeFileSystemPort } = require('../../src/adapters/node-fs-port');
const { wrapHostBridgePort, isValidHostBridgePort } = require('../../src/runtime/renderer/host-bridge-port');
const { createRendererKernel } = require('../../src/runtime/renderer/kernel');
const { createConfigBridge } = require('../../src/runtime/main/config-bridge');
const { createHostRuntimeController } = require('../../src/runtime/main/init-main');
const { IPC_CHANNELS } = require('../../src/runtime/shared/constants');

function makeTmpDir(prefix = 'agy-v23-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function makeBaseManifest(overrides = {}) {
  const { compatibility, entry, ...rest } = overrides;
  return {
    schemaVersion: 2,
    pluginId: 'test-v23-addon',
    displayName: 'Test v2.3 Addon',
    version: '1.0.0',
    trustLevel: 'trusted',
    compatibility: {
      minHostVersion: '2.3.0',
      ...(compatibility || {}),
    },
    capabilities: ['renderer'],
    entry: entry || {
      rendererScript: 'dist/renderer.js',
    },
    isolation: {
      noTranslate: true,
      i18nSelfManaged: true,
    },
    ...rest,
  };
}

function makeMockDom() {
  const makeEl = (tag) => {
    const attrs = {};
    return {
      tagName: String(tag || 'DIV').toUpperCase(),
      style: {},
      children: [],
      setAttribute(k, v) {
        attrs[k] = String(v);
      },
      getAttribute(k) {
        return attrs[k] || null;
      },
      appendChild(c) {
        c.parentNode = this;
        this.children.push(c);
      },
      removeChild(c) {
        this.children = this.children.filter((x) => x !== c);
        c.parentNode = null;
      },
    };
  };
  const body = makeEl('body');
  return {
    body,
    head: body,
    documentElement: body,
    createElement: makeEl,
    addEventListener() {},
    removeEventListener() {},
  };
}

test('v2.3.0 HostProfile multi-profile compatibility & fail-closed supportedCapabilities', () => {
  const tmpDir = makeTmpDir('agy-v23-profile-');
  try {
    const pluginsRootDir = path.join(tmpDir, 'plugins');
    const addonDir = path.join(pluginsRootDir, 'dual-cap-addon', 'dist');
    fs.mkdirSync(addonDir, { recursive: true });
    fs.writeFileSync(path.join(addonDir, 'renderer.js'), '/* renderer */\n', 'utf8');
    fs.writeFileSync(path.join(addonDir, 'main-hook.js'), 'module.exports = () => {};\n', 'utf8');

    const dualManifest = makeBaseManifest({
      pluginId: 'dual-cap-addon',
      capabilities: ['renderer', 'mainHook'],
      entry: { rendererScript: 'dist/renderer.js', mainHookScript: 'dist/main-hook.js' },
      compatibility: { hostProfile: 'antigravity-desktop' },
    });

    const fsPort = createNodeFileSystemPort();
    // On a Remote Web profile compatible with antigravity-desktop but supporting only ['renderer']
    const webRes = validateAddonManifest(dualManifest, {
      pluginsRootDir,
      checkFilesExist: true,
      hostProfileId: 'antigravity-remote-web',
      compatibleHostProfiles: ['antigravity-desktop'],
      supportedCapabilities: ['renderer'],
      hostVersion: '2.3.0',
      fsPort,
    });
    assert.equal(webRes.ok, true);
    assert.deepEqual(webRes.skippedCapabilities, ['mainHook']);
    assert.equal(webRes.resolvedEntries.mainHookScript, null);
    assert.ok(webRes.resolvedEntries.rendererScript.endsWith('renderer.js'));

    // Explicit hostProfiles allowlist restricts to listed profiles only
    const explicitOnlyRes = validateAddonManifest(
      makeBaseManifest({
        pluginId: 'desktop-allowlist-only',
        compatibility: { hostProfiles: ['antigravity-desktop'] },
      }),
      {
        pluginsRootDir,
        checkFilesExist: false,
        hostProfileId: 'antigravity-remote-web',
        compatibleHostProfiles: ['antigravity-desktop'],
        supportedCapabilities: ['renderer'],
        hostVersion: '2.3.0',
      }
    );
    assert.equal(explicitOnlyRes.ok, false);
    assert.equal(explicitOnlyRes.reason, 'ERR_INCOMPATIBLE_HOST_PROFILE');

    // Excluded profile is rejected cleanly
    const excludedManifest = makeBaseManifest({
      pluginId: 'desktop-only-addon',
      compatibility: { excludeHostProfiles: ['antigravity-remote-web'] },
    });
    const exRes = validateAddonManifest(excludedManifest, {
      pluginsRootDir,
      checkFilesExist: false,
      hostProfileId: 'antigravity-remote-web',
      compatibleHostProfiles: ['antigravity-desktop'],
      supportedCapabilities: ['renderer'],
      hostVersion: '2.3.0',
    });
    assert.equal(exRes.ok, false);
    assert.equal(exRes.reason, 'ERR_INCOMPATIBLE_HOST_PROFILE');

    // mainHook-only addon on renderer-only profile is rejected cleanly
    const mainOnlyManifest = makeBaseManifest({
      pluginId: 'main-only-addon',
      capabilities: ['mainHook'],
      entry: { mainHookScript: 'dist/main-hook.js' },
    });
    const moRes = validateAddonManifest(mainOnlyManifest, {
      pluginsRootDir,
      checkFilesExist: false,
      hostProfileId: 'antigravity-remote-web',
      compatibleHostProfiles: ['antigravity-desktop'],
      supportedCapabilities: ['renderer'],
      hostVersion: '2.3.0',
    });
    assert.equal(moRes.ok, false);
    assert.equal(moRes.reason, 'ERR_UNSUPPORTED_HOST_CAPABILITY');

    // validateHostProfile accepts optional compatibleHostProfiles, supportedCapabilities, resolveConfigScopes
    assert.deepEqual(validateHostProfile(ANTIGRAVITY_HOST_PROFILE), { ok: true });
    const scopes = resolveAntigravityConfigScopes(resolveAntigravityPaths({ HOME: tmpDir, USERPROFILE: tmpDir }));
    assert.equal(scopes['antigravity:mcp-config'].access, 'rw');
    assert.equal(scopes['antigravity:plugin-mcp-configs'].kind, 'plugin-files');
    assert.equal(scopes['antigravity:plugin-mcp-configs'].access, 'ro');
    assert.equal(scopes['antigravity:mcp-config-legacy'].access, 'ro');

    const loaderSrc = buildHostLoaderScriptSource(
      resolveAntigravityPaths({ HOME: tmpDir, USERPROFILE: tmpDir }),
      ANTIGRAVITY_HOST_PROFILE
    );
    assert.ok(loaderSrc.includes('antigravity:mcp-config'));
    assert.ok(loaderSrc.includes('supportedCapabilities'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('v2.3.0 configBridge manifest validation, trust policy, and SlotRegistry single-rw exclusivity', () => {
  // Restricted addon cannot declare configBridge
  const restrictedRes = validateAddonManifest(
    makeBaseManifest({
      pluginId: 'untrusted-cfg',
      trustLevel: 'restricted',
      configBridge: { scopes: [{ scopeId: 'antigravity:mcp-config', access: 'ro' }] },
    }),
    { checkFilesExist: false, hostVersion: '2.3.0' }
  );
  assert.equal(restrictedRes.ok, false);
  assert.equal(restrictedRes.reason, 'ERR_RESTRICTED_CONFIG_BRIDGE_FORBIDDEN');

  // Duplicate scopeId within one manifest rejected
  const dupScopeRes = validateAddonManifest(
    makeBaseManifest({
      pluginId: 'dup-scope-addon',
      configBridge: {
        scopes: [
          { scopeId: 'antigravity:mcp-config', access: 'ro' },
          { scopeId: 'antigravity:mcp-config', access: 'rw' },
        ],
      },
    }),
    { checkFilesExist: false, hostVersion: '2.3.0' }
  );
  assert.equal(dupScopeRes.ok, false);
  assert.equal(dupScopeRes.reason, 'ERR_DUPLICATE_CONFIG_SCOPE_IN_MANIFEST');

  // Valid trusted manifest with configBridge requires trust approval
  const okRes = validateAddonManifest(
    makeBaseManifest({
      pluginId: 'mcp-manager',
      configBridge: {
        scopes: [
          { scopeId: 'antigravity:mcp-config', access: 'rw' },
          { scopeId: 'antigravity:plugin-mcp-configs', access: 'ro' },
        ],
      },
    }),
    { checkFilesExist: false, hostVersion: '2.3.0' }
  );
  assert.equal(okRes.ok, true);
  assert.equal(okRes.hasConfigBridge, true);
  assert.equal(okRes.manifest.configBridge.scopes[0].maxBytes, 262144);
  const priv = getPrivilegedRequirements(okRes.manifest);
  assert.equal(priv.requiresTrustApproval, true);
  assert.equal(priv.hasConfigBridge, true);
  assert.ok(priv.privilegedCapabilities.includes('configBridge'));

  // SlotRegistry: multiple ro readers allowed, second rw writer rejected
  const reg = createSlotRegistry();
  assert.equal(
    reg.registerManifestSlots({
      pluginId: 'reader-1',
      uiSlots: [],
      configBridge: { scopes: [{ scopeId: 'antigravity:mcp-config', access: 'ro', maxBytes: 262144 }] },
    }).ok,
    true
  );
  assert.equal(
    reg.registerManifestSlots({
      pluginId: 'writer-1',
      uiSlots: [],
      configBridge: { scopes: [{ scopeId: 'antigravity:mcp-config', access: 'rw', maxBytes: 262144 }] },
    }).ok,
    true
  );
  assert.equal(
    reg.registerManifestSlots({
      pluginId: 'reader-2',
      uiSlots: [],
      configBridge: { scopes: [{ scopeId: 'antigravity:mcp-config', access: 'ro', maxBytes: 262144 }] },
    }).ok,
    true
  );
  const conflict = reg.registerManifestSlots({
    pluginId: 'writer-2',
    uiSlots: [],
    configBridge: { scopes: [{ scopeId: 'antigravity:mcp-config', access: 'rw', maxBytes: 262144 }] },
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.conflicts[0].code, 'ERR_DUPLICATE_CONFIG_SCOPE_WRITER');
  assert.equal(reg.snapshot().configScopeWriters['antigravity:mcp-config'], 'writer-1');
});

test('v2.3.0 HostBridgePort direct injection & kernel readConfigScope/writeConfigScope primordial security', async () => {
  assert.equal(isValidHostBridgePort(null), false);
  assert.equal(isValidHostBridgePort({ setPortalClaim() {} }), false);
  assert.throws(() => wrapHostBridgePort({ setPortalClaim() {} }), /ERR_HOST_BRIDGE_PORT_MISSING_METHOD:saveSettings/);

  const calls = [];
  const directBridge = {
    docGenId: 7,
    profileId: 'antigravity-remote-web',
    setPortalClaim: () => Promise.resolve({ ok: true }),
    saveSettings: () => Promise.resolve({ ok: true, snapshot: { status: 'ok', data: {} } }),
    reportError: () => {},
    ping: () => Promise.resolve({ ok: true }),
    readConfigScope(pluginId, scopeId) {
      calls.push({ op: 'read', pluginId, scopeId });
      return Promise.resolve({
        ok: true,
        scopeId,
        kind: 'file',
        status: 'ok',
        data: { mcpServers: { demo: { command: 'node' } } },
        rawText: null,
        sha256: 'a'.repeat(64),
        reason: null,
      });
    },
    writeConfigScope(pluginId, scopeId, rawJson, opts) {
      calls.push({ op: 'write', pluginId, scopeId, rawJson, opts });
      return Promise.resolve({
        ok: true,
        reason: null,
        backupFileName: 'mcp_config.json.bak',
        currentSha256: 'b'.repeat(64),
        snapshot: { ok: true, scopeId, kind: 'file', status: 'ok', data: JSON.parse(rawJson), sha256: 'b'.repeat(64) },
      });
    },
  };

  const kernel = createRendererKernel(makeMockDom(), {});
  const token = 'host-token-v23-remote-web-12345678';
  const bootRes = kernel.boot({ docGenId: 7, hostToken: token, hostBridge: directBridge });
  assert.equal(bootRes.ok, true);
  assert.equal(bootRes.hasBridge, true);
  assert.equal(bootRes.hostProfileId, 'antigravity-remote-web');
  assert.equal(kernel.getBridgeStatus().hostProfileId, 'antigravity-remote-web');

  const trustedHandle = kernel.createPluginHandle(
    {
      pluginId: 'mcp-manager',
      version: '1.0.0',
      trustLevel: 'trusted',
      hasConfigBridge: true,
      configScopes: [
        { scopeId: 'antigravity:mcp-config', access: 'rw', maxBytes: 262144 },
        { scopeId: 'antigravity:mcp-config-legacy', access: 'ro', maxBytes: 262144 },
      ],
      uiSlots: [],
    },
    token
  );
  assert.equal(trustedHandle.hostProfileId, 'antigravity-remote-web');
  assert.equal(trustedHandle.hasConfigBridge, true);
  assert.equal(trustedHandle.configScopes.length, 2);

  // Restricted handle gets ZERO config bridge capabilities even if meta claims hasConfigBridge
  const restrictedHandle = kernel.createPluginHandle(
    {
      pluginId: 'evil-addon',
      version: '1.0.0',
      trustLevel: 'restricted',
      hasConfigBridge: true,
      configScopes: [{ scopeId: 'antigravity:mcp-config', access: 'rw', maxBytes: 262144 }],
      uiSlots: [],
    },
    token
  );
  assert.equal(restrictedHandle.hasConfigBridge, false);
  await assert.rejects(() => restrictedHandle.readConfigScope('antigravity:mcp-config'), /ERR_CONFIG_BRIDGE_NOT_DECLARED/);

  // Undeclared scope & ro write are rejected in kernel
  await assert.rejects(() => trustedHandle.readConfigScope('unknown:scope'), /ERR_CONFIG_SCOPE_NOT_DECLARED/);
  await assert.rejects(
    () => trustedHandle.writeConfigScope('antigravity:mcp-config-legacy', { a: 1 }),
    /ERR_CONFIG_SCOPE_READ_ONLY/
  );

  // Read & deeply frozen return
  const snap = await trustedHandle.readConfigScope('antigravity:mcp-config');
  assert.equal(snap.ok, true);
  assert.equal(Object.isFrozen(snap), true);
  assert.equal(Object.isFrozen(snap.data.mcpServers), true);

  // Primordial tamper immunity: poison JSON.stringify and Object.prototype.expectedSha256
  const origStringify = JSON.stringify;
  Object.defineProperty(Object.prototype, 'expectedSha256', {
    value: 'forged-from-proto',
    configurable: true,
    writable: true,
  });
  JSON.stringify = () => '{"hijacked":true}';
  try {
    const writeRes = await trustedHandle.writeConfigScope('antigravity:mcp-config', { mcpServers: {} }, {});
    assert.equal(writeRes.ok, true);
    const lastCall = calls[calls.length - 1];
    assert.equal(lastCall.rawJson, '{"mcpServers":{}}');
    assert.equal(Object.prototype.hasOwnProperty.call(lastCall.opts, 'expectedSha256'), false);
  } finally {
    JSON.stringify = origStringify;
    delete Object.prototype.expectedSha256;
  }

  // Proto-pollution key in object write rejected
  const protoPayload = JSON.parse('{"__proto__":{"polluted":true}}');
  await assert.rejects(
    () => trustedHandle.writeConfigScope('antigravity:mcp-config', protoPayload),
    /ERR_CONFIG_UNSAFE_PROTO_KEY/
  );

  // Dispose revokes handle
  trustedHandle.dispose();
  assert.throws(() => trustedHandle.readConfigScope('antigravity:mcp-config'), /ERR_PLUGIN_HANDLE_DISPOSED/);
});

test('v2.3.0 config-bridge.js CAS concurrency, raw recovery, backup rotation, lock contention, symlink/jail guards, and plugin-files scan', () => {
  const tmpDir = makeTmpDir('agy-v23-cfgbridge-');
  try {
    const configDir = path.join(tmpDir, '.gemini', 'config');
    const pluginsDir = path.join(configDir, 'plugins');
    const backupDir = path.join(configDir, '.mcp-manager-backups');
    const mcpPath = path.join(configDir, 'mcp_config.json');
    const legacyPath = path.join(tmpDir, '.gemini', 'antigravity', 'mcp_config.json');
    const reservedConfigJson = path.join(configDir, 'config.json');

    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(reservedConfigJson, '{"plugins":{}}\n', 'utf8');

    const bridge = createConfigBridge({
      configScopes: {
        'antigravity:mcp-config': {
          kind: 'file',
          access: 'rw',
          maxBytes: 262144,
          path: mcpPath,
          backupDir,
          maxBackups: 2,
          allowRawRecovery: true,
          ancestorSymlinkDepth: 2,
          staleLockMs: 50,
        },
        'antigravity:plugin-mcp-configs': {
          kind: 'plugin-files',
          access: 'ro',
          maxBytes: 262144,
          rootDir: pluginsDir,
          fileName: 'mcp_config.json',
          maxPlugins: 2,
          allowRawRecovery: true,
        },
        'antigravity:mcp-config-legacy': {
          kind: 'file',
          access: 'ro',
          maxBytes: 262144,
          path: legacyPath,
          allowRawRecovery: true,
          ancestorSymlinkDepth: 2,
        },
        'evil:reserved-test': {
          kind: 'file',
          access: 'rw',
          maxBytes: 262144,
          path: reservedConfigJson,
        },
      },
      reservedFilePaths: [reservedConfigJson],
    });

    const binding = {
      pluginId: 'mcp-manager',
      scopes: [
        { scopeId: 'antigravity:mcp-config', access: 'rw', maxBytes: 262144 },
        { scopeId: 'antigravity:plugin-mcp-configs', access: 'ro', maxBytes: 262144 },
        { scopeId: 'antigravity:mcp-config-legacy', access: 'ro', maxBytes: 262144 },
        { scopeId: 'evil:reserved-test', access: 'rw', maxBytes: 262144 },
      ],
    };

    // 1. Missing file read
    const missing = bridge.readScopeForPlugin('mcp-manager', binding, 'antigravity:mcp-config');
    assert.equal(missing.ok, true);
    assert.equal(missing.status, 'missing');
    assert.equal(missing.sha256, null);

    // 2. CAS create fails on wrong expectedSha256, succeeds on expectedSha256: null
    const badCreate = bridge.writeScopeForPlugin(
      'mcp-manager',
      binding,
      'antigravity:mcp-config',
      '{"mcpServers":{}}',
      { expectedSha256: 'deadbeef' }
    );
    assert.equal(badCreate.ok, false);
    assert.equal(badCreate.reason, 'ERR_CONFIG_CAS_CONFLICT');
    assert.equal(badCreate.currentSha256, null);

    const created = bridge.writeScopeForPlugin(
      'mcp-manager',
      binding,
      'antigravity:mcp-config',
      '{"mcpServers":{"s1":{"command":"node"}}}',
      { expectedSha256: null }
    );
    assert.equal(created.ok, true);
    assert.equal(created.backupFileName, null);
    const sha1 = created.snapshot.sha256;
    assert.equal(sha1.length, 64);

    // 3. Subsequent writes create rotating backups (maxBackups = 2)
    const w2 = bridge.writeScopeForPlugin(
      'mcp-manager',
      binding,
      'antigravity:mcp-config',
      '{"mcpServers":{"s2":{"command":"npx"}}}',
      { expectedSha256: sha1 }
    );
    assert.equal(w2.ok, true);
    assert.ok(w2.backupFileName && w2.backupFileName.endsWith('.bak'));

    const w3 = bridge.writeScopeForPlugin(
      'mcp-manager',
      binding,
      'antigravity:mcp-config',
      '{"mcpServers":{"s3":{"command":"uvx"}}}',
      { expectedSha256: w2.snapshot.sha256 }
    );
    assert.equal(w3.ok, true);

    const w4 = bridge.writeScopeForPlugin(
      'mcp-manager',
      binding,
      'antigravity:mcp-config',
      '{"mcpServers":{"s4":{"command":"python"}}}',
      { expectedSha256: w3.snapshot.sha256 }
    );
    assert.equal(w4.ok, true);
    const backupFiles = fs.readdirSync(backupDir).filter((n) => n.endsWith('.bak'));
    assert.equal(backupFiles.length, 2);

    // 4. Stale CAS rejected with current snapshot
    const staleWrite = bridge.writeScopeForPlugin(
      'mcp-manager',
      binding,
      'antigravity:mcp-config',
      '{"mcpServers":{}}',
      { expectedSha256: sha1 }
    );
    assert.equal(staleWrite.ok, false);
    assert.equal(staleWrite.reason, 'ERR_CONFIG_CAS_CONFLICT');
    assert.equal(staleWrite.currentSha256, w4.snapshot.sha256);

    // 5. Raw recovery on corrupt JSON + CAS repair
    fs.writeFileSync(mcpPath, '{ "mcpServers": broken ', 'utf8');
    const corruptSnap = bridge.readScopeForPlugin('mcp-manager', binding, 'antigravity:mcp-config');
    assert.equal(corruptSnap.ok, true);
    assert.equal(corruptSnap.status, 'corrupt');
    assert.equal(corruptSnap.reason, 'ERR_CONFIG_INVALID_JSON');
    assert.equal(corruptSnap.rawText, '{ "mcpServers": broken ');
    assert.equal(corruptSnap.sha256, sha256('{ "mcpServers": broken '));

    const repaired = bridge.writeScopeForPlugin(
      'mcp-manager',
      binding,
      'antigravity:mcp-config',
      '{"mcpServers":{"repaired":{"command":"node"}}}',
      { expectedSha256: corruptSnap.sha256 }
    );
    assert.equal(repaired.ok, true);
    assert.equal(repaired.snapshot.data.mcpServers.repaired.command, 'node');

    // 6. Reserved path blocked on both read & write
    const resRead = bridge.readScopeForPlugin('mcp-manager', binding, 'evil:reserved-test');
    assert.equal(resRead.ok, false);
    assert.equal(resRead.reason, 'ERR_CONFIG_RESERVED_PATH');
    const resWrite = bridge.writeScopeForPlugin('mcp-manager', binding, 'evil:reserved-test', '{}');
    assert.equal(resWrite.ok, false);
    assert.equal(resWrite.reason, 'ERR_CONFIG_RESERVED_PATH');

    // 7. Read-only scope write rejected
    const roWrite = bridge.writeScopeForPlugin('mcp-manager', binding, 'antigravity:mcp-config-legacy', '{}');
    assert.equal(roWrite.ok, false);
    assert.equal(roWrite.reason, 'ERR_CONFIG_SCOPE_READ_ONLY');

    // 8. plugin-files scan: valid, missing, corrupt, and maxPlugins truncation
    fs.mkdirSync(path.join(pluginsDir, 'p-alpha'), { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, 'p-alpha', 'mcp_config.json'), '{"mcpServers":{"a":{}}}\n', 'utf8');
    fs.mkdirSync(path.join(pluginsDir, 'p-beta'), { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, 'p-beta', 'mcp_config.json'), '{ bad json', 'utf8');
    fs.mkdirSync(path.join(pluginsDir, 'p-gamma'), { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, 'p-gamma', 'mcp_config.json'), '{"mcpServers":{"g":{}}}\n', 'utf8');

    const plugScan = bridge.readScopeForPlugin('mcp-manager', binding, 'antigravity:plugin-mcp-configs');
    assert.equal(plugScan.ok, true);
    assert.equal(plugScan.kind, 'plugin-files');
    assert.equal(plugScan.truncated, true);
    assert.equal(plugScan.items.length, 2);
    assert.equal(plugScan.items[0].pluginId, 'p-alpha');
    assert.equal(plugScan.items[0].status, 'ok');
    assert.equal(plugScan.items[1].pluginId, 'p-beta');
    assert.equal(plugScan.items[1].status, 'corrupt');
    assert.equal(plugScan.items[1].rawText, '{ bad json');

    // 9. Ancestor symlink/junction guard (real directory junction on Windows / symlink on POSIX)
    const realTargetDir = path.join(tmpDir, 'outside-real');
    fs.mkdirSync(realTargetDir, { recursive: true });
    fs.writeFileSync(path.join(realTargetDir, 'mcp_config.json'), '{"escaped":true}\n', 'utf8');
    const junctionDir = path.join(tmpDir, 'junction-config');
    fs.symlinkSync(realTargetDir, junctionDir, process.platform === 'win32' ? 'junction' : 'dir');
    const symBridge = createConfigBridge({
      configScopes: {
        'test:ancestor-sym': {
          kind: 'file',
          access: 'rw',
          maxBytes: 65536,
          path: path.join(junctionDir, 'mcp_config.json'),
          ancestorSymlinkDepth: 2,
        },
      },
    });
    const symBinding = {
      pluginId: 'mcp-manager',
      scopes: [{ scopeId: 'test:ancestor-sym', access: 'rw', maxBytes: 65536 }],
    };
    const symRead = symBridge.readScopeForPlugin('mcp-manager', symBinding, 'test:ancestor-sym');
    assert.equal(symRead.ok, false);
    assert.equal(symRead.reason, 'ERR_CONFIG_ANCESTOR_SYMLINK_FORBIDDEN');
    const symWrite = symBridge.writeScopeForPlugin('mcp-manager', symBinding, 'test:ancestor-sym', '{"a":1}');
    assert.equal(symWrite.ok, false);
    assert.equal(symWrite.reason, 'ERR_CONFIG_ANCESTOR_SYMLINK_FORBIDDEN');

    // 10. Stale advisory lockfile recovery
    const lockPath = path.join(configDir, '.mcp_config.json.addon-host.lock');
    fs.writeFileSync(lockPath, '99999:0\n', 'utf8');
    const past = new Date(Date.now() - 5000);
    fs.utimesSync(lockPath, past, past);
    const recoveredWrite = bridge.writeScopeForPlugin(
      'mcp-manager',
      binding,
      'antigravity:mcp-config',
      '{"mcpServers":{"afterStaleLock":{}}}',
      { expectedSha256: repaired.snapshot.sha256 }
    );
    assert.equal(recoveredWrite.ok, true);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('v2.3.0 Main IPC CONFIG_READ / CONFIG_WRITE enforces claimed origin and trusted plugin binding', async () => {
  const tmpDir = makeTmpDir('agy-v23-ipc-');
  try {
    const configDir = path.join(tmpDir, '.gemini', 'config');
    const hostDataDir = path.join(tmpDir, '.gemini', 'antigravity');
    const pluginsDir = path.join(configDir, 'plugins');
    const addonsDir = path.join(hostDataDir, 'addons.d');
    const mcpPath = path.join(configDir, 'mcp_config.json');
    const configJsonPath = path.join(configDir, 'config.json');
    const trustPolicyPath = path.join(hostDataDir, 'trust-policy.json');

    fs.mkdirSync(path.join(pluginsDir, 'mcp-manager', 'dist'), { recursive: true });
    fs.mkdirSync(addonsDir, { recursive: true });

    const rendererSrc = '/* mcp-manager renderer startup */\n';
    const rendererPath = path.join(pluginsDir, 'mcp-manager', 'dist', 'renderer.js');
    fs.writeFileSync(rendererPath, rendererSrc, 'utf8');
    fs.writeFileSync(configJsonPath, JSON.stringify({ plugins: { 'mcp-manager': { enabled: true } } }), 'utf8');
    fs.writeFileSync(
      trustPolicyPath,
      JSON.stringify({
        schemaVersion: 1,
        approved: {
          'mcp-manager': {
            approvedAt: new Date().toISOString(),
            rendererSha256: sha256(rendererSrc),
          },
        },
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(addonsDir, 'mcp-manager.json'),
      JSON.stringify(
        makeBaseManifest({
          pluginId: 'mcp-manager',
          configBridge: {
            scopes: [
              { scopeId: 'antigravity:mcp-config', access: 'rw' },
              { scopeId: 'antigravity:mcp-config-legacy', access: 'ro' },
            ],
          },
        })
      ),
      'utf8'
    );

    const paths = resolveAntigravityPaths({ HOME: tmpDir, USERPROFILE: tmpDir });
    const configScopes = resolveAntigravityConfigScopes(paths);

    const ipcHandlers = new Map();
    const ipcListeners = new Map();
    const mockIpcMain = {
      on(ch, fn) {
        ipcListeners.set(ch, fn);
      },
      handle(ch, fn) {
        ipcHandlers.set(ch, fn);
      },
      removeHandler(ch) {
        ipcHandlers.delete(ch);
      },
    };
    const defaultSession = { id: 'default' };
    const mockApp = {
      isReady: () => true,
      whenReady: () => Promise.resolve(),
      on() {},
    };

    const controller = createHostRuntimeController(
      {
        profile: ANTIGRAVITY_HOST_PROFILE,
        addonsDir,
        pluginsRootDir: pluginsDir,
        configJsonPath,
        trustPolicyPath,
        configScopes,
        kernelBundleSource: 'globalThis.__addonHostKernel = { boot: () => ({ ok: true, hasBridge: true }), stagePluginHandle: () => ({ ok: true, runNonce: "rn-1" }), consumeStagedHandle: () => ({ dispose() {} }), reportPluginError() {} };',
        hostVersion: '2.3.0',
      },
      {
        app: mockApp,
        session: { defaultSession },
        ipcMain: mockIpcMain,
      }
    );

    controller.start();
    assert.equal(controller.getConfigBridgeStatus().scopeCount, 3);

    const events = {};
    const mockWc = {
      id: 42,
      session: defaultSession,
      isDestroyed: () => false,
      getURL: () => 'https://127.0.0.1:4567/',
      mainFrame: { url: 'https://127.0.0.1:4567/', top: null },
      on(name, fn) {
        events[name] = fn;
      },
      once(name, fn) {
        events[name] = fn;
      },
      async executeJavaScriptInIsolatedWorld(_worldId, [{ code }]) {
        if (code.includes('.boot(')) return { ok: true, hasBridge: true };
        if (code.includes('.stagePluginHandle(')) return { ok: true, runNonce: 'rn-1' };
        return { ok: true };
      },
    };
    mockWc.mainFrame.top = mockWc.mainFrame;

    controller.attachWebContents(mockWc);

    // Verify frame & claim nonce to establish docGenId=1
    const verifyEv = { sender: mockWc, senderFrame: mockWc.mainFrame, returnValue: null };
    ipcListeners.get(IPC_CHANNELS.VERIFY_FRAME)(verifyEv);
    assert.equal(verifyEv.returnValue.ok, true);

    await controller.attachWebContents; // trigger sync via did-finish-load
    const syncDone = new Promise((r) => setTimeout(r, 40));
    events['did-finish-load']();
    await syncDone;

    // Wait for kernel boot to rotate generation & grab nonce from originResolver? Better: claim via captured boot code
    let capturedNonce = null;
    mockWc.executeJavaScriptInIsolatedWorld = async (_w, [{ code }]) => {
      const m = code.match(/"claimNonce":"([^"]+)"/);
      if (m) capturedNonce = m[1];
      if (code.includes('.boot(')) return { ok: true, hasBridge: true };
      if (code.includes('.stagePluginHandle(')) return { ok: true, runNonce: 'rn-2' };
      return { ok: true };
    };
    events['did-navigate']({}, 'https://127.0.0.1:4567/app');
    events['did-finish-load']();
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(capturedNonce && capturedNonce.length >= 16);

    const claimEv = { sender: mockWc, senderFrame: mockWc.mainFrame, returnValue: null };
    ipcListeners.get(IPC_CHANNELS.CLAIM_NONCE)(claimEv, capturedNonce);
    assert.equal(claimEv.returnValue.ok, true);
    const docGenId = claimEv.returnValue.docGenId;

    const readHandler = ipcHandlers.get(IPC_CHANNELS.CONFIG_READ);
    const writeHandler = ipcHandlers.get(IPC_CHANNELS.CONFIG_WRITE);

    // Spoofed pluginId rejected
    const spoofed = await readHandler(
      { sender: mockWc, senderFrame: mockWc.mainFrame },
      { docGenId, pluginId: 'other-plugin', scopeId: 'antigravity:mcp-config' }
    );
    assert.equal(spoofed.ok, false);
    assert.equal(spoofed.reason, 'ERR_CONFIG_BRIDGE_NOT_BOUND');

    // Bound trusted mcp-manager reads missing mcp_config.json and CAS-creates it
    const r1 = await readHandler(
      { sender: mockWc, senderFrame: mockWc.mainFrame },
      { docGenId, pluginId: 'mcp-manager', scopeId: 'antigravity:mcp-config' }
    );
    assert.equal(r1.ok, true);
    assert.equal(r1.status, 'missing');

    const w1 = await writeHandler(
      { sender: mockWc, senderFrame: mockWc.mainFrame },
      {
        docGenId,
        pluginId: 'mcp-manager',
        scopeId: 'antigravity:mcp-config',
        rawJson: '{"mcpServers":{"ipcServer":{"command":"node"}}}',
        expectedSha256: null,
      }
    );
    assert.equal(w1.ok, true);
    assert.equal(fs.existsSync(mcpPath), true);

    // RO scope rejected on write
    const roRes = await writeHandler(
      { sender: mockWc, senderFrame: mockWc.mainFrame },
      {
        docGenId,
        pluginId: 'mcp-manager',
        scopeId: 'antigravity:mcp-config-legacy',
        rawJson: '{}',
      }
    );
    assert.equal(roRes.ok, false);
    assert.equal(roRes.reason, 'ERR_CONFIG_SCOPE_READ_ONLY');

    controller.dispose();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-V23-006: CLI --profile remote-web, --build-remote, and src/index.js integration wiring', () => {
  const { spawnSync } = require('node:child_process');
  const pkgIndex = require('../../src/index');

  assert.equal(pkgIndex.ANTIGRAVITY_REMOTE_WEB_PROFILE.id, 'antigravity-remote-web');
  assert.equal(typeof pkgIndex.toBrowserRemoteWebProfile, 'function');
  assert.equal(typeof pkgIndex.bootRemoteWebHost, 'function');
  assert.equal(typeof pkgIndex.collectRemoteWebAddons, 'function');

  const tmpDir = makeTmpDir();
  try {
    const configDir = path.join(tmpDir, '.gemini', 'config');
    const agyDir = path.join(tmpDir, '.gemini', 'antigravity');
    const pluginsRoot = path.join(configDir, 'plugins');
    const addonsDir = path.join(agyDir, 'addons.d');
    const remoteDistDir = path.join(agyDir, 'remote-dist');
    const pluginDir = path.join(pluginsRoot, 'desktop-compat-ui');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(addonsDir, { recursive: true });

    const rendererPath = path.join(pluginDir, 'renderer.js');
    fs.writeFileSync(rendererPath, 'void 0;\n', 'utf8');
    const mainHookPath = path.join(pluginDir, 'main-hook.js');
    fs.writeFileSync(mainHookPath, 'module.exports = {};\n', 'utf8');

    const manifest = makeBaseManifest({
      pluginId: 'desktop-compat-ui',
      trustLevel: 'trusted',
      capabilities: ['renderer', 'mainHook'],
      entry: { rendererScript: 'renderer.js', mainHookScript: 'main-hook.js' },
      compatibility: { hostProfile: 'antigravity-desktop', minHostVersion: '2.0.0' },
    });
    fs.writeFileSync(path.join(addonsDir, 'desktop-compat-ui.json'), JSON.stringify(manifest, null, 2), 'utf8');
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ plugins: { 'desktop-compat-ui': { enabled: true } } }),
      'utf8'
    );

    const env = {
      ...process.env,
      HOME: tmpDir,
      USERPROFILE: tmpDir,
      AGY_REMOTE_DIST_DIR: remoteDistDir,
    };

    const binPath = path.resolve(__dirname, '..', '..', 'bin', 'addon-host.js');

    // 1. --profile remote-web --status auto-includes desktop v2 renderer addon & skips mainHook
    const statusRes = spawnSync(process.execPath, [binPath, '--profile', 'remote-web', '--status'], {
      env,
      encoding: 'utf8',
    });
    assert.equal(statusRes.status, 0, statusRes.stderr);
    const statusJson = JSON.parse(statusRes.stdout);
    assert.equal(statusJson.hostVersion, '2.4.0');
    assert.equal(statusJson.hostProfileId, 'antigravity-remote-web');
    assert.equal(statusJson.hostStatus.mode, 'remote-web');
    assert.equal(statusJson.activeAddons.length, 1);
    assert.equal(statusJson.activeAddons[0].pluginId, 'desktop-compat-ui');

    // 2. --profile remote-web --install fails closed with ERR_REMOTE_WEB_USES_BUILD_REMOTE
    const installRes = spawnSync(process.execPath, [binPath, '--profile', 'remote-web', '--install'], {
      env,
      encoding: 'utf8',
    });
    assert.equal(installRes.status, 1);
    const installJson = JSON.parse(installRes.stdout);
    assert.equal(installJson.ok, false);
    assert.equal(installJson.reason, 'ERR_REMOTE_WEB_USES_BUILD_REMOTE');

    // 3. --build-remote --no-addons --check passes determinism & AST gate
    const buildRes = spawnSync(process.execPath, [binPath, '--build-remote', '--no-addons', '--check'], {
      env,
      encoding: 'utf8',
    });
    assert.equal(buildRes.status, 0, buildRes.stderr);
    const buildJson = JSON.parse(buildRes.stdout);
    assert.equal(buildJson.ok, true);
    assert.equal(buildJson.mode, 'check');
    assert.equal(buildJson.addonCount, 0);
    assert.equal(buildJson.astViolations, 0);

    // 4. F6 regression: corrupt build-manifest.json marks remote-web diagnoseHost unhealthy
    fs.mkdirSync(remoteDistDir, { recursive: true });
    fs.writeFileSync(path.join(remoteDistDir, 'build-manifest.json'), '{ corrupt json', 'utf8');
    const diagRes = spawnSync(process.execPath, [binPath, '--profile', 'remote-web', '--doctor'], {
      env,
      encoding: 'utf8',
    });
    assert.equal(diagRes.status, 0, diagRes.stderr);
    const diagJson = JSON.parse(diagRes.stdout);
    assert.equal(diagJson.host.manifestCorrupt, true);
    assert.equal(diagJson.host.healthy, false);
    assert.equal(diagJson.healthy, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-V23-007: F5 regressions — custom backupDir ancestor symlink blocked & ERR_CONFIG_WRITE_FAILED preserves currentSha256', () => {
  const tmpDir = makeTmpDir();
  try {
    const targetPath = path.join(tmpDir, 'mcp_config.json');
    fs.writeFileSync(targetPath, '{"mcpServers":{"init":{}}}\n', 'utf8');

    // 1. Ancestor symlink above custom backupDir is rejected
    const outsideReal = path.join(tmpDir, 'outside-backup-real');
    fs.mkdirSync(outsideReal, { recursive: true });
    const junctionParent = path.join(tmpDir, 'backup-junction');
    fs.symlinkSync(outsideReal, junctionParent, process.platform === 'win32' ? 'junction' : 'dir');
    const nestedBackupDir = path.join(junctionParent, 'nested-backups');

    const symBackupBridge = createConfigBridge({
      configScopes: {
        'test:backup-ancestor-sym': {
          kind: 'file',
          access: 'rw',
          maxBytes: 65536,
          path: targetPath,
          backupDir: nestedBackupDir,
          maxBackups: 3,
          ancestorSymlinkDepth: 3,
        },
      },
    });
    const binding = {
      pluginId: 'mcp-manager',
      scopes: [{ scopeId: 'test:backup-ancestor-sym', access: 'rw', maxBytes: 65536 }],
    };
    const symWrite = symBackupBridge.writeScopeForPlugin(
      'mcp-manager',
      binding,
      'test:backup-ancestor-sym',
      '{"mcpServers":{"updated":{}}}'
    );
    assert.equal(symWrite.ok, false);
    assert.equal(symWrite.reason, 'ERR_CONFIG_BACKUP_SYMLINK_FORBIDDEN');
    assert.equal(fs.existsSync(nestedBackupDir), false);

    // 2. ERR_CONFIG_WRITE_FAILED preserves currentSha256 & snapshot
    const failingFs = {
      ...fs,
      renameSync() {
        const err = new Error('Simulated EACCES on rename');
        err.code = 'EACCES';
        throw err;
      },
    };
    const failWriteBridge = createConfigBridge({
      configScopes: {
        'test:write-fail': {
          kind: 'file',
          access: 'rw',
          maxBytes: 65536,
          path: targetPath,
          ancestorSymlinkDepth: 2,
        },
      },
      fsImpl: failingFs,
    });
    const failBinding = {
      pluginId: 'mcp-manager',
      scopes: [{ scopeId: 'test:write-fail', access: 'rw', maxBytes: 65536 }],
    };
    const beforeSnap = failWriteBridge.readScopeForPlugin('mcp-manager', failBinding, 'test:write-fail');
    assert.equal(beforeSnap.ok, true);
    assert.ok(beforeSnap.sha256);

    const failRes = failWriteBridge.writeScopeForPlugin(
      'mcp-manager',
      failBinding,
      'test:write-fail',
      '{"mcpServers":{"next":{}}}',
      { expectedSha256: beforeSnap.sha256 }
    );
    assert.equal(failRes.ok, false);
    assert.equal(failRes.reason, 'ERR_CONFIG_WRITE_FAILED');
    assert.equal(failRes.currentSha256, beforeSnap.sha256);
    assert.equal(failRes.snapshot.sha256, beforeSnap.sha256);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
