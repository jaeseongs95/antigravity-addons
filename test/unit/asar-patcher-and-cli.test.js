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
    // v2.0.0: .orig and .orig.json live in BACKUPS_DIR, NOT alongside app.asar in resources/
    assert.notEqual(path.dirname(inst.backupPath), path.dirname(asarPath));

    // Tamper .orig.json -> rollback must fail closed
    const metaPath = `${inst.backupPath}.json`;
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
      {
        ...paths,
        ASAR_PATH: noIntPath,
        ASAR_LOCK_PATH: path.join(dir, 'noint.lock'),
        BACKUPS_DIR: path.join(dir, 'backups-noint'),
      },
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

test('TC-010 (F5): custom non-Antigravity HostProfile works across install, delta>0 comment stripping, .orig reinstall, and rollback (and rejects process.env anchor overrides)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-custom-'));
  try {
    // v2.0.0 security: custom profile using process.env.* in mainAnchorReplacement MUST fail closed
    const insecureProfile = Object.freeze({
      id: 'acme-insecure',
      patchMarker: 'ACME_HOST_LOADER_V1',
      mainEntry: 'dist/main.js',
      mainAnchorTarget: "app.on('web-contents-created', (_e, contents) => {",
      mainAnchorReplacement:
        "app.on('web-contents-created', (_e, contents) => {\n// ACME_HOST_LOADER_V1\ntry{require(process.env.ACME_HOST_LOADER_PATH).initMain(app);}catch(_e){}",
      legacyPatchMarkers: Object.freeze([]),
      resolvePaths: () => ({}),
    });
    const asarPath = path.join(dir, 'app.asar');
    const origBuf = buildSyntheticAsar(asarPath, {
      version: '4.0.0',
      anchorTarget: insecureProfile.mainAnchorTarget,
    });
    const paths = {
      ASAR_PATH: asarPath,
      ASAR_LOCK_PATH: path.join(dir, 'asar.lock'),
      BACKUPS_DIR: path.join(dir, 'backups'),
      ADDONS_DIR: path.join(dir, 'addons.d'),
      LOADER_SCRIPT_PATH: path.join(dir, 'loader.js'),
    };
    assert.throws(
      () => installAsarAddonHost(paths, insecureProfile),
      /ERR_ANCHOR_ENV_OVERRIDE_FORBIDDEN/
    );

    const customProfile = Object.freeze({
      id: 'acme-electron-app',
      patchMarker: 'ACME_HOST_LOADER_V2',
      mainEntry: 'dist/main.js',
      mainAnchorTarget: "app.on('web-contents-created', (_e, contents) => {",
      mainAnchorReplacement:
        "app.on('web-contents-created', (_e, contents) => {\n// ACME_HOST_LOADER_V2\ntry{const _p=require('path').join(require('os').homedir(),'.acme','loader.js');if(require('path').isAbsolute(_p)&&require('fs').existsSync(_p))require(_p).initMain(app);}catch(_e){}",
      legacyPatchMarkers: Object.freeze(['ACME_OLD_PATCH']),
      resolvePaths: () => ({}),
    });

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
  assert.equal(
    validateElectronHostProfile({ ...ANTIGRAVITY_HOST_PROFILE, uiAnchors: 'bad' }).reason,
    'INVALID_UI_ANCHORS'
  );
  assert.equal(
    validateElectronHostProfile({ ...ANTIGRAVITY_HOST_PROFILE, uiAnchors: { sidebar: [] } }).reason,
    'INVALID_UI_ANCHOR_ENTRY:sidebar'
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

    // R9-F1: Direct port unregisterManifest must block path traversal, forbidden IDs, and empty IDs
    // without touching files outside ADDONS_DIR (e.g. ../../config/config.json)
    const nestedAddonsDir = path.join(dir, 'host', 'addons.d');
    const externalConfigDir = path.join(dir, 'config');
    const externalConfigFile = path.join(externalConfigDir, 'config.json');
    const externalOutsideFile = path.join(dir, 'host', 'outside.json');
    fs.mkdirSync(nestedAddonsDir, { recursive: true });
    fs.mkdirSync(externalConfigDir, { recursive: true });
    fs.writeFileSync(externalConfigFile, '{"protected":true}', 'utf8');
    fs.writeFileSync(externalOutsideFile, '{"protected":true}', 'utf8');
    const portCtx = {
      activeProfile: ANTIGRAVITY_HOST_PROFILE,
      paths: {
        ADDONS_DIR: nestedAddonsDir,
        ADDONS_LOCK_PATH: path.join(dir, 'host', 'addons.lock'),
        LOADER_SCRIPT_PATH: path.join(dir, 'host', 'loader.js'),
      },
    };
    for (const badId of ['../../config/config', '../outside', 'constructor', '']) {
      const badRes = store.unregisterManifest(portCtx, badId);
      assert.equal(badRes.ok, false, `R9-F1: unregisterManifest must reject "${badId}"`);
      assert.equal(badRes.reason, 'ERR_INVALID_PLUGIN_ID');
    }
    assert.equal(fs.existsSync(externalConfigFile), true, 'R9-F1: external config.json must remain untouched');
    assert.equal(fs.existsSync(externalOutsideFile), true, 'R9-F1: external outside.json must remain untouched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TC-019 (P0): same-version Build A vs Build B mismatch fails closed (ERR_ORIG_BUILD_MISMATCH), --refresh-orig archives previous .orig, and tampered patched ASAR blocks non-force rollback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-tc019-'));
  try {
    const asarPath = path.join(dir, 'app.asar');
    const paths = {
      ASAR_PATH: asarPath,
      ASAR_LOCK_PATH: path.join(dir, 'asar.lock'),
      ADDONS_DIR: path.join(dir, 'addons.d'),
      ADDONS_LOCK_PATH: path.join(dir, 'addons.lock'),
      LOADER_SCRIPT_PATH: path.join(dir, 'addon-host-loader.js'),
      PLUGINS_ROOT_DIR: path.join(dir, 'plugins'),
      CONFIG_JSON_PATH: path.join(dir, 'config.json'),
    };
    const lifecycle = createElectronHostLifecyclePort();
    const ctx = { hostProfileId: ANTIGRAVITY_HOST_PROFILE.id, activeProfile: ANTIGRAVITY_HOST_PROFILE, paths };

    // 1) Install Build A (v2.33.0) -> records patchedSha256 in .orig.json -> rollback to pure Build A
    const buildABuf = buildSyntheticAsar(asarPath, { version: '2.33.0', extraLines: ['// vendor build A'] });
    const buildASha = crypto.createHash('sha256').update(buildABuf).digest('hex');
    const instA = installAsarAddonHost(paths, ANTIGRAVITY_HOST_PROFILE);
    assert.equal(instA.status, 'INSTALLED');
    assert.equal(instA.origSha256, buildASha);
    const metaPath = `${instA.backupPath}.json`;
    const metaA = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.equal(metaA.patchedSha256, instA.sha256);
    const patchedABuf = fs.readFileSync(asarPath);

    const rbA = rollbackAsarAddonHost(paths, ANTIGRAVITY_HOST_PROFILE);
    assert.equal(rbA.status, 'ROLLED_BACK');
    assert.deepEqual(fs.readFileSync(asarPath), buildABuf);

    // 2) Vendor silently ships Build B with SAME version 2.33.0 but different content/SHA
    const buildBBuf = buildSyntheticAsar(asarPath, { version: '2.33.0', extraLines: ['// vendor hotfix build B'] });
    const buildBSha = crypto.createHash('sha256').update(buildBBuf).digest('hex');
    assert.notEqual(buildBSha, buildASha);

    // diagnoseHost must detect origBuildMismatch & mark unhealthy
    const diagMismatch = lifecycle.diagnoseHost(ctx);
    assert.equal(diagMismatch.origBuildMismatch, true);
    assert.equal(diagMismatch.healthy, false);

    // Installing WITHOUT refreshOrig must fail closed and NEVER overwrite Build B with Build A!
    const blocked = installAsarAddonHost(paths, ANTIGRAVITY_HOST_PROFILE);
    assert.equal(blocked.status, 'ERR_ORIG_BUILD_MISMATCH');
    assert.equal(blocked.currentSha256, buildBSha);
    assert.equal(blocked.backupSha256, buildASha);
    assert.deepEqual(fs.readFileSync(asarPath), buildBBuf, 'P0: Build B must remain byte-identical when mismatch is blocked');

    // 3) Explicit refreshOrig archives Build A .orig, updates .orig to Build B, and patches Build B
    const refreshed = lifecycle.installHost(ctx, { refreshOrig: true });
    assert.equal(refreshed.ok, true);
    assert.equal(refreshed.status, 'INSTALLED');
    assert.equal(refreshed.asar.origSha256, buildBSha);
    const backupsDir = path.dirname(instA.backupPath);
    const archivedAPath = path.join(backupsDir, `app.asar.v2.33.0.${buildASha.slice(0, 8)}.orig`);
    assert.equal(fs.existsSync(archivedAPath), true, 'P0: previous Build A .orig must be archived in BACKUPS_DIR');
    assert.deepEqual(fs.readFileSync(archivedAPath), buildABuf);
    assert.equal(lifecycle.diagnoseHost(ctx).healthy, true);

    // 4) Tamper patched app.asar (swap in Build A's patched bytes while .orig.json expects Build B's patchedSha256)
    fs.writeFileSync(asarPath, patchedABuf);
    const diagTampered = lifecycle.diagnoseHost(ctx);
    assert.equal(diagTampered.patchedShaMismatch, true);
    assert.equal(diagTampered.healthy, false);

    // Rollback WITHOUT force must fail closed with ERR_PATCHED_ASAR_UNEXPECTED_MODIFICATION
    const rbBlocked = rollbackAsarAddonHost(paths, ANTIGRAVITY_HOST_PROFILE);
    assert.equal(rbBlocked.status, 'ERR_PATCHED_ASAR_UNEXPECTED_MODIFICATION');
    assert.deepEqual(fs.readFileSync(asarPath), patchedABuf);

    // Rollback WITH force: true overrides explicitly and restores Build B pure .orig
    const rbForced = rollbackAsarAddonHost(paths, ANTIGRAVITY_HOST_PROFILE, { force: true });
    assert.equal(rbForced.status, 'ROLLED_BACK');
    assert.deepEqual(fs.readFileSync(asarPath), buildBBuf);

    // NB3: --refresh-orig against a Build C whose transformExactSize fails must NOT mutate existing Build B .orig!
    const buildCBuf = buildSyntheticAsar(asarPath, {
      version: '2.33.0',
      anchorTarget: '// missing anchor target so transform fails',
    });
    const buildBOrigPath = refreshed.asar.backupPath;
    const buildBOrigBefore = fs.readFileSync(buildBOrigPath);
    const failedRefresh = installAsarAddonHost(
      { ...paths, ALLOW_REFRESH_ORIG: true },
      ANTIGRAVITY_HOST_PROFILE
    );
    assert.equal(failedRefresh.status, 'ERR_EXACT_SIZE_TRANSFORM_FAILED');
    assert.deepEqual(fs.readFileSync(buildBOrigPath), buildBOrigBefore, 'NB3: failed refresh must preserve existing .orig');
    assert.deepEqual(fs.readFileSync(asarPath), buildCBuf, 'NB3: failed refresh must leave live app.asar untouched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TC-020 (P2): transactional installHost stages loader first and auto-compensates on ASAR failure or lock contention', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-tc020-'));
  try {
    const asarPath = path.join(dir, 'app.asar');
    const paths = {
      ASAR_PATH: asarPath,
      ASAR_LOCK_PATH: path.join(dir, 'asar.lock'),
      ADDONS_DIR: path.join(dir, 'addons.d'),
      ADDONS_LOCK_PATH: path.join(dir, 'addons.lock'),
      LOADER_SCRIPT_PATH: path.join(dir, 'addon-host-loader.js'),
      PLUGINS_ROOT_DIR: path.join(dir, 'plugins'),
      CONFIG_JSON_PATH: path.join(dir, 'config.json'),
    };
    const lifecycle = createElectronHostLifecyclePort();
    const ctx = { hostProfileId: ANTIGRAVITY_HOST_PROFILE.id, activeProfile: ANTIGRAVITY_HOST_PROFILE, paths };

    // Case 1: ADDONS_LOCK held -> installHost fails at LOADER_LOCK_FAILED without touching app.asar
    const pureBuf = buildSyntheticAsar(asarPath);
    const heldLock = acquireExclusiveLockDetailed(paths.ADDONS_LOCK_PATH);
    assert.equal(heldLock.ok, true);
    try {
      const lockFail = lifecycle.installHost(ctx);
      assert.equal(lockFail.ok, false);
      assert.equal(lockFail.phase, 'LOADER_LOCK_FAILED');
      assert.equal(fs.existsSync(paths.LOADER_SCRIPT_PATH), false);
      assert.deepEqual(fs.readFileSync(asarPath), pureBuf);
    } finally {
      releaseExclusiveLock(paths.ADDONS_LOCK_PATH, heldLock.token);
    }

    // Case 2: Fresh install where ASAR fails (legacy direct patch present, replaceLegacy=false)
    //         -> staged loader must be removed (compensated: true)
    const legacyBuf = buildSyntheticAsar(asarPath, { extraLines: ['// AGY_STATUSBAR_LEGACY'] });
    const freshFail = lifecycle.installHost(ctx, { replaceLegacy: false });
    assert.equal(freshFail.ok, false);
    assert.equal(freshFail.phase, 'ASAR_PATCH_FAILED');
    assert.equal(freshFail.compensated, true);
    assert.equal(freshFail.asar.status, 'ERR_LEGACY_DIRECT_PATCH_DETECTED');
    assert.equal(fs.existsSync(paths.LOADER_SCRIPT_PATH), false, 'P2: newly staged loader must be deleted on ASAR failure');
    assert.deepEqual(fs.readFileSync(asarPath), legacyBuf);

    // Case 3: Existing prior loader present + ASAR patch failure -> prior loader bytes restored intact
    const priorLoader = '// prior-loader-v1.0.1-sentinel\n';
    fs.writeFileSync(paths.LOADER_SCRIPT_PATH, priorLoader, 'utf8');
    const upgradeFail = lifecycle.installHost(ctx, { replaceLegacy: false });
    assert.equal(upgradeFail.ok, false);
    assert.equal(upgradeFail.phase, 'ASAR_PATCH_FAILED');
    assert.equal(upgradeFail.compensated, true);
    assert.equal(fs.readFileSync(paths.LOADER_SCRIPT_PATH, 'utf8'), priorLoader, 'P2: prior loader must be restored verbatim');
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
