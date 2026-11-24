'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  readRemotePreferencesFile,
  isAddonEnabledInRemotePreferences,
  writeRemotePreferencesFileAtomic,
  createHostAdminService,
} = require('../../src/runtime/main/host-admin-service');
const { createHostSettingsUi, NAV_ATTR, PANE_ATTR } = require('../../src/runtime/renderer/host-settings-ui');
const { createRendererKernel } = require('../../src/runtime/renderer/kernel');
const { loadRawManifestsFromDir, buildHostLoaderScriptSource } = require('../../src/adapters/electron/host-loader-builder');
const { planAddonExecution } = require('../../src/core/lifecycle-coordinator');
const { createNodeFileSystemPort } = require('../../src/adapters/node-fs-port');
const { collectRemoteWebAddons } = require('../../src/adapters/remote-web/addon-collector');
const { ANTIGRAVITY_HOST_PROFILE, resolveAntigravityPaths } = require('../../src/profiles/antigravity');
const { ANTIGRAVITY_REMOTE_WEB_PROFILE } = require('../../src/profiles/antigravity-remote-web');
const { buildRendererKernelBundleSource } = require('../../scripts/build-runtime');
const { verifyRemoteBundleAst, parseCliArgs } = require('../../scripts/build-remote');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function createFakeDom() {
  class FakeElement {
    constructor(tagName, ownerDoc) {
      this.tagName = String(tagName || 'div').toUpperCase();
      this.nodeType = 1;
      this.ownerDocument = ownerDoc;
      this.parentElement = null;
      this.parentNode = null;
      this.children = [];
      this.childNodes = [];
      this.attributes = new Map();
      this.style = {};
      this.listeners = new Map();
      this.shadowRoot = null;
      this.disabled = false;
      this._text = '';
      this.className = '';
    }

    get isConnected() {
      let cur = this;
      while (cur) {
        if (cur === this.ownerDocument.documentElement || cur === this.ownerDocument.body) return true;
        cur = cur.parentNode;
      }
      return false;
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

    setAttribute(k, v) {
      this.attributes.set(String(k), String(v));
      if (k === 'class') this.className = String(v);
    }

    getAttribute(k) {
      return this.attributes.has(String(k)) ? this.attributes.get(String(k)) : null;
    }

    removeAttribute(k) {
      this.attributes.delete(String(k));
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

    insertBefore(child, ref) {
      if (!ref) return this.appendChild(child);
      if (!child) return child;
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      child.parentElement = this.nodeType === 1 ? this : null;
      const ci = this.childNodes.indexOf(ref);
      if (ci >= 0) this.childNodes.splice(ci, 0, child);
      else this.childNodes.push(child);
      if (child.nodeType === 1) {
        const ei = this.children.indexOf(ref);
        if (ei >= 0) this.children.splice(ei, 0, child);
        else this.children.push(child);
      }
      return child;
    }

    removeChild(child) {
      const idx = this.childNodes.indexOf(child);
      if (idx !== -1) this.childNodes.splice(idx, 1);
      const cIdx = this.children.indexOf(child);
      if (cIdx !== -1) this.children.splice(cIdx, 1);
      child.parentNode = null;
      child.parentElement = null;
      return child;
    }

    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    }

    cloneNode(deep) {
      const copy = new FakeElement(this.tagName, this.ownerDocument);
      copy.className = this.className;
      for (const [k, v] of this.attributes.entries()) copy.attributes.set(k, v);
      copy.style = { ...this.style };
      if (deep) {
        for (const ch of this.childNodes) {
          copy.appendChild(ch.cloneNode(true));
        }
      }
      return copy;
    }

    attachShadow({ mode }) {
      const sr = new FakeElement('#shadow-root', this.ownerDocument);
      sr.nodeType = 11;
      sr.mode = mode;
      sr.host = this;
      this.shadowRoot = sr;
      return sr;
    }

    addEventListener(type, fn, capture = false) {
      const key = `${type}:${capture ? 'cap' : 'bub'}`;
      if (!this.listeners.has(key)) this.listeners.set(key, []);
      this.listeners.get(key).push(fn);
    }

    removeEventListener(type, fn, capture = false) {
      const key = `${type}:${capture ? 'cap' : 'bub'}`;
      const list = this.listeners.get(key);
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx !== -1) list.splice(idx, 1);
    }

    dispatchClick() {
      if (this.disabled) return;
      const ev = {
        target: this,
        defaultPrevented: false,
        stopped: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopPropagation() {
          this.stopped = true;
        },
      };
      // Capture phase top-down
      const ancestors = [];
      let cur = this.parentNode;
      while (cur) {
        ancestors.unshift(cur);
        cur = cur.parentNode;
      }
      for (const anc of ancestors) {
        const cap = anc.listeners.get('click:cap') || [];
        for (const fn of cap.slice()) fn(ev);
      }
      const own = this.listeners.get('click:bub') || [];
      for (const fn of own.slice()) fn(ev);
      if (!ev.stopped) {
        for (let i = ancestors.length - 1; i >= 0; i -= 1) {
          const bub = ancestors[i].listeners.get('click:bub') || [];
          for (const fn of bub.slice()) fn(ev);
          if (ev.stopped) break;
        }
      }
    }

    contains(node) {
      let cur = node;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentNode;
      }
      return false;
    }

    matches(selector) {
      const parts = String(selector || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const p of parts) {
        if (p.startsWith('[') && p.endsWith(']')) {
          const inner = p.slice(1, -1);
          const eq = inner.indexOf('=');
          if (eq === -1) {
            if (this.attributes.has(inner)) return true;
          } else {
            const k = inner.slice(0, eq).trim();
            const val = inner.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
            if (this.getAttribute(k) === val) return true;
          }
        } else if (p.startsWith('.')) {
          const cls = p.slice(1);
          if (String(this.className || '').split(/\s+/).includes(cls)) return true;
        } else if (p.toUpperCase() === this.tagName) {
          return true;
        }
      }
      return false;
    }

    closest(selector) {
      let cur = this;
      while (cur && cur.nodeType === 1) {
        if (cur.matches(selector)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }

    querySelectorAll(selector) {
      const out = [];
      const walk = (node) => {
        for (const ch of node.children || []) {
          if (ch.matches(selector)) out.push(ch);
          walk(ch);
        }
      };
      walk(this);
      return out;
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
  }

  class FakeTextNode {
    constructor(text) {
      this.nodeType = 3;
      this.textContent = String(text);
      this.parentNode = null;
      this.parentElement = null;
    }
    cloneNode() {
      return new FakeTextNode(this.textContent);
    }
  }

  const doc = {
    documentElement: null,
    body: null,
    head: null,
    createElement(tag) {
      return new FakeElement(tag, doc);
    },
    createElementNS(_ns, tag) {
      return new FakeElement(tag, doc);
    },
    createTextNode(text) {
      return new FakeTextNode(text);
    },
    querySelectorAll(selector) {
      return doc.documentElement.querySelectorAll(selector);
    },
    querySelector(selector) {
      return doc.documentElement.querySelector(selector);
    },
  };
  doc.documentElement = new FakeElement('html', doc);
  doc.documentElement.lang = 'ko';
  doc.head = new FakeElement('head', doc);
  doc.body = new FakeElement('body', doc);
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);

  return { doc, FakeElement };
}

function setupFixtureEnv() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-v25-'));
  const hostDataDir = path.join(tmpDir, '.gemini', 'antigravity');
  const addonsDir = path.join(hostDataDir, 'addons.d');
  const pluginsRootDir = path.join(tmpDir, '.gemini', 'config', 'plugins');
  const remoteDistDir = path.join(hostDataDir, 'remote-dist');
  const trustPolicyPath = path.join(hostDataDir, 'trust-policy.json');
  const remotePrefsPath = path.join(hostDataDir, 'remote-preferences.json');

  fs.mkdirSync(addonsDir, { recursive: true });
  fs.mkdirSync(pluginsRootDir, { recursive: true });

  // 1. Trusted renderer plugin (remote-compatible)
  const p1Dir = path.join(pluginsRootDir, 'ko-translator');
  fs.mkdirSync(p1Dir, { recursive: true });
  const p1Src = "'use strict'; void addonHost.pluginId;\n";
  const p1Script = path.join(p1Dir, 'renderer.js');
  fs.writeFileSync(p1Script, p1Src, 'utf8');
  fs.writeFileSync(
    path.join(addonsDir, 'ko-translator.json'),
    JSON.stringify({
      schemaVersion: 2,
      pluginId: 'ko-translator',
      displayName: 'Korean Translator',
      version: '2.3.0',
      loadOrder: 10,
      trustLevel: 'trusted',
      capabilities: ['renderer'],
      entry: { rendererScript: 'renderer.js' },
      compatibility: { hostProfile: 'antigravity-desktop', minHostVersion: '2.0.0' },
      uiSlots: [{ slot: 'document-transform', slotId: 'ko-translator.doc', scope: 'native-host-only', shadow: false }],
      isolation: { noTranslate: false, i18nSelfManaged: true, respectsNoTranslate: true },
    }),
    'utf8'
  );

  // 2. Restricted renderer plugin (remote-compatible)
  const p2Dir = path.join(pluginsRootDir, 'statusbar-ui');
  fs.mkdirSync(p2Dir, { recursive: true });
  const p2Src = "'use strict'; void addonHost.pluginId;\n";
  fs.writeFileSync(path.join(p2Dir, 'renderer.js'), p2Src, 'utf8');
  fs.writeFileSync(
    path.join(addonsDir, 'statusbar-ui.json'),
    JSON.stringify({
      schemaVersion: 2,
      pluginId: 'statusbar-ui',
      displayName: 'Statusbar UI',
      version: '1.2.0',
      loadOrder: 20,
      trustLevel: 'restricted',
      capabilities: ['renderer'],
      entry: { rendererScript: 'renderer.js' },
      compatibility: { hostProfile: 'antigravity-desktop', minHostVersion: '2.0.0' },
      uiSlots: [{ slot: 'status-bar', slotId: 'statusbar-ui.bar' }],
      isolation: { noTranslate: true, i18nSelfManaged: false },
    }),
    'utf8'
  );

  // 3. Desktop-only mainHook plugin (NOT compatible with Remote Web)
  const p3Dir = path.join(pluginsRootDir, 'desktop-hook-only');
  fs.mkdirSync(p3Dir, { recursive: true });
  const p3Src = "'use strict'; module.exports = function() {};\n";
  fs.writeFileSync(path.join(p3Dir, 'main-hook.js'), p3Src, 'utf8');
  fs.writeFileSync(
    path.join(addonsDir, 'desktop-hook-only.json'),
    JSON.stringify({
      schemaVersion: 2,
      pluginId: 'desktop-hook-only',
      displayName: 'Desktop Hook Only',
      version: '1.0.0',
      loadOrder: 30,
      trustLevel: 'trusted',
      capabilities: ['mainHook'],
      entry: { mainHookScript: 'main-hook.js' },
      compatibility: { hostProfile: 'antigravity-desktop', minHostVersion: '2.0.0' },
      isolation: { noTranslate: true, i18nSelfManaged: false },
    }),
    'utf8'
  );

  fs.writeFileSync(
    trustPolicyPath,
    JSON.stringify({
      schemaVersion: 1,
      approved: {
        'ko-translator': { rendererSha256: sha256(p1Src) },
        'desktop-hook-only': { mainHookBundleSha256: sha256(p3Src) },
      },
    }),
    'utf8'
  );

  fs.mkdirSync(remoteDistDir, { recursive: true });
  fs.writeFileSync(
    path.join(remoteDistDir, 'build-manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      buildSha8: '1a25fb86',
      mode: 'packed',
      addons: [{ pluginId: 'ko-translator' }, { pluginId: 'statusbar-ui' }],
      files: { 'remote.user.js': 'abc', 'bookmarklet.txt': 'def' },
    }),
    'utf8'
  );
  fs.writeFileSync(path.join(remoteDistDir, 'remote.user.js'), '// userscript\n', 'utf8');
  fs.writeFileSync(path.join(remoteDistDir, 'bookmarklet.txt'), 'javascript:void(0)\n', 'utf8');

  return {
    tmpDir,
    hostDataDir,
    addonsDir,
    pluginsRootDir,
    remoteDistDir,
    trustPolicyPath,
    remotePrefsPath,
    cleanup() {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

test('TC-V25-001: SOLID #0 vendor neutrality & Acorn AST 0 violations for v2.5.0 host admin modules', () => {
  const hostAdminSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'runtime', 'main', 'host-admin-service.js'), 'utf8');
  const settingsUiSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'runtime', 'renderer', 'host-settings-ui.js'), 'utf8');

  for (const [label, src] of [
    ['host-admin-service.js', hostAdminSrc],
    ['host-settings-ui.js', settingsUiSrc],
  ]) {
    assert.equal(/antigravity/i.test(src), false, `${label} must not reference vendor name`);
    assert.equal(/data-agy-/i.test(src), false, `${label} must not hardcode vendor DOM attributes`);
    assert.equal(/\bAGY_/.test(src), false, `${label} must not hardcode vendor env/marker prefixes`);
  }

  const uiAst = verifyRemoteBundleAst(settingsUiSrc);
  assert.equal(uiAst.ok, true, `host-settings-ui.js AST violations: ${JSON.stringify(uiAst.violations)}`);

  const kernelBundleAst = verifyRemoteBundleAst(buildRendererKernelBundleSource());
  assert.equal(kernelBundleAst.ok, true, `kernel bundle AST violations: ${JSON.stringify(kernelBundleAst.violations)}`);
});

