'use strict';

/**
 * Generates the single shared Electron host loader (`addon-host-loader.js`)
 * consumed by the 1-line `app.asar` bootstrap hook.
 *
 * Guarantees:
 * - Local HTTP(S) top-frame Hub URLs only (rejects devtools://, file://, external origins).
 * - Strict `config.json` read-only enabled gate per plugin.
 * - Independent `try/catch` + `Promise.allSettled` fault isolation per plugin.
 * - Minimal ISP runtime API (`window.__ADDON_HOST_API__`) that automatically stamps
 *   `translate="no"`, `data-agy-no-translate="true"`, `data-addon-host-owner`, and
 *   `data-addon-host-slot` on every mounted plugin slot container.
 */

const fs = require('node:fs');
const path = require('node:path');
const { assertValidHostProfile } = require('../../core/host-profile-port');
const { planAddonExecution } = require('../../core/lifecycle-coordinator');
const { isPluginEnabledInConfig } = require('./config-reader');

function isAllowedHubUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return false;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
  } catch (_err) {
    return false;
  }
}

function serializeSafeInlineJson(val) {
  return JSON.stringify(val)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function loadRawManifestsFromDir(addonsDir) {
  if (!addonsDir || !fs.existsSync(addonsDir)) return [];
  const entries = [];
  for (const name of fs.readdirSync(addonsDir).sort()) {
    if (!name.endsWith('.json')) continue;
    const fullPath = path.join(addonsDir, name);
    try {
      const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      entries.push({ source: fullPath, manifest: parsed });
    } catch (_err) {
      entries.push({ source: fullPath, manifest: null });
    }
  }
  return entries;
}

function collectExecutableAddons(paths, { checkFilesExist = true } = {}) {
  const rawEntries = loadRawManifestsFromDir(paths.ADDONS_DIR);
  return planAddonExecution(rawEntries, {
    pluginsRootDir: paths.PLUGINS_ROOT_DIR,
    checkFilesExist,
    isEnabled: (pluginId) => isPluginEnabledInConfig(paths.CONFIG_JSON_PATH, pluginId),
  });
}

function buildRendererHostApiBootstrapSource({ hostVersion = '1.0.0', hostProfileId = 'default' } = {}) {
  return `(function(){
  if (window.__ADDON_HOST_API__) return;
  const NO_TRANSLATE_SELECTOR = '[data-addon-host-owner], [translate="no"], [data-agy-no-translate="true"]';
  const slotOwners = new Map();
  const slotElements = new Map();
  const styleOwners = new Map();
  const styleElements = new Map();
  const disposers = new Map();
  const api = Object.freeze({
    hostVersion: ${serializeSafeInlineJson(hostVersion)},
    hostProfileId: ${serializeSafeInlineJson(hostProfileId)},
    getNoTranslateSelector() {
      return NO_TRANSLATE_SELECTOR;
    },
    mountSlot(pluginId, slotId, parentEl) {
      if (!pluginId || !slotId) throw new Error('ERR_INVALID_SLOT_ARGS');
      const existingOwner = slotOwners.get(slotId);
      if (existingOwner && existingOwner !== pluginId) {
        throw new Error('ERR_SLOT_OWNED_BY_ANOTHER_PLUGIN:' + slotId);
      }
      let el = slotElements.get(slotId);
      if (!el) {
        el = document.createElement('div');
        el.setAttribute('translate', 'no');
        el.setAttribute('data-agy-no-translate', 'true');
        el.setAttribute('data-addon-host-owner', String(pluginId));
        el.setAttribute('data-addon-host-slot', String(slotId));
        slotOwners.set(slotId, pluginId);
        slotElements.set(slotId, el);
      }
      const hostParent = parentEl || document.body;
      if (hostParent && el.parentNode !== hostParent && typeof hostParent.appendChild === 'function') {
        hostParent.appendChild(el);
      }
      return el;
    },
    unmountSlot(pluginId, slotId) {
      const owner = slotOwners.get(slotId);
      if (!owner) return false;
      if (owner !== pluginId) throw new Error('ERR_FORBIDDEN_CROSS_PLUGIN_UNMOUNT:' + slotId);
      const el = slotElements.get(slotId);
      if (el && el.parentNode && typeof el.parentNode.removeChild === 'function') {
        el.parentNode.removeChild(el);
      }
      slotOwners.delete(slotId);
      slotElements.delete(slotId);
      return true;
    },
    injectStyle(pluginId, styleId, cssText) {
      if (!pluginId || !styleId) throw new Error('ERR_INVALID_STYLE_ARGS');
      const existingOwner = styleOwners.get(styleId);
      if (existingOwner && existingOwner !== pluginId) {
        throw new Error('ERR_STYLE_OWNED_BY_ANOTHER_PLUGIN:' + styleId);
      }
      let styleEl = styleElements.get(styleId);
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.setAttribute('data-addon-host-owner', String(pluginId));
        styleEl.setAttribute('data-addon-host-style', String(styleId));
        styleOwners.set(styleId, pluginId);
        styleElements.set(styleId, styleEl);
        const head = document.head || document.documentElement || document.body;
        if (head && typeof head.appendChild === 'function') head.appendChild(styleEl);
      }
      styleEl.textContent = String(cssText || '');
      return styleEl;
    },
    removeStyle(pluginId, styleId) {
      const owner = styleOwners.get(styleId);
      if (!owner) return false;
      if (owner !== pluginId) throw new Error('ERR_FORBIDDEN_CROSS_PLUGIN_STYLE_REMOVE:' + styleId);
      const el = styleElements.get(styleId);
      if (el && el.parentNode && typeof el.parentNode.removeChild === 'function') {
        el.parentNode.removeChild(el);
      }
      styleOwners.delete(styleId);
      styleElements.delete(styleId);
      return true;
    },
    listOwnedSlots(pluginId) {
      const out = [];
      for (const [sid, owner] of slotOwners.entries()) {
        if (owner === pluginId) out.push(sid);
      }
      return out;
    },
    onDispose(pluginId, fn) {
      if (!pluginId || typeof fn !== 'function') return;
      if (!disposers.has(pluginId)) disposers.set(pluginId, []);
      disposers.get(pluginId).push(fn);
    },
    disposePlugin(pluginId) {
      const fns = disposers.get(pluginId) || [];
      disposers.delete(pluginId);
      for (const fn of fns) {
        try { fn(); } catch (_err) {}
      }
      for (const sid of api.listOwnedSlots(pluginId)) {
        try { api.unmountSlot(pluginId, sid); } catch (_err) {}
      }
      for (const [stId, owner] of Array.from(styleOwners.entries())) {
        if (owner === pluginId) {
          try { api.removeStyle(pluginId, stId); } catch (_err) {}
        }
      }
    },
  });
  Object.defineProperty(window, '__ADDON_HOST_API__', {
    value: api,
    writable: false,
    configurable: false,
    enumerable: false,
  });
})();`;
}

function buildHostLoaderScriptSource(paths, profile, { hostVersion = '1.0.0' } = {}) {
  assertValidHostProfile(profile);
  const bootstrapApiSrc = buildRendererHostApiBootstrapSource({
    hostVersion,
    hostProfileId: profile.id,
  });
  const cfg = {
    addonsDir: paths.ADDONS_DIR,
    pluginsRootDir: paths.PLUGINS_ROOT_DIR,
    configJsonPath: paths.CONFIG_JSON_PATH,
    hostProfileId: profile.id,
    hostVersion,
  };

  return `'use strict';
// Auto-generated by antigravity-native-addon-host (${profile.patchMarker}).
// Single isolated mainHook + top-frame renderer loader.
const fs = require('fs');
const path = require('path');

const HOST_CFG = ${serializeSafeInlineJson(cfg)};
const RENDERER_API_BOOTSTRAP = ${serializeSafeInlineJson(bootstrapApiSrc)};

function isAllowedHubUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return false;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
  } catch (_e) { return false; }
}

function isPluginEnabled(pluginId) {
  try {
    if (!fs.existsSync(HOST_CFG.configJsonPath)) return true;
    const parsed = JSON.parse(fs.readFileSync(HOST_CFG.configJsonPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const entry = parsed.plugins && parsed.plugins[pluginId];
    return !(entry && entry.enabled === false);
  } catch (_e) { return false; }
}

function resolveConfined(relScript, pluginDir) {
  if (typeof relScript !== 'string' || !relScript.trim() || path.isAbsolute(relScript) || relScript.includes('\\0')) return null;
  const base = path.resolve(pluginDir);
  const target = path.resolve(base, path.normalize(relScript));
  const rel = path.relative(base, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(target)) return null;
  try {
    const realBase = fs.realpathSync(base);
    const realTarget = fs.realpathSync(target);
    const realRel = path.relative(realBase, realTarget);
    if (!realRel || realRel.startsWith('..') || path.isAbsolute(realRel)) return null;
    return realTarget;
  } catch (_e) { return null; }
}

function collectActiveAddons() {
  if (!fs.existsSync(HOST_CFG.addonsDir)) return [];
  const items = [];
  for (const name of fs.readdirSync(HOST_CFG.addonsDir).sort()) {
    if (!name.endsWith('.json')) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(HOST_CFG.addonsDir, name), 'utf8'));
      if (!m || m.schemaVersion !== 1 || typeof m.pluginId !== 'string' || !Array.isArray(m.capabilities)) continue;
      if (!isPluginEnabled(m.pluginId)) continue;
      const pluginDir = path.join(HOST_CFG.pluginsRootDir, m.pluginId);
      const rendererPath = m.capabilities.includes('renderer') && m.entry && m.entry.rendererScript
        ? resolveConfined(m.entry.rendererScript, pluginDir) : null;
      const mainHookPath = m.capabilities.includes('mainHook') && m.entry && m.entry.mainHookScript
        ? resolveConfined(m.entry.mainHookScript, pluginDir) : null;
      items.push({
        pluginId: m.pluginId,
        loadOrder: typeof m.loadOrder === 'number' ? m.loadOrder : 100,
        rendererPath,
        mainHookPath,
      });
    } catch (_e) {}
  }
  items.sort((a, b) => (a.loadOrder !== b.loadOrder ? a.loadOrder - b.loadOrder : a.pluginId.localeCompare(b.pluginId)));
  return items;
}

const loadedMainHooks = new Map();

function runMainHooks(electronApp) {
  for (const addon of collectActiveAddons()) {
    if (!addon.mainHookPath || loadedMainHooks.has(addon.pluginId)) continue;
    try {
      const mod = require(addon.mainHookPath);
      const ctx = {
        app: electronApp,
        pluginId: addon.pluginId,
        hostProfileId: HOST_CFG.hostProfileId,
        hostVersion: HOST_CFG.hostVersion,
      };
      if (typeof mod === 'function') mod(ctx);
      else if (mod && typeof mod.activate === 'function') mod.activate(ctx);
      loadedMainHooks.set(addon.pluginId, mod);
    } catch (_err) {}
  }
}

function attachWebContents(contents, electronApp) {
  if (!contents || typeof contents.getType !== 'function' || contents.getType() !== 'window') return;
  runMainHooks(electronApp);

  for (const [pluginId, mod] of loadedMainHooks.entries()) {
    if (mod && typeof mod.onWebContentsCreated === 'function') {
      try {
        mod.onWebContentsCreated({ app: electronApp, contents, pluginId, isAllowedHubUrl });
      } catch (_err) {}
    }
  }

  let lastUrl = '';
  const injectedIds = new Set();
  const injectAll = async () => {
    try {
      const url = typeof contents.getURL === 'function' ? contents.getURL() : '';
      if (!isAllowedHubUrl(url)) return;
      let hasApi = false;
      try {
        hasApi = Boolean(await contents.executeJavaScript('Boolean(window.__ADDON_HOST_API__)', true));
      } catch (_e) { hasApi = false; }
      if (url !== lastUrl || !hasApi) {
        lastUrl = url;
        injectedIds.clear();
        await contents.executeJavaScript(RENDERER_API_BOOTSTRAP, true);
      }
      const addons = collectActiveAddons().filter((a) => a.rendererPath && !injectedIds.has(a.pluginId));
      await Promise.allSettled(addons.map(async (addon) => {
        const code = fs.readFileSync(addon.rendererPath, 'utf8');
        await contents.executeJavaScript(code, true);
        injectedIds.add(addon.pluginId);
      }));
    } catch (_err) {}
  };

  if (typeof contents.on === 'function') {
    contents.on('dom-ready', () => { void injectAll(); });
    contents.on('did-finish-load', () => { void injectAll(); });
  }
}

module.exports = {
  isAllowedHubUrl,
  collectActiveAddons,
  runMainHooks,
  attachWebContents,
};
`;
}

module.exports = {
  isAllowedHubUrl,
  serializeSafeInlineJson,
  loadRawManifestsFromDir,
  collectExecutableAddons,
  buildRendererHostApiBootstrapSource,
  buildHostLoaderScriptSource,
};
