'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validateAddonManifest, isReservedSettingsFileName } = require('../../src/core/manifest-validator');
const { getPrivilegedRequirements } = require('../../src/core/trust-policy-port');
const { createSlotRegistry } = require('../../src/core/slot-registry');
const { readSettingsFileSnapshot, createSettingsBridge } = require('../../src/runtime/main/settings-bridge');
const { createRendererKernel } = require('../../src/runtime/renderer/kernel');

function makeTrustedBridgeManifest(overrides = {}) {
  return {
    schemaVersion: 2,
    pluginId: 'sample-settings-plugin',
    displayName: 'Sample Settings Plugin',
    version: '2.1.0',
    trustLevel: 'trusted',
    compatibility: {
      hostProfile: 'antigravity-desktop',
      minHostVersion: '2.1.0',
    },
    capabilities: ['renderer'],
    entry: { rendererScript: 'dist/renderer.js' },
    settingsBridge: { fileName: 'sample_settings.json' },
    isolation: { noTranslate: false, i18nSelfManaged: true, respectsNoTranslate: true },
    ...overrides,
  };
}

test('TC-V21-001: settingsBridge schema validation, trustLevel requirement, reserved filenames, and normalization', () => {
  const ok = validateAddonManifest(makeTrustedBridgeManifest(), {
    hostProfileId: 'antigravity-desktop',
    hostVersion: '2.1.0',
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.hasSettingsBridge, true);
  assert.equal(ok.requiresTrustApproval, true);
  assert.ok(ok.privilegedCapabilities.includes('settingsBridge'));
  assert.deepEqual(ok.manifest.settingsBridge, { fileName: 'sample_settings.json', maxBytes: 65536 });

  const reqs = getPrivilegedRequirements(ok.manifest);
  assert.equal(reqs.hasSettingsBridge, true);
  assert.equal(reqs.requiresTrustApproval, true);

  // Restricted or omitted trustLevel MUST fail closed
  const restricted = validateAddonManifest(makeTrustedBridgeManifest({ trustLevel: 'restricted' }), {
    hostVersion: '2.1.0',
  });
  assert.equal(restricted.ok, false);
  assert.equal(restricted.reason, 'ERR_RESTRICTED_SETTINGS_BRIDGE_FORBIDDEN');

  const omittedTrust = makeTrustedBridgeManifest();
  delete omittedTrust.trustLevel;
  const omittedRes = validateAddonManifest(omittedTrust, { hostVersion: '2.1.0' });
  assert.equal(omittedRes.ok, false);
  assert.equal(omittedRes.reason, 'ERR_RESTRICTED_SETTINGS_BRIDGE_FORBIDDEN');

  // Reserved host filenames & traversal patterns MUST be rejected
  for (const bad of [
    'trust-policy.json',
    'config.json',
    'index.json',
    'build-manifest.json',
    'package.json',
    'app.orig.json',
    'a..json',
    'con.json',
    'nul.json',
    'com1.json',
  ]) {
    assert.equal(isReservedSettingsFileName(bad), true, `Expected reserved rejection for ${bad}`);
    const res = validateAddonManifest(makeTrustedBridgeManifest({ settingsBridge: { fileName: bad } }), {
      hostVersion: '2.1.0',
    });
    assert.equal(res.ok, false, `Expected manifest failure for ${bad}`);
    assert.equal(res.reason, 'ERR_RESERVED_SETTINGS_BRIDGE_FILE');
  }

  // Path separators & out-of-range maxBytes fail schema validation
  for (const badPath of ['../secret.json', 'sub/settings.json', '/etc/passwd.json']) {
    const res = validateAddonManifest(makeTrustedBridgeManifest({ settingsBridge: { fileName: badPath } }), {
      hostVersion: '2.1.0',
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'ERR_MANIFEST_SCHEMA_INVALID');
  }

  const tooSmall = validateAddonManifest(
    makeTrustedBridgeManifest({ settingsBridge: { fileName: 'ok_settings.json', maxBytes: 512 } }),
    { hostVersion: '2.1.0' }
  );
  assert.equal(tooSmall.ok, false);
  assert.equal(tooSmall.reason, 'ERR_MANIFEST_SCHEMA_INVALID');

  const tooBig = validateAddonManifest(
    makeTrustedBridgeManifest({ settingsBridge: { fileName: 'ok_settings.json', maxBytes: 512000 } }),
    { hostVersion: '2.1.0' }
  );
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.reason, 'ERR_MANIFEST_SCHEMA_INVALID');
});

test('TC-V21-002: SlotRegistry enforces unique settingsBridge.fileName across active manifests', () => {
  const reg = createSlotRegistry();
  const m1 = validateAddonManifest(
    makeTrustedBridgeManifest({ pluginId: 'plugin-alpha', settingsBridge: { fileName: 'shared_cfg.json' } }),
    { hostVersion: '2.1.0' }
  ).manifest;
  const m2 = validateAddonManifest(
    makeTrustedBridgeManifest({ pluginId: 'plugin-beta', settingsBridge: { fileName: 'shared_cfg.json' } }),
    { hostVersion: '2.1.0' }
  ).manifest;

  assert.equal(reg.registerManifestSlots(m1).ok, true);
  const dup = reg.registerManifestSlots(m2);
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, 'ERR_DUPLICATE_SETTINGS_FILE');
  assert.equal(reg.snapshot().settingsBridgeFiles['shared_cfg.json'], 'plugin-alpha');
});

