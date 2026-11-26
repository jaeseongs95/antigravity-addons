'use strict';

/**
 * Vendor-neutral Tier-1 Toast, Confirm & Prompt Manager (v3.0.0 — SOLID #0).
 *
 * - `showToast`: Shadow DOM live region (`role="status"`, `aria-live="polite"`), auto-dismiss,
 *   variant styling (`info | success | warning | error`), non-removable `Addon: <displayName>` label.
 * - `confirm` / `prompt`: Top Layer `<dialog>` with non-removable `Addon: <displayName>` badge,
 *   LIFO Escape / cancel handling, focus return, IME-safe Enter, and `ev.isTrusted` click check.
 */

const { buildOverlayChrome } = require('./ui-schema-renderer');

const TOAST_CSS = `
@keyframes ag-toast-in {
  from { opacity: 0; transform: translateY(8px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.ag-toast-host {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483500;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 240px;
  max-width: min(360px, calc(100vw - 32px));
  pointer-events: none;
  font-family: var(--ag-font, system-ui, -apple-system, sans-serif);
  -webkit-font-smoothing: antialiased;
}
.ag-toast {
  pointer-events: auto;
  background: var(--ag-surface, #161b24);
  color: var(--ag-text, #f1f5f9);
  border: 1px solid var(--ag-border-strong, rgba(255, 255, 255, 0.14));
  border-radius: 11px;
  padding: 10px 12px;
  box-shadow: var(--ag-shadow, 0 16px 36px rgba(0, 0, 0, 0.52));
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  display: flex;
  flex-direction: column;
  gap: 5px;
  animation: ag-toast-in 160ms ease-out;
}
.ag-toast[data-variant="success"] { border-left: 3px solid var(--ag-success, #4ade80); }
.ag-toast[data-variant="warning"] { border-left: 3px solid var(--ag-warning, #fbbf24); }
.ag-toast[data-variant="error"] { border-left: 3px solid var(--ag-danger, #ef4444); }
.ag-toast[data-variant="info"] { border-left: 3px solid var(--ag-accent, #38bdf8); }
.ag-toast-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ag-toast-head-left {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.ag-toast-head-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.ag-toast-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--ag-accent, #38bdf8);
}
.ag-toast[data-variant="success"] .ag-toast-dot { background: var(--ag-success, #4ade80); }
.ag-toast[data-variant="warning"] .ag-toast-dot { background: var(--ag-warning, #fbbf24); }
.ag-toast[data-variant="error"] .ag-toast-dot { background: var(--ag-danger, #ef4444); }
.ag-toast-title {
  font-weight: 600;
  font-size: 12px;
  color: var(--ag-text, #f1f5f9);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ag-toast-badge {
  font-size: 10px;
  font-weight: 500;
  color: var(--ag-text-muted, #94a3b8);
  background: rgba(148, 163, 184, 0.12);
  border: 1px solid var(--ag-border, rgba(255, 255, 255, 0.09));
  border-radius: 999px;
  padding: 1px 6px;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ag-toast-close {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--ag-text-muted, #94a3b8);
  border-radius: 6px;
  width: 22px;
  height: 22px;
  padding: 0;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease;
}
.ag-toast-close:hover {
  background: var(--ag-surface-hover, rgba(255, 255, 255, 0.09));
  color: var(--ag-text, #f1f5f9);
}
.ag-toast-close:focus-visible {
  outline: 2px solid var(--ag-primary, #2563eb);
  outline-offset: 1px;
}
.ag-toast-msg {
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--ag-text, #f1f5f9);
  padding-left: 13px;
}
.ag-toast-actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: 3px; }
.ag-toast-btn {
  appearance: none;
  border: 1px solid var(--ag-border-strong, rgba(255, 255, 255, 0.16));
  background: var(--ag-surface-elevated, rgba(255, 255, 255, 0.06));
  color: var(--ag-text, #f1f5f9);
  border-radius: 7px;
  padding: 4px 10px;
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.ag-toast-btn:hover {
  background: var(--ag-surface-hover, rgba(255, 255, 255, 0.11));
}
@media (prefers-reduced-motion: reduce) {
  .ag-toast { animation: none; }
  .ag-toast-close, .ag-toast-btn { transition: none; }
}
`;

