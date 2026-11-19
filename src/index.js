'use strict';

const hostProfilePort = require('./core/host-profile-port');
const manifestValidator = require('./core/manifest-validator');
const slotRegistry = require('./core/slot-registry');
const lifecycleCoordinator = require('./core/lifecycle-coordinator');
const configReader = require('./adapters/electron/config-reader');
const asarPatcher = require('./adapters/electron/asar-patcher');
const hostLoaderBuilder = require('./adapters/electron/host-loader-builder');
const antigravityProfile = require('./profiles/antigravity');
const cli = require('./cli/main');

module.exports = {
  ...hostProfilePort,
  ...manifestValidator,
  ...slotRegistry,
  ...lifecycleCoordinator,
  ...configReader,
  ...asarPatcher,
  ...hostLoaderBuilder,
  ...antigravityProfile,
  ...cli,
};
