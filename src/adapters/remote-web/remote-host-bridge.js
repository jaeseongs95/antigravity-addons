'use strict';

/**
 * Remote Web HostBridgePort Adapter (v2.3.0 — LSP / DIP / ISP).
 *
 * Implements the exact `src/runtime/renderer/host-bridge-port.js` contract:
 * - Required: `setPortalClaim`, `saveSettings`, `reportError`, `ping`
 * - Optional: `readConfigScope`, `writeConfigScope`
 * - Meta: `docGenId`, `profileId`
 *
 * Phase 1 persistence: browser-local namespaced StoragePort (`localStorage` fallback)
 * with strict prototype-pollution rejection, byte budget enforcement, secret redaction,
 * and instant snapshot delivery hook (`onSettingsSaved`).
 *
 * Phase 2 extension point (OCP): optional `remoteTransport` may provide authenticated
 * remote `saveSettings`, `readConfigScope`, and `writeConfigScope` without modifying
 * callers or kernel code.
 */

const { evaluateNetRequest, isPublicFqdnHost, normalizeHostName } = require('../../core/net-policy');

const DEFAULT_MAX_SETTINGS_BYTES = 65536;
const MIN_SETTINGS_BYTES = 1024;
const MAX_SETTINGS_BYTES = 262144;
const MAX_RECORDED_ERRORS = 200;
const MAX_USER_ALLOWED_HTTPS_HOSTS = 16;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

const SECRET_PATTERNS = Object.freeze([
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /\bAIza[0-9A-Za-z\-_]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bsk-[A-Za-z0-9\-_]{16,}\b/g,
]);

function redactSecrets(text) {
  let out = String(text === undefined || text === null ? '' : text);
  for (let i = 0; i < SECRET_PATTERNS.length; i += 1) {
    out = out.replace(SECRET_PATTERNS[i], '[REDACTED]');
  }
  return out;
}

function utf8ByteLength(str) {
  const s = String(str || '');
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(s).length;
  }
  if (typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') {
    return Buffer.byteLength(s, 'utf8');
  }
  return unescape(encodeURIComponent(s)).length;
}

function hasDangerousProtoKey(value) {
  if (!value || typeof value !== 'object') return false;
  const stack = [value];
  const seen = new Set();
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur)) {
      for (let i = 0; i < cur.length; i += 1) {
        if (cur[i] && typeof cur[i] === 'object') stack.push(cur[i]);
      }
    } else {
      const keys = Object.keys(cur);
      for (let i = 0; i < keys.length; i += 1) {
        if (DANGEROUS_KEYS.has(keys[i])) return true;
        const v = cur[keys[i]];
        if (v && typeof v === 'object') stack.push(v);
      }
    }
  }
  return false;
}

function parseSafeJsonObject(rawJson) {
  if (typeof rawJson !== 'string') {
    return { ok: false, reason: 'ERR_SETTINGS_INVALID_JSON', data: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch (_err) {
    return { ok: false, reason: 'ERR_SETTINGS_INVALID_JSON', data: null };
  }
  if (hasDangerousProtoKey(parsed)) {
    return { ok: false, reason: 'ERR_SETTINGS_UNSAFE_PROTO_KEY', data: null };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'ERR_SETTINGS_MUST_BE_OBJECT', data: null };
  }
  return { ok: true, reason: null, data: parsed };
}

/**
 * Deterministic 64-hex-char fingerprint for browser-local snapshots when synchronous
 * Node crypto is unavailable (zero external deps, pure JS).
 */
function deterministicHexDigest(text) {
  const s = String(text || '');
  const seeds = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f, 0x165667b1, 0xd3a2646c];
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    for (let k = 0; k < seeds.length; k += 1) {
      let h = seeds[k] ^ (c + ((i + 1) * (k + 3)));
      h = Math.imul(h, 0x01000193) >>> 0;
      seeds[k] = ((h << ((k % 7) + 1)) | (h >>> (32 - ((k % 7) + 1)))) >>> 0;
    }
  }
  return seeds.map((n) => n.toString(16).padStart(8, '0')).join('');
}

function clampMaxBytes(raw) {
  if (!Number.isInteger(raw)) return DEFAULT_MAX_SETTINGS_BYTES;
  if (raw < MIN_SETTINGS_BYTES) return MIN_SETTINGS_BYTES;
  if (raw > MAX_SETTINGS_BYTES) return MAX_SETTINGS_BYTES;
  return raw;
}

function createMemoryStorageFallback() {
  const map = new Map();
  return {
    getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      map.set(String(k), String(v));
    },
    removeItem(k) {
      map.delete(String(k));
    },
  };
}

