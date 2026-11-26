'use strict';

/**
 * Phase-0 (v2.9.0) Regression & Unit Tests:
 * - Axis 3B Auto-Update Survival (Option 3B-1: Layer 2 + Windows Layer 1 Fail-Open ACK)
 * - 4 Verified Remote Web Security Fixes (CONNECT_HOST_RE SSRF ban, @require #sha256 SRI,
 *   buildAddonUserscript trust-policy gate on hasSettingsBridge, remote-bootstrap ev.isTrusted)
 * - SOLID #0 Zero-Vendor-Literal Check for new core/runtime modules
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  assertValidUpdateSurvivalConfig,
  evaluateReconcileEligibility,
  recordReconcileOutcome,
  normalizeReconcileState,
} = require('../../src/core/update-survival-port');
const {
  isPathInsideDir,
  isAllowedExternalNodePath,
  resolveExternalNodeExecutable,
  reconcileElectronHost,
  runDetachedHandoffReconcile,
  launchHostWithReconcile,
  spawnAppDetached,
  verifyAsarReadyForPatch,
} = require('../../src/adapters/electron/update-reconciler');
const asar = require('@electron/asar');
const { EventEmitter } = require('node:events');
const {
  createUpdateSurvivalHook,
  isValidExternalNodeBinary,
} = require('../../src/runtime/main/update-survival-hook');
const {
  normalizeHostLibUrl,
  normalizeConnectHosts,
  buildAddonUserscript,
} = require('../../scripts/build-remote');
const { createRendererKernel } = require('../../src/runtime/renderer/kernel');
const { ANTIGRAVITY_REMOTE_WEB_PROFILE } = require('../../src/profiles/antigravity-remote-web');
const {
  registerAddon,
  bootRemoteWebHost,
} = require('../../src/adapters/remote-web/remote-bootstrap');

const SAMPLE_SHA_A = 'a'.repeat(64);
const SAMPLE_SHA_B = 'b'.repeat(64);

test('TC-V29-01: UpdateSurvival eligibility preserves intentional rollback, trips per-SHA256 circuit breaker after 1 failure, resets on new SHA256, and keeps macOS detect-only', () => {
  const cfg = assertValidUpdateSurvivalConfig({
    updaterModule: 'electron-updater',
    method: 'quitAndInstall',
    platforms: ['win32'],
  });
  assert.equal(cfg.ackTimeoutMs, 250);
  assert.equal(cfg.waitTimeoutMs, 45000);
  assert.throws(() => assertValidUpdateSurvivalConfig({ updaterModule: '', method: 'quitAndInstall' }), /ERR_UPDATE_SURVIVAL_INVALID_UPDATER_MODULE/);

  // 1. Intentional rollback (`rolledBackAt != null`) MUST NOT auto-repatch
  const rollbackRes = evaluateReconcileEligibility({
    diag: {
      asarExists: true,
      status: 'UNPATCHED',
      updatedUnpatched: false,
      rolledBackAt: '2026-11-25T00:00:00.000Z',
      asarSha256: SAMPLE_SHA_A,
    },
    state: normalizeReconcileState(null),
    platform: 'win32',
  });
  assert.equal(rollbackRes.eligible, false);
  assert.equal(rollbackRes.reason, 'INTENTIONAL_ROLLBACK_PRESERVED');

  // Even if status were manually forced while rolledBackAt is set, still blocked
  const forcedRollbackRes = evaluateReconcileEligibility({
    diag: {
      asarExists: true,
      status: 'UPDATED_UNPATCHED',
      updatedUnpatched: true,
      rolledBackAt: '2026-11-25T00:00:00.000Z',
      asarSha256: SAMPLE_SHA_A,
    },
    state: normalizeReconcileState(null),
    platform: 'win32',
  });
  assert.equal(forcedRollbackRes.eligible, false);
  assert.equal(forcedRollbackRes.reason, 'INTENTIONAL_ROLLBACK_PRESERVED');

  // 2. macOS (`darwin`) MUST default to detect-only (no automatic re-patch)
  const macRes = evaluateReconcileEligibility({
    diag: {
      asarExists: true,
      status: 'UPDATED_UNPATCHED',
      updatedUnpatched: true,
      rolledBackAt: null,
      asarSha256: SAMPLE_SHA_A,
      appVersion: '2.35.2',
    },
    state: normalizeReconcileState(null),
    platform: 'darwin',
  });
  assert.equal(macRes.eligible, false);
  assert.equal(macRes.reason, 'MACOS_DETECT_ONLY');

  // 3. Windows eligible when UPDATED_UNPATCHED & no prior failure
  const winRes = evaluateReconcileEligibility({
    diag: {
      asarExists: true,
      status: 'UPDATED_UNPATCHED',
      updatedUnpatched: true,
      rolledBackAt: null,
      asarSha256: SAMPLE_SHA_A,
      appVersion: '2.35.2',
    },
    state: normalizeReconcileState(null),
    platform: 'win32',
  });
  assert.equal(winRes.eligible, true);
  assert.equal(winRes.reason, 'ELIGIBLE_UPDATED_UNPATCHED');

  // 4. Persistent failure trips per-asarSha256 circuit breaker after 1 attempt
  const failedState = recordReconcileOutcome(null, {
    asarSha256: SAMPLE_SHA_A,
    ok: false,
    reason: 'ANCHOR_NOT_FOUND',
    appVersion: '2.35.2',
  });
  const tripped = evaluateReconcileEligibility({
    diag: {
      asarExists: true,
      status: 'UPDATED_UNPATCHED',
      updatedUnpatched: true,
      rolledBackAt: null,
      asarSha256: SAMPLE_SHA_A,
    },
    state: failedState,
    platform: 'win32',
  });
  assert.equal(tripped.eligible, false);
  assert.equal(tripped.reason, 'CIRCUIT_BREAKER_TRIPPED');

  // 5. Brand-new target build hash (SAMPLE_SHA_B) is NOT blocked by SAMPLE_SHA_A failure
  const nextBuild = evaluateReconcileEligibility({
    diag: {
      asarExists: true,
      status: 'UPDATED_UNPATCHED',
      updatedUnpatched: true,
      rolledBackAt: null,
      asarSha256: SAMPLE_SHA_B,
    },
    state: failedState,
    platform: 'win32',
  });
  assert.equal(nextBuild.eligible, true);

  // 6. Transient Windows file lock does NOT permanently trip the circuit breaker
  const lockedState = recordReconcileOutcome(null, {
    asarSha256: SAMPLE_SHA_A,
    ok: false,
    reason: 'ERR_TARGET_LOCKED_APP_RUNNING',
    appVersion: '2.35.2',
  });
  const afterTransientLock = evaluateReconcileEligibility({
    diag: {
      asarExists: true,
      status: 'UPDATED_UNPATCHED',
      updatedUnpatched: true,
      rolledBackAt: null,
      asarSha256: SAMPLE_SHA_A,
    },
    state: lockedState,
    platform: 'win32',
  });
  assert.equal(afterTransientLock.eligible, true);
});

test('TC-V29-02: External Node resolver strictly rejects binaries inside $INSTDIR (including app exe) and prefers staged external node', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-v29-extnode-'));
  try {
    const installDir = path.join(tmp, 'Programs', 'MyApp');
    const resourcesDir = path.join(installDir, 'resources');
    const hostDataDir = path.join(tmp, 'host-data');
    const stagedBinDir = path.join(hostDataDir, 'bin');
    const externalBinDir = path.join(tmp, 'system-node');
    fs.mkdirSync(resourcesDir, { recursive: true });
    fs.mkdirSync(stagedBinDir, { recursive: true });
    fs.mkdirSync(externalBinDir, { recursive: true });

    const nodeBinName = process.platform === 'win32' ? 'node.exe' : 'node';
    const appExe = path.join(installDir, process.platform === 'win32' ? 'MyApp.exe' : 'MyApp');
    const asarPath = path.join(resourcesDir, 'app.asar');
    const insideNode = path.join(installDir, nodeBinName);
    const stagedNode = path.join(stagedBinDir, nodeBinName);
    const extNode = path.join(externalBinDir, nodeBinName);

    fs.writeFileSync(appExe, 'exe');
    fs.writeFileSync(asarPath, 'asar');
    fs.writeFileSync(insideNode, 'node');
    fs.writeFileSync(extNode, 'node');

    assert.equal(isPathInsideDir(insideNode, installDir), true);
    assert.equal(isPathInsideDir(extNode, installDir), false);
    // F7: subdirectory whose name starts with ".." inside $INSTDIR must still be treated as inside
    const dotDotSubdirNode = path.join(installDir, '..hidden', nodeBinName);
    assert.equal(isPathInsideDir(dotDotSubdirNode, installDir), true);
    // F7: Electron execPath fallback rejects node inside Electron directory even if appExecutablePath/asarPath omitted
    assert.equal(
      isValidExternalNodeBinary(insideNode, {
        appExecutablePath: null,
        asarPath: null,
        platform: process.platform,
        electronExecPath: appExe,
      }),
      false
    );

    // Rejects app executable (wrong basename AND inside $INSTDIR)
    assert.equal(isAllowedExternalNodePath(appExe, { appExecutablePath: appExe, asarPath }), false);
    assert.equal(isValidExternalNodeBinary(appExe, { appExecutablePath: appExe, asarPath, platform: process.platform }), false);

    // Rejects node binary placed inside $INSTDIR
    assert.equal(isAllowedExternalNodePath(insideNode, { appExecutablePath: appExe, asarPath }), false);
    assert.equal(isValidExternalNodeBinary(insideNode, { appExecutablePath: appExe, asarPath, platform: process.platform }), false);

    // Accepts external node strictly outside $INSTDIR
    assert.equal(isAllowedExternalNodePath(extNode, { appExecutablePath: appExe, asarPath }), true);
    assert.equal(isValidExternalNodeBinary(extNode, { appExecutablePath: appExe, asarPath, platform: process.platform }), true);

    // Resolver picks preferred external node when staged bin absent
    const resExt = resolveExternalNodeExecutable({
      hostDataDir,
      appExecutablePath: appExe,
      asarPath,
      preferredNodePath: extNode,
      currentExecPath: appExe,
      envPath: installDir,
    });
    assert.equal(resExt.ok, true);
    assert.equal(resExt.source, 'preferred');

    // Resolver prioritizes host-staged ~/.gemini/.../bin/node(.exe) when present
    fs.writeFileSync(stagedNode, 'node');
    const resStaged = resolveExternalNodeExecutable({
      hostDataDir,
      appExecutablePath: appExe,
      asarPath,
      preferredNodePath: extNode,
      currentExecPath: appExe,
      envPath: externalBinDir,
    });
    assert.equal(resStaged.ok, true);
    assert.equal(resStaged.source, 'staged-host-bin');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('TC-V29-03: Layer-1 Module._load hook fails open verbatim on ACK timeout / missing node, and arms isForceRunAfter=false ONLY after READY ACK', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-v29-hook-'));
  try {
    const installDir = path.join(tmp, 'app-install');
    const hostDataDir = path.join(tmp, 'host-data');
    const extNodeDir = path.join(tmp, 'ext-node');
    fs.mkdirSync(installDir, { recursive: true });
    fs.mkdirSync(hostDataDir, { recursive: true });
    fs.mkdirSync(extNodeDir, { recursive: true });

    const cliEntryPath = path.join(tmp, 'addon-host.js');
    const nodeBinName = process.platform === 'win32' ? 'node.exe' : 'node';
    const extNode = path.join(extNodeDir, nodeBinName);
    const appExe = path.join(installDir, 'App.exe');
    const asarPath = path.join(installDir, 'resources', 'app.asar');
    fs.writeFileSync(cliEntryPath, '// cli\n');
    fs.writeFileSync(extNode, 'node');

    fs.writeFileSync(
      path.join(hostDataDir, 'host-cli.json'),
      JSON.stringify({
        schemaVersion: 2,
        cliEntryPath,
        nodeExecPath: extNode,
        appExecutablePath: appExe,
        asarPath,
      })
    );

    const calls = [];
    const fakeUpdaterModule = {
      autoUpdater: {
        quitAndInstall(isSilent, isForceRunAfter) {
          calls.push({ isSilent, isForceRunAfter });
          return 'CALLED';
        },
      },
    };
    const fakeModuleApi = {
      _load(req) {
        if (req === 'electron-updater') return fakeUpdaterModule;
        return null;
      },
    };

    // Case A: ACK times out -> MUST FAIL OPEN with original isForceRunAfter = true,
    // write .cancel sentinel, and terminate ONLY the unacked helper child (F2)
    let killedUnackedChild = false;
    let timedOutAckPath = null;
    const hookTimeout = createUpdateSurvivalHook({
      updateSurvival: {
        updaterModule: 'electron-updater',
        method: 'quitAndInstall',
        platforms: [process.platform],
        ackTimeoutMs: 25,
        waitTimeoutMs: 5000,
      },
      hostDataDir,
      platform: process.platform,
      moduleApi: fakeModuleApi,
      spawnFn: (_bin, args) => {
        const ackIdx = args.indexOf('--ack-file');
        timedOutAckPath = ackIdx !== -1 ? args[ackIdx + 1] : null;
        return {
          pid: 99999,
          unref() {},
          kill() {
            killedUnackedChild = true;
          },
        };
      },
      sleepSyncFn: () => {},
    });
    assert.equal(hookTimeout.install(), true);
    const loadedA = fakeModuleApi._load('electron-updater');
    loadedA.autoUpdater.quitAndInstall(true, true);
    assert.deepEqual(calls[0], { isSilent: true, isForceRunAfter: true });
    assert.equal(hookTimeout.getStatus().lastHandoff.failOpen, true);
    assert.equal(hookTimeout.getStatus().lastHandoff.reason, 'ERR_RECONCILE_ACK_TIMEOUT');
    assert.equal(killedUnackedChild, true, 'Timed-out helper must be cancelled/killed');
    assert.equal(fs.existsSync(`${timedOutAckPath}.cancel`), true, 'Cancel sentinel must be written on ACK timeout');
    try { fs.unlinkSync(`${timedOutAckPath}.cancel`); } catch (_e) {}
    hookTimeout.dispose();

    // Case B: Helper emits READY:<pid> ACK -> suppresses isForceRunAfter = false
    let spawnedArgs = null;
    const hookAck = createUpdateSurvivalHook({
      updateSurvival: {
        updaterModule: 'electron-updater',
        method: 'quitAndInstall',
        platforms: [process.platform],
        ackTimeoutMs: 100,
        waitTimeoutMs: 5000,
      },
      hostDataDir,
      platform: process.platform,
      moduleApi: fakeModuleApi,
      spawnFn: (_bin, args) => {
        spawnedArgs = args;
        const ackIdx = args.indexOf('--ack-file');
        if (ackIdx !== -1 && args[ackIdx + 1]) {
          fs.writeFileSync(args[ackIdx + 1], 'READY:4242\n');
        }
        return { pid: 4242, unref() {} };
      },
      sleepSyncFn: () => {},
    });
    assert.equal(hookAck.install(), true);
    const loadedB = fakeModuleApi._load('electron-updater');
    loadedB.autoUpdater.quitAndInstall(false, true);
    assert.deepEqual(calls[1], { isSilent: false, isForceRunAfter: false });
    assert.equal(hookAck.getStatus().lastHandoff.ok, true);
    assert.equal(hookAck.getStatus().lastHandoff.failOpen, false);
    assert.ok(spawnedArgs.includes('--reconcile'));
    assert.ok(spawnedArgs.includes('--handoff'));
    assert.ok(spawnedArgs.includes('--relaunch'));
    hookAck.dispose();

    // Case C (F1): Pre-cached updater module in Module._cache is wrapped during install() and restored on dispose()
    const cachedCalls = [];
    const origCachedFn = function (isSilent, isForceRunAfter) {
      cachedCalls.push({ isSilent, isForceRunAfter });
    };
    const preCachedMod = {
      exports: { autoUpdater: { quitAndInstall: origCachedFn } },
    };
    const fakeModuleApiWithCache = {
      _cache: {
        '/app/resources/app.asar/node_modules/electron-updater/out/main.js': preCachedMod,
      },
      _load() {
        return null;
      },
    };
    const hookCached = createUpdateSurvivalHook({
      updateSurvival: {
        updaterModule: 'electron-updater',
        method: 'quitAndInstall',
        platforms: [process.platform],
        ackTimeoutMs: 100,
        waitTimeoutMs: 5000,
      },
      hostDataDir,
      platform: process.platform,
      moduleApi: fakeModuleApiWithCache,
      spawnFn: (_bin, args) => {
        const ackIdx = args.indexOf('--ack-file');
        if (ackIdx !== -1 && args[ackIdx + 1]) {
          fs.writeFileSync(args[ackIdx + 1], 'READY:7777\n');
        }
        return { pid: 7777, unref() {} };
      },
      sleepSyncFn: () => {},
    });
    assert.equal(hookCached.install(), true);
    preCachedMod.exports.autoUpdater.quitAndInstall(true, true);
    assert.deepEqual(cachedCalls[0], { isSilent: true, isForceRunAfter: false });
    hookCached.dispose();
    assert.equal(preCachedMod.exports.autoUpdater.quitAndInstall, origCachedFn);

    // Case D (F3): Async/sync EventEmitter 'error' on spawn must fail open without uncaughtException
    const errCalls = [];
    const errUpdater = {
      autoUpdater: {
        quitAndInstall(isSilent, isForceRunAfter) {
          errCalls.push({ isSilent, isForceRunAfter });
        },
      },
    };
    let caseDAckPath = null;
    const hookSpawnErr = createUpdateSurvivalHook({
      updateSurvival: {
        updaterModule: 'electron-updater',
        method: 'quitAndInstall',
        platforms: [process.platform],
        ackTimeoutMs: 50,
        waitTimeoutMs: 5000,
      },
      hostDataDir,
      platform: process.platform,
      moduleApi: { _cache: { 'electron-updater': { exports: errUpdater } }, _load: () => errUpdater },
      spawnFn: (_bin, args) => {
        const ee = new EventEmitter();
        ee.unref = () => {};
        const ackIdx = args.indexOf('--ack-file');
        caseDAckPath = ackIdx !== -1 ? args[ackIdx + 1] : null;
        // Emit error on next tick (proving listener is attached so no uncaughtException)
        setImmediate(() => ee.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
        return ee;
      },
      sleepSyncFn: () => {},
    });
    assert.equal(hookSpawnErr.install(), true);
    errUpdater.autoUpdater.quitAndInstall(true, true);
    assert.deepEqual(errCalls[0], { isSilent: true, isForceRunAfter: true });
    assert.equal(hookSpawnErr.getStatus().lastHandoff.failOpen, true);
    if (caseDAckPath) {
      try { fs.unlinkSync(`${caseDAckPath}.cancel`); } catch (_e) {}
    }
    hookSpawnErr.dispose();

    // F3: spawnAppDetached attaches error listener so EventEmitter 'error' does not throw uncaughtException
    const detachedMock = new EventEmitter();
    detachedMock.pid = 8888;
    detachedMock.unref = () => {};
    const detachedRes = spawnAppDetached(appExe, () => detachedMock);
    assert.equal(detachedRes.launched, true);
    assert.doesNotThrow(() => detachedMock.emit('error', new Error('ENOENT')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('TC-V29-04: Detached handoff reconciler emits startup ACK and UNCONDITIONALLY relaunches target app even if repatch throws', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-v29-handoff-'));
  try {
    const ackFile = path.join(tmp, 'ack.tmp');
    const appExe = path.join(tmp, 'TargetApp.exe');
    const relaunched = [];

    const ctx = {
      paths: {
        HOST_DATA_DIR: tmp,
        RECONCILE_STATE_PATH: path.join(tmp, 'reconcile-state.json'),
        APP_EXECUTABLE_PATH: appExe,
        ASAR_PATH: null,
      },
    };

    const res = await runDetachedHandoffReconcile(
      ctx,
      {
        diagnoseHost() {
          throw new Error('ANCHOR_NOT_FOUND');
        },
      },
      {
        parentPid: 999999,
        ackFilePath: ackFile,
        relaunch: true,
        waitTimeoutMs: 500,
        pollIntervalMs: 5,
        isPidAliveFn: () => false,
        sleepFn: async () => {},
        spawnFn: (bin, args, opts) => {
          relaunched.push({ bin, args, opts });
          return { pid: 5555, unref() {} };
        },
        reconcileFn: () => {
          throw new Error('ANCHOR_NOT_FOUND');
        },
      }
    );

    assert.equal(fs.existsSync(ackFile), true);
    assert.ok(fs.readFileSync(ackFile, 'utf8').startsWith('READY:'));
    assert.equal(res.ok, false);
    assert.equal(res.error, 'ANCHOR_NOT_FOUND');
    assert.equal(relaunched.length, 1);
    assert.equal(relaunched[0].bin, appExe);
    assert.equal(relaunched[0].opts.shell, false);
    assert.equal(relaunched[0].opts.detached, true);
    assert.equal(res.relaunch.launched, true);

    // Also verify reconcileElectronHost trips circuit breaker on persistent install failure
    let installCalls = 0;
    const fakeLifecycle = {
      diagnoseHost: () => ({
        asarExists: true,
        status: 'UPDATED_UNPATCHED',
        updatedUnpatched: true,
        rolledBackAt: null,
        asarSha256: SAMPLE_SHA_A,
        appVersion: '2.35.2',
      }),
      installHost: () => {
        installCalls += 1;
        return { ok: false, phase: 'ASAR_PATCH_FAILED', asar: { status: 'ANCHOR_NOT_FOUND' } };
      },
    };

    const first = reconcileElectronHost(ctx, fakeLifecycle, { hostVersion: '2.9.0', platform: 'win32' });
    assert.equal(first.ok, false);
    assert.equal(first.action, 'FAILED');
    assert.equal(installCalls, 1);

    const second = reconcileElectronHost(ctx, fakeLifecycle, { hostVersion: '2.9.0', platform: 'win32' });
    assert.equal(second.ok, true);
    assert.equal(second.action, 'SKIPPED');
    assert.equal(second.reason, 'CIRCUIT_BREAKER_TRIPPED');
    assert.equal(installCalls, 1);

    // F2: Cancelled handoff (.cancel sentinel present) MUST NOT reconcile or relaunch (zero double-relaunch)
    const cancelAckFile = path.join(tmp, 'cancelled-ack.tmp');
    fs.writeFileSync(`${cancelAckFile}.cancel`, 'CANCEL\n');
    let cancelledReconcileCalls = 0;
    let cancelledRelaunchCalls = 0;
    const cancelRes = await runDetachedHandoffReconcile(ctx, fakeLifecycle, {
      ackFilePath: cancelAckFile,
      relaunch: true,
      waitTimeoutMs: 200,
      pollIntervalMs: 5,
      isPidAliveFn: () => false,
      sleepFn: async () => {},
      spawnFn: () => {
        cancelledRelaunchCalls += 1;
        return { pid: 6666, unref() {} };
      },
      reconcileFn: () => {
        cancelledReconcileCalls += 1;
        return { ok: true };
      },
    });
    assert.equal(cancelRes.cancelled, true);
    assert.equal(cancelledReconcileCalls, 0);
    assert.equal(cancelledRelaunchCalls, 0);
    assert.equal(fs.existsSync(`${cancelAckFile}.cancel`), false);

    // F4: ASAR wait loop memoizes unchanged signature (only checks once per distinct size:mtimeMs)
    const dummyAsar = path.join(tmp, 'dummy.asar');
    fs.writeFileSync(dummyAsar, 'unchanged-bytes');
    let verifyCalls = 0;
    let pollTicks = 0;
    const waitCtx = {
      paths: {
        ...ctx.paths,
        ASAR_PATH: dummyAsar,
      },
    };
    await runDetachedHandoffReconcile(waitCtx, fakeLifecycle, {
      relaunch: false,
      waitTimeoutMs: 60,
      pollIntervalMs: 5,
      isPidAliveFn: () => false,
      sleepFn: async () => {
        pollTicks += 1;
        await new Promise((r) => setTimeout(r, 6));
      },
      verifyAsarFn: () => {
        verifyCalls += 1;
        return { ok: false, reason: 'WAITING_FOR_UNPATCHED_ASAR' };
      },
      reconcileFn: () => ({ ok: true, action: 'SKIPPED' }),
    });
    assert.ok(pollTicks >= 3, `Expected multiple poll ticks, got ${pollTicks}`);
    assert.equal(verifyCalls, 1, 'Unchanged ASAR signature must only be read/hashed once');

    // F4(a): verifyAsarReadyForPatch rejects an already-patched real ASAR even when prevBundleSha is null
    const asarSrcDir = path.join(tmp, 'asar-src');
    fs.mkdirSync(asarSrcDir, { recursive: true });
    fs.writeFileSync(path.join(asarSrcDir, 'package.json'), JSON.stringify({ name: 'test-app', version: '2.35.2' }));
    fs.writeFileSync(path.join(asarSrcDir, 'main.js'), 'console.log("ok");\n');
    const realAsarPath = path.join(tmp, 'real-test.asar');
    await asar.createPackage(asarSrcDir, realAsarPath);
    const patchedCheck = verifyAsarReadyForPatch(realAsarPath, null, {
      ctx,
      lifecyclePort: { diagnoseHost: () => ({ hostInstalled: true }) },
    });
    assert.equal(patchedCheck.ok, false);
    assert.equal(patchedCheck.reason, 'WAITING_FOR_UNPATCHED_ASAR');
    const unpatchedCheck = verifyAsarReadyForPatch(realAsarPath, null, {
      ctx,
      lifecyclePort: { diagnoseHost: () => ({ hostInstalled: false }) },
    });
    assert.equal(unpatchedCheck.ok, true);

    // F9: launchHostWithReconcile still launches target app even if reconcile throws
    let launchedAfterError = 0;
    const launchRes = launchHostWithReconcile(
      ctx,
      {
        diagnoseHost() {
          throw new Error('DIAG_CRASH');
        },
      },
      {
        hostVersion: '2.9.0',
        platform: 'win32',
        spawnFn: () => {
          launchedAfterError += 1;
          return { pid: 7778, unref() {} };
        },
      }
    );
    assert.equal(launchRes.ok, true);
    assert.equal(launchRes.reconcile.ok, false);
    assert.equal(launchedAfterError, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('TC-V29-05: Remote Web Phase-0 security fixes — CONNECT_HOST_RE bans localhost/IPs/auth origins, @require supports #sha256 SRI, hasSettingsBridge requires trust pinning', () => {
  // 1. CONNECT_HOST_RE SSRF & auth-origin hard rejection
  assert.deepEqual(normalizeConnectHosts(['translate.googleapis.com', 'api.example.com']), [
    'translate.googleapis.com',
    'api.example.com',
  ]);
  for (const badHost of [
    'localhost',
    'localhost.localdomain',
    '127.0.0.1',
    '169.254.169.254',
    '10.0.0.1',
    '192.168.1.1',
    '[::1]',
    'foo.local',
    'db.internal',
    'sub.localhost',
    'corp.intranet',
    '*',
    '*.example.com',
    'antigravity.google.com',
    'sub.antigravity.google.com',
    'accounts.google.com',
    'sub.accounts.google.com',
    `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.${'e'.repeat(20)}.com`,
  ]) {
    assert.throws(() => normalizeConnectHosts([badHost]), /ERR_(INVALID|FORBIDDEN)_CONNECT_HOST/, `Should reject ${badHost}`);
  }

  // 2. @require #sha256= SRI fragment support + arbitrary hash rejection
  const validSha = 'c'.repeat(64);
  const pinnedUrl = normalizeHostLibUrl('https://example.com/v2.9.0/host.lib.js', ANTIGRAVITY_REMOTE_WEB_PROFILE, {
    hostLibSha256: validSha,
  });
  assert.equal(pinnedUrl, `https://example.com/v2.9.0/host.lib.js#sha256=${validSha}`);
  assert.equal(
    normalizeHostLibUrl(`https://example.com/v2.9.0/host.lib.js#sha256=${validSha}`),
    `https://example.com/v2.9.0/host.lib.js#sha256=${validSha}`
  );
  assert.throws(() => normalizeHostLibUrl('https://example.com/host.lib.js#arbitrary'), /ERR_HOST_LIB_URL_UNSAFE/);
  assert.throws(
    () =>
      normalizeHostLibUrl(`https://example.com/host.lib.js#sha256=${validSha}`, ANTIGRAVITY_REMOTE_WEB_PROFILE, {
        hostLibSha256: 'd'.repeat(64),
      }),
    /ERR_HOST_LIB_SHA256_MISMATCH/
  );

  // 3. buildAddonUserscript gates hasSettingsBridge on trust-policy.json SHA-256 verification
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-v29-trust-'));
  try {
    const pluginDir = path.join(tmp, 'p');
    fs.mkdirSync(path.join(pluginDir, 'dist'), { recursive: true });
    const rendererSrc = `addonHost.registerAction('ping', { label: 'Ping', run: () => ({ ok: true }) });\n`;
    fs.writeFileSync(path.join(pluginDir, 'dist', 'renderer.js'), rendererSrc);
    const rendererSha = crypto.createHash('sha256').update(Buffer.from(rendererSrc, 'utf8')).digest('hex');

    const manifestPath = path.join(pluginDir, 'addon-manifest.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        pluginId: 'trusted-sample',
        displayName: 'Trusted Sample',
        version: '1.0.0',
        trustLevel: 'trusted',
        compatibility: {
          hostProfile: 'antigravity-desktop',
          hostProfiles: ['antigravity-desktop', 'antigravity-remote-web'],
          minHostVersion: '2.3.0',
        },
        capabilities: ['renderer'],
        entry: { rendererScript: 'dist/renderer.js' },
        settingsBridge: { fileName: 'sample.json', maxBytes: 4096 },
        uiSlots: [],
        isolation: { storageNamespace: 'trusted-sample', noTranslate: true, i18nSelfManaged: true },
      })
    );

    const hostLibFile = path.join(tmp, 'antigravity-remote-host.lib.js');
    fs.writeFileSync(hostLibFile, '// host lib\n');
    const hostLibSha = crypto.createHash('sha256').update(fs.readFileSync(hostLibFile)).digest('hex');

    // Without trustPolicyPath -> fail-closed: trustLevel MUST downgrade to restricted & hasSettingsBridge MUST be false (F5)
    const unpinned = buildAddonUserscript({
      manifestPath,
      pluginDir,
      targetDir: path.join(tmp, 'out-unpinned'),
      hostLibFile,
    });
    assert.equal(unpinned.buildManifest.trustPinned, false);
    assert.equal(unpinned.buildManifest.hasSettingsBridge, false);
    assert.ok(unpinned.buildManifest.hostLibUrl.endsWith(`#sha256=${hostLibSha}`));
    const unpinnedJs = fs.readFileSync(unpinned.userscriptPath, 'utf8');
    assert.ok(unpinnedJs.includes(`#sha256=${hostLibSha}`));
    assert.ok(unpinnedJs.includes('"trustLevel":"restricted"'));
    assert.ok(unpinnedJs.includes('"hasSettingsBridge":false'));
    assert.ok(unpinnedJs.includes('"hasDocumentTransformSlot":false'));

    // With mismatched trust-policy.json -> throws ERR_ADDON_TRUST_NOT_APPROVED
    const badPolicyPath = path.join(tmp, 'bad-trust.json');
    fs.writeFileSync(
      badPolicyPath,
      JSON.stringify({
        schemaVersion: 1,
        approved: {
          'trusted-sample': { rendererSha256: '0'.repeat(64) },
        },
      })
    );
    assert.throws(
      () =>
        buildAddonUserscript({
          manifestPath,
          pluginDir,
          targetDir: path.join(tmp, 'out-bad-trust'),
          trustPolicyPath: badPolicyPath,
        }),
      /ERR_ADDON_TRUST_NOT_APPROVED/
    );

    // With matching trust-policy.json SHA-256 -> grants hasSettingsBridge: true
    const goodPolicyPath = path.join(tmp, 'good-trust.json');
    fs.writeFileSync(
      goodPolicyPath,
      JSON.stringify({
        schemaVersion: 1,
        approved: {
          'trusted-sample': { rendererSha256: rendererSha },
        },
      })
    );
    const pinned = buildAddonUserscript({
      manifestPath,
      pluginDir,
      targetDir: path.join(tmp, 'out-pinned'),
      trustPolicyPath: goodPolicyPath,
      hostLibSha256: hostLibSha,
    });
    assert.equal(pinned.buildManifest.trustPinned, true);
    assert.equal(pinned.buildManifest.hasSettingsBridge, true);
    const pinnedJs = fs.readFileSync(pinned.userscriptPath, 'utf8');
    assert.ok(pinnedJs.includes('"trustLevel":"trusted"'));
    assert.ok(pinnedJs.includes('"hasSettingsBridge":true'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('TC-V29-06: Remote Web drawer click handlers ignore synthetic untrusted clicks (ev.isTrusted === false) while allowing trusted user clicks', async () => {
  function makeNode(tag) {
    const attrs = new Map();
    const listeners = new Map();
    return {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      style: {},
      children: [],
      parentNode: null,
      shadowRoot: null,
      isConnected: true,
      disabled: false,
      _text: '',
      get id() { return attrs.get('id') || ''; },
      set id(v) { attrs.set('id', String(v)); },
      get className() { return attrs.get('class') || ''; },
      set className(v) { attrs.set('class', String(v)); },
      get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text; },
      set textContent(v) { this._text = String(v == null ? '' : v); this.children = []; },
      get firstChild() { return this.children[0] || null; },
      setAttribute(k, v) { attrs.set(String(k), String(v)); },
      getAttribute(k) { return attrs.has(String(k)) ? attrs.get(String(k)) : null; },
      hasAttribute(k) { return attrs.has(String(k)); },
      removeAttribute(k) { attrs.delete(String(k)); },
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; } return c; },
      addEventListener(t, fn) { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t).add(fn); },
      removeEventListener(t, fn) { if (listeners.has(t)) listeners.get(t).delete(fn); },
      dispatchEvent(ev) { const s = listeners.get(ev.type); if (s) for (const fn of s) fn(ev); return true; },
      focus() {},
      attachShadow() { const sr = makeNode('#shadow-root'); sr.host = this; this.shadowRoot = sr; return sr; },
      querySelectorAll(sel) {
        const out = [];
        const walk = (n) => {
          for (const c of n.children) {
            if (
              (sel.startsWith('#') && c.id === sel.slice(1)) ||
              (sel.startsWith('.') && (c.getAttribute('class') || '').split(/\s+/).includes(sel.slice(1))) ||
              (sel.startsWith('[') && c.hasAttribute(sel.slice(1, -1).split('=')[0]))
            ) {
              out.push(c);
            }
            walk(c);
          }
        };
        walk(this);
        return out;
      },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    };
  }

  const html = makeNode('html');
  const body = makeNode('body');
  html.appendChild(body);
  const doc = {
    documentElement: html,
    body,
    createElement: (t) => makeNode(t),
    getElementById: (id) => html.querySelector(`#${id}`),
    querySelector: (s) => html.querySelector(s),
    querySelectorAll: (s) => html.querySelectorAll(s),
  };
  const winListeners = new Map();
  const win = {
    location: new URL('https://antigravity.google.com/workspace'),
    document: doc,
    addEventListener(t, fn) { if (!winListeners.has(t)) winListeners.set(t, new Set()); winListeners.get(t).add(fn); },
    removeEventListener(t, fn) { if (winListeners.has(t)) winListeners.get(t).delete(fn); },
    dispatchEvent(ev) { const s = winListeners.get(ev.type); if (s) for (const fn of s) fn(ev); return true; },
  };

  let actionCalls = 0;
  let tabCalls = 0;
  registerAddon(
    {
      pluginMeta: {
        schemaVersion: 2,
        pluginId: 'trusted-click-check',
        displayName: 'Click Check',
        version: '1.0.0',
        trustLevel: 'restricted',
        capabilities: ['renderer'],
        uiSlots: [],
      },
      run(addonHost) {
        addonHost.registerAction('do-it', { label: 'Do It', run() { actionCalls += 1; } });
        addonHost.registerSettingsTab('cfg', { label: 'Cfg', onSelect() { tabCalls += 1; } });
      },
    },
    { win }
  );

  const boot = await bootRemoteWebHost({
    doc,
    win,
    profile: ANTIGRAVITY_REMOTE_WEB_PROFILE,
    kernel: createRendererKernel(doc, win),
  });
  assert.equal(boot.ok, true);
  const sr = boot.controller.drawerUi.shadowRoot;
  const pill = sr.querySelector('.rah-pill');
  const panel = sr.querySelector('#rah-drawer-panel');

  // Synthetic untrusted click on pill MUST be ignored (drawer stays hidden)
  pill.dispatchEvent({ type: 'click', isTrusted: false });
  assert.equal(panel.hasAttribute('hidden'), true);

  // Trusted user click opens drawer
  pill.dispatchEvent({ type: 'click', isTrusted: true });
  assert.equal(panel.hasAttribute('hidden'), false);

  // F8: Synthetic untrusted Escape keydown MUST NOT close drawer; trusted Escape closes it
  win.dispatchEvent({ type: 'keydown', key: 'Escape', isTrusted: false });
  assert.equal(panel.hasAttribute('hidden'), false);
  win.dispatchEvent({ type: 'keydown', key: 'Escape', isTrusted: true });
  assert.equal(panel.hasAttribute('hidden'), true);
  // Re-open with trusted click for subsequent assertions
  pill.dispatchEvent({ type: 'click', isTrusted: true });
  assert.equal(panel.hasAttribute('hidden'), false);

  // Untrusted click on host action MUST be ignored
  const actBtn = sr.querySelector('[data-host-action-id]');
  actBtn.dispatchEvent({ type: 'click', isTrusted: false });
  assert.equal(actionCalls, 0);

  // Trusted click executes host action
  actBtn.dispatchEvent({ type: 'click', isTrusted: true });
  assert.equal(actionCalls, 1);

  // Untrusted click on settings tab button MUST be ignored
  const tabBtns = sr.querySelectorAll('.rah-tab');
  tabBtns[1].dispatchEvent({ type: 'click', isTrusted: false });
  assert.equal(tabBtns[1].getAttribute('aria-selected'), 'false');

  // Trusted click selects settings tab, then untrusted vs trusted on settings card
  tabBtns[1].dispatchEvent({ type: 'click', isTrusted: true });
  assert.equal(tabBtns[1].getAttribute('aria-selected'), 'true');
  const settingsCard = sr.querySelector('[data-settings-tab-id]');
  settingsCard.dispatchEvent({ type: 'click', isTrusted: false });
  assert.equal(tabCalls, 0);
  settingsCard.dispatchEvent({ type: 'click', isTrusted: true });
  assert.equal(tabCalls, 1);

  boot.controller.dispose();
});

test('TC-V29-07: SOLID #0 zero-vendor-literal invariant holds for new core and runtime update-survival modules', () => {
  const files = [
    path.resolve(__dirname, '..', '..', 'src', 'core', 'update-survival-port.js'),
    path.resolve(__dirname, '..', '..', 'src', 'runtime', 'main', 'update-survival-hook.js'),
  ];
  const forbidden = [/antigravity/i, /ko-thought/i, /statusbar/i, /mcp-manager/i, /electron-updater/i];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const re of forbidden) {
      assert.equal(re.test(src), false, `Vendor literal ${re} leaked into ${path.basename(f)}`);
    }
  }
});
