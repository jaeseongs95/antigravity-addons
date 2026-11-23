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

// I4: Capture JS primordials BEFORE any plugin executes in shared Isolated World 998
const _ObjectKeys = Object.keys;
const _ObjectFreeze = Object.freeze;
const _ObjectDefineProperty = Object.defineProperty;
const _ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const _ArrayIsArray = Array.isArray;
const _ArrayFrom = Array.from;
const _ArrayPush = Function.prototype.call.bind(Array.prototype.push);
const _Map = Map;
const _MapGet = Function.prototype.call.bind(Map.prototype.get);
const _MapSet = Function.prototype.call.bind(Map.prototype.set);
const _MapHas = Function.prototype.call.bind(Map.prototype.has);
const _MapDelete = Function.prototype.call.bind(Map.prototype.delete);
const _MapValues = Function.prototype.call.bind(Map.prototype.values);
const _Set = Set;
const _SetAdd = Function.prototype.call.bind(Set.prototype.add);
const _SetHas = Function.prototype.call.bind(Set.prototype.has);
const _SetDelete = Function.prototype.call.bind(Set.prototype.delete);
const _SetClear = Function.prototype.call.bind(Set.prototype.clear);
const _SetValues = Function.prototype.call.bind(Set.prototype.values);
const _SetSize = Function.prototype.call.bind(_ObjectGetOwnPropertyDescriptor(Set.prototype, 'size').get);
const _WeakMap = WeakMap;
const _WeakMapGet = Function.prototype.call.bind(WeakMap.prototype.get);
const _WeakMapSet = Function.prototype.call.bind(WeakMap.prototype.set);
const _WeakMapHas = Function.prototype.call.bind(WeakMap.prototype.has);
const _Uint8Array = Uint8Array;
const _NumberToString = Function.prototype.call.bind(Number.prototype.toString);
const _StringPadStart = Function.prototype.call.bind(String.prototype.padStart);
const _StringSlice = Function.prototype.call.bind(String.prototype.slice);
const _DateNow = Date.now;
const _MathRandom = Math.random;
const _GlobalCrypto = typeof globalThis !== 'undefined' && globalThis.crypto ? globalThis.crypto : null;
const _CryptoGetRandomValues =
  _GlobalCrypto && typeof _GlobalCrypto.getRandomValues === 'function'
    ? Function.prototype.bind.call(_GlobalCrypto.getRandomValues, _GlobalCrypto)
    : null;

const FORBIDDEN_CLONE_KEYS = new _Set(['__proto__', 'constructor', 'prototype']);

