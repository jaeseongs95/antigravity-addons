'use strict';
// Auto-generated World 998 Renderer Kernel Bundle (zero external dependencies).
(function() {
  const __mods = {
  "../../core/ui-schema-validator.js": function(module, exports, require) {
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

  },
  "../../core/service-bus-policy.js": function(module, exports, require) {
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

  },
  "../../core/net-policy.js": function(module, exports, require) {
'use strict';

/**
 * Pure vendor- & runtime-neutral Dual-Key Network Policy Engine (v3.0.0 — SOLID #0).
 *
 * ZERO Node.js built-in imports, ZERO vendor literals.
 *
 * Enforces the locked deliberation contract:
 * 1. `permissions.net.httpsHosts` (Desktop + Remote Web):
 *    - Public HTTPS FQDN only (`<= 253` chars, no wildcards, no raw IPv4/IPv6,
 *      no `localhost`, no internal suffixes, no profile-forbidden auth/host origins).
 *    - `credentials: 'omit'`, forbidden headers stripped (`Cookie`, `Host`, `Origin`, `Referer`).
 *    - Manual redirects up to `MAX_HTTPS_REDIRECTS` (3), re-validating every hop.
 *    - DNS pre-resolution IP classifier blocks RFC1918, loopback, link-local, IMDS (`169.254.169.254`),
 *      CGNAT, multicast, and IPv4-mapped IPv6 equivalents.
 * 2. `permissions.net.localLoopback` (Desktop `trusted` ONLY):
 *    - Explicit integer ports (`1024..65535`) or profile-resolved named targets (no wildcards).
 *    - Normalizes `localhost` -> `127.0.0.1` literal.
 *    - ZERO redirects (`MAX_LOOPBACK_REDIRECTS = 0`).
 *    - Strictly omitted / denied on Remote Web.
 */

const MAX_FQDN_LENGTH = 253;
const PUBLIC_FQDN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const NAMED_LOOPBACK_TARGET_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const MAX_HTTPS_REDIRECTS = 3;
const MAX_LOOPBACK_REDIRECTS = 0;

const FORBIDDEN_INTERNAL_SUFFIXES = Object.freeze([
  '.local',
  '.internal',
  '.localhost',
  '.localdomain',
  '.lan',
  '.home',
  '.corp',
  '.intranet',
  '.arpa',
  '.home.arpa',
]);

const FORBIDDEN_REQUEST_HEADERS = Object.freeze([
  'cookie',
  'cookie2',
  'host',
  'origin',
  'referer',
  'proxy-authorization',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-real-ip',
]);

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

function normalizeHostName(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim().toLowerCase();
  if (s.endsWith('.')) s = s.slice(0, -1);
  return s;
}

function isForbiddenHostMatch(host, forbiddenHosts = []) {
  if (!host) return true;
  if (host === 'localhost') return true;
  for (let i = 0; i < FORBIDDEN_INTERNAL_SUFFIXES.length; i += 1) {
    if (host.endsWith(FORBIDDEN_INTERNAL_SUFFIXES[i])) return true;
  }
  if (Array.isArray(forbiddenHosts)) {
    for (let i = 0; i < forbiddenHosts.length; i += 1) {
      const f = normalizeHostName(forbiddenHosts[i]);
      if (!f) continue;
      if (host === f || host.endsWith(`.${f}`)) return true;
    }
  }
  return false;
}

function isPublicFqdnHost(rawHost, { forbiddenHosts = [] } = {}) {
  const host = normalizeHostName(rawHost);
  if (!host || host.length > MAX_FQDN_LENGTH) return false;
  if (host.includes('*') || host.includes(':') || host.includes('/') || host.includes('@')) return false;
  if (!PUBLIC_FQDN_RE.test(host)) return false;
  if (isForbiddenHostMatch(host, forbiddenHosts)) return false;
  return true;
}

function parseIpv4Octets(ip) {
  const parts = String(ip || '').trim().split('.');
  if (parts.length !== 4) return null;
  const out = [];
  for (let i = 0; i < 4; i += 1) {
    if (!/^\d{1,3}$/.test(parts[i])) return null;
    if (parts[i].length > 1 && parts[i].startsWith('0')) return null;
    const n = Number(parts[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out.push(n);
  }
  return out;
}

function isPrivateOrReservedIpv4Octets(octets) {
  if (!octets || octets.length !== 4) return true;
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8 (RFC1918)
  if (a === 127) return true; // 127.0.0.0/8 (Loopback)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (Link-local & Cloud IMDS 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC1918)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC1918)
  if (a === 192 && b === 0 && (octets[2] === 0 || octets[2] === 2)) return true; // IETF / TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // Benchmarking
  if (a === 198 && b === 51 && octets[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && octets[2] === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // Multicast & Reserved (224.0.0.0/4, 240.0.0.0/4, broadcast)
  return false;
}

function expandIpv6Groups(rawIp) {
  let ip = String(rawIp || '').trim().toLowerCase();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const zoneIdx = ip.indexOf('%');
  if (zoneIdx !== -1) ip = ip.slice(0, zoneIdx);
  if (!ip.includes(':')) return null;

  // Handle embedded IPv4 tail (e.g. ::ffff:127.0.0.1)
  const lastColon = ip.lastIndexOf(':');
  const tail = ip.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4Octets(tail);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    ip = `${ip.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = halves.length === 2 ? 8 - (left.length + right.length) : 0;
  if (missing < 0 || (halves.length === 1 && left.length !== 8)) return null;

  const groups = [...left, ...new Array(missing).fill('0'), ...right];
  if (groups.length !== 8) return null;
  const nums = [];
  for (let i = 0; i < 8; i += 1) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null;
    nums.push(parseInt(groups[i], 16));
  }
  return nums;
}

/**
 * Returns true if the IP address is private, loopback, link-local, IMDS, multicast,
 * reserved, IPv4-mapped private IPv6, or unparseable (fail-closed).
 */
function isPrivateOrReservedIp(rawIp) {
  if (typeof rawIp !== 'string' || !rawIp.trim()) return true;
  const trimmed = rawIp.trim();
  const v4 = parseIpv4Octets(trimmed);
  if (v4) {
    return isPrivateOrReservedIpv4Octets(v4);
  }
  const v6 = expandIpv6Groups(trimmed);
  if (!v6) return true; // Fail-closed on unparseable IP

  const allZeroPrefix6 = v6[0] === 0 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0 && v6[4] === 0;
  // Unspecified :: and Loopback ::1
  if (allZeroPrefix6 && v6[5] === 0 && v6[6] === 0 && (v6[7] === 0 || v6[7] === 1)) {
    return true;
  }
  // IPv4-mapped ::ffff:0:0/96, IPv4-compatible ::/96, RFC 2765 ::ffff:0:0:0/96, or NAT64 64:ff9b::/96
  const isV4Mapped = allZeroPrefix6 && (v6[5] === 0xffff || v6[5] === 0);
  const isV4Translated = v6[0] === 0 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0 && v6[4] === 0xffff && v6[5] === 0;
  const isNat64 = v6[0] === 0x0064 && v6[1] === 0xff9b && v6[2] === 0 && v6[3] === 0 && v6[4] === 0 && v6[5] === 0;
  if (isV4Mapped || isV4Translated || isNat64) {
    const mappedOctets = [(v6[6] >> 8) & 0xff, v6[6] & 0xff, (v6[7] >> 8) & 0xff, v6[7] & 0xff];
    return isPrivateOrReservedIpv4Octets(mappedOctets);
  }
  // RFC 8215 Local-Use NAT64 64:ff9b:1::/48
  if (v6[0] === 0x0064 && v6[1] === 0xff9b && v6[2] === 0x0001) return true;
  // RFC 6666 Discard-Only 100::/64
  if (v6[0] === 0x0100 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0) return true;
  // 6to4 2002::/16 (always block to prevent tunneled SSRF)
  if (v6[0] === 0x2002) return true;
  // Teredo 2001:0000::/32
  if (v6[0] === 0x2001 && v6[1] === 0x0000) return true;
  // Unique Local fc00::/7
  if ((v6[0] & 0xfe00) === 0xfc00) return true;
  // Link-Local fe80::/10
  if ((v6[0] & 0xffc0) === 0xfe80) return true;
  // Site-Local (deprecated) fec0::/10
  if ((v6[0] & 0xffc0) === 0xfec0) return true;
  // Multicast ff00::/8
  if ((v6[0] & 0xff00) === 0xff00) return true;
  // Documentation 2001:db8::/32
  if (v6[0] === 0x2001 && v6[1] === 0x0db8) return true;
  return false;
}

function normalizeLoopbackTarget(entry) {
  if (typeof entry === 'number' && Number.isInteger(entry) && entry >= 1024 && entry <= 65535) {
    return { kind: 'port', port: entry };
  }
  if (typeof entry === 'string') {
    const trimmed = entry.trim();
    if (NAMED_LOOPBACK_TARGET_RE.test(trimmed)) {
      return { kind: 'named', name: trimmed };
    }
  }
  return null;
}

function validateNetPermissions(netPerm, { trustLevel = 'restricted', forbiddenHosts = [] } = {}) {
  if (netPerm === null || netPerm === undefined) {
    return { ok: true, httpsHosts: [], localLoopback: [], userApprovedHttps: false };
  }
  if (typeof netPerm !== 'object' || Array.isArray(netPerm)) {
    return { ok: false, reason: 'ERR_INVALID_NET_PERMISSIONS', errors: ['permissions.net must be an object'] };
  }
  const errors = [];
  const httpsHosts = [];
  const seenHosts = new Set();
  if (netPerm.httpsHosts !== undefined) {
    if (!Array.isArray(netPerm.httpsHosts)) {
      errors.push('permissions.net.httpsHosts must be an array');
    } else {
      for (let i = 0; i < netPerm.httpsHosts.length; i += 1) {
        const raw = netPerm.httpsHosts[i];
        const norm = normalizeHostName(raw);
        if (!isPublicFqdnHost(norm, { forbiddenHosts })) {
          errors.push(`Invalid or forbidden httpsHost "${String(raw)}"`);
        } else if (!seenHosts.has(norm)) {
          seenHosts.add(norm);
          httpsHosts.push(norm);
        }
      }
    }
  }

  let userApprovedHttps = false;
  if (netPerm.userApprovedHttps !== undefined) {
    if (typeof netPerm.userApprovedHttps !== 'boolean') {
      errors.push('permissions.net.userApprovedHttps must be a boolean');
    } else {
      userApprovedHttps = netPerm.userApprovedHttps;
    }
  }

  const localLoopback = [];
  const seenLoopback = new Set();
  if (netPerm.localLoopback !== undefined) {
    if (!Array.isArray(netPerm.localLoopback)) {
      errors.push('permissions.net.localLoopback must be an array');
    } else {
      if (netPerm.localLoopback.length > 0 && trustLevel !== 'trusted') {
        return {
          ok: false,
          reason: 'ERR_RESTRICTED_LOCAL_LOOPBACK_FORBIDDEN',
          errors: ['permissions.net.localLoopback requires trustLevel: "trusted" and Desktop host trust approval'],
        };
      }
      for (let i = 0; i < netPerm.localLoopback.length; i += 1) {
        const parsed = normalizeLoopbackTarget(netPerm.localLoopback[i]);
        if (!parsed) {
          errors.push(`Invalid localLoopback target "${String(netPerm.localLoopback[i])}" (must be port 1024..65535 or named target)`);
        } else {
          const key = parsed.kind === 'port' ? `port:${parsed.port}` : `named:${parsed.name}`;
          if (!seenLoopback.has(key)) {
            seenLoopback.add(key);
            localLoopback.push(parsed.kind === 'port' ? parsed.port : parsed.name);
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, reason: 'ERR_INVALID_NET_PERMISSIONS', errors };
  }
  return { ok: true, httpsHosts, localLoopback, userApprovedHttps };
}

function sanitizeNetHeaders(rawHeaders) {
  const clean = {};
  if (!rawHeaders || typeof rawHeaders !== 'object') return clean;
  const entries = Array.isArray(rawHeaders) ? rawHeaders : Object.entries(rawHeaders);
  for (let i = 0; i < entries.length; i += 1) {
    const pair = entries[i];
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const rawName = String(pair[0] || '').trim();
    const lower = rawName.toLowerCase();
    if (!rawName || !/^[a-z0-9-]+$/i.test(rawName)) continue;
    if (
      FORBIDDEN_REQUEST_HEADERS.includes(lower) ||
      lower.startsWith('sec-fetch-') ||
      lower.startsWith('proxy-') ||
      lower.startsWith('x-addon-host-')
    ) {
      continue;
    }
    const rawVal = String(pair[1] === undefined || pair[1] === null ? '' : pair[1]);
    if (/[\r\n\0]/.test(rawVal)) continue;
    clean[rawName] = rawVal;
  }
  return clean;
}

/**
 * Classifies and authorizes a single `net.fetch(url, init)` target against a plugin's
 * validated dual-key net policy.
 *
 * @param {string} rawUrl
 * @param {object} init
 * @param {{
 *   httpsHosts?: string[],
 *   localLoopback?: Array<number|string>,
 *   namedLoopbackPorts?: Record<string, number>,
 *   forbiddenHosts?: string[],
 *   allowLoopback?: boolean,
 * }} policy
 */
function evaluateNetRequest(rawUrl, init = {}, policy = {}) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { ok: false, reason: 'ERR_NET_INVALID_URL' };
  }
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch (_e) {
    return { ok: false, reason: 'ERR_NET_INVALID_URL' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'ERR_NET_CREDENTIALS_IN_URL_FORBIDDEN' };
  }

  const method = String((init && init.method) || 'GET').trim().toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    return { ok: false, reason: `ERR_NET_METHOD_FORBIDDEN:${method}` };
  }

  const headers = sanitizeNetHeaders(init && init.headers);
  const rawHost = normalizeHostName(parsed.hostname);
  const isLoopbackHost = rawHost === 'localhost' || rawHost === '127.0.0.1' || rawHost === '[::1]' || rawHost === '::1';

  if (isLoopbackHost) {
    if (policy.allowLoopback !== true) {
      return { ok: false, reason: 'ERR_NET_LOOPBACK_NOT_SUPPORTED' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, reason: 'ERR_NET_SCHEME_FORBIDDEN' };
    }
    const explicitPort = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    if (!Number.isInteger(explicitPort) || explicitPort < 1024 || explicitPort > 65535) {
      return { ok: false, reason: 'ERR_NET_LOOPBACK_PORT_FORBIDDEN' };
    }
    const allowedPorts = new Set();
    const declared = Array.isArray(policy.localLoopback) ? policy.localLoopback : [];
    const namedMap = policy.namedLoopbackPorts && typeof policy.namedLoopbackPorts === 'object' ? policy.namedLoopbackPorts : {};
    let hasNamedTarget = false;
    for (let i = 0; i < declared.length; i += 1) {
      const entry = declared[i];
      if (typeof entry === 'number' && Number.isInteger(entry) && entry >= 1024 && entry <= 65535) {
        allowedPorts.add(entry);
      } else if (typeof entry === 'string') {
        hasNamedTarget = true;
        if (Object.prototype.hasOwnProperty.call(namedMap, entry)) {
          const resolvedPort = Number(namedMap[entry]);
          if (Number.isInteger(resolvedPort) && resolvedPort >= 1024 && resolvedPort <= 65535) {
            allowedPorts.add(resolvedPort);
          }
        }
      }
    }
    if (hasNamedTarget && Array.isArray(policy.dynamicLoopbackPorts)) {
      for (let i = 0; i < policy.dynamicLoopbackPorts.length; i += 1) {
        const dynPort = Number(policy.dynamicLoopbackPorts[i]);
        if (Number.isInteger(dynPort) && dynPort >= 1024 && dynPort <= 65535) {
          allowedPorts.add(dynPort);
        }
      }
    }
    if (!allowedPorts.has(explicitPort)) {
      return { ok: false, reason: `ERR_NET_LOOPBACK_PORT_NOT_ALLOWED:${explicitPort}` };
    }
    // Always normalize localhost / ::1 -> 127.0.0.1 literal, 0 redirects
    const normalizedUrl = `${parsed.protocol}//127.0.0.1:${explicitPort}${parsed.pathname}${parsed.search}`;
    return {
      ok: true,
      channel: 'localLoopback',
      method,
      url: normalizedUrl,
      hostname: '127.0.0.1',
      port: explicitPort,
      protocol: parsed.protocol,
      path: `${parsed.pathname}${parsed.search}`,
      headers,
      maxRedirects: MAX_LOOPBACK_REDIRECTS,
      credentials: 'omit',
    };
  }

  // Public HTTPS FQDN channel
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'ERR_NET_HTTPS_REQUIRED' };
  }
  const port = parsed.port ? Number(parsed.port) : 443;
  if (!Number.isInteger(port) || port !== 443) {
    return { ok: false, reason: 'ERR_NET_NON_STANDARD_HTTPS_PORT_FORBIDDEN' };
  }
  const forbiddenHosts = Array.isArray(policy.forbiddenHosts) ? policy.forbiddenHosts : [];
  if (!isPublicFqdnHost(rawHost, { forbiddenHosts })) {
    return { ok: false, reason: `ERR_NET_HOST_FORBIDDEN:${rawHost}` };
  }
  const allowSet = new Set(
    (Array.isArray(policy.httpsHosts) ? policy.httpsHosts : []).map((h) => normalizeHostName(h)).filter(Boolean)
  );
  if (!allowSet.has(rawHost)) {
    return { ok: false, reason: `ERR_NET_HOST_NOT_ALLOWED:${rawHost}` };
  }

  return {
    ok: true,
    channel: 'https',
    method,
    url: parsed.href,
    hostname: rawHost,
    port: 443,
    protocol: 'https:',
    path: `${parsed.pathname}${parsed.search}`,
    headers,
    maxRedirects: MAX_HTTPS_REDIRECTS,
    credentials: 'omit',
  };
}

module.exports = {
  MAX_FQDN_LENGTH,
  PUBLIC_FQDN_RE,
  NAMED_LOOPBACK_TARGET_RE,
  MAX_HTTPS_REDIRECTS,
  MAX_LOOPBACK_REDIRECTS,
  FORBIDDEN_INTERNAL_SUFFIXES,
  FORBIDDEN_REQUEST_HEADERS,
  normalizeHostName,
  isPublicFqdnHost,
  isPrivateOrReservedIp,
  normalizeLoopbackTarget,
  validateNetPermissions,
  sanitizeNetHeaders,
  evaluateNetRequest,
};

  },
  "./ignore-guard.js": function(module, exports, require) {
'use strict';

/**
 * Shadow-DOM-aware Ignore & No-Translate Guard (FV4 / D-R4-8 / TC-025).
 *
 * - Safely uses `evt.composedPath()` when available (handles real ShadowRoot events
 *   as well as mock unit-test events that omit `composedPath`).
 * - Walks across ShadowRoot host boundaries (`node.parentNode || node.host`).
 */

function isNodeIgnored(node, extraNoTranslateAttributes = [], ignoreElements = []) {
  const ignoreSet = new Set(Array.isArray(ignoreElements) ? ignoreElements : []);
  const extraAttrs = Array.isArray(extraNoTranslateAttributes) ? extraNoTranslateAttributes : [];
  let cur = node;
  let guard = 0;
  while (cur && guard < 128) {
    guard++;
    if (ignoreSet.has(cur)) return true;
    if (typeof cur.getAttribute === 'function') {
      if (
        cur.getAttribute('translate') === 'no' ||
        cur.getAttribute('data-addon-host-no-translate') === 'true' ||
        cur.getAttribute('data-addon-host-slot') !== null
      ) {
        return true;
      }
      for (let i = 0; i < extraAttrs.length; i++) {
        const attrVal = cur.getAttribute(extraAttrs[i]);
        if (attrVal !== null && attrVal !== 'false') return true;
      }
    }
    if (cur.parentNode) {
      cur = cur.parentNode;
    } else if (cur.host) {
      cur = cur.host;
    } else {
      break;
    }
  }
  return false;
}

function isElementInsideIgnored(nodeOrEvent, { extraNoTranslateAttributes = [], ignoreElements = [] } = {}) {
  if (!nodeOrEvent) return false;
  const ignoreSet = new Set(Array.isArray(ignoreElements) ? ignoreElements : []);

  // R-5: Distinguish DOM nodes (e.g. <a>, <form>, <area>, <base> which have a `.target` property) from Events
  const isDomNode = typeof nodeOrEvent.nodeType === 'number';
  if (!isDomNode && typeof nodeOrEvent === 'object' && ('target' in nodeOrEvent || typeof nodeOrEvent.composedPath === 'function')) {
    const pathNodes =
      typeof nodeOrEvent.composedPath === 'function'
        ? nodeOrEvent.composedPath()
        : nodeOrEvent.target
          ? [nodeOrEvent.target]
          : [];
    for (let i = 0; i < pathNodes.length; i++) {
      const n = pathNodes[i];
      if (!n) continue;
      if (ignoreSet.has(n)) return true;
      if (isNodeIgnored(n, extraNoTranslateAttributes, ignoreElements)) return true;
    }
    return false;
  }

  return isNodeIgnored(nodeOrEvent, extraNoTranslateAttributes, ignoreElements);
}

module.exports = {
  isNodeIgnored,
  isElementInsideIgnored,
};

  },
  "./style-manager.js": function(module, exports, require) {
'use strict';

/**
 * ShadowRoot-aware & Owner-Scoped CSS Style Manager (FV4 / D-R4-8 / TC-021 / TC-024).
 *
 * - Rejects dangerous CSS constructs (`@import`, `expression(`, `javascript:`,
 *   `behavior:`, `-moz-binding`, `</style`, `url(javascript:...)`, unicode escapes hiding them).
 * - Preserves `{ scope: 'owner' | 'global', slotId }` API contract.
 * - Restricts `scope: 'global'` strictly to trusted plugins.
 * - Routes styles into ShadowRoot (`<style>` inside ShadowRoot, compatible with strict CSP
 *   and mock DOMs) AND syncs owner styles automatically when Shadow slots mount later.
 */

const DANGEROUS_CSS_PATTERNS = [
  /@import\b/i,
  /expression\s*\(/i,
  /javascript\s*:/i,
  /vbscript\s*:/i,
  /-moz-binding\s*:/i,
  /behavior\s*:/i,
  /<\s*\/\s*style/i,
  /@charset\b/i,
];

const ALLOWED_OWNER_AT_RULES = new Set([
  '@media',
  '@supports',
  '@keyframes',
  '@-webkit-keyframes',
  '@layer',
]);

function preprocessCssInput(css) {
  // F4 (W3C CSS Syntax L3 §3.3): normalize CRLF -> LF, stray CR/FF -> LF, NUL -> U+FFFD
  return String(css || '')
    .replace(/\r\n/g, '\n')
    .replace(/[\r\f]/g, '\n')
    .replace(/\u0000/g, '\uFFFD');
}

function stripCssComments(css, replacement = ' ') {
  // F8: Default to `' '` (token separator) so `//**/*` NEVER coalesces into a live `/*` comment.
  // Callers checking keyword smuggling (`@im/**/port`) explicitly pass `''`.
  let out = '';
  let quote = null;
  const s = preprocessCssInput(css);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const next = s[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < s.length) {
        out += s[++i];
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    // F6: Respect unquoted CSS backslash escapes so `\"` never desynchronizes quote state
    if (ch === '\\' && i + 1 < s.length) {
      out += ch + s[++i];
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 1;
      out += replacement;
      continue;
    }
    out += ch;
  }
  return out;
}

function decodeCssEscapesRaw(s) {
  return preprocessCssInput(s)
    .replace(/\\\n/g, '')
    .replace(/\\([0-9a-fA-F]{1,6})[ \t\n]?/g, (_m, hex) => {
      const cp = parseInt(hex, 16);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return '';
      try {
        return String.fromCodePoint(cp);
      } catch (_e) {
        return '';
      }
    })
    .replace(/\\([^\n0-9a-fA-F])/g, '$1');
}

function decodeCssEscapesForCheck(css) {
  // S-2 + F4: Preprocess CRLF/CR/FF per CSS Syntax L3 §3.3, collapse comments (`''`) for `@im/**/port`, then decode escapes
  return decodeCssEscapesRaw(stripCssComments(preprocessCssInput(css), ''));
}

function decodeIdentEscapesForUrlCheck(css) {
  // F9: Decode ONLY ASCII ident escapes ([a-zA-Z0-9_-]) outside strings so hex quotes (\22/\27) NEVER synthesize string delimiters
  const s = preprocessCssInput(css);
  let out = '';
  let quote = null;
  let inComment = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const next = s[i + 1];
    if (inComment) {
      out += ch;
      if (ch === '*' && next === '/') {
        out += '/';
        inComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < s.length) {
        out += s[++i];
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '/*';
      inComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '\\') {
      const hexMatch = s.slice(i + 1).match(/^([0-9a-fA-F]{1,6})[ \t\n]?/);
      if (hexMatch) {
        const cp = parseInt(hexMatch[1], 16);
        const decodedCh = Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
        if (/^[a-zA-Z0-9_-]$/.test(decodedCh)) {
          out += decodedCh;
          i += hexMatch[0].length;
          continue;
        }
        out += ' ';
        i += hexMatch[0].length;
        continue;
      }
      if (i + 1 < s.length) {
        out += /^[a-zA-Z0-9_-]$/.test(next) ? next : ' ';
        i++;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function validateCssSyntaxBalanced(cssText) {
  const s = preprocessCssInput(cssText);
  // F11: Enforce full W3C CSS Syntax L3 LIFO block stack (`{}`, `()`, `[]`) and reject unquoted CDO/CDC (`<!--`/`-->`)
  const stack = [];
  let quote = null;
  let inComment = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const next = s[i + 1];
    if (inComment) {
      if (ch === '*' && next === '/') {
        inComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (ch === '\\') {
        if (i + 1 >= s.length) return false;
        i++;
        continue;
      }
      if (ch === '\n') {
        return false; // unescaped newline/CR/FF inside CSS string (CSS Syntax L3 bad-string token bypass)
      }
      if (ch === quote) quote = null;
      continue;
    }
    // F6: Respect unquoted backslash escapes (reject trailing EOF `\` or unquoted `\<newline>`)
    if (ch === '\\') {
      if (i + 1 >= s.length || next === '\n') return false;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if ((ch === '<' && s.slice(i, i + 4) === '<!--') || (ch === '-' && s.slice(i, i + 3) === '-->')) {
      return false;
    }
    if (ch === '{') stack.push('}');
    else if (ch === '(') stack.push(')');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ')' || ch === ']') {
      if (stack.length === 0 || stack[stack.length - 1] !== ch) return false;
      stack.pop();
    }
  }
  return !quote && !inComment && stack.length === 0;
}

const DANGEROUS_UNQUOTED_ESCAPED_CHARS = new Set([
  '"',
  "'",
  '{',
  '}',
  '(',
  ')',
  '[',
  ']',
  '/',
  '*',
  '\\',
  ';',
  ':',
  '@',
  ',',
  '+',
  '~',
  '>',
  '<',
]);

function hasDangerousUnquotedEscape(cssText) {
  // F6 + F9: Reject both literal (`\"`) and hex (`\22`, `\27`, `\2f`, `\7b`, etc.) unquoted escapes
  // that decode to syntax/delimiter/control characters.
  const s = preprocessCssInput(cssText);
  let quote = null;
  let inComment = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const next = s[i + 1];
    if (inComment) {
      if (ch === '*' && next === '/') {
        inComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '*') {
      inComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '\\') {
      const hexMatch = s.slice(i + 1).match(/^([0-9a-fA-F]{1,6})[ \t\n]?/);
      if (hexMatch) {
        const cp = parseInt(hexMatch[1], 16);
        if (!Number.isFinite(cp) || cp <= 0x20 || cp === 0x7f || cp > 0x10ffff) return true;
        const decodedCh = String.fromCodePoint(cp);
        if (DANGEROUS_UNQUOTED_ESCAPED_CHARS.has(decodedCh)) return true;
        i += hexMatch[0].length;
        continue;
      }
      if (i + 1 >= s.length || next === '\n' || DANGEROUS_UNQUOTED_ESCAPED_CHARS.has(next)) {
        return true;
      }
      i++;
    }
  }
  return false;
}

function hasInvalidUnquotedUrlToken(str) {
  const s = preprocessCssInput(str);
  let quote = null;
  let inComment = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const next = s[i + 1];
    if (inComment) {
      if (ch === '*' && next === '/') {
        inComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (
      (ch === 'u' || ch === 'U') &&
      s.slice(i, i + 4).toLowerCase() === 'url(' &&
      (i === 0 || !/[a-z0-9_-]/i.test(s[i - 1]))
    ) {
      let k = i + 4;
      while (k < s.length && /\s/.test(s[k])) k++;
      if (k >= s.length) return true;
      if (s[k] === '"' || s[k] === "'") {
        i += 3;
        continue;
      }
      // F4: W3C CSS Syntax L3 §4.3.6 unquoted <url-token> — reject any <bad-url-token> / quote / brace desync chars
      let closed = false;
      for (; k < s.length; k++) {
        const c = s[k];
        if (c === ')') {
          closed = true;
          break;
        }
        if (/\s/.test(c)) {
          while (k < s.length && /\s/.test(s[k])) k++;
          if (k < s.length && s[k] === ')') {
            closed = true;
            break;
          }
          return true; // whitespace-split remnant inside unquoted url(...)
        }
        const code = c.charCodeAt(0);
        // F10: Also reject `/*` inside unquoted url(...) so comment stripping cannot desync from CSS Syntax L3 §4.3.6
        if (
          (c === '/' && s[k + 1] === '*') ||
          c === '"' ||
          c === "'" ||
          c === '(' ||
          c === '\\' ||
          c === '{' ||
          c === '}' ||
          code <= 0x1f ||
          code === 0x7f
        ) {
          return true;
        }
      }
      if (!closed) return true;
      i = k;
    }
  }
  return false;
}

function splitTopLevelSelectorList(selList) {
  // F7 + F11: Split on top-level commas ONLY (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0, quote & backslash safe)
  const out = [];
  let start = 0;
  let quote = null;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  for (let i = 0; i < selList.length; i++) {
    const ch = selList[i];
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(') parenDepth++;
    else if (ch === ')' && parenDepth > 0) parenDepth--;
    else if (ch === '[') bracketDepth++;
    else if (ch === ']' && bracketDepth > 0) bracketDepth--;
    else if (ch === '{') braceDepth++;
    else if (ch === '}' && braceDepth > 0) braceDepth--;
    else if (ch === ',' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      out.push(selList.slice(start, i));
      start = i + 1;
    }
  }
  out.push(selList.slice(start));
  return out;
}

function getFirstTopLevelCombinator(selector) {
  // F7 + F11: Return the first top-level combinator ('+', '~', '>', ' ') outside quotes/parens/brackets/braces
  const s = selector.trim();
  let quote = null;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let sawSpace = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\') {
      if (sawSpace && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) return ' ';
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (sawSpace && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) return ' ';
      quote = ch;
      continue;
    }
    if (ch === '(') {
      if (sawSpace && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) return ' ';
      parenDepth++;
      continue;
    }
    if (ch === ')' && parenDepth > 0) {
      parenDepth--;
      continue;
    }
    if (ch === '[') {
      if (sawSpace && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) return ' ';
      bracketDepth++;
      continue;
    }
    if (ch === ']' && bracketDepth > 0) {
      bracketDepth--;
      continue;
    }
    if (ch === '{') {
      if (sawSpace && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) return ' ';
      braceDepth++;
      continue;
    }
    if (ch === '}' && braceDepth > 0) {
      braceDepth--;
      continue;
    }
    if (parenDepth > 0 || bracketDepth > 0 || braceDepth > 0) continue;
    if (/\s/.test(ch)) {
      sawSpace = true;
      continue;
    }
    if (ch === '+' || ch === '~' || ch === '>') {
      return ch;
    }
    if (sawSpace) {
      return ' ';
    }
  }
  return null;
}

function hasForbiddenOwnerSiblingSelector(cleanCss) {
  let i = 0;
  const len = cleanCss.length;
  while (i < len) {
    const braceIdx = findNextTopLevelChar(cleanCss, i, '{');
    if (braceIdx === -1) break;
    const semiIdx = findNextTopLevelChar(cleanCss, i, ';');
    if (semiIdx !== -1 && semiIdx < braceIdx) {
      i = semiIdx + 1;
      continue;
    }
    const prelude = cleanCss.slice(i, braceIdx);
    const closeIdx = findMatchingCloseBrace(cleanCss, braceIdx);
    const body = cleanCss.slice(braceIdx + 1, closeIdx);
    const lowerPrelude = prelude.trim().toLowerCase();
    if (lowerPrelude.startsWith('@media') || lowerPrelude.startsWith('@supports') || lowerPrelude.startsWith('@layer')) {
      if (hasForbiddenOwnerSiblingSelector(body)) return true;
    } else if (!lowerPrelude.startsWith('@')) {
      const selectors = splitTopLevelSelectorList(prelude);
      for (let sIdx = 0; sIdx < selectors.length; sIdx++) {
        const trimmed = selectors[sIdx].trim();
        if (!trimmed) continue;
        if (trimmed[0] === '+' || trimmed[0] === '~') return true;
        if (/^(?:\[\s*data-addon-host-owner\b|(?:html|body|:root)(?![a-z0-9_-]))/i.test(trimmed)) {
          const firstComb = getFirstTopLevelCombinator(trimmed);
          if (firstComb === '+' || firstComb === '~') return true;
        }
      }
    }
    i = closeIdx + 1;
  }
  return false;
}

function hasForbiddenOwnerNesting(cleanCss, inKeyframes = false) {
  let i = 0;
  const len = cleanCss.length;
  while (i < len) {
    const braceIdx = findNextTopLevelChar(cleanCss, i, '{');
    if (braceIdx === -1) break;
    const semiIdx = findNextTopLevelChar(cleanCss, i, ';');
    if (semiIdx !== -1 && semiIdx < braceIdx) {
      i = semiIdx + 1;
      continue;
    }
    const prelude = cleanCss.slice(i, braceIdx).trim().toLowerCase();
    const closeIdx = findMatchingCloseBrace(cleanCss, braceIdx);
    const body = cleanCss.slice(braceIdx + 1, closeIdx);
    if (inKeyframes) {
      if (findNextTopLevelChar(body, 0, '{') !== -1) return true;
    } else if (prelude.startsWith('@media') || prelude.startsWith('@supports') || prelude.startsWith('@layer')) {
      if (hasForbiddenOwnerNesting(body, false)) return true;
    } else if (prelude.startsWith('@keyframes') || prelude.startsWith('@-webkit-keyframes')) {
      if (hasForbiddenOwnerNesting(body, true)) return true;
    } else {
      // F5: Structurally disallow CSS Nesting Level 1 (`{` inside any non-@ style rule body) in owner scope
      if (findNextTopLevelChar(body, 0, '{') !== -1) return true;
    }
    i = closeIdx + 1;
  }
  return false;
}

function validateSafeCssText(cssText, { scope = 'owner' } = {}) {
  if (typeof cssText !== 'string') {
    return { ok: false, reason: 'ERR_CSS_NOT_STRING' };
  }
  const normalized = preprocessCssInput(cssText);
  const strippedSpace = stripCssComments(normalized, ' ');
  // F8: Verify BOTH pre-strip and space-stripped CSS are syntax-balanced (blocks `//**/*` comment synthesis)
  if (!validateCssSyntaxBalanced(normalized) || !validateCssSyntaxBalanced(strippedSpace)) {
    return { ok: false, reason: 'ERR_FORBIDDEN_CSS_SYNTAX' };
  }
  const decoded = decodeCssEscapesForCheck(normalized);
  // F10: Also check escape-decoded text WITHOUT comment stripping so unquoted `url(http://x/*)` cannot mask escaped keywords
  const decodedNoStrip = decodeCssEscapesRaw(normalized);
  for (let i = 0; i < DANGEROUS_CSS_PATTERNS.length; i++) {
    if (
      DANGEROUS_CSS_PATTERNS[i].test(decoded) ||
      DANGEROUS_CSS_PATTERNS[i].test(decodedNoStrip) ||
      DANGEROUS_CSS_PATTERNS[i].test(normalized)
    ) {
      return { ok: false, reason: 'ERR_UNSAFE_CSS_CONSTRUCT' };
    }
  }
  // F4 + F6 + F9 + F10: Reject unquoted <bad-url-token> (using ident-only decode so \22/\27 never open fake quotes),
  // unquoted `url(.../*...)`, and dangerous literal/hex unquoted escapes.
  const identDecoded = decodeIdentEscapesForUrlCheck(normalized);
  if (
    hasInvalidUnquotedUrlToken(normalized) ||
    hasInvalidUnquotedUrlToken(strippedSpace) ||
    hasInvalidUnquotedUrlToken(identDecoded) ||
    hasDangerousUnquotedEscape(normalized)
  ) {
    return { ok: false, reason: 'ERR_FORBIDDEN_CSS_SYNTAX' };
  }
  if (scope === 'owner') {
    // S-2: Reject backslash escapes inside @-rule identifiers (prevents @\media / @\6d edia scoping bypass)
    const strippedCollapsed = stripCssComments(normalized, '');
    if (/@[^;{}\s"'()]*\\/.test(strippedSpace) || /@[^;{}\s"'()]*\\/.test(strippedCollapsed)) {
      return { ok: false, reason: 'ERR_FORBIDDEN_CSS_AT_RULE' };
    }
    // Enforce strict lowercased @-rule allowlist (rejects @scope, @property, @starting-style, @font-face, @container, etc.)
    const atMatches = decoded.match(/@[a-z-]+/gi) || [];
    for (let i = 0; i < atMatches.length; i++) {
      if (!ALLOWED_OWNER_AT_RULES.has(atMatches[i].toLowerCase())) {
        return { ok: false, reason: 'ERR_FORBIDDEN_CSS_AT_RULE' };
      }
    }
    // F7: Paren/bracket-aware sibling-combinator escape check out of owner/body/root (blocks `:is(*, .x) ~ *`)
    if (hasForbiddenOwnerSiblingSelector(strippedSpace) || hasForbiddenOwnerSiblingSelector(decoded)) {
      return { ok: false, reason: 'ERR_FORBIDDEN_CSS_SELECTOR' };
    }
    if (
      /(?:&[^;{}]*[+~]|:\s*has\s*\()/i.test(decoded) ||
      hasForbiddenOwnerNesting(strippedSpace) ||
      hasForbiddenOwnerNesting(decoded)
    ) {
      return { ok: false, reason: 'ERR_FORBIDDEN_CSS_NESTING' };
    }
  }
  return { ok: true };
}

function findNextTopLevelChar(str, startIdx, targetChar) {
  // F11: Match targetChar ONLY at top level (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0)
  let quote = null;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  for (let i = startIdx; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && ch === targetChar) {
      return i;
    }
    if (ch === '(') parenDepth++;
    else if (ch === ')' && parenDepth > 0) parenDepth--;
    else if (ch === '[') bracketDepth++;
    else if (ch === ']' && bracketDepth > 0) bracketDepth--;
    else if (ch === '{') braceDepth++;
    else if (ch === '}' && braceDepth > 0) braceDepth--;
  }
  return -1;
}

function findMatchingCloseBrace(str, openBraceIdx) {
  // F11: Track parenDepth & bracketDepth so braces inside `(...)` or `[...]` never desync block matching
  let depth = 1;
  let parenDepth = 0;
  let bracketDepth = 0;
  let quote = null;
  for (let j = openBraceIdx + 1; j < str.length; j++) {
    const ch = str[j];
    if (quote) {
      if (ch === '\\') {
        j++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\') {
      j++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(') {
      parenDepth++;
      continue;
    }
    if (ch === ')' && parenDepth > 0) {
      parenDepth--;
      continue;
    }
    if (ch === '[') {
      bracketDepth++;
      continue;
    }
    if (ch === ']' && bracketDepth > 0) {
      bracketDepth--;
      continue;
    }
    if (parenDepth === 0 && bracketDepth === 0) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return j;
      }
    }
  }
  return str.length;
}

function scopeCssToOwner(cssText, pluginId) {
  const ownerPrefix = `[data-addon-host-owner="${String(pluginId).replace(/"/g, '\\"')}"]`;
  // F8: Replace comments with a token-separating space (' ') so emitted CSS can NEVER synthesize `/*`
  const clean = stripCssComments(preprocessCssInput(cssText), ' ');
  let out = '';
  let i = 0;
  const len = clean.length;

  function prefixSelectorList(selList) {
    return splitTopLevelSelectorList(selList)
      .map((s) => {
        const trimmed = s.trim();
        if (!trimmed) return '';
        if (trimmed.startsWith(':host')) return trimmed;
        // Only treat exact leading ownerPrefix as already rooted (NEVER `includes(ownerPrefix)` which allows `body:not([owner])`)
        if (
          trimmed === ownerPrefix ||
          trimmed.startsWith(`${ownerPrefix} `) ||
          trimmed.startsWith(`${ownerPrefix}>`) ||
          trimmed.startsWith(`${ownerPrefix}.`) ||
          trimmed.startsWith(`${ownerPrefix}#`) ||
          trimmed.startsWith(`${ownerPrefix}:`) ||
          trimmed.startsWith(`${ownerPrefix}[`)
        ) {
          return trimmed;
        }
        if (/^(?:html|body|:root)(?![a-z0-9_-])/i.test(trimmed)) {
          return trimmed.replace(/^(?:html|body|:root)(?![a-z0-9_-])/i, ownerPrefix);
        }
        return `${ownerPrefix} ${trimmed}`;
      })
      .filter(Boolean)
      .join(', ');
  }

  while (i < len) {
    const braceIdx = findNextTopLevelChar(clean, i, '{');
    if (braceIdx === -1) {
      out += clean.slice(i);
      break;
    }
    // S-2: Split top-level `;`-terminated statements (e.g. `@layer a;`) before `{` so subsequent selectors are scoped
    const semiIdx = findNextTopLevelChar(clean, i, ';');
    if (semiIdx !== -1 && semiIdx < braceIdx) {
      out += clean.slice(i, semiIdx + 1);
      i = semiIdx + 1;
      continue;
    }
    const prelude = clean.slice(i, braceIdx);
    const closeIdx = findMatchingCloseBrace(clean, braceIdx);
    const body = clean.slice(braceIdx + 1, closeIdx);
    const lowerPrelude = prelude.trim().toLowerCase();
    if (lowerPrelude.startsWith('@media') || lowerPrelude.startsWith('@supports') || lowerPrelude.startsWith('@layer')) {
      out += `${prelude}{${scopeCssToOwner(body, pluginId)}}`;
    } else if (lowerPrelude.startsWith('@')) {
      out += `${prelude}{${body}}`;
    } else {
      out += `${prefixSelectorList(prelude)} {${body}}`;
    }
    i = closeIdx + 1;
  }
  return out;
}

function createStyleManager(doc) {
  const recordsByKey = new Map(); // `${pluginId}:${styleId}` -> { pluginId, styleId, scope, slotId, finalCss, headEl, shadowEls: Map<ShadowRoot, Element> }
  const shadowRootsByOwner = new Map(); // pluginId -> Map<slotId, Set<ShadowRoot>> (R-6d Ruling 1)

  function upsertStyleElement(parentNode, existingEl, pluginId, styleId, scope, finalCss) {
    if (!parentNode || typeof parentNode.appendChild !== 'function') return null;
    let el = existingEl;
    if (!el || !el.parentNode) {
      el = doc.createElement('style');
      el.setAttribute('data-addon-host-owner', pluginId);
      el.setAttribute('data-addon-host-style', `${pluginId}:${styleId}`);
      el.setAttribute('data-addon-host-style-scope', scope);
      parentNode.appendChild(el);
    }
    el.textContent = finalCss;
    return el;
  }

  function removeHeadStyle(rec) {
    if (rec && rec.headEl && rec.headEl.parentNode && typeof rec.headEl.parentNode.removeChild === 'function') {
      try {
        rec.headEl.parentNode.removeChild(rec.headEl);
      } catch (_e) {}
    }
    if (rec) rec.headEl = null;
  }

  function registerShadowRoot(pluginId, slotId, shadowRoot) {
    if (!shadowRoot) return;
    let map = shadowRootsByOwner.get(pluginId);
    if (!map) {
      map = new Map();
      shadowRootsByOwner.set(pluginId, map);
    }
    let srSet = map.get(slotId);
    if (!srSet) {
      srSet = new Set();
      map.set(slotId, srSet);
    }
    srSet.add(shadowRoot);
    // Sync all existing owner-scoped styles (and matching slotId styles) into this newly mounted ShadowRoot
    for (const rec of recordsByKey.values()) {
      if (rec.pluginId !== pluginId) continue;
      if (rec.slotId && rec.slotId !== slotId) continue;
      const el = upsertStyleElement(shadowRoot, rec.shadowEls.get(shadowRoot), pluginId, rec.styleId, rec.scope, rec.finalCss);
      if (el) rec.shadowEls.set(shadowRoot, el);
      // D-11: If this style was specifically targeted to this slotId and previously fell back to document.head, clean up headEl
      if (rec.slotId === slotId && rec.headEl) {
        removeHeadStyle(rec);
      }
    }
  }

  function unregisterShadowRoot(pluginId, slotId, shadowRoot = null) {
    const map = shadowRootsByOwner.get(pluginId);
    if (!map) return;
    const srSet = map.get(slotId);
    if (!srSet) return;
    const targets = shadowRoot ? (srSet.has(shadowRoot) ? [shadowRoot] : []) : Array.from(srSet);
    for (const sr of targets) {
      srSet.delete(sr);
      for (const rec of recordsByKey.values()) {
        if (rec.pluginId !== pluginId) continue;
        const el = rec.shadowEls.get(sr);
        if (el && el.parentNode && typeof el.parentNode.removeChild === 'function') {
          try {
            el.parentNode.removeChild(el);
          } catch (_e) {}
        }
        rec.shadowEls.delete(sr);
      }
    }
    if (srSet.size === 0) {
      map.delete(slotId);
    }
    if (map.size === 0) {
      shadowRootsByOwner.delete(pluginId);
    }
  }

  function injectStyle(pluginMeta, styleId, cssText, opts = {}) {
    const pluginId = pluginMeta.pluginId;
    if (!styleId || typeof styleId !== 'string') {
      throw new Error('ERR_INVALID_STYLE_ID');
    }
    const defaultScope =
      pluginMeta.trustLevel === 'trusted' && pluginMeta.hasDocumentTransformSlot ? 'global' : 'owner';
    const scope = opts && opts.scope ? String(opts.scope) : defaultScope;
    if (scope !== 'owner' && scope !== 'global') {
      throw new Error(`ERR_INVALID_STYLE_SCOPE:${scope}`);
    }
    if (scope === 'global' && pluginMeta.trustLevel !== 'trusted') {
      throw new Error('ERR_RESTRICTED_GLOBAL_CSS_FORBIDDEN');
    }

    const safeCheck = validateSafeCssText(cssText, { scope });
    if (!safeCheck.ok) {
      throw new Error(safeCheck.reason);
    }

    const slotId = opts && typeof opts.slotId === 'string' && opts.slotId ? opts.slotId : null;
    const finalCss = scope === 'global' ? cssText : scopeCssToOwner(cssText, pluginId);
    const key = `${pluginId}:${styleId}`;
    let rec = recordsByKey.get(key);
    if (!rec) {
      rec = { pluginId, styleId, scope, slotId, finalCss, headEl: null, shadowEls: new Map() };
      recordsByKey.set(key, rec);
    } else {
      rec.scope = scope;
      rec.slotId = slotId;
      rec.finalCss = finalCss;
    }

    const ownerShadows = shadowRootsByOwner.get(pluginId);
    const specificSet = slotId && ownerShadows ? ownerShadows.get(slotId) : null;
    const hasSpecificShadow = Boolean(specificSet && specificSet.size > 0);

    if (hasSpecificShadow) {
      // Targeted shadow slot(s): inject directly into every open ShadowRoot for this slotId (zero document.head pollution!)
      removeHeadStyle(rec);
      let firstEl = null;
      for (const sr of specificSet) {
        const el = upsertStyleElement(sr, rec.shadowEls.get(sr), pluginId, styleId, scope, finalCss);
        if (el) {
          rec.shadowEls.set(sr, el);
          if (!firstEl) firstEl = el;
        }
      }
      return firstEl;
    }

    // Inject into document.head (for light DOM / global / v1 slots) AND sync to any open owner ShadowRoots
    const head = doc.head || doc.documentElement || doc.body;
    rec.headEl = upsertStyleElement(head, rec.headEl, pluginId, styleId, scope, finalCss);
    if (ownerShadows && scope === 'owner') {
      for (const [sId, srSet] of ownerShadows.entries()) {
        if (slotId && slotId !== sId) continue;
        for (const sr of srSet) {
          const el = upsertStyleElement(sr, rec.shadowEls.get(sr), pluginId, styleId, scope, finalCss);
          if (el) rec.shadowEls.set(sr, el);
        }
      }
    }

    return rec.headEl;
  }

  function removeStyle(pluginId, styleId) {
    const key = `${pluginId}:${styleId}`;
    const rec = recordsByKey.get(key);
    if (!rec) return false;
    if (rec.headEl && rec.headEl.parentNode && typeof rec.headEl.parentNode.removeChild === 'function') {
      try {
        rec.headEl.parentNode.removeChild(rec.headEl);
      } catch (_e) {}
    }
    for (const el of rec.shadowEls.values()) {
      if (el && el.parentNode && typeof el.parentNode.removeChild === 'function') {
        try {
          el.parentNode.removeChild(el);
        } catch (_e) {}
      }
    }
    recordsByKey.delete(key);
    return true;
  }

  function disposePluginStyles(pluginId) {
    for (const [key, rec] of Array.from(recordsByKey.entries())) {
      if (rec.pluginId === pluginId) {
        removeStyle(pluginId, rec.styleId);
      }
    }
    shadowRootsByOwner.delete(pluginId);
  }

  return Object.freeze({
    registerShadowRoot,
    unregisterShadowRoot,
    injectStyle,
    removeStyle,
    disposePluginStyles,
  });
}

module.exports = {
  validateSafeCssText,
  scopeCssToOwner,
  createStyleManager,
};

  },
  "./slot-manager.js": function(module, exports, require) {
'use strict';

/**
 * UI Slot Manager — Option B2 Shadow DOM Contract (T-B, F3).
 *
 * - `mountSlot(pluginMeta, slotId, opts)`:
 *   - Enforces manifest slot ownership (`slotId` must be declared in `pluginMeta.uiSlots`).
 *   - Resolves `shadow` from normalized v2 manifest (`v1` defaults `false`, `v2` defaults `true`,
 *     `document-transform` ALWAYS `false`).
 *   - Option B2 (`shadow: true`): creates open `ShadowRoot` on host wrapper element and returns
 *     inner `<div class="addon-host-slot-root" data-addon-host-owner="...">` (`HTMLElement`),
 *     preserving `.style`/`.classList`/`.setAttribute()` while exposing `ShadowRoot` via `el.getRootNode()`.
 *   - Anchor miss: returns `null` (NEVER auto-opens ModalPortal!).
 */

function createSlotManager(doc, { uiAnchors = {}, extraNoTranslateAttributes = [], styleManager = null } = {}) {
  const mountedByKey = new Map(); // `${pluginId}:${slotId}` -> { hostEl, rootEl, shadowRoot, slotDef }

  function findSlotDef(pluginMeta, slotId) {
    const slots = Array.isArray(pluginMeta && pluginMeta.uiSlots) ? pluginMeta.uiSlots : [];
    return slots.find((s) => s && s.slotId === slotId) || null;
  }

  function resolveAnchorContainer(slotDef, opts = {}) {
    if (opts && opts.container) return opts.container;
    const anchorKey = (opts && opts.anchor) || (slotDef && slotDef.anchor) || (slotDef && slotDef.slot);
    if (anchorKey && uiAnchors && Array.isArray(uiAnchors[anchorKey])) {
      const selectors = uiAnchors[anchorKey];
      for (let i = 0; i < selectors.length; i++) {
        try {
          const found = typeof doc.querySelector === 'function' ? doc.querySelector(selectors[i]) : null;
          if (found) return found;
        } catch (_e) {}
      }
      // Anchor was explicitly defined in HostProfile but not present in current DOM -> return null!
      return null;
    }
    return opts && opts.fallbackToBody ? doc.body : null;
  }

  function applyNoTranslateAttrs(el, pluginMeta) {
    const noTranslate = !pluginMeta.isolation || pluginMeta.isolation.noTranslate !== false;
    if (!noTranslate) return;
    el.setAttribute('translate', 'no');
    el.setAttribute('data-addon-host-no-translate', 'true');
    for (let i = 0; i < extraNoTranslateAttributes.length; i++) {
      el.setAttribute(extraNoTranslateAttributes[i], 'true');
    }
  }

  function mountSlot(pluginMeta, slotId, opts = {}) {
    const slotDef = findSlotDef(pluginMeta, slotId);
    if (!slotDef) {
      throw new Error(`ERR_UNDECLARED_SLOT:${pluginMeta.pluginId}:${slotId}`);
    }

    const key = `${pluginMeta.pluginId}:${slotId}`;
    const existing = mountedByKey.get(key);
    if (existing && existing.hostEl) {
      // R-3: Check isConnected (fallback to parentNode for lightweight mocks) so React anchor unmount triggers clean remount
      const stillConnected =
        existing.hostEl.isConnected !== undefined
          ? Boolean(existing.hostEl.isConnected)
          : Boolean(existing.hostEl.parentNode);
      if (stillConnected) {
        return existing.rootEl;
      }
      if (existing.shadowRoot && styleManager) {
        styleManager.unregisterShadowRoot(pluginMeta.pluginId, slotId, existing.shadowRoot);
      }
      mountedByKey.delete(key);
    }

    const container = resolveAnchorContainer(slotDef, opts);
    if (!container || typeof container.appendChild !== 'function') {
      return null;
    }

    const ALLOWED_SLOT_TAGS = new Set(['div', 'span', 'section', 'aside', 'nav', 'header', 'footer']);
    const useShadow =
      slotDef.slot === 'document-transform'
        ? false
        : typeof opts.shadow === 'boolean' && (opts.shadow === true || pluginMeta.trustLevel === 'trusted' || !slotDef.shadow)
          ? opts.shadow
          : Boolean(slotDef.shadow);

    const requestedTag = typeof opts.tagName === 'string' ? opts.tagName.toLowerCase() : 'div';
    const safeTag = ALLOWED_SLOT_TAGS.has(requestedTag) ? requestedTag : 'div';
    const hostEl = doc.createElement(safeTag);
    hostEl.setAttribute('data-addon-host-owner', pluginMeta.pluginId);
    hostEl.setAttribute('data-addon-host-slot', slotId);
    hostEl.setAttribute('data-addon-host-slot-kind', slotDef.slot);
    applyNoTranslateAttrs(hostEl, pluginMeta);
    container.appendChild(hostEl);

    let rootEl = hostEl;
    let shadowRoot = null;

    if (useShadow && typeof hostEl.attachShadow === 'function') {
      shadowRoot = hostEl.attachShadow({ mode: 'open' });
      const inner = doc.createElement('div');
      inner.className = 'addon-host-slot-root';
      inner.setAttribute('data-addon-host-owner', pluginMeta.pluginId);
      inner.setAttribute('data-addon-host-slot', slotId);
      if (typeof shadowRoot.appendChild === 'function') {
        shadowRoot.appendChild(inner);
      }
      rootEl = inner;
      if (styleManager) {
        styleManager.registerShadowRoot(pluginMeta.pluginId, slotId, shadowRoot);
      }
    }

    mountedByKey.set(key, { hostEl, rootEl, shadowRoot, slotDef });
    return rootEl;
  }

  function unmountSlot(pluginId, slotId) {
    const key = `${pluginId}:${slotId}`;
    const rec = mountedByKey.get(key);
    if (!rec) {
      for (const existingKey of mountedByKey.keys()) {
        if (existingKey.endsWith(`:${slotId}`) && !existingKey.startsWith(`${pluginId}:`)) {
          throw new Error(`ERR_FORBIDDEN_CROSS_PLUGIN_UNMOUNT:${pluginId}:${slotId}`);
        }
      }
      return false;
    }
    if (rec.shadowRoot && styleManager) {
      styleManager.unregisterShadowRoot(pluginId, slotId, rec.shadowRoot);
    }
    if (rec.hostEl && rec.hostEl.parentNode && typeof rec.hostEl.parentNode.removeChild === 'function') {
      try {
        rec.hostEl.parentNode.removeChild(rec.hostEl);
      } catch (_e) {}
    }
    mountedByKey.delete(key);
    return true;
  }

  function disposePluginSlots(pluginId) {
    for (const [key, rec] of Array.from(mountedByKey.entries())) {
      if (key.startsWith(`${pluginId}:`)) {
        unmountSlot(pluginId, rec.slotDef.slotId);
      }
    }
  }

  return Object.freeze({
    mountSlot,
    unmountSlot,
    disposePluginSlots,
  });
}

module.exports = {
  createSlotManager,
};

  },
  "./surface-geometry.js": function(module, exports, require) {
'use strict';

/**
 * Vendor-neutral Per-Surface Content Bounds & Center-Point Geometry Engine (v2.4.0 — SOLID #0).
 *
 * - ZERO vendor/app-specific literals: every surface selector, priority, chrome-exclusion
 *   selector, and safe inset comes declaratively from `HostProfile.uiSurfaces` / `uiAnchors`.
 * - Ignores addon-host modal/popover portals (`[data-addon-host-modal-dialog]`,
 *   `[data-addon-host-popover]`) so open plugin overlays never distort host surface measurements.
 * - Resolution order per surface:
 *   1. Direct visible container matching `selectors` (`source: 'selector'`).
 *   2. Viewport minus visible edge chrome matching `exclude{Left,Right,Top,Bottom}Selectors`
 *      (`source: 'chrome-subtracted'`).
 *   3. Optional caller-provided `anchorEl` nearest inset content-pane ancestor
 *      (`source: 'anchor-container'`).
 *   4. Safe viewport fallback (`source: 'viewport'`).
 * - Always returns finite, viewport-clamped, deep-frozen coordinates including `centerX`,
 *   `centerY`, bounding box (`left/top/right/bottom/width/height`), and CSS fixed insets
 *   (`insetLeft/insetTop/insetRight/insetBottom`).
 */

const _ObjectFreeze = Object.freeze;
const _ObjectKeys = Object.keys;
const _ArrayIsArray = Array.isArray;
const _Number = Number;
const _NumberIsFinite = Number.isFinite;
const _MathMax = Math.max;
const _MathMin = Math.min;
const _MathRound = Math.round;

const EDGE_TOUCH_TOLERANCE_PX = 12;

function toNonNegativeNumber(value, fallback = 0) {
  const n = _Number(value);
  return _NumberIsFinite(n) && n >= 0 ? n : fallback;
}

function roundCoord(value) {
  return _MathRound(value * 100) / 100;
}

function normalizeStringList(list) {
  if (!_ArrayIsArray(list)) return [];
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const s = list[i];
    if (typeof s === 'string' && s.trim()) {
      out.push(s.trim());
    }
  }
  return out;
}

function normalizeSafeInsets(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return _ObjectFreeze({
    top: toNonNegativeNumber(src.top, 0),
    right: toNonNegativeNumber(src.right, 0),
    bottom: toNonNegativeNumber(src.bottom, 0),
    left: toNonNegativeNumber(src.left, 0),
  });
}

function createSurfaceGeometry(doc, win, { uiSurfaces = {}, uiAnchors = {} } = {}) {
  const surfaceSpecs = new Map();
  const orderedIds = [];

  if (uiSurfaces && typeof uiSurfaces === 'object') {
    const keys = _ObjectKeys(uiSurfaces);
    for (let i = 0; i < keys.length; i += 1) {
      const id = keys[i];
      if (!id || id === 'viewport' || id === 'auto' || id === 'active') continue;
      const raw = uiSurfaces[id];
      if (!raw || typeof raw !== 'object' || _ArrayIsArray(raw)) continue;
      const anchorFallback = uiAnchors && _ArrayIsArray(uiAnchors[id]) ? uiAnchors[id] : [];
      const selectors = normalizeStringList(raw.selectors);
      const mergedSelectors = selectors.length > 0 ? selectors : normalizeStringList(anchorFallback);
      const spec = _ObjectFreeze({
        id,
        priority: _NumberIsFinite(_Number(raw.priority)) ? _Number(raw.priority) : 0,
        selectors: _ObjectFreeze(mergedSelectors),
        excludeLeftSelectors: _ObjectFreeze(normalizeStringList(raw.excludeLeftSelectors)),
        excludeRightSelectors: _ObjectFreeze(normalizeStringList(raw.excludeRightSelectors)),
        excludeTopSelectors: _ObjectFreeze(normalizeStringList(raw.excludeTopSelectors)),
        excludeBottomSelectors: _ObjectFreeze(normalizeStringList(raw.excludeBottomSelectors)),
        safeInsets: normalizeSafeInsets(raw.safeInsets),
      });
      surfaceSpecs.set(id, spec);
      orderedIds.push(id);
    }
  }

  // Sort surfaces by priority descending (stable tie-break by id)
  orderedIds.sort((a, b) => {
    const pa = surfaceSpecs.get(a).priority;
    const pb = surfaceSpecs.get(b).priority;
    if (pb !== pa) return pb - pa;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  // Compute default viewport safeInsets from the highest-priority declared surface if any
  let defaultSafeTop = 0;
  let defaultSafeRight = 0;
  let defaultSafeBottom = 0;
  let defaultSafeLeft = 0;
  for (let i = 0; i < orderedIds.length; i += 1) {
    const s = surfaceSpecs.get(orderedIds[i]).safeInsets;
    if (s.top > defaultSafeTop) defaultSafeTop = s.top;
    if (s.right > defaultSafeRight) defaultSafeRight = s.right;
    if (s.bottom > defaultSafeBottom) defaultSafeBottom = s.bottom;
    if (s.left > defaultSafeLeft) defaultSafeLeft = s.left;
  }
  const defaultSafeInsets = _ObjectFreeze({
    top: defaultSafeTop,
    right: defaultSafeRight,
    bottom: defaultSafeBottom,
    left: defaultSafeLeft,
  });

  function getViewportSize() {
    const docEl = doc && doc.documentElement ? doc.documentElement : null;
    const w =
      win && _NumberIsFinite(_Number(win.innerWidth)) && _Number(win.innerWidth) > 0
        ? _Number(win.innerWidth)
        : docEl && _NumberIsFinite(_Number(docEl.clientWidth)) && _Number(docEl.clientWidth) > 0
          ? _Number(docEl.clientWidth)
          : 0;
    const h =
      win && _NumberIsFinite(_Number(win.innerHeight)) && _Number(win.innerHeight) > 0
        ? _Number(win.innerHeight)
        : docEl && _NumberIsFinite(_Number(docEl.clientHeight)) && _Number(docEl.clientHeight) > 0
          ? _Number(docEl.clientHeight)
          : 0;
    return { width: w, height: h };
  }

  function isInsideAddonPortal(el) {
    if (!el) return false;
    if (typeof el.closest === 'function') {
      try {
        if (el.closest('[data-addon-host-modal-dialog]') || el.closest('[data-addon-host-popover]')) {
          return true;
        }
      } catch (_e) {}
    }
    let cur = el;
    let guard = 0;
    while (cur && guard < 64) {
      guard += 1;
      if (typeof cur.getAttribute === 'function') {
        try {
          if (cur.getAttribute('data-addon-host-modal-dialog') || cur.getAttribute('data-addon-host-popover')) {
            return true;
          }
        } catch (_e) {}
      }
      cur = cur.parentNode;
    }
    return false;
  }

  function readVisibleRect(el) {
    if (!el || isInsideAddonPortal(el)) return null;
    if (el.isConnected === false) return null;
    if (win && typeof win.getComputedStyle === 'function') {
      try {
        const cs = win.getComputedStyle(el);
        if (cs) {
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') {
            return null;
          }
        }
      } catch (_e) {}
    }
    if (typeof el.getBoundingClientRect !== 'function') return null;
    let rect;
    try {
      rect = el.getBoundingClientRect();
    } catch (_e) {
      return null;
    }
    if (!rect || typeof rect !== 'object') return null;
    const left = _Number(rect.left);
    const top = _Number(rect.top);
    const width = _Number(rect.width);
    const height = _Number(rect.height);
    if (!_NumberIsFinite(left) || !_NumberIsFinite(top) || !_NumberIsFinite(width) || !_NumberIsFinite(height)) {
      return null;
    }
    if (width <= 0 || height <= 0) return null;
    const right = _NumberIsFinite(_Number(rect.right)) ? _Number(rect.right) : left + width;
    const bottom = _NumberIsFinite(_Number(rect.bottom)) ? _Number(rect.bottom) : top + height;
    return { left, top, right, bottom, width, height };
  }

  function queryMatchingElements(selector) {
    if (!doc || !selector) return [];
    if (typeof doc.querySelectorAll === 'function') {
      try {
        const list = doc.querySelectorAll(selector);
        if (list && typeof list.length === 'number') {
          const out = [];
          for (let i = 0; i < list.length; i += 1) {
            if (list[i]) out.push(list[i]);
          }
          return out;
        }
      } catch (_e) {
        return [];
      }
    }
    if (typeof doc.querySelector === 'function') {
      try {
        const one = doc.querySelector(selector);
        return one ? [one] : [];
      } catch (_e) {
        return [];
      }
    }
    return [];
  }

  function findFirstVisibleSelectorRect(selectors) {
    for (let i = 0; i < selectors.length; i += 1) {
      const els = queryMatchingElements(selectors[i]);
      for (let j = 0; j < els.length; j += 1) {
        const rect = readVisibleRect(els[j]);
        if (rect) return rect;
      }
    }
    return null;
  }

  function computeSafeViewportRect(safeInsets, vw, vh) {
    const left = _MathMin(vw, toNonNegativeNumber(safeInsets.left, 0));
    const top = _MathMin(vh, toNonNegativeNumber(safeInsets.top, 0));
    const right = _MathMax(left, vw - toNonNegativeNumber(safeInsets.right, 0));
    const bottom = _MathMax(top, vh - toNonNegativeNumber(safeInsets.bottom, 0));
    return { left, top, right, bottom };
  }

  function buildBoundsDto({ surfaceId, requestedSurfaceId, matched, source, left, top, right, bottom, vw, vh }) {
    const clampedLeft = vw > 0 ? _MathMax(0, _MathMin(vw, left)) : _MathMax(0, left);
    const clampedTop = vh > 0 ? _MathMax(0, _MathMin(vh, top)) : _MathMax(0, top);
    const clampedRight = vw > 0 ? _MathMax(clampedLeft, _MathMin(vw, right)) : _MathMax(clampedLeft, right);
    const clampedBottom = vh > 0 ? _MathMax(clampedTop, _MathMin(vh, bottom)) : _MathMax(clampedTop, bottom);
    const width = clampedRight - clampedLeft;
    const height = clampedBottom - clampedTop;
    const insetRight = vw > 0 ? _MathMax(0, vw - clampedRight) : 0;
    const insetBottom = vh > 0 ? _MathMax(0, vh - clampedBottom) : 0;

    return _ObjectFreeze({
      surfaceId,
      requestedSurfaceId,
      matched: Boolean(matched),
      source,
      left: roundCoord(clampedLeft),
      top: roundCoord(clampedTop),
      right: roundCoord(clampedRight),
      bottom: roundCoord(clampedBottom),
      width: roundCoord(width),
      height: roundCoord(height),
      centerX: roundCoord(clampedLeft + width / 2),
      centerY: roundCoord(clampedTop + height / 2),
      insetLeft: roundCoord(clampedLeft),
      insetTop: roundCoord(clampedTop),
      insetRight: roundCoord(insetRight),
      insetBottom: roundCoord(insetBottom),
      viewport: _ObjectFreeze({
        width: roundCoord(vw),
        height: roundCoord(vh),
      }),
    });
  }

  function measureBySelector(spec, safeRect, vw, vh) {
    if (!spec || spec.selectors.length === 0) return null;
    const rect = findFirstVisibleSelectorRect(spec.selectors);
    if (!rect) return null;
    const left = vw > 0 ? _MathMax(safeRect.left, rect.left) : rect.left;
    const top = vh > 0 ? _MathMax(safeRect.top, rect.top) : rect.top;
    const right = vw > 0 ? _MathMin(safeRect.right, rect.right) : rect.right;
    const bottom = vh > 0 ? _MathMin(safeRect.bottom, rect.bottom) : rect.bottom;
    if (right <= left || bottom <= top) return null;
    return { left, top, right, bottom };
  }

  function measureByChromeSubtraction(spec, safeRect, vw, vh) {
    if (!spec || vw <= 0 || vh <= 0) return null;
    const hasChrome =
      spec.excludeLeftSelectors.length > 0 ||
      spec.excludeRightSelectors.length > 0 ||
      spec.excludeTopSelectors.length > 0 ||
      spec.excludeBottomSelectors.length > 0;
    if (!hasChrome) return null;

    let left = safeRect.left;
    let top = safeRect.top;
    let right = safeRect.right;
    let bottom = safeRect.bottom;
    let subtracted = false;

    for (let i = 0; i < spec.excludeLeftSelectors.length; i += 1) {
      const els = queryMatchingElements(spec.excludeLeftSelectors[i]);
      for (let j = 0; j < els.length; j += 1) {
        const r = readVisibleRect(els[j]);
        if (!r) continue;
        if (r.left <= safeRect.left + EDGE_TOUCH_TOLERANCE_PX && r.height >= vh * 0.4 && r.right < vw * 0.65) {
          if (r.right > left) {
            left = r.right;
            subtracted = true;
          }
        }
      }
    }

    for (let i = 0; i < spec.excludeRightSelectors.length; i += 1) {
      const els = queryMatchingElements(spec.excludeRightSelectors[i]);
      for (let j = 0; j < els.length; j += 1) {
        const r = readVisibleRect(els[j]);
        if (!r) continue;
        if (r.right >= safeRect.right - EDGE_TOUCH_TOLERANCE_PX && r.height >= vh * 0.4 && r.left > vw * 0.35) {
          if (r.left < right) {
            right = r.left;
            subtracted = true;
          }
        }
      }
    }

    for (let i = 0; i < spec.excludeTopSelectors.length; i += 1) {
      const els = queryMatchingElements(spec.excludeTopSelectors[i]);
      for (let j = 0; j < els.length; j += 1) {
        const r = readVisibleRect(els[j]);
        if (!r) continue;
        if (r.top <= safeRect.top + EDGE_TOUCH_TOLERANCE_PX && r.width >= vw * 0.4 && r.bottom < vh * 0.4) {
          if (r.bottom > top) {
            top = r.bottom;
            subtracted = true;
          }
        }
      }
    }

    for (let i = 0; i < spec.excludeBottomSelectors.length; i += 1) {
      const els = queryMatchingElements(spec.excludeBottomSelectors[i]);
      for (let j = 0; j < els.length; j += 1) {
        const r = readVisibleRect(els[j]);
        if (!r) continue;
        if (r.bottom >= safeRect.bottom - EDGE_TOUCH_TOLERANCE_PX && r.width >= vw * 0.4 && r.top > vh * 0.6) {
          if (r.top < bottom) {
            bottom = r.top;
            subtracted = true;
          }
        }
      }
    }

    if (!subtracted) return null;
    const minWidth = _MathMin(200, vw * 0.25);
    const minHeight = _MathMin(120, vh * 0.25);
    if (right - left < minWidth || bottom - top < minHeight) {
      return null;
    }
    return { left, top, right, bottom };
  }

  function measureByAnchorContainer(anchorEl, safeRect, vw, vh) {
    if (!anchorEl || typeof anchorEl !== 'object' || vw <= 0 || vh <= 0) return null;
    if (anchorEl.isConnected === false || isInsideAddonPortal(anchorEl)) return null;
    const minWidth = _MathMin(240, vw * 0.25);
    const minHeight = _MathMin(240, vh * 0.45);
    const bodyEl = doc && doc.body ? doc.body : null;
    const docEl = doc && doc.documentElement ? doc.documentElement : null;

    let best = null;
    let bestArea = 0;
    let cur = anchorEl.parentNode;
    let guard = 0;
    while (cur && guard < 32) {
      guard += 1;
      if (cur === bodyEl || cur === docEl) break;
      const r = readVisibleRect(cur);
      if (r) {
        const left = _MathMax(safeRect.left, r.left);
        const top = _MathMax(safeRect.top, r.top);
        const right = _MathMin(safeRect.right, r.right);
        const bottom = _MathMin(safeRect.bottom, r.bottom);
        const w = right - left;
        const h = bottom - top;
        const isHorizontallyInset = left >= safeRect.left + 16 || right <= safeRect.right - 16;
        if (w >= minWidth && h >= minHeight && w < vw - 16 && isHorizontallyInset) {
          const area = w * h;
          if (area >= bestArea) {
            bestArea = area;
            best = { left, top, right, bottom };
          }
        }
      }
      cur = cur.parentNode;
    }
    return best;
  }

  function getActiveSurface(anchorEl = null) {
    const { width: vw, height: vh } = getViewportSize();

    // Pass 1: highest-priority direct selector match wins
    for (let i = 0; i < orderedIds.length; i += 1) {
      const id = orderedIds[i];
      const spec = surfaceSpecs.get(id);
      const safeRect = computeSafeViewportRect(spec.safeInsets, vw, vh);
      const matchedRect = measureBySelector(spec, safeRect, vw, vh);
      if (matchedRect) {
        return buildBoundsDto({
          surfaceId: id,
          requestedSurfaceId: 'auto',
          matched: true,
          source: 'selector',
          left: matchedRect.left,
          top: matchedRect.top,
          right: matchedRect.right,
          bottom: matchedRect.bottom,
          vw,
          vh,
        });
      }
    }

    // Pass 2: highest-priority chrome-subtracted match wins
    for (let i = 0; i < orderedIds.length; i += 1) {
      const id = orderedIds[i];
      const spec = surfaceSpecs.get(id);
      const safeRect = computeSafeViewportRect(spec.safeInsets, vw, vh);
      const chromeRect = measureByChromeSubtraction(spec, safeRect, vw, vh);
      if (chromeRect) {
        return buildBoundsDto({
          surfaceId: id,
          requestedSurfaceId: 'auto',
          matched: true,
          source: 'chrome-subtracted',
          left: chromeRect.left,
          top: chromeRect.top,
          right: chromeRect.right,
          bottom: chromeRect.bottom,
          vw,
          vh,
        });
      }
    }

    // Pass 3: caller-supplied anchor element ancestor pane fallback
    if (anchorEl) {
      const fallbackSafeRect = computeSafeViewportRect(defaultSafeInsets, vw, vh);
      const anchorRect = measureByAnchorContainer(anchorEl, fallbackSafeRect, vw, vh);
      if (anchorRect) {
        return buildBoundsDto({
          surfaceId: 'viewport',
          requestedSurfaceId: 'auto',
          matched: true,
          source: 'anchor-container',
          left: anchorRect.left,
          top: anchorRect.top,
          right: anchorRect.right,
          bottom: anchorRect.bottom,
          vw,
          vh,
        });
      }
    }

    const fallbackRect = computeSafeViewportRect(defaultSafeInsets, vw, vh);
    return buildBoundsDto({
      surfaceId: 'viewport',
      requestedSurfaceId: 'auto',
      matched: false,
      source: 'viewport',
      left: fallbackRect.left,
      top: fallbackRect.top,
      right: fallbackRect.right,
      bottom: fallbackRect.bottom,
      vw,
      vh,
    });
  }

  function getSurfaceBounds(surfaceIdOrOpts) {
    let requested = 'auto';
    let anchorEl = null;
    if (typeof surfaceIdOrOpts === 'string' && surfaceIdOrOpts.trim()) {
      requested = surfaceIdOrOpts.trim();
    } else if (surfaceIdOrOpts && typeof surfaceIdOrOpts === 'object') {
      if (typeof surfaceIdOrOpts.surface === 'string' && surfaceIdOrOpts.surface.trim()) {
        requested = surfaceIdOrOpts.surface.trim();
      }
      if (surfaceIdOrOpts.anchorEl && typeof surfaceIdOrOpts.anchorEl === 'object') {
        anchorEl = surfaceIdOrOpts.anchorEl;
      }
    }

    if (requested === 'auto' || requested === 'active') {
      return getActiveSurface(anchorEl);
    }

    const { width: vw, height: vh } = getViewportSize();

    if (requested === 'viewport') {
      const safeRect = computeSafeViewportRect(defaultSafeInsets, vw, vh);
      return buildBoundsDto({
        surfaceId: 'viewport',
        requestedSurfaceId: 'viewport',
        matched: true,
        source: 'viewport',
        left: safeRect.left,
        top: safeRect.top,
        right: safeRect.right,
        bottom: safeRect.bottom,
        vw,
        vh,
      });
    }

    const spec = surfaceSpecs.get(requested);
    if (spec) {
      const safeRect = computeSafeViewportRect(spec.safeInsets, vw, vh);
      const matchedRect = measureBySelector(spec, safeRect, vw, vh);
      if (matchedRect) {
        return buildBoundsDto({
          surfaceId: requested,
          requestedSurfaceId: requested,
          matched: true,
          source: 'selector',
          left: matchedRect.left,
          top: matchedRect.top,
          right: matchedRect.right,
          bottom: matchedRect.bottom,
          vw,
          vh,
        });
      }
      const chromeRect = measureByChromeSubtraction(spec, safeRect, vw, vh);
      if (chromeRect) {
        return buildBoundsDto({
          surfaceId: requested,
          requestedSurfaceId: requested,
          matched: true,
          source: 'chrome-subtracted',
          left: chromeRect.left,
          top: chromeRect.top,
          right: chromeRect.right,
          bottom: chromeRect.bottom,
          vw,
          vh,
        });
      }
      const anchorRect = measureByAnchorContainer(anchorEl, safeRect, vw, vh);
      if (anchorRect) {
        return buildBoundsDto({
          surfaceId: requested,
          requestedSurfaceId: requested,
          matched: true,
          source: 'anchor-container',
          left: anchorRect.left,
          top: anchorRect.top,
          right: anchorRect.right,
          bottom: anchorRect.bottom,
          vw,
          vh,
        });
      }
      return buildBoundsDto({
        surfaceId: requested,
        requestedSurfaceId: requested,
        matched: false,
        source: 'viewport',
        left: safeRect.left,
        top: safeRect.top,
        right: safeRect.right,
        bottom: safeRect.bottom,
        vw,
        vh,
      });
    }

    // Fallback to uiAnchors[requested] if declared only in uiAnchors
    if (uiAnchors && _ArrayIsArray(uiAnchors[requested])) {
      const anchorSelectors = normalizeStringList(uiAnchors[requested]);
      const safeRect = computeSafeViewportRect(defaultSafeInsets, vw, vh);
      const rect = findFirstVisibleSelectorRect(anchorSelectors);
      if (rect) {
        const left = vw > 0 ? _MathMax(safeRect.left, rect.left) : rect.left;
        const top = vh > 0 ? _MathMax(safeRect.top, rect.top) : rect.top;
        const right = vw > 0 ? _MathMin(safeRect.right, rect.right) : rect.right;
        const bottom = vh > 0 ? _MathMin(safeRect.bottom, rect.bottom) : rect.bottom;
        if (right > left && bottom > top) {
          return buildBoundsDto({
            surfaceId: requested,
            requestedSurfaceId: requested,
            matched: true,
            source: 'selector',
            left,
            top,
            right,
            bottom,
            vw,
            vh,
          });
        }
      }
    }

    const fallbackRect = computeSafeViewportRect(defaultSafeInsets, vw, vh);
    return buildBoundsDto({
      surfaceId: 'viewport',
      requestedSurfaceId: requested,
      matched: false,
      source: 'viewport',
      left: fallbackRect.left,
      top: fallbackRect.top,
      right: fallbackRect.right,
      bottom: fallbackRect.bottom,
      vw,
      vh,
    });
  }

  function listSurfaces() {
    return _ObjectFreeze([...orderedIds, 'viewport']);
  }

  return _ObjectFreeze({
    getSurfaceBounds,
    getActiveSurface,
    listSurfaces,
  });
}

module.exports = {
  createSurfaceGeometry,
};

  },
  "./placement-engine.js": function(module, exports, require) {
'use strict';

/**
 * Vendor-neutral Overlay Placement Engine for Tier-2 UI (v3.0.0 — SOLID #0).
 *
 * Computes deterministic, viewport-safe coordinates from a plugin's declarative
 * `PlacementSpec`:
 * - `zone`: `'anchor' | 'surface-center' | 'corner' | 'sheet' | 'drawer'`
 * - Flip on primary axis when overflowing viewport (`bottom` <-> `top`, `right` <-> `left`)
 * - Shift clamping on cross axis within safe viewport insets
 * - Automatic mobile bottom-sheet switch when `viewport.width <= mobileBreakpointPx` (default 640)
 * - Live `resize` + `scroll` repositioning with deterministic disposer cleanup.
 */

const DEFAULT_OFFSET_PX = 8;
const DEFAULT_VIEWPORT_MARGIN_PX = 8;
const DEFAULT_MOBILE_BREAKPOINT_PX = 640;

function toFiniteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(val, min, max) {
  if (max < min) return min;
  return Math.max(min, Math.min(max, val));
}

function parsePrefer(rawPrefer) {
  const raw = typeof rawPrefer === 'string' ? rawPrefer.trim().toLowerCase() : 'bottom-start';
  const [sideRaw, alignRaw] = raw.split('-');
  const side = ['top', 'bottom', 'left', 'right'].includes(sideRaw) ? sideRaw : 'bottom';
  const align = ['start', 'center', 'end'].includes(alignRaw) ? alignRaw : 'start';
  return { side, align };
}

function computeAnchoredPosition({ anchorRect, boxWidth, boxHeight, bounds, prefer, offset, margin }) {
  const { side, align } = parsePrefer(prefer);
  const minLeft = bounds.left + margin;
  const maxLeft = Math.max(minLeft, bounds.right - margin - boxWidth);
  const minTop = bounds.top + margin;
  const maxTop = Math.max(minTop, bounds.bottom - margin - boxHeight);

  let resolvedSide = side;
  let flipped = false;

  const spaceTop = anchorRect.top - (bounds.top + margin);
  const spaceBottom = bounds.bottom - margin - anchorRect.bottom;
  const spaceLeft = anchorRect.left - (bounds.left + margin);
  const spaceRight = bounds.right - margin - anchorRect.right;

  if (side === 'bottom' && spaceBottom < boxHeight + offset && spaceTop > spaceBottom) {
    resolvedSide = 'top';
    flipped = true;
  } else if (side === 'top' && spaceTop < boxHeight + offset && spaceBottom > spaceTop) {
    resolvedSide = 'bottom';
    flipped = true;
  } else if (side === 'right' && spaceRight < boxWidth + offset && spaceLeft > spaceRight) {
    resolvedSide = 'left';
    flipped = true;
  } else if (side === 'left' && spaceLeft < boxWidth + offset && spaceRight > spaceLeft) {
    resolvedSide = 'right';
    flipped = true;
  }

  let rawLeft = minLeft;
  let rawTop = minTop;

  if (resolvedSide === 'bottom' || resolvedSide === 'top') {
    rawTop = resolvedSide === 'bottom' ? anchorRect.bottom + offset : anchorRect.top - offset - boxHeight;
    if (align === 'end') {
      rawLeft = anchorRect.right - boxWidth;
    } else if (align === 'center') {
      rawLeft = anchorRect.left + (anchorRect.width - boxWidth) / 2;
    } else {
      rawLeft = anchorRect.left;
    }
  } else {
    rawLeft = resolvedSide === 'right' ? anchorRect.right + offset : anchorRect.left - offset - boxWidth;
    if (align === 'end') {
      rawTop = anchorRect.bottom - boxHeight;
    } else if (align === 'center') {
      rawTop = anchorRect.top + (anchorRect.height - boxHeight) / 2;
    } else {
      rawTop = anchorRect.top;
    }
  }

  const left = clamp(rawLeft, minLeft, maxLeft);
  const top = clamp(rawTop, minTop, maxTop);
  const shifted = Math.abs(left - rawLeft) > 0.5 || Math.abs(top - rawTop) > 0.5;

  return {
    left: Math.round(left),
    top: Math.round(top),
    resolvedSide,
    flipped,
    shifted,
  };
}

function createPlacementEngine(doc, win, { surfaceGeometry = null, uiAnchors = {} } = {}) {
  function resolveAnchorElement(spec) {
    if (!spec || typeof spec !== 'object') return null;
    if (spec.anchorEl && typeof spec.anchorEl.getBoundingClientRect === 'function') {
      return spec.anchorEl;
    }
    if (typeof spec.anchorKey === 'string' && spec.anchorKey && uiAnchors && Array.isArray(uiAnchors[spec.anchorKey])) {
      const sels = uiAnchors[spec.anchorKey];
      for (let i = 0; i < sels.length; i += 1) {
        try {
          const el = doc && typeof doc.querySelector === 'function' ? doc.querySelector(sels[i]) : null;
          if (el && typeof el.getBoundingClientRect === 'function') return el;
        } catch (_e) {}
      }
    }
    return null;
  }

  function getSurfaceRect(spec, anchorEl) {
    if (surfaceGeometry && typeof surfaceGeometry.getSurfaceBounds === 'function') {
      const surfaceArg = spec && typeof spec.surface === 'string' && spec.surface ? spec.surface : 'auto';
      const b = surfaceGeometry.getSurfaceBounds(anchorEl ? { surface: surfaceArg, anchorEl } : surfaceArg);
      if (b && b.viewport && b.viewport.width > 0 && b.viewport.height > 0) {
        return b;
      }
    }
    const vw = toFiniteNumber(win && win.innerWidth, 1280) || 1280;
    const vh = toFiniteNumber(win && win.innerHeight, 800) || 800;
    return {
      surfaceId: 'viewport',
      left: 0,
      top: 0,
      right: vw,
      bottom: vh,
      width: vw,
      height: vh,
      centerX: vw / 2,
      centerY: vh / 2,
      viewport: { width: vw, height: vh },
    };
  }

  function computePlacement(spec = {}, overlaySize = {}) {
    const requestedZone = typeof spec.zone === 'string' ? spec.zone.trim().toLowerCase() : 'surface-center';
    const margin = Math.max(0, toFiniteNumber(spec.margin, DEFAULT_VIEWPORT_MARGIN_PX));
    const offset = Math.max(0, toFiniteNumber(spec.offset, DEFAULT_OFFSET_PX));
    const mobileBp = Math.max(0, toFiniteNumber(spec.mobileBreakpointPx, DEFAULT_MOBILE_BREAKPOINT_PX));
    const anchorEl = resolveAnchorElement(spec);
    const bounds = getSurfaceRect(spec, anchorEl);
    const vw = bounds.viewport.width;
    const vh = bounds.viewport.height;

    const maxW = Math.max(200, Math.min(toFiniteNumber(spec.maxWidth, vw - margin * 2), vw - margin * 2));
    const maxH = Math.max(120, Math.min(toFiniteNumber(spec.maxHeight, vh - margin * 2), vh - margin * 2));
    const explicitW = Number.isFinite(Number(spec.width)) && Number(spec.width) > 0 ? Number(spec.width) : null;
    const explicitH = Number.isFinite(Number(spec.height)) && Number(spec.height) > 0 ? Number(spec.height) : null;
    const boxWidth = Math.min(maxW, Math.max(160, explicitW || toFiniteNumber(overlaySize.width, 320)));
    const boxHeight = Math.min(maxH, Math.max(80, explicitH || toFiniteNumber(overlaySize.height, 220)));

    // Responsive mobile bottom-sheet auto-switch
    const isMobileViewport = vw > 0 && vw <= mobileBp && spec.disableMobileSheet !== true;
    if (requestedZone === 'sheet' || (isMobileViewport && (requestedZone === 'anchor' || requestedZone === 'corner' || requestedZone === 'drawer'))) {
      return Object.freeze({
        zone: 'sheet',
        requestedZone,
        autoMobileSheet: requestedZone !== 'sheet',
        surfaceId: bounds.surfaceId,
        left: 0,
        right: 0,
        bottom: 0,
        top: null,
        width: vw,
        maxWidth: vw,
        maxHeight: Math.round(vh * 0.85),
        flipped: false,
        shifted: false,
      });
    }

    if (requestedZone === 'drawer') {
      const side = spec.side === 'left' ? 'left' : 'right';
      const drawerWidth = Math.min(Math.max(260, toFiniteNumber(spec.width, 380)), Math.max(260, vw - 24));
      return Object.freeze({
        zone: 'drawer',
        requestedZone,
        autoMobileSheet: false,
        side,
        surfaceId: bounds.surfaceId,
        left: side === 'left' ? Math.round(bounds.left) : Math.round(bounds.right - drawerWidth),
        top: Math.round(bounds.top),
        width: Math.round(drawerWidth),
        height: Math.round(bounds.height),
        maxWidth: Math.round(drawerWidth),
        maxHeight: Math.round(bounds.height),
        flipped: false,
        shifted: false,
      });
    }

    if (requestedZone === 'corner') {
      const corner = typeof spec.corner === 'string' ? spec.corner.toLowerCase() : 'bottom-right';
      const isLeft = corner.includes('left');
      const isTop = corner.includes('top');
      const left = isLeft ? bounds.left + margin : bounds.right - margin - boxWidth;
      const top = isTop ? bounds.top + margin : bounds.bottom - margin - boxHeight;
      return Object.freeze({
        zone: 'corner',
        requestedZone,
        autoMobileSheet: false,
        corner,
        surfaceId: bounds.surfaceId,
        left: Math.round(clamp(left, bounds.left + margin, bounds.right - margin - boxWidth)),
        top: Math.round(clamp(top, bounds.top + margin, bounds.bottom - margin - boxHeight)),
        maxWidth: Math.round(maxW),
        maxHeight: Math.round(maxH),
        flipped: false,
        shifted: false,
      });
    }

    if (requestedZone === 'anchor' && anchorEl) {
      let rect = null;
      try {
        rect = anchorEl.getBoundingClientRect();
      } catch (_e) {}
      if (rect && Number.isFinite(Number(rect.left)) && Number.isFinite(Number(rect.top))) {
        const anchorRect = {
          left: Number(rect.left),
          top: Number(rect.top),
          width: Math.max(0, Number(rect.width) || 0),
          height: Math.max(0, Number(rect.height) || 0),
          right: Number.isFinite(Number(rect.right)) ? Number(rect.right) : Number(rect.left) + (Number(rect.width) || 0),
          bottom: Number.isFinite(Number(rect.bottom)) ? Number(rect.bottom) : Number(rect.top) + (Number(rect.height) || 0),
        };
        const pos = computeAnchoredPosition({
          anchorRect,
          boxWidth,
          boxHeight,
          bounds,
          prefer: spec.prefer,
          offset,
          margin,
        });
        return Object.freeze({
          zone: 'anchor',
          requestedZone,
          autoMobileSheet: false,
          surfaceId: bounds.surfaceId,
          left: pos.left,
          top: pos.top,
          width: explicitW ? Math.round(boxWidth) : undefined,
          resolvedSide: pos.resolvedSide,
          flipped: pos.flipped,
          shifted: pos.shifted,
          maxWidth: Math.round(maxW),
          maxHeight: Math.round(maxH),
        });
      }
    }

    // Default: surface-center
    const centerLeft = clamp(bounds.centerX - boxWidth / 2, bounds.left + margin, bounds.right - margin - boxWidth);
    const centerTop = clamp(bounds.centerY - boxHeight / 2, bounds.top + margin, bounds.bottom - margin - boxHeight);
    return Object.freeze({
      zone: 'surface-center',
      requestedZone,
      autoMobileSheet: false,
      surfaceId: bounds.surfaceId,
      left: Math.round(centerLeft),
      top: Math.round(centerTop),
      maxWidth: Math.round(maxW),
      maxHeight: Math.round(maxH),
      flipped: false,
      shifted: false,
    });
  }

  function applyPlacementStyles(el, placement) {
    if (!el || !el.style || !placement) return placement;
    el.style.position = 'fixed';
    el.style.margin = '0';
    el.setAttribute('data-addon-host-placement-zone', placement.zone);
    if (placement.zone === 'sheet') {
      el.style.left = '0px';
      el.style.right = '0px';
      el.style.bottom = '0px';
      el.style.top = 'auto';
      el.style.width = '100vw';
      el.style.maxWidth = '100vw';
      el.style.maxHeight = `${placement.maxHeight}px`;
    } else {
      el.style.left = `${placement.left}px`;
      el.style.top = `${placement.top}px`;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      if (placement.width) {
        el.style.width = `${placement.width}px`;
      }
      if (placement.zone === 'drawer' && placement.height) {
        el.style.height = `${placement.height}px`;
      }
      el.style.maxWidth = `${placement.maxWidth}px`;
      el.style.maxHeight = `${placement.maxHeight}px`;
    }
    return placement;
  }

  function trackElementPlacement(el, spec = {}, onUpdate = null) {
    let disposed = false;
    const sync = () => {
      if (disposed) return null;
      let measured = {};
      try {
        if (el && typeof el.getBoundingClientRect === 'function') {
          const r = el.getBoundingClientRect();
          if (r && r.width > 0 && r.height > 0) {
            measured = { width: r.width, height: r.height };
          }
        }
      } catch (_e) {}
      const placement = computePlacement(spec, measured);
      applyPlacementStyles(el, placement);
      if (typeof onUpdate === 'function') {
        try {
          onUpdate(placement);
        } catch (_e) {}
      }
      return placement;
    };

    const initial = sync();
    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('resize', sync);
      win.addEventListener('scroll', sync, true);
    }

    return Object.freeze({
      initial,
      reposition: sync,
      dispose() {
        if (disposed) return;
        disposed = true;
        if (win && typeof win.removeEventListener === 'function') {
          try {
            win.removeEventListener('resize', sync);
            win.removeEventListener('scroll', sync, true);
          } catch (_e) {}
        }
      },
    });
  }

  return Object.freeze({
    computePlacement,
    applyPlacementStyles,
    trackElementPlacement,
  });
}

module.exports = {
  DEFAULT_OFFSET_PX,
  DEFAULT_VIEWPORT_MARGIN_PX,
  DEFAULT_MOBILE_BREAKPOINT_PX,
  createPlacementEngine,
};

  },
  "./modal-portal.js": function(module, exports, require) {
'use strict';

/**
 * Host Modal & Popover Portal Stack (FV4 / P1-5 / Option B2 / T-C).
 *
 * - Validates `openModal` slot kind is strictly `'modal'` or `'overlay'` (FV4 fix).
 * - Uses native `<dialog>.showModal()` + `popover="manual"` when available (with safe
 *   degradation for lightweight unit-test DOM mocks).
 * - Capture-phase `Escape` keydown listener + `<dialog>` `cancel` `preventDefault()` LIFO stack
 *   (empirically verified on Electron 45.4.1 `sendInputEvent('Escape')` in P1-5!).
 * - Option B2 `bodyEl`: `<div class="addon-host-slot-root">` inside `ShadowRoot` when `shadow !== false`.
 * - Applies `titleBarOverlay` safe top inset (`env(titlebar-area-height, 36px)`).
 * - Emits `onPortalClaimChange(claimId, active)` ONLY on stack `0 -> 1` and `1 -> 0` transitions.
 */

function isEventInsideElements(ev, elements) {
  if (!ev || !Array.isArray(elements) || elements.length === 0) return false;
  const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [ev.target];
  for (let i = 0; i < path.length; i++) {
    const node = path[i];
    if (!node) continue;
    for (let j = 0; j < elements.length; j++) {
      const target = elements[j];
      if (!target) continue;
      if (node === target) return true;
      if (typeof target.contains === 'function' && target.contains(node)) return true;
    }
  }
  return false;
}

function createModalPortal(
  doc,
  win,
  { extraNoTranslateAttributes = [], styleManager = null, surfaceGeometry = null, onPortalClaimChange = () => {} } = {}
) {
  const stack = []; // LIFO: { id, kind: 'modal'|'popover', pluginId, slotId, el, bodyEl, shadowRoot, prevFocus, ignoreOutsideClickEls, onClose }
  let seq = 0;
  let globalListenersInstalled = false;
  let portalClaimActive = false;

  function notifyPortalState(_prevCount, nextCount) {
    const nextActive = nextCount > 0;
    if (nextActive === portalClaimActive) return;
    portalClaimActive = nextActive;
    try {
      onPortalClaimChange('host-modal-portal-stack', nextActive);
    } catch (_e) {}
  }

  function isNestedInside(parentEl, childEl) {
    if (!parentEl || !childEl || parentEl === childEl) return false;
    if (childEl.parentNode === parentEl) return true;
    if (typeof parentEl.contains === 'function') {
      try {
        return Boolean(parentEl.contains(childEl));
      } catch (_e) {}
    }
    let cur = childEl.parentNode;
    let guard = 0;
    while (cur && guard < 64) {
      guard++;
      if (cur === parentEl) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  function closeEntry(entry) {
    const idx = stack.indexOf(entry);
    if (idx === -1) return false;
    // NB-4: Mark closing before cascading so any popover opened inside a child onClose() will not mount into this dying <dialog>
    entry.closing = true;
    const prevCount = stack.length;

    // F2: Cascade-close nested child entries using a snapshot so re-entrant onClose() mutations cannot skip or throw
    for (const candidate of stack.slice().reverse()) {
      if (candidate && candidate !== entry && stack.includes(candidate) && isNestedInside(entry.el, candidate.el)) {
        closeEntry(candidate);
      }
    }

    const curIdx = stack.indexOf(entry);
    if (curIdx === -1) return true;
    stack.splice(curIdx, 1);

    if (entry.shadowRoot && styleManager) {
      styleManager.unregisterShadowRoot(entry.pluginId, entry.slotId, entry.shadowRoot);
    }
    if (typeof entry.onResizeCleanup === 'function') {
      try {
        entry.onResizeCleanup();
      } catch (_e) {}
      entry.onResizeCleanup = null;
    }
    try {
      if (entry.kind === 'modal' && typeof entry.el.close === 'function' && entry.el.open) {
        entry.el.close();
      } else if (entry.kind === 'popover' && typeof entry.el.hidePopover === 'function') {
        entry.el.hidePopover();
      }
    } catch (_e) {}

    if (entry.el && entry.el.parentNode && typeof entry.el.parentNode.removeChild === 'function') {
      try {
        entry.el.parentNode.removeChild(entry.el);
      } catch (_e) {}
    }
    if (entry.prevFocus && typeof entry.prevFocus.focus === 'function') {
      try {
        entry.prevFocus.focus();
      } catch (_e) {}
    }
    if (typeof entry.onClose === 'function') {
      try {
        entry.onClose();
      } catch (_e) {}
    }
    notifyPortalState(prevCount, stack.length);
    return true;
  }

  function closeTop() {
    if (stack.length === 0) return false;
    return closeEntry(stack[stack.length - 1]);
  }

  function ensureGlobalListeners() {
    if (globalListenersInstalled) return;
    globalListenersInstalled = true;

    if (win && typeof win.addEventListener === 'function') {
      // Capture-phase Escape intercepts BEFORE Chromium CloseWatcher closes underlying <dialog> (P1-5)
      win.addEventListener(
        'keydown',
        (ev) => {
          if (!ev || ev.key !== 'Escape' || stack.length === 0) return;
          // R-6c: Do not intercept CJK IME composition cancellation or already-handled Escape events
          if (ev.isComposing || ev.keyCode === 229 || ev.defaultPrevented) return;
          if (typeof ev.preventDefault === 'function') ev.preventDefault();
          if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
          closeTop();
        },
        true
      );
    }

    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener(
        'pointerdown',
        (ev) => {
          if (stack.length === 0) return;
          const top = stack[stack.length - 1];
          if (top.kind !== 'popover') return;
          const ignoreEls = [top.el, ...(top.ignoreOutsideClickEls || [])];
          if (isEventInsideElements(ev, ignoreEls)) {
            return;
          }
          closeEntry(top);
        },
        true
      );
    }
  }

  function findSlotDef(pluginMeta, slotId) {
    const slots = Array.isArray(pluginMeta && pluginMeta.uiSlots) ? pluginMeta.uiSlots : [];
    return slots.find((s) => s && s.slotId === slotId) || null;
  }

  function createSurfaceBody(el, pluginMeta, slotId, useShadow) {
    if (useShadow) {
      // WHATWG DOM: <dialog> cannot call attachShadow() directly; attach open ShadowRoot to an inner host <div>.
      const shadowHost =
        String(el.tagName || '').toLowerCase() === 'dialog'
          ? (() => {
              const wrap = doc.createElement('div');
              wrap.className = 'addon-host-modal-shadow-host';
              wrap.setAttribute('data-addon-host-owner', pluginMeta.pluginId);
              wrap.setAttribute('data-addon-host-slot', slotId);
              el.appendChild(wrap);
              return wrap;
            })()
          : el;
      if (typeof shadowHost.attachShadow === 'function') {
        const sr = shadowHost.attachShadow({ mode: 'open' });
        const inner = doc.createElement('div');
        inner.className = 'addon-host-slot-root';
        inner.setAttribute('data-addon-host-owner', pluginMeta.pluginId);
        inner.setAttribute('data-addon-host-slot', slotId);
        if (typeof sr.appendChild === 'function') sr.appendChild(inner);
        if (styleManager) styleManager.registerShadowRoot(pluginMeta.pluginId, slotId, sr);
        return { bodyEl: inner, shadowRoot: sr };
      }
    }
    return { bodyEl: el, shadowRoot: null };
  }

  function resolveUseShadow(pluginMeta, slotDef, opts = {}) {
    // R-6a: Match slot-manager.js shadow guard — restricted v2 plugins cannot downgrade shadow: true to false
    return typeof opts.shadow === 'boolean' && (opts.shadow === true || pluginMeta.trustLevel === 'trusted' || !slotDef.shadow)
      ? opts.shadow
      : Boolean(slotDef.shadow);
  }

  function openModal(pluginMeta, slotId, opts = {}) {
    const slotDef = findSlotDef(pluginMeta, slotId);
    if (!slotDef) {
      throw new Error(`ERR_UNDECLARED_SLOT:${pluginMeta.pluginId}:${slotId}`);
    }
    if (slotDef.slot !== 'modal' && slotDef.slot !== 'overlay') {
      throw new Error(`ERR_INVALID_MODAL_SLOT_KIND:${slotDef.slot}`);
    }

    ensureGlobalListeners();
    const prevCount = stack.length;
    const prevFocus = doc.activeElement || null;
    const dlg = doc.createElement('dialog');
    dlg.setAttribute('data-addon-host-modal-dialog', '1');
    dlg.setAttribute('data-addon-host-owner', pluginMeta.pluginId);
    dlg.setAttribute('data-addon-host-slot', slotId);
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('translate', 'no');
    dlg.setAttribute('data-addon-host-no-translate', 'true');
    for (let i = 0; i < extraNoTranslateAttributes.length; i++) {
      dlg.setAttribute(extraNoTranslateAttributes[i], 'true');
    }
    if (dlg.style) {
      // Center <dialog> inside the safe viewport region below the titlebar even under app CSS resets (* { margin: 0 }).
      dlg.style.position = 'fixed';
      dlg.style.inset = '0';
      dlg.style.top = '36px';
      dlg.style.top = 'max(env(titlebar-area-height, 36px), 36px)';
      dlg.style.right = '0';
      dlg.style.bottom = '0';
      dlg.style.left = '0';
      dlg.style.margin = 'auto';
      dlg.style.width = 'fit-content';
      dlg.style.height = 'fit-content';
      dlg.style.maxWidth = 'calc(100vw - 24px)';
      dlg.style.maxHeight = 'calc(100vh - 56px)';
      dlg.style.zIndex = String(2147483000 + stack.length + 1);
    }

    const useShadow = resolveUseShadow(pluginMeta, slotDef, opts);
    const { bodyEl, shadowRoot } = createSurfaceBody(dlg, pluginMeta, slotId, useShadow);

    const hostBody = doc.body || doc.documentElement;
    hostBody.appendChild(dlg);

    const requestedSurface =
      typeof opts.surface === 'string' && opts.surface.trim()
        ? opts.surface.trim()
        : opts.align === 'surface'
          ? 'auto'
          : null;

    const applySurfaceBounds = (targetSurface, anchorEl = null) => {
      if (!surfaceGeometry || typeof surfaceGeometry.getSurfaceBounds !== 'function') {
        return null;
      }
      const queryArg = anchorEl ? { surface: targetSurface || 'auto', anchorEl } : targetSurface || 'auto';
      const bounds = surfaceGeometry.getSurfaceBounds(queryArg);
      if (bounds && dlg.style) {
        dlg.setAttribute('data-addon-host-modal-surface', bounds.surfaceId);
        if (typeof bounds.source === 'string' && bounds.source) {
          dlg.setAttribute('data-addon-host-modal-surface-source', bounds.source);
        }
        dlg.setAttribute('data-addon-host-modal-surface-matched', bounds.matched ? 'true' : 'false');
        if (bounds.viewport && bounds.viewport.width > 0 && bounds.viewport.height > 0) {
          dlg.style.position = 'fixed';
          dlg.style.inset = '';
          dlg.style.left = `${bounds.insetLeft}px`;
          dlg.style.top = `${bounds.insetTop}px`;
          dlg.style.right = `${bounds.insetRight}px`;
          dlg.style.bottom = `${bounds.insetBottom}px`;
          dlg.style.margin = 'auto';
          dlg.style.maxWidth = `${Math.max(120, Math.floor(bounds.width - 24))}px`;
          dlg.style.maxHeight = `${Math.max(120, Math.floor(bounds.height - 24))}px`;
        }
      }
      return bounds;
    };

    const entry = {
      id: `modal-${++seq}`,
      kind: 'modal',
      pluginId: pluginMeta.pluginId,
      slotId,
      el: dlg,
      bodyEl,
      shadowRoot,
      prevFocus,
      surfaceTarget: requestedSurface,
      anchorEl: opts.anchorEl && typeof opts.anchorEl === 'object' ? opts.anchorEl : null,
      onResizeCleanup: null,
      ignoreOutsideClickEls: Array.isArray(opts.ignoreOutsideClickEls) ? opts.ignoreOutsideClickEls : [],
      onClose: opts.onClose || null,
    };

    if (requestedSurface && surfaceGeometry) {
      applySurfaceBounds(requestedSurface, entry.anchorEl);
      if (win && typeof win.addEventListener === 'function') {
        const handleResize = () => {
          if (entry.closing || !stack.includes(entry)) return;
          applySurfaceBounds(entry.surfaceTarget, entry.anchorEl);
        };
        win.addEventListener('resize', handleResize);
        entry.onResizeCleanup = () => {
          if (typeof win.removeEventListener === 'function') {
            win.removeEventListener('resize', handleResize);
          }
        };
      }
    }

    if (typeof dlg.addEventListener === 'function') {
      dlg.addEventListener('cancel', (ev) => {
        if (ev && ev.cancelable && typeof ev.preventDefault === 'function') {
          ev.preventDefault();
        }
        closeTop();
      });
      // R-6b: Sync stack if <dialog> is closed programmatically or via <form method="dialog">
      dlg.addEventListener('close', () => {
        closeEntry(entry);
      });
    }

    stack.push(entry);
    if (typeof dlg.showModal === 'function') {
      try {
        dlg.showModal();
      } catch (_e) {}
    }
    notifyPortalState(prevCount, stack.length);

    return Object.freeze({
      id: entry.id,
      element: dlg,
      bodyEl,
      close: () => closeEntry(entry),
      reposition: (nextSurface) => {
        if (entry.closing || !stack.includes(entry)) return null;
        if (typeof nextSurface === 'string' && nextSurface.trim()) {
          entry.surfaceTarget = nextSurface.trim();
        } else if (nextSurface && typeof nextSurface === 'object') {
          if (typeof nextSurface.surface === 'string' && nextSurface.surface.trim()) {
            entry.surfaceTarget = nextSurface.surface.trim();
          }
          if (nextSurface.anchorEl !== undefined) {
            entry.anchorEl = nextSurface.anchorEl && typeof nextSurface.anchorEl === 'object' ? nextSurface.anchorEl : null;
          }
        } else if (!entry.surfaceTarget) {
          entry.surfaceTarget = 'auto';
        }
        return applySurfaceBounds(entry.surfaceTarget, entry.anchorEl);
      },
    });
  }

  function openPopover(pluginMeta, slotId, opts = {}) {
    const slotDef = findSlotDef(pluginMeta, slotId);
    if (!slotDef) {
      throw new Error(`ERR_UNDECLARED_SLOT:${pluginMeta.pluginId}:${slotId}`);
    }
    if (slotDef.slot !== 'overlay' && slotDef.slot !== 'modal') {
      throw new Error(`ERR_INVALID_POPOVER_SLOT_KIND:${slotDef.slot}`);
    }

    ensureGlobalListeners();
    const prevCount = stack.length;
    const prevFocus = doc.activeElement || null;
    const pop = doc.createElement('div');
    pop.setAttribute('popover', 'manual');
    pop.setAttribute('data-addon-host-popover', '1');
    pop.setAttribute('data-addon-host-owner', pluginMeta.pluginId);
    pop.setAttribute('data-addon-host-slot', slotId);
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('translate', 'no');
    pop.setAttribute('data-addon-host-no-translate', 'true');
    for (let i = 0; i < extraNoTranslateAttributes.length; i++) {
      pop.setAttribute(extraNoTranslateAttributes[i], 'true');
    }
    if (pop.style) {
      pop.style.zIndex = String(2147483000 + stack.length + 1);
    }

    const useShadow = resolveUseShadow(pluginMeta, slotDef, opts);
    const { bodyEl, shadowRoot } = createSurfaceBody(pop, pluginMeta, slotId, useShadow);

    // R-2 + NB-4: Mount inside topmost non-closing connected modal <dialog> when active
    let mountParent = doc.body || doc.documentElement;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].kind === 'modal' && !stack[i].closing && stack[i].el && stack[i].el.isConnected !== false) {
        mountParent = stack[i].el;
        break;
      }
    }
    mountParent.appendChild(pop);

    const entry = {
      id: `popover-${++seq}`,
      kind: 'popover',
      pluginId: pluginMeta.pluginId,
      slotId,
      el: pop,
      bodyEl,
      shadowRoot,
      prevFocus,
      ignoreOutsideClickEls: Array.isArray(opts.ignoreOutsideClickEls) ? opts.ignoreOutsideClickEls : [],
      onClose: opts.onClose || null,
    };

    if (typeof pop.addEventListener === 'function') {
      // R-6b: Sync stack if popover is hidden externally via hidePopover()
      pop.addEventListener('toggle', (ev) => {
        if (ev && ev.newState === 'closed') {
          closeEntry(entry);
        }
      });
    }

    stack.push(entry);
    if (typeof pop.showPopover === 'function') {
      try {
        pop.showPopover();
      } catch (_e) {}
    }
    notifyPortalState(prevCount, stack.length);

    return Object.freeze({
      id: entry.id,
      element: pop,
      bodyEl,
      close: () => closeEntry(entry),
    });
  }

  function disposePluginPortals(pluginId) {
    for (const entry of stack.slice()) {
      if (entry.pluginId === pluginId) {
        closeEntry(entry);
      }
    }
  }

  return Object.freeze({
    openModal,
    openPopover,
    closeTop,
    disposePluginPortals,
    getStackSize: () => stack.length,
  });
}

module.exports = {
  createModalPortal,
};

  },
  "./region-observer.js": function(module, exports, require) {
'use strict';

/**
 * Throttled DOM Region Observer with automatic per-plugin disposal.
 */

function createRegionObserver(doc, win) {
  const observersByPlugin = new Map(); // pluginId -> Set<{ disconnect }>

  function observeRegion(pluginId, selector, callback, { debounceMs = 50 } = {}) {
    if (typeof callback !== 'function') throw new Error('ERR_OBSERVER_CALLBACK_REQUIRED');
    const MutationObs = (win && win.MutationObserver) || globalThis.MutationObserver;
    let timer = null;
    let disconnected = false;
    let lastMatch = null;

    const checkNow = () => {
      if (disconnected) return;
      let el = null;
      try {
        el = typeof doc.querySelector === 'function' ? doc.querySelector(selector) : null;
      } catch (_e) {
        return;
      }
      if (el && el !== lastMatch) {
        lastMatch = el;
        try {
          callback(el);
        } catch (_err) {}
      } else if (!el) {
        lastMatch = null;
      }
    };

    checkNow();

    let mo = null;
    if (typeof MutationObs === 'function' && (doc.body || doc.documentElement)) {
      mo = new MutationObs(() => {
        if (disconnected) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(checkNow, debounceMs);
      });
      try {
        mo.observe(doc.body || doc.documentElement, { childList: true, subtree: true });
      } catch (_e) {}
    }

    const handle = {
      disconnect() {
        disconnected = true;
        lastMatch = null;
        if (timer) clearTimeout(timer);
        if (mo && typeof mo.disconnect === 'function') {
          try {
            mo.disconnect();
          } catch (_e) {}
        }
        const ownerSet = observersByPlugin.get(pluginId);
        if (ownerSet) ownerSet.delete(handle);
      },
    };

    let set = observersByPlugin.get(pluginId);
    if (!set) {
      set = new Set();
      observersByPlugin.set(pluginId, set);
    }
    set.add(handle);
    return handle;
  }

  function disposePluginObservers(pluginId) {
    const set = observersByPlugin.get(pluginId);
    if (!set) return;
    for (const h of set) h.disconnect();
    observersByPlugin.delete(pluginId);
  }

  return Object.freeze({
    observeRegion,
    disposePluginObservers,
  });
}

module.exports = {
  createRegionObserver,
};

  },
  "./settings-tab-coordinator.js": function(module, exports, require) {
'use strict';

/**
 * Fail-Open Settings Tab Coordinator with per-plugin cleanup.
 */

function createSettingsTabCoordinator() {
  const tabsByPlugin = new Map(); // pluginId -> Map<tabId, { tabId, label, onSelect }>

  function registerSettingsTab(pluginId, tabId, { label, onSelect } = {}) {
    if (!tabId || typeof tabId !== 'string') throw new Error('ERR_INVALID_TAB_ID');
    let map = tabsByPlugin.get(pluginId);
    if (!map) {
      map = new Map();
      tabsByPlugin.set(pluginId, map);
    }
    map.set(tabId, { tabId, label: String(label || tabId), onSelect: typeof onSelect === 'function' ? onSelect : null });
    return {
      unregister() {
        map.delete(tabId);
      },
    };
  }

  function listTabs() {
    const out = [];
    for (const [pluginId, map] of tabsByPlugin.entries()) {
      for (const tab of map.values()) {
        out.push({
          pluginId,
          tabId: tab.tabId,
          label: tab.label,
          selectable: typeof tab.onSelect === 'function',
        });
      }
    }
    return out;
  }

  function selectTab(pluginId, tabId) {
    if (typeof pluginId !== 'string' || !pluginId || typeof tabId !== 'string' || !tabId) {
      return { ok: false, reason: 'ERR_SETTINGS_TAB_NOT_FOUND' };
    }
    const map = tabsByPlugin.get(pluginId);
    const tab = map ? map.get(tabId) : null;
    if (!tab) {
      return { ok: false, reason: 'ERR_SETTINGS_TAB_NOT_FOUND' };
    }
    if (typeof tab.onSelect !== 'function') {
      return { ok: false, reason: 'ERR_SETTINGS_TAB_NOT_SELECTABLE' };
    }
    try {
      const result = tab.onSelect({ pluginId, tabId: tab.tabId, label: tab.label });
      return { ok: true, reason: null, result };
    } catch (err) {
      return {
        ok: false,
        reason: 'ERR_SETTINGS_TAB_SELECT_FAILED',
        error: err && err.message ? err.message : String(err),
      };
    }
  }

  function disposePluginTabs(pluginId) {
    tabsByPlugin.delete(pluginId);
  }

  return Object.freeze({
    registerSettingsTab,
    listTabs,
    selectTab,
    disposePluginTabs,
  });
}

module.exports = {
  createSettingsTabCoordinator,
};

  },
  "./theme-i18n.js": function(module, exports, require) {
'use strict';

/**
 * Vendor-neutral Theme & i18n Provider for AddonContextV3 (v3.0.0 — SOLID #0).
 *
 * - Provides semantic `--ag-*` CSS custom properties synced to dark/light mode.
 * - Detects active locale from `document.documentElement.lang` / `navigator.language`.
 * - Zero vendor literals, zero Node built-ins.
 */

const _ObjectFreeze = Object.freeze;
const _ObjectKeys = Object.keys;
const _Set = Set;
const _SetAdd = Function.prototype.call.bind(Set.prototype.add);
const _SetDelete = Function.prototype.call.bind(Set.prototype.delete);
const _SetClear = Function.prototype.call.bind(Set.prototype.clear);
const _SetForEach = Function.prototype.call.bind(Set.prototype.forEach);

const DARK_TOKENS = _ObjectFreeze({
  '--ag-bg': '#0f131a',
  '--ag-surface': '#161b24',
  '--ag-surface-elevated': '#1e2532',
  '--ag-border': 'rgba(255, 255, 255, 0.14)',
  '--ag-text': '#f0f6fc',
  '--ag-text-muted': '#8b949e',
  '--ag-accent': '#38bdf8',
  '--ag-accent-fg': '#082f49',
  '--ag-danger': '#f87171',
  '--ag-success': '#4ade80',
  '--ag-warning': '#fbbf24',
  '--ag-radius': '10px',
  '--ag-shadow': '0 12px 32px rgba(0, 0, 0, 0.52)',
  '--ag-font': 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", sans-serif',
});

const LIGHT_TOKENS = Object.freeze({
  '--ag-bg': '#ffffff',
  '--ag-surface': '#f8fafc',
  '--ag-surface-elevated': '#ffffff',
  '--ag-border': 'rgba(15, 23, 42, 0.14)',
  '--ag-text': '#0f172a',
  '--ag-text-muted': '#475569',
  '--ag-accent': '#0284c7',
  '--ag-accent-fg': '#ffffff',
  '--ag-danger': '#dc2626',
  '--ag-success': '#16a34a',
  '--ag-warning': '#d97706',
  '--ag-radius': '10px',
  '--ag-shadow': '0 12px 32px rgba(15, 23, 42, 0.16)',
  '--ag-font': 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", sans-serif',
});

function buildTokenCss(mode) {
  const tokens = mode === 'light' ? LIGHT_TOKENS : DARK_TOKENS;
  const keys = _ObjectKeys(tokens);
  const lines = [];
  for (let i = 0; i < keys.length; i += 1) {
    lines[lines.length] = `  ${keys[i]}: ${tokens[keys[i]]};`;
  }
  return `:host {\n${lines.join('\n')}\n}`;
}

function createThemeAndI18n(doc, win) {
  const listeners = new _Set();

  function detectMode() {
    try {
      const docEl = doc && doc.documentElement;
      const explicit =
        docEl && typeof docEl.getAttribute === 'function'
          ? String(docEl.getAttribute('data-theme') || docEl.getAttribute('data-color-scheme') || '').toLowerCase()
          : '';
      if (explicit === 'light' || explicit === 'dark') return explicit;
      if (docEl && docEl.className && typeof docEl.className === 'string') {
        if (/\blight\b/i.test(docEl.className) && !/\bdark\b/i.test(docEl.className)) return 'light';
        if (/\bdark\b/i.test(docEl.className)) return 'dark';
      }
      if (win && typeof win.matchMedia === 'function') {
        const mq = win.matchMedia('(prefers-color-scheme: light)');
        if (mq && mq.matches) return 'light';
      }
    } catch (_e) {}
    return 'dark';
  }

  let currentMode = detectMode();
  let mediaQuery = null;
  const handleMediaChange = () => {
    const next = detectMode();
    if (next === currentMode) return;
    currentMode = next;
    const snap = getSnapshot();
    _SetForEach(listeners, (cb) => {
      try {
        cb(snap);
      } catch (_e) {}
    });
  };

  try {
    if (win && typeof win.matchMedia === 'function') {
      mediaQuery = win.matchMedia('(prefers-color-scheme: light)');
      if (mediaQuery && typeof mediaQuery.addEventListener === 'function') {
        mediaQuery.addEventListener('change', handleMediaChange);
      }
    }
  } catch (_e) {}

  function getSnapshot() {
    const mode = detectMode();
    currentMode = mode;
    return _ObjectFreeze({
      mode,
      tokens: mode === 'light' ? LIGHT_TOKENS : DARK_TOKENS,
    });
  }

  function getLocale() {
    try {
      const docLang =
        doc && doc.documentElement && typeof doc.documentElement.lang === 'string'
          ? doc.documentElement.lang.trim()
          : '';
      if (docLang) return docLang;
      const navLang =
        win && win.navigator && typeof win.navigator.language === 'string'
          ? win.navigator.language.trim()
          : '';
      if (navLang) return navLang;
    } catch (_e) {}
    return 'en';
  }

  function translate(key, dictOrParams = null, params = null) {
    const locale = getLocale().toLowerCase();
    const shortLocale = locale.split('-')[0];
    let template = String(key || '');
    let vars = params;
    if (dictOrParams && typeof dictOrParams === 'object' && !Array.isArray(dictOrParams)) {
      if (typeof dictOrParams[locale] === 'string') {
        template = dictOrParams[locale];
      } else if (typeof dictOrParams[shortLocale] === 'string') {
        template = dictOrParams[shortLocale];
      } else if (typeof dictOrParams.en === 'string') {
        template = dictOrParams.en;
      } else {
        vars = dictOrParams;
      }
    }
    if (vars && typeof vars === 'object') {
      template = template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, k) => {
        if (Object.prototype.hasOwnProperty.call(vars, k) && vars[k] !== undefined && vars[k] !== null) {
          return String(vars[k]);
        }
        return '';
      });
    }
    return template;
  }

  function createThemeHandle(registerDisposer) {
    return _ObjectFreeze({
      getMode: () => getSnapshot().mode,
      getTokens: () => getSnapshot().tokens,
      getTokenCss: () => buildTokenCss(getSnapshot().mode),
      onDidChange(cb) {
        if (typeof cb !== 'function') throw new Error('ERR_INVALID_THEME_LISTENER');
        _SetAdd(listeners, cb);
        const unsub = () => _SetDelete(listeners, cb);
        if (typeof registerDisposer === 'function') registerDisposer(unsub);
        return unsub;
      },
    });
  }

  function createI18nHandle() {
    return _ObjectFreeze({
      getLocale,
      t: translate,
    });
  }

  function dispose() {
    _SetClear(listeners);
    try {
      if (mediaQuery && typeof mediaQuery.removeEventListener === 'function') {
        mediaQuery.removeEventListener('change', handleMediaChange);
      }
    } catch (_e) {}
  }

  return _ObjectFreeze({
    getSnapshot,
    buildTokenCss,
    getLocale,
    t: translate,
    createThemeHandle,
    createI18nHandle,
    dispose,
  });
}

module.exports = {
  DARK_TOKENS,
  LIGHT_TOKENS,
  buildTokenCss,
  createThemeAndI18n,
};

  },
  "./ui-schema-renderer.js": function(module, exports, require) {
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

  },
  "./toast-manager.js": function(module, exports, require) {
'use strict';

/**
 * Vendor-neutral Tier-1 Toast, Confirm & Prompt Manager (v3.0.0 — SOLID #0).
 *
 * - `showToast`: Shadow DOM live region (`role="status"`, `aria-live="polite"`), auto-dismiss,
 *   variant styling (`info | success | warning | error`), non-removable `Addon: <displayName>` label.
 * - `confirm` / `prompt`: Top Layer `<dialog>` with non-removable `Addon: <displayName>` badge,
 *   LIFO Escape / cancel handling, focus return, IME-safe Enter, and `ev.isTrusted` click check.
 */

const { buildOverlayChrome } = require('./ui-schema-renderer');

const TOAST_CSS = `
.ag-toast-host {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483500;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: min(360px, calc(100vw - 32px));
  pointer-events: none;
  font-family: var(--ag-font, system-ui, -apple-system, sans-serif);
}
.ag-toast {
  pointer-events: auto;
  background: var(--ag-surface, #161b24);
  color: var(--ag-text, #f0f6fc);
  border: 1px solid var(--ag-border, rgba(255, 255, 255, 0.16));
  border-radius: 10px;
  padding: 10px 12px;
  box-shadow: var(--ag-shadow, 0 12px 32px rgba(0, 0, 0, 0.52));
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ag-toast[data-variant="success"] { border-left: 3px solid var(--ag-success, #4ade80); }
.ag-toast[data-variant="warning"] { border-left: 3px solid var(--ag-warning, #fbbf24); }
.ag-toast[data-variant="error"] { border-left: 3px solid var(--ag-danger, #f87171); }
.ag-toast[data-variant="info"] { border-left: 3px solid var(--ag-accent, #38bdf8); }
.ag-toast-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ag-toast-title { font-weight: 700; font-size: 12px; }
.ag-toast-badge { font-size: 10px; color: var(--ag-accent, #38bdf8); }
.ag-toast-msg { font-size: 12px; color: var(--ag-text, #f0f6fc); }
.ag-toast-actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: 4px; }
.ag-toast-btn {
  appearance: none;
  border: 1px solid var(--ag-border, rgba(255, 255, 255, 0.18));
  background: transparent;
  color: var(--ag-text, #f0f6fc);
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 11px;
  cursor: pointer;
}
`;

function createToastAndDialogManager(
  doc,
  win,
  { themeAndI18n = null, extraNoTranslateAttributes = [], onPortalClaimChange = null } = {}
) {
  let toastHostEl = null;
  let toastShadowRoot = null;
  let toastListEl = null;
  const toastsByPlugin = new Map(); // pluginId -> Set<{ dismiss }>
  const dialogsByPlugin = new Map(); // pluginId -> Set<{ close }>
  let seq = 0;

  function applyNoTranslate(el) {
    if (!el || typeof el.setAttribute !== 'function') return;
    el.setAttribute('translate', 'no');
    el.setAttribute('data-addon-host-no-translate', 'true');
    el.setAttribute('data-addon-host-ignore', 'true');
    for (let i = 0; i < extraNoTranslateAttributes.length; i += 1) {
      el.setAttribute(extraNoTranslateAttributes[i], 'true');
    }
  }

  function ensureToastContainer() {
    if (toastListEl && toastHostEl && toastHostEl.isConnected !== false) return toastListEl;
    toastHostEl = doc.createElement('div');
    toastHostEl.setAttribute('data-addon-host-toast-root', '1');
    applyNoTranslate(toastHostEl);
    if (typeof toastHostEl.attachShadow === 'function') {
      toastShadowRoot = toastHostEl.attachShadow({ mode: 'open' });
      const styleEl = doc.createElement('style');
      const tokenCss = themeAndI18n ? themeAndI18n.buildTokenCss(themeAndI18n.getSnapshot().mode) : '';
      styleEl.textContent = `${tokenCss}\n${TOAST_CSS}`;
      toastShadowRoot.appendChild(styleEl);
      toastListEl = doc.createElement('div');
      toastListEl.className = 'ag-toast-host';
      toastListEl.setAttribute('role', 'region');
      toastListEl.setAttribute('aria-label', 'Addon Notifications');
      toastShadowRoot.appendChild(toastListEl);
    } else {
      toastListEl = toastHostEl;
    }
    const parent = doc.body || doc.documentElement;
    if (parent && typeof parent.appendChild === 'function') {
      parent.appendChild(toastHostEl);
    }
    return toastListEl;
  }

  function showToast(pluginMeta, opts = {}) {
    const spec = typeof opts === 'string' ? { message: opts } : opts || {};
    const list = ensureToastContainer();
    const id = `toast-${++seq}`;
    const variant = ['info', 'success', 'warning', 'error'].includes(spec.variant) ? spec.variant : 'info';

    const card = doc.createElement('div');
    card.className = 'ag-toast';
    card.setAttribute('role', 'status');
    card.setAttribute('aria-live', variant === 'error' ? 'assertive' : 'polite');
    card.setAttribute('data-variant', variant);
    card.setAttribute('data-addon-host-owner', pluginMeta.pluginId);
    card.setAttribute('data-toast-id', id);

    const top = doc.createElement('div');
    top.className = 'ag-toast-top';
    const titleEl = doc.createElement('span');
    titleEl.className = 'ag-toast-title';
    titleEl.textContent = String(spec.title || variant.toUpperCase());
    const badgeEl = doc.createElement('span');
    badgeEl.className = 'ag-toast-badge';
    badgeEl.setAttribute('data-addon-host-attribution', '1');
    badgeEl.textContent = `Addon: ${String(pluginMeta.displayName || pluginMeta.pluginId)}`;
    top.appendChild(titleEl);
    top.appendChild(badgeEl);
    card.appendChild(top);

    const msgEl = doc.createElement('div');
    msgEl.className = 'ag-toast-msg';
    msgEl.textContent = String(spec.message || '');
    card.appendChild(msgEl);

    let timer = null;
    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (card.parentNode && typeof card.parentNode.removeChild === 'function') {
        card.parentNode.removeChild(card);
      }
      const set = toastsByPlugin.get(pluginMeta.pluginId);
      if (set) set.delete(handle);
    };

    const actionsRow = doc.createElement('div');
    actionsRow.className = 'ag-toast-actions';
    if (spec.action && typeof spec.action.label === 'string' && typeof spec.action.onClick === 'function') {
      const actBtn = doc.createElement('button');
      actBtn.type = 'button';
      actBtn.className = 'ag-toast-btn';
      actBtn.textContent = spec.action.label;
      actBtn.addEventListener('click', (ev) => {
        if (ev && ev.isTrusted === false) return;
        try {
          spec.action.onClick();
        } catch (_e) {}
        dismiss();
      });
      actionsRow.appendChild(actBtn);
    }
    const closeBtn = doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ag-toast-btn';
    closeBtn.textContent = 'Dismiss';
    closeBtn.addEventListener('click', (ev) => {
      if (ev && ev.isTrusted === false) return;
      dismiss();
    });
    actionsRow.appendChild(closeBtn);
    card.appendChild(actionsRow);

    list.appendChild(card);

    const durationMs = Number.isFinite(Number(spec.durationMs)) ? Number(spec.durationMs) : 4000;
    if (durationMs > 0) {
      timer = setTimeout(dismiss, durationMs);
    }

    const handle = Object.freeze({ id, dismiss });
    let set = toastsByPlugin.get(pluginMeta.pluginId);
    if (!set) {
      set = new Set();
      toastsByPlugin.set(pluginMeta.pluginId, set);
    }
    set.add(handle);
    return handle;
  }

  function openSimpleDialog(pluginMeta, mode, opts = {}) {
    return new Promise((resolve) => {
      const prevFocus = doc.activeElement || null;
      const dlg = doc.createElement('dialog');
      dlg.setAttribute('data-addon-host-modal-dialog', '1');
      dlg.setAttribute('data-addon-host-owner', pluginMeta.pluginId);
      dlg.setAttribute('role', 'dialog');
      dlg.setAttribute('aria-modal', 'true');
      applyNoTranslate(dlg);
      if (dlg.style) {
        dlg.style.position = 'fixed';
        dlg.style.inset = '0';
        dlg.style.margin = 'auto';
        dlg.style.padding = '0';
        dlg.style.border = 'none';
        dlg.style.background = 'transparent';
        dlg.style.maxWidth = 'min(420px, calc(100vw - 24px))';
        dlg.style.zIndex = '2147483400';
      }

      const wrap = doc.createElement('div');
      dlg.appendChild(wrap);
      const sr = typeof wrap.attachShadow === 'function' ? wrap.attachShadow({ mode: 'open' }) : wrap;
      const tokenCss = themeAndI18n ? themeAndI18n.buildTokenCss(themeAndI18n.getSnapshot().mode) : '';

      let settled = false;
      seq += 1;
      const claimId = `v3:dialog:${pluginMeta.pluginId}:${seq}`;
      const notifyPortalClaim = (active) => {
        if (typeof onPortalClaimChange === 'function') {
          try {
            onPortalClaimChange(claimId, active);
          } catch (_e) {}
        }
      };
      const finish = (value) => {
        if (settled) return;
        settled = true;
        notifyPortalClaim(false);
        const set = dialogsByPlugin.get(pluginMeta.pluginId);
        if (set) set.delete(tracker);
        try {
          if (typeof dlg.close === 'function' && dlg.open) dlg.close();
        } catch (_e) {}
        if (dlg.parentNode && typeof dlg.parentNode.removeChild === 'function') {
          dlg.parentNode.removeChild(dlg);
        }
        if (prevFocus && typeof prevFocus.focus === 'function') {
          try {
            prevFocus.focus();
          } catch (_e) {}
        }
        resolve(value);
      };

      const { body } = buildOverlayChrome(doc, sr, {
        title: String(opts.title || (mode === 'prompt' ? 'Input Required' : 'Confirm')),
        displayName: pluginMeta.displayName || pluginMeta.pluginId,
        tokenCss,
        closable: true,
        onClose: () => finish(mode === 'prompt' ? null : false),
      });

      if (opts.message) {
        const msg = doc.createElement('p');
        msg.className = 'ag-text';
        msg.textContent = String(opts.message);
        body.appendChild(msg);
      }

      let inputEl = null;
      if (mode === 'prompt') {
        inputEl = doc.createElement('input');
        inputEl.type = opts.inputType === 'password' ? 'password' : 'text';
        inputEl.className = 'ag-input';
        inputEl.value = opts.defaultValue !== undefined && opts.defaultValue !== null ? String(opts.defaultValue) : '';
        if (opts.placeholder) inputEl.setAttribute('placeholder', String(opts.placeholder));
        inputEl.addEventListener('keydown', (ev) => {
          if (!ev || ev.key !== 'Enter') return;
          if (ev.isComposing || ev.keyCode === 229 || ev.isTrusted === false) return;
          finish(inputEl.value);
        });
        body.appendChild(inputEl);
      }

      const btnRow = doc.createElement('div');
      btnRow.className = 'ag-row';
      if (btnRow.style) btnRow.style.justifyContent = 'flex-end';

      const cancelBtn = doc.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'ag-btn';
      cancelBtn.setAttribute('data-ag-dialog-cancel', '1');
      cancelBtn.textContent = String(opts.cancelLabel || 'Cancel');
      cancelBtn.addEventListener('click', (ev) => {
        if (ev && ev.isTrusted === false) return;
        finish(mode === 'prompt' ? null : false);
      });

      const confirmBtn = doc.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'ag-btn';
      confirmBtn.setAttribute('data-ag-dialog-confirm', '1');
      confirmBtn.setAttribute('data-variant', opts.destructive ? 'danger' : 'primary');
      confirmBtn.textContent = String(opts.confirmLabel || 'OK');
      confirmBtn.addEventListener('click', (ev) => {
        if (ev && ev.isTrusted === false) return;
        finish(mode === 'prompt' ? (inputEl ? inputEl.value : '') : true);
      });

      btnRow.appendChild(cancelBtn);
      btnRow.appendChild(confirmBtn);
      body.appendChild(btnRow);

      if (typeof dlg.addEventListener === 'function') {
        dlg.addEventListener('cancel', (ev) => {
          if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
          finish(mode === 'prompt' ? null : false);
        });
      }

      const tracker = { close: () => finish(mode === 'prompt' ? null : false) };
      let set = dialogsByPlugin.get(pluginMeta.pluginId);
      if (!set) {
        set = new Set();
        dialogsByPlugin.set(pluginMeta.pluginId, set);
      }
      set.add(tracker);

      const parent = doc.body || doc.documentElement;
      if (parent && typeof parent.appendChild === 'function') {
        parent.appendChild(dlg);
      }
      notifyPortalClaim(true);
      if (typeof dlg.showModal === 'function') {
        try {
          dlg.showModal();
        } catch (_e) {}
      }
      if (inputEl && typeof inputEl.focus === 'function') {
        try {
          inputEl.focus();
        } catch (_e) {}
      }
    });
  }

  function confirm(pluginMeta, opts) {
    return openSimpleDialog(pluginMeta, 'confirm', typeof opts === 'string' ? { message: opts } : opts || {});
  }

  function prompt(pluginMeta, opts) {
    return openSimpleDialog(pluginMeta, 'prompt', typeof opts === 'string' ? { message: opts } : opts || {});
  }

  function disposePlugin(pluginId) {
    const tSet = toastsByPlugin.get(pluginId);
    if (tSet) {
      Array.from(tSet).forEach((h) => h.dismiss());
      toastsByPlugin.delete(pluginId);
    }
    const dSet = dialogsByPlugin.get(pluginId);
    if (dSet) {
      Array.from(dSet).forEach((d) => d.close());
      dialogsByPlugin.delete(pluginId);
    }
  }

  return Object.freeze({
    showToast,
    confirm,
    prompt,
    disposePlugin,
  });
}

module.exports = {
  createToastAndDialogManager,
};

  },
  "./service-bus.js": function(module, exports, require) {
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

  },
  "./event-bus.js": function(module, exports, require) {
'use strict';

/**
 * Vendor-neutral Plugin Event Bus with Payload Sanitization & Auto-Dispose (v3.0.0 — SOLID #0).
 */

const { sanitizeBusPayload } = require('../../core/service-bus-policy');

function createEventBus({ reportPluginError = () => {} } = {}) {
  const listenersByTopic = new Map(); // topic -> Set<{ pluginId, handler, once }>

  function on(pluginId, topic, handler, { once = false } = {}) {
    if (typeof topic !== 'string' || !topic.trim()) throw new Error('ERR_INVALID_EVENT_TOPIC');
    if (typeof handler !== 'function') throw new Error('ERR_INVALID_EVENT_HANDLER');
    const cleanTopic = topic.trim();
    let set = listenersByTopic.get(cleanTopic);
    if (!set) {
      set = new Set();
      listenersByTopic.set(cleanTopic, set);
    }
    const entry = { pluginId, handler, once: Boolean(once) };
    set.add(entry);
    return () => {
      set.delete(entry);
      if (set.size === 0) listenersByTopic.delete(cleanTopic);
    };
  }

  function once(pluginId, topic, handler) {
    return on(pluginId, topic, handler, { once: true });
  }

  function emit(pluginId, topic, payload) {
    if (typeof topic !== 'string' || !topic.trim()) throw new Error('ERR_INVALID_EVENT_TOPIC');
    const cleanTopic = topic.trim();
    const set = listenersByTopic.get(cleanTopic);
    if (!set || set.size === 0) return 0;
    const cleanPayload = payload === undefined ? undefined : sanitizeBusPayload(payload);
    const snapshot = Array.from(set);
    let delivered = 0;
    for (let i = 0; i < snapshot.length; i += 1) {
      const entry = snapshot[i];
      if (entry.once) set.delete(entry);
      delivered += 1;
      try {
        const ret = entry.handler(
          cleanPayload === undefined ? undefined : sanitizeBusPayload(cleanPayload),
          Object.freeze({ topic: cleanTopic, sourcePluginId: pluginId })
        );
        if (ret && typeof ret.then === 'function') {
          ret.catch((err) => reportPluginError(entry.pluginId, err && err.message ? err.message : String(err)));
        }
      } catch (err) {
        reportPluginError(entry.pluginId, err && err.message ? err.message : String(err));
      }
    }
    if (set.size === 0) listenersByTopic.delete(cleanTopic);
    return delivered;
  }

  function disposePlugin(pluginId) {
    for (const [topic, set] of Array.from(listenersByTopic.entries())) {
      for (const entry of Array.from(set)) {
        if (entry.pluginId === pluginId) set.delete(entry);
      }
      if (set.size === 0) listenersByTopic.delete(topic);
    }
  }

  return Object.freeze({
    on,
    once,
    emit,
    disposePlugin,
  });
}

module.exports = {
  createEventBus,
};

  },
  "./storage-v3.js": function(module, exports, require) {
'use strict';

/**
 * Vendor-neutral Plugin-Scoped KV Storage with TTL & `onDidChange` (v3.0.0 — SOLID #0).
 *
 * - Strictly scoped per plugin (`storageNamespace`).
 * - Supports async `get(key)`, `set(key, value, { ttlMs? })`, `delete(key)`, `keys()`, `clear()`,
 *   and `onDidChange(cb)`.
 * - Strips/rejects prototype-pollution keys via `sanitizeBusPayload`.
 * - Persists to `localStorage` when available, with automatic in-memory fallback.
 */

const { sanitizeBusPayload } = require('../../core/service-bus-policy');

const _ObjectFreeze = Object.freeze;
const _ObjectEntries = Object.entries;
const _ArrayIsArray = Array.isArray;
const _Map = Map;
const _MapGet = Function.prototype.call.bind(Map.prototype.get);
const _MapSet = Function.prototype.call.bind(Map.prototype.set);
const _MapDelete = Function.prototype.call.bind(Map.prototype.delete);
const _MapClear = Function.prototype.call.bind(Map.prototype.clear);
const _MapForEach = Function.prototype.call.bind(Map.prototype.forEach);
const _Set = Set;
const _SetHas = Function.prototype.call.bind(Set.prototype.has);
const _SetAdd = Function.prototype.call.bind(Set.prototype.add);
const _SetDelete = Function.prototype.call.bind(Set.prototype.delete);
const _SetClear = Function.prototype.call.bind(Set.prototype.clear);
const _SetForEach = Function.prototype.call.bind(Set.prototype.forEach);

const FORBIDDEN_KEYS = new _Set(['__proto__', 'constructor', 'prototype']);

function createStorageV3(win, { namespacePrefix = 'ag-v3-storage' } = {}) {
  const buckets = new _Map(); // pluginId -> { map: Map<k, { v, exp }>, listeners: Set<fn>, storageKey }

  function resolveBackingStore() {
    try {
      if (win && win.localStorage && typeof win.localStorage.getItem === 'function') {
        return win.localStorage;
      }
    } catch (_e) {}
    return null;
  }

  function getBucket(pluginId, customNamespace) {
    let bucket = _MapGet(buckets, pluginId);
    if (bucket) return bucket;
    const ns = typeof customNamespace === 'string' && customNamespace ? customNamespace : pluginId;
    const storageKey = `${namespacePrefix}:${ns}`;
    const map = new _Map();
    const store = resolveBackingStore();
    if (store) {
      try {
        const raw = store.getItem(storageKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && !_ArrayIsArray(parsed)) {
            const now = Date.now();
            const entries = _ObjectEntries(parsed);
            for (let i = 0; i < entries.length; i += 1) {
              const k = entries[i][0];
              const rec = entries[i][1];
              if (_SetHas(FORBIDDEN_KEYS, k) || !rec || typeof rec !== 'object') continue;
              if (typeof rec.exp === 'number' && rec.exp <= now) continue;
              _MapSet(map, k, { v: sanitizeBusPayload(rec.v), exp: typeof rec.exp === 'number' ? rec.exp : null });
            }
          }
        }
      } catch (_e) {}
    }
    bucket = { map, listeners: new _Set(), storageKey };
    _MapSet(buckets, pluginId, bucket);
    return bucket;
  }

  function persistBucket(bucket) {
    const store = resolveBackingStore();
    if (!store) return;
    try {
      const obj = {};
      const now = Date.now();
      const expired = [];
      _MapForEach(bucket.map, (rec, k) => {
        if (rec.exp !== null && rec.exp <= now) {
          expired[expired.length] = k;
        } else {
          obj[k] = rec;
        }
      });
      for (let i = 0; i < expired.length; i += 1) {
        _MapDelete(bucket.map, expired[i]);
      }
      store.setItem(bucket.storageKey, JSON.stringify(obj));
    } catch (_e) {}
  }

  function emitChange(bucket, change) {
    const frozen = _ObjectFreeze(change);
    const cbs = [];
    _SetForEach(bucket.listeners, (cb) => {
      cbs[cbs.length] = cb;
    });
    for (let i = 0; i < cbs.length; i += 1) {
      try {
        cbs[i](frozen);
      } catch (_e) {}
    }
  }

  function createPluginStorage(pluginId, { namespace = null, maxBytes = 65536, assertActive = () => {}, registerDisposer = () => {} } = {}) {
    const bucket = getBucket(pluginId, namespace);

    return _ObjectFreeze({
      async get(key) {
        assertActive();
        if (typeof key !== 'string' || !key || _SetHas(FORBIDDEN_KEYS, key)) {
          throw new Error('ERR_INVALID_STORAGE_KEY');
        }
        const rec = _MapGet(bucket.map, key);
        if (!rec) return undefined;
        if (rec.exp !== null && rec.exp <= Date.now()) {
          _MapDelete(bucket.map, key);
          persistBucket(bucket);
          return undefined;
        }
        return sanitizeBusPayload(rec.v);
      },

      async set(key, value, opts = {}) {
        assertActive();
        if (typeof key !== 'string' || !key || _SetHas(FORBIDDEN_KEYS, key)) {
          throw new Error('ERR_INVALID_STORAGE_KEY');
        }
        const cleanVal = sanitizeBusPayload(value);
        const serialized = JSON.stringify(cleanVal);
        if (serialized && serialized.length > maxBytes) {
          throw new Error('ERR_STORAGE_QUOTA_EXCEEDED');
        }
        const ttlMs = opts && Number.isFinite(Number(opts.ttlMs)) && Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : null;
        const exp = ttlMs ? Date.now() + ttlMs : null;
        const now = Date.now();
        // NB-04: Enforce total bucket serialized byte quota across all live keys
        const projected = {};
        _MapForEach(bucket.map, (rec, existingKey) => {
          if (existingKey === key) return;
          if (rec.exp !== null && rec.exp <= now) return;
          projected[existingKey] = rec;
        });
        projected[key] = { v: cleanVal, exp };
        const totalSerialized = JSON.stringify(projected);
        if (totalSerialized && totalSerialized.length > maxBytes) {
          throw new Error('ERR_STORAGE_QUOTA_EXCEEDED');
        }
        const prevRec = _MapGet(bucket.map, key);
        const oldValue = prevRec && (prevRec.exp === null || prevRec.exp > now) ? sanitizeBusPayload(prevRec.v) : undefined;
        _MapSet(bucket.map, key, { v: cleanVal, exp });
        persistBucket(bucket);
        emitChange(bucket, { key, oldValue, newValue: sanitizeBusPayload(cleanVal) });
        return true;
      },

      async delete(key) {
        assertActive();
        if (typeof key !== 'string' || !key || _SetHas(FORBIDDEN_KEYS, key)) {
          throw new Error('ERR_INVALID_STORAGE_KEY');
        }
        const prev = _MapGet(bucket.map, key);
        const existed = _MapDelete(bucket.map, key);
        if (existed) {
          persistBucket(bucket);
          emitChange(bucket, { key, oldValue: prev ? sanitizeBusPayload(prev.v) : undefined, newValue: undefined });
        }
        return existed;
      },

      async keys() {
        assertActive();
        const now = Date.now();
        const out = [];
        const expired = [];
        _MapForEach(bucket.map, (rec, k) => {
          if (rec.exp !== null && rec.exp <= now) {
            expired[expired.length] = k;
          } else {
            out[out.length] = k;
          }
        });
        for (let i = 0; i < expired.length; i += 1) {
          _MapDelete(bucket.map, expired[i]);
        }
        if (expired.length > 0) persistBucket(bucket);
        return out;
      },

      async clear() {
        assertActive();
        _MapClear(bucket.map);
        persistBucket(bucket);
        emitChange(bucket, { key: '*', oldValue: undefined, newValue: undefined });
      },

      onDidChange(cb) {
        assertActive();
        if (typeof cb !== 'function') throw new Error('ERR_INVALID_STORAGE_LISTENER');
        _SetAdd(bucket.listeners, cb);
        const unsub = () => _SetDelete(bucket.listeners, cb);
        registerDisposer(unsub);
        return unsub;
      },
    });
  }

  function disposePlugin(pluginId) {
    const bucket = _MapGet(buckets, pluginId);
    if (bucket) {
      _SetClear(bucket.listeners);
    }
  }

  return _ObjectFreeze({
    createPluginStorage,
    disposePlugin,
  });
}

module.exports = {
  createStorageV3,
};

  },
  "./status-item-registry.js": function(module, exports, require) {
'use strict';

/**
 * Vendor-neutral Tier-1 Status Item Registry (v3.0.0 — SOLID #0).
 *
 * - Delegates `ui.registerStatusItem` to the installed `'host.statusbar'` service
 *   (e.g., `antigravity-statusbar`) when available.
 * - Falls back automatically to a minimal, accessible Shadow-DOM host bar when
 *   `'host.statusbar'` is not installed.
 * - Delivers click modifiers `{ shiftKey, ctrlKey, metaKey, altKey, anchorEl, itemId }`
 *   to `onClick` and enforces `ev.isTrusted !== false`.
 */

const FALLBACK_BAR_CSS = `
.ag-fallback-bar {
  position: fixed;
  left: 12px;
  bottom: 12px;
  z-index: 2147482900;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 999px;
  background: var(--ag-surface, rgba(18, 22, 30, 0.92));
  border: 1px solid var(--ag-border, rgba(255, 255, 255, 0.14));
  box-shadow: var(--ag-shadow, 0 6px 20px rgba(0, 0, 0, 0.4));
  font-family: var(--ag-font, system-ui, -apple-system, sans-serif);
}
.ag-fallback-bar[hidden] { display: none; }
.ag-status-btn {
  appearance: none;
  border: 1px solid transparent;
  background: transparent;
  color: var(--ag-text, #f0f6fc);
  border-radius: 999px;
  padding: 4px 9px;
  min-height: 28px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.ag-status-btn:hover { background: rgba(255, 255, 255, 0.08); }
.ag-status-badge {
  background: rgba(56, 189, 248, 0.18);
  color: var(--ag-accent, #38bdf8);
  border-radius: 999px;
  padding: 1px 6px;
  font-size: 10px;
}
`;

// NEW-BLK-01 / R3-BLK-01..02 / R3-NB-03: Capture JS primordials at module load so World 998 prototype tampering cannot hijack statusbar items or delegation.
const _Error = Error;
const _String = String;
const _Number = Number;
const _NumberIsFinite = Number.isFinite;
const _StringTrim = Function.prototype.call.bind(String.prototype.trim);
const _ObjectCreate = Object.create;
const _ObjectDefineProperty = Object.defineProperty;
const _ObjectFreeze = Object.freeze;
const _ObjectHasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
const _ReflectApply = Reflect.apply;
const _Map = Map;
const _MapGet = Function.prototype.call.bind(Map.prototype.get);
const _MapSet = Function.prototype.call.bind(Map.prototype.set);
const _MapHas = Function.prototype.call.bind(Map.prototype.has);
const _MapDelete = Function.prototype.call.bind(Map.prototype.delete);
const _MapClear = Function.prototype.call.bind(Map.prototype.clear);
const _MapForEach = Function.prototype.call.bind(Map.prototype.forEach);

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

function createStatusItemRegistry(doc, _win, { serviceBus = null, themeAndI18n = null, extraNoTranslateAttributes = [] } = {}) {
  const itemsByKey = new _Map(); // `${pluginId}:${itemId}` -> itemRecord
  const delegatedByKey = new _Map(); // `${pluginId}:${itemId}` -> { unregister }
  let fallbackHostEl = null;
  let fallbackBarEl = null;

  function getDelegatedService() {
    if (!serviceBus || typeof serviceBus.getInternalService !== 'function') return null;
    const svc = serviceBus.getInternalService('host.statusbar');
    const impl = getOwn(svc, 'impl');
    if (impl && typeof getOwn(impl, 'registerItem') === 'function') {
      return impl;
    }
    return null;
  }

  function ensureFallbackBar() {
    if (fallbackBarEl && fallbackHostEl && fallbackHostEl.isConnected !== false) return fallbackBarEl;
    if (!doc || typeof doc.createElement !== 'function') return null;
    fallbackHostEl = doc.createElement('div');
    fallbackHostEl.setAttribute('data-addon-host-fallback-statusbar', '1');
    fallbackHostEl.setAttribute('data-addon-host-ignore', 'true');
    fallbackHostEl.setAttribute('translate', 'no');
    fallbackHostEl.setAttribute('data-addon-host-no-translate', 'true');
    for (let i = 0; i < extraNoTranslateAttributes.length; i += 1) {
      fallbackHostEl.setAttribute(extraNoTranslateAttributes[i], 'true');
    }
    if (typeof fallbackHostEl.attachShadow === 'function') {
      const sr = fallbackHostEl.attachShadow({ mode: 'open' });
      const styleEl = doc.createElement('style');
      const tokenCss = themeAndI18n ? themeAndI18n.buildTokenCss(themeAndI18n.getSnapshot().mode) : '';
      styleEl.textContent = `${tokenCss}\n${FALLBACK_BAR_CSS}`;
      sr.appendChild(styleEl);
      fallbackBarEl = doc.createElement('div');
      fallbackBarEl.className = 'ag-fallback-bar';
      fallbackBarEl.setAttribute('role', 'toolbar');
      fallbackBarEl.setAttribute('aria-label', 'Addon Status Items');
      sr.appendChild(fallbackBarEl);
    } else {
      fallbackBarEl = fallbackHostEl;
    }
    const parent = doc.body || doc.documentElement;
    if (parent && typeof parent.appendChild === 'function') {
      parent.appendChild(fallbackHostEl);
    }
    return fallbackBarEl;
  }

  function removeFallbackBarIfEmpty() {
    if (!fallbackBarEl) return;
    if (fallbackBarEl.childNodes.length === 0) {
      if (typeof fallbackBarEl.setAttribute === 'function') {
        fallbackBarEl.setAttribute('hidden', 'true');
      }
    }
  }

  function buildClickPayload(record, ev, anchorEl) {
    return _ObjectFreeze({
      pluginId: record.pluginId,
      itemId: record.id,
      shiftKey: !!(ev && ev.shiftKey),
      ctrlKey: !!(ev && ev.ctrlKey),
      metaKey: !!(ev && ev.metaKey),
      altKey: !!(ev && ev.altKey),
      anchorEl: anchorEl || null,
    });
  }

  function renderFallbackItems() {
    const delegatedSvc = getDelegatedService();
    if (delegatedSvc) {
      if (fallbackBarEl) {
        while (fallbackBarEl.firstChild) fallbackBarEl.removeChild(fallbackBarEl.firstChild);
        if (typeof fallbackBarEl.setAttribute === 'function') fallbackBarEl.setAttribute('hidden', 'true');
      }
      return;
    }

    const sorted = [];
    _MapForEach(itemsByKey, (rec) => {
      pushSafe(sorted, rec);
    });
    // R3-BLK-02: Local insertion sort using defineSafeDataProp — never invokes Array.prototype.sort or Array.prototype[idx] setters.
    for (let i = 1; i < sorted.length; i += 1) {
      const cur = sorted[i];
      let j = i - 1;
      while (j >= 0) {
        const prev = sorted[j];
        const cmp = prev.priority !== cur.priority ? prev.priority - cur.priority : prev.key < cur.key ? -1 : 1;
        if (cmp <= 0) break;
        defineSafeDataProp(sorted, j + 1, prev);
        j -= 1;
      }
      defineSafeDataProp(sorted, j + 1, cur);
    }
    if (sorted.length === 0) {
      if (fallbackBarEl) {
        while (fallbackBarEl.firstChild) fallbackBarEl.removeChild(fallbackBarEl.firstChild);
        removeFallbackBarIfEmpty();
      }
      return;
    }

    const bar = ensureFallbackBar();
    if (!bar) return;
    if (typeof bar.removeAttribute === 'function') bar.removeAttribute('hidden');
    while (bar.firstChild) bar.removeChild(bar.firstChild);

    for (let i = 0; i < sorted.length; i += 1) {
      const rec = sorted[i];
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'ag-status-btn';
      btn.setAttribute('data-addon-host-owner', rec.pluginId);
      btn.setAttribute('data-status-item-id', rec.id);
      if (rec.tooltip) btn.setAttribute('title', rec.tooltip);
      const labelSpan = doc.createElement('span');
      labelSpan.textContent = rec.icon ? `${rec.icon} ${rec.label}` : rec.label;
      btn.appendChild(labelSpan);
      if (rec.badge) {
        const badgeSpan = doc.createElement('span');
        badgeSpan.className = 'ag-status-badge';
        badgeSpan.textContent = rec.badge;
        btn.appendChild(badgeSpan);
      }
      btn.addEventListener('click', (ev) => {
        if (ev && ev.isTrusted === false) return;
        if (typeof rec.onClick === 'function') {
          try {
            rec.onClick(buildClickPayload(rec, ev, btn));
          } catch (_e) {}
        }
      });
      bar.appendChild(btn);
    }
  }

  function syncDelegation() {
    const svc = getDelegatedService();
    if (!svc) {
      // Clear any stale delegation handles and fall back to host bar
      _MapClear(delegatedByKey);
      renderFallbackItems();
      return;
    }
    // Delegate every active item that is not yet delegated
    _MapForEach(itemsByKey, (rec, key) => {
      if (!_MapHas(delegatedByKey, key)) {
        try {
          const res = svc.registerItem({
            pluginId: rec.pluginId,
            id: rec.id,
            label: rec.label,
            icon: rec.icon,
            tooltip: rec.tooltip,
            badge: rec.badge,
            align: rec.align,
            priority: rec.priority,
            onClick: (ev) => {
              if (typeof rec.onClick === 'function') {
                rec.onClick(buildClickPayload(rec, ev, ev && ev.anchorEl ? ev.anchorEl : null));
              }
            },
          });
          _MapSet(delegatedByKey, key, res || { delegated: true });
        } catch (_e) {}
      }
    });
    renderFallbackItems();
  }

  function registerStatusItem(pluginId, spec) {
    const rawId = getOwn(spec, 'id');
    if (!spec || typeof spec !== 'object' || typeof rawId !== 'string' || !_StringTrim(rawId)) {
      throw new _Error('ERR_INVALID_STATUS_ITEM_ID');
    }
    const id = _StringTrim(rawId);
    const key = `${pluginId}:${id}`;
    const rawLabel = getOwn(spec, 'label');
    const rawIcon = getOwn(spec, 'icon');
    const rawTooltip = getOwn(spec, 'tooltip');
    const rawBadge = getOwn(spec, 'badge');
    const rawAlign = getOwn(spec, 'align');
    const rawPriority = getOwn(spec, 'priority');
    const rawOnClick = getOwn(spec, 'onClick');
    const parsedPriority = _Number(rawPriority);
    const record = _ObjectCreate(null);
    record.key = key;
    record.pluginId = pluginId;
    record.id = id;
    record.label = _String(rawLabel || id);
    record.icon = typeof rawIcon === 'string' ? rawIcon : '';
    record.tooltip = typeof rawTooltip === 'string' ? rawTooltip : '';
    record.badge = rawBadge !== undefined && rawBadge !== null ? _String(rawBadge) : '';
    record.align = rawAlign === 'left' ? 'left' : 'right';
    record.priority = rawPriority !== undefined && _NumberIsFinite(parsedPriority) ? parsedPriority : 100;
    record.onClick = typeof rawOnClick === 'function' ? rawOnClick : null;
    _MapSet(itemsByKey, key, record);

    const svc = getDelegatedService();
    if (svc) {
      try {
        const res = svc.registerItem({
          pluginId: record.pluginId,
          id: record.id,
          label: record.label,
          icon: record.icon,
          tooltip: record.tooltip,
          badge: record.badge,
          align: record.align,
          priority: record.priority,
          onClick: (ev) => {
            if (typeof record.onClick === 'function') {
              record.onClick(buildClickPayload(record, ev, ev && ev.anchorEl ? ev.anchorEl : null));
            }
          },
        });
        _MapSet(delegatedByKey, key, res || { delegated: true });
      } catch (_e) {}
    } else {
      renderFallbackItems();
    }

    return _ObjectFreeze({
      id,
      update(patch) {
        if (!_MapHas(itemsByKey, key) || !patch || typeof patch !== 'object') return;
        const pLabel = getOwn(patch, 'label');
        const pIcon = getOwn(patch, 'icon');
        const pTooltip = getOwn(patch, 'tooltip');
        const pBadge = getOwn(patch, 'badge');
        const pPriority = getOwn(patch, 'priority');
        if (pLabel !== undefined) record.label = _String(pLabel);
        if (pIcon !== undefined) record.icon = _String(pIcon || '');
        if (pTooltip !== undefined) record.tooltip = _String(pTooltip || '');
        if (pBadge !== undefined) record.badge = pBadge === null ? '' : _String(pBadge);
        if (pPriority !== undefined && _NumberIsFinite(_Number(pPriority))) {
          record.priority = _Number(pPriority);
        }
        const activeSvc = getDelegatedService();
        const updateFn = getOwn(activeSvc, 'updateItem');
        if (typeof updateFn === 'function') {
          try {
            const updateArgs = [];
            defineSafeDataProp(updateArgs, 0, pluginId);
            defineSafeDataProp(updateArgs, 1, id);
            defineSafeDataProp(updateArgs, 2, {
              label: record.label,
              icon: record.icon,
              tooltip: record.tooltip,
              badge: record.badge,
              priority: record.priority,
            });
            _ReflectApply(updateFn, activeSvc, updateArgs);
          } catch (_e) {}
        } else {
          renderFallbackItems();
        }
      },
      dispose() {
        if (!_MapHas(itemsByKey, key)) return;
        _MapDelete(itemsByKey, key);
        const del = _MapGet(delegatedByKey, key);
        _MapDelete(delegatedByKey, key);
        const disposeFn = getOwn(del, 'dispose');
        if (typeof disposeFn === 'function') {
          try {
            disposeFn();
          } catch (_e) {}
        } else {
          const activeSvc = getDelegatedService();
          const removeFn = getOwn(activeSvc, 'removeItem');
          if (typeof removeFn === 'function') {
            try {
              const removeArgs = [];
              defineSafeDataProp(removeArgs, 0, pluginId);
              defineSafeDataProp(removeArgs, 1, id);
              _ReflectApply(removeFn, activeSvc, removeArgs);
            } catch (_e) {}
          }
        }
        renderFallbackItems();
      },
    });
  }

  function listStatusItems() {
    const out = [];
    _MapForEach(itemsByKey, (r) => {
      pushSafe(
        out,
        _ObjectFreeze({
          pluginId: r.pluginId,
          id: r.id,
          label: r.label,
          icon: r.icon,
          tooltip: r.tooltip,
          badge: r.badge,
          align: r.align,
          priority: r.priority,
          delegated: _MapHas(delegatedByKey, r.key),
        })
      );
    });
    return out;
  }

  function invokeStatusItem(pluginId, itemId, clickEvent = {}) {
    const rec = _MapGet(itemsByKey, `${pluginId}:${itemId}`);
    if (!rec || typeof rec.onClick !== 'function') {
      return { ok: false, reason: 'ERR_STATUS_ITEM_NOT_FOUND' };
    }
    rec.onClick(buildClickPayload(rec, clickEvent, clickEvent && clickEvent.anchorEl ? clickEvent.anchorEl : null));
    return { ok: true };
  }

  function disposePlugin(pluginId) {
    const toRemove = [];
    _MapForEach(itemsByKey, (rec, key) => {
      if (rec.pluginId === pluginId) pushSafe(toRemove, key);
    });
    for (let i = 0; i < toRemove.length; i += 1) {
      const key = toRemove[i];
      _MapDelete(itemsByKey, key);
      const del = _MapGet(delegatedByKey, key);
      _MapDelete(delegatedByKey, key);
      const disposeFn = getOwn(del, 'dispose');
      if (typeof disposeFn === 'function') {
        try {
          disposeFn();
        } catch (_e) {}
      }
    }
    renderFallbackItems();
  }

  return _ObjectFreeze({
    registerStatusItem,
    listStatusItems,
    invokeStatusItem,
    syncDelegation,
    isDelegated: () => !!getDelegatedService(),
    disposePlugin,
  });
}

module.exports = {
  createStatusItemRegistry,
};

  },
  "./settings-page-coordinator.js": function(module, exports, require) {
'use strict';

/**
 * Vendor-neutral Unified Settings Page Coordinator for Tier-1 `ui.registerSettingsPage` (v3.0.0 — SOLID #0).
 *
 * - Bridges both Desktop Settings sidebar tabs (`settingsTabs`) AND Remote Web Drawer settings tabs
 *   through a single declarative API.
 * - Supports either a Tier-2 declarative JSON `schema` (with `state`, `onChange`, `onAction`)
 *   OR a Tier-3 Shadow-DOM `render(canvasRoot)` callback.
 * - Opens inside a host-managed modal/panel surface when triggered from Remote Web or Desktop
 *   without requiring plugins to query or mutate host Settings DOM directly.
 */

function createSettingsPageCoordinator({ settingsTabs = null, openTier2Modal = null, openTier3Modal = null } = {}) {
  const pagesByKey = new Map(); // `${pluginId}:${pageId}` -> record
  const changeListeners = new Set();

  function notifyChange() {
    for (const fn of Array.from(changeListeners)) {
      try {
        fn();
      } catch (_e) {}
    }
  }

  function registerSettingsPage(pluginMeta, spec = {}) {
    if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string' || !spec.id.trim()) {
      throw new Error('ERR_INVALID_SETTINGS_PAGE_ID');
    }
    const pageId = spec.id.trim();
    const key = `${pluginMeta.pluginId}:${pageId}`;
    const title = String(spec.title || spec.label || pageId);
    const hasSchema = Boolean((spec.schema && typeof spec.schema === 'object') || typeof spec.getSchema === 'function');
    const hasRender = typeof spec.render === 'function';
    if (!hasSchema && !hasRender) {
      throw new Error('ERR_SETTINGS_PAGE_REQUIRES_SCHEMA_OR_RENDER');
    }

    let activeModalHandle = null;
    const openPage = () => {
      if (activeModalHandle && typeof activeModalHandle.close === 'function') {
        try {
          activeModalHandle.close();
        } catch (_e) {}
        activeModalHandle = null;
      }
      if (hasSchema && typeof openTier2Modal === 'function') {
        activeModalHandle = openTier2Modal(pluginMeta, {
          title,
          placement: { zone: 'surface-center', width: spec.width || 560 },
          tree: typeof spec.getSchema === 'function' ? spec.getSchema() : spec.schema,
          state: typeof spec.getState === 'function' ? spec.getState() : spec.state || {},
          onChange: spec.onChange || null,
          onAction: spec.onAction || null,
          onClose: () => {
            activeModalHandle = null;
            if (typeof spec.onClose === 'function') spec.onClose();
          },
        });
        return activeModalHandle;
      }
      if (hasRender && typeof openTier3Modal === 'function') {
        activeModalHandle = openTier3Modal(pluginMeta, {
          title,
          placement: { zone: 'surface-center', width: spec.width || 560 },
          onClose: () => {
            activeModalHandle = null;
            if (typeof spec.onClose === 'function') spec.onClose();
          },
        });
        if (activeModalHandle && activeModalHandle.bodyEl) {
          spec.render(activeModalHandle.bodyEl, activeModalHandle);
        }
        return activeModalHandle;
      }
      return null;
    };

    let tabHandle = null;
    if (settingsTabs && typeof settingsTabs.registerSettingsTab === 'function') {
      tabHandle = settingsTabs.registerSettingsTab(pluginMeta.pluginId, pageId, {
        label: title,
        onSelect: () => openPage(),
      });
    }

    const record = {
      key,
      pluginId: pluginMeta.pluginId,
      id: pageId,
      title,
      order: Number.isFinite(Number(spec.order)) ? Number(spec.order) : 100,
      kind: hasSchema ? 'schema' : 'canvas',
      openPage,
      tabHandle,
    };
    pagesByKey.set(key, record);
    notifyChange();

    return Object.freeze({
      id: pageId,
      open: openPage,
      update(nextSchema, nextState) {
        if (nextSchema && typeof nextSchema === 'object') spec.schema = nextSchema;
        if (nextState && typeof nextState === 'object') spec.state = nextState;
        if (activeModalHandle && typeof activeModalHandle.update === 'function') {
          activeModalHandle.update(nextSchema || spec.schema, nextState);
        }
      },
      dispose() {
        if (activeModalHandle && typeof activeModalHandle.close === 'function') {
          try {
            activeModalHandle.close();
          } catch (_e) {}
          activeModalHandle = null;
        }
        if (tabHandle && typeof tabHandle.unregister === 'function') {
          try {
            tabHandle.unregister();
          } catch (_e) {}
        }
        const deleted = pagesByKey.delete(key);
        if (deleted) notifyChange();
      },
    });
  }

  function listSettingsPages() {
    return Array.from(pagesByKey.values())
      .sort((a, b) => (a.order !== b.order ? a.order - b.order : a.key < b.key ? -1 : 1))
      .map((r) =>
        Object.freeze({
          pluginId: r.pluginId,
          id: r.id,
          title: r.title,
          order: r.order,
          kind: r.kind,
        })
      );
  }

  function openSettingsPage(pluginId, pageId) {
    const rec = pagesByKey.get(`${pluginId}:${pageId}`);
    if (!rec) return { ok: false, reason: 'ERR_SETTINGS_PAGE_NOT_FOUND' };
    const handle = rec.openPage();
    return { ok: true, handle };
  }

  function disposePlugin(pluginId) {
    let removed = false;
    for (const [key, rec] of Array.from(pagesByKey.entries())) {
      if (rec.pluginId !== pluginId) continue;
      if (rec.tabHandle && typeof rec.tabHandle.unregister === 'function') {
        try {
          rec.tabHandle.unregister();
        } catch (_e) {}
      }
      if (pagesByKey.delete(key)) removed = true;
    }
    if (removed) notifyChange();
  }

  function onChange(listener) {
    if (typeof listener !== 'function') return () => {};
    changeListeners.add(listener);
    return () => {
      changeListeners.delete(listener);
    };
  }

  return Object.freeze({
    registerSettingsPage,
    listSettingsPages,
    openSettingsPage,
    disposePlugin,
    onChange,
  });
}

module.exports = {
  createSettingsPageCoordinator,
};

  },
  "./context-v3.js": function(module, exports, require) {
'use strict';

/**
 * Clean-Slate ISP-Segregated AddonContextV3 Builder (v3.0.0 — SOLID #0).
 *
 * Always-on namespaces:
 *   `apiVersion: 3`, `meta`, `env` (abstract surface & capabilities — NO raw `hostProfileId`),
 *   `theme`, `i18n`, `ui` (Tier 1 + Tier 2 + Tier 3), `storage`, `events`, `services`, `lifecycle` (`AbortSignal`)
 *
 * Capability-gated namespaces (strictly omitted / `undefined` when undeclared, unapproved, or unsupported):
 *   `net?`, `dom?`, `configBridge?`, `settingsBridge?`
 */

const { buildOverlayChrome, createSchemaUiController } = require('./ui-schema-renderer');
const { validateSafeCssText } = require('./style-manager');

const _ObjectCreate = Object.create;
const _ObjectDefineProperty = Object.defineProperty;
const _ObjectFreeze = Object.freeze;
const _ObjectHasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
const _ReflectApply = Reflect.apply;
const _ArrayIsArray = Array.isArray;
const _Set = Set;
const _SetAdd = Function.prototype.call.bind(Set.prototype.add);
const _SetDelete = Function.prototype.call.bind(Set.prototype.delete);
const _SetClear = Function.prototype.call.bind(Set.prototype.clear);
const _SetForEach = Function.prototype.call.bind(Set.prototype.forEach);

// BLK-02: Null-prototype descriptor avoids both Object.prototype.<prop> setter theft
// AND Object.prototype.get/set descriptor collision throws in shared World 998.
function defineSafeReadOnlyProp(target, key, value) {
  const desc = _ObjectCreate(null);
  desc.value = value;
  desc.enumerable = true;
  desc.writable = false;
  desc.configurable = false;
  _ObjectDefineProperty(target, key, desc);
}

function defineSafeDataProp(target, key, value) {
  const desc = _ObjectCreate(null);
  desc.value = value;
  desc.enumerable = true;
  desc.writable = true;
  desc.configurable = true;
  _ObjectDefineProperty(target, key, desc);
}

function pushSafe(arr, value) {
  defineSafeDataProp(arr, arr.length, value);
}

function getOwn(obj, key) {
  if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return undefined;
  return _ObjectHasOwn(obj, key) ? obj[key] : undefined;
}

// NB-01 / R4-NB-02: Module-scoped LIFO stack for v3 overlays with prototype-safe mutations.
const v3EscapeStack = [];
let v3OverlaySeq = 0;

function removeFromEscapeStack(fn) {
  let idx = -1;
  for (let i = 0; i < v3EscapeStack.length; i += 1) {
    if (v3EscapeStack[i] === fn) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return;
  for (let i = idx; i < v3EscapeStack.length - 1; i += 1) {
    defineSafeDataProp(v3EscapeStack, i, v3EscapeStack[i + 1]);
  }
  v3EscapeStack.length -= 1;
}

function detectLayoutMode(win) {
  const w = win && Number.isFinite(Number(win.innerWidth)) ? Number(win.innerWidth) : 1280;
  if (w > 0 && w <= 640) return 'mobile';
  if (w > 0 && w <= 1024) return 'compact';
  return 'desktop';
}

function createAddonContextV3({
  doc,
  win,
  pluginMeta,
  surface = 'desktop',
  hostBridge = null,
  extraNoTranslateAttributes = [],
  styleManager,
  slotManager,
  surfaceGeometry,
  placementEngine,
  modalPortal,
  regionObserver,
  themeAndI18n,
  toastManager,
  statusItemRegistry,
  settingsPageCoordinator,
  serviceBus,
  eventBus,
  storageV3,
  registerCommand,
  listCommands,
  invokeCommand,
  isElementInsideIgnored,
  readConfigScope,
  writeConfigScope,
  hasConfigBridge,
  frozenConfigScopes,
  hasSettingsBridge,
  getSettings,
  onSettingsChange,
  saveSettings,
  assertActive,
  addDisposer,
  disposeSelf,
  runSafe,
  addManagedListener,
}) {
  // R4-NB-02: Use own-property lookups so inherited Object.prototype.net/dom/trustLevel cannot expose undeclared capabilities.
  const pluginId = getOwn(pluginMeta, 'pluginId');
  const displayName = getOwn(pluginMeta, 'displayName') || pluginId;
  const effectiveTrustLevel = getOwn(pluginMeta, 'trustLevel') || 'restricted';
  const rawPerms = getOwn(pluginMeta, 'permissions');
  const perms = rawPerms && typeof rawPerms === 'object' ? rawPerms : null;
  const rawNet = getOwn(perms, 'net');
  const netPerm = rawNet && typeof rawNet === 'object' ? rawNet : null;
  const rawDom = getOwn(perms, 'dom');
  const domPerm = rawDom && typeof rawDom === 'object' ? rawDom : null;

  const netHttpsHosts = getOwn(netPerm, 'httpsHosts');
  const netLocalLoopback = getOwn(netPerm, 'localLoopback');
  const netUserApprovedHttps = getOwn(netPerm, 'userApprovedHttps') === true;
  const domAnchors = getOwn(domPerm, 'anchors');
  const uiSlots = getOwn(pluginMeta, 'uiSlots');

  const hasNetHttps = !!(
    (_ArrayIsArray(netHttpsHosts) && netHttpsHosts.length > 0) ||
      (surface === 'remote-web' && netUserApprovedHttps)
  );
  const hasLocalLoopback = !!(
    surface === 'desktop' &&
      effectiveTrustLevel === 'trusted' &&
      _ArrayIsArray(netLocalLoopback) &&
      netLocalLoopback.length > 0
  );
  const hasNetCapability = !!(
    (hasNetHttps || hasLocalLoopback) && hostBridge && typeof hostBridge.netFetch === 'function'
  );
  const hasDocumentTransform = !!(
    effectiveTrustLevel === 'trusted' &&
      (getOwn(pluginMeta, 'hasDocumentTransformSlot') || getOwn(domPerm, 'documentTransform') === true)
  );
  const hasDomCapability = !!(
    hasDocumentTransform ||
      (_ArrayIsArray(domAnchors) && domAnchors.length > 0) ||
      (_ArrayIsArray(uiSlots) && uiSlots.length > 0)
  );

  // Lifecycle AbortController
  const abortController = typeof AbortController === 'function' ? new AbortController() : null;
  if (abortController) {
    addDisposer(() => {
      try {
        abortController.abort();
      } catch (_e) {}
    });
  }

  // Helper to mount a Tier-2 or Tier-3 overlay using Top Layer + PlacementEngine + non-removable attribution
  const activeOverlays = new _Set();
  addDisposer(() => {
    const closers = [];
    _SetForEach(activeOverlays, (fn) => {
      pushSafe(closers, fn);
    });
    for (let i = 0; i < closers.length; i += 1) {
      try {
        closers[i]();
      } catch (_e) {}
    }
    _SetClear(activeOverlays);
  });

  function openPositionedOverlay(kind, opts = {}) {
    assertActive();
    const isModal = kind === 'modal';
    const prevFocus = doc && doc.activeElement ? doc.activeElement : null;
    const el = doc.createElement(isModal ? 'dialog' : 'div');
    if (isModal) {
      el.setAttribute('data-addon-host-modal-dialog', '1');
      el.setAttribute('aria-modal', 'true');
    } else {
      el.setAttribute('popover', 'manual');
      el.setAttribute('data-addon-host-popover', '1');
    }
    el.setAttribute('data-addon-host-v3-overlay', kind);
    el.setAttribute('data-addon-host-owner', pluginId);
    el.setAttribute('role', 'dialog');
    el.setAttribute('translate', 'no');
    el.setAttribute('data-addon-host-no-translate', 'true');
    el.setAttribute('data-addon-host-ignore', 'true');
    for (let i = 0; i < extraNoTranslateAttributes.length; i += 1) {
      el.setAttribute(extraNoTranslateAttributes[i], 'true');
    }
    if (el.style) {
      el.style.padding = '0';
      el.style.border = 'none';
      el.style.background = 'transparent';
      el.style.overflow = 'visible';
      el.style.zIndex = String(2147483200 + activeOverlays.size + 1);
    }

    const shadowHost = isModal ? doc.createElement('div') : el;
    if (isModal) el.appendChild(shadowHost);
    const sr = typeof shadowHost.attachShadow === 'function' ? shadowHost.attachShadow({ mode: 'open' }) : shadowHost;

    let closed = false;
    let tracker = null;
    let outsideCleanup = null;
    let escCleanup = null;
    v3OverlaySeq += 1;
    const claimId = `v3:${pluginId}:${kind}:${v3OverlaySeq}`;
    const notifyPortalClaim = (active) => {
      if (hostBridge && typeof hostBridge.setPortalClaim === 'function') {
        try {
          hostBridge.setPortalClaim(claimId, active);
        } catch (_e) {}
      }
    };

    const close = () => {
      if (closed) return false;
      closed = true;
      _SetDelete(activeOverlays, close);
      removeFromEscapeStack(close);
      notifyPortalClaim(false);
      if (tracker) {
        tracker.dispose();
        tracker = null;
      }
      if (outsideCleanup) {
        outsideCleanup();
        outsideCleanup = null;
      }
      if (escCleanup) {
        escCleanup();
        escCleanup = null;
      }
      try {
        if (isModal && typeof el.close === 'function' && el.open) el.close();
        else if (!isModal && typeof el.hidePopover === 'function') el.hidePopover();
      } catch (_e) {}
      if (el.parentNode && typeof el.parentNode.removeChild === 'function') {
        el.parentNode.removeChild(el);
      }
      if (prevFocus && typeof prevFocus.focus === 'function') {
        try {
          prevFocus.focus();
        } catch (_e) {}
      }
      if (typeof opts.onClose === 'function') {
        try {
          opts.onClose();
        } catch (_e) {}
      }
      return true;
    };

    const tokenCss = themeAndI18n ? themeAndI18n.buildTokenCss(themeAndI18n.getSnapshot().mode) : '';
    const { body, badge } = buildOverlayChrome(doc, sr, {
      title: opts.title || '',
      displayName,
      tokenCss,
      closable: opts.closable !== false,
      onClose: close,
    });

    let schemaController = null;
    if (opts.tree && typeof opts.tree === 'object') {
      schemaController = createSchemaUiController(doc, body, {
        tree: opts.tree,
        state: opts.state || {},
        onChange: opts.onChange || null,
        onAction: opts.onAction || null,
      });
    }

    const parent = doc.body || doc.documentElement;
    if (parent && typeof parent.appendChild === 'function') {
      parent.appendChild(el);
    }

    if (isModal && typeof el.showModal === 'function') {
      try {
        el.showModal();
      } catch (_e) {}
    } else if (!isModal && typeof el.showPopover === 'function') {
      try {
        el.showPopover();
      } catch (_e) {}
    }

    const defaultZone = kind === 'panel' ? 'drawer' : kind === 'modal' ? 'surface-center' : 'anchor';
    const placementSpec = {
      zone: defaultZone,
      ...(opts.placement && typeof opts.placement === 'object' ? opts.placement : {}),
    };
    tracker = placementEngine.trackElementPlacement(el, placementSpec);

    if (isModal && typeof el.addEventListener === 'function') {
      el.addEventListener('cancel', (ev) => {
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
        close();
      });
    }

    if (!isModal && opts.closeOnOutsideClick !== false && doc && typeof doc.addEventListener === 'function') {
      const onPointerDown = (ev) => {
        if (closed) return;
        const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [ev.target];
        if (path.includes(el)) return;
        const anchor = placementSpec.anchorEl;
        if (anchor && (path.includes(anchor) || (typeof anchor.contains === 'function' && anchor.contains(ev.target)))) {
          return;
        }
        close();
      };
      doc.addEventListener('pointerdown', onPointerDown, true);
      outsideCleanup = () => doc.removeEventListener('pointerdown', onPointerDown, true);
    }

    if (win && typeof win.addEventListener === 'function') {
      const onKeyDown = (ev) => {
        if (closed || !ev || ev.key !== 'Escape') return;
        if (v3EscapeStack.length > 0 && v3EscapeStack[v3EscapeStack.length - 1] !== close) return;
        if (ev.isComposing || ev.keyCode === 229 || ev.defaultPrevented) return;
        if (ev.isTrusted === false) return;
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
        close();
      };
      win.addEventListener('keydown', onKeyDown, true);
      escCleanup = () => win.removeEventListener('keydown', onKeyDown, true);
    }

    pushSafe(v3EscapeStack, close);
    notifyPortalClaim(true);
    _SetAdd(activeOverlays, close);

    return _ObjectFreeze({
      kind,
      element: el,
      bodyEl: opts.tree ? null : body, // Tier-2 schema overlays keep DOM host-owned; Tier-3 canvas overlays expose bodyEl
      attributionBadge: badge,
      getPlacement: () => (tracker ? tracker.reposition() : null),
      reposition: () => (tracker ? tracker.reposition() : null),
      update(nextTree, nextState) {
        if (!schemaController) {
          throw new Error('ERR_OVERLAY_NOT_SCHEMA_DRIVEN');
        }
        schemaController.update(nextTree, nextState);
        if (tracker) tracker.reposition();
      },
      getState: () => (schemaController ? schemaController.getState() : null),
      getElementById: (nodeId) => (schemaController ? schemaController.getElementById(nodeId) : null),
      close,
    });
  }

  function createStyleElementSafe(cssText) {
    assertActive();
    const check = validateSafeCssText(cssText, { scope: 'owner' });
    if (!check.ok) {
      throw new Error(check.reason || 'ERR_UNSAFE_CSS_CONSTRUCT');
    }
    const styleEl = doc.createElement('style');
    styleEl.setAttribute('data-addon-host-owner', pluginId);
    styleEl.textContent = String(cssText);
    return styleEl;
  }

  function mountCanvas(slotId, opts = {}) {
    assertActive();
    const canvasOpts = { ...opts, shadow: true };
    const slotHandle = slotManager.mountSlot(pluginMeta, slotId, canvasOpts);
    const targetRoot =
      (slotHandle && slotHandle.shadowRoot) ||
      (slotHandle && typeof slotHandle.getRootNode === 'function' ? slotHandle.getRootNode() : null);
    if (targetRoot && targetRoot !== doc && themeAndI18n) {
      const tokenStyle = doc.createElement('style');
      tokenStyle.setAttribute('data-addon-host-tokens', '1');
      tokenStyle.textContent = themeAndI18n.buildTokenCss(themeAndI18n.getSnapshot().mode);
      if (typeof targetRoot.insertBefore === 'function' && targetRoot.firstChild) {
        targetRoot.insertBefore(tokenStyle, targetRoot.firstChild);
      } else if (typeof targetRoot.appendChild === 'function') {
        targetRoot.appendChild(tokenStyle);
      }
    }
    return slotHandle;
  }

  const meta = _ObjectFreeze({
    pluginId,
    displayName,
    version: getOwn(pluginMeta, 'version') || '0.0.0',
    trustLevel: effectiveTrustLevel,
    sourceSchemaVersion: getOwn(pluginMeta, 'sourceSchemaVersion') || 3,
  });

  // ISP + SOLID #0: Expose ONLY abstract capabilities and surface — NEVER raw hostProfileId
  const env = _ObjectFreeze({
    surface: surface === 'remote-web' ? 'remote-web' : 'desktop',
    get layoutMode() {
      return detectLayoutMode(win);
    },
    capabilities: _ObjectFreeze({
      hasLocalLoopback,
      hasNetHttps,
      hasConfigBridge: !!hasConfigBridge,
      hasSettingsBridge: !!hasSettingsBridge,
      hasDocumentTransform,
    }),
  });

  const ui = _ObjectFreeze({
    // Tier 1: Zero-DOM Semantic Host Surfaces
    showToast(opts) {
      assertActive();
      return toastManager.showToast(pluginMeta, opts);
    },
    confirm(opts) {
      assertActive();
      return toastManager.confirm(pluginMeta, opts);
    },
    prompt(opts) {
      assertActive();
      return toastManager.prompt(pluginMeta, opts);
    },
    registerCommand(commandId, spec) {
      assertActive();
      return registerCommand(commandId, spec);
    },
    listCommands() {
      assertActive();
      return listCommands();
    },
    invokeCommand() {
      assertActive();
      return _ReflectApply(invokeCommand, undefined, arguments);
    },
    registerStatusItem(spec) {
      assertActive();
      const handle = statusItemRegistry.registerStatusItem(pluginId, spec);
      addDisposer(() => handle.dispose());
      return handle;
    },
    registerSettingsPage(spec) {
      assertActive();
      const handle = settingsPageCoordinator.registerSettingsPage(pluginMeta, spec);
      addDisposer(() => handle.dispose());
      return handle;
    },

    // Tier 2: Host-Positioned Overlays + Typed Declarative Schema
    openPopup(opts) {
      return openPositionedOverlay('popup', opts);
    },
    openModal(opts) {
      return openPositionedOverlay('modal', opts);
    },
    openPanel(opts) {
      return openPositionedOverlay('panel', opts);
    },

    // Tier 3: Controlled Escape Hatch
    mountCanvas,
    createStyleElementSafe,
    injectStyle(styleId, cssText, opts) {
      assertActive();
      return styleManager.injectStyle(pluginMeta, styleId, cssText, opts);
    },
    removeStyle(styleId) {
      assertActive();
      return styleManager.removeStyle(pluginId, styleId);
    },
    getSurfaceBounds(surfaceIdOrOpts) {
      assertActive();
      return surfaceGeometry.getSurfaceBounds(surfaceIdOrOpts);
    },
    getActiveSurface() {
      assertActive();
      return surfaceGeometry.getActiveSurface();
    },
    listSurfaces() {
      assertActive();
      return surfaceGeometry.listSurfaces();
    },
  });

  const rawStoragePerm = getOwn(perms, 'storage');
  const storagePerm = rawStoragePerm && typeof rawStoragePerm === 'object' ? rawStoragePerm : null;
  const isolationMeta = getOwn(pluginMeta, 'isolation');
  const storage = storageV3.createPluginStorage(pluginId, {
    namespace:
      getOwn(storagePerm, 'namespace') ||
      getOwn(isolationMeta, 'storageNamespace') ||
      pluginId,
    maxBytes: getOwn(storagePerm, 'maxBytes') || 65536,
    assertActive,
    registerDisposer: addDisposer,
  });

  const events = _ObjectFreeze({
    on(topic, handler) {
      assertActive();
      const unsub = eventBus.on(pluginId, topic, handler);
      addDisposer(unsub);
      return unsub;
    },
    once(topic, handler) {
      assertActive();
      const unsub = eventBus.once(pluginId, topic, handler);
      addDisposer(unsub);
      return unsub;
    },
    emit(topic, payload) {
      assertActive();
      return eventBus.emit(pluginId, topic, payload);
    },
  });

  const services = _ObjectFreeze({
    provide(serviceName, impl, opts) {
      assertActive();
      const handle = serviceBus.provide(pluginMeta, serviceName, impl, opts);
      addDisposer(() => handle.dispose());
      return handle;
    },
    has(serviceName) {
      assertActive();
      return serviceBus.has(pluginId, serviceName);
    },
    list() {
      assertActive();
      return serviceBus.list(pluginId);
    },
    // R3-BLK-01: Avoid `...args` spread (which invokes Array.prototype[Symbol.iterator]) and element assignment setters.
    call() {
      assertActive();
      const callArgs = [];
      defineSafeDataProp(callArgs, 0, pluginId);
      for (let i = 0; i < arguments.length; i += 1) {
        defineSafeDataProp(callArgs, i + 1, arguments[i]);
      }
      return _ReflectApply(serviceBus.call, undefined, callArgs);
    },
  });

  const lifecycle = _ObjectFreeze({
    signal: abortController ? abortController.signal : null,
    onDispose(fn) {
      assertActive();
      addDisposer(fn);
    },
    addManagedListener,
    runSafe,
    dispose: disposeSelf,
  });

  const ctx = {};
  defineSafeReadOnlyProp(ctx, 'apiVersion', 3);
  defineSafeReadOnlyProp(ctx, 'meta', meta);
  defineSafeReadOnlyProp(ctx, 'env', env);
  defineSafeReadOnlyProp(ctx, 'theme', themeAndI18n.createThemeHandle(addDisposer));
  defineSafeReadOnlyProp(ctx, 'i18n', themeAndI18n.createI18nHandle());
  defineSafeReadOnlyProp(ctx, 'ui', ui);
  defineSafeReadOnlyProp(ctx, 'storage', storage);
  defineSafeReadOnlyProp(ctx, 'events', events);
  defineSafeReadOnlyProp(ctx, 'services', services);
  defineSafeReadOnlyProp(ctx, 'lifecycle', lifecycle);

  // Capability-gated namespaces: strictly omitted when not declared/permitted/supported.
  // BLK-02: defineSafeReadOnlyProp uses a null-prototype descriptor so neither
  // Object.prototype.<prop> setters nor Object.prototype.get/set can hijack or crash World 998.
  if (hasNetCapability) {
    defineSafeReadOnlyProp(
      ctx,
      'net',
      _ObjectFreeze({
        fetch(url, init = {}) {
          assertActive();
          return hostBridge.netFetch(pluginId, url, init);
        },
      })
    );
  }

  if (hasDomCapability) {
    defineSafeReadOnlyProp(
      ctx,
      'dom',
      _ObjectFreeze({
        observeRegion(selector, callback, opts) {
          assertActive();
          return regionObserver.observeRegion(pluginId, selector, callback, opts);
        },
        isElementInsideIgnored(nodeOrEvent, opts) {
          return isElementInsideIgnored(nodeOrEvent, opts);
        },
        mountSlot(slotId, opts) {
          assertActive();
          return slotManager.mountSlot(pluginMeta, slotId, opts);
        },
        unmountSlot(slotId) {
          assertActive();
          return slotManager.unmountSlot(pluginId, slotId);
        },
      })
    );
  }

  if (hasConfigBridge) {
    defineSafeReadOnlyProp(
      ctx,
      'configBridge',
      _ObjectFreeze({
        scopes: frozenConfigScopes,
        read(scopeId) {
          assertActive();
          return readConfigScope(scopeId);
        },
        write(scopeId, nextDataOrRawJson, opts) {
          assertActive();
          return writeConfigScope(scopeId, nextDataOrRawJson, opts);
        },
      })
    );
  }

  if (
    hasSettingsBridge &&
    typeof getSettings === 'function' &&
    typeof onSettingsChange === 'function' &&
    typeof saveSettings === 'function'
  ) {
    const readSnap = () => {
      assertActive();
      return getSettings();
    };
    const subscribeSnap = (callback) => {
      assertActive();
      return onSettingsChange(callback);
    };
    const persistSnap = (nextData) => {
      assertActive();
      return saveSettings(nextData);
    };
    defineSafeReadOnlyProp(
      ctx,
      'settingsBridge',
      _ObjectFreeze({
        getSettings: readSnap,
        getSnapshot: readSnap,
        onSettingsChange: subscribeSnap,
        onDidChange: subscribeSnap,
        saveSettings: persistSnap,
        save: persistSnap,
      })
    );
  }

  return _ObjectFreeze(ctx);
}

module.exports = {
  createAddonContextV3,
};

  },
  "./v2-compat-adapter.js": function(module, exports, require) {
'use strict';

/**
 * 1-Major Backward-Compatibility Adapter (`createV2CompatAdapter(v3, legacy)`) — v3.0.0.
 *
 * Preserves 100% of the v2.x flat 21-method `addonHost` API contract for existing
 * AddonManifest v1/v2 plugins throughout `v3.x` (planned removal: `v4.0.0`), while
 * delegating shared primitives directly to `AddonContextV3`.
 */

const _ObjectFreeze = Object.freeze;
const _ReflectApply = Reflect.apply;

function createV2CompatAdapter(v3Context, legacy = {}) {
  const {
    hostProfileId = null,
    hasSettingsBridge = false,
    hasConfigBridge = false,
    configScopes = _ObjectFreeze([]),
    mountSlot,
    unmountSlot,
    openModal,
    openPopover,
    observeRegion,
    registerSettingsTab,
    isElementInsideIgnored,
    getSettings,
    onSettingsChange,
    saveSettings,
    readConfigScope,
    writeConfigScope,
  } = legacy;

  return _ObjectFreeze({
    pluginId: v3Context.meta.pluginId,
    version: v3Context.meta.version,
    trustLevel: v3Context.meta.trustLevel,
    hostProfileId,
    schemaVersion: 2,
    sourceSchemaVersion: v3Context.meta.sourceSchemaVersion,
    hasSettingsBridge,
    hasConfigBridge,
    configScopes,
    // Opt-in bridge allowing v2 plugins to adopt v3 APIs incrementally during migration
    v3: v3Context,

    mountSlot(slotId, opts) {
      return mountSlot(slotId, opts);
    },
    unmountSlot(slotId) {
      return unmountSlot(slotId);
    },
    injectStyle(styleId, cssText, opts) {
      return v3Context.ui.injectStyle(styleId, cssText, opts);
    },
    removeStyle(styleId) {
      return v3Context.ui.removeStyle(styleId);
    },
    openModal(slotId, opts) {
      return openModal(slotId, opts);
    },
    openPopover(slotId, opts) {
      return openPopover(slotId, opts);
    },
    getSurfaceBounds(surfaceIdOrOpts) {
      return v3Context.ui.getSurfaceBounds(surfaceIdOrOpts);
    },
    getActiveSurface() {
      return v3Context.ui.getActiveSurface();
    },
    listSurfaces() {
      return v3Context.ui.listSurfaces();
    },
    observeRegion(selector, callback, opts) {
      return observeRegion(selector, callback, opts);
    },
    registerSettingsTab(tabId, opts) {
      return registerSettingsTab(tabId, opts);
    },
    registerAction(actionId, spec) {
      return v3Context.ui.registerCommand(actionId, spec);
    },
    listActions() {
      return v3Context.ui.listCommands();
    },
    invokeAction() {
      return _ReflectApply(v3Context.ui.invokeCommand, v3Context.ui, arguments);
    },
    isElementInsideIgnored(nodeOrEvent, opts) {
      return isElementInsideIgnored(nodeOrEvent, opts);
    },
    getSettings() {
      return getSettings();
    },
    onSettingsChange(callback) {
      return onSettingsChange(callback);
    },
    saveSettings(nextData) {
      return saveSettings(nextData);
    },
    readConfigScope(scopeId) {
      return readConfigScope(scopeId);
    },
    writeConfigScope(scopeId, nextDataOrRawJson, opts) {
      return writeConfigScope(scopeId, nextDataOrRawJson, opts);
    },
    addManagedListener(target, type, listener, opts) {
      return v3Context.lifecycle.addManagedListener(target, type, listener, opts);
    },
    runSafe(fn) {
      return v3Context.lifecycle.runSafe(fn);
    },
    onDispose(fn) {
      return v3Context.lifecycle.onDispose(fn);
    },
    dispose() {
      return v3Context.lifecycle.dispose();
    },
  });
}

module.exports = {
  createV2CompatAdapter,
};

  },
  "./host-bridge-port.js": function(module, exports, require) {
'use strict';

/**
 * Renderer-side HostBridgePort contract (v2.3.0 — DIP / LSP / ISP).
 *
 * Unifies the transport boundary between the shared renderer `kernel.js` and
 * host-specific bridge implementations:
 * - Desktop Electron: `preload-bridge.js` (`window.__addonHostBootstrap.claim(nonce)`)
 * - Remote Web: `src/adapters/remote-web/*` (injected via `kernel.boot({ hostBridge })`
 *   or `window.__addonHostBootstrap.claim(nonce)`)
 *
 * Uses captured primordials to remain immune to shared-world prototype tampering (I4).
 */

const _Error = Error;
const _Number = Number;
const _ObjectFreeze = Object.freeze;
const _ReflectApply = Reflect.apply;

const HOST_BRIDGE_PORT_REQUIRED_METHODS = _ObjectFreeze([
  'setPortalClaim',
  'saveSettings',
  'reportError',
  'ping',
]);

const HOST_BRIDGE_PORT_OPTIONAL_METHODS = _ObjectFreeze([
  'readConfigScope',
  'writeConfigScope',
  'getHostAdminState',
  'setRemoteAddonPreference',
  'netFetch',
]);

function isValidHostBridgePort(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  for (let i = 0; i < HOST_BRIDGE_PORT_REQUIRED_METHODS.length; i += 1) {
    if (typeof candidate[HOST_BRIDGE_PORT_REQUIRED_METHODS[i]] !== 'function') {
      return false;
    }
  }
  return true;
}

function wrapHostBridgePort(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    throw new _Error('ERR_INVALID_HOST_BRIDGE_PORT');
  }
  for (let i = 0; i < HOST_BRIDGE_PORT_REQUIRED_METHODS.length; i += 1) {
    const name = HOST_BRIDGE_PORT_REQUIRED_METHODS[i];
    if (typeof candidate[name] !== 'function') {
      throw new _Error(`ERR_HOST_BRIDGE_PORT_MISSING_METHOD:${name}`);
    }
  }

  const docGenId = _Number(candidate.docGenId) || 0;
  const profileId = typeof candidate.profileId === 'string' && candidate.profileId ? candidate.profileId : null;
  const fnSetPortalClaim = candidate.setPortalClaim;
  const fnSaveSettings = candidate.saveSettings;
  const fnReportError = candidate.reportError;
  const fnPing = candidate.ping;
  const fnReadConfigScope = typeof candidate.readConfigScope === 'function' ? candidate.readConfigScope : null;
  const fnWriteConfigScope = typeof candidate.writeConfigScope === 'function' ? candidate.writeConfigScope : null;
  const fnGetHostAdminState = typeof candidate.getHostAdminState === 'function' ? candidate.getHostAdminState : null;
  const fnSetRemoteAddonPreference =
    typeof candidate.setRemoteAddonPreference === 'function' ? candidate.setRemoteAddonPreference : null;
  const fnNetFetch = typeof candidate.netFetch === 'function' ? candidate.netFetch : null;

  const wrapped = {
    docGenId,
    profileId,
    setPortalClaim(claimId, active) {
      return _ReflectApply(fnSetPortalClaim, candidate, [claimId, active]);
    },
    saveSettings(pluginId, rawJson) {
      return _ReflectApply(fnSaveSettings, candidate, [pluginId, rawJson]);
    },
    reportError(pluginId, detail) {
      return _ReflectApply(fnReportError, candidate, [pluginId, detail]);
    },
    ping() {
      return _ReflectApply(fnPing, candidate, []);
    },
  };

  if (fnReadConfigScope) {
    wrapped.readConfigScope = function readConfigScope(pluginId, scopeId) {
      return _ReflectApply(fnReadConfigScope, candidate, [pluginId, scopeId]);
    };
  }
  if (fnWriteConfigScope) {
    wrapped.writeConfigScope = function writeConfigScope(pluginId, scopeId, rawJson, opts) {
      return _ReflectApply(fnWriteConfigScope, candidate, [pluginId, scopeId, rawJson, opts]);
    };
  }
  if (fnGetHostAdminState) {
    wrapped.getHostAdminState = function getHostAdminState() {
      return _ReflectApply(fnGetHostAdminState, candidate, []);
    };
  }
  if (fnSetRemoteAddonPreference) {
    wrapped.setRemoteAddonPreference = function setRemoteAddonPreference(pluginId, enabled) {
      return _ReflectApply(fnSetRemoteAddonPreference, candidate, [pluginId, enabled]);
    };
  }
  if (fnNetFetch) {
    wrapped.netFetch = function netFetch(pluginId, url, init) {
      return _ReflectApply(fnNetFetch, candidate, [pluginId, url, init]);
    };
  }

  return _ObjectFreeze(wrapped);
}

module.exports = {
  HOST_BRIDGE_PORT_REQUIRED_METHODS,
  HOST_BRIDGE_PORT_OPTIONAL_METHODS,
  isValidHostBridgePort,
  wrapHostBridgePort,
};

  },
  "./host-settings-ui.js": function(module, exports, require) {
'use strict';

/**
 * Vendor-neutral Built-in Host Settings UI (`Addon Manager` / `애드온 관리`) — v2.5.0.
 *
 * - Runs strictly inside the privileged Renderer Kernel (World 998) using the claimed
 *   HostBridgePort admin methods (`getHostAdminState`, `setRemoteAddonPreference`).
 * - NEVER exposed on consumer plugin `addonHost` handles.
 * - Zero vendor literals (SOLID #0), zero HTML sinks (`innerHTML` / `outerHTML` /
 *   `insertAdjacentHTML` = 0), zero `eval` / `new Function`, Shadow DOM isolated.
 * - Coexists cleanly with native Settings tabs and peer plugin tabs (e.g. MCP Manager).
 */

const NAV_ATTR = 'data-addon-host-admin-nav';
const PLUGIN_NAV_ATTR = 'data-addon-host-plugin-settings-nav';
const PANE_ATTR = 'data-addon-host-admin-pane';
const IGNORE_ATTR = 'data-addon-host-ignore';
const NO_TRANSLATE_ATTR = 'data-addon-host-no-translate';
const LANG_STORAGE_KEY = 'addon-host:settings-ui-lang';

const DEFAULT_SETTINGS_UI_CONFIG = Object.freeze({
  navId: 'addon-manager',
  navLabel: Object.freeze({
    en: 'Addon Manager',
    ko: '애드온 관리',
  }),
  anchorGroups: Object.freeze([
    Object.freeze(['general', '일반']),
    Object.freeze(['application', '애플리케이션', '앱']),
    Object.freeze(['appearance', '모양 및 테마', '외관', '모양', '화면']),
    Object.freeze(['shortcuts', '단축키', '바로가기']),
    Object.freeze(['notifications', '알림']),
    Object.freeze(['models', '모델']),
    Object.freeze(['browser', '브라우저']),
    Object.freeze(['editor', '에디터']),
    Object.freeze(['account', '계정']),
  ]),
});

const COPY = Object.freeze({
  en: Object.freeze({
    title: 'Addon Manager',
    subtitle: 'Manage addons running on the native addon host and choose which ones appear on Remote Web.',
    refresh: 'Refresh',
    refreshing: 'Refreshing...',
    hostLabel: 'Host',
    buildLabel: 'Build',
    summaryDesktop: 'Running on Desktop',
    summaryDesktopSub: 'Registered',
    summaryRemote: 'Shown on Remote Web',
    summaryRemoteSub: 'Remote-compatible',
    summaryBundle: 'Remote Web Bundle',
    bundleUpToDate: 'Up to date',
    bundleNeedsRebuild: 'Rebuild needed',
    bundleNotBuilt: 'Not built yet',
    sectionAddons: 'Installed Native Host Addons',
    emptyTitle: 'No addons registered yet',
    emptyBody: 'Register an AddonManifest.v3 / v2 plugin with the host CLI to manage it here.',
    openSettings: 'Settings',
    sectionPluginPages: 'Plugin Settings Pages',
    statusActive: 'Running',
    statusDisabled: 'Disabled',
    statusRejected: 'Blocked',
    statusFailed: 'Failed',
    statusPending: 'Pending',
    trustApproved: 'Trusted',
    trustUnapproved: 'Approval required',
    trustRestricted: 'Restricted',
    capRenderer: 'Renderer',
    capMainHook: 'Main Hook',
    capSettings: 'Settings',
    capConfig: 'Config',
    remoteToggleLabel: 'Show on Remote Web',
    remoteToggleOn: 'Included',
    remoteToggleOff: 'Hidden',
    remoteReasonDesktopOnly: 'Desktop only',
    remoteReasonConfigBridge: 'Local config bridge only',
    remoteReasonDisabledConfig: 'Disabled in config',
    remoteReasonTrustRequired: 'Trust approval required',
    remoteReasonUnsupported: 'Not supported on Remote Web',
    remoteReasonUnconfigured: 'Remote Web unavailable',
    syncTitleUpToDate: 'Remote Web bundle is synchronized',
    syncTitleNeedsRebuild: 'Remote Web bundle needs rebuild',
    syncTitleNotBuilt: 'Remote Web bundle has not been built yet',
    syncDescUpToDate: 'Your Remote Web settings match the latest bundle. For zero-PC access from any network (LTE/5G/other devices), install each addon’s public HTTPS .user.js release, or copy this single .user.js file via cloud drive/messenger once.',
    syncDescNeedsRebuild: 'Visibility preferences are saved. Run the command below to rebuild the portable Remote Web Userscript, @require host library, and secondary extension.',
    syncDescNotBuilt: 'Run the command below to generate the portable Remote Web Userscript, @require host library, and secondary browser extension.',
    copyCommand: 'Copy command',
    copyServeCommand: 'Copy same-Wi-Fi QR command',
    copyExtensionPath: 'Copy extension path',
    copyUserscriptPath: 'Copy userscript path',
    copyBookmarklet: 'Copy bookmarklet',
    userscriptGuide: 'Universal setup (works anywhere): Install public HTTPS addon .user.js releases (auto-updating, multi-addon coexistence), OR transfer the built .user.js file once via cloud/messenger and import it in Userscripts (iOS/iPadOS Safari) or Violentmonkey/Tampermonkey (Android Firefox / Desktop). Once imported, no PC or LAN is needed. (Optional: same-Wi-Fi QR helper only works on the same local network with firewall open; desktop Chrome/Edge fallback: chrome://extensions.)',
    extensionGuide: 'Browser setup: Open chrome://extensions (Edge supported) -> Enable Developer mode -> Load unpacked -> select the copied folder path. After future rebuilds, click Reload on the extension card.',
    copied: 'Copied',
    copyFailed: 'Copy failed',
    loadError: 'Failed to load addon host status.',
    saveError: 'Failed to save Remote Web preference.',
    loading: 'Loading addon status...',
    remotePrefsSaved: 'Saved Remote Web preference.',
    langSwitchAria: 'Addon Manager language',
    langKo: '한국어',
    langEn: 'EN',
  }),
  ko: Object.freeze({
    title: '애드온 관리',
    subtitle: '네이티브 애드온 호스트에서 실행 중인 플러그인 현황과 원격 웹(Remote Web) 표시 여부를 관리합니다.',
    refresh: '새로고침',
    refreshing: '불러오는 중...',
    hostLabel: '호스트',
    buildLabel: '빌드',
    summaryDesktop: '데스크톱 실행 중',
    summaryDesktopSub: '전체 등록',
    summaryRemote: '원격 웹 표시',
    summaryRemoteSub: '원격 지원',
    summaryBundle: '원격 웹 번들',
    bundleUpToDate: '최신 상태',
    bundleNeedsRebuild: '재빌드 필요',
    bundleNotBuilt: '미빌드',
    sectionAddons: '네이티브 호스트 애드온 목록',
    emptyTitle: '등록된 애드온이 없습니다',
    emptyBody: '호스트 CLI로 AddonManifest.v3 / v2 플러그인을 등록하면 이 화면에서 관리할 수 있습니다.',
    openSettings: '설정',
    sectionPluginPages: '플러그인 설정 페이지',
    statusActive: '실행 중',
    statusDisabled: '비활성',
    statusRejected: '차단됨',
    statusFailed: '오류',
    statusPending: '대기 중',
    trustApproved: '신뢰 승인됨',
    trustUnapproved: '승인 필요',
    trustRestricted: '제한 모드',
    capRenderer: '렌더러 UI',
    capMainHook: '메인 훅',
    capSettings: '설정 브리지',
    capConfig: '구성 브리지',
    remoteToggleLabel: '원격 웹 표시',
    remoteToggleOn: '표시함',
    remoteToggleOff: '숨김',
    remoteReasonDesktopOnly: '데스크톱 전용',
    remoteReasonConfigBridge: '로컬 설정 브리지 전용',
    remoteReasonDisabledConfig: '앱 설정에서 꺼짐',
    remoteReasonTrustRequired: '신뢰 승인 필요',
    remoteReasonUnsupported: '원격 웹 미지원',
    remoteReasonUnconfigured: '원격 프로필 미구성',
    syncTitleUpToDate: '원격 웹 번들이 최신 상태입니다',
    syncTitleNeedsRebuild: '원격 웹 번들 재빌드가 필요합니다',
    syncTitleNotBuilt: '원격 웹 번들이 아직 생성되지 않았습니다',
    syncDescUpToDate: '현재 선택한 원격 웹 표시 설정이 최신 번들과 일치합니다. 외부 네트워크(LTE/5G·타 기기)에서 PC 없이 쓰려면 각 애드온의 공개 HTTPS .user.js 릴리스를 1클릭 설치하거나, 빌드된 .user.js 파일 1개를 클라우드·메신저로 옮겨 한 번만 가져오세요.',
    syncDescNeedsRebuild: '변경된 원격 웹 표시 설정은 즉시 저장되었습니다. 아래 명령으로 휴대용 Remote Web Userscript, @require 호스트 라이브러리 및 보조 확장을 재빌드하세요.',
    syncDescNotBuilt: '아래 명령을 실행하면 선택한 애드온이 포함된 휴대용 Remote Web Userscript, @require 호스트 라이브러리 및 보조 브라우저 확장을 생성합니다.',
    copyCommand: '명령 복사',
    copyServeCommand: '같은 Wi-Fi QR 복사 명령',
    copyExtensionPath: '확장 경로 복사',
    copyUserscriptPath: 'Userscript 경로 복사',
    copyBookmarklet: '북마클릿 복사',
    userscriptGuide: '범용 설치(어디서나 동작): 공개 HTTPS 애드온 .user.js(다중 애드온 자동 공존·자동 업데이트)를 설치하거나, 빌드된 .user.js 파일 1개를 클라우드/메신저로 옮겨 iOS Safari(Userscripts)·Android Firefox/데스크톱(Violentmonkey/Tampermonkey)에 한 번만 가져오세요. 설치 후에는 PC나 사설 IP가 필요 없습니다. (보조: 같은 Wi-Fi QR 명령은 동일 네트워크·방화벽 개방 시에만 동작 / 데스크톱 Chrome·Edge: chrome://extensions.)',
    extensionGuide: '브라우저 적용: chrome://extensions 열기(Edge 동일) → 개발자 모드 켜기 → 압축해제된 확장 프로그램 로드 → 복사한 확장 폴더 선택. 재빌드 후에는 확장 카드의 새로고침(↻)만 누르면 됩니다.',
    copied: '복사됨',
    copyFailed: '복사 실패',
    loadError: '애드온 호스트 상태를 불러오지 못했습니다.',
    saveError: '원격 웹 표시 설정 저장에 실패했습니다.',
    loading: '애드온 상태를 불러오는 중...',
    remotePrefsSaved: '원격 웹 표시 설정을 저장했습니다.',
    langSwitchAria: '애드온 관리 언어',
    langKo: '한국어',
    langEn: 'EN',
  }),
});

const PANEL_CSS = `
:host {
  display: block;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", sans-serif;
  color: #f1f5f9;
  --surface-bg: transparent;
  --card-bg: rgba(255, 255, 255, 0.035);
  --card-bg-hover: rgba(255, 255, 255, 0.055);
  --card-border: rgba(255, 255, 255, 0.09);
  --text-primary: #f1f5f9;
  --text-secondary: #94a3b8;
  --text-muted: #64748b;
  --accent: #38bdf8;
  --accent-strong: #0284c7;
  --ok-bg: rgba(34, 197, 94, 0.14);
  --ok-fg: #4ade80;
  --ok-border: rgba(34, 197, 94, 0.3);
  --warn-bg: rgba(245, 158, 11, 0.14);
  --warn-fg: #fbbf24;
  --warn-border: rgba(245, 158, 11, 0.32);
  --err-bg: rgba(239, 68, 68, 0.14);
  --err-fg: #f87171;
  --err-border: rgba(239, 68, 68, 0.3);
  --chip-bg: rgba(148, 163, 184, 0.12);
  --chip-fg: #cbd5e1;
  --switch-off: rgba(148, 163, 184, 0.28);
  --switch-on: #22c55e;
  --focus-ring: #38bdf8;
}

@media (prefers-color-scheme: light) {
  :host([data-theme="light"]) {
    color: #0f172a;
    --card-bg: rgba(15, 23, 42, 0.03);
    --card-bg-hover: rgba(15, 23, 42, 0.055);
    --card-border: rgba(15, 23, 42, 0.12);
    --text-primary: #0f172a;
    --text-secondary: #475569;
    --text-muted: #64748b;
    --ok-bg: rgba(22, 163, 74, 0.12);
    --ok-fg: #15803d;
    --ok-border: rgba(22, 163, 74, 0.28);
    --warn-bg: rgba(217, 119, 6, 0.12);
    --warn-fg: #b45309;
    --warn-border: rgba(217, 119, 6, 0.3);
    --err-bg: rgba(220, 38, 38, 0.12);
    --err-fg: #b91c1c;
    --err-border: rgba(220, 38, 38, 0.28);
    --chip-bg: rgba(15, 23, 42, 0.07);
    --chip-fg: #334155;
    --switch-off: rgba(100, 116, 139, 0.35);
    --switch-on: #16a34a;
  }
}

* {
  box-sizing: border-box;
}

.ah-root {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 24px 32px 28px 28px;
  max-width: 840px;
  color: var(--text-primary);
  overflow-y: auto;
  height: 100%;
  scrollbar-width: thin;
  scrollbar-color: rgba(148, 163, 184, 0.28) transparent;
}

.ah-root::-webkit-scrollbar {
  width: 8px;
}

.ah-root::-webkit-scrollbar-track {
  background: transparent;
}

.ah-root::-webkit-scrollbar-thumb {
  background: rgba(148, 163, 184, 0.25);
  border-radius: 999px;
}

.ah-root::-webkit-scrollbar-thumb:hover {
  background: rgba(148, 163, 184, 0.4);
}

.ah-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding-right: 36px;
  flex-wrap: wrap;
}

.ah-title-wrap {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  flex: 1 1 320px;
}

.ah-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: -0.01em;
  color: var(--text-primary);
}

.ah-subtitle {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.ah-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ah-meta-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: var(--chip-bg);
  color: var(--chip-fg);
  border: 1px solid var(--card-border);
}

.ah-lang-switch {
  display: inline-flex;
  align-items: center;
  padding: 2px;
  border-radius: 8px;
  border: 1px solid var(--card-border);
  background: var(--card-bg);
  gap: 2px;
}

.ah-lang-btn {
  appearance: none;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11.5px;
  font-weight: 500;
  padding: 4px 8px;
  cursor: pointer;
  line-height: 1.2;
  transition: background-color 120ms ease, color 120ms ease;
}

.ah-lang-btn:hover {
  color: var(--text-primary);
}

.ah-lang-btn[aria-pressed="true"] {
  background: var(--accent-strong);
  color: #ffffff;
  font-weight: 600;
}

.ah-lang-btn:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
}

.ah-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--card-border);
  background: var(--card-bg);
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 140ms ease, border-color 140ms ease, opacity 140ms ease;
}

.ah-btn:hover:not(:disabled) {
  background: var(--card-bg-hover);
  border-color: rgba(148, 163, 184, 0.32);
}

.ah-btn:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.ah-btn:disabled {
  opacity: 0.55;
  cursor: default;
}

.ah-btn-primary {
  background: rgba(56, 189, 248, 0.16);
  border-color: rgba(56, 189, 248, 0.35);
  color: #7dd3fc;
}

.ah-btn-primary:hover:not(:disabled) {
  background: rgba(56, 189, 248, 0.24);
  border-color: rgba(56, 189, 248, 0.5);
}

.ah-summary-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

@media (max-width: 640px) {
  .ah-summary-grid {
    grid-template-columns: 1fr;
  }
}

.ah-stat-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 16px;
  border-radius: 12px;
  background: var(--card-bg);
  border: 1px solid var(--card-border);
}

.ah-stat-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
}

.ah-stat-value-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.ah-stat-value {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.2;
  color: var(--text-primary);
}

.ah-stat-value--ok {
  color: var(--ok-fg);
}

.ah-stat-value--warn {
  color: var(--warn-fg);
}

.ah-stat-sub {
  font-size: 11px;
  color: var(--text-muted);
}

.ah-banner {
  padding: 10px 14px;
  border-radius: 10px;
  font-size: 12.5px;
  line-height: 1.45;
  border: 1px solid var(--card-border);
}

.ah-banner--error {
  background: var(--err-bg);
  border-color: var(--err-border);
  color: var(--err-fg);
}

.ah-banner--ok {
  background: var(--ok-bg);
  border-color: var(--ok-border);
  color: var(--ok-fg);
}

.ah-section-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.ah-addon-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ah-addon-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
  border-radius: 12px;
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  transition: border-color 140ms ease, background-color 140ms ease;
}

.ah-addon-card:hover {
  background: var(--card-bg-hover);
  border-color: rgba(148, 163, 184, 0.22);
}

.ah-addon-main {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  flex: 1 1 auto;
}

.ah-addon-top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ah-addon-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.ah-addon-ver {
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--text-secondary);
  background: var(--chip-bg);
  padding: 2px 7px;
  border-radius: 6px;
}

.ah-addon-id {
  font-size: 11.5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--text-muted);
}

.ah-badge-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.ah-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.5;
  border: 1px solid transparent;
}

.ah-badge-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.ah-badge--ok {
  background: var(--ok-bg);
  color: var(--ok-fg);
  border-color: var(--ok-border);
}

.ah-badge--warn {
  background: var(--warn-bg);
  color: var(--warn-fg);
  border-color: var(--warn-border);
}

.ah-badge--err {
  background: var(--err-bg);
  color: var(--err-fg);
  border-color: var(--err-border);
}

.ah-badge--neutral {
  background: var(--chip-bg);
  color: var(--chip-fg);
  border-color: var(--card-border);
}

.ah-addon-control {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  flex: 0 0 auto;
}

.ah-addon-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  flex-wrap: wrap;
}

.ah-plugin-pages-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.ah-toggle-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.ah-toggle-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  white-space: nowrap;
}

.ah-switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  width: 40px;
  height: 22px;
  padding: 2px;
  border: none;
  border-radius: 999px;
  background: var(--switch-off);
  cursor: pointer;
  transition: background-color 150ms ease, opacity 150ms ease;
}

.ah-switch[aria-checked="true"] {
  background: var(--switch-on);
}

.ah-switch:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.ah-switch:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.ah-switch-thumb {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #ffffff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
  transform: translateX(0);
  transition: transform 150ms ease;
}

.ah-switch[aria-checked="true"] .ah-switch-thumb {
  transform: translateX(18px);
}

.ah-toggle-hint {
  font-size: 11px;
  color: var(--text-muted);
  text-align: right;
}

.ah-sync-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px;
  border-radius: 12px;
  background: var(--card-bg);
  border: 1px solid var(--card-border);
}

.ah-sync-card--warn {
  background: rgba(245, 158, 11, 0.08);
  border-color: var(--warn-border);
}

.ah-sync-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.ah-sync-title {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-primary);
}

.ah-sync-desc {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.ah-cmd-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ah-cmd-code {
  flex: 1 1 220px;
  min-width: 0;
  overflow-x: auto;
  white-space: nowrap;
  padding: 7px 11px;
  border-radius: 8px;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: rgba(0, 0, 0, 0.28);
  border: 1px solid var(--card-border);
  color: #e2e8f0;
  user-select: all;
}

.ah-delivery-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ah-install-guide {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-secondary);
  background: rgba(15, 23, 42, 0.42);
  border: 1px solid var(--card-border);
}

.ah-empty {
  padding: 28px 20px;
  border-radius: 12px;
  border: 1px dashed var(--card-border);
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ah-empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.ah-empty-body {
  font-size: 12.5px;
  color: var(--text-secondary);
}

@media (prefers-reduced-motion: reduce) {
  .ah-btn,
  .ah-lang-btn,
  .ah-addon-card,
  .ah-switch,
  .ah-switch-thumb {
    transition: none;
  }
}
`;

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeLang(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'ko' || v.startsWith('ko-')) return 'ko';
  if (v === 'en' || v.startsWith('en-')) return 'en';
  return null;
}

function readStoredLanguage(win) {
  try {
    const storage = win && win.localStorage;
    if (storage && typeof storage.getItem === 'function') {
      return normalizeLang(storage.getItem(LANG_STORAGE_KEY));
    }
  } catch (_err) {}
  return null;
}

function writeStoredLanguage(win, lang) {
  try {
    const storage = win && win.localStorage;
    if (storage && typeof storage.setItem === 'function') {
      storage.setItem(LANG_STORAGE_KEY, lang);
      return true;
    }
  } catch (_err) {}
  return false;
}

function resolveLanguage(win, doc, overrideLang) {
  const explicit = normalizeLang(overrideLang);
  if (explicit) return explicit;
  const stored = readStoredLanguage(win);
  if (stored) return stored;
  try {
    const docLang =
      doc && doc.documentElement && doc.documentElement.lang
        ? normalizeLang(String(doc.documentElement.lang))
        : null;
    if (docLang) return docLang;
    const nav = win && win.navigator;
    const navLang = nav
      ? normalizeLang(nav.language || (Array.isArray(nav.languages) ? nav.languages[0] : ''))
      : null;
    if (navLang) return navLang;
  } catch (_err) {}
  return 'en';
}

function applyShieldAttributes(el, extraNoTranslateAttributes) {
  if (!el || typeof el.setAttribute !== 'function') return;
  el.setAttribute(IGNORE_ATTR, 'true');
  el.setAttribute(NO_TRANSLATE_ATTR, 'true');
  el.setAttribute('translate', 'no');
  if (Array.isArray(extraNoTranslateAttributes)) {
    for (let i = 0; i < extraNoTranslateAttributes.length; i += 1) {
      const attr = extraNoTranslateAttributes[i];
      if (typeof attr === 'string' && attr) {
        try {
          el.setAttribute(attr, 'true');
        } catch (_e) {}
      }
    }
  }
}

function resolveRemoteReasonLabel(reason, t) {
  switch (reason) {
    case 'ERR_UNSUPPORTED_HOST_CAPABILITY':
      return t.remoteReasonDesktopOnly;
    case 'ERR_REMOTE_REQUIRES_LOCAL_CONFIG_BRIDGE':
      return t.remoteReasonConfigBridge;
    case 'DISABLED_IN_CONFIG':
      return t.remoteReasonDisabledConfig;
    case 'ERR_TRUST_POLICY_NOT_APPROVED':
    case 'ERR_TRUST_HASH_MISMATCH':
    case 'ERR_TRUST_POLICY_READ_FAILED':
      return t.remoteReasonTrustRequired;
    case 'ERR_REMOTE_PROFILE_UNCONFIGURED':
      return t.remoteReasonUnconfigured;
    default:
      return t.remoteReasonUnsupported;
  }
}

function hasVisibleBackground(el, win) {
  if (!el || !win || typeof win.getComputedStyle !== 'function') return false;
  try {
    const bg = String(win.getComputedStyle(el).backgroundColor || '').trim().toLowerCase();
    if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)' || bg === 'rgba(0,0,0,0)') {
      return false;
    }
    return true;
  } catch (_err) {
    return false;
  }
}

function replaceLeafText(rootEl, nextText, doc) {
  if (!rootEl) return;
  const textNodes = [];
  function walk(node) {
    const list = node && node.childNodes ? node.childNodes : [];
    for (let i = 0; i < list.length; i += 1) {
      const ch = list[i];
      if (!ch) continue;
      if (ch.nodeType === 3) {
        if (String(ch.nodeValue !== undefined ? ch.nodeValue : ch.textContent || '').trim().length > 0) {
          textNodes.push(ch);
        }
      } else if (ch.nodeType === 1) {
        const tag = String(ch.tagName || '').toUpperCase();
        if (tag !== 'SVG' && tag !== 'STYLE' && tag !== 'SCRIPT') {
          walk(ch);
        }
      }
    }
  }
  walk(rootEl);
  if (textNodes.length > 0) {
    for (let i = 0; i < textNodes.length; i += 1) {
      const val = i === 0 ? nextText : '';
      if ('nodeValue' in textNodes[i]) {
        textNodes[i].nodeValue = val;
      } else {
        textNodes[i].textContent = val;
      }
    }
    return;
  }
  // If cloned item contains an SVG icon alongside empty text wrapper, preserve SVG; otherwise replace text cleanly
  const hasSvg = Boolean(rootEl.querySelector && rootEl.querySelector('svg'));
  if (hasSvg && doc && typeof doc.createElement === 'function') {
    const span = doc.createElement('span');
    span.textContent = nextText;
    rootEl.appendChild(span);
    return;
  }
  rootEl.textContent = nextText;
}

function setImportantStyle(el, prop, value) {
  if (!el || !el.style) return;
  if (typeof el.style.setProperty === 'function') {
    el.style.setProperty(prop, value, 'important');
  } else {
    const camel = prop.replace(/-([a-z])/g, (_m, ch) => ch.toUpperCase());
    el.style[camel] = value;
  }
}

function removeStyleProp(el, prop, restoreValue) {
  if (!el || !el.style) return;
  if (typeof el.style.removeProperty === 'function') {
    el.style.removeProperty(prop);
  }
  const camel = prop.replace(/-([a-z])/g, (_m, ch) => ch.toUpperCase());
  el.style[camel] = restoreValue || '';
}

function createHostSettingsUi(doc, win, opts = {}) {
  const hostBridge = opts.hostBridge || null;
  const settingsPageCoordinator = opts.settingsPageCoordinator || null;
  const settingsUiCfg = opts.settingsUi && typeof opts.settingsUi === 'object' ? opts.settingsUi : DEFAULT_SETTINGS_UI_CONFIG;
  const extraNoTranslateAttributes = Array.isArray(opts.extraNoTranslateAttributes) ? opts.extraNoTranslateAttributes : [];
  const anchorGroups =
    Array.isArray(settingsUiCfg.anchorGroups) && settingsUiCfg.anchorGroups.length > 0
      ? settingsUiCfg.anchorGroups
      : DEFAULT_SETTINGS_UI_CONFIG.anchorGroups;

  let disposed = false;
  let started = false;
  let observer = null;
  let domReadyHandler = null;
  let mountTimer = null;

  let mountedListParent = null;
  let mountedOuterSidebar = null;
  let mountedContentPane = null;
  let mountedReferenceItem = null;
  let mountedLang = null;
  let userLangOverride = readStoredLanguage(win);
  let navElement = null;
  let navInactiveColor = '';
  let pluginNavElements = [];
  let unsubSettingsPages = null;
  let paneHostElement = null;
  let shadowRoot = null;
  let isOpen = false;
  let isLoading = false;
  let lastState = null;
  let lastError = null;
  let flashMessage = null;
  let flashTimer = null;
  let pendingToggleIds = new Set();
  const savedChildDisplay = new WeakMap();
  const suppressedSiblingStyles = new Map(); // el -> { bg, color }
  let clickHostElement = null;
  let listClickHandler = null;

  function getNavLabel(lang) {
    const labels = settingsUiCfg.navLabel;
    if (labels && typeof labels === 'object') {
      if (lang === 'ko' && typeof labels.ko === 'string' && labels.ko.trim()) return labels.ko.trim();
      if (typeof labels.en === 'string' && labels.en.trim()) return labels.en.trim();
    }
    return lang === 'ko' ? DEFAULT_SETTINGS_UI_CONFIG.navLabel.ko : DEFAULT_SETTINGS_UI_CONFIG.navLabel.en;
  }

  function getLanguage() {
    return resolveLanguage(win, doc, userLangOverride);
  }

  function setLanguage(nextLang) {
    const norm = normalizeLang(nextLang);
    if (!norm) return getLanguage();
    userLangOverride = norm;
    writeStoredLanguage(win, norm);
    mountedLang = norm;
    if (navElement && navElement.isConnected) {
      replaceLeafText(navElement, getNavLabel(norm), doc);
    }
    if (!disposed && isOpen) {
      renderPanel();
    }
    return norm;
  }

  function matchAnchorGroupIndex(text) {
    const norm = normalizeText(text);
    if (!norm || norm.length > 48) return -1;
    for (let g = 0; g < anchorGroups.length; g += 1) {
      const group = anchorGroups[g];
      if (!Array.isArray(group)) continue;
      for (let i = 0; i < group.length; i += 1) {
        const candidate = normalizeText(group[i]);
        if (candidate && norm === candidate) {
          return g;
        }
      }
    }
    return -1;
  }

  function unwrapNavItem(el, groupIdx, stopContainer) {
    let cur = el;
    while (
      cur &&
      cur.parentElement &&
      cur.parentElement !== stopContainer &&
      cur.parentElement !== doc.body &&
      cur.parentElement !== doc.documentElement
    ) {
      const parent = cur.parentElement;
      const isSingleChild = parent.children && parent.children.length === 1;
      const isSameAnchorItem =
        parent.children &&
        parent.children.length <= 3 &&
        matchAnchorGroupIndex(parent.textContent) === groupIdx;
      if (isSingleChild || isSameAnchorItem) {
        cur = parent;
      } else {
        break;
      }
    }
    return cur;
  }

  function findSettingsSidebarAndContent() {
    if (!doc || typeof doc.querySelectorAll !== 'function') return null;
    const NAV_CANDIDATE_SEL = 'button, a, [role="tab"], [role="menuitem"], [role="button"], li, div';
    const candidates = doc.querySelectorAll(NAV_CANDIDATE_SEL);
    const matchedLeaves = [];

    for (let i = 0; i < candidates.length; i += 1) {
      const el = candidates[i];
      if (!el || !el.parentElement) continue;
      if (el.children && el.children.length > 2) continue;
      if (el.getAttribute && el.getAttribute(NAV_ATTR) === 'true') continue;
      if (el.closest && el.closest(`[${PANE_ATTR}="true"]`)) continue;
      const groupIdx = matchAnchorGroupIndex(el.textContent);
      if (groupIdx === -1) continue;
      // Keep only the innermost matching node so outer wrappers don't shadow actual clickable items
      let hasMatchingChild = false;
      if (el.children && el.children.length > 0 && typeof el.querySelectorAll === 'function') {
        const desc = el.querySelectorAll(NAV_CANDIDATE_SEL);
        for (let j = 0; j < desc.length; j += 1) {
          if (desc[j] !== el && matchAnchorGroupIndex(desc[j].textContent) !== -1) {
            hasMatchingChild = true;
            break;
          }
        }
      }
      if (hasMatchingChild) continue;
      matchedLeaves.push({ el, groupIdx });
    }

    if (matchedLeaves.length < 2) return null;

    // Group matched leaves by ancestor containers up to depth 4 (handles both direct siblings and wrapped items)
    const byContainer = new Map();
    for (let i = 0; i < matchedLeaves.length; i += 1) {
      const { el, groupIdx } = matchedLeaves[i];
      let container = el.parentElement;
      for (let depth = 0; depth < 4 && container && container !== doc.body && container !== doc.documentElement; depth += 1) {
        let rec = byContainer.get(container);
        if (!rec) {
          rec = { container, depthSum: 0, maxDepth: depth, groups: new Set(), items: [] };
          byContainer.set(container, rec);
        }
        if (!rec.groups.has(groupIdx)) {
          rec.groups.add(groupIdx);
          rec.depthSum += depth;
          if (depth > rec.maxDepth) rec.maxDepth = depth;
          rec.items.push({ el, groupIdx });
        }
        container = container.parentElement;
      }
    }

    let best = null;
    for (const rec of byContainer.values()) {
      if (rec.groups.size < 2) continue;
      if (
        !best ||
        rec.groups.size > best.groups.size ||
        (rec.groups.size === best.groups.size && rec.maxDepth < best.maxDepth) ||
        (rec.groups.size === best.groups.size && rec.maxDepth === best.maxDepth && rec.depthSum < best.depthSum)
      ) {
        best = rec;
      }
    }
    if (!best) return null;

    // Resolve unwrapped sibling items & true listParent inside the matched sidebar container
    const unwrappedItems = best.items.map((entry) => unwrapNavItem(entry.el, entry.groupIdx, best.container));
    const listParentCounts = new Map();
    for (let i = 0; i < unwrappedItems.length; i += 1) {
      const p = unwrappedItems[i].parentElement || best.container;
      listParentCounts.set(p, (listParentCounts.get(p) || 0) + 1);
    }
    let listParent = best.container;
    let bestParentCount = 0;
    for (const [p, count] of listParentCounts.entries()) {
      if (count > bestParentCount) {
        bestParentCount = count;
        listParent = p;
      }
    }
    const directMatchedItems = unwrappedItems.filter((item) => item.parentElement === listParent);
    const matchedList = directMatchedItems.length > 0 ? directMatchedItems : unwrappedItems;

    // Walk up up to 10 levels to locate the 2-pane split container (outerSidebar + largest right-hand contentPane)
    const sidebarRect =
      typeof best.container.getBoundingClientRect === 'function' ? best.container.getBoundingClientRect() : null;
    let cur = listParent;
    let outerSidebar = best.container;
    let contentPane = null;
    for (let depth = 0; depth < 10 && cur && cur.parentElement && cur.parentElement !== doc.documentElement; depth += 1) {
      const container = cur.parentElement;
      const curRect = typeof cur.getBoundingClientRect === 'function' ? cur.getBoundingClientRect() : null;
      const hasLayout = Boolean(curRect && curRect.width > 0 && curRect.height > 0);
      const rightBoundary = hasLayout
        ? Math.max(curRect.right, sidebarRect && sidebarRect.width > 0 ? sidebarRect.right : 0)
        : 0;
      const siblings = Array.from(container.children || []).filter((child) => child !== cur);
      const viableList = siblings.filter((sib) => {
        if (!sib || sib.nodeType !== 1) return false;
        const tag = String(sib.tagName || '').toUpperCase();
        if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'BUTTON' || tag === 'HEADER' || /^H[1-6]$/.test(tag)) {
          return false;
        }
        if (hasLayout && typeof sib.getBoundingClientRect === 'function') {
          const sibRect = sib.getBoundingClientRect();
          if (sibRect.width < 260 || sibRect.height < 200) return false;
          // Require side-by-side placement to the right (or non-overlapping horizontally)
          const horizontalOverlap = Math.min(curRect.right, sibRect.right) - Math.max(curRect.left, sibRect.left);
          if (sibRect.left < rightBoundary - 24 && horizontalOverlap > Math.min(curRect.width, sibRect.width) * 0.5) {
            return false;
          }
          return true;
        }
        // Fallback for non-layout mock DOMs: skip tiny text-only sidebar titles with no element children
        const childCount = sib.children ? sib.children.length : 0;
        const textLen = String(sib.textContent || '').trim().length;
        if (childCount === 0 && textLen < 40 && tag !== 'MAIN') return false;
        return true;
      });
      if (viableList.length > 0) {
        let chosen = viableList[0];
        if (hasLayout) {
          let bestArea = 0;
          for (let i = 0; i < viableList.length; i += 1) {
            const r = viableList[i].getBoundingClientRect();
            const area = r.width * r.height;
            if (area > bestArea) {
              bestArea = area;
              chosen = viableList[i];
            }
          }
        }
        outerSidebar = cur;
        contentPane = chosen;
        break;
      }
      cur = container;
    }

    if (!contentPane) return null;

    // Pick an INACTIVE sibling as clone template so native classes/spacing match with 0px shift
    const inactiveItem =
      matchedList.find((item) => !hasVisibleBackground(item, win) && matchAnchorGroupIndex(item.textContent) !== 0) ||
      matchedList.find((item) => !hasVisibleBackground(item, win)) ||
      matchedList[matchedList.length - 1] ||
      matchedList[0];

    return {
      listParent,
      outerSidebar,
      contentPane,
      referenceItem: inactiveItem,
      lastMatchedItem: matchedList[matchedList.length - 1] || inactiveItem,
    };
  }

  function isCloseButtonElement(el, contentPaneRect) {
    if (!el || el.nodeType !== 1) return false;
    const checkBtn = (btn) => {
      const aria = normalizeText(btn.getAttribute ? btn.getAttribute('aria-label') : '');
      const title = normalizeText(btn.getAttribute ? btn.getAttribute('title') : '');
      const text = normalizeText(btn.textContent);
      if (
        aria.includes('close') ||
        aria.includes('닫기') ||
        title.includes('close') ||
        title.includes('닫기') ||
        text === '×' ||
        text === '✕' ||
        text === 'x'
      ) {
        return true;
      }
      if (contentPaneRect && typeof btn.getBoundingClientRect === 'function') {
        const r = btn.getBoundingClientRect();
        if (r && r.width > 0 && r.width <= 52 && r.height > 0 && r.height <= 52) {
          if (r.right >= contentPaneRect.right - 72 && r.top <= contentPaneRect.top + 72) {
            return true;
          }
        }
      }
      return false;
    };
    const tag = String(el.tagName || '').toUpperCase();
    if (tag === 'BUTTON' && checkBtn(el)) return true;
    if (contentPaneRect && typeof el.getBoundingClientRect === 'function') {
      const r = el.getBoundingClientRect();
      if (
        r &&
        r.width > 0 &&
        r.width <= 64 &&
        r.height > 0 &&
        r.height <= 64 &&
        r.right >= contentPaneRect.right - 72 &&
        r.top <= contentPaneRect.top + 72
      ) {
        const innerBtn = el.querySelector ? el.querySelector('button') : null;
        if (innerBtn && checkBtn(innerBtn)) return true;
      }
    }
    return false;
  }

  function suppressNativeActiveSiblings() {
    let activeBg = 'rgba(255, 255, 255, 0.08)';
    let activeColor = '#f8fafc';
    if (!mountedListParent) return { activeBg, activeColor };

    const dim = (node) => {
      if (!node || !node.style || suppressedSiblingStyles.has(node)) return;
      suppressedSiblingStyles.set(node, {
        bg: node.style.backgroundColor || '',
        color: node.style.color || '',
      });
      setImportantStyle(node, 'background-color', 'transparent');
      if (navInactiveColor) {
        setImportantStyle(node, 'color', navInactiveColor);
      }
    };

    const children = Array.from(mountedListParent.children || []);
    for (let i = 0; i < children.length; i += 1) {
      const sib = children[i];
      if (!sib || sib.nodeType !== 1 || sib === navElement) continue;
      if (sib.getAttribute && sib.getAttribute(NAV_ATTR) === 'true') continue;
      if (hasVisibleBackground(sib, win)) {
        try {
          const cs = win.getComputedStyle(sib);
          if (cs.backgroundColor) activeBg = cs.backgroundColor;
          if (cs.color) activeColor = cs.color;
        } catch (_e) {}
      }
      dim(sib);
      if (typeof sib.querySelectorAll === 'function') {
        const inners = sib.querySelectorAll('button, span, div, a');
        for (let j = 0; j < inners.length; j += 1) {
          const inner = inners[j];
          if (hasVisibleBackground(inner, win)) {
            try {
              const ics = win.getComputedStyle(inner);
              if (ics.backgroundColor) activeBg = ics.backgroundColor;
              if (ics.color) activeColor = ics.color;
            } catch (_e2) {}
          }
          dim(inner);
        }
      }
    }
    return { activeBg, activeColor };
  }

  function restoreNativeActiveSiblings() {
    for (const [node, saved] of suppressedSiblingStyles.entries()) {
      removeStyleProp(node, 'background-color', saved.bg);
      removeStyleProp(node, 'color', saved.color);
    }
    suppressedSiblingStyles.clear();
  }

  function updateNavVisualState(active, activeTheme) {
    if (!navElement) return;
    navElement.setAttribute('aria-selected', active ? 'true' : 'false');
    navElement.setAttribute('data-active', active ? 'true' : 'false');
    if (active) {
      const bg = (activeTheme && activeTheme.activeBg) || 'rgba(56, 189, 248, 0.14)';
      const fg = (activeTheme && activeTheme.activeColor) || '#f8fafc';
      setImportantStyle(navElement, 'background-color', bg);
      setImportantStyle(navElement, 'color', fg);
    } else {
      removeStyleProp(navElement, 'background-color', '');
      removeStyleProp(navElement, 'color', '');
    }
  }

  function restoreNativeContentChildren() {
    if (!mountedContentPane) return;
    const children = Array.from(mountedContentPane.children || []);
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      if (child === paneHostElement) continue;
      if (savedChildDisplay.has(child)) {
        child.style.display = savedChildDisplay.get(child);
        savedChildDisplay.delete(child);
      }
    }
  }

  function hideOtherContentChildren() {
    if (!mountedContentPane) return;
    const paneRect =
      typeof mountedContentPane.getBoundingClientRect === 'function'
        ? mountedContentPane.getBoundingClientRect()
        : null;
    const children = Array.from(mountedContentPane.children || []);
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      if (child === paneHostElement) continue;
      if (isCloseButtonElement(child, paneRect)) {
        if (child.style) child.style.zIndex = '20';
        continue;
      }
      if (!savedChildDisplay.has(child)) {
        savedChildDisplay.set(child, child.style ? child.style.display || '' : '');
      }
      if (child.style) {
        child.style.display = 'none';
      }
    }
  }

  function clearFlashLater() {
    if (flashTimer) {
      clearTimeout(flashTimer);
      flashTimer = null;
    }
    flashTimer = setTimeout(() => {
      flashTimer = null;
      flashMessage = null;
      if (isOpen) renderPanel();
    }, 2600);
  }

  async function copyText(text, triggerBtn, t) {
    let ok = false;
    try {
      if (win && win.navigator && win.navigator.clipboard && typeof win.navigator.clipboard.writeText === 'function') {
        await win.navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (_err) {
      ok = false;
    }
    if (!ok && doc && typeof doc.createElement === 'function' && typeof doc.execCommand === 'function') {
      try {
        const ta = doc.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', 'true');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        doc.body.appendChild(ta);
        ta.select();
        ok = Boolean(doc.execCommand('copy'));
        ta.remove();
      } catch (_err2) {
        ok = false;
      }
    }
    if (triggerBtn) {
      const prev = triggerBtn.textContent;
      triggerBtn.textContent = ok ? t.copied : t.copyFailed;
      setTimeout(() => {
        if (triggerBtn && triggerBtn.isConnected) {
          triggerBtn.textContent = prev;
        }
      }, 1500);
    }
    return ok;
  }

  async function handleToggleRemote(addon, nextEnabled, t) {
    if (!hostBridge || typeof hostBridge.setRemoteAddonPreference !== 'function') return;
    if (pendingToggleIds.has(addon.pluginId)) return;

    pendingToggleIds.add(addon.pluginId);
    lastError = null;
    renderPanel();

    try {
      const res = await Promise.resolve(hostBridge.setRemoteAddonPreference(addon.pluginId, nextEnabled));
      if (res && res.ok === true && res.state) {
        lastState = res.state;
        flashMessage = t.remotePrefsSaved;
        clearFlashLater();
      } else {
        lastError = `${t.saveError}${res && res.reason ? ` (${res.reason})` : ''}`;
      }
    } catch (err) {
      lastError = `${t.saveError}${err && err.message ? ` (${err.message})` : ''}`;
    } finally {
      pendingToggleIds.delete(addon.pluginId);
      if (!disposed && isOpen) {
        renderPanel();
      }
    }
  }

  function createEl(tag, className, text) {
    const el = doc.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined && text !== null) el.textContent = String(text);
    return el;
  }

  function createBadge(text, variant, withDot = false) {
    const badge = createEl('span', `ah-badge ah-badge--${variant}`);
    if (withDot) {
      badge.appendChild(createEl('span', 'ah-badge-dot'));
    }
    badge.appendChild(doc.createTextNode(String(text)));
    return badge;
  }

  function renderPanel() {
    if (!shadowRoot) return;
    const lang = getLanguage();
    const t = COPY[lang] || COPY.en;

    while (shadowRoot.firstChild) {
      shadowRoot.removeChild(shadowRoot.firstChild);
    }

    const styleEl = doc.createElement('style');
    styleEl.textContent = PANEL_CSS;
    shadowRoot.appendChild(styleEl);

    const root = createEl('div', 'ah-root');
    shadowRoot.appendChild(root);

    // 1. Header
    const header = createEl('div', 'ah-header');
    const titleWrap = createEl('div', 'ah-title-wrap');
    titleWrap.appendChild(createEl('h2', 'ah-title', t.title));
    titleWrap.appendChild(createEl('p', 'ah-subtitle', t.subtitle));
    header.appendChild(titleWrap);

    const actions = createEl('div', 'ah-header-actions');
    if (lastState && lastState.host) {
      actions.appendChild(
        createEl('span', 'ah-meta-pill', `${t.hostLabel} v${lastState.host.version || '3.0.1'}`)
      );
      if (lastState.host.buildSha8) {
        actions.appendChild(createEl('span', 'ah-meta-pill', `${t.buildLabel} ${lastState.host.buildSha8}`));
      }
    }
    const langGroup = createEl('div', 'ah-lang-switch');
    langGroup.setAttribute('role', 'group');
    langGroup.setAttribute('aria-label', t.langSwitchAria);
    langGroup.setAttribute('data-ah-control', 'language-switch');
    const langDefs = [
      { code: 'ko', label: t.langKo },
      { code: 'en', label: t.langEn },
    ];
    for (let i = 0; i < langDefs.length; i += 1) {
      const def = langDefs[i];
      const lBtn = createEl('button', 'ah-lang-btn', def.label);
      lBtn.setAttribute('type', 'button');
      lBtn.setAttribute('data-ah-lang', def.code);
      lBtn.setAttribute('aria-pressed', lang === def.code ? 'true' : 'false');
      lBtn.addEventListener('click', () => {
        setLanguage(def.code);
      });
      langGroup.appendChild(lBtn);
    }
    actions.appendChild(langGroup);

    const refreshBtn = createEl('button', 'ah-btn', isLoading ? t.refreshing : t.refresh);
    refreshBtn.setAttribute('type', 'button');
    refreshBtn.disabled = isLoading;
    refreshBtn.addEventListener('click', () => {
      refresh();
    });
    actions.appendChild(refreshBtn);
    header.appendChild(actions);
    root.appendChild(header);

    if (lastError) {
      const errBanner = createEl('div', 'ah-banner ah-banner--error', lastError);
      errBanner.setAttribute('role', 'alert');
      root.appendChild(errBanner);
    } else if (flashMessage) {
      const okBanner = createEl('div', 'ah-banner ah-banner--ok', flashMessage);
      okBanner.setAttribute('role', 'status');
      root.appendChild(okBanner);
    }

    if (!lastState) {
      root.appendChild(createEl('div', 'ah-empty', isLoading ? t.loading : t.loadError));
      return;
    }

    const summary = lastState.summary || {
      totalCount: 0,
      desktopActiveCount: 0,
      remoteEligibleCount: 0,
      remoteEnabledCount: 0,
    };
    const bundle = lastState.remoteBundle || {
      built: false,
      needsRebuild: true,
      buildSha8: null,
      buildCommand: 'addon-host --build-remote',
      hasBookmarklet: false,
      bookmarkletText: null,
    };

    // 2. Summary cards
    const summaryGrid = createEl('div', 'ah-summary-grid');

    const statDesktop = createEl('div', 'ah-stat-card');
    statDesktop.appendChild(createEl('div', 'ah-stat-label', t.summaryDesktop));
    const desktopRow = createEl('div', 'ah-stat-value-row');
    desktopRow.appendChild(
      createEl('span', 'ah-stat-value ah-stat-value--ok', `${summary.desktopActiveCount} / ${summary.totalCount}`)
    );
    statDesktop.appendChild(desktopRow);
    statDesktop.appendChild(createEl('div', 'ah-stat-sub', `${t.summaryDesktopSub}: ${summary.totalCount}`));
    summaryGrid.appendChild(statDesktop);

    const statRemote = createEl('div', 'ah-stat-card');
    statRemote.appendChild(createEl('div', 'ah-stat-label', t.summaryRemote));
    const remoteRow = createEl('div', 'ah-stat-value-row');
    remoteRow.appendChild(
      createEl('span', 'ah-stat-value', `${summary.remoteEnabledCount} / ${summary.remoteEligibleCount}`)
    );
    statRemote.appendChild(remoteRow);
    statRemote.appendChild(createEl('div', 'ah-stat-sub', `${t.summaryRemoteSub}: ${summary.remoteEligibleCount}`));
    summaryGrid.appendChild(statRemote);

    const statBundle = createEl('div', 'ah-stat-card');
    statBundle.appendChild(createEl('div', 'ah-stat-label', t.summaryBundle));
    const bundleRow = createEl('div', 'ah-stat-value-row');
    const bundleLabel = !bundle.built
      ? t.bundleNotBuilt
      : bundle.needsRebuild
        ? t.bundleNeedsRebuild
        : t.bundleUpToDate;
    const bundleValueClass = !bundle.built || bundle.needsRebuild ? 'ah-stat-value ah-stat-value--warn' : 'ah-stat-value ah-stat-value--ok';
    bundleRow.appendChild(createEl('span', bundleValueClass, bundleLabel));
    statBundle.appendChild(bundleRow);
    statBundle.appendChild(
      createEl('div', 'ah-stat-sub', bundle.buildSha8 ? `SHA ${bundle.buildSha8}` : 'remote-dist')
    );
    summaryGrid.appendChild(statBundle);

    root.appendChild(summaryGrid);

    // 3. Addon list
    const registeredPages =
      settingsPageCoordinator && typeof settingsPageCoordinator.listSettingsPages === 'function'
        ? settingsPageCoordinator.listSettingsPages()
        : [];
    const pagesByPlugin = new Map();
    for (let p = 0; p < registeredPages.length; p += 1) {
      const pg = registeredPages[p];
      if (!pg || !pg.pluginId) continue;
      if (!pagesByPlugin.has(pg.pluginId)) pagesByPlugin.set(pg.pluginId, []);
      pagesByPlugin.get(pg.pluginId).push(pg);
    }
    const renderedPageKeys = new Set();

    root.appendChild(createEl('h3', 'ah-section-title', t.sectionAddons));
    const addons = Array.isArray(lastState.addons) ? lastState.addons : [];
    if (addons.length === 0) {
      const empty = createEl('div', 'ah-empty');
      empty.appendChild(createEl('div', 'ah-empty-title', t.emptyTitle));
      empty.appendChild(createEl('div', 'ah-empty-body', t.emptyBody));
      root.appendChild(empty);
    } else {
      const list = createEl('div', 'ah-addon-list');
      for (let i = 0; i < addons.length; i += 1) {
        const addon = addons[i];
        const card = createEl('div', 'ah-addon-card');
        card.setAttribute('data-plugin-id', addon.pluginId);

        const main = createEl('div', 'ah-addon-main');
        const top = createEl('div', 'ah-addon-top');
        top.appendChild(createEl('span', 'ah-addon-name', addon.displayName || addon.pluginId));
        top.appendChild(createEl('span', 'ah-addon-ver', `v${addon.version || '0.0.0'}`));
        if (addon.displayName && addon.displayName !== addon.pluginId) {
          top.appendChild(createEl('span', 'ah-addon-id', addon.pluginId));
        }
        main.appendChild(top);

        const badges = createEl('div', 'ah-badge-row');
        if (addon.desktopStatus === 'active') {
          badges.appendChild(createBadge(t.statusActive, 'ok', true));
        } else if (addon.desktopStatus === 'disabled') {
          badges.appendChild(createBadge(t.statusDisabled, 'neutral', true));
        } else if (addon.desktopStatus === 'rejected') {
          badges.appendChild(createBadge(t.statusRejected, 'err', true));
        } else if (addon.desktopStatus === 'failed') {
          badges.appendChild(createBadge(t.statusFailed, 'err', true));
        } else {
          badges.appendChild(createBadge(t.statusPending, 'warn', true));
        }

        if (addon.trustLevel === 'trusted') {
          badges.appendChild(
            createBadge(addon.trustApproved ? t.trustApproved : t.trustUnapproved, addon.trustApproved ? 'neutral' : 'warn')
          );
        } else {
          badges.appendChild(createBadge(t.trustRestricted, 'neutral'));
        }

        const caps = Array.isArray(addon.capabilities) ? addon.capabilities : [];
        if (caps.includes('renderer')) badges.appendChild(createBadge(t.capRenderer, 'neutral'));
        if (caps.includes('mainHook')) badges.appendChild(createBadge(t.capMainHook, 'neutral'));
        if (addon.hasSettingsBridge) badges.appendChild(createBadge(t.capSettings, 'neutral'));
        if (addon.hasConfigBridge) badges.appendChild(createBadge(t.capConfig, 'neutral'));
        main.appendChild(badges);
        card.appendChild(main);

        // Right control: Plugin Settings Page button(s) + Remote Web visibility toggle
        const ctrl = createEl('div', 'ah-addon-control');
        const pluginPages = pagesByPlugin.get(addon.pluginId) || [];
        if (pluginPages.length > 0 && settingsPageCoordinator && typeof settingsPageCoordinator.openSettingsPage === 'function') {
          const actionRow = createEl('div', 'ah-addon-actions');
          for (let j = 0; j < pluginPages.length; j += 1) {
            const page = pluginPages[j];
            const pageKey = `${addon.pluginId}:${page.id}`;
            renderedPageKeys.add(pageKey);
            const btnLabel = pluginPages.length === 1 ? t.openSettings : page.title;
            const openBtn = createEl('button', 'ah-btn ah-btn-primary', btnLabel);
            openBtn.setAttribute('type', 'button');
            openBtn.setAttribute('title', page.title);
            openBtn.setAttribute('aria-label', page.title);
            openBtn.setAttribute('data-ah-settings-page', pageKey);
            openBtn.addEventListener('click', () => {
              settingsPageCoordinator.openSettingsPage(addon.pluginId, page.id);
            });
            actionRow.appendChild(openBtn);
          }
          ctrl.appendChild(actionRow);
        }
        const toggleRow = createEl('div', 'ah-toggle-row');
        const toggleLabel = createEl('span', 'ah-toggle-label', t.remoteToggleLabel);
        toggleRow.appendChild(toggleLabel);

        const isPending = pendingToggleIds.has(addon.pluginId);
        const switchBtn = createEl('button', 'ah-switch');
        switchBtn.setAttribute('type', 'button');
        switchBtn.setAttribute('role', 'switch');
        switchBtn.setAttribute('aria-label', `${addon.displayName || addon.pluginId} ${t.remoteToggleLabel}`);
        switchBtn.setAttribute('aria-checked', addon.remoteEnabled ? 'true' : 'false');
        switchBtn.setAttribute('data-remote-toggle', addon.pluginId);
        if (isPending) switchBtn.setAttribute('aria-busy', 'true');
        switchBtn.disabled = !addon.remoteToggleable || isPending;
        switchBtn.appendChild(createEl('span', 'ah-switch-thumb'));

        if (addon.remoteToggleable) {
          switchBtn.addEventListener('click', () => {
            handleToggleRemote(addon, !addon.remoteEnabled, t);
          });
        }
        toggleRow.appendChild(switchBtn);
        ctrl.appendChild(toggleRow);

        const hintText = addon.remoteToggleable
          ? addon.remoteEnabled
            ? t.remoteToggleOn
            : t.remoteToggleOff
          : resolveRemoteReasonLabel(addon.remoteBlockedReason, t);
        ctrl.appendChild(createEl('div', 'ah-toggle-hint', hintText));
        card.appendChild(ctrl);

        list.appendChild(card);
      }
      root.appendChild(list);
    }

    const extraPages = registeredPages.filter((pg) => pg && !renderedPageKeys.has(`${pg.pluginId}:${pg.id}`));
    if (extraPages.length > 0 && settingsPageCoordinator && typeof settingsPageCoordinator.openSettingsPage === 'function') {
      root.appendChild(createEl('h3', 'ah-section-title', t.sectionPluginPages));
      const extraBar = createEl('div', 'ah-plugin-pages-bar');
      for (let e = 0; e < extraPages.length; e += 1) {
        const pg = extraPages[e];
        const pageKey = `${pg.pluginId}:${pg.id}`;
        const btn = createEl('button', 'ah-btn ah-btn-primary', pg.title);
        btn.setAttribute('type', 'button');
        btn.setAttribute('data-ah-settings-page', pageKey);
        btn.addEventListener('click', () => {
          settingsPageCoordinator.openSettingsPage(pg.pluginId, pg.id);
        });
        extraBar.appendChild(btn);
      }
      root.appendChild(extraBar);
    }

    // 4. Remote Web Bundle Sync Footer
    const needsAttention = !bundle.built || bundle.needsRebuild;
    const syncCard = createEl('div', needsAttention ? 'ah-sync-card ah-sync-card--warn' : 'ah-sync-card');
    const syncHead = createEl('div', 'ah-sync-head');
    const syncTitleText = !bundle.built
      ? t.syncTitleNotBuilt
      : bundle.needsRebuild
        ? t.syncTitleNeedsRebuild
        : t.syncTitleUpToDate;
    syncHead.appendChild(createEl('h3', 'ah-sync-title', syncTitleText));
    syncHead.appendChild(createBadge(bundleLabel, needsAttention ? 'warn' : 'ok', true));
    syncCard.appendChild(syncHead);

    const syncDescText = !bundle.built
      ? t.syncDescNotBuilt
      : bundle.needsRebuild
        ? t.syncDescNeedsRebuild
        : t.syncDescUpToDate;
    syncCard.appendChild(createEl('p', 'ah-sync-desc', syncDescText));

    const cmdRow = createEl('div', 'ah-cmd-row');
    const buildCmd = bundle.buildCommand || 'addon-host --build-remote';
    cmdRow.appendChild(createEl('code', 'ah-cmd-code', buildCmd));

    const copyCmdBtn = createEl('button', needsAttention ? 'ah-btn ah-btn-primary' : 'ah-btn', t.copyCommand);
    copyCmdBtn.setAttribute('type', 'button');
    copyCmdBtn.setAttribute('data-ah-action', 'copy-command');
    copyCmdBtn.addEventListener('click', () => {
      copyText(buildCmd, copyCmdBtn, t);
    });
    cmdRow.appendChild(copyCmdBtn);
    syncCard.appendChild(cmdRow);

    const canCopyExtension = Boolean(
      bundle.built && bundle.hasExtension && typeof bundle.extensionDir === 'string' && bundle.extensionDir.length > 0
    );
    const canCopyUserscript = Boolean(
      bundle.built && bundle.hasUserscript && typeof bundle.userscriptPath === 'string' && bundle.userscriptPath.length > 0
    );
    const canCopyServeCommand = Boolean(
      canCopyUserscript && typeof bundle.serveCommand === 'string' && bundle.serveCommand.length > 0
    );
    const canCopyBookmarklet = Boolean(
      typeof bundle.bookmarkletText === 'string' &&
        bundle.bookmarkletText.length > 0 &&
        (bundle.bookmarkletRunnable === true ||
          (bundle.bookmarkletRunnable === undefined &&
            bundle.hasBookmarklet === true &&
            bundle.bookmarkletText.length <= 65536))
    );

    if (canCopyUserscript || canCopyServeCommand || canCopyExtension || canCopyBookmarklet) {
      const deliveryRow = createEl('div', 'ah-delivery-row');
      if (canCopyUserscript) {
        const copyUserBtn = createEl(
          'button',
          !needsAttention ? 'ah-btn ah-btn-primary' : 'ah-btn',
          t.copyUserscriptPath
        );
        copyUserBtn.setAttribute('type', 'button');
        copyUserBtn.setAttribute('data-ah-action', 'copy-userscript-path');
        copyUserBtn.addEventListener('click', () => {
          copyText(bundle.userscriptPath, copyUserBtn, t);
        });
        deliveryRow.appendChild(copyUserBtn);
      }
      if (canCopyServeCommand) {
        const copyServeBtn = createEl('button', 'ah-btn', t.copyServeCommand);
        copyServeBtn.setAttribute('type', 'button');
        copyServeBtn.setAttribute('data-ah-action', 'copy-serve-command');
        copyServeBtn.addEventListener('click', () => {
          copyText(bundle.serveCommand, copyServeBtn, t);
        });
        deliveryRow.appendChild(copyServeBtn);
      }
      if (canCopyExtension) {
        const copyExtBtn = createEl(
          'button',
          !needsAttention && !canCopyUserscript ? 'ah-btn ah-btn-primary' : 'ah-btn',
          t.copyExtensionPath
        );
        copyExtBtn.setAttribute('type', 'button');
        copyExtBtn.setAttribute('data-ah-action', 'copy-extension-path');
        copyExtBtn.addEventListener('click', () => {
          copyText(bundle.extensionDir, copyExtBtn, t);
        });
        deliveryRow.appendChild(copyExtBtn);
      }
      if (canCopyBookmarklet) {
        const copyBmBtn = createEl('button', 'ah-btn', t.copyBookmarklet);
        copyBmBtn.setAttribute('type', 'button');
        copyBmBtn.setAttribute('data-ah-action', 'copy-bookmarklet');
        copyBmBtn.addEventListener('click', () => {
          copyText(bundle.bookmarkletText, copyBmBtn, t);
        });
        deliveryRow.appendChild(copyBmBtn);
      }
      syncCard.appendChild(deliveryRow);
    }

    if (canCopyUserscript) {
      syncCard.appendChild(createEl('p', 'ah-install-guide', t.userscriptGuide));
    } else if (canCopyExtension) {
      syncCard.appendChild(createEl('p', 'ah-install-guide', t.extensionGuide));
    }

    root.appendChild(syncCard);
  }

  async function refresh() {
    if (disposed || !hostBridge || typeof hostBridge.getHostAdminState !== 'function') {
      return { ok: false, reason: 'ERR_HOST_ADMIN_UNAVAILABLE' };
    }
    const lang = getLanguage();
    const t = COPY[lang] || COPY.en;
    isLoading = true;
    lastError = null;
    if (isOpen) renderPanel();

    try {
      const res = await Promise.resolve(hostBridge.getHostAdminState());
      if (res && res.ok === true) {
        lastState = res;
      } else {
        lastError = `${t.loadError}${res && res.reason ? ` (${res.reason})` : ''}`;
      }
      return res;
    } catch (err) {
      lastError = `${t.loadError}${err && err.message ? ` (${err.message})` : ''}`;
      return { ok: false, reason: err && err.message ? err.message : String(err) };
    } finally {
      isLoading = false;
      if (!disposed && isOpen) {
        renderPanel();
      }
    }
  }

  function openPanel() {
    if (disposed || !mountedContentPane) return false;
    const activeTheme = suppressNativeActiveSiblings();
    hideOtherContentChildren();

    if (!paneHostElement || paneHostElement.parentElement !== mountedContentPane) {
      paneHostElement = doc.createElement('div');
      paneHostElement.setAttribute(PANE_ATTR, 'true');
      applyShieldAttributes(paneHostElement, extraNoTranslateAttributes);
      paneHostElement.style.width = '100%';
      paneHostElement.style.height = '100%';
      paneHostElement.style.overflow = 'hidden';
      shadowRoot = paneHostElement.attachShadow({ mode: 'open' });
      mountedContentPane.appendChild(paneHostElement);
    }
    paneHostElement.style.display = 'block';
    isOpen = true;
    updateNavVisualState(true, activeTheme);
    renderPanel();
    refresh();
    return true;
  }

  function closePanel() {
    if (!isOpen && !paneHostElement) return false;
    isOpen = false;
    restoreNativeActiveSiblings();
    updateNavVisualState(false);
    if (paneHostElement && paneHostElement.style) {
      paneHostElement.style.display = 'none';
    }
    restoreNativeContentChildren();
    return true;
  }

  function detachNavListeners() {
    if (clickHostElement && listClickHandler) {
      try {
        clickHostElement.removeEventListener('click', listClickHandler, true);
      } catch (_err) {}
    }
    clickHostElement = null;
    listClickHandler = null;
  }

  function buildNavItem(referenceItem, lang) {
    let btn;
    if (referenceItem && typeof referenceItem.cloneNode === 'function') {
      btn = referenceItem.cloneNode(true);
      btn.removeAttribute('id');
      btn.removeAttribute('aria-current');
      btn.removeAttribute('data-state');
      btn.removeAttribute('data-active');
      if (btn.tagName && String(btn.tagName).toUpperCase() === 'BUTTON') {
        btn.setAttribute('type', 'button');
      }
      if (typeof btn.querySelectorAll === 'function') {
        const innerBtns = btn.querySelectorAll('button');
        for (let i = 0; i < innerBtns.length; i += 1) {
          innerBtns[i].removeAttribute('id');
          innerBtns[i].setAttribute('type', 'button');
        }
      }
      replaceLeafText(btn, getNavLabel(lang), doc);
    } else {
      btn = doc.createElement('button');
      btn.setAttribute('type', 'button');
      btn.textContent = getNavLabel(lang);
    }

    btn.setAttribute(NAV_ATTR, 'true');
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', 'false');
    applyShieldAttributes(btn, extraNoTranslateAttributes);
    if (btn.style && !btn.style.cursor) {
      btn.style.cursor = 'pointer';
    }

    btn.addEventListener('click', (ev) => {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
      openPanel();
    });

    return btn;
  }

  function findInsertReferenceAfterSettingsGroup(listParent, lastMatchedItem) {
    if (!listParent || !lastMatchedItem || lastMatchedItem.parentElement !== listParent) {
      return null;
    }
    let anchor = lastMatchedItem;
    const siblings = Array.from(listParent.children || []);
    let idx = siblings.indexOf(anchor);
    if (idx === -1) return null;
    // Stay cleanly after any adjacent peer addon slot nav items mounted right after the settings group
    while (idx + 1 < siblings.length) {
      const next = siblings[idx + 1];
      if (
        next &&
        next.getAttribute &&
        (next.getAttribute('data-addon-host-slot') || next.getAttribute('data-addon-host-owner'))
      ) {
        idx += 1;
        anchor = next;
      } else {
        break;
      }
    }
    return idx + 1 < siblings.length ? siblings[idx + 1] : null;
  }

  function removePluginNavItems() {
    for (let i = 0; i < pluginNavElements.length; i += 1) {
      const el = pluginNavElements[i];
      if (el && el.parentNode && typeof el.parentNode.removeChild === 'function') {
        try {
          el.parentNode.removeChild(el);
        } catch (_err) {}
      }
    }
    pluginNavElements = [];
  }

  function buildPluginNavItem(referenceItem, page) {
    let btn;
    if (referenceItem && typeof referenceItem.cloneNode === 'function') {
      btn = referenceItem.cloneNode(true);
      btn.removeAttribute('id');
      btn.removeAttribute('aria-current');
      btn.removeAttribute('data-state');
      btn.removeAttribute('data-active');
      if (btn.tagName && String(btn.tagName).toUpperCase() === 'BUTTON') {
        btn.setAttribute('type', 'button');
      }
      if (typeof btn.querySelectorAll === 'function') {
        const innerBtns = btn.querySelectorAll('button');
        for (let i = 0; i < innerBtns.length; i += 1) {
          innerBtns[i].removeAttribute('id');
          innerBtns[i].setAttribute('type', 'button');
        }
      }
      replaceLeafText(btn, page.title, doc);
    } else {
      btn = doc.createElement('button');
      btn.setAttribute('type', 'button');
      btn.textContent = page.title;
    }

    const pageKey = `${page.pluginId}:${page.id}`;
    btn.setAttribute(PLUGIN_NAV_ATTR, pageKey);
    btn.setAttribute('data-addon-host-owner', page.pluginId);
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', 'false');
    applyShieldAttributes(btn, extraNoTranslateAttributes);
    if (btn.style && !btn.style.cursor) {
      btn.style.cursor = 'pointer';
    }

    btn.addEventListener('click', (ev) => {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
      if (settingsPageCoordinator && typeof settingsPageCoordinator.openSettingsPage === 'function') {
        settingsPageCoordinator.openSettingsPage(page.pluginId, page.id);
      }
    });

    return btn;
  }

  function syncPluginNavItems() {
    if (disposed || !mountedListParent || !mountedListParent.isConnected || !navElement || !navElement.isConnected) {
      return;
    }
    removePluginNavItems();
    if (!settingsPageCoordinator || typeof settingsPageCoordinator.listSettingsPages !== 'function') {
      return;
    }
    const pages = settingsPageCoordinator.listSettingsPages();
    if (!Array.isArray(pages) || pages.length === 0) return;

    let anchor = navElement;
    for (let i = 0; i < pages.length; i += 1) {
      const page = pages[i];
      if (!page || !page.pluginId || !page.id) continue;
      const btn = buildPluginNavItem(mountedReferenceItem, page);
      const nextSib = anchor.nextSibling || null;
      if (nextSib && typeof mountedListParent.insertBefore === 'function') {
        mountedListParent.insertBefore(btn, nextSib);
      } else if (typeof mountedListParent.appendChild === 'function') {
        mountedListParent.appendChild(btn);
      }
      pluginNavElements.push(btn);
      anchor = btn;
    }
  }

  function ensureMount() {
    if (disposed || !doc) return false;

    if (navElement && navElement.isConnected && mountedListParent && mountedListParent.isConnected) {
      const liveLang = getLanguage();
      if (liveLang !== mountedLang) {
        mountedLang = liveLang;
        replaceLeafText(navElement, getNavLabel(liveLang), doc);
        if (isOpen) renderPanel();
      }
      return true;
    }

    // Previous Settings modal was unmounted; clean stale references
    restoreNativeActiveSiblings();
    detachNavListeners();
    removePluginNavItems();
    navElement = null;
    navInactiveColor = '';
    paneHostElement = null;
    shadowRoot = null;
    mountedListParent = null;
    mountedOuterSidebar = null;
    mountedContentPane = null;
    mountedReferenceItem = null;
    mountedLang = null;
    isOpen = false;

    const found = findSettingsSidebarAndContent();
    if (!found) return false;

    const { listParent, outerSidebar, contentPane, referenceItem, lastMatchedItem } = found;
    const existing = listParent.querySelector ? listParent.querySelector(`[${NAV_ATTR}="true"]`) : null;
    if (existing) {
      navElement = existing;
      mountedListParent = listParent;
      mountedOuterSidebar = outerSidebar || listParent;
      mountedContentPane = contentPane;
      mountedReferenceItem = referenceItem || null;
      mountedLang = getLanguage();
      syncPluginNavItems();
      return true;
    }

    const lang = getLanguage();
    try {
      if (referenceItem && win && typeof win.getComputedStyle === 'function') {
        navInactiveColor = String(win.getComputedStyle(referenceItem).color || '');
      }
    } catch (_e) {
      navInactiveColor = '';
    }
    const btn = buildNavItem(referenceItem, lang);
    const insertRef = findInsertReferenceAfterSettingsGroup(listParent, lastMatchedItem);
    if (insertRef && typeof listParent.insertBefore === 'function') {
      listParent.insertBefore(btn, insertRef);
    } else {
      listParent.appendChild(btn);
    }

    mountedListParent = listParent;
    mountedOuterSidebar = outerSidebar || listParent;
    mountedContentPane = contentPane;
    mountedReferenceItem = referenceItem || null;
    mountedLang = lang;
    navElement = btn;
    syncPluginNavItems();

    // Close our panel smoothly whenever the user selects any other tab/item in the sidebar (native OR peer addon)
    const clickHost = mountedOuterSidebar || listParent;
    clickHostElement = clickHost;
    listClickHandler = (ev) => {
      const target = ev && ev.target;
      if (!target || !navElement || !isOpen) return;
      if (target === navElement || (navElement.contains && navElement.contains(target))) {
        return;
      }
      for (let i = 0; i < pluginNavElements.length; i += 1) {
        const pNav = pluginNavElements[i];
        if (pNav && (target === pNav || (pNav.contains && pNav.contains(target)))) {
          return;
        }
      }
      if (clickHost && clickHost.contains && clickHost.contains(target)) {
        closePanel();
      }
    };
    clickHost.addEventListener('click', listClickHandler, true);
    return true;
  }

  function scheduleEnsureMount() {
    if (disposed || mountTimer) return;
    mountTimer = setTimeout(() => {
      mountTimer = null;
      if (!disposed) ensureMount();
    }, 30);
  }

  function start() {
    if (disposed || started) return false;
    started = true;
    if (settingsPageCoordinator && typeof settingsPageCoordinator.onChange === 'function') {
      unsubSettingsPages = settingsPageCoordinator.onChange(() => {
        if (disposed) return;
        syncPluginNavItems();
        if (isOpen) renderPanel();
      });
    }
    ensureMount();
    const MO = (win && win.MutationObserver) || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
    const observeTarget = doc && (doc.documentElement || doc.body);
    if (MO && observeTarget) {
      observer = new MO(() => {
        scheduleEnsureMount();
      });
      observer.observe(observeTarget, {
        childList: true,
        subtree: true,
      });
    }
    if (doc && doc.readyState === 'loading' && typeof doc.addEventListener === 'function') {
      domReadyHandler = () => {
        domReadyHandler = null;
        if (!disposed) ensureMount();
      };
      doc.addEventListener('DOMContentLoaded', domReadyHandler, { once: true });
    }
    return true;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (mountTimer) {
      clearTimeout(mountTimer);
      mountTimer = null;
    }
    if (flashTimer) {
      clearTimeout(flashTimer);
      flashTimer = null;
    }
    if (domReadyHandler && doc && typeof doc.removeEventListener === 'function') {
      try {
        doc.removeEventListener('DOMContentLoaded', domReadyHandler);
      } catch (_err) {}
      domReadyHandler = null;
    }
    if (observer) {
      try {
        observer.disconnect();
      } catch (_err) {}
      observer = null;
    }
    if (unsubSettingsPages) {
      try {
        unsubSettingsPages();
      } catch (_err) {}
      unsubSettingsPages = null;
    }
    closePanel();
    restoreNativeActiveSiblings();
    detachNavListeners();
    removePluginNavItems();
    if (navElement && navElement.parentNode) {
      try {
        navElement.parentNode.removeChild(navElement);
      } catch (_err) {}
    }
    if (paneHostElement && paneHostElement.parentNode) {
      try {
        paneHostElement.parentNode.removeChild(paneHostElement);
      } catch (_err) {}
    }
    navElement = null;
    navInactiveColor = '';
    paneHostElement = null;
    shadowRoot = null;
    mountedListParent = null;
    mountedOuterSidebar = null;
    mountedContentPane = null;
    mountedReferenceItem = null;
    mountedLang = null;
  }

  return Object.freeze({
    start,
    ensureMount,
    openPanel,
    closePanel,
    refresh,
    dispose,
    getLanguage,
    setLanguage,
    isMounted: () => Boolean(navElement && navElement.isConnected),
    isOpen: () => isOpen,
    getElements: () => ({
      navElement,
      pluginNavElements: pluginNavElements.slice(),
      paneHostElement,
      shadowRoot,
    }),
  });
}

module.exports = {
  NAV_ATTR,
  PLUGIN_NAV_ATTR,
  PANE_ATTR,
  LANG_STORAGE_KEY,
  DEFAULT_SETTINGS_UI_CONFIG,
  createHostSettingsUi,
};

  },
  "./kernel.js": function(module, exports, require) {
'use strict';

/**
 * Isolated World 998 Renderer Kernel (v2.0.0 — T-A Option A1 + T-B Option B2).
 *
 * - Claims `window.__addonHostBootstrap.claim(cfg.claimNonce)` ONCE per document generation.
 * - Composes modular `ignore-guard`, `style-manager`, `slot-manager`, `modal-portal`,
 *   `region-observer`, and `settings-tab-coordinator`.
 * - Provides each plugin an isolated, capability-scoped `addonHost` API handle with
 *   deterministic `dispose()` cleanup.
 */

const { isElementInsideIgnored } = require('./ignore-guard');
const { createStyleManager } = require('./style-manager');
const { createSlotManager } = require('./slot-manager');
const { createSurfaceGeometry } = require('./surface-geometry');
const { createPlacementEngine } = require('./placement-engine');
const { createModalPortal } = require('./modal-portal');
const { createRegionObserver } = require('./region-observer');
const { createSettingsTabCoordinator } = require('./settings-tab-coordinator');
const { createThemeAndI18n } = require('./theme-i18n');
const { createToastAndDialogManager } = require('./toast-manager');
const { createServiceBus } = require('./service-bus');
const { createEventBus } = require('./event-bus');
const { createStorageV3 } = require('./storage-v3');
const { createStatusItemRegistry } = require('./status-item-registry');
const { createSettingsPageCoordinator } = require('./settings-page-coordinator');
const { createAddonContextV3 } = require('./context-v3');
const { createV2CompatAdapter } = require('./v2-compat-adapter');
const { wrapHostBridgePort } = require('./host-bridge-port');
const { createHostSettingsUi } = require('./host-settings-ui');

// I4: Capture JS primordials BEFORE any plugin executes in shared Isolated World 998
const _Error = Error;
const _String = String;
const _Number = Number;
const _NumberIsFinite = Number.isFinite;
const _ReflectApply = Reflect.apply;
const _ObjectKeys = Object.keys;
const _ObjectCreate = Object.create;
const _ObjectFreeze = Object.freeze;
const _ObjectHasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
const _ObjectDefineProperty = Object.defineProperty;
const _ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const _ArrayIsArray = Array.isArray;
const _ArrayPush = Function.prototype.call.bind(Array.prototype.push);
const _ArrayShift = Function.prototype.call.bind(Array.prototype.shift);
const _ArraySlice = Function.prototype.call.bind(Array.prototype.slice);
const _Map = Map;
const _MapGet = Function.prototype.call.bind(Map.prototype.get);
const _MapSet = Function.prototype.call.bind(Map.prototype.set);
const _MapHas = Function.prototype.call.bind(Map.prototype.has);
const _MapDelete = Function.prototype.call.bind(Map.prototype.delete);
const _MapForEach = Function.prototype.call.bind(Map.prototype.forEach);
const _Set = Set;
const _SetAdd = Function.prototype.call.bind(Set.prototype.add);
const _SetHas = Function.prototype.call.bind(Set.prototype.has);
const _SetDelete = Function.prototype.call.bind(Set.prototype.delete);
const _SetClear = Function.prototype.call.bind(Set.prototype.clear);
const _SetForEach = Function.prototype.call.bind(Set.prototype.forEach);
const _SetSize = Function.prototype.call.bind(_ObjectGetOwnPropertyDescriptor(Set.prototype, 'size').get);
const _WeakMap = WeakMap;
const _WeakMapGet = Function.prototype.call.bind(WeakMap.prototype.get);
const _WeakMapSet = Function.prototype.call.bind(WeakMap.prototype.set);
const _WeakMapHas = Function.prototype.call.bind(WeakMap.prototype.has);
const _WeakSet = WeakSet;
const _WeakSetAdd = Function.prototype.call.bind(WeakSet.prototype.add);
const _WeakSetHas = Function.prototype.call.bind(WeakSet.prototype.has);
const _WeakSetDelete = Function.prototype.call.bind(WeakSet.prototype.delete);
const _Uint8Array = Uint8Array;
const _NumberToString = Function.prototype.call.bind(Number.prototype.toString);
const _StringPadStart = Function.prototype.call.bind(String.prototype.padStart);
const _StringSlice = Function.prototype.call.bind(String.prototype.slice);
const _StringTrim = Function.prototype.call.bind(String.prototype.trim);
const _ArrayJoin = Function.prototype.call.bind(Array.prototype.join);
const _MathRound = Math.round;
const _DateNow = Date.now;
const _MathRandom = Math.random;
const _JSONStringify = JSON.stringify;
const _PromiseResolve = Promise.resolve.bind(Promise);
const _PromiseReject = Promise.reject.bind(Promise);
const _GlobalCrypto = typeof globalThis !== 'undefined' && globalThis.crypto ? globalThis.crypto : null;
const _CryptoGetRandomValues =
  _GlobalCrypto && typeof _GlobalCrypto.getRandomValues === 'function'
    ? Function.prototype.bind.call(_GlobalCrypto.getRandomValues, _GlobalCrypto)
    : null;

const FORBIDDEN_CLONE_KEYS = new _Set(['__proto__', 'constructor', 'prototype']);
const UI_GRID_MERGE_STYLE_ATTR = 'data-addon-host-ui-grid-merge';
const UNSAFE_GRID_MERGE_SELECTOR_RE = /[{};@\r\n\\]|\/\*|\*\/|<\/style/i;

function isSafeGridMergeSelector(selector) {
  if (typeof selector !== 'string') return false;
  const trimmed = _StringTrim(selector);
  if (!trimmed || trimmed.length > 256) return false;
  return !UNSAFE_GRID_MERGE_SELECTOR_RE.test(trimmed);
}

function buildUiGridMergeCss(uiGridMerges) {
  if (!_ArrayIsArray(uiGridMerges) || uiGridMerges.length === 0) return '';
  const blocks = [];
  for (let i = 0; i < uiGridMerges.length; i += 1) {
    const spec = uiGridMerges[i];
    if (!spec || typeof spec !== 'object' || _ArrayIsArray(spec)) continue;
    const s = typeof spec.section === 'string' ? _StringTrim(spec.section) : '';
    const t = typeof spec.secondary === 'string' ? _StringTrim(spec.secondary) : '';
    if (!isSafeGridMergeSelector(s) || !isSafeGridMergeSelector(t)) continue;
    // SOLID #0: Read structural wrapper/grid selectors declaratively from HostProfile (zero vendor/Tailwind literals in kernel)
    const rawWrap = typeof spec.wrapperSelector === 'string' ? _StringTrim(spec.wrapperSelector) : '[data-grid-wrapper]';
    const rawGrid = typeof spec.gridSelector === 'string' ? _StringTrim(spec.gridSelector) : '[data-grid]';
    if (!isSafeGridMergeSelector(rawWrap) || !isSafeGridMergeSelector(rawGrid)) continue;
    const minW = _NumberIsFinite(spec.minWidthPx) && spec.minWidthPx >= 0 ? _MathRound(spec.minWidthPx) : 640;
    const cols = _NumberIsFinite(spec.columns) && spec.columns >= 2 && spec.columns <= 12 ? _MathRound(spec.columns) : 2;
    const gap = _NumberIsFinite(spec.gapPx) && spec.gapPx >= 0 ? _MathRound(spec.gapPx) : 8;
    const hdrGap = _NumberIsFinite(spec.headerGapPx) && spec.headerGapPx >= 0 ? _MathRound(spec.headerGapPx) : 4;
    const sel = `${s}:has(> ${rawWrap} > ${rawGrid}):has(> ${t})`;
    const rule =
      `@media (min-width: ${minW}px) {` +
      `${sel} { display: grid; grid-template-columns: repeat(${cols}, minmax(0, 1fr)); gap: ${gap}px; }` +
      `${sel} > :first-child { grid-column: 1 / -1; margin-bottom: ${hdrGap}px; }` +
      `${sel} > [role="alert"] { grid-column: 1 / -1; }` +
      `${sel} > ${rawWrap}:has(> ${rawGrid}), ${sel} > ${rawWrap}:has(> ${rawGrid}) > ${rawGrid}, ${sel} > ${t} { display: contents; }` +
      `${sel} > ${rawWrap}:has(> ${rawGrid}) > :not(${rawGrid}) { grid-column: 1 / -1; order: 10; }` +
      `}`;
    _ArrayPush(blocks, rule);
  }
  return _ArrayJoin(blocks, '\n');
}

function applyUiGridMerges(doc, uiGridMerges) {
  const css = buildUiGridMergeCss(uiGridMerges);
  if (!css || !doc || typeof doc.createElement !== 'function') return false;
  const existing =
    typeof doc.querySelector === 'function' ? doc.querySelector(`style[${UI_GRID_MERGE_STYLE_ATTR}="1"]`) : null;
  if (existing) {
    existing.textContent = css;
    return true;
  }
  const target = doc.head || doc.documentElement || doc.body;
  if (!target || typeof target.appendChild !== 'function') return false;
  const styleEl = doc.createElement('style');
  if (typeof styleEl.setAttribute === 'function') {
    styleEl.setAttribute(UI_GRID_MERGE_STYLE_ATTR, '1');
    styleEl.setAttribute('data-addon-host-ignore', 'true');
  }
  styleEl.textContent = css;
  target.appendChild(styleEl);
  return true;
}

function defineSafeOwnProp(target, key, value) {
  const desc = _ObjectCreate(null);
  desc.value = value;
  desc.enumerable = true;
  desc.configurable = true;
  desc.writable = true;
  _ObjectDefineProperty(target, key, desc);
}

function deepFreezeClone(value, seen = new _WeakMap()) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (_WeakMapHas(seen, value)) {
    return _WeakMapGet(seen, value);
  }
  if (_ArrayIsArray(value)) {
    const out = [];
    _WeakMapSet(seen, value, out);
    for (let i = 0; i < value.length; i++) {
      defineSafeOwnProp(out, i, deepFreezeClone(value[i], seen));
    }
    return _ObjectFreeze(out);
  }
  const out = {};
  _WeakMapSet(seen, value, out);
  const keys = _ObjectKeys(value);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (_SetHas(FORBIDDEN_CLONE_KEYS, k)) continue;
    defineSafeOwnProp(out, k, deepFreezeClone(value[k], seen));
  }
  return _ObjectFreeze(out);
}

function sanitizeJsonPayload(value, seen = new _WeakSet()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return _NumberIsFinite(value) ? value : null;
  }
  if (typeof value !== 'object') {
    return undefined;
  }
  if (_WeakSetHas(seen, value)) {
    throw new _Error('ERR_SETTINGS_INVALID_JSON');
  }
  _WeakSetAdd(seen, value);
  try {
    if (_ArrayIsArray(value)) {
      const out = [];
      for (let i = 0; i < value.length; i++) {
        const item = sanitizeJsonPayload(value[i], seen);
        defineSafeOwnProp(out, i, item === undefined ? null : item);
      }
      return out;
    }
    const out = {};
    const keys = _ObjectKeys(value);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (_SetHas(FORBIDDEN_CLONE_KEYS, k)) {
        throw new _Error('ERR_SETTINGS_UNSAFE_PROTO_KEY');
      }
      const nextVal = sanitizeJsonPayload(value[k], seen);
      if (nextVal !== undefined) {
        defineSafeOwnProp(out, k, nextVal);
      }
    }
    return out;
  } finally {
    _WeakSetDelete(seen, value);
  }
}

function createRendererKernel(doc = globalThis.document, win = globalThis.window || globalThis) {
  let booted = false;
  let docGenId = 0;
  let hostProfileId = null;
  let hostSurface = 'desktop';
  let hostToken = null;
  let hostBridge = null;
  let extraNoTranslateAttributes = [];
  let styleManager = null;
  let slotManager = null;
  let surfaceGeometry = null;
  let placementEngine = null;
  let modalPortal = null;
  let regionObserver = null;
  let settingsTabs = null;
  let themeAndI18n = null;
  let toastManager = null;
  let serviceBus = null;
  let eventBus = null;
  let storageV3 = null;
  let statusItemRegistry = null;
  let settingsPageCoordinator = null;
  let hostSettingsUi = null;

  const pluginDisposers = new _Map(); // pluginId -> Set<Function>
  const pluginMarkDisposed = new _Map(); // pluginId -> Set<Function>
  const disposingPlugins = new _Set(); // pluginId (I10: re-entrancy guard during onDispose)
  const pluginActions = new _Map(); // pluginId -> Map<actionId, object>
  const pluginTrustLevels = new _Map(); // pluginId -> 'trusted' | 'restricted' (I4)
  const pluginSettingsAllowed = new _Set(); // pluginId (trusted + settingsBridge declared)
  const pluginSettingsSnapshots = new _Map(); // pluginId -> frozen snapshot
  const pluginSettingsListeners = new _Map(); // pluginId -> Set<Function>
  const pluginConfigScopes = new _Map(); // pluginId -> Map<scopeId, { scopeId, access, maxBytes }>
  const pluginV3Contexts = new _Map(); // pluginId -> AddonContextV3
  const stagedHandles = new _Map(); // runNonce -> { pluginId, handle } (S-1 CSP-safe two-phase execution)
  const recordedErrors = [];
  let nonceSeq = 0;

  function generateRunNonce() {
    nonceSeq += 1;
    try {
      const getRandom =
        _CryptoGetRandomValues ||
        (win && win.crypto && typeof win.crypto.getRandomValues === 'function'
          ? (arr) => win.crypto.getRandomValues(arr)
          : null);
      if (getRandom) {
        const bytes = new _Uint8Array(16);
        getRandom(bytes);
        let hex = '';
        for (let i = 0; i < 16; i++) {
          hex += _StringPadStart(_NumberToString(bytes[i], 16), 2, '0');
        }
        return `rn-${nonceSeq}-${hex}`;
      }
    } catch (_e) {}
    return `rn-${nonceSeq}-${_NumberToString(_DateNow(), 36)}-${_StringSlice(_NumberToString(_MathRandom(), 36), 2)}-${_StringSlice(_NumberToString(_MathRandom(), 36), 2)}`;
  }

  function assertHostToken(providedToken) {
    if (hostToken !== null && providedToken !== hostToken) {
      throw new _Error('ERR_FORBIDDEN_HOST_TOKEN');
    }
  }

  function reportPluginError(pluginId, detail) {
    const entry = { pluginId: _String(pluginId || 'unknown'), detail: _String(detail || '') };
    _ArrayPush(recordedErrors, entry);
    if (recordedErrors.length > 200) _ArrayShift(recordedErrors);
    if (hostBridge && typeof hostBridge.reportError === 'function') {
      try {
        hostBridge.reportError(entry.pluginId, entry.detail);
      } catch (_e) {}
    }
  }

  function boot(cfg = {}) {
    if (booted) {
      if (hostToken !== null && cfg.hostToken !== hostToken) {
        return { ok: false, reason: 'ERR_KERNEL_ALREADY_BOOTED' };
      }
      return { ok: true, alreadyBooted: true, docGenId, hostProfileId };
    }
    if (typeof cfg.hostToken === 'string' && cfg.hostToken.length >= 16) {
      hostToken = cfg.hostToken;
    }
    docGenId = _Number(cfg.docGenId) || 1;
    hostProfileId = typeof cfg.hostProfileId === 'string' && cfg.hostProfileId ? cfg.hostProfileId : null;
    extraNoTranslateAttributes = _ArrayIsArray(cfg.extraNoTranslateAttributes)
      ? _ArraySlice(cfg.extraNoTranslateAttributes)
      : [];

    // v2.3.0 HostBridgePort: accept direct cfg.hostBridge injection (e.g. Remote Web adapter)
    // OR T-A Option A1 single-claim Electron preload bootstrap (`claim(nonce)`).
    if (cfg.hostBridge !== undefined && cfg.hostBridge !== null) {
      try {
        hostBridge = wrapHostBridgePort(cfg.hostBridge);
      } catch (err) {
        return {
          ok: false,
          reason: err && err.message ? err.message : 'ERR_INVALID_HOST_BRIDGE_PORT',
        };
      }
    } else {
      const bootstrap = win && win.__addonHostBootstrap;
      if (bootstrap && typeof bootstrap.claim === 'function' && cfg.claimNonce) {
        try {
          hostBridge = wrapHostBridgePort(bootstrap.claim(cfg.claimNonce));
        } catch (err) {
          return {
            ok: false,
            reason: err && err.message ? err.message : 'ERR_BRIDGE_CLAIM_FAILED',
          };
        }
      }
    }
    if (!hostProfileId && hostBridge && hostBridge.profileId) {
      hostProfileId = hostBridge.profileId;
    }
    hostSurface =
      cfg.surface === 'remote-web' ||
      (typeof hostProfileId === 'string' && hostProfileId.indexOf('remote') !== -1)
        ? 'remote-web'
        : 'desktop';

    styleManager = createStyleManager(doc);
    slotManager = createSlotManager(doc, {
      uiAnchors: cfg.uiAnchors || {},
      extraNoTranslateAttributes,
      styleManager,
    });
    surfaceGeometry = createSurfaceGeometry(doc, win, {
      uiSurfaces: cfg.uiSurfaces || {},
      uiAnchors: cfg.uiAnchors || {},
    });
    placementEngine = createPlacementEngine(doc, win, {
      surfaceGeometry,
      uiAnchors: cfg.uiAnchors || {},
    });
    const onPortalClaimChange = (claimId, active) => {
      if (hostBridge && typeof hostBridge.setPortalClaim === 'function') {
        try {
          hostBridge.setPortalClaim(claimId, active);
        } catch (_e) {}
      }
    };
    modalPortal = createModalPortal(doc, win, {
      extraNoTranslateAttributes,
      styleManager,
      surfaceGeometry,
      onPortalClaimChange,
    });
    regionObserver = createRegionObserver(doc, win);
    settingsTabs = createSettingsTabCoordinator();
    themeAndI18n = createThemeAndI18n(doc, win);
    toastManager = createToastAndDialogManager(doc, win, {
      themeAndI18n,
      extraNoTranslateAttributes,
      onPortalClaimChange,
    });
    eventBus = createEventBus({ reportPluginError });
    storageV3 = createStorageV3(win);
    serviceBus = createServiceBus({
      onServiceRegistryChange: (serviceName) => {
        if (serviceName === 'host.statusbar' && statusItemRegistry) {
          statusItemRegistry.syncDelegation();
        }
      },
    });
    statusItemRegistry = createStatusItemRegistry(doc, win, {
      serviceBus,
      themeAndI18n,
      extraNoTranslateAttributes,
    });
    settingsPageCoordinator = createSettingsPageCoordinator({
      settingsTabs,
      openTier2Modal: (pMeta, modalOpts) => {
        const ctxRef = _MapGet(pluginV3Contexts, pMeta.pluginId);
        return ctxRef ? ctxRef.ui.openModal(modalOpts) : null;
      },
      openTier3Modal: (pMeta, modalOpts) => {
        const ctxRef = _MapGet(pluginV3Contexts, pMeta.pluginId);
        return ctxRef ? ctxRef.ui.openModal(modalOpts) : null;
      },
    });
    if (
      typeof createHostSettingsUi === 'function' &&
      cfg.settingsUi &&
      typeof cfg.settingsUi === 'object' &&
      hostBridge &&
      typeof hostBridge.getHostAdminState === 'function'
    ) {
      hostSettingsUi = createHostSettingsUi(doc, win, {
        hostBridge,
        settingsUi: cfg.settingsUi,
        extraNoTranslateAttributes,
        settingsPageCoordinator,
      });
      hostSettingsUi.start();
    }
    const hasUiGridMerges = applyUiGridMerges(doc, cfg.uiGridMerges);
    booted = true;
    return {
      ok: true,
      alreadyBooted: false,
      docGenId,
      hostProfileId,
      hasBridge: !!hostBridge,
      hasHostSettingsUi: !!hostSettingsUi,
      hasUiGridMerges,
    };
  }

  function addPluginDisposer(pluginId, fn) {
    if (typeof fn !== 'function') return;
    let set = _MapGet(pluginDisposers, pluginId);
    if (!set) {
      set = new _Set();
      _MapSet(pluginDisposers, pluginId, set);
    }
    _SetAdd(set, fn);
  }

  function disposePluginInternal(pluginId) {
    if (_SetHas(disposingPlugins, pluginId)) {
      return true;
    }
    _SetAdd(disposingPlugins, pluginId);
    try {
      // I10: Run registered onDispose callbacks BEFORE marking handle disposed so cleanup calls (e.g. removeStyle) succeed cleanly
      const set = _MapGet(pluginDisposers, pluginId);
      if (set) {
        const fns = [];
        _SetForEach(set, (fn) => {
          _ArrayPush(fns, fn);
        });
        for (let i = 0; i < fns.length; i++) {
          try {
            fns[i]();
          } catch (err) {
            reportPluginError(pluginId, err && err.message ? err.message : _String(err));
          }
        }
        _SetClear(set);
        _MapDelete(pluginDisposers, pluginId);
      }
      const markers = _MapGet(pluginMarkDisposed, pluginId);
      if (markers) {
        const marks = [];
        _SetForEach(markers, (mark) => {
          _ArrayPush(marks, mark);
        });
        for (let i = 0; i < marks.length; i++) {
          try {
            marks[i]();
          } catch (_e) {}
        }
        _SetClear(markers);
        _MapDelete(pluginMarkDisposed, pluginId);
      }
      if (slotManager) slotManager.disposePluginSlots(pluginId);
      if (styleManager) styleManager.disposePluginStyles(pluginId);
      if (modalPortal) modalPortal.disposePluginPortals(pluginId);
      if (regionObserver) regionObserver.disposePluginObservers(pluginId);
      if (settingsTabs) settingsTabs.disposePluginTabs(pluginId);
      if (toastManager) toastManager.disposePlugin(pluginId);
      if (statusItemRegistry) statusItemRegistry.disposePlugin(pluginId);
      if (settingsPageCoordinator) settingsPageCoordinator.disposePlugin(pluginId);
      if (serviceBus) serviceBus.disposePlugin(pluginId);
      if (eventBus) eventBus.disposePlugin(pluginId);
      if (storageV3) storageV3.disposePlugin(pluginId);
      _MapDelete(pluginV3Contexts, pluginId);
      _MapDelete(pluginActions, pluginId);
      _MapDelete(pluginTrustLevels, pluginId);
      _SetDelete(pluginSettingsAllowed, pluginId);
      _MapDelete(pluginSettingsSnapshots, pluginId);
      _MapDelete(pluginConfigScopes, pluginId);
      const settingsSubs = _MapGet(pluginSettingsListeners, pluginId);
      if (settingsSubs) {
        _SetClear(settingsSubs);
        _MapDelete(pluginSettingsListeners, pluginId);
      }
      return true;
    } finally {
      _SetDelete(disposingPlugins, pluginId);
    }
  }

  function disposePlugin(pluginId, token) {
    assertHostToken(token);
    return disposePluginInternal(pluginId);
  }

  function createPluginHandle(pluginMeta, token, initialSettingsSnapshot = null) {
    assertHostToken(token);
    if (!booted) {
      throw new _Error('ERR_KERNEL_NOT_BOOTED');
    }
    const pluginId = pluginMeta.pluginId;
    const effectiveTrustLevel = pluginMeta.trustLevel || 'restricted';
    const hasSettingsBridge = !!(pluginMeta.hasSettingsBridge && effectiveTrustLevel === 'trusted');
    const scopeMap = new _Map();
    const declaredConfigScopes = [];
    if (pluginMeta.hasConfigBridge && effectiveTrustLevel === 'trusted' && _ArrayIsArray(pluginMeta.configScopes)) {
      for (let i = 0; i < pluginMeta.configScopes.length; i += 1) {
        const s = pluginMeta.configScopes[i];
        if (!s || typeof s.scopeId !== 'string' || !s.scopeId) continue;
        const access = s.access === 'rw' ? 'rw' : 'ro';
        const maxBytes = _NumberIsFinite(s.maxBytes) ? s.maxBytes : 262144;
        const frozenEntry = _ObjectFreeze({
          scopeId: s.scopeId,
          access,
          maxBytes,
        });
        _MapSet(scopeMap, s.scopeId, frozenEntry);
        _ArrayPush(declaredConfigScopes, frozenEntry);
      }
    }
    const frozenConfigScopes = _ObjectFreeze(declaredConfigScopes);
    const hasConfigBridge = frozenConfigScopes.length > 0;
    let disposed = false;

    _MapSet(pluginTrustLevels, pluginId, effectiveTrustLevel);

    if (hasSettingsBridge) {
      _SetAdd(pluginSettingsAllowed, pluginId);
      _MapSet(
        pluginSettingsSnapshots,
        pluginId,
        initialSettingsSnapshot && typeof initialSettingsSnapshot === 'object'
          ? deepFreezeClone(initialSettingsSnapshot)
          : null
      );
    }
    if (hasConfigBridge) {
      _MapSet(pluginConfigScopes, pluginId, scopeMap);
    }

    let markers = _MapGet(pluginMarkDisposed, pluginId);
    if (!markers) {
      markers = new _Set();
      _MapSet(pluginMarkDisposed, pluginId, markers);
    }
    _SetAdd(markers, () => {
      disposed = true;
    });

    const assertActive = () => {
      if (disposed) throw new _Error(`ERR_PLUGIN_HANDLE_DISPOSED:${pluginId}`);
    };

    const registerCommand = (actionId, spec = {}) => {
      assertActive();
      if (!actionId || typeof actionId !== 'string') throw new _Error('ERR_INVALID_ACTION_ID');
      let map = _MapGet(pluginActions, pluginId);
      if (!map) {
        map = new _Map();
        _MapSet(pluginActions, pluginId, map);
      }
      const entry = {
        pluginId,
        actionId,
        label: _String(spec.label || actionId),
        run: typeof spec.run === 'function' ? spec.run : null,
      };
      _MapSet(map, actionId, entry);
      return _ObjectFreeze({
        unregister() {
          _MapDelete(map, actionId);
        },
        dispose() {
          _MapDelete(map, actionId);
        },
      });
    };

    const listCommands = () => {
      assertActive();
      const out = [];
      _MapForEach(pluginActions, (map) => {
        _MapForEach(map, (a) => {
          const ownerTrust = _MapGet(pluginTrustLevels, a.pluginId) || 'restricted';
          if (effectiveTrustLevel !== 'trusted' && ownerTrust === 'trusted' && a.pluginId !== pluginId) {
            return;
          }
          _ArrayPush(out, { pluginId: a.pluginId, actionId: a.actionId, label: a.label });
        });
      });
      return out;
    };

    const invokeCommand = (targetPluginId, actionId, ...args) => {
      assertActive();
      const targetTrust = _MapGet(pluginTrustLevels, targetPluginId) || 'restricted';
      if (effectiveTrustLevel !== 'trusted' && targetTrust === 'trusted' && targetPluginId !== pluginId) {
        throw new _Error(`ERR_ACTION_TRUST_FORBIDDEN:${targetPluginId}:${actionId}`);
      }
      const map = _MapGet(pluginActions, targetPluginId);
      const a = map && _MapGet(map, actionId);
      if (!a || !a.run) throw new _Error(`ERR_ACTION_NOT_FOUND:${targetPluginId}:${actionId}`);
      return _ReflectApply(a.run, undefined, args);
    };

    const readConfigScope = (scopeId) => {
      assertActive();
      if (!hasConfigBridge) {
        return _PromiseReject(new _Error('ERR_CONFIG_BRIDGE_NOT_DECLARED'));
      }
      if (typeof scopeId !== 'string' || !scopeId) {
        return _PromiseReject(new _Error('ERR_INVALID_CONFIG_SCOPE_ID'));
      }
      const boundScopes = _MapGet(pluginConfigScopes, pluginId);
      if (!boundScopes || !_MapHas(boundScopes, scopeId)) {
        return _PromiseReject(new _Error(`ERR_CONFIG_SCOPE_NOT_DECLARED:${scopeId}`));
      }
      if (!hostBridge || typeof hostBridge.readConfigScope !== 'function') {
        return _PromiseReject(new _Error('ERR_CONFIG_BRIDGE_UNAVAILABLE'));
      }
      return _PromiseResolve(hostBridge.readConfigScope(pluginId, scopeId)).then((res) => {
        if (res && typeof res === 'object') {
          return deepFreezeClone(res);
        }
        return _ObjectFreeze({
          ok: false,
          scopeId,
          status: 'error',
          data: null,
          rawText: null,
          sha256: null,
          reason: 'ERR_CONFIG_READ_FAILED',
        });
      });
    };

    const writeConfigScope = (scopeId, nextDataOrRawJson, opts) => {
      assertActive();
      if (!hasConfigBridge) {
        return _PromiseReject(new _Error('ERR_CONFIG_BRIDGE_NOT_DECLARED'));
      }
      if (typeof scopeId !== 'string' || !scopeId) {
        return _PromiseReject(new _Error('ERR_INVALID_CONFIG_SCOPE_ID'));
      }
      const boundScopes = _MapGet(pluginConfigScopes, pluginId);
      const scopeEntry = boundScopes ? _MapGet(boundScopes, scopeId) : null;
      if (!scopeEntry) {
        return _PromiseReject(new _Error(`ERR_CONFIG_SCOPE_NOT_DECLARED:${scopeId}`));
      }
      if (scopeEntry.access !== 'rw') {
        return _PromiseReject(new _Error(`ERR_CONFIG_SCOPE_READ_ONLY:${scopeId}`));
      }
      if (!hostBridge || typeof hostBridge.writeConfigScope !== 'function') {
        return _PromiseReject(new _Error('ERR_CONFIG_BRIDGE_UNAVAILABLE'));
      }
      let rawJson;
      if (typeof nextDataOrRawJson === 'string') {
        rawJson = nextDataOrRawJson;
      } else if (nextDataOrRawJson && typeof nextDataOrRawJson === 'object' && !_ArrayIsArray(nextDataOrRawJson)) {
        try {
          const clean = sanitizeJsonPayload(nextDataOrRawJson);
          rawJson = _JSONStringify(clean);
        } catch (err) {
          const msg = err && err.message ? err.message : 'ERR_CONFIG_INVALID_JSON';
          return _PromiseReject(
            new _Error(
              msg === 'ERR_SETTINGS_UNSAFE_PROTO_KEY'
                ? 'ERR_CONFIG_UNSAFE_PROTO_KEY'
                : msg === 'ERR_SETTINGS_INVALID_JSON'
                  ? 'ERR_CONFIG_INVALID_JSON'
                  : msg
            )
          );
        }
      } else {
        return _PromiseReject(new _Error('ERR_CONFIG_MUST_BE_OBJECT'));
      }
      if (typeof rawJson !== 'string') {
        return _PromiseReject(new _Error('ERR_CONFIG_INVALID_JSON'));
      }
      const forwardOpts = {};
      if (opts && typeof opts === 'object' && _ObjectHasOwn(opts, 'expectedSha256') && opts.expectedSha256 !== undefined) {
        if (opts.expectedSha256 !== null && typeof opts.expectedSha256 !== 'string') {
          return _PromiseReject(new _Error('ERR_INVALID_EXPECTED_SHA256'));
        }
        forwardOpts.expectedSha256 = opts.expectedSha256;
      }
      return _PromiseResolve(hostBridge.writeConfigScope(pluginId, scopeId, rawJson, forwardOpts)).then((res) => {
        if (res && typeof res === 'object') {
          return deepFreezeClone(res);
        }
        return _ObjectFreeze({
          ok: false,
          reason: 'ERR_CONFIG_WRITE_FAILED',
          currentSha256: null,
          snapshot: null,
        });
      });
    };

    const addManagedListenerFn = (target, type, listener, opts) => {
      assertActive();
      if (!target || typeof target.addEventListener !== 'function') {
        throw new _Error('ERR_INVALID_EVENT_TARGET');
      }
      const safeListener = (ev) => {
        if (disposed) return;
        try {
          const ret = listener(ev);
          if (ret && typeof ret.then === 'function') {
            ret.catch((err) => reportPluginError(pluginId, err && err.message ? err.message : _String(err)));
          }
        } catch (err) {
          reportPluginError(pluginId, err && err.message ? err.message : _String(err));
        }
      };
      target.addEventListener(type, safeListener, opts);
      const remove = () => {
        if (typeof target.removeEventListener === 'function') {
          try {
            target.removeEventListener(type, safeListener, opts);
          } catch (_e) {}
        }
      };
      addPluginDisposer(pluginId, remove);
      return remove;
    };

    const runSafeFn = (fn) => {
      if (disposed || typeof fn !== 'function') return undefined;
      try {
        const ret = fn();
        if (ret && typeof ret.then === 'function') {
          return ret.catch((err) => {
            reportPluginError(pluginId, err && err.message ? err.message : _String(err));
            return undefined;
          });
        }
        return ret;
      } catch (err) {
        reportPluginError(pluginId, err && err.message ? err.message : _String(err));
        return undefined;
      }
    };

    const disposeSelfFn = () => {
      if (disposed) return;
      disposePluginInternal(pluginId);
    };

    const isIgnoredFn = (nodeOrEvent, opts = {}) =>
      isElementInsideIgnored(nodeOrEvent, {
        extraNoTranslateAttributes,
        ignoreElements: (opts && opts.ignoreElements) || [],
      });

    const getSettingsFn = () => {
      assertActive();
      if (!hasSettingsBridge) return null;
      return _MapGet(pluginSettingsSnapshots, pluginId) || null;
    };

    const onSettingsChangeFn = (callback) => {
      assertActive();
      if (typeof callback !== 'function') {
        throw new _Error('ERR_INVALID_SETTINGS_CALLBACK');
      }
      if (!hasSettingsBridge) {
        throw new _Error('ERR_SETTINGS_BRIDGE_NOT_DECLARED');
      }
      let subs = _MapGet(pluginSettingsListeners, pluginId);
      if (!subs) {
        subs = new _Set();
        _MapSet(pluginSettingsListeners, pluginId, subs);
      }
      _SetAdd(subs, callback);
      const unsub = () => {
        _SetDelete(subs, callback);
      };
      addPluginDisposer(pluginId, unsub);
      return unsub;
    };

    const saveSettingsFn = (nextData) => {
      assertActive();
      if (!hasSettingsBridge) {
        return _PromiseReject(new _Error('ERR_SETTINGS_BRIDGE_NOT_DECLARED'));
      }
      if (!nextData || typeof nextData !== 'object' || _ArrayIsArray(nextData)) {
        return _PromiseReject(new _Error('ERR_SETTINGS_MUST_BE_OBJECT'));
      }
      if (!hostBridge || typeof hostBridge.saveSettings !== 'function') {
        return _PromiseReject(new _Error('ERR_SETTINGS_SAVE_UNAVAILABLE'));
      }
      let rawJson;
      try {
        const clean = sanitizeJsonPayload(nextData);
        rawJson = _JSONStringify(clean);
      } catch (err) {
        return _PromiseReject(new _Error(err && err.message ? err.message : 'ERR_SETTINGS_INVALID_JSON'));
      }
      if (typeof rawJson !== 'string') {
        return _PromiseReject(new _Error('ERR_SETTINGS_INVALID_JSON'));
      }
      return _PromiseResolve(hostBridge.saveSettings(pluginId, rawJson)).then((res) => {
        if (res && res.ok === true && res.snapshot && typeof res.snapshot === 'object') {
          const frozen = deepFreezeClone(res.snapshot);
          return _ObjectFreeze({ ok: true, reason: null, snapshot: frozen });
        }
        return _ObjectFreeze({
          ok: false,
          reason: (res && res.reason) || 'ERR_SETTINGS_SAVE_FAILED',
          snapshot: null,
        });
      });
    };

    const v3Context = createAddonContextV3({
      doc,
      win,
      pluginMeta,
      surface: hostSurface,
      hostBridge,
      extraNoTranslateAttributes,
      styleManager,
      slotManager,
      surfaceGeometry,
      placementEngine,
      modalPortal,
      regionObserver,
      themeAndI18n,
      toastManager,
      statusItemRegistry,
      settingsPageCoordinator,
      serviceBus,
      eventBus,
      storageV3,
      registerCommand,
      listCommands,
      invokeCommand,
      isElementInsideIgnored: isIgnoredFn,
      readConfigScope,
      writeConfigScope,
      hasConfigBridge,
      frozenConfigScopes,
      hasSettingsBridge,
      getSettings: getSettingsFn,
      onSettingsChange: onSettingsChangeFn,
      saveSettings: saveSettingsFn,
      assertActive,
      addDisposer: (fn) => addPluginDisposer(pluginId, fn),
      disposeSelf: disposeSelfFn,
      runSafe: runSafeFn,
      addManagedListener: addManagedListenerFn,
    });
    _MapSet(pluginV3Contexts, pluginId, v3Context);

    if (pluginMeta.sourceSchemaVersion === 3 || pluginMeta.apiVersion === 3) {
      return v3Context;
    }

    const handle = createV2CompatAdapter(v3Context, {
      hostProfileId,
      hasSettingsBridge,
      hasConfigBridge,
      configScopes: frozenConfigScopes,
      mountSlot(slotId, opts) {
        assertActive();
        return slotManager.mountSlot(pluginMeta, slotId, opts);
      },
      unmountSlot(slotId) {
        assertActive();
        return slotManager.unmountSlot(pluginId, slotId);
      },
      openModal(slotId, opts) {
        assertActive();
        return modalPortal.openModal(pluginMeta, slotId, opts);
      },
      openPopover(slotId, opts) {
        assertActive();
        return modalPortal.openPopover(pluginMeta, slotId, opts);
      },
      observeRegion(selector, callback, opts) {
        assertActive();
        return regionObserver.observeRegion(pluginId, selector, callback, opts);
      },
      registerSettingsTab(tabId, opts) {
        assertActive();
        return settingsTabs.registerSettingsTab(pluginId, tabId, opts);
      },
      isElementInsideIgnored: isIgnoredFn,
      getSettings: getSettingsFn,
      onSettingsChange: onSettingsChangeFn,
      saveSettings: saveSettingsFn,
      readConfigScope,
      writeConfigScope,
    });

    return handle;
  }

  function stagePluginHandle(pluginMeta, token, initialSettingsSnapshot = null) {
    assertHostToken(token);
    const handle = createPluginHandle(pluginMeta, token, initialSettingsSnapshot);
    const runNonce = generateRunNonce();
    _MapSet(stagedHandles, runNonce, { pluginId: pluginMeta.pluginId, handle });
    return { ok: true, runNonce };
  }

  function pushPluginSettings(pluginId, snapshot, token) {
    assertHostToken(token);
    if (!booted) {
      return { ok: false, reason: 'ERR_KERNEL_NOT_BOOTED', delivered: 0 };
    }
    if (!_SetHas(pluginSettingsAllowed, pluginId)) {
      return { ok: false, reason: 'ERR_SETTINGS_BRIDGE_NOT_BOUND', delivered: 0 };
    }
    const frozen = snapshot && typeof snapshot === 'object' ? deepFreezeClone(snapshot) : null;
    _MapSet(pluginSettingsSnapshots, pluginId, frozen);
    const subs = _MapGet(pluginSettingsListeners, pluginId);
    if (!subs || _SetSize(subs) === 0) {
      return { ok: true, delivered: 0 };
    }
    const cbs = [];
    _SetForEach(subs, (cb) => {
      _ArrayPush(cbs, cb);
    });
    let delivered = 0;
    for (let i = 0; i < cbs.length; i++) {
      delivered += 1;
      try {
        const ret = cbs[i](frozen);
        if (ret && typeof ret.then === 'function') {
          ret.catch((err) => reportPluginError(pluginId, err && err.message ? err.message : _String(err)));
        }
      } catch (err) {
        reportPluginError(pluginId, err && err.message ? err.message : _String(err));
      }
    }
    return { ok: true, delivered };
  }

  function consumeStagedHandle(runNonce) {
    if (typeof runNonce !== 'string' || !_MapHas(stagedHandles, runNonce)) {
      throw new _Error('ERR_INVALID_OR_CONSUMED_RUN_NONCE');
    }
    const entry = _MapGet(stagedHandles, runNonce);
    _MapDelete(stagedHandles, runNonce);
    return entry.handle;
  }

  function clearStagedHandle(runNonce, token) {
    assertHostToken(token);
    if (typeof runNonce !== 'string') return false;
    return _MapDelete(stagedHandles, runNonce);
  }

  function selectSettingsTab(pluginId, tabId, token) {
    assertHostToken(token);
    if (!booted || !settingsTabs || typeof settingsTabs.selectTab !== 'function') {
      return { ok: false, reason: 'ERR_KERNEL_NOT_BOOTED' };
    }
    const res = settingsTabs.selectTab(pluginId, tabId);
    if (res && res.ok === false && res.reason === 'ERR_SETTINGS_TAB_SELECT_FAILED') {
      reportPluginError(pluginId, res.error || res.reason);
    } else if (res && res.ok === true && res.result && typeof res.result.then === 'function') {
      res.result.catch((err) => reportPluginError(pluginId, err && err.message ? err.message : _String(err)));
    }
    return res;
  }

  function listHostActions(token) {
    assertHostToken(token);
    const out = [];
    _MapForEach(pluginActions, (map) => {
      _MapForEach(map, (a) => {
        _ArrayPush(out, {
          pluginId: a.pluginId,
          actionId: a.actionId,
          label: a.label,
          runnable: typeof a.run === 'function',
        });
      });
    });
    return out;
  }

  function invokeHostAction(targetPluginId, actionId, args, token) {
    assertHostToken(token);
    if (typeof targetPluginId !== 'string' || !targetPluginId || typeof actionId !== 'string' || !actionId) {
      return { ok: false, reason: 'ERR_ACTION_NOT_FOUND' };
    }
    const map = _MapGet(pluginActions, targetPluginId);
    const a = map && _MapGet(map, actionId);
    if (!a || typeof a.run !== 'function') {
      return { ok: false, reason: `ERR_ACTION_NOT_FOUND:${targetPluginId}:${actionId}` };
    }
    try {
      const result = _ReflectApply(a.run, undefined, _ArrayIsArray(args) ? args : []);
      if (result && typeof result.then === 'function') {
        result.catch((err) => reportPluginError(targetPluginId, err && err.message ? err.message : _String(err)));
      }
      return { ok: true, reason: null, result };
    } catch (err) {
      const detail = err && err.message ? err.message : _String(err);
      reportPluginError(targetPluginId, detail);
      return { ok: false, reason: 'ERR_ACTION_EXEC_FAILED', error: detail };
    }
  }

  const api = _ObjectFreeze({
    boot,
    createPluginHandle,
    stagePluginHandle,
    pushPluginSettings,
    consumeStagedHandle,
    clearStagedHandle,
    disposePlugin,
    reportPluginError,
    getErrors: () => _ArraySlice(recordedErrors),
    getBridgeStatus: () => ({ booted, docGenId, hostProfileId, surface: hostSurface, hasBridge: !!hostBridge }),
    listSettingsTabs: () => (settingsTabs ? settingsTabs.listTabs() : []),
    selectSettingsTab,
    listSettingsPages: () => (settingsPageCoordinator ? settingsPageCoordinator.listSettingsPages() : []),
    openSettingsPage: (pid, pageId, token) => {
      assertHostToken(token);
      return settingsPageCoordinator ? settingsPageCoordinator.openSettingsPage(pid, pageId) : { ok: false, reason: 'ERR_KERNEL_NOT_BOOTED' };
    },
    listStatusItems: () => (statusItemRegistry ? statusItemRegistry.listStatusItems() : []),
    invokeStatusItem: (pid, itemId, clickEv, token) => {
      assertHostToken(token);
      return statusItemRegistry ? statusItemRegistry.invokeStatusItem(pid, itemId, clickEv) : { ok: false, reason: 'ERR_KERNEL_NOT_BOOTED' };
    },
    listHostActions,
    invokeHostAction,
    getSurfaceBounds: (surfaceIdOrOpts) => (surfaceGeometry ? surfaceGeometry.getSurfaceBounds(surfaceIdOrOpts) : null),
    getActiveSurface: () => (surfaceGeometry ? surfaceGeometry.getActiveSurface() : null),
    listSurfaces: () => (surfaceGeometry ? surfaceGeometry.listSurfaces() : _ObjectFreeze(['viewport'])),
  });

  return api;
}

if (typeof globalThis !== 'undefined' && typeof globalThis.document !== 'undefined') {
  if (!globalThis.__addonHostKernel) {
    Object.defineProperty(globalThis, '__addonHostKernel', {
      value: createRendererKernel(globalThis.document, globalThis.window || globalThis),
      writable: false,
      configurable: false,
      enumerable: false,
    });
  }
}

module.exports = {
  createRendererKernel,
  UI_GRID_MERGE_STYLE_ATTR,
  isSafeGridMergeSelector,
  buildUiGridMergeCss,
  applyUiGridMerges,
};

  }
  };
  const __cache = Object.create(null);
  function __req(id) {
    const key = id.endsWith('.js') ? id : id + '.js';
    if (__cache[key]) return __cache[key].exports;
    const fn = __mods[key];
    if (!fn) throw new Error('ERR_KERNEL_BUNDLE_MISSING_MOD:' + key);
    const mod = { exports: {} };
    __cache[key] = mod;
    fn(mod, mod.exports, __req);
    return mod.exports;
  }
  const kernelMod = __req('./kernel.js');
  if (typeof globalThis !== 'undefined' && typeof globalThis.document !== 'undefined') {
    if (!globalThis.__addonHostKernel) {
      Object.defineProperty(globalThis, '__addonHostKernel', {
        value: kernelMod.createRendererKernel(globalThis.document, globalThis.window || globalThis),
        writable: false,
        configurable: false,
        enumerable: false,
      });
    }
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = kernelMod;
  }
})();
