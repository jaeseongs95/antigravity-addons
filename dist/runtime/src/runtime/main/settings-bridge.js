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

function readSettingsFileSnapshot(settingsDataDir, spec, { reservedFilePaths = [] } = {}) {
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
    lstat = fs.lstatSync(resolvedTarget);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { status: 'missing', data: null, sha256: null, reason: 'ERR_SETTINGS_FILE_MISSING', updatedAt };
    }
    return { status: 'error', data: null, sha256: null, reason: 'ERR_SETTINGS_STAT_FAILED', updatedAt };
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
    realBase = fs.realpathSync(resolvedBase);
    realTarget = fs.realpathSync(resolvedTarget);
  } catch (_err) {
    return { status: 'error', data: null, sha256: null, reason: 'ERR_SETTINGS_REALPATH_FAILED', updatedAt };
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
    fd = fs.openSync(realTarget, 'r');
    const fstat = fs.fstatSync(fd);
    if (!fstat.isFile()) {
      return { status: 'error', data: null, sha256: null, reason: 'ERR_SETTINGS_NOT_REGULAR_FILE', updatedAt };
    }
    if (fstat.size > maxBytes) {
      return { status: 'error', data: null, sha256: null, reason: 'ERR_SETTINGS_FILE_TOO_LARGE', updatedAt };
    }
    const readBuf = Buffer.allocUnsafe(maxBytes + 1);
    let totalRead = 0;
    while (totalRead <= maxBytes) {
      const n = fs.readSync(fd, readBuf, totalRead, readBuf.length - totalRead, totalRead);
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
    return { status: 'error', data: null, sha256: null, reason: 'ERR_SETTINGS_READ_FAILED', updatedAt };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
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

function snapshotKey(snap) {
  return `${snap.status}:${snap.sha256 || ''}:${snap.reason || ''}`;
}

function createSettingsBridge({
  settingsDataDir = null,
  reservedFilePaths = [],
  onSnapshotChange = () => {},
  debounceMs = DEFAULT_DEBOUNCE_MS,
  recordDiag = () => {},
} = {}) {
  const effectiveDebounceMs =
    Number.isInteger(debounceMs) && debounceMs >= 10 && debounceMs <= 5000 ? debounceMs : DEFAULT_DEBOUNCE_MS;
  const bindings = new Map(); // pluginId -> { fileName, maxBytes, revision, lastKey, lastSnapshot }
  let watcher = null;
  let debounceTimer = null;
  let disposed = false;

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

  function evaluateBinding(pluginId, entry, { emitIfChanged = true } = {}) {
    const raw = readSettingsFileSnapshot(settingsDataDir, entry, { reservedFilePaths });
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

  function ensureWatcher() {
    if (disposed || bindings.size === 0) {
      closeWatcher();
      return;
    }
    if (watcher) return;
    if (!settingsDataDir || !fs.existsSync(settingsDataDir)) return;
    try {
      watcher = fs.watch(settingsDataDir, { persistent: false }, (_eventType, _filename) => {
        scheduleRefresh();
      });
      if (watcher && typeof watcher.on === 'function') {
        watcher.on('error', (err) => {
          recordDiag('warn', 'SETTINGS_BRIDGE_WATCH_ERR', err && err.message ? err.message : String(err));
          closeWatcher();
        });
      }
    } catch (err) {
      recordDiag('warn', 'SETTINGS_BRIDGE_WATCH_START_ERR', err && err.message ? err.message : String(err));
      closeWatcher();
    }
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
      return evaluateBinding(pluginId, existing, { emitIfChanged: false }).snapshot;
    }
    const nextEntry = {
      fileName,
      maxBytes,
      revision: existing ? existing.revision : 0,
      lastKey: null,
      lastSnapshot: null,
    };
    bindings.set(pluginId, nextEntry);
    const res = evaluateBinding(pluginId, nextEntry, { emitIfChanged: false });
    ensureWatcher();
    return res.snapshot;
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
        const entry = {
          fileName,
          maxBytes,
          revision: existing ? existing.revision : 0,
          lastKey: null,
          lastSnapshot: null,
        };
        bindings.set(pluginId, entry);
        evaluateBinding(pluginId, entry, { emitIfChanged: false });
      }
    }
    for (const oldId of Array.from(bindings.keys())) {
      if (!nextIds.has(oldId)) {
        bindings.delete(oldId);
      }
    }
    ensureWatcher();
  }

  function getStatus() {
    return {
      settingsDataDir: settingsDataDir || null,
      watcherActive: Boolean(watcher),
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
    closeWatcher();
    bindings.clear();
  }

  return Object.freeze({
    readSnapshotForPlugin,
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
  createSettingsBridge,
};
