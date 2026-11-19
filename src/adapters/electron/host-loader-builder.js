'use strict';

/**
 * Generates the single shared Electron host loader (`addon-host-loader.js`)
 * consumed by the 1-line `app.asar` bootstrap hook.
 *
 * Security & Isolation Guarantees (F1-F5, NB2):
 * - Single source of truth: runtime loader delegates directly to `src/core/lifecycle-coordinator.js`
 *   (Ajv schema, FORBIDDEN_IDS, pluginId regex, pluginsRoot symlink confinement, compatibility,
 *   slot/namespace/IPC conflict checks).
 * - Capability-token Scoped API: global `window.__ADDON_HOST_API__` exposes ONLY read-only host info
 *   (`hostVersion`, `hostProfileId`, `getNoTranslateSelector()`). Each plugin receives its own immutable
 *   `addonHost` handle bound to its `pluginId` and declared `allowedSlotIds` via a one-time unguessable
 *   token, preventing cross-plugin impersonation or undeclared slot hijacking.
 * - Serialized injection queue (`dom-ready` + `did-finish-load` race-free), deterministic sequential
 *   `loadOrder` execution with per-plugin `try/catch` fault isolation, SPA `pushState` non-re-injection,
 *   and `mainHook` deactivation cleanup (`dispose()` + removal from `onWebContentsCreated`).
 * - Vendor-neutral: URL allowlist & extra no-translate attributes come strictly from `HostProfile`.
 */

const fs = require('node:fs');
const path = require('node:path');
const { assertValidHostProfile } = require('../../core/host-profile-port');
const { planAddonExecution } = require('../../core/lifecycle-coordinator');
const { isPluginEnabledInConfig } = require('./config-reader');

const DEFAULT_ALLOWED_PROTOCOLS = Object.freeze(['http:', 'https:']);
const DEFAULT_ALLOWED_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '::1', '[::1]']);