test('TC-V21-003: settings-bridge.js enforces missing, size cap, non-regular, symlink, reserved path, proto guard, and SHA-256 dedupe', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-settings-bridge-unit-'));
  try {
    // Missing file
    const missing = readSettingsFileSnapshot(tmpDir, { fileName: 'my_settings.json', maxBytes: 4096 });
    assert.equal(missing.status, 'missing');
    assert.equal(missing.data, null);
    assert.equal(missing.reason, 'ERR_SETTINGS_FILE_MISSING');

    // Directory masquerading as file
    fs.mkdirSync(path.join(tmpDir, 'dir_settings.json'));
    const dirSnap = readSettingsFileSnapshot(tmpDir, { fileName: 'dir_settings.json', maxBytes: 4096 });
    assert.equal(dirSnap.status, 'error');
    assert.equal(dirSnap.reason, 'ERR_SETTINGS_NOT_REGULAR_FILE');

    // Oversized file
    fs.writeFileSync(path.join(tmpDir, 'big_settings.json'), JSON.stringify({ pad: 'x'.repeat(2048) }), 'utf8');
    const bigSnap = readSettingsFileSnapshot(tmpDir, { fileName: 'big_settings.json', maxBytes: 1024 });
    assert.equal(bigSnap.status, 'error');
    assert.equal(bigSnap.reason, 'ERR_SETTINGS_FILE_TOO_LARGE');

    // Corrupt JSON, array JSON, and __proto__ JSON
    fs.writeFileSync(path.join(tmpDir, 'corrupt.json'), '{bad', 'utf8');
    assert.equal(readSettingsFileSnapshot(tmpDir, { fileName: 'corrupt.json' }).reason, 'ERR_SETTINGS_INVALID_JSON');

    fs.writeFileSync(path.join(tmpDir, 'arr.json'), '[1,2,3]', 'utf8');
    assert.equal(readSettingsFileSnapshot(tmpDir, { fileName: 'arr.json' }).reason, 'ERR_SETTINGS_MUST_BE_OBJECT');

    fs.writeFileSync(path.join(tmpDir, 'proto.json'), '{"__proto__":{"polluted":true}}', 'utf8');
    assert.equal(
      readSettingsFileSnapshot(tmpDir, { fileName: 'proto.json' }).reason,
      'ERR_SETTINGS_UNSAFE_PROTO_KEY'
    );

    // Runtime reservedFilePaths check
    const customReserved = path.join(tmpDir, 'custom_reserved.json');
    fs.writeFileSync(customReserved, '{"secret":true}', 'utf8');
    const resSnap = readSettingsFileSnapshot(
      tmpDir,
      { fileName: 'custom_reserved.json' },
      { reservedFilePaths: [customReserved] }
    );
    assert.equal(resSnap.status, 'error');
    assert.equal(resSnap.reason, 'ERR_SETTINGS_RESERVED_PATH');

    // Symlink rejection (when filesystem supports symlinks without elevated rights)
    const outsideFile = path.join(tmpDir, 'outside_target.txt');
    const symPath = path.join(tmpDir, 'sym_settings.json');
    fs.writeFileSync(outsideFile, '{"ok":true}', 'utf8');
    let symlinkCreated = false;
    try {
      fs.symlinkSync(outsideFile, symPath);
      symlinkCreated = true;
    } catch (_e) {}
    if (symlinkCreated) {
      const symSnap = readSettingsFileSnapshot(tmpDir, { fileName: 'sym_settings.json' });
      assert.equal(symSnap.status, 'error');
      assert.equal(symSnap.reason, 'ERR_SETTINGS_SYMLINK_FORBIDDEN');
    }

    // Bridge lifecycle: SHA-256 deduplication, monotonic revision, watcher open/close
    const pushed = [];
    const bridge = createSettingsBridge({
      settingsDataDir: tmpDir,
      debounceMs: 25,
      onSnapshotChange: (pluginId, snap) => pushed.push({ pluginId, snap }),
    });
    const cfgPath = path.join(tmpDir, 'live_cfg.json');
    fs.writeFileSync(cfgPath, '{"enabled":false,"provider":"local-llm"}', 'utf8');

    const init = bridge.readSnapshotForPlugin('p-trusted', { fileName: 'live_cfg.json', maxBytes: 4096 });
    assert.equal(init.status, 'ok');
    assert.equal(init.revision, 1);
    assert.deepEqual(init.data, { enabled: false, provider: 'local-llm' });
    assert.equal(bridge.getStatus().watcherActive, true);
    assert.equal(pushed.length, 0);

    // Same bytes -> ZERO push, revision unchanged
    fs.writeFileSync(cfgPath, '{"enabled":false,"provider":"local-llm"}', 'utf8');
    assert.equal(bridge.refreshNow(), 0);
    assert.equal(pushed.length, 0);

    // Changed bytes -> push once, revision increments to 2
    fs.writeFileSync(cfgPath, '{"enabled":true,"provider":"local-llm"}', 'utf8');
    assert.equal(bridge.refreshNow(), 1);
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].pluginId, 'p-trusted');
    assert.equal(pushed[0].snap.revision, 2);
    assert.equal(pushed[0].snap.data.enabled, true);

    // Unbinding all plugins closes watcher immediately
    bridge.syncPlugins([]);
    assert.equal(bridge.getStatus().watcherActive, false);
    assert.equal(bridge.getStatus().boundPluginCount, 0);
    bridge.dispose();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-V21-004: RendererKernel enforces hostToken auth, deep-frozen snapshots, restricted rejection, and cleanup on dispose', () => {
  const fakeDoc = {
    head: null,
    body: null,
    documentElement: null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ setAttribute() {}, remove() {} }),
  };
  const kernel = createRendererKernel(fakeDoc, {});
  const hostToken = '0123456789abcdef0123456789abcdef';
  assert.equal(kernel.boot({ docGenId: 1, hostToken }).ok, true);

  // Restricted plugin cannot subscribe to settings
  const restrictedHandle = kernel.createPluginHandle(
    { pluginId: 'p-restricted', trustLevel: 'restricted', hasSettingsBridge: true },
    hostToken,
    { status: 'ok', data: { enabled: true }, revision: 1 }
  );
  assert.equal(restrictedHandle.getSettings(), null);
  assert.throws(() => restrictedHandle.onSettingsChange(() => {}), /ERR_SETTINGS_BRIDGE_NOT_DECLARED/);
  assert.equal(kernel.pushPluginSettings('p-restricted', { status: 'ok', data: {} }, hostToken).ok, false);

  // Trusted plugin receives deep-frozen initial snapshot and authenticated live pushes
  const trustedHandle = kernel.createPluginHandle(
    { pluginId: 'p-trusted', trustLevel: 'trusted', hasSettingsBridge: true },
    hostToken,
    { status: 'ok', data: { enabled: false, nested: { mode: 'local' } }, revision: 1 }
  );
  const initSnap = trustedHandle.getSettings();
  assert.equal(initSnap.status, 'ok');
  assert.equal(initSnap.data.enabled, false);
  assert.equal(Object.isFrozen(initSnap), true);
  assert.equal(Object.isFrozen(initSnap.data), true);
  assert.equal(Object.isFrozen(initSnap.data.nested), true);
  assert.throws(() => {
    initSnap.data.enabled = true;
  }, TypeError);

  const received = [];
  const unsub = trustedHandle.onSettingsChange((snap) => received.push(snap));

  // Wrong token MUST throw ERR_FORBIDDEN_HOST_TOKEN
  assert.throws(
    () => kernel.pushPluginSettings('p-trusted', { status: 'ok', data: { enabled: true }, revision: 2 }, 'wrong-token'),
    /ERR_FORBIDDEN_HOST_TOKEN/
  );

  // Valid token delivers deep-frozen update
  const pushRes = kernel.pushPluginSettings(
    'p-trusted',
    { status: 'ok', data: { enabled: true, nested: { mode: 'remote' } }, revision: 2 },
    hostToken
  );
  assert.equal(pushRes.ok, true);
  assert.equal(pushRes.delivered, 1);
  assert.equal(received.length, 1);
  assert.equal(received[0].revision, 2);
  assert.equal(Object.isFrozen(received[0].data), true);
  assert.equal(trustedHandle.getSettings().revision, 2);

  unsub();
  kernel.pushPluginSettings('p-trusted', { status: 'ok', data: { enabled: false }, revision: 3 }, hostToken);
  assert.equal(received.length, 1);

  // Dispose removes binding
  kernel.disposePlugin('p-trusted', hostToken);
  assert.equal(kernel.pushPluginSettings('p-trusted', { status: 'ok', data: {}, revision: 4 }, hostToken).ok, false);
});

