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
const { createSurfaceGeometry } = require('./surface-geometry');
const { createModalPortal } = require('./modal-portal');
const { createRegionObserver } = require('./region-observer');
const { createSettingsTabCoordinator } = require('./settings-tab-coordinator');
const { wrapHostBridgePort } = require('./host-bridge-port');
const { createHostSettingsUi } = require('./host-settings-ui');

// I4: Capture JS primordials BEFORE any plugin executes in shared Isolated World 998
const _Error = Error;
const _String = String;
const _Number = Number;
const _NumberIsFinite = Number.isFinite;
const _ReflectApply = Reflect.apply;
const _ObjectKeys = Object.keys;
const _ObjectFreeze = Object.freeze;
const _ObjectHasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
const _ObjectDefineProperty = Object.defineProperty;
const _ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const _ArrayIsArray = Array.isArray;
const _ArrayPush = Function.prototype.call.bind(Array.prototype.push);
const _ArrayShift = Function.prototype.call.bind(Array.prototype.shift);
const _ArraySlice = Function.prototype.call.bind(Array.prototype.slice);
const _Map = Map;
const _MapGet = Function.prototype.call.bind(Map.prototype.get);
const _MapSet = Function.prototype.call.bind(Map.prototype.set);
const _MapHas = Function.prototype.call.bind(Map.prototype.has);
const _MapDelete = Function.prototype.call.bind(Map.prototype.delete);
const _MapForEach = Function.prototype.call.bind(Map.prototype.forEach);
const _Set = Set;
const _SetAdd = Function.prototype.call.bind(Set.prototype.add);
const _SetHas = Function.prototype.call.bind(Set.prototype.has);
const _SetDelete = Function.prototype.call.bind(Set.prototype.delete);
const _SetClear = Function.prototype.call.bind(Set.prototype.clear);
const _SetForEach = Function.prototype.call.bind(Set.prototype.forEach);
const _SetSize = Function.prototype.call.bind(_ObjectGetOwnPropertyDescriptor(Set.prototype, 'size').get);
const _WeakMap = WeakMap;
const _WeakMapGet = Function.prototype.call.bind(WeakMap.prototype.get);
const _WeakMapSet = Function.prototype.call.bind(WeakMap.prototype.set);
const _WeakMapHas = Function.prototype.call.bind(WeakMap.prototype.has);
const _WeakSet = WeakSet;
const _WeakSetAdd = Function.prototype.call.bind(WeakSet.prototype.add);
const _WeakSetHas = Function.prototype.call.bind(WeakSet.prototype.has);
const _WeakSetDelete = Function.prototype.call.bind(WeakSet.prototype.delete);
const _Uint8Array = Uint8Array;
const _NumberToString = Function.prototype.call.bind(Number.prototype.toString);
const _StringPadStart = Function.prototype.call.bind(String.prototype.padStart);
const _StringSlice = Function.prototype.call.bind(String.prototype.slice);
const _StringTrim = Function.prototype.call.bind(String.prototype.trim);
const _ArrayJoin = Function.prototype.call.bind(Array.prototype.join);
const _MathRound = Math.round;
const _DateNow = Date.now;
const _MathRandom = Math.random;
const _JSONStringify = JSON.stringify;
const _PromiseResolve = Promise.resolve.bind(Promise);
const _PromiseReject = Promise.reject.bind(Promise);
const _GlobalCrypto = typeof globalThis !== 'undefined' && globalThis.crypto ? globalThis.crypto : null;
const _CryptoGetRandomValues =
  _GlobalCrypto && typeof _GlobalCrypto.getRandomValues === 'function'
    ? Function.prototype.bind.call(_GlobalCrypto.getRandomValues, _GlobalCrypto)
    : null;

const FORBIDDEN_CLONE_KEYS = new _Set(['__proto__', 'constructor', 'prototype']);
const UI_GRID_MERGE_STYLE_ATTR = 'data-addon-host-ui-grid-merge';
const UNSAFE_GRID_MERGE_SELECTOR_RE = /[{};@\r\n\\]|\/\*|\*\/|<\/style/i;

