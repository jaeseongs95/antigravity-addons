'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  readStateField,
  validateUiCondition,
  evaluateUiCondition,
  validateUiTree,
} = require('../../src/core/ui-schema-validator');
const {
  utf8ByteLength,
  validateSecretKey,
  validateSecretValue,
  validateSecretsPermissions,
  normalizeSecretHeadersSpec,
  resolveSecretHeaders,
} = require('../../src/core/secrets-policy');
const { validateHostProfile, assertValidHostProfile } = require('../../src/core/host-profile-port');
const {
  assertValidUpdateSurvivalConfig,
  normalizeReconcileState,
  evaluateReconcileEligibility,
  recordReconcileOutcome,
} = require('../../src/core/update-survival-port');
const { assertFileSystemPort } = require('../../src/core/fs-port');
const { assertHostLifecyclePort, assertAddonStorePort } = require('../../src/core/host-ports');
const { assertTrustPolicyPort, evaluateTrustDecision } = require('../../src/core/trust-policy-port');
const {
  validateServiceName,
  isCallerAllowed,
  sanitizeBusPayload,
  validateServicePermissions,
} = require('../../src/core/service-bus-policy');
const { normalizeManifestToV2 } = require('../../src/core/manifest-normalizer');
const {
  normalizeLoopbackTarget,
  validateNetPermissions,
  sanitizeNetHeaders,
  evaluateNetRequest,
} = require('../../src/core/net-policy');
const {
  validatePluginId,
  compareSemver,
  resolveConfinedScriptPath,
  validateAddonManifest,
} = require('../../src/core/manifest-validator');

