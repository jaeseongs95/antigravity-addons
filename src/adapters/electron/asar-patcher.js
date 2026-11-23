'use strict';

/**
 * Electron ASAR Single-Owner Patcher, Integrity Verifier, V1->V2 Upgrader,
 * External Backup Manager (N=3 pinned-active pruning), Rollback, and Legacy Conflict Doctor.
 *
 * Uses official `@electron/asar`, `acorn`, and `proper-lockfile`.
 * Strictly vendor-independent: all paths, anchors, and markers come from the injected `HostProfile`.
 * Strict exact-size invariant ONLY (outBuf.length === archive.buf.length).
 * Fail-fast on Windows EBUSY/EPERM (ERR_TARGET_LOCKED_APP_RUNNING — Option B-Clean).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const asar = require('@electron/asar');
const acorn = require('acorn');

const {
  acquireExclusiveLockDetailed,
  acquireExclusiveLock,
  releaseExclusiveLock,
  writeAtomicSync,
} = require('../fs-lock-atomic');
const { assertValidElectronHostProfile } = require('./electron-host-profile-port');

const DEFAULT_BACKUP_RETENTION = 3;

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

function resolveBackupsDir(paths) {
  if (paths && typeof paths.BACKUPS_DIR === 'string' && paths.BACKUPS_DIR.trim()) {
    return paths.BACKUPS_DIR;
  }
  const base =
    (paths && paths.HOST_DATA_DIR) ||
    (paths && paths.LOADER_SCRIPT_PATH && path.dirname(paths.LOADER_SCRIPT_PATH)) ||
    (paths && paths.ASAR_LOCK_PATH && path.dirname(paths.ASAR_LOCK_PATH)) ||
    path.dirname(paths.ASAR_PATH);
  return path.join(base, 'backups');
}

function getBackupIndexPath(backupsDir) {
  return path.join(backupsDir, 'index.json');
}

function readBackupIndex(backupsDir) {
  const idxPath = getBackupIndexPath(backupsDir);
  if (!fs.existsSync(idxPath)) {
    return {
      schemaVersion: 1,
      activeOrigSha256: null,
      activePatchedSha256: null,
      activeVersion: null,
      activeBackupPath: null,
      rolledBackAt: null,
      pinnedShas: [],
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
    return {
      schemaVersion: 1,
      activeOrigSha256: parsed.activeOrigSha256 || null,
      activePatchedSha256: parsed.activePatchedSha256 || null,
      activeVersion: parsed.activeVersion || null,
      activeBackupPath: parsed.activeBackupPath || null,
      rolledBackAt: parsed.rolledBackAt || null,
      pinnedShas: Array.isArray(parsed.pinnedShas) ? parsed.pinnedShas.filter((s) => typeof s === 'string') : [],
    };
  } catch (_err) {
    return {
      schemaVersion: 1,
      activeOrigSha256: null,
      activePatchedSha256: null,
      activeVersion: null,
      activeBackupPath: null,
      rolledBackAt: null,
      pinnedShas: [],
    };
  }
}

function writeBackupIndex(backupsDir, indexObj) {
  fs.mkdirSync(backupsDir, { recursive: true });
  writeAtomicSync(getBackupIndexPath(backupsDir), JSON.stringify(indexObj, null, 2) + '\n');
}

function getVersionedBackupPath(backupsDir, safeVer, sha256) {
  return path.join(backupsDir, `app.asar.v${safeVer}.${String(sha256).slice(0, 8)}.orig`);
}

function getLegacyBackupPath(asarPath, safeVer) {
  return `${asarPath}.v${safeVer}.orig`;
}

function pruneBackups(backupsDir, indexObj, maxKeep = DEFAULT_BACKUP_RETENTION) {
  if (!fs.existsSync(backupsDir)) return;
  const protectedShas = new Set(indexObj.pinnedShas || []);
  if (indexObj.activeOrigSha256) protectedShas.add(indexObj.activeOrigSha256);

  const items = [];
  for (const name of fs.readdirSync(backupsDir)) {
    if (!name.endsWith('.orig')) continue;
    const origPath = path.join(backupsDir, name);
    const metaPath = `${origPath}.json`;
    let sha = null;
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(origPath).mtimeMs;
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (meta && typeof meta.sha256 === 'string') sha = meta.sha256;
      }
    } catch (_e) {}
    const isProtected =
      (sha && protectedShas.has(sha)) ||
      (indexObj.activeBackupPath && path.resolve(origPath) === path.resolve(indexObj.activeBackupPath));
    items.push({ origPath, metaPath, sha, mtimeMs, isProtected });
  }

  if (items.length <= maxKeep) return;
  // Sort newest first; never prune protected entries
  items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let kept = items.filter((i) => i.isProtected).length;
  for (const item of items) {
    if (item.isProtected) continue;
    if (kept < maxKeep) {
      kept++;
      continue;
    }
    try {
      if (fs.existsSync(item.origPath)) fs.unlinkSync(item.origPath);
      if (fs.existsSync(item.metaPath)) fs.unlinkSync(item.metaPath);
    } catch (_e) {}
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
  if (!mainBuf) {
    return { mainPresent: false, hostInstalled: false, priorHostMarkersInstalled: [], legacyMarkers: [] };
  }
  const text = mainBuf.toString('utf8');
  const hostInstalled = text.includes(profile.patchMarker);
  const priorHostMarkersInstalled = (profile.priorHostMarkers || []).filter(
    (m) => m !== profile.patchMarker && text.includes(m)
  );
  const legacyMarkers = (profile.legacyPatchMarkers || []).filter((m) => text.includes(m));
  return { mainPresent: true, hostInstalled, priorHostMarkersInstalled, legacyMarkers };
}

function isPureUnpatchedArchive(archive, profile) {
  const info = detectArchiveMarkers(archive, profile);
  if (!info.mainPresent) return false;
  return !info.hostInstalled && info.priorHostMarkersInstalled.length === 0 && info.legacyMarkers.length === 0;
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

function isJsLineTerminator(ch) {
  return ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029';
}

function parseJavaScriptWithAcorn(sourceText, onComment = null) {
  const tryParse = (sourceType) => {
    const collected = onComment ? [] : null;
    const opts = {
      ecmaVersion: 'latest',
      sourceType,
      allowHashBang: true,
      allowReturnOutsideFunction: sourceType === 'script',
    };
    if (collected) {
      opts.onComment = (block, text, start, end) => {
        collected.push({ block, text, start, end });
      };
    }
    const ast = acorn.parse(sourceText, opts);
    if (collected) {
      for (const c of collected) {
        onComment(c.block, c.text, c.start, c.end);
      }
    }
    return ast;
  };
  try {
    return tryParse('script');
  } catch (_scriptErr) {
    return tryParse('module');
  }
}

function findSafeStandaloneCommentRanges(sourceText) {
  const rawComments = [];
  parseJavaScriptWithAcorn(sourceText, (block, _text, start, end) => {
    if (!block) {
      rawComments.push({ start, end });
    }
  });

  const ranges = [];
  const len = sourceText.length;
  for (const c of rawComments) {
    let lineStart = c.start;
    while (lineStart > 0 && !isJsLineTerminator(sourceText[lineStart - 1])) {
      lineStart--;
    }
    const prefix = sourceText.slice(lineStart, c.start);
    if (!/^[ \t]*$/.test(prefix)) continue;

    let lineEnd = c.end;
    if (lineEnd < len) {
      const ch = sourceText[lineEnd];
      if (ch === '\r' && lineEnd + 1 < len && sourceText[lineEnd + 1] === '\n') {
        lineEnd += 2;
      } else if (isJsLineTerminator(ch)) {
        lineEnd += 1;
      } else {
        continue;
      }
    }
    ranges.push({
      lineStart,
      lineEnd,
      commentStart: c.start,
      commentEnd: c.end,
      text: sourceText.slice(lineStart, c.end),
    });
  }
  return ranges;
}

function transformExactSize(origBuf, targetStr, replacementStr, marker) {
  const origText = origBuf.toString('utf8');
  const firstIdx = origText.indexOf(targetStr);
  if (firstIdx === -1) throw new Error('ANCHOR_NOT_FOUND');
  if (origText.indexOf(targetStr, firstIdx + 1) !== -1) throw new Error('ANCHOR_NOT_UNIQUE');

  let nextText = origText.slice(0, firstIdx) + replacementStr + origText.slice(firstIdx + targetStr.length);
  let delta = Buffer.byteLength(nextText, 'utf8') - origBuf.length;

  if (delta > 0) {
    const safeRanges = findSafeStandaloneCommentRanges(nextText);
    const toRemove = [];
    for (const r of safeRanges) {
      if (delta <= 0) break;
      if (marker && r.text.includes(marker)) continue;
      if (!/^[ \t]*\/\/[ \t]*[A-Za-z0-9#*\-_=.,:;()[\]{}@/'" ]*$/.test(r.text)) continue;
      const sliceBytes = Buffer.byteLength(nextText.slice(r.lineStart, r.lineEnd), 'utf8');
      if (sliceBytes <= 0) continue;
      toRemove.push(r);
      delta -= sliceBytes;
    }
    if (toRemove.length > 0) {
      const parts = [];
      let cursor = 0;
      for (const r of toRemove) {
        if (r.lineStart < cursor) continue;
        parts.push(nextText.slice(cursor, r.lineStart));
        cursor = r.lineEnd;
      }
      parts.push(nextText.slice(cursor));
      nextText = parts.join('');
    }
  }

  const finalDiff = origBuf.length - Buffer.byteLength(nextText, 'utf8');
  if (finalDiff < 0) {
    throw new Error(`INSUFFICIENT_BYTE_HEADROOM:${-finalDiff}`);
  }
  if (finalDiff > 0) {
    nextText = nextText + ' '.repeat(finalDiff);
  }
  parseJavaScriptWithAcorn(nextText);
  const outBuf = Buffer.from(nextText, 'utf8');
  if (outBuf.length !== origBuf.length) {
    throw new Error('EXACT_SIZE_MISMATCH');
  }
  return outBuf;
}

function verifyOrigBackupStrict(backupPath, metaPath, expectedVersion, profile, { backfillMeta = false } = {}) {
  assertValidElectronHostProfile(profile);
  if (!backupPath || !fs.existsSync(backupPath)) return { ok: false, status: 'ERR_ORIG_MISSING' };
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
  let parsedMeta = null;
  if (metaPath && fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const expectedBytes = typeof meta.bytes === 'number' ? meta.bytes : meta.size;
      if (!meta || meta.sha256 !== actualHash || expectedBytes !== archive.buf.length) {
        return { ok: false, status: 'ERR_ORIG_META_MISMATCH' };
      }
      parsedMeta = meta;
    } catch (_err) {
      return { ok: false, status: 'ERR_ORIG_META_CORRUPTED' };
    }
  } else if (backfillMeta && metaPath) {
    // O-4: Synthesize metadata strictly in memory — NEVER write .json into vendor resources/ during legacy migration
    parsedMeta = {
      appVersion: archive.appVersion,
      bytes: archive.buf.length,
      sha256: actualHash,
      createdAt: new Date().toISOString(),
    };
  } else {
    return { ok: false, status: 'ERR_ORIG_META_MISSING' };
  }
  return { ok: true, archive, sha256: actualHash, meta: parsedMeta, backupPath, metaPath };
}

/**
 * Finds the best candidate .orig backup for `appVersion` across:
 * 1) Active index pointer in BACKUPS_DIR
 * 2) Matching versioned `.orig` files in BACKUPS_DIR (preferring matching patchedSha256 or sha256)
 * 3) Legacy `${ASAR_PATH}.v<ver>.orig` for seamless V1 -> V2 migration
 */
