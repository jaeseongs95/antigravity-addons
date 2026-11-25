'use strict';

/**
 * Shared v2.0.0 runtime constants (zero external dependencies).
 * NOTE: preload-bridge.js is built as a single self-contained file by scripts/build-runtime.js
 * and inlines these IPC names so it has ZERO relative requires under `sandbox: true`.
 */

const ISOLATED_WORLD_ID = 998;
const MAIN_INIT_SYMBOL = Symbol.for('antigravity.addonHost.v2.mainInitialized');
const PRELOAD_SCRIPT_ID = 'antigravity-addon-host-v2-preload';
const BOOTSTRAP_GLOBAL_NAME = '__addonHostBootstrap';
const BOOKMARKLET_MAX_RUNNABLE_CHARS = 65536;

const IPC_CHANNELS = Object.freeze({
  VERIFY_FRAME: 'addon-host:v2:verify-frame',
  CLAIM_NONCE: 'addon-host:v2:claim-nonce',
  PORTAL_CLAIM: 'addon-host:v2:portal-claim',
  SAVE_SETTINGS: 'addon-host:v2:save-settings',
  CONFIG_READ: 'addon-host:v2:config-read',
  CONFIG_WRITE: 'addon-host:v2:config-write',
  HOST_ADMIN_STATE: 'addon-host:v2:host-admin-state',
  HOST_ADMIN_SET_REMOTE_PREF: 'addon-host:v2:host-admin-set-remote-pref',
  REPORT_ERROR: 'addon-host:v2:report-error',
  PING: 'addon-host:v2:ping',
});

const LIFECYCLE_STATES = Object.freeze({
  PENDING: 'PENDING',
  ACTIVATING: 'ACTIVATING',
  ACTIVE: 'ACTIVE',
  FAILED: 'FAILED',
  DISPOSING: 'DISPOSING',
  DISPOSED: 'DISPOSED',
});

module.exports = {
  ISOLATED_WORLD_ID,
  MAIN_INIT_SYMBOL,
  PRELOAD_SCRIPT_ID,
  BOOTSTRAP_GLOBAL_NAME,
  BOOKMARKLET_MAX_RUNNABLE_CHARS,
  IPC_CHANNELS,
  LIFECYCLE_STATES,
};