test('TC-V25-002: remote-preferences.json atomic persistence, validation & security guards', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-prefs-'));
  try {
    const prefsPath = path.join(tmpDir, 'remote-preferences.json');

    const empty = readRemotePreferencesFile(prefsPath);
    assert.equal(empty.ok, true);
    assert.equal(empty.exists, false);
    assert.equal(isAddonEnabledInRemotePreferences(empty, 'any-plugin'), true);

    const wr = writeRemotePreferencesFileAtomic(prefsPath, {
      schemaVersion: 1,
      updatedAt: '2026-11-24T00:00:00.000Z',
      addons: {
        'ko-translator': { enabled: false, updatedAt: '2026-11-24T00:00:00.000Z' },
        'statusbar-ui': { enabled: true, updatedAt: '2026-11-24T00:00:00.000Z' },
      },
    });
    assert.equal(wr.ok, true);

    const loaded = readRemotePreferencesFile(prefsPath);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.exists, true);
    assert.equal(isAddonEnabledInRemotePreferences(loaded, 'ko-translator'), false);
    assert.equal(isAddonEnabledInRemotePreferences(loaded, 'statusbar-ui'), true);
    assert.equal(isAddonEnabledInRemotePreferences(loaded, 'unlisted-plugin'), true);

    // Reject oversized write (>64KB)
    const oversized = writeRemotePreferencesFileAtomic(prefsPath, {
      schemaVersion: 1,
      addons: { big: 'x'.repeat(70000) },
    });
    assert.equal(oversized.ok, false);
    assert.equal(oversized.reason, 'ERR_REMOTE_PREFS_TOO_LARGE');

    // Reject directory path (non-regular file)
    const dirTarget = path.join(tmpDir, 'subdir');
    fs.mkdirSync(dirTarget);
    const dirRead = readRemotePreferencesFile(dirTarget);
    assert.equal(dirRead.ok, false);
    assert.equal(dirRead.error, 'ERR_REMOTE_PREFS_NON_REGULAR_OR_SYMLINK');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-V25-003: createHostAdminService aggregates desktop/remote status and toggles remote preferences', () => {
  const fx = setupFixtureEnv();
  try {
    const fsPort = createNodeFileSystemPort();
    const policy = JSON.parse(fs.readFileSync(fx.trustPolicyPath, 'utf8'));
    const svc = createHostAdminService({
      hostVersion: '2.5.0',
      buildSha8: 'abcd1234',
      profile: ANTIGRAVITY_HOST_PROFILE,
      addonsDir: fx.addonsDir,
      pluginsRootDir: fx.pluginsRootDir,
      remotePrefsPath: fx.remotePrefsPath,
      remoteDistDir: fx.remoteDistDir,
      strictTrustPolicy: true,
      fsPort,
      isEnabledInDesktopConfig: () => true,
      loadRawManifests: loadRawManifestsFromDir,
      planDesktopAddons: () =>
        planAddonExecution(loadRawManifestsFromDir(fx.addonsDir), {
          pluginsRootDir: fx.pluginsRootDir,
          checkFilesExist: true,
          hostProfileId: ANTIGRAVITY_HOST_PROFILE.id,
          supportedCapabilities: ANTIGRAVITY_HOST_PROFILE.supportedCapabilities,
          hostVersion: '2.5.0',
          strictTrustPolicy: true,
          fsPort,
          isEnabled: () => true,
        }),
      readCurrentPolicy: () => policy,
      getLifecycleStates: () => ({
        'ko-translator': 'ACTIVE',
        'statusbar-ui': 'ACTIVE',
        'desktop-hook-only': 'ACTIVE',
      }),
    });

    const initial = svc.getState();
    assert.equal(initial.ok, true);
    assert.equal(initial.summary.totalCount, 3);
    assert.equal(initial.summary.desktopActiveCount, 3);
    assert.equal(initial.summary.remoteEligibleCount, 2);
    assert.equal(initial.summary.remoteEnabledCount, 2);
    assert.equal(initial.remoteBundle.built, true);
    assert.equal(initial.remoteBundle.needsRebuild, false);
    assert.equal(initial.remoteBundle.hasUserscript, true);
    assert.equal(initial.remoteBundle.hasBookmarklet, true);

    const hookOnly = initial.addons.find((a) => a.pluginId === 'desktop-hook-only');
    assert.equal(hookOnly.desktopStatus, 'active');
    assert.equal(hookOnly.remoteEligible, false);
    assert.equal(hookOnly.remoteToggleable, false);
    assert.equal(hookOnly.remoteBlockedReason, 'ERR_UNSUPPORTED_HOST_CAPABILITY');

    // Invalid pluginId rejected
    const bad = svc.setRemoteAddonPreference('../escape', false);
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'ERR_INVALID_PLUGIN_ID');

    // Toggle ko-translator off for Remote Web
    const updated = svc.setRemoteAddonPreference('ko-translator', false);
    assert.equal(updated.ok, true);
    assert.equal(updated.state.summary.remoteEnabledCount, 1);
    assert.equal(updated.state.remoteBundle.needsRebuild, true);
    assert.equal(fs.existsSync(fx.remotePrefsPath), true);

    // Ensure ZERO files were written inside pluginsRootDir
    assert.equal(fs.existsSync(path.join(fx.pluginsRootDir, 'remote-preferences.json')), false);
  } finally {
    fx.cleanup();
  }
});

