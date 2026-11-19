'use strict';

/**
 * Generates the single shared Electron host loader (`addon-host-loader.js`)
 * consumed by the 1-line `app.asar` bootstrap hook.
 *
 * Security & Isolation Guarantees:
 * - Single source of truth: runtime loader delegates directly to `src/core/lifecycle-coordinator.js`
 *   (Ajv schema, FORBIDDEN_IDS, pluginId regex, duplicate pluginId blocking, pluginsRoot symlink
 *   confinement, compatibility, slot/namespace/IPC conflict checks).
 * - Prototype-pollution-immune Capability-Token Scoped API:
 *   - Captures pristine Object/Array/Function primitives at bootstrap before any plugin runs.
 *   - Stores pending capability tokens and owned slots/styles in null-prototype dictionaries
 *     (`Object.create(null)`) so hooked `Map.prototype.set` / `Object.prototype` cannot steal tokens.
 *   - Binds immutable `spec` at `__ADDON_HOST_REGISTER_CAP__(hostSecret, token, spec)` time so
 *     `__ADDON_HOST_CONSUME_CAP__(token)` ignores any caller-supplied spec.
 *   - Verifies live host ownership via a non-spoofable nonce challenge (`__ADDON_HOST_VERIFY__`)
 *     before sending `hostSecret` into the renderer.
 * - Serialized injection queue (`dom-ready` + `did-finish-load` race-free), deterministic sequential
 *   `loadOrder` execution with per-plugin `try/catch` fault isolation, SPA `pushState` non-re-injection,
 *   and `syncMainHooks` on both `attachWebContents` and `enqueueInject` so single-window reloads
 *   immediately dispose disabled/unregistered `mainHook`s.
 */

