'use strict';

/**
 * `@antigravity-addons/sdk` Real-Kernel Desktop/Remote Parity Test Host (v3.0.0).
 *
 * Boots the actual `createRendererKernel` inside a lightweight built-in DOM harness
 * so plugin authors can verify Desktop vs. Remote Web behavior, ISP namespace gating,
 * Tier 1/2/3 UI surfaces, status item delegation, and disposal without launching Electron.
 */

const path = require('node:path');
const { createRendererKernel } = require(path.resolve(__dirname, '..', '..', '..', 'src', 'runtime', 'renderer', 'kernel'));

function createMockElement(tagName, ownerDocument) {
  const attrs = new Map();
  const listeners = new Map();
  const childNodes = [];
  const style = {};
  let textContentValue = '';
  let shadowRoot = null;
  let rect = { left: 100, top: 100, width: 300, height: 180, right: 400, bottom: 280 };

  const el = {
    tagName: String(tagName || 'div').toUpperCase(),
    nodeName: String(tagName || 'div').toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null,
    childNodes,
    style,
    className: '',
    value: '',
    checked: false,
    disabled: false,
    hidden: false,
    open: false,
    isConnected: true,
    get firstChild() {
      return childNodes[0] || null;
    },
    get shadowRoot() {
      return shadowRoot;
    },
    get textContent() {
      if (childNodes.length === 0) return textContentValue;
      return textContentValue + childNodes.map((c) => c.textContent || '').join('');
    },
    set textContent(v) {
      textContentValue = String(v === undefined || v === null ? '' : v);
      childNodes.length = 0;
    },
    setAttribute(k, v) {
      attrs.set(String(k), String(v));
      if (k === 'class') el.className = String(v);
      if (k === 'hidden') el.hidden = true;
    },
    getAttribute(k) {
      return attrs.has(String(k)) ? attrs.get(String(k)) : null;
    },
    removeAttribute(k) {
      attrs.delete(String(k));
      if (k === 'hidden') el.hidden = false;
    },
    hasAttribute(k) {
      return attrs.has(String(k));
    },
    appendChild(child) {
      if (!child) return child;
      if (child.parentNode && typeof child.parentNode.removeChild === 'function') {
        child.parentNode.removeChild(child);
      }
      child.parentNode = el;
      childNodes.push(child);
      return child;
    },
    insertBefore(child, refNode) {
      if (!child) return child;
      if (child.parentNode && typeof child.parentNode.removeChild === 'function') {
        child.parentNode.removeChild(child);
      }
      const idx = refNode ? childNodes.indexOf(refNode) : -1;
      child.parentNode = el;
      if (idx === -1) childNodes.push(child);
      else childNodes.splice(idx, 0, child);
      return child;
    },
    removeChild(child) {
      const idx = childNodes.indexOf(child);
      if (idx !== -1) {
        childNodes.splice(idx, 1);
        child.parentNode = null;
      }
      return child;
    },
    contains(target) {
      if (target === el) return true;
      for (let i = 0; i < childNodes.length; i += 1) {
        if (childNodes[i] === target || (typeof childNodes[i].contains === 'function' && childNodes[i].contains(target))) {
          return true;
        }
      }
      return false;
    },
    attachShadow({ mode } = {}) {
      const sr = createMockElement('#shadow-root', ownerDocument);
      sr.mode = mode || 'open';
      sr.host = el;
      if (mode !== 'closed') shadowRoot = sr;
      return sr;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (listeners.has(type)) listeners.get(type).delete(fn);
    },
    dispatchEvent(ev) {
      const type = ev && ev.type;
      const set = listeners.get(type);
      if (set) {
        for (const fn of Array.from(set)) fn(ev);
      }
      return true;
    },
    click(ev = {}) {
      return el.dispatchEvent({ type: 'click', isTrusted: true, ...ev });
    },
    focus() {
      ownerDocument.activeElement = el;
    },
    showModal() {
      el.open = true;
    },
    close() {
      el.open = false;
    },
    showPopover() {
      el.open = true;
    },
    hidePopover() {
      el.open = false;
    },
    setMockRect(nextRect) {
      rect = { ...rect, ...nextRect };
    },
    getBoundingClientRect() {
      return { ...rect };
    },
    querySelector(selector) {
      return el.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      const results = [];
      const attrMatch = String(selector || '').match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
      const walk = (node) => {
        if (!node || !Array.isArray(node.childNodes)) return;
        for (let i = 0; i < node.childNodes.length; i += 1) {
          const c = node.childNodes[i];
          if (!c || c.nodeType !== 1) continue;
          if (attrMatch) {
            const val = typeof c.getAttribute === 'function' ? c.getAttribute(attrMatch[1]) : null;
            if (val !== null && (attrMatch[2] === undefined || val === attrMatch[2])) {
              results.push(c);
            }
          } else if (typeof c.tagName === 'string' && c.tagName.toLowerCase() === String(selector).toLowerCase()) {
            results.push(c);
          }
          walk(c);
        }
      };
      walk(el);
      return results;
    },
  };
  return el;
}

