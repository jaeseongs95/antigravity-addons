'use strict';

/**
 * Vendor-neutral Tier-1 Status Item Registry (v3.0.2 — SOLID #0).
 *
 * - Delegates `ui.registerStatusItem` to the installed `'host.statusbar'` service
 *   when available.
 * - On `surface === 'desktop'`, never mounts an uninvited floating fallback bar
 *   when `'host.statusbar'` is absent (status items remain registered for
 *   programmatic inspection/invocation and auto-delegate once `'host.statusbar'`
 *   registers; settings belong in the Desktop Settings UI).
 * - On `surface === 'remote-web'`, falls back automatically to a minimal,
 *   accessible Shadow-DOM host bar anchored at the bottom-right above the
 *   Remote Web drawer pill when `'host.statusbar'` is not installed.
 * - Delivers click modifiers `{ shiftKey, ctrlKey, metaKey, altKey, anchorEl, itemId }`
 *   to `onClick` and enforces `ev.isTrusted !== false`.
 */

const FALLBACK_BAR_CSS = `
.ag-fallback-bar {
  position: fixed;
  right: max(12px, env(safe-area-inset-right, 0px));
  bottom: max(64px, calc(64px + env(safe-area-inset-bottom, 0px)));
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

// NEW-BLK-01 / R3-BLK-01..02 / R3-NB-03: Capture JS primordials at module load so World 998 prototype tampering cannot hijack statusbar items or delegation.
const _Error = Error;
const _String = String;
const _Number = Number;
const _NumberIsFinite = Number.isFinite;
const _StringTrim = Function.prototype.call.bind(String.prototype.trim);
const _ObjectCreate = Object.create;
const _ObjectDefineProperty = Object.defineProperty;
const _ObjectFreeze = Object.freeze;
const _ObjectHasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
const _ReflectApply = Reflect.apply;
const _Map = Map;
const _MapGet = Function.prototype.call.bind(Map.prototype.get);
const _MapSet = Function.prototype.call.bind(Map.prototype.set);
const _MapHas = Function.prototype.call.bind(Map.prototype.has);
const _MapDelete = Function.prototype.call.bind(Map.prototype.delete);
const _MapClear = Function.prototype.call.bind(Map.prototype.clear);
const _MapForEach = Function.prototype.call.bind(Map.prototype.forEach);

function defineSafeDataProp(target, key, value) {
  const desc = _ObjectCreate(null);
  desc.value = value;
  desc.enumerable = true;
  desc.configurable = true;
  desc.writable = true;
  _ObjectDefineProperty(target, key, desc);
}

function pushSafe(arr, value) {
  defineSafeDataProp(arr, arr.length, value);
}

function getOwn(obj, key) {
  if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return undefined;
  return _ObjectHasOwn(obj, key) ? obj[key] : undefined;
}

function createStatusItemRegistry(
  doc,
  _win,
  { serviceBus = null, themeAndI18n = null, extraNoTranslateAttributes = [], surface = 'desktop' } = {}
) {
  const allowFallbackBar = surface === 'remote-web';
  const itemsByKey = new _Map(); // `${pluginId}:${itemId}` -> itemRecord
  const delegatedByKey = new _Map(); // `${pluginId}:${itemId}` -> { unregister }
  let fallbackHostEl = null;
  let fallbackBarEl = null;
  let fallbackStyleEl = null;
  let lastFallbackThemeMode = null;

  function getDelegatedService() {
    if (!serviceBus || typeof serviceBus.getInternalService !== 'function') return null;
    const svc = serviceBus.getInternalService('host.statusbar');
    const impl = getOwn(svc, 'impl');
    if (impl && typeof getOwn(impl, 'registerItem') === 'function') {
      return impl;
    }
    return null;
  }

  function syncFallbackThemeCss() {
    if (!fallbackStyleEl) return;
    const mode = themeAndI18n ? themeAndI18n.getSnapshot().mode : 'dark';
    if (mode === lastFallbackThemeMode) return;
    lastFallbackThemeMode = mode;
    const tokenCss = themeAndI18n ? themeAndI18n.buildTokenCss(mode) : '';
    fallbackStyleEl.textContent = `${tokenCss}\n${FALLBACK_BAR_CSS}`;
  }

  function ensureFallbackBar() {
    if (fallbackBarEl && fallbackHostEl && fallbackHostEl.isConnected !== false) {
      syncFallbackThemeCss();
      return fallbackBarEl;
    }
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
      fallbackStyleEl = styleEl;
      lastFallbackThemeMode = null;
      syncFallbackThemeCss();
      sr.appendChild(styleEl);
      fallbackBarEl = doc.createElement('div');
      fallbackBarEl.className = 'ag-fallback-bar';
      fallbackBarEl.setAttribute('role', 'toolbar');
      fallbackBarEl.setAttribute('aria-label', 'Addon Status Items');
      sr.appendChild(fallbackBarEl);
    } else {
      fallbackStyleEl = null;
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
    if (delegatedSvc || !allowFallbackBar) {
      if (fallbackBarEl) {
        while (fallbackBarEl.firstChild) fallbackBarEl.removeChild(fallbackBarEl.firstChild);
        if (typeof fallbackBarEl.setAttribute === 'function') fallbackBarEl.setAttribute('hidden', 'true');
      }
      return;
    }

    const sorted = [];
    _MapForEach(itemsByKey, (rec) => {
      pushSafe(sorted, rec);
    });
    // R3-BLK-02: Local insertion sort using defineSafeDataProp — never invokes Array.prototype.sort or Array.prototype[idx] setters.
    for (let i = 1; i < sorted.length; i += 1) {
      const cur = sorted[i];
      let j = i - 1;
      while (j >= 0) {
        const prev = sorted[j];
        const cmp = prev.priority !== cur.priority ? prev.priority - cur.priority : prev.key < cur.key ? -1 : 1;
        if (cmp <= 0) break;
        defineSafeDataProp(sorted, j + 1, prev);
        j -= 1;
      }
      defineSafeDataProp(sorted, j + 1, cur);
    }
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

  function registerStatusItem(pluginId, spec) {
    const rawId = getOwn(spec, 'id');
    if (!spec || typeof spec !== 'object' || typeof rawId !== 'string' || !_StringTrim(rawId)) {
      throw new _Error('ERR_INVALID_STATUS_ITEM_ID');
    }
    const id = _StringTrim(rawId);
    const key = `${pluginId}:${id}`;
    const rawLabel = getOwn(spec, 'label');
    const rawIcon = getOwn(spec, 'icon');
    const rawTooltip = getOwn(spec, 'tooltip');
    const rawBadge = getOwn(spec, 'badge');
    const rawAlign = getOwn(spec, 'align');
    const rawPriority = getOwn(spec, 'priority');
    const rawOnClick = getOwn(spec, 'onClick');
    const parsedPriority = _Number(rawPriority);
    const record = _ObjectCreate(null);
    record.key = key;
    record.pluginId = pluginId;
    record.id = id;
    record.label = _String(rawLabel || id);
    record.icon = typeof rawIcon === 'string' ? rawIcon : '';
    record.tooltip = typeof rawTooltip === 'string' ? rawTooltip : '';
    record.badge = rawBadge !== undefined && rawBadge !== null ? _String(rawBadge) : '';
    record.align = rawAlign === 'left' ? 'left' : 'right';
    record.priority = rawPriority !== undefined && _NumberIsFinite(parsedPriority) ? parsedPriority : 100;
    record.onClick = typeof rawOnClick === 'function' ? rawOnClick : null;
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
      update(patch) {
        if (!_MapHas(itemsByKey, key) || !patch || typeof patch !== 'object') return;
        const pLabel = getOwn(patch, 'label');
        const pIcon = getOwn(patch, 'icon');
        const pTooltip = getOwn(patch, 'tooltip');
        const pBadge = getOwn(patch, 'badge');
        const pPriority = getOwn(patch, 'priority');
        if (pLabel !== undefined) record.label = _String(pLabel);
        if (pIcon !== undefined) record.icon = _String(pIcon || '');
        if (pTooltip !== undefined) record.tooltip = _String(pTooltip || '');
        if (pBadge !== undefined) record.badge = pBadge === null ? '' : _String(pBadge);
        if (pPriority !== undefined && _NumberIsFinite(_Number(pPriority))) {
          record.priority = _Number(pPriority);
        }
        const activeSvc = getDelegatedService();
        const updateFn = getOwn(activeSvc, 'updateItem');
        if (typeof updateFn === 'function') {
          try {
            const updateArgs = [];
            defineSafeDataProp(updateArgs, 0, pluginId);
            defineSafeDataProp(updateArgs, 1, id);
            defineSafeDataProp(updateArgs, 2, {
              label: record.label,
              icon: record.icon,
              tooltip: record.tooltip,
              badge: record.badge,
              priority: record.priority,
            });
            _ReflectApply(updateFn, activeSvc, updateArgs);
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
        const disposeFn = getOwn(del, 'dispose');
        if (typeof disposeFn === 'function') {
          try {
            disposeFn();
          } catch (_e) {}
        } else {
          const activeSvc = getDelegatedService();
          const removeFn = getOwn(activeSvc, 'removeItem');
          if (typeof removeFn === 'function') {
            try {
              const removeArgs = [];
              defineSafeDataProp(removeArgs, 0, pluginId);
              defineSafeDataProp(removeArgs, 1, id);
              _ReflectApply(removeFn, activeSvc, removeArgs);
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
      pushSafe(
        out,
        _ObjectFreeze({
          pluginId: r.pluginId,
          id: r.id,
          label: r.label,
          icon: r.icon,
          tooltip: r.tooltip,
          badge: r.badge,
          align: r.align,
          priority: r.priority,
          delegated: _MapHas(delegatedByKey, r.key),
        })
      );
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
      if (rec.pluginId === pluginId) pushSafe(toRemove, key);
    });
    for (let i = 0; i < toRemove.length; i += 1) {
      const key = toRemove[i];
      _MapDelete(itemsByKey, key);
      const del = _MapGet(delegatedByKey, key);
      _MapDelete(delegatedByKey, key);
      const disposeFn = getOwn(del, 'dispose');
      if (typeof disposeFn === 'function') {
        try {
          disposeFn();
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
