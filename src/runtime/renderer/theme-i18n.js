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
const _Set = Set;
const _SetAdd = Function.prototype.call.bind(Set.prototype.add);
const _SetDelete = Function.prototype.call.bind(Set.prototype.delete);
const _SetClear = Function.prototype.call.bind(Set.prototype.clear);
const _SetForEach = Function.prototype.call.bind(Set.prototype.forEach);

const DARK_TOKENS = _ObjectFreeze({
  '--ag-bg': '#0f131a',
  '--ag-surface': '#161b24',
  '--ag-surface-elevated': '#1e2532',
  '--ag-border': 'rgba(255, 255, 255, 0.14)',
  '--ag-text': '#f0f6fc',
  '--ag-text-muted': '#8b949e',
  '--ag-accent': '#38bdf8',
  '--ag-accent-fg': '#082f49',
  '--ag-danger': '#f87171',
  '--ag-success': '#4ade80',
  '--ag-warning': '#fbbf24',
  '--ag-radius': '10px',
  '--ag-shadow': '0 12px 32px rgba(0, 0, 0, 0.52)',
  '--ag-font': 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", sans-serif',
});

const LIGHT_TOKENS = Object.freeze({
  '--ag-bg': '#ffffff',
  '--ag-surface': '#f8fafc',
  '--ag-surface-elevated': '#ffffff',
  '--ag-border': 'rgba(15, 23, 42, 0.14)',
  '--ag-text': '#0f172a',
  '--ag-text-muted': '#475569',
  '--ag-accent': '#0284c7',
  '--ag-accent-fg': '#ffffff',
  '--ag-danger': '#dc2626',
  '--ag-success': '#16a34a',
  '--ag-warning': '#d97706',
  '--ag-radius': '10px',
  '--ag-shadow': '0 12px 32px rgba(15, 23, 42, 0.16)',
  '--ag-font': 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", sans-serif',
});

function buildTokenCss(mode) {
  const tokens = mode === 'light' ? LIGHT_TOKENS : DARK_TOKENS;
  const keys = _ObjectKeys(tokens);
  const lines = [];
  for (let i = 0; i < keys.length; i += 1) {
    lines[lines.length] = `  ${keys[i]}: ${tokens[keys[i]]};`;
  }
  return `:host {\n${lines.join('\n')}\n}`;
}

function createThemeAndI18n(doc, win) {
  const listeners = new _Set();

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

  function createI18nHandle() {
    return _ObjectFreeze({
      getLocale,
      t: translate,
    });
  }

  function dispose() {
    _SetClear(listeners);
    try {
      if (mediaQuery && typeof mediaQuery.removeEventListener === 'function') {
        mediaQuery.removeEventListener('change', handleMediaChange);
      }
    } catch (_e) {}
  }

  return _ObjectFreeze({
    getSnapshot,
    buildTokenCss,
    getLocale,
    t: translate,
    createThemeHandle,
    createI18nHandle,
    dispose,
  });
}

module.exports = {
  DARK_TOKENS,
  LIGHT_TOKENS,
  buildTokenCss,
  createThemeAndI18n,
};
