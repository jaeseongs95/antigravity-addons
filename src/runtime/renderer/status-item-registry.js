'use strict';

/**
 * Vendor-neutral Tier-1 Status Item Registry (v3.0.0 — SOLID #0).
 *
 * - Delegates `ui.registerStatusItem` to the installed `'host.statusbar'` service
 *   (e.g., `antigravity-statusbar`) when available.
 * - Falls back automatically to a minimal, accessible Shadow-DOM host bar when
 *   `'host.statusbar'` is not installed.
 * - Delivers click modifiers `{ shiftKey, ctrlKey, metaKey, altKey, anchorEl, itemId }`
 *   to `onClick` and enforces `ev.isTrusted !== false`.
 */

const FALLBACK_BAR_CSS = `
.ag-fallback-bar {
  position: fixed;
  left: 12px;
  bottom: 12px;
  z-index: 2147482900;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 999px;
  background: var(--ag-surface, rgba(18, 22, 30, 0.92));
  border: 1px solid var(--ag-border, rgba(255, 255, 255, 0.14));
  box-shadow: var(--ag-shadow, 0 6px 20px rgba(0, 0, 0, 0.4));
  font-family: var(--ag-font, system-ui, -apple-system, sans-serif);
}
.ag-fallback-bar[hidden] { display: none; }
.ag-status-btn {
  appearance: none;
  border: 1px solid transparent;
  background: transparent;
  color: var(--ag-text, #f0f6fc);
  border-radius: 999px;
  padding: 4px 9px;
  min-height: 28px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.ag-status-btn:hover { background: rgba(255, 255, 255, 0.08); }
.ag-status-badge {
  background: rgba(56, 189, 248, 0.18);
  color: var(--ag-accent, #38bdf8);
  border-radius: 999px;
  padding: 1px 6px;
  font-size: 10px;
}
`;

// NEW-BLK-01: Capture JS primordials at module load so World 998 Map/Object prototype tampering cannot hijack statusbar delegation.
const _ObjectFreeze = Object.freeze;
const _Map = Map;
const _MapGet = Function.prototype.call.bind(Map.prototype.get);
const _MapSet = Function.prototype.call.bind(Map.prototype.set);
const _MapHas = Function.prototype.call.bind(Map.prototype.has);
const _MapDelete = Function.prototype.call.bind(Map.prototype.delete);
const _MapClear = Function.prototype.call.bind(Map.prototype.clear);
const _MapForEach = Function.prototype.call.bind(Map.prototype.forEach);