function detectSyncGmApi(win) {
  const getFn =
    (win && typeof win.GM_getValue === 'function' && win.GM_getValue) ||
    (typeof globalThis !== 'undefined' && typeof globalThis.GM_getValue === 'function' && globalThis.GM_getValue) ||
    (typeof GM_getValue === 'function' ? GM_getValue : null);
  const setFn =
    (win && typeof win.GM_setValue === 'function' && win.GM_setValue) ||
    (typeof globalThis !== 'undefined' && typeof globalThis.GM_setValue === 'function' && globalThis.GM_setValue) ||
    (typeof GM_setValue === 'function' ? GM_setValue : null);
  const delFn =
    (win && typeof win.GM_deleteValue === 'function' && win.GM_deleteValue) ||
    (typeof globalThis !== 'undefined' && typeof globalThis.GM_deleteValue === 'function' && globalThis.GM_deleteValue) ||
    (typeof GM_deleteValue === 'function' ? GM_deleteValue : null);

  if (typeof getFn === 'function' && typeof setFn === 'function') {
    return { getFn, setFn, delFn };
  }
  return null;
}

function detectAsyncGmApi(win) {
  const gmObj =
    (win && win.GM && typeof win.GM === 'object' && win.GM) ||
    (typeof globalThis !== 'undefined' && globalThis.GM && typeof globalThis.GM === 'object' && globalThis.GM) ||
    (typeof GM !== 'undefined' && GM && typeof GM === 'object' ? GM : null);
  if (gmObj && typeof gmObj.getValue === 'function' && typeof gmObj.setValue === 'function') {
    return gmObj;
  }
  return null;
}

function createGmSyncStorageAdapter({ getFn, setFn, delFn }) {
  return {
    getItem(k) {
      const val = getFn(String(k), null);
      if (val === undefined || val === null) return null;
      return typeof val === 'string' ? val : String(val);
    },
    setItem(k, v) {
      setFn(String(k), String(v));
    },
    removeItem(k) {
      if (typeof delFn === 'function') {
        delFn(String(k));
      } else {
        setFn(String(k), null);
      }
    },
  };
}

function createGmAsyncStorageAdapter(gmObj) {
  const cache = new Map();
  return {
    async hydrateKey(k) {
      const key = String(k);
      try {
        const val = await gmObj.getValue(key, null);
        if (val === undefined || val === null) {
          cache.delete(key);
          return null;
        }
        const strVal = typeof val === 'string' ? val : String(val);
        cache.set(key, strVal);
        return strVal;
      } catch (_err) {
        return null;
      }
    },
    getItem(k) {
      const key = String(k);
      return cache.has(key) ? cache.get(key) : null;
    },
    setItem(k, v) {
      const key = String(k);
      const val = String(v);
      cache.set(key, val);
      try {
        const ret = gmObj.setValue(key, val);
        if (ret && typeof ret.catch === 'function') {
          ret.catch(() => {});
        }
      } catch (_err) {
        // Keep in-memory cache coherent if async write rejects.
      }
    },
    removeItem(k) {
      const key = String(k);
      cache.delete(key);
      try {
        const ret =
          typeof gmObj.deleteValue === 'function' ? gmObj.deleteValue(key) : gmObj.setValue(key, null);
        if (ret && typeof ret.catch === 'function') {
          ret.catch(() => {});
        }
      } catch (_err) {
        // Best-effort async delete.
      }
    },
  };
}

function resolveStorage(storage, win) {
  if (storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function') {
    return { store: storage, kind: 'injected' };
  }
  try {
    const syncGm = detectSyncGmApi(win);
    if (syncGm) {
      return { store: createGmSyncStorageAdapter(syncGm), kind: 'gm-sync' };
    }
  } catch (_err) {
    // Fall through if GM_* probe fails.
  }
  try {
    const asyncGm = detectAsyncGmApi(win);
    if (asyncGm) {
      return { store: createGmAsyncStorageAdapter(asyncGm), kind: 'gm-async' };
    }
  } catch (_err) {
    // Fall through if GM.* probe fails.
  }
  try {
    if (win && win.localStorage && typeof win.localStorage.getItem === 'function') {
      return { store: win.localStorage, kind: 'localStorage' };
    }
  } catch (_err) {
    // Storage access may be restricted by browser privacy settings; fall back explicitly.
  }
  return { store: createMemoryStorageFallback(), kind: 'memory-ephemeral' };
}

