'use strict';

/**
 * Pure vendor- & runtime-neutral Tier-2 Declarative UI Schema Validator &
 * Static JSON Predicate Evaluator (v3.0.0 — SOLID #0).
 *
 * - Closed set of 16 semantic UI primitives (zero raw HTML, zero script tags, zero eval).
 * - Static JSON `visibleWhen` / `disabledWhen` predicates (`{ field, eq | neq | in | truthy }`
 *   plus bounded `{ all }` / `{ any }` combinators).
 * - Enforces max tree depth (12) and max node count (256) to prevent DoS.
 */

const ALLOWED_UI_NODE_TYPES = Object.freeze([
  'stack',
  'row',
  'section',
  'heading',
  'text',
  'badge',
  'divider',
  'alert',
  'button',
  'toggle',
  'input',
  'textarea',
  'select',
  'slider',
  'progress',
  'list',
]);

const ALLOWED_UI_NODE_TYPE_SET = new Set(ALLOWED_UI_NODE_TYPES);
const CONTAINER_NODE_TYPES = new Set(['stack', 'row', 'section']);
const MAX_TREE_DEPTH = 12;
const MAX_TREE_NODES = 256;
const MAX_CONDITION_DEPTH = 4;
const SAFE_NODE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;
const FORBIDDEN_STATE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function readStateField(state, fieldPath) {
  if (!state || typeof state !== 'object' || typeof fieldPath !== 'string' || !fieldPath) {
    return undefined;
  }
  const parts = fieldPath.split('.');
  let cur = state;
  for (let i = 0; i < parts.length; i += 1) {
    const key = parts[i];
    if (!key || FORBIDDEN_STATE_KEYS.has(key)) return undefined;
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, key)) {
      return undefined;
    }
    cur = cur[key];
  }
  return cur;
}

