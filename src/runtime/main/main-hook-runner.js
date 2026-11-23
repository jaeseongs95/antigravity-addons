'use strict';

/**
 * Isolated MainHook Runner with least-privilege broker, timeout, async fault isolation,
 * and serialized disposal when plugins are disabled or unloaded.
 */

const path = require('node:path');
const { LIFECYCLE_STATES } = require('../shared/constants');
const { loadVerifiedMainHookModule } = require('./trust-verifier');

function withTimeout(promiseOrVal, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`ERR_MAIN_HOOK_TIMEOUT:${label}:${timeoutMs}ms`));
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();

    Promise.resolve()
      .then(() => promiseOrVal)
      .then(
        (val) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(val);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      );
  });
}

function createMainHookRunner({
  pluginsRootDir,
  strictTrustPolicy = true,
  mainHookTimeoutMs = 5000,
  recordDiag = () => {},
  lifecycleStates = new Map(),
} = {}) {
  const activeHooks = new Map(); // pluginId -> { dispose, disposers, disposed, state }
  let opChain = Promise.resolve();

  function createLeastPrivilegeBroker(pluginId, record) {
    const assertNotDisposed = () => {
      if (record.disposed) {
        throw new Error(`ERR_MAIN_HOOK_BROKER_DISPOSED:${pluginId}`);
      }
    };
    const assertActiveForRegistration = () => {
      if (record.disposing || record.disposed) {
        throw new Error(`ERR_MAIN_HOOK_BROKER_DISPOSED:${pluginId}`);
      }
    };
    return Object.freeze({
      pluginId,
      log(level, message) {
        assertNotDisposed();
        recordDiag(String(level || 'info'), `MAIN_HOOK:${pluginId}`, String(message || ''));
      },
      onDispose(fn) {
        assertActiveForRegistration();
        if (typeof fn === 'function') record.disposers.push(fn);
      },
      isDisposed() {
        return Boolean(record.disposed || record.disposing);
      },
    });
  }

  async function disposePluginHook(pluginId) {
    const rec = activeHooks.get(pluginId);
    if (!rec) return;
    lifecycleStates.set(pluginId, LIFECYCLE_STATES.DISPOSING);
    rec.disposing = true;
    const tasks = [];
    if (typeof rec.dispose === 'function') tasks.push(rec.dispose);
    while (rec.disposers.length > 0) {
      tasks.push(rec.disposers.pop());
    }
    for (const fn of tasks) {
      try {
        await withTimeout(fn(), mainHookTimeoutMs, `${pluginId}:dispose`);
      } catch (err) {
        recordDiag('warn', 'MAIN_HOOK_DISPOSE_ERR', `${pluginId}: ${err && err.message ? err.message : err}`);
      }
    }
    rec.disposed = true;
    activeHooks.delete(pluginId);
    lifecycleStates.set(pluginId, LIFECYCLE_STATES.DISPOSED);
  }

  async function activatePluginHook(addon, policy) {
    const pluginId = addon.pluginId;
    if (activeHooks.has(pluginId)) return { ok: true, alreadyActive: true };
    const entryPath = addon.resolvedEntries && addon.resolvedEntries.mainHookScript;
    if (!entryPath) return { ok: true, skipped: true };

    lifecycleStates.set(pluginId, LIFECYCLE_STATES.ACTIVATING);
    const pluginRoot = pluginsRootDir ? path.join(pluginsRootDir, pluginId) : path.dirname(entryPath);
    const loaded = loadVerifiedMainHookModule(entryPath, pluginRoot, addon.manifest, policy, {
      strictTrustPolicy,
    });
    if (!loaded.ok) {
      lifecycleStates.set(pluginId, LIFECYCLE_STATES.FAILED);
      recordDiag('warn', 'MAIN_HOOK_TRUST_REJECTED', `${pluginId}: ${loaded.reason}`);
      return { ok: false, reason: loaded.reason };
    }

    const record = { dispose: null, disposers: [], disposed: false };
    const broker = createLeastPrivilegeBroker(pluginId, record);
    const exp = loaded.exports;
    const hookFn =
      typeof exp === 'function'
        ? exp
        : exp && typeof exp.onMainReady === 'function'
          ? exp.onMainReady
          : exp && typeof exp.activate === 'function'
            ? exp.activate
            : null;
    if (exp && typeof exp.dispose === 'function') {
      record.dispose = () => exp.dispose(broker);
    }

    activeHooks.set(pluginId, record);
    if (hookFn) {
      try {
        const ret = await withTimeout(hookFn(broker), mainHookTimeoutMs, `${pluginId}:activate`);
        if (typeof ret === 'function') {
          record.disposers.push(ret);
        } else if (ret && typeof ret.dispose === 'function') {
          record.disposers.push(() => ret.dispose());
        }
      } catch (err) {
        recordDiag('error', 'MAIN_HOOK_ACTIVATE_FAILED', `${pluginId}: ${err && err.message ? err.message : err}`);
        await disposePluginHook(pluginId);
        lifecycleStates.set(pluginId, LIFECYCLE_STATES.FAILED);
        return { ok: false, reason: 'ERR_MAIN_HOOK_ACTIVATE_FAILED', error: err && err.message ? err.message : String(err) };
      }
    }

    lifecycleStates.set(pluginId, LIFECYCLE_STATES.ACTIVE);
    return { ok: true, bundleSha256: loaded.bundleSha256 };
  }

  function reconcile(activeAddons, policy) {
    opChain = opChain
      .then(async () => {
        const wanted = new Set(
          (activeAddons || [])
            .filter((a) => a && a.resolvedEntries && a.resolvedEntries.mainHookScript)
            .map((a) => a.pluginId)
        );
        for (const existingId of Array.from(activeHooks.keys())) {
          if (!wanted.has(existingId)) {
            await disposePluginHook(existingId);
          }
        }
        for (const addon of activeAddons || []) {
          if (addon && addon.resolvedEntries && addon.resolvedEntries.mainHookScript) {
            await activatePluginHook(addon, policy);
          }
        }
      })
      .catch((err) => {
        recordDiag('error', 'MAIN_HOOK_RECONCILE_ERR', err && err.message ? err.message : String(err));
      });
    return opChain;
  }

  function disposeAll() {
    opChain = opChain.then(async () => {
      for (const id of Array.from(activeHooks.keys())) {
        await disposePluginHook(id);
      }
    });
    return opChain;
  }

  return Object.freeze({
    reconcile,
    disposeAll,
    getActivePluginIds: () => Array.from(activeHooks.keys()),
  });
}

module.exports = {
  createMainHookRunner,
};
