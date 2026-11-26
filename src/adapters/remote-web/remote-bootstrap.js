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
const { createRemoteHostTransport } = require('./remote-host-transport');

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
    netFetch(pluginId, url, init) {
      const p = activePort();
      return p && typeof p.netFetch === 'function'
        ? p.netFetch(pluginId, url, init)
        : Promise.resolve({ ok: false, reason: 'ERR_REMOTE_HOST_DISPOSED' });
    },
    secretsSet(pluginId, key, value) {
      const p = activePort();
      return p && typeof p.secretsSet === 'function'
        ? p.secretsSet(pluginId, key, value)
        : Promise.resolve({ ok: false, reason: 'ERR_REMOTE_HOST_DISPOSED' });
    },
    secretsGet(pluginId, key) {
      const p = activePort();
      return p && typeof p.secretsGet === 'function'
        ? p.secretsGet(pluginId, key)
        : Promise.resolve({ ok: false, exists: false, value: undefined, reason: 'ERR_REMOTE_HOST_DISPOSED' });
    },
    secretsHas(pluginId, key) {
      const p = activePort();
      return p && typeof p.secretsHas === 'function'
        ? p.secretsHas(pluginId, key)
        : Promise.resolve({ ok: false, exists: false, reason: 'ERR_REMOTE_HOST_DISPOSED' });
    },
    secretsDelete(pluginId, key) {
      const p = activePort();
      return p && typeof p.secretsDelete === 'function'
        ? p.secretsDelete(pluginId, key)
        : Promise.resolve({ ok: false, deleted: false, reason: 'ERR_REMOTE_HOST_DISPOSED' });
    },
    secretsList(pluginId) {
      const p = activePort();
      return p && typeof p.secretsList === 'function'
        ? p.secretsList(pluginId)
        : Promise.resolve({ ok: false, keys: [], reason: 'ERR_REMOTE_HOST_DISPOSED' });
    },
    getRemoteBridgeStatus() {
      const p = activePort();
      return p && typeof p.getRemoteBridgeStatus === 'function'
        ? p.getRemoteBridgeStatus()
        : { configured: false, connected: false, baseUrl: null, hostVersion: null, buildSha8: null, activePlugins: [], lastCheckedAt: null, lastError: null };
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
.rah-header-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.rah-lang-switch {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.04);
}
.rah-lang-btn {
  appearance: none;
  border: none;
  background: transparent;
  color: #8b949e;
  border-radius: 6px;
  min-height: 28px;
  padding: 4px 8px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  touch-action: manipulation;
}
.rah-lang-btn[aria-pressed="true"] {
  background: #2563eb;
  color: #ffffff;
}
.rah-lang-btn:focus-visible {
  outline: 2px solid #79c0ff;
  outline-offset: 1px;
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
.rah-net-box {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rah-net-title {
  font-size: 11px;
  font-weight: 600;
  color: #9fb3c8;
}
.rah-net-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.rah-net-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 11px;
  background: rgba(121, 192, 255, 0.14);
  border: 1px solid rgba(121, 192, 255, 0.3);
  color: #e6edf3;
}
.rah-net-chip-del {
  appearance: none;
  border: none;
  background: transparent;
  color: #f85149;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  padding: 0 2px;
  line-height: 1;
}
.rah-net-form {
  display: flex;
  gap: 6px;
  align-items: center;
}
.rah-net-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 30px;
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(13, 17, 23, 0.8);
  color: #e6edf3;
  font-size: 11.5px;
}
.rah-net-err {
  font-size: 11px;
  color: #f85149;
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

function renderAddonCardList(doc, container, addons, hostActions, onInvokeHostAction, onAfterAction, netConsent = null) {
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

    if (
      item.userApprovedHttps === true &&
      netConsent &&
      typeof netConsent.listHosts === 'function' &&
      typeof netConsent.addHost === 'function' &&
      typeof netConsent.removeHost === 'function'
    ) {
      const netBox = createElementSafe(doc, 'div', {
        class: 'rah-net-box',
        'data-rah-net-consent-plugin': item.pluginId,
      });
      netBox.appendChild(createElementSafe(doc, 'div', { class: 'rah-net-title' }, 'Allowed HTTPS Hosts (User Consent)'));
      const approvedHosts = netConsent.listHosts(item.pluginId);
      if (approvedHosts.length > 0) {
        const chips = createElementSafe(doc, 'div', { class: 'rah-net-chips' });
        for (let hIdx = 0; hIdx < approvedHosts.length; hIdx += 1) {
          const hostName = approvedHosts[hIdx];
          const chip = createElementSafe(doc, 'span', { class: 'rah-net-chip', 'data-rah-net-host': hostName });
          chip.appendChild(createElementSafe(doc, 'span', null, hostName));
          const delBtn = createElementSafe(
            doc,
            'button',
            {
              type: 'button',
              class: 'rah-net-chip-del',
              'aria-label': `Revoke ${hostName}`,
              'data-rah-net-remove-host': hostName,
            },
            '×'
          );
          delBtn.addEventListener('click', (ev) => {
            if (ev && ev.isTrusted === false) return;
            netConsent.removeHost(item.pluginId, hostName);
            if (typeof onAfterAction === 'function') onAfterAction();
          });
          chip.appendChild(delBtn);
          chips.appendChild(chip);
        }
        netBox.appendChild(chips);
      } else {
        netBox.appendChild(
          createElementSafe(doc, 'div', { class: 'rah-meta' }, 'No user-approved HTTPS hosts yet (default-deny).')
        );
      }

      const formRow = createElementSafe(doc, 'div', { class: 'rah-net-form' });
      const hostInput = createElementSafe(doc, 'input', {
        type: 'url',
        class: 'rah-net-input',
        placeholder: 'https://sidecar.example.com',
        'aria-label': `HTTPS host for ${item.displayName}`,
        'data-rah-net-input': item.pluginId,
      });
      const addBtn = createElementSafe(
        doc,
        'button',
        {
          type: 'button',
          class: 'rah-btn',
          'data-rah-net-add': item.pluginId,
        },
        'Approve'
      );
      const errLine = createElementSafe(doc, 'div', { class: 'rah-net-err', hidden: 'true' });
      addBtn.addEventListener('click', (ev) => {
        if (ev && ev.isTrusted === false) return;
        const val = typeof hostInput.value === 'string' ? hostInput.value.trim() : '';
        const res = netConsent.addHost(item.pluginId, val);
        if (res && res.ok) {
          hostInput.value = '';
          errLine.setAttribute('hidden', 'true');
          setTextSafe(errLine, '');
          if (typeof onAfterAction === 'function') onAfterAction();
        } else {
          errLine.removeAttribute('hidden');
          setTextSafe(errLine, (res && res.reason) || 'ERR_NET_HOST_FORBIDDEN');
        }
      });
      formRow.appendChild(hostInput);
      formRow.appendChild(addBtn);
      netBox.appendChild(formRow);
      netBox.appendChild(errLine);
      card.appendChild(netBox);
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

function renderHostBridgePane(doc, container, bridgeStatus, controls, onUpdated) {
  clearChildrenSafe(container);
  const st = bridgeStatus && typeof bridgeStatus === 'object' ? bridgeStatus : { configured: false, connected: false };
  const card = createElementSafe(doc, 'div', { class: 'rah-card', 'data-rah-bridge-card': '1' });

  const head = createElementSafe(doc, 'div', { class: 'rah-card-row' });
  head.appendChild(createElementSafe(doc, 'strong', null, 'Native Host Bridge'));
  head.appendChild(
    createElementSafe(
      doc,
      'span',
      {
        class: st.connected ? 'rah-status-ok' : 'rah-meta',
        'data-rah-bridge-status': st.connected ? 'connected' : 'disconnected',
      },
      st.connected ? 'Connected' : 'Disconnected'
    )
  );
  card.appendChild(head);

  if (st.connected && st.baseUrl) {
    const infoText = `${st.baseUrl}${st.hostVersion ? ` · host v${st.hostVersion}` : ''}${st.buildSha8 ? ` (${st.buildSha8})` : ''}`;
    card.appendChild(createElementSafe(doc, 'div', { class: 'rah-meta', 'data-rah-bridge-url': st.baseUrl }, infoText));
  } else {
    card.appendChild(
      createElementSafe(
        doc,
        'div',
        { class: 'rah-meta' },
        'Paste the Pairing Code from Desktop Settings -> Addon Manager -> Remote Host Bridge. All plugins automatically share this single authenticated connection.'
      )
    );
  }

  const errEl = createElementSafe(doc, 'div', {
    class: 'rah-net-err',
    'data-rah-bridge-error': '1',
    ...(st.lastError ? {} : { hidden: 'true' }),
  }, st.lastError || '');

  if (controls && typeof controls.connect === 'function') {
    const pairLabel = createElementSafe(doc, 'div', { class: 'rah-net-title' }, 'Pairing Code (Recommended)');
    card.appendChild(pairLabel);

    const pairRow = createElementSafe(doc, 'div', { class: 'rah-net-form' });
    const pairInput = createElementSafe(doc, 'input', {
      type: 'password',
      class: 'rah-net-input',
      placeholder: 'ag-bridge-v1:...',
      'aria-label': 'Native Host Pairing Code',
      'data-rah-bridge-pairing-input': '1',
    });
    const connectBtn = createElementSafe(
      doc,
      'button',
      {
        type: 'button',
        class: 'rah-btn',
        'data-rah-bridge-connect': '1',
      },
      'Connect'
    );
    connectBtn.addEventListener('click', (ev) => {
      if (ev && ev.isTrusted === false) return;
      const code = typeof pairInput.value === 'string' ? pairInput.value.trim() : '';
      if (!code) {
        errEl.removeAttribute('hidden');
        setTextSafe(errEl, 'ERR_INVALID_PAIRING_CODE');
        return;
      }
      connectBtn.disabled = true;
      Promise.resolve(controls.connect(code))
        .then((res) => {
          connectBtn.disabled = false;
          if (res && res.ok) {
            pairInput.value = '';
            errEl.setAttribute('hidden', 'true');
            setTextSafe(errEl, '');
          } else {
            errEl.removeAttribute('hidden');
            setTextSafe(errEl, (res && res.reason) || 'ERR_REMOTE_BRIDGE_UNREACHABLE');
          }
          if (typeof onUpdated === 'function') onUpdated();
        })
        .catch((err) => {
          connectBtn.disabled = false;
          errEl.removeAttribute('hidden');
          setTextSafe(errEl, err && err.message ? err.message : 'ERR_REMOTE_BRIDGE_UNREACHABLE');
        });
    });
    pairRow.appendChild(pairInput);
    pairRow.appendChild(connectBtn);
    card.appendChild(pairRow);

    const manualBox = createElementSafe(doc, 'details', { class: 'rah-net-box' });
    manualBox.appendChild(createElementSafe(doc, 'summary', { class: 'rah-net-title' }, 'Manual URL & Token'));
    const urlInput = createElementSafe(doc, 'input', {
      type: 'url',
      class: 'rah-net-input',
      placeholder: 'http://127.0.0.1:19384 or https://...',
      'aria-label': 'Native Host Bridge URL',
      'data-rah-bridge-url-input': '1',
      value: st.baseUrl || '',
    });
    const tokInput = createElementSafe(doc, 'input', {
      type: 'password',
      class: 'rah-net-input',
      placeholder: 'Bearer token (64 hex chars)',
      'aria-label': 'Native Host Bridge Token',
      'data-rah-bridge-token-input': '1',
    });
    const manualBtn = createElementSafe(
      doc,
      'button',
      {
        type: 'button',
        class: 'rah-btn',
        'data-rah-bridge-manual-connect': '1',
      },
      'Connect Manually'
    );
    manualBtn.addEventListener('click', (ev) => {
      if (ev && ev.isTrusted === false) return;
      const u = typeof urlInput.value === 'string' ? urlInput.value.trim() : '';
      const tk = typeof tokInput.value === 'string' ? tokInput.value.trim() : '';
      manualBtn.disabled = true;
      Promise.resolve(controls.connect({ baseUrl: u, token: tk }))
        .then((res) => {
          manualBtn.disabled = false;
          if (res && res.ok) {
            tokInput.value = '';
            errEl.setAttribute('hidden', 'true');
            setTextSafe(errEl, '');
          } else {
            errEl.removeAttribute('hidden');
            setTextSafe(errEl, (res && res.reason) || 'ERR_REMOTE_BRIDGE_UNREACHABLE');
          }
          if (typeof onUpdated === 'function') onUpdated();
        })
        .catch((err) => {
          manualBtn.disabled = false;
          errEl.removeAttribute('hidden');
          setTextSafe(errEl, err && err.message ? err.message : 'ERR_REMOTE_BRIDGE_UNREACHABLE');
        });
    });
    manualBox.appendChild(urlInput);
    manualBox.appendChild(tokInput);
    manualBox.appendChild(manualBtn);
    card.appendChild(manualBox);

    if (st.configured || st.connected) {
      const actionRow = createElementSafe(doc, 'div', { class: 'rah-action-list' });
      if (typeof controls.ping === 'function') {
        const testBtn = createElementSafe(
          doc,
          'button',
          { type: 'button', class: 'rah-btn rah-action-btn', 'data-rah-bridge-test': '1' },
          'Test Connection'
        );
        testBtn.addEventListener('click', (ev) => {
          if (ev && ev.isTrusted === false) return;
          testBtn.disabled = true;
          Promise.resolve(controls.ping()).finally(() => {
            testBtn.disabled = false;
            if (typeof onUpdated === 'function') onUpdated();
          });
        });
        actionRow.appendChild(testBtn);
      }
      if (typeof controls.disconnect === 'function') {
        const discBtn = createElementSafe(
          doc,
          'button',
          { type: 'button', class: 'rah-btn rah-action-btn', 'data-rah-bridge-disconnect': '1' },
          'Disconnect'
        );
        discBtn.addEventListener('click', (ev) => {
          if (ev && ev.isTrusted === false) return;
          controls.disconnect();
          if (typeof onUpdated === 'function') onUpdated();
        });
        actionRow.appendChild(discBtn);
      }
      card.appendChild(actionRow);
    }
  }

  card.appendChild(errEl);
  container.appendChild(card);
}

function createHostDrawerUi({
  doc,
  win,
  profile,
  getState,
  onSelectSettingsTab = null,
  onInvokeHostAction = null,
  getHostLocale = null,
  onSetHostLocale = null,
  netConsent = null,
  remoteBridgeControls = null,
  shadowMode = 'open',
}) {
  const noTranslateAttrs = Array.isArray(profile.extraNoTranslateAttributes) ? profile.extraNoTranslateAttributes : [];
  const { hostEl, shadowRoot } = createShadowContainer(doc, DRAWER_HOST_ID, {
    mode: shadowMode === 'closed' ? 'closed' : 'open',
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

  const headerActions = createElementSafe(doc, 'div', { class: 'rah-header-actions' });
  const langButtons = [];
  if (typeof onSetHostLocale === 'function') {
    const langGroup = createElementSafe(doc, 'div', {
      class: 'rah-lang-switch',
      role: 'group',
      'aria-label': 'Host language',
      'data-rah-lang-switch': '1',
    });
    const langDefs = [
      { code: 'ko', label: '한국어' },
      { code: 'en', label: 'EN' },
    ];
    for (let i = 0; i < langDefs.length; i += 1) {
      const def = langDefs[i];
      const lBtn = createElementSafe(
        doc,
        'button',
        {
          type: 'button',
          class: 'rah-lang-btn',
          'data-rah-lang': def.code,
          'aria-pressed': 'false',
        },
        def.label
      );
      lBtn.addEventListener('click', (ev) => {
        if (ev && ev.isTrusted === false) return;
        onSetHostLocale(def.code);
        render();
      });
      langButtons.push({ code: def.code, el: lBtn });
      langGroup.appendChild(lBtn);
    }
    headerActions.appendChild(langGroup);
  }

  const closeBtn = createElementSafe(
    doc,
    'button',
    { type: 'button', class: 'rah-btn', 'aria-label': 'Close remote addon host panel' },
    'Close'
  );
  headerActions.appendChild(closeBtn);
  header.appendChild(titleWrap);
  header.appendChild(headerActions);

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
    { id: 'bridge', label: 'Host Bridge', emptyText: '' },
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
    if (isOpen && ev && ev.key === 'Escape' && ev.isTrusted !== false) {
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

    if (langButtons.length > 0 && typeof getHostLocale === 'function') {
      const rawLoc = String(getHostLocale() || 'en').toLowerCase();
      const activeLoc = rawLoc === 'ko' || rawLoc.startsWith('ko-') ? 'ko' : 'en';
      for (let i = 0; i < langButtons.length; i += 1) {
        langButtons[i].el.setAttribute('aria-pressed', langButtons[i].code === activeLoc ? 'true' : 'false');
      }
    }

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
    const bridgePane = paneRefs.get('bridge');

    renderAddonCardList(
      doc,
      addonsPane.primaryItems,
      state.addons,
      Array.isArray(state.hostActions) ? state.hostActions : [],
      onInvokeHostAction,
      render,
      netConsent
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
    if (bridgePane) {
      renderHostBridgePane(doc, bridgePane.primaryItems, state.remoteBridge, remoteBridgeControls, render);
      if (bridgePane.emptyEl) bridgePane.emptyEl.setAttribute('hidden', 'true');
    }
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
  getHostLocale = null,
  onSetHostLocale = null,
  netConsent = null,
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
      render,
      netConsent
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
  drawerShadowMode = 'open',
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

  const storageNamespace = profile.storageNamespace || `remote-addon-host:${profile.id}`;
  let activeRemoteTransport = remoteTransport;
  if (!activeRemoteTransport) {
    activeRemoteTransport = createRemoteHostTransport({
      win,
      storage,
      storageNamespace,
    });
    await activeRemoteTransport.hydrate();
    const initialBridgeStatus = activeRemoteTransport.getStatus();
    if (initialBridgeStatus && initialBridgeStatus.configured) {
      await activeRemoteTransport.ping();
    }
  }

  const bridge = createRemoteHostBridge({
    doc,
    win,
    docGenId,
    profileId: profile.id,
    storageNamespace,
    storage,
    remoteTransport: activeRemoteTransport,
    forbiddenNetHosts: Array.isArray(profile.forbiddenNetHosts) ? profile.forbiddenNetHosts : [],
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
    surface: 'remote-web',
    hostBridge: existingKernelState ? undefined : createSwappableBridgePort(kernelState),
    uiAnchors: profile.uiAnchors || {},
    uiSurfaces: profile.uiSurfaces || {},
    uiGridMerges: Array.isArray(profile.uiGridMerges) ? profile.uiGridMerges : [],
    uiSectionTargets: profile.uiSectionTargets || {},
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

  const mountedSettingsPluginIds = new Set();

  async function syncRemoteBridgeChange() {
    const status = bridge.getRemoteBridgeStatus();
    if (status && status.connected) {
      for (const pid of mountedSettingsPluginIds) {
        try {
          const snap = await bridge.hydrateSettings(pid);
          if (snap) {
            activeKernel.pushPluginSettings(pid, snap, hostToken);
          }
        } catch (_err) {}
      }
    }
    if (typeof activeKernel.emitHostEvent === 'function') {
      try {
        activeKernel.emitHostEvent('host:remote-bridge-changed', status, hostToken);
      } catch (_evErr) {}
    }
    if (drawerUi) drawerUi.render();
  }

  async function connectRemoteHost(input) {
    if (!activeRemoteTransport) {
      return { ok: false, reason: 'ERR_REMOTE_TRANSPORT_UNAVAILABLE' };
    }
    let res;
    if (typeof input === 'string' && typeof activeRemoteTransport.connectWithPairingCode === 'function') {
      res = await activeRemoteTransport.connectWithPairingCode(input);
    } else if (input && typeof input === 'object' && typeof activeRemoteTransport.connect === 'function') {
      res = await activeRemoteTransport.connect(input);
    } else {
      return { ok: false, reason: 'ERR_INVALID_PAIRING_CODE' };
    }
    await syncRemoteBridgeChange();
    return res;
  }

  function disconnectRemoteHost() {
    if (!activeRemoteTransport || typeof activeRemoteTransport.disconnect !== 'function') {
      return { ok: false, reason: 'ERR_REMOTE_TRANSPORT_UNAVAILABLE' };
    }
    const res = activeRemoteTransport.disconnect();
    syncRemoteBridgeChange().catch(() => {});
    return res;
  }

  const drawerCallbacks = {
    getState: () => ({
      addons: addonStates,
      settingsTabs: typeof activeKernel.listSettingsTabs === 'function' ? activeKernel.listSettingsTabs() : [],
      hostActions: typeof activeKernel.listHostActions === 'function' ? activeKernel.listHostActions(hostToken) : [],
      errors: bridge.getErrors(),
      remoteBridge: bridge.getRemoteBridgeStatus(),
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
    getHostLocale() {
      return typeof activeKernel.getHostLocale === 'function' ? activeKernel.getHostLocale() : 'en';
    },
    onSetHostLocale(locale) {
      if (typeof activeKernel.setHostLocale !== 'function') return 'en';
      return activeKernel.setHostLocale(locale, hostToken);
    },
    netConsent: {
      listHosts: (pluginId) => bridge.listUserAllowedHttpsHosts(pluginId),
      addHost: (pluginId, rawHostOrUrl) => bridge.addUserAllowedHttpsHost(pluginId, rawHostOrUrl),
      removeHost: (pluginId, rawHost) => bridge.removeUserAllowedHttpsHost(pluginId, rawHost),
    },
    remoteBridgeControls: {
      connect: connectRemoteHost,
      disconnect: disconnectRemoteHost,
      ping: async () => {
        if (!activeRemoteTransport || typeof activeRemoteTransport.ping !== 'function') {
          return { ok: false, reason: 'ERR_REMOTE_TRANSPORT_UNAVAILABLE' };
        }
        const res = await activeRemoteTransport.ping();
        await syncRemoteBridgeChange();
        return res;
      },
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
        shadowMode: drawerShadowMode,
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

    const netPerm =
      meta.permissions && meta.permissions.net && typeof meta.permissions.net === 'object' ? meta.permissions.net : null;
    const staticHttpsHosts = netPerm && Array.isArray(netPerm.httpsHosts) ? netPerm.httpsHosts : [];
    const allowUserHttps = Boolean(netPerm && netPerm.userApprovedHttps === true);
    const trustedLoopback =
      meta.trustLevel === 'trusted' && netPerm && Array.isArray(netPerm.localLoopback)
        ? netPerm.localLoopback.slice()
        : [];

    const record = {
      pluginId,
      displayName: meta.displayName || pluginId,
      version: meta.version || '0.0.0',
      trustLevel: meta.trustLevel || 'restricted',
      skippedCapabilities: Array.isArray(meta.skippedCapabilities) ? meta.skippedCapabilities.slice() : [],
      userApprovedHttps: allowUserHttps,
      status: 'pending',
      error: null,
    };
    addonStates.push(record);

    let initialSettings = addon.initialSettingsSnapshot || null;
    if (meta.hasSettingsBridge && meta.trustLevel === 'trusted') {
      mountedSettingsPluginIds.add(pluginId);
      bridge.bindSettingsPlugin(pluginId, addon.settingsSpec || {});
      const persisted =
        typeof bridge.hydrateSettings === 'function'
          ? await bridge.hydrateSettings(pluginId)
          : bridge.loadPersistedSettings(pluginId);
      if (persisted) {
        initialSettings = persisted;
      }
    }
    if (staticHttpsHosts.length > 0 || allowUserHttps || trustedLoopback.length > 0) {
      if (allowUserHttps && typeof bridge.hydrateUserAllowedHttpsHosts === 'function') {
        await bridge.hydrateUserAllowedHttpsHosts();
      }
      bridge.bindNetPlugin(pluginId, {
        httpsHosts: staticHttpsHosts,
        userApprovedHttps: allowUserHttps,
        localLoopback: trustedLoopback,
      });
    }
    const secretsPerm =
      meta.trustLevel === 'trusted' &&
      meta.permissions &&
      meta.permissions.secrets &&
      typeof meta.permissions.secrets === 'object'
        ? meta.permissions.secrets
        : null;
    if (secretsPerm && typeof bridge.bindSecretsPlugin === 'function') {
      bridge.bindSecretsPlugin(pluginId, secretsPerm);
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
    listUserAllowedHttpsHosts(pluginId) {
      if (disposed) return [];
      return bridge.listUserAllowedHttpsHosts(pluginId);
    },
    addUserAllowedHttpsHost(pluginId, rawHostOrUrl) {
      if (disposed) return { ok: false, reason: 'ERR_REMOTE_HOST_DISPOSED', hosts: [] };
      const res = bridge.addUserAllowedHttpsHost(pluginId, rawHostOrUrl);
      if (res && res.ok && drawerUi) drawerUi.render();
      return res;
    },
    removeUserAllowedHttpsHost(pluginId, rawHost) {
      if (disposed) return { ok: false, reason: 'ERR_REMOTE_HOST_DISPOSED', hosts: [] };
      const res = bridge.removeUserAllowedHttpsHost(pluginId, rawHost);
      if (res && res.ok && drawerUi) drawerUi.render();
      return res;
    },
    connectRemoteHost,
    disconnectRemoteHost,
    getRemoteBridgeStatus: () => bridge.getRemoteBridgeStatus(),
    getHostLocale: () => (typeof activeKernel.getHostLocale === 'function' ? activeKernel.getHostLocale() : 'en'),
    setHostLocale(locale) {
      if (disposed || typeof activeKernel.setHostLocale !== 'function') return 'en';
      const next = activeKernel.setHostLocale(locale, hostToken);
      if (drawerUi) drawerUi.render();
      return next;
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
