'use strict';

/**
 * Vendor-neutral Tier-2 Declarative UI Schema Renderer & ID-based Patch Engine (v3.0.0 — SOLID #0).
 *
 * - Strictly ZERO HTML sinks (`innerHTML`, `outerHTML`, `insertAdjacentHTML` = 0).
 * - Strictly ZERO `eval` / `new Function`.
 * - Renders validated 17-primitive JSON trees using `--ag-*` semantic CSS tokens.
 * - Supports static JSON `visibleWhen` / `disabledWhen` predicates evaluated against current state.
 * - Supports `update(nextTree, nextState)` with ID-based in-place DOM patching so focused inputs
 *   and scroll positions are preserved across updates.
 * - Enforces `ev.isTrusted !== false` on user actions and IME-safe Enter handling.
 */

const {
  validateUiTree,
  evaluateUiCondition,
  readStateField,
} = require('../../core/ui-schema-validator');

const SCHEMA_UI_CSS = `
:host {
  display: flex;
  flex-direction: column;
  max-height: inherit;
  min-height: 0;
  width: 100%;
}
:host, .ag-ui-shell {
  box-sizing: border-box;
  font-family: var(--ag-font, system-ui, -apple-system, sans-serif);
  color: var(--ag-text, #f1f5f9);
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
*, *::before, *::after { box-sizing: border-box; }
.ag-ui-shell {
  background: var(--ag-surface, #161b24);
  border: 1px solid var(--ag-border-strong, rgba(255, 255, 255, 0.16));
  border-radius: var(--ag-radius, 12px);
  box-shadow: var(--ag-shadow, 0 20px 48px rgba(0, 0, 0, 0.56));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  width: 100%;
  max-height: inherit;
  min-height: 0;
}
.ag-ui-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 13px 16px;
  border-bottom: 1px solid var(--ag-border, rgba(255, 255, 255, 0.09));
  background: var(--ag-surface-elevated, rgba(255, 255, 255, 0.03));
  flex: 0 0 auto;
}
.ag-ui-header-meta { display: flex; align-items: center; gap: 10px; min-width: 0; }
.ag-ui-header-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.ag-ui-lang-switch {
  display: inline-flex;
  align-items: center;
  padding: 2px;
  border-radius: 8px;
  border: 1px solid var(--ag-border-strong, rgba(255, 255, 255, 0.14));
  background: var(--ag-surface-elevated, rgba(255, 255, 255, 0.04));
  gap: 2px;
  flex-shrink: 0;
}
.ag-ui-lang-btn {
  appearance: none;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--ag-text-muted, #94a3b8);
  font-size: 11.5px;
  font-weight: 500;
  font-family: inherit;
  padding: 4px 8px;
  cursor: pointer;
  line-height: 1.2;
  white-space: nowrap;
  transition: background-color 120ms ease, color 120ms ease;
}
.ag-ui-lang-btn:hover {
  color: var(--ag-text, #f1f5f9);
}
.ag-ui-lang-btn[aria-pressed="true"] {
  background: var(--ag-primary, #2563eb);
  color: var(--ag-primary-fg, #ffffff);
  font-weight: 600;
}
.ag-ui-lang-btn:focus-visible {
  outline: 2px solid var(--ag-focus-ring, rgba(59, 130, 246, 0.32));
  outline-offset: 1px;
}
.ag-ui-title {
  font-weight: 600;
  font-size: 14.5px;
  letter-spacing: -0.01em;
  color: var(--ag-text, #f1f5f9);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ag-ui-attribution {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 500;
  background: rgba(148, 163, 184, 0.12);
  color: var(--ag-text-muted, #94a3b8);
  border: 1px solid var(--ag-border, rgba(255, 255, 255, 0.09));
  flex-shrink: 0;
}
.ag-ui-close {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  background: transparent;
  color: var(--ag-text-muted, #94a3b8);
  border-radius: 8px;
  width: 28px;
  height: 28px;
  min-width: 28px;
  min-height: 28px;
  padding: 0;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  transition: background-color 140ms ease, color 140ms ease, border-color 140ms ease;
}
.ag-ui-close:hover {
  background: var(--ag-surface-hover, rgba(255, 255, 255, 0.08));
  color: var(--ag-text, #f1f5f9);
}
.ag-ui-close:focus-visible {
  outline: 2px solid var(--ag-primary, #2563eb);
  outline-offset: 2px;
}
.ag-ui-body {
  padding: 16px;
  overflow-y: auto;
  flex: 1 1 auto; min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  scrollbar-width: thin;
  scrollbar-color: var(--ag-scrollbar-thumb, rgba(148, 163, 184, 0.28)) transparent;
}
.ag-ui-body::-webkit-scrollbar,
.ag-textarea::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
.ag-ui-body::-webkit-scrollbar-track,
.ag-textarea::-webkit-scrollbar-track {
  background: transparent;
}
.ag-ui-body::-webkit-scrollbar-thumb,
.ag-textarea::-webkit-scrollbar-thumb {
  background: var(--ag-scrollbar-thumb, rgba(148, 163, 184, 0.28));
  border-radius: 999px;
}
.ag-ui-body::-webkit-scrollbar-thumb:hover,
.ag-textarea::-webkit-scrollbar-thumb:hover {
  background: var(--ag-scrollbar-thumb-hover, rgba(148, 163, 184, 0.46));
}
.ag-ui-body::-webkit-scrollbar-corner,
.ag-textarea::-webkit-scrollbar-corner {
  background: transparent;
}
.ag-stack { display: flex; flex-direction: column; gap: 12px; }
.ag-row { display: flex; flex-direction: row; align-items: center; gap: 8px; flex-wrap: wrap; }
.ag-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid var(--ag-border, rgba(255, 255, 255, 0.09));
  border-radius: 10px;
  background: var(--ag-surface-elevated, rgba(255, 255, 255, 0.04));
}
.ag-section-title {
  font-weight: 600;
  font-size: 13px;
  letter-spacing: -0.005em;
  color: var(--ag-text, #f1f5f9);
}
.ag-heading { margin: 0; font-weight: 600; color: var(--ag-text, #f1f5f9); letter-spacing: -0.01em; }
.ag-text { margin: 0; color: var(--ag-text, #f1f5f9); line-height: 1.5; }
.ag-text[data-tone="muted"] { color: var(--ag-text-muted, #94a3b8); font-size: 12px; line-height: 1.5; }
.ag-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  background: rgba(148, 163, 184, 0.14);
  border: 1px solid var(--ag-border, rgba(255, 255, 255, 0.09));
  color: var(--ag-text, #f1f5f9);
}
.ag-badge[data-variant="success"] {
  background: rgba(34, 197, 94, 0.14);
  border-color: rgba(34, 197, 94, 0.28);
  color: var(--ag-success, #4ade80);
}
.ag-badge[data-variant="warning"] {
  background: rgba(245, 158, 11, 0.14);
  border-color: rgba(245, 158, 11, 0.28);
  color: var(--ag-warning, #fbbf24);
}
.ag-badge[data-variant="danger"] {
  background: rgba(239, 68, 68, 0.14);
  border-color: rgba(239, 68, 68, 0.28);
  color: var(--ag-danger, #ef4444);
}
.ag-divider { border: 0; border-top: 1px solid var(--ag-border, rgba(255, 255, 255, 0.09)); margin: 4px 0; }
.ag-alert {
  padding: 10px 12px;
  border-radius: 9px;
  font-size: 12px;
  line-height: 1.5;
  background: rgba(56, 189, 248, 0.08);
  border: 1px solid rgba(56, 189, 248, 0.24);
  color: var(--ag-text, #f1f5f9);
}
.ag-alert[data-variant="danger"] {
  background: rgba(239, 68, 68, 0.1);
  border-color: rgba(239, 68, 68, 0.34);
  color: var(--ag-danger, #ef4444);
}
.ag-alert[data-variant="warning"] {
  background: rgba(245, 158, 11, 0.1);
  border-color: rgba(245, 158, 11, 0.34);
  color: var(--ag-warning, #fbbf24);
}
.ag-alert[data-variant="success"] {
  background: rgba(34, 197, 94, 0.1);
  border-color: rgba(34, 197, 94, 0.34);
  color: var(--ag-success, #4ade80);
}
.ag-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid var(--ag-border-strong, rgba(255, 255, 255, 0.16));
  background: var(--ag-surface-elevated, rgba(255, 255, 255, 0.06));
  color: var(--ag-text, #f1f5f9);
  border-radius: 8px;
  min-height: 34px;
  padding: 7px 14px;
  font-size: 12.5px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: background-color 140ms ease, border-color 140ms ease, box-shadow 140ms ease, opacity 140ms ease;
}
.ag-btn:hover:not(:disabled) {
  background: var(--ag-surface-hover, rgba(255, 255, 255, 0.11));
  border-color: rgba(148, 163, 184, 0.34);
}
.ag-btn:focus-visible {
  outline: 2px solid var(--ag-primary, #2563eb);
  outline-offset: 2px;
}
.ag-btn[data-variant="primary"] {
  background: var(--ag-primary, #2563eb);
  color: var(--ag-primary-fg, #ffffff);
  border-color: transparent;
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.14);
}
.ag-btn[data-variant="primary"]:hover:not(:disabled) {
  background: var(--ag-primary-hover, #3b82f6);
  border-color: transparent;
}
.ag-btn[data-variant="danger"] {
  background: rgba(239, 68, 68, 0.14);
  color: var(--ag-danger, #ef4444);
  border-color: rgba(239, 68, 68, 0.34);
}
.ag-btn[data-variant="danger"]:hover:not(:disabled) {
  background: var(--ag-danger, #ef4444);
  color: #ffffff;
  border-color: transparent;
}
.ag-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.ag-field { display: flex; flex-direction: column; gap: 6px; }
.ag-field-label { font-size: 12px; font-weight: 500; color: var(--ag-text-muted, #94a3b8); }
.ag-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 2px 0;
  min-height: 28px;
  cursor: pointer;
}
.ag-toggle-row .ag-field-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--ag-text, #f1f5f9);
}
.ag-toggle-row input[type="checkbox"] {
  appearance: none;
  -webkit-appearance: none;
  position: relative;
  width: 38px;
  height: 22px;
  margin: 0;
  border-radius: 999px;
  border: 1px solid var(--ag-border-strong, rgba(255, 255, 255, 0.16));
  background: rgba(148, 163, 184, 0.28);
  cursor: pointer;
  flex-shrink: 0;
  transition: background-color 150ms ease, border-color 150ms ease;
}
.ag-toggle-row input[type="checkbox"]::before {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #ffffff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.32);
  transition: transform 150ms ease;
}
.ag-toggle-row input[type="checkbox"]:checked {
  background: var(--ag-primary, #2563eb);
  border-color: transparent;
}
.ag-toggle-row input[type="checkbox"]:checked::before {
  transform: translateX(16px);
}
.ag-toggle-row input[type="checkbox"]:focus-visible {
  outline: 2px solid var(--ag-primary, #2563eb);
  outline-offset: 2px;
}
.ag-toggle-row input[type="checkbox"]:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.ag-input, .ag-textarea, .ag-select {
  width: 100%;
  background: var(--ag-input-bg, rgba(9, 12, 18, 0.78));
  color: var(--ag-text, #f1f5f9);
  border: 1px solid var(--ag-border-strong, rgba(255, 255, 255, 0.16));
  border-radius: 8px;
  padding: 8px 11px;
  font-size: 13px;
  line-height: 1.45;
  font-family: inherit;
  transition: border-color 140ms ease, box-shadow 140ms ease, background-color 140ms ease;
}
.ag-input:hover:not(:disabled),
.ag-textarea:hover:not(:disabled),
.ag-select:hover:not(:disabled) {
  border-color: rgba(148, 163, 184, 0.36);
}
.ag-input:focus,
.ag-textarea:focus,
.ag-select:focus {
  outline: none;
  border-color: var(--ag-primary-hover, #3b82f6);
  box-shadow: 0 0 0 3px var(--ag-focus-ring, rgba(59, 130, 246, 0.32));
}
.ag-textarea {
  resize: vertical;
  min-height: 92px;
  line-height: 1.55;
  scrollbar-width: thin;
  scrollbar-color: var(--ag-scrollbar-thumb, rgba(148, 163, 184, 0.28)) transparent;
}
.ag-select {
  appearance: none;
  -webkit-appearance: none;
  padding-right: 32px;
  cursor: pointer;
  background-image:
    linear-gradient(45deg, transparent 50%, var(--ag-text-muted, #94a3b8) 50%),
    linear-gradient(135deg, var(--ag-text-muted, #94a3b8) 50%, transparent 50%);
  background-position:
    calc(100% - 16px) calc(50% + 1px),
    calc(100% - 11px) calc(50% + 1px);
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
}
.ag-select option {
  background: var(--ag-surface, #161b24);
  color: var(--ag-text, #f1f5f9);
}
.ag-segmented {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  width: fit-content;
  max-width: 100%;
  flex-wrap: wrap;
  border-radius: 8px;
  border: 1px solid var(--ag-border-strong, rgba(255, 255, 255, 0.16));
  background: var(--ag-input-bg, rgba(9, 12, 18, 0.78));
}
.ag-segmented-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--ag-text-muted, #94a3b8);
  border-radius: 6px;
  min-height: 28px;
  padding: 5px 11px;
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  line-height: 1.2;
  cursor: pointer;
  transition: background-color 140ms ease, color 140ms ease, opacity 140ms ease;
}
.ag-segmented-btn:hover:not(:disabled):not([aria-pressed="true"]) {
  color: var(--ag-text, #f1f5f9);
  background: var(--ag-surface-hover, rgba(255, 255, 255, 0.08));
}
.ag-segmented-btn[aria-pressed="true"] {
  background: var(--ag-primary, #2563eb);
  color: var(--ag-primary-fg, #ffffff);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.24);
}
.ag-segmented-btn:focus-visible {
  outline: 2px solid var(--ag-primary, #2563eb);
  outline-offset: 1px;
}
.ag-segmented-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.ag-progress {
  appearance: none;
  -webkit-appearance: none;
  width: 100%;
  height: 6px;
  border: none;
  border-radius: 999px;
  overflow: hidden;
  background: var(--ag-border-strong, rgba(255, 255, 255, 0.14));
}
.ag-progress::-webkit-progress-bar {
  background: var(--ag-border-strong, rgba(255, 255, 255, 0.14));
  border-radius: 999px;
}
.ag-progress::-webkit-progress-value {
  background: var(--ag-primary-hover, #3b82f6);
  border-radius: 999px;
}
.ag-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.ag-list-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--ag-border, rgba(255, 255, 255, 0.09));
  background: var(--ag-surface-elevated, rgba(255, 255, 255, 0.03));
}
@media (prefers-reduced-motion: reduce) {
  .ag-ui-close,
  .ag-btn,
  .ag-toggle-row input[type="checkbox"],
  .ag-toggle-row input[type="checkbox"]::before,
  .ag-input,
  .ag-textarea,
  .ag-select,
  .ag-segmented-btn {
    transition: none;
  }
}
[hidden] { display: none !important; }
`;

