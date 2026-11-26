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

// NEW-BLK-01: Capture JS primordials at module load so shared World 998 prototype tampering cannot bypass policy checks.
const _ObjectFreeze = Object.freeze;
const _ObjectKeys = Object.keys;
const _ObjectCreate = Object.create;
const _ObjectDefineProperty = Object.defineProperty;
const _ArrayIsArray = Array.isArray;
const _NumberIsFinite = Number.isFinite;
const _Date = Date;
const _DateGetTime = Function.prototype.call.bind(Date.prototype.getTime);
const _Set = Set;
const _SetHas = Function.prototype.call.bind(Set.prototype.has);
const _SetAdd = Function.prototype.call.bind(Set.prototype.add);
const _WeakSet = WeakSet;
const _WeakSetHas = Function.prototype.call.bind(WeakSet.prototype.has);
const _WeakSetAdd = Function.prototype.call.bind(WeakSet.prototype.add);
const _WeakSetDelete = Function.prototype.call.bind(WeakSet.prototype.delete);
const _RegExpTest = Function.prototype.call.bind(RegExp.prototype.test);
const _StringStartsWith = Function.prototype.call.bind(String.prototype.startsWith);

const WELL_KNOWN_HOST_SERVICES = _ObjectFreeze(['host.statusbar']);
const WELL_KNOWN_HOST_SERVICE_SET = new _Set(WELL_KNOWN_HOST_SERVICES);
const SERVICE_NAME_RE = /^[a-z0-9][a-z0-9._-]{1,63}\.[a-z0-9][a-z0-9._-]{1,63}$/;
const FORBIDDEN_KEYS = new _Set(['__proto__', 'constructor', 'prototype']);
const MAX_PAYLOAD_DEPTH = 12;

function defineSafeDataProp(target, key, value) {
  const desc = _ObjectCreate(null);
  desc.value = value;
  desc.enumerable = true;
  desc.configurable = true;
  desc.writable = true;
  _ObjectDefineProperty(target, key, desc);
}

function validateServiceName(pluginId, serviceName, { allowWellKnownHostServices = false } = {}) {
  if (typeof pluginId !== 'string' || !pluginId) {
    return { ok: false, reason: 'ERR_INVALID_PLUGIN_ID' };
  }
  if (typeof serviceName !== 'string' || !_RegExpTest(SERVICE_NAME_RE, serviceName)) {
    return { ok: false, reason: 'ERR_INVALID_SERVICE_NAME' };
  }
  if (_StringStartsWith(serviceName, `${pluginId}.`)) {
    return { ok: true, serviceName, isWellKnownHostService: false };
  }
  if (allowWellKnownHostServices && _SetHas(WELL_KNOWN_HOST_SERVICE_SET, serviceName)) {
    return { ok: true, serviceName, isWellKnownHostService: true };
  }
  return { ok: false, reason: 'ERR_SERVICE_NAMESPACE_MISMATCH' };
}

function isCallerAllowed(providerPluginId, callerPluginId, allowedCallers) {
  if (typeof callerPluginId !== 'string' || !callerPluginId) return false;
  if (callerPluginId === providerPluginId) return true;
  if (!_ArrayIsArray(allowedCallers) || allowedCallers.length === 0) {
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
  const seen = new _WeakSet();

  function clone(val, depth) {
    if (depth > maxDepth) {
      throw new Error('ERR_BUS_PAYLOAD_TOO_DEEP');
    }
    if (val === null || val === undefined || typeof val === 'boolean' || typeof val === 'string') {
      return val;
    }
    if (typeof val === 'number') {
      return _NumberIsFinite(val) ? val : null;
    }
    if (typeof val === 'function' || typeof val === 'symbol' || typeof val === 'bigint') {
      throw new Error('ERR_BUS_PAYLOAD_NON_SERIALIZABLE');
    }
    if (typeof val === 'object') {
      if (_WeakSetHas(seen, val)) {
        throw new Error('ERR_BUS_PAYLOAD_CIRCULAR');
      }
      // Reject DOM nodes or host objects cleanly
      if (typeof val.nodeType === 'number' && typeof val.nodeName === 'string') {
        throw new Error('ERR_BUS_PAYLOAD_DOM_NODE_FORBIDDEN');
      }
      _WeakSetAdd(seen, val);
      try {
        if (_ArrayIsArray(val)) {
          const arr = [];
          for (let i = 0; i < val.length; i += 1) {
            defineSafeDataProp(arr, i, clone(val[i], depth + 1));
          }
          return arr;
        }
        if (val instanceof _Date) {
          return new _Date(_DateGetTime(val));
        }
        const out = {};
        const keys = _ObjectKeys(val);
        for (let i = 0; i < keys.length; i += 1) {
          const k = keys[i];
          if (_SetHas(FORBIDDEN_KEYS, k)) continue;
          const clonedVal = clone(val[k], depth + 1);
          if (clonedVal !== undefined) {
            defineSafeDataProp(out, k, clonedVal);
          }
        }
        return out;
      } finally {
        _WeakSetDelete(seen, val);
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
  if (typeof servicesPerm !== 'object' || _ArrayIsArray(servicesPerm)) {
    return { ok: false, reason: 'ERR_INVALID_SERVICE_PERMISSIONS', errors: ['permissions.services must be an object'] };
  }
  const errors = [];
  const provide = [];
  const seenProvide = new _Set();

  if (_ArrayIsArray(servicesPerm.provide)) {
    for (let i = 0; i < servicesPerm.provide.length; i += 1) {
      const entry = servicesPerm.provide[i];
      if (!entry || typeof entry !== 'object') {
        errors[errors.length] = `permissions.services.provide[${i}] must be an object`;
        continue;
      }
      const check = validateServiceName(pluginId, entry.name, { allowWellKnownHostServices: true });
      if (!check.ok) {
        errors[errors.length] = `permissions.services.provide[${i}].name "${String(entry.name)}": ${check.reason}`;
        continue;
      }
      if (_SetHas(seenProvide, entry.name)) {
        errors[errors.length] = `Duplicate provided service "${entry.name}"`;
        continue;
      }
      _SetAdd(seenProvide, entry.name);
      const callersCopy = [];
      if (_ArrayIsArray(entry.allowedCallers)) {
        for (let j = 0; j < entry.allowedCallers.length; j += 1) {
          callersCopy[callersCopy.length] = entry.allowedCallers[j];
        }
      }
      provide[provide.length] = {
        name: entry.name,
        allowedCallers: callersCopy,
      };
    }
  }

  const consume = [];
  const seenConsume = new _Set();
  if (_ArrayIsArray(servicesPerm.consume)) {
    for (let i = 0; i < servicesPerm.consume.length; i += 1) {
      const name = servicesPerm.consume[i];
      if (typeof name !== 'string' || !_RegExpTest(SERVICE_NAME_RE, name)) {
        errors[errors.length] = `Invalid consumed service name "${String(name)}"`;
      } else if (!_SetHas(seenConsume, name)) {
        _SetAdd(seenConsume, name);
        consume[consume.length] = name;
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
