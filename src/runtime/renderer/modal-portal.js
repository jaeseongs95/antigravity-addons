'use strict';

/**
 * Host Modal & Popover Portal Stack (FV4 / P1-5 / Option B2 / T-C).
 *
 * - Validates `openModal` slot kind is strictly `'modal'` or `'overlay'` (FV4 fix).
 * - Uses native `<dialog>.showModal()` + `popover="manual"` when available (with safe
 *   degradation for lightweight unit-test DOM mocks).
 * - Capture-phase `Escape` keydown listener + `<dialog>` `cancel` `preventDefault()` LIFO stack
 *   (empirically verified on Electron 45.4.1 `sendInputEvent('Escape')` in P1-5!).
 * - Option B2 `bodyEl`: `<div class="addon-host-slot-root">` inside `ShadowRoot` when `shadow !== false`.
 * - Applies `titleBarOverlay` safe top inset (`env(titlebar-area-height, 36px)`).
 * - Emits `onPortalClaimChange(claimId, active)` ONLY on stack `0 -> 1` and `1 -> 0` transitions.
 */

function isEventInsideElements(ev, elements) {
  if (!ev || !Array.isArray(elements) || elements.length === 0) return false;
  const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [ev.target];
  for (let i = 0; i < path.length; i++) {
    const node = path[i];
    if (!node) continue;
    for (let j = 0; j < elements.length; j++) {
      const target = elements[j];
      if (!target) continue;
      if (node === target) return true;
      if (typeof target.contains === 'function' && target.contains(node)) return true;
    }
  }
  return false;
}

