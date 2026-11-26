'use strict';

/**
 * Browser-side Authenticated Remote Host Bridge Transport (v3.1.0 — SOLID #0).
 *
 * - ZERO Node built-in imports, ZERO vendor literals, ZERO HTML sinks, ZERO eval.
 * - Connects Remote Web ONCE to the Desktop Native Host's Remote Bridge Server
 *   using a 1-line Pairing Code (`ag-bridge-v1:...`) or manual `{ baseUrl, token }`.
 * - Persists credentials strictly in browser-local StoragePort (GM_* or localStorage),
 *   NEVER embedded in Remote Web bundles.
 * - Transparently serves `readSettings`, `saveSettings`, `readConfigScope`,
 *   `writeConfigScope`, and `netFetch` (including trusted `localLoopback` via Host)
 *   for ALL plugins through one unified framework transport.
 */

const PAIRING_CODE_PREFIX = 'ag-bridge-v1:';
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

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

function parseSafeJsonObject(raw) {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (hasDangerousProtoKey(parsed)) return null;
    return parsed;
  } catch (_err) {
    return null;
  }
}

function decodeBase64UrlToUtf8(input) {
  if (typeof input !== 'string' || !input) return null;
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLen);

  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < padded.length; i += 1) {
    const ch = padded[i];
    if (ch === '=') break;
    const val = BASE64_ALPHABET.indexOf(ch);
    if (val === -1) return null;
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
  }
  const u8 = new Uint8Array(bytes);
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder('utf-8').decode(u8);
  }
  let out = '';
  for (let i = 0; i < u8.length; i += 1) {
    out += String.fromCharCode(u8[i]);
  }
  try {
    return decodeURIComponent(escape(out));
  } catch (_err) {
    return out;
  }
}

function normalizeBridgeBaseUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { ok: false, reason: 'ERR_REMOTE_BRIDGE_INVALID_URL' };
  }
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch (_err) {
    return { ok: false, reason: 'ERR_REMOTE_BRIDGE_INVALID_URL' };
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return { ok: false, reason: 'ERR_REMOTE_BRIDGE_INVALID_URL' };
  }
  if (parsed.protocol === 'http:') {
    const h = String(parsed.hostname || '').toLowerCase();
    if (h !== '127.0.0.1' && h !== 'localhost' && h !== '::1' && h !== '[::1]') {
      return { ok: false, reason: 'ERR_REMOTE_BRIDGE_HTTPS_REQUIRED' };
    }
  } else if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'ERR_REMOTE_BRIDGE_HTTPS_REQUIRED' };
  }
  return { ok: true, baseUrl: parsed.href.replace(/\/+$/, '') };
}

