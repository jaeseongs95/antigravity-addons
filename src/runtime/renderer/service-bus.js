'use strict';

/**
 * Vendor-neutral Typed Service Bus with Default-Deny ACL & Proto-Key Stripping (v3.0.0 — SOLID #0).
 *
 * - Enforces `<pluginId>.<name>` namespace (or manifest-declared well-known `host.*` service slot).
 * - Default-deny `allowedCallers`: cross-plugin calls fail unless explicitly permitted.
 * - Deep clones and strips `__proto__` / `constructor` / `prototype` on every argument & return value
 *   (except for internal host-to-service wiring like `host.statusbar` accessed via `getInternalService`).
 */

const {
  validateServiceName,
  isCallerAllowed,
  sanitizeBusPayload,
} = require('../../core/service-bus-policy');

// NEW-BLK-01 / R3-BLK-01..03: Capture JS primordials at module load so shared World 998 prototype tampering cannot hijack host.statusbar, ACLs, or bus payloads.
const _Error = Error;
const _String = String;
const _ObjectCreate = Object.create;
const _ObjectDefineProperty = Object.defineProperty;
const _ObjectFreeze = Object.freeze;
const _ObjectKeys = Object.keys;
const _ObjectHasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
const _ObjectGetPrototypeOf = Object.getPrototypeOf;
const _ObjectIsExtensible = Object.isExtensible;
const _ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const _ArrayIsArray = Array.isArray;
const _Map = Map;
const _MapGet = Function.prototype.call.bind(Map.prototype.get);
const _MapSet = Function.prototype.call.bind(Map.prototype.set);
const _MapHas = Function.prototype.call.bind(Map.prototype.has);
const _MapDelete = Function.prototype.call.bind(Map.prototype.delete);
const _MapForEach = Function.prototype.call.bind(Map.prototype.forEach);
const _Set = Set;
const _SetHas = Function.prototype.call.bind(Set.prototype.has);
const _SetAdd = Function.prototype.call.bind(Set.prototype.add);
const _StringStartsWith = Function.prototype.call.bind(String.prototype.startsWith);
const _ReflectApply = Reflect.apply;
const _Promise = Promise;
const _PromisePrototype = Promise.prototype;
const _PromiseThen = Function.prototype.call.bind(Promise.prototype.then);
const _SymbolSpecies = Symbol.species;
const _OrigPromiseSpeciesGetter = (_ObjectGetOwnPropertyDescriptor(_Promise, _SymbolSpecies) || {}).get;

function pinSafePromiseConstructor(p) {
  if (_ObjectIsExtensible(p)) {
    const desc = _ObjectCreate(null);
    desc.value = undefined;
    desc.writable = true;
    desc.configurable = true;
    desc.enumerable = false;
    _ObjectDefineProperty(p, 'constructor', desc);
    return;
  }
  // R4-BLK-01: Non-extensible Promise — fail closed unless constructor & Promise[Symbol.species] are provably unpoisoned.
  if (_ObjectHasOwn(p, 'constructor')) {
    const ownDesc = _ObjectGetOwnPropertyDescriptor(p, 'constructor');
    if (ownDesc && !ownDesc.get && !ownDesc.set && ownDesc.value === undefined) return;
    throw new _Error('ERR_SERVICE_PROMISE_UNSAFE');
  }
  const protoDesc = _ObjectGetOwnPropertyDescriptor(_PromisePrototype, 'constructor');
  const speciesDesc = _ObjectGetOwnPropertyDescriptor(_Promise, _SymbolSpecies);
  if (
    protoDesc &&
    !protoDesc.get &&
    !protoDesc.set &&
    protoDesc.value === _Promise &&
    speciesDesc &&
    speciesDesc.get === _OrigPromiseSpeciesGetter &&
    !speciesDesc.set
  ) {
    return;
  }
  throw new _Error('ERR_SERVICE_PROMISE_UNSAFE');
}

function shadowThenableOnResolvedValue(val) {
  // R5-BLK-01 / R6-BLK-01: Shadow non-enumerable own `then: undefined` on extensible objects/arrays/Dates
  // so ECMA-262 Promise Resolve Functions & caller `await` never walk `Object.prototype.then`,
  // without throwing TypeError on frozen/sealed/non-extensible values (e.g. caller `.then(() => Object.freeze(...)).finally(...)`).
  if (val !== null && typeof val === 'object' && !_ObjectHasOwn(val, 'then') && _ObjectIsExtensible(val)) {
    const desc = _ObjectCreate(null);
    desc.value = undefined;
    desc.writable = true;
    desc.configurable = true;
    desc.enumerable = false;
    _ObjectDefineProperty(val, 'then', desc);
  }
  return val;
}

