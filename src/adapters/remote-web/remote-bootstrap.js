'use strict';

/**
 * Vendor-neutral Remote Web Browser Bootstrap & Shadow-DOM Host Drawer (v2.3.0).
 *
 * - Pure Browser + Node CJS (ZERO Node built-in imports, ZERO vendor literals).
 * - Fail-closed origin enforcement BEFORE creating any DOM element or booting kernel.
 * - Zero HTML sinks (100% `createElementSafe` + `textContent`).
 * - Zero `eval` / `new Function` (packed addons execute via pre-compiled `addon.run(handle)`).
 * - Mounts an unobtrusive, keyboard-accessible Shadow-DOM dark-mode status/settings drawer
 *   and semantic fallback anchor dock (`[data-remote-addon-host-slot-host="..."]`) so
 *   compliant AddonManifest.v2 plugins render even when page-specific selectors differ.
 */

const { assertAllowedOrigin } = require('./origin-guard');
const { createScopedTrustedTypesGuard } = require('./trusted-types-guard');
const {
  createElementSafe,
  clearChildrenSafe,
  setTextSafe,
  createShadowContainer,
} = require('./dom-guard');
const { createRemoteHostBridge } = require('./remote-host-bridge');

const FALLBACK_ANCHOR_KEYS = Object.freeze([
  'status-bar',
  'sidebar',
  'overview-pane',
  'settings-pane',
  'automation-page',
  'customizations-page',
]);

const DRAWER_HOST_ID = 'remote-addon-host-drawer-root';
const SLOT_DOCK_ID = 'remote-addon-host-slot-dock';

const DRAWER_CSS = `
:host {
  all: initial;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: #e6edf3;
  font-size: 12px;
  line-height: 1.45;
}
.rah-shell {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483000;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}
.rah-pill {
  appearance: none;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(18, 22, 30, 0.94);
  color: #e6edf3;
  border-radius: 999px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
}
.rah-pill:hover {
  background: rgba(28, 34, 46, 0.98);
  border-color: rgba(130, 180, 255, 0.45);
}
.rah-pill:focus-visible,
.rah-btn:focus-visible,
.rah-tab:focus-visible {
  outline: 2px solid #79c0ff;
  outline-offset: 2px;
}
.rah-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #3fb950;
  flex-shrink: 0;
}
.rah-dot.has-error {
  background: #f85149;
}
.rah-badge {
  background: rgba(121, 192, 255, 0.16);
  color: #a5d6ff;
  border-radius: 999px;
  padding: 1px 7px;
  font-size: 11px;
}
.rah-badge.err {
  background: rgba(248, 81, 73, 0.2);
  color: #ffa198;
}
.rah-drawer {
  width: min(360px, calc(100vw - 32px));
  max-height: min(460px, calc(100vh - 96px));
  background: rgba(15, 19, 26, 0.97);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.rah-drawer[hidden] {
  display: none;
}
.rah-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}
.rah-title {
  font-size: 13px;
  font-weight: 700;
  color: #f0f6fc;
}
.rah-meta {
  font-size: 11px;
  color: #8b949e;
}
.rah-btn {
  appearance: none;
  background: rgba(255, 255, 255, 0.08);
  color: #e6edf3;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 11px;
  cursor: pointer;
}
.rah-tabs {
  display: flex;
  gap: 4px;
  padding: 8px 12px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.rah-tab {
  appearance: none;
  background: transparent;
  color: #8b949e;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.rah-tab[aria-selected="true"] {
  color: #f0f6fc;
  border-bottom-color: #79c0ff;
}
.rah-body {
  padding: 10px 12px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rah-card {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.rah-card-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.rah-status-ok { color: #3fb950; font-weight: 600; }
.rah-status-err { color: #f85149; font-weight: 600; }
.rah-empty {
  color: #8b949e;
  padding: 12px 4px;
  text-align: center;
}
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
`;

