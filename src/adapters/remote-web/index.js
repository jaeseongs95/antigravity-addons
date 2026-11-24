'use strict';

/**
 * Remote Web Adapter public barrel exports (v2.3.0).
 */

const originGuard = require('./origin-guard');
const trustedTypesGuard = require('./trusted-types-guard');
const domGuard = require('./dom-guard');
const remoteHostBridge = require('./remote-host-bridge');
const addonCollector = require('./addon-collector');
const remoteBootstrap = require('./remote-bootstrap');

module.exports = {
  ...originGuard,
  ...trustedTypesGuard,
  ...domGuard,
  ...remoteHostBridge,
  ...addonCollector,
  ...remoteBootstrap,
};