function isAllowedRendererUrl(rawUrl, profile = null) {
  if (typeof rawUrl !== 'string' || !rawUrl) return false;
  const protocols =
    profile && Array.isArray(profile.allowedUrlProtocols) && profile.allowedUrlProtocols.length > 0
      ? profile.allowedUrlProtocols
      : DEFAULT_ALLOWED_PROTOCOLS;
  const hosts =
    profile && Array.isArray(profile.allowedUrlHosts) && profile.allowedUrlHosts.length > 0
      ? profile.allowedUrlHosts.map((h) => h.toLowerCase())
      : DEFAULT_ALLOWED_HOSTS;
  try {
    const u = new URL(rawUrl);
    if (!protocols.includes(u.protocol)) return false;
    return hosts.includes(u.hostname.toLowerCase());
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

function collectExecutableAddons(
  paths,
  { checkFilesExist = true, hostProfileId = null, hostVersion = null } = {}
) {
  const rawEntries = loadRawManifestsFromDir(paths.ADDONS_DIR);
  return planAddonExecution(rawEntries, {
    pluginsRootDir: paths.PLUGINS_ROOT_DIR,
    checkFilesExist,
    hostProfileId,
    hostVersion,
    isEnabled: (pluginId) => isPluginEnabledInConfig(paths.CONFIG_JSON_PATH, pluginId),
  });
}

function buildRendererHostApiBootstrapSource({
  hostVersion = '1.0.0',
  hostProfileId = 'default',
  extraNoTranslateAttributes = [],
} = {}) {
  const extraAttrs = Array.isArray(extraNoTranslateAttributes) ? extraNoTranslateAttributes : [];
  const noTranslateParts = ['[data-addon-host-owner]', '[translate="no"]'];
  for (const attr of extraAttrs) {
    noTranslateParts.push(`[${attr}="true"]`);
  }
  const noTranslateSelector = noTranslateParts.join(', ');

  return `(function(){
  if (window.__ADDON_HOST_API__) return;
  const NO_TRANSLATE_SELECTOR = ${serializeSafeInlineJson(noTranslateSelector)};
  const EXTRA_NO_TRANSLATE_ATTRS = Object.freeze(${serializeSafeInlineJson(extraAttrs)});
  const slotOwners = new Map();
  const slotElements = new Map();
  const styleOwners = new Map();
  const styleElements = new Map();
  const disposers = new Map();
  const pendingTokens = new Map();

  function createScopedHandle(spec) {
    const pluginId = String(spec.pluginId);
    const allowedSlots = new Set(Array.isArray(spec.allowedSlotIds) ? spec.allowedSlotIds : []);
    const storageNamespace = spec.storageNamespace || pluginId;
    const ipcChannelPrefix = spec.ipcChannelPrefix || null;

    const handle = Object.freeze({
      pluginId,
      hostVersion: ${serializeSafeInlineJson(hostVersion)},
      hostProfileId: ${serializeSafeInlineJson(hostProfileId)},
      storageNamespace,
      ipcChannelPrefix,
      getNoTranslateSelector() {
        return NO_TRANSLATE_SELECTOR;
      },
      mountSlot(slotId, parentEl) {
        if (!slotId || typeof slotId !== 'string') throw new Error('ERR_INVALID_SLOT_ID');
        if (!allowedSlots.has(slotId)) {
          throw new Error('ERR_UNDECLARED_SLOT:' + slotId);
        }
        const existingOwner = slotOwners.get(slotId);
        if (existingOwner && existingOwner !== pluginId) {
          throw new Error('ERR_SLOT_OWNED_BY_ANOTHER_PLUGIN:' + slotId);
        }
        let el = slotElements.get(slotId);
        if (!el) {
          el = document.createElement('div');
          el.setAttribute('translate', 'no');
          for (const attr of EXTRA_NO_TRANSLATE_ATTRS) {
            el.setAttribute(attr, 'true');
          }
          el.setAttribute('data-addon-host-owner', pluginId);
          el.setAttribute('data-addon-host-slot', slotId);
          slotOwners.set(slotId, pluginId);
          slotElements.set(slotId, el);
        }
        const hostParent = parentEl || document.body;
        if (hostParent && el.parentNode !== hostParent && typeof hostParent.appendChild === 'function') {
          hostParent.appendChild(el);
        }
        return el;
      },
      unmountSlot(slotId) {
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
      injectStyle(styleId, cssText) {
        if (!styleId || typeof styleId !== 'string') throw new Error('ERR_INVALID_STYLE_ID');
        const scopedKey = pluginId + ':' + styleId;
        const existingOwner = styleOwners.get(scopedKey);
        if (existingOwner && existingOwner !== pluginId) {
          throw new Error('ERR_STYLE_OWNED_BY_ANOTHER_PLUGIN:' + styleId);
        }
        let styleEl = styleElements.get(scopedKey);
        if (!styleEl) {
          styleEl = document.createElement('style');
          styleEl.setAttribute('data-addon-host-owner', pluginId);
          styleEl.setAttribute('data-addon-host-style', scopedKey);
          styleOwners.set(scopedKey, pluginId);
          styleElements.set(scopedKey, styleEl);
          const head = document.head || document.documentElement || document.body;
          if (head && typeof head.appendChild === 'function') head.appendChild(styleEl);
        }
        styleEl.textContent = String(cssText || '');
        return styleEl;
      },
      removeStyle(styleId) {
        const scopedKey = pluginId + ':' + styleId;
        const owner = styleOwners.get(scopedKey);
        if (!owner) return false;
        if (owner !== pluginId) throw new Error('ERR_FORBIDDEN_CROSS_PLUGIN_STYLE_REMOVE:' + styleId);
        const el = styleElements.get(scopedKey);
        if (el && el.parentNode && typeof el.parentNode.removeChild === 'function') {
          el.parentNode.removeChild(el);
        }
        styleOwners.delete(scopedKey);
        styleElements.delete(scopedKey);
        return true;
      },
      listOwnedSlots() {
        const out = [];
        for (const [sid, owner] of slotOwners.entries()) {
          if (owner === pluginId) out.push(sid);
        }
        return out;
      },
      onDispose(fn) {
        if (typeof fn !== 'function') return;
        if (!disposers.has(pluginId)) disposers.set(pluginId, []);
        disposers.get(pluginId).push(fn);
      },
      dispose() {
        const fns = disposers.get(pluginId) || [];
        disposers.delete(pluginId);
        for (const fn of fns) {
          try { fn(); } catch (_err) {}
        }
        for (const sid of handle.listOwnedSlots()) {
          try { handle.unmountSlot(sid); } catch (_err) {}
        }
        for (const [stKey, owner] of Array.from(styleOwners.entries())) {
          if (owner === pluginId) {
            const el = styleElements.get(stKey);
            if (el && el.parentNode && typeof el.parentNode.removeChild === 'function') {
              el.parentNode.removeChild(el);
            }
            styleOwners.delete(stKey);
            styleElements.delete(stKey);
          }
        }
      },
    });
    return handle;
  }

  // Public read-only surface (ZERO destructive cross-plugin methods)
  const publicApi = Object.freeze({
    hostVersion: ${serializeSafeInlineJson(hostVersion)},
    hostProfileId: ${serializeSafeInlineJson(hostProfileId)},
    getNoTranslateSelector() {
      return NO_TRANSLATE_SELECTOR;
    },
  });
  Object.defineProperty(window, '__ADDON_HOST_API__', {
    value: publicApi,
    writable: false,
    configurable: false,
    enumerable: false,
  });

  // One-time internal capability-token consumer used ONLY by host-injected plugin wrappers
  Object.defineProperty(window, '__ADDON_HOST_CONSUME_CAP__', {
    value: function(token, spec) {
      if (!token || !pendingTokens.has(token)) {
        throw new Error('ERR_INVALID_CAPABILITY_TOKEN');
      }
      pendingTokens.delete(token);
      return createScopedHandle(spec);
    },
    writable: false,
    configurable: false,
    enumerable: false,
  });
  Object.defineProperty(window, '__ADDON_HOST_REGISTER_CAP__', {
    value: function(hostSecret, token) {
      if (hostSecret !== __HOST_SECRET__) throw new Error('ERR_FORBIDDEN_CAP_REGISTRATION');
      pendingTokens.set(token, true);
    },
    writable: false,
    configurable: false,
    enumerable: false,
  });
})();`;
}

function buildHostLoaderScriptSource(paths, profile, { hostVersion = '1.0.0' } = {}) {
  assertValidHostProfile(profile);
  const extraAttrs = Array.isArray(profile.extraNoTranslateAttributes) ? profile.extraNoTranslateAttributes : [];
  const allowedProtocols =
    Array.isArray(profile.allowedUrlProtocols) && profile.allowedUrlProtocols.length > 0
      ? profile.allowedUrlProtocols
      : DEFAULT_ALLOWED_PROTOCOLS;
  const allowedHosts =
    Array.isArray(profile.allowedUrlHosts) && profile.allowedUrlHosts.length > 0
      ? profile.allowedUrlHosts.map((h) => h.toLowerCase())
      : DEFAULT_ALLOWED_HOSTS;

  const bootstrapApiTemplate = buildRendererHostApiBootstrapSource({
    hostVersion,
    hostProfileId: profile.id,
    extraNoTranslateAttributes: extraAttrs,
  });

  const cfg = {
    addonsDir: paths.ADDONS_DIR,
    pluginsRootDir: paths.PLUGINS_ROOT_DIR,
    configJsonPath: paths.CONFIG_JSON_PATH,
    hostProfileId: profile.id,
    hostVersion,
    allowedProtocols,
    allowedHosts,
    coreLifecyclePath: path.resolve(__dirname, '..', '..', 'core', 'lifecycle-coordinator.js'),
    configReaderPath: path.resolve(__dirname, 'config-reader.js'),
  };

  return `'use strict';
// Auto-generated by antigravity-native-addon-host (${profile.patchMarker}).
// Single isolated mainHook + top-frame renderer loader.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOST_CFG = ${serializeSafeInlineJson(cfg)};
const RENDERER_API_BOOTSTRAP_TEMPLATE = ${serializeSafeInlineJson(bootstrapApiTemplate)};

const { planAddonExecution } = require(HOST_CFG.coreLifecyclePath);
const { isPluginEnabledInConfig } = require(HOST_CFG.configReaderPath);

const diagnostics = [];
function recordDiag(level, code, detail) {
  diagnostics.push({ ts: new Date().toISOString(), level, code, detail: String(detail || '') });
  if (diagnostics.length > 200) diagnostics.shift();
}

function getDiagnostics() {
  return diagnostics.slice();
}

function isAllowedRendererUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return false;
  try {
    const u = new URL(rawUrl);
    if (!HOST_CFG.allowedProtocols.includes(u.protocol)) return false;
    return HOST_CFG.allowedHosts.includes(u.hostname.toLowerCase());
  } catch (_e) { return false; }
}

function collectExecutionPlan() {
  if (!fs.existsSync(HOST_CFG.addonsDir)) {
    return { active: [], disabled: [], rejected: [], slots: {} };
  }
  const rawEntries = [];
  for (const name of fs.readdirSync(HOST_CFG.addonsDir).sort()) {
    if (!name.endsWith('.json')) continue;
    const fullPath = path.join(HOST_CFG.addonsDir, name);
    try {
      rawEntries.push({ source: fullPath, manifest: JSON.parse(fs.readFileSync(fullPath, 'utf8')) });
    } catch (err) {
      recordDiag('error', 'ERR_MANIFEST_JSON_PARSE', name + ': ' + (err && err.message));
      rawEntries.push({ source: fullPath, manifest: null });
    }
  }
  const plan = planAddonExecution(rawEntries, {
    pluginsRootDir: HOST_CFG.pluginsRootDir,
    checkFilesExist: true,
    hostProfileId: HOST_CFG.hostProfileId,
    hostVersion: HOST_CFG.hostVersion,
    isEnabled: (pluginId) => isPluginEnabledInConfig(HOST_CFG.configJsonPath, pluginId),
  });
  for (const rej of plan.rejected) {
    recordDiag('warn', rej.reason || 'ERR_ADDON_REJECTED', (rej.pluginId || rej.source) + '');
  }
  return plan;
}

function collectActiveAddons() {
  return collectExecutionPlan().active.map((item) => ({
    pluginId: item.pluginId,
    loadOrder: item.loadOrder,
    rendererPath: item.resolvedEntries.rendererScript,
    mainHookPath: item.resolvedEntries.mainHookScript,
    allowedSlotIds: (item.manifest.uiSlots || []).map((s) => s.slotId),
    storageNamespace: (item.manifest.isolation && item.manifest.isolation.storageNamespace) || item.pluginId,
    ipcChannelPrefix: (item.manifest.isolation && item.manifest.isolation.ipcChannelPrefix) || null,
  }));
}

const loadedMainHooks = new Map();

function syncMainHooks(electronApp) {
  const active = collectActiveAddons();
  const activeMainIds = new Set(active.filter((a) => a.mainHookPath).map((a) => a.pluginId));

  // Deactivate any previously loaded mainHook that was disabled or unregistered
  for (const [pluginId, entry] of Array.from(loadedMainHooks.entries())) {
    if (!activeMainIds.has(pluginId)) {
      try {
        if (entry && entry.mod && typeof entry.mod.dispose === 'function') {
          entry.mod.dispose();
        }
      } catch (err) {
        recordDiag('error', 'ERR_MAIN_HOOK_DISPOSE', pluginId + ': ' + (err && err.message));
      }
      loadedMainHooks.delete(pluginId);
    }
  }

  for (const addon of active) {
    if (!addon.mainHookPath || loadedMainHooks.has(addon.pluginId)) continue;
    try {
      const mod = require(addon.mainHookPath);
      const ctx = {
        app: electronApp,
        pluginId: addon.pluginId,
        hostProfileId: HOST_CFG.hostProfileId,
        hostVersion: HOST_CFG.hostVersion,
        storageNamespace: addon.storageNamespace,
        ipcChannelPrefix: addon.ipcChannelPrefix,
      };
      if (typeof mod === 'function') mod(ctx);
      else if (mod && typeof mod.activate === 'function') mod.activate(ctx);
      loadedMainHooks.set(addon.pluginId, { mod, addon });
    } catch (err) {
      recordDiag('error', 'ERR_MAIN_HOOK_ACTIVATE', addon.pluginId + ': ' + (err && err.message));
    }
  }
}

function attachWebContents(contents, electronApp) {
  if (!contents || typeof contents.getType !== 'function' || contents.getType() !== 'window') return;
  syncMainHooks(electronApp);

  for (const [pluginId, entry] of loadedMainHooks.entries()) {
    if (entry && entry.mod && typeof entry.mod.onWebContentsCreated === 'function') {
      try {
        entry.mod.onWebContentsCreated({
          app: electronApp,
          contents,
          pluginId,
          isAllowedRendererUrl,
        });
      } catch (err) {
        recordDiag('error', 'ERR_MAIN_HOOK_WEBCONTENTS', pluginId + ': ' + (err && err.message));
      }
    }
  }

  let hostSecret = crypto.randomBytes(24).toString('hex');
  const injectedIds = new Set();
  let injectQueue = Promise.resolve();

  const enqueueInject = () => {
    injectQueue = injectQueue.then(async () => {
      try {
        const url = typeof contents.getURL === 'function' ? contents.getURL() : '';
        if (!isAllowedRendererUrl(url)) return;

        // Only re-bootstrap when the document was actually loaded/reloaded (SPA pushState preserves __ADDON_HOST_API__)
        let hasApi = false;
        try {
          hasApi = Boolean(await contents.executeJavaScript('Boolean(window.__ADDON_HOST_API__)', true));
        } catch (_e) { hasApi = false; }

        if (!hasApi) {
          injectedIds.clear();
          hostSecret = crypto.randomBytes(24).toString('hex');
          const bootstrapWithSecret = '(function(){ const __HOST_SECRET__ = ' + JSON.stringify(hostSecret) + ';\\n' + RENDERER_API_BOOTSTRAP_TEMPLATE + '\\n})();';
          await contents.executeJavaScript(bootstrapWithSecret, true);
        }

        const addons = collectActiveAddons().filter((a) => a.rendererPath && !injectedIds.has(a.pluginId));
        // Deterministic sequential execution preserves loadOrder while isolating each plugin's faults
        for (const addon of addons) {
          try {
            const capToken = crypto.randomBytes(24).toString('hex');
            await contents.executeJavaScript(
              'window.__ADDON_HOST_REGISTER_CAP__(' + JSON.stringify(hostSecret) + ',' + JSON.stringify(capToken) + ');',
              true
            );
            const rawCode = fs.readFileSync(addon.rendererPath, 'utf8');
            const spec = {
              pluginId: addon.pluginId,
              allowedSlotIds: addon.allowedSlotIds,
              storageNamespace: addon.storageNamespace,
              ipcChannelPrefix: addon.ipcChannelPrefix,
            };
            const wrapped =
              '(function(addonHost){\\n' +
              rawCode +
              '\\n})(window.__ADDON_HOST_CONSUME_CAP__(' +
              JSON.stringify(capToken) + ',' + JSON.stringify(spec) + '));';
            await contents.executeJavaScript(wrapped, true);
            injectedIds.add(addon.pluginId);
          } catch (err) {
            recordDiag('error', 'ERR_RENDERER_INJECT', addon.pluginId + ': ' + (err && err.message));
          }
        }
      } catch (err) {
        recordDiag('error', 'ERR_INJECT_PASS', err && err.message);
      }
    });
    return injectQueue;
  };

  if (typeof contents.on === 'function') {
    contents.on('dom-ready', () => { void enqueueInject(); });
    contents.on('did-finish-load', () => { void enqueueInject(); });
  }
}

module.exports = {
  isAllowedRendererUrl,
  isAllowedHubUrl: isAllowedRendererUrl,
  collectActiveAddons,
  syncMainHooks,
  runMainHooks: syncMainHooks,
  attachWebContents,
  getDiagnostics,
};
`;
}

module.exports = {
  DEFAULT_ALLOWED_PROTOCOLS,
  DEFAULT_ALLOWED_HOSTS,
  isAllowedRendererUrl,
  isAllowedHubUrl: isAllowedRendererUrl,
  serializeSafeInlineJson,
  loadRawManifestsFromDir,
  collectExecutableAddons,
  buildRendererHostApiBootstrapSource,
  buildHostLoaderScriptSource,
};
