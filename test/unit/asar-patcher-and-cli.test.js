'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_BIN = path.join(REPO_ROOT, 'bin', 'addon-host.js');

const { ANTIGRAVITY_HOST_PROFILE } = require('../../src/profiles/antigravity');
const {
  sanitizeVersionForFilename,
  acquireExclusiveLockDetailed,
  releaseExclusiveLock,
  transformExactSize,
  readAsarArchive,
  isAsarHostInstalled,
  installAsarAddonHost,
  rollbackAsarAddonHost,
  diagnoseAsarState,
} = require('../../src/adapters/electron/asar-patcher');

function buildSyntheticAsar(
  filePath,
  {
    version = '2.33.0',
    anchorTarget = ANTIGRAVITY_HOST_PROFILE.mainAnchorTarget,
    extraLines = [],
    includeIntegrity = true,
    eol = '\n',
  } = {}
) {
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
  const mainBuf = Buffer.from(mainLines.join(eol) + eol, 'utf8');
  const makeIntegrity = (buf) => {
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    return { algorithm: 'SHA256', hash, blockSize: 4 * 1024 * 1024, blocks: [hash] };
  };
  const pkgEntry = { size: pkgBuf.length, offset: '0' };
  const mainEntry = { size: mainBuf.length, offset: String(pkgBuf.length) };
  if (includeIntegrity) {
    pkgEntry.integrity = makeIntegrity(pkgBuf);
    mainEntry.integrity = makeIntegrity(mainBuf);
  }
  const files = {
    'package.json': pkgEntry,
    dist: { files: { 'main.js': mainEntry } },
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

test('TC-009 (F6): synthetic ASAR exact-size install (with & without integrity), CRLF & template-literal // preservation, appVersion sanitization, lock error classification, and rollback', () => {
  // F6: appVersion filename sanitization
  assert.equal(sanitizeVersionForFilename('../../evil/1.0'), 'evil_1.0');
  assert.equal(sanitizeVersionForFilename('2.33.0'), '2.33.0');

  // F6: template literal containing `//` on its own line must NOT be stripped; CRLF supported
  const templateSrc = [
    "const tpl = `line1",
    "  // keep this inside template literal",
    "line3`;",
    "// top level removable comment line 1 for exact size padding",
    "// top level removable comment line 2 for exact size padding",
    "TARGET_ANCHOR();",
  ].join('\r\n');
  const transformed = transformExactSize(
    Buffer.from(templateSrc, 'utf8'),
    'TARGET_ANCHOR();',
    'TARGET_ANCHOR();/*MARK*/void 0;',
    'MARK'
  ).toString('utf8');
  assert.equal(transformed.includes('// keep this inside template literal'), true);
  assert.equal(transformed.includes('/*MARK*/'), true);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-asar-'));
  try {
    // 1) Standard ASAR with integrity + CRLF
    const asarPath = path.join(dir, 'app.asar');
    const origBuf = buildSyntheticAsar(asarPath, { includeIntegrity: true, eol: '\r\n' });
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

    // 2) F6: Non-integrity ASAR must patch without ERR_ARCHIVE_SIZE_DRIFT
    const noIntPath = path.join(dir, 'no-int.asar');
    const noIntOrig = buildSyntheticAsar(noIntPath, { includeIntegrity: false });
    const noIntInst = installAsarAddonHost(
      { ...paths, ASAR_PATH: noIntPath, ASAR_LOCK_PATH: path.join(dir, 'noint.lock') },
      ANTIGRAVITY_HOST_PROFILE
    );
    assert.equal(noIntInst.status, 'INSTALLED');
    assert.equal(fs.statSync(noIntPath).size, noIntOrig.length);

    // 3) F6: Lock contention returns LOCK_BUSY while invalid FS path returns ERR_LOCK_FS_ERROR
    const lockFile = path.join(dir, 'test.lock');
    const first = acquireExclusiveLockDetailed(lockFile);
    assert.equal(first.ok, true);
    const second = acquireExclusiveLockDetailed(lockFile);
    assert.equal(second.ok, false);
    assert.equal(second.code, 'LOCK_BUSY');
    releaseExclusiveLock(lockFile, first.token);

    const badFs = acquireExclusiveLockDetailed(path.join(dir, 'bad\0path', 'x.lock'));
    assert.equal(badFs.ok, false);
    assert.equal(badFs.code, 'ERR_LOCK_FS_ERROR');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TC-010 (F5): custom non-Antigravity HostProfile works across install, delta>0 comment stripping, .orig reinstall, and rollback', () => {
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

    const reinst = installAsarAddonHost(paths, customProfile);
    assert.equal(reinst.status, 'INSTALLED');
    assert.equal(isAsarHostInstalled(asarPath, customProfile), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TC-011 & TC-012 (F5 & F7): real bin/addon-host.js CLI process executes --version, --help, --profile, --validate, --register, --status, --doctor, and --unregister', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-cli-proc-'));
  try {
    const asarPath = path.join(dir, 'app.asar');
    buildSyntheticAsar(asarPath, {
      extraLines: ['// AGY_STATUSBAR_AUTOINJECT_V5', '/* AGY_MCP_MANAGER_SETTINGS_V2_START */'],
    });
    const pluginsRoot = path.join(dir, 'plugins');
    const pluginDir = path.join(pluginsRoot, 'acme-bar');
    fs.mkdirSync(path.join(pluginDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'dist', 'renderer.js'), '// acme bar\n', 'utf8');

    const manifestFile = path.join(dir, 'acme-bar.json');
    fs.writeFileSync(
      manifestFile,
      JSON.stringify({
        schemaVersion: 1,
        pluginId: 'acme-bar',
        displayName: 'Acme Bar',
        version: '1.0.0',
        compatibility: { hostProfile: 'acme-cli-profile', minHostVersion: '1.0.0' },
        capabilities: ['renderer'],
        entry: { rendererScript: 'dist/renderer.js', mainHookScript: null },
        uiSlots: [{ slot: 'status-bar', slotId: 'acme-bar.root', exclusive: true }],
        isolation: { noTranslate: true, i18nSelfManaged: true, storageNamespace: 'acme-bar' },
      }),
      'utf8'
    );

    // Custom HostProfile module passed via --profile
    const profileFile = path.join(dir, 'custom-profile.js');
    fs.writeFileSync(
      profileFile,
      `
      module.exports = {
        HOST_PROFILE: {
          id: 'acme-cli-profile',
          patchMarker: 'ADDON_HOST_LOADER_V1',
          loaderEnvVar: 'ACME_LOADER_PATH',
          mainEntry: 'dist/main.js',
          mainAnchorTarget: "electron_1.app.on('web-contents-created', (_event, contents) => {",
          mainAnchorReplacement: "electron_1.app.on('web-contents-created', (_event, contents) => {/*ADDON_HOST_LOADER_V1*/",
          legacyPatchMarkers: ['AGY_STATUSBAR', 'AGY_MCP'],
          resolvePaths: () => (${JSON.stringify({
            PLUGINS_ROOT_DIR: pluginsRoot,
            ADDONS_DIR: path.join(dir, 'addons.d'),
            ADDONS_LOCK_PATH: path.join(dir, 'addons.lock'),
            LOADER_SCRIPT_PATH: path.join(dir, 'addon-host-loader.js'),
            CONFIG_JSON_PATH: path.join(dir, 'config.json'),
            ASAR_PATH: asarPath,
            ASAR_LOCK_PATH: path.join(dir, 'asar.lock'),
          })}),
        },
      };
      `,
      'utf8'
    );

    const runBin = (args) => execFileSync(process.execPath, [CLI_BIN, ...args], { encoding: 'utf8' });

    assert.match(runBin(['--version']).trim(), /^\d+\.\d+\.\d+/);
    assert.match(runBin(['--help']), /--profile/);

    const valOut = JSON.parse(runBin(['--profile', profileFile, '--validate', manifestFile]));
    assert.equal(valOut.ok, true);

    const regOut = JSON.parse(runBin(['--profile', profileFile, '--register', manifestFile]));
    assert.equal(regOut.ok, true);
    assert.equal(regOut.pluginId, 'acme-bar');

    const statusOut = JSON.parse(runBin(['--profile', profileFile, '--status']));
    assert.equal(statusOut.hostProfileId, 'acme-cli-profile');
    assert.equal(statusOut.activeAddons.length, 1);
    assert.equal(statusOut.activeAddons[0].pluginId, 'acme-bar');

    const doctorOut = JSON.parse(runBin(['--profile', profileFile, '--doctor']));
    assert.equal(doctorOut.healthy, false);
    assert.equal(doctorOut.asar.hasLegacyConflict, true);
    assert.equal(doctorOut.asar.legacyMarkers.includes('AGY_STATUSBAR'), true);

    const unregOut = JSON.parse(runBin(['--profile', profileFile, '--unregister', 'acme-bar']));
    assert.equal(unregOut.ok, true);
    assert.equal(unregOut.removed, true);

    // Direct diagnoseAsarState also matches
    const diag = diagnoseAsarState(
      { ASAR_PATH: asarPath, ASAR_LOCK_PATH: path.join(dir, 'asar.lock') },
      ANTIGRAVITY_HOST_PROFILE
    );
    assert.equal(diag.hasLegacyConflict, true);
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
