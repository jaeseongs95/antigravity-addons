'use strict';

/**
 * Vendor-neutral Theme & i18n Provider for AddonContextV3 (v3.0.0 — SOLID #0).
 *
 * - Provides semantic `--ag-*` CSS custom properties synced to dark/light mode.
 * - Detects active locale from `document.documentElement.lang` / `navigator.language`.
 * - Zero vendor literals, zero Node built-ins.
 */

const _ObjectFreeze = Object.freeze;
const _ObjectKeys = Object.keys;
const _Number = Number;
const _NumberIsFinite = Number.isFinite;
const _String = String;
const _StringTrim = Function.prototype.call.bind(String.prototype.trim);
const _RegExpExec = Function.prototype.call.bind(RegExp.prototype.exec);
const _Set = Set;
const _SetAdd = Function.prototype.call.bind(Set.prototype.add);
const _SetDelete = Function.prototype.call.bind(Set.prototype.delete);
const _SetClear = Function.prototype.call.bind(Set.prototype.clear);
const _SetForEach = Function.prototype.call.bind(Set.prototype.forEach);

const _RGB_COLOR_RE = /^rgba?\(\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)(?:\s*[,/]\s*([0-9.]+))?\s*\)$/i;
const HOST_LOCALE_STORAGE_KEY = 'addon-host:settings-ui-lang';
const _SAFE_LOCALE_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;

function normalizeHostLocale(value) {
  if (typeof value !== 'string') return null;
  const trimmed = _StringTrim(value);
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower === 'ko' || lower.startsWith('ko-')) return 'ko';
  if (lower === 'en' || lower.startsWith('en-')) return 'en';
  if (_SAFE_LOCALE_RE.test(trimmed)) return trimmed;
  return null;
}

function readStoredHostLocale(win) {
  try {
    const storage = win && win.localStorage;
    if (storage && typeof storage.getItem === 'function') {
      return normalizeHostLocale(storage.getItem(HOST_LOCALE_STORAGE_KEY));
    }
  } catch (_e) {}
  return null;
}

function writeStoredHostLocale(win, locale) {
  try {
    const storage = win && win.localStorage;
    if (storage && typeof storage.setItem === 'function') {
      storage.setItem(HOST_LOCALE_STORAGE_KEY, locale);
      return true;
    }
  } catch (_e) {}
  return false;
}

function parseOpaqueRgb(colorStr) {
  if (typeof colorStr !== 'string') return null;
  const trimmed = _StringTrim(colorStr);
  if (!trimmed || trimmed === 'transparent') return null;
  const match = _RegExpExec(_RGB_COLOR_RE, trimmed);
  if (!match) return null;
  const r = _Number(match[1]);
  const g = _Number(match[2]);
  const b = _Number(match[3]);
  const a = match[4] !== undefined ? _Number(match[4]) : 1;
  if (!_NumberIsFinite(r) || !_NumberIsFinite(g) || !_NumberIsFinite(b) || !_NumberIsFinite(a)) return null;
  if (a <= 0.05) return null;
  return { r, g, b };
}

function detectModeFromComputedBackground(doc, win) {
  if (!doc || !win || typeof win.getComputedStyle !== 'function') return null;
  const candidates = [doc.body, doc.documentElement];
  for (let i = 0; i < candidates.length; i += 1) {
    const el = candidates[i];
    if (!el) continue;
    try {
      const style = win.getComputedStyle(el);
      const rgb = parseOpaqueRgb(style && style.backgroundColor);
      if (rgb) {
        const luminance = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
        return luminance < 128 ? 'dark' : 'light';
      }
    } catch (_e) {}
  }
  return null;
}

const DARK_TOKENS = _ObjectFreeze({
  '--ag-bg': '#0d1117',
  '--ag-surface': '#161b24',
  '--ag-surface-elevated': 'rgba(255, 255, 255, 0.04)',
  '--ag-surface-hover': 'rgba(255, 255, 255, 0.08)',
  '--ag-input-bg': 'rgba(9, 12, 18, 0.78)',
  '--ag-border': 'rgba(255, 255, 255, 0.09)',
  '--ag-border-strong': 'rgba(255, 255, 255, 0.16)',
  '--ag-text': '#f1f5f9',
  '--ag-text-muted': '#94a3b8',
  '--ag-accent': '#38bdf8',
  '--ag-accent-fg': '#082f49',
  '--ag-primary': '#2563eb',
  '--ag-primary-hover': '#3b82f6',
  '--ag-primary-fg': '#ffffff',
  '--ag-focus-ring': 'rgba(59, 130, 246, 0.32)',
  '--ag-scrollbar-thumb': 'rgba(148, 163, 184, 0.28)',
  '--ag-scrollbar-thumb-hover': 'rgba(148, 163, 184, 0.46)',
  '--ag-danger': '#ef4444',
  '--ag-success': '#4ade80',
  '--ag-warning': '#fbbf24',
  '--ag-radius': '12px',
  '--ag-shadow': '0 20px 48px rgba(0, 0, 0, 0.56), 0 0 0 1px rgba(255, 255, 255, 0.06)',
  '--ag-font': 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", sans-serif',
});