function deepFreezeClone(value, seen = new _WeakMap()) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (_WeakMapHas(seen, value)) {
    return _WeakMapGet(seen, value);
  }
  if (_ArrayIsArray(value)) {
    const out = [];
    _WeakMapSet(seen, value, out);
    for (let i = 0; i < value.length; i++) {
      _ObjectDefineProperty(out, i, {
        value: deepFreezeClone(value[i], seen),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return _ObjectFreeze(out);
  }
  const out = {};
  _WeakMapSet(seen, value, out);
  const keys = _ObjectKeys(value);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (_SetHas(FORBIDDEN_CLONE_KEYS, k)) continue;
    _ObjectDefineProperty(out, k, {
      value: deepFreezeClone(value[k], seen),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return _ObjectFreeze(out);
}

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

  const pluginDisposers = new _Map(); // pluginId -> Set<Function>
  const pluginMarkDisposed = new _Map(); // pluginId -> Set<Function>
  const disposingPlugins = new _Set(); // pluginId (I10: re-entrancy guard during onDispose)
  const pluginActions = new _Map(); // pluginId -> Map<actionId, object>
  const pluginTrustLevels = new _Map(); // pluginId -> 'trusted' | 'restricted' (I4)
  const pluginSettingsAllowed = new _Set(); // pluginId (trusted + settingsBridge declared)
  const pluginSettingsSnapshots = new _Map(); // pluginId -> frozen snapshot
  const pluginSettingsListeners = new _Map(); // pluginId -> Set<Function>
  const stagedHandles = new _Map(); // runNonce -> { pluginId, handle } (S-1 CSP-safe two-phase execution)
  const recordedErrors = [];
  let nonceSeq = 0;

  function generateRunNonce() {
    nonceSeq += 1;
    try {
      const getRandom =
        _CryptoGetRandomValues ||
        (win && win.crypto && typeof win.crypto.getRandomValues === 'function'
          ? (arr) => win.crypto.getRandomValues(arr)
          : null);
      if (getRandom) {
        const bytes = new _Uint8Array(16);
        getRandom(bytes);
        let hex = '';
        for (let i = 0; i < bytes.length; i++) {
          hex += _StringPadStart(_NumberToString(bytes[i], 16), 2, '0');
        }
        return `rn-${nonceSeq}-${hex}`;
      }
    } catch (_e) {}
    return `rn-${nonceSeq}-${_NumberToString(_DateNow(), 36)}-${_StringSlice(_NumberToString(_MathRandom(), 36), 2)}-${_StringSlice(_NumberToString(_MathRandom(), 36), 2)}`;
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
    let set = _MapGet(pluginDisposers, pluginId);
    if (!set) {
      set = new _Set();
      _MapSet(pluginDisposers, pluginId, set);
    }
    _SetAdd(set, fn);
  }

  function disposePluginInternal(pluginId) {
    if (_SetHas(disposingPlugins, pluginId)) {
      return true;
    }
    _SetAdd(disposingPlugins, pluginId);
    try {
      // I10: Run registered onDispose callbacks BEFORE marking handle disposed so cleanup calls (e.g. removeStyle) succeed cleanly
      const set = _MapGet(pluginDisposers, pluginId);
      if (set) {
        for (const fn of _ArrayFrom(_SetValues(set))) {
          try {
            fn();
          } catch (err) {
            reportPluginError(pluginId, err && err.message ? err.message : String(err));
          }
        }
        _SetClear(set);
        _MapDelete(pluginDisposers, pluginId);
      }
      const markers = _MapGet(pluginMarkDisposed, pluginId);
      if (markers) {
        for (const mark of _ArrayFrom(_SetValues(markers))) {
          try {
            mark();
          } catch (_e) {}
        }
        _SetClear(markers);
        _MapDelete(pluginMarkDisposed, pluginId);
      }
      if (slotManager) slotManager.disposePluginSlots(pluginId);
      if (styleManager) styleManager.disposePluginStyles(pluginId);
      if (modalPortal) modalPortal.disposePluginPortals(pluginId);
      if (regionObserver) regionObserver.disposePluginObservers(pluginId);
      if (settingsTabs) settingsTabs.disposePluginTabs(pluginId);
      _MapDelete(pluginActions, pluginId);
      _MapDelete(pluginTrustLevels, pluginId);
      _SetDelete(pluginSettingsAllowed, pluginId);
      _MapDelete(pluginSettingsSnapshots, pluginId);
      const settingsSubs = _MapGet(pluginSettingsListeners, pluginId);
      if (settingsSubs) {
        _SetClear(settingsSubs);
        _MapDelete(pluginSettingsListeners, pluginId);
      }
      return true;
    } finally {
      _SetDelete(disposingPlugins, pluginId);
    }
  }

  function disposePlugin(pluginId, token) {
    assertHostToken(token);
    return disposePluginInternal(pluginId);
  }

  function createPluginHandle(pluginMeta, token, initialSettingsSnapshot = null) {
    assertHostToken(token);
    if (!booted) {
      throw new Error('ERR_KERNEL_NOT_BOOTED');
    }
    const pluginId = pluginMeta.pluginId;
    const effectiveTrustLevel = pluginMeta.trustLevel || 'restricted';
    const hasSettingsBridge = Boolean(pluginMeta.hasSettingsBridge && effectiveTrustLevel === 'trusted');
    let disposed = false;

    _MapSet(pluginTrustLevels, pluginId, effectiveTrustLevel);

    if (hasSettingsBridge) {
      _SetAdd(pluginSettingsAllowed, pluginId);
      _MapSet(
        pluginSettingsSnapshots,
        pluginId,
        initialSettingsSnapshot && typeof initialSettingsSnapshot === 'object'
          ? deepFreezeClone(initialSettingsSnapshot)
          : null
      );
    }

    let markers = _MapGet(pluginMarkDisposed, pluginId);
    if (!markers) {
      markers = new _Set();
      _MapSet(pluginMarkDisposed, pluginId, markers);
    }
    _SetAdd(markers, () => {
      disposed = true;
    });

    const assertActive = () => {
      if (disposed) throw new Error(`ERR_PLUGIN_HANDLE_DISPOSED:${pluginId}`);
    };

    const handle = _ObjectFreeze({
      pluginId,
      version: pluginMeta.version || '0.0.0',
      trustLevel: effectiveTrustLevel,
      schemaVersion: 2,
      sourceSchemaVersion: pluginMeta.sourceSchemaVersion || 2,
      hasSettingsBridge,

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
        let map = _MapGet(pluginActions, pluginId);
        if (!map) {
          map = new _Map();
          _MapSet(pluginActions, pluginId, map);
        }
        const entry = {
          pluginId,
          actionId,
          label: String(spec.label || actionId),
          run: typeof spec.run === 'function' ? spec.run : null,
        };
        _MapSet(map, actionId, entry);
        return _ObjectFreeze({
          unregister() {
            _MapDelete(map, actionId);
          },
        });
      },

      listActions() {
        assertActive();
        const out = [];
        for (const map of _MapValues(pluginActions)) {
          for (const a of _MapValues(map)) {
            const ownerTrust = _MapGet(pluginTrustLevels, a.pluginId) || 'restricted';
            if (effectiveTrustLevel !== 'trusted' && ownerTrust === 'trusted' && a.pluginId !== pluginId) {
              continue;
            }
            _ArrayPush(out, { pluginId: a.pluginId, actionId: a.actionId, label: a.label });
          }
        }
        return out;
      },

      invokeAction(targetPluginId, actionId, ...args) {
        assertActive();
        const targetTrust = _MapGet(pluginTrustLevels, targetPluginId) || 'restricted';
        if (effectiveTrustLevel !== 'trusted' && targetTrust === 'trusted' && targetPluginId !== pluginId) {
          throw new Error(`ERR_ACTION_TRUST_FORBIDDEN:${targetPluginId}:${actionId}`);
        }
        const map = _MapGet(pluginActions, targetPluginId);
        const a = map && _MapGet(map, actionId);
        if (!a || !a.run) throw new Error(`ERR_ACTION_NOT_FOUND:${targetPluginId}:${actionId}`);
        return a.run(...args);
      },

      isElementInsideIgnored(nodeOrEvent, opts = {}) {
        return isElementInsideIgnored(nodeOrEvent, {
          extraNoTranslateAttributes,
          ignoreElements: (opts && opts.ignoreElements) || [],
        });
      },

      getSettings() {
        assertActive();
        if (!hasSettingsBridge) return null;
        return _MapGet(pluginSettingsSnapshots, pluginId) || null;
      },

      onSettingsChange(callback) {
        assertActive();
        if (typeof callback !== 'function') {
          throw new Error('ERR_INVALID_SETTINGS_CALLBACK');
        }
        if (!hasSettingsBridge) {
          throw new Error('ERR_SETTINGS_BRIDGE_NOT_DECLARED');
        }
        let subs = _MapGet(pluginSettingsListeners, pluginId);
        if (!subs) {
          subs = new _Set();
          _MapSet(pluginSettingsListeners, pluginId, subs);
        }
        _SetAdd(subs, callback);
        return () => {
          _SetDelete(subs, callback);
        };
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
        disposePluginInternal(pluginId);
      },
    });

    return handle;
  }

  function stagePluginHandle(pluginMeta, token, initialSettingsSnapshot = null) {
    assertHostToken(token);
    const handle = createPluginHandle(pluginMeta, token, initialSettingsSnapshot);
    const runNonce = generateRunNonce();
    _MapSet(stagedHandles, runNonce, { pluginId: pluginMeta.pluginId, handle });
    return { ok: true, runNonce };
  }

  function pushPluginSettings(pluginId, snapshot, token) {
    assertHostToken(token);
    if (!booted) {
      return { ok: false, reason: 'ERR_KERNEL_NOT_BOOTED', delivered: 0 };
    }
    if (!_SetHas(pluginSettingsAllowed, pluginId)) {
      return { ok: false, reason: 'ERR_SETTINGS_BRIDGE_NOT_BOUND', delivered: 0 };
    }
    const frozen = snapshot && typeof snapshot === 'object' ? deepFreezeClone(snapshot) : null;
    _MapSet(pluginSettingsSnapshots, pluginId, frozen);
    const subs = _MapGet(pluginSettingsListeners, pluginId);
    if (!subs || _SetSize(subs) === 0) {
      return { ok: true, delivered: 0 };
    }
    let delivered = 0;
    for (const cb of _ArrayFrom(_SetValues(subs))) {
      delivered += 1;
      try {
        const ret = cb(frozen);
        if (ret && typeof ret.then === 'function') {
          ret.catch((err) => reportPluginError(pluginId, err && err.message ? err.message : String(err)));
        }
      } catch (err) {
        reportPluginError(pluginId, err && err.message ? err.message : String(err));
      }
    }
    return { ok: true, delivered };
  }

  function consumeStagedHandle(runNonce) {
    if (typeof runNonce !== 'string' || !_MapHas(stagedHandles, runNonce)) {
      throw new Error('ERR_INVALID_OR_CONSUMED_RUN_NONCE');
    }
    const entry = _MapGet(stagedHandles, runNonce);
    _MapDelete(stagedHandles, runNonce);
    return entry.handle;
  }

  function clearStagedHandle(runNonce, token) {
    assertHostToken(token);
    if (typeof runNonce !== 'string') return false;
    return _MapDelete(stagedHandles, runNonce);
  }

  const api = _ObjectFreeze({
    boot,
    createPluginHandle,
    stagePluginHandle,
    pushPluginSettings,
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
