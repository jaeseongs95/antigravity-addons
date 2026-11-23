'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { normalizeManifestToV2 } = require('../../src/core/manifest-normalizer');
const { validateAddonManifest } = require('../../src/core/manifest-validator');
const {
  snapshotPluginBundleInMemory,
  loadVerifiedMainHookModule,
  readVerifiedRendererScript,
  sha256Hex,
} = require('../../src/runtime/main/trust-verifier');
const { createPortalArbiter } = require('../../src/runtime/main/portal-arbiter');
const {
  installAsarAddonHost,
  rollbackAsarAddonHost,
  isAsarHostInstalled,
  pruneBackups,
} = require('../../src/adapters/electron/asar-patcher');
const { ANTIGRAVITY_HOST_PROFILE } = require('../../src/profiles/antigravity');
const { createElectronHostLifecyclePort } = require('../../src/adapters/electron/electron-host-lifecycle-port');
const { createElectronAddonStorePort } = require('../../src/adapters/electron/electron-addon-store-port');
const {
  buildNodeOptionsWithRequire,
  scrubOwnRequireFromNodeOptions,
  buildUnpackagedBootstrapSource,
  createEnvLauncherTransport,
} = require('../../src/adapters/electron/env-launcher-transport');
const { createElectronTrustPolicyPort } = require('../../src/adapters/electron/trust-policy-store');

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'addon-host.js');

function buildSyntheticAsar(asarPath, { version = '2.34.0', extraLines = [], anchorReplacement = null } = {}) {
  const pkgJsonBuf = Buffer.from(JSON.stringify({ name: 'antigravity', version }), 'utf8');
  const lines = [
    '// synthetic header padding 01 ----------------------------------------------------------',
    '// synthetic header padding 02 ----------------------------------------------------------',
    '// synthetic header padding 03 ----------------------------------------------------------',
    '// synthetic header padding 04 ----------------------------------------------------------',
    '// synthetic header padding 05 ----------------------------------------------------------',
    '// synthetic header padding 06 ----------------------------------------------------------',
    '// synthetic header padding 07 ----------------------------------------------------------',
    '// synthetic header padding 08 ----------------------------------------------------------',
    '// synthetic header padding 09 ----------------------------------------------------------',
    '// synthetic header padding 10 ----------------------------------------------------------',
    '// synthetic header padding 11 ----------------------------------------------------------',
    '// synthetic header padding 12 ----------------------------------------------------------',
    ...extraLines,
    anchorReplacement || ANTIGRAVITY_HOST_PROFILE.mainAnchorTarget,
    '  void contents;',
    '});',
    'electron_1.app.whenReady().then(() => {});',
  ];
  const mainBuf = Buffer.from(lines.join('\n') + '\n', 'utf8');
  const headerObj = {
    files: {
      'package.json': { size: pkgJsonBuf.length, offset: '0' },
      dist: {
        files: {
          'main.js': { size: mainBuf.length, offset: String(pkgJsonBuf.length) },
        },
      },
    },
  };
  const headerJsonBuf = Buffer.from(JSON.stringify(headerObj), 'utf8');
  const pad = (4 - (headerJsonBuf.length % 4)) % 4;
  const paddedHeaderLen = headerJsonBuf.length + pad;
  const headerBuf = Buffer.concat([headerJsonBuf, Buffer.alloc(pad)]);

  const preamble = Buffer.alloc(16);
  preamble.writeUInt32LE(4, 0);
  preamble.writeUInt32LE(paddedHeaderLen + 8, 4);
  preamble.writeUInt32LE(paddedHeaderLen + 4, 8);
  preamble.writeUInt32LE(headerJsonBuf.length, 12);

  const out = Buffer.concat([preamble, headerBuf, pkgJsonBuf, mainBuf]);
  fs.writeFileSync(asarPath, out);
  return out;
}