function shadowThenableDeep(val) {
  // R6-BLK-02: Recursively shadow non-enumerable own `then: undefined` across the entire freshly
  // sanitized payload tree (objects, Arrays, Dates) so nested `.then(r => r.nested)`, awaited sync
  // `serviceBus.call`, and awaited service args cannot trigger a poisoned `Object.prototype.then`.
  if (val === null || typeof val !== 'object') {
    return val;
  }
  shadowThenableOnResolvedValue(val);
  if (_ArrayIsArray(val)) {
    for (let i = 0; i < val.length; i += 1) {
      if (_ObjectHasOwn(val, i)) {
        shadowThenableDeep(val[i]);
      }
    }
    return val;
  }
  const keys = _ObjectKeys(val);
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i];
    if (_ObjectHasOwn(val, k)) {
      shadowThenableDeep(val[k]);
    }
  }
  return val;
}

function hardenReturnedPromise(p) {
  pinSafePromiseConstructor(p);
  const thenDesc = _ObjectCreate(null);
  thenDesc.value = function safeThen(onFulfilled, onRejected) {
    return hardenReturnedPromise(_PromiseThen(p, onFulfilled, onRejected));
  };
  thenDesc.writable = true;
  thenDesc.configurable = true;
  thenDesc.enumerable = false;
  _ObjectDefineProperty(p, 'then', thenDesc);

  // R5-BLK-02: Pin own non-enumerable `catch` and `finally` so poisoned Promise.prototype.catch/finally cannot hijack chains.
  const catchDesc = _ObjectCreate(null);
  catchDesc.value = function safeCatch(onRejected) {
    return hardenReturnedPromise(_PromiseThen(p, undefined, onRejected));
  };
  catchDesc.writable = true;
  catchDesc.configurable = true;
  catchDesc.enumerable = false;
  _ObjectDefineProperty(p, 'catch', catchDesc);

  const finallyDesc = _ObjectCreate(null);
  finallyDesc.value = function safeFinally(onFinally) {
    if (typeof onFinally !== 'function') {
      return hardenReturnedPromise(_PromiseThen(p, onFinally, onFinally));
    }
    const settled = new _Promise((resolve, reject) => {
      _PromiseThen(
        p,
        (val) => {
          try {
            const finRet = onFinally();
            if (finRet !== null && typeof finRet === 'object' && _ObjectGetPrototypeOf(finRet) === _PromisePrototype) {
              pinSafePromiseConstructor(finRet);
              _PromiseThen(finRet, () => resolve(shadowThenableOnResolvedValue(val)), reject);
            } else {
              resolve(shadowThenableOnResolvedValue(val));
            }
          } catch (err) {
            reject(err);
          }
        },
        (reason) => {
          try {
            const finRet = onFinally();
            if (finRet !== null && typeof finRet === 'object' && _ObjectGetPrototypeOf(finRet) === _PromisePrototype) {
              pinSafePromiseConstructor(finRet);
              _PromiseThen(finRet, () => reject(reason), reject);
            } else {
              reject(reason);
            }
          } catch (err) {
            reject(err);
          }
        }
      );
    });
    return hardenReturnedPromise(settled);
  };
  finallyDesc.writable = true;
  finallyDesc.configurable = true;
  finallyDesc.enumerable = false;
  _ObjectDefineProperty(p, 'finally', finallyDesc);

  return p;
}

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

function copyArrayPlain(src) {
  const out = [];
  if (!_ArrayIsArray(src)) return out;
  for (let i = 0; i < src.length; i += 1) {
    if (_ObjectHasOwn(src, i)) {
      pushSafe(out, src[i]);
    }
  }
  return out;
}