function setStateField(state, fieldPath, nextVal) {
  if (!state || typeof state !== 'object' || typeof fieldPath !== 'string' || !fieldPath) return;
  const parts = fieldPath.split('.');
  let cur = state;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const k = parts[i];
    if (!k || k === '__proto__' || k === 'constructor' || k === 'prototype') return;
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  const last = parts[parts.length - 1];
  if (!last || last === '__proto__' || last === 'constructor' || last === 'prototype') return;
  cur[last] = nextVal;
}

function createSchemaUiController(doc, containerEl, {
  tree,
  state = {},
  onChange = null,
  onAction = null,
} = {}) {
  const validation = validateUiTree(tree);
  if (!validation.ok) {
    throw new Error(`${validation.reason}: ${(validation.errors || []).join('; ')}`);
  }

  let currentTree = tree;
  let currentState = state && typeof state === 'object' ? { ...state } : {};
  const elementsById = new Map(); // nodeId -> { nodeType, wrapperEl, controlEl, labelEl }

  function emitChange(field, value) {
    if (field) {
      setStateField(currentState, field, value);
    }
    if (typeof onChange === 'function') {
      try {
        onChange({ field, value, state: { ...currentState } });
      } catch (_e) {}
    }
    // Re-evaluate visibleWhen / disabledWhen across all mounted nodes in place
    syncVisibilityAndDisabled(currentTree);
  }

  function emitAction(actionId, payload) {
    if (typeof onAction === 'function') {
      try {
        onAction({ actionId, payload, state: { ...currentState } });
      } catch (_e) {}
    }
  }

  function applyCommonFlags(wrapperEl, controlEl, node) {
    const visible = node.visibleWhen ? evaluateUiCondition(node.visibleWhen, currentState) : true;
    const disabled = Boolean(node.disabled) || (node.disabledWhen ? evaluateUiCondition(node.disabledWhen, currentState) : false);
    if (visible) {
      if (typeof wrapperEl.removeAttribute === 'function') wrapperEl.removeAttribute('hidden');
      wrapperEl.hidden = false;
    } else {
      if (typeof wrapperEl.setAttribute === 'function') wrapperEl.setAttribute('hidden', 'true');
      wrapperEl.hidden = true;
    }
    if (controlEl && 'disabled' in controlEl) {
      controlEl.disabled = disabled;
    }
    if (
      controlEl &&
      typeof controlEl.getAttribute === 'function' &&
      controlEl.getAttribute('data-ag-segmented') === '1'
    ) {
      if (typeof controlEl.setAttribute === 'function') {
        controlEl.setAttribute('aria-disabled', disabled ? 'true' : 'false');
      }
      const kids = controlEl.childNodes || [];
      for (let i = 0; i < kids.length; i += 1) {
        const kid = kids[i];
        if (kid && 'disabled' in kid) {
          kid.disabled = disabled;
        }
      }
    }
  }

  function renderSegmentedButtons(targetEl, optionsList, activeValue, fieldName) {
    while (targetEl.firstChild) targetEl.removeChild(targetEl.firstChild);
    const activeStr = activeValue !== undefined && activeValue !== null ? String(activeValue) : '';
    const opts = Array.isArray(optionsList) ? optionsList : [];
    for (let i = 0; i < opts.length; i += 1) {
      const o = opts[i];
      const optVal = String(o && typeof o === 'object' ? o.value : o);
      const optLabel = String(o && typeof o === 'object' ? o.label || o.value : o);
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'ag-segmented-btn';
      btn.setAttribute('data-ag-segment-value', optVal);
      btn.setAttribute('aria-pressed', activeStr === optVal ? 'true' : 'false');
      btn.textContent = optLabel;
      btn.addEventListener('click', (ev) => {
        if (ev && ev.isTrusted === false) return;
        if (btn.disabled) return;
        const kids = targetEl.childNodes || [];
        for (let j = 0; j < kids.length; j += 1) {
          const kid = kids[j];
          if (kid && typeof kid.setAttribute === 'function') {
            kid.setAttribute('aria-pressed', kid === btn ? 'true' : 'false');
          }
        }
        emitChange(fieldName, optVal);
      });
      targetEl.appendChild(btn);
    }
  }

  function syncVisibilityAndDisabled(node) {
    if (!node || typeof node !== 'object') return;
    if (node.id && elementsById.has(node.id)) {
      const ref = elementsById.get(node.id);
      applyCommonFlags(ref.wrapperEl, ref.controlEl, node);
    }
    if (Array.isArray(node.children)) {
      for (let i = 0; i < node.children.length; i += 1) {
        syncVisibilityAndDisabled(node.children[i]);
      }
    }
  }

  function patchExistingNode(ref, node) {
    if (!ref || ref.nodeType !== node.type) return false;
    applyCommonFlags(ref.wrapperEl, ref.controlEl, node);
    const val = node.field ? readStateField(currentState, node.field) : node.value;

    switch (node.type) {
      case 'heading':
      case 'text':
      case 'badge':
      case 'alert':
        ref.wrapperEl.textContent = String(node.text !== undefined ? node.text : node.label || '');
        if (node.variant) ref.wrapperEl.setAttribute('data-variant', String(node.variant));
        if (node.tone) ref.wrapperEl.setAttribute('data-tone', String(node.tone));
        return true;
      case 'button':
        ref.controlEl.textContent = String(node.label || node.text || 'Action');
        if (node.variant) ref.controlEl.setAttribute('data-variant', String(node.variant));
        else if (typeof ref.controlEl.removeAttribute === 'function') ref.controlEl.removeAttribute('data-variant');
        return true;
      case 'toggle':
        if (ref.labelEl) ref.labelEl.textContent = String(node.label || '');
        if (ref.controlEl) ref.controlEl.checked = Boolean(val);
        return true;
      case 'input':
      case 'textarea': {
        if (ref.labelEl) ref.labelEl.textContent = String(node.label || '');
        const activeEl =
          ref.controlEl &&
          typeof ref.controlEl.getRootNode === 'function' &&
          ref.controlEl.getRootNode() &&
          ref.controlEl.getRootNode().activeElement
            ? ref.controlEl.getRootNode().activeElement
            : doc.activeElement;
        if (ref.controlEl && activeEl !== ref.controlEl) {
          ref.controlEl.value = val !== undefined && val !== null ? String(val) : '';
        }
        if (node.placeholder !== undefined && ref.controlEl) {
          ref.controlEl.setAttribute('placeholder', String(node.placeholder));
        }
        return true;
      }
      case 'select':
        if (ref.labelEl) ref.labelEl.textContent = String(node.label || '');
        if (ref.controlEl) {
          // Rebuild options only when changed
          const optSig = JSON.stringify(node.options || []);
          if (ref.optSig !== optSig) {
            while (ref.controlEl.firstChild) ref.controlEl.removeChild(ref.controlEl.firstChild);
            const opts = Array.isArray(node.options) ? node.options : [];
            for (let i = 0; i < opts.length; i += 1) {
              const o = opts[i];
              const optEl = doc.createElement('option');
              optEl.value = String(o && typeof o === 'object' ? o.value : o);
              optEl.textContent = String(o && typeof o === 'object' ? o.label || o.value : o);
              ref.controlEl.appendChild(optEl);
            }
            ref.optSig = optSig;
          }
          if (val !== undefined && val !== null) ref.controlEl.value = String(val);
        }
        return true;
      case 'segmented': {
        if (ref.labelEl) ref.labelEl.textContent = String(node.label || '');
        if (ref.controlEl) {
          const opts = Array.isArray(node.options) ? node.options : [];
          const optSig = JSON.stringify(opts);
          if (ref.optSig !== optSig) {
            renderSegmentedButtons(ref.controlEl, opts, val, node.field || node.id);
            ref.optSig = optSig;
          } else {
            const activeStr = val !== undefined && val !== null ? String(val) : '';
            const kids = ref.controlEl.childNodes || [];
            for (let i = 0; i < kids.length; i += 1) {
              const kid = kids[i];
              if (kid && typeof kid.getAttribute === 'function' && typeof kid.setAttribute === 'function') {
                kid.setAttribute(
                  'aria-pressed',
                  kid.getAttribute('data-ag-segment-value') === activeStr ? 'true' : 'false'
                );
              }
            }
          }
          applyCommonFlags(ref.wrapperEl, ref.controlEl, node);
        }
        return true;
      }
      case 'slider':
        if (ref.labelEl) ref.labelEl.textContent = String(node.label || '');
        if (ref.controlEl && val !== undefined && val !== null) {
          ref.controlEl.value = String(val);
        }
        return true;
      case 'progress':
        if (ref.controlEl) {
          ref.controlEl.value = Number.isFinite(Number(node.value)) ? Number(node.value) : 0;
          ref.controlEl.max = Number.isFinite(Number(node.max)) ? Number(node.max) : 100;
        }
        return true;
      case 'section':
        if (ref.labelEl && node.title !== undefined) {
          ref.labelEl.textContent = String(node.title);
        }
        return true;
      case 'list': {
        const listSig = JSON.stringify(node.items || []);
        if (ref.optSig !== listSig && ref.wrapperEl) {
          while (ref.wrapperEl.firstChild) ref.wrapperEl.removeChild(ref.wrapperEl.firstChild);
          const items = Array.isArray(node.items) ? node.items : [];
          for (let i = 0; i < items.length; i += 1) {
            const item = items[i];
            const li = doc.createElement('li');
            li.className = 'ag-list-item';
            const textSpan = doc.createElement('span');
            textSpan.textContent = String(item && typeof item === 'object' ? item.label || item.text || '' : item);
            li.appendChild(textSpan);
            if (item && typeof item === 'object' && item.actionId) {
              const btn = doc.createElement('button');
              btn.type = 'button';
              btn.className = 'ag-btn';
              btn.textContent = String(item.actionLabel || 'Open');
              btn.addEventListener('click', (ev) => {
                if (ev && ev.isTrusted === false) return;
                emitAction(item.actionId, item.payload !== undefined ? item.payload : item.id);
              });
              li.appendChild(btn);
            }
            ref.wrapperEl.appendChild(li);
          }
          ref.optSig = listSig;
        }
        return true;
      }
      default:
        return true;
    }
  }

  function buildNodeElement(node) {
    let wrapperEl = null;
    let controlEl = null;
    let labelEl = null;
    let childrenMountEl = null;
    let optSig = null;
    const stateVal = node.field ? readStateField(currentState, node.field) : node.value;

    switch (node.type) {
      case 'stack': {
        wrapperEl = doc.createElement('div');
        wrapperEl.className = 'ag-stack';
        childrenMountEl = wrapperEl;
        break;
      }
      case 'row': {
        wrapperEl = doc.createElement('div');
        wrapperEl.className = 'ag-row';
        childrenMountEl = wrapperEl;
        break;
      }
      case 'section': {
        wrapperEl = doc.createElement('section');
        wrapperEl.className = 'ag-section';
        if (node.title) {
          labelEl = doc.createElement('div');
          labelEl.className = 'ag-section-title';
          labelEl.textContent = String(node.title);
          wrapperEl.appendChild(labelEl);
        }
        childrenMountEl = wrapperEl;
        break;
      }
      case 'heading': {
        const level = Number.isInteger(node.level) && node.level >= 1 && node.level <= 6 ? node.level : 3;
        wrapperEl = doc.createElement(`h${level}`);
        wrapperEl.className = 'ag-heading';
        wrapperEl.textContent = String(node.text || '');
        break;
      }
      case 'text': {
        wrapperEl = doc.createElement('p');
        wrapperEl.className = 'ag-text';
        if (node.tone) wrapperEl.setAttribute('data-tone', String(node.tone));
        wrapperEl.textContent = String(node.text || '');
        break;
      }
      case 'badge': {
        wrapperEl = doc.createElement('span');
        wrapperEl.className = 'ag-badge';
        if (node.variant) wrapperEl.setAttribute('data-variant', String(node.variant));
        wrapperEl.textContent = String(node.text || '');
        break;
      }
      case 'divider': {
        wrapperEl = doc.createElement('hr');
        wrapperEl.className = 'ag-divider';
        break;
      }
      case 'alert': {
        wrapperEl = doc.createElement('div');
        wrapperEl.className = 'ag-alert';
        wrapperEl.setAttribute('role', 'status');
        if (node.variant) wrapperEl.setAttribute('data-variant', String(node.variant));
        wrapperEl.textContent = String(node.text || '');
        break;
      }
      case 'button': {
        controlEl = doc.createElement('button');
        controlEl.type = 'button';
        controlEl.className = 'ag-btn';
        if (node.variant) controlEl.setAttribute('data-variant', String(node.variant));
        controlEl.textContent = String(node.label || node.text || 'Action');
        controlEl.addEventListener('click', (ev) => {
          if (ev && ev.isTrusted === false) return;
          emitAction(node.actionId || node.id || 'action', node.payload);
        });
        wrapperEl = controlEl;
        break;
      }
      case 'toggle': {
        wrapperEl = doc.createElement('label');
        wrapperEl.className = 'ag-toggle-row';
        labelEl = doc.createElement('span');
        labelEl.className = 'ag-field-label';
        labelEl.textContent = String(node.label || '');
        controlEl = doc.createElement('input');
        controlEl.type = 'checkbox';
        controlEl.checked = Boolean(stateVal);
        controlEl.addEventListener('change', (ev) => {
          if (ev && ev.isTrusted === false) return;
          emitChange(node.field || node.id, Boolean(controlEl.checked));
        });
        wrapperEl.appendChild(labelEl);
        wrapperEl.appendChild(controlEl);
        break;
      }
      case 'input': {
        wrapperEl = doc.createElement('label');
        wrapperEl.className = 'ag-field';
        if (node.label) {
          labelEl = doc.createElement('span');
          labelEl.className = 'ag-field-label';
          labelEl.textContent = String(node.label);
          wrapperEl.appendChild(labelEl);
        }
        controlEl = doc.createElement('input');
        controlEl.type = node.inputType === 'password' || node.inputType === 'number' || node.inputType === 'url' ? node.inputType : 'text';
        controlEl.className = 'ag-input';
        if (node.placeholder) controlEl.setAttribute('placeholder', String(node.placeholder));
        controlEl.value = stateVal !== undefined && stateVal !== null ? String(stateVal) : '';
        controlEl.addEventListener('input', () => {
          const v = controlEl.type === 'number' && controlEl.value !== '' ? Number(controlEl.value) : controlEl.value;
          emitChange(node.field || node.id, v);
        });
        controlEl.addEventListener('keydown', (ev) => {
          if (!ev || ev.key !== 'Enter') return;
          if (ev.isComposing || ev.keyCode === 229 || ev.isTrusted === false) return;
          if (node.submitActionId) {
            emitAction(node.submitActionId, { value: controlEl.value });
          }
        });
        wrapperEl.appendChild(controlEl);
        break;
      }
      case 'textarea': {
        wrapperEl = doc.createElement('label');
        wrapperEl.className = 'ag-field';
        if (node.label) {
          labelEl = doc.createElement('span');
          labelEl.className = 'ag-field-label';
          labelEl.textContent = String(node.label);
          wrapperEl.appendChild(labelEl);
        }
        controlEl = doc.createElement('textarea');
        controlEl.className = 'ag-textarea';
        if (Number.isInteger(node.rows) && node.rows > 0) controlEl.setAttribute('rows', String(node.rows));
        if (node.placeholder) controlEl.setAttribute('placeholder', String(node.placeholder));
        controlEl.value = stateVal !== undefined && stateVal !== null ? String(stateVal) : '';
        controlEl.addEventListener('input', () => {
          emitChange(node.field || node.id, controlEl.value);
        });
        wrapperEl.appendChild(controlEl);
        break;
      }
      case 'select': {
        wrapperEl = doc.createElement('label');
        wrapperEl.className = 'ag-field';
        if (node.label) {
          labelEl = doc.createElement('span');
          labelEl.className = 'ag-field-label';
          labelEl.textContent = String(node.label);
          wrapperEl.appendChild(labelEl);
        }
        controlEl = doc.createElement('select');
        controlEl.className = 'ag-select';
        const opts = Array.isArray(node.options) ? node.options : [];
        optSig = JSON.stringify(opts);
        for (let i = 0; i < opts.length; i += 1) {
          const o = opts[i];
          const optEl = doc.createElement('option');
          optEl.value = String(o && typeof o === 'object' ? o.value : o);
          optEl.textContent = String(o && typeof o === 'object' ? o.label || o.value : o);
          controlEl.appendChild(optEl);
        }
        if (stateVal !== undefined && stateVal !== null) controlEl.value = String(stateVal);
        controlEl.addEventListener('change', (ev) => {
          if (ev && ev.isTrusted === false) return;
          emitChange(node.field || node.id, controlEl.value);
        });
        wrapperEl.appendChild(controlEl);
        break;
      }
      case 'segmented': {
        wrapperEl = doc.createElement('div');
        wrapperEl.className = 'ag-field';
        if (node.label) {
          labelEl = doc.createElement('span');
          labelEl.className = 'ag-field-label';
          labelEl.textContent = String(node.label);
          wrapperEl.appendChild(labelEl);
        }
        controlEl = doc.createElement('div');
        controlEl.className = 'ag-segmented';
        controlEl.setAttribute('role', 'group');
        controlEl.setAttribute('data-ag-segmented', '1');
        if (node.label) controlEl.setAttribute('aria-label', String(node.label));
        const opts = Array.isArray(node.options) ? node.options : [];
        optSig = JSON.stringify(opts);
        renderSegmentedButtons(controlEl, opts, stateVal, node.field || node.id);
        wrapperEl.appendChild(controlEl);
        break;
      }
      case 'slider': {
        wrapperEl = doc.createElement('label');
        wrapperEl.className = 'ag-field';
        if (node.label) {
          labelEl = doc.createElement('span');
          labelEl.className = 'ag-field-label';
          labelEl.textContent = String(node.label);
          wrapperEl.appendChild(labelEl);
        }
        controlEl = doc.createElement('input');
        controlEl.type = 'range';
        if (node.min !== undefined) controlEl.setAttribute('min', String(node.min));
        if (node.max !== undefined) controlEl.setAttribute('max', String(node.max));
        if (node.step !== undefined) controlEl.setAttribute('step', String(node.step));
        controlEl.value = stateVal !== undefined && stateVal !== null ? String(stateVal) : String(node.min || 0);
        controlEl.addEventListener('input', () => {
          emitChange(node.field || node.id, Number(controlEl.value));
        });
        wrapperEl.appendChild(controlEl);
        break;
      }
      case 'progress': {
        wrapperEl = doc.createElement('div');
        wrapperEl.className = 'ag-field';
        if (node.label) {
          labelEl = doc.createElement('span');
          labelEl.className = 'ag-field-label';
          labelEl.textContent = String(node.label);
          wrapperEl.appendChild(labelEl);
        }
        controlEl = doc.createElement('progress');
        controlEl.className = 'ag-progress';
        controlEl.value = Number.isFinite(Number(node.value)) ? Number(node.value) : 0;
        controlEl.max = Number.isFinite(Number(node.max)) ? Number(node.max) : 100;
        wrapperEl.appendChild(controlEl);
        break;
      }
      case 'list': {
        wrapperEl = doc.createElement('ul');
        wrapperEl.className = 'ag-list';
        const items = Array.isArray(node.items) ? node.items : [];
        for (let i = 0; i < items.length; i += 1) {
          const item = items[i];
          const li = doc.createElement('li');
          li.className = 'ag-list-item';
          const textSpan = doc.createElement('span');
          textSpan.textContent = String(item && typeof item === 'object' ? item.label || item.text || '' : item);
          li.appendChild(textSpan);
          if (item && typeof item === 'object' && item.actionId) {
            const btn = doc.createElement('button');
            btn.type = 'button';
            btn.className = 'ag-btn';
            btn.textContent = String(item.actionLabel || 'Open');
            btn.addEventListener('click', (ev) => {
              if (ev && ev.isTrusted === false) return;
              emitAction(item.actionId, item.payload !== undefined ? item.payload : item.id);
            });
            li.appendChild(btn);
          }
          wrapperEl.appendChild(li);
        }
        break;
      }
      default:
        wrapperEl = doc.createElement('div');
    }

    if (node.id) {
      wrapperEl.setAttribute('data-ag-node-id', node.id);
      elementsById.set(node.id, {
        nodeType: node.type,
        wrapperEl,
        controlEl,
        labelEl,
        childrenMountEl,
        optSig,
      });
    }
    applyCommonFlags(wrapperEl, controlEl, node);

    if (childrenMountEl && Array.isArray(node.children)) {
      for (let i = 0; i < node.children.length; i += 1) {
        childrenMountEl.appendChild(buildNodeElement(node.children[i]));
      }
    }
    return wrapperEl;
  }

  function reconcileNode(node, parentEl, nextSeenIds) {
    if (node.id && elementsById.has(node.id)) {
      const ref = elementsById.get(node.id);
      if (ref.nodeType === node.type) {
        nextSeenIds.add(node.id);
        patchExistingNode(ref, node);
        if (ref.childrenMountEl && Array.isArray(node.children)) {
          const desiredChildren = [];
          for (let i = 0; i < node.children.length; i += 1) {
            desiredChildren.push(reconcileNode(node.children[i], ref.childrenMountEl, nextSeenIds));
          }
          syncChildOrder(ref.childrenMountEl, desiredChildren, ref.labelEl);
        }
        return ref.wrapperEl;
      }
    }
    const freshEl = buildNodeElement(node);
    if (node.id) nextSeenIds.add(node.id);
    if (Array.isArray(node.children)) {
      collectIds(node, nextSeenIds);
    }
    return freshEl;
  }

  function collectIds(node, outSet) {
    if (!node || typeof node !== 'object') return;
    if (node.id) outSet.add(node.id);
    if (Array.isArray(node.children)) {
      for (let i = 0; i < node.children.length; i += 1) collectIds(node.children[i], outSet);
    }
  }

  function syncChildOrder(mountEl, desiredChildren, keepFirstHeaderEl) {
    const startIdx = keepFirstHeaderEl && mountEl.firstChild === keepFirstHeaderEl ? 1 : 0;
    const desiredSet = new Set(desiredChildren);
    const existing = [];
    for (let i = startIdx; i < mountEl.childNodes.length; i += 1) {
      existing.push(mountEl.childNodes[i]);
    }
    for (let i = 0; i < existing.length; i += 1) {
      if (!desiredSet.has(existing[i])) {
        mountEl.removeChild(existing[i]);
      }
    }
    for (let i = 0; i < desiredChildren.length; i += 1) {
      const target = desiredChildren[i];
      const currentAtSlot = mountEl.childNodes[startIdx + i] || null;
      if (currentAtSlot !== target) {
        if (typeof mountEl.insertBefore === 'function') {
          mountEl.insertBefore(target, currentAtSlot);
        } else {
          mountEl.appendChild(target);
        }
      }
    }
  }

  // Initial mount
  while (containerEl.firstChild) containerEl.removeChild(containerEl.firstChild);
  const rootEl = buildNodeElement(currentTree);
  containerEl.appendChild(rootEl);

  function update(nextTree, nextState) {
    if (nextState && typeof nextState === 'object') {
      currentState = { ...nextState };
    }
    if (nextTree) {
      const check = validateUiTree(nextTree);
      if (!check.ok) {
        throw new Error(`${check.reason}: ${(check.errors || []).join('; ')}`);
      }
      const nextSeenIds = new Set();
      const nextRootEl = reconcileNode(nextTree, containerEl, nextSeenIds);
      if (nextRootEl !== containerEl.firstChild) {
        while (containerEl.firstChild) containerEl.removeChild(containerEl.firstChild);
        containerEl.appendChild(nextRootEl);
      }
      for (const oldId of Array.from(elementsById.keys())) {
        if (!nextSeenIds.has(oldId)) elementsById.delete(oldId);
      }
      currentTree = nextTree;
    } else {
      syncVisibilityAndDisabled(currentTree);
    }
  }

  function getState() {
    return { ...currentState };
  }

  function getElementById(nodeId) {
    const ref = elementsById.get(nodeId);
    return ref ? ref.controlEl || ref.wrapperEl : null;
  }

  return Object.freeze({
    update,
    getState,
    getElementById,
  });
}

