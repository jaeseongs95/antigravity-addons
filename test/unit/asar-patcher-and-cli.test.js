'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { ANTIGRAVITY_HOST_PROFILE } = require('../../src/profiles/antigravity');
const {
  readAsarArchive,
  isAsarHostInstalled,
  installAsarAddonHost,
  rollbackAsarAddonHost,
  diagnoseAsarState,
} = require('../../src/adapters/electron/asar-patcher');
const {
  buildStatusReport,
  buildDoctorReport,
  registerAddonManifestFile,
  unregisterAddonManifest,
} = require('../../src/cli/main');

function buildSyntheticAsar(filePath, { version = '2.33.0', anchorTarget = ANTIGRAVITY_HOST_PROFILE.mainAnchorTarget, extraLines = [] } = {}) {
  const pkgBuf = Buffer.from(JSON.stringify({ name: 'desktop-host', version }), 'utf8');
  const mainLines = [
    "'use strict';",
    "const electron_1 = require('electron');",
    ...Array.from({ length: 14 }, (_, i) => `// headroom comment line ${i} for exact size padding`),
    ...extraLines,
    anchorTarget,
    '  void contents;',
    '});',
  ];
  const mainBuf = Buffer.from(mainLines.join('\n') + '\n', 'utf8');
  const makeIntegrity = (buf) => {
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    return { algorithm: 'SHA256', hash, blockSize: 4 * 1024 * 1024, blocks: [hash] };
  };
  const files = {
    'package.json': { size: pkgBuf.length, offset: '0', integrity: makeIntegrity(pkgBuf) },
    dist: {
      files: {
        'main.js': { size: mainBuf.length, offset: String(pkgBuf.length), integrity: makeIntegrity(mainBuf) },
      },
    },
  };
  const headerStrBuf = Buffer.from(JSON.stringify({ files }), 'utf8');
  const aligned = Math.ceil(headerStrBuf.length / 4) * 4;
  const u8 = 4 + aligned;
  const u4 = 4 + u8;
  const hdr = Buffer.alloc(8 + u4, 0);
  hdr.writeUInt32LE(4, 0);
  hdr.writeUInt32LE(u4, 4);
  hdr.writeUInt32LE(u8, 8);
  hdr.writeUInt32LE(headerStrBuf.length, 12);
  headerStrBuf.copy(hdr, 16);
  const full = Buffer.concat([hdr, pkgBuf, mainBuf]);
  fs.writeFileSync(filePath, full);
  return full;
}

