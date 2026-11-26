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

// NEW-BLK-01: Capture JS primordials at module load so shared World 998 prototype tampering cannot hijack host.statusbar or ACLs.
const _Error = Error;
const _ObjectFreeze = Object.freeze;
const _ObjectKeys = Object.keys;
const _ObjectHasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
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

function copyArrayPlain(src) {
  const out = [];
  if (!_ArrayIsArray(src)) return out;
  for (let i = 0; i < src.length; i += 1) {
    out[out.length] = src[i];
  }
  return out;
}

function createServiceBus({ onServiceRegistryChange = null } = {}) {
  const services = new _Map(); // serviceName -> { providerPluginId, name, allowedCallers, impl }

  function notifyChange(serviceName, action) {
    if (typeof onServiceRegistryChange === 'function') {
      try {
        onServiceRegistryChange(serviceName, action);
      } catch (_e) {}
    }
  }

  function provide(pluginMeta, serviceName, impl, opts = {}) {
    const pluginId = pluginMeta && pluginMeta.pluginId;
    const trustLevel = (pluginMeta && pluginMeta.trustLevel) || 'restricted';
    const isV3 = !!(pluginMeta && (pluginMeta.sourceSchemaVersion === 3 || pluginMeta.apiVersion === 3));
    const declaredProvide =
      pluginMeta &&
      pluginMeta.permissions &&
      pluginMeta.permissions.services &&
      _ArrayIsArray(pluginMeta.permissions.services.provide)
        ? pluginMeta.permissions.services.provide
        : [];
    let declaredEntry = null;
    for (let i = 0; i < declaredProvide.length; i += 1) {
      const p = declaredProvide[i];
      if (p && p.name === serviceName) {
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

    const nameCheck = validateServiceName(pluginId, serviceName, { allowWellKnownHostServices: allowWellKnown });
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
    const manifestCallers =
      declaredEntry && _ArrayIsArray(declaredEntry.allowedCallers) ? copyArrayPlain(declaredEntry.allowedCallers) : [];
    let allowedCallers;
    if (declaredEntry) {
      if (_ArrayIsArray(opts && opts.allowedCallers)) {
        let hasWildcard = false;
        const allowedSet = new _Set();
        for (let i = 0; i < manifestCallers.length; i += 1) {
          if (manifestCallers[i] === '*') hasWildcard = true;
          _SetAdd(allowedSet, manifestCallers[i]);
        }
        if (hasWildcard) {
          allowedCallers = copyArrayPlain(opts.allowedCallers);
        } else {
          allowedCallers = [];
          for (let i = 0; i < opts.allowedCallers.length; i += 1) {
            const c = opts.allowedCallers[i];
            if (_SetHas(allowedSet, c)) allowedCallers[allowedCallers.length] = c;
          }
        }
      } else {
        allowedCallers = manifestCallers;
      }
    } else {
      allowedCallers = _ArrayIsArray(opts && opts.allowedCallers) ? copyArrayPlain(opts.allowedCallers) : [];
    }

    _MapSet(services, serviceName, {
      providerPluginId: pluginId,
      name: serviceName,
      allowedCallers,
      impl,
    });
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
            methods[methods.length] = keys[i];
          }
        }
        out[out.length] = _ObjectFreeze({
          name: rec.name,
          providerPluginId: rec.providerPluginId,
          methods: _ObjectFreeze(methods),
        });
      }
    });
    return _ObjectFreeze(out);
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
      throw new _Error(`ERR_SERVICE_METHOD_INVALID:${String(methodName)}`);
    }
    const fn = _ObjectHasOwn(rec.impl, methodName) ? rec.impl[methodName] : null;
    if (typeof fn !== 'function') {
      throw new _Error(`ERR_SERVICE_METHOD_NOT_FOUND:${serviceName}.${methodName}`);
    }
    const cleanArgs = [];
    for (let i = 3; i < arguments.length; i += 1) {
      cleanArgs[cleanArgs.length] = sanitizeBusPayload(arguments[i]);
    }
    const ret = _ReflectApply(fn, undefined, cleanArgs);
    if (ret && typeof ret.then === 'function') {
      return ret.then((resolved) => sanitizeBusPayload(resolved));
    }
    return sanitizeBusPayload(ret);
  }

  function getInternalService(serviceName) {
    return _MapGet(services, serviceName) || null;
  }

  function disposePlugin(pluginId) {
    const toRemove = [];
    _MapForEach(services, (rec, name) => {
      if (rec.providerPluginId === pluginId) {
        toRemove[toRemove.length] = name;
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