function isPathConfinedToDir(dirPath, candidatePath) {
  if (!dirPath || !candidatePath) return false;
  const resolvedDir = path.resolve(dirPath);
  const resolvedCandidate = path.resolve(candidatePath);
  const rel = path.relative(resolvedDir, resolvedCandidate);
  return Boolean(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function findCandidateBackup(paths, safeVer, currentSha256, { preferPatchedMatch = false } = {}) {
  const backupsDir = resolveBackupsDir(paths);
  const index = readBackupIndex(backupsDir);
  const candidates = [];

  // SEC-06: Confine index.activeBackupPath strictly inside backupsDir before touching it
  if (
    index.activeBackupPath &&
    isPathConfinedToDir(backupsDir, index.activeBackupPath) &&
    fs.existsSync(index.activeBackupPath) &&
    (!index.activeVersion || index.activeVersion === safeVer)
  ) {
    candidates.push({ backupPath: index.activeBackupPath, metaPath: `${index.activeBackupPath}.json`, source: 'index' });
  }

  if (fs.existsSync(backupsDir)) {
    const prefix = `app.asar.v${safeVer}.`;
    for (const name of fs.readdirSync(backupsDir).sort()) {
      if (!name.startsWith(prefix) || !name.endsWith('.orig')) continue;
      const bp = path.join(backupsDir, name);
      if (candidates.some((c) => path.resolve(c.backupPath) === path.resolve(bp))) continue;
      candidates.push({ backupPath: bp, metaPath: `${bp}.json`, source: 'backupsDir' });
    }
  }

  const legacyPath = getLegacyBackupPath(paths.ASAR_PATH, safeVer);
  if (fs.existsSync(legacyPath) && !candidates.some((c) => path.resolve(c.backupPath) === path.resolve(legacyPath))) {
    candidates.push({ backupPath: legacyPath, metaPath: `${legacyPath}.json`, source: 'legacy' });
  }

  if (candidates.length === 0) return null;

  // Prefer candidate whose metadata matches currentSha256 (either as patchedSha256 or orig sha256)
  for (const c of candidates) {
    if (!fs.existsSync(c.metaPath)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(c.metaPath, 'utf8'));
      if (preferPatchedMatch && m.patchedSha256 && m.patchedSha256 === currentSha256) return c;
      if (!preferPatchedMatch && m.sha256 && m.sha256 === currentSha256) return c;
    } catch (_e) {}
  }

  return candidates[0];
}

function classifyWriteError(err) {
  const code = err && err.code;
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
    return { status: 'ERR_TARGET_LOCKED_APP_RUNNING', fsCode: code, error: err.message };
  }
  return null;
}

