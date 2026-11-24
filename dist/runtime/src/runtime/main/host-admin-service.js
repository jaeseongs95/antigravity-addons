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
const { planAddonExecution } = require('../../core/lifecycle-coordinator');
const { readVerifiedRendererScript } = require('./trust-verifier');

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const MAX_REMOTE_PREFS_BYTES = 65536;
const MAX_BOOKMARKLET_BYTES = 2 * 1024 * 1024;
const DEFAULT_REMOTE_PREFS_FILENAME = 'remote-preferences.json';

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

function readRemoteBundleStatus(remoteDistDir) {
  const empty = {
    built: false,
    distDir: remoteDistDir || null,
    buildSha8: null,
    mode: null,
    addonCount: 0,
    packedPluginIds: [],
    hasUserscript: false,
    hasBookmarklet: false,
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
    const packedPluginIds = Array.isArray(parsed.addons)
      ? parsed.addons
          .map((a) => (a && typeof a.pluginId === 'string' ? a.pluginId : null))
          .filter(Boolean)
          .sort()
      : [];
    const manifestFiles = parsed.files && typeof parsed.files === 'object' ? Object.keys(parsed.files) : [];
    const userscriptFileName = manifestFiles.find((name) => typeof name === 'string' && name.endsWith('.user.js')) || null;
    const userscriptPath = userscriptFileName ? path.join(remoteDistDir, userscriptFileName) : null;
    const bookmarkletPath = path.join(remoteDistDir, 'bookmarklet.txt');
    const hasUserscript = Boolean(userscriptPath && fs.existsSync(userscriptPath));
    let hasBookmarklet = false;
    let bookmarkletText = null;
    if (fs.existsSync(bookmarkletPath)) {
      const stat = fs.lstatSync(bookmarkletPath);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= MAX_BOOKMARKLET_BYTES) {
        hasBookmarklet = true;
        bookmarkletText = fs.readFileSync(bookmarkletPath, 'utf8').trim();
      }
    }
    return {
      built: true,
      distDir: remoteDistDir,
      buildSha8: parsed.buildSha8,
      mode: typeof parsed.mode === 'string' ? parsed.mode : null,
      addonCount: packedPluginIds.length,
      packedPluginIds,
      hasUserscript,
      hasBookmarklet,
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

function createHostAdminService({
  hostVersion = '2.5.1',
  buildSha8 = 'dev',
  profile = {},
  addonsDir = null,
  pluginsRootDir = null,
  remotePrefsPath = null,
  remoteDistDir = null,
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
      const candidateAddon = desktopActive || remoteActiveById.get(pluginId) || null;
      const rendererScript = candidateAddon && candidateAddon.resolvedEntries ? candidateAddon.resolvedEntries.rendererScript : null;
      if (trustLevel === 'trusted') {
        if (rendererScript && fs.existsSync(rendererScript)) {
          const verified = readVerifiedRendererScript(rendererScript, activeManifest, policy, {
            strictTrustPolicy,
          });
          trustApproved = verified.ok;
          if (!verified.ok) trustRejectReason = verified.reason;
        } else {
          trustApproved = Boolean(policy && policy.approved && policy.approved[pluginId]);
          if (!trustApproved) trustRejectReason = 'ERR_TRUST_POLICY_NOT_APPROVED';
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
      } else if (trustLevel === 'trusted' && trustApproved === false) {
        remoteBlockedReason = trustRejectReason || 'ERR_TRUST_POLICY_NOT_APPROVED';
      } else {
        remoteEligible = true;
      }

      const prefEnabled = isAddonEnabledInRemotePreferences(remotePrefs, pluginId);
      const remoteEnabled = remoteEligible && prefEnabled;

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
    const remoteBundleNeedsRebuild =
      !remoteBundle.built || !sameStringArray(remoteBundle.packedPluginIds, remoteEnabledIds);

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
        buildCommand: effectiveRemoteDistDir
          ? `addon-host --build-remote --out-dir "${effectiveRemoteDistDir}"`
          : 'addon-host --build-remote',
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
  readRemotePreferencesFile,
  isAddonEnabledInRemotePreferences,
  writeRemotePreferencesFileAtomic,
  readRemoteBundleStatus,
  createHostAdminService,
};