function createServiceBus({ onServiceRegistryChange = null } = {}) {
  const services = new _Map(); // serviceName -> null-proto { providerPluginId, name, allowedCallers, impl }

  function notifyChange(serviceName, action) {
    if (typeof onServiceRegistryChange === 'function') {
      try {
        onServiceRegistryChange(serviceName, action);
      } catch (_e) {}
    }
  }

  function provide(pluginMeta, serviceName, impl, opts) {
    // R3-BLK-03: Read every metadata/permission/opts property via own-property lookup only.
    const pluginId = getOwn(pluginMeta, 'pluginId');
    const trustLevel = getOwn(pluginMeta, 'trustLevel') || 'restricted';
    const isV3 = !!(getOwn(pluginMeta, 'sourceSchemaVersion') === 3 || getOwn(pluginMeta, 'apiVersion') === 3);
    const perms = getOwn(pluginMeta, 'permissions');
    const svcPerms = getOwn(perms, 'services');
    const rawProvide = getOwn(svcPerms, 'provide');
    const declaredProvide = _ArrayIsArray(rawProvide) ? rawProvide : [];
    let declaredEntry = null;
    for (let i = 0; i < declaredProvide.length; i += 1) {
      if (!_ObjectHasOwn(declaredProvide, i)) continue;
      const p = declaredProvide[i];
      if (p && typeof p === 'object' && getOwn(p, 'name') === serviceName) {
        declaredEntry = p;
        break;
      }
    }
    const isHostWellKnown = typeof serviceName === 'string' && _StringStartsWith(serviceName, 'host.');

    // BLK-01: Well-known `host.*` services strictly require trusted + manifest declaration.
    // Never honor plugin-supplied `opts.allowWellKnownHostServices`.
    if (isHostWellKnown && (trustLevel !== 'trusted' || !declaredEntry)) {
      throw new _Error(`ERR_SERVICE_HOST_TRUST_FORBIDDEN:${serviceName}`);
    }
    const allowWellKnown = isHostWellKnown && trustLevel === 'trusted' && !!declaredEntry;

    const nameOpts = _ObjectCreate(null);
    nameOpts.allowWellKnownHostServices = allowWellKnown;
    const nameCheck = validateServiceName(pluginId, serviceName, nameOpts);
    if (!nameCheck.ok) {
      throw new _Error(`${nameCheck.reason}:${serviceName}`);
    }
    // Enforce manifest declaration on v3 manifests
    if (isV3 && !declaredEntry) {
      throw new _Error(`ERR_SERVICE_NOT_DECLARED:${serviceName}`);
    }
    if (!impl || typeof impl !== 'object') {
      throw new _Error('ERR_INVALID_SERVICE_IMPL');
    }
    if (_MapHas(services, serviceName) && _MapGet(services, serviceName).providerPluginId !== pluginId) {
      throw new _Error(`ERR_SERVICE_ALREADY_PROVIDED:${serviceName}`);
    }

    // Runtime opts.allowedCallers may only narrow (never widen) manifest-declared allowedCallers
    const rawManifestCallers = getOwn(declaredEntry, 'allowedCallers');
    const manifestCallers = _ArrayIsArray(rawManifestCallers) ? copyArrayPlain(rawManifestCallers) : [];
    const rawOptCallers = getOwn(opts, 'allowedCallers');
    let allowedCallers;
    if (declaredEntry) {
      if (_ArrayIsArray(rawOptCallers)) {
        let hasWildcard = false;
        const allowedSet = new _Set();
        for (let i = 0; i < manifestCallers.length; i += 1) {
          if (manifestCallers[i] === '*') hasWildcard = true;
          _SetAdd(allowedSet, manifestCallers[i]);
        }
        if (hasWildcard) {
          allowedCallers = copyArrayPlain(rawOptCallers);
        } else {
          allowedCallers = [];
          for (let i = 0; i < rawOptCallers.length; i += 1) {
            if (!_ObjectHasOwn(rawOptCallers, i)) continue;
            const c = rawOptCallers[i];
            if (_SetHas(allowedSet, c)) pushSafe(allowedCallers, c);
          }
        }
      } else {
        allowedCallers = manifestCallers;
      }
    } else {
      allowedCallers = _ArrayIsArray(rawOptCallers) ? copyArrayPlain(rawOptCallers) : [];
    }

    const record = _ObjectCreate(null);
    record.providerPluginId = pluginId;
    record.name = serviceName;
    record.allowedCallers = _ObjectFreeze(allowedCallers);
    record.impl = impl;
    _MapSet(services, serviceName, _ObjectFreeze(record));
    notifyChange(serviceName, 'provide');

    return _ObjectFreeze({
      name: serviceName,
      dispose() {
        const cur = _MapGet(services, serviceName);
        if (cur && cur.providerPluginId === pluginId) {
          _MapDelete(services, serviceName);
          notifyChange(serviceName, 'dispose');
        }
      },
    });
  }

  function has(callerPluginId, serviceName) {
    const rec = _MapGet(services, serviceName);
    if (!rec) return false;
    return isCallerAllowed(rec.providerPluginId, callerPluginId, rec.allowedCallers);
  }

  function list(callerPluginId) {
    const out = [];
    _MapForEach(services, (rec) => {
      if (isCallerAllowed(rec.providerPluginId, callerPluginId, rec.allowedCallers)) {
        const keys = _ObjectKeys(rec.impl);
        const methods = [];
        for (let i = 0; i < keys.length; i += 1) {
          if (typeof rec.impl[keys[i]] === 'function') {
            pushSafe(methods, keys[i]);
          }
        }
        pushSafe(
          out,
          _ObjectFreeze(
            shadowThenableOnResolvedValue({
              name: rec.name,
              providerPluginId: rec.providerPluginId,
              methods: _ObjectFreeze(shadowThenableOnResolvedValue(methods)),
            })
          )
        );
      }
    });
    return _ObjectFreeze(shadowThenableOnResolvedValue(out));
  }

  function call(callerPluginId, serviceName, methodName) {
    const rec = _MapGet(services, serviceName);
    if (!rec) {
      throw new _Error(`ERR_SERVICE_NOT_FOUND:${serviceName}`);
    }
    if (!isCallerAllowed(rec.providerPluginId, callerPluginId, rec.allowedCallers)) {
      throw new _Error(`ERR_SERVICE_CALLER_FORBIDDEN:${callerPluginId}:${serviceName}`);
    }
    if (typeof methodName !== 'string' || !methodName || methodName === '__proto__' || methodName === 'constructor') {
      throw new _Error(`ERR_SERVICE_METHOD_INVALID:${_String(methodName)}`);
    }
    const fn = _ObjectHasOwn(rec.impl, methodName) ? rec.impl[methodName] : null;
    if (typeof fn !== 'function') {
      throw new _Error(`ERR_SERVICE_METHOD_NOT_FOUND:${serviceName}.${methodName}`);
    }
    // R3-BLK-01 / R6-BLK-02: Populate cleanArgs via defineSafeDataProp & deep-shadow own `then: undefined`.
    const cleanArgs = [];
    for (let i = 3; i < arguments.length; i += 1) {
      pushSafe(cleanArgs, shadowThenableDeep(sanitizeBusPayload(arguments[i])));
    }
    const ret = _ReflectApply(fn, undefined, cleanArgs);
    // R3-BLK-03 / R4-BLK-01: Only treat genuine native Promises as async, pin own constructor=undefined
    // before invoking _PromiseThen (defeating Promise[Symbol.species] & Promise.prototype.constructor),
    // and return a fresh hardened Promise immune to Promise.prototype.then / species tampering.
    if (ret !== null && typeof ret === 'object' && _ObjectGetPrototypeOf(ret) === _PromisePrototype) {
      pinSafePromiseConstructor(ret);
      const safePromise = new _Promise((resolve, reject) => {
        _PromiseThen(
          ret,
          (resolved) => {
            try {
              resolve(shadowThenableDeep(sanitizeBusPayload(resolved)));
            } catch (err) {
              reject(err);
            }
          },
          reject
        );
      });
      return hardenReturnedPromise(safePromise);
    }
    return shadowThenableDeep(sanitizeBusPayload(ret));
  }

  function getInternalService(serviceName) {
    return _MapGet(services, serviceName) || null;
  }

  function disposePlugin(pluginId) {
    const toRemove = [];
    _MapForEach(services, (rec, name) => {
      if (rec.providerPluginId === pluginId) {
        pushSafe(toRemove, name);
      }
    });
    for (let i = 0; i < toRemove.length; i += 1) {
      _MapDelete(services, toRemove[i]);
      notifyChange(toRemove[i], 'dispose');
    }
  }

  return _ObjectFreeze({
    provide,
    has,
    list,
    call,
    getInternalService,
    disposePlugin,
  });
}

module.exports = {
  createServiceBus,
};