test('TC-V25-004: collectRemoteWebAddons & build-remote CLI honor remote-preferences.json and explicit null opt-out', () => {
  const fx = setupFixtureEnv();
  try {
    writeRemotePreferencesFileAtomic(fx.remotePrefsPath, {
      schemaVersion: 1,
      updatedAt: '2026-11-24T00:00:00.000Z',
      addons: { 'ko-translator': { enabled: false, updatedAt: '2026-11-24T00:00:00.000Z' } },
    });

    // Default resolves remote-preferences.json beside addons.d -> excludes ko-translator
    const resFiltered = collectRemoteWebAddons({
      profile: ANTIGRAVITY_REMOTE_WEB_PROFILE,
      addonsDir: fx.addonsDir,
      pluginsRootDir: fx.pluginsRootDir,
      configJsonPath: null,
      trustPolicyPath: fx.trustPolicyPath,
      hostVersion: '2.5.0',
    });
    assert.deepEqual(
      resFiltered.addons.map((a) => a.pluginMeta.pluginId),
      ['statusbar-ui']
    );
    assert.ok(
      resFiltered.disabled.some((d) => d.pluginId === 'ko-translator' && d.reason === 'DISABLED_BY_REMOTE_PREFERENCES')
    );

    // Explicit null opts out of remote-preferences.json -> includes both renderer addons
    const resAll = collectRemoteWebAddons({
      profile: ANTIGRAVITY_REMOTE_WEB_PROFILE,
      addonsDir: fx.addonsDir,
      pluginsRootDir: fx.pluginsRootDir,
      configJsonPath: null,
      trustPolicyPath: fx.trustPolicyPath,
      remotePrefsPath: null,
      hostVersion: '2.5.0',
    });
    assert.deepEqual(
      resAll.addons.map((a) => a.pluginMeta.pluginId).sort(),
      ['ko-translator', 'statusbar-ui']
    );

    // CLI arg parsing for --remote-prefs
    const defaultArgs = parseCliArgs([]);
    assert.equal(defaultArgs.remotePrefsPath, undefined);
    const customArgs = parseCliArgs(['--remote-prefs', fx.remotePrefsPath]);
    assert.equal(customArgs.remotePrefsPath, path.resolve(fx.remotePrefsPath));
  } finally {
    fx.cleanup();
  }
});

