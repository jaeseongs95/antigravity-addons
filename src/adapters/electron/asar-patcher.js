'use strict';

/**
 * Electron ASAR Single-Owner Patcher, Integrity Verifier, Rollback, and Legacy Conflict Doctor.
 *
 * Uses official `@electron/asar` and `proper-lockfile`.
 * Strictly vendor-independent: all paths, anchors, and markers come from the injected `HostProfile`.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const asar = require('@electron/asar');
const lockfile = require('proper-lockfile');
const acorn = require('acorn');

const { assertValidElectronHostProfile } = require('./electron-host-profile-port');

const activeLockReleases = new Map();

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sanitizeVersionForFilename(rawVersion) {
  const cleaned = String(rawVersion || '')
    .replace(/\.\./g, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^[._-]+/, '')
    .slice(0, 64);
  return cleaned || 'unknown';
}

function acquireExclusiveLockDetailed(lockPath, staleMs = 60000) {
  if (!lockPath) return { ok: false, code: 'ERR_LOCK_PATH_MISSING', error: 'Missing lockPath' };
  const effectiveStaleMs = Math.max(Number(staleMs) || 60000, 2000);
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    if (fs.existsSync(lockPath)) {
      const st = fs.lstatSync(lockPath);
      if (st.isFile()) {
        if (Date.now() - st.mtimeMs <= effectiveStaleMs) {
          return { ok: false, code: 'LOCK_BUSY', error: 'Active legacy file lock present' };
        }
        fs.unlinkSync(lockPath);
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

function computeIntegrity(buf) {
  const blockSize = 4 * 1024 * 1024;
  const blocks = [];
  for (let off = 0; off < buf.length; off += blockSize) {
    blocks.push(sha256Hex(buf.subarray(off, Math.min(off + blockSize, buf.length))));
  }
  return {
    algorithm: 'SHA256',
    hash: sha256Hex(buf),
    blockSize,
    blocks: blocks.length > 0 ? blocks : [sha256Hex(Buffer.alloc(0))],
  };
}

function readAsarArchive(asarPath) {
  const buf = fs.readFileSync(asarPath);
  asar.uncacheAll();
  const rawHdr = asar.getRawHeader(asarPath);
  const u0 = buf.readUInt32LE(0);
  const u4 = buf.readUInt32LE(4);
  const u8 = buf.readUInt32LE(8);
  const header = JSON.parse(JSON.stringify(rawHdr.header));
  const dataStart = 8 + rawHdr.headerSize;

  const fileMap = new Map();
  const integrityMap = new Map();
  function walk(node, relPath) {
    if (node.files) {
      for (const [name, child] of Object.entries(node.files)) {
        walk(child, relPath ? `${relPath}/${name}` : name);
      }
    } else if (!node.unpacked && node.offset !== undefined && node.size !== undefined) {
      const start = dataStart + Number(node.offset);
      const end = start + Number(node.size);
      fileMap.set(relPath, buf.subarray(start, end));
      if (node.integrity) integrityMap.set(relPath, node.integrity);
    }
  }
  walk(header, '');

  let appVersion = 'unknown';
  const pkgBuf = fileMap.get('package.json');
  if (pkgBuf) {
    try {
      const pkg = JSON.parse(pkgBuf.toString('utf8'));
      if (pkg && typeof pkg.version === 'string') appVersion = sanitizeVersionForFilename(pkg.version);
    } catch (_err) {}
  }

  return { buf, u0, u4, u8, header, dataStart, fileMap, integrityMap, appVersion };
}

function verifyAllAsarIntegrity(archive) {
  for (const [relPath, expected] of archive.integrityMap.entries()) {
    const data = archive.fileMap.get(relPath);
    if (!data) return false;
    const actual = computeIntegrity(data);
    if (expected.hash && actual.hash !== expected.hash) return false;
    if (Array.isArray(expected.blocks)) {
      if (expected.blocks.length !== actual.blocks.length) return false;
      for (let i = 0; i < expected.blocks.length; i++) {
        if (expected.blocks[i] !== actual.blocks[i]) return false;
      }
    }
  }
  return true;
}

function detectArchiveMarkers(archive, profile) {
  assertValidElectronHostProfile(profile);
  const mainBuf = archive.fileMap.get(profile.mainEntry);
  if (!mainBuf) return { mainPresent: false, hostInstalled: false, legacyMarkers: [] };
  const text = mainBuf.toString('utf8');
  const hostInstalled = text.includes(profile.patchMarker);
  const legacyMarkers = (profile.legacyPatchMarkers || []).filter((m) => text.includes(m));
  return { mainPresent: true, hostInstalled, legacyMarkers };
}

function isPureUnpatchedArchive(archive, profile) {
  const info = detectArchiveMarkers(archive, profile);
  if (!info.mainPresent) return false;
  return !info.hostInstalled && info.legacyMarkers.length === 0;
}

function isAsarHostInstalled(asarPath, profile) {
  assertValidElectronHostProfile(profile);
  try {
    if (!asarPath || !fs.existsSync(asarPath)) return false;
    const archive = readAsarArchive(asarPath);
    return detectArchiveMarkers(archive, profile).hostInstalled;
  } catch (_err) {
    return false;
  }
}

/**
 * Finds 0-based line indices whose entire content is a standalone `//` line comment
 * using the standard ECMAScript parser (`acorn`), safely ignoring `//` inside strings,
 * regex literals, nested template `${...}` expressions, and block comments (CRLF & LF safe).
 */
