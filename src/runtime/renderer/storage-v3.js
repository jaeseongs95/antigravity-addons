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