test('TC-V25-005: Consumer addonHost handle never exposes host admin methods; loader forwards v2.5.0 config', () => {
  const { doc } = createFakeDom();
  const kernel = createRendererKernel(doc, {});
  const fakeBridge = {
    docGenId: 1,
    profileId: 'antigravity-desktop',
    reportError: () => {},
    setPortalClaim: async () => ({ ok: true }),
    saveSettings: async () => ({ ok: true, snapshot: {} }),
    ping: async () => ({ ok: true }),
    getHostAdminState: async () => ({ ok: true, addons: [], summary: {}, host: {}, remoteBundle: {} }),
    setRemoteAddonPreference: async () => ({ ok: true }),
  };

  const boot = kernel.boot({
    docGenId: 1,
    hostProfileId: 'antigravity-desktop',
    hostToken: 'secret-host-token-123456',
    hostBridge: fakeBridge,
    settingsUi: ANTIGRAVITY_HOST_PROFILE.settingsUi,
  });
  assert.equal(boot.ok, true);
  assert.equal(boot.hasHostSettingsUi, true);

  const handle = kernel.createPluginHandle(
    { pluginId: 'trusted-plugin', version: '1.0.0', trustLevel: 'trusted' },
    'secret-host-token-123456'
  );
  assert.equal('getHostAdminState' in handle, false);
  assert.equal('setRemoteAddonPreference' in handle, false);
  assert.equal('hostBridge' in handle, false);

  // Loader shim forwards uiSurfaces, settingsUi, remoteProfileId, remotePrefsPath, remoteDistDir
  const paths = resolveAntigravityPaths({ HOME: os.tmpdir(), USERPROFILE: os.tmpdir() });
  const shimSource = buildHostLoaderScriptSource(paths, ANTIGRAVITY_HOST_PROFILE, {
    hostVersion: '2.5.0',
    buildSha8: 'testsha8',
  });
  assert.match(shimSource, /"settingsUi":/);
  assert.match(shimSource, /"uiSurfaces":/);
  assert.match(shimSource, /"remoteProfileId":"antigravity-remote-web"/);
  assert.match(shimSource, /"remotePrefsPath":/);
  assert.match(shimSource, /"remoteDistDir":/);

  // Long Windows CI temp paths must remain strictly under the 4096-byte thin-shim cap
  const longWinBase = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\addon-host-v2-tc008-long-ci-runner-dir-999999';
  const longShim = buildHostLoaderScriptSource(
    {
      ADDONS_DIR: `${longWinBase}\\addons.d`,
      PLUGINS_ROOT_DIR: `${longWinBase}\\plugins`,
      CONFIG_JSON_PATH: `${longWinBase}\\config.json`,
      TRUST_POLICY_PATH: `${longWinBase}\\trust-policy.json`,
    },
    ANTIGRAVITY_HOST_PROFILE,
    { hostVersion: '2.5.0', buildSha8: 'testsha8' }
  );
  assert.equal(longShim.length < 4096, true, `Long-path shim exceeded 4096 bytes: ${longShim.length}`);
  assert.match(longShim, /const _B = /);
});

