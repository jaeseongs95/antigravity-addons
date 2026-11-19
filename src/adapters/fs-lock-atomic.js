'use strict';

/**
 * Host-neutral file locking and atomic write utilities (SRP / DIP).
 * Depends ONLY on Node built-ins and `proper-lockfile` — zero Electron/ASAR/Acorn coupling.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const lockfile = require('proper-lockfile');

const activeLockReleases = new Map();

function acquireExclusiveLockDetailed(lockPath, staleMs = 60000) {
  if (!lockPath) return { ok: false, code: 'ERR_LOCK_PATH_MISSING', error: 'Missing lockPath' };
  const effectiveStaleMs = Math.max(Number(staleMs) || 60000, 2000);
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    if (fs.existsSync(lockPath)) {
      try {
        const st = fs.lstatSync(lockPath);
        if (st.isFile()) {
          if (Date.now() - st.mtimeMs <= effectiveStaleMs) {
            return { ok: false, code: 'LOCK_BUSY', error: 'Active legacy file lock present' };
          }
          fs.unlinkSync(lockPath);
        }
      } catch (staleErr) {
        if (!staleErr || staleErr.code !== 'ENOENT') throw staleErr;
      }
    }
    const sentinelPath = `${lockPath}.target`;
    if (!fs.existsSync(sentinelPath)) {
      fs.writeFileSync(sentinelPath, '', { encoding: 'utf8', mode: 0o600 });
    }
    const release = lockfile.lockSync(sentinelPath, {
      lockfilePath: lockPath,
      stale: effectiveStaleMs,
      realpath: false,
    });
    const token = crypto.randomBytes(12).toString('hex');
    activeLockReleases.set(token, { lockPath, release });
    return { ok: true, token };
  } catch (err) {
    if (err && err.code === 'ELOCKED') {
      return { ok: false, code: 'LOCK_BUSY', error: err.message };
    }
    return {
      ok: false,
      code: 'ERR_LOCK_FS_ERROR',
      fsCode: err && err.code ? err.code : 'UNKNOWN',
      error: err && err.message ? err.message : String(err),
    };
  }
}

function acquireExclusiveLock(lockPath, staleMs = 60000) {
  const res = acquireExclusiveLockDetailed(lockPath, staleMs);
  return res.ok ? res.token : null;
}

function releaseExclusiveLock(lockPath, token) {
  if (!token) return;
  const entry = activeLockReleases.get(token);
  if (!entry) return;
  if (lockPath && entry.lockPath !== lockPath) return;
  activeLockReleases.delete(token);
  try {
    entry.release();
  } catch (_err) {}
}

function writeAtomicSync(targetPath, data, { isBinary = false } = {}) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  try {
    if (isBinary) {
      fs.writeFileSync(tmpPath, data);
    } else {
      fs.writeFileSync(tmpPath, data, { encoding: 'utf8', mode: 0o600 });
    }
    fs.renameSync(tmpPath, targetPath);
  } finally {
    if (fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath);
      } catch (_err) {}
    }
  }
}

module.exports = {
  acquireExclusiveLockDetailed,
  acquireExclusiveLock,
  releaseExclusiveLock,
  writeAtomicSync,
};
