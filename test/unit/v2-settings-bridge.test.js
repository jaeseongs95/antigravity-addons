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
