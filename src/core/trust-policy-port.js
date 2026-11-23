'use strict';

/**
 * Pure vendor- & runtime-neutral TrustPolicyPort contract and Default-Deny evaluator (ISP / DIP).
 *
 * ZERO Node.js fs/path/os/child_process or vendor imports (TC-001 / TC-023).
 */

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

const TRUST_POLICY_PORT_METHODS = Object.freeze([
  'loadPolicy',
  'verifyPluginTrust',
  'approvePlugin',
  'revokePlugin',
  'listApproved',
]);

function assertTrustPolicyPort(port) {
  if (!port || typeof port !== 'object') {
    throw new Error('ERR_TRUST_POLICY_PORT:INVALID_PORT');
  }
  for (const method of TRUST_POLICY_PORT_METHODS) {
    if (typeof port[method] !== 'function') {
      throw new Error(`ERR_TRUST_POLICY_PORT:MISSING_METHOD:${method}`);
    }
  }
  return port;
}

function getPrivilegedRequirements(manifest) {
  const caps = new Set(Array.isArray(manifest && manifest.capabilities) ? manifest.capabilities : []);
  const slots = Array.isArray(manifest && manifest.uiSlots) ? manifest.uiSlots : [];
  const hasMainHook = caps.has('mainHook');
  const hasDocumentTransform = slots.some((s) => s && s.slot === 'document-transform');
  const hasSettingsBridge = Boolean(
    manifest &&
      manifest.settingsBridge &&
      typeof manifest.settingsBridge === 'object' &&
      typeof manifest.settingsBridge.fileName === 'string' &&
      manifest.settingsBridge.fileName.length > 0
  );
  const required = [];
  if (hasMainHook) required.push('mainHook');
  if (hasDocumentTransform) required.push('document-transform');
  if (hasSettingsBridge) required.push('settingsBridge');
  return {
    hasMainHook,
    hasDocumentTransform,
    hasSettingsBridge,
    requiresTrustApproval: required.length > 0 || (manifest && manifest.trustLevel === 'trusted'),
    privilegedCapabilities: required,
  };
}

/**
 * Pure Default-Deny trust decision against host-owned trust-policy.json data.
 *
 * @param {object} manifest - Validated/normalized manifest
 * @param {{ rendererSha256?: string|null, mainHookBundleSha256?: string|null }} digests - Computed from single-read buffers
 * @param {{ schemaVersion?: number, approved?: Record<string, object> } | null} policy - Host trust policy
 * @param {{ strictTrustPolicy?: boolean }} opts
 */
function evaluateTrustDecision(
  manifest,
  digests = {},
  policy = null,
  { strictTrustPolicy = true, checkTarget = 'all' } = {}
) {
  const pluginId = manifest && manifest.pluginId;
  const reqs = getPrivilegedRequirements(manifest);

  if (!reqs.requiresTrustApproval) {
    return {
      ok: true,
      effectiveTrustLevel: 'restricted',
      pinned: false,
      privilegedCapabilities: [],
    };
  }

  if (!strictTrustPolicy) {
    return {
      ok: true,
      effectiveTrustLevel: manifest.trustLevel === 'restricted' ? 'restricted' : 'trusted',
      pinned: false,
      privilegedCapabilities: reqs.privilegedCapabilities,
    };
  }

  const approvedMap =
    policy && policy.approved && typeof policy.approved === 'object' && !Array.isArray(policy.approved)
      ? policy.approved
      : null;
  const record = approvedMap && Object.prototype.hasOwnProperty.call(approvedMap, pluginId) ? approvedMap[pluginId] : null;
  if (!record || typeof record !== 'object') {
    return {
      ok: false,
      reason: 'ERR_TRUST_POLICY_NOT_APPROVED',
      effectiveTrustLevel: 'restricted',
      privilegedCapabilities: reqs.privilegedCapabilities,
    };
  }

  const shouldCheckRenderer = checkTarget === 'all' || checkTarget === 'renderer';
  const shouldCheckMainHook = checkTarget === 'all' || checkTarget === 'mainHook';

  if (shouldCheckRenderer && manifest.entry && manifest.entry.rendererScript) {
    if (!record.rendererSha256 || !SHA256_HEX_RE.test(record.rendererSha256)) {
      return { ok: false, reason: 'ERR_TRUST_POLICY_MISSING_RENDERER_PIN', effectiveTrustLevel: 'restricted' };
    }
    if (!digests.rendererSha256 || digests.rendererSha256 !== record.rendererSha256) {
      return {
        ok: false,
        reason: 'ERR_TRUST_POLICY_RENDERER_SHA_MISMATCH',
        effectiveTrustLevel: 'restricted',
        expectedSha256: record.rendererSha256,
        actualSha256: digests.rendererSha256 || null,
      };
    }
  }

  if (shouldCheckMainHook && reqs.hasMainHook) {
    if (!record.mainHookBundleSha256 || !SHA256_HEX_RE.test(record.mainHookBundleSha256)) {
      return { ok: false, reason: 'ERR_TRUST_POLICY_MISSING_MAIN_HOOK_PIN', effectiveTrustLevel: 'restricted' };
    }
    if (!digests.mainHookBundleSha256 || digests.mainHookBundleSha256 !== record.mainHookBundleSha256) {
      return {
        ok: false,
        reason: 'ERR_TRUST_POLICY_MAIN_HOOK_SHA_MISMATCH',
        effectiveTrustLevel: 'restricted',
        expectedSha256: record.mainHookBundleSha256,
        actualSha256: digests.mainHookBundleSha256 || null,
      };
    }
  }

  return {
    ok: true,
    effectiveTrustLevel: 'trusted',
    pinned: true,
    privilegedCapabilities: reqs.privilegedCapabilities,
  };
}

module.exports = {
  SHA256_HEX_RE,
  TRUST_POLICY_PORT_METHODS,
  assertTrustPolicyPort,
  getPrivilegedRequirements,
  evaluateTrustDecision,
};
