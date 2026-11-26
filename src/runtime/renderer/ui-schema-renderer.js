'use strict';

/**
 * Vendor-neutral Tier-2 Declarative UI Schema Renderer & ID-based Patch Engine (v3.0.0 — SOLID #0).
 *
 * - Strictly ZERO HTML sinks (`innerHTML`, `outerHTML`, `insertAdjacentHTML` = 0).
 * - Strictly ZERO `eval` / `new Function`.
 * - Renders validated 16-primitive JSON trees using `--ag-*` semantic CSS tokens.
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
:host, .ag-ui-shell {
  box-sizing: border-box;
  font-family: var(--ag-font, system-ui, -apple-system, sans-serif);
  color: var(--ag-text, #f0f6fc);
  font-size: 13px;
  line-height: 1.45;
}
*, *::before, *::after { box-sizing: border-box; }
.ag-ui-shell {
  background: var(--ag-surface, #161b24);
  border: 1px solid var(--ag-border, rgba(255, 255, 255, 0.14));
  border-radius: var(--ag-radius, 10px);
  box-shadow: var(--ag-shadow, 0 12px 32px rgba(0, 0, 0, 0.52));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  max-height: inherit;
}
.ag-ui-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--ag-border, rgba(255, 255, 255, 0.14));
}
.ag-ui-header-meta { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ag-ui-title { font-weight: 700; font-size: 14px; color: var(--ag-text, #f0f6fc); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ag-ui-attribution {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  background: rgba(56, 189, 248, 0.15);
  color: var(--ag-accent, #38bdf8);
  border: 1px solid rgba(56, 189, 248, 0.3);
  flex-shrink: 0;
}
.ag-ui-close {
  appearance: none;
  border: 1px solid var(--ag-border, rgba(255, 255, 255, 0.14));
  background: transparent;
  color: var(--ag-text-muted, #8b949e);
  border-radius: 6px;
  min-width: 28px;
  min-height: 28px;
  cursor: pointer;
  font-size: 14px;
}
.ag-ui-close:hover { color: var(--ag-text, #f0f6fc); }
.ag-ui-body { padding: 12px 14px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
.ag-stack { display: flex; flex-direction: column; gap: 8px; }
.ag-row { display: flex; flex-direction: row; align-items: center; gap: 8px; flex-wrap: wrap; }
.ag-section { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--ag-border, rgba(255, 255, 255, 0.12)); border-radius: 8px; background: var(--ag-surface-elevated, rgba(255,255,255,0.03)); }
.ag-section-title { font-weight: 600; font-size: 12px; color: var(--ag-text-muted, #8b949e); text-transform: uppercase; letter-spacing: 0.03em; }
.ag-heading { margin: 0; font-weight: 700; color: var(--ag-text, #f0f6fc); }
.ag-text { margin: 0; color: var(--ag-text, #f0f6fc); }
.ag-text[data-tone="muted"] { color: var(--ag-text-muted, #8b949e); font-size: 12px; }
.ag-badge { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; background: rgba(148, 163, 184, 0.18); color: var(--ag-text, #f0f6fc); }
.ag-badge[data-variant="success"] { background: rgba(74, 222, 128, 0.16); color: var(--ag-success, #4ade80); }
.ag-badge[data-variant="warning"] { background: rgba(251, 191, 36, 0.16); color: var(--ag-warning, #fbbf24); }
.ag-badge[data-variant="danger"] { background: rgba(248, 113, 113, 0.16); color: var(--ag-danger, #f87171); }
.ag-divider { border: 0; border-top: 1px solid var(--ag-border, rgba(255, 255, 255, 0.12)); margin: 4px 0; }
.ag-alert { padding: 8px 10px; border-radius: 8px; font-size: 12px; border: 1px solid var(--ag-border, rgba(255, 255, 255, 0.16)); }
.ag-alert[data-variant="danger"] { border-color: var(--ag-danger, #f87171); color: var(--ag-danger, #f87171); }
.ag-alert[data-variant="warning"] { border-color: var(--ag-warning, #fbbf24); color: var(--ag-warning, #fbbf24); }
.ag-alert[data-variant="success"] { border-color: var(--ag-success, #4ade80); color: var(--ag-success, #4ade80); }
.ag-btn {
  appearance: none;
  border: 1px solid var(--ag-border, rgba(255, 255, 255, 0.18));
  background: var(--ag-surface-elevated, rgba(255, 255, 255, 0.08));
  color: var(--ag-text, #f0f6fc);
  border-radius: 7px;
  min-height: 34px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.ag-btn[data-variant="primary"] { background: var(--ag-accent, #38bdf8); color: var(--ag-accent-fg, #082f49); border-color: transparent; }
.ag-btn[data-variant="danger"] { background: var(--ag-danger, #f87171); color: #ffffff; border-color: transparent; }
.ag-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.ag-field { display: flex; flex-direction: column; gap: 4px; }
.ag-field-label { font-size: 12px; font-weight: 600; color: var(--ag-text, #f0f6fc); }
.ag-toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; cursor: pointer; }
.ag-input, .ag-textarea, .ag-select {
  width: 100%;
  background: var(--ag-bg, #0f131a);
  color: var(--ag-text, #f0f6fc);
  border: 1px solid var(--ag-border, rgba(255, 255, 255, 0.18));
  border-radius: 7px;
  padding: 6px 9px;
  font-size: 13px;
  font-family: inherit;
}
.ag-progress { width: 100%; height: 8px; }
.ag-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.ag-list-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--ag-border, rgba(255, 255, 255, 0.1)); }
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

function buildOverlayChrome(doc, shadowRoot, {
  title,
  displayName,
  tokenCss,
  closable = true,
  onClose,
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

  if (title) {
    const titleEl = doc.createElement('div');
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
    header.appendChild(closeBtn);
  }

  const body = doc.createElement('div');
  body.className = 'ag-ui-body';

  shell.appendChild(header);
  shell.appendChild(body);
  shadowRoot.appendChild(shell);

  return { shell, header, body, badge };
}

module.exports = {
  SCHEMA_UI_CSS,
  createSchemaUiController,
  buildOverlayChrome,
};
