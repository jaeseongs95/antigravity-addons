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
  isSafeExtraAttrName,
  createElementSafe,
  clearChildrenSafe,
  setTextSafe,
  createShadowContainer,
} = require('./dom-guard');
const { createRemoteHostBridge } = require('./remote-host-bridge');

const KERNEL_BOOT_STATE = new WeakMap();
const WINDOW_ADDON_REGISTRIES = new WeakMap();
const WINDOW_ACTIVE_CONTROLLERS = new WeakMap();

function resolveRegistryHost(win) {
  if (win && typeof win === 'object') return win;
  if (typeof globalThis !== 'undefined' && globalThis && typeof globalThis === 'object') {
    return globalThis;
  }
  return null;
}

function getOrCreateAddonRegistry(win) {
  const host = resolveRegistryHost(win);
  if (!host) return [];
  let list = WINDOW_ADDON_REGISTRIES.get(host);
  if (!list) {
    list = [];
    WINDOW_ADDON_REGISTRIES.set(host, list);
  }
  return list;
}

function validateAddonDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') {
    return { ok: false, reason: 'ERR_INVALID_ADDON_DESCRIPTOR' };
  }
  const meta = descriptor.pluginMeta;
  if (!meta || typeof meta !== 'object' || typeof meta.pluginId !== 'string' || !meta.pluginId.trim()) {
    return { ok: false, reason: 'ERR_INVALID_ADDON_META' };
  }
  if (typeof descriptor.run !== 'function') {
    return { ok: false, reason: 'ERR_PACKED_ADDON_RUN_FN_REQUIRED' };
  }
  return { ok: true, pluginId: meta.pluginId.trim() };
}

function registerAddon(descriptor, { win = null } = {}) {
  const check = validateAddonDescriptor(descriptor);
  if (!check.ok) {
    return { ok: false, queued: false, mounted: false, reason: check.reason };
  }
  const host = resolveRegistryHost(win || (typeof globalThis !== 'undefined' ? globalThis.window || globalThis : null));
  const list = getOrCreateAddonRegistry(host);
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] && list[i].pluginMeta && list[i].pluginMeta.pluginId === check.pluginId) {
      return { ok: false, queued: false, mounted: false, pluginId: check.pluginId, reason: 'ERR_DUPLICATE_ADDON_ID' };
    }
  }
  list.push(descriptor);

  const activeController = host ? WINDOW_ACTIVE_CONTROLLERS.get(host) : null;
  if (activeController && !activeController.disposed && typeof activeController.mountAddon === 'function') {
    const mountPromise = activeController.mountAddon(descriptor);
    return {
      ok: true,
      queued: false,
      mounted: true,
      pluginId: check.pluginId,
      promise: mountPromise,
    };
  }
  return { ok: true, queued: true, mounted: false, pluginId: check.pluginId };
}

function getRegisteredAddons(win = null) {
  const host = resolveRegistryHost(win || (typeof globalThis !== 'undefined' ? globalThis.window || globalThis : null));
  const list = getOrCreateAddonRegistry(host);
  return list.slice();
}

function createSwappableBridgePort(kernelState) {
  function activePort() {
    return kernelState.currentBridge ? kernelState.currentBridge.port : null;
  }
  return Object.freeze({
    get docGenId() {
      return kernelState.docGenId;
    },
    get profileId() {
      return kernelState.profileId;
    },
    setPortalClaim(claimId, active) {
      const p = activePort();
      return p ? p.setPortalClaim(claimId, active) : { ok: false, reason: 'ERR_REMOTE_HOST_DISPOSED' };
    },
    saveSettings(pluginId, rawJson) {
      const p = activePort();
      return p ? p.saveSettings(pluginId, rawJson) : Promise.resolve({ ok: false, reason: 'ERR_REMOTE_HOST_DISPOSED' });
    },
    reportError(pluginId, detail) {
      const p = activePort();
      return p ? p.reportError(pluginId, detail) : { ok: false, reason: 'ERR_REMOTE_HOST_DISPOSED' };
    },
    ping() {
      const p = activePort();
      return p ? p.ping() : Promise.resolve({ ok: false, reason: 'ERR_REMOTE_HOST_DISPOSED' });
    },
    readConfigScope(pluginId, scopeId) {
      const p = activePort();
      return p
        ? p.readConfigScope(pluginId, scopeId)
        : Promise.resolve({ ok: false, scopeId, status: 'error', reason: 'ERR_REMOTE_HOST_DISPOSED' });
    },
    writeConfigScope(pluginId, scopeId, rawJson, opts) {
      const p = activePort();
      return p
        ? p.writeConfigScope(pluginId, scopeId, rawJson, opts)
        : Promise.resolve({ ok: false, reason: 'ERR_REMOTE_HOST_DISPOSED' });
    },
  });
}

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
const ACTIVE_HOST_ATTR = 'data-remote-addon-host-active';
const MOUNTED_PLUGINS_ATTR = 'data-remote-addon-host-plugins';

