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
const asar = require('@electron/asar');
const acorn = require('acorn');

const {
  acquireExclusiveLockDetailed,
  acquireExclusiveLock,
  releaseExclusiveLock,
  writeAtomicSync,
} = require('../fs-lock-atomic');
const { assertValidElectronHostProfile } = require('./electron-host-profile-port');

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

function isJsLineTerminator(ch) {
  return ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029';
}

function parseJavaScriptWithAcorn(sourceText, onComment = null) {
  const tryParse = (sourceType) => {
    // R8-F1: Collect comments into an attempt-local buffer so a failed 'script' pass
    // before falling back to 'module' never duplicates comment ranges into caller state.
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

/**
 * Finds exact character-offset ranges `[lineStart, lineEnd]` of standalone `//` line comments
 * using Acorn's `onComment(block, text, start, end)` offsets directly.
 * Immune to `\r`, `\u2028`, `\u2029`, regex literals, nested template `${...}`, and strings.
 */
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
    // Walk backward to the nearest ECMAScript line terminator (\n, \r, \u2028, \u2029) or start of file
    let lineStart = c.start;
    while (lineStart > 0 && !isJsLineTerminator(sourceText[lineStart - 1])) {
      lineStart--;
    }
    const prefix = sourceText.slice(lineStart, c.start);
    if (!/^[ \t]*$/.test(prefix)) continue;

    // Verify the comment reaches end-of-line (or EOF) and consume its trailing line terminator
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
  // R6-F2: Validate syntax with Acorn (supports CJS, ESM, and Hashbang uniformly)
  parseJavaScriptWithAcorn(nextText);
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
  // NB1: Also acquire ADDONS_LOCK_PATH (when provided) to serialize rollback against concurrent --register
  const addonsLockRes = paths.ADDONS_LOCK_PATH
    ? acquireExclusiveLockDetailed(paths.ADDONS_LOCK_PATH, 30000)
    : { ok: true, token: null };
  if (!addonsLockRes.ok) {
    releaseExclusiveLock(paths.ASAR_LOCK_PATH, lockRes.token);
    return { status: addonsLockRes.code, error: addonsLockRes.error, fsCode: addonsLockRes.fsCode };
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
    if (addonsLockRes.token) releaseExclusiveLock(paths.ADDONS_LOCK_PATH, addonsLockRes.token);
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
  parseJavaScriptWithAcorn,
  findSafeStandaloneCommentRanges,
  transformExactSize,
  verifyOrigBackupStrict,
  installAsarAddonHost,
  rollbackAsarAddonHost,
  diagnoseAsarState,
};
