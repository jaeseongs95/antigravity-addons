'use strict';

/**
 * Main-Process Layer-1 Fail-Open Update Survival Hook (Axis 3B — Option 3B-1).
 *
 * - Strictly vendor-neutral (SOLID #0): driven by `profile.updateSurvival`
 *   (`{ updaterModule, method, platforms, ackTimeoutMs, waitTimeoutMs }`).
 * - Zero external dependencies (Node built-ins only; passes dist/runtime AST check).
 * - Non-destructively wraps `Module._load` in memory (zero edits to upstream files).
 * - Mandatory Spawn-ACK Gate: ONLY suppresses `isForceRunAfter` (`false`) after
 *   verifying an external Node runtime strictly outside `$INSTDIR`, spawning the
 *   detached `--reconcile --handoff` CLI, and observing `READY:` within `ackTimeoutMs`.
 *   Any missing runtime, path violation, spawn error, or ACK timeout FAILS OPEN
 *   verbatim to the original updater method.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { spawn } = require('node:child_process');
const { assertValidUpdateSurvivalConfig } = require('../../core/update-survival-port');

const WRAPPED_FN_SYMBOL = Symbol.for('addonHost.updateSurvival.wrappedFn.v1');
const HOST_CLI_META_FILENAME = 'host-cli.json';

function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch (_err) {
    return path.resolve(p);
  }
}

function normalizePathForCompare(p, platform) {
  const res = path.resolve(p);
  return platform === 'win32' ? res.toLowerCase() : res;
}

function isInsideDir(candidate, baseDir, platform) {
  if (!candidate || !baseDir) return false;
  const c1 = normalizePathForCompare(candidate, platform);
  const b1 = normalizePathForCompare(baseDir, platform);
  const r1 = path.relative(b1, c1);
  if (r1 === '' || (!r1.startsWith('..') && !path.isAbsolute(r1))) return true;
  const c2 = normalizePathForCompare(safeRealpath(candidate), platform);
  const b2 = normalizePathForCompare(safeRealpath(baseDir), platform);
  const r2 = path.relative(b2, c2);
  return r2 === '' || (!r2.startsWith('..') && !path.isAbsolute(r2));
}

function isValidExternalNodeBinary(nodePath, { appExecutablePath, asarPath, platform }) {
  if (typeof nodePath !== 'string' || !nodePath.trim() || !path.isAbsolute(nodePath)) {
    return false;
  }
  const base = path.basename(nodePath);
  const expected = platform === 'win32' ? 'node.exe' : 'node';
  if ((platform === 'win32' ? base.toLowerCase() : base) !== expected) {
    return false;
  }
  try {
    if (!fs.statSync(nodePath).isFile()) return false;
  } catch (_err) {
    return false;
  }
  const forbidden = [];
  if (typeof appExecutablePath === 'string' && appExecutablePath.trim()) {
    forbidden.push(path.dirname(path.resolve(appExecutablePath)));
  }
  if (typeof asarPath === 'string' && asarPath.trim()) {
    const resDir = path.dirname(path.resolve(asarPath));
    forbidden.push(resDir);
    const parent = path.dirname(resDir);
    if (parent && parent !== resDir) forbidden.push(parent);
  }
  for (let i = 0; i < forbidden.length; i += 1) {
    if (isInsideDir(nodePath, forbidden[i], platform)) return false;
  }
  return true;
}

function readHostCliMeta(hostDataDir) {
  if (typeof hostDataDir !== 'string' || !hostDataDir.trim()) return null;
  const metaPath = path.join(hostDataDir, HOST_CLI_META_FILENAME);
  try {
    const lstat = fs.lstatSync(metaPath);
    if (lstat.isSymbolicLink() || !lstat.isFile()) return null;
    const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch (_err) {
    return null;
  }
}

function sleepSyncBounded(ms) {
  const duration = Math.max(1, Math.min(50, Math.floor(ms)));
  try {
    const sab = new SharedArrayBuffer(4);
    const view = new Int32Array(sab);
    Atomics.wait(view, 0, 0, duration);
  } catch (_err) {
    const end = Date.now() + duration;
    while (Date.now() < end) {
      // Bounded fallback if SharedArrayBuffer is unavailable.
    }
  }
}

function waitForAckFileSync(ackFilePath, timeoutMs, sleepFn = sleepSyncBounded) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      if (fs.existsSync(ackFilePath)) {
        const content = fs.readFileSync(ackFilePath, 'utf8');
        if (typeof content === 'string' && content.startsWith('READY:')) {
          return true;
        }
      }
    } catch (_err) {}
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    sleepFn(Math.min(10, remaining));
  }
  return false;
}

function createUpdateSurvivalHook({
  updateSurvival = null,
  hostDataDir = null,
  platform = process.platform,
  moduleApi = Module,
  spawnFn = spawn,
  sleepSyncFn = sleepSyncBounded,
  recordDiag = () => {},
} = {}) {
  let config = null;
  try {
    config = assertValidUpdateSurvivalConfig(updateSurvival);
  } catch (err) {
    recordDiag('warn', 'UPDATE_SURVIVAL_CONFIG_REJECTED', err && err.message ? err.message : String(err));
    config = null;
  }

  let installed = false;
  let origLoad = null;
  let wrappedTargets = [];
  let lastHandoff = null;

  function resolveHandoffMeta() {
    const meta = readHostCliMeta(hostDataDir);
    if (!meta) return { ok: false, reason: 'ERR_HOST_CLI_META_MISSING' };
    const cliEntryPath = typeof meta.cliEntryPath === 'string' ? meta.cliEntryPath.trim() : '';
    if (!cliEntryPath || !path.isAbsolute(cliEntryPath)) {
      return { ok: false, reason: 'ERR_CLI_ENTRY_MISSING' };
    }
    try {
      if (!fs.statSync(cliEntryPath).isFile()) return { ok: false, reason: 'ERR_CLI_ENTRY_NOT_FOUND' };
    } catch (_err) {
      return { ok: false, reason: 'ERR_CLI_ENTRY_NOT_FOUND' };
    }

    const appExecutablePath = typeof meta.appExecutablePath === 'string' ? meta.appExecutablePath : null;
    const asarPath = typeof meta.asarPath === 'string' ? meta.asarPath : null;
    const candidates = [];
    if (hostDataDir) {
      candidates.push(path.join(hostDataDir, 'bin', platform === 'win32' ? 'node.exe' : 'node'));
    }
    if (typeof meta.nodeExecPath === 'string' && meta.nodeExecPath.trim()) {
      candidates.push(meta.nodeExecPath.trim());
    }

    let externalNode = null;
    for (let i = 0; i < candidates.length; i += 1) {
      if (isValidExternalNodeBinary(candidates[i], { appExecutablePath, asarPath, platform })) {
        externalNode = safeRealpath(candidates[i]);
        break;
      }
    }
    if (!externalNode) {
      return { ok: false, reason: 'ERR_NO_EXTERNAL_NODE_OUTSIDE_INSTDIR' };
    }

    return {
      ok: true,
      nodeExecPath: externalNode,
      cliEntryPath,
      prevAsarSha: typeof meta.lastPatchedAsarSha256 === 'string' ? meta.lastPatchedAsarSha256 : null,
    };
  }

  function trySpawnHandoffHelper() {
    const resolved = resolveHandoffMeta();
    if (!resolved.ok) {
      lastHandoff = { ok: false, failOpen: true, reason: resolved.reason };
      recordDiag('warn', 'UPDATE_SURVIVAL_FAIL_OPEN', resolved.reason);
      return false;
    }

    const ackFilePath = path.join(
      os.tmpdir(),
      `addon-host-reconcile-ack-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`
    );

    const args = [
      resolved.cliEntryPath,
      '--reconcile',
      '--handoff',
      '--parent-pid',
      String(process.pid),
      '--relaunch',
      '--ack-file',
      ackFilePath,
      '--wait-timeout',
      String(config.waitTimeoutMs),
    ];
    if (resolved.prevAsarSha) {
      args.push('--prev-asar-sha', resolved.prevAsarSha);
    }

    try {
      const child = spawnFn(resolved.nodeExecPath, args, {
        detached: true,
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
      });
      if (child && typeof child.unref === 'function') {
        child.unref();
      }
      const acked = waitForAckFileSync(ackFilePath, config.ackTimeoutMs, sleepSyncFn);
      try {
        if (fs.existsSync(ackFilePath)) fs.unlinkSync(ackFilePath);
      } catch (_rmErr) {}

      if (!acked) {
        lastHandoff = { ok: false, failOpen: true, reason: 'ERR_RECONCILE_ACK_TIMEOUT' };
        recordDiag('warn', 'UPDATE_SURVIVAL_ACK_TIMEOUT_FAIL_OPEN', `timeoutMs=${config.ackTimeoutMs}`);
        return false;
      }

      lastHandoff = {
        ok: true,
        failOpen: false,
        reason: 'ACK_RECEIVED',
        helperPid: child && child.pid ? child.pid : null,
      };
      recordDiag('info', 'UPDATE_SURVIVAL_HANDOFF_ARMED', `helperPid=${lastHandoff.helperPid || 'unknown'}`);
      return true;
    } catch (err) {
      try {
        if (fs.existsSync(ackFilePath)) fs.unlinkSync(ackFilePath);
      } catch (_rmErr) {}
      const reason = err && err.message ? err.message : String(err);
      lastHandoff = { ok: false, failOpen: true, reason: `ERR_RECONCILE_SPAWN_FAILED:${reason}` };
      recordDiag('warn', 'UPDATE_SURVIVAL_SPAWN_FAIL_OPEN', reason);
      return false;
    }
  }

  function wrapUpdaterExport(exported) {
    if (!exported || typeof exported !== 'object') return;
    const targetObj =
      exported.autoUpdater && typeof exported.autoUpdater === 'object' ? exported.autoUpdater : exported;
    const methodName = config.method;
    const origFn = targetObj[methodName];
    if (typeof origFn !== 'function' || origFn[WRAPPED_FN_SYMBOL]) {
      return;
    }

    const wrapped = function updateSurvivalWrappedMethod(isSilent, isForceRunAfter) {
      const args = Array.prototype.slice.call(arguments);
      // Only intercept when upstream intends immediate force-run-after relaunch.
      if (isForceRunAfter === true) {
        const armed = trySpawnHandoffHelper();
        if (armed) {
          args[1] = false;
          return origFn.apply(this, args);
        }
      }
      // Fail-open verbatim: preserve exact upstream arguments.
      return origFn.apply(this, args);
    };
    wrapped[WRAPPED_FN_SYMBOL] = true;

    try {
      targetObj[methodName] = wrapped;
      wrappedTargets.push({ targetObj, methodName, origFn, wrapped });
    } catch (_assignErr) {
      recordDiag('warn', 'UPDATE_SURVIVAL_WRAP_SKIPPED', 'updater_target_readonly');
    }
  }

  function install() {
    if (installed) return true;
    if (!config || !config.platforms.includes(platform)) {
      return false;
    }
    if (!moduleApi || typeof moduleApi._load !== 'function') {
      return false;
    }

    origLoad = moduleApi._load;
    const hookLoad = function updateSurvivalModuleLoad(request, parent, isMain) {
      const res = origLoad.apply(this, arguments);
      if (request === config.updaterModule) {
        try {
          wrapUpdaterExport(res);
        } catch (_wrapErr) {}
      }
      return res;
    };
    moduleApi._load = hookLoad;
    installed = true;
    recordDiag('info', 'UPDATE_SURVIVAL_HOOK_INSTALLED', `module=${config.updaterModule} method=${config.method}`);
    return true;
  }

  function dispose() {
    if (installed && moduleApi && origLoad) {
      moduleApi._load = origLoad;
    }
    for (let i = 0; i < wrappedTargets.length; i += 1) {
      const entry = wrappedTargets[i];
      try {
        if (entry.targetObj[entry.methodName] === entry.wrapped) {
          entry.targetObj[entry.methodName] = entry.origFn;
        }
      } catch (_err) {}
    }
    wrappedTargets = [];
    origLoad = null;
    installed = false;
  }

  function getStatus() {
    return {
      configured: Boolean(config),
      installed,
      platform,
      enabledForPlatform: Boolean(config && config.platforms.includes(platform)),
      updaterModule: config ? config.updaterModule : null,
      method: config ? config.method : null,
      ackTimeoutMs: config ? config.ackTimeoutMs : null,
      lastHandoff,
    };
  }

  return Object.freeze({
    install,
    dispose,
    getStatus,
    trySpawnHandoffHelper,
  });
}

module.exports = {
  HOST_CLI_META_FILENAME,
  isValidExternalNodeBinary,
  waitForAckFileSync,
  createUpdateSurvivalHook,
};