test('TC-V211-001 (I1): Multi-window readSnapshotForPlugin emits onSnapshotChange so Window 1 never starves', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-v211-i1-'));
  try {
    const cfgPath = path.join(tmpDir, 'multi_win.json');
    fs.writeFileSync(cfgPath, '{"enabled":true,"provider":"google-translate"}', 'utf8');

    const broadcasted = [];
    const bridge = createSettingsBridge({
      settingsDataDir: tmpDir,
      debounceMs: 500, // Long debounce to deterministically simulate Window 2 joining BEFORE debounce fires
      onSnapshotChange: (pluginId, snap) => broadcasted.push({ pluginId, snap }),
    });

    // Window 1 initial read establishes binding (no broadcast expected yet)
    const w1Init = bridge.readSnapshotForPlugin('ko-thought-translator', { fileName: 'multi_win.json', maxBytes: 4096 });
    assert.equal(w1Init.revision, 1);
    assert.equal(w1Init.data.enabled, true);
    assert.equal(broadcasted.length, 0);

    // File changes while Window 1 is active, BEFORE fs.watch debounce fires
    fs.writeFileSync(cfgPath, '{"enabled":false,"provider":"local-llm"}', 'utf8');

    // Window 2 joins and calls readSnapshotForPlugin before debounce fires
    const w2Init = bridge.readSnapshotForPlugin('ko-thought-translator', { fileName: 'multi_win.json', maxBytes: 4096 });
    assert.equal(w2Init.revision, 2);
    assert.equal(w2Init.data.enabled, false);

    // I1 invariant: onSnapshotChange MUST have fired for Window 1 even though readSnapshotForPlugin advanced lastKey!
    assert.equal(broadcasted.length, 1);
    assert.equal(broadcasted[0].pluginId, 'ko-thought-translator');
    assert.equal(broadcasted[0].snap.revision, 2);
    assert.equal(broadcasted[0].snap.data.enabled, false);

    // Subsequent debounce refreshNow() sees identical key -> zero duplicate broadcast
    assert.equal(bridge.refreshNow(), 0);
    assert.equal(broadcasted.length, 1);

    bridge.dispose();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-V211-002 (I2): Transient Windows EBUSY/EPERM lock retries gracefully and watcher auto-reconnects after error', async () => {
  const { EventEmitter } = require('node:events');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-v211-i2-'));
  try {
    const cfgPath = path.join(tmpDir, 'lock_test.json');
    fs.writeFileSync(cfgPath, '{"enabled":true,"provider":"local-llm"}', 'utf8');

    let remainingLockFailures = 0;
    let watchCalls = 0;
    const watchers = [];
    const fakeFs = {
      existsSync: (p) => fs.existsSync(p),
      lstatSync: (p) => fs.lstatSync(p),
      realpathSync: (p) => fs.realpathSync(p),
      fstatSync: (fd) => fs.fstatSync(fd),
      readSync: (...a) => fs.readSync(...a),
      closeSync: (fd) => fs.closeSync(fd),
      openSync: (p, flags) => {
        if (remainingLockFailures > 0) {
          remainingLockFailures -= 1;
          const err = new Error('EBUSY: resource busy or locked');
          err.code = 'EBUSY';
          throw err;
        }
        return fs.openSync(p, flags);
      },
      watch: (_dir, _opts, listener) => {
        watchCalls += 1;
        const w = new EventEmitter();
        w.close = () => {
          w.closed = true;
        };
        w.trigger = () => listener('change', 'lock_test.json');
        watchers.push(w);
        return w;
      },
    };

    const events = [];
    const bridge = createSettingsBridge({
      settingsDataDir: tmpDir,
      debounceMs: 15,
      transientRetryDelaysMs: [15, 20],
      postErrorRetryDelaysMs: [25],
      watcherReconnectBaseMs: 20,
      watcherReconnectMaxMs: 40,
      fsImpl: fakeFs,
      onSnapshotChange: (pluginId, snap) => events.push({ pluginId, snap }),
    });

    const init = bridge.readSnapshotForPlugin('p-lock', { fileName: 'lock_test.json', maxBytes: 4096 });
    assert.equal(init.status, 'ok');
    assert.equal(watchCalls, 1);

    // 1. Transient lock (1 EBUSY then succeeds on retry) -> MUST NOT trip Fail-Closed!
    fs.writeFileSync(cfgPath, '{"enabled":false,"provider":"local-llm"}', 'utf8');
    remainingLockFailures = 1;
    assert.equal(bridge.refreshNow(), 0, 'Transient lock deferred during grace retry');
    assert.equal(events.length, 0, 'Must not immediately emit error on 1st EBUSY');

    await new Promise((r) => setTimeout(r, 70));
    assert.equal(events.length, 1);
    assert.equal(events[0].snap.status, 'ok');
    assert.equal(events[0].snap.data.enabled, false);

    // 2. Sustained lock exceeding grace retries (3 EBUSY) -> MUST Fail-Closed, then self-heal on post-error recheck!
    remainingLockFailures = 3;
    bridge.refreshNow();
    await new Promise((r) => setTimeout(r, 140));
    assert.ok(events.some((e) => e.snap.status === 'error' && e.snap.reason === 'ERR_SETTINGS_READ_FAILED'));
    assert.equal(events[events.length - 1].snap.status, 'ok', 'Self-healed back to ok once lock cleared');

    // 3. Watcher emits error -> MUST close and auto-reconnect + refresh missed edits
    fs.writeFileSync(cfgPath, '{"enabled":true,"provider":"google-translate"}', 'utf8');
    watchers[0].emit('error', new Error('EPERM watch handle lost'));
    assert.equal(bridge.getStatus().watcherActive, false);
    assert.equal(bridge.getStatus().watcherReconnectPending, true);

    await new Promise((r) => setTimeout(r, 80));
    assert.equal(watchCalls, 2, 'Watcher must reconnect automatically after error');
    assert.equal(bridge.getStatus().watcherActive, true);
    assert.equal(events[events.length - 1].snap.data.provider, 'google-translate');

    bridge.dispose();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-V211-003 (I4 + I10): Kernel resists World 998 prototype tampering, gates invokeAction by trustLevel, and runs onDispose before marking disposed', () => {
  const removedStyles = [];
  const fakeDoc = {
    head: { appendChild() {} },
    body: { appendChild() {} },
    documentElement: null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({
      id: '',
      textContent: '',
      setAttribute() {},
      remove() {
        removedStyles.push(this.id);
      },
    }),
  };
  const kernel = createRendererKernel(fakeDoc, {});
  const hostToken = 'fedcba9876543210fedcba9876543210';
  assert.equal(kernel.boot({ docGenId: 1, hostToken }).ok, true);

  // Register trusted plugin + action + onDispose calling removeStyle (I10)
  const trustedStage = kernel.stagePluginHandle(
    { pluginId: 'p-trusted', trustLevel: 'trusted', hasSettingsBridge: true },
    hostToken,
    { status: 'ok', data: { enabled: true, provider: 'local-llm' }, revision: 1 }
  );
  const trustedHandle = kernel.consumeStagedHandle(trustedStage.runNonce);
  let trustedActionRuns = 0;
  trustedHandle.registerAction('secret-op', {
    label: 'Secret Op',
    run: () => {
      trustedActionRuns += 1;
      return 'SECRET_OK';
    },
  });
  trustedHandle.injectStyle('s-own', '[data-addon-host-owner="p-trusted"][data-addon-host-slot="main"] { color: red; }');
  let onDisposeError = null;
  trustedHandle.onDispose(() => {
    try {
      trustedHandle.removeStyle('s-own');
    } catch (err) {
      onDisposeError = err;
    }
  });

  // Register restricted plugin
  const restrictedStage = kernel.stagePluginHandle(
    { pluginId: 'p-restricted', trustLevel: 'restricted', hasSettingsBridge: false },
    hostToken,
    null
  );
  const restrictedHandle = kernel.consumeStagedHandle(restrictedStage.runNonce);
  restrictedHandle.registerAction('public-op', {
    label: 'Public Op',
    run: () => 'PUBLIC_OK',
  });

  // I4: restricted plugin cannot list or invoke trusted plugin actions
  const restrictedList = restrictedHandle.listActions();
  assert.equal(restrictedList.some((a) => a.pluginId === 'p-trusted'), false);
  assert.equal(restrictedList.some((a) => a.pluginId === 'p-restricted'), true);
  assert.throws(
    () => restrictedHandle.invokeAction('p-trusted', 'secret-op'),
    /ERR_ACTION_TRUST_FORBIDDEN/
  );
  assert.equal(trustedActionRuns, 0);

  // Trusted plugin CAN still invoke restricted plugin actions and its own actions
  assert.equal(trustedHandle.invokeAction('p-restricted', 'public-op'), 'PUBLIC_OK');
  assert.equal(trustedHandle.invokeAction('p-trusted', 'secret-op'), 'SECRET_OK');

  // I4: Prototype tampering by restricted plugin MUST NOT hijack stagedHandles or deepFreezeClone
  const origMapGet = Map.prototype.get;
  const origMapSet = Map.prototype.set;
  const origObjFreeze = Object.freeze;
  const origObjKeys = Object.keys;
  let hijackAttempts = 0;
  try {
    Map.prototype.get = function () {
      hijackAttempts += 1;
      return undefined;
    };
    Map.prototype.set = function () {
      hijackAttempts += 1;
      return this;
    };
    Object.freeze = (o) => {
      hijackAttempts += 1;
      return o;
    };
    Object.keys = () => {
      hijackAttempts += 1;
      return [];
    };

    const pushRes = kernel.pushPluginSettings(
      'p-trusted',
      { status: 'ok', data: { enabled: false, provider: 'local-llm' }, revision: 2 },
      hostToken
    );
    assert.equal(pushRes.ok, true);
    const snap = trustedHandle.getSettings();
    assert.equal(snap.revision, 2);
    assert.equal(snap.data.enabled, false);
    assert.equal(Object.isFrozen(snap.data), true);
    assert.equal(hijackAttempts, 0, 'Kernel must use captured primordials, zero tampered prototype calls');
  } finally {
    Map.prototype.get = origMapGet;
    Map.prototype.set = origMapSet;
    Object.freeze = origObjFreeze;
    Object.keys = origObjKeys;
  }

  // I10: disposePlugin runs onDispose BEFORE marking handle disposed so removeStyle succeeds cleanly
  kernel.disposePlugin('p-trusted', hostToken);
  assert.equal(onDisposeError, null, 'removeStyle inside onDispose must not throw ERR_PLUGIN_HANDLE_DISPOSED');
  assert.throws(() => trustedHandle.listActions(), /ERR_PLUGIN_HANDLE_DISPOSED/);
});

test('TC-V211-004 (I10): style-manager preserves [attr] ownerPrefix and host-loader-builder emits dynamic version comment', () => {
  const { scopeCssToOwner } = require('../../src/runtime/renderer/style-manager');
  const { buildHostLoaderScriptSource } = require('../../src/adapters/electron/host-loader-builder');
  const { ANTIGRAVITY_HOST_PROFILE } = require('../../src/profiles/antigravity');

  const scoped = scopeCssToOwner(
    'ko-thought-translator',
    '[data-addon-host-owner="ko-thought-translator"][data-addon-host-slot="main"] { color: green; }'
  );
  assert.equal(
    scoped.includes('[data-addon-host-owner="ko-thought-translator"] [data-addon-host-owner="ko-thought-translator"]'),
    false,
    'Owner-prefixed attribute selector must not be double-prefixed'
  );

  const shim = buildHostLoaderScriptSource(
    {
      ADDONS_DIR: '/tmp/addons.d',
      PLUGINS_ROOT_DIR: '/tmp/plugins',
      CONFIG_JSON_PATH: '/tmp/config.json',
      TRUST_POLICY_PATH: '/tmp/trust-policy.json',
    },
    ANTIGRAVITY_HOST_PROFILE,
    {
      hostVersion: '2.1.1',
      buildSha8: '12345678',
    }
  );
  assert.match(shim, /Auto-generated thin v2\.1\.1 entry shim/);
});
