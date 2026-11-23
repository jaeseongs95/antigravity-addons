'use strict';

/**
 * Pre-Ready-safe Electron Preload Registrar (D-R4-2).
 *
 * STRICT INVARIANTS:
 * - NEVER accesses `session.defaultSession` before `app.isReady()`.
 * - NEVER registers on `session-created` or arbitrary `contents.session` so
 *   Antigravity's hardened sessions (isScriptJail, SSH removeSessionPreloads,
 *   captureWindow, persist:hub-browser-*) are NEVER contaminated.
 * - Registers the self-contained preload bridge idempotently ONCE on
 *   `session.defaultSession` after `app.whenReady()`.
 */

const fs = require('node:fs');
const path = require('node:path');
const { PRELOAD_SCRIPT_ID } = require('../shared/constants');

function createPreloadRegistrar({ app, sessionModule, preloadPath, preloadId = PRELOAD_SCRIPT_ID, recordDiag = () => {} }) {
  let registeredId = null;
  let scheduled = false;

  function registerNow() {
    if (!preloadPath || !path.isAbsolute(preloadPath) || !fs.existsSync(preloadPath)) {
      recordDiag('error', 'PRELOAD_SCRIPT_MISSING', preloadPath || '');
      return { ok: false, reason: 'ERR_PRELOAD_SCRIPT_MISSING' };
    }
    if (!app || typeof app.isReady !== 'function' || !app.isReady()) {
      return { ok: false, reason: 'ERR_APP_NOT_READY' };
    }
    const defaultSes = sessionModule && sessionModule.defaultSession;
    if (!defaultSes || typeof defaultSes.registerPreloadScript !== 'function') {
      recordDiag('error', 'PRELOAD_API_UNAVAILABLE', 'session.defaultSession.registerPreloadScript missing');
      return { ok: false, reason: 'ERR_REGISTER_PRELOAD_API_UNAVAILABLE' };
    }

    try {
      const existing = typeof defaultSes.getPreloadScripts === 'function' ? defaultSes.getPreloadScripts() : [];
      const found = Array.isArray(existing)
        ? existing.find((p) => p && (p.id === preloadId || (p.filePath && path.resolve(p.filePath) === path.resolve(preloadPath))))
        : null;
      if (found) {
        registeredId = found.id || preloadId;
        return { ok: true, id: registeredId, alreadyRegistered: true };
      }

      registeredId = defaultSes.registerPreloadScript({
        type: 'frame',
        filePath: preloadPath,
        id: preloadId,
      });
      recordDiag('info', 'PRELOAD_REGISTERED_DEFAULT_SESSION', registeredId);
      return { ok: true, id: registeredId, alreadyRegistered: false };
    } catch (err) {
      recordDiag('error', 'PRELOAD_REGISTER_FAILED', err && err.message ? err.message : String(err));
      return { ok: false, reason: 'ERR_PRELOAD_REGISTER_FAILED', error: err && err.message ? err.message : String(err) };
    }
  }

  function ensureRegistered() {
    if (!app) return Promise.resolve({ ok: false, reason: 'ERR_NO_APP' });
    if (typeof app.isReady === 'function' && app.isReady()) {
      return Promise.resolve(registerNow());
    }
    if (scheduled) {
      return app
        .whenReady()
        .then(() => (registeredId ? { ok: true, id: registeredId, alreadyRegistered: true } : registerNow()));
    }
    scheduled = true;
    // R-4: Register synchronously BEFORE host app.on('ready') listeners create initial windows
    if (typeof app.prependOnceListener === 'function') {
      app.prependOnceListener('ready', () => {
        if (!registeredId) registerNow();
      });
    }
    return app
      .whenReady()
      .then(() => (registeredId ? { ok: true, id: registeredId, alreadyRegistered: true } : registerNow()));
  }

  function unregister() {
    if (!registeredId || !app || !app.isReady()) return false;
    const defaultSes = sessionModule && sessionModule.defaultSession;
    if (!defaultSes || typeof defaultSes.unregisterPreloadScript !== 'function') return false;
    try {
      defaultSes.unregisterPreloadScript(registeredId);
      registeredId = null;
      return true;
    } catch (_err) {
      return false;
    }
  }

  function getStatus() {
    return { registered: Boolean(registeredId), id: registeredId, preloadPath };
  }

  return Object.freeze({
    ensureRegistered,
    registerNow,
    unregister,
    getStatus,
  });
}

module.exports = {
  createPreloadRegistrar,
};