function createRemoteHostBridge({
  doc = null,
  win = null,
  docGenId = 1,
  profileId = 'remote-web',
  storageNamespace = 'remote-addon-host:v2',
  storage = null,
  remoteTransport = null,
  netTransport = null,
  forbiddenNetHosts = [],
  settingsBindings = null,
  netBindings = null,
  configScopeSnapshots = null,
  onSettingsSaved = null,
  onError = null,
  onPortalClaimsChanged = null,
} = {}) {
  const resolved = resolveStorage(storage, win);
  const store = resolved.store;
  const storageKind = resolved.kind;

  const activePortalClaims = new Set();
  const recordedErrors = [];
  const allowedSettings = new Map(); // pluginId -> { maxBytes, revision }
  const allowedNet = new Map(); // pluginId -> { httpsHosts: string[], userApprovedHttps: boolean, localLoopback: Array<number|string> }
  const packedConfigScopes = new Map(); // `${pluginId}:${scopeId}` -> snapshot

  function isRemoteTransportConnected() {
    if (!remoteTransport) return false;
    if (typeof remoteTransport.isConnected === 'function') {
      return Boolean(remoteTransport.isConnected());
    }
    return true;
  }

  function getRemoteBridgeStatus() {
    if (remoteTransport && typeof remoteTransport.getStatus === 'function') {
      return remoteTransport.getStatus();
    }
    return Object.freeze({
      configured: Boolean(remoteTransport),
      connected: isRemoteTransportConnected(),
      baseUrl: null,
      hostVersion: null,
      buildSha8: null,
      activePlugins: [],
      lastCheckedAt: null,
      lastError: null,
    });
  }

  if (netBindings && typeof netBindings === 'object') {
    const entries = netBindings instanceof Map ? Array.from(netBindings.entries()) : Object.entries(netBindings);
    for (let i = 0; i < entries.length; i += 1) {
      const [pid, spec] = entries[i];
      if (typeof pid === 'string' && PLUGIN_ID_RE.test(pid) && spec && typeof spec === 'object') {
        const hosts = Array.isArray(spec.httpsHosts) ? spec.httpsHosts.slice() : [];
        const userApprovedHttps = spec.userApprovedHttps === true;
        const localLoopback = Array.isArray(spec.localLoopback) ? spec.localLoopback.slice() : [];
        if (hosts.length > 0 || userApprovedHttps || localLoopback.length > 0) {
          allowedNet.set(pid, { httpsHosts: hosts, userApprovedHttps, localLoopback });
        }
      }
    }
  }

  if (settingsBindings && typeof settingsBindings === 'object') {
    const entries = settingsBindings instanceof Map ? Array.from(settingsBindings.entries()) : Object.entries(settingsBindings);
    for (let i = 0; i < entries.length; i += 1) {
      const [pid, spec] = entries[i];
      if (typeof pid === 'string' && PLUGIN_ID_RE.test(pid) && spec) {
        allowedSettings.set(pid, {
          maxBytes: clampMaxBytes(spec.maxBytes),
          revision: Number.isInteger(spec.revision) && spec.revision >= 0 ? spec.revision : 0,
        });
      }
    }
  }

  if (configScopeSnapshots && typeof configScopeSnapshots === 'object') {
    const entries =
      configScopeSnapshots instanceof Map
        ? Array.from(configScopeSnapshots.entries())
        : Object.entries(configScopeSnapshots);
    for (let i = 0; i < entries.length; i += 1) {
      const [key, snap] = entries[i];
      if (typeof key === 'string' && snap && typeof snap === 'object') {
        packedConfigScopes.set(key, snap);
      }
    }
  }

  function storageKeyFor(pluginId) {
    return `${storageNamespace}:settings:${pluginId}`;
  }

  function userHttpsHostsStorageKey() {
    return `${storageNamespace}:__host__:user-allowed-https-hosts`;
  }

  function getForbiddenHostsList() {
    return Array.isArray(forbiddenNetHosts) ? forbiddenNetHosts : [];
  }

  function parseUserAllowedHttpsHostInput(rawInput) {
    if (typeof rawInput !== 'string' || !rawInput.trim()) {
      return { ok: false, reason: 'ERR_NET_INVALID_URL' };
    }
    const trimmed = rawInput.trim();
    let candidateHost = '';
    if (trimmed.includes('://')) {
      let parsed;
      try {
        parsed = new URL(trimmed);
      } catch (_err) {
        return { ok: false, reason: 'ERR_NET_INVALID_URL' };
      }
      if (parsed.protocol !== 'https:') {
        return { ok: false, reason: 'ERR_NET_HTTPS_REQUIRED' };
      }
      if (parsed.username || parsed.password) {
        return { ok: false, reason: 'ERR_NET_CREDENTIALS_IN_URL_FORBIDDEN' };
      }
      const port = parsed.port ? Number(parsed.port) : 443;
      if (!Number.isInteger(port) || port !== 443) {
        return { ok: false, reason: 'ERR_NET_NON_STANDARD_HTTPS_PORT_FORBIDDEN' };
      }
      candidateHost = normalizeHostName(parsed.hostname);
    } else {
      if (/\s/.test(trimmed) || trimmed.includes('/') || trimmed.includes(':') || trimmed.includes('@') || trimmed.includes('*')) {
        return { ok: false, reason: 'ERR_NET_HOST_FORBIDDEN' };
      }
      candidateHost = normalizeHostName(trimmed);
    }
    if (!isPublicFqdnHost(candidateHost, { forbiddenHosts: getForbiddenHostsList() })) {
      return { ok: false, reason: `ERR_NET_HOST_FORBIDDEN:${candidateHost || trimmed}` };
    }
    return { ok: true, host: candidateHost };
  }

  function loadAllUserAllowedHttpsHostsMap() {
    const out = Object.create(null);
    try {
      const raw = store.getItem(userHttpsHostsStorageKey());
      if (!raw) return out;
      const parsed = parseSafeJsonObject(raw);
      if (!parsed.ok || !parsed.data) return out;
      const forbidden = getForbiddenHostsList();
      const keys = Object.keys(parsed.data);
      for (let i = 0; i < keys.length; i += 1) {
        const pid = keys[i];
        if (!PLUGIN_ID_RE.test(pid)) continue;
        const list = parsed.data[pid];
        if (!Array.isArray(list)) continue;
        const seen = new Set();
        const clean = [];
        for (let j = 0; j < list.length && clean.length < MAX_USER_ALLOWED_HTTPS_HOSTS; j += 1) {
          const h = normalizeHostName(list[j]);
          if (h && !seen.has(h) && isPublicFqdnHost(h, { forbiddenHosts: forbidden })) {
            seen.add(h);
            clean.push(h);
          }
        }
        if (clean.length > 0) {
          out[pid] = clean.sort();
        }
      }
    } catch (_err) {}
    return out;
  }

  function persistAllUserAllowedHttpsHostsMap(mapObj) {
    try {
      store.setItem(userHttpsHostsStorageKey(), JSON.stringify(mapObj));
      return true;
    } catch (err) {
      recordErrorInternal('remote-host-bridge', `user_https_hosts_save_failed: ${err && err.message ? err.message : String(err)}`);
      return false;
    }
  }

  async function hydrateUserAllowedHttpsHosts() {
    if (store && typeof store.hydrateKey === 'function') {
      try {
        await store.hydrateKey(userHttpsHostsStorageKey());
      } catch (_err) {}
    }
    return loadAllUserAllowedHttpsHostsMap();
  }

  function listUserAllowedHttpsHosts(pluginId) {
    if (typeof pluginId !== 'string' || !PLUGIN_ID_RE.test(pluginId)) return [];
    const mapObj = loadAllUserAllowedHttpsHostsMap();
    return Array.isArray(mapObj[pluginId]) ? mapObj[pluginId].slice() : [];
  }

  function addUserAllowedHttpsHost(pluginId, rawHostOrUrl) {
    if (typeof pluginId !== 'string' || !PLUGIN_ID_RE.test(pluginId)) {
      return { ok: false, reason: 'ERR_INVALID_PLUGIN_ID', hosts: [] };
    }
    const check = parseUserAllowedHttpsHostInput(rawHostOrUrl);
    if (!check.ok) {
      return { ok: false, reason: check.reason, hosts: listUserAllowedHttpsHosts(pluginId) };
    }
    const mapObj = loadAllUserAllowedHttpsHostsMap();
    const current = Array.isArray(mapObj[pluginId]) ? mapObj[pluginId].slice() : [];
    if (!current.includes(check.host)) {
      if (current.length >= MAX_USER_ALLOWED_HTTPS_HOSTS) {
        return { ok: false, reason: 'ERR_NET_USER_HTTPS_HOST_LIMIT_EXCEEDED', hosts: current };
      }
      current.push(check.host);
      current.sort();
    }
    mapObj[pluginId] = current;
    if (!persistAllUserAllowedHttpsHostsMap(mapObj)) {
      return { ok: false, reason: 'ERR_SETTINGS_STORAGE_WRITE_FAILED', hosts: listUserAllowedHttpsHosts(pluginId) };
    }
    return { ok: true, host: check.host, hosts: current.slice() };
  }

  function removeUserAllowedHttpsHost(pluginId, rawHost) {
    if (typeof pluginId !== 'string' || !PLUGIN_ID_RE.test(pluginId)) {
      return { ok: false, reason: 'ERR_INVALID_PLUGIN_ID', hosts: [] };
    }
    const norm = normalizeHostName(rawHost);
    const mapObj = loadAllUserAllowedHttpsHostsMap();
    const current = Array.isArray(mapObj[pluginId]) ? mapObj[pluginId] : [];
    const next = current.filter((h) => h !== norm);
    if (next.length > 0) {
      mapObj[pluginId] = next;
    } else {
      delete mapObj[pluginId];
    }
    if (!persistAllUserAllowedHttpsHostsMap(mapObj)) {
      return { ok: false, reason: 'ERR_SETTINGS_STORAGE_WRITE_FAILED', hosts: current.slice() };
    }
    return { ok: true, hosts: next.slice() };
  }

  function bindSettingsPlugin(pluginId, spec = {}) {
    if (typeof pluginId !== 'string' || !PLUGIN_ID_RE.test(pluginId)) {
      return false;
    }
    const existing = allowedSettings.get(pluginId);
    allowedSettings.set(pluginId, {
      maxBytes: clampMaxBytes(spec && spec.maxBytes),
      revision: existing ? existing.revision : Number.isInteger(spec && spec.revision) ? spec.revision : 0,
    });
    return true;
  }

  async function hydrateSettings(pluginId) {
    if (typeof pluginId !== 'string' || !PLUGIN_ID_RE.test(pluginId)) return null;
    if (remoteTransport && typeof remoteTransport.readSettings === 'function' && isRemoteTransportConnected()) {
      try {
        const remoteRes = await remoteTransport.readSettings(pluginId);
        if (remoteRes && remoteRes.ok === true && remoteRes.snapshot && typeof remoteRes.snapshot === 'object') {
          if (remoteRes.snapshot.status === 'ok' && remoteRes.snapshot.data) {
            try {
              store.setItem(storageKeyFor(pluginId), JSON.stringify(remoteRes.snapshot));
            } catch (_cacheErr) {}
          }
          return remoteRes.snapshot;
        }
      } catch (_remoteErr) {}
    }
    if (store && typeof store.hydrateKey === 'function') {
      await store.hydrateKey(storageKeyFor(pluginId));
    }
    return loadPersistedSettings(pluginId);
  }

  function loadPersistedSettings(pluginId) {
    if (typeof pluginId !== 'string' || !PLUGIN_ID_RE.test(pluginId)) return null;
    try {
      const raw = store.getItem(storageKeyFor(pluginId));
      if (!raw) return null;
      const parsed = parseSafeJsonObject(raw);
      if (!parsed.ok || !parsed.data) return null;
      const rec = parsed.data;
      if (!rec.data || typeof rec.data !== 'object' || Array.isArray(rec.data)) return null;
      const binding = allowedSettings.get(pluginId);
      const rev = Number.isInteger(rec.revision) && rec.revision >= 1 ? rec.revision : 1;
      if (binding && rev > binding.revision) {
        binding.revision = rev;
      }
      return {
        status: 'ok',
        data: rec.data,
        sha256: typeof rec.sha256 === 'string' ? rec.sha256 : deterministicHexDigest(JSON.stringify(rec.data)),
        reason: null,
        revision: rev,
        updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : new Date().toISOString(),
        persistence: storageKind,
      };
    } catch (err) {
      recordErrorInternal(pluginId, `settings_restore_failed: ${err && err.message ? err.message : String(err)}`);
      return null;
    }
  }

  function syncPortalAttribute() {
    if (!doc || !doc.documentElement || typeof doc.documentElement.setAttribute !== 'function') {
      return;
    }
    if (activePortalClaims.size > 0) {
      doc.documentElement.setAttribute('data-remote-addon-host-portal-claims', String(activePortalClaims.size));
    } else if (typeof doc.documentElement.removeAttribute === 'function') {
      doc.documentElement.removeAttribute('data-remote-addon-host-portal-claims');
    }
  }

  function recordErrorInternal(pluginId, detail) {
    const entry = Object.freeze({
      ts: new Date().toISOString(),
      pluginId: String(pluginId || 'unknown').slice(0, 128),
      detail: redactSecrets(detail).slice(0, 2048),
    });
    recordedErrors.push(entry);
    if (recordedErrors.length > MAX_RECORDED_ERRORS) {
      recordedErrors.shift();
    }
    if (typeof onError === 'function') {
      try {
        onError(entry);
      } catch (_cbErr) {
        // Diagnostic callback failure must not disrupt bridge execution.
      }
    }
    return entry;
  }

  function setPortalClaim(claimId, active) {
    const key = String(claimId || '').trim();
    if (!key) {
      return { ok: false, reason: 'ERR_INVALID_PORTAL_CLAIM_ID', claimCount: activePortalClaims.size };
    }
    if (active) {
      activePortalClaims.add(key);
    } else {
      activePortalClaims.delete(key);
    }
    syncPortalAttribute();
    if (typeof onPortalClaimsChanged === 'function') {
      try {
        onPortalClaimsChanged(Array.from(activePortalClaims));
      } catch (err) {
        recordErrorInternal('remote-host-bridge', `portal_claim_listener_failed: ${err && err.message ? err.message : String(err)}`);
      }
    }
    return { ok: true, claimCount: activePortalClaims.size };
  }

  function saveSettings(pluginId, rawJson) {
    if (typeof pluginId !== 'string' || !PLUGIN_ID_RE.test(pluginId)) {
      return Promise.resolve({ ok: false, reason: 'ERR_INVALID_PLUGIN_ID', snapshot: null });
    }
    const binding = allowedSettings.get(pluginId);
    if (!binding) {
      return Promise.resolve({ ok: false, reason: 'ERR_SETTINGS_BRIDGE_NOT_BOUND', snapshot: null });
    }
    if (typeof rawJson !== 'string') {
      return Promise.resolve({ ok: false, reason: 'ERR_SETTINGS_INVALID_JSON', snapshot: null });
    }
    if (utf8ByteLength(rawJson) > binding.maxBytes) {
      return Promise.resolve({ ok: false, reason: 'ERR_SETTINGS_FILE_TOO_LARGE', snapshot: null });
    }
    const parsed = parseSafeJsonObject(rawJson);
    if (!parsed.ok) {
      return Promise.resolve({ ok: false, reason: parsed.reason, snapshot: null });
    }

    if (remoteTransport && typeof remoteTransport.saveSettings === 'function' && isRemoteTransportConnected()) {
      return Promise.resolve()
        .then(() => remoteTransport.saveSettings(pluginId, rawJson))
        .then((res) => {
          if (res && res.ok === true && res.snapshot && typeof res.snapshot === 'object') {
            try {
              store.setItem(storageKeyFor(pluginId), JSON.stringify(res.snapshot));
            } catch (_cacheErr) {}
            if (typeof onSettingsSaved === 'function') {
              onSettingsSaved(pluginId, res.snapshot);
            }
            return { ok: true, reason: null, snapshot: res.snapshot };
          }
          return {
            ok: false,
            reason: (res && res.reason) || 'ERR_REMOTE_SETTINGS_SAVE_FAILED',
            snapshot: null,
          };
        })
        .catch((err) => {
          recordErrorInternal(pluginId, `remote_save_settings_failed: ${err && err.message ? err.message : String(err)}`);
          return { ok: false, reason: 'ERR_REMOTE_SETTINGS_SAVE_FAILED', snapshot: null };
        });
    }

    const canonical = JSON.stringify(parsed.data);
    if (utf8ByteLength(canonical) > binding.maxBytes) {
      return Promise.resolve({ ok: false, reason: 'ERR_SETTINGS_FILE_TOO_LARGE', snapshot: null });
    }

    binding.revision += 1;
    const snapshot = {
      status: 'ok',
      data: parsed.data,
      sha256: deterministicHexDigest(canonical),
      reason: null,
      revision: binding.revision,
      updatedAt: new Date().toISOString(),
      persistence: storageKind,
    };

    try {
      store.setItem(storageKeyFor(pluginId), JSON.stringify(snapshot));
    } catch (err) {
      recordErrorInternal(pluginId, `local_storage_write_failed: ${err && err.message ? err.message : String(err)}`);
      return Promise.resolve({ ok: false, reason: 'ERR_SETTINGS_STORAGE_WRITE_FAILED', snapshot: null });
    }

    if (typeof onSettingsSaved === 'function') {
      try {
        onSettingsSaved(pluginId, snapshot);
      } catch (err) {
        recordErrorInternal(pluginId, `on_settings_saved_failed: ${err && err.message ? err.message : String(err)}`);
      }
    }

    return Promise.resolve({ ok: true, reason: null, snapshot });
  }

  function reportError(pluginId, detail) {
    recordErrorInternal(pluginId, detail);
  }

  function ping() {
    return Promise.resolve({
      ok: true,
      docGenId: Number(docGenId) || 1,
      profileId: String(profileId || 'remote-web'),
      mode: isRemoteTransportConnected() ? 'remote-sync' : 'browser-local',
      storageKind,
      remoteBridge: getRemoteBridgeStatus(),
    });
  }

  function readConfigScope(pluginId, scopeId) {
    if (remoteTransport && typeof remoteTransport.readConfigScope === 'function' && isRemoteTransportConnected()) {
      return Promise.resolve()
        .then(() => remoteTransport.readConfigScope(pluginId, scopeId))
        .catch((err) => {
          recordErrorInternal(pluginId, `read_config_scope_failed:${scopeId}: ${err && err.message ? err.message : String(err)}`);
          return {
            ok: false,
            scopeId: String(scopeId || ''),
            status: 'error',
            data: null,
            rawText: null,
            sha256: null,
            reason: 'ERR_REMOTE_CONFIG_READ_FAILED',
          };
        });
    }

    const packedKey = `${pluginId}:${scopeId}`;
    if (packedConfigScopes.has(packedKey)) {
      const snap = packedConfigScopes.get(packedKey);
      return Promise.resolve({
        ok: true,
        scopeId: String(scopeId || ''),
        status: 'ok',
        data: snap.data !== undefined ? snap.data : null,
        rawText: typeof snap.rawText === 'string' ? snap.rawText : null,
        sha256: typeof snap.sha256 === 'string' ? snap.sha256 : null,
        reason: null,
        persistence: 'packed-readonly',
      });
    }

    return Promise.resolve({
      ok: false,
      scopeId: String(scopeId || ''),
      status: 'unavailable',
      data: null,
      rawText: null,
      sha256: null,
      reason: 'ERR_REMOTE_CONFIG_BRIDGE_OFFLINE',
    });
  }

  function writeConfigScope(pluginId, scopeId, rawJson, opts = {}) {
    if (remoteTransport && typeof remoteTransport.writeConfigScope === 'function' && isRemoteTransportConnected()) {
      return Promise.resolve()
        .then(() => remoteTransport.writeConfigScope(pluginId, scopeId, rawJson, opts))
        .catch((err) => {
          recordErrorInternal(pluginId, `write_config_scope_failed:${scopeId}: ${err && err.message ? err.message : String(err)}`);
          return {
            ok: false,
            reason: 'ERR_REMOTE_CONFIG_WRITE_FAILED',
            currentSha256: null,
            snapshot: null,
          };
        });
    }

    return Promise.resolve({
      ok: false,
      reason: 'ERR_REMOTE_CONFIG_BRIDGE_READ_ONLY',
      currentSha256: null,
      snapshot: null,
    });
  }

  function bindNetPlugin(pluginId, spec = {}) {
    if (typeof pluginId !== 'string' || !PLUGIN_ID_RE.test(pluginId)) return false;
    const httpsHosts = Array.isArray(spec && spec.httpsHosts) ? spec.httpsHosts.slice() : [];
    const userApprovedHttps = Boolean(spec && spec.userApprovedHttps === true);
    const localLoopback = Array.isArray(spec && spec.localLoopback) ? spec.localLoopback.slice() : [];
    allowedNet.set(pluginId, { httpsHosts, userApprovedHttps, localLoopback });
    return true;
  }

  function getEffectiveHttpsHosts(pluginId, binding) {
    const merged = [];
    const seen = new Set();
    const pushHost = (h) => {
      const norm = normalizeHostName(h);
      if (norm && !seen.has(norm)) {
        seen.add(norm);
        merged.push(norm);
      }
    };
    const staticList = Array.isArray(binding.httpsHosts) ? binding.httpsHosts : [];
    for (let i = 0; i < staticList.length; i += 1) pushHost(staticList[i]);
    if (binding.userApprovedHttps) {
      const userList = listUserAllowedHttpsHosts(pluginId);
      for (let i = 0; i < userList.length; i += 1) pushHost(userList[i]);
    }
    return merged;
  }

  function detectGmXhr() {
    if (typeof netTransport === 'function') return netTransport;
    if (win && typeof win.GM_xmlhttpRequest === 'function') return win.GM_xmlhttpRequest;
    if (typeof globalThis !== 'undefined' && typeof globalThis.GM_xmlhttpRequest === 'function') {
      return globalThis.GM_xmlhttpRequest;
    }
    if (win && win.GM && typeof win.GM.xmlHttpRequest === 'function') return win.GM.xmlHttpRequest;
    return null;
  }

  function isLoopbackUrl(rawUrl) {
    try {
      const parsed = new URL(String(rawUrl || ''));
      const h = String(parsed.hostname || '').toLowerCase();
      return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
    } catch (_err) {
      return false;
    }
  }

  function netFetch(pluginId, rawUrl, init = {}) {
    if (typeof pluginId !== 'string' || !PLUGIN_ID_RE.test(pluginId)) {
      return Promise.resolve({ ok: false, reason: 'ERR_INVALID_PLUGIN_ID' });
    }
    const binding = allowedNet.get(pluginId);
    if (!binding) {
      return Promise.resolve({ ok: false, reason: 'ERR_NET_NOT_DECLARED' });
    }

    const declaredLoopback = Array.isArray(binding.localLoopback) ? binding.localLoopback : [];
    const targetsLoopback = isLoopbackUrl(rawUrl);

    if (targetsLoopback) {
      if (remoteTransport && typeof remoteTransport.netFetch === 'function' && declaredLoopback.length > 0) {
        if (!isRemoteTransportConnected()) {
          return Promise.resolve({ ok: false, reason: 'ERR_REMOTE_HOST_NOT_CONNECTED' });
        }
        return Promise.resolve(remoteTransport.netFetch(pluginId, rawUrl, init));
      }
      return Promise.resolve({ ok: false, reason: 'ERR_NET_LOOPBACK_NOT_SUPPORTED' });
    }

    const effectiveHttpsHosts = getEffectiveHttpsHosts(pluginId, binding);
    if (effectiveHttpsHosts.length === 0) {
      return Promise.resolve({
        ok: false,
        reason: binding.userApprovedHttps ? 'ERR_NET_USER_HTTPS_HOST_NOT_APPROVED' : 'ERR_NET_NOT_DECLARED',
      });
    }
    const plan = evaluateNetRequest(rawUrl, init, {
      httpsHosts: effectiveHttpsHosts,
      localLoopback: [],
      forbiddenHosts: getForbiddenHostsList(),
      allowLoopback: false,
    });
    if (!plan.ok) {
      return Promise.resolve({ ok: false, reason: plan.reason });
    }
    const xhrFn = detectGmXhr();
    if (!xhrFn && remoteTransport && typeof remoteTransport.netFetch === 'function' && isRemoteTransportConnected()) {
      return Promise.resolve(remoteTransport.netFetch(pluginId, rawUrl, init));
    }
    if (!xhrFn) {
      return Promise.resolve({ ok: false, reason: 'ERR_REMOTE_NET_TRANSPORT_UNAVAILABLE' });
    }
    return new Promise((resolve) => {
      try {
        xhrFn({
          method: plan.method,
          url: plan.url,
          headers: plan.headers,
          data: typeof init.body === 'string' ? init.body : undefined,
          anonymous: true,
          timeout: Number.isFinite(Number(init.timeoutMs)) ? Math.min(30000, Math.max(500, Number(init.timeoutMs))) : 15000,
          onload(resp) {
            // NB-03: Re-validate redirect finalUrl against the same fail-closed allowlist and cap response size
            const finalUrl = resp && typeof resp.finalUrl === 'string' && resp.finalUrl ? resp.finalUrl : plan.url;
            if (finalUrl !== plan.url) {
              const finalCheck = evaluateNetRequest(finalUrl, { method: 'GET' }, {
                httpsHosts: effectiveHttpsHosts,
                localLoopback: [],
                forbiddenHosts: getForbiddenHostsList(),
                allowLoopback: false,
              });
              if (!finalCheck.ok) {
                resolve({ ok: false, reason: `ERR_NET_REDIRECT_FORBIDDEN:${finalCheck.reason}` });
                return;
              }
            }
            const bodyText = String((resp && resp.responseText) || '');
            const maxBytes = Number.isFinite(Number(init.maxResponseBytes))
              ? Math.min(4 * 1024 * 1024, Math.max(1024, Number(init.maxResponseBytes)))
              : 2 * 1024 * 1024;
            if (utf8ByteLength(bodyText) > maxBytes) {
              resolve({ ok: false, reason: 'ERR_NET_RESPONSE_TOO_LARGE' });
              return;
            }
            resolve({
              ok: true,
              status: Number(resp && resp.status) || 0,
              statusText: String((resp && resp.statusText) || ''),
              headers: {},
              bodyText,
              url: finalUrl,
              channel: 'https',
            });
          },
          onerror() {
            resolve({ ok: false, reason: 'ERR_REMOTE_NET_REQUEST_FAILED' });
          },
          ontimeout() {
            resolve({ ok: false, reason: 'ERR_NET_TIMEOUT' });
          },
        });
      } catch (err) {
        resolve({ ok: false, reason: `ERR_REMOTE_NET_REQUEST_FAILED:${err && err.message ? err.message : String(err)}` });
      }
    });
  }

  const port = Object.freeze({
    docGenId: Number(docGenId) || 1,
    profileId: String(profileId || 'remote-web'),
    setPortalClaim,
    saveSettings,
    reportError,
    ping,
    readConfigScope,
    writeConfigScope,
    getRemoteBridgeStatus,
    netFetch,
  });

  function dispose() {
    activePortalClaims.clear();
    syncPortalAttribute();
  }

  return Object.freeze({
    port,
    bindSettingsPlugin,
    bindNetPlugin,
    hydrateSettings,
    loadPersistedSettings,
    hydrateUserAllowedHttpsHosts,
    listUserAllowedHttpsHosts,
    addUserAllowedHttpsHost,
    removeUserAllowedHttpsHost,
    getRemoteBridgeStatus,
    getErrors: () => recordedErrors.slice(),
    getPortalClaims: () => Array.from(activePortalClaims),
    getStatus: () => ({
      docGenId: port.docGenId,
      profileId: port.profileId,
      mode: isRemoteTransportConnected() ? 'remote-sync' : 'browser-local',
      storageKind,
      remoteBridge: getRemoteBridgeStatus(),
      boundSettingsPlugins: Array.from(allowedSettings.keys()),
      portalClaimCount: activePortalClaims.size,
      errorCount: recordedErrors.length,
    }),
    dispose,
  });
}

module.exports = {
  DEFAULT_MAX_SETTINGS_BYTES,
  redactSecrets,
  parseSafeJsonObject,
  deterministicHexDigest,
  createRemoteHostBridge,
};
