'use strict';

const hostProfilePort = require('./core/host-profile-port');
const hostPorts = require('./core/host-ports');
const fsPort = require('./core/fs-port');
const manifestValidator = require('./core/manifest-validator');
const slotRegistry = require('./core/slot-registry');
const lifecycleCoordinator = require('./core/lifecycle-coordinator');
const nodeFsPort = require('./adapters/node-fs-port');
const fsLockAtomic = require('./adapters/fs-lock-atomic');
const electronHostProfilePort = require('./adapters/electron/electron-host-profile-port');
const electronHostLifecyclePort = require('./adapters/electron/electron-host-lifecycle-port');
const electronAddonStorePort = require('./adapters/electron/electron-addon-store-port');
const configReader = require('./adapters/electron/config-reader');
const asarPatcher = require('./adapters/electron/asar-patcher');
const hostLoaderBuilder = require('./adapters/electron/host-loader-builder');
const antigravityProfile = require('./profiles/antigravity');
const cliFactory = require('./cli/main');

// NB3: Lazy default CLI app factory (zero side effects or eager instantiation at module import time)
let cachedDefaultCliApp = null;
function getDefaultCliApp() {
  if (!cachedDefaultCliApp) {
    cachedDefaultCliApp = cliFactory.createCliApp({
      hostLifecycle: electronHostLifecyclePort.createElectronHostLifecyclePort(),
      addonStore: electronAddonStorePort.createElectronAddonStorePort(),
      defaultProfile: antigravityProfile.ANTIGRAVITY_HOST_PROFILE,
    });
  }
  return cachedDefaultCliApp;
}

module.exports = {
  ...hostProfilePort,
  ...hostPorts,
  ...fsPort,
  ...manifestValidator,
  ...slotRegistry,
  ...lifecycleCoordinator,
  ...nodeFsPort,
  ...fsLockAtomic,
  ...electronHostProfilePort,
  ...electronHostLifecyclePort,
  ...electronAddonStorePort,
  ...configReader,
  ...asarPatcher,
  ...hostLoaderBuilder,
  ...antigravityProfile,
  ...cliFactory,
  getDefaultCliApp,
  loadHostProfileFromFile: (...args) => getDefaultCliApp().loadHostProfileFromFile(...args),
  resolveContext: (...args) => getDefaultCliApp().resolveContext(...args),
  buildStatusReport: (...args) => getDefaultCliApp().buildStatusReport(...args),
  buildDoctorReport: (...args) => getDefaultCliApp().buildDoctorReport(...args),
  validateAddonManifestFile: (...args) => getDefaultCliApp().validateAddonManifestFile(...args),
  registerAddonManifestFile: (...args) => getDefaultCliApp().registerAddonManifestFile(...args),
  unregisterAddonManifest: (...args) => getDefaultCliApp().unregisterAddonManifest(...args),
  getHelpText: (...args) => getDefaultCliApp().getHelpText(...args),
  runCli: (...args) => getDefaultCliApp().runCli(...args),
};
