'use strict';

/**
 * Internal Electron Production Boot Strategy: AsarPatchTransport (Option B-Clean, D-R4-1).
 *
 * The ONLY production boot transport for packaged Electron applications
 * (`Antigravity.exe` / `Antigravity.app`), because Electron's `NodeBindings::Initialize`
 * blocks `NODE_OPTIONS=--require` in packaged apps.
 * Kept internal to `src/adapters/electron/` (NOT exposed in `src/core/`).
 */

const {
  isAsarHostInstalled,
  installAsarAddonHost,
  upgradeAsarAddonHost,
  rollbackAsarAddonHost,
  diagnoseAsarState,
} = require('./asar-patcher');

function createAsarPatchTransport() {
  return Object.freeze({
    id: 'asar-patch',
    isInstalled(paths, profile) {
      return isAsarHostInstalled(paths.ASAR_PATH, profile);
    },
    diagnose(paths, profile) {
      return diagnoseAsarState(paths, profile);
    },
    install(paths, profile, { replaceLegacy = false, refreshOrig = false } = {}) {
      return installAsarAddonHost(
        {
          ...paths,
          ALLOW_REPLACE_LEGACY: Boolean(replaceLegacy),
          ALLOW_REFRESH_ORIG: Boolean(refreshOrig),
        },
        profile
      );
    },
    upgrade(paths, profile, { replaceLegacy = false, refreshOrig = false } = {}) {
      return upgradeAsarAddonHost(
        {
          ...paths,
          ALLOW_REPLACE_LEGACY: Boolean(replaceLegacy),
          ALLOW_REFRESH_ORIG: Boolean(refreshOrig),
        },
        profile
      );
    },
    rollback(paths, profile, { force = false } = {}) {
      return rollbackAsarAddonHost(paths, profile, { force: Boolean(force) });
    },
  });
}

module.exports = {
  createAsarPatchTransport,
};
