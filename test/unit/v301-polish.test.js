'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { createRendererKernel } = require('../../src/runtime/renderer/kernel');
const { createHostSettingsUi, PLUGIN_NAV_ATTR } = require('../../src/runtime/renderer/host-settings-ui');
const { createSettingsPageCoordinator } = require('../../src/runtime/renderer/settings-page-coordinator');
const { buildAddonUserscript } = require('../../scripts/build-remote');
const { createTestHost } = require('../../packages/sdk/src/test-host');

test('v3.0.1: AddonContextV3 exposes primordial-hardened ctx.settingsBridge strictly when declared & cleans up on dispose', async () => {
  const host = createTestHost({
    surface: 'desktop',
    initialSettings: {
      'alpha-plugin': { status: 'ok', data: { enabled: true, mode: 'fast' } },
    },
  });

  const manifestWithBridge = {
    schemaVersion: 3,
    apiVersion: 3,
    pluginId: 'alpha-plugin',
    displayName: 'Alpha Plugin',
    version: '1.0.0',
    trustLevel: 'trusted',
    capabilities: ['renderer'],
    entry: { rendererScript: 'dist/renderer.js' },
    settingsBridge: { fileName: 'alpha_settings.json', maxBytes: 16384 },
    permissions: { ui: { overlays: true } },
  };

  const manifestWithoutBridge = {
    schemaVersion: 3,
    apiVersion: 3,
    pluginId: 'beta-plugin',
    displayName: 'Beta Plugin',
    version: '1.0.0',
    trustLevel: 'trusted',
    capabilities: ['renderer'],
    entry: { rendererScript: 'dist/renderer.js' },
    permissions: { ui: { overlays: true } },
  };

  const ctxWithout = await host.mountPlugin(manifestWithoutBridge);
  assert.equal(ctxWithout.env.capabilities.hasSettingsBridge, false);
  assert.equal(ctxWithout.settingsBridge, undefined, 'Undeclared settingsBridge must remain omitted (ISP)');

  const ctxWith = await host.mountPlugin(manifestWithBridge);
  assert.equal(ctxWith.env.capabilities.hasSettingsBridge, true);
  assert.ok(ctxWith.settingsBridge, 'Declared trusted settingsBridge must be exposed on AddonContextV3');
  assert.equal(Object.isFrozen(ctxWith.settingsBridge), true);
  assert.deepEqual(ctxWith.settingsBridge.getSettings(), { status: 'ok', data: { enabled: true, mode: 'fast' } });
  assert.deepEqual(ctxWith.settingsBridge.getSnapshot(), { status: 'ok', data: { enabled: true, mode: 'fast' } });

  const seen = [];
  const unsub = ctxWith.settingsBridge.onDidChange((snap) => seen.push(snap));
  const saveRes = await ctxWith.settingsBridge.saveSettings({ enabled: false, mode: 'local' });
  assert.equal(saveRes.ok, true);
  assert.equal(saveRes.snapshot.data.enabled, false);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].data.mode, 'local');
  assert.equal(ctxWith.settingsBridge.getSettings().data.mode, 'local');

  // Alias save() also works
  const saveRes2 = await ctxWith.settingsBridge.save({ enabled: true, mode: 'remote' });
  assert.equal(saveRes2.ok, true);
  assert.equal(seen.length, 2);

  unsub();
  await ctxWith.settingsBridge.save({ enabled: true, mode: 'silent' });
  assert.equal(seen.length, 2, 'Unsubscribed listener must not receive further updates');

  // Disposal blocks further settingsBridge access
  assert.equal(host.disposePlugin('alpha-plugin'), true);
  assert.throws(() => ctxWith.settingsBridge.getSettings(), /DISPOSED/i);
});