function parsePairingCode(rawCode) {
  if (typeof rawCode !== 'string') {
    return { ok: false, reason: 'ERR_INVALID_PAIRING_CODE' };
  }
  const trimmed = rawCode.trim();
  if (!trimmed.startsWith(PAIRING_CODE_PREFIX)) {
    return { ok: false, reason: 'ERR_INVALID_PAIRING_CODE' };
  }
  const encoded = trimmed.slice(PAIRING_CODE_PREFIX.length);
  if (!encoded || encoded.length > 4096) {
    return { ok: false, reason: 'ERR_INVALID_PAIRING_CODE' };
  }
  const decoded = decodeBase64UrlToUtf8(encoded);
  const parsed = parseSafeJsonObject(decoded);
  if (!parsed || parsed.v !== 1) {
    return { ok: false, reason: 'ERR_INVALID_PAIRING_CODE' };
  }
  const urlCheck = normalizeBridgeBaseUrl(parsed.url);
  if (!urlCheck.ok) {
    return { ok: false, reason: urlCheck.reason };
  }
  const token = typeof parsed.token === 'string' ? parsed.token.trim() : '';
  if (token.length < 32 || token.length > 256 || /\s/.test(token)) {
    return { ok: false, reason: 'ERR_INVALID_PAIRING_CODE_TOKEN' };
  }
  return { ok: true, baseUrl: urlCheck.baseUrl, token };
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

function resolveTransportStorage(storage, win) {
  if (storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function') {
    return storage;
  }
  try {
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
    if (getFn && setFn) {
      return {
        getItem(k) {
          const val = getFn(String(k), null);
          return val === undefined || val === null ? null : String(val);
        },
        setItem(k, v) {
          setFn(String(k), String(v));
        },
        removeItem(k) {
          if (typeof delFn === 'function') delFn(String(k));
          else setFn(String(k), null);
        },
      };
    }
  } catch (_err) {}
  try {
    const gmObj =
      (win && win.GM && typeof win.GM === 'object' && win.GM) ||
      (typeof globalThis !== 'undefined' && globalThis.GM && typeof globalThis.GM === 'object' && globalThis.GM) ||
      null;
    if (gmObj && typeof gmObj.getValue === 'function' && typeof gmObj.setValue === 'function') {
      const cache = new Map();
      return {
        async hydrateKey(k) {
          try {
            const val = await gmObj.getValue(String(k), null);
            if (val === undefined || val === null) {
              cache.delete(String(k));
              return null;
            }
            const s = String(val);
            cache.set(String(k), s);
            return s;
          } catch (_e) {
            return null;
          }
        },
        getItem(k) {
          return cache.has(String(k)) ? cache.get(String(k)) : null;
        },
        setItem(k, v) {
          cache.set(String(k), String(v));
          try {
            const r = gmObj.setValue(String(k), String(v));
            if (r && typeof r.catch === 'function') r.catch(() => {});
          } catch (_e) {}
        },
        removeItem(k) {
          cache.delete(String(k));
          try {
            const r = typeof gmObj.deleteValue === 'function' ? gmObj.deleteValue(String(k)) : gmObj.setValue(String(k), null);
            if (r && typeof r.catch === 'function') r.catch(() => {});
          } catch (_e) {}
        },
      };
    }
  } catch (_err) {}
  try {
    if (win && win.localStorage && typeof win.localStorage.getItem === 'function') {
      return win.localStorage;
    }
  } catch (_err) {}
  return createMemoryStorageFallback();
}

function createRemoteHostTransport({
  win = null,
  storage = null,
  storageNamespace = 'remote-addon-host:v2',
  fetchFn = null,
  gmXhrFn = null,
  timeoutMs = 15000,
} = {}) {
  const store = resolveTransportStorage(storage, win);
  const storageKey = `${storageNamespace}:__host__:remote-bridge-config`;
  const listeners = new Set();

  let baseUrl = '';
  let token = '';
  let connected = false;
  let hostVersion = null;
  let buildSha8 = null;
  let activePlugins = [];
  let lastCheckedAt = null;
  let lastError = null;

  function loadStoredConfig() {
    try {
      const raw = store.getItem(storageKey);
      if (!raw) return false;
      const parsed = parseSafeJsonObject(raw);
      if (!parsed) return false;
      const urlCheck = normalizeBridgeBaseUrl(parsed.baseUrl);
      const tok = typeof parsed.token === 'string' ? parsed.token.trim() : '';
      if (!urlCheck.ok || tok.length < 32 || tok.length > 256) return false;
      baseUrl = urlCheck.baseUrl;
      token = tok;
      return true;
    } catch (_err) {
      return false;
    }
  }

  function persistConfig(nextBaseUrl, nextToken) {
    try {
      store.setItem(storageKey, JSON.stringify({ v: 1, baseUrl: nextBaseUrl, token: nextToken }));
      return true;
    } catch (_err) {
      return false;
    }
  }

  function clearStoredConfig() {
    try {
      if (typeof store.removeItem === 'function') {
        store.removeItem(storageKey);
      } else {
        store.setItem(storageKey, '');
      }
    } catch (_err) {}
  }

  function getStatus() {
    return Object.freeze({
      configured: Boolean(baseUrl && token),
      connected: Boolean(connected),
      baseUrl: baseUrl || null,
      hostVersion,
      buildSha8,
      activePlugins: activePlugins.slice(),
      lastCheckedAt,
      lastError,
    });
  }

  function notifyListeners() {
    const snap = getStatus();
    const list = Array.from(listeners);
    for (let i = 0; i < list.length; i += 1) {
      try {
        list[i](snap);
      } catch (_err) {}
    }
  }

  function detectGmXhr() {
    if (typeof gmXhrFn === 'function') return gmXhrFn;
    if (win && typeof win.GM_xmlhttpRequest === 'function') return win.GM_xmlhttpRequest;
    if (typeof globalThis !== 'undefined' && typeof globalThis.GM_xmlhttpRequest === 'function') {
      return globalThis.GM_xmlhttpRequest;
    }
    if (win && win.GM && typeof win.GM.xmlHttpRequest === 'function') return win.GM.xmlHttpRequest;
    return null;
  }

  function detectFetch() {
    if (typeof fetchFn === 'function') return fetchFn;
    if (win && typeof win.fetch === 'function') return win.fetch.bind(win);
    if (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function') {
      return globalThis.fetch.bind(globalThis);
    }
    return null;
  }

  async function requestJson(method, routePath, bodyObj, overrideCreds = null) {
    const activeBase = overrideCreds ? overrideCreds.baseUrl : baseUrl;
    const activeToken = overrideCreds ? overrideCreds.token : token;
    if (!activeBase || !activeToken) {
      return { ok: false, status: 0, reason: 'ERR_REMOTE_HOST_NOT_CONFIGURED', data: null };
    }
    const targetUrl = `${activeBase}${routePath}`;
    const headers = {
      Authorization: `Bearer ${activeToken}`,
    };
    let serializedBody = undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      headers['Content-Type'] = 'application/json';
      serializedBody = JSON.stringify(bodyObj || {});
    }

    const activeFetch = detectFetch();
    const activeGmXhr = detectGmXhr();

    // Prefer injected fetchFn when explicitly provided (unit tests), else prefer GM_xmlhttpRequest when available, else standard CORS fetch
    if (typeof fetchFn === 'function' || (!activeGmXhr && activeFetch)) {
      if (!activeFetch) {
        return { ok: false, status: 0, reason: 'ERR_REMOTE_TRANSPORT_UNAVAILABLE', data: null };
      }
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller
        ? setTimeout(() => {
            try {
              controller.abort();
            } catch (_e) {}
          }, timeoutMs)
        : null;
      try {
        const resp = await activeFetch(targetUrl, {
          method,
          headers,
          body: serializedBody,
          mode: 'cors',
          credentials: 'omit',
          ...(controller ? { signal: controller.signal } : {}),
        });
        const text = typeof resp.text === 'function' ? await resp.text() : '';
        const parsed = parseSafeJsonObject(text);
        if (!resp.ok) {
          return {
            ok: false,
            status: Number(resp.status) || 0,
            reason: (parsed && parsed.reason) || `ERR_REMOTE_BRIDGE_HTTP_${resp.status || 0}`,
            data: parsed,
          };
        }
        return { ok: true, status: Number(resp.status) || 200, reason: null, data: parsed || {} };
      } catch (err) {
        return {
          ok: false,
          status: 0,
          reason: err && err.name === 'AbortError' ? 'ERR_REMOTE_BRIDGE_TIMEOUT' : 'ERR_REMOTE_BRIDGE_UNREACHABLE',
          data: null,
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    if (activeGmXhr) {
      return new Promise((resolve) => {
        try {
          activeGmXhr({
            method,
            url: targetUrl,
            headers,
            data: serializedBody,
            anonymous: true,
            timeout: timeoutMs,
            onload(resp) {
              const status = Number(resp && resp.status) || 0;
              const parsed = parseSafeJsonObject(String((resp && resp.responseText) || ''));
              if (status < 200 || status >= 300) {
                resolve({
                  ok: false,
                  status,
                  reason: (parsed && parsed.reason) || `ERR_REMOTE_BRIDGE_HTTP_${status}`,
                  data: parsed,
                });
                return;
              }
              resolve({ ok: true, status, reason: null, data: parsed || {} });
            },
            onerror() {
              resolve({ ok: false, status: 0, reason: 'ERR_REMOTE_BRIDGE_UNREACHABLE', data: null });
            },
            ontimeout() {
              resolve({ ok: false, status: 0, reason: 'ERR_REMOTE_BRIDGE_TIMEOUT', data: null });
            },
          });
        } catch (_err) {
          resolve({ ok: false, status: 0, reason: 'ERR_REMOTE_BRIDGE_UNREACHABLE', data: null });
        }
      });
    }

    return { ok: false, status: 0, reason: 'ERR_REMOTE_TRANSPORT_UNAVAILABLE', data: null };
  }

  async function ping(overrideCreds = null) {
    const res = await requestJson('GET', '/v1/ping', null, overrideCreds);
    const nowIso = new Date().toISOString();
    if (!overrideCreds) {
      lastCheckedAt = nowIso;
    }
    if (res.ok && res.data && res.data.ok === true) {
      if (!overrideCreds) {
        connected = true;
        hostVersion = typeof res.data.hostVersion === 'string' ? res.data.hostVersion : null;
        buildSha8 = typeof res.data.buildSha8 === 'string' ? res.data.buildSha8 : null;
        activePlugins = Array.isArray(res.data.activePlugins) ? res.data.activePlugins.slice() : [];
        lastError = null;
        notifyListeners();
      }
      return { ok: true, reason: null, data: res.data };
    }
    const reason = res.reason || 'ERR_REMOTE_BRIDGE_PING_FAILED';
    if (!overrideCreds) {
      connected = false;
      lastError = reason;
      notifyListeners();
    }
    return { ok: false, reason, data: null };
  }

  async function hydrate() {
    if (store && typeof store.hydrateKey === 'function') {
      try {
        await store.hydrateKey(storageKey);
      } catch (_err) {}
    }
    loadStoredConfig();
    return getStatus();
  }

  async function connect({ baseUrl: rawUrl, token: rawToken } = {}) {
    const urlCheck = normalizeBridgeBaseUrl(rawUrl);
    if (!urlCheck.ok) {
      lastError = urlCheck.reason;
      notifyListeners();
      return { ok: false, reason: urlCheck.reason, status: getStatus() };
    }
    const cleanToken = typeof rawToken === 'string' ? rawToken.trim() : '';
    if (cleanToken.length < 32 || cleanToken.length > 256 || /\s/.test(cleanToken)) {
      lastError = 'ERR_REMOTE_BRIDGE_INVALID_TOKEN';
      notifyListeners();
      return { ok: false, reason: 'ERR_REMOTE_BRIDGE_INVALID_TOKEN', status: getStatus() };
    }
    const checkRes = await ping({ baseUrl: urlCheck.baseUrl, token: cleanToken });
    if (!checkRes.ok) {
      lastError = checkRes.reason;
      notifyListeners();
      return { ok: false, reason: checkRes.reason, status: getStatus() };
    }
    baseUrl = urlCheck.baseUrl;
    token = cleanToken;
    connected = true;
    hostVersion = typeof checkRes.data.hostVersion === 'string' ? checkRes.data.hostVersion : null;
    buildSha8 = typeof checkRes.data.buildSha8 === 'string' ? checkRes.data.buildSha8 : null;
    activePlugins = Array.isArray(checkRes.data.activePlugins) ? checkRes.data.activePlugins.slice() : [];
    lastCheckedAt = new Date().toISOString();
    lastError = null;
    persistConfig(baseUrl, token);
    notifyListeners();
    return { ok: true, reason: null, status: getStatus() };
  }

  async function connectWithPairingCode(rawCode) {
    const parsed = parsePairingCode(rawCode);
    if (!parsed.ok) {
      lastError = parsed.reason;
      notifyListeners();
      return { ok: false, reason: parsed.reason, status: getStatus() };
    }
    return connect({ baseUrl: parsed.baseUrl, token: parsed.token });
  }

  function disconnect() {
    baseUrl = '';
    token = '';
    connected = false;
    hostVersion = null;
    buildSha8 = null;
    activePlugins = [];
    lastError = null;
    lastCheckedAt = new Date().toISOString();
    clearStoredConfig();
    notifyListeners();
    return { ok: true, status: getStatus() };
  }

  async function readSettings(pluginId) {
    if (!connected) return { ok: false, reason: 'ERR_REMOTE_HOST_NOT_CONNECTED', snapshot: null };
    const res = await requestJson('POST', '/v1/settings/read', { pluginId });
    if (!res.ok || !res.data) {
      return { ok: false, reason: res.reason || 'ERR_REMOTE_SETTINGS_READ_FAILED', snapshot: null };
    }
    return res.data;
  }

  async function saveSettings(pluginId, rawJson) {
    if (!connected) return { ok: false, reason: 'ERR_REMOTE_HOST_NOT_CONNECTED', snapshot: null };
    const res = await requestJson('POST', '/v1/settings/save', { pluginId, rawJson });
    if (!res.ok || !res.data) {
      return { ok: false, reason: res.reason || 'ERR_REMOTE_SETTINGS_SAVE_FAILED', snapshot: null };
    }
    return res.data;
  }

  async function readConfigScope(pluginId, scopeId) {
    if (!connected) {
      return {
        ok: false,
        scopeId: String(scopeId || ''),
        status: 'unavailable',
        data: null,
        rawText: null,
        sha256: null,
        reason: 'ERR_REMOTE_HOST_NOT_CONNECTED',
      };
    }
    const res = await requestJson('POST', '/v1/config/read', { pluginId, scopeId });
    if (!res.ok || !res.data) {
      return {
        ok: false,
        scopeId: String(scopeId || ''),
        status: 'error',
        data: null,
        rawText: null,
        sha256: null,
        reason: res.reason || 'ERR_REMOTE_CONFIG_READ_FAILED',
      };
    }
    return res.data;
  }

  async function writeConfigScope(pluginId, scopeId, rawJson, opts = {}) {
    if (!connected) {
      return { ok: false, reason: 'ERR_REMOTE_HOST_NOT_CONNECTED', currentSha256: null, snapshot: null };
    }
    const payload = { pluginId, scopeId, rawJson };
    if (opts && typeof opts === 'object' && Object.prototype.hasOwnProperty.call(opts, 'expectedSha256')) {
      payload.expectedSha256 = opts.expectedSha256;
    }
    const res = await requestJson('POST', '/v1/config/write', payload);
    if (!res.ok || !res.data) {
      return { ok: false, reason: res.reason || 'ERR_REMOTE_CONFIG_WRITE_FAILED', currentSha256: null, snapshot: null };
    }
    return res.data;
  }

  async function netFetch(pluginId, url, init = {}) {
    if (!connected) {
      return { ok: false, reason: 'ERR_REMOTE_HOST_NOT_CONNECTED' };
    }
    const safeInit = init && typeof init === 'object' ? init : {};
    const reqBody = {
      pluginId,
      url: String(url || ''),
      method: typeof safeInit.method === 'string' ? safeInit.method : 'GET',
      headers: safeInit.headers && typeof safeInit.headers === 'object' ? safeInit.headers : {},
      body: typeof safeInit.body === 'string' ? safeInit.body : null,
      timeoutMs: Number.isFinite(Number(safeInit.timeoutMs)) ? Number(safeInit.timeoutMs) : undefined,
    };
    if (safeInit.secretHeaders && typeof safeInit.secretHeaders === 'object' && !Array.isArray(safeInit.secretHeaders)) {
      reqBody.secretHeaders = safeInit.secretHeaders;
    }
    const res = await requestJson('POST', '/v1/net/fetch', reqBody);
    if (!res.ok || !res.data) {
      return { ok: false, reason: res.reason || 'ERR_REMOTE_NET_REQUEST_FAILED' };
    }
    return res.data;
  }

  async function secretsSet(pluginId, key, value) {
    if (!connected) return { ok: false, reason: 'ERR_REMOTE_HOST_NOT_CONNECTED' };
    const res = await requestJson('POST', '/v1/secrets/set', { pluginId, key, value });
    if (!res.ok || !res.data) {
      return { ok: false, reason: res.reason || 'ERR_REMOTE_SECRETS_SET_FAILED' };
    }
    return res.data;
  }

  async function secretsGet(pluginId, key) {
    if (!connected) return { ok: false, exists: false, value: undefined, reason: 'ERR_REMOTE_HOST_NOT_CONNECTED' };
    const res = await requestJson('POST', '/v1/secrets/get', { pluginId, key });
    if (!res.ok || !res.data) {
      return { ok: false, exists: false, value: undefined, reason: res.reason || 'ERR_REMOTE_SECRETS_GET_FAILED' };
    }
    return res.data;
  }

  async function secretsHas(pluginId, key) {
    if (!connected) return { ok: false, exists: false, reason: 'ERR_REMOTE_HOST_NOT_CONNECTED' };
    const res = await requestJson('POST', '/v1/secrets/has', { pluginId, key });
    if (!res.ok || !res.data) {
      return { ok: false, exists: false, reason: res.reason || 'ERR_REMOTE_SECRETS_HAS_FAILED' };
    }
    return res.data;
  }

  async function secretsDelete(pluginId, key) {
    if (!connected) return { ok: false, deleted: false, reason: 'ERR_REMOTE_HOST_NOT_CONNECTED' };
    const res = await requestJson('POST', '/v1/secrets/delete', { pluginId, key });
    if (!res.ok || !res.data) {
      return { ok: false, deleted: false, reason: res.reason || 'ERR_REMOTE_SECRETS_DELETE_FAILED' };
    }
    return res.data;
  }

  async function secretsList(pluginId) {
    if (!connected) return { ok: false, keys: [], reason: 'ERR_REMOTE_HOST_NOT_CONNECTED' };
    const res = await requestJson('POST', '/v1/secrets/list', { pluginId });
    if (!res.ok || !res.data) {
      return { ok: false, keys: [], reason: res.reason || 'ERR_REMOTE_SECRETS_LIST_FAILED' };
    }
    return res.data;
  }

  function onStatusChange(cb) {
    if (typeof cb !== 'function') return () => {};
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }

  loadStoredConfig();

  return Object.freeze({
    hydrate,
    connect,
    connectWithPairingCode,
    disconnect,
    ping,
    readSettings,
    saveSettings,
    readConfigScope,
    writeConfigScope,
    netFetch,
    secretsSet,
    secretsGet,
    secretsHas,
    secretsDelete,
    secretsList,
    getStatus,
    isConnected: () => Boolean(connected),
    onStatusChange,
  });
}

module.exports = {
  PAIRING_CODE_PREFIX,
  normalizeBridgeBaseUrl,
  parsePairingCode,
  createRemoteHostTransport,
};