function findSafeStandaloneCommentLines(sourceText) {
  const safeLineIndices = new Set();
  const lineStarts = [0];
  for (let i = 0; i < sourceText.length; i++) {
    if (sourceText[i] === '\n') {
      lineStarts.push(i + 1);
    }
  }

  const collectComments = (sourceType) => {
    const collected = [];
    acorn.parse(sourceText, {
      ecmaVersion: 'latest',
      sourceType,
      allowHashBang: true,
      allowReturnOutsideFunction: sourceType === 'script',
      locations: true,
      onComment(block, _text, start, _end, startLoc, endLoc) {
        if (!block && startLoc && endLoc && startLoc.line === endLoc.line) {
          collected.push({ lineIdx: startLoc.line - 1, start });
        }
      },
    });
    return collected;
  };

  let comments;
  try {
    comments = collectComments('script');
  } catch (_scriptErr) {
    comments = collectComments('module');
  }

  for (const c of comments) {
    const lineStart = lineStarts[c.lineIdx];
    if (lineStart === undefined) continue;
    const prefix = sourceText.slice(lineStart, c.start);
    if (/^[ \t]*$/.test(prefix)) {
      safeLineIndices.add(c.lineIdx);
    }
  }

  return safeLineIndices;
}

function transformExactSize(origBuf, targetStr, replacementStr, marker) {
  const origText = origBuf.toString('utf8');
  const firstIdx = origText.indexOf(targetStr);
  if (firstIdx === -1) throw new Error('ANCHOR_NOT_FOUND');
  if (origText.indexOf(targetStr, firstIdx + 1) !== -1) throw new Error('ANCHOR_NOT_UNIQUE');

  let nextText = origText.slice(0, firstIdx) + replacementStr + origText.slice(firstIdx + targetStr.length);
  let delta = Buffer.byteLength(nextText, 'utf8') - origBuf.length;

  if (delta > 0) {
    const safeLines = findSafeStandaloneCommentLines(nextText);
    const rawLines = nextText.split('\n');
    const kept = [];
    for (let idx = 0; idx < rawLines.length; idx++) {
      const line = rawLines[idx];
      const trimmedCr = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (
        delta > 0 &&
        safeLines.has(idx) &&
        (!marker || !trimmedCr.includes(marker)) &&
        /^\s*\/\/\s*[A-Za-z0-9#*\-_=.,:;()[\]{}@/'" ]*$/.test(trimmedCr)
      ) {
        delta -= Buffer.byteLength(line, 'utf8') + (idx < rawLines.length - 1 ? 1 : 0);
        continue;
      }
      kept.push(line);
    }
    nextText = kept.join('\n');
  }

  const finalDiff = origBuf.length - Buffer.byteLength(nextText, 'utf8');
  if (finalDiff < 0) {
    throw new Error(`INSUFFICIENT_BYTE_HEADROOM:${-finalDiff}`);
  }
  if (finalDiff > 0) {
    nextText = nextText + ' '.repeat(finalDiff);
  }
  new vm.Script(nextText);
  const outBuf = Buffer.from(nextText, 'utf8');
  if (outBuf.length !== origBuf.length) {
    throw new Error('EXACT_SIZE_MISMATCH');
  }
  return outBuf;
}

function verifyOrigBackupStrict(backupPath, metaPath, expectedVersion, profile, { backfillMeta = false } = {}) {
  assertValidElectronHostProfile(profile);
  if (!fs.existsSync(backupPath)) return { ok: false, status: 'ERR_ORIG_MISSING' };
  let archive;
  try {
    archive = readAsarArchive(backupPath);
  } catch (_err) {
    return { ok: false, status: 'ERR_ORIG_CORRUPTED' };
  }
  if (expectedVersion && archive.appVersion !== expectedVersion) {
    return { ok: false, status: 'ERR_ORIG_VERSION_MISMATCH' };
  }
  if (!isPureUnpatchedArchive(archive, profile)) {
    return { ok: false, status: 'ERR_ORIG_NOT_PURE' };
  }
  if (!verifyAllAsarIntegrity(archive)) {
    return { ok: false, status: 'ERR_ORIG_INTEGRITY_MISMATCH' };
  }
  const actualHash = sha256Hex(archive.buf);
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const expectedBytes = typeof meta.bytes === 'number' ? meta.bytes : meta.size;
      if (!meta || meta.sha256 !== actualHash || expectedBytes !== archive.buf.length) {
        return { ok: false, status: 'ERR_ORIG_META_MISMATCH' };
      }
    } catch (_err) {
      return { ok: false, status: 'ERR_ORIG_META_CORRUPTED' };
    }
  } else if (backfillMeta) {
    writeAtomicSync(
      metaPath,
      JSON.stringify(
        {
          appVersion: archive.appVersion,
          bytes: archive.buf.length,
          sha256: actualHash,
          createdAt: new Date().toISOString(),
        },
        null,
        2
      ) + '\n'
    );
  } else {
    return { ok: false, status: 'ERR_ORIG_META_MISSING' };
  }
  return { ok: true, archive, sha256: actualHash };
}

