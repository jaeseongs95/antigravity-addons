#!/usr/bin/env node
'use strict';

/**
 * CLI Composition Root: binds the Electron host adapter and default Antigravity profile
 * into the host-agnostic CLI factory (`src/cli/main.js`).
 */

const { createCliApp } = require('../src/cli/main');
const { createElectronHostAdapter } = require('../src/adapters/electron/electron-host-adapter');
const { ANTIGRAVITY_HOST_PROFILE } = require('../src/profiles/antigravity');

const cliApp = createCliApp({
  hostAdapter: createElectronHostAdapter(),
  defaultProfile: ANTIGRAVITY_HOST_PROFILE,
});

cliApp.runCli(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`${err && err.message ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
