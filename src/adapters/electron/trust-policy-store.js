'use strict';

/**
 * FileSystem implementation of `TrustPolicyPort` (`${HOST_DATA_DIR}/trust-policy.json`).
 *
 * - Locked, atomic writes via `fs-lock-atomic.js`.
 * - Zero writes inside `~/.gemini/config/plugins/`.
 * - Computes deterministic single-buffer renderer SHA-256 and realpath-confined
 *   mainHook directory bundle SHA-256 for explicit CLI pinning (`addon-host trust approve`).
 */

const fs = require('node:fs');
const path = require('node:path');
const { evaluateTrustDecision } = require('../../core/trust-policy-port');
const { validatePluginId } = require('../../core/manifest-validator');
const {
  acquireExclusiveLockDetailed,
  releaseExclusiveLock,
  writeAtomicSync,
} = require('../fs-lock-atomic');
const {
  sha256Hex,
  loadTrustPolicyFile,
  snapshotPluginBundleInMemory,
} = require('../../runtime/main/trust-verifier');
const { parseSafeJson } = require('../../runtime/shared/safe-json');

function resolveTrustPolicyPaths(ctx) {
  const paths = (ctx && ctx.paths) || {};
  const hostDataDir =
    paths.HOST_DATA_DIR ||
    (paths.LOADER_SCRIPT_PATH && path.dirname(paths.LOADER_SCRIPT_PATH)) ||
    (paths.ADDONS_DIR && path.dirname(paths.ADDONS_DIR));
  const trustPolicyPath = paths.TRUST_POLICY_PATH || path.join(hostDataDir, 'trust-policy.json');
  const lockPath = paths.ADDONS_LOCK_PATH || path.join(hostDataDir, 'addon-host-addons.lock');
  return { trustPolicyPath, lockPath, pluginsRootDir: paths.PLUGINS_ROOT_DIR, addonsDir: paths.ADDONS_DIR };
}