function readMountedPlugins(docEl) {
  const out = new Set();
  if (!docEl || typeof docEl.getAttribute !== 'function') return out;
  const raw = docEl.getAttribute(MOUNTED_PLUGINS_ATTR);
  if (typeof raw !== 'string' || !raw.trim()) return out;
  const parts = raw.split(',');
  for (let i = 0; i < parts.length; i += 1) {
    const id = parts[i].trim();
    if (id) out.add(id);
  }
  return out;
}

function writeMountedPlugins(docEl, pluginSet) {
  if (!docEl) return;
  const list = Array.from(pluginSet).filter(Boolean).sort();
  if (list.length === 0) {
    if (typeof docEl.removeAttribute === 'function') {
      docEl.removeAttribute(MOUNTED_PLUGINS_ATTR);
    }
  } else if (typeof docEl.setAttribute === 'function') {
    docEl.setAttribute(MOUNTED_PLUGINS_ATTR, list.join(','));
  }
}

function claimMountedPlugin(docEl, pluginId) {
  if (!docEl || !pluginId) return;
  const set = readMountedPlugins(docEl);
  set.add(pluginId);
  writeMountedPlugins(docEl, set);
}

function releaseMountedPlugins(docEl, pluginIds) {
  if (!docEl || !pluginIds || pluginIds.size === 0) return;
  const set = readMountedPlugins(docEl);
  pluginIds.forEach((id) => set.delete(id));
  writeMountedPlugins(docEl, set);
}

