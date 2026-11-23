#!/usr/bin/env node
'use strict';

/**
 * CLI Composition Root: wires segregated Electron ports (`HostLifecyclePort`, `AddonStorePort`,
 * optional `TrustPolicyPort`) and the default Antigravity profile into the host-agnostic CLI factory.
 */

const { createCliApp } = require('../src/cli/main');
const { createElectronHostLifecyclePort } = require('../src/adapters/electron/electron-host-lifecycle-port');
const { createElectronAddonStorePort } = require('../src/adapters/electron/electron-addon-store-port');
const { createElectronTrustPolicyPort } = require('../src/adapters/electron/trust-policy-store');
const { ANTIGRAVITY_HOST_PROFILE } = require('../src/profiles/antigravity');

const cliApp = createCliApp({
  hostLifecycle: createElectronHostLifecyclePort(),
  addonStore: createElectronAddonStorePort(),
  trustPolicy: createElectronTrustPolicyPort(),
  defaultProfile: ANTIGRAVITY_HOST_PROFILE,
});

cliApp.runCli(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`${err && err.message ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
