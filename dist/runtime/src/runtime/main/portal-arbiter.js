'use strict';

/**
 * Dual-Source Portal Arbiter (T-C, D-R4-4).
 *
 * - Isolated behind `HostProfile.portalBridge` (`{ channel, allowDegradedLocal }`).
 * - Keyed strictly by `webContents.id` (NEVER calls `BrowserWindow.fromWebContents` which
 *   varies/returns null for `BaseWindow + WebContentsView`).
 * - Non-destructively wraps `ipcMain.handle` / `ipcMain.removeHandler` BEFORE `app.whenReady()`.
 * - Combines `effective = Boolean(nativeOpen || pluginClaims.size > 0)`.
 * - Auto-revokes plugin claims on navigation/crash/destroy/dispose while guarding
 *   `!contents.isDestroyed() && Boolean(contents.mainFrame)` inside `try/catch`.
 * - If pre-registered or unsupported, NEVER calls destructive `removeHandler`; degrades
 *   cleanly to `PORTAL_ARBITER_DEGRADED_LOCAL`.
 */

function createPortalArbiter({ ipcMain, portalBridge = null, recordDiag = () => {} } = {}) {
  const channel = portalBridge && typeof portalBridge.channel === 'string' ? portalBridge.channel.trim() : '';
  const stateByWcId = new Map();

  let mode = channel ? 'ARMED' : 'DISABLED';
  let capturedNativeHandler = null;
  let wrappedInstalled = false;
  let origHandle = null;
  let origRemoveHandler = null;

  function getOrCreate(wcId, contents = null) {
    let entry = stateByWcId.get(wcId);
    if (!entry) {
      entry = { nativeOpen: false, pluginClaims: new Set(), contents: contents || null };
      stateByWcId.set(wcId, entry);
    } else if (contents) {
      entry.contents = contents;
    }
    return entry;
  }

  function invokeNativeSafely(wc, effective) {
    if (!capturedNativeHandler || !wc) return false;
    try {
      if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return false;
      if (!wc.mainFrame) return false;
      const ret = capturedNativeHandler({ sender: wc, senderFrame: wc.mainFrame }, Boolean(effective));
      if (ret && typeof ret.catch === 'function') {
        ret.catch((err) => {
          recordDiag('warn', 'PORTAL_ARBITER_NATIVE_ASYNC_ERR', err && err.message ? err.message : String(err));
        });
      }
      return true;
    } catch (err) {
      recordDiag('warn', 'PORTAL_ARBITER_NATIVE_FORWARD_ERR', err && err.message ? err.message : String(err));
      return false;
    }
  }

  function install() {
    if (!channel) {
      mode = 'DISABLED';
      return { ok: true, mode };
    }
    if (wrappedInstalled) {
      return { ok: true, mode };
    }
    if (!ipcMain || typeof ipcMain.handle !== 'function') {
      mode = 'PORTAL_ARBITER_DEGRADED_LOCAL';
      recordDiag('warn', 'PORTAL_ARBITER_DEGRADED_LOCAL', 'ipcMain.handle unavailable');
      return { ok: true, mode };
    }

    origHandle = ipcMain.handle.bind(ipcMain);
    origRemoveHandler = typeof ipcMain.removeHandler === 'function' ? ipcMain.removeHandler.bind(ipcMain) : null;

    ipcMain.handle = function wrappedPortalHandle(ch, listener) {
      if (ch !== channel) {
        return origHandle(ch, listener);
      }
      const nativeFn = listener;
      capturedNativeHandler = nativeFn;
      mode = 'ACTIVE_ARBITER';
      try {
        return origHandle(ch, (ev, open) => {
          const sender = ev && ev.sender;
          const wcId = sender && typeof sender.id === 'number' ? sender.id : 0;
          const entry = getOrCreate(wcId, sender);
          entry.nativeOpen = Boolean(open);
          const effective = Boolean(entry.nativeOpen || entry.pluginClaims.size > 0);
          return nativeFn(ev, effective);
        });
      } catch (err) {
        // Channel was already registered before initMain (never call destructive removeHandler!)
        capturedNativeHandler = null;
        mode = 'PORTAL_ARBITER_DEGRADED_LOCAL';
        recordDiag('warn', 'PORTAL_ARBITER_DEGRADED_LOCAL', err && err.message ? err.message : String(err));
        throw err;
      }
    };

    if (origRemoveHandler) {
      ipcMain.removeHandler = function wrappedPortalRemoveHandler(ch) {
        if (ch === channel) {
          capturedNativeHandler = null;
          mode = 'PORTAL_ARBITER_DEGRADED_LOCAL';
        }
        return origRemoveHandler(ch);
      };
    }

    wrappedInstalled = true;
    return { ok: true, mode };
  }

  function setPluginClaim(contents, claimId, active) {
    if (!contents || typeof contents.id !== 'number') {
      return { ok: false, mode, effective: false };
    }
    const id = String(claimId || 'default');
    const entry = getOrCreate(contents.id, contents);
    if (active) {
      entry.pluginClaims.add(id);
    } else {
      entry.pluginClaims.delete(id);
    }
    const effective = Boolean(entry.nativeOpen || entry.pluginClaims.size > 0);
    if (mode === 'ACTIVE_ARBITER' && capturedNativeHandler) {
      invokeNativeSafely(contents, effective);
    } else if (channel && mode === 'ARMED') {
      // Host never registered the channel on ipcMain (e.g., migrated to contents.ipc) -> degrade non-destructively
      mode = 'PORTAL_ARBITER_DEGRADED_LOCAL';
      recordDiag('warn', 'PORTAL_ARBITER_DEGRADED_LOCAL', `No ipcMain handler captured for ${channel}`);
    }
    return { ok: true, mode, effective, claimCount: entry.pluginClaims.size };
  }

  function revokeAllPluginClaims(contentsOrWcId, { resetNative = false } = {}) {
    const wcId = typeof contentsOrWcId === 'number' ? contentsOrWcId : contentsOrWcId && contentsOrWcId.id;
    if (typeof wcId !== 'number') return { ok: false, effective: false };
    const entry = stateByWcId.get(wcId);
    if (!entry) return { ok: true, mode, effective: false };
    const hadOpen = entry.pluginClaims.size > 0 || (resetNative && entry.nativeOpen);
    entry.pluginClaims.clear();
    if (resetNative) entry.nativeOpen = false;
    const effective = Boolean(entry.nativeOpen);
    const wc = typeof contentsOrWcId === 'object' ? contentsOrWcId : entry.contents;
    if (hadOpen && mode === 'ACTIVE_ARBITER' && capturedNativeHandler && wc) {
      invokeNativeSafely(wc, effective);
    }
    return { ok: true, mode, effective };
  }

  function attachWebContentsLifecycle(contents) {
    if (!contents || typeof contents.on !== 'function') return;
    const wcId = contents.id;
    // R-1: Revoke on committed main-frame navigation (NOT pre-commit did-start-navigation)
    contents.on('did-navigate', () => {
      revokeAllPluginClaims(contents, { resetNative: true });
    });
    contents.on('render-process-gone', () => {
      revokeAllPluginClaims(contents, { resetNative: true });
    });
    contents.once('destroyed', () => {
      revokeAllPluginClaims(wcId, { resetNative: true });
      stateByWcId.delete(wcId);
    });
  }

  function getStatus() {
    return {
      mode,
      channel: channel || null,
      activeWindows: stateByWcId.size,
      hasNativeHandler: Boolean(capturedNativeHandler),
    };
  }

  function dispose() {
    for (const wcId of Array.from(stateByWcId.keys())) {
      revokeAllPluginClaims(wcId);
    }
    stateByWcId.clear();
  }

  return Object.freeze({
    install,
    setPluginClaim,
    revokeAllPluginClaims,
    attachWebContentsLifecycle,
    getStatus,
    dispose,
  });
}

module.exports = {
  createPortalArbiter,
};