test('TC-CORE-01: ui-schema-validator covers all condition combinators, depth/node DoS limits, and prototype guards', () => {
  // readStateField boundary & prototype pollution
  assert.equal(readStateField(null, 'a'), undefined);
  assert.equal(readStateField({ a: 1 }, ''), undefined);
  assert.equal(readStateField({ a: { b: 2 } }, 'a.b'), 2);
  assert.equal(readStateField({ a: { b: 2 } }, 'a.missing.c'), undefined);
  assert.equal(readStateField({ a: null }, 'a.b'), undefined);
  assert.equal(readStateField({}, '__proto__.polluted'), undefined);
  assert.equal(readStateField({}, 'constructor.prototype'), undefined);

  // validateUiCondition all valid & invalid paths
  assert.equal(validateUiCondition(null).ok, true);
  assert.equal(validateUiCondition('bad').reason, 'ERR_UI_CONDITION_INVALID');
  assert.equal(validateUiCondition([]).reason, 'ERR_UI_CONDITION_INVALID');
  assert.equal(validateUiCondition({ field: '' }).reason, 'ERR_UI_CONDITION_FIELD_REQUIRED');
  assert.equal(validateUiCondition({ field: 'x' }).reason, 'ERR_UI_CONDITION_SINGLE_OPERATOR_REQUIRED');
  assert.equal(validateUiCondition({ field: 'x', eq: 1, neq: 2 }).reason, 'ERR_UI_CONDITION_SINGLE_OPERATOR_REQUIRED');
  assert.equal(validateUiCondition({ field: 'x', in: 'not-array' }).reason, 'ERR_UI_CONDITION_IN_MUST_BE_ARRAY');
  assert.equal(validateUiCondition({ field: 'x', truthy: 'yes' }).reason, 'ERR_UI_CONDITION_TRUTHY_MUST_BE_BOOLEAN');
  assert.equal(validateUiCondition({ all: [{ field: 'x', eq: 1 }] }).ok, true);
  assert.equal(validateUiCondition({ all: [{ field: '' }] }).ok, false);
  assert.equal(validateUiCondition({ any: [{ field: 'x', neq: 2 }] }).ok, true);
  assert.equal(validateUiCondition({ any: [{ field: 'x', in: 'bad' }] }).ok, false);

  let deepCond = { field: 'x', eq: 1 };
  for (let i = 0; i < 6; i += 1) deepCond = { all: [deepCond] };
  assert.equal(validateUiCondition(deepCond).reason, 'ERR_UI_CONDITION_TOO_DEEP');

  // evaluateUiCondition all branches
  assert.equal(evaluateUiCondition(undefined, {}), true);
  assert.equal(evaluateUiCondition('bad', {}), false);
  assert.equal(evaluateUiCondition(deepCond, { x: 1 }), false);
  assert.equal(evaluateUiCondition({ all: [{ field: 'a', eq: 1 }, { field: 'b', neq: 2 }] }, { a: 1, b: 3 }), true);
  assert.equal(evaluateUiCondition({ all: [{ field: 'a', eq: 1 }, { field: 'b', neq: 2 }] }, { a: 1, b: 2 }), false);
  assert.equal(evaluateUiCondition({ any: [{ field: 'a', in: ['x', 'y'] }, { field: 'b', truthy: true }] }, { a: 'z', b: 1 }), true);
  assert.equal(evaluateUiCondition({ any: [{ field: 'a', in: ['x', 'y'] }, { field: 'b', truthy: true }] }, { a: 'z', b: 0 }), false);
  assert.equal(evaluateUiCondition({ field: 'a' }, { a: 1 }), false);

  // validateUiTree all error paths & limits
  assert.equal(validateUiTree(null).reason, 'ERR_UI_TREE_INVALID');
  assert.equal(validateUiTree([]).reason, 'ERR_UI_TREE_INVALID');
  assert.equal(validateUiTree({ type: 'unknown' }).ok, false);
  assert.equal(validateUiTree({ type: 'text', id: 'bad id!' }).ok, false);
  assert.equal(
    validateUiTree({
      type: 'stack',
      children: [
        null,
        { type: 'text', id: 'dup' },
        { type: 'text', id: 'dup', visibleWhen: { field: '' }, disabledWhen: { field: 'a', truthy: 1 } },
        { type: 'select' },
        { type: 'segmented', options: 'bad' },
        { type: 'list', items: 'bad' },
        { type: 'button', children: [] },
      ],
    }).ok,
    false
  );
  assert.equal(validateUiTree({ type: 'stack', children: 'not-array' }).ok, false);

  // Max tree depth & max nodes DoS bounds
  let deepTree = { type: 'text', text: 'leaf' };
  for (let i = 0; i < 14; i += 1) deepTree = { type: 'stack', children: [deepTree] };
  assert.equal(validateUiTree(deepTree).ok, false);

  const manyChildren = [];
  for (let i = 0; i < 260; i += 1) manyChildren.push({ type: 'text', text: String(i) });
  assert.equal(validateUiTree({ type: 'stack', children: manyChildren }).ok, false);
});

