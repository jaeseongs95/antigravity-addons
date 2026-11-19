'use strict';

/**
 * Generates the single shared Electron host loader (`addon-host-loader.js`)
 * consumed by the 1-line `app.asar` bootstrap hook.
 *
 * Security & Isolation Guarantees (v1.1.0):
 * - Single source of truth: runtime loader delegates to `src/core/lifecycle-coordinator.js`
 *   with injected `NodeFileSystemPort` (`src/adapters/node-fs-port.js`).
 * - Explicit Trust Model (`trusted` | `restricted`) + Owner CSS Auto-Scoping:
 *   - Non-`document-transform` & `restricted` addons automatically scope CSS rules under
 *     `[data-addon-host-owner="<pluginId>"]`, blocking `@import`/`javascript:`/`expression(`
 *     and rejecting `{ scope: "global" }` (`ERR_FORBIDDEN_GLOBAL_STYLE_SCOPE`).
 *   - Prototype-pollution-immune Capability-Token Scoped API (`Reflect.apply`, null-prototype
 *     dictionaries & descriptors, non-spoofable nonce challenge, origin+location verification).
 * - Least-Privilege `mainHook` & `webContents` Brokers:
 *   - Never passes raw Electron `app` or raw `webContents` to plugins.
 *   - Enforces URL allowlist and `isolatedWorldId` on every isolated execution and auto-cleans
 *     every broker-registered listener on `dispose()` or async activation failure.
 * - Async Fault Isolation & Explicit Addon Lifecycle State Machine:
 *   - Tracks `PENDING` -> `ACTIVATING` -> `ACTIVE` / `FAILED` / `DISPOSING` -> `DISPOSED`
 *     per addon (`getAddonLifecycleStates()`), catches async `activate()`/`dispose()` rejections
 *     and activation timeouts, and provides `addonHost.runSafe()`, `reportError()`, and
 *     `addManagedListener()`.
 */

const fs = require('node:fs');
const path = require('node:path');
const pkg = require('../../../package.json');
const { assertValidElectronHostProfile } = require('./electron-host-profile-port');
const { planAddonExecution } = require('../../core/lifecycle-coordinator');
const { createNodeFileSystemPort } = require('../node-fs-port');
const { isPluginEnabledInConfig } = require('./config-reader');

const DEFAULT_ALLOWED_PROTOCOLS = Object.freeze(['http:', 'https:']);
const DEFAULT_ALLOWED_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '::1', '[::1]']);
const DEFAULT_NODE_FS_PORT = createNodeFileSystemPort();

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
  {
    checkFilesExist = true,
    hostProfileId = null,
    hostVersion = null,
    strictTrustPolicy = false,
    fsPort = DEFAULT_NODE_FS_PORT,
  } = {}
) {
  const rawEntries = loadRawManifestsFromDir(paths.ADDONS_DIR);
  return planAddonExecution(rawEntries, {
    pluginsRootDir: paths.PLUGINS_ROOT_DIR,
    checkFilesExist,
    hostProfileId,
    hostVersion,
    strictTrustPolicy,
    fsPort,
    isEnabled: (pluginId) => isPluginEnabledInConfig(paths.CONFIG_JSON_PATH, pluginId),
  });
}