test('TC-V2-001: normalizeManifestToV2 enforces v1 light-DOM default, v2 Shadow DOM default, and document-transform shadow:false', () => {
  const v1 = normalizeManifestToV2({
    schemaVersion: 1,
    pluginId: 'legacy-bar',
    displayName: 'Legacy Bar',
    version: '1.0.0',
    capabilities: ['renderer'],
    entry: { rendererScript: 'r.js', mainHookScript: null },
    uiSlots: [{ slot: 'status-bar', slotId: 'legacy.bar' }],
    isolation: { noTranslate: true, i18nSelfManaged: true },
  });
  assert.equal(v1.schemaVersion, 2);
  assert.equal(v1.sourceSchemaVersion, 1);
  assert.equal(v1.uiSlots[0].shadow, false, 'v1 manifests default shadow: false');

  const v2 = normalizeManifestToV2({
    schemaVersion: 2,
    pluginId: 'modern-panel',
    displayName: 'Modern Panel',
    version: '2.0.0',
    trustLevel: 'trusted',
    capabilities: ['renderer'],
    entry: { rendererScript: 'r.js' },
    uiSlots: [
      { slot: 'overview-pane', slotId: 'modern.panel' },
      { slot: 'document-transform', slotId: 'modern.doc', scope: 'native-host-only', shadow: true },
    ],
    isolation: { noTranslate: true, i18nSelfManaged: true },
  });
  assert.equal(v2.schemaVersion, 2);
  assert.equal(v2.sourceSchemaVersion, 2);
  assert.equal(v2.uiSlots[0].shadow, true, 'v2 UI slots default shadow: true');
  assert.equal(v2.uiSlots[1].shadow, false, 'document-transform MUST always force shadow: false');

  const val = validateAddonManifest({
    schemaVersion: 2,
    pluginId: 'modern-v2-ui',
    displayName: 'Modern V2 UI',
    version: '2.0.0',
    capabilities: ['renderer'],
    entry: { rendererScript: 'r.js' },
    uiSlots: [{ slot: 'overview-pane', slotId: 'modern-v2-ui.pane', anchor: 'overview-pane', shadow: true }],
    isolation: { noTranslate: true, i18nSelfManaged: true },
    loadOrder: 10,
  });
  assert.equal(val.ok, true);
  assert.equal(val.requiresTrustApproval, false);
});