function createModalPortal(
  doc,
  win,
  { extraNoTranslateAttributes = [], styleManager = null, onPortalClaimChange = () => {} } = {}
) {
  const stack = []; // LIFO: { id, kind: 'modal'|'popover', pluginId, slotId, el, bodyEl, shadowRoot, prevFocus, ignoreOutsideClickEls, onClose }
  let seq = 0;
  let globalListenersInstalled = false;
  let portalClaimActive = false;

  function notifyPortalState(_prevCount, nextCount) {
    const nextActive = nextCount > 0;
    if (nextActive === portalClaimActive) return;
    portalClaimActive = nextActive;
    try {
      onPortalClaimChange('host-modal-portal-stack', nextActive);
    } catch (_e) {}
  }

  function isNestedInside(parentEl, childEl) {
    if (!parentEl || !childEl || parentEl === childEl) return false;
    if (childEl.parentNode === parentEl) return true;
    if (typeof parentEl.contains === 'function') {
      try {
        return Boolean(parentEl.contains(childEl));
      } catch (_e) {}
    }
    let cur = childEl.parentNode;
    let guard = 0;
    while (cur && guard < 64) {
      guard++;
      if (cur === parentEl) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  function closeEntry(entry) {
    const idx = stack.indexOf(entry);
    if (idx === -1) return false;
    // NB-4: Mark closing before cascading so any popover opened inside a child onClose() will not mount into this dying <dialog>
    entry.closing = true;
    const prevCount = stack.length;

    // F2: Cascade-close nested child entries using a snapshot so re-entrant onClose() mutations cannot skip or throw
    for (const candidate of stack.slice().reverse()) {
      if (candidate && candidate !== entry && stack.includes(candidate) && isNestedInside(entry.el, candidate.el)) {
        closeEntry(candidate);
      }
    }

    const curIdx = stack.indexOf(entry);
    if (curIdx === -1) return true;
    stack.splice(curIdx, 1);

    if (entry.shadowRoot && styleManager) {
      styleManager.unregisterShadowRoot(entry.pluginId, entry.slotId, entry.shadowRoot);
    }
    try {
      if (entry.kind === 'modal' && typeof entry.el.close === 'function' && entry.el.open) {
        entry.el.close();
      } else if (entry.kind === 'popover' && typeof entry.el.hidePopover === 'function') {
        entry.el.hidePopover();
      }
    } catch (_e) {}

    if (entry.el && entry.el.parentNode && typeof entry.el.parentNode.removeChild === 'function') {
      try {
        entry.el.parentNode.removeChild(entry.el);
      } catch (_e) {}
    }
    if (entry.prevFocus && typeof entry.prevFocus.focus === 'function') {
      try {
        entry.prevFocus.focus();
      } catch (_e) {}
    }
    if (typeof entry.onClose === 'function') {
      try {
        entry.onClose();
      } catch (_e) {}
    }
    notifyPortalState(prevCount, stack.length);
    return true;
  }

  function closeTop() {
    if (stack.length === 0) return false;
    return closeEntry(stack[stack.length - 1]);
  }

  function ensureGlobalListeners() {
    if (globalListenersInstalled) return;
    globalListenersInstalled = true;

    if (win && typeof win.addEventListener === 'function') {
      // Capture-phase Escape intercepts BEFORE Chromium CloseWatcher closes underlying <dialog> (P1-5)
      win.addEventListener(
        'keydown',
        (ev) => {
          if (!ev || ev.key !== 'Escape' || stack.length === 0) return;
          // R-6c: Do not intercept CJK IME composition cancellation or already-handled Escape events
          if (ev.isComposing || ev.keyCode === 229 || ev.defaultPrevented) return;
          if (typeof ev.preventDefault === 'function') ev.preventDefault();
          if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
          closeTop();
        },
        true
      );
    }

    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener(
        'pointerdown',
        (ev) => {
          if (stack.length === 0) return;
          const top = stack[stack.length - 1];
          if (top.kind !== 'popover') return;
          const ignoreEls = [top.el, ...(top.ignoreOutsideClickEls || [])];
          if (isEventInsideElements(ev, ignoreEls)) {
            return;
          }
          closeEntry(top);
        },
        true
      );
    }
  }

  function findSlotDef(pluginMeta, slotId) {
    const slots = Array.isArray(pluginMeta && pluginMeta.uiSlots) ? pluginMeta.uiSlots : [];
    return slots.find((s) => s && s.slotId === slotId) || null;
  }

  function createSurfaceBody(el, pluginMeta, slotId, useShadow) {
    if (useShadow) {
      // WHATWG DOM: <dialog> cannot call attachShadow() directly; attach open ShadowRoot to an inner host <div>.
      const shadowHost =
        String(el.tagName || '').toLowerCase() === 'dialog'
          ? (() => {
              const wrap = doc.createElement('div');
              wrap.className = 'addon-host-modal-shadow-host';
              wrap.setAttribute('data-addon-host-owner', pluginMeta.pluginId);
              wrap.setAttribute('data-addon-host-slot', slotId);
              el.appendChild(wrap);
              return wrap;
            })()
          : el;
      if (typeof shadowHost.attachShadow === 'function') {
        const sr = shadowHost.attachShadow({ mode: 'open' });
        const inner = doc.createElement('div');
        inner.className = 'addon-host-slot-root';
        inner.setAttribute('data-addon-host-owner', pluginMeta.pluginId);
        inner.setAttribute('data-addon-host-slot', slotId);
        if (typeof sr.appendChild === 'function') sr.appendChild(inner);
        if (styleManager) styleManager.registerShadowRoot(pluginMeta.pluginId, slotId, sr);
        return { bodyEl: inner, shadowRoot: sr };
      }
    }
    return { bodyEl: el, shadowRoot: null };
  }

  function resolveUseShadow(pluginMeta, slotDef, opts = {}) {
    // R-6a: Match slot-manager.js shadow guard — restricted v2 plugins cannot downgrade shadow: true to false
    return typeof opts.shadow === 'boolean' && (opts.shadow === true || pluginMeta.trustLevel === 'trusted' || !slotDef.shadow)
      ? opts.shadow
      : Boolean(slotDef.shadow);
  }

  function openModal(pluginMeta, slotId, opts = {}) {
    const slotDef = findSlotDef(pluginMeta, slotId);
    if (!slotDef) {
      throw new Error(`ERR_UNDECLARED_SLOT:${pluginMeta.pluginId}:${slotId}`);
    }
    if (slotDef.slot !== 'modal' && slotDef.slot !== 'overlay') {
      throw new Error(`ERR_INVALID_MODAL_SLOT_KIND:${slotDef.slot}`);
    }

    ensureGlobalListeners();
    const prevCount = stack.length;
    const prevFocus = doc.activeElement || null;
    const dlg = doc.createElement('dialog');
    dlg.setAttribute('data-addon-host-modal-dialog', '1');
    dlg.setAttribute('data-addon-host-owner', pluginMeta.pluginId);
    dlg.setAttribute('data-addon-host-slot', slotId);
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('translate', 'no');
    dlg.setAttribute('data-addon-host-no-translate', 'true');
    for (let i = 0; i < extraNoTranslateAttributes.length; i++) {
      dlg.setAttribute(extraNoTranslateAttributes[i], 'true');
    }
    if (dlg.style) {
      dlg.style.marginTop = 'max(env(titlebar-area-height, 36px), 36px)';
      dlg.style.zIndex = String(2147483000 + stack.length + 1);
    }

    const useShadow = resolveUseShadow(pluginMeta, slotDef, opts);
    const { bodyEl, shadowRoot } = createSurfaceBody(dlg, pluginMeta, slotId, useShadow);

    const hostBody = doc.body || doc.documentElement;
    hostBody.appendChild(dlg);

    const entry = {
      id: `modal-${++seq}`,
      kind: 'modal',
      pluginId: pluginMeta.pluginId,
      slotId,
      el: dlg,
      bodyEl,
      shadowRoot,
      prevFocus,
      ignoreOutsideClickEls: Array.isArray(opts.ignoreOutsideClickEls) ? opts.ignoreOutsideClickEls : [],
      onClose: opts.onClose || null,
    };

    if (typeof dlg.addEventListener === 'function') {
      dlg.addEventListener('cancel', (ev) => {
        if (ev && ev.cancelable && typeof ev.preventDefault === 'function') {
          ev.preventDefault();
        }
        closeTop();
      });
      // R-6b: Sync stack if <dialog> is closed programmatically or via <form method="dialog">
      dlg.addEventListener('close', () => {
        closeEntry(entry);
      });
    }

    stack.push(entry);
    if (typeof dlg.showModal === 'function') {
      try {
        dlg.showModal();
      } catch (_e) {}
    }
    notifyPortalState(prevCount, stack.length);

    return Object.freeze({
      id: entry.id,
      element: dlg,
      bodyEl,
      close: () => closeEntry(entry),
    });
  }

  function openPopover(pluginMeta, slotId, opts = {}) {
    const slotDef = findSlotDef(pluginMeta, slotId);
    if (!slotDef) {
      throw new Error(`ERR_UNDECLARED_SLOT:${pluginMeta.pluginId}:${slotId}`);
    }
    if (slotDef.slot !== 'overlay' && slotDef.slot !== 'modal') {
      throw new Error(`ERR_INVALID_POPOVER_SLOT_KIND:${slotDef.slot}`);
    }

    ensureGlobalListeners();
    const prevCount = stack.length;
    const prevFocus = doc.activeElement || null;
    const pop = doc.createElement('div');
    pop.setAttribute('popover', 'manual');
    pop.setAttribute('data-addon-host-popover', '1');
    pop.setAttribute('data-addon-host-owner', pluginMeta.pluginId);
    pop.setAttribute('data-addon-host-slot', slotId);
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('translate', 'no');
    pop.setAttribute('data-addon-host-no-translate', 'true');
    for (let i = 0; i < extraNoTranslateAttributes.length; i++) {
      pop.setAttribute(extraNoTranslateAttributes[i], 'true');
    }
    if (pop.style) {
      pop.style.zIndex = String(2147483000 + stack.length + 1);
    }

    const useShadow = resolveUseShadow(pluginMeta, slotDef, opts);
    const { bodyEl, shadowRoot } = createSurfaceBody(pop, pluginMeta, slotId, useShadow);

    // R-2 + NB-4: Mount inside topmost non-closing connected modal <dialog> when active
    let mountParent = doc.body || doc.documentElement;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].kind === 'modal' && !stack[i].closing && stack[i].el && stack[i].el.isConnected !== false) {
        mountParent = stack[i].el;
        break;
      }
    }
    mountParent.appendChild(pop);

    const entry = {
      id: `popover-${++seq}`,
      kind: 'popover',
      pluginId: pluginMeta.pluginId,
      slotId,
      el: pop,
      bodyEl,
      shadowRoot,
      prevFocus,
      ignoreOutsideClickEls: Array.isArray(opts.ignoreOutsideClickEls) ? opts.ignoreOutsideClickEls : [],
      onClose: opts.onClose || null,
    };

    if (typeof pop.addEventListener === 'function') {
      // R-6b: Sync stack if popover is hidden externally via hidePopover()
      pop.addEventListener('toggle', (ev) => {
        if (ev && ev.newState === 'closed') {
          closeEntry(entry);
        }
      });
    }

    stack.push(entry);
    if (typeof pop.showPopover === 'function') {
      try {
        pop.showPopover();
      } catch (_e) {}
    }
    notifyPortalState(prevCount, stack.length);

    return Object.freeze({
      id: entry.id,
      element: pop,
      bodyEl,
      close: () => closeEntry(entry),
    });
  }

  function disposePluginPortals(pluginId) {
    for (const entry of stack.slice()) {
      if (entry.pluginId === pluginId) {
        closeEntry(entry);
      }
    }
  }

  return Object.freeze({
    openModal,
    openPopover,
    closeTop,
    disposePluginPortals,
    getStackSize: () => stack.length,
  });
}

module.exports = {
  createModalPortal,
};
