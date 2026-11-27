'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const {
  checkAncestorSymlinks,
  readFileScopeSnapshot,
  readPluginFilesScopeSnapshot,
  writeFileScopeSnapshot,
  createConfigBridge,
} = require('../../src/runtime/main/config-bridge');
const { createHostRuntimeController } = require('../../src/runtime/main/init-main');
const { createRendererInjector } = require('../../src/runtime/main/renderer-injector');
const {
  readRemoteBridgeConfigFile,
  writeRemoteBridgeConfigFileAtomic,
  createRemoteBridgeServer,
} = require('../../src/runtime/main/remote-bridge-server');
const {
  createHostAdminService,
  isCommandOnPath,
  readHostCliMetaFile,
  readRemotePreferencesFile,
  isAddonEnabledInRemotePreferences,
  writeRemotePreferencesFileAtomic,
  readRemoteBundleStatus,
} = require('../../src/runtime/main/host-admin-service');
const { createSecretsVault } = require('../../src/runtime/main/secrets-vault');
const {
  createSettingsBridge,
  writeSettingsFileSnapshot,
} = require('../../src/runtime/main/settings-bridge');
const { createElectronHostLifecyclePort } = require('../../src/adapters/electron/electron-host-lifecycle-port');
const { createElectronTrustPolicyPort } = require('../../src/adapters/electron/trust-policy-store');
const { createPortalArbiter } = require('../../src/runtime/main/portal-arbiter');
const { createPreloadRegistrar } = require('../../src/runtime/main/preload-registrar');
const { isAllowedRendererUrl, createHostOriginResolver } = require('../../src/runtime/main/host-origin-resolver');
const {
  validateElectronHostProfile,
  assertValidElectronHostProfile,
  validateResolvedElectronPaths,
  assertValidResolvedElectronPaths,
} = require('../../src/adapters/electron/electron-host-profile-port');
const { createUpdateSurvivalHook } = require('../../src/runtime/main/update-survival-hook');
const {
  loadTrustPolicyFile,
  readVerifiedRendererScript,
  loadVerifiedMainHookModule,
  snapshotPluginBundleInMemory,
} = require('../../src/runtime/main/trust-verifier');
const {
  diagnoseAsarState,
  rollbackAsarAddonHost,
  upgradeAsarAddonHost,
} = require('../../src/adapters/electron/asar-patcher');
const { IPC_CHANNELS } = require('../../src/runtime/shared/constants');
const { ANTIGRAVITY_HOST_PROFILE } = require('../../src/profiles/antigravity');