function generateHostToken(win) {
  try {
    const cryptoObj = (win && win.crypto) || (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
    if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
      const bytes = new Uint8Array(24);
      cryptoObj.getRandomValues(bytes);
      let hex = '';
      for (let i = 0; i < bytes.length; i += 1) {
        hex += bytes[i].toString(16).padStart(2, '0');
      }
      return `rht-${hex}`;
    }
  } catch (_err) {
    // Fallback token below when WebCrypto is absent in minimal test doubles.
  }
  return `rht-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function mountFallbackSlotDock(doc, noTranslateAttrs) {
  const parent = doc.body || doc.documentElement;
  if (!parent || typeof parent.appendChild !== 'function') return null;

  const existing = typeof doc.getElementById === 'function' ? doc.getElementById(SLOT_DOCK_ID) : null;
  if (existing) return existing;

  const dock = createElementSafe(doc, 'div', {
    id: SLOT_DOCK_ID,
    translate: 'no',
    'data-addon-host-ignore': 'true',
    'data-addon-host-no-translate': 'true',
  });
  dock.style.position = 'fixed';
  dock.style.left = '12px';
  dock.style.bottom = '12px';
  dock.style.zIndex = '2147482900';
  dock.style.display = 'flex';
  dock.style.flexDirection = 'column';
  dock.style.gap = '6px';
  dock.style.maxWidth = 'calc(100vw - 180px)';
  dock.style.pointerEvents = 'none';

  for (let i = 0; i < noTranslateAttrs.length; i += 1) {
    const attr = String(noTranslateAttrs[i] || '').trim();
    if (attr && !attr.toLowerCase().startsWith('on')) {
      dock.setAttribute(attr, 'true');
    }
  }

  for (let i = 0; i < FALLBACK_ANCHOR_KEYS.length; i += 1) {
    const key = FALLBACK_ANCHOR_KEYS[i];
    const slotHost = createElementSafe(doc, 'div', {
      'data-remote-addon-host-slot-host': key,
    });
    slotHost.style.pointerEvents = 'auto';
    dock.appendChild(slotHost);
  }

  parent.appendChild(dock);
  return dock;
}

function createHostDrawerUi({ doc, win, profile, getState }) {
  const noTranslateAttrs = Array.isArray(profile.extraNoTranslateAttributes) ? profile.extraNoTranslateAttributes : [];
  const { hostEl, shadowRoot } = createShadowContainer(doc, DRAWER_HOST_ID, {
    mode: 'open',
    noTranslateAttrs,
    cssText: DRAWER_CSS,
  });

  clearChildrenSafe(shadowRoot);
  const styleEl = doc.createElement('style');
  styleEl.textContent = DRAWER_CSS;
  shadowRoot.appendChild(styleEl);

  const shell = createElementSafe(doc, 'div', { class: 'rah-shell' });

  const drawer = createElementSafe(doc, 'section', {
    id: 'rah-drawer-panel',
    class: 'rah-drawer',
    role: 'region',
    'aria-label': `${profile.displayName || profile.id} Control Panel`,
    hidden: 'true',
  });

  const header = createElementSafe(doc, 'div', { class: 'rah-header' });
  const titleWrap = createElementSafe(doc, 'div');
  const titleEl = createElementSafe(doc, 'div', { class: 'rah-title' }, profile.displayName || profile.id);
  const metaEl = createElementSafe(doc, 'div', { class: 'rah-meta' }, `profile: ${profile.id}`);
  titleWrap.appendChild(titleEl);
  titleWrap.appendChild(metaEl);

  const closeBtn = createElementSafe(
    doc,
    'button',
    { type: 'button', class: 'rah-btn', 'aria-label': 'Close remote addon host panel' },
    'Close'
  );
  header.appendChild(titleWrap);
  header.appendChild(closeBtn);

  const tabsRow = createElementSafe(doc, 'div', { class: 'rah-tabs', role: 'tablist' });
  const bodyEl = createElementSafe(doc, 'div', { class: 'rah-body', role: 'tabpanel' });

  let activeTab = 'addons';
  let isOpen = false;

  const tabDefs = [
    { id: 'addons', label: 'Addons' },
    { id: 'settings', label: 'Settings Tabs' },
    { id: 'errors', label: 'Diagnostics' },
  ];
  const tabButtons = new Map();

  for (let i = 0; i < tabDefs.length; i += 1) {
    const def = tabDefs[i];
    const btn = createElementSafe(
      doc,
      'button',
      {
        type: 'button',
        class: 'rah-tab',
        role: 'tab',
        'aria-selected': def.id === activeTab ? 'true' : 'false',
      },
      def.label
    );
    btn.addEventListener('click', () => {
      activeTab = def.id;
      render();
    });
    tabButtons.set(def.id, btn);
    tabsRow.appendChild(btn);
  }

  drawer.appendChild(header);
  drawer.appendChild(tabsRow);
  drawer.appendChild(bodyEl);

  const pillBtn = createElementSafe(doc, 'button', {
    type: 'button',
    class: 'rah-pill',
    'aria-expanded': 'false',
    'aria-controls': 'rah-drawer-panel',
  });
  const dotEl = createElementSafe(doc, 'span', { class: 'rah-dot', 'aria-hidden': 'true' });
  const labelEl = createElementSafe(doc, 'span', null, 'Addons');
  const countBadge = createElementSafe(doc, 'span', { class: 'rah-badge' }, '0');
  const errBadge = createElementSafe(doc, 'span', { class: 'rah-badge err', hidden: 'true' }, '0 err');
  pillBtn.appendChild(dotEl);
  pillBtn.appendChild(labelEl);
  pillBtn.appendChild(countBadge);
  pillBtn.appendChild(errBadge);

  shell.appendChild(drawer);
  shell.appendChild(pillBtn);
  shadowRoot.appendChild(shell);

  function setOpen(nextOpen) {
    isOpen = Boolean(nextOpen);
    pillBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    if (isOpen) {
      drawer.removeAttribute('hidden');
      render();
    } else {
      drawer.setAttribute('hidden', 'true');
    }
  }

  pillBtn.addEventListener('click', () => setOpen(!isOpen));
  closeBtn.addEventListener('click', () => {
    setOpen(false);
    if (typeof pillBtn.focus === 'function') pillBtn.focus();
  });

  const onKeyDown = (ev) => {
    if (isOpen && ev && ev.key === 'Escape') {
      setOpen(false);
      if (typeof pillBtn.focus === 'function') pillBtn.focus();
    }
  };
  if (win && typeof win.addEventListener === 'function') {
    win.addEventListener('keydown', onKeyDown);
  }

  function render() {
    const state = getState();
    const activeCount = state.addons.filter((a) => a.status === 'active').length;
    const errorCount = state.errors.length;

    setTextSafe(countBadge, `${activeCount}/${state.addons.length}`);
    if (errorCount > 0) {
      dotEl.setAttribute('class', 'rah-dot has-error');
      errBadge.removeAttribute('hidden');
      setTextSafe(errBadge, `${errorCount} err`);
    } else {
      dotEl.setAttribute('class', 'rah-dot');
      errBadge.setAttribute('hidden', 'true');
    }

    for (const [id, btn] of tabButtons.entries()) {
      btn.setAttribute('aria-selected', id === activeTab ? 'true' : 'false');
    }

    clearChildrenSafe(bodyEl);

    if (activeTab === 'addons') {
      if (state.addons.length === 0) {
        bodyEl.appendChild(createElementSafe(doc, 'div', { class: 'rah-empty' }, 'No addons packed in this remote bundle.'));
        return;
      }
      for (let i = 0; i < state.addons.length; i += 1) {
        const item = state.addons[i];
        const card = createElementSafe(doc, 'div', { class: 'rah-card' });
        const row = createElementSafe(doc, 'div', { class: 'rah-card-row' });
        row.appendChild(createElementSafe(doc, 'strong', null, `${item.displayName} (${item.version})`));
        row.appendChild(
          createElementSafe(
            doc,
            'span',
            { class: item.status === 'active' ? 'rah-status-ok' : 'rah-status-err' },
            item.status
          )
        );
        card.appendChild(row);
        const subText = item.error
          ? `${item.pluginId} · ${item.trustLevel} · ${item.error}`
          : `${item.pluginId} · ${item.trustLevel}${item.skippedCapabilities.length ? ` · skipped: ${item.skippedCapabilities.join(',')}` : ''}`;
        card.appendChild(createElementSafe(doc, 'div', { class: 'rah-meta' }, subText));
        bodyEl.appendChild(card);
      }
      return;
    }

    if (activeTab === 'settings') {
      if (!state.settingsTabs || state.settingsTabs.length === 0) {
        bodyEl.appendChild(createElementSafe(doc, 'div', { class: 'rah-empty' }, 'No plugin settings tabs registered.'));
        return;
      }
      for (let i = 0; i < state.settingsTabs.length; i += 1) {
        const tab = state.settingsTabs[i];
        const card = createElementSafe(doc, 'div', {
          class: 'rah-card',
          'data-settings-tab-id': tab.tabId || '',
        });
        const row = createElementSafe(doc, 'div', { class: 'rah-card-row' });
        row.appendChild(createElementSafe(doc, 'strong', { class: 'rah-tab-label' }, tab.label || tab.tabId));
        row.appendChild(createElementSafe(doc, 'span', { class: 'rah-meta' }, tab.pluginId));
        card.appendChild(row);
        card.appendChild(createElementSafe(doc, 'div', { class: 'rah-meta' }, `tabId: ${tab.tabId}`));
        bodyEl.appendChild(card);
      }
      return;
    }

    if (state.errors.length === 0) {
      bodyEl.appendChild(createElementSafe(doc, 'div', { class: 'rah-empty' }, 'No runtime errors recorded.'));
      return;
    }
    for (let i = state.errors.length - 1; i >= 0; i -= 1) {
      const err = state.errors[i];
      const card = createElementSafe(doc, 'div', { class: 'rah-card' });
      card.appendChild(createElementSafe(doc, 'strong', null, err.pluginId));
      card.appendChild(createElementSafe(doc, 'div', { class: 'rah-meta' }, err.detail));
      bodyEl.appendChild(card);
    }
  }

  render();

  return Object.freeze({
    hostEl,
    shadowRoot,
    setOpen,
    render,
    dispose() {
      if (win && typeof win.removeEventListener === 'function') {
        win.removeEventListener('keydown', onKeyDown);
      }
      if (hostEl && hostEl.parentNode && typeof hostEl.parentNode.removeChild === 'function') {
        hostEl.parentNode.removeChild(hostEl);
      }
    },
  });
}

async function bootRemoteWebHost({
  doc = typeof globalThis !== 'undefined' ? globalThis.document : null,
  win = typeof globalThis !== 'undefined' ? globalThis.window || globalThis : null,
  profile,
  kernel = null,
  packedAddons = [],
  docGenId = 1,
  storage = null,
  remoteTransport = null,
  configScopeSnapshots = null,
  allowedOrigins = null,
  allowLoopbackHttp = false,
  mountDrawer = true,
  mountFallbackDock = true,
} = {}) {
  if (!profile || typeof profile !== 'object' || typeof profile.id !== 'string' || !profile.id.trim()) {
    return { ok: false, reason: 'ERR_INVALID_HOST_PROFILE' };
  }
  if (!doc || !win) {
    return { ok: false, reason: 'ERR_DOM_UNAVAILABLE' };
  }

  const currentHref =
    win.location && typeof win.location.href === 'string'
      ? win.location.href
      : win.location && typeof win.location.origin === 'string'
        ? win.location.origin
        : '';

  const effectiveAllowedOrigins = Array.isArray(allowedOrigins) ? allowedOrigins : profile.allowedOrigins || [];
  let verifiedOrigin;
  try {
    verifiedOrigin = assertAllowedOrigin(currentHref, {
      allowedOrigins: effectiveAllowedOrigins,
      excludedProtocols: profile.excludedUrlProtocols,
      allowLoopbackHttp,
    });
  } catch (err) {
    return {
      ok: false,
      reason: (err && err.code) || 'ERR_ORIGIN_NOT_ALLOWED',
      error: err && err.message ? err.message : String(err),
    };
  }

  const activeKernel = kernel || (typeof globalThis !== 'undefined' ? globalThis.__addonHostKernel : null);
  if (!activeKernel || typeof activeKernel.boot !== 'function') {
    return { ok: false, reason: 'ERR_RENDERER_KERNEL_UNAVAILABLE' };
  }

  const instanceKey = `__remoteAddonHost_${profile.id}`;
  if (win[instanceKey] && win[instanceKey].docGenId === docGenId && !win[instanceKey].disposed) {
    return { ok: true, alreadyBooted: true, controller: win[instanceKey] };
  }

  const ttGuard = createScopedTrustedTypesGuard(win, {
    policyName: profile.trustedTypesPolicyName || 'remote-web-addon-host',
    allowedOrigin: verifiedOrigin,
    allowLoopbackHttp,
  });

  const hostToken = generateHostToken(win);
  const addonStates = [];
  let drawerUi = null;

  const bridge = createRemoteHostBridge({
    doc,
    win,
    docGenId,
    profileId: profile.id,
    storageNamespace: profile.storageNamespace || `remote-addon-host:${profile.id}`,
    storage,
    remoteTransport,
    configScopeSnapshots,
    onSettingsSaved(pluginId, snapshot) {
      activeKernel.pushPluginSettings(pluginId, snapshot, hostToken);
      if (drawerUi) drawerUi.render();
    },
    onError() {
      if (drawerUi) drawerUi.render();
    },
  });

  const bootRes = activeKernel.boot({
    docGenId,
    hostToken,
    hostProfileId: profile.id,
    hostBridge: bridge.port,
    uiAnchors: profile.uiAnchors || {},
    extraNoTranslateAttributes: Array.isArray(profile.extraNoTranslateAttributes)
      ? profile.extraNoTranslateAttributes
      : [],
  });
  if (!bootRes || bootRes.ok !== true) {
    return { ok: false, reason: (bootRes && bootRes.reason) || 'ERR_KERNEL_BOOT_FAILED' };
  }

  let fallbackDockEl = null;
  if (mountFallbackDock !== false) {
    fallbackDockEl = mountFallbackSlotDock(
      doc,
      Array.isArray(profile.extraNoTranslateAttributes) ? profile.extraNoTranslateAttributes : []
    );
  }

  for (let i = 0; i < (packedAddons || []).length; i += 1) {
    const addon = packedAddons[i];
    const meta = addon && addon.pluginMeta;
    if (!meta || typeof meta.pluginId !== 'string') continue;

    const record = {
      pluginId: meta.pluginId,
      displayName: meta.displayName || meta.pluginId,
      version: meta.version || '0.0.0',
      trustLevel: meta.trustLevel || 'restricted',
      skippedCapabilities: Array.isArray(meta.skippedCapabilities) ? meta.skippedCapabilities.slice() : [],
      status: 'pending',
      error: null,
    };
    addonStates.push(record);

    let initialSettings = addon.initialSettingsSnapshot || null;
    if (meta.hasSettingsBridge && meta.trustLevel === 'trusted') {
      bridge.bindSettingsPlugin(meta.pluginId, addon.settingsSpec || {});
      const persisted = bridge.loadPersistedSettings(meta.pluginId);
      if (persisted) {
        initialSettings = persisted;
      }
    }

    let stageRes;
    try {
      stageRes = activeKernel.stagePluginHandle(meta, hostToken, initialSettings);
    } catch (err) {
      record.status = 'failed';
      record.error = err && err.message ? err.message : String(err);
      bridge.port.reportError(meta.pluginId, record.error);
      continue;
    }

    if (!stageRes || stageRes.ok !== true || typeof stageRes.runNonce !== 'string') {
      record.status = 'failed';
      record.error = (stageRes && stageRes.reason) || 'ERR_STAGE_HANDLE_FAILED';
      bridge.port.reportError(meta.pluginId, record.error);
      continue;
    }

    const runNonce = stageRes.runNonce;
    let handle = null;
    try {
      handle = activeKernel.consumeStagedHandle(runNonce);
      if (typeof addon.run !== 'function') {
        throw new Error('ERR_PACKED_ADDON_RUN_FN_REQUIRED');
      }
      const ret = addon.run(handle);
      if (ret && typeof ret.then === 'function') {
        await ret;
      }
      record.status = 'active';
    } catch (err) {
      record.status = 'failed';
      record.error = err && err.message ? err.message : String(err);
      if (handle && typeof handle.dispose === 'function') {
        try {
          handle.dispose();
        } catch (_disposeErr) {
          // Disposal errors are recorded alongside the root failure below.
        }
      }
      activeKernel.clearStagedHandle(runNonce, hostToken);
      activeKernel.disposePlugin(meta.pluginId, hostToken);
      activeKernel.reportPluginError(meta.pluginId, record.error);
    }
  }

  if (mountDrawer !== false) {
    drawerUi = createHostDrawerUi({
      doc,
      win,
      profile,
      getState: () => ({
        addons: addonStates,
        settingsTabs: typeof activeKernel.listSettingsTabs === 'function' ? activeKernel.listSettingsTabs() : [],
        errors: bridge.getErrors(),
      }),
    });
  }

  let disposed = false;
  const controller = {
    docGenId,
    profileId: profile.id,
    origin: verifiedOrigin,
    trustedTypes: ttGuard,
    bridge,
    drawerUi,
    get disposed() {
      return disposed;
    },
    getAddonStates: () => addonStates.map((a) => ({ ...a })),
    getErrors: () => bridge.getErrors(),
    getBridgeStatus: () => ({
      ...activeKernel.getBridgeStatus(),
      ...bridge.getStatus(),
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (let i = 0; i < addonStates.length; i += 1) {
        activeKernel.disposePlugin(addonStates[i].pluginId, hostToken);
      }
      if (drawerUi) {
        drawerUi.dispose();
      }
      if (fallbackDockEl && fallbackDockEl.parentNode && typeof fallbackDockEl.parentNode.removeChild === 'function') {
        fallbackDockEl.parentNode.removeChild(fallbackDockEl);
      }
      bridge.dispose();
    },
  };

  Object.defineProperty(win, instanceKey, {
    value: controller,
    writable: false,
    configurable: true,
    enumerable: false,
  });

  return {
    ok: true,
    alreadyBooted: false,
    controller,
  };
}

module.exports = {
  FALLBACK_ANCHOR_KEYS,
  DRAWER_HOST_ID,
  SLOT_DOCK_ID,
  bootRemoteWebHost,
};