test('TC-CORE-02: secrets-policy covers UTF-8 sizing, permission bounds, forbidden headers, and injection rejection', () => {
  assert.equal(utf8ByteLength('abc'), 3);
  assert.equal(utf8ByteLength('한글'), 6);
  assert.equal(utf8ByteLength('😀'), 4);

  // Manual fallback branch in utf8ByteLength when TextEncoder/Buffer absent
  const origTE = globalThis.TextEncoder;
  const origBuf = globalThis.Buffer;
  try {
    globalThis.TextEncoder = undefined;
    assert.equal(utf8ByteLength('한글'), 6);
    globalThis.Buffer = undefined;
    assert.equal(utf8ByteLength('aé한😀'), 1 + 2 + 3 + 4);
  } finally {
    globalThis.TextEncoder = origTE;
    globalThis.Buffer = origBuf;
  }

  // validateSecretKey & validateSecretValue
  assert.equal(validateSecretKey(123).reason, 'ERR_SECRETS_INVALID_KEY');
  assert.equal(validateSecretKey('__proto__').reason, 'ERR_SECRETS_INVALID_KEY');
  assert.equal(validateSecretKey('bad key!').reason, 'ERR_SECRETS_INVALID_KEY');
  assert.equal(validateSecretValue(123).reason, 'ERR_SECRETS_INVALID_VALUE');
  assert.equal(validateSecretValue('').reason, 'ERR_SECRETS_EMPTY_VALUE');
  assert.equal(validateSecretValue('abc\0def').reason, 'ERR_SECRETS_INVALID_VALUE');
  assert.equal(validateSecretValue('x'.repeat(100), { maxSingleBytes: 10 }).reason, 'ERR_SECRETS_VALUE_TOO_LARGE');

  // validateSecretsPermissions
  assert.deepEqual(validateSecretsPermissions(null), { ok: true, enabled: false, maxKeys: 0, maxBytes: 0, allowRead: false });
  assert.equal(validateSecretsPermissions([]).reason, 'ERR_INVALID_SECRETS_PERMISSIONS');
  assert.equal(validateSecretsPermissions({}, { trustLevel: 'restricted' }).reason, 'ERR_RESTRICTED_SECRETS_FORBIDDEN');
  const badPerm = validateSecretsPermissions({ maxKeys: 0, maxBytes: 512, allowRead: 'yes' }, { trustLevel: 'trusted' });
  assert.equal(badPerm.ok, false);
  assert.equal(badPerm.errors.length, 3);
  const okPerm = validateSecretsPermissions({ maxKeys: 8, maxBytes: 4096, allowRead: true }, { trustLevel: 'trusted' });
  assert.equal(okPerm.ok, true);
  assert.equal(okPerm.allowRead, true);

  // normalizeSecretHeadersSpec & resolveSecretHeaders
  assert.deepEqual(normalizeSecretHeadersSpec(null), { ok: true, entries: [] });
  assert.equal(normalizeSecretHeadersSpec('bad').reason, 'ERR_NET_INVALID_SECRET_HEADERS');
  const tooMany = {};
  for (let i = 0; i < 9; i += 1) tooMany[`X-Tok-${i}`] = 'k1';
  assert.equal(normalizeSecretHeadersSpec(tooMany).reason, 'ERR_NET_TOO_MANY_SECRET_HEADERS');
  assert.equal(normalizeSecretHeadersSpec({ Cookie: 'k1' }).ok, false);
  assert.equal(normalizeSecretHeadersSpec({ 'Sec-Fetch-Mode': 'k1' }).ok, false);
  assert.equal(normalizeSecretHeadersSpec({ 'X-Addon-Host-Token': 'k1' }).ok, false);
  assert.equal(normalizeSecretHeadersSpec({ '': 'k1' }).ok, false);
  assert.equal(normalizeSecretHeadersSpec({ 'X-Api-Key': 'k1', 'x-api-key': 'k2' }).ok, false);
  assert.equal(normalizeSecretHeadersSpec({ 'X-Api-Key': { secretKey: 'k1', prefix: 'bad\r\n' } }).reason, 'ERR_NET_INVALID_SECRET_HEADER_PREFIX');
  assert.equal(normalizeSecretHeadersSpec({ 'X-Api-Key': { secretKey: 'k1', suffix: 'bad\n' } }).reason, 'ERR_NET_INVALID_SECRET_HEADER_SUFFIX');
  assert.equal(normalizeSecretHeadersSpec({ 'X-Api-Key': 123 }).reason, 'ERR_NET_INVALID_SECRET_HEADERS');
  assert.equal(normalizeSecretHeadersSpec({ 'X-Api-Key': { secretKey: 'bad key!' } }).reason, 'ERR_SECRETS_INVALID_KEY');
  const okSpec = normalizeSecretHeadersSpec({ Authorization: { secretKey: 'k1', prefix: 'Bearer ', suffix: '!' } });
  assert.equal(okSpec.ok, true);

  assert.equal(resolveSecretHeaders(null, null).ok, true);
  assert.equal(resolveSecretHeaders({ Authorization: 'k1' }, null).reason, 'ERR_SECRETS_NOT_DECLARED');
  assert.equal(resolveSecretHeaders({ Authorization: 'k1' }, () => ({ ok: false })).reason, 'ERR_SECRET_NOT_FOUND:k1');
  assert.equal(
    resolveSecretHeaders({ Authorization: 'k1' }, () => ({ ok: true, value: 'bad\r\nval' })).reason,
    'ERR_SECRET_INVALID_HEADER_VALUE'
  );
});

