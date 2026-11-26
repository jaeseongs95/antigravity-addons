'use strict';

/**
 * Native Host Authenticated Remote Bridge Server (v3.1.0 — SOLID #0, zero external deps).
 *
 * Centralizes Remote Web <-> Desktop Native Host communication inside the host framework
 * so individual plugins NEVER have to ship their own URL/token inputs or bespoke remote servers.
 *
 * Security invariants:
 * 1. Disabled by default (`enabled: false`); explicit user opt-in from Desktop Addon Manager.
 * 2. Persists config & CSPRNG 256-bit Bearer token in `remote-bridge.json` (0o600, symlink-rejected,
 *    atomic temp+rename write, reserved from plugin settingsBridge/configBridge access).
 * 3. Constant-time `crypto.timingSafeEqual` Bearer token verification on EVERY route (including `/v1/ping`).
 * 4. Strict exact `Origin` allowlist CORS (NEVER `*`); forbidden origins receive HTTP 403.
 * 5. Zero arbitrary proxy: every `/v1/*` call validates `pluginId` against live `planCurrentAddons()`
 *    + `readCurrentPolicy()` + `readVerifiedRendererScript(...)` before delegating to the host's
 *    existing `settingsBridge`, `configBridge`, and `netFetchBroker`.
 * 6. Security response headers (`Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
 *    `Referrer-Policy: no-referrer`) and strict 512 KiB request body cap.
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { parseSafeJson } = require('../shared/safe-json');
const { readVerifiedRendererScript } = require('./trust-verifier');

const DEFAULT_REMOTE_BRIDGE_FILENAME = 'remote-bridge.json';
const DEFAULT_REMOTE_BRIDGE_PORT = 19384;
const DEFAULT_REMOTE_BRIDGE_BIND_HOST = '127.0.0.1';
const ALLOWED_BIND_HOSTS = Object.freeze(['127.0.0.1', '0.0.0.0']);
const MAX_CONFIG_BYTES = 32768;
const MAX_BODY_BYTES = 512 * 1024;
const PAIRING_CODE_PREFIX = 'ag-bridge-v1:';
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

function generateBridgeToken() {
  return crypto.randomBytes(32).toString('hex');
}

function normalizeOrigin(rawOrigin) {
  if (typeof rawOrigin !== 'string' || !rawOrigin.trim()) return null;
  let parsed;
  try {
    parsed = new URL(rawOrigin.trim());
  } catch (_err) {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.protocol === 'http:') {
    const h = String(parsed.hostname || '').toLowerCase();
    if (h !== '127.0.0.1' && h !== 'localhost' && h !== '::1' && h !== '[::1]') {
      return null;
    }
  }
  return parsed.origin;
}

function normalizePublicUrl(rawUrl) {
  if (rawUrl === null || rawUrl === undefined) return { ok: true, value: '' };
  if (typeof rawUrl !== 'string') return { ok: false, reason: 'ERR_REMOTE_BRIDGE_INVALID_PUBLIC_URL' };
  const trimmed = rawUrl.trim();
  if (!trimmed) return { ok: true, value: '' };
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (_err) {
    return { ok: false, reason: 'ERR_REMOTE_BRIDGE_INVALID_PUBLIC_URL' };
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return { ok: false, reason: 'ERR_REMOTE_BRIDGE_INVALID_PUBLIC_URL' };
  }
  if (parsed.protocol === 'http:') {
    const h = String(parsed.hostname || '').toLowerCase();
    if (h !== '127.0.0.1' && h !== 'localhost' && h !== '::1' && h !== '[::1]') {
      return { ok: false, reason: 'ERR_REMOTE_BRIDGE_PUBLIC_URL_MUST_BE_HTTPS' };
    }
  } else if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'ERR_REMOTE_BRIDGE_PUBLIC_URL_MUST_BE_HTTPS' };
  }
  return { ok: true, value: parsed.href.replace(/\/+$/, '') };
}

function normalizePort(rawPort, { allowZero = false } = {}) {
  const n = Number(rawPort);
  if (!Number.isInteger(n)) return null;
  if (allowZero && n === 0) return 0;
  if (n < 1024 || n > 65535) return null;
  return n;
}

function normalizeBindHost(rawHost) {
  if (typeof rawHost !== 'string') return null;
  const trimmed = rawHost.trim();
  return ALLOWED_BIND_HOSTS.includes(trimmed) ? trimmed : null;
}

function normalizeAllowedOrigins(rawList) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  const seen = new Set();
  for (let i = 0; i < rawList.length; i += 1) {
    const norm = normalizeOrigin(rawList[i]);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

function encodePairingCode({ url, token }) {
  if (typeof url !== 'string' || !url || typeof token !== 'string' || token.length < 32) {
    return null;
  }
  const payload = JSON.stringify({ v: 1, url: url.replace(/\/+$/, ''), token });
  return `${PAIRING_CODE_PREFIX}${Buffer.from(payload, 'utf8').toString('base64url')}`;
}

function decodePairingCode(rawCode) {
  if (typeof rawCode !== 'string') return { ok: false, reason: 'ERR_INVALID_PAIRING_CODE' };
  const trimmed = rawCode.trim();
  if (!trimmed.startsWith(PAIRING_CODE_PREFIX)) {
    return { ok: false, reason: 'ERR_INVALID_PAIRING_CODE' };
  }
  const encoded = trimmed.slice(PAIRING_CODE_PREFIX.length);
  if (!encoded || encoded.length > 4096) {
    return { ok: false, reason: 'ERR_INVALID_PAIRING_CODE' };
  }
  try {
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    const parsed = parseSafeJson(decoded);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.v !== 1) {
      return { ok: false, reason: 'ERR_INVALID_PAIRING_CODE' };
    }
    const urlCheck = normalizePublicUrl(parsed.url);
    if (!urlCheck.ok || !urlCheck.value) {
      return { ok: false, reason: 'ERR_INVALID_PAIRING_CODE_URL' };
    }
    const token = typeof parsed.token === 'string' ? parsed.token.trim() : '';
    if (token.length < 32 || token.length > 256 || /\s/.test(token)) {
      return { ok: false, reason: 'ERR_INVALID_PAIRING_CODE_TOKEN' };
    }
    return { ok: true, url: urlCheck.value, token };
  } catch (_err) {
    return { ok: false, reason: 'ERR_INVALID_PAIRING_CODE' };
  }
}

function constantTimeTokenMatch(expectedToken, providedToken) {
  if (typeof expectedToken !== 'string' || typeof providedToken !== 'string') return false;
  if (!expectedToken || !providedToken) return false;
  const a = Buffer.from(expectedToken, 'utf8');
  const b = Buffer.from(providedToken, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function defaultBridgeConfig() {
  return {
    schemaVersion: 1,
    enabled: false,
    bindHost: DEFAULT_REMOTE_BRIDGE_BIND_HOST,
    port: DEFAULT_REMOTE_BRIDGE_PORT,
    publicUrl: '',
    token: generateBridgeToken(),
    allowedOrigins: [],
    updatedAt: null,
  };
}

function readRemoteBridgeConfigFile(configPath) {
  const fallback = defaultBridgeConfig();
  if (!configPath || typeof configPath !== 'string') {
    return { ok: true, exists: false, config: fallback, error: null };
  }
  if (!fs.existsSync(configPath)) {
    return { ok: true, exists: false, config: fallback, error: null };
  }
  try {
    const lstat = fs.lstatSync(configPath);
    if (lstat.isSymbolicLink() || !lstat.isFile()) {
      return { ok: false, exists: true, config: fallback, error: 'ERR_REMOTE_BRIDGE_CONFIG_SYMLINK_OR_NON_FILE' };
    }
    if (lstat.size > MAX_CONFIG_BYTES) {
      return { ok: false, exists: true, config: fallback, error: 'ERR_REMOTE_BRIDGE_CONFIG_TOO_LARGE' };
    }
    const parsed = parseSafeJson(fs.readFileSync(configPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, exists: true, config: fallback, error: 'ERR_REMOTE_BRIDGE_CONFIG_INVALID_ROOT' };
    }
    const bindHost = normalizeBindHost(parsed.bindHost) || DEFAULT_REMOTE_BRIDGE_BIND_HOST;
    const port = normalizePort(parsed.port, { allowZero: true });
    const pubCheck = normalizePublicUrl(parsed.publicUrl);
    const token =
      typeof parsed.token === 'string' && parsed.token.trim().length >= 32 && parsed.token.trim().length <= 256
        ? parsed.token.trim()
        : generateBridgeToken();
    const allowedOrigins = normalizeAllowedOrigins(parsed.allowedOrigins);
    return {
      ok: true,
      exists: true,
      config: {
        schemaVersion: 1,
        enabled: parsed.enabled === true,
        bindHost,
        port: port !== null ? port : DEFAULT_REMOTE_BRIDGE_PORT,
        publicUrl: pubCheck.ok ? pubCheck.value : '',
        token,
        allowedOrigins,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      },
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      exists: true,
      config: fallback,
      error: err && err.message ? err.message : String(err),
    };
  }
}

function writeRemoteBridgeConfigFileAtomic(configPath, data) {
  if (!configPath || typeof configPath !== 'string') {
    return { ok: false, reason: 'ERR_REMOTE_BRIDGE_CONFIG_PATH_MISSING' };
  }
  const absPath = path.resolve(configPath);
  const dir = path.dirname(absPath);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(absPath)) {
    const lstat = fs.lstatSync(absPath);
    if (lstat.isSymbolicLink() || !lstat.isFile()) {
      return { ok: false, reason: 'ERR_REMOTE_BRIDGE_CONFIG_SYMLINK_OR_NON_FILE' };
    }
  }
  const serialized = JSON.stringify(data, null, 2) + '\n';
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CONFIG_BYTES) {
    return { ok: false, reason: 'ERR_REMOTE_BRIDGE_CONFIG_TOO_LARGE' };
  }
  const tmpPath = path.join(dir, `.remote-bridge.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmpPath, serialized, { encoding: 'utf8', mode: 0o600 });
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        fs.renameSync(tmpPath, absPath);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (!err || (err.code !== 'EBUSY' && err.code !== 'EPERM' && err.code !== 'EACCES')) {
          throw err;
        }
      }
    }
    if (lastErr) throw lastErr;
    try {
      fs.chmodSync(absPath, 0o600);
    } catch (_chmodErr) {}
    return { ok: true, reason: null };
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (_cleanupErr) {}
    return { ok: false, reason: err && err.message ? err.message : 'ERR_REMOTE_BRIDGE_CONFIG_WRITE_FAILED' };
  }
}

function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      resolve(res);
    };
    req.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        req.destroy();
        finish({ ok: false, status: 413, reason: 'ERR_REMOTE_BRIDGE_BODY_TOO_LARGE' });
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (total === 0) {
        finish({ ok: true, body: {} });
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        const parsed = parseSafeJson(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          finish({ ok: false, status: 400, reason: 'ERR_REMOTE_BRIDGE_INVALID_JSON' });
          return;
        }
        finish({ ok: true, body: parsed });
      } catch (err) {
        const reason =
          err && err.message === 'ERR_UNSAFE_JSON_PROTO_KEY'
            ? 'ERR_REMOTE_BRIDGE_UNSAFE_PROTO_KEY'
            : 'ERR_REMOTE_BRIDGE_INVALID_JSON';
        finish({ ok: false, status: 400, reason });
      }
    });
    req.on('error', () => {
      finish({ ok: false, status: 400, reason: 'ERR_REMOTE_BRIDGE_READ_FAILED' });
    });
  });
}

function createRemoteBridgeServer({
  configPath = null,
  hostVersion = '3.1.0',
  buildSha8 = 'dev',
  profileId = null,
  allowedOrigins = [],
  allowLoopbackOrigin = false,
  strictTrustPolicy = true,
  planCurrentAddons = () => ({ active: [], disabled: [], rejected: [] }),
  readCurrentPolicy = () => ({ schemaVersion: 1, approved: {} }),
  settingsBridge = null,
  configBridge = null,
  netFetchBroker = null,
  httpModule = http,
  recordDiag = () => {},
} = {}) {
  const baseAllowedOrigins = normalizeAllowedOrigins(allowedOrigins);
  const initialLoaded = readRemoteBridgeConfigFile(configPath);
  if (!initialLoaded.ok) {
    recordDiag('warn', 'REMOTE_BRIDGE_CONFIG_READ_ERR', initialLoaded.error || '');
  }
  let config = initialLoaded.config;
  let server = null;
  let listeningPort = null;
  let listeningHost = null;
  let lastError = null;
  let disposed = false;

  function getEffectiveAllowedOrigins() {
    const merged = new Set(baseAllowedOrigins);
    for (let i = 0; i < config.allowedOrigins.length; i += 1) {
      merged.add(config.allowedOrigins[i]);
    }
    return Array.from(merged);
  }

  function isOriginAllowed(rawOrigin) {
    if (!rawOrigin || typeof rawOrigin !== 'string') return true; // Non-CORS / same-origin or server-to-server requests with valid Bearer token
    const norm = normalizeOrigin(rawOrigin);
    if (!norm) return false;
    const allowed = getEffectiveAllowedOrigins();
    if (allowed.includes(norm)) return true;
    if (allowLoopbackOrigin) {
      try {
        const u = new URL(norm);
        const h = String(u.hostname || '').toLowerCase();
        if ((u.protocol === 'http:' || u.protocol === 'https:') && (h === '127.0.0.1' || h === 'localhost')) {
          return true;
        }
      } catch (_err) {}
    }
    return false;
  }

  function writeJsonResponse(res, statusCode, payload, corsOrigin = null) {
    const body = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(body, 'utf8')),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    };
    if (corsOrigin) {
      headers['Access-Control-Allow-Origin'] = corsOrigin;
      headers['Vary'] = 'Origin';
      headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
      headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
      headers['Access-Control-Max-Age'] = '600';
    }
    res.writeHead(statusCode, headers);
    res.end(body);
  }

  function resolveVerifiedPlugin(pluginId) {
    if (typeof pluginId !== 'string' || !PLUGIN_ID_RE.test(pluginId.trim())) {
      return { ok: false, reason: 'ERR_INVALID_PLUGIN_ID' };
    }
    const cleanId = pluginId.trim();
    const plan = planCurrentAddons();
    const activeList = Array.isArray(plan && plan.active) ? plan.active : [];
    const addon = activeList.find((a) => a && a.pluginId === cleanId) || null;
    if (!addon) {
      return { ok: false, reason: 'ERR_REMOTE_BRIDGE_PLUGIN_NOT_ACTIVE' };
    }
    const manifest = addon.manifest || {};
    const rendererScript = addon.resolvedEntries ? addon.resolvedEntries.rendererScript : null;
    if (!rendererScript || !fs.existsSync(rendererScript)) {
      return { ok: false, reason: 'ERR_REMOTE_BRIDGE_RENDERER_MISSING' };
    }
    const policy = readCurrentPolicy();
    const verified = readVerifiedRendererScript(rendererScript, manifest, policy, { strictTrustPolicy });
    if (!verified.ok) {
      return { ok: false, reason: verified.reason || 'ERR_TRUST_POLICY_NOT_APPROVED' };
    }
    const isTrusted = verified.effectiveTrustLevel === 'trusted';
    const settingsSpec =
      isTrusted &&
      manifest.settingsBridge &&
      typeof manifest.settingsBridge === 'object' &&
      typeof manifest.settingsBridge.fileName === 'string' &&
      manifest.settingsBridge.fileName.trim()
        ? {
            pluginId: cleanId,
            fileName: manifest.settingsBridge.fileName.trim(),
            maxBytes: manifest.settingsBridge.maxBytes,
          }
        : null;
    const configScopes =
      isTrusted &&
      manifest.configBridge &&
      typeof manifest.configBridge === 'object' &&
      Array.isArray(manifest.configBridge.scopes) &&
      manifest.configBridge.scopes.length > 0
        ? manifest.configBridge.scopes
        : null;
    const configBinding = configScopes
      ? {
          pluginId: cleanId,
          scopes: configScopes,
        }
      : null;
    const netPerm =
      manifest.permissions &&
      typeof manifest.permissions === 'object' &&
      manifest.permissions.net &&
      typeof manifest.permissions.net === 'object'
        ? manifest.permissions.net
        : null;
    const netBinding = netPerm
      ? {
          pluginId: cleanId,
          httpsHosts: Array.isArray(netPerm.httpsHosts) ? netPerm.httpsHosts.slice() : [],
          localLoopback: isTrusted && Array.isArray(netPerm.localLoopback) ? netPerm.localLoopback.slice() : [],
          allowLoopback: isTrusted && Array.isArray(netPerm.localLoopback) && netPerm.localLoopback.length > 0,
        }
      : null;

    return {
      ok: true,
      pluginId: cleanId,
      trustLevel: verified.effectiveTrustLevel,
      settingsSpec,
      configBinding,
      netBinding,
    };
  }

  async function handleRequest(req, res) {
    const rawOrigin = req && req.headers ? req.headers.origin : null;
    const hasOriginHeader = typeof rawOrigin === 'string' && rawOrigin.trim().length > 0;
    const allowedCorsOrigin = hasOriginHeader && isOriginAllowed(rawOrigin) ? normalizeOrigin(rawOrigin) : null;

    if (hasOriginHeader && !allowedCorsOrigin) {
      writeJsonResponse(res, 403, { ok: false, reason: 'ERR_REMOTE_BRIDGE_ORIGIN_FORBIDDEN' });
      return;
    }

    const method = String((req && req.method) || 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      const headers = {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      };
      if (allowedCorsOrigin) {
        headers['Access-Control-Allow-Origin'] = allowedCorsOrigin;
        headers['Vary'] = 'Origin';
        headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
        headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
        headers['Access-Control-Max-Age'] = '600';
      }
      res.writeHead(204, headers);
      res.end();
      return;
    }

    const authHeader = req && req.headers && typeof req.headers.authorization === 'string' ? req.headers.authorization.trim() : '';
    const bearerPrefix = 'Bearer ';
    const providedToken = authHeader.startsWith(bearerPrefix) ? authHeader.slice(bearerPrefix.length).trim() : '';
    if (!constantTimeTokenMatch(config.token, providedToken)) {
      writeJsonResponse(res, 401, { ok: false, reason: 'ERR_REMOTE_BRIDGE_UNAUTHORIZED' }, allowedCorsOrigin);
      return;
    }

    let pathname = '/';
    try {
      const parsedUrl = new URL(String((req && req.url) || '/'), 'http://127.0.0.1');
      pathname = parsedUrl.pathname;
    } catch (_err) {
      writeJsonResponse(res, 400, { ok: false, reason: 'ERR_REMOTE_BRIDGE_BAD_URL' }, allowedCorsOrigin);
      return;
    }

    if (method === 'GET' && pathname === '/v1/ping') {
      const plan = planCurrentAddons();
      const activePlugins = Array.isArray(plan && plan.active) ? plan.active.map((a) => a.pluginId) : [];
      writeJsonResponse(
        res,
        200,
        {
          ok: true,
          bridgeVersion: 1,
          hostVersion,
          buildSha8,
          profileId,
          activePlugins,
        },
        allowedCorsOrigin
      );
      return;
    }

    if (method !== 'POST') {
      writeJsonResponse(res, 405, { ok: false, reason: 'ERR_REMOTE_BRIDGE_METHOD_NOT_ALLOWED' }, allowedCorsOrigin);
      return;
    }

    const bodyRes = await readJsonBody(req, MAX_BODY_BYTES);
    if (!bodyRes.ok) {
      writeJsonResponse(res, bodyRes.status || 400, { ok: false, reason: bodyRes.reason }, allowedCorsOrigin);
      return;
    }
    const payload = bodyRes.body || {};

    if (pathname === '/v1/settings/read') {
      if (!settingsBridge || typeof settingsBridge.readSnapshotForPlugin !== 'function') {
        writeJsonResponse(res, 503, { ok: false, reason: 'ERR_SETTINGS_BRIDGE_UNAVAILABLE', snapshot: null }, allowedCorsOrigin);
        return;
      }
      const verified = resolveVerifiedPlugin(payload.pluginId);
      if (!verified.ok) {
        writeJsonResponse(res, 403, { ok: false, reason: verified.reason, snapshot: null }, allowedCorsOrigin);
        return;
      }
      if (!verified.settingsSpec) {
        writeJsonResponse(res, 403, { ok: false, reason: 'ERR_SETTINGS_BRIDGE_NOT_BOUND', snapshot: null }, allowedCorsOrigin);
        return;
      }
      const snapshot = settingsBridge.readSnapshotForPlugin(verified.pluginId, verified.settingsSpec);
      writeJsonResponse(res, 200, { ok: true, reason: null, snapshot }, allowedCorsOrigin);
      return;
    }

    if (pathname === '/v1/settings/save') {
      if (!settingsBridge || typeof settingsBridge.writeSnapshotForPlugin !== 'function') {
        writeJsonResponse(res, 503, { ok: false, reason: 'ERR_SETTINGS_BRIDGE_UNAVAILABLE', snapshot: null }, allowedCorsOrigin);
        return;
      }
      const verified = resolveVerifiedPlugin(payload.pluginId);
      if (!verified.ok) {
        writeJsonResponse(res, 403, { ok: false, reason: verified.reason, snapshot: null }, allowedCorsOrigin);
        return;
      }
      if (!verified.settingsSpec) {
        writeJsonResponse(res, 403, { ok: false, reason: 'ERR_SETTINGS_BRIDGE_NOT_BOUND', snapshot: null }, allowedCorsOrigin);
        return;
      }
      const rawJson = typeof payload.rawJson === 'string' ? payload.rawJson : null;
      if (rawJson === null) {
        writeJsonResponse(res, 400, { ok: false, reason: 'ERR_INVALID_PAYLOAD', snapshot: null }, allowedCorsOrigin);
        return;
      }
      const result = settingsBridge.writeSnapshotForPlugin(verified.pluginId, verified.settingsSpec, rawJson);
      writeJsonResponse(res, 200, result, allowedCorsOrigin);
      return;
    }

    if (pathname === '/v1/config/read') {
      if (!configBridge || typeof configBridge.readScopeForPlugin !== 'function') {
        writeJsonResponse(res, 503, { ok: false, reason: 'ERR_CONFIG_BRIDGE_UNAVAILABLE' }, allowedCorsOrigin);
        return;
      }
      const verified = resolveVerifiedPlugin(payload.pluginId);
      if (!verified.ok) {
        writeJsonResponse(res, 403, { ok: false, reason: verified.reason }, allowedCorsOrigin);
        return;
      }
      if (!verified.configBinding) {
        writeJsonResponse(res, 403, { ok: false, reason: 'ERR_CONFIG_BRIDGE_NOT_BOUND' }, allowedCorsOrigin);
        return;
      }
      const scopeId = typeof payload.scopeId === 'string' ? payload.scopeId : '';
      if (!scopeId) {
        writeJsonResponse(res, 400, { ok: false, reason: 'ERR_INVALID_PAYLOAD' }, allowedCorsOrigin);
        return;
      }
      const result = configBridge.readScopeForPlugin(verified.pluginId, verified.configBinding, scopeId);
      writeJsonResponse(res, 200, result, allowedCorsOrigin);
      return;
    }

    if (pathname === '/v1/config/write') {
      if (!configBridge || typeof configBridge.writeScopeForPlugin !== 'function') {
        writeJsonResponse(res, 503, { ok: false, reason: 'ERR_CONFIG_BRIDGE_UNAVAILABLE' }, allowedCorsOrigin);
        return;
      }
      const verified = resolveVerifiedPlugin(payload.pluginId);
      if (!verified.ok) {
        writeJsonResponse(res, 403, { ok: false, reason: verified.reason }, allowedCorsOrigin);
        return;
      }
      if (!verified.configBinding) {
        writeJsonResponse(res, 403, { ok: false, reason: 'ERR_CONFIG_BRIDGE_NOT_BOUND' }, allowedCorsOrigin);
        return;
      }
      const scopeId = typeof payload.scopeId === 'string' ? payload.scopeId : '';
      const rawJson = typeof payload.rawJson === 'string' ? payload.rawJson : null;
      if (!scopeId || rawJson === null) {
        writeJsonResponse(res, 400, { ok: false, reason: 'ERR_INVALID_PAYLOAD' }, allowedCorsOrigin);
        return;
      }
      const opts = {};
      if (Object.prototype.hasOwnProperty.call(payload, 'expectedSha256') && payload.expectedSha256 !== undefined) {
        opts.expectedSha256 = payload.expectedSha256;
      }
      const result = configBridge.writeScopeForPlugin(verified.pluginId, verified.configBinding, scopeId, rawJson, opts);
      writeJsonResponse(res, 200, result, allowedCorsOrigin);
      return;
    }

    if (pathname === '/v1/net/fetch') {
      if (!netFetchBroker || typeof netFetchBroker.fetchForPlugin !== 'function') {
        writeJsonResponse(res, 503, { ok: false, reason: 'ERR_NET_BROKER_UNAVAILABLE' }, allowedCorsOrigin);
        return;
      }
      const verified = resolveVerifiedPlugin(payload.pluginId);
      if (!verified.ok) {
        writeJsonResponse(res, 403, { ok: false, reason: verified.reason }, allowedCorsOrigin);
        return;
      }
      if (!verified.netBinding) {
        writeJsonResponse(res, 403, { ok: false, reason: 'ERR_NET_NOT_DECLARED' }, allowedCorsOrigin);
        return;
      }
      const url = typeof payload.url === 'string' ? payload.url : '';
      if (!url) {
        writeJsonResponse(res, 400, { ok: false, reason: 'ERR_INVALID_PAYLOAD' }, allowedCorsOrigin);
        return;
      }
      // Ensure plugin's latest settings snapshot is hydrated before dynamic loopback port resolution
      if (verified.settingsSpec && settingsBridge && typeof settingsBridge.readSnapshotForPlugin === 'function') {
        try {
          settingsBridge.readSnapshotForPlugin(verified.pluginId, verified.settingsSpec);
        } catch (_snapErr) {}
      }
      const result = await netFetchBroker.fetchForPlugin(verified.netBinding, url, {
        method: payload.method,
        headers: payload.headers,
        body: payload.body,
        timeoutMs: payload.timeoutMs,
      });
      writeJsonResponse(res, 200, result, allowedCorsOrigin);
      return;
    }

    writeJsonResponse(res, 404, { ok: false, reason: 'ERR_REMOTE_BRIDGE_NOT_FOUND' }, allowedCorsOrigin);
  }

  function stop() {
    if (!server) {
      listeningPort = null;
      listeningHost = null;
      return Promise.resolve({ ok: true });
    }
    const current = server;
    server = null;
    listeningPort = null;
    listeningHost = null;
    return new Promise((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        resolve({ ok: true });
      };
      try {
        current.close(() => done());
        if (typeof current.closeIdleConnections === 'function') {
          current.closeIdleConnections();
        }
        if (typeof current.closeAllConnections === 'function') {
          current.closeAllConnections();
        }
      } catch (_err) {
        done();
      }
    });
  }

  function start() {
    if (disposed) {
      return Promise.resolve({ ok: false, reason: 'ERR_REMOTE_BRIDGE_DISPOSED' });
    }
    if (server && listeningPort !== null) {
      return Promise.resolve({ ok: true, port: listeningPort, bindHost: listeningHost });
    }
    return new Promise((resolve) => {
      const nextServer = httpModule.createServer((req, res) => {
        Promise.resolve(handleRequest(req, res)).catch((err) => {
          recordDiag('warn', 'REMOTE_BRIDGE_REQ_ERR', err && err.message ? err.message : String(err));
          try {
            if (!res.headersSent) {
              writeJsonResponse(res, 500, { ok: false, reason: 'ERR_REMOTE_BRIDGE_INTERNAL' });
            } else {
              res.end();
            }
          } catch (_endErr) {}
        });
      });

      const onStartupError = (err) => {
        lastError = err && err.message ? err.message : String(err);
        recordDiag('warn', 'REMOTE_BRIDGE_LISTEN_ERR', lastError);
        try {
          nextServer.close();
        } catch (_closeErr) {}
        resolve({ ok: false, reason: lastError });
      };

      nextServer.once('error', onStartupError);
      nextServer.listen(config.port, config.bindHost, () => {
        nextServer.removeListener('error', onStartupError);
        nextServer.on('error', (err) => {
          lastError = err && err.message ? err.message : String(err);
          recordDiag('warn', 'REMOTE_BRIDGE_SERVER_ERR', lastError);
        });
        const addr = nextServer.address();
        server = nextServer;
        listeningPort = addr && typeof addr === 'object' ? addr.port : config.port;
        listeningHost = config.bindHost;
        lastError = null;
        if (typeof nextServer.unref === 'function') {
          nextServer.unref();
        }
        resolve({ ok: true, port: listeningPort, bindHost: listeningHost });
      });
    });
  }

  function startIfEnabled() {
    if (!config.enabled) {
      return Promise.resolve({ ok: true, skipped: true });
    }
    return start();
  }

  function persistConfig(nextCfg) {
    if (!configPath) {
      config = nextCfg;
      return { ok: true, reason: null };
    }
    const writeRes = writeRemoteBridgeConfigFileAtomic(configPath, nextCfg);
    if (!writeRes.ok) {
      return writeRes;
    }
    config = nextCfg;
    return { ok: true, reason: null };
  }

  async function configure(patch = {}) {
    if (disposed) {
      return { ok: false, reason: 'ERR_REMOTE_BRIDGE_DISPOSED', status: getStatus({ includeSecrets: true }) };
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, reason: 'ERR_INVALID_PAYLOAD', status: getStatus({ includeSecrets: true }) };
    }
    const nextEnabled =
      Object.prototype.hasOwnProperty.call(patch, 'enabled') ? Boolean(patch.enabled) : config.enabled;
    const nextBindHost = Object.prototype.hasOwnProperty.call(patch, 'bindHost')
      ? normalizeBindHost(patch.bindHost)
      : config.bindHost;
    if (!nextBindHost) {
      return { ok: false, reason: 'ERR_REMOTE_BRIDGE_INVALID_BIND_HOST', status: getStatus({ includeSecrets: true }) };
    }
    const nextPort = Object.prototype.hasOwnProperty.call(patch, 'port')
      ? normalizePort(patch.port, { allowZero: true })
      : config.port;
    if (nextPort === null) {
      return { ok: false, reason: 'ERR_REMOTE_BRIDGE_INVALID_PORT', status: getStatus({ includeSecrets: true }) };
    }
    const pubCheck = Object.prototype.hasOwnProperty.call(patch, 'publicUrl')
      ? normalizePublicUrl(patch.publicUrl)
      : { ok: true, value: config.publicUrl };
    if (!pubCheck.ok) {
      return { ok: false, reason: pubCheck.reason, status: getStatus({ includeSecrets: true }) };
    }
    const nextAllowedOrigins = Object.prototype.hasOwnProperty.call(patch, 'allowedOrigins')
      ? normalizeAllowedOrigins(patch.allowedOrigins)
      : config.allowedOrigins;

    const needsRestart =
      server !== null &&
      (nextBindHost !== listeningHost || (nextPort !== 0 && nextPort !== listeningPort));

    const nextCfg = {
      schemaVersion: 1,
      enabled: nextEnabled,
      bindHost: nextBindHost,
      port: nextPort,
      publicUrl: pubCheck.value,
      token: config.token || generateBridgeToken(),
      allowedOrigins: nextAllowedOrigins,
      updatedAt: new Date().toISOString(),
    };

    const saveRes = persistConfig(nextCfg);
    if (!saveRes.ok) {
      return { ok: false, reason: saveRes.reason, status: getStatus({ includeSecrets: true }) };
    }

    if (!nextEnabled) {
      await stop();
      lastError = null;
      return { ok: true, reason: null, status: getStatus({ includeSecrets: true }) };
    }

    if (needsRestart) {
      await stop();
    }
    const startRes = await start();
    if (!startRes.ok) {
      return { ok: false, reason: startRes.reason, status: getStatus({ includeSecrets: true }) };
    }
    return { ok: true, reason: null, status: getStatus({ includeSecrets: true }) };
  }

  function rotateToken() {
    if (disposed) {
      return { ok: false, reason: 'ERR_REMOTE_BRIDGE_DISPOSED', status: getStatus({ includeSecrets: true }) };
    }
    const nextCfg = {
      ...config,
      token: generateBridgeToken(),
      updatedAt: new Date().toISOString(),
    };
    const saveRes = persistConfig(nextCfg);
    if (!saveRes.ok) {
      return { ok: false, reason: saveRes.reason, status: getStatus({ includeSecrets: true }) };
    }
    return { ok: true, reason: null, status: getStatus({ includeSecrets: true }) };
  }

  function getStatus({ includeSecrets = false } = {}) {
    const activePort = listeningPort !== null ? listeningPort : config.port;
    const localUrl = activePort ? `http://127.0.0.1:${activePort}` : null;
    const connectUrl = config.publicUrl || localUrl || '';
    const tokenHint =
      typeof config.token === 'string' && config.token.length >= 12
        ? `${config.token.slice(0, 6)}...${config.token.slice(-4)}`
        : null;
    const base = {
      enabled: Boolean(config.enabled),
      running: Boolean(server && listeningPort !== null),
      bindHost: config.bindHost,
      port: config.port,
      listeningPort,
      localUrl,
      publicUrl: config.publicUrl || '',
      connectUrl,
      allowedOrigins: getEffectiveAllowedOrigins(),
      tokenHint,
      updatedAt: config.updatedAt,
      error: lastError,
    };
    if (includeSecrets) {
      return {
        ...base,
        token: config.token,
        pairingCode: connectUrl ? encodePairingCode({ url: connectUrl, token: config.token }) : null,
      };
    }
    return base;
  }

  function dispose() {
    disposed = true;
    return stop();
  }

  return Object.freeze({
    start,
    startIfEnabled,
    stop,
    configure,
    rotateToken,
    getStatus,
    dispose,
  });
}

module.exports = {
  DEFAULT_REMOTE_BRIDGE_FILENAME,
  DEFAULT_REMOTE_BRIDGE_PORT,
  DEFAULT_REMOTE_BRIDGE_BIND_HOST,
  PAIRING_CODE_PREFIX,
  generateBridgeToken,
  normalizeOrigin,
  normalizePublicUrl,
  encodePairingCode,
  decodePairingCode,
  readRemoteBridgeConfigFile,
  writeRemoteBridgeConfigFileAtomic,
  createRemoteBridgeServer,
};
