'use strict';

/**
 * Vendor- and runtime-neutral Update Survival Port & Eligibility State Machine (SOLID #0).
 *
 * Enforces:
 * - Auto-repatch ONLY when `status === 'UPDATED_UNPATCHED'` and `rolledBackAt == null`
 *   (never overrides an intentional `--rollback`).
 * - Per-`asarSha256` circuit breaker (max 1 persistent failure per target build hash).
 * - macOS (`darwin`) detect-only guardrail until code-signing/updater verification passes.
 */

const DEFAULT_CIRCUIT_BREAKER_MAX_FAILURES = 1;
const DEFAULT_ACK_TIMEOUT_MS = 250;
const DEFAULT_WAIT_TIMEOUT_MS = 45000;

const ALLOWED_PLATFORMS = Object.freeze(['win32', 'darwin', 'linux']);
const TRANSIENT_LOCK_REASONS = new Set([
  'ERR_TARGET_LOCKED_APP_RUNNING',
  'ERR_LOCK_TIMEOUT',
  'ERR_LOCK_FAILED',
]);

function assertValidUpdateSurvivalConfig(cfg) {
  if (cfg === null || cfg === undefined) return null;
  if (typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new Error('ERR_UPDATE_SURVIVAL_CONFIG_INVALID');
  }
  const updaterModule = typeof cfg.updaterModule === 'string' ? cfg.updaterModule.trim() : '';
  const method = typeof cfg.method === 'string' ? cfg.method.trim() : '';
  if (!updaterModule || /[\r\n\0]/.test(updaterModule)) {
    throw new Error('ERR_UPDATE_SURVIVAL_INVALID_UPDATER_MODULE');
  }
  if (!method || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(method)) {
    throw new Error('ERR_UPDATE_SURVIVAL_INVALID_METHOD');
  }
  const rawPlatforms = Array.isArray(cfg.platforms) ? cfg.platforms : ['win32'];
  const platforms = [];
  for (let i = 0; i < rawPlatforms.length; i += 1) {
    const p = String(rawPlatforms[i] || '').trim();
    if (!ALLOWED_PLATFORMS.includes(p)) {
      throw new Error(`ERR_UPDATE_SURVIVAL_INVALID_PLATFORM:${p}`);
    }
    if (!platforms.includes(p)) platforms.push(p);
  }
  const ackTimeoutMs =
    Number.isInteger(cfg.ackTimeoutMs) && cfg.ackTimeoutMs >= 20 && cfg.ackTimeoutMs <= 5000
      ? cfg.ackTimeoutMs
      : DEFAULT_ACK_TIMEOUT_MS;
  const waitTimeoutMs =
    Number.isInteger(cfg.waitTimeoutMs) && cfg.waitTimeoutMs >= 1000 && cfg.waitTimeoutMs <= 180000
      ? cfg.waitTimeoutMs
      : DEFAULT_WAIT_TIMEOUT_MS;

  return Object.freeze({
    updaterModule,
    method,
    platforms: Object.freeze(platforms),
    ackTimeoutMs,
    waitTimeoutMs,
  });
}

function normalizeReconcileState(raw) {
  const base = {
    schemaVersion: 1,
    failedBySha256: {},
    lastSuccess: null,
    lastRunAt: null,
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return base;
  }
  if (raw.failedBySha256 && typeof raw.failedBySha256 === 'object' && !Array.isArray(raw.failedBySha256)) {
    for (const [sha, entry] of Object.entries(raw.failedBySha256)) {
      if (!/^[a-f0-9]{64}$/i.test(sha)) continue;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const count = Number.isInteger(entry.count) && entry.count > 0 ? entry.count : 0;
      if (count <= 0) continue;
      base.failedBySha256[sha.toLowerCase()] = {
        count,
        reason: typeof entry.reason === 'string' ? entry.reason : 'UNKNOWN',
        appVersion: typeof entry.appVersion === 'string' ? entry.appVersion : null,
        lastAttemptAt: typeof entry.lastAttemptAt === 'string' ? entry.lastAttemptAt : null,
      };
    }
  }
  if (raw.lastSuccess && typeof raw.lastSuccess === 'object' && !Array.isArray(raw.lastSuccess)) {
    base.lastSuccess = {
      asarSha256: typeof raw.lastSuccess.asarSha256 === 'string' ? raw.lastSuccess.asarSha256 : null,
      appVersion: typeof raw.lastSuccess.appVersion === 'string' ? raw.lastSuccess.appVersion : null,
      at: typeof raw.lastSuccess.at === 'string' ? raw.lastSuccess.at : null,
    };
  }
  if (typeof raw.lastRunAt === 'string') {
    base.lastRunAt = raw.lastRunAt;
  }
  return base;
}