function installAsarAddonHost(paths, profile) {
  assertValidElectronHostProfile(profile);
  if (!fs.existsSync(paths.ASAR_PATH)) {
    return { status: 'SKIPPED_NO_ASAR' };
  }
  const lockRes = acquireExclusiveLockDetailed(paths.ASAR_LOCK_PATH, 60000);
  if (!lockRes.ok) return { status: lockRes.code, error: lockRes.error, fsCode: lockRes.fsCode };

  try {
    let archive = readAsarArchive(paths.ASAR_PATH);
    const curMarkers = detectArchiveMarkers(archive, profile);
    if (curMarkers.hostInstalled) {
      return { status: 'ALREADY_INSTALLED', appVersion: archive.appVersion };
    }
    if (curMarkers.legacyMarkers.length > 0 && !paths.ALLOW_REPLACE_LEGACY) {
      return {
        status: 'ERR_LEGACY_DIRECT_PATCH_DETECTED',
        appVersion: archive.appVersion,
        legacyMarkers: curMarkers.legacyMarkers,
      };
    }

    const safeVer = sanitizeVersionForFilename(archive.appVersion);
    const backupPath = `${paths.ASAR_PATH}.v${safeVer}.orig`;
    const metaPath = `${backupPath}.json`;

    if (fs.existsSync(backupPath)) {
      const check = verifyOrigBackupStrict(backupPath, metaPath, archive.appVersion, profile, {
        backfillMeta: true,
      });
      if (!check.ok) {
        return { status: check.status, appVersion: archive.appVersion };
      }
      archive = check.archive;
    } else if (isPureUnpatchedArchive(archive, profile)) {
      if (!verifyAllAsarIntegrity(archive)) {
        return { status: 'ERR_ARCHIVE_INTEGRITY_MISMATCH', appVersion: archive.appVersion };
      }
      writeAtomicSync(backupPath, archive.buf, { isBinary: true });
      writeAtomicSync(
        metaPath,
        JSON.stringify(
          {
            appVersion: archive.appVersion,
            bytes: archive.buf.length,
            sha256: sha256Hex(archive.buf),
            createdAt: new Date().toISOString(),
          },
          null,
          2
        ) + '\n'
      );
    } else {
      return { status: 'ERR_ORIG_MISSING_FOR_PATCHED_ASAR', appVersion: archive.appVersion };
    }

    const mainBuf = archive.fileMap.get(profile.mainEntry);
    if (!mainBuf) return { status: 'ERR_MAIN_MISSING', appVersion: archive.appVersion };

    let patchedMainBuf;
    try {
      patchedMainBuf = transformExactSize(
        mainBuf,
        profile.mainAnchorTarget,
        profile.mainAnchorReplacement,
        profile.patchMarker
      );
    } catch (err) {
      return {
        status: 'ERR_EXACT_SIZE_TRANSFORM_FAILED',
        error: err && err.message ? err.message : String(err),
        appVersion: archive.appVersion,
      };
    }
    archive.fileMap.set(profile.mainEntry, patchedMainBuf);

    const chunks = [];
    let currentOffset = 0n;
    function rebuild(node, relPath) {
      if (node.files) {
        for (const [name, child] of Object.entries(node.files)) {
          rebuild(child, relPath ? `${relPath}/${name}` : name);
        }
      } else if (!node.unpacked && node.offset !== undefined && node.size !== undefined) {
        const data = archive.fileMap.get(relPath);
        node.size = data.length;
        node.offset = currentOffset.toString();
        // Preserve header layout: recompute integrity ONLY when the original archive carried integrity metadata.
        if (node.integrity) {
          node.integrity = computeIntegrity(data);
        }
        chunks.push(data);
        currentOffset += BigInt(data.length);
      }
    }
    rebuild(archive.header, '');

    const headerStrBuf = Buffer.from(JSON.stringify(archive.header), 'utf8');
    const alignedStrSize = Math.ceil(headerStrBuf.length / 4) * 4;
    const newU8 = 4 + alignedStrSize;
    const newU4 = 4 + newU8;
    const headerBuf = Buffer.alloc(8 + newU4, 0);
    headerBuf.writeUInt32LE(archive.u0, 0);
    headerBuf.writeUInt32LE(newU4, 4);
    headerBuf.writeUInt32LE(newU8, 8);
    headerBuf.writeUInt32LE(headerStrBuf.length, 12);
    headerStrBuf.copy(headerBuf, 16);

    const outBuf = Buffer.concat([headerBuf, ...chunks]);
    if (outBuf.length !== archive.buf.length) {
      return { status: 'ERR_ARCHIVE_SIZE_DRIFT', appVersion: archive.appVersion };
    }

    writeAtomicSync(paths.ASAR_PATH, outBuf, { isBinary: true });
    asar.uncacheAll();
    return {
      status: 'INSTALLED',
      patchMarker: profile.patchMarker,
      appVersion: archive.appVersion,
      backupPath,
      sha256: sha256Hex(outBuf),
    };
  } finally {
    releaseExclusiveLock(paths.ASAR_LOCK_PATH, lockRes.token);
  }
}

