'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const acorn = require('acorn');

const { validateHostProfile } = require('../../src/core/host-profile-port');
const { isValidHostBridgePort, wrapHostBridgePort } = require('../../src/runtime/renderer/host-bridge-port');
const { createRendererKernel } = require('../../src/runtime/renderer/kernel');
const {
  ANTIGRAVITY_REMOTE_WEB_PROFILE,
  toBrowserRemoteWebProfile,
} = require('../../src/profiles/antigravity-remote-web');
const {
  SecurityPolicyError,
  normalizeOrigin,
  isOriginAllowed,
  assertAllowedOrigin,
} = require('../../src/adapters/remote-web/origin-guard');
const {
  assertValidPolicyName,
  createScopedTrustedTypesGuard,
} = require('../../src/adapters/remote-web/trusted-types-guard');
const {
  createElementSafe,
  clearChildrenSafe,
  createShadowContainer,
} = require('../../src/adapters/remote-web/dom-guard');
const {
  redactSecrets,
  createRemoteHostBridge,
} = require('../../src/adapters/remote-web/remote-host-bridge');
const { collectRemoteWebAddons } = require('../../src/adapters/remote-web/addon-collector');
const { ACTIVE_HOST_ATTR, bootRemoteWebHost } = require('../../src/adapters/remote-web/remote-bootstrap');
const {
  EXTENSION_CONTENT_SCRIPT_FILENAME,
  normalizeMv3Version,
  buildExtensionMatchPatterns,
  buildMv3ExtensionManifest,
} = require('../../src/adapters/remote-web/extension-manifest');
const { buildRendererKernelBundleSource } = require('../../scripts/build-runtime');
const {
  REMOTE_BROWSER_MODULES,
  BOOKMARKLET_MAX_RUNNABLE_CHARS,
  buildBookmarkletText,
  verifyRemoteBundleAst,
  buildDistRemote,
} = require('../../scripts/build-remote');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function makeTmpDir(prefix = 'agy-v23-rw-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function makeMockDom(origin = 'https://antigravity.google.com') {
  const byId = new Map();
  const listeners = new Map();

  function makeEl(tag) {
    const attrs = new Map();
    const children = [];
    const el = {
      tagName: String(tag || 'DIV').toUpperCase(),
      style: {},
      textContent: '',
      parentNode: null,
      shadowRoot: null,
      get children() {
        return children;
      },
      get firstChild() {
        return children.length > 0 ? children[0] : null;
      },
      get isConnected() {
        return Boolean(this.parentNode || this === documentElement || this === body);
      },
      setAttribute(k, v) {
        const key = String(k);
        const val = String(v);
        attrs.set(key, val);
        if (key === 'id') byId.set(val, this);
      },
      getAttribute(k) {
        return attrs.has(String(k)) ? attrs.get(String(k)) : null;
      },
      removeAttribute(k) {
        attrs.delete(String(k));
      },
      appendChild(c) {
        c.parentNode = this;
        children.push(c);
        return c;
      },
      removeChild(c) {
        const idx = children.indexOf(c);
        if (idx >= 0) children.splice(idx, 1);
        c.parentNode = null;
        return c;
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        if (listeners.has(type)) listeners.get(type).delete(fn);
      },
      attachShadow({ mode }) {
        const sr = makeEl('#shadow-root');
        sr.mode = mode;
        sr.host = this;
        this.shadowRoot = sr;
        return sr;
      },
      getRootNode() {
        let cur = this;
        while (cur.parentNode) cur = cur.parentNode;
        return cur;
      },
      querySelector(sel) {
        const slotHostMatch = /^\[data-remote-addon-host-slot-host="([^"]+)"\]$/.exec(sel);
        const queue = [...children];
        while (queue.length > 0) {
          const cur = queue.shift();
          if (slotHostMatch && cur.getAttribute('data-remote-addon-host-slot-host') === slotHostMatch[1]) {
            return cur;
          }
          if (cur.children && cur.children.length) queue.push(...cur.children);
        }
        return null;
      },
    };
    return el;
  }

  const documentElement = makeEl('html');
  const head = makeEl('head');
  const body = makeEl('body');
  documentElement.appendChild(head);
  documentElement.appendChild(body);

  const doc = {
    documentElement,
    head,
    body,
    createElement: makeEl,
    getElementById(id) {
      const found = byId.get(String(id)) || null;
      return found && found.isConnected ? found : null;
    },
    querySelector(sel) {
      return documentElement.querySelector(sel);
    },
    addEventListener() {},
    removeEventListener() {},
  };

  const win = {
    location: { href: `${origin}/workspace`, origin },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (listeners.has(type)) listeners.get(type).delete(fn);
    },
  };

  return { doc, win };
}

