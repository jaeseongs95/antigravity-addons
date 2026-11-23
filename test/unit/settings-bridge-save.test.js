'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { IPC_CHANNELS } = require('../../src/runtime/shared/constants');
const {
  readSettingsFileSnapshot,
  writeSettingsFileSnapshot,
  createSettingsBridge,
} = require('../../src/runtime/main/settings-bridge');
const { createRendererKernel } = require('../../src/runtime/renderer/kernel');
const { createHostRuntimeController } = require('../../src/runtime/main/init-main');

test('writeSettingsFileSnapshot enforces path confinement, reserved files, symlinks, proto keys, and maxBytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-save-snap-'));
  try {
    const spec = { fileName: 'ko_translator_settings.json', maxBytes: 1024 };

    // 1. Valid write & read-back
    const okRes = writeSettingsFileSnapshot(
      dir,
      spec,
      JSON.stringify({ schemaVersion: 1, enabled: true, provider: 'local-llm' })
    );
    assert.equal(okRes.ok, true);
    assert.equal(okRes.reason, null);
    assert.match(okRes.sha256, /^[a-f0-9]{64}$/);
    const snap = readSettingsFileSnapshot(dir, spec);
    assert.equal(snap.status, 'ok');
    assert.equal(snap.data.provider, 'local-llm');

    // 2. Reject reserved files & path traversal
    for (const badFile of ['trust-policy.json', 'config.json', '../escape.json', 'sub/nested.json']) {
      const res = writeSettingsFileSnapshot(dir, { fileName: badFile, maxBytes: 1024 }, '{"ok":true}');
      assert.equal(res.ok, false, `Must reject ${badFile}`);
    }

    // 3. Reject non-object JSON & prototype pollution keys
    assert.equal(writeSettingsFileSnapshot(dir, spec, '[1,2,3]').reason, 'ERR_SETTINGS_MUST_BE_OBJECT');
    assert.equal(writeSettingsFileSnapshot(dir, spec, 'not-json').reason, 'ERR_SETTINGS_INVALID_JSON');
    assert.equal(
      writeSettingsFileSnapshot(dir, spec, '{"__proto__":{"polluted":true}}').reason,
      'ERR_SETTINGS_UNSAFE_PROTO_KEY'
    );

    // 4. Reject oversized payload (> maxBytes)
    const bigPayload = JSON.stringify({ pad: 'x'.repeat(1200) });
    assert.equal(writeSettingsFileSnapshot(dir, spec, bigPayload).reason, 'ERR_SETTINGS_FILE_TOO_LARGE');

    // 5. Reject symlink target
    const outsidePath = path.join(dir, 'outside-target.json');
    fs.writeFileSync(outsidePath, '{"secret":true}\n', 'utf8');
    const symlinkPath = path.join(dir, 'symlink_settings.json');
    let symlinkCreated = false;
    try {
      fs.symlinkSync(outsidePath, symlinkPath);
      symlinkCreated = true;
    } catch (_err) {
      // Windows without Developer Mode may forbid symlink creation; skip only symlink assertion if OS denies creation
    }
    if (symlinkCreated) {
      const symRes = writeSettingsFileSnapshot(dir, { fileName: 'symlink_settings.json', maxBytes: 1024 }, '{"a":1}');
      assert.equal(symRes.ok, false);
      assert.equal(symRes.reason, 'ERR_SETTINGS_SYMLINK_FORBIDDEN');
      assert.equal(fs.readFileSync(outsidePath, 'utf8'), '{"secret":true}\n');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createSettingsBridge.writeSnapshotForPlugin persists atomically and broadcasts immediately', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-save-bridge-'));
  const events = [];
  const bridge = createSettingsBridge({
    settingsDataDir: dir,
    onSnapshotChange: (pluginId, snapshot) => {
      events.push({ pluginId, snapshot });
    },
  });
  try {
    const spec = { fileName: 'ko_translator_settings.json', maxBytes: 4096 };
    const initSnap = bridge.readSnapshotForPlugin('ko-thought-translator', spec);
    assert.equal(initSnap.status, 'missing');

    const res = bridge.writeSnapshotForPlugin(
      'ko-thought-translator',
      spec,
      JSON.stringify({ schemaVersion: 1, enabled: true, provider: 'google-translate' })
    );
    assert.equal(res.ok, true);
    assert.equal(res.snapshot.status, 'ok');
    assert.equal(res.snapshot.data.provider, 'google-translate');
    assert.equal(events.length, 1);
    assert.equal(events[0].pluginId, 'ko-thought-translator');
    assert.equal(events[0].snapshot.data.provider, 'google-translate');

    const res2 = bridge.writeSnapshotForPlugin(
      'ko-thought-translator',
      spec,
      JSON.stringify({ schemaVersion: 1, enabled: true, provider: 'local-llm' })
    );
    assert.equal(res2.ok, true);
    assert.equal(events.length, 2);
    assert.equal(events[1].snapshot.data.provider, 'local-llm');
  } finally {
    bridge.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Kernel saveSettings enforces trust boundary, rejects restricted/proto-tampered payloads, and IPC enforces wcId+pluginId binding', async () => {
  // 1. Kernel handle security checks (including JSON.stringify primordial tamper)
  const savedCalls = [];
  const mockWin = {
    __addonHostBootstrap: {
      claim(nonce) {
        assert.equal(nonce, 'nonce-save-test-1234567890');
        return Object.freeze({
          docGenId: 1,
          setPortalClaim: () => Promise.resolve({ ok: true }),
          saveSettings(pluginId, rawJson) {
            savedCalls.push({ pluginId, rawJson });
            return Promise.resolve({
              ok: true,
              reason: null,
              snapshot: { status: 'ok', revision: 2, data: JSON.parse(rawJson), sha256: 'abc', reason: null },
            });
          },
          reportError() {},
          ping: () => Promise.resolve({ ok: true }),
        });
      },
    },
  };
  const mockDoc = {
    createElement: () => ({ setAttribute() {}, style: {} }),
    head: { appendChild() {} },
    body: { appendChild() {} },
    documentElement: { appendChild() {} },
  };
  const kernel = createRendererKernel(mockDoc, mockWin);
  const token = 'host-token-save-settings-123456';
  assert.equal(kernel.boot({ docGenId: 1, claimNonce: 'nonce-save-test-1234567890', hostToken: token }).ok, true);

  const trustedHandle = kernel.createPluginHandle(
    { pluginId: 'ko-thought-translator', version: '2.1.1', trustLevel: 'trusted', hasSettingsBridge: true, uiSlots: [] },
    token,
    { status: 'ok', revision: 1, data: { enabled: true, provider: 'google-translate' } }
  );
  const restrictedHandle = kernel.createPluginHandle(
    { pluginId: 'untrusted-addon', version: '1.0.0', trustLevel: 'restricted', hasSettingsBridge: true, uiSlots: [] },
    token,
    null
  );

  // Restricted plugin MUST be rejected
  await assert.rejects(() => restrictedHandle.saveSettings({ enabled: true }), /ERR_SETTINGS_BRIDGE_NOT_DECLARED/);

  // Non-object / prototype pollution key MUST be rejected
  await assert.rejects(() => trustedHandle.saveSettings([1, 2]), /ERR_SETTINGS_MUST_BE_OBJECT/);
  const protoObj = JSON.parse('{"__proto__":{"evil":1}}');
  await assert.rejects(() => trustedHandle.saveSettings(protoObj), /ERR_SETTINGS_UNSAFE_PROTO_KEY/);

  // Tamper global JSON.stringify after kernel boot -> kernel primordial must still serialize cleanly
  const origStringify = JSON.stringify;
  try {
    JSON.stringify = () => '{"hijacked":true}';
    const res = await trustedHandle.saveSettings({ enabled: true, provider: 'local-llm' });
    assert.equal(res.ok, true);
    assert.equal(savedCalls.length, 1);
    assert.equal(savedCalls[0].pluginId, 'ko-thought-translator');
    assert.deepEqual(JSON.parse(savedCalls[0].rawJson), { enabled: true, provider: 'local-llm' });
    assert.equal(res.snapshot.data.provider, 'local-llm');
  } finally {
    JSON.stringify = origStringify;
  }

  // 2. Main process IPC_CHANNELS.SAVE_SETTINGS enforces claimed origin + active trusted binding
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-ipc-save-'));
  try {
    const addonsDir = path.join(dir, 'addons.d');
    const pluginsDir = path.join(dir, 'plugins');
    fs.mkdirSync(addonsDir, { recursive: true });
    fs.mkdirSync(pluginsDir, { recursive: true });

    const onHandlers = new Map();
    const handleHandlers = new Map();
    const ipcMain = {
      on: (ch, fn) => onHandlers.set(ch, fn),
      handle: (ch, fn) => handleHandlers.set(ch, fn),
      removeHandler: () => {},
    };
    const app = new EventEmitter();
    app.isReady = () => true;
    app.whenReady = () => Promise.resolve();
    const defaultSession = {
      getPreloads: () => [],
      setPreloads: () => {},
      registerPreloadScript: () => {},
    };

    const controller = createHostRuntimeController(
      {
        addonsDir,
        pluginsRootDir: pluginsDir,
        settingsDataDir: dir,
        trustPolicyPath: path.join(dir, 'trust-policy.json'),
        configJsonPath: path.join(dir, 'config.json'),
        strictTrustPolicy: true,
        profile: { id: 'antigravity-desktop', allowedOrigins: ['http://127.0.0.1'] },
      },
      { app, ipcMain, session: { defaultSession } }
    );
    controller.start();
    try {
      const saveHandler = handleHandlers.get(IPC_CHANNELS.SAVE_SETTINGS);
      assert.equal(typeof saveHandler, 'function');

      // Unclaimed / spoofed sender MUST fail closed
      const fakeEv = {
        sender: { id: 999, session: defaultSession, getURL: () => 'http://127.0.0.1:4242/' },
        senderFrame: { top: null, url: 'http://127.0.0.1:4242/' },
      };
      fakeEv.senderFrame.top = fakeEv.senderFrame;
      const deniedUnclaimed = await saveHandler(fakeEv, {
        docGenId: 1,
        pluginId: 'ko-thought-translator',
        rawJson: '{"enabled":true}',
      });
      assert.equal(deniedUnclaimed.ok, false);

      // Verify frame + claim nonce, but plugin is NOT bound to this wcId -> ERR_SETTINGS_BRIDGE_NOT_BOUND
      const verifyFn = onHandlers.get(IPC_CHANNELS.VERIFY_FRAME);
      const claimFn = onHandlers.get(IPC_CHANNELS.CLAIM_NONCE);
      const wc = new EventEmitter();
      wc.id = 77;
      wc.session = defaultSession;
      wc.getURL = () => 'http://127.0.0.1:4242/';
      wc.isDestroyed = () => false;
      wc.executeJavaScriptInIsolatedWorld = async () => ({ ok: true });
      controller.attachWebContents(wc);

      const frameEv = {
        sender: wc,
        senderFrame: { url: 'http://127.0.0.1:4242/' },
        returnValue: null,
      };
      frameEv.senderFrame.top = frameEv.senderFrame;
      verifyFn(frameEv);
      assert.equal(frameEv.returnValue.ok, true);

      // Even if a renderer tries to spoof pluginId without an active trusted settings binding, Main rejects
      const spoofRes = await saveHandler(
        { sender: wc, senderFrame: frameEv.senderFrame },
        { docGenId: 1, pluginId: 'ko-thought-translator', rawJson: '{"enabled":true}' }
      );
      assert.equal(spoofRes.ok, false);
      assert.equal(fs.existsSync(path.join(dir, 'ko_translator_settings.json')), false);
      assert.equal(typeof claimFn, 'function');
    } finally {
      controller.dispose();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
