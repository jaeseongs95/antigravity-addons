'use strict';

/**
 * Self-contained Electron sandboxed Preload Bridge (T-A Option A1, D-R4-2).
 *
 * STRICT INVARIANTS (enforced by scripts/build-runtime.js acorn AST gate):
 * - ZERO relative requires (`./`, `../`) and ZERO Node.js built-in imports.
 * - ONLY `require('electron')` (`contextBridge`, `ipcRenderer`) is allowed so
 *   this script works cleanly under Electron 20+ default `sandbox: true`.
 * - Top guard: `if (!process.isMainFrame || !process.contextIsolated) return;`
 * - Exposes ONLY a single-claim `claim(nonce)` bootstrap in isolated World 998.
 * - ZERO globals exposed on Page World 0.
 */

const { contextBridge, ipcRenderer } = require('electron');

if (!process.isMainFrame || !process.contextIsolated) {
  return;
}

const ISOLATED_WORLD_ID = 998;
const BOOTSTRAP_GLOBAL_NAME = '__addonHostBootstrap';
const IPC_VERIFY_FRAME = 'addon-host:v2:verify-frame';
const IPC_CLAIM_NONCE = 'addon-host:v2:claim-nonce';
const IPC_PORTAL_CLAIM = 'addon-host:v2:portal-claim';
const IPC_SAVE_SETTINGS = 'addon-host:v2:save-settings';
const IPC_CONFIG_READ = 'addon-host:v2:config-read';
const IPC_CONFIG_WRITE = 'addon-host:v2:config-write';
const IPC_HOST_ADMIN_STATE = 'addon-host:v2:host-admin-state';
const IPC_HOST_ADMIN_SET_REMOTE_PREF = 'addon-host:v2:host-admin-set-remote-pref';
const IPC_HOST_ADMIN_CONFIGURE_REMOTE_BRIDGE = 'addon-host:v3:host-admin-configure-remote-bridge';
const IPC_HOST_ADMIN_ROTATE_REMOTE_TOKEN = 'addon-host:v3:host-admin-rotate-remote-token';
const IPC_HOST_ADMIN_REBUILD_REMOTE_BUNDLE = 'addon-host:v3:host-admin-rebuild-remote-bundle';
const IPC_NET_FETCH = 'addon-host:v3:net-fetch';
const IPC_SECRETS_SET = 'addon-host:v3:secrets-set';
const IPC_SECRETS_GET = 'addon-host:v3:secrets-get';
const IPC_SECRETS_HAS = 'addon-host:v3:secrets-has';
const IPC_SECRETS_DELETE = 'addon-host:v3:secrets-delete';
const IPC_SECRETS_LIST = 'addon-host:v3:secrets-list';
const IPC_REPORT_ERROR = 'addon-host:v2:report-error';
const IPC_PING = 'addon-host:v2:ping';

let frameDecision = null;
try {
  // Never pass renderer-supplied origin; Main inspects ev.sender & ev.senderFrame directly.
  frameDecision = ipcRenderer.sendSync(IPC_VERIFY_FRAME);
} catch (_err) {
  return;
}

if (!frameDecision || frameDecision.ok !== true) {
  return;
}

const targetWorldId =
  Number.isInteger(frameDecision.worldId) && frameDecision.worldId > 0 && frameDecision.worldId !== 999
    ? frameDecision.worldId
    : ISOLATED_WORLD_ID;

let claimed = false;