function createMockDocumentAndWindow({ viewport = { width: 1280, height: 800 }, locale = 'en', themeMode = 'dark' } = {}) {
  const docListeners = new Map();
  const winListeners = new Map();
  const storageMap = new Map();

  const doc = {
    activeElement: null,
    createElement(tag) {
      return createMockElement(tag, doc);
    },
    createTextNode(text) {
      const value = String(text === undefined || text === null ? '' : text);
      return {
        nodeType: 3,
        nodeName: '#text',
        ownerDocument: doc,
        parentNode: null,
        nodeValue: value,
        textContent: value,
      };
    },
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (docListeners.has(type)) docListeners.get(type).delete(fn);
    },
    querySelector(sel) {
      return doc.body.querySelector(sel);
    },
    querySelectorAll(sel) {
      return doc.body.querySelectorAll(sel);
    },
  };

  doc.documentElement = createMockElement('html', doc);
  doc.documentElement.lang = locale;
  doc.documentElement.setAttribute('data-theme', themeMode);
  doc.head = createMockElement('head', doc);
  doc.body = createMockElement('body', doc);
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);

  const win = {
    document: doc,
    innerWidth: viewport.width,
    innerHeight: viewport.height,
    navigator: { language: locale },
    localStorage: {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(String(k), String(v)),
      removeItem: (k) => storageMap.delete(String(k)),
    },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (winListeners.has(type)) winListeners.get(type).delete(fn);
    },
    dispatchEvent(ev) {
      const set = winListeners.get(ev && ev.type);
      if (set) {
        for (const fn of Array.from(set)) fn(ev);
      }
      return true;
    },
  };

  return { doc, win };
}

function createTestHost({
  surface = 'desktop',
  viewport = { width: 1280, height: 800 },
  locale = 'en',
  themeMode = 'dark',
  netHandler = null,
  configScopes = {},
  initialSettings = {},
} = {}) {
  const effectiveSurface = surface === 'remote-web' ? 'remote-web' : 'desktop';
  const { doc, win } = createMockDocumentAndWindow({ viewport, locale, themeMode });
  const kernel = createRendererKernel(doc, win);
  const hostToken = 'sdk-test-host-token-0123456789abcdef';
  const scopeStore = new Map(Object.entries(configScopes || {}));
  const settingsStore = new Map(Object.entries(initialSettings || {}));

  const hostBridge = {
    docGenId: 1,
    profileId: effectiveSurface === 'remote-web' ? 'sdk-test-remote-web' : 'sdk-test-desktop',
    setPortalClaim: () => ({ ok: true }),
    saveSettings: (pid, rawJson) => {
      const parsed = JSON.parse(rawJson);
      const snapshot = { status: 'ok', data: parsed };
      settingsStore.set(pid, snapshot);
      kernel.pushPluginSettings(pid, snapshot, hostToken);
      return Promise.resolve({ ok: true, snapshot });
    },
    reportError: () => {},
    ping: () => Promise.resolve({ ok: true }),
    readConfigScope: (_pid, scopeId) => {
      const rec = scopeStore.get(scopeId);
      if (!rec) return Promise.resolve({ ok: false, scopeId, status: 'missing', data: null });
      return Promise.resolve({ ok: true, scopeId, status: 'ok', data: rec.data, sha256: rec.sha256 || 'mock-sha' });
    },
    writeConfigScope: (_pid, scopeId, rawJson) => {
      const data = JSON.parse(rawJson);
      scopeStore.set(scopeId, { data, sha256: 'updated-sha' });
      return Promise.resolve({ ok: true, currentSha256: 'updated-sha', snapshot: { data } });
    },
    netFetch: (pluginId, url, init) => {
      if (typeof netHandler === 'function') {
        return Promise.resolve(netHandler(pluginId, url, init));
      }
      return Promise.resolve({ ok: false, reason: 'ERR_TEST_HOST_NET_HANDLER_NOT_CONFIGURED' });
    },
  };

  kernel.boot({
    docGenId: 1,
    hostToken,
    hostProfileId: hostBridge.profileId,
    surface: effectiveSurface,
    hostBridge,
  });

  async function mountPlugin(manifest, setupFn) {
    const pluginId = manifest.pluginId;
    const isTrusted = manifest.trustLevel === 'trusted';
    const cbScopes =
      (manifest.permissions && manifest.permissions.configBridge && manifest.permissions.configBridge.scopes) ||
      (manifest.configBridge && manifest.configBridge.scopes) ||
      [];
    const pluginMeta = {
      pluginId,
      displayName: manifest.displayName || pluginId,
      version: manifest.version || '1.0.0',
      apiVersion: manifest.schemaVersion === 3 ? 3 : 2,
      sourceSchemaVersion: manifest.schemaVersion || 3,
      trustLevel: isTrusted ? 'trusted' : 'restricted',
      hasSettingsBridge: Boolean(manifest.settingsBridge && isTrusted),
      hasConfigBridge: Boolean(effectiveSurface === 'desktop' && isTrusted && cbScopes.length > 0),
      configScopes: effectiveSurface === 'desktop' && isTrusted ? cbScopes : [],
      permissions: manifest.permissions || null,
      uiSlots: manifest.uiSlots || [],
      isolation: manifest.isolation || {},
    };

    const initialSnap = settingsStore.has(pluginId) ? settingsStore.get(pluginId) : null;
    const ctx = kernel.createPluginHandle(pluginMeta, hostToken, initialSnap);
    if (typeof setupFn === 'function') {
      await setupFn(ctx);
    }
    return ctx;
  }

  return Object.freeze({
    surface: effectiveSurface,
    kernel,
    doc,
    win,
    mountPlugin,
    disposePlugin: (pluginId) => kernel.disposePlugin(pluginId, hostToken),
    setViewport(width, height) {
      win.innerWidth = width;
      win.innerHeight = height;
      win.dispatchEvent({ type: 'resize' });
    },
    getStatusItems: () => kernel.listStatusItems(),
    getSettingsPages: () => kernel.listSettingsPages(),
  });
}

module.exports = {
  createTestHost,
};
