'use strict';

/**
 * Electron Native App Auto-Update Reconciler & External Runtime Resolver (Axis 3B — Option 3B-1).
 *
 * Invariants:
 * 1. NEVER executes any binary inside the target app install directory ($INSTDIR)
 *    (specifically forbids running the app executable with ELECTRON_RUN_AS_NODE=1).
 * 2. NEVER calls taskkill / SIGKILL on a running host application.
 * 3. Auto-repatches ONLY when `status === 'UPDATED_UNPATCHED'` and `rolledBackAt == null`,
 *    enforcing a per-asarSha256 circuit breaker and macOS detect-only guardrail.
 * 4. In detached `--handoff` mode, emits an immediate startup ACK and UNCONDITIONALLY
 *    relaunches the target app inside `finally {}` regardless of patch success or error.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  DEFAULT_WAIT_TIMEOUT_MS,
  normalizeReconcileState,
  evaluateReconcileEligibility,
  recordReconcileOutcome,
} = require('../../core/update-survival-port');
const { writeAtomicSync } = require('../fs-lock-atomic');
const { readAsarArchive, verifyAllAsarIntegrity, sha256Hex } = require('./asar-patcher');

function safeRealpath(targetPath) {
  try {
    return fs.realpathSync(targetPath);
  } catch (_err) {
    return path.resolve(targetPath);
  }
}

function normalizeComparePath(p, platform = process.platform) {
  const resolved = path.resolve(p);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInsideDir(candidatePath, baseDir, platform = process.platform) {
  if (!candidatePath || !baseDir) return false;
  const candNorm = normalizeComparePath(candidatePath, platform);
  const baseNorm = normalizeComparePath(baseDir, platform);
  const rel = path.relative(baseNorm, candNorm);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    return true;
  }
  const candReal = normalizeComparePath(safeRealpath(candidatePath), platform);
  const baseReal = normalizeComparePath(safeRealpath(baseDir), platform);
  const realRel = path.relative(baseReal, candReal);
  return realRel === '' || (!realRel.startsWith('..') && !path.isAbsolute(realRel));
}

function collectForbiddenInstallDirs({ appExecutablePath = null, asarPath = null } = {}) {
  const dirs = [];
  if (typeof appExecutablePath === 'string' && appExecutablePath.trim()) {
    dirs.push(path.dirname(path.resolve(appExecutablePath)));
  }
  if (typeof asarPath === 'string' && asarPath.trim()) {
    const resDir = path.dirname(path.resolve(asarPath));
    dirs.push(resDir);
    const parent = path.dirname(resDir);
    if (parent && parent !== resDir) {
      dirs.push(parent);
    }
  }
  return Array.from(new Set(dirs));
}

function isNodeBinaryBasename(candidatePath, platform = process.platform) {
  const base = path.basename(String(candidatePath || ''));
  if (platform === 'win32') {
    return base.toLowerCase() === 'node.exe';
  }
  return base === 'node';
}

function isAllowedExternalNodePath(
  candidatePath,
  { appExecutablePath = null, asarPath = null, platform = process.platform, checkExists = true } = {}
) {
  if (typeof candidatePath !== 'string' || !candidatePath.trim()) return false;
  if (!path.isAbsolute(candidatePath)) return false;
  if (!isNodeBinaryBasename(candidatePath, platform)) return false;
  if (checkExists) {
    try {
      if (!fs.statSync(candidatePath).isFile()) return false;
    } catch (_err) {
      return false;
    }
  }
  const forbiddenDirs = collectForbiddenInstallDirs({ appExecutablePath, asarPath });
  for (let i = 0; i < forbiddenDirs.length; i += 1) {
    if (isPathInsideDir(candidatePath, forbiddenDirs[i], platform)) {
      return false;
    }
  }
  return true;
}

function resolveExternalNodeExecutable({
  hostDataDir = null,
  appExecutablePath = null,
  asarPath = null,
  preferredNodePath = null,
  currentExecPath = process.execPath,
  envPath = process.env.PATH || '',
  platform = process.platform,
} = {}) {
  const binName = platform === 'win32' ? 'node.exe' : 'node';
  const candidates = [];

  if (typeof hostDataDir === 'string' && hostDataDir.trim()) {
    candidates.push({ source: 'staged-host-bin', p: path.join(hostDataDir, 'bin', binName) });
  }
  if (typeof preferredNodePath === 'string' && preferredNodePath.trim()) {
    candidates.push({ source: 'preferred', p: preferredNodePath.trim() });
  }
  if (typeof currentExecPath === 'string' && currentExecPath.trim()) {
    candidates.push({ source: 'current-exec', p: currentExecPath.trim() });
  }
  if (typeof envPath === 'string' && envPath.trim()) {
    const sep = platform === 'win32' ? ';' : ':';
    const dirs = envPath.split(sep).map((d) => d.trim()).filter(Boolean);
    for (let i = 0; i < dirs.length; i += 1) {
      candidates.push({ source: 'system-path', p: path.join(dirs[i], binName) });
    }
  }

  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    if (isAllowedExternalNodePath(c.p, { appExecutablePath, asarPath, platform, checkExists: true })) {
      return { ok: true, nodePath: safeRealpath(c.p), source: c.source };
    }
  }
  return { ok: false, nodePath: null, reason: 'ERR_NO_EXTERNAL_NODE_OUTSIDE_INSTDIR' };
}

function resolveReconcileStatePath(paths) {
  if (paths && typeof paths.RECONCILE_STATE_PATH === 'string' && paths.RECONCILE_STATE_PATH.trim()) {
    return paths.RECONCILE_STATE_PATH;
  }
  const base =
    (paths && paths.HOST_DATA_DIR) ||
    (paths && paths.LOADER_SCRIPT_PATH && path.dirname(paths.LOADER_SCRIPT_PATH)) ||
    (paths && paths.ADDONS_DIR && path.dirname(paths.ADDONS_DIR));
  return base ? path.join(base, 'reconcile-state.json') : null;
}

function readReconcileState(statePath) {
  if (!statePath || !fs.existsSync(statePath)) {
    return normalizeReconcileState(null);
  }
  try {
    return normalizeReconcileState(JSON.parse(fs.readFileSync(statePath, 'utf8')));
  } catch (_err) {
    return normalizeReconcileState(null);
  }
}

function writeReconcileState(statePath, state) {
  if (!statePath) return;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  writeAtomicSync(statePath, JSON.stringify(normalizeReconcileState(state), null, 2) + '\n');
}

function extractFailureReason(installResult) {
  if (!installResult || typeof installResult !== 'object') return 'ERR_RECONCILE_INSTALL_FAILED';
  if (installResult.asar && typeof installResult.asar.status === 'string' && installResult.asar.status) {
    return installResult.asar.status;
  }
  if (typeof installResult.reason === 'string' && installResult.reason) return installResult.reason;
  if (typeof installResult.phase === 'string' && installResult.phase) return installResult.phase;
  if (typeof installResult.error === 'string' && installResult.error) return installResult.error;
  return 'ERR_RECONCILE_INSTALL_FAILED';
}

function reconcileElectronHost(
  ctx,
  lifecyclePort,
  {
    hostVersion,
    platform = process.platform,
    forceMacAutoRepatch = false,
    maxFailuresPerSha = 1,
    nowIso = () => new Date().toISOString(),
  } = {}
) {
  const statePath = resolveReconcileStatePath(ctx && ctx.paths);
  const state = readReconcileState(statePath);
  const diag = lifecyclePort.diagnoseHost(ctx);
  const elig = evaluateReconcileEligibility({
    diag,
    state,
    platform,
    forceMacAutoRepatch,
    maxFailuresPerSha,
  });

  if (!elig.eligible) {
    return {
      ok: true,
      action: 'SKIPPED',
      reason: elig.reason,
      asarSha256: elig.asarSha256 || null,
      appVersion: (diag && diag.appVersion) || null,
      statePath,
      diag,
    };
  }

  let installRes;
  try {
    installRes = lifecyclePort.installHost(ctx, {
      refreshOrig: true,
      hostVersion,
    });
  } catch (err) {
    installRes = {
      ok: false,
      reason: err && err.message ? err.message : String(err),
    };
  }

  const failureReason = installRes && installRes.ok ? null : extractFailureReason(installRes);
  const nextState = recordReconcileOutcome(state, {
    asarSha256: elig.asarSha256,
    ok: Boolean(installRes && installRes.ok),
    reason: failureReason,
    appVersion: elig.appVersion,
    nowIso: nowIso(),
  });
  writeReconcileState(statePath, nextState);

  return {
    ok: Boolean(installRes && installRes.ok),
    action: installRes && installRes.ok ? 'REPATCHED' : 'FAILED',
    reason: failureReason || (installRes && installRes.status) || 'INSTALLED',
    asarSha256: elig.asarSha256,
    appVersion: elig.appVersion,
    statePath,
    installResult: installRes,
  };
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probeAsarReady(asarPath, prevAsarSha = null) {
  if (!asarPath || !fs.existsSync(asarPath)) {
    return { ready: false, reason: 'ASAR_MISSING' };
  }
  let st;
  try {
    st = fs.statSync(asarPath);
  } catch (_err) {
    return { ready: false, reason: 'ASAR_STAT_FAILED' };
  }
  if (!st.isFile() || st.size <= 0) {
    return { ready: false, reason: 'ASAR_EMPTY' };
  }
  return { ready: true, size: st.size, mtimeMs: st.mtimeMs, prevAsarSha };
}

function verifyAsarReadyForPatch(asarPath, prevAsarSha = null) {
  try {
    const archive = readAsarArchive(asarPath);
    const sha = sha256Hex(archive.buf);
    if (prevAsarSha && sha.toLowerCase() === String(prevAsarSha).toLowerCase()) {
      return { ok: false, reason: 'WAITING_FOR_ASAR_CHANGE', sha };
    }
    if (!verifyAllAsarIntegrity(archive)) {
      return { ok: false, reason: 'WAITING_FOR_ASAR_INTEGRITY', sha };
    }
    return { ok: true, sha, appVersion: archive.appVersion };
  } catch (_err) {
    return { ok: false, reason: 'WAITING_FOR_ASAR_READABLE' };
  }
}

function spawnAppDetached(appExecutablePath, spawnFn = spawn) {
  if (!appExecutablePath || typeof appExecutablePath !== 'string') {
    return { launched: false, reason: 'ERR_APP_EXECUTABLE_MISSING' };
  }
  const child = spawnFn(appExecutablePath, [], {
    detached: true,
    stdio: 'ignore',
    shell: false,
    windowsHide: false,
  });
  if (child && typeof child.unref === 'function') {
    child.unref();
  }
  return { launched: true, pid: child && child.pid ? child.pid : null };
}

async function runDetachedHandoffReconcile(
  ctx,
  lifecyclePort,
  {
    hostVersion,
    parentPid = null,
    prevAsarSha = null,
    ackFilePath = null,
    relaunch = false,
    waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    pollIntervalMs = 200,
    platform = process.platform,
    forceMacAutoRepatch = false,
    isPidAliveFn = isPidAlive,
    sleepFn = sleepMs,
    spawnFn = spawn,
    reconcileFn = null,
  } = {}
) {
  const deadline = Date.now() + (Number.isInteger(waitTimeoutMs) && waitTimeoutMs > 0 ? waitTimeoutMs : DEFAULT_WAIT_TIMEOUT_MS);
  const pollMs = Number.isInteger(pollIntervalMs) && pollIntervalMs >= 5 ? pollIntervalMs : 200;
  const appExecutablePath = ctx && ctx.paths ? ctx.paths.APP_EXECUTABLE_PATH : null;
  const asarPath = ctx && ctx.paths ? ctx.paths.ASAR_PATH : null;

  // 1. Emit startup ACK immediately so Layer-1 parent knows this detached helper is alive.
  if (typeof ackFilePath === 'string' && ackFilePath.trim()) {
    try {
      writeAtomicSync(ackFilePath, `READY:${process.pid}\n`);
    } catch (_ackErr) {}
  }

  let result = null;
  let relaunchResult = null;
  let thrownErr = null;

  try {
    // 2. Wait cleanly for old parent process to exit (NEVER taskkill).
    if (Number.isInteger(parentPid) && parentPid > 0) {
      while (Date.now() < deadline && isPidAliveFn(parentPid)) {
        await sleepFn(pollMs);
      }
    }

    // 3. Wait for target ASAR to stabilize across 2 consecutive polls and pass integrity check.
    if (asarPath) {
      let lastSig = null;
      let stableTicks = 0;
      while (Date.now() < deadline) {
        const probe = probeAsarReady(asarPath, prevAsarSha);
        if (probe.ready) {
          const sig = `${probe.size}:${probe.mtimeMs}`;
          if (sig === lastSig) {
            stableTicks += 1;
          } else {
            lastSig = sig;
            stableTicks = 1;
          }
          if (stableTicks >= 2) {
            const check = verifyAsarReadyForPatch(asarPath, prevAsarSha);
            if (check.ok) break;
          }
        }
        await sleepFn(pollMs);
      }
    }

    // 4. Execute reconcile with bounded retry on transient Windows file lock.
    const execReconcile =
      typeof reconcileFn === 'function'
        ? reconcileFn
        : () =>
            reconcileElectronHost(ctx, lifecyclePort, {
              hostVersion,
              platform,
              forceMacAutoRepatch,
            });

    do {
      result = execReconcile();
      if (!result || result.ok || result.reason !== 'ERR_TARGET_LOCKED_APP_RUNNING') {
        break;
      }
      if (Date.now() >= deadline) break;
      await sleepFn(pollMs);
    } while (Date.now() < deadline);
  } catch (err) {
    thrownErr = err;
    result = {
      ok: false,
      action: 'FAILED',
      reason: err && err.message ? err.message : String(err),
    };
  } finally {
    // 5. UNCONDITIONAL FAIL-OPEN RELAUNCH: never leave target app unlaunched after handoff.
    if (relaunch && appExecutablePath) {
      try {
        relaunchResult = spawnAppDetached(appExecutablePath, spawnFn);
      } catch (spawnErr) {
        relaunchResult = {
          launched: false,
          reason: spawnErr && spawnErr.message ? spawnErr.message : String(spawnErr),
        };
      }
    }
  }

  return {
    ok: Boolean(result && result.ok),
    handoff: true,
    reconcile: result,
    relaunch: relaunchResult,
    error: thrownErr ? (thrownErr.message || String(thrownErr)) : null,
  };
}

function launchHostWithReconcile(
  ctx,
  lifecyclePort,
  {
    hostVersion,
    platform = process.platform,
    forceMacAutoRepatch = false,
    spawnFn = spawn,
  } = {}
) {
  const reconcile = reconcileElectronHost(ctx, lifecyclePort, {
    hostVersion,
    platform,
    forceMacAutoRepatch,
  });
  const appExecutablePath = ctx && ctx.paths ? ctx.paths.APP_EXECUTABLE_PATH : null;
  const launch = spawnAppDetached(appExecutablePath, spawnFn);
  return {
    ok: Boolean(launch && launch.launched),
    reconcile,
    launch,
  };
}

module.exports = {
  isPathInsideDir,
  isNodeBinaryBasename,
  isAllowedExternalNodePath,
  resolveExternalNodeExecutable,
  resolveReconcileStatePath,
  readReconcileState,
  writeReconcileState,
  reconcileElectronHost,
  runDetachedHandoffReconcile,
  launchHostWithReconcile,
  spawnAppDetached,
};