function rollbackAsarAddonHost(paths, profile, { force = false } = {}) {
  assertValidElectronHostProfile(profile);
  if (!fs.existsSync(paths.ASAR_PATH)) {
    return { status: 'SKIPPED_NO_ASAR' };
  }

  const lockRes = acquireExclusiveLockDetailed(paths.ASAR_LOCK_PATH, 60000);
  if (!lockRes.ok) return { status: lockRes.code, error: lockRes.error, fsCode: lockRes.fsCode };
  try {
    const remainingManifests = fs.existsSync(paths.ADDONS_DIR)
      ? fs.readdirSync(paths.ADDONS_DIR).filter((f) => f.endsWith('.json'))
      : [];
    if (remainingManifests.length > 0 && !force) {
      return {
        status: 'BLOCKED_REGISTERED_ADDONS_REMAIN',
        remainingManifests,
      };
    }

    const cur = readAsarArchive(paths.ASAR_PATH);
    if (isPureUnpatchedArchive(cur, profile)) {
      return { status: 'ALREADY_UNPATCHED', appVersion: cur.appVersion };
    }
    const safeVer = sanitizeVersionForFilename(cur.appVersion);
    const backupPath = `${paths.ASAR_PATH}.v${safeVer}.orig`;
    const metaPath = `${backupPath}.json`;
    const check = verifyOrigBackupStrict(backupPath, metaPath, cur.appVersion, profile, {
      backfillMeta: false,
    });
    if (!check.ok) {
      return { status: check.status, appVersion: cur.appVersion };
    }
    writeAtomicSync(paths.ASAR_PATH, check.archive.buf, { isBinary: true });
    asar.uncacheAll();
    return {
      status: 'ROLLED_BACK',
      appVersion: cur.appVersion,
      sha256: check.sha256,
    };
  } finally {
    releaseExclusiveLock(paths.ASAR_LOCK_PATH, lockRes.token);
  }
}