function isSafeGridMergeSelector(selector) {
  if (typeof selector !== 'string') return false;
  const trimmed = _StringTrim(selector);
  if (!trimmed || trimmed.length > 256) return false;
  return !UNSAFE_GRID_MERGE_SELECTOR_RE.test(trimmed);
}

function buildUiGridMergeCss(uiGridMerges) {
  if (!_ArrayIsArray(uiGridMerges) || uiGridMerges.length === 0) return '';
  const blocks = [];
  for (let i = 0; i < uiGridMerges.length; i += 1) {
    const spec = uiGridMerges[i];
    if (!spec || typeof spec !== 'object' || _ArrayIsArray(spec)) continue;
    const s = typeof spec.section === 'string' ? _StringTrim(spec.section) : '';
    const t = typeof spec.secondary === 'string' ? _StringTrim(spec.secondary) : '';
    if (!isSafeGridMergeSelector(s) || !isSafeGridMergeSelector(t)) continue;
    const minW = _NumberIsFinite(spec.minWidthPx) && spec.minWidthPx >= 0 ? _MathRound(spec.minWidthPx) : 640;
    const cols = _NumberIsFinite(spec.columns) && spec.columns >= 2 && spec.columns <= 12 ? _MathRound(spec.columns) : 2;
    const gap = _NumberIsFinite(spec.gapPx) && spec.gapPx >= 0 ? _MathRound(spec.gapPx) : 8;
    const hdrGap = _NumberIsFinite(spec.headerGapPx) && spec.headerGapPx >= 0 ? _MathRound(spec.headerGapPx) : 4;
    const sel = `${s}:has(> div > div.grid):has(> ${t})`;
    const rule =
      `@media (min-width: ${minW}px) {` +
      `${sel} { display: grid; grid-template-columns: repeat(${cols}, minmax(0, 1fr)); gap: ${gap}px; }` +
      `${sel} > :first-child { grid-column: 1 / -1; margin-bottom: ${hdrGap}px; }` +
      `${sel} > [role="alert"] { grid-column: 1 / -1; }` +
      `${sel} > div:has(> div.grid), ${sel} > div:has(> div.grid) > div.grid, ${sel} > ${t} { display: contents; }` +
      `${sel} > div:has(> div.grid) > :not(div.grid) { grid-column: 1 / -1; order: 10; }` +
      `}`;
    _ArrayPush(blocks, rule);
  }
  return _ArrayJoin(blocks, '\n');
}

function applyUiGridMerges(doc, uiGridMerges) {
  const css = buildUiGridMergeCss(uiGridMerges);
  if (!css || !doc || typeof doc.createElement !== 'function') return false;
  const existing =
    typeof doc.querySelector === 'function' ? doc.querySelector(`style[${UI_GRID_MERGE_STYLE_ATTR}="1"]`) : null;
  if (existing) {
    existing.textContent = css;
    return true;
  }
  const target = doc.head || doc.documentElement || doc.body;
  if (!target || typeof target.appendChild !== 'function') return false;
  const styleEl = doc.createElement('style');
  if (typeof styleEl.setAttribute === 'function') {
    styleEl.setAttribute(UI_GRID_MERGE_STYLE_ATTR, '1');
    styleEl.setAttribute('data-addon-host-ignore', 'true');
  }
  styleEl.textContent = css;
  target.appendChild(styleEl);
  return true;
}

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

