'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { validateAddonManifest } = require('../../src/core/manifest-validator');
const {
  isPublicFqdnHost,
  isPrivateOrReservedIp,
  validateNetPermissions,
  sanitizeNetHeaders,
  evaluateNetRequest,
} = require('../../src/core/net-policy');
const {
  ALLOWED_UI_NODE_TYPES,
  validateUiTree,
  evaluateUiCondition,
} = require('../../src/core/ui-schema-validator');
const {
  validateServiceName,
  isCallerAllowed,
  sanitizeBusPayload,
} = require('../../src/core/service-bus-policy');
const { scanSolidZero } = require('../../scripts/check-solid-zero');
const { buildHostLoaderScriptSource } = require('../../src/adapters/electron/host-loader-builder');
const { ANTIGRAVITY_HOST_PROFILE } = require('../../src/profiles/antigravity');

test('TC-V30-01: AddonManifest.v3 validates permissions and enforces default-deny restricted boundaries', () => {
  const validRestricted = {
    schemaVersion: 3,
    apiVersion: 3,
    pluginId: 'sample-v3',
    displayName: 'Sample V3',
    version: '1.0.0',
    trustLevel: 'restricted',
    capabilities: ['renderer'],
    entry: { rendererScript: 'index.js' },
    permissions: {
      ui: { toasts: true, overlays: true, statusItems: true, settingsPages: true },
      storage: { maxBytes: 32768 },
      services: {
        provide: [{ name: 'sample-v3.api', allowedCallers: ['peer-a'] }],
        consume: ['host.statusbar'],
      },
      net: {
        httpsHosts: ['api.example.com'],
      },
    },
  };
  const okRes = validateAddonManifest(validRestricted, {
    strictTrustPolicy: true,
    forbiddenNetHosts: ['antigravity.google.com', 'accounts.google.com'],
  });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.sourceSchemaVersion, 3);
  assert.equal(okRes.trustLevel, 'restricted');
  assert.equal(okRes.requiresTrustApproval, false);

  // Restricted plugin cannot declare localLoopback
  const badLoopback = {
    ...validRestricted,
    permissions: { net: { localLoopback: [11434] } },
  };
  const rLoop = validateAddonManifest(badLoopback, { strictTrustPolicy: true });
  assert.equal(rLoop.ok, false);
  assert.equal(rLoop.reason, 'ERR_RESTRICTED_LOCAL_LOOPBACK_FORBIDDEN');

  // Trusted plugin with localLoopback + named target passes static check with requiresTrustApproval=true
  const trustedLoopback = {
    ...badLoopback,
    trustLevel: 'trusted',
    permissions: { net: { httpsHosts: ['translate.googleapis.com'], localLoopback: [11434, 'antigravity-sidecar'] } },
  };
  const okTrusted = validateAddonManifest(trustedLoopback, { strictTrustPolicy: true });
  assert.equal(okTrusted.ok, true);
  assert.equal(okTrusted.requiresTrustApproval, true);
  assert.ok(okTrusted.privilegedCapabilities.includes('net.localLoopback'));

  // Forbidden auth origin rejected in httpsHosts
  const badAuthHost = {
    ...validRestricted,
    permissions: { net: { httpsHosts: ['sub.accounts.google.com'] } },
  };
  const rAuth = validateAddonManifest(badAuthHost, {
    strictTrustPolicy: true,
    forbiddenNetHosts: ['accounts.google.com'],
  });
  assert.equal(rAuth.ok, false);
  assert.equal(rAuth.reason, 'ERR_INVALID_NET_PERMISSIONS');

  // Service namespace mismatch rejected
  const badSvc = {
    ...validRestricted,
    permissions: { services: { provide: [{ name: 'other-plugin.hack' }] } },
  };
  const rSvc = validateAddonManifest(badSvc, { strictTrustPolicy: true });
  assert.equal(rSvc.ok, false);
  assert.equal(rSvc.reason, 'ERR_INVALID_SERVICE_PERMISSIONS');
});