function normalizeHeaderLang(locale) {
  return String(locale || '').trim().toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

function createHeaderLocaleSwitch(doc, themeAndI18n) {
  const group = doc.createElement('div');
  group.className = 'ag-ui-lang-switch';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Language');
  group.setAttribute('data-addon-host-control', 'locale-switch');

  const defs = [
    { code: 'ko', label: '한국어' },
    { code: 'en', label: 'EN' },
  ];
  const buttons = [];
  const sync = (nextLocale) => {
    const active = normalizeHeaderLang(
      nextLocale !== undefined
        ? nextLocale
        : themeAndI18n && typeof themeAndI18n.getLocale === 'function'
          ? themeAndI18n.getLocale()
          : 'en'
    );
    for (let i = 0; i < buttons.length; i += 1) {
      const entry = buttons[i];
      entry.btn.setAttribute('aria-pressed', active === entry.code ? 'true' : 'false');
    }
  };

  for (let i = 0; i < defs.length; i += 1) {
    const def = defs[i];
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'ag-ui-lang-btn';
    btn.setAttribute('data-addon-host-lang', def.code);
    btn.textContent = def.label;
    btn.addEventListener('click', (ev) => {
      if (ev && ev.isTrusted === false) return;
      if (themeAndI18n && typeof themeAndI18n.setLocale === 'function') {
        themeAndI18n.setLocale(def.code);
      }
      sync(def.code);
    });
    buttons.push({ code: def.code, btn });
    group.appendChild(btn);
  }

  sync();

  let unsub = null;
  if (themeAndI18n && typeof themeAndI18n.onLocaleDidChange === 'function') {
    try {
      unsub = themeAndI18n.onLocaleDidChange((nextLocale) => {
        sync(nextLocale);
      });
    } catch (_e) {
      unsub = null;
    }
  }

  return Object.freeze({
    element: group,
    sync,
    dispose() {
      if (typeof unsub === 'function') {
        try {
          unsub();
        } catch (_e) {}
        unsub = null;
      }
    },
  });
}

function buildOverlayChrome(doc, shadowRoot, {
  title,
  displayName,
  tokenCss,
  closable = true,
  onClose,
  showLocaleSwitch = false,
  themeAndI18n = null,
}) {
  const styleEl = doc.createElement('style');
  styleEl.textContent = `${tokenCss || ''}\n${SCHEMA_UI_CSS}`;
  shadowRoot.appendChild(styleEl);

  const shell = doc.createElement('div');
  shell.className = 'ag-ui-shell';

  const header = doc.createElement('div');
  header.className = 'ag-ui-header';

  const meta = doc.createElement('div');
  meta.className = 'ag-ui-header-meta';

  let titleEl = null;
  if (title) {
    titleEl = doc.createElement('div');
    titleEl.className = 'ag-ui-title';
    titleEl.textContent = String(title);
    meta.appendChild(titleEl);
  }

  // Non-removable host-owned attribution badge
  const badge = doc.createElement('span');
  badge.className = 'ag-ui-attribution';
  badge.setAttribute('data-addon-host-attribution', '1');
  badge.textContent = `Addon: ${String(displayName || 'Unknown')}`;
  meta.appendChild(badge);
  header.appendChild(meta);

  let localeSwitch = null;
  const actionsWrap = doc.createElement('div');
  actionsWrap.className = 'ag-ui-header-actions';
  if (showLocaleSwitch && themeAndI18n && typeof themeAndI18n.setLocale === 'function') {
    localeSwitch = createHeaderLocaleSwitch(doc, themeAndI18n);
    actionsWrap.appendChild(localeSwitch.element);
  }

  if (closable) {
    const closeBtn = doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ag-ui-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', (ev) => {
      if (ev && ev.isTrusted === false) return;
      if (typeof onClose === 'function') onClose();
    });
    actionsWrap.appendChild(closeBtn);
  }

  if (actionsWrap.childNodes && actionsWrap.childNodes.length > 0) {
    header.appendChild(actionsWrap);
  }

  const body = doc.createElement('div');
  body.className = 'ag-ui-body';

  shell.appendChild(header);
  shell.appendChild(body);
  shadowRoot.appendChild(shell);

  const setTitle = (nextTitle) => {
    const text = String(nextTitle || '');
    if (!titleEl && text) {
      titleEl = doc.createElement('div');
      titleEl.className = 'ag-ui-title';
      if (typeof meta.insertBefore === 'function') {
        meta.insertBefore(titleEl, badge);
      } else {
        meta.appendChild(titleEl);
      }
    }
    if (titleEl) {
      titleEl.textContent = text;
    }
  };

  const disposeChrome = () => {
    if (localeSwitch && typeof localeSwitch.dispose === 'function') {
      localeSwitch.dispose();
      localeSwitch = null;
    }
  };

  return { shell, header, body, badge, titleEl, setTitle, disposeChrome };
}

module.exports = {
  SCHEMA_UI_CSS,
  createSchemaUiController,
  createHeaderLocaleSwitch,
  buildOverlayChrome,
};
