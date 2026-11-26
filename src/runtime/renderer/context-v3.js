'use strict';

/**
 * Clean-Slate ISP-Segregated AddonContextV3 Builder (v3.0.0 — SOLID #0).
 *
 * Always-on namespaces:
 *   `apiVersion: 3`, `meta`, `env` (abstract surface & capabilities — NO raw `hostProfileId`),
 *   `theme`, `i18n`, `ui` (Tier 1 + Tier 2 + Tier 3), `storage`, `events`, `services`, `lifecycle` (`AbortSignal`)
 *
 * Capability-gated namespaces (strictly omitted / `undefined` when undeclared, unapproved, or unsupported):
 *   `net?`, `dom?`, `configBridge?`
 */

const { buildOverlayChrome, createSchemaUiController } = require('./ui-schema-renderer');
const { validateSafeCssText } = require('./style-manager');

const _ObjectFreeze = Object.freeze;
const _ReflectApply = Reflect.apply;
const _ArrayIsArray = Array.isArray;
const _Set = Set;
const _SetAdd = Function.prototype.call.bind(Set.prototype.add);
const _SetDelete = Function.prototype.call.bind(Set.prototype.delete);
const _SetClear = Function.prototype.call.bind(Set.prototype.clear);
const _SetForEach = Function.prototype.call.bind(Set.prototype.forEach);

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
  assertActive,
  addDisposer,
  disposeSelf,
  runSafe,
  addManagedListener,
}) {
  const pluginId = pluginMeta.pluginId;
  const displayName = pluginMeta.displayName || pluginId;
  const effectiveTrustLevel = pluginMeta.trustLevel || 'restricted';
  const perms = pluginMeta.permissions && typeof pluginMeta.permissions === 'object' ? pluginMeta.permissions : {};
  const netPerm = perms.net && typeof perms.net === 'object' ? perms.net : null;
  const domPerm = perms.dom && typeof perms.dom === 'object' ? perms.dom : null;

  const hasNetHttps = !!(netPerm && _ArrayIsArray(netPerm.httpsHosts) && netPerm.httpsHosts.length > 0);
  const hasLocalLoopback = !!(
    surface === 'desktop' &&
      effectiveTrustLevel === 'trusted' &&
      netPerm &&
      _ArrayIsArray(netPerm.localLoopback) &&
      netPerm.localLoopback.length > 0
  );
  const hasNetCapability = !!(
    (hasNetHttps || hasLocalLoopback) && hostBridge && typeof hostBridge.netFetch === 'function'
  );
  const hasDocumentTransform = !!(
    effectiveTrustLevel === 'trusted' &&
      (pluginMeta.hasDocumentTransformSlot || (domPerm && domPerm.documentTransform === true))
  );
  const hasDomCapability = !!(
    hasDocumentTransform ||
      (domPerm && _ArrayIsArray(domPerm.anchors) && domPerm.anchors.length > 0) ||
      (_ArrayIsArray(pluginMeta.uiSlots) && pluginMeta.uiSlots.length > 0)
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
      closers[closers.length] = fn;
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
      el.style.background = 'transparent';
      el.style.overflow = 'visible';
      el.style.zIndex = String(2147483200 + activeOverlays.size + 1);
    }

    const shadowHost = isModal ? doc.createElement('div') : el;
    if (isModal) el.appendChild(shadowHost);
    const sr = typeof shadowHost.attachShadow === 'function' ? shadowHost.attachShadow({ mode: 'open' }) : shadowHost;

    let closed = false;
    let tracker = null;
    let outsideCleanup = null;
    let escCleanup = null;

    const close = () => {
      if (closed) return false;
      closed = true;
      _SetDelete(activeOverlays, close);
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
        if (ev.isComposing || ev.keyCode === 229 || ev.defaultPrevented) return;
        if (ev.isTrusted === false) return;
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        close();
      };
      win.addEventListener('keydown', onKeyDown, true);
      escCleanup = () => win.removeEventListener('keydown', onKeyDown, true);
    }

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
    if (slotHandle && slotHandle.shadowRoot && themeAndI18n) {
      const tokenStyle = doc.createElement('style');
      tokenStyle.setAttribute('data-addon-host-tokens', '1');
      tokenStyle.textContent = themeAndI18n.buildTokenCss(themeAndI18n.getSnapshot().mode);
      if (typeof slotHandle.shadowRoot.insertBefore === 'function' && slotHandle.shadowRoot.firstChild) {
        slotHandle.shadowRoot.insertBefore(tokenStyle, slotHandle.shadowRoot.firstChild);
      } else if (typeof slotHandle.shadowRoot.appendChild === 'function') {
        slotHandle.shadowRoot.appendChild(tokenStyle);
      }
    }
    return slotHandle;
  }

  const meta = _ObjectFreeze({
    pluginId,
    displayName,
    version: pluginMeta.version || '0.0.0',
    trustLevel: effectiveTrustLevel,
    sourceSchemaVersion: pluginMeta.sourceSchemaVersion || 3,
  });

  // ISP + SOLID #0: Expose ONLY abstract capabilities and surface — NEVER raw hostProfileId
  const env = _ObjectFreeze({
    surface: surface === 'remote-web' ? 'remote-web' : 'desktop',
    get layoutMode() {
      return detectLayoutMode(win);
    },
    capabilities: _ObjectFreeze({
      hasLocalLoopback,
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

  const storagePerm = perms.storage && typeof perms.storage === 'object' ? perms.storage : {};
  const storage = storageV3.createPluginStorage(pluginId, {
    namespace: storagePerm.namespace || (pluginMeta.isolation && pluginMeta.isolation.storageNamespace) || pluginId,
    maxBytes: storagePerm.maxBytes || 65536,
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
    call(serviceName, methodName, ...args) {
      assertActive();
      return serviceBus.call(pluginId, serviceName, methodName, ...args);
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

  const ctx = {
    apiVersion: 3,
    meta,
    env,
    theme: themeAndI18n.createThemeHandle(addDisposer),
    i18n: themeAndI18n.createI18nHandle(),
    ui,
    storage,
    events,
    services,
    lifecycle,
  };

  // Capability-gated namespaces: strictly omitted when not declared/permitted/supported.
  // Direct own assignment prior to _ObjectFreeze(ctx) avoids Object.defineProperty descriptor
  // inheritance breaks if a peer plugin pollutes Object.prototype.get/set in World 998.
  if (hasNetCapability) {
    ctx.net = _ObjectFreeze({
      fetch(url, init = {}) {
        assertActive();
        return hostBridge.netFetch(pluginId, url, init);
      },
    });
  }

  if (hasDomCapability) {
    ctx.dom = _ObjectFreeze({
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
    });
  }

  if (hasConfigBridge) {
    ctx.configBridge = _ObjectFreeze({
      scopes: frozenConfigScopes,
      read(scopeId) {
        assertActive();
        return readConfigScope(scopeId);
      },
      write(scopeId, nextDataOrRawJson, opts) {
        assertActive();
        return writeConfigScope(scopeId, nextDataOrRawJson, opts);
      },
    });
  }

  return _ObjectFreeze(ctx);
}

module.exports = {
  createAddonContextV3,
};
