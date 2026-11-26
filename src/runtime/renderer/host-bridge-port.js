'use strict';

/**
 * Renderer-side HostBridgePort contract (v2.3.0 — DIP / LSP / ISP).
 *
 * Unifies the transport boundary between the shared renderer `kernel.js` and
 * host-specific bridge implementations:
 * - Desktop Electron: `preload-bridge.js` (`window.__addonHostBootstrap.claim(nonce)`)
 * - Remote Web: `src/adapters/remote-web/*` (injected via `kernel.boot({ hostBridge })`
 *   or `window.__addonHostBootstrap.claim(nonce)`)
 *
 * Uses captured primordials to remain immune to shared-world prototype tampering (I4).
 */

const _Error = Error;
const _Number = Number;
const _ObjectFreeze = Object.freeze;
const _ReflectApply = Reflect.apply;

const HOST_BRIDGE_PORT_REQUIRED_METHODS = _ObjectFreeze([
  'setPortalClaim',
  'saveSettings',
  'reportError',
  'ping',
]);

const HOST_BRIDGE_PORT_OPTIONAL_METHODS = _ObjectFreeze([
  'readConfigScope',
  'writeConfigScope',
  'getHostAdminState',
  'setRemoteAddonPreference',
  'configureRemoteBridge',
  'rotateRemoteBridgeToken',
  'rebuildRemoteBundle',
  'getRemoteBridgeStatus',
  'netFetch',
]);

function isValidHostBridgePort(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  for (let i = 0; i < HOST_BRIDGE_PORT_REQUIRED_METHODS.length; i += 1) {
    if (typeof candidate[HOST_BRIDGE_PORT_REQUIRED_METHODS[i]] !== 'function') {
      return false;
    }
  }
  return true;
}

function wrapHostBridgePort(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    throw new _Error('ERR_INVALID_HOST_BRIDGE_PORT');
  }
  for (let i = 0; i < HOST_BRIDGE_PORT_REQUIRED_METHODS.length; i += 1) {
    const name = HOST_BRIDGE_PORT_REQUIRED_METHODS[i];
    if (typeof candidate[name] !== 'function') {
      throw new _Error(`ERR_HOST_BRIDGE_PORT_MISSING_METHOD:${name}`);
    }
  }

  const docGenId = _Number(candidate.docGenId) || 0;
  const profileId = typeof candidate.profileId === 'string' && candidate.profileId ? candidate.profileId : null;
  const fnSetPortalClaim = candidate.setPortalClaim;
  const fnSaveSettings = candidate.saveSettings;
  const fnReportError = candidate.reportError;
  const fnPing = candidate.ping;
  const fnReadConfigScope = typeof candidate.readConfigScope === 'function' ? candidate.readConfigScope : null;
  const fnWriteConfigScope = typeof candidate.writeConfigScope === 'function' ? candidate.writeConfigScope : null;
  const fnGetHostAdminState = typeof candidate.getHostAdminState === 'function' ? candidate.getHostAdminState : null;
  const fnSetRemoteAddonPreference =
    typeof candidate.setRemoteAddonPreference === 'function' ? candidate.setRemoteAddonPreference : null;
  const fnConfigureRemoteBridge =
    typeof candidate.configureRemoteBridge === 'function' ? candidate.configureRemoteBridge : null;
  const fnRotateRemoteBridgeToken =
    typeof candidate.rotateRemoteBridgeToken === 'function' ? candidate.rotateRemoteBridgeToken : null;
  const fnRebuildRemoteBundle =
    typeof candidate.rebuildRemoteBundle === 'function' ? candidate.rebuildRemoteBundle : null;
  const fnGetRemoteBridgeStatus =
    typeof candidate.getRemoteBridgeStatus === 'function' ? candidate.getRemoteBridgeStatus : null;
  const fnNetFetch = typeof candidate.netFetch === 'function' ? candidate.netFetch : null;

  const wrapped = {
    docGenId,
    profileId,
    setPortalClaim(claimId, active) {
      return _ReflectApply(fnSetPortalClaim, candidate, [claimId, active]);
    },
    saveSettings(pluginId, rawJson) {
      return _ReflectApply(fnSaveSettings, candidate, [pluginId, rawJson]);
    },
    reportError(pluginId, detail) {
      return _ReflectApply(fnReportError, candidate, [pluginId, detail]);
    },
    ping() {
      return _ReflectApply(fnPing, candidate, []);
    },
  };

  if (fnReadConfigScope) {
    wrapped.readConfigScope = function readConfigScope(pluginId, scopeId) {
      return _ReflectApply(fnReadConfigScope, candidate, [pluginId, scopeId]);
    };
  }
  if (fnWriteConfigScope) {
    wrapped.writeConfigScope = function writeConfigScope(pluginId, scopeId, rawJson, opts) {
      return _ReflectApply(fnWriteConfigScope, candidate, [pluginId, scopeId, rawJson, opts]);
    };
  }
  if (fnGetHostAdminState) {
    wrapped.getHostAdminState = function getHostAdminState() {
      return _ReflectApply(fnGetHostAdminState, candidate, []);
    };
  }
  if (fnSetRemoteAddonPreference) {
    wrapped.setRemoteAddonPreference = function setRemoteAddonPreference(pluginId, enabled) {
      return _ReflectApply(fnSetRemoteAddonPreference, candidate, [pluginId, enabled]);
    };
  }
  if (fnConfigureRemoteBridge) {
    wrapped.configureRemoteBridge = function configureRemoteBridge(patch) {
      return _ReflectApply(fnConfigureRemoteBridge, candidate, [patch]);
    };
  }
  if (fnRotateRemoteBridgeToken) {
    wrapped.rotateRemoteBridgeToken = function rotateRemoteBridgeToken() {
      return _ReflectApply(fnRotateRemoteBridgeToken, candidate, []);
    };
  }
  if (fnRebuildRemoteBundle) {
    wrapped.rebuildRemoteBundle = function rebuildRemoteBundle() {
      return _ReflectApply(fnRebuildRemoteBundle, candidate, []);
    };
  }
  if (fnGetRemoteBridgeStatus) {
    wrapped.getRemoteBridgeStatus = function getRemoteBridgeStatus() {
      return _ReflectApply(fnGetRemoteBridgeStatus, candidate, []);
    };
  }
  if (fnNetFetch) {
    wrapped.netFetch = function netFetch(pluginId, url, init) {
      return _ReflectApply(fnNetFetch, candidate, [pluginId, url, init]);
    };
  }

  return _ObjectFreeze(wrapped);
}

module.exports = {
  HOST_BRIDGE_PORT_REQUIRED_METHODS,
  HOST_BRIDGE_PORT_OPTIONAL_METHODS,
  isValidHostBridgePort,
  wrapHostBridgePort,
};