const fs = require('node:fs');
const path = require('node:path');
const { assertValidElectronHostProfile } = require('./electron-host-profile-port');
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
  hostVersion = '1.0.1',
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
  const _ObjCreate = Object.create;
  const _ObjFreeze = Object.freeze;
  const _ObjDefineProperty = Object.defineProperty;
  const _ObjKeys = Object.keys;
  const _has = typeof Object.hasOwn === 'function'
    ? Object.hasOwn
    : Function.prototype.call.bind(Object.prototype.hasOwnProperty);
  const _ArrayIsArray = Array.isArray;
  const _String = String;
  const _Error = Error;
  const _FnCall = Function.prototype.call;

  // R5-F3: Null-prototype property descriptors prevent Object.prototype.get/set pollution
  // from causing TypeError: Invalid property descriptor during defineProperty calls.
  function makeDataDesc(value, writable, enumerable, configurable) {
    const d = _ObjCreate(null);
    d.value = value;
    d.writable = writable;
    d.enumerable = enumerable;
    d.configurable = configurable;
    return d;
  }

  // R3-F1: Never trust a pre-existing window.__ADDON_HOST_VERIFY__ before defining our own
  // non-configurable properties. If a page pre-spoofed them as non-configurable, _ObjDefineProperty
  // throws and the host fails closed without leaking hostSecret or capToken.
  const NO_TRANSLATE_SELECTOR = ${serializeSafeInlineJson(noTranslateSelector)};
  const EXTRA_NO_TRANSLATE_ATTRS = _ObjFreeze(${serializeSafeInlineJson(extraAttrs)});
  const slotOwners = _ObjCreate(null);
  const slotElements = _ObjCreate(null);
  const styleOwners = _ObjCreate(null);
  const styleElements = _ObjCreate(null);
  const disposers = _ObjCreate(null);
  const pendingSpecs = _ObjCreate(null);
  const activeHandles = _ObjCreate(null);

  function createScopedHandle(spec) {
    const pluginId = _String(spec.pluginId);
    const allowedSlots = spec.allowedSlotsMap || _ObjCreate(null);
    const storageNamespace = spec.storageNamespace ? _String(spec.storageNamespace) : pluginId;
    const ipcChannelPrefix = spec.ipcChannelPrefix ? _String(spec.ipcChannelPrefix) : null;

    const handle = _ObjFreeze({
      pluginId,
      hostVersion: ${serializeSafeInlineJson(hostVersion)},
      hostProfileId: ${serializeSafeInlineJson(hostProfileId)},
      storageNamespace,
      ipcChannelPrefix,
      getNoTranslateSelector() {
        return NO_TRANSLATE_SELECTOR;
      },
      mountSlot(slotId, parentEl) {
        if (!slotId || typeof slotId !== 'string') throw new _Error('ERR_INVALID_SLOT_ID');
        if (!_has(allowedSlots, slotId)) {
          throw new _Error('ERR_UNDECLARED_SLOT:' + slotId);
        }
        if (_has(slotOwners, slotId) && slotOwners[slotId] !== pluginId) {
          throw new _Error('ERR_SLOT_OWNED_BY_ANOTHER_PLUGIN:' + slotId);
        }
        let el = _has(slotElements, slotId) ? slotElements[slotId] : null;
        if (!el) {
          el = document.createElement('div');
          el.setAttribute('translate', 'no');
          for (let i = 0; i < EXTRA_NO_TRANSLATE_ATTRS.length; i++) {
            el.setAttribute(EXTRA_NO_TRANSLATE_ATTRS[i], 'true');
          }
          el.setAttribute('data-addon-host-owner', pluginId);
          el.setAttribute('data-addon-host-slot', slotId);
          slotOwners[slotId] = pluginId;
          slotElements[slotId] = el;
        }
        const hostParent = parentEl || document.body;
        if (hostParent && el.parentNode !== hostParent && typeof hostParent.appendChild === 'function') {
          hostParent.appendChild(el);
        }
        return el;
      },
      unmountSlot(slotId) {
        if (!_has(slotOwners, slotId)) return false;
        if (slotOwners[slotId] !== pluginId) throw new _Error('ERR_FORBIDDEN_CROSS_PLUGIN_UNMOUNT:' + slotId);
        const el = slotElements[slotId];
        if (el && el.parentNode && typeof el.parentNode.removeChild === 'function') {
          el.parentNode.removeChild(el);
        }
        delete slotOwners[slotId];
        delete slotElements[slotId];
        return true;
      },
      injectStyle(styleId, cssText) {
        if (!styleId || typeof styleId !== 'string') throw new _Error('ERR_INVALID_STYLE_ID');
        const scopedKey = pluginId + ':' + styleId;
        if (_has(styleOwners, scopedKey) && styleOwners[scopedKey] !== pluginId) {
          throw new _Error('ERR_STYLE_OWNED_BY_ANOTHER_PLUGIN:' + styleId);
        }
        let styleEl = _has(styleElements, scopedKey) ? styleElements[scopedKey] : null;
        if (!styleEl) {
          styleEl = document.createElement('style');
          styleEl.setAttribute('data-addon-host-owner', pluginId);
          styleEl.setAttribute('data-addon-host-style', scopedKey);
          styleOwners[scopedKey] = pluginId;
          styleElements[scopedKey] = styleEl;
          const head = document.head || document.documentElement || document.body;
          if (head && typeof head.appendChild === 'function') head.appendChild(styleEl);
        }
        styleEl.textContent = _String(cssText || '');
        return styleEl;
      },
      removeStyle(styleId) {
        const scopedKey = pluginId + ':' + styleId;
        if (!_has(styleOwners, scopedKey)) return false;
        if (styleOwners[scopedKey] !== pluginId) throw new _Error('ERR_FORBIDDEN_CROSS_PLUGIN_STYLE_REMOVE:' + styleId);
        const el = styleElements[scopedKey];
        if (el && el.parentNode && typeof el.parentNode.removeChild === 'function') {
          el.parentNode.removeChild(el);
        }
        delete styleOwners[scopedKey];
        delete styleElements[scopedKey];
        return true;
      },
      listOwnedSlots() {
        const out = [];
        let outLen = 0;
        const keys = _ObjKeys(slotOwners);
        for (let i = 0; i < keys.length; i++) {
          if (slotOwners[keys[i]] === pluginId) {
            _ObjDefineProperty(out, outLen++, makeDataDesc(keys[i], true, true, true));
          }
        }
        return out;
      },
      onDispose(fn) {
        if (typeof fn !== 'function') return;
        if (!_has(disposers, pluginId)) {
          disposers[pluginId] = { count: 0, items: _ObjCreate(null) };
        }
        const bucket = disposers[pluginId];
        bucket.items[bucket.count++] = fn;
      },
      dispose() {
        // R5-F3 & NB2: Isolate every cleanup phase independently and invoke disposers with undefined this
        try {
          const bucket = _has(disposers, pluginId) ? disposers[pluginId] : null;
          delete disposers[pluginId];
          if (bucket) {
            for (let i = 0; i < bucket.count; i++) {
              try { _FnCall.call(bucket.items[i], undefined); } catch (_err) {}
            }
          }
        } catch (_err) {}
        try {
          const owned = handle.listOwnedSlots();
          for (let i = 0; i < owned.length; i++) {
            try { handle.unmountSlot(owned[i]); } catch (_err) {}
          }
        } catch (_err) {}
        try {
          const stKeys = _ObjKeys(styleOwners);
          for (let i = 0; i < stKeys.length; i++) {
            const stKey = stKeys[i];
            if (styleOwners[stKey] === pluginId) {
              try {
                const el = styleElements[stKey];
                if (el && el.parentNode && typeof el.parentNode.removeChild === 'function') {
                  el.parentNode.removeChild(el);
                }
              } catch (_err) {}
              delete styleOwners[stKey];
              delete styleElements[stKey];
            }
          }
        } catch (_err) {}
      },
    });
    return handle;
  }

  // Public read-only surface (ZERO destructive cross-plugin methods)
  const publicApi = _ObjFreeze({
    hostVersion: ${serializeSafeInlineJson(hostVersion)},
    hostProfileId: ${serializeSafeInlineJson(hostProfileId)},
    getNoTranslateSelector() {
      return NO_TRANSLATE_SELECTOR;
    },
  });
  _ObjDefineProperty(window, '__ADDON_HOST_API__', makeDataDesc(publicApi, false, false, false));

  // Non-spoofable liveness challenge bound to host-generated __INSTANCE_NONCE__
  _ObjDefineProperty(
    window,
    '__ADDON_HOST_VERIFY__',
    makeDataDesc(
      function(nonce) {
        return typeof nonce === 'string' && nonce === __INSTANCE_NONCE__;
      },
      false,
      false,
      false
    )
  );

  // Host binds immutable spec at registration time (caller of CONSUME_CAP cannot pass/forge spec)
  _ObjDefineProperty(
    window,
    '__ADDON_HOST_REGISTER_CAP__',
    makeDataDesc(
      function(hostSecret, token, spec) {
        if (hostSecret !== __HOST_SECRET__) throw new _Error('ERR_FORBIDDEN_CAP_REGISTRATION');
        if (typeof token !== 'string' || !token || !spec || typeof spec !== 'object') {
          throw new _Error('ERR_INVALID_CAP_REGISTRATION');
        }
        const rawSlots = _ArrayIsArray(spec.allowedSlotIds) ? spec.allowedSlotIds : [];
        const allowedSlotsMap = _ObjCreate(null);
        for (let i = 0; i < rawSlots.length; i++) {
          if (_has(rawSlots, i)) {
            allowedSlotsMap[_String(rawSlots[i])] = true;
          }
        }
        pendingSpecs[token] = _ObjFreeze({
          pluginId: _String(spec.pluginId),
          allowedSlotsMap: _ObjFreeze(allowedSlotsMap),
          storageNamespace: spec.storageNamespace ? _String(spec.storageNamespace) : _String(spec.pluginId),
          ipcChannelPrefix: spec.ipcChannelPrefix ? _String(spec.ipcChannelPrefix) : null,
        });
      },
      false,
      false,
      false
    )
  );

  _ObjDefineProperty(
    window,
    '__ADDON_HOST_CONSUME_CAP__',
    makeDataDesc(
      function(token) {
        if (typeof token !== 'string' || !_has(pendingSpecs, token)) {
          throw new _Error('ERR_INVALID_CAPABILITY_TOKEN');
        }
        const boundSpec = pendingSpecs[token];
        delete pendingSpecs[token];
        const scoped = createScopedHandle(boundSpec);
        activeHandles[boundSpec.pluginId] = scoped;
        return scoped;
      },
      false,
      false,
      false
    )
  );

  // R5-F5: Host-authenticated renderer disposal when a plugin is disabled/unregistered on reload
  _ObjDefineProperty(
    window,
    '__ADDON_HOST_DISPOSE__',
    makeDataDesc(
      function(hostSecret, pluginId) {
        if (hostSecret !== __HOST_SECRET__) throw new _Error('ERR_FORBIDDEN_HOST_DISPOSE');
        const id = _String(pluginId || '');
        if (!_has(activeHandles, id)) return false;
        const h = activeHandles[id];
        delete activeHandles[id];
        if (h && typeof h.dispose === 'function') {
          h.dispose();
        }
        return true;
      },
      false,
      false,
      false
    )
  );
})();`;
}

function buildHostLoaderScriptSource(paths, profile, { hostVersion = '1.0.1' } = {}) {
  assertValidElectronHostProfile(profile);
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

  let hostSecret = '';
  let instanceNonce = '';
  const injectedIds = new Set();
  let injectQueue = Promise.resolve();

  const enqueueInject = () => {
    injectQueue = injectQueue.then(async () => {
      try {
        // F4: Re-sync mainHooks on every reload/navigation so disabled hooks dispose even in a single-window session
        syncMainHooks(electronApp);

        const url = typeof contents.getURL === 'function' ? contents.getURL() : '';
        if (!isAllowedRendererUrl(url)) return;

        const verifyLiveNonce = async (nonceToCheck) => {
          if (!nonceToCheck) return false;
          try {
            return Boolean(
              await contents.executeJavaScript(
                'typeof window.__ADDON_HOST_VERIFY__ === "function" && window.__ADDON_HOST_VERIFY__(' +
                  JSON.stringify(nonceToCheck) + ')',
                true
              )
            );
          } catch (_e) {
            return false;
          }
        };

        const verifyDocumentStillTrusted = async () => {
          const liveUrl = typeof contents.getURL === 'function' ? contents.getURL() : '';
          if (!isAllowedRendererUrl(liveUrl)) return false;
          return verifyLiveNonce(instanceNonce);
        };

        const resetCredentials = () => {
          injectedIds.clear();
          hostSecret = '';
          instanceNonce = '';
        };

        // F3: Non-spoofable nonce challenge verifies that THIS host bootstrapped the current document
        const verifiedLive = await verifyLiveNonce(instanceNonce);

        if (!verifiedLive) {
          resetCredentials();
          const nextSecret = crypto.randomBytes(24).toString('hex');
          const nextNonce = crypto.randomBytes(24).toString('hex');
          const bootstrapWithSecrets =
            '(function(){ const __HOST_SECRET__ = ' + JSON.stringify(nextSecret) +
            '; const __INSTANCE_NONCE__ = ' + JSON.stringify(nextNonce) + ';\\n' +
            RENDERER_API_BOOTSTRAP_TEMPLATE + '\\n})();';
          await contents.executeJavaScript(bootstrapWithSecrets, true);
          const postUrl = typeof contents.getURL === 'function' ? contents.getURL() : '';
          const postVerify = isAllowedRendererUrl(postUrl) && (await verifyLiveNonce(nextNonce));
          if (!postVerify) {
            recordDiag('error', 'ERR_HOST_BOOTSTRAP_SPOOFED', 'Renderer API verification failed after bootstrap');
            return;
          }
          // R4-F1: Commit closure credentials ONLY after bootstrap + postVerify both succeed
          hostSecret = nextSecret;
          instanceNonce = nextNonce;
        }

        const activeRendererAddons = collectActiveAddons().filter((a) => a.rendererPath);
        const activeRendererIds = new Set(activeRendererAddons.map((a) => a.pluginId));

        // R5-F5: Dispose any previously injected renderer addon that is now disabled/unregistered
        if (verifiedLive && injectedIds.size > 0) {
          for (const prevId of Array.from(injectedIds)) {
            if (!activeRendererIds.has(prevId)) {
              if (!(await verifyDocumentStillTrusted())) {
                recordDiag('warn', 'ERR_RENDERER_TOCTOU_ABORT', 'Document origin/nonce changed before dispose');
                resetCredentials();
                return;
              }
              try {
                await contents.executeJavaScript(
                  'typeof window.__ADDON_HOST_DISPOSE__ === "function" && window.__ADDON_HOST_DISPOSE__(' +
                    JSON.stringify(hostSecret) + ',' +
                    JSON.stringify(prevId) + ');',
                  true
                );
              } catch (err) {
                recordDiag('error', 'ERR_RENDERER_DISPOSE', prevId + ': ' + (err && err.message));
              }
              injectedIds.delete(prevId);
            }
          }
        }

        const addons = activeRendererAddons.filter((a) => !injectedIds.has(a.pluginId));
        // Deterministic sequential execution preserves loadOrder while isolating each plugin's faults
        for (const addon of addons) {
          try {
            // NB2: Read renderer script BEFORE registering capability token so missing/unreadable files leak no token
            const rawCode = fs.readFileSync(addon.rendererPath, 'utf8');
            // R5-F2: Re-verify URL + instanceNonce immediately before REGISTER_CAP (prevents async redirect TOCTOU)
            if (!(await verifyDocumentStillTrusted())) {
              recordDiag('warn', 'ERR_RENDERER_TOCTOU_ABORT', addon.pluginId + ': origin/nonce changed before cap registration');
              resetCredentials();
              break;
            }
            const capToken = crypto.randomBytes(24).toString('hex');
            const spec = {
              pluginId: addon.pluginId,
              allowedSlotIds: addon.allowedSlotIds,
              storageNamespace: addon.storageNamespace,
              ipcChannelPrefix: addon.ipcChannelPrefix,
            };
            await contents.executeJavaScript(
              'window.__ADDON_HOST_REGISTER_CAP__(' +
                JSON.stringify(hostSecret) + ',' +
                JSON.stringify(capToken) + ',' +
                JSON.stringify(spec) + ');',
              true
            );
            // R5-F2: Re-verify URL + instanceNonce immediately before executing plugin wrapper
            if (!(await verifyDocumentStillTrusted())) {
              recordDiag('warn', 'ERR_RENDERER_TOCTOU_ABORT', addon.pluginId + ': origin/nonce changed before execution');
              resetCredentials();
              break;
            }
            const wrapped =
              '(function(addonHost){\\n' +
              rawCode +
              '\\n})(window.__ADDON_HOST_CONSUME_CAP__(' +
              JSON.stringify(capToken) + '));';
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