const DRAWER_CSS = `
:host {
  all: initial;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: #e6edf3;
  font-size: 13px;
  line-height: 1.45;
  box-sizing: border-box;
}
*, *::before, *::after {
  box-sizing: border-box;
}
.rah-shell {
  position: fixed;
  right: max(12px, env(safe-area-inset-right, 0px));
  bottom: max(12px, env(safe-area-inset-bottom, 0px));
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
  min-height: 44px;
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
  touch-action: manipulation;
}
.rah-pill:hover {
  background: rgba(28, 34, 46, 0.98);
  border-color: rgba(130, 180, 255, 0.45);
}
.rah-pill:focus-visible,
.rah-btn:focus-visible,
.rah-tab:focus-visible,
.rah-card-btn:focus-visible {
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
  padding: 2px 8px;
  font-size: 11px;
}
.rah-badge.err {
  background: rgba(248, 81, 73, 0.2);
  color: #ffa198;
}
.rah-drawer {
  width: min(380px, calc(100vw - 24px));
  max-height: min(500px, calc(100dvh - 88px));
  background: rgba(15, 19, 26, 0.98);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 14px;
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
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}
.rah-title {
  font-size: 14px;
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
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 8px;
  min-height: 44px;
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  touch-action: manipulation;
}
.rah-btn:hover:not(:disabled) {
  background: rgba(121, 192, 255, 0.16);
  border-color: rgba(121, 192, 255, 0.45);
}
.rah-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.rah-tabs {
  display: flex;
  gap: 4px;
  padding: 4px 12px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  overflow-x: auto;
}
.rah-tab {
  appearance: none;
  background: transparent;
  color: #8b949e;
  border: none;
  border-bottom: 2px solid transparent;
  min-height: 44px;
  padding: 8px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  touch-action: manipulation;
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
  -webkit-overflow-scrolling: touch;
}
.rah-card {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  text-align: left;
  color: inherit;
}
.rah-card-btn {
  appearance: none;
  width: 100%;
  min-height: 44px;
  cursor: pointer;
  touch-action: manipulation;
}
.rah-card-btn:hover:not(:disabled) {
  background: rgba(121, 192, 255, 0.12);
  border-color: rgba(121, 192, 255, 0.45);
}
.rah-card-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.rah-card-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  width: 100%;
}
.rah-action-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}
.rah-action-btn {
  flex: 1 1 auto;
  min-width: 110px;
}
.rah-open-pill {
  font-size: 11px;
  color: #79c0ff;
  font-weight: 600;
}
.rah-status-ok { color: #3fb950; font-weight: 600; }
.rah-status-err { color: #f85149; font-weight: 600; }
.rah-empty {
  color: #8b949e;
  padding: 14px 4px;
  text-align: center;
}
.rah-pane,
.rah-primary-items,
.rah-peer-items,
.rah-peer-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rah-pane[hidden],
.rah-empty[hidden],
.rah-peer-items:empty,
.rah-peer-group:empty {
  display: none;
}
@media (max-width: 640px) {
  .rah-shell {
    left: max(12px, env(safe-area-inset-left, 0px));
    right: max(12px, env(safe-area-inset-right, 0px));
    bottom: max(12px, env(safe-area-inset-bottom, 0px));
    align-items: stretch;
  }
  .rah-drawer {
    width: 100%;
    max-width: none;
    max-height: 70dvh;
    border-radius: 16px 16px 12px 12px;
  }
  .rah-pill {
    align-self: flex-end;
  }
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
    if (isSafeExtraAttrName(attr)) {
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

function hasClassSafe(node, className) {
  if (!node || typeof node.getAttribute !== 'function') return false;
  const cls = String(node.getAttribute('class') || '');
  return cls.split(/\s+/).includes(className);
}

function findFirstInSubtree(root, predicate) {
  if (!root || !root.children) return null;
  const queue = Array.from(root.children);
  while (queue.length > 0) {
    const cur = queue.shift();
    if (!cur) continue;
    if (predicate(cur)) return cur;
    if (cur.children && cur.children.length > 0) {
      for (let i = 0; i < cur.children.length; i += 1) queue.push(cur.children[i]);
    }
  }
  return null;
}

function findAllInSubtree(root, predicate) {
  const out = [];
  if (!root || !root.children) return out;
  const queue = Array.from(root.children);
  while (queue.length > 0) {
    const cur = queue.shift();
    if (!cur) continue;
    if (predicate(cur)) out.push(cur);
    if (cur.children && cur.children.length > 0) {
      for (let i = 0; i < cur.children.length; i += 1) queue.push(cur.children[i]);
    }
  }
  return out;
}

function syncDrawerShellSummary(shadowRoot) {
  if (!shadowRoot) return;
  const shell = findFirstInSubtree(shadowRoot, (n) => hasClassSafe(n, 'rah-shell'));
  if (!shell) return;
  let activeCount = Number(shell.getAttribute('data-rah-primary-active') || 0) || 0;
  let totalCount = Number(shell.getAttribute('data-rah-primary-total') || 0) || 0;
  let errorCount = Number(shell.getAttribute('data-rah-primary-errors') || 0) || 0;

  const addonsPeerHost = findFirstInSubtree(
    shadowRoot,
    (n) => typeof n.getAttribute === 'function' && n.getAttribute('data-rah-peer-items') === 'addons'
  );
  if (addonsPeerHost && addonsPeerHost.children) {
    const peerGroups = addonsPeerHost.children;
    for (let i = 0; i < peerGroups.length; i += 1) {
      const g = peerGroups[i];
      if (!g || typeof g.getAttribute !== 'function' || !g.getAttribute('data-rah-peer-sandbox')) continue;
      activeCount += Number(g.getAttribute('data-rah-active') || 0) || 0;
      totalCount += Number(g.getAttribute('data-rah-total') || 0) || 0;
      errorCount += Number(g.getAttribute('data-rah-errors') || 0) || 0;
    }
  }

  const countBadge = findFirstInSubtree(
    shadowRoot,
    (n) => typeof n.getAttribute === 'function' && n.getAttribute('data-rah-count-badge') !== null
  );
  const errBadge = findFirstInSubtree(
    shadowRoot,
    (n) => typeof n.getAttribute === 'function' && n.getAttribute('data-rah-err-badge') !== null
  );
  const dotEl = findFirstInSubtree(
    shadowRoot,
    (n) => typeof n.getAttribute === 'function' && n.getAttribute('data-rah-dot') !== null
  );
  if (countBadge) setTextSafe(countBadge, `${activeCount}/${totalCount}`);
  if (dotEl && errBadge) {
    if (errorCount > 0) {
      dotEl.setAttribute('class', 'rah-dot has-error');
      errBadge.removeAttribute('hidden');
      setTextSafe(errBadge, `${errorCount} err`);
    } else {
      dotEl.setAttribute('class', 'rah-dot');
      errBadge.setAttribute('hidden', 'true');
    }
  }

  const panes = ['addons', 'settings', 'errors'];
  for (let i = 0; i < panes.length; i += 1) {
    const paneName = panes[i];
    const paneEl = findFirstInSubtree(
      shadowRoot,
      (n) => typeof n.getAttribute === 'function' && n.getAttribute('data-rah-pane') === paneName
    );
    if (!paneEl) continue;
    const emptyEl = findFirstInSubtree(paneEl, (n) => hasClassSafe(n, 'rah-empty'));
    if (!emptyEl) continue;
    const hasCards = Boolean(findFirstInSubtree(paneEl, (n) => hasClassSafe(n, 'rah-card')));
    if (hasCards) {
      emptyEl.setAttribute('hidden', 'true');
    } else {
      emptyEl.removeAttribute('hidden');
    }
  }
}

function renderAddonCardList(doc, container, addons, hostActions, onInvokeHostAction, onAfterAction) {
  clearChildrenSafe(container);
  const actionsByPlugin = new Map();
  for (let i = 0; i < hostActions.length; i += 1) {
    const act = hostActions[i];
    if (!act || !act.pluginId) continue;
    if (!actionsByPlugin.has(act.pluginId)) actionsByPlugin.set(act.pluginId, []);
    actionsByPlugin.get(act.pluginId).push(act);
  }
  for (let i = 0; i < addons.length; i += 1) {
    const item = addons[i];
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

    const pluginActs = actionsByPlugin.get(item.pluginId) || [];
    if (pluginActs.length > 0 && typeof onInvokeHostAction === 'function') {
      const actionList = createElementSafe(doc, 'div', { class: 'rah-action-list' });
      for (let j = 0; j < pluginActs.length; j += 1) {
        const act = pluginActs[j];
        const actBtn = createElementSafe(
          doc,
          'button',
          {
            type: 'button',
            class: 'rah-btn rah-action-btn',
            'data-host-action-plugin': act.pluginId,
            'data-host-action-id': act.actionId,
          },
          act.label || act.actionId
        );
        if (act.runnable === false) {
          actBtn.disabled = true;
        } else {
          actBtn.addEventListener('click', (ev) => {
            if (ev && ev.isTrusted === false) return;
            onInvokeHostAction(act.pluginId, act.actionId);
            if (typeof onAfterAction === 'function') onAfterAction();
          });
        }
        actionList.appendChild(actBtn);
      }
      card.appendChild(actionList);
    }
    container.appendChild(card);
  }
}

function renderSettingsTabCardList(doc, container, settingsTabs, onSelectSettingsTab, onSelectedOk, onSelectedFail) {
  clearChildrenSafe(container);
  for (let i = 0; i < settingsTabs.length; i += 1) {
    const tab = settingsTabs[i];
    const canSelect = Boolean(tab.selectable !== false && typeof onSelectSettingsTab === 'function');
    const card = createElementSafe(doc, 'button', {
      type: 'button',
      class: 'rah-card rah-card-btn',
      'data-settings-tab-id': tab.tabId || '',
      'data-settings-tab-plugin': tab.pluginId || '',
      'data-settings-tab-action': 'select',
    });
    if (!canSelect) {
      card.disabled = true;
    }
    const row = createElementSafe(doc, 'div', { class: 'rah-card-row' });
    row.appendChild(createElementSafe(doc, 'strong', { class: 'rah-tab-label' }, tab.label || tab.tabId));
    row.appendChild(
      createElementSafe(doc, 'span', { class: canSelect ? 'rah-open-pill' : 'rah-meta' }, canSelect ? 'Open' : tab.pluginId)
    );
    card.appendChild(row);
    card.appendChild(createElementSafe(doc, 'div', { class: 'rah-meta' }, `${tab.pluginId} · ${tab.tabId}`));
    if (canSelect) {
      card.addEventListener('click', (ev) => {
        if (ev && ev.isTrusted === false) return;
        const res = onSelectSettingsTab(tab.pluginId, tab.tabId);
        if (!res || res.ok !== false) {
          if (typeof onSelectedOk === 'function') onSelectedOk();
        } else if (typeof onSelectedFail === 'function') {
          onSelectedFail();
        }
      });
    }
    container.appendChild(card);
  }
}

function renderErrorCardList(doc, container, errors) {
  clearChildrenSafe(container);
  for (let i = errors.length - 1; i >= 0; i -= 1) {
    const err = errors[i];
    const card = createElementSafe(doc, 'div', { class: 'rah-card' });
    card.appendChild(createElementSafe(doc, 'strong', null, err.pluginId));
    card.appendChild(createElementSafe(doc, 'div', { class: 'rah-meta' }, err.detail));
    container.appendChild(card);
  }
}

function createHostDrawerUi({ doc, win, profile, getState, onSelectSettingsTab = null, onInvokeHostAction = null }) {
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

  const shell = createElementSafe(doc, 'div', {
    class: 'rah-shell',
    'data-rah-primary-active': '0',
    'data-rah-primary-total': '0',
    'data-rah-primary-errors': '0',
  });

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

  const paneDefs = [
    {
      id: 'addons',
      label: 'Addons',
      emptyText: 'No addons packed in this remote bundle. Install modular addon Userscripts or run addon-host --build-remote.',
    },
    { id: 'settings', label: 'Settings Tabs', emptyText: 'No plugin settings tabs registered.' },
    { id: 'errors', label: 'Diagnostics', emptyText: 'No runtime errors recorded.' },
  ];

  let activeTab = 'addons';
  let isOpen = false;

  const tabButtons = new Map();
  const paneRefs = new Map();

  for (let i = 0; i < paneDefs.length; i += 1) {
    const def = paneDefs[i];
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
    btn.addEventListener('click', (ev) => {
      if (ev && ev.isTrusted === false) return;
      activeTab = def.id;
      render();
    });
    tabButtons.set(def.id, btn);
    tabsRow.appendChild(btn);

    const paneAttrs = { class: 'rah-pane', 'data-rah-pane': def.id };
    if (def.id !== activeTab) paneAttrs.hidden = 'true';
    const paneEl = createElementSafe(doc, 'div', paneAttrs);
    const primaryItems = createElementSafe(doc, 'div', { class: 'rah-primary-items', 'data-rah-primary-items': def.id });
    const peerItems = createElementSafe(doc, 'div', { class: 'rah-peer-items', 'data-rah-peer-items': def.id });
    const emptyEl = createElementSafe(doc, 'div', { class: 'rah-empty' }, def.emptyText);
    paneEl.appendChild(primaryItems);
    paneEl.appendChild(peerItems);
    paneEl.appendChild(emptyEl);
    bodyEl.appendChild(paneEl);
    paneRefs.set(def.id, { paneEl, primaryItems, peerItems, emptyEl });
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
  const dotEl = createElementSafe(doc, 'span', { class: 'rah-dot', 'data-rah-dot': '1', 'aria-hidden': 'true' });
  const labelEl = createElementSafe(doc, 'span', null, 'Addons');
  const countBadge = createElementSafe(doc, 'span', { class: 'rah-badge', 'data-rah-count-badge': '1' }, '0/0');
  const errBadge = createElementSafe(doc, 'span', { class: 'rah-badge err', 'data-rah-err-badge': '1', hidden: 'true' }, '0 err');
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

  pillBtn.addEventListener('click', (ev) => {
    if (ev && ev.isTrusted === false) return;
    setOpen(!isOpen);
  });
  closeBtn.addEventListener('click', (ev) => {
    if (ev && ev.isTrusted === false) return;
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
    const failedCount = state.addons.filter((a) => a.status === 'failed').length;
    const errorCount = Math.max(state.errors.length, failedCount);

    shell.setAttribute('data-rah-primary-active', String(activeCount));
    shell.setAttribute('data-rah-primary-total', String(state.addons.length));
    shell.setAttribute('data-rah-primary-errors', String(errorCount));

    for (const [id, btn] of tabButtons.entries()) {
      btn.setAttribute('aria-selected', id === activeTab ? 'true' : 'false');
      const ref = paneRefs.get(id);
      if (ref) {
        if (id === activeTab) {
          ref.paneEl.removeAttribute('hidden');
        } else {
          ref.paneEl.setAttribute('hidden', 'true');
        }
      }
    }

    const addonsPane = paneRefs.get('addons');
    const settingsPane = paneRefs.get('settings');
    const errorsPane = paneRefs.get('errors');

    renderAddonCardList(
      doc,
      addonsPane.primaryItems,
      state.addons,
      Array.isArray(state.hostActions) ? state.hostActions : [],
      onInvokeHostAction,
      render
    );
    renderSettingsTabCardList(
      doc,
      settingsPane.primaryItems,
      Array.isArray(state.settingsTabs) ? state.settingsTabs : [],
      onSelectSettingsTab,
      () => setOpen(false),
      render
    );
    renderErrorCardList(doc, errorsPane.primaryItems, Array.isArray(state.errors) ? state.errors : []);
    syncDrawerShellSummary(shadowRoot);
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

function attachPeerDrawerContributor({
  doc,
  shadowRoot,
  sandboxId,
  getState,
  onSelectSettingsTab = null,
  onInvokeHostAction = null,
}) {
  if (!shadowRoot) return null;
  const addonsPeerHost = findFirstInSubtree(
    shadowRoot,
    (n) => typeof n.getAttribute === 'function' && n.getAttribute('data-rah-peer-items') === 'addons'
  );
  const settingsPeerHost = findFirstInSubtree(
    shadowRoot,
    (n) => typeof n.getAttribute === 'function' && n.getAttribute('data-rah-peer-items') === 'settings'
  );
  const errorsPeerHost = findFirstInSubtree(
    shadowRoot,
    (n) => typeof n.getAttribute === 'function' && n.getAttribute('data-rah-peer-items') === 'errors'
  );
  if (!addonsPeerHost || !settingsPeerHost || !errorsPeerHost) return null;

  const addonsGroup = createElementSafe(doc, 'div', {
    class: 'rah-peer-group',
    'data-rah-peer-sandbox': sandboxId,
    'data-rah-active': '0',
    'data-rah-total': '0',
    'data-rah-errors': '0',
  });
  const settingsGroup = createElementSafe(doc, 'div', {
    class: 'rah-peer-group',
    'data-rah-peer-sandbox': sandboxId,
  });
  const errorsGroup = createElementSafe(doc, 'div', {
    class: 'rah-peer-group',
    'data-rah-peer-sandbox': sandboxId,
  });

  addonsPeerHost.appendChild(addonsGroup);
  settingsPeerHost.appendChild(settingsGroup);
  errorsPeerHost.appendChild(errorsGroup);

  function closeSharedDrawer() {
    const panel = findFirstInSubtree(
      shadowRoot,
      (n) => typeof n.getAttribute === 'function' && n.getAttribute('id') === 'rah-drawer-panel'
    );
    const pill = findFirstInSubtree(shadowRoot, (n) => hasClassSafe(n, 'rah-pill'));
    if (panel) panel.setAttribute('hidden', 'true');
    if (pill) pill.setAttribute('aria-expanded', 'false');
  }

  function render() {
    const state = getState();
    const activeCount = state.addons.filter((a) => a.status === 'active').length;
    const failedCount = state.addons.filter((a) => a.status === 'failed').length;
    const errorCount = Math.max(state.errors.length, failedCount);
    addonsGroup.setAttribute('data-rah-active', String(activeCount));
    addonsGroup.setAttribute('data-rah-total', String(state.addons.length));
    addonsGroup.setAttribute('data-rah-errors', String(errorCount));

    renderAddonCardList(
      doc,
      addonsGroup,
      state.addons,
      Array.isArray(state.hostActions) ? state.hostActions : [],
      onInvokeHostAction,
      render
    );
    renderSettingsTabCardList(
      doc,
      settingsGroup,
      Array.isArray(state.settingsTabs) ? state.settingsTabs : [],
      onSelectSettingsTab,
      closeSharedDrawer,
      render
    );
    renderErrorCardList(doc, errorsGroup, Array.isArray(state.errors) ? state.errors : []);
    syncDrawerShellSummary(shadowRoot);
  }

  render();

  return Object.freeze({
    hostEl: shadowRoot.host || null,
    shadowRoot,
    setOpen(nextOpen) {
      const panel = shadowRoot.querySelector('#rah-drawer-panel');
      const pill = shadowRoot.querySelector('.rah-pill');
      if (panel) {
        if (nextOpen) panel.removeAttribute('hidden');
        else panel.setAttribute('hidden', 'true');
      }
      if (pill) pill.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
    },
    render,
    dispose() {
      const groups = [addonsGroup, settingsGroup, errorsGroup];
      for (let i = 0; i < groups.length; i += 1) {
        const g = groups[i];
        if (g && g.parentNode && typeof g.parentNode.removeChild === 'function') {
          g.parentNode.removeChild(g);
        }
      }
      syncDrawerShellSummary(shadowRoot);
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

  const queuedRegistered = getRegisteredAddons(win);
  const candidateAddons = [];
  if (Array.isArray(packedAddons)) {
    for (let i = 0; i < packedAddons.length; i += 1) candidateAddons.push(packedAddons[i]);
  }
  for (let i = 0; i < queuedRegistered.length; i += 1) {
    candidateAddons.push(queuedRegistered[i]);
  }

  const docEl = doc.documentElement || null;
  const hasActiveAttr = Boolean(
    docEl && typeof docEl.getAttribute === 'function' && docEl.getAttribute(ACTIVE_HOST_ATTR) === profile.id
  );
  const existingDrawer =
    mountDrawer !== false && typeof doc.getElementById === 'function' ? doc.getElementById(DRAWER_HOST_ID) : null;
  const hasExistingDrawer = Boolean(existingDrawer && existingDrawer.isConnected !== false);
  const isPeerCoexist = hasActiveAttr || hasExistingDrawer;

  let initialAddons = candidateAddons;
  if (isPeerCoexist) {
    const alreadyMounted = readMountedPlugins(docEl);
    const seenNew = new Set();
    initialAddons = [];
    for (let i = 0; i < candidateAddons.length; i += 1) {
      const cand = candidateAddons[i];
      const pid = cand && cand.pluginMeta && typeof cand.pluginMeta.pluginId === 'string' ? cand.pluginMeta.pluginId.trim() : '';
      if (!pid || alreadyMounted.has(pid) || seenNew.has(pid)) continue;
      seenNew.add(pid);
      initialAddons.push(cand);
    }
    if (initialAddons.length === 0) {
      return { ok: true, alreadyBooted: true, crossWorld: true, controller: null };
    }
  }

  const ttGuard = createScopedTrustedTypesGuard(win, {
    policyName: profile.trustedTypesPolicyName || 'remote-web-addon-host',
    allowedOrigin: verifiedOrigin,
    allowLoopbackHttp,
  });

  const existingKernelState = KERNEL_BOOT_STATE.get(activeKernel);
  const hostToken = existingKernelState ? existingKernelState.hostToken : generateHostToken(win);
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

  const kernelState = existingKernelState || {
    hostToken,
    currentBridge: null,
    docGenId,
    profileId: profile.id,
  };
  const prevBridge = kernelState.currentBridge;
  const prevDocGenId = kernelState.docGenId;
  const prevProfileId = kernelState.profileId;
  kernelState.currentBridge = bridge;
  kernelState.docGenId = docGenId;
  kernelState.profileId = profile.id;

  const safeExtraNoTranslateAttributes = Array.isArray(profile.extraNoTranslateAttributes)
    ? profile.extraNoTranslateAttributes
        .map((attr) => (typeof attr === 'string' ? attr.trim() : ''))
        .filter((attr) => isSafeExtraAttrName(attr))
    : [];

  const bootRes = activeKernel.boot({
    docGenId,
    hostToken,
    hostProfileId: profile.id,
    hostBridge: existingKernelState ? undefined : createSwappableBridgePort(kernelState),
    uiAnchors: profile.uiAnchors || {},
    uiSurfaces: profile.uiSurfaces || {},
    uiGridMerges: Array.isArray(profile.uiGridMerges) ? profile.uiGridMerges : [],
    extraNoTranslateAttributes: safeExtraNoTranslateAttributes,
  });
  if (!bootRes || bootRes.ok !== true) {
    kernelState.currentBridge = prevBridge;
    kernelState.docGenId = prevDocGenId;
    kernelState.profileId = prevProfileId;
    bridge.dispose();
    return { ok: false, reason: (bootRes && bootRes.reason) || 'ERR_KERNEL_BOOT_FAILED' };
  }
  if (!existingKernelState) {
    KERNEL_BOOT_STATE.set(activeKernel, kernelState);
  }
  if (!isPeerCoexist && docEl && typeof docEl.setAttribute === 'function') {
    docEl.setAttribute(ACTIVE_HOST_ATTR, profile.id);
  }

  let fallbackDockEl = null;
  let ownsFallbackDock = false;
  if (mountFallbackDock !== false) {
    const preExistingDock = typeof doc.getElementById === 'function' ? doc.getElementById(SLOT_DOCK_ID) : null;
    fallbackDockEl = mountFallbackSlotDock(doc, safeExtraNoTranslateAttributes);
    ownsFallbackDock = !isPeerCoexist && !preExistingDock && Boolean(fallbackDockEl);
  }

  const drawerCallbacks = {
    getState: () => ({
      addons: addonStates,
      settingsTabs: typeof activeKernel.listSettingsTabs === 'function' ? activeKernel.listSettingsTabs() : [],
      hostActions: typeof activeKernel.listHostActions === 'function' ? activeKernel.listHostActions(hostToken) : [],
      errors: bridge.getErrors(),
    }),
    onSelectSettingsTab(pluginId, tabId) {
      if (typeof activeKernel.selectSettingsTab !== 'function') {
        return { ok: false, reason: 'ERR_SELECT_SETTINGS_TAB_UNAVAILABLE' };
      }
      return activeKernel.selectSettingsTab(pluginId, tabId, hostToken);
    },
    onInvokeHostAction(pluginId, actionId) {
      if (typeof activeKernel.invokeHostAction !== 'function') {
        return { ok: false, reason: 'ERR_INVOKE_HOST_ACTION_UNAVAILABLE' };
      }
      return activeKernel.invokeHostAction(pluginId, actionId, [], hostToken);
    },
  };

  if (mountDrawer !== false) {
    if (isPeerCoexist) {
      if (existingDrawer && existingDrawer.shadowRoot) {
        drawerUi = attachPeerDrawerContributor({
          doc,
          shadowRoot: existingDrawer.shadowRoot,
          sandboxId: generateHostToken(win),
          ...drawerCallbacks,
        });
      }
    } else {
      drawerUi = createHostDrawerUi({
        doc,
        win,
        profile,
        ...drawerCallbacks,
      });
    }
  }

  const mountedPluginIds = new Set();

  async function mountAddon(addon) {
    const meta = addon && addon.pluginMeta;
    if (!meta || typeof meta.pluginId !== 'string' || !meta.pluginId.trim()) {
      return { ok: false, status: 'rejected', pluginId: null, error: 'ERR_INVALID_ADDON_META' };
    }
    const pluginId = meta.pluginId.trim();
    if (mountedPluginIds.has(pluginId) || readMountedPlugins(docEl).has(pluginId)) {
      return { ok: false, status: 'duplicate', pluginId, error: 'ERR_DUPLICATE_ADDON_ID' };
    }
    mountedPluginIds.add(pluginId);
    claimMountedPlugin(docEl, pluginId);

    const record = {
      pluginId,
      displayName: meta.displayName || pluginId,
      version: meta.version || '0.0.0',
      trustLevel: meta.trustLevel || 'restricted',
      skippedCapabilities: Array.isArray(meta.skippedCapabilities) ? meta.skippedCapabilities.slice() : [],
      status: 'pending',
      error: null,
    };
    addonStates.push(record);

    let initialSettings = addon.initialSettingsSnapshot || null;
    if (meta.hasSettingsBridge && meta.trustLevel === 'trusted') {
      bridge.bindSettingsPlugin(pluginId, addon.settingsSpec || {});
      const persisted =
        typeof bridge.hydrateSettings === 'function'
          ? await bridge.hydrateSettings(pluginId)
          : bridge.loadPersistedSettings(pluginId);
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
      bridge.port.reportError(pluginId, record.error);
      if (drawerUi) drawerUi.render();
      return { ok: false, status: 'failed', pluginId, error: record.error };
    }

    if (!stageRes || stageRes.ok !== true || typeof stageRes.runNonce !== 'string') {
      record.status = 'failed';
      record.error = (stageRes && stageRes.reason) || 'ERR_STAGE_HANDLE_FAILED';
      bridge.port.reportError(pluginId, record.error);
      if (drawerUi) drawerUi.render();
      return { ok: false, status: 'failed', pluginId, error: record.error };
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
      activeKernel.disposePlugin(pluginId, hostToken);
      if (typeof activeKernel.reportPluginError === 'function') {
        activeKernel.reportPluginError(pluginId, record.error);
      } else {
        bridge.port.reportError(pluginId, record.error);
      }
    }
    if (drawerUi) drawerUi.render();
    return {
      ok: record.status === 'active',
      status: record.status,
      pluginId,
      error: record.error,
    };
  }

  for (let i = 0; i < initialAddons.length; i += 1) {
    await mountAddon(initialAddons[i]);
  }

  let disposed = false;
  const controller = {
    docGenId,
    profileId: profile.id,
    origin: verifiedOrigin,
    peerCoexist: isPeerCoexist,
    trustedTypes: ttGuard,
    bridge,
    drawerUi,
    mountAddon,
    selectSettingsTab(pluginId, tabId) {
      if (disposed || typeof activeKernel.selectSettingsTab !== 'function') {
        return { ok: false, reason: 'ERR_REMOTE_HOST_DISPOSED' };
      }
      return activeKernel.selectSettingsTab(pluginId, tabId, hostToken);
    },
    listHostActions() {
      if (disposed || typeof activeKernel.listHostActions !== 'function') return [];
      return activeKernel.listHostActions(hostToken);
    },
    invokeHostAction(pluginId, actionId, args = []) {
      if (disposed || typeof activeKernel.invokeHostAction !== 'function') {
        return { ok: false, reason: 'ERR_REMOTE_HOST_DISPOSED' };
      }
      return activeKernel.invokeHostAction(pluginId, actionId, args, hostToken);
    },
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
      const host = resolveRegistryHost(win);
      if (host && WINDOW_ACTIVE_CONTROLLERS.get(host) === controller) {
        WINDOW_ACTIVE_CONTROLLERS.delete(host);
      }
      for (let i = 0; i < addonStates.length; i += 1) {
        activeKernel.disposePlugin(addonStates[i].pluginId, hostToken);
      }
      releaseMountedPlugins(docEl, mountedPluginIds);
      if (drawerUi) {
        drawerUi.dispose();
      }
      if (ownsFallbackDock && fallbackDockEl && fallbackDockEl.parentNode && typeof fallbackDockEl.parentNode.removeChild === 'function') {
        fallbackDockEl.parentNode.removeChild(fallbackDockEl);
      }
      if (
        !isPeerCoexist &&
        docEl &&
        typeof docEl.getAttribute === 'function' &&
        typeof docEl.removeAttribute === 'function' &&
        docEl.getAttribute(ACTIVE_HOST_ATTR) === profile.id
      ) {
        docEl.removeAttribute(ACTIVE_HOST_ATTR);
      }
      if (kernelState.currentBridge === bridge) {
        kernelState.currentBridge = null;
      }
      bridge.dispose();
    },
  };

  const registryHost = resolveRegistryHost(win);
  if (registryHost) {
    WINDOW_ACTIVE_CONTROLLERS.set(registryHost, controller);
  }

  Object.defineProperty(win, instanceKey, {
    value: controller,
    writable: false,
    configurable: true,
    enumerable: false,
  });

  return {
    ok: true,
    alreadyBooted: false,
    peerCoexist: isPeerCoexist,
    controller,
  };
}

module.exports = {
  FALLBACK_ANCHOR_KEYS,
  DRAWER_HOST_ID,
  SLOT_DOCK_ID,
  ACTIVE_HOST_ATTR,
  MOUNTED_PLUGINS_ATTR,
  registerAddon,
  getRegisteredAddons,
  bootRemoteWebHost,
};
