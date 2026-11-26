'use strict';

/**
 * Pure vendor- & runtime-neutral Service Bus & Event Bus Security Policy (v3.0.0 — SOLID #0).
 *
 * - Enforces `<pluginId>.<name>` service naming (plus explicit well-known host service slots
 *   such as `host.statusbar` when declared in manifest `permissions.services.provide`).
 * - Default-deny `allowedCallers`: omitting `allowedCallers` permits ONLY the provider itself;
 *   explicit caller pluginIds or `'*'` are required for cross-plugin calls.
 * - Deep plain-data structured clone stripping `__proto__`, `constructor`, `prototype`,
 *   and rejecting functions / circular references / excessive nesting depth.
 */

const WELL_KNOWN_HOST_SERVICES = Object.freeze(['host.statusbar']);
const WELL_KNOWN_HOST_SERVICE_SET = new Set(WELL_KNOWN_HOST_SERVICES);
const SERVICE_NAME_RE = /^[a-z0-9][a-z0-9._-]{1,63}\.[a-z0-9][a-z0-9._-]{1,63}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_PAYLOAD_DEPTH = 12;

function validateServiceName(pluginId, serviceName, { allowWellKnownHostServices = false } = {}) {
  if (typeof pluginId !== 'string' || !pluginId) {
    return { ok: false, reason: 'ERR_INVALID_PLUGIN_ID' };
  }
  if (typeof serviceName !== 'string' || !SERVICE_NAME_RE.test(serviceName)) {
    return { ok: false, reason: 'ERR_INVALID_SERVICE_NAME' };
  }
  if (serviceName.startsWith(`${pluginId}.`)) {
    return { ok: true, serviceName, isWellKnownHostService: false };
  }
  if (allowWellKnownHostServices && WELL_KNOWN_HOST_SERVICE_SET.has(serviceName)) {
    return { ok: true, serviceName, isWellKnownHostService: true };
  }
  return { ok: false, reason: 'ERR_SERVICE_NAMESPACE_MISMATCH' };
}

function isCallerAllowed(providerPluginId, callerPluginId, allowedCallers) {
  if (typeof callerPluginId !== 'string' || !callerPluginId) return false;
  if (callerPluginId === providerPluginId) return true;
  if (!Array.isArray(allowedCallers) || allowedCallers.length === 0) {
    return false; // Default-deny
  }
  for (let i = 0; i < allowedCallers.length; i += 1) {
    if (allowedCallers[i] === '*' || allowedCallers[i] === callerPluginId) {
      return true;
    }
  }
  return false;
}

function sanitizeBusPayload(value, maxDepth = MAX_PAYLOAD_DEPTH) {
  const seen = new WeakSet();

  function clone(val, depth) {
    if (depth > maxDepth) {
      throw new Error('ERR_BUS_PAYLOAD_TOO_DEEP');
    }
    if (val === null || val === undefined || typeof val === 'boolean' || typeof val === 'string') {
      return val;
    }
    if (typeof val === 'number') {
      return Number.isFinite(val) ? val : null;
    }
    if (typeof val === 'function' || typeof val === 'symbol' || typeof val === 'bigint') {
      throw new Error('ERR_BUS_PAYLOAD_NON_SERIALIZABLE');
    }
    if (typeof val === 'object') {
      if (seen.has(val)) {
        throw new Error('ERR_BUS_PAYLOAD_CIRCULAR');
      }
      // Reject DOM nodes or host objects cleanly
      if (typeof val.nodeType === 'number' && typeof val.nodeName === 'string') {
        throw new Error('ERR_BUS_PAYLOAD_DOM_NODE_FORBIDDEN');
      }
      seen.add(val);
      try {
        if (Array.isArray(val)) {
          const arr = [];
          for (let i = 0; i < val.length; i += 1) {
            arr.push(clone(val[i], depth + 1));
          }
          return arr;
        }
        if (val instanceof Date) {
          return new Date(val.getTime());
        }
        const out = Object.create(null);
        const keys = Object.keys(val);
        for (let i = 0; i < keys.length; i += 1) {
          const k = keys[i];
          if (FORBIDDEN_KEYS.has(k)) continue;
          const clonedVal = clone(val[k], depth + 1);
          if (clonedVal !== undefined) {
            out[k] = clonedVal;
          }
        }
        return Object.assign({}, out);
      } finally {
        seen.delete(val);
      }
    }
    return undefined;
  }

  return clone(value, 0);
}

function validateServicePermissions(pluginId, servicesPerm) {
  if (servicesPerm === null || servicesPerm === undefined) {
    return { ok: true, provide: [], consume: [] };
  }
  if (typeof servicesPerm !== 'object' || Array.isArray(servicesPerm)) {
    return { ok: false, reason: 'ERR_INVALID_SERVICE_PERMISSIONS', errors: ['permissions.services must be an object'] };
  }
  const errors = [];
  const provide = [];
  const seenProvide = new Set();

  if (Array.isArray(servicesPerm.provide)) {
    for (let i = 0; i < servicesPerm.provide.length; i += 1) {
      const entry = servicesPerm.provide[i];
      if (!entry || typeof entry !== 'object') {
        errors.push(`permissions.services.provide[${i}] must be an object`);
        continue;
      }
      const check = validateServiceName(pluginId, entry.name, { allowWellKnownHostServices: true });
      if (!check.ok) {
        errors.push(`permissions.services.provide[${i}].name "${String(entry.name)}": ${check.reason}`);
        continue;
      }
      if (seenProvide.has(entry.name)) {
        errors.push(`Duplicate provided service "${entry.name}"`);
        continue;
      }
      seenProvide.add(entry.name);
      provide.push({
        name: entry.name,
        allowedCallers: Array.isArray(entry.allowedCallers) ? entry.allowedCallers.slice() : [],
      });
    }
  }

  const consume = [];
  if (Array.isArray(servicesPerm.consume)) {
    for (let i = 0; i < servicesPerm.consume.length; i += 1) {
      const name = servicesPerm.consume[i];
      if (typeof name !== 'string' || !SERVICE_NAME_RE.test(name)) {
        errors.push(`Invalid consumed service name "${String(name)}"`);
      } else if (!consume.includes(name)) {
        consume.push(name);
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, reason: 'ERR_INVALID_SERVICE_PERMISSIONS', errors };
  }
  return { ok: true, provide, consume };
}

module.exports = {
  WELL_KNOWN_HOST_SERVICES,
  SERVICE_NAME_RE,
  MAX_PAYLOAD_DEPTH,
  validateServiceName,
  isCallerAllowed,
  sanitizeBusPayload,
  validateServicePermissions,
};
