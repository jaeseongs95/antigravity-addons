'use strict';

/**
 * Vendor- and runtime-neutral segregated CLI ports (ISP / DIP / OCP).
 *
 * `src/cli/` depends ONLY on these small, host-neutral interfaces rather than
 * concrete host adapters, file locks, or runtime-specific archive formats.
 *
 * Option B-Clean (TC-014 LSP): HOST_LIFECYCLE_PORT_METHODS (6) and
 * ADDON_STORE_PORT_METHODS (4) are strictly preserved unchanged.
 * Optional TrustPolicyPort is segregated in `src/core/trust-policy-port.js`.
 */

const { TRUST_POLICY_PORT_METHODS, assertTrustPolicyPort } = require('./trust-policy-port');

const HOST_LIFECYCLE_PORT_METHODS = Object.freeze([
  'validateProfile',
  'resolveContext',
  'getHostStatus',
  'diagnoseHost',
  'installHost',
  'rollbackHost',
]);

const ADDON_STORE_PORT_METHODS = Object.freeze([
  'planAddons',
  'validateManifest',
  'registerManifest',
  'unregisterManifest',
]);

function assertPortMethods(port, requiredMethods, errorPrefix) {
  if (!port || typeof port !== 'object') {
    throw new Error(`${errorPrefix}:INVALID_PORT`);
  }
  for (const method of requiredMethods) {
    if (typeof port[method] !== 'function') {
      throw new Error(`${errorPrefix}:MISSING_METHOD:${method}`);
    }
  }
  return port;
}

function assertHostLifecyclePort(port) {
  return assertPortMethods(port, HOST_LIFECYCLE_PORT_METHODS, 'ERR_HOST_LIFECYCLE_PORT');
}

function assertAddonStorePort(port) {
  return assertPortMethods(port, ADDON_STORE_PORT_METHODS, 'ERR_ADDON_STORE_PORT');
}

module.exports = {
  HOST_LIFECYCLE_PORT_METHODS,
  ADDON_STORE_PORT_METHODS,
  TRUST_POLICY_PORT_METHODS,
  assertHostLifecyclePort,
  assertAddonStorePort,
  assertTrustPolicyPort,
};
