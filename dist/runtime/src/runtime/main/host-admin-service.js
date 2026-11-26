'use strict';

/**
 * Vendor-neutral Host Admin State & Remote Preferences Service (v2.5.0 — SOLID SRP/DIP).
 *
 * - Aggregates live desktop addon inventory, trust-policy approval state, Remote Web
 *   compatibility/eligibility, per-plugin Remote Web visibility preferences, and built
 *   Remote Web bundle status (`build-manifest.json` + optional `bookmarklet.txt`).
 * - Persists user Remote Web visibility toggles strictly in host-owned
 *   `remote-preferences.json` (NEVER writes under `~/.gemini/config/plugins/`).
 * - Enforces symlink rejection, `parseSafeJson` prototype guard, `pluginId` validation,
 *   size cap, and atomic temp+rename writes.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseSafeJson } = require('../shared/safe-json');
const { BOOKMARKLET_MAX_RUNNABLE_CHARS } = require('../shared/constants');
const { planAddonExecution } = require('../../core/lifecycle-coordinator');
const { readVerifiedRendererScript, sha256Hex } = require('./trust-verifier');

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const MAX_REMOTE_PREFS_BYTES = 65536;
const MAX_HOST_CLI_META_BYTES = 16384;
const MAX_EXTENSION_MANIFEST_BYTES = 65536;
const DEFAULT_REMOTE_PREFS_FILENAME = 'remote-preferences.json';
const DEFAULT_HOST_CLI_META_FILENAME = 'host-cli.json';
const DEFAULT_CLI_COMMAND_NAME = 'addon-host';
const UNSAFE_SHELL_PATH_RE = /[\r\n\0"'`$;&|<>]/;

function isSafeShellQuotedPath(filePath) {
  if (typeof filePath !== 'string') return false;
  const trimmed = filePath.trim();
  if (!trimmed || UNSAFE_SHELL_PATH_RE.test(trimmed)) return false;
  return path.isAbsolute(trimmed);
}

function isCommandOnPath(
  commandName = DEFAULT_CLI_COMMAND_NAME,
  { pathEnv = undefined, pathExtEnv = undefined, platform = process.platform } = {}
) {
  if (typeof commandName !== 'string' || !commandName.trim() || UNSAFE_SHELL_PATH_RE.test(commandName)) {
    return false;
  }
  const activePlatform = platform || process.platform;
  const isWin = activePlatform === 'win32';
  const rawPath =
    typeof pathEnv === 'string'
      ? pathEnv
      : isWin
        ? process.env.PATH || process.env.Path || ''
        : process.env.PATH || '';
  if (!rawPath) return false;

  const sep = isWin ? ';' : ':';
  const dirs = rawPath
    .split(sep)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  if (dirs.length === 0) return false;

  let exts = [''];
  if (isWin) {
    const rawExt =
      typeof pathExtEnv === 'string' ? pathExtEnv : process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.PS1';
    const parsedExts = [];
    const seenExts = new Set();
    for (const part of rawExt.split(';')) {
      const trimmed = part.trim();
      if (!trimmed.startsWith('.')) continue;
      for (const variant of [trimmed, trimmed.toLowerCase()]) {
        if (!seenExts.has(variant)) {
          seenExts.add(variant);
          parsedExts.push(variant);
        }
      }
    }
    const hasExt = path.extname(commandName) !== '';
    exts = hasExt ? ['', ...parsedExts] : parsedExts.length > 0 ? parsedExts : ['.EXE', '.exe', '.CMD', '.cmd', '.BAT', '.bat'];
  }

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, ext ? `${commandName}${ext}` : commandName);
      try {
        const st = fs.statSync(candidate);
        if (!st.isFile()) continue;
        if (!isWin) {
          fs.accessSync(candidate, fs.constants.X_OK);
        }
        return true;
      } catch (_err) {
        // continue searching PATH
      }
    }
  }
  return false;
}

function readHostCliMetaFile(metaPath) {
  const empty = {
    ok: true,
    exists: false,
    path: metaPath || null,
    cliEntryPath: null,
    updatedAt: null,
    error: null,
  };
  if (!metaPath || typeof metaPath !== 'string') {
    return empty;
  }
  if (!fs.existsSync(metaPath)) {
    return empty;
  }
  try {
    const lstat = fs.lstatSync(metaPath);
    if (lstat.isSymbolicLink() || !lstat.isFile()) {
      return { ...empty, ok: false, exists: true, error: 'ERR_HOST_CLI_META_NON_REGULAR_OR_SYMLINK' };
    }
    if (lstat.size > MAX_HOST_CLI_META_BYTES) {
      return { ...empty, ok: false, exists: true, error: 'ERR_HOST_CLI_META_TOO_LARGE' };
    }
    const parsed = parseSafeJson(fs.readFileSync(metaPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...empty, ok: false, exists: true, error: 'ERR_HOST_CLI_META_INVALID_ROOT' };
    }
    const rawCli = typeof parsed.cliEntryPath === 'string' ? parsed.cliEntryPath.trim() : '';
    const updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null;
    if (!isSafeShellQuotedPath(rawCli)) {
      return { ...empty, ok: false, exists: true, updatedAt, error: 'ERR_HOST_CLI_ENTRY_INVALID' };
    }
    const resolvedCli = path.resolve(rawCli);
    try {
      if (!fs.statSync(resolvedCli).isFile()) {
        return { ...empty, ok: true, exists: true, updatedAt, error: 'ERR_HOST_CLI_ENTRY_MISSING' };
      }
    } catch (_statErr) {
      return { ...empty, ok: true, exists: true, updatedAt, error: 'ERR_HOST_CLI_ENTRY_MISSING' };
    }
    return {
      ok: true,
      exists: true,
      path: metaPath,
      cliEntryPath: resolvedCli,
      updatedAt,
      error: null,
    };
  } catch (err) {
    return {
      ...empty,
      ok: false,
      exists: true,
      error: err && err.message ? err.message : String(err),
    };
  }
}

function resolveCliSubcommand({
  subcommandFlag = '--build-remote',
  remoteDistDir = null,
  cliCommandName = DEFAULT_CLI_COMMAND_NAME,
  cliEntryPath = null,
  hostCliMetaPath = null,
  pathEnv = undefined,
  pathExtEnv = undefined,
  platform = process.platform,
} = {}) {
  const safeCmd =
    typeof cliCommandName === 'string' && cliCommandName.trim() && !UNSAFE_SHELL_PATH_RE.test(cliCommandName.trim())
      ? cliCommandName.trim()
      : DEFAULT_CLI_COMMAND_NAME;
  const distTrimmed = typeof remoteDistDir === 'string' ? remoteDistDir.trim() : '';
  const safeDistDir = distTrimmed && !UNSAFE_SHELL_PATH_RE.test(distTrimmed) ? distTrimmed : null;
  const argsSuffix = safeDistDir ? `${subcommandFlag} --out-dir "${safeDistDir}"` : subcommandFlag;

  if (isCommandOnPath(safeCmd, { pathEnv, pathExtEnv, platform })) {
    return {
      command: `${safeCmd} ${argsSuffix}`,
      source: 'path',
      runnable: true,
      cliEntryPath: null,
    };
  }

  let candidateCli = null;
  if (isSafeShellQuotedPath(cliEntryPath)) {
    const resolvedExplicit = path.resolve(cliEntryPath.trim());
    try {
      if (fs.statSync(resolvedExplicit).isFile()) {
        candidateCli = resolvedExplicit;
      }
    } catch (_err) {
      candidateCli = null;
    }
  }
  if (!candidateCli && hostCliMetaPath) {
    const meta = readHostCliMetaFile(hostCliMetaPath);
    if (meta.ok && meta.cliEntryPath) {
      candidateCli = meta.cliEntryPath;
    }
  }

  if (candidateCli) {
    return {
      command: `node "${candidateCli}" ${argsSuffix}`,
      source: 'cli-entry',
      runnable: true,
      cliEntryPath: candidateCli,
    };
  }

  return {
    command: `${safeCmd} ${argsSuffix}`,
    source: 'fallback',
    runnable: false,
    cliEntryPath: null,
  };
}

function resolveBuildRemoteCommand(opts = {}) {
  return resolveCliSubcommand({ ...opts, subcommandFlag: '--build-remote' });
}

function resolveServeRemoteCommand(opts = {}) {
  return resolveCliSubcommand({ ...opts, subcommandFlag: '--serve-remote' });
}

function readRemotePreferencesFile(prefsPath) {
  const empty = {
    ok: true,
    exists: false,
    path: prefsPath || null,
    addons: {},
    updatedAt: null,
    error: null,
  };
  if (!prefsPath || typeof prefsPath !== 'string') {
    return empty;
  }
  if (!fs.existsSync(prefsPath)) {
    return empty;
  }
  try {
    const lstat = fs.lstatSync(prefsPath);
    if (lstat.isSymbolicLink() || !lstat.isFile()) {
      return { ...empty, ok: false, exists: true, error: 'ERR_REMOTE_PREFS_NON_REGULAR_OR_SYMLINK' };
    }
    if (lstat.size > MAX_REMOTE_PREFS_BYTES) {
      return { ...empty, ok: false, exists: true, error: 'ERR_REMOTE_PREFS_TOO_LARGE' };
    }
    const raw = fs.readFileSync(prefsPath, 'utf8');
    const parsed = parseSafeJson(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...empty, ok: false, exists: true, error: 'ERR_REMOTE_PREFS_INVALID_ROOT' };
    }
    const addons = {};
    if (parsed.addons && typeof parsed.addons === 'object' && !Array.isArray(parsed.addons)) {
      for (const [id, rec] of Object.entries(parsed.addons)) {
        if (!PLUGIN_ID_RE.test(id)) continue;
        if (rec && typeof rec === 'object' && typeof rec.enabled === 'boolean') {
          addons[id] = {
            enabled: rec.enabled,
            updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : null,
          };
        } else if (typeof rec === 'boolean') {
          addons[id] = { enabled: rec, updatedAt: null };
        }
      }
    }
    return {
      ok: true,
      exists: true,
      path: prefsPath,
      addons,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      error: null,
    };
  } catch (err) {
    return {
      ...empty,
      ok: false,
      exists: true,
      error: err && err.message ? err.message : String(err),
    };
  }
}

function isAddonEnabledInRemotePreferences(prefs, pluginId) {
  if (!prefs || !prefs.addons || typeof pluginId !== 'string') return true;
  const rec = prefs.addons[pluginId];
  if (!rec || typeof rec !== 'object') return true;
  return rec.enabled !== false;
}

function writeRemotePreferencesFileAtomic(prefsPath, nextData) {
  if (!prefsPath || typeof prefsPath !== 'string') {
    return { ok: false, reason: 'ERR_REMOTE_PREFS_PATH_MISSING' };
  }
  const absPath = path.resolve(prefsPath);
  const dir = path.dirname(absPath);
  fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(absPath)) {
    const lstat = fs.lstatSync(absPath);
    if (lstat.isSymbolicLink() || !lstat.isFile()) {
      return { ok: false, reason: 'ERR_REMOTE_PREFS_NON_REGULAR_OR_SYMLINK' };
    }
  }

  const serialized = JSON.stringify(nextData, null, 2) + '\n';
  if (Buffer.byteLength(serialized, 'utf8') > MAX_REMOTE_PREFS_BYTES) {
    return { ok: false, reason: 'ERR_REMOTE_PREFS_TOO_LARGE' };
  }

  const tmpName = `.remote-prefs.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const tmpPath = path.join(dir, tmpName);
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
    return { ok: true, reason: null };
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (_cleanupErr) {}
    return { ok: false, reason: err && err.message ? err.message : 'ERR_REMOTE_PREFS_WRITE_FAILED' };
  }
}

function resolveSafeChildPath(rootDir, relPosix) {
  if (!rootDir || typeof relPosix !== 'string' || !relPosix.trim()) return null;
  if (relPosix.includes('\\') || relPosix.includes('\0') || path.isAbsolute(relPosix)) return null;
  const segments = relPosix.split('/');
  if (segments.some((seg) => !seg || seg === '.' || seg === '..')) return null;
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(resolvedRoot, ...segments);
  if (resolvedTarget === resolvedRoot || !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    return null;
  }
  return resolvedTarget;
}

function isRegularNonSymlinkFile(filePath) {
  try {
    const st = fs.lstatSync(filePath);
    return st.isFile() && !st.isSymbolicLink();
  } catch (_err) {
    return false;
  }
}

function isRegularNonSymlinkDir(dirPath) {
  try {
    const st = fs.lstatSync(dirPath);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch (_err) {
    return false;
  }
}

function readRemoteBundleStatus(remoteDistDir) {
  const empty = {
    built: false,
    distDir: remoteDistDir || null,
    buildSha8: null,
    mode: null,
    addonCount: 0,
    packedPluginIds: [],
    packedAddonsById: {},
    hasExtension: false,
    extensionDir: null,
    hasUserscript: false,
    userscriptPath: null,
    hasHostLib: false,
    hostLibPath: null,
    hasUserscriptMeta: false,
    userscriptMetaPath: null,
    hasBookmarklet: false,
    bookmarkletRunnable: false,
    bookmarkletChars: null,
    bookmarkletMaxChars: BOOKMARKLET_MAX_RUNNABLE_CHARS,
    bookmarkletText: null,
  };
  if (!remoteDistDir || !fs.existsSync(remoteDistDir)) {
    return empty;
  }
  const manifestPath = path.join(remoteDistDir, 'build-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return empty;
  }
  try {
    const parsed = parseSafeJson(fs.readFileSync(manifestPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.buildSha8 !== 'string' || !parsed.buildSha8) {
      return empty;
    }
    const packedAddonsById = {};
    const packedPluginIds = Array.isArray(parsed.addons)
      ? parsed.addons
          .map((a) => {
            if (!a || typeof a !== 'object' || typeof a.pluginId !== 'string' || !a.pluginId) return null;
            packedAddonsById[a.pluginId] = {
              version: typeof a.version === 'string' && a.version ? a.version : null,
              rendererSha256: typeof a.rendererSha256 === 'string' && a.rendererSha256 ? a.rendererSha256 : null,
            };
            return a.pluginId;
          })
          .filter(Boolean)
          .sort()
      : [];
    const manifestFiles = parsed.files && typeof parsed.files === 'object' ? Object.keys(parsed.files) : [];
    const userscriptFileName = manifestFiles.find((name) => typeof name === 'string' && name.endsWith('.user.js')) || null;
    const candidateUserscriptPath = userscriptFileName
      ? resolveSafeChildPath(remoteDistDir, userscriptFileName)
      : null;
    const hasUserscript = Boolean(candidateUserscriptPath && isRegularNonSymlinkFile(candidateUserscriptPath));
    const userscriptPath = hasUserscript ? candidateUserscriptPath : null;

    const hostLibFileName = manifestFiles.find((name) => typeof name === 'string' && name.endsWith('.lib.js')) || null;
    const candidateHostLibPath = hostLibFileName ? resolveSafeChildPath(remoteDistDir, hostLibFileName) : null;
    const hasHostLib = Boolean(candidateHostLibPath && isRegularNonSymlinkFile(candidateHostLibPath));
    const hostLibPath = hasHostLib ? candidateHostLibPath : null;

    const metaFileName = manifestFiles.find((name) => typeof name === 'string' && name.endsWith('.meta.js')) || null;
    const candidateMetaPath = metaFileName ? resolveSafeChildPath(remoteDistDir, metaFileName) : null;
    const hasUserscriptMeta = Boolean(candidateMetaPath && isRegularNonSymlinkFile(candidateMetaPath));
    const userscriptMetaPath = hasUserscriptMeta ? candidateMetaPath : null;

    const extDirRel =
      parsed.extension && typeof parsed.extension === 'object' && typeof parsed.extension.dir === 'string'
        ? parsed.extension.dir
        : 'extension';
    const extManifestRel =
      parsed.extension && typeof parsed.extension === 'object' && typeof parsed.extension.manifestFile === 'string'
        ? parsed.extension.manifestFile
        : `${extDirRel}/manifest.json`;
    const extScriptRel =
      parsed.extension && typeof parsed.extension === 'object' && typeof parsed.extension.contentScriptFile === 'string'
        ? parsed.extension.contentScriptFile
        : `${extDirRel}/content-script.js`;

    const candidateExtDir = resolveSafeChildPath(remoteDistDir, extDirRel);
    const candidateExtManifest = resolveSafeChildPath(remoteDistDir, extManifestRel);
    const candidateExtScript = resolveSafeChildPath(remoteDistDir, extScriptRel);
    let hasExtension = false;
    let extensionDir = null;
    if (
      candidateExtDir &&
      candidateExtManifest &&
      candidateExtScript &&
      isRegularNonSymlinkDir(candidateExtDir) &&
      isRegularNonSymlinkFile(candidateExtManifest) &&
      isRegularNonSymlinkFile(candidateExtScript)
    ) {
      try {
        const extManifestStat = fs.lstatSync(candidateExtManifest);
        if (extManifestStat.size > 0 && extManifestStat.size <= MAX_EXTENSION_MANIFEST_BYTES) {
          const extManifest = parseSafeJson(fs.readFileSync(candidateExtManifest, 'utf8'));
          if (extManifest && typeof extManifest === 'object' && extManifest.manifest_version === 3) {
            hasExtension = true;
            extensionDir = candidateExtDir;
          }
        }
      } catch (_extErr) {
        hasExtension = false;
        extensionDir = null;
      }
    }

    const bookmarkletPath = path.join(remoteDistDir, 'bookmarklet.txt');
    let hasBookmarklet = false;
    let bookmarkletRunnable = false;
    let bookmarkletChars = null;
    let bookmarkletText = null;
    if (fs.existsSync(bookmarkletPath)) {
      const stat = fs.lstatSync(bookmarkletPath);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size > 0) {
        if (stat.size > BOOKMARKLET_MAX_RUNNABLE_CHARS) {
          bookmarkletChars = stat.size;
        } else {
          const trimmed = fs.readFileSync(bookmarkletPath, 'utf8').trim();
          bookmarkletChars = trimmed.length;
          if (
            trimmed.startsWith('javascript:') &&
            trimmed.length > 0 &&
            trimmed.length <= BOOKMARKLET_MAX_RUNNABLE_CHARS
          ) {
            hasBookmarklet = true;
            bookmarkletRunnable = true;
            bookmarkletText = trimmed;
          }
        }
      }
    } else if (
      parsed.bookmarklet &&
      typeof parsed.bookmarklet === 'object' &&
      Number.isFinite(parsed.bookmarklet.charLength) &&
      parsed.bookmarklet.charLength > 0
    ) {
      bookmarkletChars = parsed.bookmarklet.charLength;
    }

    return {
      built: true,
      distDir: remoteDistDir,
      buildSha8: parsed.buildSha8,
      mode: typeof parsed.mode === 'string' ? parsed.mode : null,
      addonCount: packedPluginIds.length,
      packedPluginIds,
      packedAddonsById,
      hasExtension,
      extensionDir,
      hasUserscript,
      userscriptPath,
      hasHostLib,
      hostLibPath,
      hasUserscriptMeta,
      userscriptMetaPath,
      hasBookmarklet,
      bookmarkletRunnable,
      bookmarkletChars,
      bookmarkletMaxChars: BOOKMARKLET_MAX_RUNNABLE_CHARS,
      bookmarkletText,
    };
  } catch (_err) {
    return empty;
  }
}

function sameStringArray(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function isOfflineConfigBridgeManifest(manifest, remoteProfileId) {
  if (!manifest || typeof manifest !== 'object') return false;
  const hasConfigBridge = Boolean(
    manifest.configBridge &&
      typeof manifest.configBridge === 'object' &&
      Array.isArray(manifest.configBridge.scopes) &&
      manifest.configBridge.scopes.length > 0
  );
  if (!hasConfigBridge) return false;
  const compat = manifest.compatibility && typeof manifest.compatibility === 'object' ? manifest.compatibility : null;
  const explicitRemoteOptIn = Boolean(
    compat &&
      ((typeof compat.hostProfile === 'string' && compat.hostProfile === remoteProfileId) ||
        (Array.isArray(compat.hostProfiles) && compat.hostProfiles.includes(remoteProfileId)))
  );
  return !explicitRemoteOptIn;
}

function createHostAdminService({
  hostVersion = '2.7.0',
  buildSha8 = 'dev',
  profile = {},
  addonsDir = null,
  pluginsRootDir = null,
  remotePrefsPath = null,
  remoteDistDir = null,
  hostCliMetaPath = null,
  cliEntryPath = null,
  cliCommandName = DEFAULT_CLI_COMMAND_NAME,
  pathEnv = undefined,
  pathExtEnv = undefined,
  platform = process.platform,
  strictTrustPolicy = true,
  fsPort = null,
  isEnabledInDesktopConfig = () => true,
  loadRawManifests = () => [],
  planDesktopAddons = () => ({ active: [], disabled: [], rejected: [] }),
  readCurrentPolicy = () => ({ schemaVersion: 1, approved: {} }),
  getLifecycleStates = () => ({}),
  recordDiag = () => {},
} = {}) {
  const effectiveRemotePrefsPath =
    remotePrefsPath ||
    (addonsDir ? path.join(path.dirname(path.resolve(addonsDir)), DEFAULT_REMOTE_PREFS_FILENAME) : null);
  const effectiveRemoteDistDir =
    remoteDistDir ||
    (addonsDir ? path.join(path.dirname(path.resolve(addonsDir)), 'remote-dist') : null);
  const effectiveHostCliMetaPath =
    hostCliMetaPath ||
    (addonsDir ? path.join(path.dirname(path.resolve(addonsDir)), DEFAULT_HOST_CLI_META_FILENAME) : null);
  const effectiveRemoteProfileId =
    typeof profile.remoteProfileId === 'string' && profile.remoteProfileId.trim()
      ? profile.remoteProfileId.trim()
      : null;
  const effectiveRemoteCapabilities = Array.isArray(profile.remoteSupportedCapabilities)
    ? profile.remoteSupportedCapabilities
    : ['renderer'];

  function getState() {
    const rawEntries = loadRawManifests(addonsDir);
    const desktopPlan = planDesktopAddons();
    const policy = readCurrentPolicy();
    const lifecycleMap = getLifecycleStates() || {};
    const remotePrefs = readRemotePreferencesFile(effectiveRemotePrefsPath);

    // Evaluate Remote Web compatibility using the exact same core planner
    let remotePlan = { active: [], disabled: [], rejected: [] };
    if (effectiveRemoteProfileId) {
      remotePlan = planAddonExecution(rawEntries, {
        pluginsRootDir,
        checkFilesExist: true,
        hostProfileId: effectiveRemoteProfileId,
        compatibleHostProfiles: profile.id ? [profile.id] : null,
        supportedCapabilities: effectiveRemoteCapabilities,
        forbiddenNetHosts: Array.isArray(profile.forbiddenNetHosts) ? profile.forbiddenNetHosts : null,
        hostVersion,
        strictTrustPolicy,
        fsPort,
        isEnabled: isEnabledInDesktopConfig,
      });
    }

    const desktopActiveById = new Map((desktopPlan.active || []).map((a) => [a.pluginId, a]));
    const desktopDisabledById = new Map((desktopPlan.disabled || []).map((d) => [d.pluginId, d]));
    const desktopRejectedById = new Map((desktopPlan.rejected || []).map((r) => [r.pluginId, r]));

    const remoteActiveById = new Map((remotePlan.active || []).map((a) => [a.pluginId, a]));
    const remoteDisabledById = new Map((remotePlan.disabled || []).map((d) => [d.pluginId, d]));
    const remoteRejectedById = new Map((remotePlan.rejected || []).map((r) => [r.pluginId, r]));

    const seenIds = new Set();
    const addons = [];
    const liveRemoteSnapshotById = new Map();

    for (const entry of rawEntries) {
      const manifest = entry && entry.manifest && typeof entry.manifest === 'object' ? entry.manifest : null;
      const pluginId =
        manifest && typeof manifest.pluginId === 'string' && manifest.pluginId.trim()
          ? manifest.pluginId.trim()
          : path.basename(String((entry && entry.source) || 'unknown'), '.json');
      if (seenIds.has(pluginId)) continue;
      seenIds.add(pluginId);

      const desktopActive = desktopActiveById.get(pluginId) || null;
      const desktopDisabled = desktopDisabledById.get(pluginId) || null;
      const desktopRejected = desktopRejectedById.get(pluginId) || null;

      const activeManifest = (desktopActive && desktopActive.manifest) || manifest || {};
      const displayName =
        typeof activeManifest.displayName === 'string' && activeManifest.displayName.trim()
          ? activeManifest.displayName.trim()
          : pluginId;
      const version = typeof activeManifest.version === 'string' ? activeManifest.version : '0.0.0';
      const loadOrder = Number.isFinite(Number(activeManifest.loadOrder)) ? Number(activeManifest.loadOrder) : 100;
      const trustLevel = activeManifest.trustLevel === 'trusted' ? 'trusted' : 'restricted';
      const capabilities = Array.isArray(activeManifest.capabilities) ? activeManifest.capabilities.slice() : ['renderer'];
      const hasSettingsBridge = Boolean(activeManifest.settingsBridge && activeManifest.settingsBridge.fileName);
      const hasConfigBridge = Boolean(
        activeManifest.configBridge &&
          Array.isArray(activeManifest.configBridge.scopes) &&
          activeManifest.configBridge.scopes.length > 0
      );

      let trustApproved = null;
      let trustRejectReason = null;
      let liveRendererSha256 = null;
      const candidateAddon = desktopActive || remoteActiveById.get(pluginId) || null;
      const rendererScript = candidateAddon && candidateAddon.resolvedEntries ? candidateAddon.resolvedEntries.rendererScript : null;
      if (trustLevel === 'trusted') {
        if (rendererScript && fs.existsSync(rendererScript)) {
          const verified = readVerifiedRendererScript(rendererScript, activeManifest, policy, {
            strictTrustPolicy,
          });
          trustApproved = verified.ok;
          liveRendererSha256 = typeof verified.sha256 === 'string' ? verified.sha256 : null;
          if (!verified.ok) trustRejectReason = verified.reason;
        } else {
          trustApproved = Boolean(policy && policy.approved && policy.approved[pluginId]);
          if (!trustApproved) trustRejectReason = 'ERR_TRUST_POLICY_NOT_APPROVED';
        }
      } else if (rendererScript && fs.existsSync(rendererScript)) {
        try {
          liveRendererSha256 = sha256Hex(fs.readFileSync(rendererScript));
        } catch (_hashErr) {
          liveRendererSha256 = null;
        }
      }

      const liveState = lifecycleMap[pluginId] || null;
      let desktopStatus = 'pending';
      let desktopReason = null;
      if (desktopDisabled) {
        desktopStatus = 'disabled';
        desktopReason = desktopDisabled.reason || 'DISABLED_IN_CONFIG';
      } else if (desktopRejected) {
        desktopStatus = 'rejected';
        desktopReason = desktopRejected.reason || 'ERR_REJECTED';
      } else if (trustLevel === 'trusted' && trustApproved === false) {
        desktopStatus = 'rejected';
        desktopReason = trustRejectReason || 'ERR_TRUST_POLICY_NOT_APPROVED';
      } else if (liveState === 'FAILED') {
        desktopStatus = 'failed';
      } else if (liveState === 'ACTIVE' || desktopActive) {
        desktopStatus = 'active';
      }

      // Remote Web eligibility & user visibility preference
      let remoteEligible = false;
      let remoteBlockedReason = null;
      if (!effectiveRemoteProfileId) {
        remoteBlockedReason = 'ERR_REMOTE_PROFILE_UNCONFIGURED';
      } else if (remoteDisabledById.has(pluginId)) {
        remoteBlockedReason = remoteDisabledById.get(pluginId).reason || 'DISABLED_IN_CONFIG';
      } else if (remoteRejectedById.has(pluginId)) {
        remoteBlockedReason = remoteRejectedById.get(pluginId).reason || 'ERR_INCOMPATIBLE_HOST_PROFILE';
      } else if (!remoteActiveById.has(pluginId)) {
        remoteBlockedReason = 'ERR_UNSUPPORTED_HOST_CAPABILITY';
      } else if (isOfflineConfigBridgeManifest(activeManifest, effectiveRemoteProfileId)) {
        remoteBlockedReason = 'ERR_REMOTE_REQUIRES_LOCAL_CONFIG_BRIDGE';
      } else if (trustLevel === 'trusted' && trustApproved === false) {
        remoteBlockedReason = trustRejectReason || 'ERR_TRUST_POLICY_NOT_APPROVED';
      } else {
        remoteEligible = true;
      }

      const prefEnabled = isAddonEnabledInRemotePreferences(remotePrefs, pluginId);
      const remoteEnabled = remoteEligible && prefEnabled;
      if (remoteEnabled) {
        liveRemoteSnapshotById.set(pluginId, {
          version,
          rendererSha256: liveRendererSha256,
        });
      }

      addons.push({
        pluginId,
        displayName,
        version,
        loadOrder,
        trustLevel,
        trustApproved,
        capabilities,
        hasSettingsBridge,
        hasConfigBridge,
        desktopStatus,
        desktopLifecycleState: liveState,
        desktopReason,
        remoteEligible,
        remoteEnabled,
        remoteToggleable: remoteEligible,
        remoteBlockedReason,
      });
    }

    addons.sort((a, b) => (a.loadOrder !== b.loadOrder ? a.loadOrder - b.loadOrder : a.pluginId.localeCompare(b.pluginId)));

    const remoteEnabledIds = addons
      .filter((a) => a.remoteEnabled)
      .map((a) => a.pluginId)
      .sort();
    const remoteBundle = readRemoteBundleStatus(effectiveRemoteDistDir);
    const stalePluginIds = [];
    if (remoteBundle.built) {
      const packedMap = remoteBundle.packedAddonsById || {};
      for (const id of remoteEnabledIds) {
        const packed = packedMap[id];
        const live = liveRemoteSnapshotById.get(id);
        if (!packed || !live) continue;
        const shaChanged = Boolean(
          packed.rendererSha256 && live.rendererSha256 && packed.rendererSha256 !== live.rendererSha256
        );
        const versionChanged = Boolean(packed.version && live.version && packed.version !== live.version);
        if (shaChanged || versionChanged) {
          stalePluginIds.push(id);
        }
      }
    }
    const remoteBundleNeedsRebuild =
      !remoteBundle.built ||
      !remoteBundle.hasUserscript ||
      !sameStringArray(remoteBundle.packedPluginIds, remoteEnabledIds) ||
      stalePluginIds.length > 0;
    const resolvedBuildCmd = resolveBuildRemoteCommand({
      remoteDistDir: effectiveRemoteDistDir,
      cliCommandName,
      cliEntryPath,
      hostCliMetaPath: effectiveHostCliMetaPath,
      pathEnv,
      pathExtEnv,
      platform,
    });
    const resolvedServeCmd = resolveServeRemoteCommand({
      remoteDistDir: effectiveRemoteDistDir,
      cliCommandName,
      cliEntryPath,
      hostCliMetaPath: effectiveHostCliMetaPath,
      pathEnv,
      pathExtEnv,
      platform,
    });

    return {
      ok: true,
      host: {
        version: hostVersion,
        buildSha8,
        profileId: profile.id || null,
        remoteProfileId: effectiveRemoteProfileId,
        strictTrustPolicy,
      },
      summary: {
        totalCount: addons.length,
        desktopActiveCount: addons.filter((a) => a.desktopStatus === 'active').length,
        remoteEligibleCount: addons.filter((a) => a.remoteEligible).length,
        remoteEnabledCount: remoteEnabledIds.length,
      },
      addons,
      remoteBundle: {
        ...remoteBundle,
        needsRebuild: remoteBundleNeedsRebuild,
        expectedPluginIds: remoteEnabledIds,
        stalePluginIds,
        buildCommand: resolvedBuildCmd.command,
        buildCommandSource: resolvedBuildCmd.source,
        buildCommandRunnable: resolvedBuildCmd.runnable,
        serveCommand: resolvedServeCmd.command,
        serveCommandSource: resolvedServeCmd.source,
        serveCommandRunnable: resolvedServeCmd.runnable,
      },
      remotePreferences: {
        ok: remotePrefs.ok,
        updatedAt: remotePrefs.updatedAt,
        error: remotePrefs.error,
      },
    };
  }

  function setRemoteAddonPreference(pluginId, enabled) {
    if (typeof pluginId !== 'string' || !PLUGIN_ID_RE.test(pluginId.trim())) {
      return { ok: false, reason: 'ERR_INVALID_PLUGIN_ID', state: null };
    }
    const cleanId = pluginId.trim();
    const nextEnabled = Boolean(enabled);

    const current = readRemotePreferencesFile(effectiveRemotePrefsPath);
    const nextAddons = current.ok && current.addons ? { ...current.addons } : {};
    const nowIso = new Date().toISOString();
    nextAddons[cleanId] = {
      enabled: nextEnabled,
      updatedAt: nowIso,
    };

    const writeRes = writeRemotePreferencesFileAtomic(effectiveRemotePrefsPath, {
      schemaVersion: 1,
      updatedAt: nowIso,
      addons: nextAddons,
    });
    if (!writeRes.ok) {
      recordDiag('warn', 'REMOTE_PREFS_WRITE_ERR', `${cleanId}: ${writeRes.reason}`);
      return { ok: false, reason: writeRes.reason, state: null };
    }

    return {
      ok: true,
      reason: null,
      pluginId: cleanId,
      enabled: nextEnabled,
      state: getState(),
    };
  }

  return Object.freeze({
    getState,
    setRemoteAddonPreference,
    getRemotePrefsPath: () => effectiveRemotePrefsPath,
  });
}

module.exports = {
  DEFAULT_REMOTE_PREFS_FILENAME,
  DEFAULT_HOST_CLI_META_FILENAME,
  isCommandOnPath,
  readHostCliMetaFile,
  resolveBuildRemoteCommand,
  resolveServeRemoteCommand,
  readRemotePreferencesFile,
  isAddonEnabledInRemotePreferences,
  writeRemotePreferencesFileAtomic,
  readRemoteBundleStatus,
  createHostAdminService,
};
