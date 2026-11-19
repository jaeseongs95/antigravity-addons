'use strict';

/**
 * Electron ASAR Single-Owner Patcher, Integrity Verifier, Rollback, and Legacy Conflict Doctor.
 *
 * Uses official `@electron/asar` and `proper-lockfile` (zero hand-rolled ASAR header parsing or lockfiles).
 * Strictly vendor-independent: all paths, anchors, and markers come from the injected `HostProfile`.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const asar = require('@electron/asar');
const lockfile = require('proper-lockfile');

const { assertValidHostProfile } = require('../../core/host-profile-port');

const activeLockReleases = new Map();

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function acquireExclusiveLock(lockPath, staleMs = 60000) {
  if (!lockPath) return null;
  const effectiveStaleMs = Math.max(Number(staleMs) || 60000, 2000);
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    if (fs.existsSync(lockPath)) {
      const st = fs.lstatSync(lockPath);
      if (st.isFile()) {
        if (Date.now() - st.mtimeMs <= effectiveStaleMs) {
          return null;
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
    return token;
  } catch (_err) {
    return null;
  }
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
      if (pkg && typeof pkg.version === 'string') appVersion = pkg.version;
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
  assertValidHostProfile(profile);
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
  assertValidHostProfile(profile);
  try {
    if (!asarPath || !fs.existsSync(asarPath)) return false;
    const archive = readAsarArchive(asarPath);
    return detectArchiveMarkers(archive, profile).hostInstalled;
  } catch (_err) {
    return false;
  }
}

function transformExactSize(origBuf, targetStr, replacementStr, marker) {
  const origText = origBuf.toString('utf8');
  const firstIdx = origText.indexOf(targetStr);
  if (firstIdx === -1) throw new Error('ANCHOR_NOT_FOUND');
  if (origText.indexOf(targetStr, firstIdx + 1) !== -1) throw new Error('ANCHOR_NOT_UNIQUE');

  let nextText = origText.slice(0, firstIdx) + replacementStr + origText.slice(firstIdx + targetStr.length);
  let delta = Buffer.byteLength(nextText, 'utf8') - origBuf.length;

  if (delta > 0) {
    const lines = nextText.split('\n');
    const kept = [];
    for (const line of lines) {
      if (
        delta > 0 &&
        (!marker || !line.includes(marker)) &&
        /^\s*\/\/\s*[A-Za-z0-9#*\-_=.,:;()[\]{}@/'" ]*$/.test(line)
      ) {
        delta -= Buffer.byteLength(line, 'utf8') + 1;
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
  assertValidHostProfile(profile);
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
  assertValidHostProfile(profile);
  if (!fs.existsSync(paths.ASAR_PATH)) {
    return { status: 'SKIPPED_NO_ASAR' };
  }
  const lockTok = acquireExclusiveLock(paths.ASAR_LOCK_PATH, 60000);
  if (!lockTok) return { status: 'LOCK_BUSY' };

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

    const backupPath = `${paths.ASAR_PATH}.v${archive.appVersion}.orig`;
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

    const patchedMainBuf = transformExactSize(
      mainBuf,
      profile.mainAnchorTarget,
      profile.mainAnchorReplacement,
      profile.patchMarker
    );
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
        node.integrity = computeIntegrity(data);
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
    releaseExclusiveLock(paths.ASAR_LOCK_PATH, lockTok);
  }
}

function rollbackAsarAddonHost(paths, profile, { force = false } = {}) {
  assertValidHostProfile(profile);
  if (!fs.existsSync(paths.ASAR_PATH)) {
    return { status: 'SKIPPED_NO_ASAR' };
  }

  const remainingManifests = fs.existsSync(paths.ADDONS_DIR)
    ? fs.readdirSync(paths.ADDONS_DIR).filter((f) => f.endsWith('.json'))
    : [];
  if (remainingManifests.length > 0 && !force) {
    return {
      status: 'BLOCKED_REGISTERED_ADDONS_REMAIN',
      remainingManifests,
    };
  }

  const lockTok = acquireExclusiveLock(paths.ASAR_LOCK_PATH, 60000);
  if (!lockTok) return { status: 'LOCK_BUSY' };
  try {
    const cur = readAsarArchive(paths.ASAR_PATH);
    if (isPureUnpatchedArchive(cur, profile)) {
      return { status: 'ALREADY_UNPATCHED', appVersion: cur.appVersion };
    }
    const backupPath = `${paths.ASAR_PATH}.v${cur.appVersion}.orig`;
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
    releaseExclusiveLock(paths.ASAR_LOCK_PATH, lockTok);
  }
}

function diagnoseAsarState(paths, profile) {
  assertValidHostProfile(profile);
  if (!fs.existsSync(paths.ASAR_PATH)) {
    return { asarExists: false, status: 'NO_ASAR', legacyMarkers: [], origBackupValid: false };
  }
  const archive = readAsarArchive(paths.ASAR_PATH);
  const markers = detectArchiveMarkers(archive, profile);
  const backupPath = `${paths.ASAR_PATH}.v${archive.appVersion}.orig`;
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
  acquireExclusiveLock,
  releaseExclusiveLock,
  writeAtomicSync,
  readAsarArchive,
  verifyAllAsarIntegrity,
  detectArchiveMarkers,
  isPureUnpatchedArchive,
  isAsarHostInstalled,
  transformExactSize,
  verifyOrigBackupStrict,
  installAsarAddonHost,
  rollbackAsarAddonHost,
  diagnoseAsarState,
};
