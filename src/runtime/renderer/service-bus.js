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

function createServiceBus({ onServiceRegistryChange = null } = {}) {
  const services = new Map(); // serviceName -> { providerPluginId, name, allowedCallers, impl }

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
    const isV3 = Boolean(pluginMeta && (pluginMeta.sourceSchemaVersion === 3 || pluginMeta.apiVersion === 3));
    const declaredProvide =
      pluginMeta &&
      pluginMeta.permissions &&
      pluginMeta.permissions.services &&
      Array.isArray(pluginMeta.permissions.services.provide)
        ? pluginMeta.permissions.services.provide
        : [];
    const declaredEntry = declaredProvide.find((p) => p && p.name === serviceName) || null;
    const isHostWellKnown = typeof serviceName === 'string' && serviceName.startsWith('host.');

    // BLK-01: Well-known `host.*` services strictly require trusted + manifest declaration.
    // Never honor plugin-supplied `opts.allowWellKnownHostServices`.
    if (isHostWellKnown && (trustLevel !== 'trusted' || !declaredEntry)) {
      throw new Error(`ERR_SERVICE_HOST_TRUST_FORBIDDEN:${serviceName}`);
    }
    const allowWellKnown = isHostWellKnown && trustLevel === 'trusted' && Boolean(declaredEntry);

    const nameCheck = validateServiceName(pluginId, serviceName, { allowWellKnownHostServices: allowWellKnown });
    if (!nameCheck.ok) {
      throw new Error(`${nameCheck.reason}:${serviceName}`);
    }
    // Enforce manifest declaration when permissions.services.provide is used or on v3 manifests
    if (isV3 && !declaredEntry) {
      throw new Error(`ERR_SERVICE_NOT_DECLARED:${serviceName}`);
    }
    if (!impl || typeof impl !== 'object') {
      throw new Error('ERR_INVALID_SERVICE_IMPL');
    }
    if (services.has(serviceName) && services.get(serviceName).providerPluginId !== pluginId) {
      throw new Error(`ERR_SERVICE_ALREADY_PROVIDED:${serviceName}`);
    }

    // Runtime opts.allowedCallers may only narrow (never widen) manifest-declared allowedCallers
    const manifestCallers =
      declaredEntry && Array.isArray(declaredEntry.allowedCallers) ? declaredEntry.allowedCallers.slice() : [];
    let allowedCallers;
    if (declaredEntry) {
      if (Array.isArray(opts && opts.allowedCallers)) {
        if (manifestCallers.includes('*')) {
          allowedCallers = opts.allowedCallers.slice();
        } else {
          const allowedSet = new Set(manifestCallers);
          allowedCallers = opts.allowedCallers.filter((c) => allowedSet.has(c));
        }
      } else {
        allowedCallers = manifestCallers;
      }
    } else {
      allowedCallers = Array.isArray(opts && opts.allowedCallers) ? opts.allowedCallers.slice() : [];
    }

    services.set(serviceName, {
      providerPluginId: pluginId,
      name: serviceName,
      allowedCallers,
      impl,
    });
    notifyChange(serviceName, 'provide');

    return Object.freeze({
      name: serviceName,
      dispose() {
        const cur = services.get(serviceName);
        if (cur && cur.providerPluginId === pluginId) {
          services.delete(serviceName);
          notifyChange(serviceName, 'dispose');
        }
      },
    });
  }

  function has(callerPluginId, serviceName) {
    const rec = services.get(serviceName);
    if (!rec) return false;
    return isCallerAllowed(rec.providerPluginId, callerPluginId, rec.allowedCallers);
  }

  function list(callerPluginId) {
    const out = [];
    for (const rec of services.values()) {
      if (isCallerAllowed(rec.providerPluginId, callerPluginId, rec.allowedCallers)) {
        out.push(
          Object.freeze({
            name: rec.name,
            providerPluginId: rec.providerPluginId,
            methods: Object.freeze(Object.keys(rec.impl).filter((k) => typeof rec.impl[k] === 'function')),
          })
        );
      }
    }
    return Object.freeze(out);
  }

  function call(callerPluginId, serviceName, methodName, ...args) {
    const rec = services.get(serviceName);
    if (!rec) {
      throw new Error(`ERR_SERVICE_NOT_FOUND:${serviceName}`);
    }
    if (!isCallerAllowed(rec.providerPluginId, callerPluginId, rec.allowedCallers)) {
      throw new Error(`ERR_SERVICE_CALLER_FORBIDDEN:${callerPluginId}:${serviceName}`);
    }
    if (typeof methodName !== 'string' || !methodName || methodName === '__proto__' || methodName === 'constructor') {
      throw new Error(`ERR_SERVICE_METHOD_INVALID:${String(methodName)}`);
    }
    const fn = Object.prototype.hasOwnProperty.call(rec.impl, methodName) ? rec.impl[methodName] : null;
    if (typeof fn !== 'function') {
      throw new Error(`ERR_SERVICE_METHOD_NOT_FOUND:${serviceName}.${methodName}`);
    }
    const cleanArgs = args.map((a) => sanitizeBusPayload(a));
    const ret = fn.apply(undefined, cleanArgs);
    if (ret && typeof ret.then === 'function') {
      return ret.then((resolved) => sanitizeBusPayload(resolved));
    }
    return sanitizeBusPayload(ret);
  }

  function getInternalService(serviceName) {
    return services.get(serviceName) || null;
  }

  function disposePlugin(pluginId) {
    for (const [name, rec] of Array.from(services.entries())) {
      if (rec.providerPluginId === pluginId) {
        services.delete(name);
        notifyChange(name, 'dispose');
      }
    }
  }

  return Object.freeze({
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
