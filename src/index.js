'use strict';

const hostProfilePort = require('./core/host-profile-port');
const hostPorts = require('./core/host-ports');
const trustPolicyPort = require('./core/trust-policy-port');
const fsPort = require('./core/fs-port');
const manifestNormalizer = require('./core/manifest-normalizer');
const manifestValidator = require('./core/manifest-validator');
const slotRegistry = require('./core/slot-registry');
const lifecycleCoordinator = require('./core/lifecycle-coordinator');
const nodeFsPort = require('./adapters/node-fs-port');
const fsLockAtomic = require('./adapters/fs-lock-atomic');
const electronHostProfilePort = require('./adapters/electron/electron-host-profile-port');
const electronHostLifecyclePort = require('./adapters/electron/electron-host-lifecycle-port');
const electronAddonStorePort = require('./adapters/electron/electron-addon-store-port');
const trustPolicyStore = require('./adapters/electron/trust-policy-store');
const configReader = require('./adapters/electron/config-reader');
const asarPatcher = require('./adapters/electron/asar-patcher');
const asarPatchTransport = require('./adapters/electron/asar-patch-transport');
const envLauncherTransport = require('./adapters/electron/env-launcher-transport');
const hostLoaderBuilder = require('./adapters/electron/host-loader-builder');
const antigravityProfile = require('./profiles/antigravity');
const antigravityRemoteWebProfile = require('./profiles/antigravity-remote-web');
const remoteWebAdapter = require('./adapters/remote-web');
const cliFactory = require('./cli/main');

// NB3: Lazy default CLI app factory (zero side effects or eager instantiation at module import time)
let cachedDefaultCliApp = null;
function getDefaultCliApp() {
  if (!cachedDefaultCliApp) {
    cachedDefaultCliApp = cliFactory.createCliApp({
      hostLifecycle: electronHostLifecyclePort.createElectronHostLifecyclePort(),
      addonStore: electronAddonStorePort.createElectronAddonStorePort(),
      trustPolicy: trustPolicyStore.createElectronTrustPolicyPort(),
      defaultProfile: antigravityProfile.ANTIGRAVITY_HOST_PROFILE,
    });
  }
  return cachedDefaultCliApp;
}

module.exports = {
  ...hostProfilePort,
  ...hostPorts,
  ...trustPolicyPort,
  ...fsPort,
  ...manifestNormalizer,
  ...manifestValidator,
  ...slotRegistry,
  ...lifecycleCoordinator,
  ...nodeFsPort,
  ...fsLockAtomic,
  ...electronHostProfilePort,
  ...electronHostLifecyclePort,
  ...electronAddonStorePort,
  ...trustPolicyStore,
  ...configReader,
  ...asarPatcher,
  ...asarPatchTransport,
  ...envLauncherTransport,
  ...hostLoaderBuilder,
  ...antigravityProfile,
  ...antigravityRemoteWebProfile,
  ...remoteWebAdapter,
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