function validateUiCondition(cond, depth = 0) {
  if (cond === undefined || cond === null) return { ok: true };
  if (typeof cond !== 'object' || Array.isArray(cond)) {
    return { ok: false, reason: 'ERR_UI_CONDITION_INVALID' };
  }
  if (depth > MAX_CONDITION_DEPTH) {
    return { ok: false, reason: 'ERR_UI_CONDITION_TOO_DEEP' };
  }
  if (Array.isArray(cond.all)) {
    for (let i = 0; i < cond.all.length; i += 1) {
      const r = validateUiCondition(cond.all[i], depth + 1);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  if (Array.isArray(cond.any)) {
    for (let i = 0; i < cond.any.length; i += 1) {
      const r = validateUiCondition(cond.any[i], depth + 1);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  if (typeof cond.field !== 'string' || !cond.field.trim()) {
    return { ok: false, reason: 'ERR_UI_CONDITION_FIELD_REQUIRED' };
  }
  const hasEq = Object.prototype.hasOwnProperty.call(cond, 'eq');
  const hasNeq = Object.prototype.hasOwnProperty.call(cond, 'neq');
  const hasIn = Object.prototype.hasOwnProperty.call(cond, 'in');
  const hasTruthy = Object.prototype.hasOwnProperty.call(cond, 'truthy');
  const opsCount = (hasEq ? 1 : 0) + (hasNeq ? 1 : 0) + (hasIn ? 1 : 0) + (hasTruthy ? 1 : 0);
  if (opsCount !== 1) {
    return { ok: false, reason: 'ERR_UI_CONDITION_SINGLE_OPERATOR_REQUIRED' };
  }
  if (hasIn && !Array.isArray(cond.in)) {
    return { ok: false, reason: 'ERR_UI_CONDITION_IN_MUST_BE_ARRAY' };
  }
  if (hasTruthy && typeof cond.truthy !== 'boolean') {
    return { ok: false, reason: 'ERR_UI_CONDITION_TRUTHY_MUST_BE_BOOLEAN' };
  }
  return { ok: true };
}

function evaluateUiCondition(cond, state, depth = 0) {
  if (cond === undefined || cond === null) return true;
  if (typeof cond !== 'object' || Array.isArray(cond) || depth > MAX_CONDITION_DEPTH) return false;
  if (Array.isArray(cond.all)) {
    for (let i = 0; i < cond.all.length; i += 1) {
      if (!evaluateUiCondition(cond.all[i], state, depth + 1)) return false;
    }
    return true;
  }
  if (Array.isArray(cond.any)) {
    for (let i = 0; i < cond.any.length; i += 1) {
      if (evaluateUiCondition(cond.any[i], state, depth + 1)) return true;
    }
    return false;
  }
  const val = readStateField(state, cond.field);
  if (Object.prototype.hasOwnProperty.call(cond, 'eq')) return val === cond.eq;
  if (Object.prototype.hasOwnProperty.call(cond, 'neq')) return val !== cond.neq;
  if (Object.prototype.hasOwnProperty.call(cond, 'in')) {
    return Array.isArray(cond.in) && cond.in.includes(val);
  }
  if (Object.prototype.hasOwnProperty.call(cond, 'truthy')) {
    return Boolean(val) === cond.truthy;
  }
  return false;
}

function validateUiTree(tree) {
  if (!tree || typeof tree !== 'object' || Array.isArray(tree)) {
    return { ok: false, reason: 'ERR_UI_TREE_INVALID', errors: ['UI tree root must be an object'] };
  }
  const errors = [];
  let nodeCount = 0;
  const seenIds = new Set();

  function walk(node, depth, pathLabel) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      errors.push(`${pathLabel}: node must be an object`);
      return;
    }
    nodeCount += 1;
    if (nodeCount > MAX_TREE_NODES) {
      errors.push(`ERR_UI_TREE_MAX_NODES_EXCEEDED (${MAX_TREE_NODES})`);
      return;
    }
    if (depth > MAX_TREE_DEPTH) {
      errors.push(`${pathLabel}: ERR_UI_TREE_MAX_DEPTH_EXCEEDED (${MAX_TREE_DEPTH})`);
      return;
    }
    if (typeof node.type !== 'string' || !ALLOWED_UI_NODE_TYPE_SET.has(node.type)) {
      errors.push(`${pathLabel}: unsupported node type "${String(node.type)}"`);
      return;
    }
    if (node.id !== undefined) {
      if (typeof node.id !== 'string' || !SAFE_NODE_ID_RE.test(node.id)) {
        errors.push(`${pathLabel}: invalid node id "${String(node.id)}"`);
      } else if (seenIds.has(node.id)) {
        errors.push(`${pathLabel}: duplicate node id "${node.id}"`);
      } else {
        seenIds.add(node.id);
      }
    }
    if (node.visibleWhen !== undefined) {
      const r = validateUiCondition(node.visibleWhen);
      if (!r.ok) errors.push(`${pathLabel}.visibleWhen: ${r.reason}`);
    }
    if (node.disabledWhen !== undefined) {
      const r = validateUiCondition(node.disabledWhen);
      if (!r.ok) errors.push(`${pathLabel}.disabledWhen: ${r.reason}`);
    }
    if (node.type === 'select') {
      if (!Array.isArray(node.options)) {
        errors.push(`${pathLabel}: select node requires options array`);
      }
    }
    if (node.type === 'list') {
      if (node.items !== undefined && !Array.isArray(node.items)) {
        errors.push(`${pathLabel}: list node items must be an array`);
      }
    }
    if (node.children !== undefined) {
      if (!CONTAINER_NODE_TYPES.has(node.type)) {
        errors.push(`${pathLabel}: non-container node "${node.type}" cannot have children`);
      } else if (!Array.isArray(node.children)) {
        errors.push(`${pathLabel}: children must be an array`);
      } else {
        for (let i = 0; i < node.children.length; i += 1) {
          walk(node.children[i], depth + 1, `${pathLabel}.children[${i}]`);
        }
      }
    }
  }

  walk(tree, 0, 'root');
  if (errors.length > 0) {
    return { ok: false, reason: 'ERR_UI_SCHEMA_INVALID', errors };
  }
  return { ok: true, nodeCount };
}

module.exports = {
  ALLOWED_UI_NODE_TYPES,
  CONTAINER_NODE_TYPES,
  MAX_TREE_DEPTH,
  MAX_TREE_NODES,
  readStateField,
  validateUiCondition,
  evaluateUiCondition,
  validateUiTree,
};