test('TC-V30-02: net-policy blocks SSRF, RFC1918, IMDS, IPv4-mapped IPv6, forbidden headers, and Remote Web loopback', () => {
  assert.equal(isPublicFqdnHost('api.github.com'), true);
  assert.equal(isPublicFqdnHost('localhost'), false);
  assert.equal(isPublicFqdnHost('127.0.0.1'), false);
  assert.equal(isPublicFqdnHost('*.github.com'), false);
  assert.equal(isPublicFqdnHost('printer.local'), false);
  assert.equal(isPublicFqdnHost('corp.internal'), false);
  assert.equal(isPublicFqdnHost('a'.repeat(250) + '.com'), false);

  // Private / reserved IP classification
  for (const blocked of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.5',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:7f00:1',
    'not-an-ip',
  ]) {
    assert.equal(isPrivateOrReservedIp(blocked), true, `Expected ${blocked} to be blocked`);
  }
  assert.equal(isPrivateOrReservedIp('93.184.216.34'), false);
  assert.equal(isPrivateOrReservedIp('2606:2800:220:1:248:1893:25c8:1946'), false);

  // Header sanitization strips Cookie, Host, Origin, Referer, sec-fetch-*
  const cleanHeaders = sanitizeNetHeaders({
    Accept: 'application/json',
    Cookie: 'sid=secret',
    Host: 'evil.com',
    Origin: 'https://antigravity.google.com',
    Referer: 'https://antigravity.google.com/chat',
    'Sec-Fetch-Site': 'same-origin',
    'X-Custom': 'ok',
  });
  assert.deepEqual(cleanHeaders, { Accept: 'application/json', 'X-Custom': 'ok' });

  // Dual-key evaluation: localhost normalizes to 127.0.0.1 with 0 redirects on Desktop
  const loopPlan = evaluateNetRequest(
    'http://localhost:11434/api/tags',
    { method: 'GET' },
    { localLoopback: [11434], allowLoopback: true }
  );
  assert.equal(loopPlan.ok, true);
  assert.equal(loopPlan.channel, 'localLoopback');
  assert.equal(loopPlan.hostname, '127.0.0.1');
  assert.equal(loopPlan.maxRedirects, 0);

  // Named loopback target resolved from profile
  const namedPlan = evaluateNetRequest(
    'http://127.0.0.1:18910/health',
    { method: 'GET' },
    { localLoopback: ['antigravity-sidecar'], namedLoopbackPorts: { 'antigravity-sidecar': 18910 }, allowLoopback: true }
  );
  assert.equal(namedPlan.ok, true);
  assert.equal(namedPlan.port, 18910);

  // Remote Web strictly rejects loopback
  const remoteLoop = evaluateNetRequest(
    'http://127.0.0.1:11434/api/tags',
    { method: 'GET' },
    { localLoopback: [11434], allowLoopback: false }
  );
  assert.equal(remoteLoop.ok, false);
  assert.equal(remoteLoop.reason, 'ERR_NET_LOOPBACK_NOT_SUPPORTED');

  // validateNetPermissions sanity
  const vp = validateNetPermissions({ httpsHosts: ['api.openai.com'] }, { trustLevel: 'restricted' });
  assert.equal(vp.ok, true);
});

