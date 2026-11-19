#!/usr/bin/env node
'use strict';

const { runCli } = require('../src/cli/main');

runCli(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`${err && err.message ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
