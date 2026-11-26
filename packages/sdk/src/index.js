'use strict';

/**
 * `@antigravity-addons/sdk` Entry (v3.0.0 — Zero external npm dependencies).
 *
 * Exports:
 * - `defineAddon(def)`: ergonomic plugin definition wrapper with runtime contract check.
 * - `h(type, props?, children?)`: typed declarative Tier-2 UI tree builder.
 * - `createTestHost(opts?)`: real-kernel Desktop / Remote Web parity test harness.
 */

const { createTestHost } = require('./test-host');

function defineAddon(definition) {
  if (!definition || typeof definition !== 'object' || typeof definition.setup !== 'function') {
    throw new Error('ERR_SDK_INVALID_ADDON_DEFINITION: setup(ctx) function is required');
  }
  return Object.freeze({
    ...definition,
    apiVersion: 3,
  });
}

function h(type, props = {}, children = undefined) {
  if (typeof type !== 'string' || !type.trim()) {
    throw new Error('ERR_SDK_INVALID_UI_NODE_TYPE');
  }
  const node = { type: type.trim() };
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    for (const [k, v] of Object.entries(props)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      if (v !== undefined) node[k] = v;
    }
  }
  if (Array.isArray(children)) {
    node.children = children.filter(Boolean);
  } else if (Array.isArray(props)) {
    node.children = props.filter(Boolean);
  }
  return node;
}

module.exports = {
  defineAddon,
  h,
  createTestHost,
};
