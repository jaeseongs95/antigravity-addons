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

// NEW-BLK-01 / R3-BLK-01..04: Capture JS primordials at module load so shared World 998 prototype tampering cannot bypass policy checks.
const _Error = Error;
const _String = String;
const _ObjectFreeze = Object.freeze;
const _ObjectKeys = Object.keys;
const _ObjectCreate = Object.create;
const _ObjectDefineProperty = Object.defineProperty;
const _ObjectHasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
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
// R3-BLK-04: Capture RegExp.prototype.exec directly (RegExp.prototype.test delegates dynamically to this.exec).
const _RegExpExec = Function.prototype.call.bind(RegExp.prototype.exec);
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

function pushSafe(arr, value) {
  defineSafeDataProp(arr, arr.length, value);
}

function getOwn(obj, key) {
  if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return undefined;
  return _ObjectHasOwn(obj, key) ? obj[key] : undefined;
}

function isNativeDate(val) {
  try {
    _DateGetTime(val);
    return true;
  } catch (_e) {
    return false;
  }
}

function validateServiceName(pluginId, serviceName, opts) {
  // R3-BLK-03: Never read inherited Object.prototype.allowWellKnownHostServices
  const allowWellKnownHostServices = !!getOwn(opts, 'allowWellKnownHostServices');
  if (typeof pluginId !== 'string' || !pluginId) {
    return { ok: false, reason: 'ERR_INVALID_PLUGIN_ID' };
  }
  if (typeof serviceName !== 'string' || _RegExpExec(SERVICE_NAME_RE, serviceName) === null) {
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
    if (!_ObjectHasOwn(allowedCallers, i)) continue;
    const entry = allowedCallers[i];
    if (entry === '*' || entry === callerPluginId) {
      return true;
    }
  }
  return false;
}

function sanitizeBusPayload(value, maxDepth = MAX_PAYLOAD_DEPTH) {
  const seen = new _WeakSet();

  function clone(val, depth) {
    if (depth > maxDepth) {
      throw new _Error('ERR_BUS_PAYLOAD_TOO_DEEP');
    }
    if (val === null || val === undefined || typeof val === 'boolean' || typeof val === 'string') {
      return val;
    }
    if (typeof val === 'number') {
      return _NumberIsFinite(val) ? val : null;
    }
    if (typeof val === 'function' || typeof val === 'symbol' || typeof val === 'bigint') {
      throw new _Error('ERR_BUS_PAYLOAD_NON_SERIALIZABLE');
    }
    if (typeof val === 'object') {
      if (_WeakSetHas(seen, val)) {
        throw new _Error('ERR_BUS_PAYLOAD_CIRCULAR');
      }
      // Reject DOM nodes or host objects cleanly
      if (typeof val.nodeType === 'number' && typeof val.nodeName === 'string') {
        throw new _Error('ERR_BUS_PAYLOAD_DOM_NODE_FORBIDDEN');
      }
      _WeakSetAdd(seen, val);
      try {
        if (_ArrayIsArray(val)) {
          const arr = [];
          for (let i = 0; i < val.length; i += 1) {
            const elem = _ObjectHasOwn(val, i) ? val[i] : undefined;
            defineSafeDataProp(arr, i, clone(elem, depth + 1));
          }
          return arr;
        }
        // R3-NB-03: Use internal [[DateValue]] brand check via captured Date.prototype.getTime (immune to Date[Symbol.hasInstance])
        if (isNativeDate(val)) {
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

  const rawProvide = getOwn(servicesPerm, 'provide');
  if (_ArrayIsArray(rawProvide)) {
    for (let i = 0; i < rawProvide.length; i += 1) {
      const entry = _ObjectHasOwn(rawProvide, i) ? rawProvide[i] : undefined;
      if (!entry || typeof entry !== 'object') {
        pushSafe(errors, `permissions.services.provide[${i}] must be an object`);
        continue;
      }
      const entryName = getOwn(entry, 'name');
      const nameOpts = _ObjectCreate(null);
      nameOpts.allowWellKnownHostServices = true;
      const check = validateServiceName(pluginId, entryName, nameOpts);
      if (!check.ok) {
        pushSafe(errors, `permissions.services.provide[${i}].name "${_String(entryName)}": ${check.reason}`);
        continue;
      }
      if (_SetHas(seenProvide, entryName)) {
        pushSafe(errors, `Duplicate provided service "${entryName}"`);
        continue;
      }
      _SetAdd(seenProvide, entryName);
      const callersCopy = [];
      const rawCallers = getOwn(entry, 'allowedCallers');
      if (_ArrayIsArray(rawCallers)) {
        for (let j = 0; j < rawCallers.length; j += 1) {
          if (_ObjectHasOwn(rawCallers, j)) {
            pushSafe(callersCopy, rawCallers[j]);
          }
        }
      }
      pushSafe(provide, {
        name: entryName,
        allowedCallers: callersCopy,
      });
    }
  }

  const consume = [];
  const seenConsume = new _Set();
  const rawConsume = getOwn(servicesPerm, 'consume');
  if (_ArrayIsArray(rawConsume)) {
    for (let i = 0; i < rawConsume.length; i += 1) {
      const name = _ObjectHasOwn(rawConsume, i) ? rawConsume[i] : undefined;
      if (typeof name !== 'string' || _RegExpExec(SERVICE_NAME_RE, name) === null) {
        pushSafe(errors, `Invalid consumed service name "${_String(name)}"`);
      } else if (!_SetHas(seenConsume, name)) {
        _SetAdd(seenConsume, name);
        pushSafe(consume, name);
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