test('TC-CORE-03: host-profile-port, update-survival-port, fs-port, host-ports, and trust-policy-port contracts', () => {
  const baseProfile = { id: 'p1', resolvePaths: () => ({}) };
  assert.equal(validateHostProfile(null).reason, 'INVALID_HOST_PROFILE_OBJECT');
  assert.equal(validateHostProfile({ id: '' }).reason, 'MISSING_HOST_PROFILE_FIELD:id');
  assert.equal(validateHostProfile({ id: 'p1' }).reason, 'MISSING_HOST_PROFILE_RESOLVE_PATHS');
  assert.equal(validateHostProfile({ ...baseProfile, compatibleHostProfiles: [1] }).reason, 'INVALID_HOST_PROFILE_COMPATIBLE_PROFILES');
  assert.equal(validateHostProfile({ ...baseProfile, supportedCapabilities: [] }).reason, 'INVALID_HOST_PROFILE_SUPPORTED_CAPABILITIES');
  assert.equal(validateHostProfile({ ...baseProfile, resolveConfigScopes: 'nope' }).reason, 'INVALID_HOST_PROFILE_RESOLVE_CONFIG_SCOPES');
  assert.equal(validateHostProfile({ ...baseProfile, uiSurfaces: [] }).reason, 'INVALID_HOST_PROFILE_UI_SURFACES');
  assert.equal(validateHostProfile({ ...baseProfile, uiSurfaces: { main: null } }).reason, 'INVALID_HOST_PROFILE_UI_SURFACE:main');
  assert.equal(validateHostProfile({ ...baseProfile, uiSurfaces: { main: { selectors: [''] } } }).ok, false);
  assert.equal(validateHostProfile({ ...baseProfile, uiSurfaces: { main: { priority: NaN } } }).ok, false);
  assert.equal(validateHostProfile({ ...baseProfile, uiSurfaces: { main: { safeInsets: [] } } }).ok, false);
  assert.equal(validateHostProfile({ ...baseProfile, uiSurfaces: { main: { safeInsets: { top: -1 } } } }).ok, false);
  assert.equal(validateHostProfile({ ...baseProfile, uiGridMerges: 'bad' }).reason, 'INVALID_HOST_PROFILE_UI_GRID_MERGES');
  assert.equal(validateHostProfile({ ...baseProfile, uiGridMerges: [null] }).ok, false);
  assert.equal(validateHostProfile({ ...baseProfile, uiGridMerges: [{ section: '', secondary: '.b' }] }).ok, false);
  assert.equal(validateHostProfile({ ...baseProfile, uiGridMerges: [{ section: '.a', secondary: '.b', minWidthPx: -1 }] }).ok, false);
  assert.equal(validateHostProfile({ ...baseProfile, uiGridMerges: [{ section: '.a', secondary: '.b', columns: 1 }] }).ok, false);
  assert.equal(validateHostProfile({ ...baseProfile, uiGridMerges: [{ section: '.a', secondary: '.b', gapPx: -1 }] }).ok, false);
  assert.equal(validateHostProfile({ ...baseProfile, uiGridMerges: [{ section: '.a', secondary: '.b', headerGapPx: -1 }] }).ok, false);
  assert.throws(() => assertValidHostProfile(null), /INVALID_HOST_PROFILE_OBJECT/);
  assert.equal(assertValidHostProfile(baseProfile), baseProfile);

  // update-survival-port
  assert.equal(assertValidUpdateSurvivalConfig(null), null);
  assert.throws(() => assertValidUpdateSurvivalConfig([]), /ERR_UPDATE_SURVIVAL_CONFIG_INVALID/);
  assert.throws(() => assertValidUpdateSurvivalConfig({ updaterModule: 'bad\nmod', method: 'ok' }), /ERR_UPDATE_SURVIVAL_INVALID_UPDATER_MODULE/);
  assert.throws(() => assertValidUpdateSurvivalConfig({ updaterModule: 'mod', method: '123bad' }), /ERR_UPDATE_SURVIVAL_INVALID_METHOD/);
  assert.throws(() => assertValidUpdateSurvivalConfig({ updaterModule: 'mod', method: 'ok', platforms: ['solaris'] }), /ERR_UPDATE_SURVIVAL_INVALID_PLATFORM/);
  const validSurv = assertValidUpdateSurvivalConfig({
    updaterModule: 'electron-updater',
    method: 'quitAndInstall',
    platforms: ['win32', 'win32', 'linux'],
    ackTimeoutMs: 500,
    waitTimeoutMs: 10000,
  });
  assert.deepEqual(validSurv.platforms, ['win32', 'linux']);

  const sha = 'a'.repeat(64);
  const normState = normalizeReconcileState({
    failedBySha256: {
      badsha: { count: 1 },
      [sha]: { count: 0 },
      ['b'.repeat(64)]: { count: 2, reason: 'ERR_X', appVersion: '1.0', lastAttemptAt: '2026-01-01T00:00:00Z' },
    },
    lastSuccess: { asarSha256: sha, appVersion: '1.0', at: '2026-01-01T00:00:00Z' },
    lastRunAt: '2026-01-01T00:00:00Z',
  });
  assert.equal(normState.failedBySha256['b'.repeat(64)].count, 2);
  assert.equal(normState.lastSuccess.asarSha256, sha);

  assert.equal(evaluateReconcileEligibility({ diag: null }).reason, 'DIAG_MISSING');
  assert.equal(evaluateReconcileEligibility({ diag: { asarExists: false } }).reason, 'NO_ASAR');
  assert.equal(evaluateReconcileEligibility({ diag: { asarExists: true, rolledBackAt: '2026-01-01' } }).reason, 'INTENTIONAL_ROLLBACK_PRESERVED');
  assert.equal(evaluateReconcileEligibility({ diag: { asarExists: true, hostInstalled: true, status: 'PATCHED' } }).reason, 'ALREADY_PATCHED');
  assert.equal(evaluateReconcileEligibility({ diag: { asarExists: true, hostInstalled: false, status: 'UNPATCHED' } }).reason, 'NOT_UPDATED_UNPATCHED');
  assert.equal(
    evaluateReconcileEligibility({
      diag: { asarExists: true, status: 'UPDATED_UNPATCHED', updatedUnpatched: true, asarSha256: sha },
      platform: 'darwin',
    }).reason,
    'MACOS_DETECT_ONLY'
  );
  const failedState = recordReconcileOutcome(null, { asarSha256: sha, ok: false, reason: 'ERR_PATCH_FAILED' });
  assert.equal(
    evaluateReconcileEligibility({
      diag: { asarExists: true, status: 'UPDATED_UNPATCHED', updatedUnpatched: true, asarSha256: sha },
      state: failedState,
      platform: 'win32',
    }).reason,
    'CIRCUIT_BREAKER_TRIPPED'
  );
  const clearedState = recordReconcileOutcome(failedState, { asarSha256: sha, ok: true, appVersion: '2.0' });
  assert.equal(clearedState.failedBySha256[sha], undefined);
  const transientState = recordReconcileOutcome(null, { asarSha256: sha, ok: false, reason: 'ERR_LOCK_TIMEOUT' });
  assert.equal(transientState.failedBySha256[sha], undefined);

  // Port assertions
  assert.throws(() => assertFileSystemPort(null), /ERR_FS_PORT:INVALID_PORT/);
  assert.throws(() => assertFileSystemPort({}), /ERR_FS_PORT:MISSING_METHOD/);
  const stubFs = {
    existsSync() {}, isFileSync() {}, realpathSync() {}, resolve() {},
    normalize() {}, relative() {}, isAbsolute() {}, join() {},
  };
  assert.throws(() => assertFileSystemPort(stubFs), /ERR_FS_PORT:MISSING_PROP:sep/);
  assert.throws(() => assertHostLifecyclePort(null), /ERR_HOST_LIFECYCLE_PORT:INVALID_PORT/);
  assert.throws(() => assertAddonStorePort({}), /ERR_ADDON_STORE_PORT:MISSING_METHOD/);
  assert.throws(() => assertTrustPolicyPort(null), /ERR_TRUST_POLICY_PORT:INVALID_PORT/);
  assert.throws(() => assertTrustPolicyPort({}), /ERR_TRUST_POLICY_PORT:MISSING_METHOD/);

  // TrustPolicy evaluator edge paths
  const trustedManifest = {
    pluginId: 'p1',
    trustLevel: 'trusted',
    capabilities: ['renderer', 'mainHook'],
    entry: { rendererScript: 'r.js', mainHookScript: 'm.js' },
  };
  assert.equal(evaluateTrustDecision(trustedManifest, {}, null, { strictTrustPolicy: false }).effectiveTrustLevel, 'trusted');
  assert.equal(
    evaluateTrustDecision(trustedManifest, { rendererSha256: sha }, { approved: { p1: {} } }, { checkTarget: 'renderer' }).reason,
    'ERR_TRUST_POLICY_MISSING_RENDERER_PIN'
  );
  assert.equal(
    evaluateTrustDecision(trustedManifest, { mainHookBundleSha256: sha }, { approved: { p1: { rendererSha256: sha } } }, { checkTarget: 'mainHook' }).reason,
    'ERR_TRUST_POLICY_MISSING_MAIN_HOOK_PIN'
  );
});