const VARIANT_LABELS = Object.freeze({
  info: Object.freeze({ ko: '안내', en: 'Info' }),
  success: Object.freeze({ ko: '완료', en: 'Success' }),
  warning: Object.freeze({ ko: '주의', en: 'Warning' }),
  error: Object.freeze({ ko: '오류', en: 'Error' }),
});

function createToastAndDialogManager(
  doc,
  win,
  { themeAndI18n = null, extraNoTranslateAttributes = [], onPortalClaimChange = null } = {}
) {
  let toastHostEl = null;
  let toastShadowRoot = null;
  let toastListEl = null;
  const toastsByPlugin = new Map(); // pluginId -> Set<{ dismiss }>
  const dialogsByPlugin = new Map(); // pluginId -> Set<{ close }>
  let seq = 0;

  function applyNoTranslate(el) {
    if (!el || typeof el.setAttribute !== 'function') return;
    el.setAttribute('translate', 'no');
    el.setAttribute('data-addon-host-no-translate', 'true');
    el.setAttribute('data-addon-host-ignore', 'true');
    for (let i = 0; i < extraNoTranslateAttributes.length; i += 1) {
      el.setAttribute(extraNoTranslateAttributes[i], 'true');
    }
  }

  function ensureToastContainer() {
    if (toastListEl && toastHostEl && toastHostEl.isConnected !== false) return toastListEl;
    toastHostEl = doc.createElement('div');
    toastHostEl.setAttribute('data-addon-host-toast-root', '1');
    applyNoTranslate(toastHostEl);
    if (typeof toastHostEl.attachShadow === 'function') {
      toastShadowRoot = toastHostEl.attachShadow({ mode: 'open' });
      const styleEl = doc.createElement('style');
      const tokenCss = themeAndI18n ? themeAndI18n.buildTokenCss(themeAndI18n.getSnapshot().mode) : '';
      styleEl.textContent = `${tokenCss}\n${TOAST_CSS}`;
      toastShadowRoot.appendChild(styleEl);
      toastListEl = doc.createElement('div');
      toastListEl.className = 'ag-toast-host';
      toastListEl.setAttribute('role', 'region');
      toastListEl.setAttribute('aria-label', 'Addon Notifications');
      toastShadowRoot.appendChild(toastListEl);
    } else {
      toastListEl = toastHostEl;
    }
    const parent = doc.body || doc.documentElement;
    if (parent && typeof parent.appendChild === 'function') {
      parent.appendChild(toastHostEl);
    }
    return toastListEl;
  }

  function showToast(pluginMeta, opts = {}) {
    const spec = typeof opts === 'string' ? { message: opts } : opts || {};
    const list = ensureToastContainer();
    const id = `toast-${++seq}`;
    const variant = ['info', 'success', 'warning', 'error'].includes(spec.variant) ? spec.variant : 'info';

    const card = doc.createElement('div');
    card.className = 'ag-toast';
    card.setAttribute('role', 'status');
    card.setAttribute('aria-live', variant === 'error' ? 'assertive' : 'polite');
    card.setAttribute('data-variant', variant);
    card.setAttribute('data-addon-host-owner', pluginMeta.pluginId);
    card.setAttribute('data-toast-id', id);

    const resolveDefaultToastTitle = (v) => {
      const dict = VARIANT_LABELS[v] || VARIANT_LABELS.info;
      if (themeAndI18n && typeof themeAndI18n.t === 'function') {
        return themeAndI18n.t(dict.en, dict);
      }
      return dict.en;
    };

    const top = doc.createElement('div');
    top.className = 'ag-toast-top';

    const headLeft = doc.createElement('div');
    headLeft.className = 'ag-toast-head-left';
    const dotEl = doc.createElement('span');
    dotEl.className = 'ag-toast-dot';
    dotEl.setAttribute('aria-hidden', 'true');
    const titleEl = doc.createElement('span');
    titleEl.className = 'ag-toast-title';
    titleEl.textContent = String(spec.title || resolveDefaultToastTitle(variant));
    headLeft.appendChild(dotEl);
    headLeft.appendChild(titleEl);

    let timer = null;
    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (card.parentNode && typeof card.parentNode.removeChild === 'function') {
        card.parentNode.removeChild(card);
      }
      const set = toastsByPlugin.get(pluginMeta.pluginId);
      if (set) set.delete(handle);
    };

    const headRight = doc.createElement('div');
    headRight.className = 'ag-toast-head-right';
    const badgeEl = doc.createElement('span');
    badgeEl.className = 'ag-toast-badge';
    badgeEl.setAttribute('data-addon-host-attribution', '1');
    badgeEl.textContent = `Addon: ${String(pluginMeta.displayName || pluginMeta.pluginId)}`;
    const closeBtn = doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ag-toast-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', (ev) => {
      if (ev && ev.isTrusted === false) return;
      dismiss();
    });
    headRight.appendChild(badgeEl);
    headRight.appendChild(closeBtn);

    top.appendChild(headLeft);
    top.appendChild(headRight);
    card.appendChild(top);

    const msgEl = doc.createElement('div');
    msgEl.className = 'ag-toast-msg';
    msgEl.textContent = String(spec.message || '');
    card.appendChild(msgEl);

    if (spec.action && typeof spec.action.label === 'string' && typeof spec.action.onClick === 'function') {
      const actionsRow = doc.createElement('div');
      actionsRow.className = 'ag-toast-actions';
      const actBtn = doc.createElement('button');
      actBtn.type = 'button';
      actBtn.className = 'ag-toast-btn';
      actBtn.textContent = spec.action.label;
      actBtn.addEventListener('click', (ev) => {
        if (ev && ev.isTrusted === false) return;
        try {
          spec.action.onClick();
        } catch (_e) {}
        dismiss();
      });
      actionsRow.appendChild(actBtn);
      card.appendChild(actionsRow);
    }

    list.appendChild(card);

    const durationMs = Number.isFinite(Number(spec.durationMs)) ? Number(spec.durationMs) : 4000;
    if (durationMs > 0) {
      timer = setTimeout(dismiss, durationMs);
    }

    const handle = Object.freeze({ id, dismiss });
    let set = toastsByPlugin.get(pluginMeta.pluginId);
    if (!set) {
      set = new Set();
      toastsByPlugin.set(pluginMeta.pluginId, set);
    }
    set.add(handle);
    return handle;
  }

  function openSimpleDialog(pluginMeta, mode, opts = {}) {
    return new Promise((resolve) => {
      const prevFocus = doc.activeElement || null;
      const dlg = doc.createElement('dialog');
      dlg.setAttribute('data-addon-host-modal-dialog', '1');
      dlg.setAttribute('data-addon-host-owner', pluginMeta.pluginId);
      dlg.setAttribute('role', 'dialog');
      dlg.setAttribute('aria-modal', 'true');
      applyNoTranslate(dlg);
      if (dlg.style) {
        dlg.style.position = 'fixed';
        dlg.style.inset = '0';
        dlg.style.margin = 'auto';
        dlg.style.padding = '0';
        dlg.style.border = 'none';
        dlg.style.background = 'transparent';
        dlg.style.maxWidth = 'min(420px, calc(100vw - 24px))';
        dlg.style.zIndex = '2147483400';
      }

      const wrap = doc.createElement('div');
      dlg.appendChild(wrap);
      const sr = typeof wrap.attachShadow === 'function' ? wrap.attachShadow({ mode: 'open' }) : wrap;
      const tokenCss = themeAndI18n ? themeAndI18n.buildTokenCss(themeAndI18n.getSnapshot().mode) : '';

      let settled = false;
      seq += 1;
      const claimId = `v3:dialog:${pluginMeta.pluginId}:${seq}`;
      const notifyPortalClaim = (active) => {
        if (typeof onPortalClaimChange === 'function') {
          try {
            onPortalClaimChange(claimId, active);
          } catch (_e) {}
        }
      };
      const finish = (value) => {
        if (settled) return;
        settled = true;
        notifyPortalClaim(false);
        const set = dialogsByPlugin.get(pluginMeta.pluginId);
        if (set) set.delete(tracker);
        try {
          if (typeof dlg.close === 'function' && dlg.open) dlg.close();
        } catch (_e) {}
        if (dlg.parentNode && typeof dlg.parentNode.removeChild === 'function') {
          dlg.parentNode.removeChild(dlg);
        }
        if (prevFocus && typeof prevFocus.focus === 'function') {
          try {
            prevFocus.focus();
          } catch (_e) {}
        }
        resolve(value);
      };

      const { body } = buildOverlayChrome(doc, sr, {
        title: String(opts.title || (mode === 'prompt' ? 'Input Required' : 'Confirm')),
        displayName: pluginMeta.displayName || pluginMeta.pluginId,
        tokenCss,
        closable: true,
        onClose: () => finish(mode === 'prompt' ? null : false),
      });

      if (opts.message) {
        const msg = doc.createElement('p');
        msg.className = 'ag-text';
        msg.textContent = String(opts.message);
        body.appendChild(msg);
      }

      let inputEl = null;
      if (mode === 'prompt') {
        inputEl = doc.createElement('input');
        inputEl.type = opts.inputType === 'password' ? 'password' : 'text';
        inputEl.className = 'ag-input';
        inputEl.value = opts.defaultValue !== undefined && opts.defaultValue !== null ? String(opts.defaultValue) : '';
        if (opts.placeholder) inputEl.setAttribute('placeholder', String(opts.placeholder));
        inputEl.addEventListener('keydown', (ev) => {
          if (!ev || ev.key !== 'Enter') return;
          if (ev.isComposing || ev.keyCode === 229 || ev.isTrusted === false) return;
          finish(inputEl.value);
        });
        body.appendChild(inputEl);
      }

      const btnRow = doc.createElement('div');
      btnRow.className = 'ag-row';
      if (btnRow.style) btnRow.style.justifyContent = 'flex-end';

      const cancelBtn = doc.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'ag-btn';
      cancelBtn.setAttribute('data-ag-dialog-cancel', '1');
      cancelBtn.textContent = String(opts.cancelLabel || 'Cancel');
      cancelBtn.addEventListener('click', (ev) => {
        if (ev && ev.isTrusted === false) return;
        finish(mode === 'prompt' ? null : false);
      });

      const confirmBtn = doc.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'ag-btn';
      confirmBtn.setAttribute('data-ag-dialog-confirm', '1');
      confirmBtn.setAttribute('data-variant', opts.destructive ? 'danger' : 'primary');
      confirmBtn.textContent = String(opts.confirmLabel || 'OK');
      confirmBtn.addEventListener('click', (ev) => {
        if (ev && ev.isTrusted === false) return;
        finish(mode === 'prompt' ? (inputEl ? inputEl.value : '') : true);
      });

      btnRow.appendChild(cancelBtn);
      btnRow.appendChild(confirmBtn);
      body.appendChild(btnRow);

      if (typeof dlg.addEventListener === 'function') {
        dlg.addEventListener('cancel', (ev) => {
          if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
          finish(mode === 'prompt' ? null : false);
        });
      }

      const tracker = { close: () => finish(mode === 'prompt' ? null : false) };
      let set = dialogsByPlugin.get(pluginMeta.pluginId);
      if (!set) {
        set = new Set();
        dialogsByPlugin.set(pluginMeta.pluginId, set);
      }
      set.add(tracker);

      const parent = doc.body || doc.documentElement;
      if (parent && typeof parent.appendChild === 'function') {
        parent.appendChild(dlg);
      }
      notifyPortalClaim(true);
      if (typeof dlg.showModal === 'function') {
        try {
          dlg.showModal();
        } catch (_e) {}
      }
      if (inputEl && typeof inputEl.focus === 'function') {
        try {
          inputEl.focus();
        } catch (_e) {}
      }
    });
  }

  function confirm(pluginMeta, opts) {
    return openSimpleDialog(pluginMeta, 'confirm', typeof opts === 'string' ? { message: opts } : opts || {});
  }

  function prompt(pluginMeta, opts) {
    return openSimpleDialog(pluginMeta, 'prompt', typeof opts === 'string' ? { message: opts } : opts || {});
  }

  function disposePlugin(pluginId) {
    const tSet = toastsByPlugin.get(pluginId);
    if (tSet) {
      Array.from(tSet).forEach((h) => h.dismiss());
      toastsByPlugin.delete(pluginId);
    }
    const dSet = dialogsByPlugin.get(pluginId);
    if (dSet) {
      Array.from(dSet).forEach((d) => d.close());
      dialogsByPlugin.delete(pluginId);
    }
  }

  return Object.freeze({
    showToast,
    confirm,
    prompt,
    disposePlugin,
  });
}

module.exports = {
  createToastAndDialogManager,
};