test('TC-V2-002: TrustVerifier memory-backed CJS loader blocks forbidden requires/symlinks/tamper/unapproved and supports circular relative requires', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-v2-trust-'));
  try {
    const manifest = {
      schemaVersion: 2,
      pluginId: 'trusted-mod',
      displayName: 'Trusted Mod',
      version: '1.0.0',
      trustLevel: 'trusted',
      capabilities: ['renderer', 'mainHook'],
      entry: { rendererScript: 'renderer.js', mainHookScript: 'main.js' },
      isolation: { noTranslate: true, i18nSelfManaged: true },
    };

    // 1) Circular relative requires work cleanly inside memory-backed CJS loader
    const circDir = path.join(dir, 'circ');
    fs.mkdirSync(circDir, { recursive: true });
    fs.writeFileSync(path.join(circDir, 'a.js'), `exports.step = 'A'; exports.b = require('./b');\n`, 'utf8');
    fs.writeFileSync(path.join(circDir, 'b.js'), `exports.step = 'B'; exports.aStep = require('./a').step;\n`, 'utf8');
    fs.writeFileSync(path.join(circDir, 'main.js'), `const a = require('./a'); exports.val = a.step + ':' + a.b.step + ':' + a.b.aStep;\n`, 'utf8');
    fs.writeFileSync(path.join(circDir, 'renderer.js'), `// r\n`, 'utf8');

    const snap = snapshotPluginBundleInMemory(circDir);
    const approvedPolicy = {
      schemaVersion: 1,
      approved: {
        'trusted-mod': {
          pluginId: 'trusted-mod',
          version: '1.0.0',
          rendererSha256: sha256Hex(fs.readFileSync(path.join(circDir, 'renderer.js'))),
          mainHookBundleSha256: snap.bundleSha256,
        },
      },
    };

    // Unapproved policy fails closed (Default-Deny)
    const denied = loadVerifiedMainHookModule(path.join(circDir, 'main.js'), circDir, manifest, { schemaVersion: 1, approved: {} });
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'ERR_TRUST_POLICY_NOT_APPROVED');

    // Approved circular CJS module loads from memory cleanly
    const okLoad = loadVerifiedMainHookModule(path.join(circDir, 'main.js'), circDir, manifest, approvedPolicy);
    assert.equal(okLoad.ok, true);
    assert.equal(okLoad.exports.val, 'A:B:A');

    // Tamper renderer.js after approval -> single-buffer SHA-256 rejects
    fs.writeFileSync(path.join(circDir, 'renderer.js'), `// tampered\n`, 'utf8');
    const tamperedR = readVerifiedRendererScript(path.join(circDir, 'renderer.js'), manifest, approvedPolicy);
    assert.equal(tamperedR.ok, false);
    assert.equal(tamperedR.reason, 'ERR_TRUST_POLICY_RENDERER_SHA_MISMATCH');

    // 2) Security rejections inside memory-backed CJS loader
    const badCases = [
      ['absPath', `require('/etc/passwd');`, /ERR_FORBIDDEN_REQUIRE_PATH/],
      ['fileUrl', `require('file:///C:/Windows/win.ini');`, /ERR_FORBIDDEN_REQUIRE_PATH/],
      ['nodeModules', `require('lodash');`, /ERR_FORBIDDEN_EXTERNAL_REQUIRE/],
      ['esmMjs', `require('./sub.mjs');`, /ERR_FORBIDDEN_ESM_REQUIRE/],
      ['electron', `require('electron');`, /ERR_FORBIDDEN_EXTERNAL_REQUIRE/],
      ['nodeFs', `require('fs');`, /ERR_FORBIDDEN_EXTERNAL_REQUIRE/],
      ['nodePrefixFs', `require('node:fs');`, /ERR_FORBIDDEN_EXTERNAL_REQUIRE/],
      ['parentEscape', `require('../outside.js');`, /ERR_REQUIRE_ESCAPES_PLUGIN_ROOT/],
    ];
    for (const [name, code, errRegex] of badCases) {
      const caseDir = path.join(dir, `bad-${name}`);
      fs.mkdirSync(caseDir, { recursive: true });
      if (name === 'esmMjs') fs.writeFileSync(path.join(caseDir, 'sub.mjs'), 'export default 1;\n', 'utf8');
      fs.writeFileSync(path.join(caseDir, 'main.js'), code, 'utf8');
      const s = snapshotPluginBundleInMemory(caseDir);
      const pol = {
        schemaVersion: 1,
        approved: { 'trusted-mod': { pluginId: 'trusted-mod', version: '1.0.0', mainHookBundleSha256: s.bundleSha256 } },
      };
      const res = loadVerifiedMainHookModule(path.join(caseDir, 'main.js'), caseDir, manifest, pol);
      assert.equal(res.ok, false, `Case ${name} must be rejected`);
      assert.match(String(res.error || res.reason), errRegex, `Case ${name} error mismatch`);
    }

    // 3) Symlink/junction inside plugin bundle -> rejected by snapshotPluginBundleInMemory
    const symDir = path.join(dir, 'sym-plugin');
    const outsideDir = path.join(dir, 'outside-secret-dir');
    fs.mkdirSync(symDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'secret.js'), 'exports.x = 1;\n', 'utf8');
    fs.symlinkSync(outsideDir, path.join(symDir, 'escape-dir'), 'junction');
    assert.throws(() => snapshotPluginBundleInMemory(symDir), /ERR_BUNDLE_SYMLINK_ESCAPE/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TC-V2-003: PortalArbiter enforces 4-state truth table, degraded-local mode, and destroyed webContents cleanup', async () => {
  const nativeCalls = [];
  const handlers = new Map();
  const fakeIpcMain = {
    handle(ch, fn) {
      handlers.set(ch, fn);
    },
    removeHandler(ch) {
      handlers.delete(ch);
    },
  };

  const arbiter = createPortalArbiter({
    ipcMain: fakeIpcMain,
    portalBridge: ANTIGRAVITY_HOST_PROFILE.portalBridge,
  });
  arbiter.install();

  // Before native host registers handler -> ARMED (and claim degrades cleanly to PORTAL_ARBITER_DEGRADED_LOCAL)
  assert.equal(arbiter.getStatus().mode, 'ARMED');
  const degradedRes = await arbiter.setPluginClaim({ id: 999, isDestroyed: () => false }, 'pre-host', true);
  assert.equal(degradedRes.mode, 'PORTAL_ARBITER_DEGRADED_LOCAL');
  assert.equal(arbiter.getStatus().mode, 'PORTAL_ARBITER_DEGRADED_LOCAL');

  // Native host registers handler AFTER arbiter.install() (pre-L339)
  fakeIpcMain.handle('wcv:set-portal-overlay-open', (ev, open) => {
    nativeCalls.push({ wcId: ev.sender.id, open: Boolean(open) });
    return { ok: true };
  });
  assert.equal(arbiter.getStatus().mode, 'ACTIVE_ARBITER');

  const wcListeners = new Map();
  const fakeSender = {
    id: 42,
    mainFrame: { id: 1 },
    isDestroyed: () => false,
    on(ev, fn) {
      wcListeners.set(ev, fn);
    },
    once(ev, fn) {
      wcListeners.set(ev, fn);
    },
  };
  arbiter.attachWebContentsLifecycle(fakeSender);

  const wrappedNative = handlers.get('wcv:set-portal-overlay-open');
  // 1) (F, 0) -> (T, 0): native opens -> effective true
  await wrappedNative({ sender: fakeSender }, true);
  assert.equal(nativeCalls[nativeCalls.length - 1].open, true);

  // 2) (T, 0) -> (T, 1): plugin claims -> effective stays true (no redundant false)
  const r2 = await arbiter.setPluginClaim(fakeSender, 'modal-1', true);
  assert.equal(r2.effective, true);

  // 3) (T, 1) -> (F, 1): native tries to close while plugin claim active -> effective STAYS true!
  await wrappedNative({ sender: fakeSender }, false);
  assert.equal(nativeCalls[nativeCalls.length - 1].open, true, 'Native close MUST keep overlay open while plugin claim active');

  // 4) (F, 1) -> (F, 0): plugin releases -> effective transitions to false!
  const r4 = await arbiter.setPluginClaim(fakeSender, 'modal-1', false);
  assert.equal(r4.effective, false);
  assert.equal(nativeCalls[nativeCalls.length - 1].open, false);

  // 5) Destroyed webContents cleans up active state without throwing
  await arbiter.setPluginClaim(fakeSender, 'modal-2', true);
  const beforeDestroy = arbiter.getStatus().activeWindows;
  assert.ok(beforeDestroy >= 1);
  wcListeners.get('destroyed')();
  assert.equal(arbiter.getStatus().activeWindows, beforeDestroy - 1);

  arbiter.dispose();
});

