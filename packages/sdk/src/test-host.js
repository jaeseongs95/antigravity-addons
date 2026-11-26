'use strict';

/**
 * `@extenra/sdk` Real-Kernel Desktop/Remote Parity Test Host (v3.2.0).
 *
 * Boots the actual `createRendererKernel` inside a lightweight built-in DOM harness
 * so plugin authors can verify Desktop vs. Remote Web behavior, ISP namespace gating,
 * Tier 1/2/3 UI surfaces, status item delegation, and disposal without launching Electron.
 */

const path = require('node:path');
const { createRendererKernel } = require(path.resolve(__dirname, '..', '..', '..', 'src', 'runtime', 'renderer', 'kernel'));
const {
  validateSecretKey,
  validateSecretValue,
  resolveSecretHeaders,
} = require(path.resolve(__dirname, '..', '..', '..', 'src', 'core', 'secrets-policy'));

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
    get parentElement() {
      return el.parentNode;
    },
    get children() {
      return childNodes.filter((c) => c && c.nodeType === 1);
    },
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
      const seen = new Set();
      const parts = String(selector || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const matchSingle = (c, sel) => {
        const attrMatch = sel.match(/^([a-zA-Z0-9_-]+)?\[([^=\]]+)(?:="([^"]*)")?\]$/);
        if (attrMatch) {
          if (attrMatch[1] && String(c.tagName || '').toLowerCase() !== attrMatch[1].toLowerCase()) return false;
          const val = typeof c.getAttribute === 'function' ? c.getAttribute(attrMatch[2]) : null;
          return val !== null && (attrMatch[3] === undefined || val === attrMatch[3]);
        }
        return typeof c.tagName === 'string' && c.tagName.toLowerCase() === sel.toLowerCase();
      };
      const walk = (node) => {
        if (!node || !Array.isArray(node.childNodes)) return;
        for (let i = 0; i < node.childNodes.length; i += 1) {
          const c = node.childNodes[i];
          if (!c || c.nodeType !== 1) continue;
          for (let p = 0; p < parts.length; p += 1) {
            if (!seen.has(c) && matchSingle(c, parts[p])) {
              seen.add(c);
              results.push(c);
              break;
            }
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
  remoteBridgeConnected = false,
  uiSectionTargets = {},
  netHandler = null,
  configScopes = {},
  initialSettings = {},
} = {}) {
  const effectiveSurface = surface === 'remote-web' ? 'remote-web' : 'desktop';
  const hasLiveRemoteBridge = effectiveSurface === 'remote-web' && remoteBridgeConnected === true;
  const { doc, win } = createMockDocumentAndWindow({ viewport, locale, themeMode });
  const kernel = createRendererKernel(doc, win);
  const hostToken = 'sdk-test-host-token-0123456789abcdef';
  const scopeStore = new Map(Object.entries(configScopes || {}));
  const settingsStore = new Map(Object.entries(initialSettings || {}));
  const secretsBindings = new Map(); // pluginId -> { maxKeys, maxBytes, allowRead }
  const secretsStore = new Map(); // pluginId -> Map<key, value>
  const defaultPersistence =
    effectiveSurface === 'remote-web' ? (hasLiveRemoteBridge ? 'remote-bridge' : 'session-memory') : 'os-encrypted';

  function getSecretBucket(pid, create = false) {
    let b = secretsStore.get(pid);
    if (!b && create) {
      b = new Map();
      secretsStore.set(pid, b);
    }
    return b || null;
  }

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
    ...(hasLiveRemoteBridge
      ? {
          getRemoteBridgeStatus: () => ({
            configured: true,
            connected: true,
            baseUrl: 'http://127.0.0.1:19384',
            hostVersion: '3.3.0',
            buildSha8: 'test',
            activePlugins: [],
            lastCheckedAt: new Date().toISOString(),
            lastError: null,
          }),
        }
      : {}),
    secretsSet: (pid, key, value) => {
      const binding = secretsBindings.get(pid);
      if (!binding) return Promise.resolve({ ok: false, reason: 'ERR_SECRETS_NOT_DECLARED' });
      const kc = validateSecretKey(key);
      if (!kc.ok) return Promise.resolve({ ok: false, reason: kc.reason });
      const vc = validateSecretValue(value);
      if (!vc.ok) return Promise.resolve({ ok: false, reason: vc.reason });
      const bucket = getSecretBucket(pid, true);
      if (!bucket.has(kc.key) && bucket.size >= binding.maxKeys) {
        return Promise.resolve({ ok: false, reason: 'ERR_SECRETS_MAX_KEYS_EXCEEDED' });
      }
      bucket.set(kc.key, vc.value);
      return Promise.resolve({ ok: true, key: kc.key, persistence: defaultPersistence, updatedAt: new Date().toISOString(), reason: null });
    },
    secretsHas: (pid, key) => {
      const binding = secretsBindings.get(pid);
      if (!binding) return Promise.resolve({ ok: false, exists: false, reason: 'ERR_SECRETS_NOT_DECLARED' });
      const kc = validateSecretKey(key);
      if (!kc.ok) return Promise.resolve({ ok: false, exists: false, reason: kc.reason });
      const bucket = getSecretBucket(pid, false);
      return Promise.resolve({ ok: true, exists: Boolean(bucket && bucket.has(kc.key)), persistence: defaultPersistence, reason: null });
    },
    secretsGet: (pid, key) => {
      const binding = secretsBindings.get(pid);
      if (!binding) return Promise.resolve({ ok: false, exists: false, value: undefined, reason: 'ERR_SECRETS_NOT_DECLARED' });
      if (!binding.allowRead) return Promise.resolve({ ok: false, exists: false, value: undefined, reason: 'ERR_SECRETS_READ_NOT_ALLOWED' });
      const kc = validateSecretKey(key);
      if (!kc.ok) return Promise.resolve({ ok: false, exists: false, value: undefined, reason: kc.reason });
      const bucket = getSecretBucket(pid, false);
      if (!bucket || !bucket.has(kc.key)) return Promise.resolve({ ok: true, exists: false, value: undefined, persistence: defaultPersistence, reason: null });
      return Promise.resolve({ ok: true, exists: true, value: bucket.get(kc.key), persistence: defaultPersistence, reason: null });
    },
    secretsDelete: (pid, key) => {
      const binding = secretsBindings.get(pid);
      if (!binding) return Promise.resolve({ ok: false, deleted: false, reason: 'ERR_SECRETS_NOT_DECLARED' });
      const kc = validateSecretKey(key);
      if (!kc.ok) return Promise.resolve({ ok: false, deleted: false, reason: kc.reason });
      const bucket = getSecretBucket(pid, false);
      return Promise.resolve({ ok: true, deleted: Boolean(bucket && bucket.delete(kc.key)), reason: null });
    },
    secretsList: (pid) => {
      const binding = secretsBindings.get(pid);
      if (!binding) return Promise.resolve({ ok: false, keys: [], reason: 'ERR_SECRETS_NOT_DECLARED' });
      const bucket = getSecretBucket(pid, false);
      return Promise.resolve({ ok: true, keys: bucket ? Array.from(bucket.keys()).sort() : [], persistence: defaultPersistence, reason: null });
    },
    netFetch: (pluginId, url, init) => {
      const safeInit = init && typeof init === 'object' ? { ...init } : {};
      if (safeInit.secretHeaders && typeof safeInit.secretHeaders === 'object') {
        const binding = secretsBindings.get(pluginId);
        if (!binding) return Promise.resolve({ ok: false, reason: 'ERR_SECRETS_NOT_DECLARED' });
        const bucket = getSecretBucket(pluginId, false);
        const res = resolveSecretHeaders(safeInit.secretHeaders, (secretKey) => {
          if (!bucket || !bucket.has(secretKey)) return { ok: false, reason: `ERR_SECRET_NOT_FOUND:${secretKey}` };
          return { ok: true, value: bucket.get(secretKey) };
        });
        if (!res.ok) return Promise.resolve({ ok: false, reason: res.reason });
        safeInit.headers = { ...(safeInit.headers || {}), ...res.headers };
      }
      if (typeof netHandler === 'function') {
        return Promise.resolve(netHandler(pluginId, url, safeInit));
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
    uiSectionTargets,
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
      hasConfigBridge: Boolean((effectiveSurface === 'desktop' || hasLiveRemoteBridge) && isTrusted && cbScopes.length > 0),
      configScopes: (effectiveSurface === 'desktop' || hasLiveRemoteBridge) && isTrusted ? cbScopes : [],
      permissions: manifest.permissions || null,
      uiSlots: manifest.uiSlots || [],
      isolation: manifest.isolation || {},
    };

    const secretsPerm = isTrusted && manifest.permissions && manifest.permissions.secrets ? manifest.permissions.secrets : null;
    if (secretsPerm) {
      secretsBindings.set(pluginId, {
        maxKeys: Number.isInteger(secretsPerm.maxKeys) ? secretsPerm.maxKeys : 32,
        maxBytes: Number.isInteger(secretsPerm.maxBytes) ? secretsPerm.maxBytes : 32768,
        allowRead: secretsPerm.allowRead === true,
      });
    }
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
    setLocale: (nextLocale) => kernel.setHostLocale(nextLocale, hostToken),
    getStatusItems: () => kernel.listStatusItems(),
    getSectionActions: () => kernel.listSectionActions(),
    invokeSectionAction: (pluginId, actionId, clickEv) => kernel.invokeSectionAction(pluginId, actionId, clickEv, hostToken),
    getSettingsPages: () => kernel.listSettingsPages(),
  });
}

module.exports = {
  createTestHost,
};