try {
  contextBridge.exposeInIsolatedWorld(targetWorldId, BOOTSTRAP_GLOBAL_NAME, {
    claim(nonce) {
      if (claimed) {
        throw new Error('ERR_BRIDGE_ALREADY_CLAIMED');
      }
      if (typeof nonce !== 'string' || nonce.length < 16) {
        throw new Error('ERR_INVALID_CLAIM_NONCE');
      }
      const res = ipcRenderer.sendSync(IPC_CLAIM_NONCE, nonce);
      if (!res || res.ok !== true) {
        throw new Error(res && res.reason ? String(res.reason) : 'ERR_CLAIM_NONCE_REJECTED');
      }
      claimed = true;
      const docGenId = Number(res.docGenId) || 0;
      return Object.freeze({
        docGenId,
        setPortalClaim(claimId, active) {
          return ipcRenderer.invoke(IPC_PORTAL_CLAIM, {
            docGenId,
            claimId: String(claimId || ''),
            active: Boolean(active),
          });
        },
        saveSettings(pluginId, rawJson) {
          return ipcRenderer.invoke(IPC_SAVE_SETTINGS, {
            docGenId,
            pluginId: String(pluginId || ''),
            rawJson: typeof rawJson === 'string' ? rawJson : '',
          });
        },
        readConfigScope(pluginId, scopeId) {
          return ipcRenderer.invoke(IPC_CONFIG_READ, {
            docGenId,
            pluginId: String(pluginId || ''),
            scopeId: String(scopeId || ''),
          });
        },
        writeConfigScope(pluginId, scopeId, rawJson, opts) {
          const hasExpected =
            opts && typeof opts === 'object' && Object.prototype.hasOwnProperty.call(opts, 'expectedSha256');
          const payload = {
            docGenId,
            pluginId: String(pluginId || ''),
            scopeId: String(scopeId || ''),
            rawJson: typeof rawJson === 'string' ? rawJson : '',
          };
          if (hasExpected) {
            payload.expectedSha256 = opts.expectedSha256;
          }
          return ipcRenderer.invoke(IPC_CONFIG_WRITE, payload);
        },
        getHostAdminState() {
          return ipcRenderer.invoke(IPC_HOST_ADMIN_STATE, { docGenId });
        },
        setRemoteAddonPreference(pluginId, enabled) {
          return ipcRenderer.invoke(IPC_HOST_ADMIN_SET_REMOTE_PREF, {
            docGenId,
            pluginId: String(pluginId || ''),
            enabled: Boolean(enabled),
          });
        },
        configureRemoteBridge(patch) {
          const safePatch = patch && typeof patch === 'object' ? patch : {};
          return ipcRenderer.invoke(IPC_HOST_ADMIN_CONFIGURE_REMOTE_BRIDGE, {
            docGenId,
            patch: safePatch,
          });
        },
        rotateRemoteBridgeToken() {
          return ipcRenderer.invoke(IPC_HOST_ADMIN_ROTATE_REMOTE_TOKEN, { docGenId });
        },
        rebuildRemoteBundle() {
          return ipcRenderer.invoke(IPC_HOST_ADMIN_REBUILD_REMOTE_BUNDLE, { docGenId });
        },
        netFetch(pluginId, url, init) {
          const safeInit = init && typeof init === 'object' ? init : {};
          const payload = {
            docGenId,
            pluginId: String(pluginId || ''),
            url: String(url || ''),
            method: typeof safeInit.method === 'string' ? safeInit.method : 'GET',
            headers: safeInit.headers && typeof safeInit.headers === 'object' ? safeInit.headers : {},
            body: typeof safeInit.body === 'string' ? safeInit.body : null,
            timeoutMs: Number.isFinite(Number(safeInit.timeoutMs)) ? Number(safeInit.timeoutMs) : undefined,
          };
          if (safeInit.secretHeaders && typeof safeInit.secretHeaders === 'object' && !Array.isArray(safeInit.secretHeaders)) {
            payload.secretHeaders = safeInit.secretHeaders;
          }
          return ipcRenderer.invoke(IPC_NET_FETCH, payload);
        },
        secretsSet(pluginId, key, value) {
          return ipcRenderer.invoke(IPC_SECRETS_SET, {
            docGenId,
            pluginId: String(pluginId || ''),
            key: String(key || ''),
            value: typeof value === 'string' ? value : '',
          });
        },
        secretsGet(pluginId, key) {
          return ipcRenderer.invoke(IPC_SECRETS_GET, {
            docGenId,
            pluginId: String(pluginId || ''),
            key: String(key || ''),
          });
        },
        secretsHas(pluginId, key) {
          return ipcRenderer.invoke(IPC_SECRETS_HAS, {
            docGenId,
            pluginId: String(pluginId || ''),
            key: String(key || ''),
          });
        },
        secretsDelete(pluginId, key) {
          return ipcRenderer.invoke(IPC_SECRETS_DELETE, {
            docGenId,
            pluginId: String(pluginId || ''),
            key: String(key || ''),
          });
        },
        secretsList(pluginId) {
          return ipcRenderer.invoke(IPC_SECRETS_LIST, {
            docGenId,
            pluginId: String(pluginId || ''),
          });
        },
        reportError(pluginId, detail) {
          try {
            ipcRenderer.send(IPC_REPORT_ERROR, {
              docGenId,
              pluginId: String(pluginId || ''),
              detail: String(detail || ''),
            });
          } catch (_e) {}
        },
        ping() {
          return ipcRenderer.invoke(IPC_PING, { docGenId });
        },
      });
    },
  });
} catch (_exposeErr) {
  // Fail-open: never crash host renderer preload if isolated world exposure fails.
}
