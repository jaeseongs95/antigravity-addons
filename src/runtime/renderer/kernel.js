'use strict';

/**
 * Isolated World 998 Renderer Kernel (v2.0.0 — T-A Option A1 + T-B Option B2).
 *
 * - Claims `window.__addonHostBootstrap.claim(cfg.claimNonce)` ONCE per document generation.
 * - Composes modular `ignore-guard`, `style-manager`, `slot-manager`, `modal-portal`,
 *   `region-observer`, and `settings-tab-coordinator`.
 * - Provides each plugin an isolated, capability-scoped `addonHost` API handle with
 *   deterministic `dispose()` cleanup.
 */

const { isElementInsideIgnored } = require('./ignore-guard');
const { createStyleManager } = require('./style-manager');
const { createSlotManager } = require('./slot-manager');
const { createModalPortal } = require('./modal-portal');
const { createRegionObserver } = require('./region-observer');
const { createSettingsTabCoordinator } = require('./settings-tab-coordinator');

function createRendererKernel(doc = globalThis.document, win = globalThis.window || globalThis) {
  let booted = false;
  let docGenId = 0;
  let hostToken = null;
  let hostBridge = null;
  let extraNoTranslateAttributes = [];
  let styleManager = null;
  let slotManager = null;
  let modalPortal = null;
  let regionObserver = null;
  let settingsTabs = null;

  const pluginDisposers = new Map(); // pluginId -> Set<Function>
  const pluginMarkDisposed = new Map(); // pluginId -> Set<Function>
  const pluginActions = new Map(); // pluginId -> Map<actionId, object>
  const stagedHandles = new Map(); // runNonce -> { pluginId, handle } (S-1 CSP-safe two-phase execution)
  const recordedErrors = [];
  let nonceSeq = 0;

  function generateRunNonce() {
    nonceSeq += 1;
    try {
      const cryptoObj = (win && win.crypto) || (typeof globalThis !== 'undefined' && globalThis.crypto);
      if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
        const bytes = new Uint8Array(16);
        cryptoObj.getRandomValues(bytes);
        let hex = '';
        for (let i = 0; i < bytes.length; i++) {
          hex += bytes[i].toString(16).padStart(2, '0');
        }
        return `rn-${nonceSeq}-${hex}`;
      }
    } catch (_e) {}
    return `rn-${nonceSeq}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }

  function assertHostToken(providedToken) {
    if (hostToken !== null && providedToken !== hostToken) {
      throw new Error('ERR_FORBIDDEN_HOST_TOKEN');
    }
  }

  function reportPluginError(pluginId, detail) {
    const entry = { pluginId: String(pluginId || 'unknown'), detail: String(detail || '') };
    recordedErrors.push(entry);
    if (recordedErrors.length > 200) recordedErrors.shift();
    if (hostBridge && typeof hostBridge.reportError === 'function') {
      try {
        hostBridge.reportError(entry.pluginId, entry.detail);
      } catch (_e) {}
    }
  }

  function boot(cfg = {}) {
    if (booted) {
      if (hostToken !== null && cfg.hostToken !== hostToken) {
        return { ok: false, reason: 'ERR_KERNEL_ALREADY_BOOTED' };
      }
      return { ok: true, alreadyBooted: true, docGenId };
    }
    if (typeof cfg.hostToken === 'string' && cfg.hostToken.length >= 16) {
      hostToken = cfg.hostToken;
    }
    docGenId = Number(cfg.docGenId) || 1;
    extraNoTranslateAttributes = Array.isArray(cfg.extraNoTranslateAttributes)
      ? cfg.extraNoTranslateAttributes.slice()
      : [];

    // T-A Option A1: claim preload bridge ONCE per document generation
    const bootstrap = win && win.__addonHostBootstrap;
    if (bootstrap && typeof bootstrap.claim === 'function' && cfg.claimNonce) {
      try {
        hostBridge = bootstrap.claim(cfg.claimNonce);
      } catch (err) {
        return {
          ok: false,
          reason: err && err.message ? err.message : 'ERR_BRIDGE_CLAIM_FAILED',
        };
      }
    }

    styleManager = createStyleManager(doc);
    slotManager = createSlotManager(doc, {
      uiAnchors: cfg.uiAnchors || {},
      extraNoTranslateAttributes,
      styleManager,
    });
    modalPortal = createModalPortal(doc, win, {
      extraNoTranslateAttributes,
      styleManager,
      onPortalClaimChange: (claimId, active) => {
        if (hostBridge && typeof hostBridge.setPortalClaim === 'function') {
          try {
            hostBridge.setPortalClaim(claimId, active);
          } catch (_e) {}
        }
      },
    });
    regionObserver = createRegionObserver(doc, win);
    settingsTabs = createSettingsTabCoordinator();
    booted = true;
    return { ok: true, alreadyBooted: false, docGenId, hasBridge: Boolean(hostBridge) };
  }

  function addPluginDisposer(pluginId, fn) {
    if (typeof fn !== 'function') return;
    let set = pluginDisposers.get(pluginId);
    if (!set) {
      set = new Set();
      pluginDisposers.set(pluginId, set);
    }
    set.add(fn);
  }

  function disposePluginInternal(pluginId) {
    const markers = pluginMarkDisposed.get(pluginId);
    if (markers) {
      for (const mark of Array.from(markers)) {
        try {
          mark();
        } catch (_e) {}
      }
      markers.clear();
      pluginMarkDisposed.delete(pluginId);
    }
    const set = pluginDisposers.get(pluginId);
    if (set) {
      for (const fn of Array.from(set)) {
        try {
          fn();
        } catch (err) {
          reportPluginError(pluginId, err && err.message ? err.message : String(err));
        }
      }
      set.clear();
      pluginDisposers.delete(pluginId);
    }
    if (slotManager) slotManager.disposePluginSlots(pluginId);
    if (styleManager) styleManager.disposePluginStyles(pluginId);
    if (modalPortal) modalPortal.disposePluginPortals(pluginId);
    if (regionObserver) regionObserver.disposePluginObservers(pluginId);
    if (settingsTabs) settingsTabs.disposePluginTabs(pluginId);
    pluginActions.delete(pluginId);
    return true;
  }

  function disposePlugin(pluginId, token) {
    assertHostToken(token);
    return disposePluginInternal(pluginId);
  }

  function createPluginHandle(pluginMeta, token) {
    assertHostToken(token);
    if (!booted) {
      throw new Error('ERR_KERNEL_NOT_BOOTED');
    }
    const pluginId = pluginMeta.pluginId;
    let disposed = false;

    let markers = pluginMarkDisposed.get(pluginId);
    if (!markers) {
      markers = new Set();
      pluginMarkDisposed.set(pluginId, markers);
    }
    markers.add(() => {
      disposed = true;
    });

    const assertActive = () => {
      if (disposed) throw new Error(`ERR_PLUGIN_HANDLE_DISPOSED:${pluginId}`);
    };

    const handle = Object.freeze({
      pluginId,
      version: pluginMeta.version || '0.0.0',
      trustLevel: pluginMeta.trustLevel || 'restricted',
      schemaVersion: 2,
      sourceSchemaVersion: pluginMeta.sourceSchemaVersion || 2,

      mountSlot(slotId, opts) {
        assertActive();
        return slotManager.mountSlot(pluginMeta, slotId, opts);
      },

      unmountSlot(slotId) {
        assertActive();
        return slotManager.unmountSlot(pluginId, slotId);
      },

      injectStyle(styleId, cssText, opts) {
        assertActive();
        return styleManager.injectStyle(pluginMeta, styleId, cssText, opts);
      },

      removeStyle(styleId) {
        assertActive();
        return styleManager.removeStyle(pluginId, styleId);
      },

      openModal(slotId, opts) {
        assertActive();
        return modalPortal.openModal(pluginMeta, slotId, opts);
      },

      openPopover(slotId, opts) {
        assertActive();
        return modalPortal.openPopover(pluginMeta, slotId, opts);
      },

      observeRegion(selector, callback, opts) {
        assertActive();
        return regionObserver.observeRegion(pluginId, selector, callback, opts);
      },

      registerSettingsTab(tabId, opts) {
        assertActive();
        return settingsTabs.registerSettingsTab(pluginId, tabId, opts);
      },

      registerAction(actionId, spec = {}) {
        assertActive();
        if (!actionId || typeof actionId !== 'string') throw new Error('ERR_INVALID_ACTION_ID');
        let map = pluginActions.get(pluginId);
        if (!map) {
          map = new Map();
          pluginActions.set(pluginId, map);
        }
        const entry = {
          pluginId,
          actionId,
          label: String(spec.label || actionId),
          run: typeof spec.run === 'function' ? spec.run : null,
        };
        map.set(actionId, entry);
        return Object.freeze({
          unregister() {
            map.delete(actionId);
          },
        });
      },

      listActions() {
        const out = [];
        for (const map of pluginActions.values()) {
          for (const a of map.values()) {
            out.push({ pluginId: a.pluginId, actionId: a.actionId, label: a.label });
          }
        }
        return out;
      },

      invokeAction(targetPluginId, actionId, ...args) {
        assertActive();
        const map = pluginActions.get(targetPluginId);
        const a = map && map.get(actionId);
        if (!a || !a.run) throw new Error(`ERR_ACTION_NOT_FOUND:${targetPluginId}:${actionId}`);
        return a.run(...args);
      },

      isElementInsideIgnored(nodeOrEvent, opts = {}) {
        return isElementInsideIgnored(nodeOrEvent, {
          extraNoTranslateAttributes,
          ignoreElements: (opts && opts.ignoreElements) || [],
        });
      },

      addManagedListener(target, type, listener, opts) {
        assertActive();
        if (!target || typeof target.addEventListener !== 'function') {
          throw new Error('ERR_INVALID_EVENT_TARGET');
        }
        const safeListener = (ev) => {
          if (disposed) return;
          try {
            const ret = listener(ev);
            if (ret && typeof ret.then === 'function') {
              ret.catch((err) => reportPluginError(pluginId, err && err.message ? err.message : String(err)));
            }
          } catch (err) {
            reportPluginError(pluginId, err && err.message ? err.message : String(err));
          }
        };
        target.addEventListener(type, safeListener, opts);
        const remove = () => {
          if (typeof target.removeEventListener === 'function') {
            try {
              target.removeEventListener(type, safeListener, opts);
            } catch (_e) {}
          }
        };
        addPluginDisposer(pluginId, remove);
        return remove;
      },

      runSafe(fn) {
        if (disposed || typeof fn !== 'function') return undefined;
        try {
          const ret = fn();
          if (ret && typeof ret.then === 'function') {
            return ret.catch((err) => {
              reportPluginError(pluginId, err && err.message ? err.message : String(err));
              return undefined;
            });
          }
          return ret;
        } catch (err) {
          reportPluginError(pluginId, err && err.message ? err.message : String(err));
          return undefined;
        }
      },

      onDispose(fn) {
        assertActive();
        addPluginDisposer(pluginId, fn);
      },

      dispose() {
        if (disposed) return;
        disposed = true;
        disposePluginInternal(pluginId);
      },
    });

    return handle;
  }

  function stagePluginHandle(pluginMeta, token) {
    assertHostToken(token);
    const handle = createPluginHandle(pluginMeta, token);
    const runNonce = generateRunNonce();
    stagedHandles.set(runNonce, { pluginId: pluginMeta.pluginId, handle });
    return { ok: true, runNonce };
  }

  function consumeStagedHandle(runNonce) {
    if (typeof runNonce !== 'string' || !stagedHandles.has(runNonce)) {
      throw new Error('ERR_INVALID_OR_CONSUMED_RUN_NONCE');
    }
    const entry = stagedHandles.get(runNonce);
    stagedHandles.delete(runNonce);
    return entry.handle;
  }

  function clearStagedHandle(runNonce, token) {
    assertHostToken(token);
    if (typeof runNonce !== 'string') return false;
    return stagedHandles.delete(runNonce);
  }

  const api = Object.freeze({
    boot,
    createPluginHandle,
    stagePluginHandle,
    consumeStagedHandle,
    clearStagedHandle,
    disposePlugin,
    reportPluginError,
    getErrors: () => recordedErrors.slice(),
    getBridgeStatus: () => ({ booted, docGenId, hasBridge: Boolean(hostBridge) }),
    listSettingsTabs: () => (settingsTabs ? settingsTabs.listTabs() : []),
  });

  return api;
}

if (typeof globalThis !== 'undefined' && typeof globalThis.document !== 'undefined') {
  if (!globalThis.__addonHostKernel) {
    Object.defineProperty(globalThis, '__addonHostKernel', {
      value: createRendererKernel(globalThis.document, globalThis.window || globalThis),
      writable: false,
      configurable: false,
      enumerable: false,
    });
  }
}

module.exports = {
  createRendererKernel,
};
