'use strict';

/**
 * UI Slot Manager — Option B2 Shadow DOM Contract (T-B, F3).
 *
 * - `mountSlot(pluginMeta, slotId, opts)`:
 *   - Enforces manifest slot ownership (`slotId` must be declared in `pluginMeta.uiSlots`).
 *   - Resolves `shadow` from normalized v2 manifest (`v1` defaults `false`, `v2` defaults `true`,
 *     `document-transform` ALWAYS `false`).
 *   - Option B2 (`shadow: true`): creates open `ShadowRoot` on host wrapper element and returns
 *     inner `<div class="addon-host-slot-root" data-addon-host-owner="...">` (`HTMLElement`),
 *     preserving `.style`/`.classList`/`.setAttribute()` while exposing `ShadowRoot` via `el.getRootNode()`.
 *   - Anchor miss: returns `null` (NEVER auto-opens ModalPortal!).
 */

function createSlotManager(doc, { uiAnchors = {}, extraNoTranslateAttributes = [], styleManager = null } = {}) {
  const mountedByKey = new Map(); // `${pluginId}:${slotId}` -> { hostEl, rootEl, shadowRoot, slotDef }

  function findSlotDef(pluginMeta, slotId) {
    const slots = Array.isArray(pluginMeta && pluginMeta.uiSlots) ? pluginMeta.uiSlots : [];
    return slots.find((s) => s && s.slotId === slotId) || null;
  }

  function resolveAnchorContainer(slotDef, opts = {}) {
    if (opts && opts.container) return opts.container;
    const anchorKey = (opts && opts.anchor) || (slotDef && slotDef.anchor) || (slotDef && slotDef.slot);
    if (anchorKey && uiAnchors && Array.isArray(uiAnchors[anchorKey])) {
      const selectors = uiAnchors[anchorKey];
      for (let i = 0; i < selectors.length; i++) {
        try {
          const found = typeof doc.querySelector === 'function' ? doc.querySelector(selectors[i]) : null;
          if (found) return found;
        } catch (_e) {}
      }
      // Anchor was explicitly defined in HostProfile but not present in current DOM -> return null!
      return null;
    }
    return opts && opts.fallbackToBody ? doc.body : null;
  }

  function applyNoTranslateAttrs(el, pluginMeta) {
    const noTranslate = !pluginMeta.isolation || pluginMeta.isolation.noTranslate !== false;
    if (!noTranslate) return;
    el.setAttribute('translate', 'no');
    el.setAttribute('data-addon-host-no-translate', 'true');
    for (let i = 0; i < extraNoTranslateAttributes.length; i++) {
      el.setAttribute(extraNoTranslateAttributes[i], 'true');
    }
  }

  function mountSlot(pluginMeta, slotId, opts = {}) {
    const slotDef = findSlotDef(pluginMeta, slotId);
    if (!slotDef) {
      throw new Error(`ERR_UNDECLARED_SLOT:${pluginMeta.pluginId}:${slotId}`);
    }

    const key = `${pluginMeta.pluginId}:${slotId}`;
    const existing = mountedByKey.get(key);
    if (existing && existing.hostEl) {
      // R-3: Check isConnected (fallback to parentNode for lightweight mocks) so React anchor unmount triggers clean remount
      const stillConnected =
        existing.hostEl.isConnected !== undefined
          ? Boolean(existing.hostEl.isConnected)
          : Boolean(existing.hostEl.parentNode);
      if (stillConnected) {
        return existing.rootEl;
      }
      if (existing.shadowRoot && styleManager) {
        styleManager.unregisterShadowRoot(pluginMeta.pluginId, slotId, existing.shadowRoot);
      }
      mountedByKey.delete(key);
    }

    const container = resolveAnchorContainer(slotDef, opts);
    if (!container || typeof container.appendChild !== 'function') {
      return null;
    }

    const ALLOWED_SLOT_TAGS = new Set(['div', 'span', 'section', 'aside', 'nav', 'header', 'footer']);
    const useShadow =
      slotDef.slot === 'document-transform'
        ? false
        : typeof opts.shadow === 'boolean' && (opts.shadow === true || pluginMeta.trustLevel === 'trusted' || !slotDef.shadow)
          ? opts.shadow
          : Boolean(slotDef.shadow);

    const requestedTag = typeof opts.tagName === 'string' ? opts.tagName.toLowerCase() : 'div';
    const safeTag = ALLOWED_SLOT_TAGS.has(requestedTag) ? requestedTag : 'div';
    const hostEl = doc.createElement(safeTag);
    hostEl.setAttribute('data-addon-host-owner', pluginMeta.pluginId);
    hostEl.setAttribute('data-addon-host-slot', slotId);
    hostEl.setAttribute('data-addon-host-slot-kind', slotDef.slot);
    applyNoTranslateAttrs(hostEl, pluginMeta);
    container.appendChild(hostEl);

    let rootEl = hostEl;
    let shadowRoot = null;

    if (useShadow && typeof hostEl.attachShadow === 'function') {
      shadowRoot = hostEl.attachShadow({ mode: 'open' });
      const inner = doc.createElement('div');
      inner.className = 'addon-host-slot-root';
      inner.setAttribute('data-addon-host-owner', pluginMeta.pluginId);
      inner.setAttribute('data-addon-host-slot', slotId);
      if (typeof shadowRoot.appendChild === 'function') {
        shadowRoot.appendChild(inner);
      }
      rootEl = inner;
      if (styleManager) {
        styleManager.registerShadowRoot(pluginMeta.pluginId, slotId, shadowRoot);
      }
    }

    mountedByKey.set(key, { hostEl, rootEl, shadowRoot, slotDef });
    return rootEl;
  }

  function unmountSlot(pluginId, slotId) {
    const key = `${pluginId}:${slotId}`;
    const rec = mountedByKey.get(key);
    if (!rec) {
      for (const existingKey of mountedByKey.keys()) {
        if (existingKey.endsWith(`:${slotId}`) && !existingKey.startsWith(`${pluginId}:`)) {
          throw new Error(`ERR_FORBIDDEN_CROSS_PLUGIN_UNMOUNT:${pluginId}:${slotId}`);
        }
      }
      return false;
    }
    if (rec.shadowRoot && styleManager) {
      styleManager.unregisterShadowRoot(pluginId, slotId, rec.shadowRoot);
    }
    if (rec.hostEl && rec.hostEl.parentNode && typeof rec.hostEl.parentNode.removeChild === 'function') {
      try {
        rec.hostEl.parentNode.removeChild(rec.hostEl);
      } catch (_e) {}
    }
    mountedByKey.delete(key);
    return true;
  }

  function disposePluginSlots(pluginId) {
    for (const [key, rec] of Array.from(mountedByKey.entries())) {
      if (key.startsWith(`${pluginId}:`)) {
        unmountSlot(pluginId, rec.slotDef.slotId);
      }
    }
  }

  return Object.freeze({
    mountSlot,
    unmountSlot,
    disposePluginSlots,
  });
}

module.exports = {
  createSlotManager,
};