test('TC-V25-006: Built-in host-settings-ui mounts Korean Settings tab, toggles Remote Web, and coexists with peer tabs', async () => {
  const { doc } = createFakeDom();

  // Build mock Korean Settings modal with sidebar title + nav list + peer MCP Manager tab + close button
  const modal = doc.createElement('div');
  modal.className = 'settings-modal-container';
  const sidebarCol = doc.createElement('aside');
  const sidebarTitle = doc.createElement('div');
  sidebarTitle.textContent = '설정';
  const sidebar = doc.createElement('nav');
  const navGeneral = doc.createElement('button');
  navGeneral.textContent = '일반';
  const navBrowser = doc.createElement('button');
  navBrowser.textContent = '브라우저';
  const navMcp = doc.createElement('button');
  navMcp.setAttribute('data-agy-mcp-settings-nav', 'true');
  navMcp.textContent = 'MCP Manager';
  sidebar.appendChild(navGeneral);
  sidebar.appendChild(navBrowser);
  sidebar.appendChild(navMcp);
  sidebarCol.appendChild(sidebarTitle);
  sidebarCol.appendChild(sidebar);

  const contentPane = doc.createElement('main');
  const closeBtn = doc.createElement('button');
  closeBtn.setAttribute('aria-label', '닫기');
  closeBtn.textContent = '×';
  const nativeBody = doc.createElement('div');
  nativeBody.textContent = '일반 설정 내용';
  contentPane.appendChild(closeBtn);
  contentPane.appendChild(nativeBody);

  modal.appendChild(sidebarCol);
  modal.appendChild(contentPane);
  doc.body.appendChild(modal);

  let currentRemoteEnabled = true;
  const makeState = () => ({
    ok: true,
    host: { version: '2.5.0', buildSha8: '1234abcd', profileId: 'antigravity-desktop', remoteProfileId: 'antigravity-remote-web' },
    summary: {
      totalCount: 2,
      desktopActiveCount: 2,
      remoteEligibleCount: 1,
      remoteEnabledCount: currentRemoteEnabled ? 1 : 0,
    },
    addons: [
      {
        pluginId: 'ko-translator',
        displayName: '한국어 번역기',
        version: '2.3.0',
        trustLevel: 'trusted',
        trustApproved: true,
        capabilities: ['renderer'],
        hasSettingsBridge: true,
        hasConfigBridge: false,
        desktopStatus: 'active',
        remoteEligible: true,
        remoteEnabled: currentRemoteEnabled,
        remoteToggleable: true,
        remoteBlockedReason: null,
      },
      {
        pluginId: 'mcp-manager',
        displayName: 'MCP Manager',
        version: '1.0.0',
        trustLevel: 'trusted',
        trustApproved: true,
        capabilities: ['mainHook'],
        hasSettingsBridge: false,
        hasConfigBridge: true,
        desktopStatus: 'active',
        remoteEligible: false,
        remoteEnabled: false,
        remoteToggleable: false,
        remoteBlockedReason: 'ERR_UNSUPPORTED_HOST_CAPABILITY',
      },
    ],
    remoteBundle: {
      built: true,
      buildSha8: '1a25fb86',
      needsRebuild: !currentRemoteEnabled,
      hasBookmarklet: true,
      bookmarkletText: 'javascript:void(0)',
      buildCommand: 'addon-host --build-remote',
    },
  });

  const toggleCalls = [];
  const ui = createHostSettingsUi(doc, {}, {
    settingsUi: ANTIGRAVITY_HOST_PROFILE.settingsUi,
    extraNoTranslateAttributes: ANTIGRAVITY_HOST_PROFILE.extraNoTranslateAttributes,
    hostBridge: {
      getHostAdminState: async () => makeState(),
      setRemoteAddonPreference: async (pluginId, enabled) => {
        toggleCalls.push({ pluginId, enabled });
        currentRemoteEnabled = enabled;
        return { ok: true, pluginId, enabled, state: makeState() };
      },
    },
  });

  assert.equal(ui.ensureMount(), true);
  const { navElement } = ui.getElements();
  assert.ok(navElement);
  assert.equal(navElement.getAttribute(NAV_ATTR), 'true');
  assert.equal(navElement.getAttribute('data-agy-no-translate'), 'true');
  assert.equal(navElement.getAttribute('translate'), 'no');
  assert.equal(navElement.textContent, '애드온 관리');

  // Open panel by clicking nav item
  navElement.dispatchClick();
  await new Promise((r) => setImmediate(r));

  assert.equal(ui.isOpen(), true);
  assert.equal(nativeBody.style.display, 'none');
  assert.notEqual(closeBtn.style.display, 'none', 'Close button must remain visible');

  const { paneHostElement, shadowRoot } = ui.getElements();
  assert.equal(paneHostElement.getAttribute(PANE_ATTR), 'true');
  assert.ok(shadowRoot);

  const switches = shadowRoot.querySelectorAll('[role="switch"]');
  assert.equal(switches.length, 2);
  assert.equal(switches[0].getAttribute('aria-checked'), 'true');
  assert.equal(switches[0].disabled, false);
  assert.equal(switches[1].disabled, true);

  // Toggle ko-translator off for Remote Web
  switches[0].dispatchClick();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(toggleCalls, [{ pluginId: 'ko-translator', enabled: false }]);

  const updatedSwitches = shadowRoot.querySelectorAll('[role="switch"]');
  assert.equal(updatedSwitches[0].getAttribute('aria-checked'), 'false');

  // Clicking peer tab (MCP Manager) closes our pane and restores native children cleanly
  navMcp.dispatchClick();
  assert.equal(ui.isOpen(), false);
  assert.equal(paneHostElement.style.display, 'none');
  assert.equal(nativeBody.style.display, '');

  ui.dispose();
});

