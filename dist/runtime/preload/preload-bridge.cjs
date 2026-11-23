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