test('TC-009: synthetic ASAR exact-size install, tampered .orig.json fail-closed, and byte-identical rollback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-asar-'));
  try {
    const asarPath = path.join(dir, 'app.asar');
    const origBuf = buildSyntheticAsar(asarPath);
    const paths = {
      ASAR_PATH: asarPath,
      ASAR_LOCK_PATH: path.join(dir, 'asar.lock'),
      ADDONS_DIR: path.join(dir, 'addons.d'),
      LOADER_SCRIPT_PATH: path.join(dir, 'addon-host-loader.js'),
    };

    const inst = installAsarAddonHost(paths, ANTIGRAVITY_HOST_PROFILE);
    assert.equal(inst.status, 'INSTALLED');
    assert.equal(isAsarHostInstalled(asarPath, ANTIGRAVITY_HOST_PROFILE), true);
    assert.equal(fs.statSync(asarPath).size, origBuf.length);

    // Tamper .orig.json -> rollback must fail closed
    const metaPath = `${asarPath}.v2.33.0.orig.json`;
    const savedMeta = fs.readFileSync(metaPath, 'utf8');
    fs.writeFileSync(metaPath, JSON.stringify({ sha256: '0'.repeat(64), bytes: 1 }), 'utf8');
    assert.equal(rollbackAsarAddonHost(paths, ANTIGRAVITY_HOST_PROFILE).status, 'ERR_ORIG_META_MISMATCH');

    // Restore valid meta -> byte-identical rollback succeeds
    fs.writeFileSync(metaPath, savedMeta, 'utf8');
    const rb = rollbackAsarAddonHost(paths, ANTIGRAVITY_HOST_PROFILE);
    assert.equal(rb.status, 'ROLLED_BACK');
    assert.deepEqual(fs.readFileSync(asarPath), origBuf);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TC-010: custom non-Antigravity HostProfile works across install, delta>0 comment stripping, .orig reinstall, and rollback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-custom-'));
  try {
    const customProfile = Object.freeze({
      id: 'acme-electron-app',
      patchMarker: 'ACME_HOST_LOADER_V1',
      loaderEnvVar: 'ACME_HOST_LOADER_PATH',
      mainEntry: 'dist/main.js',
      mainAnchorTarget: "app.on('web-contents-created', (_e, contents) => {",
      mainAnchorReplacement:
        "app.on('web-contents-created', (_e, contents) => {\n// ACME_HOST_LOADER_V1\ntry{require(process.env.ACME_HOST_LOADER_PATH).attachWebContents(contents,app);}catch(_e){}",
      legacyPatchMarkers: Object.freeze(['ACME_OLD_PATCH']),
      resolvePaths: () => ({}),
    });

    const asarPath = path.join(dir, 'app.asar');
    const origBuf = buildSyntheticAsar(asarPath, {
      version: '4.0.0',
      anchorTarget: customProfile.mainAnchorTarget,
    });
    const paths = {
      ASAR_PATH: asarPath,
      ASAR_LOCK_PATH: path.join(dir, 'asar.lock'),
      ADDONS_DIR: path.join(dir, 'addons.d'),
      LOADER_SCRIPT_PATH: path.join(dir, 'loader.js'),
    };

    const inst = installAsarAddonHost(paths, customProfile);
    assert.equal(inst.status, 'INSTALLED');
    assert.equal(isAsarHostInstalled(asarPath, customProfile), true);

    const rb = rollbackAsarAddonHost(paths, customProfile);
    assert.equal(rb.status, 'ROLLED_BACK');
    assert.deepEqual(fs.readFileSync(asarPath), origBuf);

    // Reinstall when .orig already exists
    const reinst = installAsarAddonHost(paths, customProfile);
    assert.equal(reinst.status, 'INSTALLED');
    assert.equal(isAsarHostInstalled(asarPath, customProfile), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TC-011 & TC-012: --doctor detects legacy direct patches and CLI register/status/unregister works end-to-end', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-cli-'));
  try {
    const asarPath = path.join(dir, 'app.asar');
    buildSyntheticAsar(asarPath, {
      extraLines: ['// AGY_STATUSBAR_AUTOINJECT_V5', '/* AGY_MCP_MANAGER_SETTINGS_V2_START */'],
    });
    const pluginsRoot = path.join(dir, 'plugins');
    const pluginDir = path.join(pluginsRoot, 'antigravity-statusbar');
    fs.mkdirSync(path.join(pluginDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'dist', 'renderer.js'), '// statusbar\n', 'utf8');

    const manifestFile = path.join(dir, 'statusbar-manifest.json');
    fs.writeFileSync(
      manifestFile,
      JSON.stringify({
        schemaVersion: 1,
        pluginId: 'antigravity-statusbar',
        displayName: 'Statusbar',
        version: '3.1.0',
        capabilities: ['renderer'],
        entry: { rendererScript: 'dist/renderer.js', mainHookScript: null },
        uiSlots: [{ slot: 'status-bar', slotId: 'antigravity-statusbar.root', exclusive: true }],
        isolation: { noTranslate: true, i18nSelfManaged: true },
      }),
      'utf8'
    );

    const overrides = {
      ASAR_PATH: asarPath,
      ASAR_LOCK_PATH: path.join(dir, 'asar.lock'),
      PLUGINS_ROOT_DIR: pluginsRoot,
      ADDONS_DIR: path.join(dir, 'addons.d'),
      LOADER_SCRIPT_PATH: path.join(dir, 'addon-host-loader.js'),
      CONFIG_JSON_PATH: path.join(dir, 'config.json'),
    };

    const diag = diagnoseAsarState(overrides, ANTIGRAVITY_HOST_PROFILE);
    assert.equal(diag.hasLegacyConflict, true);
    assert.equal(diag.legacyMarkers.includes('AGY_STATUSBAR'), true);
    assert.equal(diag.legacyMarkers.includes('AGY_MCP'), true);

    // Install without --replace-legacy must fail closed to protect existing legacy patches
    const blockedInst = installAsarAddonHost(overrides, ANTIGRAVITY_HOST_PROFILE);
    assert.equal(blockedInst.status, 'ERR_LEGACY_DIRECT_PATCH_DETECTED');

    // Register, status, doctor, unregister
    const reg = registerAddonManifestFile(manifestFile, overrides);
    assert.equal(reg.ok, true);
    const status = buildStatusReport(overrides);
    assert.equal(status.activeAddons.length, 1);
    assert.equal(status.activeAddons[0].pluginId, 'antigravity-statusbar');

    const docReport = buildDoctorReport(overrides);
    assert.equal(docReport.healthy, false);
    assert.equal(docReport.asar.hasLegacyConflict, true);

    const unreg = unregisterAddonManifest('antigravity-statusbar', overrides);
    assert.equal(unreg.ok, true);
    assert.equal(unreg.removed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const defaultLocalOrig = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'Programs', 'antigravity', 'resources', 'app.asar.v2.33.0.orig')
  : '';
const HAS_REAL_ASAR = Boolean(defaultLocalOrig && fs.existsSync(defaultLocalOrig));

test(
  'TC-013: Real Antigravity app.asar copy exact-size patch and byte-identical rollback',
  { skip: HAS_REAL_ASAR ? false : 'Local Antigravity app.asar.orig fixture not present in this environment' },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-real-asar-'));
    try {
      const asarPath = path.join(dir, 'app.asar');
      fs.copyFileSync(defaultLocalOrig, asarPath);
      const origBuf = fs.readFileSync(asarPath);
      const origHash = crypto.createHash('sha256').update(origBuf).digest('hex');

      const paths = {
        ASAR_PATH: asarPath,
        ASAR_LOCK_PATH: path.join(dir, 'asar.lock'),
        ADDONS_DIR: path.join(dir, 'addons.d'),
        LOADER_SCRIPT_PATH: path.join(dir, 'addon-host-loader.js'),
      };

      const inst = installAsarAddonHost(paths, ANTIGRAVITY_HOST_PROFILE);
      assert.equal(inst.status, 'INSTALLED');
      assert.equal(isAsarHostInstalled(asarPath, ANTIGRAVITY_HOST_PROFILE), true);
      assert.equal(fs.statSync(asarPath).size, origBuf.length);

      const rb = rollbackAsarAddonHost(paths, ANTIGRAVITY_HOST_PROFILE);
      assert.equal(rb.status, 'ROLLED_BACK');
      const restoredHash = crypto.createHash('sha256').update(fs.readFileSync(asarPath)).digest('hex');
      assert.equal(restoredHash, origHash);
      readAsarArchive(asarPath);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);