test('TC-V2-004: AsarPatcher handles V1->V2 idempotent upgrade, BACKUPS_DIR N=3 retention pruning, UPDATED_UNPATCHED vs rolledBackAt, and EBUSY classification', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-v2-asar-'));
  try {
    const asarPath = path.join(dir, 'app.asar');
    const backupsDir = path.join(dir, 'backups');
    const paths = {
      ASAR_PATH: asarPath,
      ASAR_LOCK_PATH: path.join(dir, 'asar.lock'),
      BACKUPS_DIR: backupsDir,
      RUNTIME_DIR: path.join(dir, 'runtime'),
      ADDONS_DIR: path.join(dir, 'addons.d'),
      ADDONS_LOCK_PATH: path.join(dir, 'addons.lock'),
      PLUGINS_ROOT_DIR: path.join(dir, 'plugins'),
      CONFIG_JSON_PATH: path.join(dir, 'config.json'),
      TRUST_POLICY_PATH: path.join(dir, 'trust-policy.json'),
      LOADER_SCRIPT_PATH: path.join(dir, 'addon-host-loader.js'),
    };

    // 1) V1->V2 upgrade: simulate an already V1-patched app.asar with a pure V1 .orig backup in BACKUPS_DIR
    const pureOrigBuf = buildSyntheticAsar(asarPath, { version: '2.34.0' });
    const pureSha = sha256Hex(pureOrigBuf);
    fs.mkdirSync(backupsDir, { recursive: true });
    const origBackupPath = path.join(backupsDir, 'app.asar.v2.34.0.orig');
    fs.writeFileSync(origBackupPath, pureOrigBuf);
    fs.writeFileSync(
      `${origBackupPath}.json`,
      JSON.stringify({ appVersion: '2.34.0', sha256: pureSha, bytes: pureOrigBuf.length }),
      'utf8'
    );
    // Overwrite live app.asar with V1 marker
    const v1Anchor = `/*ADDON_HOST_LOADER_V1*/${ANTIGRAVITY_HOST_PROFILE.mainAnchorTarget}`;
    buildSyntheticAsar(asarPath, { version: '2.34.0', anchorReplacement: v1Anchor });

    // Running installAsarAddonHost must automatically upgrade V1 -> V2 from pure .orig!
    const upgraded = installAsarAddonHost(paths, ANTIGRAVITY_HOST_PROFILE);
    assert.equal(upgraded.status, 'UPGRADED');
    assert.equal(isAsarHostInstalled(asarPath, ANTIGRAVITY_HOST_PROFILE), true);
    assert.equal(fs.statSync(asarPath).size, pureOrigBuf.length);

    // 2) Rollback records rolledBackAt -> status reports ROLLED_BACK (NOT UPDATED_UNPATCHED)
    const rb = rollbackAsarAddonHost(paths, ANTIGRAVITY_HOST_PROFILE);
    assert.equal(rb.status, 'ROLLED_BACK');
    const metaAfterRb = JSON.parse(fs.readFileSync(`${upgraded.backupPath}.json`, 'utf8'));
    assert.equal(typeof metaAfterRb.rolledBackAt, 'string');

    const lifecycle = createElectronHostLifecyclePort();
    const ctx = { hostProfileId: ANTIGRAVITY_HOST_PROFILE.id, activeProfile: ANTIGRAVITY_HOST_PROFILE, paths };
    const diagAfterRb = lifecycle.diagnoseHost(ctx);
    assert.equal(diagAfterRb.updatedUnpatched, false, 'Intentional rollback (rolledBackAt) must NOT report updatedUnpatched');

    // 3) Re-install on 2.34.0 (active host), then vendor auto-updates app.asar to 2.35.0 -> updatedUnpatched: true!
    const reinst = installAsarAddonHost(paths, ANTIGRAVITY_HOST_PROFILE);
    assert.equal(reinst.status, 'INSTALLED');
    buildSyntheticAsar(asarPath, { version: '2.35.0' });
    const diagAfterUpdate = lifecycle.diagnoseHost(ctx);
    assert.equal(diagAfterUpdate.updatedUnpatched, true, 'Vendor app.asar update over active host must report updatedUnpatched: true');
    assert.equal(diagAfterUpdate.healthy, false);

    // 4) BACKUPS_DIR N=3 retention pruning removes oldest version backups beyond maxKeep=3 while protecting activeOrigSha256
    const pruneDir = path.join(dir, 'prune-test');
    fs.mkdirSync(pruneDir, { recursive: true });
    for (let i = 1; i <= 5; i++) {
      const f = path.join(pruneDir, `app.asar.v2.3${i}.0.orig`);
      fs.writeFileSync(f, `v${i}`, 'utf8');
      fs.writeFileSync(`${f}.json`, JSON.stringify({ appVersion: `2.3${i}.0`, sha256: `sha-${i}` }), 'utf8');
      const t = new Date(Date.now() - (10 - i) * 10000);
      fs.utimesSync(f, t, t);
    }
    pruneBackups(pruneDir, { activeOrigSha256: 'sha-1', pinnedShas: [] }, 3);
    const remainingOrigs = fs.readdirSync(pruneDir).filter((n) => n.endsWith('.orig')).sort();
    assert.equal(remainingOrigs.length, 3);
    assert.ok(remainingOrigs.includes('app.asar.v2.31.0.orig'), 'Protected activeOrigSha256 must NEVER be pruned');

    // 5) EBUSY / EPERM write error returns ERR_TARGET_LOCKED_APP_RUNNING fail-fast
    const lockedAsar = path.join(dir, 'locked.asar');
    buildSyntheticAsar(lockedAsar, { version: '2.36.0' });
    const origRenameSync = fs.renameSync;
    fs.renameSync = (src, dst) => {
      if (path.resolve(dst) === path.resolve(lockedAsar)) {
        const e = new Error('EBUSY: resource busy or locked');
        e.code = 'EBUSY';
        throw e;
      }
      return origRenameSync(src, dst);
    };
    try {
      const lockedRes = installAsarAddonHost(
        {
          ...paths,
          ASAR_PATH: lockedAsar,
          ASAR_LOCK_PATH: path.join(dir, 'locked.lock'),
          BACKUPS_DIR: path.join(dir, 'locked-backups'),
        },
        ANTIGRAVITY_HOST_PROFILE
      );
      assert.equal(lockedRes.status, 'ERR_TARGET_LOCKED_APP_RUNNING');
    } finally {
      fs.renameSync = origRenameSync;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TC-V2-005: EnvLauncherTransport formats forward-slash Windows NODE_OPTIONS, scrubs quote-aware flags, and guards non-browser processes', () => {
  const winLoader = 'C:\\Users\\My User\\.gemini\\antigravity\\addon-host-loader.js';
  const combined = buildNodeOptionsWithRequire('--max-old-space-size=4096', winLoader) + ' --trace-warnings';
  assert.match(combined, /--require "C:\/Users\/My User\/\.gemini\/antigravity\/addon-host-loader\.js"/);

  const scrubbed = scrubOwnRequireFromNodeOptions(combined, winLoader);
  assert.equal(scrubbed, '--max-old-space-size=4096 --trace-warnings');

  // `--require="path"` form is also scrubbed cleanly
  const eqScrubbed = scrubOwnRequireFromNodeOptions(
    `--require="C:/Users/My User/.gemini/antigravity/addon-host-loader.js" --enable-source-maps`,
    winLoader
  );
  assert.equal(eqScrubbed, '--enable-source-maps');

  // Bootstrap source strictly enforces browser-process-only guard (`ELECTRON_RUN_AS_NODE` immunity)
  const bootSrc = buildUnpackagedBootstrapSource(winLoader);
  assert.match(bootSrc, /if\s*\(\s*process\.type\s*!==\s*'browser'\s*\)\s*return;/);

  const transport = createEnvLauncherTransport();
  assert.equal(transport.id, 'env-launcher-unpackaged');
  assert.equal(typeof transport.launchUnpackaged, 'function');
});

test('TC-V2-006: ElectronAddonStorePort performs zero addon-host-loader.js rewrites on register/unregister and CLI manages trust approve/list/revoke', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-v2-cli-trust-'));
  try {
    const pluginsRoot = path.join(dir, 'plugins');
    const addonsDir = path.join(dir, 'addons.d');
    const trustPolicyPath = path.join(dir, 'trust-policy.json');
    const loaderPath = path.join(dir, 'addon-host-loader.js');
    const pluginDir = path.join(pluginsRoot, 'trusted-cli-addon');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'renderer.js'), 'console.log("ok");\n', 'utf8');
    fs.writeFileSync(path.join(pluginDir, 'hook.cjs'), 'exports.onMainReady = () => {};\n', 'utf8');

    // Seed sentinel loader file -> register/unregister must NEVER touch or overwrite it!
    fs.writeFileSync(loaderPath, '// SENTINEL_LOADER_UNTOUCHED\n', 'utf8');

    const manifestPath = path.join(dir, 'trusted-cli-addon.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        pluginId: 'trusted-cli-addon',
        displayName: 'Trusted CLI Addon',
        version: '2.0.0',
        trustLevel: 'trusted',
        capabilities: ['renderer', 'mainHook'],
        entry: { rendererScript: 'renderer.js', mainHookScript: 'hook.cjs' },
        isolation: { noTranslate: true, i18nSelfManaged: true },
      }),
      'utf8'
    );

    const store = createElectronAddonStorePort();
    const ctx = {
      hostProfileId: ANTIGRAVITY_HOST_PROFILE.id,
      activeProfile: ANTIGRAVITY_HOST_PROFILE,
      paths: {
        ADDONS_DIR: addonsDir,
        ADDONS_LOCK_PATH: path.join(dir, 'addons.lock'),
        PLUGINS_ROOT_DIR: pluginsRoot,
        CONFIG_JSON_PATH: path.join(dir, 'config.json'),
        LOADER_SCRIPT_PATH: loaderPath,
      },
    };
    const manifestObj = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const reg = store.registerManifest(ctx, manifestObj);
    assert.equal(reg.ok, true);
    assert.equal(fs.readFileSync(loaderPath, 'utf8'), '// SENTINEL_LOADER_UNTOUCHED\n', 'registerManifest must NOT rewrite loader');

    // TrustPolicyPort + CLI `trust approve`, `trust list`, `trust revoke`
    const fakeHome = path.join(dir, 'home');
    const agyDir = path.join(fakeHome, '.gemini', 'antigravity');
    const homePluginsRoot = path.join(fakeHome, '.gemini', 'config', 'plugins');
    const homeAddonsDir = path.join(agyDir, 'addons.d');
    const homePluginDir = path.join(homePluginsRoot, 'trusted-cli-addon');
    fs.mkdirSync(homePluginDir, { recursive: true });
    fs.mkdirSync(homeAddonsDir, { recursive: true });
    fs.writeFileSync(path.join(homePluginDir, 'renderer.js'), 'console.log("ok");\n', 'utf8');
    fs.writeFileSync(path.join(homePluginDir, 'hook.cjs'), 'exports.onMainReady = () => {};\n', 'utf8');
    fs.writeFileSync(path.join(homeAddonsDir, 'trusted-cli-addon.json'), JSON.stringify(manifestObj), 'utf8');

    const trustPort = createElectronTrustPolicyPort();
    const trustCtx = {
      hostProfileId: ANTIGRAVITY_HOST_PROFILE.id,
      activeProfile: ANTIGRAVITY_HOST_PROFILE,
      paths: {
        ADDONS_DIR: homeAddonsDir,
        PLUGINS_ROOT_DIR: homePluginsRoot,
        TRUST_POLICY_PATH: path.join(agyDir, 'trust-policy.json'),
      },
    };
    const appRes = trustPort.approvePlugin(trustCtx, 'trusted-cli-addon');
    assert.equal(appRes.ok, true);
    assert.equal(appRes.record.rendererSha256.length, 64);
    assert.equal(appRes.record.mainHookBundleSha256.length, 64);
    assert.equal(trustPort.listApproved(trustCtx).approved.length, 1);

    // Real bin/addon-host.js CLI subcommands (`trust list`, `trust revoke`, `trust approve`)
    const cliEnv = {
      ...process.env,
      USERPROFILE: fakeHome,
      HOME: fakeHome,
    };
    const listOut = JSON.parse(execFileSync(process.execPath, [BIN_PATH, 'trust', 'list', '--json'], { env: cliEnv, encoding: 'utf8' }));
    assert.equal(listOut.ok, true);
    assert.equal(listOut.approved.length, 1);

    const revokeOut = JSON.parse(
      execFileSync(process.execPath, [BIN_PATH, 'trust', 'revoke', 'trusted-cli-addon', '--json'], { env: cliEnv, encoding: 'utf8' })
    );
    assert.equal(revokeOut.ok, true);
    assert.equal(revokeOut.revoked, true);

    const approveOut = JSON.parse(
      execFileSync(process.execPath, [BIN_PATH, 'trust', 'approve', 'trusted-cli-addon', '--json'], { env: cliEnv, encoding: 'utf8' })
    );
    assert.equal(approveOut.ok, true);
    assert.equal(approveOut.record.pluginId, 'trusted-cli-addon');

    const unreg = store.unregisterManifest(ctx, 'trusted-cli-addon');
    assert.equal(unreg.ok, true);
    assert.equal(fs.readFileSync(loaderPath, 'utf8'), '// SENTINEL_LOADER_UNTOUCHED\n', 'unregisterManifest must NOT rewrite loader');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TC-V2-007 (Phase 3 Audit Hardening): CSS quote/escape/at-rule bypasses, multi-byte nonce timingSafeEqual, corrupt trust-policy fail-closed, kernel hostToken & disposePlugin invalidation, IPC docGenId, popover dismissal & CLI upgrade guard', async () => {
  const { validateSafeCssText, scopeCssToOwner } = require('../../src/runtime/renderer/style-manager');
  const { createRendererKernel } = require('../../src/runtime/renderer/kernel');
  const { createHostOriginResolver } = require('../../src/runtime/main/host-origin-resolver');
  const { validateElectronHostProfile } = require('../../src/adapters/electron/electron-host-profile-port');
  const { createCliApp } = require('../../src/cli/main');

  // 1) D-01 & SEC-03: CSS comment collapse, non-hex escapes, @container, quoted braces, and body:not([owner]) bypass
  assert.equal(validateSafeCssText('@im/**/port url("https://evil.example/x.css");').ok, false);
  assert.equal(validateSafeCssText('@\\import url("https://evil.example/x.css");').ok, false);
  assert.equal(validateSafeCssText('@container (min-width: 1px) { .a { color: red } }').ok, false);
  const quotedScoped = scopeCssToOwner('.a{content:"{";} body{display:none!important;} .c{content:"}";}', 'p1');
  assert.match(quotedScoped, /\[data-addon-host-owner="p1"\]\s*\{display:none!important;\}/);
  const notBypassScoped = scopeCssToOwner('body:not([data-addon-host-owner="p1"]) { color: red }', 'p1');
  assert.match(notBypassScoped, /^\[data-addon-host-owner="p1"\]:not\(/);

  // 2) D-02 & SEC-04: multi-byte 64-char UTF-8 nonce never throws RangeError; unclaimed/stale docGenId rejected
  const ses = { id: 'default' };
  const resolver = createHostOriginResolver({
    profile: ANTIGRAVITY_HOST_PROFILE,
    getDefaultSession: () => ses,
  });
  const ev = {
    sender: { id: 7, session: ses, mainFrame: null, isDestroyed: () => false },
    senderFrame: { parent: null, detached: false, url: 'http://127.0.0.1:4173/app', origin: 'http://127.0.0.1:4173' },
  };
  ev.sender.mainFrame = ev.senderFrame;
  const v = resolver.verifyFrameEvent(ev);
  assert.equal(v.ok, true);
  // 64 UTF-16 code units with multi-byte chars -> > 64 UTF-8 bytes
  const mbRes = resolver.consumeClaimNonce(ev, '가'.repeat(64));
  assert.equal(mbRes.ok, false);
  assert.equal(mbRes.reason, 'ERR_INVALID_NONCE');
  // Unclaimed bridge fails verifyClaimedEvent
  assert.equal(resolver.verifyClaimedEvent(ev, v.docGenId).reason, 'ERR_BRIDGE_NOT_CLAIMED_FOR_GENERATION');
  // Claim with real nonce then verify stale docGenId is rejected
  const realNonce = resolver.getState(7).activeNonce;
  assert.equal(resolver.consumeClaimNonce(ev, realNonce).ok, true);
  assert.equal(resolver.verifyClaimedEvent(ev, v.docGenId).ok, true);
  assert.equal(resolver.verifyClaimedEvent(ev, v.docGenId + 1).reason, 'ERR_STALE_DOCUMENT_GENERATION');

  // 3) SEC-02 & D-04 & D-07 & D-11: kernel hostToken protection, disposePlugin invalidating handle, sibling translate="no" outside-click
  const docListeners = {};
  const body = { children: [], appendChild(c) { c.parentNode = this; this.children.push(c); }, removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; } };
  const makeEl = (tag) => {
    const attrs = {};
    return {
      tagName: tag.toUpperCase(),
      style: {},
      children: [],
      setAttribute(k, v2) { attrs[k] = String(v2); },
      getAttribute(k) { return attrs[k] || null; },
      appendChild(c) { c.parentNode = this; this.children.push(c); },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; },
    };
  };
  const mockDoc = {
    body,
    head: body,
    createElement: makeEl,
    addEventListener(t, fn) { docListeners[t] = fn; },
  };
  const mockWin = { addEventListener() {} };
  const kernel = createRendererKernel(mockDoc, mockWin);
  const hostToken = 'a'.repeat(48);
  assert.equal(kernel.boot({ docGenId: 1, hostToken }).ok, true);
  assert.equal(kernel.boot({ docGenId: 99, hostToken: 'wrong' }).ok, false);
  assert.throws(() => kernel.createPluginHandle({ pluginId: 'evil' }, 'wrong'), /ERR_FORBIDDEN_HOST_TOKEN/);

  const meta = {
    pluginId: 'p1',
    version: '2.0.0',
    trustLevel: 'restricted',
    uiSlots: [
      { slot: 'overlay', slotId: 'p1.pop', shadow: false },
      { slot: 'status-bar', slotId: 'p1.bar', shadow: false },
    ],
  };
  const handle = kernel.createPluginHandle(meta, hostToken);
  assert.throws(() => handle.openPopover('p1.bar'), /ERR_INVALID_POPOVER_SLOT_KIND/);
  let popClosed = 0;
  handle.openPopover('p1.pop', { onClose: () => { popClosed++; } });
  // Clicking a sibling element carrying translate="no" MUST still dismiss popover (D-07)
  const sibling = makeEl('div');
  sibling.setAttribute('translate', 'no');
  docListeners.pointerdown({ target: sibling, composedPath: () => [sibling, body] });
  assert.equal(popClosed, 1);

  // kernel.disposePlugin(id, token) must immediately invalidate handle (D-04)
  kernel.disposePlugin('p1', hostToken);
  assert.throws(() => handle.mountSlot('p1.bar'), /ERR_PLUGIN_HANDLE_DISPOSED/);

  // 4) D-03: Corrupt trust-policy.json fails closed on approvePlugin & revokePlugin without wiping file
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-v2-corrupt-'));
  try {
    const corruptPath = path.join(tmp, 'trust-policy.json');
    fs.writeFileSync(corruptPath, '{BROKEN JSON', 'utf8');
    const trustPort = createElectronTrustPolicyPort();
    const tCtx = { hostProfileId: ANTIGRAVITY_HOST_PROFILE.id, activeProfile: ANTIGRAVITY_HOST_PROFILE, paths: { TRUST_POLICY_PATH: corruptPath, PLUGINS_ROOT_DIR: tmp, ADDONS_DIR: tmp } };
    const rev = trustPort.revokePlugin(tCtx, 'some-plugin');
    assert.equal(rev.ok, false);
    assert.equal(fs.readFileSync(corruptPath, 'utf8'), '{BROKEN JSON', 'Corrupt trust-policy.json must NOT be wiped');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 5) SEC-10: bracket-notation process['env'] anchor override rejected
  const badProf = validateElectronHostProfile({
    ...ANTIGRAVITY_HOST_PROFILE,
    mainAnchorReplacement: `/*${ANTIGRAVITY_HOST_PROFILE.patchMarker}*/require(process['env'].X);`,
  });
  assert.equal(badProf.ok, false);
  assert.equal(badProf.reason, 'ERR_ANCHOR_ENV_OVERRIDE_FORBIDDEN');

  // 6) F-NB1: CLI --upgrade fails closed with ERR_UPGRADE_UNSUPPORTED when port omits upgradeHost
  const cli = createCliApp({
    defaultProfile: { id: 'mock', resolvePaths: () => ({ ADDONS_DIR: '.', PLUGINS_ROOT_DIR: '.' }) },
    hostLifecycle: {
      validateProfile: (p) => p,
      resolveContext: () => ({}),
      getHostStatus: () => ({ installed: true }),
      diagnoseHost: () => ({ healthy: true }),
      installHost: () => ({ ok: true }),
      rollbackHost: () => ({ ok: true }),
    },
    addonStore: {
      planAddons: () => ({ active: [], disabled: [], rejected: [], slots: {} }),
      validateManifest: () => ({ ok: true }),
      registerManifest: () => ({ ok: true }),
      unregisterManifest: () => ({ ok: true }),
    },
  });
  const savedExit = process.exitCode;
  const origWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    const upgRes = await cli.runCli(['--upgrade']);
    assert.equal(upgRes.ok, false);
    assert.equal(upgRes.reason, 'ERR_UPGRADE_UNSUPPORTED');
  } finally {
    process.stdout.write = origWrite;
    process.exitCode = savedExit;
  }
});