function buildRendererHostApiBootstrapSource({
  hostVersion = pkg.version,
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
  'use strict';
  const _ObjCreate = Object.create;
  const _ObjFreeze = Object.freeze;
  const _ObjDefineProperty = Object.defineProperty;
  const _ObjKeys = Object.keys;
  const _has = typeof Object.hasOwn === 'function'
    ? Object.hasOwn
    : Function.prototype.call.bind(Object.prototype.hasOwnProperty);
  const _ArrayIsArray = Array.isArray;
  const _String = String;
  const _StrToLower = String.prototype.toLowerCase;
  const _StrTrim = String.prototype.trim;
  const _StrSlice = String.prototype.slice;
  const _StrIndexOf = String.prototype.indexOf;
  const _StrReplace = String.prototype.replace;
  const _RegExpTest = RegExp.prototype.test;
  const _Error = Error;
  const _Promise = Promise;
  const _ReflectApply = Reflect.apply;

  function toLowerSafe(v) {
    return _ReflectApply(_StrToLower, _String(v || ''), []);
  }
  function trimSafe(v) {
    return _ReflectApply(_StrTrim, _String(v || ''), []);
  }
  function sliceSafe(v, s, e) {
    return e === undefined
      ? _ReflectApply(_StrSlice, _String(v || ''), [s])
      : _ReflectApply(_StrSlice, _String(v || ''), [s, e]);
  }
  function indexOfSafe(v, needle, fromIdx) {
    return fromIdx === undefined
      ? _ReflectApply(_StrIndexOf, _String(v || ''), [needle])
      : _ReflectApply(_StrIndexOf, _String(v || ''), [needle, fromIdx]);
  }
  function replaceSafe(v, re, rep) {
    return _ReflectApply(_StrReplace, _String(v || ''), [re, rep]);
  }
  function testSafe(re, v) {
    return _ReflectApply(_RegExpTest, re, [_String(v || '')]);
  }

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

  // P1: CSS danger filter + owner selector scoping (prototype-pollution immune)
  const FORBIDDEN_CSS_RE = /@import\\b|javascript\\s*:|expression\\s*\\(|behavior\\s*:|-moz-binding\\s*:/i;
  const CSS_COMMENT_RE = /\\/\\*[\\s\\S]*?\\*\\//g;
  const AT_PRESERVE_RE = /^@(?:(?:-webkit-)?keyframes|font-face|property|counter-style)\\b/i;
  const AT_NESTED_RE = /^@(?:media|supports|container|layer|document)\\b/i;
  const ROOT_TAG_ONLY_RE = /^(?::root|html|body)$/i;
  const ROOT_TAG_PREFIX_RE = /^(?:html|body)(?=[\\s>+~.#\\[:])/i;

  function assertSafeCssConstructs(rawCss) {
    const withoutComments = replaceSafe(rawCss, CSS_COMMENT_RE, '');
    if (testSafe(FORBIDDEN_CSS_RE, withoutComments)) {
      throw new _Error('ERR_FORBIDDEN_CSS_CONSTRUCT');
    }
    return withoutComments;
  }

  function scopeSelectorList(selectorList, ownerPrefix) {
    let out = '';
    let start = 0;
    let parenDepth = 0;
    let bracketDepth = 0;
    let quote = '';
    const len = selectorList.length;

    function appendScoped(part) {
      const sel = trimSafe(part);
      if (!sel) return;
      let scoped;
      if (indexOfSafe(sel, ownerPrefix) !== -1) {
        scoped = sel;
      } else if (testSafe(ROOT_TAG_ONLY_RE, sel)) {
        scoped = ownerPrefix;
      } else if (testSafe(ROOT_TAG_PREFIX_RE, sel)) {
        scoped = ownerPrefix + replaceSafe(sel, ROOT_TAG_PREFIX_RE, '');
      } else {
        scoped = ownerPrefix + ' ' + sel;
      }
      out = out ? out + ', ' + scoped : scoped;
    }

    for (let i = 0; i < len; i++) {
      const ch = selectorList[i];
      if (quote) {
        if (ch === '\\\\') { i++; continue; }
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '(') { parenDepth++; continue; }
      if (ch === ')' && parenDepth > 0) { parenDepth--; continue; }
      if (ch === '[') { bracketDepth++; continue; }
      if (ch === ']' && bracketDepth > 0) { bracketDepth--; continue; }
      if (ch === ',' && parenDepth === 0 && bracketDepth === 0) {
        appendScoped(sliceSafe(selectorList, start, i));
        start = i + 1;
      }
    }
    appendScoped(sliceSafe(selectorList, start));
    return out;
  }

  function scopeCssBlock(cssText, ownerPrefix) {
    let out = '';
    let i = 0;
    const len = cssText.length;

    while (i < len) {
      let headerStart = i;
      let bracePos = -1;
      let semiPos = -1;
      let quote = '';
      for (let j = i; j < len; j++) {
        const ch = cssText[j];
        if (quote) {
          if (ch === '\\\\') { j++; continue; }
          if (ch === quote) quote = '';
          continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === ';') { semiPos = j; break; }
        if (ch === '{') { bracePos = j; break; }
      }
      if (semiPos !== -1 && (bracePos === -1 || semiPos < bracePos)) {
        const stmt = trimSafe(sliceSafe(cssText, headerStart, semiPos + 1));
        if (stmt) out += stmt + '\\n';
        i = semiPos + 1;
        continue;
      }
      if (bracePos === -1) {
        break;
      }
      let depth = 1;
      let k = bracePos + 1;
      quote = '';
      while (k < len && depth > 0) {
        const ch = cssText[k];
        if (quote) {
          if (ch === '\\\\') { k += 2; continue; }
          if (ch === quote) quote = '';
          k++;
          continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; k++; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        k++;
      }
      const header = trimSafe(sliceSafe(cssText, headerStart, bracePos));
      const body = sliceSafe(cssText, bracePos + 1, Math.max(bracePos + 1, k - 1));
      if (header) {
        if (header[0] === '@') {
          if (testSafe(AT_PRESERVE_RE, header)) {
            out += header + ' {' + body + '}\\n';
          } else if (testSafe(AT_NESTED_RE, header)) {
            out += header + ' {\\n' + scopeCssBlock(body, ownerPrefix) + '}\\n';
          } else {
            out += header + ' {' + body + '}\\n';
          }
        } else {
          const scopedHeader = scopeSelectorList(header, ownerPrefix);
          if (scopedHeader) {
            out += scopedHeader + ' {' + body + '}\\n';
          }
        }
      }
      i = k;
    }
    return trimSafe(out);
  }

  function scopeCssToOwner(rawCss, pluginId) {
    const clean = assertSafeCssConstructs(rawCss);
    const ownerPrefix = '[data-addon-host-owner="' + pluginId + '"]';
    return scopeCssBlock(clean, ownerPrefix);
  }

  // R7-F3: Strictly compare protocol + host (+ non-'null' origin) so custom schemes
  // (e.g. app://internal.local/main, vscode-file://...) work accurately while 'null' origin frames fail closed.
  function assertHostOriginAndAuth(hostSecret, nonce, expectedLoc, errCode) {
    if (hostSecret !== __HOST_SECRET__ || typeof nonce !== 'string' || nonce !== __INSTANCE_NONCE__) {
      throw new _Error(errCode);
    }
    if (expectedLoc && typeof expectedLoc === 'object') {
      if (typeof window !== 'object' || !window || !window.location) {
        throw new _Error('ERR_FORBIDDEN_ORIGIN_MISMATCH');
      }
      const liveProto = toLowerSafe(window.location.protocol);
      const liveHost = toLowerSafe(window.location.host);
      const liveOrigin = typeof window.location.origin === 'string' ? toLowerSafe(window.location.origin) : '';
      if (liveProto !== expectedLoc.protocol || liveHost !== expectedLoc.host) {
        throw new _Error('ERR_FORBIDDEN_ORIGIN_MISMATCH');
      }
      if (expectedLoc.origin) {
        if (!liveOrigin || liveOrigin === 'null' || liveOrigin !== expectedLoc.origin) {
          throw new _Error('ERR_FORBIDDEN_ORIGIN_MISMATCH');
        }
      } else if (liveOrigin && liveOrigin !== 'null') {
        const expectedAuthOrigin = expectedLoc.host ? expectedLoc.protocol + '//' + expectedLoc.host : '';
        if (!expectedAuthOrigin || liveOrigin !== expectedAuthOrigin) {
          throw new _Error('ERR_FORBIDDEN_ORIGIN_MISMATCH');
        }
      }
    }
  }

  const NO_TRANSLATE_SELECTOR = ${serializeSafeInlineJson(noTranslateSelector)};
  const EXTRA_NO_TRANSLATE_ATTRS = _ObjFreeze(${serializeSafeInlineJson(extraAttrs)});
  const slotOwners = _ObjCreate(null);
  const slotElements = _ObjCreate(null);
  const styleOwners = _ObjCreate(null);
  const styleElements = _ObjCreate(null);
  const disposers = _ObjCreate(null);
  const managedListeners = _ObjCreate(null);
  const pluginErrors = _ObjCreate(null);
  const pendingSpecs = _ObjCreate(null);
  const activeHandles = _ObjCreate(null);

  function recordPluginError(pluginId, err) {
    if (!_has(pluginErrors, pluginId)) {
      pluginErrors[pluginId] = { count: 0, items: _ObjCreate(null) };
    }
    const bucket = pluginErrors[pluginId];
    const msg = err && typeof err === 'object' && err.message ? _String(err.message) : _String(err || 'UNKNOWN_ERROR');
    bucket.items[bucket.count % 20] = _ObjFreeze({ seq: bucket.count + 1, message: msg });
    bucket.count++;
  }

  function createScopedHandle(spec) {
    const pluginId = _String(spec.pluginId);
    const allowedSlots = spec.allowedSlotsMap || _ObjCreate(null);
    const storageNamespace = spec.storageNamespace ? _String(spec.storageNamespace) : pluginId;
    const ipcChannelPrefix = spec.ipcChannelPrefix ? _String(spec.ipcChannelPrefix) : null;
    const trustLevel = spec.trustLevel === 'trusted' ? 'trusted' : 'restricted';
    const hasDocumentTransformSlot = Boolean(spec.hasDocumentTransformSlot);
    const allowGlobalStyle = trustLevel === 'trusted' && hasDocumentTransformSlot;
    let disposed = false;

    function assertNotDisposed() {
      if (disposed) throw new _Error('ERR_HANDLE_DISPOSED:' + pluginId);
    }

    const handle = _ObjFreeze({
      pluginId,
      trustLevel,
      hostVersion: ${serializeSafeInlineJson(hostVersion)},
      hostProfileId: ${serializeSafeInlineJson(hostProfileId)},
      storageNamespace,
      ipcChannelPrefix,
      getNoTranslateSelector() {
        return NO_TRANSLATE_SELECTOR;
      },
      mountSlot(slotId, parentEl, opts) {
        assertNotDisposed();
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
        if (opts && typeof opts === 'object' && opts.shadow === true && typeof el.attachShadow === 'function') {
          return el.shadowRoot || el.attachShadow({ mode: 'open' });
        }
        return el;
      },
      unmountSlot(slotId) {
        assertNotDisposed();
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
      injectStyle(styleId, cssText, opts) {
        assertNotDisposed();
        if (!styleId || typeof styleId !== 'string') throw new _Error('ERR_INVALID_STYLE_ID');
        const scopedKey = pluginId + ':' + styleId;
        if (_has(styleOwners, scopedKey) && styleOwners[scopedKey] !== pluginId) {
          throw new _Error('ERR_STYLE_OWNED_BY_ANOTHER_PLUGIN:' + styleId);
        }
        const rawCss = _String(cssText || '');
        const requestedScope =
          opts && typeof opts === 'object' && typeof opts.scope === 'string'
            ? opts.scope
            : allowGlobalStyle
              ? 'global'
              : 'owner';
        if (requestedScope !== 'owner' && requestedScope !== 'global') {
          throw new _Error('ERR_INVALID_STYLE_SCOPE:' + requestedScope);
        }
        if (requestedScope === 'global' && !allowGlobalStyle) {
          throw new _Error('ERR_FORBIDDEN_GLOBAL_STYLE_SCOPE:' + pluginId);
        }
        const finalCss = requestedScope === 'global'
          ? assertSafeCssConstructs(rawCss)
          : scopeCssToOwner(rawCss, pluginId);

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
        styleEl.setAttribute('data-addon-host-style-scope', requestedScope);
        styleEl.textContent = finalCss;
        return styleEl;
      },
      removeStyle(styleId) {
        assertNotDisposed();
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
      reportError(err) {
        recordPluginError(pluginId, err);
      },
      runSafe(fn) {
        if (disposed || typeof fn !== 'function') return _Promise.resolve(undefined);
        try {
          const res = _ReflectApply(fn, undefined, []);
          if (res && typeof res.then === 'function') {
            return _Promise.resolve(res).catch((asyncErr) => {
              recordPluginError(pluginId, asyncErr);
              return undefined;
            });
          }
          return _Promise.resolve(res);
        } catch (syncErr) {
          recordPluginError(pluginId, syncErr);
          return _Promise.resolve(undefined);
        }
      },
      addManagedListener(target, eventType, handler, opts) {
        assertNotDisposed();
        if (!target || typeof target.addEventListener !== 'function' || typeof handler !== 'function') {
          throw new _Error('ERR_INVALID_LISTENER_TARGET');
        }
        const wrapped = function() {
          if (disposed) return;
          try {
            const ret = _ReflectApply(handler, this, arguments);
            if (ret && typeof ret.then === 'function') {
              _Promise.resolve(ret).catch((asyncErr) => recordPluginError(pluginId, asyncErr));
            }
          } catch (syncErr) {
            recordPluginError(pluginId, syncErr);
          }
        };
        target.addEventListener(eventType, wrapped, opts);
        if (!_has(managedListeners, pluginId)) {
          managedListeners[pluginId] = { count: 0, items: _ObjCreate(null) };
        }
        const bucket = managedListeners[pluginId];
        const idx = bucket.count++;
        bucket.items[idx] = { target, eventType, wrapped, opts, removed: false };
        return function removeManagedListener() {
          const item = bucket.items[idx];
          if (!item || item.removed) return;
          item.removed = true;
          try {
            if (typeof item.target.removeEventListener === 'function') {
              item.target.removeEventListener(item.eventType, item.wrapped, item.opts);
            }
          } catch (_err) {}
        };
      },
      onDispose(fn) {
        assertNotDisposed();
        if (typeof fn !== 'function') return;
        if (!_has(disposers, pluginId)) {
          disposers[pluginId] = { count: 0, items: _ObjCreate(null) };
        }
        const bucket = disposers[pluginId];
        bucket.items[bucket.count++] = fn;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        delete activeHandles[pluginId];
        // Clean managed event listeners first so callbacks never fire during teardown
        try {
          const lb = _has(managedListeners, pluginId) ? managedListeners[pluginId] : null;
          delete managedListeners[pluginId];
          if (lb) {
            for (let i = 0; i < lb.count; i++) {
              const item = lb.items[i];
              if (item && !item.removed) {
                item.removed = true;
                try {
                  if (typeof item.target.removeEventListener === 'function') {
                    item.target.removeEventListener(item.eventType, item.wrapped, item.opts);
                  }
                } catch (_err) {}
              }
            }
          }
        } catch (_err) {}
        // R6-F3: Invoke disposers via captured Reflect.apply (immune to Function.prototype.call pollution)
        try {
          const bucket = _has(disposers, pluginId) ? disposers[pluginId] : null;
          delete disposers[pluginId];
          if (bucket) {
            for (let i = 0; i < bucket.count; i++) {
              try { _ReflectApply(bucket.items[i], undefined, []); } catch (_err) {}
            }
          }
        } catch (_err) {}
        try {
          const owned = handle.listOwnedSlots();
          for (let i = 0; i < owned.length; i++) {
            const sId = owned[i];
            try {
              if (_has(slotOwners, sId) && slotOwners[sId] === pluginId) {
                const el = slotElements[sId];
                if (el && el.parentNode && typeof el.parentNode.removeChild === 'function') {
                  el.parentNode.removeChild(el);
                }
                delete slotOwners[sId];
                delete slotElements[sId];
              }
            } catch (_err) {}
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

  // R6-F4: Host binds immutable spec + verifies secret, nonce, and live window.location.origin synchronously
  _ObjDefineProperty(
    window,
    '__ADDON_HOST_REGISTER_CAP__',
    makeDataDesc(
      function(hostSecret, nonce, expectedOrigin, token, spec) {
        assertHostOriginAndAuth(hostSecret, nonce, expectedOrigin, 'ERR_FORBIDDEN_CAP_REGISTRATION');
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
          trustLevel: spec.trustLevel === 'trusted' ? 'trusted' : 'restricted',
          hasDocumentTransformSlot: Boolean(spec.hasDocumentTransformSlot),
        });
      },
      false,
      false,
      false
    )
  );

  // R6-F4 & R8-F2: Purge any unconsumed capability token with synchronous origin+nonce verification
  _ObjDefineProperty(
    window,
    '__ADDON_HOST_REVOKE_CAP__',
    makeDataDesc(
      function(hostSecret, nonce, expectedLoc, token) {
        assertHostOriginAndAuth(hostSecret, nonce, expectedLoc, 'ERR_FORBIDDEN_CAP_REVOKE');
        if (typeof token === 'string' && _has(pendingSpecs, token)) {
          delete pendingSpecs[token];
          return true;
        }
        return false;
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

  // R5-F5 & R6-F4: Host-authenticated renderer disposal with synchronous origin+nonce verification
  _ObjDefineProperty(
    window,
    '__ADDON_HOST_DISPOSE__',
    makeDataDesc(
      function(hostSecret, nonce, expectedOrigin, pluginId) {
        assertHostOriginAndAuth(hostSecret, nonce, expectedOrigin, 'ERR_FORBIDDEN_HOST_DISPOSE');
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

  // P1: Host-authenticated retrieval of isolated async renderer errors
  _ObjDefineProperty(
    window,
    '__ADDON_HOST_GET_ERRORS__',
    makeDataDesc(
      function(hostSecret, nonce, expectedOrigin, pluginId) {
        assertHostOriginAndAuth(hostSecret, nonce, expectedOrigin, 'ERR_FORBIDDEN_HOST_ERROR_READ');
        const id = _String(pluginId || '');
        if (!_has(pluginErrors, id)) return [];
        const b = pluginErrors[id];
        const out = [];
        const n = b.count < 20 ? b.count : 20;
        for (let i = 0; i < n; i++) {
          _ObjDefineProperty(out, i, makeDataDesc(b.items[i], true, true, true));
        }
        return out;
      },
      false,
      false,
      false
    )
  );
})();`;
}

function buildHostLoaderScriptSource(
  paths,
  profile,
  { hostVersion = pkg.version, strictTrustPolicy = false, mainHookTimeoutMs = 5000 } = {}
) {
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
    strictTrustPolicy: Boolean(strictTrustPolicy),
    mainHookTimeoutMs:
      Number.isInteger(mainHookTimeoutMs) && mainHookTimeoutMs >= 100 ? mainHookTimeoutMs : 5000,
    allowedProtocols,
    allowedHosts,
    isolatedWorldId:
      typeof profile.isolatedWorldId === 'number' && Number.isInteger(profile.isolatedWorldId) && profile.isolatedWorldId > 0
        ? profile.isolatedWorldId
        : 999,
    coreLifecyclePath: path.resolve(__dirname, '..', '..', 'core', 'lifecycle-coordinator.js'),
    nodeFsPortPath: path.resolve(__dirname, '..', 'node-fs-port.js'),
    configReaderPath: path.resolve(__dirname, 'config-reader.js'),
  };

  return `'use strict';
// Auto-generated by antigravity-native-addon-host (${profile.patchMarker}).
// Single isolated mainHook (least-privilege broker + async isolation) + top-frame renderer loader.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOST_CFG = ${serializeSafeInlineJson(cfg)};
const RENDERER_API_BOOTSTRAP_TEMPLATE = ${serializeSafeInlineJson(bootstrapApiTemplate)};

const { planAddonExecution } = require(HOST_CFG.coreLifecyclePath);
const { createNodeFileSystemPort } = require(HOST_CFG.nodeFsPortPath);
const { isPluginEnabledInConfig } = require(HOST_CFG.configReaderPath);

const nodeFsPort = createNodeFileSystemPort();

const diagnostics = [];
function recordDiag(level, code, detail) {
  diagnostics.push({ ts: new Date().toISOString(), level, code, detail: String(detail || '') });
  if (diagnostics.length > 200) diagnostics.shift();
}

function getDiagnostics() {
  return diagnostics.slice();
}

// P1: Explicit Addon Lifecycle State Machine (PENDING -> ACTIVATING -> ACTIVE / FAILED / DISPOSING -> DISPOSED)
const addonLifecycleStates = new Map();
function setLifecycleState(pluginId, kind, state, lastError) {
  let rec = addonLifecycleStates.get(pluginId);
  if (!rec) {
    rec = {};
    addonLifecycleStates.set(pluginId, rec);
  }
  rec[kind] = {
    state,
    lastError: lastError ? String(lastError) : null,
    updatedAt: new Date().toISOString(),
  };
}

function getAddonLifecycleStates() {
  const out = {};
  for (const [pluginId, rec] of addonLifecycleStates.entries()) {
    out[pluginId] = {
      mainHook: rec.mainHook ? { ...rec.mainHook } : null,
      renderer: rec.renderer ? { ...rec.renderer } : null,
    };
  }
  return out;
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
    strictTrustPolicy: HOST_CFG.strictTrustPolicy,
    fsPort: nodeFsPort,
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
    trustLevel: item.trustLevel || 'restricted',
    hasDocumentTransformSlot: Boolean(item.hasDocumentTransformSlot),
    rendererPath: item.resolvedEntries.rendererScript,
    mainHookPath: item.resolvedEntries.mainHookScript,
    allowedSlotIds: (item.manifest.uiSlots || []).map((s) => s.slotId),
    storageNamespace: (item.manifest.isolation && item.manifest.isolation.storageNamespace) || item.pluginId,
    ipcChannelPrefix: (item.manifest.isolation && item.manifest.isolation.ipcChannelPrefix) || null,
  }));
}

// P1: Least-Privilege Main Host Broker (never exposes raw Electron app.quit/exit/relaunch)
const ALLOWED_APP_PATHS = new Set(['userData', 'temp', 'logs']);
const ALLOWED_WC_EVENTS = new Set(['dom-ready', 'did-finish-load', 'did-navigate', 'did-fail-load', 'destroyed']);

function createScopedMainHostBridge(electronApp, pluginId, cleanupFns) {
  return Object.freeze({
    getVersion() {
      return electronApp && typeof electronApp.getVersion === 'function' ? electronApp.getVersion() : null;
    },
    getPath(name) {
      if (!ALLOWED_APP_PATHS.has(String(name || ''))) {
        throw new Error('ERR_FORBIDDEN_APP_PATH:' + String(name || ''));
      }
      return electronApp && typeof electronApp.getPath === 'function' ? electronApp.getPath(name) : null;
    },
    onBeforeQuit(fn) {
      if (typeof fn !== 'function' || !electronApp || typeof electronApp.on !== 'function') return () => {};
      const wrapped = (...args) => {
        try {
          const ret = fn(...args);
          if (ret && typeof ret.then === 'function') {
            Promise.resolve(ret).catch((err) => {
              recordDiag('error', 'ERR_MAIN_HOOK_BEFORE_QUIT_ASYNC', pluginId + ': ' + (err && err.message));
            });
          }
        } catch (err) {
          recordDiag('error', 'ERR_MAIN_HOOK_BEFORE_QUIT', pluginId + ': ' + (err && err.message));
        }
      };
      electronApp.on('before-quit', wrapped);
      let removed = false;
      const detach = () => {
        if (removed) return;
        removed = true;
        try {
          if (typeof electronApp.removeListener === 'function') {
            electronApp.removeListener('before-quit', wrapped);
          }
        } catch (_e) {}
      };
      cleanupFns.push(detach);
      return detach;
    },
  });
}

function createScopedWebContentsBridge(contents, pluginId, cleanupFns) {
  const registeredListeners = new Set();
  const worldId = HOST_CFG.isolatedWorldId || 999;

  function assertAllowedLiveUrl() {
    if (!contents || (typeof contents.isDestroyed === 'function' && contents.isDestroyed())) {
      throw new Error('ERR_WEBCONTENTS_DESTROYED');
    }
    const liveUrl = typeof contents.getURL === 'function' ? contents.getURL() : '';
    if (!isAllowedRendererUrl(liveUrl)) {
      throw new Error('ERR_FORBIDDEN_RENDERER_URL');
    }
  }

  return Object.freeze({
    getType() {
      return contents && typeof contents.getType === 'function' ? contents.getType() : 'unknown';
    },
    getURL() {
      return contents && typeof contents.getURL === 'function' ? contents.getURL() : '';
    },
    isDestroyed() {
      return contents && typeof contents.isDestroyed === 'function' ? Boolean(contents.isDestroyed()) : false;
    },
    on(eventName, fn) {
      const ev = String(eventName || '');
      if (!ALLOWED_WC_EVENTS.has(ev)) {
        throw new Error('ERR_FORBIDDEN_WEBCONTENTS_EVENT:' + ev);
      }
      if (typeof fn !== 'function' || !contents || typeof contents.on !== 'function') return;
      const wrapped = (...args) => {
        try {
          const ret = fn(...args);
          if (ret && typeof ret.then === 'function') {
            Promise.resolve(ret).catch((err) => {
              recordDiag('error', 'ERR_MAIN_HOOK_EVENT_ASYNC', pluginId + ':' + ev + ': ' + (err && err.message));
            });
          }
        } catch (err) {
          recordDiag('error', 'ERR_MAIN_HOOK_EVENT', pluginId + ':' + ev + ': ' + (err && err.message));
        }
      };
      const record = { ev, fn, wrapped };
      registeredListeners.add(record);
      contents.on(ev, wrapped);
      cleanupFns.push(() => {
        if (!registeredListeners.has(record)) return;
        registeredListeners.delete(record);
        try {
          if (typeof contents.removeListener === 'function') contents.removeListener(ev, wrapped);
        } catch (_e) {}
      });
    },
    removeListener(eventName, fn) {
      const ev = String(eventName || '');
      for (const rec of Array.from(registeredListeners)) {
        if (rec.fn === fn && (!ev || rec.ev === ev)) {
          registeredListeners.delete(rec);
          try {
            if (typeof contents.removeListener === 'function') {
              contents.removeListener(rec.ev, rec.wrapped);
            }
          } catch (_e) {}
        }
      }
    },
    executeInIsolatedWorld(code) {
      try {
        assertAllowedLiveUrl();
      } catch (err) {
        return Promise.reject(err);
      }
      if (typeof contents.executeJavaScriptInIsolatedWorld === 'function') {
        return Promise.resolve(contents.executeJavaScriptInIsolatedWorld(worldId, [{ code: String(code || '') }], true));
      }
      if (typeof contents.executeJavaScript === 'function') {
        return Promise.resolve(contents.executeJavaScript(String(code || ''), true));
      }
      return Promise.reject(new Error('ERR_ISOLATED_EXEC_UNAVAILABLE'));
    },
    executeJavaScriptInIsolatedWorld(requestedWorldId, sources, userGesture) {
      if (requestedWorldId !== worldId) {
        return Promise.reject(new Error('ERR_FORBIDDEN_WORLD_ID:' + String(requestedWorldId)));
      }
      try {
        assertAllowedLiveUrl();
      } catch (err) {
        return Promise.reject(err);
      }
      if (typeof contents.executeJavaScriptInIsolatedWorld === 'function') {
        return Promise.resolve(contents.executeJavaScriptInIsolatedWorld(worldId, sources, Boolean(userGesture)));
      }
      const code = Array.isArray(sources) && sources[0] ? String(sources[0].code || '') : '';
      if (typeof contents.executeJavaScript === 'function') {
        return Promise.resolve(contents.executeJavaScript(code, Boolean(userGesture)));
      }
      return Promise.reject(new Error('ERR_ISOLATED_EXEC_UNAVAILABLE'));
    },
  });
}

const loadedMainHooks = new Map();
const failedMainHookIds = new Set();

function runCleanupFns(cleanupFns) {
  for (const fn of cleanupFns.splice(0, cleanupFns.length)) {
    try { fn(); } catch (_e) {}
  }
}

function disposeMainHookEntry(pluginId, entry) {
  setLifecycleState(pluginId, 'mainHook', 'DISPOSING');
  const finish = (errMsg) => {
    runCleanupFns(entry.cleanupFns);
    setLifecycleState(pluginId, 'mainHook', 'DISPOSED', errMsg || null);
  };
  try {
    if (entry && entry.mod && typeof entry.mod.dispose === 'function') {
      const ret = entry.mod.dispose();
      if (ret && typeof ret.then === 'function') {
        return Promise.resolve(ret)
          .then(() => finish(null))
          .catch((err) => {
            const msg = err && err.message ? err.message : String(err);
            recordDiag('error', 'ERR_MAIN_HOOK_DISPOSE_ASYNC', pluginId + ': ' + msg);
            finish(msg);
          });
      }
    }
    finish(null);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    recordDiag('error', 'ERR_MAIN_HOOK_DISPOSE', pluginId + ': ' + msg);
    finish(msg);
  }
  return Promise.resolve();
}

function syncMainHooks(electronApp) {
  const active = collectActiveAddons();
  const activeMainIds = new Set(active.filter((a) => a.mainHookPath).map((a) => a.pluginId));

  // Clear failure latch when an addon is removed/disabled so re-enabling gets a clean attempt
  for (const failedId of Array.from(failedMainHookIds)) {
    if (!activeMainIds.has(failedId)) {
      failedMainHookIds.delete(failedId);
    }
  }

  for (const [pluginId, entry] of Array.from(loadedMainHooks.entries())) {
    if (!activeMainIds.has(pluginId)) {
      loadedMainHooks.delete(pluginId);
      void disposeMainHookEntry(pluginId, entry);
    }
  }

  for (const addon of active) {
    if (!addon.mainHookPath || loadedMainHooks.has(addon.pluginId) || failedMainHookIds.has(addon.pluginId)) {
      continue;
    }
    const cleanupFns = [];
    setLifecycleState(addon.pluginId, 'mainHook', 'ACTIVATING');
    try {
      const mod = require(addon.mainHookPath);
      const hostBridge = createScopedMainHostBridge(electronApp, addon.pluginId, cleanupFns);
      const ctx = Object.freeze({
        app: hostBridge,
        hostBridge,
        pluginId: addon.pluginId,
        trustLevel: addon.trustLevel,
        hostProfileId: HOST_CFG.hostProfileId,
        hostVersion: HOST_CFG.hostVersion,
        isolatedWorldId: HOST_CFG.isolatedWorldId,
        storageNamespace: addon.storageNamespace,
        ipcChannelPrefix: addon.ipcChannelPrefix,
      });
      const entry = { mod, addon, cleanupFns, activatePromise: null };
      loadedMainHooks.set(addon.pluginId, entry);

      let ret;
      if (typeof mod === 'function') ret = mod(ctx);
      else if (mod && typeof mod.activate === 'function') ret = mod.activate(ctx);

      if (ret && typeof ret.then === 'function') {
        let timer = null;
        const timeoutPromise = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('ERR_MAIN_HOOK_ACTIVATE_TIMEOUT')), HOST_CFG.mainHookTimeoutMs);
          if (timer && typeof timer.unref === 'function') timer.unref();
        });
        entry.activatePromise = Promise.race([Promise.resolve(ret), timeoutPromise])
          .then(() => {
            if (timer) clearTimeout(timer);
            if (loadedMainHooks.get(addon.pluginId) === entry) {
              setLifecycleState(addon.pluginId, 'mainHook', 'ACTIVE');
            }
          })
          .catch((err) => {
            if (timer) clearTimeout(timer);
            const msg = err && err.message ? err.message : String(err);
            recordDiag('error', 'ERR_MAIN_HOOK_ACTIVATE_ASYNC', addon.pluginId + ': ' + msg);
            runCleanupFns(cleanupFns);
            if (loadedMainHooks.get(addon.pluginId) === entry) {
              loadedMainHooks.delete(addon.pluginId);
              failedMainHookIds.add(addon.pluginId);
              setLifecycleState(addon.pluginId, 'mainHook', 'FAILED', msg);
            }
          });
      } else {
        setLifecycleState(addon.pluginId, 'mainHook', 'ACTIVE');
      }
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      loadedMainHooks.delete(addon.pluginId);
      failedMainHookIds.add(addon.pluginId);
      runCleanupFns(cleanupFns);
      setLifecycleState(addon.pluginId, 'mainHook', 'FAILED', msg);
      recordDiag('error', 'ERR_MAIN_HOOK_ACTIVATE', addon.pluginId + ': ' + msg);
    }
  }
}

function attachWebContents(contents, electronApp) {
  if (!contents || typeof contents.getType !== 'function' || contents.getType() !== 'window') return;
  syncMainHooks(electronApp);

  for (const [pluginId, entry] of loadedMainHooks.entries()) {
    if (entry && entry.mod && typeof entry.mod.onWebContentsCreated === 'function') {
      try {
        const scopedContents = createScopedWebContentsBridge(contents, pluginId, entry.cleanupFns);
        const hostBridge = createScopedMainHostBridge(electronApp, pluginId, entry.cleanupFns);
        const ret = entry.mod.onWebContentsCreated({
          app: hostBridge,
          hostBridge,
          contents: scopedContents,
          pluginId,
          isolatedWorldId: HOST_CFG.isolatedWorldId,
          isAllowedRendererUrl,
        });
        if (ret && typeof ret.then === 'function') {
          Promise.resolve(ret).catch((err) => {
            recordDiag('error', 'ERR_MAIN_HOOK_WEBCONTENTS_ASYNC', pluginId + ': ' + (err && err.message));
          });
        }
      } catch (err) {
        recordDiag('error', 'ERR_MAIN_HOOK_WEBCONTENTS', pluginId + ': ' + (err && err.message));
      }
    }
  }

  let hostSecret = '';
  let instanceNonce = '';
  let navGeneration = 0;
  let pendingNav = false;
  const injectedIds = new Set();
  const failedIds = new Set();
  let injectQueue = Promise.resolve();

  const execInRenderer = (code) => {
    if (typeof contents.executeJavaScriptInIsolatedWorld === 'function') {
      return contents.executeJavaScriptInIsolatedWorld(HOST_CFG.isolatedWorldId || 999, [{ code }], true);
    }
    return contents.executeJavaScript(code, true);
  };

  const resetCredentials = () => {
    injectedIds.clear();
    failedIds.clear();
    hostSecret = '';
    instanceNonce = '';
  };

  const getAllowedLocation = () => {
    const liveUrl = typeof contents.getURL === 'function' ? contents.getURL() : '';
    if (!isAllowedRendererUrl(liveUrl)) return null;
    try {
      const u = new URL(liveUrl);
      const protocol = String(u.protocol || '').toLowerCase();
      const host = String(u.host || '').toLowerCase();
      const origin = u.origin && u.origin !== 'null' ? u.origin.toLowerCase() : null;
      return { protocol, host, origin };
    } catch (_e) {
      return null;
    }
  };

  const enqueueInject = () => {
    injectQueue = injectQueue.then(async () => {
      try {
        // F4: Re-sync mainHooks on every reload/navigation so disabled hooks dispose even in a single-window session
        syncMainHooks(electronApp);

        if (pendingNav) return;
        const passGen = navGeneration;
        const initialLoc = getAllowedLocation();
        if (!initialLoc) return;

        const verifyLiveNonce = async (nonceToCheck) => {
          if (!nonceToCheck) return false;
          try {
            return Boolean(
              await execInRenderer(
                'typeof window.__ADDON_HOST_VERIFY__ === "function" && window.__ADDON_HOST_VERIFY__(' +
                  JSON.stringify(nonceToCheck) + ')'
              )
            );
          } catch (_e) {
            return false;
          }
        };

        const verifyDocumentStillTrusted = async () => {
          if (pendingNav || navGeneration !== passGen) return null;
          const liveLoc = getAllowedLocation();
          if (!liveLoc) return null;
          const liveOk = await verifyLiveNonce(instanceNonce);
          if (!liveOk || pendingNav || navGeneration !== passGen) return null;
          return liveLoc;
        };

        // F3: Non-spoofable nonce challenge verifies that THIS host bootstrapped the current document
        const verifiedLive = !pendingNav && navGeneration === passGen && (await verifyLiveNonce(instanceNonce));

        if (!verifiedLive) {
          if (pendingNav || navGeneration !== passGen) return;
          resetCredentials();
          const nextSecret = crypto.randomBytes(24).toString('hex');
          const nextNonce = crypto.randomBytes(24).toString('hex');
          const bootstrapWithSecrets =
            '(function(){ "use strict"; const __HOST_SECRET__ = ' + JSON.stringify(nextSecret) +
            '; const __INSTANCE_NONCE__ = ' + JSON.stringify(nextNonce) + ';\\n' +
            RENDERER_API_BOOTSTRAP_TEMPLATE + '\\n})();';
          await execInRenderer(bootstrapWithSecrets);
          const preVerifyLoc = getAllowedLocation();
          const liveVerified =
            !pendingNav &&
            navGeneration === passGen &&
            Boolean(preVerifyLoc) &&
            (await verifyLiveNonce(nextNonce));
          // R8-F2: Re-check pendingNav, navGeneration, and live allowed location AFTER await verifyLiveNonce
          const postVerify =
            liveVerified &&
            !pendingNav &&
            navGeneration === passGen &&
            Boolean(getAllowedLocation());
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
              const trustedLoc = await verifyDocumentStillTrusted();
              if (!trustedLoc) {
                recordDiag('warn', 'ERR_RENDERER_TOCTOU_ABORT', 'Document origin/nonce changed before dispose');
                if (!pendingNav && navGeneration === passGen) resetCredentials();
                return;
              }
              setLifecycleState(prevId, 'renderer', 'DISPOSING');
              try {
                await execInRenderer(
                  'typeof window.__ADDON_HOST_DISPOSE__ === "function" && window.__ADDON_HOST_DISPOSE__(' +
                    JSON.stringify(hostSecret) + ',' +
                    JSON.stringify(instanceNonce) + ',' +
                    JSON.stringify(trustedLoc) + ',' +
                    JSON.stringify(prevId) + ');'
                );
                setLifecycleState(prevId, 'renderer', 'DISPOSED');
              } catch (err) {
                const msg = err && err.message ? err.message : String(err);
                setLifecycleState(prevId, 'renderer', 'DISPOSED', msg);
                recordDiag('error', 'ERR_RENDERER_DISPOSE', prevId + ': ' + msg);
              }
              if (pendingNav || navGeneration !== passGen) return;
              injectedIds.delete(prevId);
            }
          }
        }

        const addons = activeRendererAddons.filter(
          (a) => !injectedIds.has(a.pluginId) && !failedIds.has(a.pluginId)
        );
        // Deterministic sequential execution preserves loadOrder while isolating each plugin's faults
        for (const addon of addons) {
          if (pendingNav || navGeneration !== passGen) break;
          let capToken = '';
          setLifecycleState(addon.pluginId, 'renderer', 'ACTIVATING');
          try {
            // NB2: Read renderer script BEFORE registering capability token so missing/unreadable files leak no token
            const rawCode = fs.readFileSync(addon.rendererPath, 'utf8');
            // R5-F2 & R6-F4: Re-verify navigation generation, URL authority, and instanceNonce before REGISTER_CAP
            const trustedLocBeforeReg = await verifyDocumentStillTrusted();
            if (!trustedLocBeforeReg) {
              recordDiag('warn', 'ERR_RENDERER_TOCTOU_ABORT', addon.pluginId + ': origin/nonce/nav changed before cap registration');
              if (!pendingNav && navGeneration === passGen) resetCredentials();
              break;
            }
            capToken = crypto.randomBytes(24).toString('hex');
            const spec = {
              pluginId: addon.pluginId,
              allowedSlotIds: addon.allowedSlotIds,
              storageNamespace: addon.storageNamespace,
              ipcChannelPrefix: addon.ipcChannelPrefix,
              trustLevel: addon.trustLevel,
              hasDocumentTransformSlot: addon.hasDocumentTransformSlot,
            };
            await execInRenderer(
              'window.__ADDON_HOST_REGISTER_CAP__(' +
                JSON.stringify(hostSecret) + ',' +
                JSON.stringify(instanceNonce) + ',' +
                JSON.stringify(trustedLocBeforeReg) + ',' +
                JSON.stringify(capToken) + ',' +
                JSON.stringify(spec) + ');'
            );
            // R5-F2, R6-F4 & R8-F2: Re-verify before executing plugin wrapper.
            // NEVER send hostSecret/instanceNonce/capToken to a renderer that just failed trust verification!
            const trustedLocBeforeExec = await verifyDocumentStillTrusted();
            if (!trustedLocBeforeExec) {
              recordDiag('warn', 'ERR_RENDERER_TOCTOU_ABORT', addon.pluginId + ': origin/nonce/nav changed before execution');
              if (!pendingNav && navGeneration === passGen) resetCredentials();
              break;
            }
            // R6-F4 & P1: On sync throw OR returned Promise rejection, isolate & clean up partial slots/styles
            const wrapped =
              '(function(){\\n' +
              '  const __addonHandle = window.__ADDON_HOST_CONSUME_CAP__(' + JSON.stringify(capToken) + ');\\n' +
              '  try {\\n' +
              '    const __addonRet = (function(addonHost){\\n' +
              rawCode +
              '\\n    })(__addonHandle);\\n' +
              '    if (__addonRet && typeof __addonRet.then === "function") {\\n' +
              '      return Promise.resolve(__addonRet).catch(function(__asyncErr){\\n' +
              '        try { __addonHandle.reportError(__asyncErr); } catch (_r) {}\\n' +
              '        try { __addonHandle.dispose(); } catch (_d) {}\\n' +
              '        throw __asyncErr;\\n' +
              '      });\\n' +
              '    }\\n' +
              '  } catch (__addonErr) {\\n' +
              '    try { __addonHandle.reportError(__addonErr); } catch (_r) {}\\n' +
              '    try { __addonHandle.dispose(); } catch (_d) {}\\n' +
              '    throw __addonErr;\\n' +
              '  }\\n' +
              '})();';
            await execInRenderer(wrapped);
            // R7-F4: Guard against navigation firing while execInRenderer(wrapped) was in flight
            if (pendingNav || navGeneration !== passGen) {
              recordDiag('warn', 'ERR_RENDERER_TOCTOU_ABORT', addon.pluginId + ': navigation occurred during execution');
              break;
            }
            injectedIds.add(addon.pluginId);
            setLifecycleState(addon.pluginId, 'renderer', 'ACTIVE');
          } catch (err) {
            // R6-F4, R7-F4 & R8-F2: Isolate failing plugin only for current generation;
            // ONLY call REVOKE_CAP if the renderer is STILL verified trusted (never leak secrets to untrusted doc).
            const msg = err && err.message ? err.message : String(err);
            if (!pendingNav && navGeneration === passGen) {
              failedIds.add(addon.pluginId);
              setLifecycleState(addon.pluginId, 'renderer', 'FAILED', msg);
            }
            if (capToken && hostSecret && instanceNonce && !pendingNav && navGeneration === passGen) {
              try {
                const trustedLocForRevoke = await verifyDocumentStillTrusted();
                if (trustedLocForRevoke) {
                  await execInRenderer(
                    'typeof window.__ADDON_HOST_REVOKE_CAP__ === "function" && window.__ADDON_HOST_REVOKE_CAP__(' +
                      JSON.stringify(hostSecret) + ',' +
                      JSON.stringify(instanceNonce) + ',' +
                      JSON.stringify(trustedLocForRevoke) + ',' +
                      JSON.stringify(capToken) + ');'
                  );
                }
              } catch (_revErr) {}
            }
            recordDiag('error', 'ERR_RENDERER_INJECT', addon.pluginId + ': ' + msg);
          }
        }
      } catch (err) {
        recordDiag('error', 'ERR_INJECT_PASS', err && err.message);
      }
    });
    return injectQueue;
  };

  if (typeof contents.on === 'function') {
    contents.on('did-start-navigation', (evt, _url, isInPlace, isMainFrame) => {
      const inPlace =
        evt && typeof evt === 'object' && typeof evt.isSameDocument === 'boolean'
          ? evt.isSameDocument
          : isInPlace;
      const mainFrame =
        evt && typeof evt === 'object' && typeof evt.isMainFrame === 'boolean'
          ? evt.isMainFrame
          : isMainFrame;
      if (inPlace === true || mainFrame === false) return;
      pendingNav = true;
      navGeneration++;
    });
    contents.on('did-navigate', () => {
      pendingNav = false;
      navGeneration++;
      resetCredentials();
    });
    contents.on('did-fail-load', (_evt, _errorCode, _errorDescription, _validatedURL, isMainFrame) => {
      if (isMainFrame === false) return;
      pendingNav = false;
    });
    contents.on('did-stop-loading', () => {
      pendingNav = false;
    });
    contents.on('dom-ready', () => {
      pendingNav = false;
      void enqueueInject();
    });
    contents.on('did-finish-load', () => {
      pendingNav = false;
      void enqueueInject();
    });
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
  getAddonLifecycleStates,
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