test('TC-V25-007: host-settings-ui mounts reliably across div/li/wrapped/icon-split/deep-nested Settings sidebars and syncs language', async () => {
  const hostBridge = {
    getHostAdminState: async () => ({
      ok: true,
      host: { version: '2.5.1', buildSha8: '1234abcd', profileId: 'antigravity-desktop' },
      summary: { totalCount: 0, desktopActiveCount: 0, remoteEligibleCount: 0, remoteEnabledCount: 0 },
      addons: [],
      remoteBundle: { built: false, needsRebuild: true, buildCommand: 'addon-host --build-remote' },
    }),
    setRemoteAddonPreference: async () => ({ ok: true }),
  };

  function buildSidebarDom(variant) {
    const { doc } = createFakeDom();
    const setRect = (el, r) => {
      el.getBoundingClientRect = () => r;
    };
    const modal = doc.createElement('div');
    setRect(modal, { left: 80, top: 40, width: 960, height: 680, right: 1040, bottom: 720 });
    const sidebar = doc.createElement('aside');
    setRect(sidebar, { left: 80, top: 40, width: 220, height: 680, right: 300, bottom: 720 });
    const content = doc.createElement('main');
    setRect(content, { left: 300, top: 40, width: 740, height: 680, right: 1040, bottom: 720 });

    // Top-right SVG-only close button (no aria-label or text, detected via geometry)
    const svgCloseBtn = doc.createElement('button');
    setRect(svgCloseBtn, { left: 996, top: 52, width: 32, height: 32, right: 1028, bottom: 84 });
    const nativePane = doc.createElement('div');
    nativePane.textContent = 'Native Settings Pane';
    content.appendChild(svgCloseBtn);
    content.appendChild(nativePane);

    modal.appendChild(sidebar);
    modal.appendChild(content);
    doc.body.appendChild(modal);

    let host = sidebar;
    const depthWrap = variant === 'deep-nesting' ? 7 : 1;
    for (let d = 0; d < depthWrap; d += 1) {
      const wrap = doc.createElement('div');
      setRect(wrap, { left: 88, top: 60, width: 204, height: 420, right: 292, bottom: 480 });
      host.appendChild(wrap);
      host = wrap;
    }

    const labels =
      variant === 'late-ko-translation'
        ? ['General', 'Application', 'Appearance', 'Shortcuts', 'Notifications', 'Models', 'Browser']
        : ['일반', '애플리케이션', '모양 및 테마', '단축키', '알림', '모델', '브라우저'];

    const createdItems = [];
    for (const label of labels) {
      if (variant === 'div-items' || variant === 'late-ko-translation') {
        const item = doc.createElement('div');
        item.textContent = label;
        setRect(item, { left: 88, top: 80, width: 200, height: 32, right: 288, bottom: 112 });
        host.appendChild(item);
        createdItems.push(item);
      } else if (variant === 'wrapped-li-buttons') {
        const li = doc.createElement('li');
        setRect(li, { left: 88, top: 80, width: 200, height: 32, right: 288, bottom: 112 });
        const btn = doc.createElement('button');
        btn.textContent = label;
        li.appendChild(btn);
        host.appendChild(li);
        createdItems.push(li);
      } else if (variant === 'icon-and-div-button') {
        const btn = doc.createElement('button');
        setRect(btn, { left: 88, top: 80, width: 200, height: 32, right: 288, bottom: 112 });
        const icon = doc.createElement('svg');
        const labelDiv = doc.createElement('div');
        labelDiv.textContent = label;
        btn.appendChild(icon);
        btn.appendChild(labelDiv);
        host.appendChild(btn);
        createdItems.push(btn);
      } else {
        const btn = doc.createElement('button');
        btn.textContent = label;
        setRect(btn, { left: 88, top: 80, width: 200, height: 32, right: 288, bottom: 112 });
        host.appendChild(btn);
        createdItems.push(btn);
      }
    }

    // Peer plugin nav slot right after Browser + separate Projects section below
    const peerSlot = doc.createElement('div');
    peerSlot.setAttribute('data-addon-host-slot', 'peer.settings-nav');
    peerSlot.setAttribute('data-addon-host-owner', 'peer-plugin');
    peerSlot.textContent = 'Peer Plugin';
    host.appendChild(peerSlot);

    const projectsHeading = doc.createElement('div');
    projectsHeading.textContent = variant === 'late-ko-translation' ? 'Projects' : '프로젝트';
    host.appendChild(projectsHeading);

    const projectLink = doc.createElement('div');
    projectLink.textContent = variant === 'late-ko-translation' ? 'Workspace' : '개발자';
    sidebar.appendChild(projectLink);

    return { doc, host, sidebar, svgCloseBtn, nativePane, peerSlot, projectsHeading, projectLink, createdItems };
  }

  for (const variant of ['div-items', 'wrapped-li-buttons', 'icon-and-div-button', 'deep-nesting']) {
    const { doc, host, svgCloseBtn, nativePane, peerSlot, projectsHeading, projectLink } = buildSidebarDom(variant);
    const ui = createHostSettingsUi(
      doc,
      { getComputedStyle: () => ({ backgroundColor: 'rgba(0, 0, 0, 0)', color: '#cbd5e1' }) },
      { hostBridge, settingsUi: ANTIGRAVITY_HOST_PROFILE.settingsUi }
    );
    assert.equal(ui.ensureMount(), true, `${variant} must mount host settings nav`);
    const { navElement } = ui.getElements();
    assert.ok(navElement, `${variant} navElement must exist`);
    assert.equal(navElement.textContent, '애드온 관리');
    assert.equal(navElement.parentElement, host, `${variant} must insert into shared listParent`);

    // Placement: immediately after peerSlot and BEFORE projectsHeading
    const idxPeer = host.children.indexOf(peerSlot);
    const idxNav = host.children.indexOf(navElement);
    const idxProj = host.children.indexOf(projectsHeading);
    assert.equal(idxNav, idxPeer + 1, `${variant} should sit right after peer settings slot`);
    assert.ok(idxNav < idxProj, `${variant} must stay above Projects section`);

    // Open panel -> SVG-only top-right close button stays visible, native pane hidden
    navElement.dispatchClick();
    await new Promise((r) => setImmediate(r));
    assert.equal(ui.isOpen(), true);
    assert.equal(nativePane.style.display, 'none');
    assert.notEqual(svgCloseBtn.style.display, 'none', `${variant} top-right SVG close button must stay visible`);

    // Clicking a Project link outside listParent (inside outerSidebar) closes our panel cleanly
    projectLink.dispatchClick();
    assert.equal(ui.isOpen(), false, `${variant} clicking outerSidebar project item must close panel`);
    assert.equal(nativePane.style.display, '');
    ui.dispose();
  }

  // Late Korean localization after initial English mount updates nav label dynamically
  const { doc, createdItems } = buildSidebarDom('late-ko-translation');
  doc.documentElement.lang = 'en';
  const uiLang = createHostSettingsUi(
    doc,
    { getComputedStyle: () => ({ backgroundColor: 'rgba(0, 0, 0, 0)', color: '#cbd5e1' }) },
    { hostBridge, settingsUi: ANTIGRAVITY_HOST_PROFILE.settingsUi }
  );
  assert.equal(uiLang.ensureMount(), true);
  assert.equal(uiLang.getElements().navElement.textContent, 'Addon Manager');
  createdItems[0].textContent = '일반';
  createdItems[6].textContent = '브라우저';
  assert.equal(uiLang.ensureMount(), true);
  assert.equal(uiLang.getElements().navElement.textContent, '애드온 관리');
  uiLang.dispose();
});