function evaluateReconcileEligibility({
  diag,
  state,
  platform = process.platform,
  forceMacAutoRepatch = false,
  maxFailuresPerSha = DEFAULT_CIRCUIT_BREAKER_MAX_FAILURES,
} = {}) {
  const normalized = normalizeReconcileState(state);
  const hostDiag = diag && diag.host ? diag.host : diag;

  if (!hostDiag || typeof hostDiag !== 'object') {
    return { eligible: false, reason: 'DIAG_MISSING', asarSha256: null };
  }
  if (!hostDiag.asarExists) {
    return { eligible: false, reason: 'NO_ASAR', asarSha256: null };
  }
  const asarSha256 =
    typeof hostDiag.asarSha256 === 'string' && hostDiag.asarSha256
      ? hostDiag.asarSha256.toLowerCase()
      : null;

  if (hostDiag.rolledBackAt) {
    return {
      eligible: false,
      reason: 'INTENTIONAL_ROLLBACK_PRESERVED',
      asarSha256,
      rolledBackAt: hostDiag.rolledBackAt,
    };
  }

  if (hostDiag.status !== 'UPDATED_UNPATCHED' || !hostDiag.updatedUnpatched) {
    return {
      eligible: false,
      reason: hostDiag.hostInstalled ? 'ALREADY_PATCHED' : 'NOT_UPDATED_UNPATCHED',
      status: hostDiag.status || null,
      asarSha256,
    };
  }

  if (platform === 'darwin' && !forceMacAutoRepatch) {
    return {
      eligible: false,
      reason: 'MACOS_DETECT_ONLY',
      asarSha256,
      appVersion: hostDiag.appVersion || null,
    };
  }

  const limit = Number.isInteger(maxFailuresPerSha) && maxFailuresPerSha >= 1
    ? maxFailuresPerSha
    : DEFAULT_CIRCUIT_BREAKER_MAX_FAILURES;

  if (asarSha256 && normalized.failedBySha256[asarSha256] && normalized.failedBySha256[asarSha256].count >= limit) {
    return {
      eligible: false,
      reason: 'CIRCUIT_BREAKER_TRIPPED',
      asarSha256,
      priorFailure: normalized.failedBySha256[asarSha256],
    };
  }

  return {
    eligible: true,
    reason: 'ELIGIBLE_UPDATED_UNPATCHED',
    asarSha256,
    appVersion: hostDiag.appVersion || null,
  };
}

function recordReconcileOutcome(
  state,
  { asarSha256 = null, ok = false, reason = null, appVersion = null, nowIso = new Date().toISOString() } = {}
) {
  const next = normalizeReconcileState(state);
  next.lastRunAt = nowIso;
  const sha = typeof asarSha256 === 'string' && /^[a-f0-9]{64}$/i.test(asarSha256) ? asarSha256.toLowerCase() : null;

  if (ok) {
    if (sha && next.failedBySha256[sha]) {
      delete next.failedBySha256[sha];
    }
    next.lastSuccess = {
      asarSha256: sha,
      appVersion: appVersion || null,
      at: nowIso,
    };
    return next;
  }

  const errCode = typeof reason === 'string' && reason ? reason : 'ERR_RECONCILE_FAILED';
  // Transient Windows file locks do not permanently trip the per-SHA256 anchor circuit breaker.
  if (sha && !TRANSIENT_LOCK_REASONS.has(errCode)) {
    const prev = next.failedBySha256[sha];
    next.failedBySha256[sha] = {
      count: prev ? prev.count + 1 : 1,
      reason: errCode,
      appVersion: appVersion || null,
      lastAttemptAt: nowIso,
    };
  }
  return next;
}

module.exports = {
  DEFAULT_CIRCUIT_BREAKER_MAX_FAILURES,
  DEFAULT_ACK_TIMEOUT_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  ALLOWED_PLATFORMS,
  TRANSIENT_LOCK_REASONS,
  assertValidUpdateSurvivalConfig,
  normalizeReconcileState,
  evaluateReconcileEligibility,
  recordReconcileOutcome,
};