function createElectronTrustPolicyPort() {
  return Object.freeze({
    loadPolicy(ctx) {
      const { trustPolicyPath } = resolveTrustPolicyPaths(ctx);
      return loadTrustPolicyFile(trustPolicyPath);
    },

    verifyPluginTrust(ctx, manifest, digests, { strictTrustPolicy = true } = {}) {
      const { trustPolicyPath } = resolveTrustPolicyPaths(ctx);
      const loaded = loadTrustPolicyFile(trustPolicyPath);
      if (!loaded.ok) {
        return { ok: false, reason: loaded.reason, error: loaded.error };
      }
      return evaluateTrustDecision(manifest, digests, loaded.policy, { strictTrustPolicy });
    },

    approvePlugin(ctx, pluginId, manifest = null) {
      const idCheck = validatePluginId(pluginId);
      if (!idCheck.ok) {
        return { ok: false, reason: idCheck.reason };
      }
      const { trustPolicyPath, lockPath, pluginsRootDir, addonsDir } = resolveTrustPolicyPaths(ctx);
      let activeManifest = manifest;
      if (!activeManifest && addonsDir) {
        const manifestFile = path.join(addonsDir, `${pluginId}.json`);
        if (!fs.existsSync(manifestFile)) {
          return { ok: false, reason: 'ERR_MANIFEST_NOT_REGISTERED', pluginId };
        }
        try {
          activeManifest = parseSafeJson(fs.readFileSync(manifestFile, 'utf8'));
        } catch (_err) {
          return { ok: false, reason: 'ERR_MANIFEST_INVALID_JSON', pluginId };
        }
      }
      if (!activeManifest || activeManifest.pluginId !== pluginId) {
        return { ok: false, reason: 'ERR_MANIFEST_PLUGIN_ID_MISMATCH', pluginId };
      }

      const pluginRoot = path.join(pluginsRootDir, pluginId);
      if (!fs.existsSync(pluginRoot)) {
        return { ok: false, reason: 'ERR_PLUGIN_DIR_NOT_FOUND', pluginId };
      }
      let realPluginRoot;
      try {
        realPluginRoot = fs.realpathSync(pluginRoot);
      } catch (_err) {
        return { ok: false, reason: 'ERR_PLUGIN_DIR_NOT_FOUND', pluginId };
      }

      const entry = activeManifest.entry || {};
      let rendererSha256 = null;
      let mainHookBundleSha256 = null;

      if (entry.rendererScript) {
        const rendererPath = path.resolve(realPluginRoot, entry.rendererScript);
        let realRendererPath;
        try {
          realRendererPath = fs.realpathSync(rendererPath);
        } catch (_err) {
          return { ok: false, reason: 'ERR_RENDERER_SCRIPT_NOT_FOUND', pluginId };
        }
        const rel = path.relative(realPluginRoot, realRendererPath);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
          return { ok: false, reason: 'ERR_RENDERER_SYMLINK_ESCAPE', pluginId };
        }
        if (!fs.statSync(realRendererPath).isFile()) {
          return { ok: false, reason: 'ERR_RENDERER_SCRIPT_NOT_FILE', pluginId };
        }
        rendererSha256 = sha256Hex(fs.readFileSync(realRendererPath));
      }

      if (entry.mainHookScript) {
        try {
          const snap = snapshotPluginBundleInMemory(pluginRoot);
          mainHookBundleSha256 = snap.bundleSha256;
        } catch (err) {
          return {
            ok: false,
            reason: 'ERR_MAIN_HOOK_SNAPSHOT_FAILED',
            error: err && err.message ? err.message : String(err),
          };
        }
      }

      const lockRes = acquireExclusiveLockDetailed(lockPath, 30000);
      if (!lockRes.ok) {
        return { ok: false, reason: lockRes.code, error: lockRes.error };
      }
      try {
        const loaded = loadTrustPolicyFile(trustPolicyPath);
        // D-03: Never overwrite/wipe a corrupted trust-policy.json on approve/revoke!
        if (!loaded.ok) {
          return { ok: false, reason: loaded.reason, error: loaded.error };
        }
        const policy = loaded.policy || { schemaVersion: 1, approved: {} };
        const record = {
          pluginId,
          version: activeManifest.version || '0.0.0',
          rendererSha256,
          mainHookBundleSha256,
          approvedAt: new Date().toISOString(),
        };
        policy.approved[pluginId] = record;
        writeAtomicSync(trustPolicyPath, JSON.stringify(policy, null, 2) + '\n');
        return { ok: true, trustPolicyPath, record };
      } finally {
        releaseExclusiveLock(lockPath, lockRes.token);
      }
    },

    revokePlugin(ctx, pluginId) {
      const idCheck = validatePluginId(pluginId);
      if (!idCheck.ok) {
        return { ok: false, reason: idCheck.reason };
      }
      const { trustPolicyPath, lockPath } = resolveTrustPolicyPaths(ctx);
      const lockRes = acquireExclusiveLockDetailed(lockPath, 30000);
      if (!lockRes.ok) {
        return { ok: false, reason: lockRes.code, error: lockRes.error };
      }
      try {
        const loaded = loadTrustPolicyFile(trustPolicyPath);
        if (!loaded.ok) {
          return { ok: false, reason: loaded.reason, error: loaded.error };
        }
        const policy = loaded.policy || { schemaVersion: 1, approved: {} };
        const existed = Object.prototype.hasOwnProperty.call(policy.approved, pluginId);
        if (existed) {
          delete policy.approved[pluginId];
          writeAtomicSync(trustPolicyPath, JSON.stringify(policy, null, 2) + '\n');
        }
        return { ok: true, pluginId, revoked: existed };
      } finally {
        releaseExclusiveLock(lockPath, lockRes.token);
      }
    },

    listApproved(ctx) {
      const { trustPolicyPath } = resolveTrustPolicyPaths(ctx);
      const loaded = loadTrustPolicyFile(trustPolicyPath);
      return {
        ok: loaded.ok,
        missing: Boolean(loaded.missing),
        reason: loaded.reason || null,
        error: loaded.error || null,
        trustPolicyPath,
        approved: Object.values((loaded.policy && loaded.policy.approved) || {}),
      };
    },
  });
}

module.exports = {
  resolveTrustPolicyPaths,
  createElectronTrustPolicyPort,
};