function rebuildArchiveExactSize(archive, profile) {
  const mainBuf = archive.fileMap.get(profile.mainEntry);
  if (!mainBuf) return { ok: false, status: 'ERR_MAIN_MISSING' };

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
      ok: false,
      status: 'ERR_EXACT_SIZE_TRANSFORM_FAILED',
      error: err && err.message ? err.message : String(err),
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
    return { ok: false, status: 'ERR_ARCHIVE_SIZE_DRIFT' };
  }
  return { ok: true, outBuf };
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
    const currentSha256 = sha256Hex(archive.buf);
    const currentIsPure = isPureUnpatchedArchive(archive, profile);
    const curMarkers = detectArchiveMarkers(archive, profile);

    if (curMarkers.hostInstalled) {
      return { status: 'ALREADY_INSTALLED', appVersion: archive.appVersion, sha256: currentSha256 };
    }
    if (curMarkers.legacyMarkers.length > 0 && !paths.ALLOW_REPLACE_LEGACY) {
      return {
        status: 'ERR_LEGACY_DIRECT_PATCH_DETECTED',
        appVersion: archive.appVersion,
        legacyMarkers: curMarkers.legacyMarkers,
      };
    }

    const backupsDir = resolveBackupsDir(paths);
    const index = readBackupIndex(backupsDir);
    const safeVer = sanitizeVersionForFilename(archive.appVersion);
    const existingCandidate = findCandidateBackup(paths, safeVer, currentSha256, {
      preferPatchedMatch: !currentIsPure,
    });

    let backupPath = null;
    let metaPath = null;
    let activeMeta = null;
    let pendingOrigCommit = null;

    if (existingCandidate) {
      // SEC-06: Only allow legacy resources/*.orig migration to backfill missing .json metadata
      const check = verifyOrigBackupStrict(existingCandidate.backupPath, existingCandidate.metaPath, archive.appVersion, profile, {
        backfillMeta: existingCandidate.source === 'legacy',
      });
      if (!check.ok) {
        return { status: check.status, appVersion: archive.appVersion };
      }

      // P0 Build-Hash Identity Guard: NEVER overwrite a newer pure build of the same appVersion with an older .orig backup!
      if (currentIsPure && currentSha256 !== check.sha256) {
        if (!paths.ALLOW_REFRESH_ORIG) {
          return {
            status: 'ERR_ORIG_BUILD_MISMATCH',
            appVersion: archive.appVersion,
            currentSha256,
            backupSha256: check.sha256,
            backupPath: existingCandidate.backupPath,
          };
        }
        if (!verifyAllAsarIntegrity(archive)) {
          return { status: 'ERR_ARCHIVE_INTEGRITY_MISMATCH', appVersion: archive.appVersion };
        }
        backupPath = getVersionedBackupPath(backupsDir, safeVer, currentSha256);
        metaPath = `${backupPath}.json`;
        const archivedPrevPath = getVersionedBackupPath(backupsDir, safeVer, check.sha256);
        const archivedPrevMetaPath = `${archivedPrevPath}.json`;
        activeMeta = {
          appVersion: archive.appVersion,
          bytes: archive.buf.length,
          sha256: currentSha256,
          createdAt: new Date().toISOString(),
          previousOrigSha256: check.sha256,
        };
        pendingOrigCommit = {
          archivedPrevPath,
          archivedPrevMetaPath,
          prevBuf: check.archive.buf,
          prevMeta: check.meta,
          nextBuf: archive.buf,
        };
      } else {
        // Use verified .orig (migrating legacy resources/*.orig into BACKUPS_DIR if needed!)
        archive = check.archive;
        backupPath = getVersionedBackupPath(backupsDir, safeVer, check.sha256);
        metaPath = `${backupPath}.json`;
        activeMeta = check.meta
          ? { ...check.meta }
          : {
              appVersion: archive.appVersion,
              bytes: archive.buf.length,
              sha256: check.sha256,
              createdAt: new Date().toISOString(),
            };
        if (path.resolve(existingCandidate.backupPath) !== path.resolve(backupPath)) {
          pendingOrigCommit = {
            archivedPrevPath: null,
            archivedPrevMetaPath: null,
            prevBuf: null,
            prevMeta: null,
            nextBuf: check.archive.buf,
          };
        }
      }
    } else if (currentIsPure) {
      if (!verifyAllAsarIntegrity(archive)) {
        return { status: 'ERR_ARCHIVE_INTEGRITY_MISMATCH', appVersion: archive.appVersion };
      }
      backupPath = getVersionedBackupPath(backupsDir, safeVer, currentSha256);
      metaPath = `${backupPath}.json`;
      activeMeta = {
        appVersion: archive.appVersion,
        bytes: archive.buf.length,
        sha256: currentSha256,
        createdAt: new Date().toISOString(),
      };
      pendingOrigCommit = {
        archivedPrevPath: null,
        archivedPrevMetaPath: null,
        prevBuf: null,
        prevMeta: null,
        nextBuf: archive.buf,
      };
    } else {
      return { status: 'ERR_ORIG_MISSING_FOR_PATCHED_ASAR', appVersion: archive.appVersion };
    }

    const built = rebuildArchiveExactSize(archive, profile);
    if (!built.ok) {
      return { status: built.status, error: built.error, appVersion: archive.appVersion };
    }
    const { outBuf } = built;

    fs.mkdirSync(backupsDir, { recursive: true });
    if (pendingOrigCommit) {
      if (pendingOrigCommit.archivedPrevPath && !fs.existsSync(pendingOrigCommit.archivedPrevPath)) {
        writeAtomicSync(pendingOrigCommit.archivedPrevPath, pendingOrigCommit.prevBuf, { isBinary: true });
        writeAtomicSync(
          pendingOrigCommit.archivedPrevMetaPath,
          JSON.stringify(pendingOrigCommit.prevMeta, null, 2) + '\n'
        );
      }
      writeAtomicSync(backupPath, pendingOrigCommit.nextBuf, { isBinary: true });
      writeAtomicSync(metaPath, JSON.stringify(activeMeta, null, 2) + '\n');
    }

    const patchedSha256 = sha256Hex(outBuf);
    try {
      writeAtomicSync(paths.ASAR_PATH, outBuf, { isBinary: true });
    } catch (writeErr) {
      const classified = classifyWriteError(writeErr);
      if (classified) return { ...classified, appVersion: archive.appVersion };
      throw writeErr;
    }
    asar.uncacheAll();

    const nextMeta = {
      ...activeMeta,
      patchedSha256,
      patchMarker: profile.patchMarker,
      patchedAt: new Date().toISOString(),
    };
    delete nextMeta.rolledBackAt;
    writeAtomicSync(metaPath, JSON.stringify(nextMeta, null, 2) + '\n');

    const nextIndex = {
      ...index,
      activeOrigSha256: activeMeta.sha256,
      activePatchedSha256: patchedSha256,
      activeVersion: safeVer,
      activeBackupPath: backupPath,
      rolledBackAt: null,
    };
    writeBackupIndex(backupsDir, nextIndex);
    pruneBackups(backupsDir, nextIndex, paths.BACKUP_RETENTION || DEFAULT_BACKUP_RETENTION);

    return {
      status: curMarkers.priorHostMarkersInstalled.length > 0 ? 'UPGRADED' : 'INSTALLED',
      upgradedFrom: curMarkers.priorHostMarkersInstalled,
      patchMarker: profile.patchMarker,
      appVersion: archive.appVersion,
      backupPath,
      origSha256: activeMeta.sha256,
      sha256: patchedSha256,
    };
  } finally {
    releaseExclusiveLock(paths.ASAR_LOCK_PATH, lockRes.token);
  }
}

