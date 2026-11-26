'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createStatusItemRegistry } = require('../../src/runtime/renderer/status-item-registry');
const { createThemeAndI18n } = require('../../src/runtime/renderer/theme-i18n');
const { createTestHost } = require('../../packages/sdk/src/test-host');

function createFakeDom({ bodyBg = 'rgb(15, 19, 26)', docElBg = '', lightOs = true, docThemeAttr = '', docClass = '' } = {}) {
  class FakeEl {
    constructor(tag) {
      this.tagName = String(tag || 'div').toUpperCase();
      this.attributes = new Map();
      this.childNodes = [];
      this.children = [];
      this.parentNode = null;
      this.shadowRoot = null;
      this.textContent = '';
      this.className = '';
      this.listeners = new Map();
    }
    get firstChild() {
      return this.childNodes[0] || null;
    }
    get isConnected() {
      let cur = this;
      while (cur) {
        if (cur === doc.body || cur === doc.documentElement) return true;
        cur = cur.parentNode;
      }
      return false;
    }
    setAttribute(k, v) {
      this.attributes.set(k, String(v));
    }
    getAttribute(k) {
      return this.attributes.has(k) ? this.attributes.get(k) : null;
    }
    removeAttribute(k) {
      this.attributes.delete(k);
    }
    appendChild(child) {
      child.parentNode = this;
      this.childNodes.push(child);
      this.children.push(child);
      return child;
    }
    removeChild(child) {
      const idx = this.childNodes.indexOf(child);
      if (idx >= 0) this.childNodes.splice(idx, 1);
      const cIdx = this.children.indexOf(child);
      if (cIdx >= 0) this.children.splice(cIdx, 1);
      child.parentNode = null;
      return child;
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    attachShadow() {
      this.shadowRoot = new FakeEl('#shadow-root');
      return this.shadowRoot;
    }
  }

  const doc = {
    documentElement: new FakeEl('html'),
    body: new FakeEl('body'),
    createElement(tag) {
      return new FakeEl(tag);
    },
  };
  if (docThemeAttr) doc.documentElement.setAttribute('data-theme', docThemeAttr);
  if (docClass) doc.documentElement.className = docClass;

  const win = {
    matchMedia(q) {
      return {
        matches: q === '(prefers-color-scheme: light)' ? lightOs : false,
        addEventListener() {},
        removeEventListener() {},
      };
    },
    getComputedStyle(el) {
      if (el === doc.body) return { backgroundColor: bodyBg };
      if (el === doc.documentElement) return { backgroundColor: docElBg };
      return { backgroundColor: 'rgba(0, 0, 0, 0)' };
    },
  };

  return { doc, win };
}

test('v3.0.2: theme-i18n detects dark mode from dark page background even when OS prefers-color-scheme is light', () => {
  const { doc, win } = createFakeDom({ bodyBg: 'rgb(15, 19, 26)', lightOs: true });
  const theme = createThemeAndI18n(doc, win);
  const snap = theme.getSnapshot();
  assert.equal(snap.mode, 'dark');
  assert.equal(snap.tokens['--ag-surface'], '#161b24');
  theme.dispose();
});

test('v3.0.2: theme-i18n detects light mode from light page background and falls back to OS when transparent', () => {
  const lightDom = createFakeDom({ bodyBg: 'rgb(255, 255, 255)', lightOs: false });
  const lightTheme = createThemeAndI18n(lightDom.doc, lightDom.win);
  assert.equal(lightTheme.getSnapshot().mode, 'light');
  lightTheme.dispose();

  const transparentDom = createFakeDom({ bodyBg: 'rgba(0, 0, 0, 0)', docElBg: 'transparent', lightOs: true });
  const fallbackTheme = createThemeAndI18n(transparentDom.doc, transparentDom.win);
  assert.equal(fallbackTheme.getSnapshot().mode, 'light');
  fallbackTheme.dispose();
});

test('v3.0.2: desktop surface NEVER mounts floating .ag-fallback-bar when host.statusbar is absent, while preserving API & late delegation', async () => {
  const { doc, win } = createFakeDom({ bodyBg: 'rgb(15, 19, 26)', lightOs: true });
  const themeAndI18n = createThemeAndI18n(doc, win);
  let activeSvc = null;
  const serviceBus = {
    getInternalService(name) {
      return name === 'host.statusbar' && activeSvc ? { impl: activeSvc } : null;
    },
  };

  const registry = createStatusItemRegistry(doc, win, {
    serviceBus,
    themeAndI18n,
    surface: 'desktop',
  });

  const clicks = [];
  const handle = registry.registerStatusItem('sample-plugin', {
    id: 'mcp-status',
    label: 'MCP',
    badge: '3',
    onClick: (ev) => clicks.push(ev),
  });

  // No floating DOM element mounted on Desktop
  const fallbackHosts = doc.body.children.filter(
    (el) => el.getAttribute('data-addon-host-fallback-statusbar') === '1'
  );
  assert.equal(fallbackHosts.length, 0, 'Desktop surface must never mount floating fallback statusbar DOM');

  // Programmatic registry & invocation still work
  assert.equal(registry.listStatusItems().length, 1);
  assert.equal(registry.listStatusItems()[0].delegated, false);
  assert.equal(registry.invokeStatusItem('sample-plugin', 'mcp-status', { shiftKey: true }).ok, true);
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].shiftKey, true);

  // Late host.statusbar delegation still works seamlessly
  const delegated = [];
  activeSvc = {
    registerItem(spec) {
      delegated.push(spec);
      return { dispose() {} };
    },
  };
  registry.syncDelegation();
  assert.equal(delegated.length, 1);
  assert.equal(registry.listStatusItems()[0].delegated, true);

  handle.dispose();
  themeAndI18n.dispose();
});

