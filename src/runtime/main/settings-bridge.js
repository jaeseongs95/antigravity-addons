'use strict';

/**
 * Unidirectional Read-Only Host Settings File Bridge (v2.1.0 — zero external dependencies).
 *
 * - Reads declared flat JSON settings files strictly inside host-owned `settingsDataDir`
 *   (NEVER inside `~/.gemini/config/plugins/`).
 * - Enforces symlink rejection (`lstatSync`), regular-file check, `realpathSync` confinement,
 *   static + runtime reserved host file protection, pre- and post-read `maxBytes` cap,
 *   and prototype-pollution-safe JSON parsing (`parseSafeJson`).
 * - Maintains at most ONE debounced `fs.watch` on `settingsDataDir` while >= 1 active trusted
 *   plugin declares `settingsBridge`, deduplicating notifications by `(status, sha256, reason)`.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseSafeJson } = require('../shared/safe-json');
const { isReservedSettingsFileName } = require('../../core/manifest-validator');

const DEFAULT_MAX_BYTES = 65536;
const MIN_MAX_BYTES = 1024;
const MAX_MAX_BYTES = 262144;
const DEFAULT_DEBOUNCE_MS = 150;
const TRANSIENT_LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const DEFAULT_TRANSIENT_RETRY_DELAYS_MS = Object.freeze([80, 160, 320]);
const DEFAULT_POST_ERROR_RETRY_DELAYS_MS = Object.freeze([1000, 2000]);
const WRITE_RENAME_RETRY_DELAYS_MS = Object.freeze([30, 60, 120, 240]);
const DEFAULT_WATCHER_RECONNECT_BASE_MS = 500;
const DEFAULT_WATCHER_RECONNECT_MAX_MS = 5000;

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

function clampMaxBytes(raw) {
  if (!Number.isInteger(raw)) return DEFAULT_MAX_BYTES;
  if (raw < MIN_MAX_BYTES) return MIN_MAX_BYTES;
  if (raw > MAX_MAX_BYTES) return MAX_MAX_BYTES;
  return raw;
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function buildReservedSet(settingsDataDir, reservedFilePaths) {
  const out = new Set();
  const candidates = Array.isArray(reservedFilePaths) ? reservedFilePaths.slice() : [];
  if (settingsDataDir) {
    const base = path.resolve(settingsDataDir);
    candidates.push(
      path.join(base, 'trust-policy.json'),
      path.join(base, 'config.json'),
      path.join(base, 'index.json'),
      path.join(base, 'build-manifest.json'),
      path.join(base, 'package.json')
    );
  }
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const resolved = path.resolve(candidate);
    out.add(normalizePathKey(resolved));
    try {
      if (fs.existsSync(resolved)) {
        out.add(normalizePathKey(fs.realpathSync(resolved)));
      }
    } catch (_err) {}
  }
  return out;
}

function readSettingsFileSnapshot(settingsDataDir, spec, { reservedFilePaths = [], fsImpl = fs } = {}) {
  const updatedAt = new Date().toISOString();
  const fileName = spec && typeof spec.fileName === 'string' ? spec.fileName.trim() : '';
  const maxBytes = clampMaxBytes(spec && spec.maxBytes);

  if (!settingsDataDir || typeof settingsDataDir !== 'string') {
    return { status: 'error', data: null, sha256: null, reason: 'ERR_SETTINGS_DATA_DIR_UNAVAILABLE', updatedAt };
  }
  if (!fileName || isReservedSettingsFileName(fileName)) {
    return { status: 'error', data: null, sha256: null, reason: 'ERR_SETTINGS_RESERVED_OR_INVALID_FILE', updatedAt };
  }

  const resolvedBase = path.resolve(settingsDataDir);
  const resolvedTarget = path.resolve(resolvedBase, fileName);
  if (path.dirname(resolvedTarget) !== resolvedBase) {
    return { status: 'error', data: null, sha256: null, reason: 'ERR_SETTINGS_PATH_ESCAPE', updatedAt };
  }

  const reservedKeys = buildReservedSet(resolvedBase, reservedFilePaths);
  if (reservedKeys.has(normalizePathKey(resolvedTarget))) {
    return { status: 'error', data: null, sha256: null, reason: 'ERR_SETTINGS_RESERVED_PATH', updatedAt };
  }

  let lstat;
  try {
    lstat = fsImpl.lstatSync(resolvedTarget);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { status: 'missing', data: null, sha256: null, reason: 'ERR_SETTINGS_FILE_MISSING', updatedAt };
    }
    return {
      status: 'error',
      data: null,
      sha256: null,
      reason: 'ERR_SETTINGS_STAT_FAILED',
      transient: isTransientLockError(err),
      updatedAt,
    };
  }

  if (lstat.isSymbolicLink()) {
    return { status: 'error', data: null, sha256: null, reason: 'ERR_SETTINGS_SYMLINK_FORBIDDEN', updatedAt };
  }
  if (!lstat.isFile()) {
    return { status: 'error', data: null, sha256: null, reason: 'ERR_SETTINGS_NOT_REGULAR_FILE', updatedAt };
  }
  if (lstat.size > maxBytes) {
    return { status: 'error', data: null, sha256: null, reason: 'ERR_SETTINGS_FILE_TOO_LARGE', updatedAt };
  }

  let realBase;
  let realTarget;
  try {
    realBase = fsImpl.realpathSync(resolvedBase);
    realTarget = fsImpl.realpathSync(resolvedTarget);
  } catch (err) {
    return {
      status: 'error',
      data: null,
      sha256: null,
      reason: 'ERR_SETTINGS_REALPATH_FAILED',
      transient: isTransientLockError(err),
      updatedAt,
    };
  }

  const rel = path.relative(realBase, realTarget);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || path.dirname(realTarget) !== realBase) {
    return { status: 'error', data: null, sha256: null, reason: 'ERR_SETTINGS_REALPATH_ESCAPE', updatedAt };
  }
  if (reservedKeys.has(normalizePathKey(realTarget))) {
    return { status: 'error', data: null, sha256: null, reason: 'ERR_SETTINGS_RESERVED_PATH', updatedAt };
  }

  let buf;
  let fd = null;
  try {
    fd = fsImpl.openSync(realTarget, 'r');
    const fstat = fsImpl.fstatSync(fd);
    if (!fstat.isFile()) {
      return { status: 'error', data: null, sha256: null, reason: 'ERR_SETTINGS_NOT_REGULAR_FILE', updatedAt };
    }
    if (fstat.size > maxBytes) {
      return { status: 'error', data: null, sha256: null, reason: 'ERR_SETTINGS_FILE_TOO_LARGE', updatedAt };
    }
    const readBuf = Buffer.allocUnsafe(maxBytes + 1);
    let totalRead = 0;
    while (totalRead <= maxBytes) {
      const n = fsImpl.readSync(fd, readBuf, totalRead, readBuf.length - totalRead, totalRead);
      if (n <= 0) break;
      totalRead += n;
    }
    if (totalRead > maxBytes) {
      return { status: 'error', data: null, sha256: null, reason: 'ERR_SETTINGS_FILE_TOO_LARGE', updatedAt };
    }
    buf = readBuf.subarray(0, totalRead);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { status: 'missing', data: null, sha256: null, reason: 'ERR_SETTINGS_FILE_MISSING', updatedAt };
    }
    return {
      status: 'error',
      data: null,
      sha256: null,
      reason: 'ERR_SETTINGS_READ_FAILED',
      transient: isTransientLockError(err),
      updatedAt,
    };
  } finally {
    if (fd !== null) {
      try {
        fsImpl.closeSync(fd);
      } catch (_closeErr) {}
    }
  }

  let parsed;
  try {
    parsed = parseSafeJson(buf.toString('utf8'));
  } catch (err) {
    const code =
      err && err.message === 'ERR_UNSAFE_JSON_PROTO_KEY' ? 'ERR_SETTINGS_UNSAFE_PROTO_KEY' : 'ERR_SETTINGS_INVALID_JSON';
    return { status: 'error', data: null, sha256: null, reason: code, updatedAt };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'error', data: null, sha256: null, reason: 'ERR_SETTINGS_MUST_BE_OBJECT', updatedAt };
  }

  return {
    status: 'ok',
    data: parsed,
    sha256: sha256Hex(buf),
    reason: null,
    updatedAt,
  };
}

function writeSettingsFileSnapshot(settingsDataDir, spec, rawJson, { reservedFilePaths = [], fsImpl = fs } = {}) {
  const fileName = spec && typeof spec.fileName === 'string' ? spec.fileName.trim() : '';
  const maxBytes = clampMaxBytes(spec && spec.maxBytes);

  if (!settingsDataDir || typeof settingsDataDir !== 'string') {
    return { ok: false, reason: 'ERR_SETTINGS_DATA_DIR_UNAVAILABLE', sha256: null };
  }
  if (!fileName || isReservedSettingsFileName(fileName)) {
    return { ok: false, reason: 'ERR_SETTINGS_RESERVED_OR_INVALID_FILE', sha256: null };
  }
  if (typeof rawJson !== 'string') {
    return { ok: false, reason: 'ERR_SETTINGS_INVALID_JSON', sha256: null };
  }
  if (Buffer.byteLength(rawJson, 'utf8') > maxBytes) {
    return { ok: false, reason: 'ERR_SETTINGS_FILE_TOO_LARGE', sha256: null };
  }

  let parsed;
  try {
    parsed = parseSafeJson(rawJson);
  } catch (err) {
    const code =
      err && err.message === 'ERR_UNSAFE_JSON_PROTO_KEY' ? 'ERR_SETTINGS_UNSAFE_PROTO_KEY' : 'ERR_SETTINGS_INVALID_JSON';
    return { ok: false, reason: code, sha256: null };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'ERR_SETTINGS_MUST_BE_OBJECT', sha256: null };
  }

  const formatted = JSON.stringify(parsed, null, 2) + '\n';
  const formattedBuf = Buffer.from(formatted, 'utf8');
  if (formattedBuf.length > maxBytes) {
    return { ok: false, reason: 'ERR_SETTINGS_FILE_TOO_LARGE', sha256: null };
  }

  const resolvedBase = path.resolve(settingsDataDir);
  const resolvedTarget = path.resolve(resolvedBase, fileName);
  if (path.dirname(resolvedTarget) !== resolvedBase) {
    return { ok: false, reason: 'ERR_SETTINGS_PATH_ESCAPE', sha256: null };
  }

  const reservedKeys = buildReservedSet(resolvedBase, reservedFilePaths);
  if (reservedKeys.has(normalizePathKey(resolvedTarget))) {
    return { ok: false, reason: 'ERR_SETTINGS_RESERVED_PATH', sha256: null };
  }

  try {
    fsImpl.mkdirSync(resolvedBase, { recursive: true });
  } catch (_err) {
    return { ok: false, reason: 'ERR_SETTINGS_WRITE_FAILED', sha256: null };
  }

  let realBase;
  try {
    realBase = fsImpl.realpathSync(resolvedBase);
  } catch (_err) {
    return { ok: false, reason: 'ERR_SETTINGS_REALPATH_FAILED', sha256: null };
  }

  // If the target already exists, strictly forbid symlinks, non-regular files, realpath escapes, and reserved files
  let exists = false;
  try {
    const lstat = fsImpl.lstatSync(resolvedTarget);
    exists = true;
    if (lstat.isSymbolicLink()) {
      return { ok: false, reason: 'ERR_SETTINGS_SYMLINK_FORBIDDEN', sha256: null };
    }
    if (!lstat.isFile()) {
      return { ok: false, reason: 'ERR_SETTINGS_NOT_REGULAR_FILE', sha256: null };
    }
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      return { ok: false, reason: 'ERR_SETTINGS_STAT_FAILED', sha256: null };
    }
  }

  if (exists) {
    let realTarget;
    try {
      realTarget = fsImpl.realpathSync(resolvedTarget);
    } catch (_err) {
      return { ok: false, reason: 'ERR_SETTINGS_REALPATH_FAILED', sha256: null };
    }
    const rel = path.relative(realBase, realTarget);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || path.dirname(realTarget) !== realBase) {
      return { ok: false, reason: 'ERR_SETTINGS_REALPATH_ESCAPE', sha256: null };
    }
    if (reservedKeys.has(normalizePathKey(realTarget))) {
      return { ok: false, reason: 'ERR_SETTINGS_RESERVED_PATH', sha256: null };
    }
  }

  const finalTarget = path.join(realBase, fileName);
  const tmpPath = path.join(realBase, `.${fileName}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`);
  try {
    fsImpl.writeFileSync(tmpPath, formattedBuf, { mode: 0o600 });
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
    return { ok: true, reason: null, sha256: sha256Hex(formattedBuf) };
  } catch (_err) {
    return { ok: false, reason: 'ERR_SETTINGS_WRITE_FAILED', sha256: null };
  } finally {
    try {
      if (fsImpl.existsSync(tmpPath)) {
        fsImpl.unlinkSync(tmpPath);
      }
    } catch (_cleanupErr) {}
  }
}

function snapshotKey(snap) {
  return `${snap.status}:${snap.sha256 || ''}:${snap.reason || ''}`;
}

function createSettingsBridge({
  settingsDataDir = null,
  reservedFilePaths = [],
  onSnapshotChange = () => {},
  debounceMs = DEFAULT_DEBOUNCE_MS,
  transientRetryDelaysMs = DEFAULT_TRANSIENT_RETRY_DELAYS_MS,
  postErrorRetryDelaysMs = DEFAULT_POST_ERROR_RETRY_DELAYS_MS,
  watcherReconnectBaseMs = DEFAULT_WATCHER_RECONNECT_BASE_MS,
  watcherReconnectMaxMs = DEFAULT_WATCHER_RECONNECT_MAX_MS,
  fsImpl = fs,
  recordDiag = () => {},
} = {}) {
  const effectiveDebounceMs =
    Number.isInteger(debounceMs) && debounceMs >= 10 && debounceMs <= 5000 ? debounceMs : DEFAULT_DEBOUNCE_MS;
  const effectiveTransientDelays =
    Array.isArray(transientRetryDelaysMs) ? transientRetryDelaysMs.filter((n) => Number.isFinite(n) && n >= 0) : DEFAULT_TRANSIENT_RETRY_DELAYS_MS;
  const effectivePostErrorDelays =
    Array.isArray(postErrorRetryDelaysMs) ? postErrorRetryDelaysMs.filter((n) => Number.isFinite(n) && n >= 0) : DEFAULT_POST_ERROR_RETRY_DELAYS_MS;
  const effectiveReconnectBaseMs =
    Number.isFinite(watcherReconnectBaseMs) && watcherReconnectBaseMs >= 10 ? watcherReconnectBaseMs : DEFAULT_WATCHER_RECONNECT_BASE_MS;
  const effectiveReconnectMaxMs =
    Number.isFinite(watcherReconnectMaxMs) && watcherReconnectMaxMs >= effectiveReconnectBaseMs ? watcherReconnectMaxMs : DEFAULT_WATCHER_RECONNECT_MAX_MS;

  const bindings = new Map(); // pluginId -> { fileName, maxBytes, revision, lastKey, lastSnapshot, transientRetries, postErrorRetries, retryTimer }
  let watcher = null;
  let debounceTimer = null;
  let watcherReconnectTimer = null;
  let watcherReconnectAttempt = 0;
  let watcherHadFailure = false;
  let disposed = false;

  function clearEntryRetryTimer(entry) {
    if (entry && entry.retryTimer) {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
    }
  }

  function clearWatcherReconnectTimer() {
    if (watcherReconnectTimer) {
      clearTimeout(watcherReconnectTimer);
      watcherReconnectTimer = null;
    }
  }

  function closeWatcher() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (watcher) {
      try {
        watcher.close();
      } catch (_err) {}
      watcher = null;
    }
  }

  function scheduleTransientRetry(pluginId, entry, delayMs) {
    if (disposed || !entry) return;
    clearEntryRetryTimer(entry);
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      if (disposed || bindings.get(pluginId) !== entry) return;
      evaluateBinding(pluginId, entry, { emitIfChanged: true, isScheduledRetry: true });
    }, delayMs);
    if (entry.retryTimer && typeof entry.retryTimer.unref === 'function') {
      entry.retryTimer.unref();
    }
  }

  function evaluateBinding(pluginId, entry, { emitIfChanged = true, isScheduledRetry = false } = {}) {
    const raw = readSettingsFileSnapshot(settingsDataDir, entry, { reservedFilePaths, fsImpl });

    // I2: Gracefully retry transient Windows file locks (EBUSY/EPERM/EACCES) before tripping Fail-Closed
    if (raw.transient) {
      const preErrorIdx = entry.transientRetries || 0;
      if (entry.lastSnapshot && preErrorIdx < effectiveTransientDelays.length) {
        entry.transientRetries = preErrorIdx + 1;
        scheduleTransientRetry(pluginId, entry, effectiveTransientDelays[preErrorIdx]);
        return { changed: false, snapshot: entry.lastSnapshot, transientDeferred: true };
      }
      // Exhausted grace retries (or initial read hit transient lock): fail closed AND schedule bounded self-healing recheck
      const postIdx = entry.postErrorRetries || 0;
      if (postIdx < effectivePostErrorDelays.length) {
        entry.postErrorRetries = postIdx + 1;
        scheduleTransientRetry(pluginId, entry, effectivePostErrorDelays[postIdx]);
      }
    } else {
      entry.transientRetries = 0;
      entry.postErrorRetries = 0;
      if (!isScheduledRetry) {
        clearEntryRetryTimer(entry);
      }
    }

    const nextKey = snapshotKey(raw);
    if (entry.lastKey === nextKey && entry.lastSnapshot) {
      return { changed: false, snapshot: entry.lastSnapshot };
    }
    entry.revision += 1;
    const snapshot = {
      status: raw.status,
      data: raw.data,
      sha256: raw.sha256,
      reason: raw.reason,
      revision: entry.revision,
      updatedAt: raw.updatedAt,
    };
    entry.lastKey = nextKey;
    entry.lastSnapshot = snapshot;
    if (emitIfChanged) {
      try {
        onSnapshotChange(pluginId, snapshot);
      } catch (err) {
        recordDiag('warn', 'SETTINGS_BRIDGE_CALLBACK_ERR', err && err.message ? err.message : String(err));
      }
    }
    return { changed: true, snapshot };
  }

  function refreshNow() {
    if (disposed) return 0;
    let changedCount = 0;
    for (const [pluginId, entry] of bindings.entries()) {
      const res = evaluateBinding(pluginId, entry, { emitIfChanged: true });
      if (res.changed) changedCount += 1;
    }
    return changedCount;
  }

  function scheduleRefresh() {
    if (disposed || bindings.size === 0) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      refreshNow();
    }, effectiveDebounceMs);
    if (debounceTimer && typeof debounceTimer.unref === 'function') {
      debounceTimer.unref();
    }
  }

  function scheduleWatcherReconnect() {
    if (disposed || bindings.size === 0 || watcher || watcherReconnectTimer) return;
    const delayMs = Math.min(
      effectiveReconnectBaseMs * Math.pow(2, watcherReconnectAttempt),
      effectiveReconnectMaxMs
    );
    watcherReconnectAttempt += 1;
    watcherHadFailure = true;
    watcherReconnectTimer = setTimeout(() => {
      watcherReconnectTimer = null;
      ensureWatcher();
    }, delayMs);
    if (watcherReconnectTimer && typeof watcherReconnectTimer.unref === 'function') {
      watcherReconnectTimer.unref();
    }
  }

  function ensureWatcher() {
    if (disposed || bindings.size === 0) {
      clearWatcherReconnectTimer();
      closeWatcher();
      return;
    }
    if (watcher) return;
    if (!settingsDataDir) return;
    if (!fsImpl.existsSync(settingsDataDir)) {
      scheduleWatcherReconnect();
      return;
    }
    try {
      watcher = fsImpl.watch(settingsDataDir, { persistent: false }, (_eventType, _filename) => {
        scheduleRefresh();
      });
      if (watcher && typeof watcher.on === 'function') {
        watcher.on('error', (err) => {
          recordDiag('warn', 'SETTINGS_BRIDGE_WATCH_ERR', err && err.message ? err.message : String(err));
          closeWatcher();
          scheduleWatcherReconnect();
        });
      }
      const recovered = watcherHadFailure;
      watcherReconnectAttempt = 0;
      watcherHadFailure = false;
      clearWatcherReconnectTimer();
      if (recovered) {
        refreshNow();
      }
    } catch (err) {
      recordDiag('warn', 'SETTINGS_BRIDGE_WATCH_START_ERR', err && err.message ? err.message : String(err));
      closeWatcher();
      scheduleWatcherReconnect();
    }
  }

  function createBindingEntry(fileName, maxBytes, revision = 0) {
    return {
      fileName,
      maxBytes,
      revision,
      lastKey: null,
      lastSnapshot: null,
      transientRetries: 0,
      postErrorRetries: 0,
      retryTimer: null,
    };
  }

  function readSnapshotForPlugin(pluginId, spec) {
    if (disposed) {
      return {
        status: 'error',
        data: null,
        sha256: null,
        reason: 'ERR_SETTINGS_BRIDGE_DISPOSED',
        revision: 0,
        updatedAt: new Date().toISOString(),
      };
    }
    const existing = bindings.get(pluginId);
    const fileName = spec && typeof spec.fileName === 'string' ? spec.fileName.trim() : '';
    const maxBytes = clampMaxBytes(spec && spec.maxBytes);
    if (existing && existing.fileName === fileName && existing.maxBytes === maxBytes) {
      // I1: Propagate detected file changes to already-bound windows instead of silently advancing lastKey
      const shouldEmit = existing.lastKey !== null;
      const res = evaluateBinding(pluginId, existing, { emitIfChanged: shouldEmit });
      ensureWatcher();
      return res.snapshot;
    }
    if (existing) clearEntryRetryTimer(existing);
    const nextEntry = createBindingEntry(fileName, maxBytes, existing ? existing.revision : 0);
    bindings.set(pluginId, nextEntry);
    const res = evaluateBinding(pluginId, nextEntry, { emitIfChanged: false });
    ensureWatcher();
    return res.snapshot;
  }

  function writeSnapshotForPlugin(pluginId, spec, rawJson) {
    if (disposed) {
      return { ok: false, reason: 'ERR_SETTINGS_BRIDGE_DISPOSED', snapshot: null };
    }
    if (!pluginId || typeof pluginId !== 'string') {
      return { ok: false, reason: 'ERR_SETTINGS_BRIDGE_NOT_BOUND', snapshot: null };
    }
    const fileName = spec && typeof spec.fileName === 'string' ? spec.fileName.trim() : '';
    const maxBytes = clampMaxBytes(spec && spec.maxBytes);
    const writeRes = writeSettingsFileSnapshot(settingsDataDir, { fileName, maxBytes }, rawJson, {
      reservedFilePaths,
      fsImpl,
    });
    if (!writeRes.ok) {
      return { ok: false, reason: writeRes.reason, snapshot: null };
    }
    let entry = bindings.get(pluginId);
    if (!entry || entry.fileName !== fileName || entry.maxBytes !== maxBytes) {
      if (entry) clearEntryRetryTimer(entry);
      entry = createBindingEntry(fileName, maxBytes, entry ? entry.revision : 0);
      bindings.set(pluginId, entry);
    }
    const evalRes = evaluateBinding(pluginId, entry, { emitIfChanged: true });
    ensureWatcher();
    return {
      ok: true,
      reason: null,
      snapshot: evalRes.snapshot,
    };
  }

  function syncPlugins(activeTrustedBindings = []) {
    if (disposed) return;
    const nextIds = new Set();
    for (const item of activeTrustedBindings || []) {
      if (!item || typeof item.pluginId !== 'string' || !item.fileName) continue;
      const pluginId = item.pluginId;
      const fileName = item.fileName.trim();
      const maxBytes = clampMaxBytes(item.maxBytes);
      nextIds.add(pluginId);
      const existing = bindings.get(pluginId);
      if (!existing || existing.fileName !== fileName || existing.maxBytes !== maxBytes) {
        if (existing) clearEntryRetryTimer(existing);
        const entry = createBindingEntry(fileName, maxBytes, existing ? existing.revision : 0);
        bindings.set(pluginId, entry);
        evaluateBinding(pluginId, entry, { emitIfChanged: false });
      }
    }
    for (const oldId of Array.from(bindings.keys())) {
      if (!nextIds.has(oldId)) {
        clearEntryRetryTimer(bindings.get(oldId));
        bindings.delete(oldId);
      }
    }
    ensureWatcher();
  }

  function getLastSnapshot(pluginId) {
    if (disposed || typeof pluginId !== 'string' || !pluginId) return null;
    const entry = bindings.get(pluginId);
    if (!entry) return null;
    return entry.lastSnapshot || null;
  }

  function getStatus() {
    return {
      settingsDataDir: settingsDataDir || null,
      watcherActive: Boolean(watcher),
      watcherReconnectPending: Boolean(watcherReconnectTimer),
      boundPluginCount: bindings.size,
      boundPlugins: Array.from(bindings.entries()).map(([pluginId, e]) => ({
        pluginId,
        fileName: e.fileName,
        maxBytes: e.maxBytes,
        revision: e.revision,
        status: e.lastSnapshot ? e.lastSnapshot.status : null,
      })),
    };
  }

  function dispose() {
    disposed = true;
    clearWatcherReconnectTimer();
    closeWatcher();
    for (const entry of bindings.values()) {
      clearEntryRetryTimer(entry);
    }
    bindings.clear();
  }

  return Object.freeze({
    readSnapshotForPlugin,
    writeSnapshotForPlugin,
    getLastSnapshot,
    syncPlugins,
    refreshNow,
    getStatus,
    dispose,
  });
}

module.exports = {
  DEFAULT_MAX_BYTES,
  MIN_MAX_BYTES,
  MAX_MAX_BYTES,
  DEFAULT_DEBOUNCE_MS,
  readSettingsFileSnapshot,
  writeSettingsFileSnapshot,
  createSettingsBridge,
};