function upgradeAsarAddonHost(paths, profile) {
  return installAsarAddonHost(paths, profile);
}

function rollbackAsarAddonHost(paths, profile, { force = false } = {}) {
  assertValidElectronHostProfile(profile);
  if (!fs.existsSync(paths.ASAR_PATH)) {
    return { status: 'SKIPPED_NO_ASAR' };
  }

  const addonsLockRes = paths.ADDONS_LOCK_PATH
    ? acquireExclusiveLockDetailed(paths.ADDONS_LOCK_PATH, 30000)
    : { ok: true, token: null };
  if (!addonsLockRes.ok) {
    return { status: addonsLockRes.code, error: addonsLockRes.error, fsCode: addonsLockRes.fsCode };
  }
  const lockRes = acquireExclusiveLockDetailed(paths.ASAR_LOCK_PATH, 60000);
  if (!lockRes.ok) {
    if (addonsLockRes.token) releaseExclusiveLock(paths.ADDONS_LOCK_PATH, addonsLockRes.token);
    return { status: lockRes.code, error: lockRes.error, fsCode: lockRes.fsCode };
  }
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
    const curMarkers = detectArchiveMarkers(cur, profile);
    const curSha256 = sha256Hex(cur.buf);
    const safeVer = sanitizeVersionForFilename(cur.appVersion);
    const candidate = findCandidateBackup(paths, safeVer, curSha256, { preferPatchedMatch: true });
    if (!candidate) {
      return { status: 'ERR_ORIG_MISSING', appVersion: cur.appVersion };
    }

    const check = verifyOrigBackupStrict(candidate.backupPath, candidate.metaPath, cur.appVersion, profile, {
      backfillMeta: false,
    });
    if (!check.ok) {
      return { status: check.status, appVersion: cur.appVersion };
    }

    const expectedPatchedSha256 =
      check.meta && typeof check.meta.patchedSha256 === 'string' && check.meta.patchedSha256
        ? check.meta.patchedSha256
        : null;
    const isKnownHostMarker = curMarkers.hostInstalled || curMarkers.priorHostMarkersInstalled.length > 0;
    const unexpectedModification =
      !isKnownHostMarker || (expectedPatchedSha256 && curSha256 !== expectedPatchedSha256);
    if (unexpectedModification && !force) {
      return {
        status: 'ERR_PATCHED_ASAR_UNEXPECTED_MODIFICATION',
        appVersion: cur.appVersion,
        currentSha256: curSha256,
        expectedPatchedSha256,
      };
    }

    try {
      writeAtomicSync(paths.ASAR_PATH, check.archive.buf, { isBinary: true });
    } catch (writeErr) {
      const classified = classifyWriteError(writeErr);
      if (classified) return { ...classified, appVersion: cur.appVersion };
      throw writeErr;
    }
    asar.uncacheAll();

    const rolledBackAt = new Date().toISOString();
    if (check.meta) {
      const cleanedMeta = { ...check.meta, rolledBackAt };
      delete cleanedMeta.patchedSha256;
      delete cleanedMeta.patchedAt;
      writeAtomicSync(candidate.metaPath, JSON.stringify(cleanedMeta, null, 2) + '\n');
    }

    const backupsDir = resolveBackupsDir(paths);
    const index = readBackupIndex(backupsDir);
    writeBackupIndex(backupsDir, {
      ...index,
      activePatchedSha256: null,
      rolledBackAt,
    });

    return {
      status: 'ROLLED_BACK',
      appVersion: cur.appVersion,
      sha256: check.sha256,
      rolledBackAt,
    };
  } finally {
    releaseExclusiveLock(paths.ASAR_LOCK_PATH, lockRes.token);
    if (addonsLockRes.token) releaseExclusiveLock(paths.ADDONS_LOCK_PATH, addonsLockRes.token);
  }
}