test('TC-RW-001: src/adapters/remote-web/ has zero vendor literals, zero HTML sinks, and browser modules have zero Node imports', () => {
  const adapterDir = path.join(REPO_ROOT, 'src', 'adapters', 'remote-web');
  const allFiles = fs.readdirSync(adapterDir).filter((n) => n.endsWith('.js'));
  assert.ok(allFiles.length >= 6);

  const vendorForbidden = [/antigravity/i, /data-agy-/i, /\bAGY_/];
  for (const name of allFiles) {
    const full = path.join(adapterDir, name);
    const src = fs.readFileSync(full, 'utf8');
    for (const re of vendorForbidden) {
      assert.equal(re.test(src), false, `Vendor literal ${re} leaked into src/adapters/remote-web/${name}`);
    }
  }

  const nodeForbidden = [
    /require\(['"](?:node:)?fs['"]\)/,
    /require\(['"](?:node:)?path['"]\)/,
    /require\(['"](?:node:)?os['"]\)/,
    /require\(['"](?:node:)?crypto['"]\)/,
    /require\(['"]electron['"]\)/,
  ];
  for (const relId of REMOTE_BROWSER_MODULES) {
    const name = relId.slice(2);
    const src = fs.readFileSync(path.join(adapterDir, name), 'utf8');
    for (const re of nodeForbidden) {
      assert.equal(re.test(src), false, `Node/Electron import ${re} leaked into browser module ${name}`);
    }
    const astCheck = verifyRemoteBundleAst(src);
    assert.equal(astCheck.ok, true, `AST violation in ${name}: ${JSON.stringify(astCheck.violations)}`);
  }
});

test('TC-RW-002: ANTIGRAVITY_REMOTE_WEB_PROFILE satisfies core HostProfile contract and browser serialization', () => {
  const res = validateHostProfile(ANTIGRAVITY_REMOTE_WEB_PROFILE);
  assert.equal(res.ok, true);
  assert.equal(ANTIGRAVITY_REMOTE_WEB_PROFILE.id, 'antigravity-remote-web');
  assert.deepEqual(ANTIGRAVITY_REMOTE_WEB_PROFILE.compatibleHostProfiles, ['antigravity-desktop']);
  assert.deepEqual(ANTIGRAVITY_REMOTE_WEB_PROFILE.supportedCapabilities, ['renderer']);
  assert.deepEqual(ANTIGRAVITY_REMOTE_WEB_PROFILE.allowedOrigins, ['https://antigravity.google.com']);

  const browserProfile = toBrowserRemoteWebProfile(ANTIGRAVITY_REMOTE_WEB_PROFILE);
  const serialized = JSON.stringify(browserProfile);
  assert.equal(typeof serialized, 'string');
  assert.equal('resolvePaths' in browserProfile, false);
  assert.equal('resolveConfigScopes' in browserProfile, false);
});

test('TC-RW-003: origin-guard enforces fail-closed allowlist and rejects lookalikes, credentials, and unsafe schemes', () => {
  const policy = { allowedOrigins: ['https://antigravity.google.com'] };
  assert.equal(assertAllowedOrigin('https://antigravity.google.com/chat?x=1', policy), 'https://antigravity.google.com');

  const disallowed = [
    'http://antigravity.google.com/chat',
    'https://antigravity.google.com.evil.example/chat',
    'https://evil-antigravity.google.com/chat',
    'https://user:pass@antigravity.google.com/chat',
    'javascript:alert(1)',
    'about:blank',
    'data:text/html,<script>1</script>',
    'file:///etc/passwd',
    'http://127.0.0.1:8080/test',
  ];
  for (const url of disallowed) {
    const check = isOriginAllowed(url, policy);
    assert.equal(check.ok, false, `Expected disallowed URL to fail: ${url}`);
    assert.throws(() => assertAllowedOrigin(url, policy), SecurityPolicyError);
  }

  // Loopback HTTP allowed ONLY when explicitly opted in
  assert.equal(
    normalizeOrigin('http://127.0.0.1:4321/page', { allowLoopbackHttp: true }),
    'http://127.0.0.1:4321'
  );
  assert.equal(
    isOriginAllowed('http://127.0.0.1:4321/page', {
      allowedOrigins: ['http://127.0.0.1:4321'],
      allowLoopbackHttp: true,
    }).ok,
    true
  );
});

test('TC-RW-004: trusted-types-guard rejects forbidden policy names and refuses HTML sinks', () => {
  for (const bad of ['default', 'DEFAULT', 'dompurify', 'angular', 'goog#html', 'lit-html', '', 'Bad Name!']) {
    assert.throws(() => assertValidPolicyName(bad), SecurityPolicyError);
  }

  let createdCount = 0;
  const mockWin = {
    location: { origin: 'https://antigravity.google.com' },
    trustedTypes: {
      createPolicy(name, rules) {
        createdCount += 1;
        return { name, ...rules };
      },
    },
  };

  const g1 = createScopedTrustedTypesGuard(mockWin, { policyName: 'remote-test-policy' });
  const g2 = createScopedTrustedTypesGuard(mockWin, { policyName: 'remote-test-policy' });
  assert.equal(g1.supported, true);
  assert.equal(g1.hasPolicy, true);
  assert.equal(createdCount, 1, 'Policy must be cached per window');
  assert.equal(g2.hasPolicy, true);

  assert.equal(g1.createSafeScriptUrl('https://antigravity.google.com/app.js'), 'https://antigravity.google.com/app.js');
  assert.throws(() => g1.createSafeScriptUrl('https://evil.example/app.js'), SecurityPolicyError);
  assert.throws(() => g1.assertNoHtmlSink(), SecurityPolicyError);
});

test('TC-RW-005: dom-guard blocks dangerous tags, inline handlers, and javascript: URLs', () => {
  const { doc } = makeMockDom();
  assert.throws(() => createElementSafe(doc, 'script'), SecurityPolicyError);
  assert.throws(() => createElementSafe(doc, 'iframe'), SecurityPolicyError);
  assert.throws(() => createElementSafe(doc, 'div', { onclick: 'alert(1)' }), SecurityPolicyError);
  assert.throws(() => createElementSafe(doc, 'a', { href: 'javascript:alert(1)' }), SecurityPolicyError);

  const el = createElementSafe(doc, 'div', { 'data-ok': '1' }, 'hello');
  assert.equal(el.textContent, 'hello');
  el.appendChild(createElementSafe(doc, 'span', null, 'child'));
  clearChildrenSafe(el);
  assert.equal(el.children.length, 0);

  const shadow = createShadowContainer(doc, 'rw-test-shadow', { noTranslateAttrs: ['data-test-nt'] });
  assert.equal(shadow.hostEl.getAttribute('translate'), 'no');
  assert.equal(shadow.hostEl.getAttribute('data-addon-host-ignore'), 'true');
  assert.equal(shadow.hostEl.getAttribute('data-test-nt'), 'true');
  assert.ok(shadow.shadowRoot);
});

test('TC-RW-006: createRemoteHostBridge implements HostBridgePort cleanly with kernel.js, local persistence, redaction, and Config Bridge OCP', async () => {
  const { doc, win } = makeMockDom();
  const backing = new Map();
  const storage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
  };

  let pushed = null;
  const kernel = createRendererKernel(doc, win);
  const hostToken = 'remote-unit-test-token-1234567890';

  const bridge = createRemoteHostBridge({
    doc,
    win,
    docGenId: 3,
    profileId: 'antigravity-remote-web',
    storageNamespace: 'test-ns',
    storage,
    configScopeSnapshots: {
      'cfg-addon:scope-ro': { data: { servers: ['a'] }, rawText: '{"servers":["a"]}', sha256: 'abc' },
    },
    onSettingsSaved(pluginId, snapshot) {
      pushed = { pluginId, snapshot };
      kernel.pushPluginSettings(pluginId, snapshot, hostToken);
    },
  });

  assert.equal(isValidHostBridgePort(bridge.port), true);
  const wrapped = wrapHostBridgePort(bridge.port);
  assert.equal(wrapped.profileId, 'antigravity-remote-web');
  assert.equal(wrapped.docGenId, 3);

  const bootRes = kernel.boot({
    docGenId: 3,
    hostToken,
    hostProfileId: 'antigravity-remote-web',
    hostBridge: bridge.port,
    uiAnchors: ANTIGRAVITY_REMOTE_WEB_PROFILE.uiAnchors,
  });
  assert.equal(bootRes.ok, true);
  assert.equal(kernel.getBridgeStatus().hostProfileId, 'antigravity-remote-web');

  const pingRes = await bridge.port.ping();
  assert.equal(pingRes.ok, true);
  assert.equal(pingRes.mode, 'browser-local');

  // Portal claim updates documentElement attribute
  bridge.port.setPortalClaim('modal-1', true);
  assert.equal(doc.documentElement.getAttribute('data-remote-addon-host-portal-claims'), '1');
  bridge.port.setPortalClaim('modal-1', false);
  assert.equal(doc.documentElement.getAttribute('data-remote-addon-host-portal-claims'), null);

  // Secret redaction
  const redacted = redactSecrets('Bearer secret_tok_123 AIzaSyD12345678901234567890 ghp_abcdefghijklmnopqrstuvwx');
  assert.equal(redacted.includes('secret_tok_123'), false);
  assert.equal(redacted.includes('AIzaSyD'), false);
  assert.equal(redacted.includes('ghp_'), false);
  bridge.port.reportError('test-p', 'failed with Bearer supersecret123');
  assert.equal(bridge.getErrors()[0].detail.includes('supersecret123'), false);

  // Settings bridge save + persistence + prototype pollution block
  bridge.bindSettingsPlugin('my-addon', { maxBytes: 1024 });
  const handle = kernel.createPluginHandle(
    {
      pluginId: 'my-addon',
      version: '1.0.0',
      trustLevel: 'trusted',
      hasSettingsBridge: true,
      hasConfigBridge: true,
      configScopes: [{ scopeId: 'scope-ro', access: 'ro', maxBytes: 4096 }],
      uiSlots: [],
    },
    hostToken,
    { status: 'ok', data: { lang: 'en' }, revision: 1 }
  );
  assert.equal(handle.hostProfileId, 'antigravity-remote-web');

  let observedChange = null;
  handle.onSettingsChange((snap) => {
    observedChange = snap;
  });

  const saveRes = await handle.saveSettings({ lang: 'ko', enabled: true });
  assert.equal(saveRes.ok, true);
  assert.equal(saveRes.snapshot.data.lang, 'ko');
  assert.equal(pushed.pluginId, 'my-addon');
  assert.equal(observedChange.data.lang, 'ko');

  const restored = bridge.loadPersistedSettings('my-addon');
  assert.deepEqual(restored.data, { lang: 'ko', enabled: true });

  const protoBlocked = await bridge.port.saveSettings('my-addon', '{"__proto__":{"polluted":true}}');
  assert.equal(protoBlocked.ok, false);
  assert.equal(protoBlocked.reason, 'ERR_SETTINGS_UNSAFE_PROTO_KEY');

  const tooBig = await bridge.port.saveSettings('my-addon', JSON.stringify({ pad: 'a'.repeat(2000) }));
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.reason, 'ERR_SETTINGS_FILE_TOO_LARGE');

  const unbound = await bridge.port.saveSettings('other-addon', '{"ok":true}');
  assert.equal(unbound.ok, false);
  assert.equal(unbound.reason, 'ERR_SETTINGS_BRIDGE_NOT_BOUND');

  // Config Bridge fail-closed when offline & packed readonly support
  const roRes = await bridge.port.readConfigScope('cfg-addon', 'scope-ro');
  assert.equal(roRes.ok, true);
  assert.deepEqual(roRes.data, { servers: ['a'] });

  const offlineRes = await bridge.port.readConfigScope('my-addon', 'scope-ro');
  assert.equal(offlineRes.ok, false);
  assert.equal(offlineRes.reason, 'ERR_REMOTE_CONFIG_BRIDGE_OFFLINE');

  const writeBlocked = await bridge.port.writeConfigScope('cfg-addon', 'scope-ro', '{}');
  assert.equal(writeBlocked.ok, false);
  assert.equal(writeBlocked.reason, 'ERR_REMOTE_CONFIG_BRIDGE_READ_ONLY');
});

test('TC-RW-007: collectRemoteWebAddons auto-includes desktop v2 renderer addons, skips mainHook safely, honors opt-out and SHA-256 trust policy', () => {
  const tmpDir = makeTmpDir('agy-v23-collect-');
  try {
    const pluginsRootDir = path.join(tmpDir, 'plugins');
    const addonsDir = path.join(tmpDir, 'addons.d');
    const trustPolicyPath = path.join(tmpDir, 'trust-policy.json');
    fs.mkdirSync(addonsDir, { recursive: true });

    // 1. Existing antigravity-desktop restricted renderer addon -> auto-included
    const p1Dir = path.join(pluginsRootDir, 'desktop-statusbar');
    fs.mkdirSync(p1Dir, { recursive: true });
    fs.writeFileSync(path.join(p1Dir, 'renderer.js'), 'addonHost.registerAction("ping", { label: "Ping", run: () => "ok" });\n', 'utf8');
    fs.writeFileSync(
      path.join(addonsDir, 'desktop-statusbar.json'),
      JSON.stringify({
        schemaVersion: 2,
        pluginId: 'desktop-statusbar',
        displayName: 'Desktop Statusbar',
        version: '3.0.0',
        trustLevel: 'restricted',
        compatibility: { hostProfile: 'antigravity-desktop', minHostVersion: '2.0.0' },
        capabilities: ['renderer'],
        entry: { rendererScript: 'renderer.js' },
        isolation: { noTranslate: true, i18nSelfManaged: true },
      })
    );

    // 2. Dual-capability (renderer + mainHook) trusted & SHA-256 pinned addon -> mainHook safely skipped, renderer packed
    const p2Dir = path.join(pluginsRootDir, 'dual-trusted');
    fs.mkdirSync(p2Dir, { recursive: true });
    const p2RendererSrc = 'const snap = addonHost.getSettings(); /* dual renderer */\n';
    fs.writeFileSync(path.join(p2Dir, 'renderer.js'), p2RendererSrc, 'utf8');
    fs.writeFileSync(path.join(p2Dir, 'main-hook.js'), 'SECRET_MAIN_HOOK_MARKER_DO_NOT_PACK();\n', 'utf8');
    fs.writeFileSync(
      path.join(addonsDir, 'dual-trusted.json'),
      JSON.stringify({
        schemaVersion: 2,
        pluginId: 'dual-trusted',
        displayName: 'Dual Trusted',
        version: '1.2.0',
        trustLevel: 'trusted',
        compatibility: { hostProfile: 'antigravity-desktop', minHostVersion: '2.3.0' },
        capabilities: ['renderer', 'mainHook'],
        entry: { rendererScript: 'renderer.js', mainHookScript: 'main-hook.js' },
        isolation: { noTranslate: true, i18nSelfManaged: true },
        settingsBridge: { fileName: 'dual-settings.json', maxBytes: 4096 },
      })
    );
    fs.writeFileSync(path.join(tmpDir, 'dual-settings.json'), JSON.stringify({ mode: 'compact' }), 'utf8');

    // 3. Explicit opt-out addon -> rejected with ERR_INCOMPATIBLE_HOST_PROFILE
    const p3Dir = path.join(pluginsRootDir, 'desktop-only-optout');
    fs.mkdirSync(p3Dir, { recursive: true });
    fs.writeFileSync(path.join(p3Dir, 'renderer.js'), '/* optout */\n', 'utf8');
    fs.writeFileSync(
      path.join(addonsDir, 'desktop-only-optout.json'),
      JSON.stringify({
        schemaVersion: 2,
        pluginId: 'desktop-only-optout',
        displayName: 'OptOut',
        version: '1.0.0',
        trustLevel: 'restricted',
        compatibility: { hostProfile: 'antigravity-desktop', excludeHostProfiles: ['antigravity-remote-web'] },
        capabilities: ['renderer'],
        entry: { rendererScript: 'renderer.js' },
        isolation: { noTranslate: true, i18nSelfManaged: true },
      })
    );

    // 4. mainHook-only addon -> rejected with ERR_UNSUPPORTED_HOST_CAPABILITY
    const p4Dir = path.join(pluginsRootDir, 'main-only');
    fs.mkdirSync(p4Dir, { recursive: true });
    fs.writeFileSync(path.join(p4Dir, 'hook.js'), 'module.exports = () => {};\n', 'utf8');
    fs.writeFileSync(
      path.join(addonsDir, 'main-only.json'),
      JSON.stringify({
        schemaVersion: 2,
        pluginId: 'main-only',
        displayName: 'Main Only',
        version: '1.0.0',
        trustLevel: 'trusted',
        capabilities: ['mainHook'],
        entry: { mainHookScript: 'hook.js' },
        isolation: { noTranslate: true, i18nSelfManaged: true },
      })
    );

    // 5. Unapproved trusted addon -> rejected with ERR_TRUST_POLICY_NOT_APPROVED
    const p5Dir = path.join(pluginsRootDir, 'unapproved-trusted');
    fs.mkdirSync(p5Dir, { recursive: true });
    fs.writeFileSync(path.join(p5Dir, 'renderer.js'), '/* unapproved */\n', 'utf8');
    fs.writeFileSync(
      path.join(addonsDir, 'unapproved-trusted.json'),
      JSON.stringify({
        schemaVersion: 2,
        pluginId: 'unapproved-trusted',
        displayName: 'Unapproved',
        version: '1.0.0',
        trustLevel: 'trusted',
        capabilities: ['renderer'],
        entry: { rendererScript: 'renderer.js' },
        isolation: { noTranslate: true, i18nSelfManaged: true },
      })
    );

    fs.writeFileSync(
      trustPolicyPath,
      JSON.stringify({
        schemaVersion: 1,
        approved: {
          'dual-trusted': { rendererSha256: sha256(p2RendererSrc) },
        },
      })
    );

    const collected = collectRemoteWebAddons({
      profile: ANTIGRAVITY_REMOTE_WEB_PROFILE,
      addonsDir,
      pluginsRootDir,
      configJsonPath: null,
      trustPolicyPath,
      settingsDataDir: tmpDir,
      hostVersion: '2.3.0',
      includeSettingsSnapshots: true,
    });

    assert.equal(collected.ok, true);
    const packedIds = collected.addons.map((a) => a.pluginMeta.pluginId).sort();
    assert.deepEqual(packedIds, ['desktop-statusbar', 'dual-trusted']);
    assert.deepEqual(collected.skippedMainHookPlugins, ['dual-trusted']);

    const dual = collected.addons.find((a) => a.pluginMeta.pluginId === 'dual-trusted');
    assert.deepEqual(dual.pluginMeta.skippedCapabilities, ['mainHook']);
    assert.equal(dual.rendererSource.includes('SECRET_MAIN_HOOK_MARKER'), false);
    assert.deepEqual(dual.initialSettingsSnapshot.data, { mode: 'compact' });

    const serializedMeta = JSON.stringify(collected.addons.map((a) => a.pluginMeta));
    assert.equal(serializedMeta.includes(tmpDir), false, 'Local machine paths must not leak into packed metadata');

    const reasonsById = new Map(collected.rejected.map((r) => [r.pluginId, r.reason]));
    assert.equal(reasonsById.get('desktop-only-optout'), 'ERR_INCOMPATIBLE_HOST_PROFILE');
    assert.equal(reasonsById.get('main-only'), 'ERR_UNSUPPORTED_HOST_CAPABILITY');
    assert.equal(reasonsById.get('unapproved-trusted'), 'ERR_TRUST_POLICY_NOT_APPROVED');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-RW-008: bootRemoteWebHost aborts fail-closed on disallowed origin and runs packed addons cleanly on allowed origin', async () => {
  // Disallowed origin -> 0 DOM mounts
  const blockedDom = makeMockDom('https://evil.example');
  const blockedKernel = createRendererKernel(blockedDom.doc, blockedDom.win);
  let ranOnBlocked = false;
  const blockedRes = await bootRemoteWebHost({
    doc: blockedDom.doc,
    win: blockedDom.win,
    profile: ANTIGRAVITY_REMOTE_WEB_PROFILE,
    kernel: blockedKernel,
    packedAddons: [
      {
        pluginMeta: { pluginId: 'should-not-run', version: '1.0.0', trustLevel: 'restricted', uiSlots: [] },
        run() {
          ranOnBlocked = true;
        },
      },
    ],
  });
  assert.equal(blockedRes.ok, false);
  assert.equal(blockedRes.reason, 'ERR_ORIGIN_NOT_ALLOWED');
  assert.equal(ranOnBlocked, false);
  assert.equal(blockedDom.doc.body.children.length, 0);

  // Allowed origin -> boots kernel, mounts drawer + fallback dock, runs addon
  const okDom = makeMockDom('https://antigravity.google.com');
  const okKernel = createRendererKernel(okDom.doc, okDom.win);
  let capturedProfileId = null;
  const okRes = await bootRemoteWebHost({
    doc: okDom.doc,
    win: okDom.win,
    profile: ANTIGRAVITY_REMOTE_WEB_PROFILE,
    kernel: okKernel,
    packedAddons: [
      {
        pluginMeta: {
          pluginId: 'hello-remote',
          displayName: 'Hello Remote',
          version: '1.0.0',
          trustLevel: 'restricted',
          uiSlots: [{ slot: 'status-bar', slotId: 'hello-remote.bar', anchor: 'status-bar', shadow: true }],
        },
        run(addonHost) {
          capturedProfileId = addonHost.hostProfileId;
          const slotRoot = addonHost.mountSlot('hello-remote.bar');
          assert.ok(slotRoot, 'Fallback anchor dock should allow status-bar slot mount');
          slotRoot.textContent = 'HELLO_REMOTE_OK';
        },
      },
    ],
  });
  assert.equal(okRes.ok, true);
  assert.equal(capturedProfileId, 'antigravity-remote-web');
  assert.equal(okRes.controller.getAddonStates()[0].status, 'active');
  okRes.controller.dispose();
});

test('TC-RW-009: build-remote.js produces deterministic host-only bundles, MV3 extension, omits oversized bookmarklet, and enforces expanded Acorn AST security gate', () => {
  // Negative AST security checks (direct + computed + global/Reflect + v2.6.0 TrustedTypes/CSP sinks)
  assert.equal(verifyRemoteBundleAst('el.innerHTML = "<b>x</b>";').ok, false);
  assert.equal(verifyRemoteBundleAst('el["outerHTML"] = "x";').ok, false);
  assert.equal(verifyRemoteBundleAst('el.setHTMLUnsafe("<b>x</b>");').ok, false);
  assert.equal(verifyRemoteBundleAst('frame.srcdoc = "<p>x</p>";').ok, false);
  assert.equal(verifyRemoteBundleAst('range.createContextualFragment("<b>x</b>");').ok, false);
  assert.equal(verifyRemoteBundleAst('parser.parseFromString("<b>x</b>", "text/html");').ok, false);
  assert.equal(verifyRemoteBundleAst('document.write("x");').ok, false);
  assert.equal(verifyRemoteBundleAst('document["write"]("x");').ok, false);
  assert.equal(verifyRemoteBundleAst('document["writeln"]("x");').ok, false);
  assert.equal(verifyRemoteBundleAst('window.document["write"]("x");').ok, false);
  assert.equal(verifyRemoteBundleAst('eval("1+1");').ok, false);
  assert.equal(verifyRemoteBundleAst('window.eval("1+1");').ok, false);
  assert.equal(verifyRemoteBundleAst('globalThis["eval"]("1+1");').ok, false);
  assert.equal(verifyRemoteBundleAst('new Function("return 1")();').ok, false);
  assert.equal(verifyRemoteBundleAst('new window.Function("return 1")();').ok, false);
  assert.equal(verifyRemoteBundleAst('Reflect.construct(Function, ["return 1"]);').ok, false);
  assert.equal(verifyRemoteBundleAst('Reflect.apply(eval, null, ["1"]);').ok, false);
  assert.equal(verifyRemoteBundleAst('require("node:fs");').ok, false);
  assert.equal(verifyRemoteBundleAst('trustedTypes.createPolicy("default", {});').ok, false);
  assert.equal(verifyRemoteBundleAst('trustedTypes["createPolicy"]("default", {});').ok, false);
  assert.equal(verifyRemoteBundleAst('trustedTypes.createPolicy(`default`, {});').ok, false);
  assert.equal(verifyRemoteBundleAst('setTimeout("alert(1)", 0);').ok, false);
  assert.equal(verifyRemoteBundleAst('window.setInterval(`tick()`, 50);').ok, false);
  assert.equal(verifyRemoteBundleAst('document.createElement("script");').ok, false);
  assert.equal(verifyRemoteBundleAst('document.createElementNS("http://www.w3.org/1999/xhtml", "script");').ok, false);
  assert.equal(verifyRemoteBundleAst('new Worker("worker.js");').ok, false);
  assert.equal(verifyRemoteBundleAst('new window.SharedWorker("shared.js");').ok, false);
  assert.equal(verifyRemoteBundleAst('el.setAttribute("onclick", "alert(1)");').ok, false);
  assert.equal(verifyRemoteBundleAst('el.setAttributeNS(null, "onload", "alert(1)");').ok, false);

  // Positive AST checks for legitimate browser calls
  assert.equal(
    verifyRemoteBundleAst('setTimeout(function() {}, 10); document.createElement("div"); el.setAttribute("data-onclick", "1");').ok,
    true
  );

  const dirA = makeTmpDir('agy-v26-dist-a-');
  const dirB = makeTmpDir('agy-v26-dist-b-');
  try {
    const resA = buildDistRemote({ targetDir: dirA, noAddons: true, hostVersion: '2.6.0' });
    const resB = buildDistRemote({ targetDir: dirB, noAddons: true, hostVersion: '2.6.0' });
    assert.equal(resA.ok, true);
    assert.equal(resA.buildManifest.mode, 'host-only');
    assert.equal(resA.buildManifest.addonCount, 0);
    assert.equal(resA.buildManifest.buildSha256, resB.buildManifest.buildSha256);

    const userJs = fs.readFileSync(path.join(dirA, 'antigravity-remote.user.js'), 'utf8');
    assert.ok(userJs.includes('// @match        https://antigravity.google.com/*'));
    assert.ok(userJs.includes('// @inject-into  content'));
    assert.ok(userJs.includes('// @grant        GM_getValue'));
    assert.ok(userJs.includes('// @grant        GM_setValue'));
    assert.ok(userJs.includes('// @grant        GM_deleteValue'));
    assert.equal(resA.buildManifest.userscript.injectInto, 'content');

    // v2.7.0 modular @require host library & .meta.js are deterministic and AST-clean
    const hostLibA = fs.readFileSync(path.join(dirA, 'antigravity-remote-host.lib.js'), 'utf8');
    const hostLibB = fs.readFileSync(path.join(dirB, 'antigravity-remote-host.lib.js'), 'utf8');
    const metaA = fs.readFileSync(path.join(dirA, 'antigravity-remote.meta.js'), 'utf8');
    const metaB = fs.readFileSync(path.join(dirB, 'antigravity-remote.meta.js'), 'utf8');
    assert.equal(hostLibA, hostLibB);
    assert.equal(metaA, metaB);
    assert.equal(hostLibA.includes('==UserScript=='), false);
    assert.ok(metaA.includes('// ==UserScript=='));
    assert.ok(metaA.includes('// @inject-into  content'));
    assert.equal(verifyRemoteBundleAst(hostLibA).ok, true);
    assert.doesNotThrow(() => acorn.parse(hostLibA, { ecmaVersion: 'latest', sourceType: 'script' }));

    // MV3 unpacked browser extension output is deterministic, AST-clean, and ISOLATED world
    const extManifestRawA = fs.readFileSync(path.join(dirA, 'extension', 'manifest.json'), 'utf8');
    const extManifestRawB = fs.readFileSync(path.join(dirB, 'extension', 'manifest.json'), 'utf8');
    const extScriptA = fs.readFileSync(path.join(dirA, 'extension', EXTENSION_CONTENT_SCRIPT_FILENAME), 'utf8');
    const extScriptB = fs.readFileSync(path.join(dirB, 'extension', EXTENSION_CONTENT_SCRIPT_FILENAME), 'utf8');
    assert.equal(extManifestRawA, extManifestRawB);
    assert.equal(extScriptA, extScriptB);
    const extManifest = JSON.parse(extManifestRawA);
    const expectedContentSha8 = resA.buildManifest.files[`extension/${EXTENSION_CONTENT_SCRIPT_FILENAME}`].slice(0, 8);
    assert.equal(extManifest.manifest_version, 3);
    assert.equal(extManifest.version, '2.6.0');
    assert.equal(extManifest.version_name, `2.6.0 (${expectedContentSha8})`);
    assert.equal(resA.buildManifest.extension.versionName, extManifest.version_name);
    assert.equal(extManifest.content_scripts[0].world, 'ISOLATED');
    assert.deepEqual(extManifest.content_scripts[0].js, [EXTENSION_CONTENT_SCRIPT_FILENAME]);
    assert.equal('permissions' in extManifest, false);
    assert.equal('host_permissions' in extManifest, false);
    assert.equal('background' in extManifest, false);
    assert.equal('web_accessible_resources' in extManifest, false);
    const extAst = verifyRemoteBundleAst(extScriptA);
    assert.equal(extAst.ok, true, `extension content-script AST failed: ${JSON.stringify(extAst.violations)}`);
    assert.doesNotThrow(() => acorn.parse(extScriptA, { ecmaVersion: 'latest', sourceType: 'script' }));

    // v2.6.0 fail-closed bookmarklet cap: oversized host-only bundle omits bookmarklet.txt
    assert.equal(fs.existsSync(path.join(dirA, 'bookmarklet.txt')), false);
    assert.equal(resA.buildManifest.bookmarklet.emitted, false);
    assert.equal(resA.buildManifest.bookmarklet.runnable, false);
    assert.equal(resA.buildManifest.bookmarklet.maxChars, BOOKMARKLET_MAX_RUNNABLE_CHARS);
    assert.equal(resA.buildManifest.bookmarklet.reason, 'ERR_BOOKMARKLET_EXCEEDS_BROWSER_LIMIT');

    // In-place rebuild prunes stale legacy bookmarklet.txt without deleting extension dir
    fs.writeFileSync(path.join(dirA, 'bookmarklet.txt'), 'javascript:void(0);', 'utf8');
    const rebuildRes = buildDistRemote({ targetDir: dirA, noAddons: true, hostVersion: '2.6.0' });
    assert.equal(rebuildRes.ok, true);
    assert.equal(fs.existsSync(path.join(dirA, 'bookmarklet.txt')), false);
    assert.equal(fs.existsSync(path.join(dirA, 'extension', 'manifest.json')), true);

    // Direct small bookmarklet generation remains syntactically valid, AST-clean, and executable
    const smallBookmarklet = buildBookmarkletText('globalThis.__bmSmoke = 42;').trim();
    assert.ok(smallBookmarklet.startsWith('javascript:'));
    assert.equal(smallBookmarklet.includes('\n'), false);
    assert.ok(smallBookmarklet.length <= BOOKMARKLET_MAX_RUNNABLE_CHARS);
    const decodedBookmarklet = decodeURIComponent(smallBookmarklet.slice('javascript:'.length));
    assert.equal(verifyRemoteBundleAst(decodedBookmarklet).ok, true);
    assert.doesNotThrow(() => acorn.parse(decodedBookmarklet, { ecmaVersion: 'latest', sourceType: 'script' }));
    const sandbox = {};
    sandbox.globalThis = sandbox;
    vm.runInNewContext(decodedBookmarklet, sandbox, { filename: 'bookmarklet.js' });
    assert.equal(sandbox.__bmSmoke, 42);
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});

test('TC-RW-010: Audit regressions F2 (check:remote mode mismatch), F3 (control-char URL & extra attr), F4 (re-boot after dispose)', async () => {
  // F3: control-char URL obfuscation & invalid extraNoTranslateAttributes
  const { doc: guardDoc } = makeMockDom('https://antigravity.google.com/workspace');
  assert.throws(
    () => createElementSafe(guardDoc, 'a', { href: '\u0000javascript:alert(1)' }),
    (err) => err instanceof SecurityPolicyError && err.code === 'ERR_FORBIDDEN_URL_ATTR_SCHEME'
  );
  assert.throws(
    () => createElementSafe(guardDoc, 'a', { href: 'java\tscript:alert(1)' }),
    (err) => err instanceof SecurityPolicyError && err.code === 'ERR_FORBIDDEN_URL_ATTR_SCHEME'
  );
  assert.throws(
    () => createElementSafe(guardDoc, 'a', { href: '\u0001data:text/html,boom' }),
    (err) => err instanceof SecurityPolicyError && err.code === 'ERR_FORBIDDEN_URL_ATTR_SCHEME'
  );
  const { hostEl } = createShadowContainer(guardDoc, 'rw-attr-check-host', {
    noTranslateAttrs: ['data-valid-attr', 'onclick', 'bad attr', 'x"y', '123-invalid'],
  });
  assert.equal(hostEl.getAttribute('data-valid-attr'), 'true');
  assert.equal(hostEl.getAttribute('onclick'), null);
  assert.equal(hostEl.getAttribute('bad attr'), null);
  assert.equal(hostEl.getAttribute('x"y'), null);
  assert.equal(hostEl.getAttribute('123-invalid'), null);

  // F2: --no-addons --check skips drift comparison when on-disk manifest is packed mode, but still detects host-only drift
  const tmpOutDir = makeTmpDir('agy-v23-f2-check-');
  try {
    const buildRemoteScript = path.join(REPO_ROOT, 'scripts', 'build-remote.js');
    fs.writeFileSync(
      path.join(tmpOutDir, 'build-manifest.json'),
      JSON.stringify({ schemaVersion: 1, mode: 'packed', buildSha256: 'deadbeef' }),
      'utf8'
    );
    const packedCheck = spawnSync(process.execPath, [buildRemoteScript, '--no-addons', '--check', '--out-dir', tmpOutDir], {
      encoding: 'utf8',
    });
    assert.equal(packedCheck.status, 0, packedCheck.stderr);
    const packedOut = JSON.parse(packedCheck.stdout);
    assert.equal(packedOut.ok, true);
    assert.equal(packedOut.comparedCommittedManifest, false);

    fs.writeFileSync(
      path.join(tmpOutDir, 'build-manifest.json'),
      JSON.stringify({ schemaVersion: 1, mode: 'host-only', buildSha256: 'deadbeef' }),
      'utf8'
    );
    const driftedCheck = spawnSync(process.execPath, [buildRemoteScript, '--no-addons', '--check', '--out-dir', tmpOutDir], {
      encoding: 'utf8',
    });
    assert.equal(driftedCheck.status, 1);
    assert.ok(driftedCheck.stderr.includes('REMOTE_BUILD_DRIFT_DETECTED'));
  } finally {
    fs.rmSync(tmpOutDir, { recursive: true, force: true });
  }

  // F4: Re-booting after controller.dispose() against the same singleton kernel succeeds & swaps active bridge
  const { doc, win } = makeMockDom('https://antigravity.google.com/workspace');
  const sharedKernel = createRendererKernel(doc, win);
  function makeMemStore() {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    };
  }
  const store1 = makeMemStore();
  const store2 = makeMemStore();
  const addonSpec = {
    pluginMeta: {
      pluginId: 'reboot-addon',
      displayName: 'Reboot Addon',
      version: '1.0.0',
      trustLevel: 'trusted',
      hasSettingsBridge: true,
      uiSlots: [],
      capabilities: ['renderer'],
      skippedCapabilities: [],
    },
    settingsSpec: { maxBytes: 4096 },
    async run(handle) {
      await handle.saveSettings({ bootRun: handle.hostProfileId, ts: 1 });
    },
  };

  const settingsKey = `${ANTIGRAVITY_REMOTE_WEB_PROFILE.storageNamespace}:settings:reboot-addon`;
  const boot1 = await bootRemoteWebHost({
    profile: ANTIGRAVITY_REMOTE_WEB_PROFILE,
    doc,
    win,
    kernel: sharedKernel,
    storage: store1,
    packedAddons: [addonSpec],
  });
  assert.equal(boot1.ok, true);
  assert.equal(boot1.controller.getAddonStates()[0].status, 'active');
  assert.ok(store1.getItem(settingsKey));
  boot1.controller.dispose();

  const boot2 = await bootRemoteWebHost({
    profile: ANTIGRAVITY_REMOTE_WEB_PROFILE,
    doc,
    win,
    kernel: sharedKernel,
    storage: store2,
    packedAddons: [addonSpec],
  });
  assert.equal(boot2.ok, true, `re-boot after dispose failed: ${boot2.reason}`);
  assert.equal(boot2.alreadyBooted, false);
  assert.equal(boot2.controller.getAddonStates()[0].status, 'active');
  assert.ok(store2.getItem(settingsKey));
  boot2.controller.dispose();
});

test('TC-RW-011: build-remote CLI resolves default trust-policy & config.json paths, preserves explicit null, and filters F7 extraNoTranslateAttributes', async () => {
  const tmpHome = makeTmpDir('agy-v24-cli-default-paths-');
  const tmpOutDir = makeTmpDir('agy-v24-cli-out-');
  try {
    const addonsDir = path.join(tmpHome, '.gemini', 'antigravity', 'addons.d');
    const pluginsRootDir = path.join(tmpHome, '.gemini', 'config', 'plugins');
    const configJsonPath = path.join(tmpHome, '.gemini', 'config', 'config.json');
    const trustPolicyPath = path.join(tmpHome, '.gemini', 'antigravity', 'trust-policy.json');
    fs.mkdirSync(addonsDir, { recursive: true });
    fs.mkdirSync(pluginsRootDir, { recursive: true });

    const enabledSrc = 'addonHost.registerAction("ok", { label: "OK", run: () => 1 });\n';
    const disabledSrc = 'addonHost.registerAction("off", { label: "OFF", run: () => 0 });\n';
    fs.mkdirSync(path.join(pluginsRootDir, 'trusted-enabled'), { recursive: true });
    fs.mkdirSync(path.join(pluginsRootDir, 'trusted-disabled'), { recursive: true });
    fs.writeFileSync(path.join(pluginsRootDir, 'trusted-enabled', 'renderer.js'), enabledSrc, 'utf8');
    fs.writeFileSync(path.join(pluginsRootDir, 'trusted-disabled', 'renderer.js'), disabledSrc, 'utf8');

    for (const id of ['trusted-enabled', 'trusted-disabled']) {
      fs.writeFileSync(
        path.join(addonsDir, `${id}.json`),
        JSON.stringify({
          schemaVersion: 2,
          pluginId: id,
          displayName: id,
          version: '1.0.0',
          trustLevel: 'trusted',
          capabilities: ['renderer'],
          entry: { rendererScript: 'renderer.js' },
          compatibility: { hostProfile: 'antigravity-desktop', minHostVersion: '2.3.0' },
          isolation: { noTranslate: true, i18nSelfManaged: true },
        }),
        'utf8'
      );
    }

    fs.writeFileSync(
      trustPolicyPath,
      JSON.stringify({
        schemaVersion: 1,
        approved: {
          'trusted-enabled': { rendererSha256: sha256(enabledSrc) },
          'trusted-disabled': { rendererSha256: sha256(disabledSrc) },
        },
      }),
      'utf8'
    );
    fs.writeFileSync(
      configJsonPath,
      JSON.stringify({
        plugins: {
          'trusted-enabled': { enabled: true },
          'trusted-disabled': { enabled: false },
        },
      }),
      'utf8'
    );

    // 1. Default CLI invocation (NO --trust-policy and NO --config-json flags) MUST resolve profile defaults
    const buildRemoteScript = path.join(REPO_ROOT, 'scripts', 'build-remote.js');
    const cliRes = spawnSync(process.execPath, [buildRemoteScript, '--out-dir', tmpOutDir], {
      env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
      encoding: 'utf8',
    });
    assert.equal(cliRes.status, 0, cliRes.stderr);
    const cliOut = JSON.parse(cliRes.stdout);
    assert.equal(cliOut.ok, true);
    assert.equal(cliOut.addonCount, 1);
    assert.equal(cliOut.rejectedCount, 0);
    const builtManifest = JSON.parse(fs.readFileSync(path.join(tmpOutDir, 'build-manifest.json'), 'utf8'));
    assert.deepEqual(
      builtManifest.addons.map((a) => a.pluginId),
      ['trusted-enabled']
    );

    // 2. Programmatic explicit null MUST still disable trustPolicyPath / configJsonPath fallback
    const nullOutDir = path.join(tmpOutDir, 'explicit-null');
    const nullRes = buildDistRemote({
      targetDir: nullOutDir,
      addonsDir,
      pluginsRootDir,
      configJsonPath: null,
      trustPolicyPath: null,
      hostVersion: '2.4.0',
    });
    assert.equal(nullRes.ok, true);
    assert.equal(nullRes.buildManifest.addonCount, 0);
    assert.equal(nullRes.buildManifest.rejectedCount, 2);

    // 3. F7: bootRemoteWebHost filters unsafe profile.extraNoTranslateAttributes BEFORE kernel.boot
    const { doc, win } = makeMockDom('https://antigravity.google.com/workspace');
    const kernel = createRendererKernel(doc, win);
    let mountedHostEl = null;
    const f7Res = await bootRemoteWebHost({
      doc,
      win,
      kernel,
      profile: {
        ...ANTIGRAVITY_REMOTE_WEB_PROFILE,
        extraNoTranslateAttributes: ['data-safe-f7', 'onclick', 'bad attr', '123invalid'],
      },
      packedAddons: [
        {
          pluginMeta: {
            pluginId: 'f7-slot-addon',
            displayName: 'F7 Slot',
            version: '1.0.0',
            trustLevel: 'restricted',
            uiSlots: [{ slot: 'status-bar', slotId: 'f7.bar', anchor: 'status-bar', shadow: false }],
          },
          run(handle) {
            mountedHostEl = handle.mountSlot('f7.bar');
          },
        },
      ],
    });
    assert.equal(f7Res.ok, true);
    assert.ok(mountedHostEl);
    assert.equal(mountedHostEl.getAttribute('data-safe-f7'), 'true');
    assert.equal(mountedHostEl.getAttribute('onclick'), null);
    assert.equal(mountedHostEl.getAttribute('bad attr'), null);
    assert.equal(mountedHostEl.getAttribute('123invalid'), null);
    f7Res.controller.dispose();
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpOutDir, { recursive: true, force: true });
  }
});

test('TC-RW-012: extension-manifest.js validates MV3 versions/origins fail-closed and generates vendor-neutral ISOLATED manifests', () => {
  assert.equal(normalizeMv3Version('2.6.0'), '2.6.0');
  assert.equal(normalizeMv3Version('v2.6.0-rc.1+build7'), '2.6.0');
  assert.equal(normalizeMv3Version('1.2.3.4'), '1.2.3.4');
  for (const badVer of ['', '0.0.0', '70000.0.0', '1.2.3.4.5', 'abc', '1.-2.0']) {
    assert.throws(
      () => normalizeMv3Version(badVer),
      (err) => err instanceof SecurityPolicyError && err.code === 'ERR_INVALID_EXTENSION_VERSION'
    );
  }

  assert.deepEqual(buildExtensionMatchPatterns(['https://app.acme.example', 'https://app.acme.example']), [
    'https://app.acme.example/*',
  ]);
  for (const badOrigins of [
    [],
    ['http://app.acme.example'],
    ['https://*.acme.example'],
    ['https://app.acme.example:8443'],
    ['https://user:pass@app.acme.example'],
    ['https://app.acme.example/workspace'],
    ['not-a-url'],
  ]) {
    assert.throws(() => buildExtensionMatchPatterns(badOrigins), SecurityPolicyError);
  }

  const syntheticProfile = {
    id: 'acme-remote-web',
    displayName: 'Acme Remote Web',
    allowedOrigins: ['https://app.acme.example'],
  };
  const manifest = buildMv3ExtensionManifest({
    profile: syntheticProfile,
    version: '2.6.0',
    contentSha8: 'abcd1234',
  });
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'Acme Remote Web Addon Host');
  assert.equal(manifest.version, '2.6.0');
  assert.equal(manifest.version_name, '2.6.0 (abcd1234)');
  assert.equal(manifest.content_scripts.length, 1);
  assert.deepEqual(manifest.content_scripts[0], {
    matches: ['https://app.acme.example/*'],
    js: [EXTENSION_CONTENT_SCRIPT_FILENAME],
    run_at: 'document_idle',
    world: 'ISOLATED',
    all_frames: false,
    match_about_blank: false,
    match_origin_as_fallback: false,
  });
  assert.equal('permissions' in manifest, false);
  assert.equal('host_permissions' in manifest, false);
  assert.equal('background' in manifest, false);
  assert.equal('web_accessible_resources' in manifest, false);
  assert.equal(/antigravity/i.test(JSON.stringify(manifest)), false);
});

test('TC-RW-013: Remote Web kernel slimming removes host-settings-ui; bootRemoteWebHost enforces cross-world guard and reports failed addons once', async () => {
  const desktopKernelSrc = buildRendererKernelBundleSource({ includeHostSettingsUi: true });
  const remoteKernelSrc = buildRendererKernelBundleSource({ includeHostSettingsUi: false });
  assert.ok(
    desktopKernelSrc.length - remoteKernelSrc.length >= 55000,
    `Expected >= 55KB slimming savings, got ${desktopKernelSrc.length - remoteKernelSrc.length}`
  );
  assert.equal(remoteKernelSrc.includes('ah-sync-card'), false);
  assert.equal(remoteKernelSrc.includes('copy-extension-path'), false);
  const remoteAst = verifyRemoteBundleAst(remoteKernelSrc);
  assert.equal(remoteAst.ok, true, `Slimmed kernel AST failed: ${JSON.stringify(remoteAst.violations)}`);

  // Cross-world duplicate-boot guard + failed addon early drawer mount & single error entry
  const { doc, win: isolatedWin } = makeMockDom('https://antigravity.google.com/workspace');
  const mainWorldWin = {
    location: { href: 'https://antigravity.google.com/workspace', origin: 'https://antigravity.google.com' },
    addEventListener() {},
    removeEventListener() {},
  };

  const k1 = createRendererKernel(doc, isolatedWin);
  const boot1 = await bootRemoteWebHost({
    doc,
    win: isolatedWin,
    profile: ANTIGRAVITY_REMOTE_WEB_PROFILE,
    kernel: k1,
    packedAddons: [
      {
        pluginMeta: {
          pluginId: 'boom-addon',
          displayName: 'Boom Addon',
          version: '1.0.0',
          trustLevel: 'restricted',
          uiSlots: [],
        },
        run() {
          throw new Error('BOOM_IN_ADDON');
        },
      },
    ],
  });
  assert.equal(boot1.ok, true);
  assert.equal(doc.documentElement.getAttribute(ACTIVE_HOST_ATTR), ANTIGRAVITY_REMOTE_WEB_PROFILE.id);
  assert.equal(boot1.controller.getAddonStates()[0].status, 'failed');
  assert.equal(boot1.controller.getErrors().length, 1, 'Failed addon error must not be double-reported');
  assert.ok(boot1.controller.getErrors()[0].detail.includes('BOOM_IN_ADDON'));

  // Pill dot must reflect error state
  function findByClass(node, cls) {
    if (!node) return null;
    const c = typeof node.getAttribute === 'function' ? node.getAttribute('class') || '' : '';
    if (c.split(/\s+/).includes(cls)) return node;
    const kids = node.children || [];
    for (let i = 0; i < kids.length; i += 1) {
      const hit = findByClass(kids[i], cls);
      if (hit) return hit;
    }
    return null;
  }
  const dotEl = findByClass(boot1.controller.drawerUi.shadowRoot, 'rah-dot');
  assert.ok(dotEl, 'Drawer pill dot must be rendered');
  assert.ok(String(dotEl.getAttribute('class') || '').includes('has-error'));

  // Second world sharing the same document must detect crossWorld duplicate boot
  const k2 = createRendererKernel(doc, mainWorldWin);
  const crossBoot = await bootRemoteWebHost({
    doc,
    win: mainWorldWin,
    profile: ANTIGRAVITY_REMOTE_WEB_PROFILE,
    kernel: k2,
    packedAddons: [],
  });
  assert.equal(crossBoot.ok, true);
  assert.equal(crossBoot.alreadyBooted, true);
  assert.equal(crossBoot.crossWorld, true);
  assert.equal(crossBoot.controller, null);

  // Disposing first boot clears ACTIVE_HOST_ATTR and allows clean re-boot
  boot1.controller.dispose();
  assert.equal(doc.documentElement.getAttribute(ACTIVE_HOST_ATTR), null);

  const bootAfterDispose = await bootRemoteWebHost({
    doc,
    win: mainWorldWin,
    profile: ANTIGRAVITY_REMOTE_WEB_PROFILE,
    kernel: k2,
    packedAddons: [],
  });
  assert.equal(bootAfterDispose.ok, true);
  assert.equal(bootAfterDispose.alreadyBooted, false);
  bootAfterDispose.controller.dispose();
});
