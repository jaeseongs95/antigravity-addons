'use strict';

/**
 * Unit Tests for v2.7.0 Universal Remote Web Delivery & Runtime Overhaul (TC-U1..TC-U5).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const { ANTIGRAVITY_REMOTE_WEB_PROFILE } = require('../../src/profiles/antigravity-remote-web');
const { ANTIGRAVITY_HOST_PROFILE } = require('../../src/profiles/antigravity');
const { createRendererKernel } = require('../../src/runtime/renderer/kernel');
const {
  registerAddon,
  getRegisteredAddons,
  bootRemoteWebHost,
  createRemoteHostBridge,
  collectRemoteWebAddons,
  isOfflineConfigBridgeAddon,
  encodeQrMatrix,
  renderQrAscii,
  startRemoteLanServer,
  pickLanIpv4Address,
} = require('../../src/adapters/remote-web');
const { createHostAdminService } = require('../../src/runtime/main/host-admin-service');
const { loadRawManifestsFromDir } = require('../../src/adapters/electron/host-loader-builder');
const { createNodeFileSystemPort } = require('../../src/adapters/node-fs-port');
const { buildDistRemote } = require('../../scripts/build-remote');

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeMockDom(url = 'https://antigravity.google.com/workspace') {
  class MockNode {
    constructor(tagName, ownerDocument, nodeType = 1) {
      this.tagName = tagName ? String(tagName).toUpperCase() : '';
      this.nodeType = nodeType;
      this.ownerDocument = ownerDocument;
      this.parentNode = null;
      this.parentElement = null;
      this.childNodes = [];
      this.children = [];
      this.attributes = new Map();
      this.style = {};
      this.listeners = new Map();
      this.shadowRoot = null;
      this._text = '';
      this.className = '';
      this.id = '';
    }
    get firstChild() {
      return this.childNodes[0] || null;
    }
    get textContent() {
      if (this.childNodes.length === 0) return this._text;
      return this.childNodes.map((c) => c.textContent || '').join('');
    }
    set textContent(v) {
      this.childNodes = [];
      this.children = [];
      this._text = String(v == null ? '' : v);
    }
    get isConnected() {
      let cur = this;
      while (cur) {
        if (cur === this.ownerDocument.documentElement || cur === this.ownerDocument.body) return true;
        cur = cur.parentNode || cur.host || null;
      }
      return false;
    }
    setAttribute(k, v) {
      const key = String(k);
      const val = String(v);
      this.attributes.set(key, val);
      if (key === 'class') this.className = val;
      if (key === 'id') this.id = val;
    }
    getAttribute(k) {
      return this.attributes.has(String(k)) ? this.attributes.get(String(k)) : null;
    }
    hasAttribute(k) {
      return this.attributes.has(String(k));
    }
    removeAttribute(k) {
      const key = String(k);
      this.attributes.delete(key);
      if (key === 'class') this.className = '';
      if (key === 'id') this.id = '';
    }
    appendChild(child) {
      if (!child) return child;
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      child.parentElement = this.nodeType === 1 ? this : null;
      this.childNodes.push(child);
      if (child.nodeType === 1) this.children.push(child);
      return child;
    }
    removeChild(child) {
      const ci = this.childNodes.indexOf(child);
      if (ci >= 0) this.childNodes.splice(ci, 1);
      const ei = this.children.indexOf(child);
      if (ei >= 0) this.children.splice(ei, 1);
      child.parentNode = null;
      child.parentElement = null;
      return child;
    }
    attachShadow({ mode }) {
      const sr = new MockNode('#shadow-root', this.ownerDocument, 11);
      sr.mode = mode;
      sr.host = this;
      this.shadowRoot = sr;
      return sr;
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    removeEventListener(type, fn) {
      const arr = this.listeners.get(type);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    }
    click() {
      const arr = (this.listeners.get('click') || []).slice();
      for (const fn of arr) fn({ target: this, preventDefault() {}, stopPropagation() {} });
    }
    focus() {}
    matches(sel) {
      const s = sel.trim();
      if (s.startsWith('#')) return this.id === s.slice(1);
      if (s.startsWith('.')) return this.className.split(/\s+/).includes(s.slice(1));
      const attrParts = s.match(/\[[^\]]+\]/g);
      if (attrParts && attrParts.join('') === s) {
        return attrParts.every((part) => {
          const m = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(part);
          if (!m) return false;
          const actual = this.getAttribute(m[1]);
          return m[2] !== undefined ? actual === m[2] : actual !== null;
        });
      }
      return this.tagName === s.toUpperCase();
    }
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => {
        for (const ch of n.children || []) {
          if (ch.matches(sel)) out.push(ch);
          walk(ch);
        }
      };
      walk(this);
      return out;
    }
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    }
  }

  const doc = {
    documentElement: null,
    head: null,
    body: null,
    createElement(tag) {
      return new MockNode(tag, doc, 1);
    },
    createTextNode(text) {
      const n = new MockNode('', doc, 3);
      n._text = String(text == null ? '' : text);
      return n;
    },
    getElementById(id) {
      return doc.documentElement.querySelector(`#${id}`);
    },
    querySelector(sel) {
      return doc.documentElement.querySelector(sel);
    },
    querySelectorAll(sel) {
      return doc.documentElement.querySelectorAll(sel);
    },
  };
  doc.documentElement = new MockNode('html', doc, 1);
  doc.head = new MockNode('head', doc, 1);
  doc.body = new MockNode('body', doc, 1);
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);

  const parsed = new URL(url);
  const win = {
    document: doc,
    location: { href: parsed.href, origin: parsed.origin, protocol: parsed.protocol },
    addEventListener() {},
    removeEventListener() {},
  };
  return { doc, win };
}

function httpRequest(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('TC-U1: modular registerAddon() supports pre-boot queueing, post-boot dynamic mounting, duplicate rejection, and error isolation', async () => {
  const { doc, win } = makeMockDom('https://antigravity.google.com/workspace');
  const kernel = createRendererKernel(doc, win);
  const ranOrder = [];

  // Invalid descriptors fail closed
  assert.equal(registerAddon(null, { win }).reason, 'ERR_INVALID_ADDON_DESCRIPTOR');
  assert.equal(registerAddon({ run() {} }, { win }).reason, 'ERR_INVALID_ADDON_META');
  assert.equal(registerAddon({ pluginMeta: { pluginId: 'no-fn' } }, { win }).reason, 'ERR_PACKED_ADDON_RUN_FN_REQUIRED');

  // Pre-boot registration queues addon
  const preRes = registerAddon(
    {
      pluginMeta: {
        schemaVersion: 2,
        pluginId: 'mod-pre-addon',
        displayName: 'Modular Pre Addon',
        version: '1.0.0',
        trustLevel: 'restricted',
        capabilities: ['renderer'],
        uiSlots: [{ slot: 'status-bar', slotId: 'mod-pre-addon.bar', anchor: 'status-bar', shadow: true }],
      },
      run(addonHost) {
        ranOrder.push('pre:' + addonHost.hostProfileId);
      },
    },
    { win }
  );
  assert.equal(preRes.ok, true);
  assert.equal(preRes.queued, true);
  assert.equal(preRes.mounted, false);
  assert.equal(getRegisteredAddons(win).length, 1);

  // Duplicate ID is rejected
  const dupRes = registerAddon(
    {
      pluginMeta: { pluginId: 'mod-pre-addon' },
      run() {},
    },
    { win }
  );
  assert.equal(dupRes.ok, false);
  assert.equal(dupRes.reason, 'ERR_DUPLICATE_ADDON_ID');

  // Boot runs queued addons
  const boot = await bootRemoteWebHost({
    doc,
    win,
    profile: ANTIGRAVITY_REMOTE_WEB_PROFILE,
    kernel,
    packedAddons: [],
  });
  assert.equal(boot.ok, true);
  assert.deepEqual(ranOrder, ['pre:antigravity-remote-web']);
  assert.equal(boot.controller.getAddonStates().length, 1);
  assert.equal(boot.controller.getAddonStates()[0].status, 'active');

  // Post-boot dynamic registration mounts immediately
  const postRes = registerAddon(
    {
      pluginMeta: {
        schemaVersion: 2,
        pluginId: 'mod-post-addon',
        displayName: 'Modular Post Addon',
        version: '1.2.0',
        trustLevel: 'restricted',
        capabilities: ['renderer'],
        uiSlots: [],
      },
      run() {
        ranOrder.push('post');
      },
    },
    { win }
  );
  assert.equal(postRes.ok, true);
  assert.equal(postRes.mounted, true);
  const mountedOutcome = await postRes.promise;
  assert.equal(mountedOutcome.ok, true);
  assert.equal(mountedOutcome.status, 'active');

  // Throwing dynamic addon is isolated and does not crash host
  const badRes = registerAddon(
    {
      pluginMeta: {
        schemaVersion: 2,
        pluginId: 'mod-crash-addon',
        displayName: 'Crash Addon',
        version: '1.0.0',
        trustLevel: 'restricted',
        capabilities: ['renderer'],
        uiSlots: [],
      },
      run() {
        throw new Error('BOOM_ISOLATED');
      },
    },
    { win }
  );
  const badOutcome = await badRes.promise;
  assert.equal(badOutcome.ok, false);
  assert.equal(badOutcome.status, 'failed');
  assert.equal(boot.controller.getAddonStates().length, 3);
  assert.equal(boot.controller.getAddonStates()[2].status, 'failed');
  assert.ok(boot.controller.getErrors().some((e) => e.pluginId === 'mod-crash-addon' && e.detail.includes('BOOM_ISOLATED')));

  boot.controller.dispose();
});

test('TC-U2: desktop-only configBridge addons excluded by default (ERR_REMOTE_REQUIRES_LOCAL_CONFIG_BRIDGE), overridable via opt-in or CLI flag, plus HTTPS --update-base-url', () => {
  const tmp = makeTmpDir('agy-v27-u2-');
  try {
    const pluginsRootDir = path.join(tmp, 'plugins');
    const addonsDir = path.join(tmp, 'addons.d');
    const trustPolicyPath = path.join(tmp, 'trust-policy.json');
    const distDir = path.join(tmp, 'dist');
    fs.mkdirSync(addonsDir, { recursive: true });

    // Addon 1: desktop-only configBridge plugin (like antigravity-mcp-manager)
    const mcpDir = path.join(pluginsRootDir, 'local-mcp');
    fs.mkdirSync(mcpDir, { recursive: true });
    const mcpCode = 'addonHost.mountSlot("local-mcp.slot");';
    fs.writeFileSync(path.join(mcpDir, 'renderer.js'), mcpCode, 'utf8');
    const mcpManifest = {
      schemaVersion: 2,
      pluginId: 'local-mcp',
      displayName: 'Local MCP',
      version: '1.0.0',
      trustLevel: 'trusted',
      compatibility: { hostProfile: 'antigravity-desktop', minHostVersion: '2.3.0' },
      capabilities: ['renderer'],
      entry: { rendererScript: 'renderer.js' },
      uiSlots: [{ slot: 'settings-pane', slotId: 'local-mcp.slot', anchor: 'settings-pane', shadow: true }],
      isolation: { noTranslate: true, i18nSelfManaged: true },
      configBridge: { scopes: [{ scopeId: 'antigravity:mcp-config', access: 'rw' }] },
      loadOrder: 10,
    };
    fs.writeFileSync(path.join(addonsDir, 'local-mcp.json'), JSON.stringify(mcpManifest), 'utf8');

    // Addon 2: explicit remote-web opt-in configBridge plugin
    const optInDir = path.join(pluginsRootDir, 'optin-cfg');
    fs.mkdirSync(optInDir, { recursive: true });
    const optInCode = 'addonHost.mountSlot("optin-cfg.slot");';
    fs.writeFileSync(path.join(optInDir, 'renderer.js'), optInCode, 'utf8');
    const optInManifest = {
      ...mcpManifest,
      pluginId: 'optin-cfg',
      displayName: 'Opt-in Config',
      compatibility: { hostProfiles: ['antigravity-desktop', 'antigravity-remote-web'], minHostVersion: '2.3.0' },
      uiSlots: [{ slot: 'settings-pane', slotId: 'optin-cfg.slot', anchor: 'settings-pane', shadow: true }],
      isolation: { noTranslate: true, i18nSelfManaged: true },
      configBridge: { scopes: [{ scopeId: 'antigravity:plugin-mcp-configs', access: 'ro' }] },
      loadOrder: 20,
    };
    fs.writeFileSync(path.join(addonsDir, 'optin-cfg.json'), JSON.stringify(optInManifest), 'utf8');

    // Addon 3: normal renderer addon (no configBridge)
    const trDir = path.join(pluginsRootDir, 'normal-ui');
    fs.mkdirSync(trDir, { recursive: true });
    const trCode = 'addonHost.mountSlot("normal-ui.slot");';
    fs.writeFileSync(path.join(trDir, 'renderer.js'), trCode, 'utf8');
    fs.writeFileSync(
      path.join(addonsDir, 'normal-ui.json'),
      JSON.stringify({
        schemaVersion: 2,
        pluginId: 'normal-ui',
        displayName: 'Normal UI',
        version: '1.0.0',
        trustLevel: 'restricted',
        compatibility: { hostProfile: 'antigravity-desktop', minHostVersion: '2.0.0' },
        capabilities: ['renderer'],
        entry: { rendererScript: 'renderer.js' },
        uiSlots: [{ slot: 'status-bar', slotId: 'normal-ui.slot', anchor: 'status-bar', shadow: true }],
        isolation: { noTranslate: true, i18nSelfManaged: true },
        loadOrder: 30,
      }),
      'utf8'
    );

    const policy = {
      schemaVersion: 1,
      approved: {
        'local-mcp': { rendererSha256: sha256(mcpCode) },
        'optin-cfg': { rendererSha256: sha256(optInCode) },
      },
    };
    fs.writeFileSync(trustPolicyPath, JSON.stringify(policy), 'utf8');

    assert.equal(isOfflineConfigBridgeAddon(mcpManifest, 'antigravity-remote-web'), true);
    assert.equal(isOfflineConfigBridgeAddon(optInManifest, 'antigravity-remote-web'), false);

    // Default collection excludes local-mcp, includes optin-cfg & normal-ui
    const colDefault = collectRemoteWebAddons({
      profile: ANTIGRAVITY_REMOTE_WEB_PROFILE,
      addonsDir,
      pluginsRootDir,
      configJsonPath: null,
      trustPolicyPath,
      hostVersion: '2.7.0',
    });
    assert.deepEqual(
      colDefault.addons.map((a) => a.pluginMeta.pluginId),
      ['optin-cfg', 'normal-ui']
    );
    assert.ok(
      colDefault.rejected.some((r) => r.pluginId === 'local-mcp' && r.reason === 'ERR_REMOTE_REQUIRES_LOCAL_CONFIG_BRIDGE')
    );

    // HostAdminService mirrors the exact same ERR_REMOTE_REQUIRES_LOCAL_CONFIG_BRIDGE eligibility
    const svc = createHostAdminService({
      hostVersion: '2.7.0',
      buildSha8: '1234abcd',
      profile: ANTIGRAVITY_HOST_PROFILE,
      addonsDir,
      pluginsRootDir,
      remotePrefsPath: path.join(tmp, 'remote-prefs.json'),
      remoteDistDir: distDir,
      strictTrustPolicy: true,
      fsPort: createNodeFileSystemPort(),
      isEnabledInDesktopConfig: () => true,
      loadRawManifests: loadRawManifestsFromDir,
      planDesktopAddons: () => ({ active: [], disabled: [], rejected: [] }),
      readCurrentPolicy: () => policy,
      getLifecycleStates: () => ({}),
    });
    const adminState = svc.getState();
    const mcpAdminRow = adminState.addons.find((a) => a.pluginId === 'local-mcp');
    assert.equal(mcpAdminRow.remoteEligible, false);
    assert.equal(mcpAdminRow.remoteBlockedReason, 'ERR_REMOTE_REQUIRES_LOCAL_CONFIG_BRIDGE');
    const normalAdminRow = adminState.addons.find((a) => a.pluginId === 'normal-ui');
    assert.equal(normalAdminRow.remoteEligible, true);

    // --include-offline-config-bridge override includes local-mcp
    const colOverride = collectRemoteWebAddons({
      profile: ANTIGRAVITY_REMOTE_WEB_PROFILE,
      addonsDir,
      pluginsRootDir,
      configJsonPath: null,
      trustPolicyPath,
      hostVersion: '2.7.0',
      includeOfflineConfigBridge: true,
    });
    assert.deepEqual(
      colOverride.addons.map((a) => a.pluginMeta.pluginId),
      ['local-mcp', 'optin-cfg', 'normal-ui']
    );

    // HTTPS --update-base-url emits @updateURL / @downloadURL; non-HTTPS rejected
    const built = buildDistRemote({
      targetDir: distDir,
      noAddons: true,
      hostVersion: '2.7.0',
      updateBaseUrl: 'https://example.com/releases/latest/download/',
    });
    assert.equal(built.ok, true);
    const ujs = fs.readFileSync(path.join(distDir, 'antigravity-remote.user.js'), 'utf8');
    const mjs = fs.readFileSync(path.join(distDir, 'antigravity-remote.meta.js'), 'utf8');
    assert.ok(ujs.includes('// @updateURL    https://example.com/releases/latest/download/antigravity-remote.meta.js'));
    assert.ok(ujs.includes('// @downloadURL  https://example.com/releases/latest/download/antigravity-remote.user.js'));
    assert.ok(mjs.includes('// @updateURL    https://example.com/releases/latest/download/antigravity-remote.meta.js'));

    assert.throws(
      () =>
        buildDistRemote({
          targetDir: distDir,
          noAddons: true,
          hostVersion: '2.7.0',
          updateBaseUrl: 'http://insecure.example.com/dl',
        }),
      /ERR_UPDATE_BASE_URL_MUST_BE_HTTPS/
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('TC-U3: interactive Shadow-DOM Settings Tab & Quick Action clicks work, host token enforced, consumer handle stays restricted', async () => {
  const { doc, win } = makeMockDom('https://antigravity.google.com/workspace');
  const kernel = createRendererKernel(doc, win);
  let settingsSelected = 0;
  let actionInvoked = 0;
  let capturedHandle = null;

  const boot = await bootRemoteWebHost({
    doc,
    win,
    profile: ANTIGRAVITY_REMOTE_WEB_PROFILE,
    kernel,
    packedAddons: [
      {
        pluginMeta: {
          schemaVersion: 2,
          pluginId: 'interactive-addon',
          displayName: 'Interactive Addon',
          version: '1.0.0',
          trustLevel: 'restricted',
          capabilities: ['renderer'],
          uiSlots: [],
        },
        run(addonHost) {
          capturedHandle = addonHost;
          addonHost.registerSettingsTab('prefs', {
            label: 'Open Preferences',
            onSelect() {
              settingsSelected += 1;
            },
          });
          addonHost.registerAction('toggle-mode', {
            label: 'Toggle Mode',
            run() {
              actionInvoked += 1;
              return { toggled: true };
            },
          });
        },
      },
    ],
  });
  assert.equal(boot.ok, true);

  // Consumer handle MUST NOT expose privileged host methods
  assert.equal('selectSettingsTab' in capturedHandle, false);
  assert.equal('listHostActions' in capturedHandle, false);
  assert.equal('invokeHostAction' in capturedHandle, false);

  // Wrong host token rejected fail-closed
  assert.throws(() => kernel.selectSettingsTab('interactive-addon', 'prefs', 'wrong-token'), /ERR_FORBIDDEN_HOST_TOKEN/);
  assert.throws(() => kernel.listHostActions('wrong-token'), /ERR_FORBIDDEN_HOST_TOKEN/);
  assert.throws(() => kernel.invokeHostAction('interactive-addon', 'toggle-mode', [], 'wrong-token'), /ERR_FORBIDDEN_HOST_TOKEN/);

  // Open drawer and click Quick Action inside Addons tab
  const sr = boot.controller.drawerUi.shadowRoot;
  const pill = sr.querySelector('.rah-pill');
  const panel = sr.querySelector('#rah-drawer-panel');
  pill.click();
  assert.equal(panel.hasAttribute('hidden'), false);

  const actionBtn = sr.querySelector('[data-host-action-plugin="interactive-addon"][data-host-action-id="toggle-mode"]');
  assert.ok(actionBtn, 'Quick Action button should render inside addon card');
  actionBtn.click();
  assert.equal(actionInvoked, 1);

  // Switch to Settings Tabs view and click Settings Tab button -> invokes onSelect & auto-closes drawer
  const navTabs = sr.querySelectorAll('.rah-tab');
  navTabs[1].click();
  const settingsBtn = sr.querySelector('[data-settings-tab-action="select"]');
  assert.ok(settingsBtn, 'Clickable Settings Tab button should render');
  settingsBtn.click();
  assert.equal(settingsSelected, 1);
  assert.equal(panel.hasAttribute('hidden'), true, 'Drawer should auto-close after opening plugin settings tab');

  boot.controller.dispose();
});

test('TC-U4: GM storage adapter priority (gm-sync, gm-async + hydrateSettings, localStorage, memory-ephemeral)', async () => {
  // 1. GM sync storage (GM_getValue / GM_setValue / GM_deleteValue)
  const syncStore = new Map();
  const syncWin = {
    GM_getValue(k, def) {
      return syncStore.has(k) ? syncStore.get(k) : def;
    },
    GM_setValue(k, v) {
      syncStore.set(k, v);
    },
    GM_deleteValue(k) {
      syncStore.delete(k);
    },
  };
  const bSync = createRemoteHostBridge({ win: syncWin, profileId: 'p-sync', storageNamespace: 'ns-sync' });
  assert.equal(bSync.getStatus().storageKind, 'gm-sync');
  bSync.bindSettingsPlugin('plug-a', { fileName: 'a.json', maxBytes: 4096 });
  const saveSync = await bSync.port.saveSettings('plug-a', JSON.stringify({ lang: 'ko' }));
  assert.equal(saveSync.ok, true);
  const syncSnap = bSync.loadPersistedSettings('plug-a');
  assert.equal(syncSnap.status, 'ok');
  assert.equal(syncSnap.persistence, 'gm-sync');
  assert.deepEqual(syncSnap.data, { lang: 'ko' });
  bSync.dispose();

  // 2. GM async storage (GM.getValue / GM.setValue) with hydrateSettings()
  const asyncStore = new Map();
  const asyncWin = {
    GM: {
      async getValue(k, def) {
        return asyncStore.has(k) ? asyncStore.get(k) : def;
      },
      async setValue(k, v) {
        asyncStore.set(k, v);
      },
      async deleteValue(k) {
        asyncStore.delete(k);
      },
    },
  };
  const bAsyncWriter = createRemoteHostBridge({ win: asyncWin, profileId: 'p-async', storageNamespace: 'ns-async' });
  assert.equal(bAsyncWriter.getStatus().storageKind, 'gm-async');
  bAsyncWriter.bindSettingsPlugin('plug-b', { fileName: 'b.json', maxBytes: 4096 });
  const initialAsyncSave = await bAsyncWriter.port.saveSettings('plug-b', JSON.stringify({ mode: 'async-restored' }));
  assert.equal(initialAsyncSave.ok, true);
  bAsyncWriter.dispose();

  // Fresh bridge instance simulates page reload: cache empty before hydrateSettings, restored after hydrateSettings
  const bAsync = createRemoteHostBridge({ win: asyncWin, profileId: 'p-async', storageNamespace: 'ns-async' });
  assert.equal(bAsync.getStatus().storageKind, 'gm-async');
  bAsync.bindSettingsPlugin('plug-b', { fileName: 'b.json', maxBytes: 4096 });
  assert.equal(bAsync.loadPersistedSettings('plug-b'), null);
  await bAsync.hydrateSettings('plug-b');
  const asyncSnap = bAsync.loadPersistedSettings('plug-b');
  assert.equal(asyncSnap.status, 'ok');
  assert.equal(asyncSnap.persistence, 'gm-async');
  assert.deepEqual(asyncSnap.data, { mode: 'async-restored' });
  const saveAsync = await bAsync.port.saveSettings('plug-b', JSON.stringify({ mode: 'updated' }));
  assert.equal(saveAsync.ok, true);
  assert.equal(JSON.parse(asyncStore.get('ns-async:settings:plug-b')).data.mode, 'updated');
  bAsync.dispose();

  // 3. localStorage fallback when no GM APIs exist
  const lsMap = new Map();
  const lsWin = {
    localStorage: {
      getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
      setItem: (k, v) => lsMap.set(k, String(v)),
      removeItem: (k) => lsMap.delete(k),
    },
  };
  const bLs = createRemoteHostBridge({ win: lsWin, profileId: 'p-ls' });
  assert.equal(bLs.getStatus().storageKind, 'localStorage');
  bLs.dispose();

  // 4. Ephemeral memory fallback when neither GM nor localStorage exists
  const bMem = createRemoteHostBridge({ win: {}, profileId: 'p-mem' });
  assert.equal(bMem.getStatus().storageKind, 'memory-ephemeral');
  bMem.dispose();
});

test('TC-U5: 0-dep ISO/IEC 18004 QR encoder & ephemeral tokenized LAN HTTP server security + --once auto-close', async () => {
  // 1. QR matrix structure: finder patterns, timing patterns, versions 1..7, ASCII half-blocks
  for (const sample of [
    'http://192.168.0.5:8080/a',
    'http://192.168.1.42:54321/0123456789abcdef0123456789abcdef/',
    'https://example.com/' + 'x'.repeat(130),
  ]) {
    const qr = encodeQrMatrix(sample);
    const expectedSize = 21 + 4 * (qr.version - 1);
    assert.equal(qr.size, expectedSize);
    assert.equal(qr.modules.length, expectedSize);
    // Top-left, top-right, bottom-left finder centers (3x3 solid dark core)
    assert.equal(qr.modules[3][3], 1);
    assert.equal(qr.modules[3][expectedSize - 4], 1);
    assert.equal(qr.modules[expectedSize - 4][3], 1);
    // Timing pattern alternating on row 6 & col 6
    assert.equal(qr.modules[6][8], 1);
    assert.equal(qr.modules[6][9], 0);
    assert.equal(qr.modules[8][6], 1);
    assert.equal(qr.modules[9][6], 0);
    const ascii = renderQrAscii(qr);
    assert.ok(ascii.includes('█') && (ascii.includes('▀') || ascii.includes('▄')));
  }

  // LAN IP picker prefers physical private IPv4 over virtual WSL/Docker interfaces
  const picked = pickLanIpv4Address({
    'vEthernet (WSL)': [{ family: 'IPv4', internal: false, address: '172.22.1.1' }],
    'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.168.0.25' }],
  });
  assert.equal(picked, '192.168.0.25');

  // 2. Ephemeral LAN HTTP server security & --once auto-close
  const tmpDir = makeTmpDir('agy-v27-lan-');
  let srvHandle = null;
  try {
    const built = buildDistRemote({ targetDir: tmpDir, noAddons: true, hostVersion: '2.7.0' });
    assert.equal(built.ok, true);

    let closedReason = null;
    srvHandle = await startRemoteLanServer({
      distDir: tmpDir,
      bindHost: '127.0.0.1',
      advertiseHost: '127.0.0.1',
      port: 0,
      ttlSec: 30,
      once: true,
      onClose: (info) => {
        closedReason = info && info.reason ? info.reason : info;
      },
    });
    assert.match(srvHandle.token, /^[a-f0-9]{32}$/);
    assert.ok(srvHandle.qrAscii.length > 40);
    const baseOrigin = `http://127.0.0.1:${srvHandle.port}`;

    // 405 on POST
    const postRes = await httpRequest(srvHandle.installUrl, 'POST');
    assert.equal(postRes.statusCode, 405);
    assert.equal(postRes.headers['cache-control'], 'no-store');
    assert.equal(postRes.headers['x-content-type-options'], 'nosniff');

    // 404 on wrong token and traversal attempts
    const badTok = await httpRequest(`${baseOrigin}/00000000000000000000000000000000/antigravity-remote.user.js`);
    assert.equal(badTok.statusCode, 404);
    const trav1 = await httpRequest(`${baseOrigin}/${srvHandle.token}/..%2fpackage.json`);
    assert.equal(trav1.statusCode, 404);
    const trav2 = await httpRequest(`${baseOrigin}/${srvHandle.token}/%2e%2e/build-manifest.json`);
    assert.equal(trav2.statusCode, 404);

    // 200 on landing HTML, .meta.js, .lib.js
    const landing = await httpRequest(srvHandle.installUrl);
    assert.equal(landing.statusCode, 200);
    assert.equal(landing.headers['cache-control'], 'no-store');
    assert.equal(landing.headers['referrer-policy'], 'no-referrer');
    assert.ok(landing.body.includes('antigravity-remote.user.js'));

    const metaRes = await httpRequest(srvHandle.metaUrl);
    assert.equal(metaRes.statusCode, 200);
    assert.ok(metaRes.body.includes('// ==UserScript=='));

    const libRes = await httpRequest(srvHandle.hostLibUrl);
    assert.equal(libRes.statusCode, 200);
    assert.equal(libRes.body.includes('// ==UserScript=='), false);

    // 200 on .user.js triggers --once auto-close
    const userRes = await httpRequest(srvHandle.userscriptUrl);
    assert.equal(userRes.statusCode, 200);
    assert.ok(userRes.body.includes('// @inject-into  content'));

    await new Promise((r) => setTimeout(r, 300));
    assert.equal(closedReason, 'once_completed');
  } finally {
    if (srvHandle) await srvHandle.close('test-cleanup');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