function diagnoseAsarState(paths, profile) {
  assertValidElectronHostProfile(profile);
  if (!fs.existsSync(paths.ASAR_PATH)) {
    return {
      asarExists: false,
      status: 'NO_ASAR',
      legacyMarkers: [],
      priorHostMarkersInstalled: [],
      origBackupValid: false,
      updatedUnpatched: false,
    };
  }
  const archive = readAsarArchive(paths.ASAR_PATH);
  const asarSha256 = sha256Hex(archive.buf);
  const pure = isPureUnpatchedArchive(archive, profile);
  const markers = detectArchiveMarkers(archive, profile);
  const safeVer = sanitizeVersionForFilename(archive.appVersion);
  const backupsDir = resolveBackupsDir(paths);
  const index = readBackupIndex(backupsDir);

  const candidate = findCandidateBackup(paths, safeVer, asarSha256, { preferPatchedMatch: !pure });
  const origCheck = candidate
    ? verifyOrigBackupStrict(candidate.backupPath, candidate.metaPath, archive.appVersion, profile, { backfillMeta: false })
    : { ok: false, status: 'ORIG_NOT_CREATED_YET' };
  const origBackupSha256 = origCheck.ok ? origCheck.sha256 : null;
  const expectedPatchedSha256 =
    origCheck.ok && origCheck.meta && typeof origCheck.meta.patchedSha256 === 'string'
      ? origCheck.meta.patchedSha256
      : null;

  const origBuildMismatch = Boolean(origCheck.ok && pure && asarSha256 !== origCheck.sha256);
  const patchedShaMismatch = Boolean(
    markers.hostInstalled && expectedPatchedSha256 && asarSha256 !== expectedPatchedSha256
  );

  // Distinguish intentional rollback (`index.rolledBackAt`) from vendor auto-update overwrite (`UPDATED_UNPATCHED`)
  const hadPreviousActiveInstall = Boolean(index.activePatchedSha256 && !index.rolledBackAt);
  const updatedUnpatched = Boolean(
    pure && hadPreviousActiveInstall && asarSha256 !== index.activePatchedSha256
  );
  const needsUpgrade = markers.priorHostMarkersInstalled.length > 0 && !markers.hostInstalled;

  return {
    asarExists: true,
    appVersion: archive.appVersion,
    asarSha256,
    hostInstalled: markers.hostInstalled,
    priorHostMarkersInstalled: markers.priorHostMarkersInstalled,
    needsUpgrade,
    legacyMarkers: markers.legacyMarkers,
    hasLegacyConflict: markers.legacyMarkers.length > 0,
    backupsDir,
    origBackupPath: candidate ? candidate.backupPath : getVersionedBackupPath(backupsDir, safeVer, asarSha256),
    origBackupValid: Boolean(origCheck.ok),
    origBackupStatus: origCheck.ok ? 'VALID' : origCheck.status,
    origBackupSha256,
    expectedPatchedSha256,
    rolledBackAt: index.rolledBackAt || null,
    updatedUnpatched,
    status: updatedUnpatched
      ? 'UPDATED_UNPATCHED'
      : needsUpgrade
        ? 'NEEDS_UPGRADE'
        : markers.hostInstalled
          ? 'INSTALLED'
          : 'UNPATCHED',
    origBuildMismatch,
    patchedShaMismatch,
  };
}

module.exports = {
  DEFAULT_BACKUP_RETENTION,
  sha256Hex,
  sanitizeVersionForFilename,
  resolveBackupsDir,
  readBackupIndex,
  writeBackupIndex,
  pruneBackups,
  acquireExclusiveLockDetailed,
  acquireExclusiveLock,
  releaseExclusiveLock,
  writeAtomicSync,
  readAsarArchive,
  verifyAllAsarIntegrity,
  detectArchiveMarkers,
  isPureUnpatchedArchive,
  isAsarHostInstalled,
  parseJavaScriptWithAcorn,
  findSafeStandaloneCommentRanges,
  transformExactSize,
  verifyOrigBackupStrict,
  installAsarAddonHost,
  upgradeAsarAddonHost,
  rollbackAsarAddonHost,
  diagnoseAsarState,
};
