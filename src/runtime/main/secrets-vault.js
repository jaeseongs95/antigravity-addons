'use strict';

/**
 * Main-Process OS-Encrypted Secrets Vault backed by Electron `safeStorage` (v3.3.0 — SOLID #0).
 *
 * Security invariants:
 * 1. Fail-closed: NEVER falls back to plaintext disk persistence when OS encryption
 *    (`safeStorage.isEncryptionAvailable()`) is unavailable.
 * 2. Stores encrypted blobs strictly inside host-reserved `secrets-vault.json` (`0o600`,
 *    symlink-rejected, realpath-confined, atomic temp+rename write, 2 MiB file cap).
 * 3. Per-plugin namespace isolation + manifest quota enforcement (`maxKeys`, `maxBytes`).
 * 4. Opt-in read gating: `getSecret()` rejects with `ERR_SECRETS_READ_NOT_ALLOWED` unless
 *    `binding.allowRead === true`; host-internal `resolveSecretForHost()` serves main-process
 *    `net.fetch` `secretHeaders` injection without exposing plaintext to renderer World 998.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseSafeJson } = require('../shared/safe-json');
const {
  DEFAULT_MAX_SECRET_KEYS,
  MAX_SECRET_KEYS_LIMIT,
  DEFAULT_MAX_SECRET_BYTES,
  MIN_MAX_SECRET_BYTES,
  MAX_SECRET_BYTES_LIMIT,
  validateSecretKey,
  validateSecretValue,
} = require('../../core/secrets-policy');

const DEFAULT_SECRETS_VAULT_FILENAME = 'secrets-vault.json';
const MAX_VAULT_FILE_BYTES = 2 * 1024 * 1024;
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const TRANSIENT_FS_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const WRITE_RETRY_DELAYS_MS = Object.freeze([30, 60, 120, 240]);

function syncSleepMs(delayMs) {
  const ms = Math.max(0, Math.floor(Number(delayMs) || 0));
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_err) {
    const end = Date.now() + ms;
    while (Date.now() < end) {}
  }
}

function clampMaxKeys(raw) {
  if (!Number.isInteger(raw)) return DEFAULT_MAX_SECRET_KEYS;
  return Math.max(1, Math.min(MAX_SECRET_KEYS_LIMIT, raw));
}

function clampMaxBytes(raw) {
  if (!Number.isInteger(raw)) return DEFAULT_MAX_SECRET_BYTES;
  return Math.max(MIN_MAX_SECRET_BYTES, Math.min(MAX_SECRET_BYTES_LIMIT, raw));
}

function createEmptyVault() {
  return {
    schemaVersion: 1,
    backend: 'electron-safeStorage',
    plugins: Object.create(null),
  };
}

function createSecretsVault({
  vaultPath = null,
  safeStorage = null,
  fsImpl = fs,
  recordDiag = () => {},
} = {}) {
  function isAvailable() {
    try {
      return Boolean(
        safeStorage &&
          typeof safeStorage.isEncryptionAvailable === 'function' &&
          safeStorage.isEncryptionAvailable() === true &&
          typeof safeStorage.encryptString === 'function' &&
          typeof safeStorage.decryptString === 'function'
      );
    } catch (_err) {
      return false;
    }
  }

  function resolveConfinedVaultPath() {
    if (!vaultPath || typeof vaultPath !== 'string' || !vaultPath.trim()) {
      return { ok: false, reason: 'ERR_SECRETS_VAULT_PATH_UNAVAILABLE' };
    }
    const resolvedTarget = path.resolve(vaultPath.trim());
    const resolvedDir = path.dirname(resolvedTarget);
    const fileName = path.basename(resolvedTarget);
    if (!fileName || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
      return { ok: false, reason: 'ERR_SECRETS_VAULT_INVALID_PATH' };
    }
    return { ok: true, resolvedDir, resolvedTarget, fileName };
  }

  function readVaultFile() {
    const pathInfo = resolveConfinedVaultPath();
    if (!pathInfo.ok) {
      return { ok: false, reason: pathInfo.reason, data: null };
    }
    const { resolvedDir, resolvedTarget } = pathInfo;
    let lstat;
    try {
      lstat = fsImpl.lstatSync(resolvedTarget);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return { ok: true, exists: false, data: createEmptyVault() };
      }
      return { ok: false, reason: 'ERR_SECRETS_VAULT_STAT_FAILED', data: null };
    }
    if (lstat.isSymbolicLink()) {
      return { ok: false, reason: 'ERR_SECRETS_VAULT_SYMLINK_FORBIDDEN', data: null };
    }
    if (!lstat.isFile()) {
      return { ok: false, reason: 'ERR_SECRETS_VAULT_NOT_REGULAR_FILE', data: null };
    }
    if (lstat.size > MAX_VAULT_FILE_BYTES) {
      return { ok: false, reason: 'ERR_SECRETS_VAULT_TOO_LARGE', data: null };
    }

    let realDir;
    let realTarget;
    try {
      realDir = fsImpl.realpathSync(resolvedDir);
      realTarget = fsImpl.realpathSync(resolvedTarget);
    } catch (_err) {
      return { ok: false, reason: 'ERR_SECRETS_VAULT_REALPATH_FAILED', data: null };
    }
    const rel = path.relative(realDir, realTarget);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || path.dirname(realTarget) !== realDir) {
      return { ok: false, reason: 'ERR_SECRETS_VAULT_PATH_ESCAPE', data: null };
    }

    let raw;
    try {
      raw = fsImpl.readFileSync(realTarget, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return { ok: true, exists: false, data: createEmptyVault() };
      }
      return { ok: false, reason: 'ERR_SECRETS_VAULT_READ_FAILED', data: null };
    }

    let parsed;
    try {
      parsed = parseSafeJson(raw);
    } catch (err) {
      const code =
        err && err.message === 'ERR_UNSAFE_JSON_PROTO_KEY'
          ? 'ERR_SECRETS_VAULT_UNSAFE_PROTO_KEY'
          : 'ERR_SECRETS_VAULT_CORRUPTED';
      return { ok: false, reason: code, data: null };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.schemaVersion !== 1) {
      return { ok: false, reason: 'ERR_SECRETS_VAULT_CORRUPTED', data: null };
    }

    const plugins = Object.create(null);
    if (parsed.plugins && typeof parsed.plugins === 'object' && !Array.isArray(parsed.plugins)) {
      for (const [pid, entries] of Object.entries(parsed.plugins)) {
        if (!PLUGIN_ID_RE.test(pid) || !entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
        const cleanEntries = Object.create(null);
        for (const [k, rec] of Object.entries(entries)) {
          const kc = validateSecretKey(k);
          if (!kc.ok || !rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
          if (typeof rec.enc !== 'string' || !rec.enc) continue;
          cleanEntries[kc.key] = {
            enc: rec.enc,
            byteLen: Number.isInteger(rec.byteLen) && rec.byteLen >= 0 ? rec.byteLen : 0,
            updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : null,
          };
        }
        plugins[pid] = cleanEntries;
      }
    }

    return {
      ok: true,
      exists: true,
      data: {
        schemaVersion: 1,
        backend: 'electron-safeStorage',
        plugins,
      },
    };
  }

  function writeVaultFileAtomic(vaultObj) {
    const pathInfo = resolveConfinedVaultPath();
    if (!pathInfo.ok) {
      return { ok: false, reason: pathInfo.reason };
    }
    const { resolvedDir, resolvedTarget, fileName } = pathInfo;

    const plainPlugins = {};
    for (const [pid, entries] of Object.entries(vaultObj.plugins || {})) {
      const entryKeys = Object.keys(entries || {});
      if (entryKeys.length === 0) continue;
      plainPlugins[pid] = {};
      for (const k of entryKeys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
        plainPlugins[pid][k] = entries[k];
      }
    }
    const serialized =
      JSON.stringify(
        {
          schemaVersion: 1,
          backend: 'electron-safeStorage',
          plugins: plainPlugins,
        },
        null,
        2
      ) + '\n';
    const buf = Buffer.from(serialized, 'utf8');
    if (buf.length > MAX_VAULT_FILE_BYTES) {
      return { ok: false, reason: 'ERR_SECRETS_VAULT_TOO_LARGE' };
    }

    try {
      fsImpl.mkdirSync(resolvedDir, { recursive: true });
    } catch (_err) {
      return { ok: false, reason: 'ERR_SECRETS_VAULT_WRITE_FAILED' };
    }

    let realDir;
    try {
      realDir = fsImpl.realpathSync(resolvedDir);
    } catch (_err) {
      return { ok: false, reason: 'ERR_SECRETS_VAULT_REALPATH_FAILED' };
    }

    try {
      const lstat = fsImpl.lstatSync(resolvedTarget);
      if (lstat.isSymbolicLink()) {
        return { ok: false, reason: 'ERR_SECRETS_VAULT_SYMLINK_FORBIDDEN' };
      }
      if (!lstat.isFile()) {
        return { ok: false, reason: 'ERR_SECRETS_VAULT_NOT_REGULAR_FILE' };
      }
      const realTarget = fsImpl.realpathSync(resolvedTarget);
      const rel = path.relative(realDir, realTarget);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || path.dirname(realTarget) !== realDir) {
        return { ok: false, reason: 'ERR_SECRETS_VAULT_PATH_ESCAPE' };
      }
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        return { ok: false, reason: 'ERR_SECRETS_VAULT_STAT_FAILED' };
      }
    }

    const finalTarget = path.join(realDir, fileName);
    const tmpPath = path.join(realDir, `.${fileName}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`);
    try {
      fsImpl.writeFileSync(tmpPath, buf, { mode: 0o600 });
      let lastErr = null;
      for (let attempt = 0; attempt <= WRITE_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
          fsImpl.renameSync(tmpPath, finalTarget);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (err && TRANSIENT_FS_CODES.has(err.code) && attempt < WRITE_RETRY_DELAYS_MS.length) {
            syncSleepMs(WRITE_RETRY_DELAYS_MS[attempt]);
            continue;
          }
          throw err;
        }
      }
      if (lastErr) throw lastErr;
      try {
        if (typeof fsImpl.chmodSync === 'function') {
          fsImpl.chmodSync(finalTarget, 0o600);
        }
      } catch (_chmodErr) {}
      return { ok: true, reason: null };
    } catch (_err) {
      return { ok: false, reason: 'ERR_SECRETS_VAULT_WRITE_FAILED' };
    } finally {
      try {
        if (fsImpl.existsSync(tmpPath)) {
          fsImpl.unlinkSync(tmpPath);
        }
      } catch (_cleanupErr) {}
    }
  }

  function validateBinding(pluginId, binding) {
    if (typeof pluginId !== 'string' || !PLUGIN_ID_RE.test(pluginId)) {
      return { ok: false, reason: 'ERR_INVALID_PLUGIN_ID' };
    }
    if (!binding || typeof binding !== 'object') {
      return { ok: false, reason: 'ERR_SECRETS_NOT_DECLARED' };
    }
    return {
      ok: true,
      pluginId,
      maxKeys: clampMaxKeys(binding.maxKeys),
      maxBytes: clampMaxBytes(binding.maxBytes),
      allowRead: binding.allowRead === true,
    };
  }

  function setSecret(pluginId, binding, rawKey, rawValue) {
    const b = validateBinding(pluginId, binding);
    if (!b.ok) return { ok: false, reason: b.reason };
    const kc = validateSecretKey(rawKey);
    if (!kc.ok) return { ok: false, reason: kc.reason };
    const vc = validateSecretValue(rawValue);
    if (!vc.ok) return { ok: false, reason: vc.reason };
    if (!isAvailable()) {
      return { ok: false, reason: 'ERR_SECRETS_ENCRYPTION_UNAVAILABLE' };
    }

    const loaded = readVaultFile();
    if (!loaded.ok) return { ok: false, reason: loaded.reason };
    const vault = loaded.data;
    if (!vault.plugins[b.pluginId]) {
      vault.plugins[b.pluginId] = Object.create(null);
    }
    const bucket = vault.plugins[b.pluginId];
    const existingKeys = Object.keys(bucket);
    const isNewKey = !Object.prototype.hasOwnProperty.call(bucket, kc.key);
    if (isNewKey && existingKeys.length >= b.maxKeys) {
      return { ok: false, reason: 'ERR_SECRETS_MAX_KEYS_EXCEEDED' };
    }

    let projectedBytes = vc.byteLength;
    for (let i = 0; i < existingKeys.length; i += 1) {
      const k = existingKeys[i];
      if (k === kc.key) continue;
      projectedBytes += Number(bucket[k] && bucket[k].byteLen) || 0;
    }
    if (projectedBytes > b.maxBytes) {
      return { ok: false, reason: 'ERR_SECRETS_QUOTA_EXCEEDED' };
    }

    let encBase64;
    try {
      const cipherBuf = safeStorage.encryptString(vc.value);
      encBase64 = Buffer.isBuffer(cipherBuf)
        ? cipherBuf.toString('base64')
        : Buffer.from(cipherBuf).toString('base64');
    } catch (err) {
      recordDiag('warn', 'SECRETS_ENCRYPT_FAILED', err && err.message ? err.message : String(err));
      return { ok: false, reason: 'ERR_SECRETS_ENCRYPT_FAILED' };
    }

    const updatedAt = new Date().toISOString();
    bucket[kc.key] = {
      enc: encBase64,
      byteLen: vc.byteLength,
      updatedAt,
    };

    const writeRes = writeVaultFileAtomic(vault);
    if (!writeRes.ok) {
      return { ok: false, reason: writeRes.reason };
    }
    return { ok: true, key: kc.key, persistence: 'os-encrypted', updatedAt, reason: null };
  }

  function hasSecret(pluginId, binding, rawKey) {
    const b = validateBinding(pluginId, binding);
    if (!b.ok) return { ok: false, exists: false, reason: b.reason };
    const kc = validateSecretKey(rawKey);
    if (!kc.ok) return { ok: false, exists: false, reason: kc.reason };
    const loaded = readVaultFile();
    if (!loaded.ok) return { ok: false, exists: false, reason: loaded.reason };
    const bucket = loaded.data.plugins[b.pluginId];
    const exists = Boolean(bucket && Object.prototype.hasOwnProperty.call(bucket, kc.key));
    return { ok: true, exists, persistence: isAvailable() ? 'os-encrypted' : 'unavailable', reason: null };
  }

  function listSecretKeys(pluginId, binding) {
    const b = validateBinding(pluginId, binding);
    if (!b.ok) return { ok: false, keys: [], reason: b.reason };
    const loaded = readVaultFile();
    if (!loaded.ok) return { ok: false, keys: [], reason: loaded.reason };
    const bucket = loaded.data.plugins[b.pluginId];
    const keys = bucket ? Object.keys(bucket).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) : [];
    return { ok: true, keys, persistence: isAvailable() ? 'os-encrypted' : 'unavailable', reason: null };
  }

  function deleteSecret(pluginId, binding, rawKey) {
    const b = validateBinding(pluginId, binding);
    if (!b.ok) return { ok: false, deleted: false, reason: b.reason };
    const kc = validateSecretKey(rawKey);
    if (!kc.ok) return { ok: false, deleted: false, reason: kc.reason };
    const loaded = readVaultFile();
    if (!loaded.ok) return { ok: false, deleted: false, reason: loaded.reason };
    const bucket = loaded.data.plugins[b.pluginId];
    if (!bucket || !Object.prototype.hasOwnProperty.call(bucket, kc.key)) {
      return { ok: true, deleted: false, reason: null };
    }
    delete bucket[kc.key];
    const writeRes = writeVaultFileAtomic(loaded.data);
    if (!writeRes.ok) {
      return { ok: false, deleted: false, reason: writeRes.reason };
    }
    return { ok: true, deleted: true, reason: null };
  }

  function decryptRecord(rec) {
    if (!isAvailable()) {
      return { ok: false, reason: 'ERR_SECRETS_ENCRYPTION_UNAVAILABLE' };
    }
    try {
      const plain = safeStorage.decryptString(Buffer.from(rec.enc, 'base64'));
      if (typeof plain !== 'string') {
        return { ok: false, reason: 'ERR_SECRETS_DECRYPT_FAILED' };
      }
      return { ok: true, value: plain };
    } catch (err) {
      recordDiag('warn', 'SECRETS_DECRYPT_FAILED', err && err.message ? err.message : String(err));
      return { ok: false, reason: 'ERR_SECRETS_DECRYPT_FAILED' };
    }
  }

  function getSecret(pluginId, binding, rawKey) {
    const b = validateBinding(pluginId, binding);
    if (!b.ok) return { ok: false, exists: false, value: undefined, reason: b.reason };
    if (!b.allowRead) {
      return { ok: false, exists: false, value: undefined, reason: 'ERR_SECRETS_READ_NOT_ALLOWED' };
    }
    const kc = validateSecretKey(rawKey);
    if (!kc.ok) return { ok: false, exists: false, value: undefined, reason: kc.reason };
    const loaded = readVaultFile();
    if (!loaded.ok) return { ok: false, exists: false, value: undefined, reason: loaded.reason };
    const bucket = loaded.data.plugins[b.pluginId];
    if (!bucket || !Object.prototype.hasOwnProperty.call(bucket, kc.key)) {
      return { ok: true, exists: false, value: undefined, persistence: 'os-encrypted', reason: null };
    }
    const dec = decryptRecord(bucket[kc.key]);
    if (!dec.ok) {
      return { ok: false, exists: true, value: undefined, reason: dec.reason };
    }
    return { ok: true, exists: true, value: dec.value, persistence: 'os-encrypted', reason: null };
  }

  /**
   * Main-process-only resolver for `net.fetch` `secretHeaders` injection.
   * Does NOT require `binding.allowRead === true`, keeping plaintext out of World 998.
   */
  function resolveSecretForHost(pluginId, binding, rawKey) {
    const b = validateBinding(pluginId, binding);
    if (!b.ok) return { ok: false, reason: b.reason };
    const kc = validateSecretKey(rawKey);
    if (!kc.ok) return { ok: false, reason: kc.reason };
    const loaded = readVaultFile();
    if (!loaded.ok) return { ok: false, reason: loaded.reason };
    const bucket = loaded.data.plugins[b.pluginId];
    if (!bucket || !Object.prototype.hasOwnProperty.call(bucket, kc.key)) {
      return { ok: false, reason: `ERR_SECRET_NOT_FOUND:${kc.key}` };
    }
    return decryptRecord(bucket[kc.key]);
  }

  function getStatus() {
    const loaded = readVaultFile();
    return {
      available: isAvailable(),
      backend: 'electron-safeStorage',
      vaultFile: vaultPath ? path.basename(vaultPath) : null,
      pluginCount: loaded.ok && loaded.data ? Object.keys(loaded.data.plugins).length : 0,
    };
  }

  return Object.freeze({
    isAvailable,
    setSecret,
    hasSecret,
    listSecretKeys,
    deleteSecret,
    getSecret,
    resolveSecretForHost,
    getStatus,
  });
}

module.exports = {
  DEFAULT_SECRETS_VAULT_FILENAME,
  MAX_VAULT_FILE_BYTES,
  createSecretsVault,
};
