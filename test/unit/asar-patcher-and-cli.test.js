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

const { validateHostProfile } = require('../../src/core/host-profile-port');
const { validateElectronHostProfile } = require('../../src/adapters/electron/electron-host-profile-port');
const {
  resolveElectronPaths,
  createElectronHostLifecyclePort,
} = require('../../src/adapters/electron/electron-host-lifecycle-port');
const { createElectronAddonStorePort } = require('../../src/adapters/electron/electron-addon-store-port');
const { createCliApp } = require('../../src/cli/main');
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

  // F6, R5-F4, R6-F2: regex literals, nested template `${...}`, CR-only (\r), \u2028/\u2029, and ESM+Hashbang
  const templateSrc = [
    '#!/usr/bin/env node',
    "const re = /foo\\/bar\\`/g;",
    "const tpl = `line1 ${`nested\r  // keep inside CR-separated nested template\rinner`}",
    "  // keep this inside outer template literal\u2028  // keep after LS inside template",
    "line3`;",
    "// top level removable comment line 1 for exact size padding",
    "// top level removable comment line 2 for exact size padding",
    "export const anchorResult = TARGET_ANCHOR();",
  ].join('\r\n');
  const transformed = transformExactSize(
    Buffer.from(templateSrc, 'utf8'),
    'TARGET_ANCHOR();',
    'TARGET_ANCHOR();/*MARK*/void 0;',
    'MARK'
  ).toString('utf8');
  assert.equal(transformed.includes('// keep inside CR-separated nested template'), true);
  assert.equal(transformed.includes('// keep this inside outer template literal'), true);
  assert.equal(transformed.includes('// keep after LS inside template'), true);
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

    // 4) R8-F1: ESM file with // comments BEFORE and AFTER import/export where delta > sum(pre-import comments)
    //    must NOT double-count pre-import comments on script->module fallback
    const esmSource = [
      '// pre-import-comment-one-aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '// pre-import-comment-two-bbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      "import fs from 'node:fs';",
      '// post-import-comment-three-cccccccccccccccccccccccccccccccccccc',
      '// post-import-comment-four-dddddddddddddddddddddddddddddddddddd',
      'export const boot = () => {',
      '  return fs.existsSync(".");',
      '};',
    ].join('\n');
    const esmTarget = '  return fs.existsSync(".");';
    // Replacement delta (~135 bytes) > sum of the two pre-import comments (~110 bytes)
    const esmReplacement =
      '  /* MARKER_ESM_R8 */ const __hooked = typeof process === "object" && Boolean(process.env.ESM_HOOK_TEST_LONG_VAR_NAME_1234567890); return __hooked && fs.existsSync(".");';
    const esmOrigBuf = Buffer.from(esmSource, 'utf8');
    const esmPatchedBuf = transformExactSize(esmOrigBuf, esmTarget, esmReplacement, 'MARKER_ESM_R8');
    assert.equal(esmPatchedBuf.length, esmOrigBuf.length);
    assert.equal(esmPatchedBuf.toString('utf8').includes('MARKER_ESM_R8'), true);
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
    const pkg = require('../../package.json');

    // R2-F1: --version must match package.json version (1.0.1)
    assert.equal(runBin(['--version']).trim(), pkg.version);
    assert.match(runBin(['--help']), /--profile/);

    const valOut = JSON.parse(runBin(['--profile', profileFile, '--validate', manifestFile]));
    assert.equal(valOut.ok, true);

    const regOut = JSON.parse(runBin(['--profile', profileFile, '--register', manifestFile]));
    assert.equal(regOut.ok, true);
    assert.equal(regOut.pluginId, 'acme-bar');

    const statusOut = JSON.parse(runBin(['--profile', profileFile, '--status']));
    assert.equal(statusOut.hostProfileId, 'acme-cli-profile');
    assert.equal(statusOut.hostVersion, pkg.version);
    assert.equal(statusOut.activeAddons.length, 1);
    assert.equal(statusOut.activeAddons[0].pluginId, 'acme-bar');

    const doctorOut = JSON.parse(runBin(['--profile', profileFile, '--doctor']));
    assert.equal(doctorOut.healthy, false);
    assert.equal(doctorOut.host.hasLegacyConflict, true);
    assert.equal(doctorOut.host.legacyMarkers.includes('AGY_STATUSBAR'), true);

    // R2-F5: --install without --replace-legacy must exit non-zero on legacy patch
    let installErr = null;
    try {
      runBin(['--profile', profileFile, '--install']);
    } catch (e) {
      installErr = e;
    }
    assert.ok(installErr && installErr.status === 1);
    assert.equal(JSON.parse(installErr.stdout).asar.status, 'ERR_LEGACY_DIRECT_PATCH_DETECTED');

    // Prepare pure .orig for --install --replace-legacy and --rollback --force via real CLI process
    const pureOrigPath = `${asarPath}.v2.33.0.orig`;
    const pureOrigBuf = buildSyntheticAsar(pureOrigPath);
    const replaceInstOut = JSON.parse(runBin(['--profile', profileFile, '--install', '--replace-legacy']));
    assert.equal(replaceInstOut.status, 'INSTALLED');
    assert.equal(replaceInstOut.asar.status, 'INSTALLED');

    const rbForceOut = JSON.parse(runBin(['--profile', profileFile, '--rollback', '--force']));
    assert.equal(rbForceOut.status, 'ROLLED_BACK');
    assert.deepEqual(fs.readFileSync(asarPath), pureOrigBuf);

    const unregOut = JSON.parse(runBin(['--profile', profileFile, '--unregister', 'acme-bar']));
    assert.equal(unregOut.ok, true);
    assert.equal(unregOut.removed, true);

    // After --rollback --force, direct diagnoseAsarState must report clean unpatched state
    const diag = diagnoseAsarState(
      { ASAR_PATH: asarPath, ASAR_LOCK_PATH: path.join(dir, 'asar.lock') },
      ANTIGRAVITY_HOST_PROFILE
    );
    assert.equal(diag.hasLegacyConflict, false);
    assert.equal(diag.hostInstalled, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TC-014 (R5-F1, R6-F1, NB1-NB3): SOLID ISP/DIP segregated ports, non-Electron CLI mock with zero ASAR fields, ADDONS_LOCK_PATH re-derivation, and non-canonical unregister', async () => {
  // 1) Core HostProfile port accepts minimal non-Electron profile without Electron/ASAR fields
  const minimalProfile = { id: 'minimal-non-electron', resolvePaths: () => ({}) };
  assert.equal(validateHostProfile(minimalProfile).ok, true);

  // 2) Electron adapter port rejects missing Electron fields, newline in patchMarker, AND resolvePaths: () => ({})
  assert.equal(validateElectronHostProfile(minimalProfile).ok, false);
  assert.equal(validateElectronHostProfile(minimalProfile).reason, 'MISSING_ELECTRON_PROFILE_FIELD:patchMarker');
  assert.equal(
    validateElectronHostProfile({ ...ANTIGRAVITY_HOST_PROFILE, patchMarker: 'BAD\nMARKER' }).reason,
    'INVALID_PATCH_MARKER_NEWLINE'
  );

  const brokenElectronProfile = {
    ...ANTIGRAVITY_HOST_PROFILE,
    resolvePaths: () => ({}),
  };
  const electronLifecycle = createElectronHostLifecyclePort();
  assert.throws(() => electronLifecycle.resolveContext(brokenElectronProfile), /MISSING_RESOLVED_PATH:ADDONS_DIR/);

  // NB2: Overriding ADDONS_DIR alone must re-derive ADDONS_LOCK_PATH co-located with overridden ADDONS_DIR
  const customAddonsDir = path.join(os.tmpdir(), 'override-dir-test', 'addons.d');
  const resolvedOverride = resolveElectronPaths(ANTIGRAVITY_HOST_PROFILE, process.env, {
    ADDONS_DIR: customAddonsDir,
  });
  assert.equal(
    resolvedOverride.paths.ADDONS_LOCK_PATH,
    path.join(path.dirname(customAddonsDir), 'addon-host-addons.lock')
  );

  // 3) CLI factory & runCli work with segregated non-Electron ports returning an opaque ctx
  //    (zero ctx.paths, zero activeProfile, zero fake ASAR fields, resolveContext called strictly ONCE per runCli)
  let resolveContextCalls = 0;
  let validateManifestCalls = 0;
  const fakeNonElectronLifecycle = {
    validateProfile: (p) => {
      if (!p || !p.id) throw new Error('BAD_PROFILE');
      return p;
    },
    resolveContext: (p) => {
      resolveContextCalls++;
      return { hostProfileId: p.id, opaqueToken: `ctx-${resolveContextCalls}` };
    },
    getHostStatus: () => ({ installed: true, engine: 'virtual-host' }),
    diagnoseHost: () => ({ healthy: false, reason: 'VIRTUAL_UNHEALTHY' }),
    installHost: () => ({ ok: true, status: 'INSTALLED' }),
    rollbackHost: () => ({ ok: true, status: 'ROLLED_BACK' }),
  };
  const fakeNonElectronStore = {
    planAddons: () => ({ active: [], disabled: [], rejected: [], slots: {} }),
    validateManifest: (ctx, manifest) => {
      validateManifestCalls++;
      assert.equal(ctx.hostProfileId, 'minimal-non-electron');
      assert.equal(ctx.paths, undefined, 'R7-F1: non-Electron opaque ctx must not require ctx.paths');
      return { ok: Boolean(manifest && manifest.pluginId), pluginId: manifest && manifest.pluginId };
    },
    registerManifest: (ctx, manifest) => {
      assert.equal(ctx.paths, undefined);
      return { ok: true, pluginId: manifest.pluginId };
    },
    unregisterManifest: (ctx, pluginId) => {
      assert.equal(ctx.paths, undefined);
      return { ok: true, removed: true, pluginId };
    },
  };
  const cli = createCliApp({
    hostLifecycle: fakeNonElectronLifecycle,
    addonStore: fakeNonElectronStore,
    defaultProfile: minimalProfile,
    hostVersion: '1.0.1',
  });
  const status = cli.buildStatusReport();
  assert.equal(status.hostProfileId, 'minimal-non-electron');
  assert.equal(status.hostInstalled, true);
  assert.equal(status.hostStatus.engine, 'virtual-host');

  const doctor = cli.buildDoctorReport();
  assert.equal(doctor.healthy, false);
  assert.equal(doctor.host.reason, 'VIRTUAL_UNHEALTHY');

  // R7-F1: Exercise runCli end-to-end against non-Electron ports and assert single resolveContext per command
  const tmpCliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-runcli-non-electron-'));
  const origWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    const sampleManifestFile = path.join(tmpCliDir, 'sample.json');
    fs.writeFileSync(sampleManifestFile, JSON.stringify({ pluginId: 'mock-plugin' }), 'utf8');

    resolveContextCalls = 0;
    const rStatus = await cli.runCli(['--status']);
    assert.equal(resolveContextCalls, 1, 'R7-F1: runCli --status must resolveContext strictly once');
    assert.equal(rStatus.hostProfileId, 'minimal-non-electron');

    resolveContextCalls = 0;
    const rDoctor = await cli.runCli(['--doctor']);
    assert.equal(resolveContextCalls, 1, 'R7-F1: runCli --doctor must resolveContext strictly once');
    assert.equal(rDoctor.healthy, false);

    resolveContextCalls = 0;
    validateManifestCalls = 0;
    const rValidate = await cli.runCli(['--validate', sampleManifestFile]);
    assert.equal(resolveContextCalls, 1, 'R7-F1: runCli --validate must resolveContext strictly once');
    assert.equal(validateManifestCalls, 1, 'R7-F1: runCli --validate must delegate to AddonStorePort.validateManifest');
    assert.equal(rValidate.ok, true);

    resolveContextCalls = 0;
    const rRegister = await cli.runCli(['--register', sampleManifestFile]);
    assert.equal(resolveContextCalls, 1, 'R7-F1: runCli --register must resolveContext strictly once');
    assert.equal(rRegister.ok, true);

    resolveContextCalls = 0;
    const rUnregister = await cli.runCli(['--unregister', 'mock-plugin']);
    assert.equal(resolveContextCalls, 1, 'R7-F1: runCli --unregister must resolveContext strictly once');
    assert.equal(rUnregister.ok, true);

    resolveContextCalls = 0;
    const rInstall = await cli.runCli(['--install']);
    assert.equal(resolveContextCalls, 1, 'R7-F1: runCli --install must resolveContext strictly once');
    assert.equal(rInstall.status, 'INSTALLED');

    resolveContextCalls = 0;
    const rRollback = await cli.runCli(['--rollback']);
    assert.equal(resolveContextCalls, 1, 'R7-F1: runCli --rollback must resolveContext strictly once');
    assert.equal(rRollback.status, 'ROLLED_BACK');
  } finally {
    process.stdout.write = origWrite;
    fs.rmSync(tmpCliDir, { recursive: true, force: true });
  }

  // NB3: --register/-flag and --unregister/-flag fail closed
  assert.equal(cli.registerAddonManifestFile('--bad-flag').reason, 'ERR_MANIFEST_FILE_NOT_FOUND');
  assert.equal(cli.unregisterAddonManifest('--bad-flag').reason, 'ERR_INVALID_PLUGIN_ID');

  // NB1: Electron AddonStorePort unregisters non-canonical filename holding the same pluginId
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-noncanon-'));
  try {
    const addonsDir = path.join(dir, 'addons.d');
    fs.mkdirSync(addonsDir, { recursive: true });
    const nonCanon = path.join(addonsDir, '99-alias-name.json');
    fs.writeFileSync(nonCanon, JSON.stringify({ pluginId: 'dup-plugin' }), 'utf8');
    const store = createElectronAddonStorePort();
    const res = store.unregisterManifest(
      {
        activeProfile: ANTIGRAVITY_HOST_PROFILE,
        paths: {
          ADDONS_DIR: addonsDir,
          ADDONS_LOCK_PATH: path.join(dir, 'addons.lock'),
          LOADER_SCRIPT_PATH: path.join(dir, 'loader.js'),
        },
      },
      'dup-plugin'
    );
    assert.equal(res.ok, true);
    assert.equal(res.removed, true);
    assert.equal(fs.existsSync(nonCanon), false);
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
      console.log(
        JSON.stringify({
          realAsarVerified: true,
          appVersion: inst.appVersion,
          bytes: origBuf.length,
          origSha256: origHash,
          patchedSha256: inst.sha256,
          restoredSha256: restoredHash,
        })
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);