function diagnoseAsarState(paths, profile) {
  assertValidElectronHostProfile(profile);
  if (!fs.existsSync(paths.ASAR_PATH)) {
    return { asarExists: false, status: 'NO_ASAR', legacyMarkers: [], origBackupValid: false };
  }
  const archive = readAsarArchive(paths.ASAR_PATH);
  const markers = detectArchiveMarkers(archive, profile);
  const safeVer = sanitizeVersionForFilename(archive.appVersion);
  const backupPath = `${paths.ASAR_PATH}.v${safeVer}.orig`;
  const metaPath = `${backupPath}.json`;
  const origCheck = fs.existsSync(backupPath)
    ? verifyOrigBackupStrict(backupPath, metaPath, archive.appVersion, profile, { backfillMeta: false })
    : { ok: false, status: 'ORIG_NOT_CREATED_YET' };

  return {
    asarExists: true,
    appVersion: archive.appVersion,
    asarSha256: sha256Hex(archive.buf),
    hostInstalled: markers.hostInstalled,
    legacyMarkers: markers.legacyMarkers,
    hasLegacyConflict: markers.legacyMarkers.length > 0,
    origBackupPath: backupPath,
    origBackupValid: Boolean(origCheck.ok),
    origBackupStatus: origCheck.ok ? 'VALID' : origCheck.status,
  };
}

module.exports = {
  sha256Hex,
  sanitizeVersionForFilename,
  acquireExclusiveLockDetailed,
  acquireExclusiveLock,
  releaseExclusiveLock,
  writeAtomicSync,
  readAsarArchive,
  verifyAllAsarIntegrity,
  detectArchiveMarkers,
  isPureUnpatchedArchive,
  isAsarHostInstalled,
  findSafeStandaloneCommentLines,
  transformExactSize,
  verifyOrigBackupStrict,
  installAsarAddonHost,
  rollbackAsarAddonHost,
  diagnoseAsarState,
};