test('TC-COV90-M01: config-bridge readFileScopeSnapshot, readPluginFilesScopeSnapshot, writeFileScopeSnapshot error/boundary paths', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extenra-cov90-cb-'));
  try {
    const validFile = path.join(tmpDir, 'valid.json');
    const arrayFile = path.join(tmpDir, 'array.json');
    const badJsonFile = path.join(tmpDir, 'bad.json');
    const bigFile = path.join(tmpDir, 'big.json');
    const subDir = path.join(tmpDir, 'subdir');
    const reservedFile = path.join(tmpDir, 'reserved.json');

    fs.writeFileSync(validFile, JSON.stringify({ k: 1 }), 'utf8');
    fs.writeFileSync(arrayFile, '[1, 2, 3]', 'utf8');
    fs.writeFileSync(badJsonFile, '{invalid', 'utf8');
    fs.writeFileSync(bigFile, '{"a":"' + 'x'.repeat(2048) + '"}', 'utf8');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(reservedFile, '{"secret":1}', 'utf8');

    const reservedKey = (process.platform === 'win32' ? reservedFile.toLowerCase() : reservedFile);
    const reservedKeys = new Set([reservedKey]);

    // readFileScopeSnapshot error & edge branches
    assert.equal(readFileScopeSnapshot('s1', { path: '' }, 4096).reason, 'ERR_CONFIG_SCOPE_PATH_MISSING');
    assert.equal(readFileScopeSnapshot('s1', { path: reservedFile }, 4096, { reservedKeys }).reason, 'ERR_CONFIG_RESERVED_PATH');
    assert.equal(readFileScopeSnapshot('s1', { path: path.join(tmpDir, 'missing.json') }, 4096).status, 'missing');
    assert.equal(readFileScopeSnapshot('s1', { path: subDir }, 4096).reason, 'ERR_CONFIG_NOT_REGULAR_FILE');
    assert.equal(readFileScopeSnapshot('s1', { path: bigFile }, 1024).ok, false);

    // Non-object JSON with allowRawRecovery true vs false
    const arrRec = readFileScopeSnapshot('s1', { path: arrayFile, allowRawRecovery: true }, 4096);
    assert.equal(arrRec.ok, true);
    assert.equal(arrRec.status, 'corrupt');
    assert.equal(arrRec.reason, 'ERR_CONFIG_MUST_BE_OBJECT');
    const arrStrict = readFileScopeSnapshot('s1', { path: arrayFile, allowRawRecovery: false }, 4096);
    assert.equal(arrStrict.ok, false);
    assert.equal(arrStrict.reason, 'ERR_CONFIG_MUST_BE_OBJECT');
    const badStrict = readFileScopeSnapshot('s1', { path: badJsonFile, allowRawRecovery: false }, 4096);
    assert.equal(badStrict.ok, false);
    assert.equal(badStrict.reason, 'ERR_CONFIG_INVALID_JSON');

    // Synthetic fsImpl faults: lstat EACCES, symlink target, realpath error, realpath escape
    const errStatFs = {
      ...fs,
      lstatSync(p) {
        if (path.resolve(p) === path.resolve(validFile)) {
          const e = new Error('EACCES');
          e.code = 'EACCES';
          throw e;
        }
        return fs.lstatSync(p);
      },
    };
    assert.equal(readFileScopeSnapshot('s1', { path: validFile }, 4096, { fsImpl: errStatFs }).reason, 'ERR_CONFIG_STAT_FAILED');

    const symlinkFs = {
      ...fs,
      lstatSync(p) {
        if (path.resolve(p) === path.resolve(validFile)) {
          return { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false, size: 10 };
        }
        return fs.lstatSync(p);
      },
    };
    assert.equal(readFileScopeSnapshot('s1', { path: validFile }, 4096, { fsImpl: symlinkFs }).reason, 'ERR_CONFIG_SYMLINK_FORBIDDEN');

    const badRealpathFs = {
      ...fs,
      realpathSync() {
        throw new Error('REALPATH_FAIL');
      },
    };
    assert.equal(readFileScopeSnapshot('s1', { path: validFile }, 4096, { fsImpl: badRealpathFs }).reason, 'ERR_CONFIG_REALPATH_FAILED');

    const escapeRealpathFs = {
      ...fs,
      realpathSync(p) {
        if (path.resolve(p) === path.resolve(validFile)) return path.join(os.tmpdir(), 'elsewhere', 'valid.json');
        return fs.realpathSync(p);
      },
    };
    assert.equal(readFileScopeSnapshot('s1', { path: validFile }, 4096, { fsImpl: escapeRealpathFs }).reason, 'ERR_CONFIG_REALPATH_ESCAPE');

    // Ancestor symlink check
    const ancSymFs = {
      ...fs,
      lstatSync() {
        return { isSymbolicLink: () => true, isDirectory: () => false };
      },
    };
    assert.equal(checkAncestorSymlinks(validFile, 2, ancSymFs).ok, false);
    assert.equal(readFileScopeSnapshot('s1', { path: validFile, ancestorSymlinkDepth: 2 }, 4096, { fsImpl: ancSymFs }).ok, false);

    // readPluginFilesScopeSnapshot edge cases
    assert.equal(readPluginFilesScopeSnapshot('pf', { rootDir: '', fileName: 'a.json' }, 4096).reason, 'ERR_CONFIG_SCOPE_INVALID');
    assert.equal(readPluginFilesScopeSnapshot('pf', { rootDir: tmpDir, fileName: '../a.json' }, 4096).reason, 'ERR_CONFIG_SCOPE_INVALID');
    assert.equal(readPluginFilesScopeSnapshot('pf', { rootDir: path.join(tmpDir, 'no-such-root'), fileName: 'a.json' }, 4096).status, 'missing');
    assert.equal(readPluginFilesScopeSnapshot('pf', { rootDir: validFile, fileName: 'a.json' }, 4096).ok, false);
    assert.equal(
      readPluginFilesScopeSnapshot('pf', { rootDir: tmpDir, fileName: 'a.json' }, 4096, {
        fsImpl: {
          ...fs,
          lstatSync() {
            const e = new Error('EPERM');
            e.code = 'EPERM';
            throw e;
          },
        },
      }).reason,
      'ERR_CONFIG_STAT_FAILED'
    );
    assert.equal(
      readPluginFilesScopeSnapshot('pf', { rootDir: tmpDir, fileName: 'a.json' }, 4096, {
        fsImpl: {
          ...fs,
          lstatSync() {
            return { isSymbolicLink: () => true, isDirectory: () => false };
          },
        },
      }).reason,
      'ERR_CONFIG_SYMLINK_FORBIDDEN'
    );

    const pluginsRoot = path.join(tmpDir, 'plugins');
    fs.mkdirSync(path.join(pluginsRoot, 'p-a'), { recursive: true });
    fs.mkdirSync(path.join(pluginsRoot, 'p-b'), { recursive: true });
    fs.mkdirSync(path.join(pluginsRoot, 'p-c'), { recursive: true });
    fs.writeFileSync(path.join(pluginsRoot, 'p-a', 'mcp.json'), JSON.stringify({ servers: { x: 1 } }), 'utf8');
    fs.writeFileSync(path.join(pluginsRoot, 'p-b', 'mcp.json'), '{bad', 'utf8');
    fs.writeFileSync(path.join(pluginsRoot, 'p-c', 'mcp.json'), JSON.stringify({ servers: { z: 3 } }), 'utf8');
    const pfTrunc = readPluginFilesScopeSnapshot('pf', { rootDir: pluginsRoot, fileName: 'mcp.json', maxPlugins: 2 }, 4096);
    assert.equal(pfTrunc.ok, true);
    assert.equal(pfTrunc.truncated, true);
    assert.equal(pfTrunc.items.length, 2);

    // Custom fsImpl error branches in readPluginFilesScopeSnapshot (lines 507-677)
    const pfRootRes = path.resolve(pluginsRoot);
    assert.equal(
      readPluginFilesScopeSnapshot('pf', { rootDir: pluginsRoot, fileName: 'mcp.json' }, 4096, {
        fsImpl: { ...fs, realpathSync: () => { throw new Error('EACCES'); } },
      }).reason,
      'ERR_CONFIG_REALPATH_FAILED'
    );
    assert.equal(
      readPluginFilesScopeSnapshot('pf', { rootDir: pluginsRoot, fileName: 'mcp.json' }, 4096, {
        fsImpl: { ...fs, readdirSync: () => { throw new Error('EIO'); } },
      }).reason,
      'ERR_CONFIG_READ_FAILED'
    );
    const mockEntries = ['sym-dir', 'esc-dir', 'res-dir', 'stat-err', 'sym-file', 'dir-as-file', 'rp-fail', 'rp-esc', 'big-file'];
    const reservedPfKey = (process.platform === 'win32'
      ? path.join(pfRootRes, 'res-dir', 'mcp.json').toLowerCase()
      : path.join(pfRootRes, 'res-dir', 'mcp.json'));
    const fakeDirStat = { isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false };
    const fakeSymStat = { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false };
    const fakeFileStat = (size = 10) => ({ isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true, size });
    const mockFs = {
      lstatSync(p) {
        if (p === pfRootRes) return fakeDirStat;
        if (p.endsWith('sym-dir')) return fakeSymStat;
        if (p.endsWith('stat-err' + path.sep + 'mcp.json')) {
          const e = new Error('EPERM'); e.code = 'EPERM'; throw e;
        }
        if (p.endsWith('sym-file' + path.sep + 'mcp.json')) return fakeSymStat;
        if (p.endsWith('dir-as-file' + path.sep + 'mcp.json')) return fakeDirStat;
        if (p.endsWith('big-file' + path.sep + 'mcp.json')) return fakeFileStat(999999);
        if (p.endsWith('mcp.json')) return fakeFileStat(10);
        return fakeDirStat;
      },
      realpathSync(p) {
        if (p === pfRootRes) return pfRootRes;
        if (p.endsWith('esc-dir')) return path.resolve(os.tmpdir(), 'escaped-elsewhere');
        if (p.endsWith('rp-fail' + path.sep + 'mcp.json')) throw new Error('RP_FAIL');
        if (p.endsWith('rp-esc' + path.sep + 'mcp.json')) return path.resolve(os.tmpdir(), 'escaped.json');
        return p;
      },
      readdirSync: () => mockEntries,
      openSync: () => { throw new Error('READ_FAIL'); },
      fstatSync: () => fakeFileStat(999999),
      readSync: () => 0,
      closeSync: () => {},
    };
    const mockSnap = readPluginFilesScopeSnapshot('pf', { rootDir: pluginsRoot, fileName: 'mcp.json', maxPlugins: 20 }, 1024, {
      fsImpl: mockFs,
      reservedKeys: new Set([reservedPfKey]),
    });
    assert.equal(mockSnap.ok, true);
    const reasons = new Set(mockSnap.items.map((it) => it.reason));
    assert.ok(reasons.has('ERR_CONFIG_SYMLINK_FORBIDDEN'));
    assert.ok(reasons.has('ERR_CONFIG_REALPATH_ESCAPE'));
    assert.ok(reasons.has('ERR_CONFIG_RESERVED_PATH'));
    assert.ok(reasons.has('ERR_CONFIG_STAT_FAILED'));
    assert.ok(reasons.has('ERR_CONFIG_NOT_REGULAR_FILE'));
    assert.ok(reasons.has('ERR_CONFIG_REALPATH_FAILED'));

    // writeFileScopeSnapshot edge & error branches
    assert.equal(writeFileScopeSnapshot('s1', { path: '' }, 4096, '{}').ok, false);
    assert.equal(writeFileScopeSnapshot('s1', { path: reservedFile }, 4096, '{}', {}, { reservedKeys }).reason, 'ERR_CONFIG_RESERVED_PATH');
    assert.equal(writeFileScopeSnapshot('s1', { path: validFile }, 4096, '{bad').ok, false);
    assert.equal(writeFileScopeSnapshot('s1', { path: validFile }, 4096, '[1,2]').ok, false);
    assert.equal(writeFileScopeSnapshot('s1', { path: validFile }, 4096, '{"__proto__":{"a":1}}').ok, false);
    assert.equal(writeFileScopeSnapshot('s1', { path: validFile }, 10, '{"big":"' + 'z'.repeat(100) + '"}').ok, false);
    assert.equal(writeFileScopeSnapshot('s1', { path: validFile }, 4096, '{"k":2}', { expectedSha256: 'wrong-sha' }).ok, false);

    // Valid write with backup rotation (multiple writes)
    const rotFile = path.join(tmpDir, 'nested', 'rot.json');
    const w1 = writeFileScopeSnapshot('s1', { path: rotFile, maxBackups: 2 }, 4096, '{"v":1}');
    assert.equal(w1.ok, true);
    const w2 = writeFileScopeSnapshot('s1', { path: rotFile, maxBackups: 2 }, 4096, '{"v":2}', { expectedSha256: w1.currentSha256 });
    assert.equal(w2.ok, true);
    const w3 = writeFileScopeSnapshot('s1', { path: rotFile, maxBackups: 2 }, 4096, '{"v":3}', { expectedSha256: w2.currentSha256 });
    assert.equal(w3.ok, true);
    const w4 = writeFileScopeSnapshot('s1', { path: rotFile, maxBackups: 2 }, 4096, '{"v":4}', { expectedSha256: w3.currentSha256 });
    assert.equal(w4.ok, true);

    // createConfigBridge plugin-files scope read
    const cb = createConfigBridge({
      configScopes: {
        pluginMcps: { kind: 'plugin-files', access: 'ro', rootDir: pluginsRoot, fileName: 'mcp.json', maxBytes: 4096 },
      },
    });
    const rPf = cb.readScopeForPlugin('p1', { scopes: [{ scopeId: 'pluginMcps', access: 'ro', maxBytes: 4096 }] }, 'pluginMcps');
    assert.equal(rPf.ok, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-COV90-M02: init-main IPC handlers, dynamic net settings extraction, and renderer-injector full lifecycle/error paths', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extenra-cov90-init-'));
  try {
    const addonsDir = path.join(tmpDir, 'addons.d');
    const pluginsRoot = path.join(tmpDir, 'plugins');
    const pluginDir = path.join(pluginsRoot, 'cov-plugin');
    const dataDir = path.join(tmpDir, 'data');
    const scopeFile = path.join(tmpDir, 'mcp-scope.json');
    fs.mkdirSync(addonsDir, { recursive: true });
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(scopeFile, JSON.stringify({ servers: {} }), 'utf8');

    const rendererCode = 'module.exports = function(ctx){ return true; };\n';
    const rendererPath = path.join(pluginDir, 'renderer.js');
    fs.writeFileSync(rendererPath, rendererCode, 'utf8');
    const rendererSha = crypto.createHash('sha256').update(rendererCode).digest('hex');

    const manifest = {
      schemaVersion: 3,
      pluginId: 'cov-plugin',
      displayName: 'Cov Plugin',
      version: '1.0.0',
      trustLevel: 'trusted',
      compatibility: { minHostVersion: '3.0.0' },
      capabilities: ['renderer'],
      entry: { rendererScript: 'renderer.js' },
      settingsBridge: { fileName: 'cov-plugin-settings.json', maxBytes: 65536 },
      permissions: {
        configBridge: { scopes: [{ scopeId: 'antigravity:mcp', access: 'rw', maxBytes: 65536 }] },
        secrets: { maxKeys: 8, maxBytes: 4096, allowRead: true },
        net: {
          httpsHosts: ['api.example.com'],
          userApprovedHttps: true,
          localLoopback: ['antigravity-sidecar'],
        },
      },
    };
    fs.writeFileSync(path.join(addonsDir, 'cov-plugin.json'), JSON.stringify(manifest), 'utf8');
    fs.writeFileSync(
      path.join(tmpDir, 'trust-policy.json'),
      JSON.stringify({
        schemaVersion: 1,
        approved: {
          'cov-plugin': {
            version: '1.0.0',
            rendererSha256: rendererSha,
            mainHookBundleSha256: null,
          },
        },
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(dataDir, 'cov-plugin-settings.json'),
      JSON.stringify({
        sidecarPort: 18101,
        loopbackPort: 18102,
        port: 18103,
        baseUrl: 'http://127.0.0.1:18104',
        sidecarUrl: 'https://localhost:18105',
        sidecar: { port: 18106, baseUrl: 'http://[::1]:18107' },
        cloudApiConfig: { baseUrl: 'https://cloud.example.com/v1' },
        llmConfig: { allowRemoteHttps: true, baseUrl: 'https://llm.example.com/v1' },
        approvedHttpsHosts: ['extra.example.com', 'https://url.example.com/path', 'http://bad.example.com', ''],
      }),
      'utf8'
    );

    const appListeners = new Map();
    const fakeApp = {
      isReady: () => true,
      whenReady: () => Promise.resolve(),
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
    const defaultSess = {
      id: 'default-sess',
      registerPreloadScript() {},
      setPreloads() {},
      getPreloads: () => [],
    };
    const fakeSession = { defaultSession: defaultSess };
    const fakeSafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('enc:' + s, 'utf8'),
      decryptString: (b) => b.toString('utf8').replace(/^enc:/, ''),
    };

    const ctrl = createHostRuntimeController(
      {
        profile: {
          ...ANTIGRAVITY_HOST_PROFILE,
          windowOrigin: 'https://app.example.com',
          strictWindowOrigin: false,
          allowedUrlProtocols: ['https:'],
          allowedUrlHosts: ['app.example.com'],
          supportedCapabilities: ['renderer'],
        },
        addonsDir,
        pluginsRootDir: pluginsRoot,
        settingsDataDir: dataDir,
        trustPolicyPath: path.join(tmpDir, 'trust-policy.json'),
        configJsonPath: path.join(tmpDir, 'config.json'),
        configScopes: {
          'antigravity:mcp': { kind: 'file', access: 'rw', path: scopeFile, maxBytes: 65536 },
        },
        kernelBundleSource: 'globalThis.__addonHostKernel = { boot:()=>({ok:true}), stagePluginHandle:()=>({runNonce:"rn-1-test"}), clearStagedHandle:()=>{}, disposePlugin:()=>{}, pushPluginSettings:()=>{} };',
      },
      { app: fakeApp, ipcMain: fakeIpc, session: fakeSession, electron: { app: fakeApp, ipcMain: fakeIpc, session: fakeSession, safeStorage: fakeSafeStorage } }
    );
    ctrl.start();

    // Create mock webContents and attach
    const wcListeners = new Map();
    let capturedClaimNonce = null;
    const fakeWc = {
      id: 101,
      session: defaultSess,
      mainFrame: { url: 'https://app.example.com/', origin: 'https://app.example.com', frameTreeNodeId: 1, parent: null },
      isDestroyed: () => false,
      getURL: () => 'https://app.example.com/',
      on(ev, fn) {
        if (!wcListeners.has(ev)) wcListeners.set(ev, []);
        wcListeners.get(ev).push(fn);
      },
      once(ev, fn) {
        this.on(ev, fn);
      },
      executeJavaScriptInIsolatedWorld: async (_worldId, scripts) => {
        const code = scripts && scripts[0] && scripts[0].code ? scripts[0].code : '';
        const nm = /"claimNonce":"([^"]+)"/.exec(code);
        if (nm) capturedClaimNonce = nm[1];
        if (code.includes('stagePluginHandle')) return { ok: true, runNonce: 'rn-1-abc' };
        return { ok: true };
      },
    };
    ctrl.attachWebContents(fakeWc);

    // Trigger dom-ready -> boots kernel & injects cov-plugin
    for (const fn of wcListeners.get('dom-ready') || []) fn();
    await new Promise((r) => setTimeout(r, 80));

    // Verify frame & claim nonce via IPC listeners
    const verifyFn = fakeIpc.listeners.get(IPC_CHANNELS.VERIFY_FRAME);
    const verifyEv = { sender: fakeWc, senderFrame: fakeWc.mainFrame, returnValue: null };
    verifyFn(verifyEv);
    assert.equal(verifyEv.returnValue.ok, true);
    const claimedDocGenId = verifyEv.returnValue.docGenId;
    if (capturedClaimNonce) {
      const claimFn = fakeIpc.listeners.get(IPC_CHANNELS.CLAIM_NONCE);
      const claimEv = { sender: fakeWc, senderFrame: fakeWc.mainFrame, returnValue: null };
      claimFn(claimEv, capturedClaimNonce);
      assert.equal(claimEv.returnValue.ok, true);

      // Exercise ALL claimed IPC handlers (secrets, config, settings, netFetch dynamic extractors, hostAdmin, portal, ping, reportError)
      const okEv = { sender: fakeWc, senderFrame: fakeWc.mainFrame };
      assert.equal((await fakeIpc.handlers.get(IPC_CHANNELS.PING)(okEv, { docGenId: claimedDocGenId })).ok, true);
      assert.equal((await fakeIpc.handlers.get(IPC_CHANNELS.PORTAL_CLAIM)(okEv, { docGenId: claimedDocGenId, claimId: 'c1', active: true })).ok, true);
      assert.equal((await fakeIpc.handlers.get(IPC_CHANNELS.PORTAL_CLAIM)(okEv, { docGenId: claimedDocGenId, claimId: 'c1', active: false })).ok, true);
      await fakeIpc.handlers.get(IPC_CHANNELS.SAVE_SETTINGS)(okEv, { docGenId: claimedDocGenId, pluginId: 'cov-plugin', rawJson: JSON.stringify({
        sidecarPort: 18101, loopbackPort: 18102, port: 18103,
        baseUrl: 'http://127.0.0.1:18104', sidecarUrl: 'http://localhost:18105',
        sidecar: { port: 18106, baseUrl: 'http://127.0.0.1:18107' },
        cloudApiConfig: { baseUrl: 'https://cloud.example.com/v1' },
        llmConfig: { allowRemoteHttps: true, baseUrl: 'https://llm.example.com/v1' },
        approvedHttpsHosts: ['https://approved1.example.com', 'approved2.example.com', ''],
      }) });
      await fakeIpc.handlers.get(IPC_CHANNELS.CONFIG_READ)(okEv, { docGenId: claimedDocGenId, pluginId: 'cov-plugin', scopeId: 'antigravity:mcp' });
      await fakeIpc.handlers.get(IPC_CHANNELS.CONFIG_WRITE)(okEv, { docGenId: claimedDocGenId, pluginId: 'cov-plugin', scopeId: 'antigravity:mcp', rawJson: '{"mcpServers":{"a":1}}' });
      await fakeIpc.handlers.get(IPC_CHANNELS.HOST_ADMIN_STATE)(okEv, { docGenId: claimedDocGenId });
      await fakeIpc.handlers.get(IPC_CHANNELS.HOST_ADMIN_SET_REMOTE_PREF)(okEv, { docGenId: claimedDocGenId, pluginId: 'cov-plugin', enabled: true });
      await fakeIpc.handlers.get(IPC_CHANNELS.HOST_ADMIN_CONFIGURE_REMOTE_BRIDGE)(okEv, { docGenId: claimedDocGenId, enabled: false });
      await fakeIpc.handlers.get(IPC_CHANNELS.HOST_ADMIN_ROTATE_REMOTE_TOKEN)(okEv, { docGenId: claimedDocGenId });
      await fakeIpc.handlers.get(IPC_CHANNELS.SECRETS_SET)(okEv, { docGenId: claimedDocGenId, pluginId: 'cov-plugin', key: 'k1', value: 'v1' });
      await fakeIpc.handlers.get(IPC_CHANNELS.SECRETS_GET)(okEv, { docGenId: claimedDocGenId, pluginId: 'cov-plugin', key: 'k1' });
      await fakeIpc.handlers.get(IPC_CHANNELS.SECRETS_HAS)(okEv, { docGenId: claimedDocGenId, pluginId: 'cov-plugin', key: 'k1' });
      await fakeIpc.handlers.get(IPC_CHANNELS.SECRETS_LIST)(okEv, { docGenId: claimedDocGenId, pluginId: 'cov-plugin' });
      await fakeIpc.handlers.get(IPC_CHANNELS.SECRETS_DELETE)(okEv, { docGenId: claimedDocGenId, pluginId: 'cov-plugin', key: 'k1' });
      // Undeclared plugin checks on claimed event
      assert.equal((await fakeIpc.handlers.get(IPC_CHANNELS.SECRETS_SET)(okEv, { docGenId: claimedDocGenId, pluginId: 'other', key: 'k1', value: 'v1' })).reason, 'ERR_SECRETS_NOT_DECLARED');
      assert.equal((await fakeIpc.handlers.get(IPC_CHANNELS.SECRETS_GET)(okEv, { docGenId: claimedDocGenId, pluginId: 'other', key: 'k1' })).reason, 'ERR_SECRETS_NOT_DECLARED');
      assert.equal((await fakeIpc.handlers.get(IPC_CHANNELS.SECRETS_HAS)(okEv, { docGenId: claimedDocGenId, pluginId: 'other', key: 'k1' })).reason, 'ERR_SECRETS_NOT_DECLARED');
      assert.equal((await fakeIpc.handlers.get(IPC_CHANNELS.SECRETS_DELETE)(okEv, { docGenId: claimedDocGenId, pluginId: 'other', key: 'k1' })).reason, 'ERR_SECRETS_NOT_DECLARED');
      assert.equal((await fakeIpc.handlers.get(IPC_CHANNELS.SECRETS_LIST)(okEv, { docGenId: claimedDocGenId, pluginId: 'other' })).reason, 'ERR_SECRETS_NOT_DECLARED');
      assert.equal((await fakeIpc.handlers.get(IPC_CHANNELS.NET_FETCH)(okEv, { docGenId: claimedDocGenId, pluginId: 'other', url: 'https://api.example.com' })).reason, 'ERR_NET_NOT_DECLARED');
      // NET_FETCH triggers dynamic loopback port + dynamic HTTPS host extractors + resolvePluginSecret!
      await fakeIpc.handlers.get(IPC_CHANNELS.SECRETS_SET)(okEv, { docGenId: claimedDocGenId, pluginId: 'cov-plugin', key: 'tok1', value: 'secret-val' });
      const loopSrv = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('loop-ok'); });
      await new Promise((r) => loopSrv.listen(0, '127.0.0.1', r));
      const loopPort = loopSrv.address().port;
      try {
        await fakeIpc.handlers.get(IPC_CHANNELS.SAVE_SETTINGS)(okEv, {
          docGenId: claimedDocGenId,
          pluginId: 'cov-plugin',
          rawJson: JSON.stringify({
            sidecarPort: loopPort,
            loopbackPort: 18102,
            port: 18103,
            baseUrl: 'http://127.0.0.1:18104',
            sidecarUrl: 'http://localhost:18105',
            sidecar: { port: 18106, baseUrl: 'http://127.0.0.1:18107' },
            cloudApiConfig: { baseUrl: 'https://cloud.example.com/v1' },
            llmConfig: { allowRemoteHttps: true, baseUrl: 'https://llm.example.com/v1' },
            approvedHttpsHosts: ['https://approved1.example.com', 'approved2.example.com', 'bad://x', ''],
          }),
        });
        const loopRes = await fakeIpc.handlers.get(IPC_CHANNELS.NET_FETCH)(okEv, {
          docGenId: claimedDocGenId,
          pluginId: 'cov-plugin',
          url: `http://127.0.0.1:${loopPort}/ping`,
          secretHeaders: { 'X-Api-Key': { secretKey: 'tok1', prefix: 'Bearer ' } },
          timeoutMs: 1000,
        });
        assert.equal(loopRes.ok, true, JSON.stringify(loopRes));
        assert.equal(loopRes.status, 200);
        // Trigger resolveDynamicHttpsHosts path
        await fakeIpc.handlers.get(IPC_CHANNELS.NET_FETCH)(okEv, {
          docGenId: claimedDocGenId,
          pluginId: 'cov-plugin',
          url: 'https://not-allowed.example.invalid/x',
          timeoutMs: 200,
        });
      } finally {
        await new Promise((r) => loopSrv.close(r));
      }
      const errFn = fakeIpc.listeners.get(IPC_CHANNELS.REPORT_ERROR);
      if (errFn) errFn(okEv, { docGenId: claimedDocGenId, pluginId: 'cov-plugin', detail: 'test-err' });
    }

    // Invalid payload / unverified checks across all IPC handlers
    const badEv = { sender: { id: 999 }, senderFrame: null };
    for (const ch of [
      IPC_CHANNELS.PORTAL_CLAIM,
      IPC_CHANNELS.SAVE_SETTINGS,
      IPC_CHANNELS.CONFIG_READ,
      IPC_CHANNELS.CONFIG_WRITE,
      IPC_CHANNELS.HOST_ADMIN_STATE,
      IPC_CHANNELS.HOST_ADMIN_SET_REMOTE_PREF,
      IPC_CHANNELS.HOST_ADMIN_CONFIGURE_REMOTE_BRIDGE,
      IPC_CHANNELS.HOST_ADMIN_ROTATE_REMOTE_TOKEN,
      IPC_CHANNELS.HOST_ADMIN_REBUILD_REMOTE_BUNDLE,
      IPC_CHANNELS.NET_FETCH,
      IPC_CHANNELS.SECRETS_SET,
      IPC_CHANNELS.SECRETS_GET,
      IPC_CHANNELS.SECRETS_HAS,
      IPC_CHANNELS.SECRETS_DELETE,
      IPC_CHANNELS.SECRETS_LIST,
      IPC_CHANNELS.PING,
    ]) {
      const h = fakeIpc.handlers.get(ch);
      assert.ok(h, `IPC handler missing: ${ch}`);
      const r1 = await h(badEv, null);
      assert.equal(r1.ok, false);
      const r2 = await h(badEv, { docGenId: 999, pluginId: 'cov-plugin', url: 'https://api.example.com', scopeId: 'mcp', key: 'k' });
      assert.equal(r2.ok, false);
    }

    // Issue & claim nonce for fakeWc via did-navigate -> verify-frame -> claim-nonce?
    // Even cleaner: exercise renderer-injector directly for exec fail/throw, pushSettingsUpdate, render-process-gone, destroyed!
    const diags = [];
    let failMode = 'ok';
    const fakeOrigin = {
      isSessionAllowed: () => true,
      isAllowedUrl: (u) => String(u).startsWith('https://app.example.com'),
      getState: () => ({ docGenId: 5, pinnedUrl: 'https://app.example.com/', nonce: '0123456789abcdef0123' }),
      rotateGeneration: (_id, u) => ({ docGenId: 5, pinnedUrl: u, nonce: '0123456789abcdef0123' }),
      clearWebContents: () => {},
    };
    const fakeSettings = {
      syncPluginBindings: () => {},
      readSnapshotForPlugin: () => ({ status: 'ok', sha256: failMode === 'catchup' ? 'sha-2' : 'sha-1', data: { v: 1 } }),
    };
    const inj = createRendererInjector({
      worldId: 998,
      originResolver: fakeOrigin,
      kernelBundleSource: () => '/*kernel*/',
      planProvider: () => ({
        active: [
          {
            pluginId: 'cov-plugin',
            manifest: { ...manifest, configBridge: manifest.permissions.configBridge },
            resolvedEntries: { rendererScript: rendererPath },
          },
        ],
      }),
      policyProvider: () => ({
        schemaVersion: 1,
        approved: { 'cov-plugin': { version: '1.0.0', rendererSha256: rendererSha, mainHookBundleSha256: null } },
      }),
      settingsBridge: fakeSettings,
      recordDiag: (lvl, code) => diags.push({ lvl, code }),
    });

    const wc2Listeners = new Map();
    const wc2 = {
      id: 202,
      on(ev, fn) {
        if (!wc2Listeners.has(ev)) wc2Listeners.set(ev, []);
        wc2Listeners.get(ev).push(fn);
      },
      once(ev, fn) {
        this.on(ev, fn);
      },
      isDestroyed: () => false,
      getURL: () => 'https://app.example.com/',
      executeJavaScriptInIsolatedWorld: async (_w, scripts) => {
        const code = scripts && scripts[0] && scripts[0].code ? scripts[0].code : '';
        if (code.includes('stagePluginHandle')) return { ok: true, runNonce: 'rn-202' };
        if (code.includes('pushPluginSettings') && failMode === 'push-err') throw new Error('PUSH_FAIL');
        if (code.includes('cov-plugin') && failMode === 'exec-fail') return { ok: false, error: 'SYNTAX_BOOM' };
        if (code.includes('cov-plugin') && failMode === 'exec-throw') throw new Error('EXEC_THROW');
        if (code.includes('cov-plugin') && failMode === 'catchup') {
          return { ok: true };
        }
        return { ok: true };
      },
    };
    inj.attachWebContents(wc2);
    await inj.scheduleSync(wc2);
    assert.ok(inj.getTrustedSettingsBinding(202, 'cov-plugin'));
    assert.ok(inj.getTrustedConfigBinding(202, 'cov-plugin'));
    assert.ok(inj.getTrustedSecretsBinding(202, 'cov-plugin'));
    assert.ok(inj.getPluginNetBinding(202, 'cov-plugin'));
    assert.equal(inj.getTrustedSettingsBinding(202, ''), null);
    assert.equal(inj.getTrustedConfigBinding(999, 'cov-plugin'), null);
    assert.equal(inj.getTrustedSecretsBinding(999, 'cov-plugin'), null);
    assert.equal(inj.getPluginNetBinding(999, 'cov-plugin'), null);

    // pushSettingsUpdate success & error path
    await inj.pushSettingsUpdate('cov-plugin', { status: 'ok', sha256: 'sha-new', data: { v: 2 } });
    failMode = 'push-err';
    await inj.pushSettingsUpdate('cov-plugin', { status: 'ok', sha256: 'sha-err', data: { v: 3 } });

    // render-process-gone clears state; re-sync under exec-fail and exec-throw
    for (const fn of wc2Listeners.get('render-process-gone') || []) fn();
    assert.equal(inj.getTrustedSettingsBinding(202, 'cov-plugin'), null);
    failMode = 'exec-fail';
    await inj.scheduleSync(wc2);
    assert.ok(inj.collectRendererErrors().length >= 1);

    for (const fn of wc2Listeners.get('did-navigate') || []) fn({}, 'https://app.example.com/');
    failMode = 'exec-throw';
    await inj.scheduleSync(wc2);

    // did-start-navigation, did-finish-load, did-navigate-in-page, destroyed
    for (const fn of wc2Listeners.get('did-start-navigation') || []) fn({}, 'https://app.example.com/next', false, true);
    for (const fn of wc2Listeners.get('did-finish-load') || []) fn();
    for (const fn of wc2Listeners.get('did-navigate-in-page') || []) fn();
    for (const fn of wc2Listeners.get('destroyed') || []) fn();
    await new Promise((r) => setTimeout(r, 40));

    await ctrl.dispose();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-COV90-M03: remote-bridge-server, host-admin-service, secrets-vault, and settings-bridge error & recovery paths', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extenra-cov90-m03-'));
  try {
    // 1. remote-bridge-server config read/write edge cases
    assert.equal(readRemoteBridgeConfigFile('').exists, false);
    assert.equal(readRemoteBridgeConfigFile(path.join(tmpDir, 'nope.json')).exists, false);
    const dirAsCfg = path.join(tmpDir, 'cfg-dir');
    fs.mkdirSync(dirAsCfg, { recursive: true });
    assert.equal(readRemoteBridgeConfigFile(dirAsCfg).error, 'ERR_REMOTE_BRIDGE_CONFIG_SYMLINK_OR_NON_FILE');
    assert.equal(writeRemoteBridgeConfigFileAtomic('', {}).reason, 'ERR_REMOTE_BRIDGE_CONFIG_PATH_MISSING');
    assert.equal(writeRemoteBridgeConfigFileAtomic(dirAsCfg, {}).reason, 'ERR_REMOTE_BRIDGE_CONFIG_SYMLINK_OR_NON_FILE');

    const badRootCfg = path.join(tmpDir, 'bad-root.json');
    fs.writeFileSync(badRootCfg, '[1,2]', 'utf8');
    assert.equal(readRemoteBridgeConfigFile(badRootCfg).error, 'ERR_REMOTE_BRIDGE_CONFIG_INVALID_ROOT');
    const hugeCfg = path.join(tmpDir, 'huge.json');
    fs.writeFileSync(hugeCfg, '{"a":"' + 'x'.repeat(70000) + '"}', 'utf8');
    assert.equal(readRemoteBridgeConfigFile(hugeCfg).error, 'ERR_REMOTE_BRIDGE_CONFIG_TOO_LARGE');
    assert.equal(writeRemoteBridgeConfigFileAtomic(path.join(tmpDir, 'huge-out.json'), { a: 'x'.repeat(70000) }).reason, 'ERR_REMOTE_BRIDGE_CONFIG_TOO_LARGE');
    const corruptCfg = path.join(tmpDir, 'corrupt.json');
    fs.writeFileSync(corruptCfg, '{bad', 'utf8');
    assert.equal(readRemoteBridgeConfigFile(corruptCfg).ok, false);

    // Live remote-bridge-server HTTP error paths (OPTIONS PNA, 403 origin, 401 auth, 400 invalid JSON/proto, 404 route)
    const rbCfgPath = path.join(tmpDir, 'remote-bridge.json');
    const rb = createRemoteBridgeServer({
      configPath: rbCfgPath,
      allowedOrigins: ['https://antigravity.google.com'],
      allowLoopbackOrigin: true,
    });
    assert.equal((await rb.startIfEnabled()).ok, true);
    const cfgRes = await rb.configure({ enabled: true, bindHost: '127.0.0.1', port: 0 });
    assert.equal(cfgRes.ok, true);
    const st = rb.getStatus();
    assert.equal(st.running, true);
    const baseUrl = `http://127.0.0.1:${st.listeningPort}`;
    const tok = readRemoteBridgeConfigFile(rbCfgPath).config.token;
    assert.ok(tok && tok.length >= 32);

    // Valid /v1/ping
    const pingRes = await globalThis.fetch(`${baseUrl}/v1/ping`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    assert.equal(pingRes.status, 200);

    // Already running start() returns ok
    assert.equal((await rb.start()).ok, true);
    // Allowed loopback origin OPTIONS PNA preflight
    const optOk = await globalThis.fetch(`${baseUrl}/v1/health`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://127.0.0.1:4173', 'Access-Control-Request-Private-Network': 'true' },
    });
    assert.equal(optOk.status, 204);
    // Disallowed origin -> 403
    const badOrig = await globalThis.fetch(`${baseUrl}/v1/health`, {
      headers: { Origin: 'https://evil.example.com', Authorization: `Bearer ${tok}` },
    });
    assert.equal(badOrig.status, 403);
    // Missing auth -> 401
    const noAuth = await globalThis.fetch(`${baseUrl}/v1/health`);
    assert.equal(noAuth.status, 401);
    // Wrong method -> 405, unknown POST route -> 404
    const wrongMethod = await globalThis.fetch(`${baseUrl}/v1/unknown`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    assert.equal(wrongMethod.status, 405);
    const notFound = await globalThis.fetch(`${baseUrl}/v1/unknown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(notFound.status, 404);
    // Invalid JSON & prototype pollution on POST
    const badJson = await globalThis.fetch(`${baseUrl}/v1/net/fetch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: '{bad',
    });
    assert.equal(badJson.status, 400);
    const protoJson = await globalThis.fetch(`${baseUrl}/v1/net/fetch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: '{"__proto__":{"polluted":1}}',
    });
    assert.equal(protoJson.status, 400);
    const arrJson = await globalThis.fetch(`${baseUrl}/v1/net/fetch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: '[1,2]',
    });
    assert.equal(arrJson.status, 400);
    // Unavailable bridges -> 503 on all POST routes
    for (const ep of ['/v1/settings/read', '/v1/settings/save', '/v1/config/read', '/v1/config/write', '/v1/net/fetch', '/v1/secrets/set']) {
      const r503 = await globalThis.fetch(`${baseUrl}${ep}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pluginId: 'p1' }),
      });
      assert.equal(r503.status, 503);
    }
    // Rotate token + dispose + start after dispose
    assert.equal(rb.rotateToken().ok, true);
    await rb.dispose();
    assert.equal((await rb.start()).reason, 'ERR_REMOTE_BRIDGE_DISPOSED');

    // Wired remote-bridge-server exercising 403/400/200 across settings/config/net/secrets routes
    const wiredCfgPath = path.join(tmpDir, 'remote-bridge-wired.json');
    const wiredRenderer = path.join(tmpDir, 'wired-r.js');
    fs.writeFileSync(wiredRenderer, 'module.exports = function(){};\n', 'utf8');
    const wiredSha = crypto.createHash('sha256').update(fs.readFileSync(wiredRenderer)).digest('hex');
    const rbWired = createRemoteBridgeServer({
      configPath: wiredCfgPath,
      allowedOrigins: ['https://antigravity.google.com'],
      allowLoopbackOrigin: true,
      planCurrentAddons: () => ({
        active: [
          {
            pluginId: 'p-full',
            manifest: {
              pluginId: 'p-full',
              version: '1.0.0',
              trustLevel: 'trusted',
              settingsBridge: { fileName: 'pf.json', maxBytes: 4096 },
              configBridge: { scopes: [{ scopeId: 'mcp', access: 'rw', maxBytes: 4096 }] },
              permissions: {
                net: { httpsHosts: ['api.example.com'] },
                secrets: { maxKeys: 4, maxBytes: 1024, allowRead: true },
              },
            },
            resolvedEntries: { rendererScript: wiredRenderer },
          },
          {
            pluginId: 'p-bare',
            manifest: { pluginId: 'p-bare', version: '1.0.0', trustLevel: 'trusted' },
            resolvedEntries: { rendererScript: wiredRenderer },
          },
        ],
      }),
      readCurrentPolicy: () => ({
        schemaVersion: 1,
        approved: {
          'p-full': { version: '1.0.0', rendererSha256: wiredSha, mainHookBundleSha256: null },
          'p-bare': { version: '1.0.0', rendererSha256: wiredSha, mainHookBundleSha256: null },
        },
      }),
      settingsBridge: {
        readSnapshotForPlugin: () => ({ ok: true, status: 'ok', data: { s: 1 } }),
        writeSnapshotForPlugin: () => ({ ok: true, snapshot: { status: 'ok', data: { s: 2 } } }),
      },
      configBridge: {
        readScopeForPlugin: () => ({ ok: true, status: 'ok', data: { c: 1 } }),
        writeScopeForPlugin: () => ({ ok: true, currentSha256: 'sha-1' }),
      },
      netFetchBroker: {
        fetchForPlugin: async () => ({ ok: true, status: 200, bodyText: 'net-ok' }),
      },
      secretsVault: {
        setSecret: () => ({ ok: true, key: 'k1' }),
        getSecret: () => ({ ok: true, exists: true, value: 'v1' }),
        hasSecret: () => ({ ok: true, exists: true }),
        deleteSecret: () => ({ ok: true, deleted: true }),
        listSecretKeys: () => ({ ok: true, keys: ['k1'] }),
      },
    });
    await rbWired.configure({ enabled: true, bindHost: '127.0.0.1', port: 0 });
    const wUrl = `http://127.0.0.1:${rbWired.getStatus().listeningPort}`;
    const wTok = readRemoteBridgeConfigFile(wiredCfgPath).config.token;
    const postW = (ep, body) =>
      globalThis.fetch(`${wUrl}${ep}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${wTok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    // Unverified plugin (403) + bare unbound plugin (403) + bad payload (400) + happy path (200)
    for (const [ep, okBody, badBody] of [
      ['/v1/settings/read', { pluginId: 'p-full' }, null],
      ['/v1/settings/save', { pluginId: 'p-full', rawJson: '{"a":1}' }, { pluginId: 'p-full' }],
      ['/v1/config/read', { pluginId: 'p-full', scopeId: 'mcp' }, { pluginId: 'p-full' }],
      ['/v1/config/write', { pluginId: 'p-full', scopeId: 'mcp', rawJson: '{}', expectedSha256: 'x' }, { pluginId: 'p-full' }],
      ['/v1/net/fetch', { pluginId: 'p-full', url: 'https://api.example.com/v1', method: 'GET' }, { pluginId: 'p-full' }],
      ['/v1/secrets/set', { pluginId: 'p-full', key: 'k1', value: 'v1' }, null],
      ['/v1/secrets/get', { pluginId: 'p-full', key: 'k1' }, null],
      ['/v1/secrets/has', { pluginId: 'p-full', key: 'k1' }, null],
      ['/v1/secrets/delete', { pluginId: 'p-full', key: 'k1' }, null],
      ['/v1/secrets/list', { pluginId: 'p-full' }, null],
    ]) {
      assert.equal((await postW(ep, { pluginId: 'unknown' })).status, 403);
      assert.equal((await postW(ep, { pluginId: 'p-bare' })).status, 403);
      if (badBody) assert.equal((await postW(ep, badBody)).status, 400);
      assert.equal((await postW(ep, okBody)).status, 200);
    }
    await rbWired.dispose();

    // 5. update-survival-hook spawn error, ACK timeout, and sync throw fail-open branches
    const cliDummy = path.join(tmpDir, 'survival-cli.js');
    fs.writeFileSync(cliDummy, '// cli\n', 'utf8');
    const hostDataDir = path.join(tmpDir, 'host-data');
    fs.mkdirSync(hostDataDir, { recursive: true });
    fs.writeFileSync(
      path.join(hostDataDir, 'host-cli.json'),
      JSON.stringify({
        cliEntryPath: cliDummy,
        nodeExecPath: process.execPath,
        appExecutablePath: path.join(tmpDir, 'app-dir', 'app.exe'),
        asarPath: path.join(tmpDir, 'app-dir', 'resources', 'app.asar'),
        lastPatchedAsarSha256: 'a'.repeat(64),
      }),
      'utf8'
    );
    const makeHook = (spawnFn) =>
      createUpdateSurvivalHook({
        updateSurvival: {
          platforms: [process.platform],
          updaterModule: 'electron-updater',
          method: 'quitAndInstall',
          ackTimeoutMs: 25,
          waitTimeoutMs: 5000,
        },
        hostDataDir,
        spawnFn,
        sleepSyncFn: () => {},
      });
    const hErr = makeHook(() => ({
      pid: 1001,
      on(ev, fn) { if (ev === 'error') fn(new Error('ENOENT')); },
      unref() {},
    }));
    assert.equal(hErr.trySpawnHandoffHelper(), false);
    assert.ok(hErr.getStatus().lastHandoff.reason.includes('ERR_RECONCILE_SPAWN_FAILED'));
    let killed = false;
    const hTimeout = makeHook(() => ({
      pid: 1002,
      on() {},
      unref() {},
      kill() { killed = true; },
    }));
    assert.equal(hTimeout.trySpawnHandoffHelper(), false);
    assert.equal(killed, true);
    assert.equal(hTimeout.getStatus().lastHandoff.reason, 'ERR_RECONCILE_ACK_TIMEOUT');
    const hThrow = makeHook(() => { throw new Error('SYNC_SPAWN_BOOM'); });
    assert.equal(hThrow.trySpawnHandoffHelper(), false);
    assert.ok(hThrow.getStatus().lastHandoff.reason.includes('SYNC_SPAWN_BOOM'));

    // 2. host-admin-service unavailable remote bridge & execBuildRemoteCli (ok, fail, dedupe, missing)
    const okCli = path.join(tmpDir, 'cli-ok.js');
    const failCli = path.join(tmpDir, 'cli-fail.js');
    fs.writeFileSync(okCli, 'setTimeout(() => { process.stdout.write("BUILT"); }, 40);\n', 'utf8');
    fs.writeFileSync(failCli, 'process.stderr.write("CLI_FAIL"); process.exit(1);\n', 'utf8');

    const adminNoBridge = createHostAdminService({
      addonsDir: tmpDir,
      pluginsRootDir: tmpDir,
      remotePrefsPath: path.join(tmpDir, 'prefs.json'),
      remoteDistDir: path.join(tmpDir, 'remote-dist'),
      cliEntryPath: okCli,
      remoteBridgeServer: null,
    });
    assert.equal((await adminNoBridge.configureRemoteBridge({})).reason, 'ERR_REMOTE_BRIDGE_UNAVAILABLE');
    assert.equal(adminNoBridge.rotateRemoteBridgeToken().reason, 'ERR_REMOTE_BRIDGE_UNAVAILABLE');
    // Concurrent rebuildRemoteBundle deduplicates in-flight promise
    const [rA, rB] = await Promise.all([adminNoBridge.rebuildRemoteBundle(), adminNoBridge.rebuildRemoteBundle()]);
    assert.equal(rA.ok, true);
    assert.equal(rB.ok, true);

    const adminFailCli = createHostAdminService({
      addonsDir: tmpDir,
      pluginsRootDir: tmpDir,
      remotePrefsPath: path.join(tmpDir, 'prefs.json'),
      remoteDistDir: path.join(tmpDir, 'remote-dist'),
      cliEntryPath: failCli,
    });
    const rFail = await adminFailCli.rebuildRemoteBundle();
    assert.equal(rFail.ok, false);

    const adminMissingCli = createHostAdminService({
      addonsDir: tmpDir,
      pluginsRootDir: tmpDir,
      remotePrefsPath: path.join(tmpDir, 'prefs.json'),
      remoteDistDir: path.join(tmpDir, 'remote-dist'),
      cliEntryPath: path.join(tmpDir, 'does-not-exist.js'),
      cliCommandName: 'nonexistent-extenra-cmd-xyz-999',
      pathEnv: '',
    });
    assert.equal((await adminMissingCli.rebuildRemoteBundle()).reason, 'ERR_HOST_CLI_NOT_FOUND');

    // 3. secrets-vault error/unavailable/corrupt paths
    const vaultPath = path.join(tmpDir, 'vault.json');
    fs.writeFileSync(vaultPath, '{corrupt', 'utf8');
    const unavailVault = createSecretsVault({
      vaultPath,
      safeStorage: { isEncryptionAvailable: () => false },
    });
    assert.equal(unavailVault.getStatus().available, false);
    const bind = { pluginId: 'p1', maxKeys: 1, maxBytes: 16, allowRead: false };
    assert.equal(unavailVault.setSecret('p1', bind, 'k1', 'v').ok, false);
    assert.equal(unavailVault.getSecret('p1', bind, 'k1').ok, false);
    assert.equal(unavailVault.hasSecret('p1', bind, 'k1').ok, false);
    assert.equal(unavailVault.deleteSecret('p1', bind, 'k1').ok, false);
    assert.equal(unavailVault.listSecretKeys('p1', bind).ok, false);

    const okVault = createSecretsVault({
      vaultPath: path.join(tmpDir, 'vault-ok.json'),
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from('e:' + s, 'utf8'),
        decryptString: (b) => b.toString('utf8').replace(/^e:/, ''),
      },
    });
    assert.equal(okVault.setSecret('p1', bind, 'k1', 'val').ok, true);
    assert.equal(okVault.setSecret('p1', bind, 'k2', 'val').reason, 'ERR_SECRETS_MAX_KEYS_EXCEEDED');
    assert.equal(okVault.getSecret('p1', bind, 'k1').reason, 'ERR_SECRETS_READ_NOT_ALLOWED');
    assert.equal(okVault.deleteSecret('p1', bind, 'nonexistent').deleted, false);
    assert.equal(okVault.deleteSecret('p1', bind, 'k1').deleted, true);

    // 4. settings-bridge corrupt/oversized/missing/refreshNow/dispose paths
    const sbDir = path.join(tmpDir, 'sb');
    fs.mkdirSync(sbDir, { recursive: true });
    fs.writeFileSync(path.join(sbDir, 'bad.json'), '{bad', 'utf8');
    fs.writeFileSync(path.join(sbDir, 'big.json'), '{"a":"' + 'y'.repeat(2048) + '"}', 'utf8');
    const sb = createSettingsBridge({ settingsDataDir: sbDir });
    assert.equal(sb.readSnapshotForPlugin('p1', { fileName: 'missing.json', maxBytes: 4096 }).status, 'missing');
    assert.equal(sb.readSnapshotForPlugin('p1', { fileName: 'bad.json', maxBytes: 4096 }).status, 'error');
    assert.equal(sb.readSnapshotForPlugin('p1', { fileName: 'big.json', maxBytes: 256 }).status, 'error');
    assert.equal(sb.writeSnapshotForPlugin('p1', { fileName: 'good.json', maxBytes: 4096 }, '{"ok":true}').ok, true);
    assert.equal(sb.writeSnapshotForPlugin('p1', { fileName: 'good.json', maxBytes: 4096 }, '{bad').ok, false);
    sb.syncPlugins([{ pluginId: 'p1', fileName: 'good.json', maxBytes: 4096 }]);
    sb.refreshNow();
    assert.ok(sb.getStatus());
    assert.ok(sb.getLastSnapshot('p1'));
    assert.equal(sb.getLastSnapshot('missing'), null);
    sb.dispose();
    assert.equal(sb.readSnapshotForPlugin('p1', { fileName: 'good.json', maxBytes: 4096 }).reason, 'ERR_SETTINGS_BRIDGE_DISPOSED');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-COV90-M04: trust-verifier, secrets-vault, and settings-bridge edge & failure paths', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extenra-cov90-m04-'));
  try {
    // 1. trust-verifier loadTrustPolicyFile
    assert.equal(loadTrustPolicyFile('').missing, true);
    assert.equal(loadTrustPolicyFile(path.join(tmpDir, 'nope.json')).missing, true);
    const arrPol = path.join(tmpDir, 'arr-pol.json');
    fs.writeFileSync(arrPol, '[1,2]', 'utf8');
    assert.equal(loadTrustPolicyFile(arrPol).reason, 'ERR_TRUST_POLICY_CORRUPTED');
    const dirPol = path.join(tmpDir, 'dir-pol');
    fs.mkdirSync(dirPol, { recursive: true });
    assert.equal(loadTrustPolicyFile(dirPol).reason, 'ERR_TRUST_POLICY_READ_FAILED');

    // 2. readVerifiedRendererScript integrity mismatch & read failure
    const pDir = path.join(tmpDir, 'plugin-tv');
    fs.mkdirSync(pDir, { recursive: true });
    const rPath = path.join(pDir, 'renderer.js');
    fs.writeFileSync(rPath, 'module.exports = function(){};\n', 'utf8');
    const rSha = crypto.createHash('sha256').update(fs.readFileSync(rPath)).digest('hex');
    const badManifest = {
      pluginId: 'p-tv',
      version: '1.0.0',
      trustLevel: 'trusted',
      integrity: { rendererSha256: '0'.repeat(64) },
    };
    assert.equal(readVerifiedRendererScript(path.join(pDir, 'missing.js'), badManifest, { approved: {} }).reason, 'ERR_RENDERER_SCRIPT_READ_FAILED');
    assert.equal(readVerifiedRendererScript(rPath, badManifest, { approved: {} }).reason, 'ERR_MANIFEST_INTEGRITY_MISMATCH');
    assert.equal(
      readVerifiedRendererScript(rPath, { pluginId: 'p-tv', version: '1.0.0', trustLevel: 'trusted' }, { approved: {} }).ok,
      false
    );
    assert.equal(
      readVerifiedRendererScript(
        rPath,
        { pluginId: 'p-tv', version: '1.0.0', trustLevel: 'trusted', integrity: { rendererSha256: rSha } },
        { approved: { 'p-tv': { version: '1.0.0', rendererSha256: rSha } } }
      ).ok,
      true
    );

    // 3. loadVerifiedMainHookModule error paths
    const mhEntry = path.join(pDir, 'main-hook.js');
    fs.writeFileSync(mhEntry, 'module.exports = { ok: true };\n', 'utf8');
    const snap = snapshotPluginBundleInMemory(pDir);
    const mhManifest = { pluginId: 'p-tv', version: '1.0.0', trustLevel: 'trusted', capabilities: ['mainHook'] };
    assert.equal(loadVerifiedMainHookModule(mhEntry, pDir, mhManifest, { approved: {} }).reason, 'ERR_TRUST_POLICY_NOT_APPROVED');
    assert.equal(
      loadVerifiedMainHookModule(mhEntry, pDir, mhManifest, { approved: { 'p-tv': { version: '1.0.0' } } }).reason,
      'ERR_TRUST_POLICY_MISSING_MAIN_HOOK_PIN'
    );
    assert.equal(
      loadVerifiedMainHookModule(path.join(pDir, 'missing-hook.js'), pDir, mhManifest, {
        approved: { 'p-tv': { version: '1.0.0', mainHookBundleSha256: snap.bundleSha256 } },
      }).reason,
      'ERR_MAIN_HOOK_ENTRY_MISSING'
    );
    const outsideEntry = path.join(tmpDir, 'outside.js');
    fs.writeFileSync(outsideEntry, 'module.exports = {};\n', 'utf8');
    assert.equal(
      loadVerifiedMainHookModule(outsideEntry, pDir, mhManifest, {
        approved: { 'p-tv': { version: '1.0.0', mainHookBundleSha256: snap.bundleSha256 } },
      }).reason,
      'ERR_MAIN_HOOK_ESCAPES_PLUGIN_ROOT'
    );
    assert.equal(
      loadVerifiedMainHookModule(
        mhEntry,
        pDir,
        { ...mhManifest, integrity: { mainHookBundleSha256: 'f'.repeat(64) } },
        { approved: { 'p-tv': { version: '1.0.0', mainHookBundleSha256: snap.bundleSha256 } } }
      ).reason,
      'ERR_MANIFEST_BUNDLE_INTEGRITY_MISMATCH'
    );
    assert.equal(
      loadVerifiedMainHookModule(mhEntry, pDir, mhManifest, {
        approved: { 'p-tv': { version: '1.0.0', mainHookBundleSha256: 'e'.repeat(64) } },
      }).ok,
      false
    );
    // Happy path + runtime throw path
    assert.equal(
      loadVerifiedMainHookModule(mhEntry, pDir, mhManifest, {
        approved: { 'p-tv': { version: '1.0.0', mainHookBundleSha256: snap.bundleSha256 } },
      }).ok,
      true
    );
    const throwDir = path.join(tmpDir, 'plugin-throw');
    fs.mkdirSync(throwDir, { recursive: true });
    const throwEntry = path.join(throwDir, 'main-hook.js');
    fs.writeFileSync(throwEntry, 'throw new Error("HOOK_INIT_FAIL");\n', 'utf8');
    const throwSnap = snapshotPluginBundleInMemory(throwDir);
    assert.equal(
      loadVerifiedMainHookModule(throwEntry, throwDir, mhManifest, {
        approved: { 'p-tv': { version: '1.0.0', mainHookBundleSha256: throwSnap.bundleSha256 } },
      }).ok,
      false
    );

    // 4. secrets-vault resolveSecretForHost + corrupt/oversized vault recovery
    const badVaultPath = path.join(tmpDir, 'bad-vault.json');
    fs.writeFileSync(badVaultPath, '{bad', 'utf8');
    const okSafe = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('e:' + s, 'utf8'),
      decryptString: (b) => b.toString('utf8').replace(/^e:/, ''),
    };
    const vBad = createSecretsVault({ vaultPath: badVaultPath, safeStorage: okSafe });
    const bindV = { pluginId: 'p1', maxKeys: 4, maxBytes: 128, allowRead: true };
    assert.equal(vBad.resolveSecretForHost('p1', bindV, 'k1').ok, false);
    assert.equal(vBad.setSecret('p1', bindV, 'bad key!', 'v').ok, false);
    assert.equal(vBad.setSecret('p1', bindV, 'k1', 'x'.repeat(256)).ok, false);
    const vGood = createSecretsVault({ vaultPath: path.join(tmpDir, 'good-vault.json'), safeStorage: okSafe });
    assert.equal(vGood.setSecret('p1', bindV, 'api_key', 'topsecret').ok, true);
    assert.equal(vGood.resolveSecretForHost('p1', bindV, 'api_key').value, 'topsecret');
    assert.equal(vGood.resolveSecretForHost('p1', bindV, 'missing_key').ok, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-COV90-M05: asar-patcher missing/blocked rollback, renderer-injector missing/untrusted/dispose, and remote-bridge startup/500 errors', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extenra-cov90-m05-'));
  try {
    // 1. asar-patcher missing ASAR diagnose & rollback & upgrade
    const missingPaths = {
      ASAR_PATH: path.join(tmpDir, 'nope.asar'),
      ASAR_LOCK_PATH: path.join(tmpDir, 'asar.lock'),
      ADDONS_LOCK_PATH: path.join(tmpDir, 'addons.lock'),
      ADDONS_DIR: path.join(tmpDir, 'addons.d'),
      ASAR_BACKUPS_DIR: path.join(tmpDir, 'backups'),
    };
    const diagMissing = diagnoseAsarState(missingPaths, ANTIGRAVITY_HOST_PROFILE);
    assert.equal(diagMissing.asarExists, false);
    assert.equal(diagMissing.status, 'NO_ASAR');
    assert.equal(rollbackAsarAddonHost(missingPaths, ANTIGRAVITY_HOST_PROFILE).status, 'SKIPPED_NO_ASAR');
    assert.equal(upgradeAsarAddonHost(missingPaths, ANTIGRAVITY_HOST_PROFILE).status, 'SKIPPED_NO_ASAR');

    // 2. renderer-injector missing script, trust rejected, active plugin removal -> disposePlugin
    const diags = [];
    const rPath = path.join(tmpDir, 'r-ok.js');
    fs.writeFileSync(rPath, 'module.exports = function(){};\n', 'utf8');
    const rSha = crypto.createHash('sha256').update(fs.readFileSync(rPath)).digest('hex');
    let includeOk = true;
    const inj = createRendererInjector({
      worldId: 998,
      originResolver: {
        isSessionAllowed: () => true,
        isAllowedUrl: () => true,
        getState: () => ({ docGenId: 1, pinnedUrl: 'https://app.example.com/', activeNonce: '0123456789abcdef0123' }),
        rotateGeneration: (_id, u) => ({ docGenId: 1, pinnedUrl: u, activeNonce: '0123456789abcdef0123' }),
        clearWebContents: () => {},
      },
      kernelBundleSource: () => '/*kernel*/',
      planProvider: () => ({
        active: [
          ...(includeOk
            ? [{ pluginId: 'p-ok', manifest: { pluginId: 'p-ok', version: '1.0.0', trustLevel: 'trusted' }, resolvedEntries: { rendererScript: rPath } }]
            : []),
          { pluginId: 'p-miss', manifest: { pluginId: 'p-miss', version: '1.0.0', trustLevel: 'trusted' }, resolvedEntries: { rendererScript: path.join(tmpDir, 'no-file.js') } },
          { pluginId: 'p-untrusted', manifest: { pluginId: 'p-untrusted', version: '1.0.0', trustLevel: 'trusted', capabilities: ['renderer'] }, resolvedEntries: { rendererScript: rPath } },
        ],
      }),
      policyProvider: () => ({
        schemaVersion: 1,
        approved: { 'p-ok': { version: '1.0.0', rendererSha256: rSha } },
      }),
      recordDiag: (lvl, code) => diags.push(code),
    });
    const wc = {
      id: 303,
      on() {},
      once() {},
      isDestroyed: () => false,
      getURL: () => 'https://app.example.com/',
      executeJavaScriptInIsolatedWorld: async (_w, scripts) => {
        const code = scripts && scripts[0] && scripts[0].code ? scripts[0].code : '';
        if (code.includes('stagePluginHandle')) return { ok: true, runNonce: 'rn-303' };
        return { ok: true };
      },
    };
    inj.attachWebContents(wc);
    await inj.scheduleSync(wc);
    assert.ok(diags.includes('RENDERER_SCRIPT_MISSING'));
    assert.ok(diags.includes('RENDERER_TRUST_REJECTED'));
    // Remove p-ok -> triggers disposePlugin branch
    includeOk = false;
    await inj.scheduleSync(wc);

    // 3. remote-bridge-server startup EADDRINUSE & internal 500 handler
    const blocker = http.createServer((_req, res) => res.end('ok'));
    await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
    const busyPort = blocker.address().port;
    try {
      const rbBusy = createRemoteBridgeServer({
        configPath: path.join(tmpDir, 'rb-busy.json'),
        allowLoopbackOrigin: true,
      });
      const cfgBusy = await rbBusy.configure({ enabled: true, bindHost: '127.0.0.1', port: busyPort });
      assert.equal(cfgBusy.ok, false);
      await rbBusy.dispose();
    } finally {
      await new Promise((r) => blocker.close(r));
    }

    const rb500Cfg = path.join(tmpDir, 'rb-500.json');
    const rb500 = createRemoteBridgeServer({
      configPath: rb500Cfg,
      allowLoopbackOrigin: true,
      planCurrentAddons: () => { throw new Error('PLAN_CRASH'); },
      settingsBridge: { readSnapshotForPlugin: () => ({}) },
    });
    await rb500.configure({ enabled: true, bindHost: '127.0.0.1', port: 0 });
    const tok500 = readRemoteBridgeConfigFile(rb500Cfg).config.token;
    const r500 = await globalThis.fetch(`http://127.0.0.1:${rb500.getStatus().listeningPort}/v1/settings/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok500}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pluginId: 'p1' }),
    });
    assert.equal(r500.status, 500);
    await rb500.dispose();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-COV90-M06: host-admin-service helpers, settings-bridge writeSettingsFileSnapshot guards, and electron-host-lifecycle-port compensation', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extenra-cov90-m06-'));
  try {
    // 1. host-admin-service exported file/PATH helpers
    assert.equal(isCommandOnPath('', { pathEnv: '' }), false);
    assert.equal(isCommandOnPath('definitely-not-a-real-cmd-xyz', { pathEnv: tmpDir }), false);
    assert.equal(readHostCliMetaFile('').exists, false);
    assert.equal(readHostCliMetaFile(path.join(tmpDir, 'nope.json')).exists, false);
    const badMeta = path.join(tmpDir, 'bad-meta.json');
    fs.writeFileSync(badMeta, '{bad', 'utf8');
    assert.equal(readHostCliMetaFile(badMeta).ok, false);

    assert.equal(readRemotePreferencesFile('').exists, false);
    assert.equal(readRemotePreferencesFile(path.join(tmpDir, 'no-prefs.json')).exists, false);
    const badPrefs = path.join(tmpDir, 'bad-prefs.json');
    fs.writeFileSync(badPrefs, '{bad', 'utf8');
    assert.equal(readRemotePreferencesFile(badPrefs).ok, false);
    const dirPrefs = path.join(tmpDir, 'dir-prefs');
    fs.mkdirSync(dirPrefs, { recursive: true });
    assert.equal(writeRemotePreferencesFileAtomic('', {}).reason, 'ERR_REMOTE_PREFS_PATH_MISSING');
    assert.equal(writeRemotePreferencesFileAtomic(dirPrefs, {}).reason, 'ERR_REMOTE_PREFS_NON_REGULAR_OR_SYMLINK');
    assert.equal(writeRemotePreferencesFileAtomic(path.join(tmpDir, 'huge-prefs.json'), { big: 'x'.repeat(300000) }).reason, 'ERR_REMOTE_PREFS_TOO_LARGE');
    const goodPrefs = path.join(tmpDir, 'prefs.json');
    assert.equal(writeRemotePreferencesFileAtomic(goodPrefs, { schemaVersion: 1, updatedAt: new Date().toISOString(), addons: { p1: { enabled: false }, p2: { enabled: true } } }).ok, true);
    const parsedPrefs = readRemotePreferencesFile(goodPrefs);
    assert.equal(parsedPrefs.ok, true);
    assert.equal(isAddonEnabledInRemotePreferences(parsedPrefs, 'p1'), false);
    assert.equal(isAddonEnabledInRemotePreferences(parsedPrefs, 'p2'), true);
    assert.equal(isAddonEnabledInRemotePreferences(parsedPrefs, 'p-other'), true);

    assert.equal(readRemoteBundleStatus(path.join(tmpDir, 'no-dist')).built, false);
    const badDist = path.join(tmpDir, 'bad-dist');
    fs.mkdirSync(badDist, { recursive: true });
    fs.writeFileSync(path.join(badDist, 'build-manifest.json'), '{bad', 'utf8');
    assert.equal(readRemoteBundleStatus(badDist).built, false);

    // 2. settings-bridge writeSettingsFileSnapshot error branches
    const sbDir = path.join(tmpDir, 'sb-write');
    fs.mkdirSync(sbDir, { recursive: true });
    const dirTarget = path.join(sbDir, 'sub.json');
    fs.mkdirSync(dirTarget, { recursive: true });
    const resTarget = path.join(sbDir, 'reserved.json');
    assert.equal(writeSettingsFileSnapshot('', { fileName: 'a.json', maxBytes: 4096 }, '{}').ok, false);
    assert.equal(writeSettingsFileSnapshot(sbDir, { fileName: '../escape.json', maxBytes: 4096 }, '{}').ok, false);
    assert.equal(writeSettingsFileSnapshot(sbDir, { fileName: 'reserved.json', maxBytes: 4096 }, '{}', { reservedFilePaths: [resTarget] }).reason, 'ERR_SETTINGS_RESERVED_PATH');
    assert.equal(writeSettingsFileSnapshot(sbDir, { fileName: 'sub.json', maxBytes: 4096 }, '{}').reason, 'ERR_SETTINGS_NOT_REGULAR_FILE');
    assert.equal(writeSettingsFileSnapshot(sbDir, { fileName: 'ok.json', maxBytes: 4096 }, '[1,2]').ok, false);
    assert.equal(writeSettingsFileSnapshot(sbDir, { fileName: 'ok.json', maxBytes: 4096 }, '{"__proto__":{"a":1}}').ok, false);
    assert.equal(writeSettingsFileSnapshot(sbDir, { fileName: 'ok.json', maxBytes: 1024 }, '{"a":"' + 'z'.repeat(2048) + '"}').ok, false);
    assert.equal(
      writeSettingsFileSnapshot(sbDir, { fileName: 'ok.json', maxBytes: 4096 }, '{}', {
        fsImpl: { ...fs, mkdirSync: () => { throw new Error('EACCES'); } },
      }).reason,
      'ERR_SETTINGS_WRITE_FAILED'
    );
    assert.equal(
      writeSettingsFileSnapshot(sbDir, { fileName: 'ok.json', maxBytes: 4096 }, '{}', {
        fsImpl: { ...fs, realpathSync: () => { throw new Error('RP'); } },
      }).reason,
      'ERR_SETTINGS_REALPATH_FAILED'
    );

    // 3. electron-host-lifecycle-port ASAR_PATCH_THREW & ASAR_PATCH_FAILED compensation paths
    const fakeHome = path.join(tmpDir, 'home');
    fs.mkdirSync(fakeHome, { recursive: true });
    const envFake = { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome };
    const throwPort = createElectronHostLifecyclePort({
      transport: {
        isInstalled: () => false,
        install: () => { throw new Error('ASAR_THROW_SIM'); },
        upgrade: () => ({ status: 'ERR_ORIG_MISSING' }),
        rollback: () => ({ status: 'SKIPPED_NO_ASAR' }),
        diagnose: () => ({ asarExists: false, status: 'NO_ASAR' }),
      },
    });
    const ctx = throwPort.resolveContext(ANTIGRAVITY_HOST_PROFILE, envFake);
    const rThrow = throwPort.installHost(ctx, { mode: 'install', hostVersion: '3.3.4' });
    assert.equal(rThrow.ok, false);
    assert.equal(rThrow.phase, 'ASAR_PATCH_THREW');
    const rFail = throwPort.upgradeHost
      ? throwPort.upgradeHost(ctx, { hostVersion: '3.3.4' })
      : throwPort.installHost(ctx, { hostVersion: '3.3.4' });
    assert.equal(rFail.ok, false);
    assert.ok(rFail.phase === 'ASAR_PATCH_FAILED' || rFail.phase === 'ASAR_PATCH_THREW');
    assert.ok(throwPort.diagnoseHost(ctx));
    assert.ok(throwPort.getHostStatus(ctx));
    assert.ok(throwPort.rollbackHost(ctx));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-COV90-M07: trust-policy-store, portal-arbiter, host-origin-resolver, and electron-host-profile-port full branch coverage', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extenra-cov90-m07-'));
  try {
    // 1. trust-policy-store full error & happy paths
    const addonsDir = path.join(tmpDir, 'addons.d');
    const pluginsRoot = path.join(tmpDir, 'plugins');
    const trustPolicyPath = path.join(tmpDir, 'trust-policy.json');
    const lockPath = path.join(tmpDir, 'addons.lock');
    fs.mkdirSync(addonsDir, { recursive: true });
    fs.mkdirSync(pluginsRoot, { recursive: true });
    const tpCtx = {
      paths: { HOST_DATA_DIR: tmpDir, TRUST_POLICY_PATH: trustPolicyPath, ADDONS_LOCK_PATH: lockPath, PLUGINS_ROOT_DIR: pluginsRoot, ADDONS_DIR: addonsDir },
    };
    const tp = createElectronTrustPolicyPort();
    assert.equal(tp.approvePlugin(tpCtx, 'BAD ID!').ok, false);
    assert.equal(tp.approvePlugin(tpCtx, 'no-reg').reason, 'ERR_MANIFEST_NOT_REGISTERED');
    fs.writeFileSync(path.join(addonsDir, 'bad-json.json'), '{bad', 'utf8');
    assert.equal(tp.approvePlugin(tpCtx, 'bad-json').reason, 'ERR_MANIFEST_INVALID_JSON');
    fs.writeFileSync(path.join(addonsDir, 'mismatch.json'), JSON.stringify({ pluginId: 'other' }), 'utf8');
    assert.equal(tp.approvePlugin(tpCtx, 'mismatch').reason, 'ERR_MANIFEST_PLUGIN_ID_MISMATCH');
    assert.equal(tp.approvePlugin(tpCtx, 'no-dir', { pluginId: 'no-dir', version: '1.0.0' }).reason, 'ERR_PLUGIN_DIR_NOT_FOUND');

    const pDir = path.join(pluginsRoot, 'tp-plug');
    fs.mkdirSync(path.join(pDir, 'sub-dir'), { recursive: true });
    assert.equal(tp.approvePlugin(tpCtx, 'tp-plug', { pluginId: 'tp-plug', version: '1.0.0', entry: { rendererScript: 'missing.js' } }).reason, 'ERR_RENDERER_SCRIPT_NOT_FOUND');
    assert.equal(tp.approvePlugin(tpCtx, 'tp-plug', { pluginId: 'tp-plug', version: '1.0.0', entry: { rendererScript: 'sub-dir' } }).reason, 'ERR_RENDERER_SCRIPT_NOT_FILE');
    fs.writeFileSync(path.join(pDir, 'r.js'), 'module.exports = function(){};\n', 'utf8');
    fs.writeFileSync(path.join(pDir, 'mh.js'), 'module.exports = {};\n', 'utf8');
    const appRes = tp.approvePlugin(tpCtx, 'tp-plug', { pluginId: 'tp-plug', version: '1.0.0', entry: { rendererScript: 'r.js', mainHookScript: 'mh.js' } });
    assert.equal(appRes.ok, true);
    assert.equal(tp.listApproved(tpCtx).approved.length, 1);
    assert.equal(tp.verifyPluginTrust(tpCtx, { pluginId: 'tp-plug', version: '1.0.0', trustLevel: 'trusted' }, { rendererSha256: appRes.record.rendererSha256 }).ok, true);
    assert.equal(tp.revokePlugin(tpCtx, 'BAD ID!').ok, false);
    assert.equal(tp.revokePlugin(tpCtx, 'tp-plug').revoked, true);
    assert.equal(tp.revokePlugin(tpCtx, 'tp-plug').revoked, false);
    // Corrupted policy file refuses overwrite on approve/revoke/verify
    fs.writeFileSync(trustPolicyPath, '[1,2]', 'utf8');
    assert.equal(tp.verifyPluginTrust(tpCtx, { pluginId: 'tp-plug', version: '1.0.0' }, {}).ok, false);
    assert.equal(tp.approvePlugin(tpCtx, 'tp-plug', { pluginId: 'tp-plug', version: '1.0.0', entry: { rendererScript: 'r.js' } }).ok, false);
    assert.equal(tp.revokePlugin(tpCtx, 'tp-plug').ok, false);

    // 2. portal-arbiter full modes & error isolation
    const paDisabled = createPortalArbiter({});
    assert.equal(paDisabled.install().mode, 'DISABLED');
    const paNoIpc = createPortalArbiter({ portalBridge: { channel: 'portal:set' } });
    assert.equal(paNoIpc.install().mode, 'PORTAL_ARBITER_DEGRADED_LOCAL');
    const paArmed = createPortalArbiter({ ipcMain: { handle() {}, removeHandler() {} }, portalBridge: { channel: 'portal:set' } });
    paArmed.install();
    assert.equal(paArmed.install().mode, 'ARMED');
    assert.equal(paArmed.setPluginClaim(null, 'c1', true).ok, false);
    assert.equal(paArmed.setPluginClaim({ id: 1, mainFrame: {} }, 'c1', true).mode, 'PORTAL_ARBITER_DEGRADED_LOCAL');

    let throwOnHandle = false;
    const ipcMock = {
      map: new Map(),
      handle(ch, fn) { if (throwOnHandle) throw new Error('ALREADY_REG'); this.map.set(ch, fn); },
      removeHandler(ch) { this.map.delete(ch); },
    };
    const paActive = createPortalArbiter({ ipcMain: ipcMock, portalBridge: { channel: 'portal:ch' } });
    paActive.install();
    ipcMock.handle('other:ch', () => 'ok');
    let nativeThrow = false;
    let nativeAsyncReject = false;
    ipcMock.handle('portal:ch', (_ev, open) => {
      if (nativeThrow) throw new Error('NATIVE_SYNC');
      if (nativeAsyncReject) return Promise.reject(new Error('NATIVE_ASYNC'));
      return open;
    });
    const wcEvs = new Map();
    const fakeWc = {
      id: 77,
      mainFrame: {},
      isDestroyed: () => false,
      on(e, fn) { wcEvs.set(e, fn); },
      once(e, fn) { wcEvs.set(e, fn); },
    };
    paActive.attachWebContentsLifecycle(fakeWc);
    ipcMock.map.get('portal:ch')({ sender: fakeWc }, true);
    paActive.setPluginClaim(fakeWc, 'c1', true);
    nativeThrow = true;
    paActive.setPluginClaim(fakeWc, 'c2', true);
    nativeThrow = false;
    nativeAsyncReject = true;
    paActive.setPluginClaim(fakeWc, 'c2', false);
    nativeAsyncReject = false;
    wcEvs.get('did-navigate')();
    wcEvs.get('render-process-gone')();
    wcEvs.get('destroyed')();
    assert.equal(paActive.revokeAllPluginClaims('not-num').ok, false);
    assert.ok(paActive.getStatus().channel === 'portal:ch');
    ipcMock.removeHandler('portal:ch');
    assert.equal(paActive.getStatus().mode, 'PORTAL_ARBITER_DEGRADED_LOCAL');
    throwOnHandle = true;
    assert.throws(() => ipcMock.handle('portal:ch', () => {}));
    paActive.dispose();

    // 3. host-origin-resolver all edge/security guards
    assert.equal(isAllowedRendererUrl('', {}), false);
    assert.equal(isAllowedRendererUrl('not a url', {}), false);
    assert.equal(isAllowedRendererUrl('https://127.0.0.1:443/', { strictWindowOrigin: true, windowOrigin: 'https://127.0.0.1' }), true);
    assert.equal(isAllowedRendererUrl('https://localhost:3000/', { strictWindowOrigin: true, windowOrigin: 'https://127.0.0.1', devUrlOrigin: 'https://localhost:3000' }), true);
    assert.equal(isAllowedRendererUrl('https://localhost:4000/', { strictWindowOrigin: true, windowOrigin: 'https://127.0.0.1' }), false);

    const defSess = { name: 'default' };
    const hor = createHostOriginResolver({
      profile: { allowedUrlProtocols: ['https:'], allowedUrlHosts: ['127.0.0.1'], defaultSessionOnly: true },
      getDefaultSession: () => defSess,
      devUrl: 'https://localhost:5173',
    });
    assert.equal(hor.isSessionAllowed(null), false);
    assert.equal(hor.verifyFrameEvent({}).reason, 'ERR_MISSING_SENDER_OR_FRAME');
    assert.equal(hor.verifyFrameEvent({ sender: { isDestroyed: () => true }, senderFrame: {} }).reason, 'ERR_SENDER_DESTROYED');
    assert.equal(hor.verifyFrameEvent({ sender: { id: 1, session: {} }, senderFrame: {} }).reason, 'ERR_DISALLOWED_SESSION');
    const mf = { url: 'https://127.0.0.1:8080/', origin: 'https://127.0.0.1:8080' };
    const wcOk = { id: 10, session: defSess, mainFrame: mf, isDestroyed: () => false };
    assert.equal(hor.verifyFrameEvent({ sender: wcOk, senderFrame: { url: 'https://127.0.0.1:8080/' } }).reason, 'ERR_NOT_MAIN_FRAME');
    const subMf = { url: 'https://127.0.0.1:8080/', parent: {} };
    assert.equal(hor.verifyFrameEvent({ sender: { id: 11, session: defSess, mainFrame: subMf }, senderFrame: subMf }).reason, 'ERR_SUBFRAME_OR_DETACHED');
    const badUrlMf = { url: 'https://evil.example.com/' };
    assert.equal(hor.verifyFrameEvent({ sender: { id: 12, session: defSess, mainFrame: badUrlMf }, senderFrame: badUrlMf }).reason, 'ERR_DISALLOWED_FRAME_URL');
    const opqMf = { url: 'https://127.0.0.1:8080/', origin: 'null' };
    assert.equal(hor.verifyFrameEvent({ sender: { id: 13, session: defSess, mainFrame: opqMf }, senderFrame: opqMf }).reason, 'ERR_OPAQUE_FRAME_ORIGIN');
    const misMf = { url: 'https://127.0.0.1:8080/', origin: 'https://127.0.0.1:9999' };
    assert.equal(hor.verifyFrameEvent({ sender: { id: 14, session: defSess, mainFrame: misMf }, senderFrame: misMf }).reason, 'ERR_FRAME_ORIGIN_MISMATCH');

    const v1 = hor.verifyFrameEvent({ sender: wcOk, senderFrame: mf });
    assert.equal(v1.ok, true);
    assert.equal(hor.verifyClaimedEvent({ sender: wcOk, senderFrame: mf }, v1.docGenId).reason, 'ERR_BRIDGE_NOT_CLAIMED_FOR_GENERATION');
    assert.equal(hor.consumeClaimNonce({ sender: wcOk, senderFrame: mf }, 123).reason, 'ERR_INVALID_NONCE');
    assert.equal(hor.consumeClaimNonce({ sender: wcOk, senderFrame: mf }, 'short').reason, 'ERR_INVALID_NONCE');
    const nonce = hor.getState(10).activeNonce;
    assert.equal(hor.consumeClaimNonce({ sender: wcOk, senderFrame: mf }, '0'.repeat(nonce.length)).reason, 'ERR_NONCE_MISMATCH');
    assert.equal(hor.consumeClaimNonce({ sender: wcOk, senderFrame: mf }, nonce).ok, true);
    assert.equal(hor.consumeClaimNonce({ sender: wcOk, senderFrame: mf }, nonce).reason, 'ERR_NONCE_ALREADY_CONSUMED_OR_MISSING');
    assert.equal(hor.verifyClaimedEvent({ sender: wcOk, senderFrame: mf }, 9999).reason, 'ERR_STALE_DOCUMENT_GENERATION');
    // Origin rotation on new port
    const mf2 = { url: 'https://127.0.0.1:8081/', origin: 'https://127.0.0.1:8081' };
    wcOk.mainFrame = mf2;
    const v2 = hor.verifyFrameEvent({ sender: wcOk, senderFrame: mf2 });
    assert.equal(v2.docGenId, v1.docGenId + 1);
    hor.clearWebContents(10);

    // 4. electron-host-profile-port all validation guards
    const base = { ...ANTIGRAVITY_HOST_PROFILE };
    assert.equal(validateElectronHostProfile({ ...base, patchMarker: '' }).reason, 'MISSING_ELECTRON_PROFILE_FIELD:patchMarker');
    assert.equal(validateElectronHostProfile({ ...base, loaderEnvVar: '  ' }).reason, 'INVALID_LOADER_ENV_VAR');
    assert.equal(validateElectronHostProfile({ ...base, patchMarker: 'A\nB' }).reason, 'INVALID_PATCH_MARKER_NEWLINE');
    assert.equal(validateElectronHostProfile({ ...base, mainAnchorReplacement: 'no-marker' }).reason, 'INVALID_MAIN_ANCHOR_REPLACEMENT_MISSING_MARKER');
    assert.equal(validateElectronHostProfile({ ...base, mainAnchorReplacement: base.patchMarker + ' process.env.X' }).reason, 'ERR_ANCHOR_ENV_OVERRIDE_FORBIDDEN');
    assert.equal(validateElectronHostProfile({ ...base, isolatedWorldId: 0 }).reason, 'INVALID_ISOLATED_WORLD_ID');
    assert.equal(validateElectronHostProfile({ ...base, isolatedWorldId: 999 }).reason, 'ERR_RESERVED_PRELOAD_WORLD_999');
    assert.equal(validateElectronHostProfile({ ...base, priorHostMarkers: ['bad\nmarker'] }).reason, 'INVALID_PRIOR_HOST_MARKERS');
    assert.equal(validateElectronHostProfile({ ...base, legacyPatchMarkers: 'not-arr' }).reason, 'INVALID_LEGACY_PATCH_MARKERS');
    assert.equal(validateElectronHostProfile({ ...base, windowOrigin: 'ftp://bad' }).reason, 'INVALID_WINDOW_ORIGIN');
    assert.equal(validateElectronHostProfile({ ...base, defaultSessionOnly: 'yes' }).reason, 'INVALID_DEFAULT_SESSION_ONLY');
    assert.equal(validateElectronHostProfile({ ...base, portalBridge: { channel: '' } }).reason, 'INVALID_PORTAL_BRIDGE');
    assert.equal(validateElectronHostProfile({ ...base, extraNoTranslateAttributes: ['bad attr!'] }).reason, 'INVALID_EXTRA_NO_TRANSLATE_ATTRIBUTES');
    assert.equal(validateElectronHostProfile({ ...base, allowedUrlHosts: [''] }).reason, 'INVALID_ALLOWED_URL_HOSTS');
    assert.equal(validateElectronHostProfile({ ...base, allowedUrlProtocols: ['invalid'] }).reason, 'INVALID_ALLOWED_URL_PROTOCOLS');
    assert.equal(validateElectronHostProfile({ ...base, uiAnchors: [] }).reason, 'INVALID_UI_ANCHORS');
    assert.equal(validateElectronHostProfile({ ...base, uiAnchors: { 'BAD KEY': ['div'] } }).ok, false);
    assert.throws(() => assertValidElectronHostProfile({ ...base, isolatedWorldId: 999 }));
    assert.equal(validateResolvedElectronPaths(null).reason, 'INVALID_RESOLVED_PATHS_OBJECT');
    assert.equal(validateResolvedElectronPaths({}).ok, false);
    assert.throws(() => assertValidResolvedElectronPaths({}));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-COV90-M08: preload-registrar full lifecycle/error paths and manifest-validator edge branches', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extenra-cov90-m08-'));
  try {
    const preloadFile = path.join(tmpDir, 'preload.cjs');
    fs.writeFileSync(preloadFile, '// preload\n', 'utf8');

    // Missing preload / app not ready / unavailable API / already registered / throw / unregister
    const prNoApp = createPreloadRegistrar({ app: null, sessionModule: null, preloadPath: preloadFile });
    assert.equal((await prNoApp.ensureRegistered()).reason, 'ERR_NO_APP');
    assert.equal(prNoApp.registerNow().reason, 'ERR_APP_NOT_READY');

    let ready = false;
    const readyListeners = [];
    const fakeApp = {
      isReady: () => ready,
      whenReady: async () => { ready = true; },
      prependOnceListener: (_ev, fn) => readyListeners.push(fn),
    };
    const prMiss = createPreloadRegistrar({ app: fakeApp, sessionModule: {}, preloadPath: path.join(tmpDir, 'nope.cjs') });
    assert.equal(prMiss.registerNow().reason, 'ERR_PRELOAD_SCRIPT_MISSING');

    const prNoApi = createPreloadRegistrar({ app: { isReady: () => true }, sessionModule: { defaultSession: {} }, preloadPath: preloadFile });
    assert.equal(prNoApi.registerNow().reason, 'ERR_REGISTER_PRELOAD_API_UNAVAILABLE');

    const prAlready = createPreloadRegistrar({
      app: { isReady: () => true },
      sessionModule: {
        defaultSession: {
          getPreloadScripts: () => [{ id: 'existing-id', filePath: preloadFile }],
          registerPreloadScript: () => 'new-id',
          unregisterPreloadScript: () => { throw new Error('UNREG_ERR'); },
        },
      },
      preloadPath: preloadFile,
    });
    assert.equal(prAlready.registerNow().alreadyRegistered, true);
    assert.equal(prAlready.unregister(), false);

    const prThrow = createPreloadRegistrar({
      app: { isReady: () => true },
      sessionModule: { defaultSession: { registerPreloadScript: () => { throw new Error('REG_FAIL'); } } },
      preloadPath: preloadFile,
    });
    assert.equal(prThrow.registerNow().reason, 'ERR_PRELOAD_REGISTER_FAILED');

    let unregCalled = false;
    const prAsync = createPreloadRegistrar({
      app: fakeApp,
      sessionModule: {
        defaultSession: {
          getPreloadScripts: () => [],
          registerPreloadScript: () => 'reg-1',
          unregisterPreloadScript: () => { unregCalled = true; },
        },
      },
      preloadPath: preloadFile,
    });
    const p1 = prAsync.ensureRegistered();
    const p2 = prAsync.ensureRegistered();
    for (const fn of readyListeners) fn();
    assert.equal((await p1).ok, true);
    assert.equal((await p2).ok, true);
    assert.equal(prAsync.getStatus().registered, true);
    assert.equal(prAsync.unregister(), true);
    assert.equal(unregCalled, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
