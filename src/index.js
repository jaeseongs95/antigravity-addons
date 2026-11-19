'use strict';

const hostProfilePort = require('./core/host-profile-port');
const manifestValidator = require('./core/manifest-validator');
const slotRegistry = require('./core/slot-registry');
const lifecycleCoordinator = require('./core/lifecycle-coordinator');
const electronHostProfilePort = require('./adapters/electron/electron-host-profile-port');
const electronHostAdapter = require('./adapters/electron/electron-host-adapter');
const configReader = require('./adapters/electron/config-reader');
const asarPatcher = require('./adapters/electron/asar-patcher');
const hostLoaderBuilder = require('./adapters/electron/host-loader-builder');
const antigravityProfile = require('./profiles/antigravity');
const cliFactory = require('./cli/main');

const defaultCliApp = cliFactory.createCliApp({
  hostAdapter: electronHostAdapter.createElectronHostAdapter(),
  defaultProfile: antigravityProfile.ANTIGRAVITY_HOST_PROFILE,
});

module.exports = {
  ...hostProfilePort,
  ...manifestValidator,
  ...slotRegistry,
  ...lifecycleCoordinator,
  ...electronHostProfilePort,
  ...electronHostAdapter,
  ...configReader,
  ...asarPatcher,
  ...hostLoaderBuilder,
  ...antigravityProfile,
  ...cliFactory,
  ...defaultCliApp,
};