test('TC-V30-03: ui-schema-validator & service-bus-policy enforce closed primitives, static predicates, default-deny ACL, and proto stripping', () => {
  assert.equal(ALLOWED_UI_NODE_TYPES.length, 17);

  const validTree = {
    type: 'stack',
    id: 'root',
    children: [
      { type: 'select', id: 'engine', field: 'engine', options: ['google', 'local'] },
      {
        type: 'input',
        id: 'endpoint',
        field: 'endpoint',
        visibleWhen: { field: 'engine', eq: 'local' },
      },
    ],
  };
  assert.equal(validateUiTree(validTree).ok, true);
  assert.equal(evaluateUiCondition({ field: 'engine', eq: 'local' }, { engine: 'local' }), true);
  assert.equal(evaluateUiCondition({ field: 'engine', eq: 'local' }, { engine: 'google' }), false);
  assert.equal(evaluateUiCondition({ field: 'engine', in: ['google', 'deepl'] }, { engine: 'google' }), true);
  assert.equal(evaluateUiCondition({ field: 'enabled', truthy: true }, { enabled: 1 }), true);

  // Unknown HTML/script primitive rejected
  assert.equal(validateUiTree({ type: 'script', text: 'alert(1)' }).ok, false);

  // Service bus policy
  assert.equal(validateServiceName('alpha', 'alpha.translate').ok, true);
  assert.equal(validateServiceName('alpha', 'beta.translate').ok, false);
  assert.equal(validateServiceName('statusbar', 'host.statusbar', { allowWellKnownHostServices: true }).ok, true);

  // Default-deny allowedCallers
  assert.equal(isCallerAllowed('alpha', 'alpha', []), true);
  assert.equal(isCallerAllowed('alpha', 'beta', []), false);
  assert.equal(isCallerAllowed('alpha', 'beta', ['beta']), true);
  assert.equal(isCallerAllowed('alpha', 'gamma', ['*']), true);

  // Proto key stripping & function rejection
  const dirty = JSON.parse('{"ok":true,"__proto__":{"polluted":1},"nested":{"constructor":"bad","safe":42}}');
  const clean = sanitizeBusPayload(dirty);
  assert.equal(clean.ok, true);
  assert.equal(clean.nested.safe, 42);
  assert.equal(Object.prototype.hasOwnProperty.call(clean, '__proto__'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(clean.nested, 'constructor'), false);
  assert.throws(() => sanitizeBusPayload({ fn: () => {} }), /ERR_BUS_PAYLOAD_NON_SERIALIZABLE/);
});

test('TC-V30-04: SOLID #0 zero-vendor-literal CI gate passes & thin shim stays strictly < 4096 B', () => {
  const solid = scanSolidZero();
  assert.equal(solid.ok, true, `SOLID #0 violations: ${JSON.stringify(solid.violations)}`);
  assert.ok(solid.checkedFiles >= 20);

  const winPaths = ANTIGRAVITY_HOST_PROFILE.resolvePaths({
    USERPROFILE: path.join('C:', 'Users', 'ExampleUser'),
    LOCALAPPDATA: path.join('C:', 'Users', 'ExampleUser', 'AppData', 'Local'),
  });
  const shim = buildHostLoaderScriptSource(winPaths, ANTIGRAVITY_HOST_PROFILE, {
    hostVersion: '3.0.0',
    buildSha8: '12345678',
    runtimeEntryDir: path.join(winPaths.RUNTIME_DIR, '12345678'),
  });
  const bytes = Buffer.byteLength(shim, 'utf8');
  assert.ok(bytes < 4096, `Thin shim must stay < 4096 bytes (got ${bytes})`);

  // Linux-style slash paths (e.g. Ubuntu CI) must also trigger _B dedup and stay < 4096 B
  const linuxStylePaths = {
    ADDONS_DIR: 'C:/Users/ExampleUser/.gemini/antigravity/addons.d',
    PLUGINS_ROOT_DIR: 'C:/Users/ExampleUser/.gemini/config/plugins',
    CONFIG_JSON_PATH: 'C:/Users/ExampleUser/.gemini/config/config.json',
    TRUST_POLICY_PATH: 'C:/Users/ExampleUser/.gemini/antigravity/trust-policy.json',
    HOST_DATA_DIR: 'C:/Users/ExampleUser/.gemini/antigravity',
    LOADER_SCRIPT_PATH: 'C:/Users/ExampleUser/.gemini/antigravity/addon-host-loader.js',
  };
  const linuxShim = buildHostLoaderScriptSource(linuxStylePaths, ANTIGRAVITY_HOST_PROFILE, {
    hostVersion: '3.0.0',
    buildSha8: '12345678',
    runtimeEntryDir: 'C:/Users/ExampleUser/.gemini/antigravity/runtime/12345678',
  });
  assert.ok(Buffer.byteLength(linuxShim, 'utf8') < 4096, `Linux-style thin shim exceeded 4096B: ${Buffer.byteLength(linuxShim, 'utf8')}`);

  // BLK-03: Token-aware dedup must NEVER corrupt object keys matching deduplicated string values or prefixes
  const acorn = require('acorn');
  const collisionProfile = {
    ...ANTIGRAVITY_HOST_PROFILE,
    namedLoopbackTargets: {
      'antigravity-sidecar': 18910,
      'antigravity.google.com': 18911,
      '[data-testid="sidebar"]': 18912,
    },
    forbiddenNetHosts: [
      'antigravity.google.com',
      'accounts.google.com',
      'oauth2.googleapis.com',
      'myaccount.google.com',
      'antigravity-sidecar',
      'antigravity-sidecar',
    ],
  };
  const collisionShim = buildHostLoaderScriptSource(winPaths, collisionProfile, {
    hostVersion: '3.0.0',
    buildSha8: '12345678',
    runtimeEntryDir: path.join(winPaths.RUNTIME_DIR, '12345678'),
  });
  assert.doesNotThrow(() => acorn.parse(collisionShim, { ecmaVersion: 'latest' }), 'Deduped shim must parse cleanly');
  const sandboxMod = { exports: {} };
  const fn = new Function('require', 'module', 'exports', '__dirname', collisionShim);
  fn(
    (id) => (id === 'node:path' ? path : { initMain() {}, createHostRuntimeController() {} }),
    sandboxMod,
    sandboxMod.exports,
    path.dirname(winPaths.LOADER_SCRIPT_PATH)
  );
  assert.equal(sandboxMod.exports.HOST_CFG.profile.namedLoopbackTargets['antigravity-sidecar'], 18910);
  assert.equal(sandboxMod.exports.HOST_CFG.profile.namedLoopbackTargets['antigravity.google.com'], 18911);
  assert.equal(sandboxMod.exports.HOST_CFG.profile.namedLoopbackTargets['[data-testid="sidebar"]'], 18912);

  // BLK-01: Restricted plugin cannot declare well-known host.statusbar service in manifest
  const badHostSvc = validateAddonManifest({
    schemaVersion: 3,
    pluginId: 'evil-bar',
    displayName: 'Evil Bar',
    version: '1.0.0',
    capabilities: ['renderer'],
    entry: { rendererScript: 'index.js' },
    permissions: { services: { provide: [{ name: 'host.statusbar', allowedCallers: ['*'] }] } },
  });
  assert.equal(badHostSvc.ok, false);
  assert.equal(badHostSvc.reason, 'ERR_RESTRICTED_HOST_SERVICE_FORBIDDEN');

  const trustedHostSvc = validateAddonManifest({
    schemaVersion: 3,
    pluginId: 'good-bar',
    displayName: 'Good Bar',
    version: '1.0.0',
    trustLevel: 'trusted',
    capabilities: ['renderer'],
    entry: { rendererScript: 'index.js' },
    permissions: { services: { provide: [{ name: 'host.statusbar', allowedCallers: ['*'] }] } },
  });
  assert.equal(trustedHostSvc.ok, true);
  assert.equal(trustedHostSvc.requiresTrustApproval, true);

  // BLK-04: verifyRemoteBundleAst blocks require() traversal bypasses
  const { verifyRemoteBundleAst } = require('../../scripts/build-remote');
  assert.equal(verifyRemoteBundleAst("require('./../../../etc/passwd');").ok, false);
  assert.equal(verifyRemoteBundleAst("require('../../../../core/..');").ok, false);
  assert.equal(verifyRemoteBundleAst("require('../../core/net-policy');").ok, true);

  // NB-04: Special-use IPv6 blocks (RFC 8215, 6to4, Teredo, Discard)
  assert.equal(isPrivateOrReservedIp('64:ff9b:1::1'), true);
  assert.equal(isPrivateOrReservedIp('2002:0a00:0001::1'), true);
  assert.equal(isPrivateOrReservedIp('2001:0000:4136:e378::1'), true);
  assert.equal(isPrivateOrReservedIp('100::1'), true);
});
