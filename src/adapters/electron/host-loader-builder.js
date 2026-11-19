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
  uiAnchors = {},
} = {}) {
  const extraAttrs = Array.isArray(extraNoTranslateAttributes) ? extraNoTranslateAttributes : [];
  const safeUiAnchors = uiAnchors && typeof uiAnchors === 'object' ? uiAnchors : {};
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
  const _StrStartsWith = String.prototype.startsWith;
  const _FromCodePoint = String.fromCodePoint;
  const _ParseInt = Number.parseInt;
  const _Number = Number;
  const _IsFinite = Number.isFinite;
  const _MathMax = Math.max;
  const _MathMin = Math.min;
  const _MathRound = Math.round;
  const _RegExpTest = RegExp.prototype.test;
  const _Error = Error;
  const _Promise = Promise;
  const _PromiseResolve = _Promise.resolve.bind(_Promise);
  const _PromiseProtoThen = _Promise.prototype.then;
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
  function startsWithSafe(v, prefix) {
    return _ReflectApply(_StrStartsWith, _String(v || ''), [prefix]);
  }
  function replaceSafe(v, re, rep) {
    return _ReflectApply(_StrReplace, _String(v || ''), [re, rep]);
  }
  function testSafe(re, v) {
    return _ReflectApply(_RegExpTest, re, [_String(v || '')]);
  }
  function promiseThenSafe(promiseLike, onFulfilled, onRejected) {
    return _ReflectApply(_PromiseProtoThen, _PromiseResolve(promiseLike), [onFulfilled, onRejected]);
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

  // P1 & R1-F1: Bulletproof CSS escape decoding, danger filter, strict @-rule allowlist, and owner selector scoping
  const FORBIDDEN_CSS_RE = /@import\\b|javascript\\s*:|expression\\s*\\(|behavior\\s*:|-moz-binding\\s*:/i;
  const CSS_COMMENT_RE = /\\/\\*[\\s\\S]*?\\*\\//g;
  const CSS_NEWLINE_ESCAPE_RE = /\\\\(?:\\r\\n|[\\r\\n\\f])/g;
  const CSS_HEX_ESCAPE_RE = /\\\\([0-9a-fA-F]{1,6})[ \\t\\r\\n\\f]?/g;
  const CSS_CHAR_ESCAPE_RE = /\\\\([^\\r\\n\\f0-9a-fA-F])/g;
  const AT_KEYFRAMES_RE = /^@(?:(?:-webkit-)?keyframes)\\b/i;
  const AT_NESTED_RE = /^@(?:media|supports|container|layer)\\b/i;
  const ROOT_TAG_ONLY_RE = /^(?::root|html|body)$/i;
  const ROOT_TAG_PREFIX_RE = /^(?::root|html|body)(?=[\\s>.#\\[:~+])/i;

  function decodeCssEscapes(cssStr) {
    let out = replaceSafe(cssStr, CSS_NEWLINE_ESCAPE_RE, '');
    out = replaceSafe(out, CSS_HEX_ESCAPE_RE, function(_m, hex) {
      const cp = _ParseInt(hex, 16);
      if (!_IsFinite(cp) || cp <= 0 || cp > 0x10ffff) return '\\uFFFD';
      try {
        return _FromCodePoint(cp);
      } catch (_e) {
        return '\\uFFFD';
      }
    });
    out = replaceSafe(out, CSS_CHAR_ESCAPE_RE, '$1');
    return out;
  }

  function assertSafeCssConstructs(rawCss) {
    const withoutComments = replaceSafe(rawCss, CSS_COMMENT_RE, '');
    const decoded = decodeCssEscapes(withoutComments);
    if (testSafe(FORBIDDEN_CSS_RE, withoutComments) || testSafe(FORBIDDEN_CSS_RE, decoded)) {
      throw new _Error('ERR_FORBIDDEN_CSS_CONSTRUCT');
    }
    return withoutComments;
  }

  // R1-F1: Reject top-level sibling combinators (~ or +) applied directly to the owner/root element
  // (e.g., \`body ~ *\`, \`body.dark + div\`, \`[data-addon-host-owner="id"] ~ *\`).
  function hasRootLevelSiblingCombinator(rest) {
    const len = rest.length;
    let i = 0;
    let parenDepth = 0;
    let bracketDepth = 0;
    let quote = '';
    while (i < len) {
      const ch = rest[i];
      if (quote) {
        if (ch === '\\\\') { i += 2; continue; }
        if (ch === quote) quote = '';
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; i++; continue; }
      if (ch === '(') { parenDepth++; i++; continue; }
      if (ch === ')' && parenDepth > 0) { parenDepth--; i++; continue; }
      if (ch === '[') { bracketDepth++; i++; continue; }
      if (ch === ']' && bracketDepth > 0) { bracketDepth--; i++; continue; }
      if (parenDepth === 0 && bracketDepth === 0) {
        if (ch === '~' || ch === '+') return true;
        if (ch === '>') return false;
        if (ch === ' ' || ch === '\\t' || ch === '\\n' || ch === '\\r' || ch === '\\f') {
          let k = i + 1;
          while (k < len && (rest[k] === ' ' || rest[k] === '\\t' || rest[k] === '\\n' || rest[k] === '\\r' || rest[k] === '\\f')) {
            k++;
          }
          if (k >= len) return false;
          if (rest[k] === '~' || rest[k] === '+') return true;
          return false;
        }
      }
      i++;
    }
    return false;
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
      if (startsWithSafe(sel, ownerPrefix)) {
        const rest = sliceSafe(sel, ownerPrefix.length);
        if (hasRootLevelSiblingCombinator(rest)) {
          throw new _Error('ERR_FORBIDDEN_CSS_SELECTOR');
        }
        scoped = sel;
      } else if (testSafe(ROOT_TAG_ONLY_RE, sel)) {
        scoped = ownerPrefix;
      } else if (testSafe(ROOT_TAG_PREFIX_RE, sel)) {
        const rest = replaceSafe(sel, ROOT_TAG_PREFIX_RE, '');
        if (hasRootLevelSiblingCombinator(rest)) {
          throw new _Error('ERR_FORBIDDEN_CSS_SELECTOR');
        }
        scoped = ownerPrefix + rest;
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
        if (stmt) {
          // R1-F1: Fail-closed on statement-form @-rules in owner scope (e.g. @import, @namespace, @layer foo;)
          if (stmt[0] === '@') {
            throw new _Error('ERR_FORBIDDEN_CSS_AT_RULE');
          }
          out += stmt + '\\n';
        }
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
      const body = sliceSafe(cssText, bracePos + 1, _MathMax(bracePos + 1, k - 1));
      if (header) {
        if (header[0] === '@') {
          // R1-F1: Strict @-rule allowlist — block backslash escapes, @scope, @property, @starting-style, @font-face, and any unknown @-rule
          if (indexOfSafe(header, '\\\\') !== -1) {
            throw new _Error('ERR_FORBIDDEN_CSS_AT_RULE');
          }
          if (testSafe(AT_KEYFRAMES_RE, header)) {
            out += header + ' {' + body + '}\\n';
          } else if (testSafe(AT_NESTED_RE, header)) {
            out += header + ' {\\n' + scopeCssBlock(body, ownerPrefix) + '}\\n';
          } else {
            throw new _Error('ERR_FORBIDDEN_CSS_AT_RULE');
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
  const HOST_UI_ANCHORS = _ObjFreeze(${serializeSafeInlineJson(safeUiAnchors)});
  const slotOwners = _ObjCreate(null);
  const slotElements = _ObjCreate(null);
  const styleOwners = _ObjCreate(null);
  const styleElements = _ObjCreate(null);
  const disposers = _ObjCreate(null);
  const managedListeners = _ObjCreate(null);
  const pluginErrors = _ObjCreate(null);
  const pendingSpecs = _ObjCreate(null);
  const activeHandles = _ObjCreate(null);

  // Host-owned Standard Modal/Popover Stack (single z-index, ESC top-most, focus restore, popover clamping)
  const modalEntries = _ObjCreate(null);
  const modalStack = { count: 0, items: _ObjCreate(null) };
  let modalZCounter = 2147483000;
  let modalGlobalListenersBound = false;
  let modalBaseStyleMounted = false;

  // Host-neutral Action Contribution Registry (DIP: decouples surface consumers like statusbar from contributors)
  const registeredActions = _ObjCreate(null);
  const actionSubscribers = _ObjCreate(null);
  let actionSubCounter = 0;

  function applyNoTranslateAttrs(el, ownerId, slotId) {
    if (!el || typeof el.setAttribute !== 'function') return;
    el.setAttribute('translate', 'no');
    for (let i = 0; i < EXTRA_NO_TRANSLATE_ATTRS.length; i++) {
      el.setAttribute(EXTRA_NO_TRANSLATE_ATTRS[i], 'true');
    }
    el.setAttribute('data-addon-host-owner', ownerId);
    if (slotId) el.setAttribute('data-addon-host-slot', slotId);
  }

  function resolveHostAnchor(anchorKey) {
    if (!anchorKey || typeof anchorKey !== 'string') return null;
    if (!_has(HOST_UI_ANCHORS, anchorKey)) return null;
    const selectors = HOST_UI_ANCHORS[anchorKey];
    if (!_ArrayIsArray(selectors) || !document || typeof document.querySelector !== 'function') return null;
    for (let i = 0; i < selectors.length; i++) {
      try {
        const el = document.querySelector(selectors[i]);
        if (el) return el;
      } catch (_e) {}
    }
    return null;
  }

  function insertOrderedChild(parentEl, el, orderNum, position) {
    if (!parentEl || typeof parentEl.appendChild !== 'function') return;
    if (position === 'before' && parentEl.parentNode && typeof parentEl.parentNode.insertBefore === 'function') {
      parentEl.parentNode.insertBefore(el, parentEl);
      return;
    }
    if (position === 'after' && parentEl.parentNode && typeof parentEl.parentNode.insertBefore === 'function') {
      parentEl.parentNode.insertBefore(el, parentEl.nextSibling || null);
      return;
    }
    if (position === 'prepend' && typeof parentEl.insertBefore === 'function') {
      parentEl.insertBefore(el, parentEl.firstChild || null);
      return;
    }
    if (typeof parentEl.insertBefore === 'function' && parentEl.children && typeof parentEl.children.length === 'number') {
      for (let i = 0; i < parentEl.children.length; i++) {
        const ch = parentEl.children[i];
        if (ch && ch !== el && typeof ch.getAttribute === 'function') {
          const ordAttr = ch.getAttribute('data-addon-host-order');
          if (ordAttr !== null && ordAttr !== '') {
            const chOrd = _Number(ordAttr);
            if (_IsFinite(chOrd) && chOrd > orderNum) {
              parentEl.insertBefore(el, ch);
              return;
            }
          }
        }
      }
    }
    parentEl.appendChild(el);
  }

  function ensureHostModalBaseStyle() {
    if (modalBaseStyleMounted || !document || typeof document.createElement !== 'function') return;
    const head = document.head || document.documentElement || document.body;
    if (!head || typeof head.appendChild !== 'function') return;
    const st = document.createElement('style');
    st.setAttribute('data-addon-host-owner', 'addon-host');
    st.setAttribute('data-addon-host-style', 'addon-host:modal-base');
    st.textContent =
      '[data-addon-host-modal-backdrop="1"]{' +
      'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;' +
      'background:rgba(0,0,0,0.52);backdrop-filter:blur(2px);box-sizing:border-box;' +
      'color-scheme:dark light;--addon-modal-bg:#1b1d22;--addon-modal-surface:#23262d;' +
      '--addon-modal-border:rgba(255,255,255,0.14);--addon-modal-text:#eef1f6;--addon-modal-muted:#9aa3b2;--addon-modal-accent:#4c9aff;' +
      '}' +
      '[data-addon-host-modal-dialog="1"]{' +
      'display:flex;flex-direction:column;width:100%;max-width:min(520px,calc(100vw - 24px));max-height:88vh;' +
      'background:var(--addon-modal-bg,#1b1d22);color:var(--addon-modal-text,#eef1f6);' +
      'border:1px solid var(--addon-modal-border,rgba(255,255,255,0.14));border-radius:12px;' +
      'box-shadow:0 18px 48px rgba(0,0,0,0.45);overflow:hidden;box-sizing:border-box;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Malgun Gothic",sans-serif;font-size:13px;line-height:1.45;' +
      '}' +
      '[data-addon-host-popover="1"]{' +
      'position:fixed;display:flex;flex-direction:column;max-width:calc(100vw - 16px);max-height:calc(100vh - 24px);' +
      'background:var(--addon-modal-bg,#1b1d22);color:var(--addon-modal-text,#eef1f6);' +
      'border:1px solid var(--addon-modal-border,rgba(255,255,255,0.14));border-radius:10px;' +
      'box-shadow:0 12px 32px rgba(0,0,0,0.42);overflow:hidden;box-sizing:border-box;' +
      'color-scheme:dark light;--addon-modal-bg:#1b1d22;--addon-modal-surface:#23262d;' +
      '--addon-modal-border:rgba(255,255,255,0.14);--addon-modal-text:#eef1f6;--addon-modal-muted:#9aa3b2;--addon-modal-accent:#4c9aff;' +
      '}' +
      '[data-addon-host-modal-hdr="1"]{' +
      'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px;' +
      'border-bottom:1px solid var(--addon-modal-border,rgba(255,255,255,0.12));flex-shrink:0;' +
      '}' +
      '[data-addon-host-modal-title-wrap="1"]{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap;}' +
      '[data-addon-host-modal-title="1"]{margin:0;font-size:14px;font-weight:600;color:inherit;}' +
      '[data-addon-host-modal-badge="1"]{font-size:11px;padding:2px 7px;border-radius:999px;background:rgba(148,163,184,0.16);color:var(--addon-modal-muted,#9aa3b2);}' +
      '[data-addon-host-modal-close="1"]{appearance:none;border:1px solid var(--addon-modal-border,rgba(255,255,255,0.16));background:transparent;color:inherit;border-radius:6px;padding:4px 9px;font-size:12px;cursor:pointer;}' +
      '[data-addon-host-modal-body="1"]{padding:14px 16px;overflow-y:auto;box-sizing:border-box;}' +
      '@media (prefers-color-scheme:light){' +
      '[data-addon-host-modal-backdrop="1"],[data-addon-host-popover="1"]{' +
      '--addon-modal-bg:#ffffff;--addon-modal-surface:#f5f6f8;--addon-modal-border:rgba(0,0,0,0.14);--addon-modal-text:#181a1f;--addon-modal-muted:#5a6270;--addon-modal-accent:#1a66d9;' +
      '}}';
    head.appendChild(st);
    modalBaseStyleMounted = true;
  }

  function removeModalFromStack(slotId) {
    let writeIdx = 0;
    const nextItems = _ObjCreate(null);
    for (let i = 0; i < modalStack.count; i++) {
      const id = modalStack.items[i];
      if (id && id !== slotId) {
        nextItems[writeIdx++] = id;
      }
    }
    modalStack.items = nextItems;
    modalStack.count = writeIdx;
  }

  function pushModalToStack(slotId) {
    removeModalFromStack(slotId);
    modalStack.items[modalStack.count++] = slotId;
  }

  function getTopModalEntry() {
    for (let i = modalStack.count - 1; i >= 0; i--) {
      const id = modalStack.items[i];
      if (id && _has(modalEntries, id)) {
        return modalEntries[id];
      }
    }
    return null;
  }

  function isElementInsideIgnored(target, entry) {
    if (!target || !entry) return false;
    if (entry.dialogEl && typeof entry.dialogEl.contains === 'function' && entry.dialogEl.contains(target)) {
      return true;
    }
    if (entry.anchorEl && typeof entry.anchorEl.contains === 'function' && entry.anchorEl.contains(target)) {
      return true;
    }
    const list = entry.ignoreOutsideClickEls;
    if (list && typeof list.length === 'number') {
      for (let i = 0; i < list.length; i++) {
        const ign = list[i];
        if (ign === target || (ign && typeof ign.contains === 'function' && ign.contains(target))) {
          return true;
        }
      }
    }
    return false;
  }

  function closeModalInternal(slotId) {
    if (!_has(modalEntries, slotId)) return false;
    const entry = modalEntries[slotId];
    delete modalEntries[slotId];
    removeModalFromStack(slotId);
    if (entry.portalEl && entry.portalEl.parentNode && typeof entry.portalEl.parentNode.removeChild === 'function') {
      try { entry.portalEl.parentNode.removeChild(entry.portalEl); } catch (_e) {}
    }
    if (typeof entry.onClose === 'function') {
      try { _ReflectApply(entry.onClose, undefined, []); } catch (err) { recordPluginError(entry.pluginId, err); }
    }
    if (entry.previousFocusEl && typeof entry.previousFocusEl.focus === 'function') {
      try { entry.previousFocusEl.focus(); } catch (_e) {}
    }
    return true;
  }

  function ensureModalGlobalListeners() {
    if (modalGlobalListenersBound || typeof window !== 'object' || !window || typeof window.addEventListener !== 'function') return;
    modalGlobalListenersBound = true;
    window.addEventListener('keydown', function(evt) {
      if (!evt || evt.key !== 'Escape') return;
      const top = getTopModalEntry();
      if (!top || top.closeOnEsc === false) return;
      if (typeof evt.preventDefault === 'function') evt.preventDefault();
      if (typeof evt.stopPropagation === 'function') evt.stopPropagation();
      closeModalInternal(top.slotId);
    }, true);
    window.addEventListener('mousedown', function(evt) {
      const top = getTopModalEntry();
      if (!top || top.mode !== 'popover' || top.closeOnBackdrop === false) return;
      if (isElementInsideIgnored(evt && evt.target, top)) return;
      closeModalInternal(top.slotId);
    }, true);
  }

  function positionPopoverElement(popoverEl, anchorEl, placement) {
    if (!popoverEl || !popoverEl.style || !anchorEl || typeof anchorEl.getBoundingClientRect !== 'function') return;
    try {
      const rect = anchorEl.getBoundingClientRect();
      const vw = typeof window.innerWidth === 'number' && window.innerWidth > 0 ? window.innerWidth : 1024;
      const vh = typeof window.innerHeight === 'number' && window.innerHeight > 0 ? window.innerHeight : 768;
      const pad = 8;
      const place = typeof placement === 'string' ? placement : 'top-end';
      if (startsWithSafe(place, 'top')) {
        const bottomOffset = _MathMax(pad, _MathRound(vh - rect.top + 6));
        popoverEl.style.bottom = bottomOffset + 'px';
        popoverEl.style.maxHeight = _MathMax(120, _MathRound(rect.top - 16)) + 'px';
      } else {
        const topOffset = _MathMax(pad, _MathRound(rect.bottom + 6));
        popoverEl.style.top = topOffset + 'px';
        popoverEl.style.maxHeight = _MathMax(120, _MathRound(vh - topOffset - pad)) + 'px';
      }
      if (indexOfSafe(place, 'end') !== -1) {
        const rightOffset = _MathMax(pad, _MathRound(vw - rect.right));
        popoverEl.style.right = rightOffset + 'px';
      } else {
        const leftOffset = _MathMax(pad, _MathRound(rect.left));
        popoverEl.style.left = leftOffset + 'px';
      }
    } catch (_e) {}
  }

  function buildSortedActionsSnapshot(surface) {
    const keys = _ObjKeys(registeredActions);
    const items = [];
    let len = 0;
    for (let i = 0; i < keys.length; i++) {
      const act = registeredActions[keys[i]];
      if (!act) continue;
      if (surface && act.surface !== surface) continue;
      _ObjDefineProperty(items, len++, makeDataDesc(act, true, true, true));
    }
    // Insertion sort (immune to Array.prototype.sort pollution)
    for (let i = 1; i < len; i++) {
      const cur = items[i];
      let j = i - 1;
      while (j >= 0) {
        const prev = items[j];
        const cmp =
          prev.order !== cur.order
            ? prev.order - cur.order
            : prev.pluginId !== cur.pluginId
              ? prev.pluginId < cur.pluginId ? -1 : 1
              : prev.id < cur.id ? -1 : prev.id > cur.id ? 1 : 0;
        if (cmp <= 0) break;
        _ObjDefineProperty(items, j + 1, makeDataDesc(prev, true, true, true));
        j--;
      }
      _ObjDefineProperty(items, j + 1, makeDataDesc(cur, true, true, true));
    }
    const out = [];
    for (let i = 0; i < len; i++) {
      const a = items[i];
      _ObjDefineProperty(
        out,
        i,
        makeDataDesc(
          _ObjFreeze({
            key: a.key,
            pluginId: a.pluginId,
            id: a.id,
            surface: a.surface,
            label: a.label,
            title: a.title,
            description: a.description,
            order: a.order,
            source: a.source,
            disabled: a.disabled,
            invoke(ctx) {
              if (a.disabled || typeof a.onClick !== 'function') return undefined;
              const payload = _ObjFreeze({
                pluginId: a.pluginId,
                actionId: a.id,
                surface: a.surface,
                event: ctx && ctx.event ? ctx.event : null,
                buttonEl: ctx && ctx.buttonEl ? ctx.buttonEl : null,
                anchorEl: (ctx && (ctx.anchorEl || ctx.buttonEl)) || null,
                sessionId: ctx && ctx.sessionId !== undefined ? ctx.sessionId : null,
              });
              try {
                const ret = _ReflectApply(a.onClick, undefined, [payload]);
                if (ret && typeof ret.then === 'function') {
                  return promiseThenSafe(ret, undefined, function(asyncErr) {
                    recordPluginError(a.pluginId, asyncErr);
                    return undefined;
                  });
                }
                return ret;
              } catch (syncErr) {
                recordPluginError(a.pluginId, syncErr);
                return undefined;
              }
            },
          }),
          true,
          true,
          true
        )
      );
    }
    return out;
  }

  function notifyActionSubscribers(surface) {
    const keys = _ObjKeys(actionSubscribers);
    for (let i = 0; i < keys.length; i++) {
      const sub = actionSubscribers[keys[i]];
      if (!sub || (sub.surface && sub.surface !== surface)) continue;
      try {
        _ReflectApply(sub.listener, undefined, [buildSortedActionsSnapshot(sub.surface)]);
      } catch (err) {
        recordPluginError(sub.pluginId, err);
      }
    }
  }

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
    const slotAnchors = spec.slotAnchorsMap || _ObjCreate(null);
    const pluginLoadOrder = typeof spec.loadOrder === 'number' && _IsFinite(spec.loadOrder) ? spec.loadOrder : 100;
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
      loadOrder: pluginLoadOrder,
      hostVersion: ${serializeSafeInlineJson(hostVersion)},
      hostProfileId: ${serializeSafeInlineJson(hostProfileId)},
      storageNamespace,
      ipcChannelPrefix,
      getNoTranslateSelector() {
        return NO_TRANSLATE_SELECTOR;
      },
      resolveAnchor(anchorKey) {
        assertNotDisposed();
        return resolveHostAnchor(anchorKey);
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
        const options = opts && typeof opts === 'object' ? opts : null;
        const anchorKey =
          (options && typeof options.anchor === 'string' && options.anchor) ||
          (_has(slotAnchors, slotId) ? slotAnchors[slotId] : null);
        let hostParent = parentEl || null;
        if (!hostParent && anchorKey) {
          hostParent = resolveHostAnchor(anchorKey);
          if (!hostParent) return null;
        }
        if (!hostParent) {
          hostParent = document.body;
        }
        let el = _has(slotElements, slotId) ? slotElements[slotId] : null;
        if (!el) {
          el = document.createElement('div');
          applyNoTranslateAttrs(el, pluginId, slotId);
          el.setAttribute('data-addon-host-order', _String(pluginLoadOrder));
          slotOwners[slotId] = pluginId;
          slotElements[slotId] = el;
        }
        const position = options && typeof options.position === 'string' ? options.position : 'append';
        if (hostParent && el.parentNode !== hostParent) {
          insertOrderedChild(hostParent, el, pluginLoadOrder, position);
        }
        if (options && options.shadow === true && typeof el.attachShadow === 'function') {
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
      openModal(slotId, opts) {
        assertNotDisposed();
        if (!slotId || typeof slotId !== 'string') throw new _Error('ERR_INVALID_SLOT_ID');
        if (!_has(allowedSlots, slotId)) {
          throw new _Error('ERR_UNDECLARED_SLOT:' + slotId);
        }
        if (_has(modalEntries, slotId) && modalEntries[slotId].pluginId !== pluginId) {
          throw new _Error('ERR_MODAL_OWNED_BY_ANOTHER_PLUGIN:' + slotId);
        }
        if (_has(modalEntries, slotId)) {
          closeModalInternal(slotId);
        }
        ensureHostModalBaseStyle();
        ensureModalGlobalListeners();

        const options = opts && typeof opts === 'object' ? opts : {};
        const mode = options.mode === 'popover' ? 'popover' : 'dialog';
        const zIndex = (modalZCounter += 2);
        const previousFocusEl =
          (options.returnFocusEl && typeof options.returnFocusEl.focus === 'function' ? options.returnFocusEl : null) ||
          (options.anchorEl && typeof options.anchorEl.focus === 'function' ? options.anchorEl : null) ||
          (document && document.activeElement && typeof document.activeElement.focus === 'function' ? document.activeElement : null);

        const dialogEl = document.createElement('div');
        dialogEl.setAttribute('role', 'dialog');
        if (mode === 'dialog') {
          dialogEl.setAttribute('aria-modal', 'true');
          dialogEl.setAttribute('data-addon-host-modal-dialog', '1');
        } else {
          dialogEl.setAttribute('data-addon-host-popover', '1');
        }
        applyNoTranslateAttrs(dialogEl, pluginId, slotId);
        dialogEl.setAttribute('data-addon-host-modal', '1');
        if (dialogEl.style) {
          if (typeof options.width === 'string' && options.width) {
            dialogEl.style.width = options.width;
          }
          if (typeof options.maxWidth === 'string' && options.maxWidth) {
            dialogEl.style.maxWidth = options.maxWidth;
          }
        }

        let titleEl = null;
        let badgeEl = null;
        if (options.hideHeader !== true && (options.title || options.badge || mode === 'dialog')) {
          const hdr = document.createElement('div');
          hdr.setAttribute('data-addon-host-modal-hdr', '1');
          const titleWrap = document.createElement('div');
          titleWrap.setAttribute('data-addon-host-modal-title-wrap', '1');
          titleEl = document.createElement('h2');
          titleEl.setAttribute('data-addon-host-modal-title', '1');
          const titleId = 'addon-modal-title-' + pluginId + '-' + slotId;
          titleEl.setAttribute('id', titleId);
          titleEl.textContent = typeof options.title === 'string' ? options.title : '';
          dialogEl.setAttribute('aria-labelledby', titleId);
          titleWrap.appendChild(titleEl);

          badgeEl = document.createElement('span');
          badgeEl.setAttribute('data-addon-host-modal-badge', '1');
          badgeEl.textContent = typeof options.badge === 'string' ? options.badge : '';
          if (badgeEl.style && !badgeEl.textContent) badgeEl.style.display = 'none';
          titleWrap.appendChild(badgeEl);

          const closeBtn = document.createElement('button');
          closeBtn.setAttribute('type', 'button');
          closeBtn.setAttribute('data-addon-host-modal-close', '1');
          closeBtn.setAttribute('aria-label', typeof options.closeLabel === 'string' ? options.closeLabel : 'Close');
          closeBtn.textContent = typeof options.closeLabel === 'string' ? options.closeLabel : '닫기';
          if (typeof closeBtn.addEventListener === 'function') {
            closeBtn.addEventListener('click', function() { closeModalInternal(slotId); });
          } else {
            closeBtn.onclick = function() { closeModalInternal(slotId); };
          }
          hdr.appendChild(titleWrap);
          hdr.appendChild(closeBtn);
          dialogEl.appendChild(hdr);
        }

        const bodyContainer = document.createElement('div');
        bodyContainer.setAttribute('data-addon-host-modal-body', '1');
        dialogEl.appendChild(bodyContainer);
        const bodyEl =
          options.shadow === true && typeof bodyContainer.attachShadow === 'function'
            ? bodyContainer.shadowRoot || bodyContainer.attachShadow({ mode: 'open' })
            : bodyContainer;

        let portalEl = dialogEl;
        if (mode === 'dialog') {
          const backdrop = document.createElement('div');
          backdrop.setAttribute('data-addon-host-modal-backdrop', '1');
          applyNoTranslateAttrs(backdrop, pluginId, slotId);
          if (backdrop.style) backdrop.style.zIndex = _String(zIndex);
          if (options.closeOnBackdrop !== false) {
            const onBackdropClick = function(evt) {
              if (evt && evt.target === backdrop) closeModalInternal(slotId);
            };
            if (typeof backdrop.addEventListener === 'function') {
              backdrop.addEventListener('mousedown', onBackdropClick);
            } else {
              backdrop.onclick = onBackdropClick;
            }
          }
          backdrop.appendChild(dialogEl);
          portalEl = backdrop;
        } else {
          if (dialogEl.style) dialogEl.style.zIndex = _String(zIndex);
          if (options.anchorEl) {
            positionPopoverElement(dialogEl, options.anchorEl, options.placement || 'top-end');
          }
        }

        const mountRoot = resolveHostAnchor('modal-root') || document.body || document.documentElement;
        if (mountRoot && typeof mountRoot.appendChild === 'function') {
          mountRoot.appendChild(portalEl);
        }

        const ignoreList = [];
        let ignoreLen = 0;
        if (options.ignoreOutsideClickEls) {
          const rawIgn = _ArrayIsArray(options.ignoreOutsideClickEls)
            ? options.ignoreOutsideClickEls
            : [options.ignoreOutsideClickEls];
          for (let i = 0; i < rawIgn.length; i++) {
            if (_has(rawIgn, i) && rawIgn[i]) {
              _ObjDefineProperty(ignoreList, ignoreLen++, makeDataDesc(rawIgn[i], true, true, true));
            }
          }
        }

        modalEntries[slotId] = {
          pluginId,
          slotId,
          mode,
          zIndex,
          portalEl,
          dialogEl,
          bodyEl,
          anchorEl: options.anchorEl || null,
          ignoreOutsideClickEls: ignoreList,
          closeOnBackdrop: options.closeOnBackdrop !== false,
          closeOnEsc: options.closeOnEsc !== false,
          onClose: typeof options.onClose === 'function' ? options.onClose : null,
          previousFocusEl,
        };
        pushModalToStack(slotId);

        return _ObjFreeze({
          slotId,
          mode,
          zIndex,
          rootEl: portalEl,
          dialogEl,
          bodyEl,
          setTitle(nextTitle) {
            if (titleEl) titleEl.textContent = _String(nextTitle || '');
          },
          setBadge(nextBadge) {
            if (!badgeEl) return;
            const txt = _String(nextBadge || '');
            badgeEl.textContent = txt;
            if (badgeEl.style) badgeEl.style.display = txt ? '' : 'none';
          },
          close() {
            return closeModalInternal(slotId);
          },
        });
      },
      closeModal(slotId) {
        assertNotDisposed();
        if (!_has(modalEntries, slotId)) return false;
        if (modalEntries[slotId].pluginId !== pluginId) {
          throw new _Error('ERR_FORBIDDEN_CROSS_PLUGIN_MODAL:' + slotId);
        }
        return closeModalInternal(slotId);
      },
      toggleModal(slotId, opts) {
        assertNotDisposed();
        if (_has(modalEntries, slotId)) {
          if (modalEntries[slotId].pluginId !== pluginId) {
            throw new _Error('ERR_FORBIDDEN_CROSS_PLUGIN_MODAL:' + slotId);
          }
          closeModalInternal(slotId);
          return null;
        }
        return handle.openModal(slotId, opts);
      },
      isModalOpen(slotId) {
        return Boolean(_has(modalEntries, slotId) && modalEntries[slotId].pluginId === pluginId);
      },
      registerAction(def) {
        assertNotDisposed();
        if (!def || typeof def !== 'object') throw new _Error('ERR_INVALID_ACTION_DEF');
        const surface = typeof def.surface === 'string' ? trimSafe(def.surface) : '';
        const id = typeof def.id === 'string' ? trimSafe(def.id) : '';
        const label = typeof def.label === 'string' ? trimSafe(def.label) : '';
        if (!surface || !id || !label || typeof def.onClick !== 'function') {
          throw new _Error('ERR_INVALID_ACTION_DEF');
        }
        const key = pluginId + ':' + id;
        const order = typeof def.order === 'number' && _IsFinite(def.order) ? def.order : pluginLoadOrder;
        registeredActions[key] = {
          key,
          pluginId,
          id,
          surface,
          label,
          title: typeof def.title === 'string' ? def.title : '',
          description: typeof def.description === 'string' ? def.description : '',
          order,
          source: typeof def.source === 'string' && trimSafe(def.source) ? trimSafe(def.source) : 'plugin',
          disabled: Boolean(def.disabled),
          onClick: def.onClick,
        };
        notifyActionSubscribers(surface);
        return key;
      },
      updateAction(id, patch) {
        assertNotDisposed();
        const key = pluginId + ':' + trimSafe(id);
        if (!_has(registeredActions, key) || registeredActions[key].pluginId !== pluginId) {
          return false;
        }
        const cur = registeredActions[key];
        const p = patch && typeof patch === 'object' ? patch : {};
        if (typeof p.label === 'string' && trimSafe(p.label)) cur.label = trimSafe(p.label);
        if (typeof p.title === 'string') cur.title = p.title;
        if (typeof p.description === 'string') cur.description = p.description;
        if (typeof p.order === 'number' && _IsFinite(p.order)) cur.order = p.order;
        if (typeof p.disabled === 'boolean') cur.disabled = p.disabled;
        if (typeof p.onClick === 'function') cur.onClick = p.onClick;
        notifyActionSubscribers(cur.surface);
        return true;
      },
      unregisterAction(id) {
        assertNotDisposed();
        const key = pluginId + ':' + trimSafe(id);
        if (!_has(registeredActions, key) || registeredActions[key].pluginId !== pluginId) {
          return false;
        }
        const surface = registeredActions[key].surface;
        delete registeredActions[key];
        notifyActionSubscribers(surface);
        return true;
      },
      listActions(surface) {
        assertNotDisposed();
        return buildSortedActionsSnapshot(typeof surface === 'string' ? trimSafe(surface) : '');
      },
      onActionsChanged(surface, listener) {
        assertNotDisposed();
        if (typeof listener !== 'function') throw new _Error('ERR_INVALID_ACTION_LISTENER');
        const surf = typeof surface === 'string' ? trimSafe(surface) : '';
        const subId = 'sub-' + (++actionSubCounter);
        actionSubscribers[subId] = { pluginId, surface: surf, listener };
        return function unsubscribe() {
          delete actionSubscribers[subId];
        };
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
        if (disposed || typeof fn !== 'function') return _PromiseResolve(undefined);
        try {
          const res = _ReflectApply(fn, undefined, []);
          if (res && typeof res.then === 'function') {
            return promiseThenSafe(res, undefined, function(asyncErr) {
              recordPluginError(pluginId, asyncErr);
              return undefined;
            });
          }
          return _PromiseResolve(res);
        } catch (syncErr) {
          recordPluginError(pluginId, syncErr);
          return _PromiseResolve(undefined);
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
              promiseThenSafe(ret, undefined, function(asyncErr) {
                recordPluginError(pluginId, asyncErr);
              });
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
        // Clean action subscriptions and contributed actions
        try {
          const subKeys = _ObjKeys(actionSubscribers);
          for (let i = 0; i < subKeys.length; i++) {
            const sk = subKeys[i];
            if (actionSubscribers[sk] && actionSubscribers[sk].pluginId === pluginId) {
              delete actionSubscribers[sk];
            }
          }
          const touchedSurfaces = _ObjCreate(null);
          const actKeys = _ObjKeys(registeredActions);
          for (let i = 0; i < actKeys.length; i++) {
            const ak = actKeys[i];
            if (registeredActions[ak] && registeredActions[ak].pluginId === pluginId) {
              touchedSurfaces[registeredActions[ak].surface] = true;
              delete registeredActions[ak];
            }
          }
          const surfKeys = _ObjKeys(touchedSurfaces);
          for (let i = 0; i < surfKeys.length; i++) {
            notifyActionSubscribers(surfKeys[i]);
          }
        } catch (_err) {}
        // Close all modals/popovers owned by this plugin
        try {
          const mKeys = _ObjKeys(modalEntries);
          for (let i = 0; i < mKeys.length; i++) {
            const mk = mKeys[i];
            if (modalEntries[mk] && modalEntries[mk].pluginId === pluginId) {
              closeModalInternal(mk);
            }
          }
        } catch (_err) {}
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
        const slotAnchorsMap = _ObjCreate(null);
        if (spec.slotAnchors && typeof spec.slotAnchors === 'object') {
          const anchorKeys = _ObjKeys(spec.slotAnchors);
          for (let i = 0; i < anchorKeys.length; i++) {
            const k = anchorKeys[i];
            if (typeof spec.slotAnchors[k] === 'string' && spec.slotAnchors[k]) {
              slotAnchorsMap[k] = spec.slotAnchors[k];
            }
          }
        }
        pendingSpecs[token] = _ObjFreeze({
          pluginId: _String(spec.pluginId),
          loadOrder: typeof spec.loadOrder === 'number' && _IsFinite(spec.loadOrder) ? spec.loadOrder : 100,
          allowedSlotsMap: _ObjFreeze(allowedSlotsMap),
          slotAnchorsMap: _ObjFreeze(slotAnchorsMap),
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

  function consumeCapabilityInternal(token) {
    if (typeof token !== 'string' || !_has(pendingSpecs, token)) {
      throw new _Error('ERR_INVALID_CAPABILITY_TOKEN');
    }
    const boundSpec = pendingSpecs[token];
    delete pendingSpecs[token];
    const scoped = createScopedHandle(boundSpec);
    activeHandles[boundSpec.pluginId] = scoped;
    return scoped;
  }

  _ObjDefineProperty(
    window,
    '__ADDON_HOST_CONSUME_CAP__',
    makeDataDesc(consumeCapabilityInternal, false, false, false)
  );

  // R1-F2: Prototype-pollution-immune addon runner using captured _Promise/_PromiseResolve/_PromiseProtoThen
  _ObjDefineProperty(
    window,
    '__ADDON_HOST_RUN_ADDON__',
    makeDataDesc(
      function(token, runnerFn) {
        const scoped = consumeCapabilityInternal(token);
        try {
          const ret = _ReflectApply(runnerFn, undefined, [scoped]);
          if (ret && typeof ret.then === 'function') {
            return promiseThenSafe(
              ret,
              function() { return true; },
              function(asyncErr) {
                try { scoped.reportError(asyncErr); } catch (_r) {}
                try { scoped.dispose(); } catch (_d) {}
                throw asyncErr;
              }
            );
          }
          return true;
        } catch (syncErr) {
          try { scoped.reportError(syncErr); } catch (_r) {}
          try { scoped.dispose(); } catch (_d) {}
          throw syncErr;
        }
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

  // P1 & NB4: Host-authenticated retrieval of isolated async renderer errors
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
  {
    hostVersion = pkg.version,
    strictTrustPolicy = false,
    mainHookTimeoutMs = 5000,
    rendererExecTimeoutMs = 10000,
  } = {}
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
    uiAnchors: profile.uiAnchors || {},
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
    rendererExecTimeoutMs:
      Number.isInteger(rendererExecTimeoutMs) && rendererExecTimeoutMs >= 100 ? rendererExecTimeoutMs : 10000,
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
  return collectExecutionPlan().active.map((item) => {
    const slotAnchors = {};
    for (const s of item.manifest.uiSlots || []) {
      if (s && s.slotId && typeof s.anchor === 'string' && s.anchor) {
        slotAnchors[s.slotId] = s.anchor;
      }
    }
    return {
      pluginId: item.pluginId,
      loadOrder: item.loadOrder,
      trustLevel: item.trustLevel || 'restricted',
      hasDocumentTransformSlot: Boolean(item.hasDocumentTransformSlot),
      rendererPath: item.resolvedEntries.rendererScript,
      mainHookPath: item.resolvedEntries.mainHookScript,
      allowedSlotIds: (item.manifest.uiSlots || []).map((s) => s.slotId),
      slotAnchors,
      storageNamespace: (item.manifest.isolation && item.manifest.isolation.storageNamespace) || item.pluginId,
      ipcChannelPrefix: (item.manifest.isolation && item.manifest.isolation.ipcChannelPrefix) || null,
    };
  });
}

// P1 & R1-F3: Least-Privilege Main Host Broker with strict active-entry lifecycle guard
const ALLOWED_APP_PATHS = new Set(['userData', 'temp', 'logs']);
const ALLOWED_WC_EVENTS = new Set(['dom-ready', 'did-finish-load', 'did-navigate', 'did-fail-load', 'destroyed']);

function createScopedMainHostBridge(electronApp, pluginId, cleanupFns, isActiveEntry) {
  function assertActive() {
    if (typeof isActiveEntry === 'function' && !isActiveEntry()) {
      throw new Error('ERR_MAIN_HOOK_DISPOSED:' + pluginId);
    }
  }
  return Object.freeze({
    getVersion() {
      return electronApp && typeof electronApp.getVersion === 'function' ? electronApp.getVersion() : null;
    },
    getPath(name) {
      assertActive();
      if (!ALLOWED_APP_PATHS.has(String(name || ''))) {
        throw new Error('ERR_FORBIDDEN_APP_PATH:' + String(name || ''));
      }
      return electronApp && typeof electronApp.getPath === 'function' ? electronApp.getPath(name) : null;
    },
    onBeforeQuit(fn) {
      assertActive();
      if (typeof fn !== 'function' || !electronApp || typeof electronApp.on !== 'function') return () => {};
      const wrapped = (...args) => {
        if (typeof isActiveEntry === 'function' && !isActiveEntry()) return;
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
      cleanupFns.add(detach);
      return detach;
    },
  });
}

function createScopedWebContentsBridge(contents, pluginId, cleanupFns, isActiveEntry) {
  const registeredListeners = new Set();
  const worldId = HOST_CFG.isolatedWorldId || 999;

  function assertActive() {
    if (typeof isActiveEntry === 'function' && !isActiveEntry()) {
      throw new Error('ERR_MAIN_HOOK_DISPOSED:' + pluginId);
    }
  }

  function assertAllowedLiveUrl() {
    assertActive();
    if (!contents || (typeof contents.isDestroyed === 'function' && contents.isDestroyed())) {
      throw new Error('ERR_WEBCONTENTS_DESTROYED');
    }
    const liveUrl = typeof contents.getURL === 'function' ? contents.getURL() : '';
    if (!isAllowedRendererUrl(liveUrl)) {
      throw new Error('ERR_FORBIDDEN_RENDERER_URL');
    }
  }

  // NB2: Immediately reclaim all listeners and cleanup closure when this contents is destroyed
  const detachAllForContents = () => {
    cleanupFns.delete(detachAllForContents);
    for (const rec of Array.from(registeredListeners)) {
      registeredListeners.delete(rec);
      try {
        if (contents && typeof contents.removeListener === 'function') {
          contents.removeListener(rec.ev, rec.wrapped);
        }
      } catch (_e) {}
    }
    try {
      if (contents && typeof contents.removeListener === 'function') {
        contents.removeListener('destroyed', onRawDestroyed);
      }
    } catch (_e) {}
  };
  const onRawDestroyed = () => {
    detachAllForContents();
  };
  cleanupFns.add(detachAllForContents);
  if (contents && typeof contents.on === 'function') {
    contents.on('destroyed', onRawDestroyed);
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
      assertActive();
      const ev = String(eventName || '');
      if (!ALLOWED_WC_EVENTS.has(ev)) {
        throw new Error('ERR_FORBIDDEN_WEBCONTENTS_EVENT:' + ev);
      }
      if (typeof fn !== 'function' || !contents || typeof contents.on !== 'function') return;
      const wrapped = (...args) => {
        if (typeof isActiveEntry === 'function' && !isActiveEntry()) return;
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
const pendingMainHookDisposes = new Map();
const contentsErrorReaders = new WeakMap();

function runCleanupFns(cleanupFns) {
  for (const fn of Array.from(cleanupFns)) {
    cleanupFns.delete(fn);
    try { fn(); } catch (_e) {}
  }
}

// R1-F3: Serialize per-pluginId async dispose & enforce entry identity so stale dispose never overwrites new ACTIVE state
function disposeMainHookEntry(pluginId, entry) {
  if (entry) {
    entry.disposed = true;
    runCleanupFns(entry.cleanupFns);
  }
  setLifecycleState(pluginId, 'mainHook', 'DISPOSING');
  const finish = (errMsg) => {
    if (entry) runCleanupFns(entry.cleanupFns);
    if (!loadedMainHooks.has(pluginId)) {
      setLifecycleState(pluginId, 'mainHook', 'DISPOSED', errMsg || null);
    }
  };
  let p;
  try {
    if (entry && entry.mod && typeof entry.mod.dispose === 'function') {
      const ret = entry.mod.dispose();
      if (ret && typeof ret.then === 'function') {
        p = Promise.resolve(ret)
          .then(() => finish(null))
          .catch((err) => {
            const msg = err && err.message ? err.message : String(err);
            recordDiag('error', 'ERR_MAIN_HOOK_DISPOSE_ASYNC', pluginId + ': ' + msg);
            finish(msg);
          });
      } else {
        finish(null);
        p = Promise.resolve();
      }
    } else {
      finish(null);
      p = Promise.resolve();
    }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    recordDiag('error', 'ERR_MAIN_HOOK_DISPOSE', pluginId + ': ' + msg);
    finish(msg);
    p = Promise.resolve();
  }
  const tracked = p.finally(() => {
    if (pendingMainHookDisposes.get(pluginId) === tracked) {
      pendingMainHookDisposes.delete(pluginId);
    }
  });
  pendingMainHookDisposes.set(pluginId, tracked);
  return tracked;
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
    // R1-F3: Defer re-activation until any in-flight async dispose for this pluginId settles
    const inflightDispose = pendingMainHookDisposes.get(addon.pluginId);
    if (inflightDispose) {
      if (!inflightDispose.__resyncQueued) {
        inflightDispose.__resyncQueued = true;
        inflightDispose.finally(() => syncMainHooks(electronApp));
      }
      continue;
    }

    const cleanupFns = new Set();
    const entry = { mod: null, addon, cleanupFns, activatePromise: null, disposed: false };
    const isActiveEntry = () => !entry.disposed && loadedMainHooks.get(addon.pluginId) === entry;
    setLifecycleState(addon.pluginId, 'mainHook', 'PENDING');
    setLifecycleState(addon.pluginId, 'mainHook', 'ACTIVATING');
    try {
      const mod = require(addon.mainHookPath);
      entry.mod = mod;
      loadedMainHooks.set(addon.pluginId, entry);
      const hostBridge = createScopedMainHostBridge(electronApp, addon.pluginId, cleanupFns, isActiveEntry);
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

      let ret;
      if (typeof mod === 'function') ret = mod(ctx);
      else if (mod && typeof mod.activate === 'function') ret = mod.activate(ctx);

      if (ret && typeof ret.then === 'function') {
        let timer = null;
        const raced =
          typeof setTimeout === 'function'
            ? Promise.race([
                Promise.resolve(ret),
                new Promise((_, reject) => {
                  timer = setTimeout(() => reject(new Error('ERR_MAIN_HOOK_ACTIVATE_TIMEOUT')), HOST_CFG.mainHookTimeoutMs);
                  if (timer && typeof timer.unref === 'function') timer.unref();
                }),
              ])
            : Promise.resolve(ret);
        entry.activatePromise = raced
          .then(() => {
            if (timer && typeof clearTimeout === 'function') clearTimeout(timer);
            if (isActiveEntry()) {
              setLifecycleState(addon.pluginId, 'mainHook', 'ACTIVE');
            }
          })
          .catch((err) => {
            if (timer && typeof clearTimeout === 'function') clearTimeout(timer);
            const msg = err && err.message ? err.message : String(err);
            recordDiag('error', 'ERR_MAIN_HOOK_ACTIVATE_ASYNC', addon.pluginId + ': ' + msg);
            entry.disposed = true;
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
      entry.disposed = true;
      loadedMainHooks.delete(addon.pluginId);
      failedMainHookIds.add(addon.pluginId);
      runCleanupFns(cleanupFns);
      setLifecycleState(addon.pluginId, 'mainHook', 'FAILED', msg);
      recordDiag('error', 'ERR_MAIN_HOOK_ACTIVATE', addon.pluginId + ': ' + msg);
    }
  }
}

async function collectRendererErrors(contents, pluginId) {
  const reader = contents ? contentsErrorReaders.get(contents) : null;
  if (typeof reader !== 'function') return [];
  return reader(pluginId);
}

function attachWebContents(contents, electronApp) {
  if (!contents || typeof contents.getType !== 'function' || contents.getType() !== 'window') return;
  syncMainHooks(electronApp);

  for (const [pluginId, entry] of loadedMainHooks.entries()) {
    if (entry && !entry.disposed && entry.mod && typeof entry.mod.onWebContentsCreated === 'function') {
      try {
        const isActiveEntry = () => !entry.disposed && loadedMainHooks.get(pluginId) === entry;
        const scopedContents = createScopedWebContentsBridge(contents, pluginId, entry.cleanupFns, isActiveEntry);
        const hostBridge = createScopedMainHostBridge(electronApp, pluginId, entry.cleanupFns, isActiveEntry);
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

  // NB4: Host-authenticated reader consuming window.__ADDON_HOST_GET_ERRORS__
  contentsErrorReaders.set(contents, async (pluginId) => {
    if (!hostSecret || !instanceNonce || pendingNav) return [];
    const liveLoc = getAllowedLocation();
    if (!liveLoc) return [];
    const liveOk = await verifyLiveNonce(instanceNonce);
    if (!liveOk || pendingNav) return [];
    try {
      const res = await execInRenderer(
        'typeof window.__ADDON_HOST_GET_ERRORS__ === "function" ? window.__ADDON_HOST_GET_ERRORS__(' +
          JSON.stringify(hostSecret) + ',' +
          JSON.stringify(instanceNonce) + ',' +
          JSON.stringify(liveLoc) + ',' +
          JSON.stringify(String(pluginId || '')) + ') : []'
      );
      return Array.isArray(res) ? res : [];
    } catch (_e) {
      return [];
    }
  });

  const enqueueInject = () => {
    injectQueue = injectQueue.then(async () => {
      try {
        // F4: Re-sync mainHooks on every reload/navigation so disabled hooks dispose even in a single-window session
        syncMainHooks(electronApp);

        if (pendingNav) return;
        const passGen = navGeneration;
        const initialLoc = getAllowedLocation();
        if (!initialLoc) return;

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
        // R1-F2: Record explicit PENDING state for every addon queued for this injection pass
        for (const addon of addons) {
          setLifecycleState(addon.pluginId, 'renderer', 'PENDING');
        }
        // Deterministic sequential execution preserves loadOrder while isolating each plugin's faults & timeouts
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
              setLifecycleState(addon.pluginId, 'renderer', 'PENDING');
              recordDiag('warn', 'ERR_RENDERER_TOCTOU_ABORT', addon.pluginId + ': origin/nonce/nav changed before cap registration');
              if (!pendingNav && navGeneration === passGen) resetCredentials();
              break;
            }
            capToken = crypto.randomBytes(24).toString('hex');
            const spec = {
              pluginId: addon.pluginId,
              loadOrder: addon.loadOrder,
              allowedSlotIds: addon.allowedSlotIds,
              slotAnchors: addon.slotAnchors,
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
              setLifecycleState(addon.pluginId, 'renderer', 'PENDING');
              recordDiag('warn', 'ERR_RENDERER_TOCTOU_ABORT', addon.pluginId + ': origin/nonce/nav changed before execution');
              if (!pendingNav && navGeneration === passGen) resetCredentials();
              break;
            }
            // R1-F2: Delegate execution to prototype-safe __ADDON_HOST_RUN_ADDON__ (captured _Promise) + host timeout guard
            const wrapped =
              'window.__ADDON_HOST_RUN_ADDON__(' + JSON.stringify(capToken) + ', function(addonHost){\\n' +
              rawCode +
              '\\n});';
            let execTimer = null;
            try {
              if (typeof setTimeout === 'function') {
                const execTimeoutPromise = new Promise((_, reject) => {
                  execTimer = setTimeout(() => reject(new Error('ERR_RENDERER_EXEC_TIMEOUT')), HOST_CFG.rendererExecTimeoutMs);
                  if (execTimer && typeof execTimer.unref === 'function') execTimer.unref();
                });
                await Promise.race([Promise.resolve(execInRenderer(wrapped)), execTimeoutPromise]);
              } else {
                await execInRenderer(wrapped);
              }
            } finally {
              if (execTimer && typeof clearTimeout === 'function') clearTimeout(execTimer);
            }
            // R7-F4: Guard against navigation firing while execInRenderer(wrapped) was in flight
            if (pendingNav || navGeneration !== passGen) {
              setLifecycleState(addon.pluginId, 'renderer', 'PENDING');
              recordDiag('warn', 'ERR_RENDERER_TOCTOU_ABORT', addon.pluginId + ': navigation occurred during execution');
              break;
            }
            injectedIds.add(addon.pluginId);
            setLifecycleState(addon.pluginId, 'renderer', 'ACTIVE');
          } catch (err) {
            // R6-F4, R7-F4, R8-F2 & R1-F2: Isolate failing/timed-out plugin; clean partial DOM on timeout;
            // ONLY call REVOKE_CAP/DISPOSE if the renderer is STILL verified trusted.
            const msg = err && err.message ? err.message : String(err);
            if (!pendingNav && navGeneration === passGen) {
              failedIds.add(addon.pluginId);
              setLifecycleState(addon.pluginId, 'renderer', 'FAILED', msg);
            } else {
              setLifecycleState(addon.pluginId, 'renderer', 'PENDING');
            }
            if (hostSecret && instanceNonce && !pendingNav && navGeneration === passGen) {
              try {
                const trustedLocForCleanup = await verifyDocumentStillTrusted();
                if (trustedLocForCleanup) {
                  if (capToken) {
                    await execInRenderer(
                      'typeof window.__ADDON_HOST_REVOKE_CAP__ === "function" && window.__ADDON_HOST_REVOKE_CAP__(' +
                        JSON.stringify(hostSecret) + ',' +
                        JSON.stringify(instanceNonce) + ',' +
                        JSON.stringify(trustedLocForCleanup) + ',' +
                        JSON.stringify(capToken) + ');'
                    );
                  }
                  if (msg === 'ERR_RENDERER_EXEC_TIMEOUT') {
                    await execInRenderer(
                      'typeof window.__ADDON_HOST_DISPOSE__ === "function" && window.__ADDON_HOST_DISPOSE__(' +
                        JSON.stringify(hostSecret) + ',' +
                        JSON.stringify(instanceNonce) + ',' +
                        JSON.stringify(trustedLocForCleanup) + ',' +
                        JSON.stringify(addon.pluginId) + ');'
                    );
                  }
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
  collectRendererErrors,
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
