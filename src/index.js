'use strict';

const hostProfilePort = require('./core/host-profile-port');
const hostPorts = require('./core/host-ports');
const manifestValidator = require('./core/manifest-validator');
const slotRegistry = require('./core/slot-registry');
const lifecycleCoordinator = require('./core/lifecycle-coordinator');
const electronHostProfilePort = require('./adapters/electron/electron-host-profile-port');
const electronHostLifecyclePort = require('./adapters/electron/electron-host-lifecycle-port');
const electronAddonStorePort = require('./adapters/electron/electron-addon-store-port');
const configReader = require('./adapters/electron/config-reader');
const asarPatcher = require('./adapters/electron/asar-patcher');
const hostLoaderBuilder = require('./adapters/electron/host-loader-builder');
const antigravityProfile = require('./profiles/antigravity');
const cliFactory = require('./cli/main');

const defaultCliApp = cliFactory.createCliApp({
  hostLifecycle: electronHostLifecyclePort.createElectronHostLifecyclePort(),
  addonStore: electronAddonStorePort.createElectronAddonStorePort(),
  defaultProfile: antigravityProfile.ANTIGRAVITY_HOST_PROFILE,
});

module.exports = {
  ...hostProfilePort,
  ...hostPorts,
  ...manifestValidator,
  ...slotRegistry,
  ...lifecycleCoordinator,
  ...electronHostProfilePort,
  ...electronHostLifecyclePort,
  ...electronAddonStorePort,
  ...configReader,
  ...asarPatcher,
  ...hostLoaderBuilder,
  ...antigravityProfile,
  ...cliFactory,
  ...defaultCliApp,
};