const LIGHT_TOKENS = Object.freeze({
  '--ag-bg': '#ffffff',
  '--ag-surface': '#f8fafc',
  '--ag-surface-elevated': '#ffffff',
  '--ag-surface-hover': 'rgba(15, 23, 42, 0.05)',
  '--ag-input-bg': '#ffffff',
  '--ag-border': 'rgba(15, 23, 42, 0.11)',
  '--ag-border-strong': 'rgba(15, 23, 42, 0.2)',
  '--ag-text': '#0f172a',
  '--ag-text-muted': '#475569',
  '--ag-accent': '#0284c7',
  '--ag-accent-fg': '#ffffff',
  '--ag-primary': '#2563eb',
  '--ag-primary-hover': '#1d4ed8',
  '--ag-primary-fg': '#ffffff',
  '--ag-focus-ring': 'rgba(37, 99, 235, 0.24)',
  '--ag-scrollbar-thumb': 'rgba(100, 116, 139, 0.3)',
  '--ag-scrollbar-thumb-hover': 'rgba(100, 116, 139, 0.5)',
  '--ag-danger': '#dc2626',
  '--ag-success': '#16a34a',
  '--ag-warning': '#d97706',
  '--ag-radius': '12px',
  '--ag-shadow': '0 16px 40px rgba(15, 23, 42, 0.16), 0 0 0 1px rgba(15, 23, 42, 0.06)',
  '--ag-font': 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", sans-serif',
});

function buildTokenCss(mode) {
  const isLight = mode === 'light';
  const tokens = isLight ? LIGHT_TOKENS : DARK_TOKENS;
  const keys = _ObjectKeys(tokens);
  const lines = [`  color-scheme: ${isLight ? 'light' : 'dark'};`];
  for (let i = 0; i < keys.length; i += 1) {
    lines[lines.length] = `  ${keys[i]}: ${tokens[keys[i]]};`;
  }
  return `:host {\n${lines.join('\n')}\n}`;
}