function createMinimalSettingsDom() {
  class FakeNode {
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
    get nextSibling() {
      if (!this.parentNode) return null;
      const idx = this.parentNode.childNodes.indexOf(this);
      return idx >= 0 ? this.parentNode.childNodes[idx + 1] || null : null;
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
    cloneNode(deep) {
      const copy = new FakeNode(this.tagName, this.ownerDocument);
      copy.className = this.className;
      copy._text = this._text;
      for (const [k, v] of this.attributes.entries()) copy.setAttribute(k, v);
      if (deep) {
        for (const ch of this.childNodes) {
          if (ch.nodeType === 3) {
            copy.appendChild(this.ownerDocument.createTextNode(ch.nodeValue));
          } else {
            copy.appendChild(ch.cloneNode(true));
          }
        }
      }
      return copy;
    }
    attachShadow() {
      const sr = new FakeNode('shadow-root', this.ownerDocument);
      sr.nodeType = 11;
      this.shadowRoot = sr;
      return sr;
    }
    contains(target) {
      if (target === this) return true;
      for (const ch of this.childNodes) {
        if (ch === target || (typeof ch.contains === 'function' && ch.contains(target))) return true;
      }
      return false;
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) {
      if (this.listeners.has(type)) this.listeners.get(type).delete(fn);
    }
    click() {
      const set = this.listeners.get('click');
      if (set) {
        for (const fn of Array.from(set)) fn({ target: this, preventDefault() {}, stopPropagation() {} });
      }
    }
    getBoundingClientRect() {
      return this._rect || { left: 0, top: 0, width: 220, height: 36, right: 220, bottom: 36 };
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
          if (String(this.className || '').split(/\s+/).includes(p.slice(1))) return true;
        } else if (this.tagName.toLowerCase() === p.toLowerCase()) {
          return true;
        }
      }
      return false;
    }
    querySelectorAll(selector) {
      const out = [];
      const walk = (n) => {
        for (const c of n.childNodes) {
          if (!c || c.nodeType !== 1) continue;
          if (c.matches(selector)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
  }

  const doc = {
    readyState: 'complete',
    createElement(tag) {
      return new FakeNode(tag, doc);
    },
    createTextNode(text) {
      return {
        nodeType: 3,
        nodeName: '#text',
        ownerDocument: doc,
        parentNode: null,
        nodeValue: String(text == null ? '' : text),
        get textContent() {
          return this.nodeValue;
        },
        set textContent(v) {
          this.nodeValue = String(v == null ? '' : v);
        },
      };
    },
    querySelectorAll(sel) {
      return doc.body.querySelectorAll(sel);
    },
    querySelector(sel) {
      return doc.body.querySelector(sel);
    },
    addEventListener() {},
    removeEventListener() {},
  };
  doc.documentElement = new FakeNode('html', doc);
  doc.documentElement.lang = 'en';
  doc.body = new FakeNode('body', doc);
  doc.documentElement.appendChild(doc.body);

  const win = {
    document: doc,
    innerWidth: 1280,
    innerHeight: 800,
    getComputedStyle: () => ({ display: 'flex', visibility: 'visible', opacity: '1', backgroundColor: 'transparent', color: '#cbd5e1' }),
    addEventListener() {},
    removeEventListener() {},
  };
  return { doc, win };
}

test('v3.0.1: Desktop HostSettingsUi mounts ui.registerSettingsPage in left sidebar AND Addon Manager cards reactively', async () => {
  const { doc, win } = createMinimalSettingsDom();

  const shell = doc.createElement('div');
  shell._rect = { left: 0, top: 0, width: 960, height: 640, right: 960, bottom: 640 };
  const sidebar = doc.createElement('div');
  sidebar._rect = { left: 0, top: 0, width: 220, height: 640, right: 220, bottom: 640 };
  const navList = doc.createElement('div');
  navList._rect = { left: 0, top: 0, width: 220, height: 400, right: 220, bottom: 400 };
  for (const label of ['General', 'Application', 'Appearance', 'Browser']) {
    const btn = doc.createElement('button');
    btn.setAttribute('type', 'button');
    const span = doc.createElement('span');
    span.appendChild(doc.createTextNode(label));
    btn.appendChild(span);
    navList.appendChild(btn);
  }
  sidebar.appendChild(navList);

  const contentPane = doc.createElement('div');
  contentPane._rect = { left: 220, top: 0, width: 740, height: 640, right: 960, bottom: 640 };
  const nativePanel = doc.createElement('div');
  nativePanel.textContent = 'Native Content';
  contentPane.appendChild(nativePanel);

  shell.appendChild(sidebar);
  shell.appendChild(contentPane);
  doc.body.appendChild(shell);

  const opened = [];
  const coordinator = createSettingsPageCoordinator({
    openTier3Modal: (pMeta, opts) => {
      const bodyEl = doc.createElement('div');
      opened.push({ pluginId: pMeta.pluginId, title: opts.title });
      return {
        bodyEl,
        close() {},
      };
    },
  });

  const adminState = {
    ok: true,
    host: { version: '3.0.1', buildSha8: 'abcd1234' },
    summary: { totalCount: 1, desktopActiveCount: 1, remoteEligibleCount: 1, remoteEnabledCount: 1 },
    addons: [
      {
        pluginId: 'sample-mcp',
        displayName: 'Sample MCP',
        version: '4.0.0',
        desktopStatus: 'active',
        trustLevel: 'trusted',
        trustApproved: true,
        capabilities: ['renderer'],
        remoteToggleable: true,
        remoteEnabled: true,
      },
    ],
    remoteBundle: { built: false, needsRebuild: true },
  };

  const ui = createHostSettingsUi(doc, win, {
    hostBridge: {
      getHostAdminState: async () => adminState,
      setRemoteAddonPreference: async () => ({ ok: true, state: adminState }),
    },
    settingsPageCoordinator: coordinator,
  });

  ui.start();
  assert.equal(ui.isMounted(), true);

  // Register a v3 plugin settings page AFTER mount -> appears live in left sidebar right below Addon Manager
  const pageHandle = coordinator.registerSettingsPage(
    { pluginId: 'sample-mcp', displayName: 'Sample MCP' },
    {
      id: 'mcp-manager',
      title: 'MCP Manager',
      render(canvasRoot) {
        const p = doc.createElement('p');
        p.textContent = 'MCP Settings Rendered';
        canvasRoot.appendChild(p);
      },
    }
  );

  const pluginNavBtn = navList.querySelector(`[${PLUGIN_NAV_ATTR}="sample-mcp:mcp-manager"]`);
  assert.ok(pluginNavBtn, 'Registered settings page must mount in Desktop Settings left sidebar');
  assert.equal(pluginNavBtn.textContent.trim(), 'MCP Manager');

  // Clicking sidebar item opens the settings page
  pluginNavBtn.click();
  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0], { pluginId: 'sample-mcp', title: 'MCP Manager' });

  // Opening Addon Manager panel also shows a Settings button on the addon card
  ui.openPanel();
  await new Promise((r) => setTimeout(r, 20));
  const { shadowRoot } = ui.getElements();
  const cardBtn = shadowRoot.querySelector('[data-ah-settings-page="sample-mcp:mcp-manager"]');
  assert.ok(cardBtn, 'Addon Manager card must expose a button to open registered settings page');
  cardBtn.click();
  assert.equal(opened.length, 2);

  // Disposing the settings page removes its sidebar button cleanly
  pageHandle.dispose();
  assert.equal(navList.querySelector(`[${PLUGIN_NAV_ATTR}="sample-mcp:mcp-manager"]`), null);

  ui.dispose();
});

test('v3.0.1: buildAddonUserscript emits AddonManifest.v3 in @description for schemaVersion 3 manifests', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'addons-v301-us-'));
  try {
    const pluginDir = path.join(tmpDir, 'plugin');
    const outDir = path.join(tmpDir, 'out');
    fs.mkdirSync(path.join(pluginDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'dist', 'renderer.js'), 'void 0;\n', 'utf8');
    const manifestPath = path.join(pluginDir, 'addon-manifest.v3.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 3,
        apiVersion: 3,
        pluginId: 'demo-v3-addon',
        displayName: 'Demo V3 Addon',
        version: '3.0.1',
        trustLevel: 'restricted',
        compatibility: {
          hostProfiles: ['antigravity-desktop', 'antigravity-remote-web'],
          surfaces: ['desktop', 'remote-web'],
          minHostVersion: '3.0.0',
        },
        capabilities: ['renderer'],
        entry: { rendererScript: 'dist/renderer.js' },
      }),
      'utf8'
    );

    const res = buildAddonUserscript({
      manifestPath,
      pluginDir,
      targetDir: outDir,
    });
    assert.equal(res.ok, true);
    const meta = fs.readFileSync(res.metaPath, 'utf8');
    assert.match(meta, /@description\s+Modular AddonManifest\.v3 Remote Web Userscript for Demo V3 Addon/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('v3.0.1: SDK createTestHost querySelectorAll handles text nodes safely + getSchema-only registerSettingsPage + mountCanvas token CSS', async () => {
  const host = createTestHost({ surface: 'desktop' });
  const container = host.doc.createElement('div');
  const textNode = host.doc.createTextNode('hello text node');
  const child = host.doc.createElement('button');
  child.setAttribute('data-role', 'action');
  container.appendChild(textNode);
  container.appendChild(child);

  assert.equal(container.querySelectorAll('[data-role="action"]').length, 1);
  assert.equal(container.querySelectorAll('button').length, 1);

  const ctx = await host.mountPlugin({
    schemaVersion: 3,
    apiVersion: 3,
    pluginId: 'dynamic-schema-plugin',
    displayName: 'Dynamic Schema Plugin',
    version: '1.0.0',
    trustLevel: 'restricted',
    capabilities: ['renderer'],
    entry: { rendererScript: 'dist/renderer.js' },
    uiSlots: [{ slot: 'canvas', slotId: 'dynamic.canvas', shadow: true }],
    permissions: { ui: { settingsPages: true, canvas: true } },
  });

  // getSchema-only page must not throw ERR_SETTINGS_PAGE_REQUIRES_SCHEMA_OR_RENDER
  const pageHandle = ctx.ui.registerSettingsPage({
    id: 'dyn-page',
    title: 'Dynamic Page',
    getSchema: () => ({ type: 'stack', children: [{ type: 'text', text: 'Dynamic OK' }] }),
  });
  const modal = pageHandle.open();
  assert.ok(modal);
  modal.close();
  pageHandle.dispose();
  host.disposePlugin('dynamic-schema-plugin');
});
