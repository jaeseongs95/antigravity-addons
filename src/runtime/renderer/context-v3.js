'use strict';

/**
 * Clean-Slate ISP-Segregated AddonContextV3 Builder (v3.0.0 — SOLID #0).
 *
 * Always-on namespaces:
 *   `apiVersion: 3`, `meta`, `env` (abstract surface & capabilities — NO raw `hostProfileId`),
 *   `theme`, `i18n`, `ui` (Tier 1 + Tier 2 + Tier 3), `storage`, `events`, `services`, `lifecycle` (`AbortSignal`)
 *
 * Capability-gated namespaces (strictly omitted / `undefined` when undeclared, unapproved, or unsupported):
 *   `net?`, `dom?`, `configBridge?`, `settingsBridge?`
 */

const { buildOverlayChrome, createSchemaUiController } = require('./ui-schema-renderer');
const { validateSafeCssText } = require('./style-manager');

const _ObjectCreate = Object.create;
const _ObjectDefineProperty = Object.defineProperty;
const _ObjectFreeze = Object.freeze;
const _ObjectHasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
const _ReflectApply = Reflect.apply;
const _ArrayIsArray = Array.isArray;
const _Set = Set;
const _SetAdd = Function.prototype.call.bind(Set.prototype.add);
const _SetDelete = Function.prototype.call.bind(Set.prototype.delete);
const _SetClear = Function.prototype.call.bind(Set.prototype.clear);
const _SetForEach = Function.prototype.call.bind(Set.prototype.forEach);

// BLK-02: Null-prototype descriptor avoids both Object.prototype.<prop> setter theft
// AND Object.prototype.get/set descriptor collision throws in shared World 998.
function defineSafeReadOnlyProp(target, key, value) {
  const desc = _ObjectCreate(null);
  desc.value = value;
  desc.enumerable = true;
  desc.writable = false;
  desc.configurable = false;
  _ObjectDefineProperty(target, key, desc);
}

function defineSafeDataProp(target, key, value) {
  const desc = _ObjectCreate(null);
  desc.value = value;
  desc.enumerable = true;
  desc.writable = true;
  desc.configurable = true;
  _ObjectDefineProperty(target, key, desc);
}

function pushSafe(arr, value) {
  defineSafeDataProp(arr, arr.length, value);
}

function getOwn(obj, key) {
  if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return undefined;
  return _ObjectHasOwn(obj, key) ? obj[key] : undefined;
}

// NB-01 / R4-NB-02: Module-scoped LIFO stack for v3 overlays with prototype-safe mutations.
const v3EscapeStack = [];
let v3OverlaySeq = 0;

const MODAL_BACKDROP_STYLE_ATTR = 'data-addon-host-v3-backdrop';
const MODAL_BACKDROP_CSS = `
dialog[data-addon-host-v3-overlay="modal"]::backdrop,
dialog[data-addon-host-modal-dialog="1"]::backdrop {
  background: rgba(5, 8, 15, 0.56);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}
`;
const modalBackdropDocs = typeof WeakSet === 'function' ? new WeakSet() : null;

function ensureModalBackdropStyle(doc) {
  if (!doc || typeof doc.createElement !== 'function') return;
  try {
    if (modalBackdropDocs && modalBackdropDocs.has(doc)) return;
    const targetParent = doc.head || doc.documentElement || doc.body;
    const existing =
      (targetParent && typeof targetParent.querySelector === 'function'
        ? targetParent.querySelector(`[${MODAL_BACKDROP_STYLE_ATTR}="1"]`)
        : null) ||
      (typeof doc.querySelector === 'function' ? doc.querySelector(`[${MODAL_BACKDROP_STYLE_ATTR}="1"]`) : null);
    if (existing) {
      if (modalBackdropDocs) modalBackdropDocs.add(doc);
      return;
    }
    if (!targetParent || typeof targetParent.appendChild !== 'function') return;
    const styleEl = doc.createElement('style');
    styleEl.setAttribute(MODAL_BACKDROP_STYLE_ATTR, '1');
    styleEl.textContent = MODAL_BACKDROP_CSS;
    targetParent.appendChild(styleEl);
    if (modalBackdropDocs) modalBackdropDocs.add(doc);
  } catch (_e) {}
}