function createThemeAndI18n(doc, win) {
  const listeners = new _Set();
  const localeListeners = new _Set();
  let overrideLocale = readStoredHostLocale(win);

  function detectMode() {
    try {
      const docEl = doc && doc.documentElement;
      const explicit =
        docEl && typeof docEl.getAttribute === 'function'
          ? String(docEl.getAttribute('data-theme') || docEl.getAttribute('data-color-scheme') || '').toLowerCase()
          : '';
      if (explicit === 'light' || explicit === 'dark') return explicit;
      if (docEl && docEl.className && typeof docEl.className === 'string') {
        if (/\blight\b/i.test(docEl.className) && !/\bdark\b/i.test(docEl.className)) return 'light';
        if (/\bdark\b/i.test(docEl.className)) return 'dark';
      }
      const bgMode = detectModeFromComputedBackground(doc, win);
      if (bgMode) return bgMode;
      if (win && typeof win.matchMedia === 'function') {
        const mq = win.matchMedia('(prefers-color-scheme: light)');
        if (mq && mq.matches) return 'light';
      }
    } catch (_e) {}
    return 'dark';
  }

  let currentMode = detectMode();
  let mediaQuery = null;
  const handleMediaChange = () => {
    const next = detectMode();
    if (next === currentMode) return;
    currentMode = next;
    const snap = getSnapshot();
    _SetForEach(listeners, (cb) => {
      try {
        cb(snap);
      } catch (_e) {}
    });
  };

  try {
    if (win && typeof win.matchMedia === 'function') {
      mediaQuery = win.matchMedia('(prefers-color-scheme: light)');
      if (mediaQuery && typeof mediaQuery.addEventListener === 'function') {
        mediaQuery.addEventListener('change', handleMediaChange);
      }
    }
  } catch (_e) {}

  function getSnapshot() {
    const mode = detectMode();
    currentMode = mode;
    return _ObjectFreeze({
      mode,
      tokens: mode === 'light' ? LIGHT_TOKENS : DARK_TOKENS,
    });
  }

  function getLocale() {
    if (overrideLocale) return overrideLocale;
    try {
      const docLang =
        doc && doc.documentElement && typeof doc.documentElement.lang === 'string'
          ? doc.documentElement.lang.trim()
          : '';
      if (docLang) return docLang;
      const navLang =
        win && win.navigator && typeof win.navigator.language === 'string'
          ? win.navigator.language.trim()
          : '';
      if (navLang) return navLang;
    } catch (_e) {}
    return 'en';
  }

  function notifyLocaleChange(nextLocale) {
    _SetForEach(localeListeners, (cb) => {
      try {
        cb(nextLocale);
      } catch (_e) {}
    });
  }

  function setLocale(nextLocale, { persist = true } = {}) {
    const normalized = normalizeHostLocale(nextLocale);
    if (!normalized) return getLocale();
    const prev = getLocale();
    overrideLocale = normalized;
    if (persist !== false) {
      writeStoredHostLocale(win, normalized);
    }
    if (normalized !== prev) {
      notifyLocaleChange(normalized);
    }
    return normalized;
  }

  function onLocaleDidChange(cb, registerDisposer) {
    if (typeof cb !== 'function') throw new Error('ERR_INVALID_I18N_LISTENER');
    _SetAdd(localeListeners, cb);
    const unsub = () => _SetDelete(localeListeners, cb);
    if (typeof registerDisposer === 'function') registerDisposer(unsub);
    return unsub;
  }

  const handleStorageLocaleSync = (ev) => {
    if (!ev || ev.key !== HOST_LOCALE_STORAGE_KEY) return;
    const prev = getLocale();
    overrideLocale = normalizeHostLocale(ev.newValue);
    const next = getLocale();
    if (next !== prev) {
      notifyLocaleChange(next);
    }
  };
  try {
    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('storage', handleStorageLocaleSync);
    }
  } catch (_e) {}

  function translate(key, dictOrParams = null, params = null) {
    const locale = getLocale().toLowerCase();
    const shortLocale = locale.split('-')[0];
    let template = String(key || '');
    let vars = params;
    if (dictOrParams && typeof dictOrParams === 'object' && !Array.isArray(dictOrParams)) {
      if (typeof dictOrParams[locale] === 'string') {
        template = dictOrParams[locale];
      } else if (typeof dictOrParams[shortLocale] === 'string') {
        template = dictOrParams[shortLocale];
      } else if (typeof dictOrParams.en === 'string') {
        template = dictOrParams.en;
      } else {
        vars = dictOrParams;
      }
    }
    if (vars && typeof vars === 'object') {
      template = template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, k) => {
        if (Object.prototype.hasOwnProperty.call(vars, k) && vars[k] !== undefined && vars[k] !== null) {
          return String(vars[k]);
        }
        return '';
      });
    }
    return template;
  }

  function createThemeHandle(registerDisposer) {
    return _ObjectFreeze({
      getMode: () => getSnapshot().mode,
      getTokens: () => getSnapshot().tokens,
      getTokenCss: () => buildTokenCss(getSnapshot().mode),
      onDidChange(cb) {
        if (typeof cb !== 'function') throw new Error('ERR_INVALID_THEME_LISTENER');
        _SetAdd(listeners, cb);
        const unsub = () => _SetDelete(listeners, cb);
        if (typeof registerDisposer === 'function') registerDisposer(unsub);
        return unsub;
      },
    });
  }

  function createI18nHandle(registerDisposer) {
    return _ObjectFreeze({
      getLocale,
      t: translate,
      onDidChange(cb) {
        return onLocaleDidChange(cb, registerDisposer);
      },
    });
  }

  function dispose() {
    _SetClear(listeners);
    _SetClear(localeListeners);
    try {
      if (mediaQuery && typeof mediaQuery.removeEventListener === 'function') {
        mediaQuery.removeEventListener('change', handleMediaChange);
      }
    } catch (_e) {}
    try {
      if (win && typeof win.removeEventListener === 'function') {
        win.removeEventListener('storage', handleStorageLocaleSync);
      }
    } catch (_e) {}
  }

  return _ObjectFreeze({
    getSnapshot,
    buildTokenCss,
    getLocale,
    setLocale,
    onLocaleDidChange,
    t: translate,
    createThemeHandle,
    createI18nHandle,
    dispose,
  });
}

module.exports = {
  HOST_LOCALE_STORAGE_KEY,
  DARK_TOKENS,
  LIGHT_TOKENS,
  normalizeHostLocale,
  buildTokenCss,
  createThemeAndI18n,
};