function sanitizeJsonPayload(value, seen = new _WeakSet()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return _NumberIsFinite(value) ? value : null;
  }
  if (typeof value !== 'object') {
    return undefined;
  }
  if (_WeakSetHas(seen, value)) {
    throw new _Error('ERR_SETTINGS_INVALID_JSON');
  }
  _WeakSetAdd(seen, value);
  try {
    if (_ArrayIsArray(value)) {
      const out = [];
      for (let i = 0; i < value.length; i++) {
        const item = sanitizeJsonPayload(value[i], seen);
        _ObjectDefineProperty(out, i, {
          value: item === undefined ? null : item,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return out;
    }
    const out = {};
    const keys = _ObjectKeys(value);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (_SetHas(FORBIDDEN_CLONE_KEYS, k)) {
        throw new _Error('ERR_SETTINGS_UNSAFE_PROTO_KEY');
      }
      const nextVal = sanitizeJsonPayload(value[k], seen);
      if (nextVal !== undefined) {
        _ObjectDefineProperty(out, k, {
          value: nextVal,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
    return out;
  } finally {
    _WeakSetDelete(seen, value);
  }
}

function createRendererKernel(doc = globalThis.document, win = globalThis.window || globalThis) {
  let booted = false;
  let docGenId = 0;
  let hostProfileId = null;
  let hostToken = null;
  let hostBridge = null;
  let extraNoTranslateAttributes = [];
  let styleManager = null;
  let slotManager = null;
  let surfaceGeometry = null;
  let modalPortal = null;
  let regionObserver = null;
  let settingsTabs = null;
  let hostSettingsUi = null;

  const pluginDisposers = new _Map(); // pluginId -> Set<Function>
  const pluginMarkDisposed = new _Map(); // pluginId -> Set<Function>
  const disposingPlugins = new _Set(); // pluginId (I10: re-entrancy guard during onDispose)
  const pluginActions = new _Map(); // pluginId -> Map<actionId, object>
  const pluginTrustLevels = new _Map(); // pluginId -> 'trusted' | 'restricted' (I4)
  const pluginSettingsAllowed = new _Set(); // pluginId (trusted + settingsBridge declared)
  const pluginSettingsSnapshots = new _Map(); // pluginId -> frozen snapshot
  const pluginSettingsListeners = new _Map(); // pluginId -> Set<Function>
  const pluginConfigScopes = new _Map(); // pluginId -> Map<scopeId, { scopeId, access, maxBytes }>
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
        for (let i = 0; i < 16; i++) {
          hex += _StringPadStart(_NumberToString(bytes[i], 16), 2, '0');
        }
        return `rn-${nonceSeq}-${hex}`;
      }
    } catch (_e) {}
    return `rn-${nonceSeq}-${_NumberToString(_DateNow(), 36)}-${_StringSlice(_NumberToString(_MathRandom(), 36), 2)}-${_StringSlice(_NumberToString(_MathRandom(), 36), 2)}`;
  }

  function assertHostToken(providedToken) {
    if (hostToken !== null && providedToken !== hostToken) {
      throw new _Error('ERR_FORBIDDEN_HOST_TOKEN');
    }
  }

  function reportPluginError(pluginId, detail) {
    const entry = { pluginId: _String(pluginId || 'unknown'), detail: _String(detail || '') };
    _ArrayPush(recordedErrors, entry);
    if (recordedErrors.length > 200) _ArrayShift(recordedErrors);
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
      return { ok: true, alreadyBooted: true, docGenId, hostProfileId };
    }
    if (typeof cfg.hostToken === 'string' && cfg.hostToken.length >= 16) {
      hostToken = cfg.hostToken;
    }
    docGenId = _Number(cfg.docGenId) || 1;
    hostProfileId = typeof cfg.hostProfileId === 'string' && cfg.hostProfileId ? cfg.hostProfileId : null;
    extraNoTranslateAttributes = _ArrayIsArray(cfg.extraNoTranslateAttributes)
      ? _ArraySlice(cfg.extraNoTranslateAttributes)
      : [];

    // v2.3.0 HostBridgePort: accept direct cfg.hostBridge injection (e.g. Remote Web adapter)
    // OR T-A Option A1 single-claim Electron preload bootstrap (`claim(nonce)`).
    if (cfg.hostBridge !== undefined && cfg.hostBridge !== null) {
      try {
        hostBridge = wrapHostBridgePort(cfg.hostBridge);
      } catch (err) {
        return {
          ok: false,
          reason: err && err.message ? err.message : 'ERR_INVALID_HOST_BRIDGE_PORT',
        };
      }
    } else {
      const bootstrap = win && win.__addonHostBootstrap;
      if (bootstrap && typeof bootstrap.claim === 'function' && cfg.claimNonce) {
        try {
          hostBridge = wrapHostBridgePort(bootstrap.claim(cfg.claimNonce));
        } catch (err) {
          return {
            ok: false,
            reason: err && err.message ? err.message : 'ERR_BRIDGE_CLAIM_FAILED',
          };
        }
      }
    }
    if (!hostProfileId && hostBridge && hostBridge.profileId) {
      hostProfileId = hostBridge.profileId;
    }

    styleManager = createStyleManager(doc);
    slotManager = createSlotManager(doc, {
      uiAnchors: cfg.uiAnchors || {},
      extraNoTranslateAttributes,
      styleManager,
    });
    surfaceGeometry = createSurfaceGeometry(doc, win, {
      uiSurfaces: cfg.uiSurfaces || {},
      uiAnchors: cfg.uiAnchors || {},
    });
    modalPortal = createModalPortal(doc, win, {
      extraNoTranslateAttributes,
      styleManager,
      surfaceGeometry,
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
    if (
      typeof createHostSettingsUi === 'function' &&
      cfg.settingsUi &&
      typeof cfg.settingsUi === 'object' &&
      hostBridge &&
      typeof hostBridge.getHostAdminState === 'function'
    ) {
      hostSettingsUi = createHostSettingsUi(doc, win, {
        hostBridge,
        settingsUi: cfg.settingsUi,
        extraNoTranslateAttributes,
      });
      hostSettingsUi.start();
    }
    const hasUiGridMerges = applyUiGridMerges(doc, cfg.uiGridMerges);
    booted = true;
    return {
      ok: true,
      alreadyBooted: false,
      docGenId,
      hostProfileId,
      hasBridge: !!hostBridge,
      hasHostSettingsUi: !!hostSettingsUi,
      hasUiGridMerges,
    };
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
        const fns = [];
        _SetForEach(set, (fn) => {
          _ArrayPush(fns, fn);
        });
        for (let i = 0; i < fns.length; i++) {
          try {
            fns[i]();
          } catch (err) {
            reportPluginError(pluginId, err && err.message ? err.message : _String(err));
          }
        }
        _SetClear(set);
        _MapDelete(pluginDisposers, pluginId);
      }
      const markers = _MapGet(pluginMarkDisposed, pluginId);
      if (markers) {
        const marks = [];
        _SetForEach(markers, (mark) => {
          _ArrayPush(marks, mark);
        });
        for (let i = 0; i < marks.length; i++) {
          try {
            marks[i]();
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
      _MapDelete(pluginConfigScopes, pluginId);
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
      throw new _Error('ERR_KERNEL_NOT_BOOTED');
    }
    const pluginId = pluginMeta.pluginId;
    const effectiveTrustLevel = pluginMeta.trustLevel || 'restricted';
    const hasSettingsBridge = !!(pluginMeta.hasSettingsBridge && effectiveTrustLevel === 'trusted');
    const scopeMap = new _Map();
    const declaredConfigScopes = [];
    if (pluginMeta.hasConfigBridge && effectiveTrustLevel === 'trusted' && _ArrayIsArray(pluginMeta.configScopes)) {
      for (let i = 0; i < pluginMeta.configScopes.length; i += 1) {
        const s = pluginMeta.configScopes[i];
        if (!s || typeof s.scopeId !== 'string' || !s.scopeId) continue;
        const access = s.access === 'rw' ? 'rw' : 'ro';
        const maxBytes = _NumberIsFinite(s.maxBytes) ? s.maxBytes : 262144;
        const frozenEntry = _ObjectFreeze({
          scopeId: s.scopeId,
          access,
          maxBytes,
        });
        _MapSet(scopeMap, s.scopeId, frozenEntry);
        _ArrayPush(declaredConfigScopes, frozenEntry);
      }
    }
    const frozenConfigScopes = _ObjectFreeze(declaredConfigScopes);
    const hasConfigBridge = frozenConfigScopes.length > 0;
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
    if (hasConfigBridge) {
      _MapSet(pluginConfigScopes, pluginId, scopeMap);
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
      if (disposed) throw new _Error(`ERR_PLUGIN_HANDLE_DISPOSED:${pluginId}`);
    };

    const handle = _ObjectFreeze({
      pluginId,
      version: pluginMeta.version || '0.0.0',
      trustLevel: effectiveTrustLevel,
      hostProfileId,
      schemaVersion: 2,
      sourceSchemaVersion: pluginMeta.sourceSchemaVersion || 2,
      hasSettingsBridge,
      hasConfigBridge,
      configScopes: frozenConfigScopes,

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

      getSurfaceBounds(surfaceIdOrOpts) {
        assertActive();
        return surfaceGeometry.getSurfaceBounds(surfaceIdOrOpts);
      },

      getActiveSurface() {
        assertActive();
        return surfaceGeometry.getActiveSurface();
      },

      listSurfaces() {
        assertActive();
        return surfaceGeometry.listSurfaces();
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
        if (!actionId || typeof actionId !== 'string') throw new _Error('ERR_INVALID_ACTION_ID');
        let map = _MapGet(pluginActions, pluginId);
        if (!map) {
          map = new _Map();
          _MapSet(pluginActions, pluginId, map);
        }
        const entry = {
          pluginId,
          actionId,
          label: _String(spec.label || actionId),
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
        _MapForEach(pluginActions, (map) => {
          _MapForEach(map, (a) => {
            const ownerTrust = _MapGet(pluginTrustLevels, a.pluginId) || 'restricted';
            if (effectiveTrustLevel !== 'trusted' && ownerTrust === 'trusted' && a.pluginId !== pluginId) {
              return;
            }
            _ArrayPush(out, { pluginId: a.pluginId, actionId: a.actionId, label: a.label });
          });
        });
        return out;
      },

      invokeAction(targetPluginId, actionId, ...args) {
        assertActive();
        const targetTrust = _MapGet(pluginTrustLevels, targetPluginId) || 'restricted';
        if (effectiveTrustLevel !== 'trusted' && targetTrust === 'trusted' && targetPluginId !== pluginId) {
          throw new _Error(`ERR_ACTION_TRUST_FORBIDDEN:${targetPluginId}:${actionId}`);
        }
        const map = _MapGet(pluginActions, targetPluginId);
        const a = map && _MapGet(map, actionId);
        if (!a || !a.run) throw new _Error(`ERR_ACTION_NOT_FOUND:${targetPluginId}:${actionId}`);
        return _ReflectApply(a.run, undefined, args);
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
          throw new _Error('ERR_INVALID_SETTINGS_CALLBACK');
        }
        if (!hasSettingsBridge) {
          throw new _Error('ERR_SETTINGS_BRIDGE_NOT_DECLARED');
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

      saveSettings(nextData) {
        assertActive();
        if (!hasSettingsBridge) {
          return _PromiseReject(new _Error('ERR_SETTINGS_BRIDGE_NOT_DECLARED'));
        }
        if (!nextData || typeof nextData !== 'object' || _ArrayIsArray(nextData)) {
          return _PromiseReject(new _Error('ERR_SETTINGS_MUST_BE_OBJECT'));
        }
        if (!hostBridge || typeof hostBridge.saveSettings !== 'function') {
          return _PromiseReject(new _Error('ERR_SETTINGS_SAVE_UNAVAILABLE'));
        }
        let rawJson;
        try {
          const clean = sanitizeJsonPayload(nextData);
          rawJson = _JSONStringify(clean);
        } catch (err) {
          return _PromiseReject(new _Error(err && err.message ? err.message : 'ERR_SETTINGS_INVALID_JSON'));
        }
        if (typeof rawJson !== 'string') {
          return _PromiseReject(new _Error('ERR_SETTINGS_INVALID_JSON'));
        }
        return _PromiseResolve(hostBridge.saveSettings(pluginId, rawJson)).then((res) => {
          if (res && res.ok === true && res.snapshot && typeof res.snapshot === 'object') {
            const frozen = deepFreezeClone(res.snapshot);
            return _ObjectFreeze({ ok: true, reason: null, snapshot: frozen });
          }
          return _ObjectFreeze({
            ok: false,
            reason: (res && res.reason) || 'ERR_SETTINGS_SAVE_FAILED',
            snapshot: null,
          });
        });
      },

      readConfigScope(scopeId) {
        assertActive();
        if (!hasConfigBridge) {
          return _PromiseReject(new _Error('ERR_CONFIG_BRIDGE_NOT_DECLARED'));
        }
        if (typeof scopeId !== 'string' || !scopeId) {
          return _PromiseReject(new _Error('ERR_INVALID_CONFIG_SCOPE_ID'));
        }
        const boundScopes = _MapGet(pluginConfigScopes, pluginId);
        if (!boundScopes || !_MapHas(boundScopes, scopeId)) {
          return _PromiseReject(new _Error(`ERR_CONFIG_SCOPE_NOT_DECLARED:${scopeId}`));
        }
        if (!hostBridge || typeof hostBridge.readConfigScope !== 'function') {
          return _PromiseReject(new _Error('ERR_CONFIG_BRIDGE_UNAVAILABLE'));
        }
        return _PromiseResolve(hostBridge.readConfigScope(pluginId, scopeId)).then((res) => {
          if (res && typeof res === 'object') {
            return deepFreezeClone(res);
          }
          return _ObjectFreeze({
            ok: false,
            scopeId,
            status: 'error',
            data: null,
            rawText: null,
            sha256: null,
            reason: 'ERR_CONFIG_READ_FAILED',
          });
        });
      },

      writeConfigScope(scopeId, nextDataOrRawJson, opts) {
        assertActive();
        if (!hasConfigBridge) {
          return _PromiseReject(new _Error('ERR_CONFIG_BRIDGE_NOT_DECLARED'));
        }
        if (typeof scopeId !== 'string' || !scopeId) {
          return _PromiseReject(new _Error('ERR_INVALID_CONFIG_SCOPE_ID'));
        }
        const boundScopes = _MapGet(pluginConfigScopes, pluginId);
        const scopeEntry = boundScopes ? _MapGet(boundScopes, scopeId) : null;
        if (!scopeEntry) {
          return _PromiseReject(new _Error(`ERR_CONFIG_SCOPE_NOT_DECLARED:${scopeId}`));
        }
        if (scopeEntry.access !== 'rw') {
          return _PromiseReject(new _Error(`ERR_CONFIG_SCOPE_READ_ONLY:${scopeId}`));
        }
        if (!hostBridge || typeof hostBridge.writeConfigScope !== 'function') {
          return _PromiseReject(new _Error('ERR_CONFIG_BRIDGE_UNAVAILABLE'));
        }
        let rawJson;
        if (typeof nextDataOrRawJson === 'string') {
          rawJson = nextDataOrRawJson;
        } else if (nextDataOrRawJson && typeof nextDataOrRawJson === 'object' && !_ArrayIsArray(nextDataOrRawJson)) {
          try {
            const clean = sanitizeJsonPayload(nextDataOrRawJson);
            rawJson = _JSONStringify(clean);
          } catch (err) {
            const msg = err && err.message ? err.message : 'ERR_CONFIG_INVALID_JSON';
            return _PromiseReject(
              new _Error(
                msg === 'ERR_SETTINGS_UNSAFE_PROTO_KEY'
                  ? 'ERR_CONFIG_UNSAFE_PROTO_KEY'
                  : msg === 'ERR_SETTINGS_INVALID_JSON'
                    ? 'ERR_CONFIG_INVALID_JSON'
                    : msg
              )
            );
          }
        } else {
          return _PromiseReject(new _Error('ERR_CONFIG_MUST_BE_OBJECT'));
        }
        if (typeof rawJson !== 'string') {
          return _PromiseReject(new _Error('ERR_CONFIG_INVALID_JSON'));
        }
        const forwardOpts = {};
        if (opts && typeof opts === 'object' && _ObjectHasOwn(opts, 'expectedSha256') && opts.expectedSha256 !== undefined) {
          if (opts.expectedSha256 !== null && typeof opts.expectedSha256 !== 'string') {
            return _PromiseReject(new _Error('ERR_INVALID_EXPECTED_SHA256'));
          }
          forwardOpts.expectedSha256 = opts.expectedSha256;
        }
        return _PromiseResolve(hostBridge.writeConfigScope(pluginId, scopeId, rawJson, forwardOpts)).then((res) => {
          if (res && typeof res === 'object') {
            return deepFreezeClone(res);
          }
          return _ObjectFreeze({
            ok: false,
            reason: 'ERR_CONFIG_WRITE_FAILED',
            currentSha256: null,
            snapshot: null,
          });
        });
      },

      addManagedListener(target, type, listener, opts) {
        assertActive();
        if (!target || typeof target.addEventListener !== 'function') {
          throw new _Error('ERR_INVALID_EVENT_TARGET');
        }
        const safeListener = (ev) => {
          if (disposed) return;
          try {
            const ret = listener(ev);
            if (ret && typeof ret.then === 'function') {
              ret.catch((err) => reportPluginError(pluginId, err && err.message ? err.message : _String(err)));
            }
          } catch (err) {
            reportPluginError(pluginId, err && err.message ? err.message : _String(err));
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
              reportPluginError(pluginId, err && err.message ? err.message : _String(err));
              return undefined;
            });
          }
          return ret;
        } catch (err) {
          reportPluginError(pluginId, err && err.message ? err.message : _String(err));
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
    const cbs = [];
    _SetForEach(subs, (cb) => {
      _ArrayPush(cbs, cb);
    });
    let delivered = 0;
    for (let i = 0; i < cbs.length; i++) {
      delivered += 1;
      try {
        const ret = cbs[i](frozen);
        if (ret && typeof ret.then === 'function') {
          ret.catch((err) => reportPluginError(pluginId, err && err.message ? err.message : _String(err)));
        }
      } catch (err) {
        reportPluginError(pluginId, err && err.message ? err.message : _String(err));
      }
    }
    return { ok: true, delivered };
  }

  function consumeStagedHandle(runNonce) {
    if (typeof runNonce !== 'string' || !_MapHas(stagedHandles, runNonce)) {
      throw new _Error('ERR_INVALID_OR_CONSUMED_RUN_NONCE');
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
    getErrors: () => _ArraySlice(recordedErrors),
    getBridgeStatus: () => ({ booted, docGenId, hostProfileId, hasBridge: !!hostBridge }),
    listSettingsTabs: () => (settingsTabs ? settingsTabs.listTabs() : []),
    getSurfaceBounds: (surfaceIdOrOpts) => (surfaceGeometry ? surfaceGeometry.getSurfaceBounds(surfaceIdOrOpts) : null),
    getActiveSurface: () => (surfaceGeometry ? surfaceGeometry.getActiveSurface() : null),
    listSurfaces: () => (surfaceGeometry ? surfaceGeometry.listSurfaces() : _ObjectFreeze(['viewport'])),
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
  UI_GRID_MERGE_STYLE_ATTR,
  isSafeGridMergeSelector,
  buildUiGridMergeCss,
  applyUiGridMerges,
};