test('TC-CORE-04: service-bus-policy, manifest-normalizer, net-policy, and manifest-validator edge/security paths', () => {
  // service-bus-policy
  assert.equal(validateServiceName('', 'a.b').reason, 'ERR_INVALID_PLUGIN_ID');
  assert.equal(validateServiceName('p1', 'BAD').reason, 'ERR_INVALID_SERVICE_NAME');
  assert.equal(validateServiceName('p1', 'other.svc').reason, 'ERR_SERVICE_NAMESPACE_MISMATCH');
  assert.equal(validateServiceName('p1', 'host.statusbar', { allowWellKnownHostServices: true }).isWellKnownHostService, true);
  assert.equal(isCallerAllowed('p1', '', ['*']), false);
  assert.equal(isCallerAllowed('p1', 'p1', []), true);
  assert.equal(isCallerAllowed('p1', 'p2', null), false);
  assert.equal(isCallerAllowed('p1', 'p2', ['*']), true);
  assert.equal(isCallerAllowed('p1', 'p2', ['p3']), false);

  assert.equal(sanitizeBusPayload(Infinity), null);
  assert.throws(() => sanitizeBusPayload(() => {}), /ERR_BUS_PAYLOAD_NON_SERIALIZABLE/);
  assert.throws(() => sanitizeBusPayload(Symbol('s')), /ERR_BUS_PAYLOAD_NON_SERIALIZABLE/);
  const circ = {};
  circ.self = circ;
  assert.throws(() => sanitizeBusPayload(circ), /ERR_BUS_PAYLOAD_CIRCULAR/);
  assert.throws(() => sanitizeBusPayload({ nodeType: 1, nodeName: 'DIV' }), /ERR_BUS_PAYLOAD_DOM_NODE_FORBIDDEN/);
  let deepObj = { v: 1 };
  for (let i = 0; i < 14; i += 1) deepObj = { next: deepObj };
  assert.throws(() => sanitizeBusPayload(deepObj), /ERR_BUS_PAYLOAD_TOO_DEEP/);
  const dt = new Date('2026-01-01T00:00:00Z');
  const cloned = sanitizeBusPayload({ d: dt, arr: [1, undefined], ok: 'yes' });
  assert.equal(cloned.d.toISOString(), dt.toISOString());

  assert.deepEqual(validateServicePermissions('p1', null), { ok: true, provide: [], consume: [] });
  assert.equal(validateServicePermissions('p1', []).reason, 'ERR_INVALID_SERVICE_PERMISSIONS');
  const badSvc = validateServicePermissions('p1', {
    provide: [null, { name: 'p1.s1' }, { name: 'p1.s1' }],
    consume: ['BAD_NAME'],
  });
  assert.equal(badSvc.ok, false);
  assert.equal(badSvc.errors.length, 3);

  // manifest-normalizer
  assert.throws(() => normalizeManifestToV2(null), /ERR_INVALID_MANIFEST_FOR_NORMALIZATION/);
  const normV3 = normalizeManifestToV2({
    schemaVersion: 3,
    pluginId: 'p1',
    permissions: { dom: { documentTransform: true, anchors: ['.x'] }, net: { httpsHosts: ['API.EXAMPLE.COM'], userApprovedHttps: true } },
    integrity: { rendererSha256: 'a'.repeat(64) },
  });
  assert.equal(normV3.permissions.dom.documentTransform, true);
  assert.equal(normV3.integrity.rendererSha256, 'a'.repeat(64));

  // net-policy
  assert.equal(normalizeLoopbackTarget(80), null);
  assert.deepEqual(normalizeLoopbackTarget(8080), { kind: 'port', port: 8080 });
  assert.deepEqual(normalizeLoopbackTarget('local-daemon'), { kind: 'named', name: 'local-daemon' });
  assert.equal(validateNetPermissions(null).ok, true);
  assert.equal(validateNetPermissions([]).reason, 'ERR_INVALID_NET_PERMISSIONS');
  assert.equal(validateNetPermissions({ httpsHosts: 'bad', userApprovedHttps: 'yes', localLoopback: 'bad' }).ok, false);
  assert.equal(validateNetPermissions({ localLoopback: [8080] }, { trustLevel: 'restricted' }).reason, 'ERR_RESTRICTED_LOCAL_LOOPBACK_FORBIDDEN');
  assert.equal(validateNetPermissions({ localLoopback: [80] }, { trustLevel: 'trusted' }).ok, false);
  assert.deepEqual(
    sanitizeNetHeaders([
      ['X-Custom', 'ok'],
      ['Cookie', 'secret'],
      ['X-Bad', 'val\r\ninject'],
      ['Bad Name!', 'x'],
      'not-pair',
    ]),
    { 'X-Custom': 'ok' }
  );
  assert.equal(evaluateNetRequest('').reason, 'ERR_NET_INVALID_URL');
  assert.equal(evaluateNetRequest('not a url').reason, 'ERR_NET_INVALID_URL');
  assert.equal(evaluateNetRequest('https://user:pass@api.example.com').reason, 'ERR_NET_CREDENTIALS_IN_URL_FORBIDDEN');
  assert.equal(evaluateNetRequest('https://api.example.com', { method: 'TRACE' }).reason, 'ERR_NET_METHOD_FORBIDDEN:TRACE');
  assert.equal(evaluateNetRequest('ftp://127.0.0.1:8080', {}, { allowLoopback: true }).reason, 'ERR_NET_SCHEME_FORBIDDEN');
  assert.equal(evaluateNetRequest('http://127.0.0.1:80', {}, { allowLoopback: true }).reason, 'ERR_NET_LOOPBACK_PORT_FORBIDDEN');
  assert.equal(evaluateNetRequest('http://api.example.com').reason, 'ERR_NET_HTTPS_REQUIRED');
  assert.equal(evaluateNetRequest('https://api.example.com:8443').reason, 'ERR_NET_NON_STANDARD_HTTPS_PORT_FORBIDDEN');
  assert.equal(evaluateNetRequest('https://foo.local', {}, { httpsHosts: ['foo.local'] }).reason, 'ERR_NET_HOST_FORBIDDEN:foo.local');
  assert.equal(evaluateNetRequest('https://api.example.com', {}, { httpsHosts: ['other.example.com'] }).reason, 'ERR_NET_HOST_NOT_ALLOWED:api.example.com');

  // manifest-validator edge branches
  assert.equal(validatePluginId('').ok, false);
  assert.equal(compareSemver('1.2.3', '1.2.4'), -1);
  assert.equal(compareSemver('2.0.0', '1.9.9'), 1);
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
  assert.equal(resolveConfinedScriptPath('', '/tmp/p', { checkExists: false }).reason, 'EMPTY_ENTRY_SCRIPT');
  assert.equal(resolveConfinedScriptPath('dist/a.js', '/tmp/p', { checkExists: true }).reason, 'ERR_FS_PORT_REQUIRED');
  assert.equal(resolveConfinedScriptPath('../escape.js', '/tmp/p', { checkExists: false }).reason, 'ERR_ENTRY_ESCAPES_PLUGIN_DIR');
  assert.equal(validateAddonManifest(null).ok, false);
});