function createStatusItemRegistry(doc, _win, { serviceBus = null, themeAndI18n = null, extraNoTranslateAttributes = [] } = {}) {
  const itemsByKey = new _Map(); // `${pluginId}:${itemId}` -> itemRecord
  const delegatedByKey = new _Map(); // `${pluginId}:${itemId}` -> { unregister }
  let fallbackHostEl = null;
  let fallbackBarEl = null;

  function getDelegatedService() {
    if (!serviceBus || typeof serviceBus.getInternalService !== 'function') return null;
    const svc = serviceBus.getInternalService('host.statusbar');
    if (svc && svc.impl && typeof svc.impl.registerItem === 'function') {
      return svc.impl;
    }
    return null;
  }

  function ensureFallbackBar() {
    if (fallbackBarEl && fallbackHostEl && fallbackHostEl.isConnected !== false) return fallbackBarEl;
    if (!doc || typeof doc.createElement !== 'function') return null;
    fallbackHostEl = doc.createElement('div');
    fallbackHostEl.setAttribute('data-addon-host-fallback-statusbar', '1');
    fallbackHostEl.setAttribute('data-addon-host-ignore', 'true');
    fallbackHostEl.setAttribute('translate', 'no');
    fallbackHostEl.setAttribute('data-addon-host-no-translate', 'true');
    for (let i = 0; i < extraNoTranslateAttributes.length; i += 1) {
      fallbackHostEl.setAttribute(extraNoTranslateAttributes[i], 'true');
    }
    if (typeof fallbackHostEl.attachShadow === 'function') {
      const sr = fallbackHostEl.attachShadow({ mode: 'open' });
      const styleEl = doc.createElement('style');
      const tokenCss = themeAndI18n ? themeAndI18n.buildTokenCss(themeAndI18n.getSnapshot().mode) : '';
      styleEl.textContent = `${tokenCss}\n${FALLBACK_BAR_CSS}`;
      sr.appendChild(styleEl);
      fallbackBarEl = doc.createElement('div');
      fallbackBarEl.className = 'ag-fallback-bar';
      fallbackBarEl.setAttribute('role', 'toolbar');
      fallbackBarEl.setAttribute('aria-label', 'Addon Status Items');
      sr.appendChild(fallbackBarEl);
    } else {
      fallbackBarEl = fallbackHostEl;
    }
    const parent = doc.body || doc.documentElement;
    if (parent && typeof parent.appendChild === 'function') {
      parent.appendChild(fallbackHostEl);
    }
    return fallbackBarEl;
  }

  function removeFallbackBarIfEmpty() {
    if (!fallbackBarEl) return;
    if (fallbackBarEl.childNodes.length === 0) {
      if (typeof fallbackBarEl.setAttribute === 'function') {
        fallbackBarEl.setAttribute('hidden', 'true');
      }
    }
  }

  function buildClickPayload(record, ev, anchorEl) {
    return _ObjectFreeze({
      pluginId: record.pluginId,
      itemId: record.id,
      shiftKey: !!(ev && ev.shiftKey),
      ctrlKey: !!(ev && ev.ctrlKey),
      metaKey: !!(ev && ev.metaKey),
      altKey: !!(ev && ev.altKey),
      anchorEl: anchorEl || null,
    });
  }

  function renderFallbackItems() {
    const delegatedSvc = getDelegatedService();
    if (delegatedSvc) {
      if (fallbackBarEl) {
        while (fallbackBarEl.firstChild) fallbackBarEl.removeChild(fallbackBarEl.firstChild);
        if (typeof fallbackBarEl.setAttribute === 'function') fallbackBarEl.setAttribute('hidden', 'true');
      }
      return;
    }

    const sorted = [];
    _MapForEach(itemsByKey, (rec) => {
      sorted[sorted.length] = rec;
    });
    sorted.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.key < b.key ? -1 : 1;
    });
    if (sorted.length === 0) {
      if (fallbackBarEl) {
        while (fallbackBarEl.firstChild) fallbackBarEl.removeChild(fallbackBarEl.firstChild);
        removeFallbackBarIfEmpty();
      }
      return;
    }

    const bar = ensureFallbackBar();
    if (!bar) return;
    if (typeof bar.removeAttribute === 'function') bar.removeAttribute('hidden');
    while (bar.firstChild) bar.removeChild(bar.firstChild);

    for (let i = 0; i < sorted.length; i += 1) {
      const rec = sorted[i];
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'ag-status-btn';
      btn.setAttribute('data-addon-host-owner', rec.pluginId);
      btn.setAttribute('data-status-item-id', rec.id);
      if (rec.tooltip) btn.setAttribute('title', rec.tooltip);
      const labelSpan = doc.createElement('span');
      labelSpan.textContent = rec.icon ? `${rec.icon} ${rec.label}` : rec.label;
      btn.appendChild(labelSpan);
      if (rec.badge) {
        const badgeSpan = doc.createElement('span');
        badgeSpan.className = 'ag-status-badge';
        badgeSpan.textContent = rec.badge;
        btn.appendChild(badgeSpan);
      }
      btn.addEventListener('click', (ev) => {
        if (ev && ev.isTrusted === false) return;
        if (typeof rec.onClick === 'function') {
          try {
            rec.onClick(buildClickPayload(rec, ev, btn));
          } catch (_e) {}
        }
      });
      bar.appendChild(btn);
    }
  }

  function syncDelegation() {
    const svc = getDelegatedService();
    if (!svc) {
      // Clear any stale delegation handles and fall back to host bar
      _MapClear(delegatedByKey);
      renderFallbackItems();
      return;
    }
    // Delegate every active item that is not yet delegated
    _MapForEach(itemsByKey, (rec, key) => {
      if (!_MapHas(delegatedByKey, key)) {
        try {
          const res = svc.registerItem({
            pluginId: rec.pluginId,
            id: rec.id,
            label: rec.label,
            icon: rec.icon,
            tooltip: rec.tooltip,
            badge: rec.badge,
            align: rec.align,
            priority: rec.priority,
            onClick: (ev) => {
              if (typeof rec.onClick === 'function') {
                rec.onClick(buildClickPayload(rec, ev, ev && ev.anchorEl ? ev.anchorEl : null));
              }
            },
          });
          _MapSet(delegatedByKey, key, res || { delegated: true });
        } catch (_e) {}
      }
    });
    renderFallbackItems();
  }

  function registerStatusItem(pluginId, spec = {}) {
    if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string' || !spec.id.trim()) {
      throw new Error('ERR_INVALID_STATUS_ITEM_ID');
    }
    const id = spec.id.trim();
    const key = `${pluginId}:${id}`;
    const record = {
      key,
      pluginId,
      id,
      label: String(spec.label || id),
      icon: typeof spec.icon === 'string' ? spec.icon : '',
      tooltip: typeof spec.tooltip === 'string' ? spec.tooltip : '',
      badge: spec.badge !== undefined && spec.badge !== null ? String(spec.badge) : '',
      align: spec.align === 'left' ? 'left' : 'right',
      priority: Number.isFinite(Number(spec.priority)) ? Number(spec.priority) : 100,
      onClick: typeof spec.onClick === 'function' ? spec.onClick : null,
    };
    _MapSet(itemsByKey, key, record);

    const svc = getDelegatedService();
    if (svc) {
      try {
        const res = svc.registerItem({
          pluginId: record.pluginId,
          id: record.id,
          label: record.label,
          icon: record.icon,
          tooltip: record.tooltip,
          badge: record.badge,
          align: record.align,
          priority: record.priority,
          onClick: (ev) => {
            if (typeof record.onClick === 'function') {
              record.onClick(buildClickPayload(record, ev, ev && ev.anchorEl ? ev.anchorEl : null));
            }
          },
        });
        _MapSet(delegatedByKey, key, res || { delegated: true });
      } catch (_e) {}
    } else {
      renderFallbackItems();
    }

    return _ObjectFreeze({
      id,
      update(patch = {}) {
        if (!_MapHas(itemsByKey, key) || !patch || typeof patch !== 'object') return;
        if (patch.label !== undefined) record.label = String(patch.label);
        if (patch.icon !== undefined) record.icon = String(patch.icon || '');
        if (patch.tooltip !== undefined) record.tooltip = String(patch.tooltip || '');
        if (patch.badge !== undefined) record.badge = patch.badge === null ? '' : String(patch.badge);
        if (patch.priority !== undefined && Number.isFinite(Number(patch.priority))) {
          record.priority = Number(patch.priority);
        }
        const activeSvc = getDelegatedService();
        if (activeSvc && typeof activeSvc.updateItem === 'function') {
          try {
            activeSvc.updateItem(pluginId, id, {
              label: record.label,
              icon: record.icon,
              tooltip: record.tooltip,
              badge: record.badge,
              priority: record.priority,
            });
          } catch (_e) {}
        } else {
          renderFallbackItems();
        }
      },
      dispose() {
        if (!_MapHas(itemsByKey, key)) return;
        _MapDelete(itemsByKey, key);
        const del = _MapGet(delegatedByKey, key);
        _MapDelete(delegatedByKey, key);
        if (del && typeof del.dispose === 'function') {
          try {
            del.dispose();
          } catch (_e) {}
        } else {
          const activeSvc = getDelegatedService();
          if (activeSvc && typeof activeSvc.removeItem === 'function') {
            try {
              activeSvc.removeItem(pluginId, id);
            } catch (_e) {}
          }
        }
        renderFallbackItems();
      },
    });
  }

  function listStatusItems() {
    const out = [];
    _MapForEach(itemsByKey, (r) => {
      out[out.length] = _ObjectFreeze({
        pluginId: r.pluginId,
        id: r.id,
        label: r.label,
        icon: r.icon,
        tooltip: r.tooltip,
        badge: r.badge,
        align: r.align,
        priority: r.priority,
        delegated: _MapHas(delegatedByKey, r.key),
      });
    });
    return out;
  }

  function invokeStatusItem(pluginId, itemId, clickEvent = {}) {
    const rec = _MapGet(itemsByKey, `${pluginId}:${itemId}`);
    if (!rec || typeof rec.onClick !== 'function') {
      return { ok: false, reason: 'ERR_STATUS_ITEM_NOT_FOUND' };
    }
    rec.onClick(buildClickPayload(rec, clickEvent, clickEvent && clickEvent.anchorEl ? clickEvent.anchorEl : null));
    return { ok: true };
  }

  function disposePlugin(pluginId) {
    const toRemove = [];
    _MapForEach(itemsByKey, (rec, key) => {
      if (rec.pluginId === pluginId) toRemove[toRemove.length] = key;
    });
    for (let i = 0; i < toRemove.length; i += 1) {
      const key = toRemove[i];
      _MapDelete(itemsByKey, key);
      const del = _MapGet(delegatedByKey, key);
      _MapDelete(delegatedByKey, key);
      if (del && typeof del.dispose === 'function') {
        try {
          del.dispose();
        } catch (_e) {}
      }
    }
    renderFallbackItems();
  }

  return _ObjectFreeze({
    registerStatusItem,
    listStatusItems,
    invokeStatusItem,
    syncDelegation,
    isDelegated: () => !!getDelegatedService(),
    disposePlugin,
  });
}

module.exports = {
  createStatusItemRegistry,
};