function removeFromEscapeStack(fn) {
  let idx = -1;
  for (let i = 0; i < v3EscapeStack.length; i += 1) {
    if (v3EscapeStack[i] === fn) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return;
  for (let i = idx; i < v3EscapeStack.length - 1; i += 1) {
    defineSafeDataProp(v3EscapeStack, i, v3EscapeStack[i + 1]);
  }
  v3EscapeStack.length -= 1;
}

function detectLayoutMode(win) {
  const w = win && Number.isFinite(Number(win.innerWidth)) ? Number(win.innerWidth) : 1280;
  if (w > 0 && w <= 640) return 'mobile';
  if (w > 0 && w <= 1024) return 'compact';
  return 'desktop';
}

function createAddonContextV3({
  doc,
  win,
  pluginMeta,
  surface = 'desktop',
  hostBridge = null,
  extraNoTranslateAttributes = [],
  styleManager,
  slotManager,
  surfaceGeometry,
  placementEngine,
  modalPortal,
  regionObserver,
  themeAndI18n,
  toastManager,
  statusItemRegistry,
  settingsPageCoordinator,
  serviceBus,
  eventBus,
  storageV3,
  registerCommand,
  listCommands,
  invokeCommand,
  isElementInsideIgnored,
  readConfigScope,
  writeConfigScope,
  hasConfigBridge,
  frozenConfigScopes,
  hasSettingsBridge,
  getSettings,
  onSettingsChange,
  saveSettings,
  assertActive,
  addDisposer,
  disposeSelf,
  runSafe,
  addManagedListener,
}) {
  // R4-NB-02: Use own-property lookups so inherited Object.prototype.net/dom/trustLevel cannot expose undeclared capabilities.
  const pluginId = getOwn(pluginMeta, 'pluginId');
  const displayName = getOwn(pluginMeta, 'displayName') || pluginId;
  const effectiveTrustLevel = getOwn(pluginMeta, 'trustLevel') || 'restricted';
  const rawPerms = getOwn(pluginMeta, 'permissions');
  const perms = rawPerms && typeof rawPerms === 'object' ? rawPerms : null;
  const rawNet = getOwn(perms, 'net');
  const netPerm = rawNet && typeof rawNet === 'object' ? rawNet : null;
  const rawDom = getOwn(perms, 'dom');
  const domPerm = rawDom && typeof rawDom === 'object' ? rawDom : null;

  const netHttpsHosts = getOwn(netPerm, 'httpsHosts');
  const netLocalLoopback = getOwn(netPerm, 'localLoopback');
  const netUserApprovedHttps = getOwn(netPerm, 'userApprovedHttps') === true;
  const domAnchors = getOwn(domPerm, 'anchors');
  const uiSlots = getOwn(pluginMeta, 'uiSlots');

  const hasNetHttps = !!(
    (_ArrayIsArray(netHttpsHosts) && netHttpsHosts.length > 0) ||
      (surface === 'remote-web' && netUserApprovedHttps)
  );
  const supportsRemoteHostBridge = !!(
    surface === 'remote-web' && hostBridge && typeof hostBridge.getRemoteBridgeStatus === 'function'
  );
  const isRemoteHostBridgeConnected = () => {
    if (!supportsRemoteHostBridge) return false;
    try {
      const st = hostBridge.getRemoteBridgeStatus();
      return !!(st && st.connected === true);
    } catch (_err) {
      return false;
    }
  };
  const hasDeclaredTrustedLoopback = !!(
    effectiveTrustLevel === 'trusted' &&
      _ArrayIsArray(netLocalLoopback) &&
      netLocalLoopback.length > 0
  );
  const hasDesktopLoopback = !!(surface === 'desktop' && hasDeclaredTrustedLoopback);
  const hasRemoteLoopbackViaBridge = !!(supportsRemoteHostBridge && hasDeclaredTrustedLoopback);
  const hasNetCapability = !!(
    (hasNetHttps || hasDesktopLoopback || hasRemoteLoopbackViaBridge) &&
      hostBridge &&
      typeof hostBridge.netFetch === 'function'
  );
  const hasDocumentTransform = !!(
    effectiveTrustLevel === 'trusted' &&
      (getOwn(pluginMeta, 'hasDocumentTransformSlot') || getOwn(domPerm, 'documentTransform') === true)
  );
  const hasDomCapability = !!(
    hasDocumentTransform ||
      (_ArrayIsArray(domAnchors) && domAnchors.length > 0) ||
      (_ArrayIsArray(uiSlots) && uiSlots.length > 0)
  );

  // Lifecycle AbortController
  const abortController = typeof AbortController === 'function' ? new AbortController() : null;
  if (abortController) {
    addDisposer(() => {
      try {
        abortController.abort();
      } catch (_e) {}
    });
  }

  // Helper to mount a Tier-2 or Tier-3 overlay using Top Layer + PlacementEngine + non-removable attribution
  const activeOverlays = new _Set();
  addDisposer(() => {
    const closers = [];
    _SetForEach(activeOverlays, (fn) => {
      pushSafe(closers, fn);
    });
    for (let i = 0; i < closers.length; i += 1) {
      try {
        closers[i]();
      } catch (_e) {}
    }
    _SetClear(activeOverlays);
  });

  function openPositionedOverlay(kind, opts = {}) {
    assertActive();
    const isModal = kind === 'modal';
    const prevFocus = doc && doc.activeElement ? doc.activeElement : null;
    const el = doc.createElement(isModal ? 'dialog' : 'div');
    if (isModal) {
      ensureModalBackdropStyle(doc);
      el.setAttribute('data-addon-host-modal-dialog', '1');
      el.setAttribute('aria-modal', 'true');
    } else {
      el.setAttribute('popover', 'manual');
      el.setAttribute('data-addon-host-popover', '1');
    }
    el.setAttribute('data-addon-host-v3-overlay', kind);
    el.setAttribute('data-addon-host-owner', pluginId);
    el.setAttribute('role', 'dialog');
    el.setAttribute('translate', 'no');
    el.setAttribute('data-addon-host-no-translate', 'true');
    el.setAttribute('data-addon-host-ignore', 'true');
    for (let i = 0; i < extraNoTranslateAttributes.length; i += 1) {
      el.setAttribute(extraNoTranslateAttributes[i], 'true');
    }
    if (el.style) {
      el.style.padding = '0';
      el.style.border = 'none';
      el.style.borderRadius = 'var(--ag-radius, 12px)';
      el.style.background = 'transparent';
      el.style.overflow = 'hidden';
      el.style.boxSizing = 'border-box';
      el.style.zIndex = String(2147483200 + activeOverlays.size + 1);
    }

    const shadowHost = isModal ? doc.createElement('div') : el;
    if (isModal) {
      if (shadowHost.style) {
        shadowHost.style.width = '100%';
        shadowHost.style.maxHeight = 'inherit';
        shadowHost.style.display = 'flex';
        shadowHost.style.flexDirection = 'column';
        shadowHost.style.overflow = 'hidden';
        shadowHost.style.boxSizing = 'border-box';
      }
      el.appendChild(shadowHost);
    }
    const sr = typeof shadowHost.attachShadow === 'function' ? shadowHost.attachShadow({ mode: 'open' }) : shadowHost;

    let closed = false;
    let tracker = null;
    let outsideCleanup = null;
    let escCleanup = null;
    v3OverlaySeq += 1;
    const claimId = `v3:${pluginId}:${kind}:${v3OverlaySeq}`;
    const notifyPortalClaim = (active) => {
      if (hostBridge && typeof hostBridge.setPortalClaim === 'function') {
        try {
          hostBridge.setPortalClaim(claimId, active);
        } catch (_e) {}
      }
    };

    const close = () => {
      if (closed) return false;
      closed = true;
      _SetDelete(activeOverlays, close);
      removeFromEscapeStack(close);
      notifyPortalClaim(false);
      if (tracker) {
        tracker.dispose();
        tracker = null;
      }
      if (outsideCleanup) {
        outsideCleanup();
        outsideCleanup = null;
      }
      if (escCleanup) {
        escCleanup();
        escCleanup = null;
      }
      try {
        if (isModal && typeof el.close === 'function' && el.open) el.close();
        else if (!isModal && typeof el.hidePopover === 'function') el.hidePopover();
      } catch (_e) {}
      if (el.parentNode && typeof el.parentNode.removeChild === 'function') {
        el.parentNode.removeChild(el);
      }
      if (prevFocus && typeof prevFocus.focus === 'function') {
        try {
          prevFocus.focus();
        } catch (_e) {}
      }
      if (typeof opts.onClose === 'function') {
        try {
          opts.onClose();
        } catch (_e) {}
      }
      return true;
    };

    const tokenCss = themeAndI18n ? themeAndI18n.buildTokenCss(themeAndI18n.getSnapshot().mode) : '';
    const { body, badge } = buildOverlayChrome(doc, sr, {
      title: opts.title || '',
      displayName,
      tokenCss,
      closable: opts.closable !== false,
      onClose: close,
    });

    let schemaController = null;
    if (opts.tree && typeof opts.tree === 'object') {
      schemaController = createSchemaUiController(doc, body, {
        tree: opts.tree,
        state: opts.state || {},
        onChange: opts.onChange || null,
        onAction: opts.onAction || null,
      });
    }

    const parent = doc.body || doc.documentElement;
    if (parent && typeof parent.appendChild === 'function') {
      parent.appendChild(el);
    }

    if (isModal && typeof el.showModal === 'function') {
      try {
        el.showModal();
      } catch (_e) {}
    } else if (!isModal && typeof el.showPopover === 'function') {
      try {
        el.showPopover();
      } catch (_e) {}
    }

    const defaultZone = kind === 'panel' ? 'drawer' : kind === 'modal' ? 'surface-center' : 'anchor';
    const placementSpec = {
      zone: defaultZone,
      ...(opts.placement && typeof opts.placement === 'object' ? opts.placement : {}),
    };
    tracker = placementEngine.trackElementPlacement(el, placementSpec);

    if (isModal && typeof el.addEventListener === 'function') {
      el.addEventListener('cancel', (ev) => {
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
        close();
      });
    }

    if (!isModal && opts.closeOnOutsideClick !== false && doc && typeof doc.addEventListener === 'function') {
      const onPointerDown = (ev) => {
        if (closed) return;
        const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [ev.target];
        if (path.includes(el)) return;
        const anchor = placementSpec.anchorEl;
        if (anchor && (path.includes(anchor) || (typeof anchor.contains === 'function' && anchor.contains(ev.target)))) {
          return;
        }
        close();
      };
      doc.addEventListener('pointerdown', onPointerDown, true);
      outsideCleanup = () => doc.removeEventListener('pointerdown', onPointerDown, true);
    }

    if (win && typeof win.addEventListener === 'function') {
      const onKeyDown = (ev) => {
        if (closed || !ev || ev.key !== 'Escape') return;
        if (v3EscapeStack.length > 0 && v3EscapeStack[v3EscapeStack.length - 1] !== close) return;
        if (ev.isComposing || ev.keyCode === 229 || ev.defaultPrevented) return;
        if (ev.isTrusted === false) return;
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
        close();
      };
      win.addEventListener('keydown', onKeyDown, true);
      escCleanup = () => win.removeEventListener('keydown', onKeyDown, true);
    }

    pushSafe(v3EscapeStack, close);
    notifyPortalClaim(true);
    _SetAdd(activeOverlays, close);

    return _ObjectFreeze({
      kind,
      element: el,
      bodyEl: opts.tree ? null : body, // Tier-2 schema overlays keep DOM host-owned; Tier-3 canvas overlays expose bodyEl
      attributionBadge: badge,
      getPlacement: () => (tracker ? tracker.reposition() : null),
      reposition: () => (tracker ? tracker.reposition() : null),
      update(nextTree, nextState) {
        if (!schemaController) {
          throw new Error('ERR_OVERLAY_NOT_SCHEMA_DRIVEN');
        }
        schemaController.update(nextTree, nextState);
        if (tracker) tracker.reposition();
      },
      getState: () => (schemaController ? schemaController.getState() : null),
      getElementById: (nodeId) => (schemaController ? schemaController.getElementById(nodeId) : null),
      close,
    });
  }

  function createStyleElementSafe(cssText) {
    assertActive();
    const check = validateSafeCssText(cssText, { scope: 'owner' });
    if (!check.ok) {
      throw new Error(check.reason || 'ERR_UNSAFE_CSS_CONSTRUCT');
    }
    const styleEl = doc.createElement('style');
    styleEl.setAttribute('data-addon-host-owner', pluginId);
    styleEl.textContent = String(cssText);
    return styleEl;
  }

  function mountCanvas(slotId, opts = {}) {
    assertActive();
    const canvasOpts = { ...opts, shadow: true };
    const slotHandle = slotManager.mountSlot(pluginMeta, slotId, canvasOpts);
    const targetRoot =
      (slotHandle && slotHandle.shadowRoot) ||
      (slotHandle && typeof slotHandle.getRootNode === 'function' ? slotHandle.getRootNode() : null);
    if (targetRoot && targetRoot !== doc && themeAndI18n) {
      const tokenStyle = doc.createElement('style');
      tokenStyle.setAttribute('data-addon-host-tokens', '1');
      tokenStyle.textContent = themeAndI18n.buildTokenCss(themeAndI18n.getSnapshot().mode);
      if (typeof targetRoot.insertBefore === 'function' && targetRoot.firstChild) {
        targetRoot.insertBefore(tokenStyle, targetRoot.firstChild);
      } else if (typeof targetRoot.appendChild === 'function') {
        targetRoot.appendChild(tokenStyle);
      }
    }
    return slotHandle;
  }

  const meta = _ObjectFreeze({
    pluginId,
    displayName,
    version: getOwn(pluginMeta, 'version') || '0.0.0',
    trustLevel: effectiveTrustLevel,
    sourceSchemaVersion: getOwn(pluginMeta, 'sourceSchemaVersion') || 3,
  });

  // ISP + SOLID #0: Expose ONLY abstract capabilities and surface — NEVER raw hostProfileId
  const env = _ObjectFreeze({
    surface: surface === 'remote-web' ? 'remote-web' : 'desktop',
    get layoutMode() {
      return detectLayoutMode(win);
    },
    capabilities: _ObjectFreeze({
      get hasLocalLoopback() {
        return hasDesktopLoopback || (hasRemoteLoopbackViaBridge && isRemoteHostBridgeConnected());
      },
      get hasRemoteHostBridge() {
        return isRemoteHostBridgeConnected();
      },
      hasNetHttps,
      hasConfigBridge: !!hasConfigBridge,
      hasSettingsBridge: !!hasSettingsBridge,
      hasDocumentTransform,
    }),
  });

  const ui = _ObjectFreeze({
    // Tier 1: Zero-DOM Semantic Host Surfaces
    showToast(opts) {
      assertActive();
      return toastManager.showToast(pluginMeta, opts);
    },
    confirm(opts) {
      assertActive();
      return toastManager.confirm(pluginMeta, opts);
    },
    prompt(opts) {
      assertActive();
      return toastManager.prompt(pluginMeta, opts);
    },
    registerCommand(commandId, spec) {
      assertActive();
      return registerCommand(commandId, spec);
    },
    listCommands() {
      assertActive();
      return listCommands();
    },
    invokeCommand() {
      assertActive();
      return _ReflectApply(invokeCommand, undefined, arguments);
    },
    registerStatusItem(spec) {
      assertActive();
      const handle = statusItemRegistry.registerStatusItem(pluginId, spec);
      addDisposer(() => handle.dispose());
      return handle;
    },
    registerSettingsPage(spec) {
      assertActive();
      const handle = settingsPageCoordinator.registerSettingsPage(pluginMeta, spec);
      addDisposer(() => handle.dispose());
      return handle;
    },

    // Tier 2: Host-Positioned Overlays + Typed Declarative Schema
    openPopup(opts) {
      return openPositionedOverlay('popup', opts);
    },
    openModal(opts) {
      return openPositionedOverlay('modal', opts);
    },
    openPanel(opts) {
      return openPositionedOverlay('panel', opts);
    },

    // Tier 3: Controlled Escape Hatch
    mountCanvas,
    createStyleElementSafe,
    injectStyle(styleId, cssText, opts) {
      assertActive();
      return styleManager.injectStyle(pluginMeta, styleId, cssText, opts);
    },
    removeStyle(styleId) {
      assertActive();
      return styleManager.removeStyle(pluginId, styleId);
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
  });

  const rawStoragePerm = getOwn(perms, 'storage');
  const storagePerm = rawStoragePerm && typeof rawStoragePerm === 'object' ? rawStoragePerm : null;
  const isolationMeta = getOwn(pluginMeta, 'isolation');
  const storage = storageV3.createPluginStorage(pluginId, {
    namespace:
      getOwn(storagePerm, 'namespace') ||
      getOwn(isolationMeta, 'storageNamespace') ||
      pluginId,
    maxBytes: getOwn(storagePerm, 'maxBytes') || 65536,
    assertActive,
    registerDisposer: addDisposer,
  });

  const events = _ObjectFreeze({
    on(topic, handler) {
      assertActive();
      const unsub = eventBus.on(pluginId, topic, handler);
      addDisposer(unsub);
      return unsub;
    },
    once(topic, handler) {
      assertActive();
      const unsub = eventBus.once(pluginId, topic, handler);
      addDisposer(unsub);
      return unsub;
    },
    emit(topic, payload) {
      assertActive();
      return eventBus.emit(pluginId, topic, payload);
    },
  });

  const services = _ObjectFreeze({
    provide(serviceName, impl, opts) {
      assertActive();
      const handle = serviceBus.provide(pluginMeta, serviceName, impl, opts);
      addDisposer(() => handle.dispose());
      return handle;
    },
    has(serviceName) {
      assertActive();
      return serviceBus.has(pluginId, serviceName);
    },
    list() {
      assertActive();
      return serviceBus.list(pluginId);
    },
    // R3-BLK-01: Avoid `...args` spread (which invokes Array.prototype[Symbol.iterator]) and element assignment setters.
    call() {
      assertActive();
      const callArgs = [];
      defineSafeDataProp(callArgs, 0, pluginId);
      for (let i = 0; i < arguments.length; i += 1) {
        defineSafeDataProp(callArgs, i + 1, arguments[i]);
      }
      return _ReflectApply(serviceBus.call, undefined, callArgs);
    },
  });

  const lifecycle = _ObjectFreeze({
    signal: abortController ? abortController.signal : null,
    onDispose(fn) {
      assertActive();
      addDisposer(fn);
    },
    addManagedListener,
    runSafe,
    dispose: disposeSelf,
  });

  const ctx = {};
  defineSafeReadOnlyProp(ctx, 'apiVersion', 3);
  defineSafeReadOnlyProp(ctx, 'meta', meta);
  defineSafeReadOnlyProp(ctx, 'env', env);
  defineSafeReadOnlyProp(ctx, 'theme', themeAndI18n.createThemeHandle(addDisposer));
  defineSafeReadOnlyProp(ctx, 'i18n', themeAndI18n.createI18nHandle());
  defineSafeReadOnlyProp(ctx, 'ui', ui);
  defineSafeReadOnlyProp(ctx, 'storage', storage);
  defineSafeReadOnlyProp(ctx, 'events', events);
  defineSafeReadOnlyProp(ctx, 'services', services);
  defineSafeReadOnlyProp(ctx, 'lifecycle', lifecycle);

  // Capability-gated namespaces: strictly omitted when not declared/permitted/supported.
  // BLK-02: defineSafeReadOnlyProp uses a null-prototype descriptor so neither
  // Object.prototype.<prop> setters nor Object.prototype.get/set can hijack or crash World 998.
  if (hasNetCapability) {
    defineSafeReadOnlyProp(
      ctx,
      'net',
      _ObjectFreeze({
        fetch(url, init = {}) {
          assertActive();
          return hostBridge.netFetch(pluginId, url, init);
        },
      })
    );
  }

  if (hasDomCapability) {
    defineSafeReadOnlyProp(
      ctx,
      'dom',
      _ObjectFreeze({
        observeRegion(selector, callback, opts) {
          assertActive();
          return regionObserver.observeRegion(pluginId, selector, callback, opts);
        },
        isElementInsideIgnored(nodeOrEvent, opts) {
          return isElementInsideIgnored(nodeOrEvent, opts);
        },
        mountSlot(slotId, opts) {
          assertActive();
          return slotManager.mountSlot(pluginMeta, slotId, opts);
        },
        unmountSlot(slotId) {
          assertActive();
          return slotManager.unmountSlot(pluginId, slotId);
        },
      })
    );
  }

  if (hasConfigBridge) {
    defineSafeReadOnlyProp(
      ctx,
      'configBridge',
      _ObjectFreeze({
        scopes: frozenConfigScopes,
        read(scopeId) {
          assertActive();
          return readConfigScope(scopeId);
        },
        write(scopeId, nextDataOrRawJson, opts) {
          assertActive();
          return writeConfigScope(scopeId, nextDataOrRawJson, opts);
        },
      })
    );
  }

  if (
    hasSettingsBridge &&
    typeof getSettings === 'function' &&
    typeof onSettingsChange === 'function' &&
    typeof saveSettings === 'function'
  ) {
    const readSnap = () => {
      assertActive();
      return getSettings();
    };
    const subscribeSnap = (callback) => {
      assertActive();
      return onSettingsChange(callback);
    };
    const persistSnap = (nextData) => {
      assertActive();
      return saveSettings(nextData);
    };
    defineSafeReadOnlyProp(
      ctx,
      'settingsBridge',
      _ObjectFreeze({
        getSettings: readSnap,
        getSnapshot: readSnap,
        onSettingsChange: subscribeSnap,
        onDidChange: subscribeSnap,
        saveSettings: persistSnap,
        save: persistSnap,
      })
    );
  }

  return _ObjectFreeze(ctx);
}

module.exports = {
  createAddonContextV3,
};