test('v3.0.2: remote-web surface mounts .ag-fallback-bar at bottom-right above drawer pill with dark tokens on dark page', () => {
  const { doc, win } = createFakeDom({ bodyBg: 'rgb(15, 19, 26)', lightOs: true });
  const themeAndI18n = createThemeAndI18n(doc, win);
  const registry = createStatusItemRegistry(doc, win, {
    serviceBus: null,
    themeAndI18n,
    surface: 'remote-web',
  });

  const handle = registry.registerStatusItem('sample-plugin', {
    id: 'mcp-status',
    label: 'MCP',
    badge: '3',
  });

  const fallbackHosts = doc.body.children.filter(
    (el) => el.getAttribute('data-addon-host-fallback-statusbar') === '1'
  );
  assert.equal(fallbackHosts.length, 1, 'Remote Web surface must mount fallback statusbar when host.statusbar is absent');
  const styleNode = fallbackHosts[0].shadowRoot.children[0];
  assert.ok(styleNode && typeof styleNode.textContent === 'string');
  assert.equal(styleNode.textContent.includes('left: 12px'), false, 'Must NOT anchor to bottom-left');
  assert.equal(styleNode.textContent.includes('right: max(12px'), true, 'Must anchor to bottom-right');
  assert.equal(styleNode.textContent.includes('bottom: max(64px'), true, 'Must sit cleanly above Remote Web drawer pill');
  assert.equal(styleNode.textContent.includes('--ag-surface: #161b24'), true, 'Must use dark surface tokens on dark page');

  handle.dispose();
  themeAndI18n.dispose();
});

test('v3.0.2: kernel passes hostSurface into statusItemRegistry for desktop vs remote-web', async () => {
  const desktopHost = createTestHost({ surface: 'desktop' });
  const ctxDesktop = await desktopHost.mountPlugin({
    schemaVersion: 3,
    pluginId: 'desktop-status-test',
    displayName: 'Desktop Status Test',
    version: '1.0.0',
    capabilities: ['renderer'],
    entry: { rendererScript: 'a.js' },
  });
  ctxDesktop.ui.registerStatusItem({ id: 'pill', label: 'MCP', badge: '3' });
  const desktopFallback = desktopHost.doc.body.childNodes.filter(
    (el) => el.getAttribute && el.getAttribute('data-addon-host-fallback-statusbar') === '1'
  );
  assert.equal(desktopFallback.length, 0);

  const remoteHost = createTestHost({ surface: 'remote-web' });
  const ctxRemote = await remoteHost.mountPlugin({
    schemaVersion: 3,
    pluginId: 'remote-status-test',
    displayName: 'Remote Status Test',
    version: '1.0.0',
    capabilities: ['renderer'],
    entry: { rendererScript: 'b.js' },
  });
  ctxRemote.ui.registerStatusItem({ id: 'pill', label: 'MCP', badge: '3' });
  const remoteFallback = remoteHost.doc.body.childNodes.filter(
    (el) => el.getAttribute && el.getAttribute('data-addon-host-fallback-statusbar') === '1'
  );
  assert.equal(remoteFallback.length, 1);
});
