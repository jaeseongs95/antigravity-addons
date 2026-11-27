'use strict';

/**
 * Declarative Named-Scope Host Config Bridge (v2.3.0 — Option A, zero external dependencies).
 *
 * - Exposes ONLY host-profile-defined named config scopes (`cfg.configScopes`) to trusted
 *   addons whose manifest explicitly declares `configBridge.scopes`.
 * - Enforces:
 *   1. Host-side `(wcId, pluginId)` binding + `ro`/`rw` intersection (fail-closed).
 *   2. Ancestor directory symlink/junction guard (`lstatSync` up `ancestorSymlinkDepth`).
 *   3. Target symlink rejection (`lstatSync`), regular-file check, `realpathSync` confinement,
 *      and reserved host control file protection (`trust-policy.json`, `config.json`, etc.).
 *   4. Bounded single-fd reads (`maxBytes <= 262144`) + prototype-pollution-safe JSON parsing
 *      with optional raw-text recovery (`status: 'corrupt'`, `rawText`, `sha256`).
 *   5. Advisory lockfile (`openSync(..., 'wx', 0o600)` with stale recovery), optimistic
 *      concurrency CAS (`expectedSha256` -> `ERR_CONFIG_CAS_CONFLICT`), private rotating
 *      backups (`maxBackups`), temp-file `fsyncSync`, and retryable atomic `renameSync`.
 *   6. Bounded read-only `plugin-files` directory scans (`maxPlugins`, symlink-rejected).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseSafeJson } = require('../shared/safe-json');

const DEFAULT_MAX_BYTES = 262144;
const MIN_MAX_BYTES = 1024;
const MAX_MAX_BYTES = 262144;
const DEFAULT_MAX_PLUGINS = 128;
const MAX_MAX_PLUGINS = 256;
const DEFAULT_MAX_BACKUPS = 10;
const DEFAULT_ANCESTOR_SYMLINK_DEPTH = 2;
const DEFAULT_STALE_LOCK_MS = 30000;
const TRANSIENT_LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const WRITE_RENAME_RETRY_DELAYS_MS = Object.freeze([30, 60, 120, 240]);
const ADVISORY_LOCK_RETRY_DELAYS_MS = Object.freeze([20, 40, 80, 120, 160]);

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

function isTransientLockError(err) {
  return Boolean(err && typeof err.code === 'string' && TRANSIENT_LOCK_CODES.has(err.code));
}

function normalizePathKey(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

function clampMaxBytes(raw, ceiling = MAX_MAX_BYTES) {
  const maxAllowed = Math.min(MAX_MAX_BYTES, Number.isInteger(ceiling) && ceiling >= MIN_MAX_BYTES ? ceiling : MAX_MAX_BYTES);
  if (!Number.isInteger(raw)) return Math.min(DEFAULT_MAX_BYTES, maxAllowed);
  if (raw < MIN_MAX_BYTES) return MIN_MAX_BYTES;
  if (raw > maxAllowed) return maxAllowed;
  return raw;
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function buildReservedSet(reservedFilePaths, fsImpl = fs) {
  const out = new Set();
  const candidates = Array.isArray(reservedFilePaths) ? reservedFilePaths : [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const resolved = path.resolve(candidate);
    out.add(normalizePathKey(resolved));
    try {
      if (fsImpl.existsSync(resolved)) {
        out.add(normalizePathKey(fsImpl.realpathSync(resolved)));
      }
    } catch (_err) {}
  }
  return out;
}

function checkAncestorSymlinks(targetPath, depth, fsImpl = fs) {
  const maxDepth = Number.isInteger(depth) && depth >= 0 ? Math.min(depth, 16) : DEFAULT_ANCESTOR_SYMLINK_DEPTH;
  let current = path.dirname(path.resolve(targetPath));
  for (let i = 0; i < maxDepth; i += 1) {
    if (!current) break;
    const parent = path.dirname(current);
    try {
      const st = fsImpl.lstatSync(current);
      if (st.isSymbolicLink()) {
        return { ok: false, reason: 'ERR_CONFIG_ANCESTOR_SYMLINK_FORBIDDEN' };
      }
      if (!st.isDirectory()) {
        return { ok: false, reason: 'ERR_CONFIG_NOT_DIRECTORY' };
      }
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        return { ok: false, reason: 'ERR_CONFIG_STAT_FAILED' };
      }
    }
    if (parent === current) break;
    current = parent;
  }
  return { ok: true, reason: null };
}

function readRegularFileBounded(filePath, maxBytes, fsImpl = fs) {
  let lstat;
  try {
    lstat = fsImpl.lstatSync(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ok: true, status: 'missing', buf: null, reason: null };
    }
    return { ok: false, status: 'error', buf: null, reason: 'ERR_CONFIG_STAT_FAILED' };
  }

  if (lstat.isSymbolicLink()) {
    return { ok: false, status: 'error', buf: null, reason: 'ERR_CONFIG_SYMLINK_FORBIDDEN' };
  }
  if (!lstat.isFile()) {
    return { ok: false, status: 'error', buf: null, reason: 'ERR_CONFIG_NOT_REGULAR_FILE' };
  }
  if (lstat.size > maxBytes) {
    return { ok: false, status: 'error', buf: null, reason: 'ERR_CONFIG_FILE_TOO_LARGE' };
  }

  let fd = null;
  try {
    fd = fsImpl.openSync(filePath, 'r');
    const fstat = fsImpl.fstatSync(fd);
    if (!fstat.isFile()) {
      return { ok: false, status: 'error', buf: null, reason: 'ERR_CONFIG_NOT_REGULAR_FILE' };
    }
    if (fstat.size > maxBytes) {
      return { ok: false, status: 'error', buf: null, reason: 'ERR_CONFIG_FILE_TOO_LARGE' };
    }
    const readBuf = Buffer.allocUnsafe(maxBytes + 1);
    let totalRead = 0;
    while (totalRead <= maxBytes) {
      const n = fsImpl.readSync(fd, readBuf, totalRead, readBuf.length - totalRead, totalRead);
      if (n <= 0) break;
      totalRead += n;
    }
    if (totalRead > maxBytes) {
      return { ok: false, status: 'error', buf: null, reason: 'ERR_CONFIG_FILE_TOO_LARGE' };
    }
    return { ok: true, status: 'ok', buf: readBuf.subarray(0, totalRead), reason: null };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ok: true, status: 'missing', buf: null, reason: null };
    }
    return { ok: false, status: 'error', buf: null, reason: 'ERR_CONFIG_READ_FAILED' };
  } finally {
    if (fd !== null) {
      try {
        fsImpl.closeSync(fd);
      } catch (_closeErr) {}
    }
  }
}

function parseJsonObjectWithRecovery(buf, { allowRawRecovery = true } = {}) {
  const sha256 = sha256Hex(buf);
  const rawText = buf.toString('utf8');
  let parsed;
  try {
    parsed = parseSafeJson(rawText);
  } catch (err) {
    if (err && err.message === 'ERR_UNSAFE_JSON_PROTO_KEY') {
      return {
        ok: false,
        status: 'error',
        data: null,
        rawText: null,
        sha256,
        reason: 'ERR_CONFIG_UNSAFE_PROTO_KEY',
      };
    }
    if (allowRawRecovery) {
      return {
        ok: true,
        status: 'corrupt',
        data: null,
        rawText,
        sha256,
        reason: 'ERR_CONFIG_INVALID_JSON',
      };
    }
    return {
      ok: false,
      status: 'error',
      data: null,
      rawText: null,
      sha256,
      reason: 'ERR_CONFIG_INVALID_JSON',
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    if (allowRawRecovery) {
      return {
        ok: true,
        status: 'corrupt',
        data: null,
        rawText,
        sha256,
        reason: 'ERR_CONFIG_MUST_BE_OBJECT',
      };
    }
    return {
      ok: false,
      status: 'error',
      data: null,
      rawText: null,
      sha256,
      reason: 'ERR_CONFIG_MUST_BE_OBJECT',
    };
  }

  return {
    ok: true,
    status: 'ok',
    data: parsed,
    rawText: null,
    sha256,
    reason: null,
  };
}

function readFileScopeSnapshot(scopeId, hostScope, effectiveMaxBytes, { reservedKeys, fsImpl = fs } = {}) {
  const updatedAt = new Date().toISOString();
  const targetPath = hostScope && typeof hostScope.path === 'string' ? hostScope.path.trim() : '';
  if (!targetPath) {
    return {
      ok: false,
      scopeId,
      kind: 'file',
      status: 'error',
      data: null,
      rawText: null,
      sha256: null,
      reason: 'ERR_CONFIG_SCOPE_PATH_MISSING',
      updatedAt,
    };
  }

  const resolvedTarget = path.resolve(targetPath);
  const resolvedParent = path.dirname(resolvedTarget);
  const ancestorCheck = checkAncestorSymlinks(resolvedTarget, hostScope.ancestorSymlinkDepth, fsImpl);
  if (!ancestorCheck.ok) {
    return {
      ok: false,
      scopeId,
      kind: 'file',
      status: 'error',
      data: null,
      rawText: null,
      sha256: null,
      reason: ancestorCheck.reason,
      updatedAt,
    };
  }

  if (reservedKeys && reservedKeys.has(normalizePathKey(resolvedTarget))) {
    return {
      ok: false,
      scopeId,
      kind: 'file',
      status: 'error',
      data: null,
      rawText: null,
      sha256: null,
      reason: 'ERR_CONFIG_RESERVED_PATH',
      updatedAt,
    };
  }

  let lstat;
  try {
    lstat = fsImpl.lstatSync(resolvedTarget);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return {
        ok: true,
        scopeId,
        kind: 'file',
        status: 'missing',
        data: null,
        rawText: null,
        sha256: null,
        reason: null,
        updatedAt,
      };
    }
    return {
      ok: false,
      scopeId,
      kind: 'file',
      status: 'error',
      data: null,
      rawText: null,
      sha256: null,
      reason: 'ERR_CONFIG_STAT_FAILED',
      updatedAt,
    };
  }

  if (lstat.isSymbolicLink()) {
    return {
      ok: false,
      scopeId,
      kind: 'file',
      status: 'error',
      data: null,
      rawText: null,
      sha256: null,
      reason: 'ERR_CONFIG_SYMLINK_FORBIDDEN',
      updatedAt,
    };
  }
  if (!lstat.isFile()) {
    return {
      ok: false,
      scopeId,
      kind: 'file',
      status: 'error',
      data: null,
      rawText: null,
      sha256: null,
      reason: 'ERR_CONFIG_NOT_REGULAR_FILE',
      updatedAt,
    };
  }

  let realParent;
  let realTarget;
  try {
    realParent = fsImpl.realpathSync(resolvedParent);
    realTarget = fsImpl.realpathSync(resolvedTarget);
  } catch (_err) {
    return {
      ok: false,
      scopeId,
      kind: 'file',
      status: 'error',
      data: null,
      rawText: null,
      sha256: null,
      reason: 'ERR_CONFIG_REALPATH_FAILED',
      updatedAt,
    };
  }

  if (path.dirname(realTarget) !== realParent) {
    return {
      ok: false,
      scopeId,
      kind: 'file',
      status: 'error',
      data: null,
      rawText: null,
      sha256: null,
      reason: 'ERR_CONFIG_REALPATH_ESCAPE',
      updatedAt,
    };
  }
  if (reservedKeys && reservedKeys.has(normalizePathKey(realTarget))) {
    return {
      ok: false,
      scopeId,
      kind: 'file',
      status: 'error',
      data: null,
      rawText: null,
      sha256: null,
      reason: 'ERR_CONFIG_RESERVED_PATH',
      updatedAt,
    };
  }

  const readRes = readRegularFileBounded(realTarget, effectiveMaxBytes, fsImpl);
  if (!readRes.ok) {
    return {
      ok: false,
      scopeId,
      kind: 'file',
      status: 'error',
      data: null,
      rawText: null,
      sha256: null,
      reason: readRes.reason,
      updatedAt,
    };
  }
  if (readRes.status === 'missing') {
    return {
      ok: true,
      scopeId,
      kind: 'file',
      status: 'missing',
      data: null,
      rawText: null,
      sha256: null,
      reason: null,
      updatedAt,
    };
  }

  const parsed = parseJsonObjectWithRecovery(readRes.buf, {
    allowRawRecovery: hostScope.allowRawRecovery !== false,
  });

  return {
    ok: parsed.ok,
    scopeId,
    kind: 'file',
    status: parsed.status,
    data: parsed.data,
    rawText: parsed.rawText,
    sha256: parsed.sha256,
    reason: parsed.reason,
    updatedAt,
  };
}

function readPluginFilesScopeSnapshot(scopeId, hostScope, effectiveMaxBytes, { reservedKeys, fsImpl = fs } = {}) {
  const updatedAt = new Date().toISOString();
  const rootDir = hostScope && typeof hostScope.rootDir === 'string' ? hostScope.rootDir.trim() : '';
  const fileName = hostScope && typeof hostScope.fileName === 'string' ? hostScope.fileName.trim() : '';
  const maxPlugins =
    Number.isInteger(hostScope && hostScope.maxPlugins) && hostScope.maxPlugins > 0
      ? Math.min(hostScope.maxPlugins, MAX_MAX_PLUGINS)
      : DEFAULT_MAX_PLUGINS;

  if (!rootDir || !fileName || fileName.includes('/') || fileName.includes('\\') || fileName === '.' || fileName === '..') {
    return {
      ok: false,
      scopeId,
      kind: 'plugin-files',
      status: 'error',
      items: [],
      truncated: false,
      reason: 'ERR_CONFIG_SCOPE_INVALID',
      updatedAt,
    };
  }

  const resolvedRoot = path.resolve(rootDir);
  let rootStat;
  try {
    rootStat = fsImpl.lstatSync(resolvedRoot);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return {
        ok: true,
        scopeId,
        kind: 'plugin-files',
        status: 'missing',
        items: [],
        truncated: false,
        reason: null,
        updatedAt,
      };
    }
    return {
      ok: false,
      scopeId,
      kind: 'plugin-files',
      status: 'error',
      items: [],
      truncated: false,
      reason: 'ERR_CONFIG_STAT_FAILED',
      updatedAt,
    };
  }

  if (rootStat.isSymbolicLink()) {
    return {
      ok: false,
      scopeId,
      kind: 'plugin-files',
      status: 'error',
      items: [],
      truncated: false,
      reason: 'ERR_CONFIG_SYMLINK_FORBIDDEN',
      updatedAt,
    };
  }
  if (!rootStat.isDirectory()) {
    return {
      ok: false,
      scopeId,
      kind: 'plugin-files',
      status: 'error',
      items: [],
      truncated: false,
      reason: 'ERR_CONFIG_NOT_DIRECTORY',
      updatedAt,
    };
  }

  let realRoot;
  try {
    realRoot = fsImpl.realpathSync(resolvedRoot);
  } catch (_err) {
    return {
      ok: false,
      scopeId,
      kind: 'plugin-files',
      status: 'error',
      items: [],
      truncated: false,
      reason: 'ERR_CONFIG_REALPATH_FAILED',
      updatedAt,
    };
  }

  let names;
  try {
    names = fsImpl.readdirSync(realRoot).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch (_err) {
    return {
      ok: false,
      scopeId,
      kind: 'plugin-files',
      status: 'error',
      items: [],
      truncated: false,
      reason: 'ERR_CONFIG_READ_FAILED',
      updatedAt,
    };
  }

  const items = [];
  let scannedDirs = 0;
  let truncated = false;

  for (const name of names) {
    const candidateDir = path.join(realRoot, name);
    let dirStat;
    try {
      dirStat = fsImpl.lstatSync(candidateDir);
    } catch (_err) {
      continue;
    }
    if (dirStat.isSymbolicLink()) {
      items.push({
        pluginId: name,
        status: 'error',
        data: null,
        rawText: null,
        sha256: null,
        reason: 'ERR_CONFIG_SYMLINK_FORBIDDEN',
      });
      continue;
    }
    if (!dirStat.isDirectory()) continue;

    scannedDirs += 1;
    if (scannedDirs > maxPlugins) {
      truncated = true;
      break;
    }

    let realPluginDir;
    try {
      realPluginDir = fsImpl.realpathSync(candidateDir);
    } catch (_err) {
      continue;
    }
    if (path.dirname(realPluginDir) !== realRoot) {
      items.push({
        pluginId: name,
        status: 'error',
        data: null,
        rawText: null,
        sha256: null,
        reason: 'ERR_CONFIG_REALPATH_ESCAPE',
      });
      continue;
    }

    const candidateFile = path.join(realPluginDir, fileName);
    if (reservedKeys && reservedKeys.has(normalizePathKey(candidateFile))) {
      items.push({
        pluginId: name,
        status: 'error',
        data: null,
        rawText: null,
        sha256: null,
        reason: 'ERR_CONFIG_RESERVED_PATH',
      });
      continue;
    }

    let fileLstat;
    try {
      fileLstat = fsImpl.lstatSync(candidateFile);
    } catch (err) {
      if (err && err.code === 'ENOENT') continue;
      items.push({
        pluginId: name,
        status: 'error',
        data: null,
        rawText: null,
        sha256: null,
        reason: 'ERR_CONFIG_STAT_FAILED',
      });
      continue;
    }

    if (fileLstat.isSymbolicLink()) {
      items.push({
        pluginId: name,
        status: 'error',
        data: null,
        rawText: null,
        sha256: null,
        reason: 'ERR_CONFIG_SYMLINK_FORBIDDEN',
      });
      continue;
    }
    if (!fileLstat.isFile()) {
      items.push({
        pluginId: name,
        status: 'error',
        data: null,
        rawText: null,
        sha256: null,
        reason: 'ERR_CONFIG_NOT_REGULAR_FILE',
      });
      continue;
    }

    let realFile;
    try {
      realFile = fsImpl.realpathSync(candidateFile);
    } catch (_err) {
      items.push({
        pluginId: name,
        status: 'error',
        data: null,
        rawText: null,
        sha256: null,
        reason: 'ERR_CONFIG_REALPATH_FAILED',
      });
      continue;
    }
    if (path.dirname(realFile) !== realPluginDir) {
      items.push({
        pluginId: name,
        status: 'error',
        data: null,
        rawText: null,
        sha256: null,
        reason: 'ERR_CONFIG_REALPATH_ESCAPE',
      });
      continue;
    }

    const readRes = readRegularFileBounded(realFile, effectiveMaxBytes, fsImpl);
    if (!readRes.ok) {
      items.push({
        pluginId: name,
        status: 'error',
        data: null,
        rawText: null,
        sha256: null,
        reason: readRes.reason,
      });
      continue;
    }
    if (readRes.status === 'missing') continue;

    const parsed = parseJsonObjectWithRecovery(readRes.buf, {
      allowRawRecovery: hostScope.allowRawRecovery !== false,
    });
    items.push({
      pluginId: name,
      status: parsed.status,
      data: parsed.data,
      rawText: parsed.rawText,
      sha256: parsed.sha256,
      reason: parsed.reason,
    });
  }

  return {
    ok: true,
    scopeId,
    kind: 'plugin-files',
    status: 'ok',
    items,
    truncated,
    reason: null,
    updatedAt,
  };
}

function acquireAdvisoryLock(lockPath, { staleLockMs = DEFAULT_STALE_LOCK_MS, fsImpl = fs } = {}) {
  for (let attempt = 0; attempt <= ADVISORY_LOCK_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const fd = fsImpl.openSync(lockPath, 'wx', 0o600);
      try {
        const meta = Buffer.from(`${process.pid}:${Date.now()}\n`, 'utf8');
        fsImpl.writeSync(fd, meta, 0, meta.length, 0);
      } catch (_writeErr) {}
      return {
        ok: true,
        release() {
          try {
            fsImpl.closeSync(fd);
          } catch (_c) {}
          try {
            fsImpl.unlinkSync(lockPath);
          } catch (_u) {}
        },
      };
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        try {
          const st = fsImpl.lstatSync(lockPath);
          // ceiling: single-user advisory lock; stale unlink race is bounded by O_EXCL ('wx') reopen below.
          if (!st.isSymbolicLink() && Date.now() - st.mtimeMs > staleLockMs) {
            fsImpl.unlinkSync(lockPath);
            continue;
          }
        } catch (_stErr) {}
        if (attempt < ADVISORY_LOCK_RETRY_DELAYS_MS.length) {
          syncSleepMs(ADVISORY_LOCK_RETRY_DELAYS_MS[attempt]);
          continue;
        }
        return { ok: false, reason: 'ERR_CONFIG_LOCK_BUSY' };
      }
      if (isTransientLockError(err) && attempt < ADVISORY_LOCK_RETRY_DELAYS_MS.length) {
        syncSleepMs(ADVISORY_LOCK_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      return { ok: false, reason: 'ERR_CONFIG_LOCK_FAILED' };
    }
  }
  return { ok: false, reason: 'ERR_CONFIG_LOCK_BUSY' };
}

function writePrivateBackup(
  targetPath,
  baseName,
  backupDir,
  maxBackups,
  effectiveMaxBytes,
  fsImpl = fs,
  ancestorSymlinkDepth = DEFAULT_ANCESTOR_SYMLINK_DEPTH
) {
  if (!backupDir || typeof backupDir !== 'string') return { ok: true, backupFileName: null };
  const existingRead = readRegularFileBounded(targetPath, effectiveMaxBytes, fsImpl);
  if (!existingRead.ok) {
    return { ok: false, reason: existingRead.reason, backupFileName: null };
  }
  if (existingRead.status === 'missing' || !existingRead.buf) {
    return { ok: true, backupFileName: null };
  }

  const resolvedBackupDir = path.resolve(backupDir);
  const ancestorCheck = checkAncestorSymlinks(resolvedBackupDir, ancestorSymlinkDepth, fsImpl);
  if (!ancestorCheck.ok) {
    return {
      ok: false,
      reason:
        ancestorCheck.reason === 'ERR_CONFIG_ANCESTOR_SYMLINK_FORBIDDEN'
          ? 'ERR_CONFIG_BACKUP_SYMLINK_FORBIDDEN'
          : ancestorCheck.reason,
      backupFileName: null,
    };
  }
  try {
    const bStat = fsImpl.lstatSync(resolvedBackupDir);
    if (bStat.isSymbolicLink()) {
      return { ok: false, reason: 'ERR_CONFIG_BACKUP_SYMLINK_FORBIDDEN', backupFileName: null };
    }
    if (!bStat.isDirectory()) {
      return { ok: false, reason: 'ERR_CONFIG_BACKUP_NOT_DIRECTORY', backupFileName: null };
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      try {
        fsImpl.mkdirSync(resolvedBackupDir, { recursive: true, mode: 0o700 });
      } catch (_mkErr) {
        return { ok: false, reason: 'ERR_CONFIG_BACKUP_FAILED', backupFileName: null };
      }
    } else {
      return { ok: false, reason: 'ERR_CONFIG_BACKUP_FAILED', backupFileName: null };
    }
  }

  let realBackupDir;
  try {
    realBackupDir = fsImpl.realpathSync(resolvedBackupDir);
  } catch (_rpErr) {
    return { ok: false, reason: 'ERR_CONFIG_BACKUP_FAILED', backupFileName: null };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFileName = `${baseName}.${stamp}.${crypto.randomBytes(4).toString('hex')}.bak`;
  const backupFullPath = path.join(realBackupDir, backupFileName);
  let fd = null;
  try {
    fd = fsImpl.openSync(backupFullPath, 'wx', 0o600);
    fsImpl.writeSync(fd, existingRead.buf, 0, existingRead.buf.length, 0);
    try {
      fsImpl.fsyncSync(fd);
    } catch (_fsyncErr) {}
  } catch (_wErr) {
    return { ok: false, reason: 'ERR_CONFIG_BACKUP_FAILED', backupFileName: null };
  } finally {
    if (fd !== null) {
      try {
        fsImpl.closeSync(fd);
      } catch (_c) {}
    }
  }

  // Rotate older backups beyond maxBackups
  const keepCount = Number.isInteger(maxBackups) && maxBackups > 0 ? Math.min(maxBackups, 100) : DEFAULT_MAX_BACKUPS;
  try {
    const prefix = `${baseName}.`;
    const allBaks = fsImpl
      .readdirSync(realBackupDir)
      .filter((n) => n.startsWith(prefix) && n.endsWith('.bak'))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .reverse();
    for (let i = keepCount; i < allBaks.length; i += 1) {
      const stalePath = path.join(realBackupDir, allBaks[i]);
      try {
        const st = fsImpl.lstatSync(stalePath);
        if (!st.isSymbolicLink() && st.isFile()) {
          fsImpl.unlinkSync(stalePath);
        }
      } catch (_delErr) {}
    }
  } catch (_rotErr) {}

  return { ok: true, backupFileName };
}

function writeFileScopeSnapshot(scopeId, hostScope, effectiveMaxBytes, rawJson, opts = {}, { reservedKeys, fsImpl = fs } = {}) {
  const targetPath = hostScope && typeof hostScope.path === 'string' ? hostScope.path.trim() : '';
  if (!targetPath) {
    return { ok: false, reason: 'ERR_CONFIG_SCOPE_PATH_MISSING', currentSha256: null, snapshot: null };
  }
  if (typeof rawJson !== 'string') {
    return { ok: false, reason: 'ERR_CONFIG_INVALID_JSON', currentSha256: null, snapshot: null };
  }
  if (Buffer.byteLength(rawJson, 'utf8') > effectiveMaxBytes) {
    return { ok: false, reason: 'ERR_CONFIG_FILE_TOO_LARGE', currentSha256: null, snapshot: null };
  }

  let parsed;
  try {
    parsed = parseSafeJson(rawJson);
  } catch (err) {
    const code =
      err && err.message === 'ERR_UNSAFE_JSON_PROTO_KEY' ? 'ERR_CONFIG_UNSAFE_PROTO_KEY' : 'ERR_CONFIG_INVALID_JSON';
    return { ok: false, reason: code, currentSha256: null, snapshot: null };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'ERR_CONFIG_MUST_BE_OBJECT', currentSha256: null, snapshot: null };
  }

  const formatted = JSON.stringify(parsed, null, 2) + '\n';
  const formattedBuf = Buffer.from(formatted, 'utf8');
  if (formattedBuf.length > effectiveMaxBytes) {
    return { ok: false, reason: 'ERR_CONFIG_FILE_TOO_LARGE', currentSha256: null, snapshot: null };
  }

  const resolvedTarget = path.resolve(targetPath);
  const resolvedParent = path.dirname(resolvedTarget);
  const baseName = path.basename(resolvedTarget);

  if (reservedKeys && reservedKeys.has(normalizePathKey(resolvedTarget))) {
    return { ok: false, reason: 'ERR_CONFIG_RESERVED_PATH', currentSha256: null, snapshot: null };
  }

  const preAncestor = checkAncestorSymlinks(resolvedTarget, hostScope.ancestorSymlinkDepth, fsImpl);
  if (!preAncestor.ok) {
    return { ok: false, reason: preAncestor.reason, currentSha256: null, snapshot: null };
  }

  try {
    fsImpl.mkdirSync(resolvedParent, { recursive: true });
  } catch (_mkErr) {
    return { ok: false, reason: 'ERR_CONFIG_WRITE_FAILED', currentSha256: null, snapshot: null };
  }

  const postAncestor = checkAncestorSymlinks(resolvedTarget, hostScope.ancestorSymlinkDepth, fsImpl);
  if (!postAncestor.ok) {
    return { ok: false, reason: postAncestor.reason, currentSha256: null, snapshot: null };
  }

  let realParent;
  try {
    realParent = fsImpl.realpathSync(resolvedParent);
  } catch (_rpErr) {
    return { ok: false, reason: 'ERR_CONFIG_REALPATH_FAILED', currentSha256: null, snapshot: null };
  }

  const finalTarget = path.join(realParent, baseName);
  if (reservedKeys && reservedKeys.has(normalizePathKey(finalTarget))) {
    return { ok: false, reason: 'ERR_CONFIG_RESERVED_PATH', currentSha256: null, snapshot: null };
  }

  const lockPath = path.join(realParent, `.${baseName}.addon-host.lock`);
  const lock = acquireAdvisoryLock(lockPath, { staleLockMs: hostScope.staleLockMs, fsImpl });
  if (!lock.ok) {
    return { ok: false, reason: lock.reason, currentSha256: null, snapshot: null };
  }

  const tmpPath = path.join(realParent, `.${baseName}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`);
  let currentSnap = null;
  try {
    // Re-read current state strictly inside the advisory lock for CAS & symlink enforcement
    currentSnap = readFileScopeSnapshot(scopeId, hostScope, effectiveMaxBytes, { reservedKeys, fsImpl });
    if (currentSnap.status === 'error') {
      return {
        ok: false,
        reason: currentSnap.reason || 'ERR_CONFIG_READ_FAILED',
        currentSha256: currentSnap.sha256,
        snapshot: currentSnap,
      };
    }

    const hasExpected =
      opts &&
      typeof opts === 'object' &&
      Object.prototype.hasOwnProperty.call(opts, 'expectedSha256') &&
      opts.expectedSha256 !== undefined;
    if (hasExpected) {
      const expected = opts.expectedSha256;
      if (expected !== null && typeof expected !== 'string') {
        return {
          ok: false,
          reason: 'ERR_INVALID_EXPECTED_SHA256',
          currentSha256: currentSnap.sha256,
          snapshot: currentSnap,
        };
      }
      if (currentSnap.sha256 !== expected) {
        return {
          ok: false,
          reason: 'ERR_CONFIG_CAS_CONFLICT',
          currentSha256: currentSnap.sha256,
          snapshot: currentSnap,
        };
      }
    }

    // Create private rotating backup of existing file before mutating
    const backupRes = writePrivateBackup(
      finalTarget,
      baseName,
      hostScope.backupDir || null,
      hostScope.maxBackups,
      effectiveMaxBytes,
      fsImpl,
      hostScope.ancestorSymlinkDepth
    );
    if (!backupRes.ok) {
      return {
        ok: false,
        reason: backupRes.reason || 'ERR_CONFIG_BACKUP_FAILED',
        currentSha256: currentSnap.sha256,
        snapshot: currentSnap,
      };
    }

    // Atomic temp-file write + fsync + retryable rename
    let tmpFd = null;
    try {
      tmpFd = fsImpl.openSync(tmpPath, 'wx', 0o600);
      fsImpl.writeSync(tmpFd, formattedBuf, 0, formattedBuf.length, 0);
      try {
        fsImpl.fsyncSync(tmpFd);
      } catch (_fsyncErr) {}
    } finally {
      if (tmpFd !== null) {
        try {
          fsImpl.closeSync(tmpFd);
        } catch (_closeErr) {}
      }
    }

    let lastRenameErr = null;
    for (let attempt = 0; attempt <= WRITE_RENAME_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        fsImpl.renameSync(tmpPath, finalTarget);
        lastRenameErr = null;
        break;
      } catch (err) {
        lastRenameErr = err;
        if (isTransientLockError(err) && attempt < WRITE_RENAME_RETRY_DELAYS_MS.length) {
          syncSleepMs(WRITE_RENAME_RETRY_DELAYS_MS[attempt]);
          continue;
        }
        throw err;
      }
    }
    if (lastRenameErr) throw lastRenameErr;

    const updatedAt = new Date().toISOString();
    const newSha = sha256Hex(formattedBuf);
    return {
      ok: true,
      reason: null,
      backupFileName: backupRes.backupFileName,
      currentSha256: newSha,
      snapshot: {
        ok: true,
        scopeId,
        kind: 'file',
        status: 'ok',
        data: parsed,
        rawText: null,
        sha256: newSha,
        reason: null,
        updatedAt,
      },
    };
  } catch (_writeErr) {
    return {
      ok: false,
      reason: 'ERR_CONFIG_WRITE_FAILED',
      currentSha256: currentSnap ? currentSnap.sha256 : null,
      snapshot: currentSnap || null,
    };
  } finally {
    try {
      if (fsImpl.existsSync(tmpPath)) {
        fsImpl.unlinkSync(tmpPath);
      }
    } catch (_tmpCleanupErr) {}
    lock.release();
  }
}

function createConfigBridge({
  configScopes = {},
  reservedFilePaths = [],
  fsImpl = fs,
  recordDiag = () => {},
} = {}) {
  const scopeMap = new Map();
  if (configScopes && typeof configScopes === 'object') {
    for (const [scopeId, spec] of Object.entries(configScopes)) {
      if (!scopeId || !spec || typeof spec !== 'object') continue;
      if (spec.kind !== 'file' && spec.kind !== 'plugin-files') continue;
      scopeMap.set(scopeId, Object.freeze({ ...spec }));
    }
  }

  function resolvePluginScopeBinding(binding, scopeId) {
    if (!binding || !Array.isArray(binding.scopes)) return null;
    for (const s of binding.scopes) {
      if (s && s.scopeId === scopeId) return s;
    }
    return null;
  }

  function readScopeForPlugin(pluginId, binding, scopeId) {
    const updatedAt = new Date().toISOString();
    if (typeof scopeId !== 'string' || !scopeId) {
      return { ok: false, scopeId: '', status: 'error', data: null, rawText: null, sha256: null, reason: 'ERR_INVALID_CONFIG_SCOPE_ID', updatedAt };
    }
    const pluginScope = resolvePluginScopeBinding(binding, scopeId);
    if (!pluginScope) {
      return { ok: false, scopeId, status: 'error', data: null, rawText: null, sha256: null, reason: 'ERR_CONFIG_SCOPE_NOT_DECLARED', updatedAt };
    }
    const hostScope = scopeMap.get(scopeId);
    if (!hostScope) {
      return { ok: false, scopeId, status: 'error', data: null, rawText: null, sha256: null, reason: 'ERR_CONFIG_SCOPE_NOT_SUPPORTED', updatedAt };
    }

    const effectiveMaxBytes = clampMaxBytes(pluginScope.maxBytes, hostScope.maxBytes);
    const reservedKeys = buildReservedSet(reservedFilePaths, fsImpl);
    try {
      if (hostScope.kind === 'plugin-files') {
        return readPluginFilesScopeSnapshot(scopeId, hostScope, effectiveMaxBytes, { reservedKeys, fsImpl });
      }
      return readFileScopeSnapshot(scopeId, hostScope, effectiveMaxBytes, { reservedKeys, fsImpl });
    } catch (err) {
      recordDiag('warn', 'CONFIG_BRIDGE_READ_ERR', `${pluginId}@${scopeId}: ${err && err.message ? err.message : String(err)}`);
      return { ok: false, scopeId, status: 'error', data: null, rawText: null, sha256: null, reason: 'ERR_CONFIG_READ_FAILED', updatedAt };
    }
  }

  function writeScopeForPlugin(pluginId, binding, scopeId, rawJson, opts = {}) {
    if (typeof scopeId !== 'string' || !scopeId) {
      return { ok: false, reason: 'ERR_INVALID_CONFIG_SCOPE_ID', currentSha256: null, snapshot: null };
    }
    const pluginScope = resolvePluginScopeBinding(binding, scopeId);
    if (!pluginScope) {
      return { ok: false, reason: 'ERR_CONFIG_SCOPE_NOT_DECLARED', currentSha256: null, snapshot: null };
    }
    if (pluginScope.access !== 'rw') {
      return { ok: false, reason: 'ERR_CONFIG_SCOPE_READ_ONLY', currentSha256: null, snapshot: null };
    }
    const hostScope = scopeMap.get(scopeId);
    if (!hostScope) {
      return { ok: false, reason: 'ERR_CONFIG_SCOPE_NOT_SUPPORTED', currentSha256: null, snapshot: null };
    }
    if (hostScope.kind !== 'file' || hostScope.access !== 'rw') {
      return { ok: false, reason: 'ERR_CONFIG_SCOPE_READ_ONLY', currentSha256: null, snapshot: null };
    }

    const effectiveMaxBytes = clampMaxBytes(pluginScope.maxBytes, hostScope.maxBytes);
    const reservedKeys = buildReservedSet(reservedFilePaths, fsImpl);
    try {
      return writeFileScopeSnapshot(scopeId, hostScope, effectiveMaxBytes, rawJson, opts, { reservedKeys, fsImpl });
    } catch (err) {
      recordDiag('warn', 'CONFIG_BRIDGE_WRITE_ERR', `${pluginId}@${scopeId}: ${err && err.message ? err.message : String(err)}`);
      return { ok: false, reason: 'ERR_CONFIG_WRITE_FAILED', currentSha256: null, snapshot: null };
    }
  }

  function getStatus() {
    return {
      scopeCount: scopeMap.size,
      scopes: Array.from(scopeMap.entries()).map(([scopeId, spec]) => ({
        scopeId,
        kind: spec.kind,
        access: spec.access,
        maxBytes: clampMaxBytes(spec.maxBytes),
      })),
    };
  }

  return Object.freeze({
    readScopeForPlugin,
    writeScopeForPlugin,
    getStatus,
  });
}

module.exports = {
  DEFAULT_MAX_BYTES,
  MIN_MAX_BYTES,
  MAX_MAX_BYTES,
  DEFAULT_MAX_PLUGINS,
  DEFAULT_MAX_BACKUPS,
  checkAncestorSymlinks,
  readFileScopeSnapshot,
  readPluginFilesScopeSnapshot,
  writeFileScopeSnapshot,
  createConfigBridge,
};
