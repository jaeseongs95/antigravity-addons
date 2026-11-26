'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { ANTIGRAVITY_HOST_PROFILE } = require('../../src/profiles/antigravity');
const { ANTIGRAVITY_REMOTE_WEB_PROFILE } = require('../../src/profiles/antigravity-remote-web');
const { buildHubFiles, buildCuratedAllInOneUserscript } = require('../../scripts/build-hub');
const { buildUserscriptMetaHeader } = require('../../scripts/build-remote');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

test('TC-V320-01: Extenra v3.2.0 rebranding preserves 100% Antigravity runtime, CLI alias, and plugin backward compatibility', () => {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const sdkPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'packages', 'sdk', 'package.json'), 'utf8'));
  const v3Schema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'schemas', 'addon-manifest.v3.schema.json'), 'utf8'));

  // 1. Package & CLI rebranding + backward-compatible aliases
  assert.equal(rootPkg.name, 'extenra');
  assert.equal(rootPkg.version, '3.2.0');
  assert.equal(rootPkg.bin.extenra, 'bin/addon-host.js');
  assert.equal(rootPkg.bin['addon-host'], 'bin/addon-host.js');
  assert.equal(rootPkg.bin['antigravity-addons'], 'bin/addon-host.js');
  assert.equal(rootPkg.repository.url, 'https://github.com/jaeseongs95/extenra.git');
  assert.equal(rootPkg.homepage, 'https://github.com/jaeseongs95/extenra#readme');
  assert.equal(rootPkg.bugs.url, 'https://github.com/jaeseongs95/extenra/issues');

  assert.equal(sdkPkg.name, '@extenra/sdk');
  assert.equal(sdkPkg.version, '3.2.0');
  assert.equal(sdkPkg.bin['extenra-addon'], 'bin/ag-addon.js');
  assert.equal(sdkPkg.bin['ag-addon'], 'bin/ag-addon.js');
  assert.equal(sdkPkg.repository.url, 'https://github.com/jaeseongs95/extenra.git');

  assert.equal(v3Schema.$id, 'https://github.com/jaeseongs95/extenra/schemas/addon-manifest.v3.schema.json');

  // 2. Existing Antigravity host profiles, patch markers & local paths remain 100% unchanged
  assert.equal(ANTIGRAVITY_HOST_PROFILE.id, 'antigravity-desktop');
  assert.equal(ANTIGRAVITY_HOST_PROFILE.remoteProfileId, 'antigravity-remote-web');
  assert.equal(ANTIGRAVITY_HOST_PROFILE.patchMarker, 'ADDON_HOST_LOADER_V2');
  assert.equal(ANTIGRAVITY_REMOTE_WEB_PROFILE.id, 'antigravity-remote-web');
  assert.equal(
    ANTIGRAVITY_REMOTE_WEB_PROFILE.defaultUpdateBaseUrl,
    'https://github.com/jaeseongs95/extenra/releases/latest/download'
  );

  // 3. Hub & Userscript builders emit Extenra branding + jaeseongs95/extenra URLs while keeping legacy asset filenames
  const hubFiles = buildHubFiles({ version: rootPkg.version });
  const hubManifest = JSON.parse(hubFiles['hub-manifest.json']);
  assert.equal(hubManifest.releaseBaseUrl, 'https://github.com/jaeseongs95/extenra/releases/latest/download');
  assert.equal(
    hubManifest.channels.modularHostLib.url,
    'https://github.com/jaeseongs95/extenra/releases/latest/download/antigravity-remote-host.lib.js'
  );
  assert.equal(
    hubManifest.channels.curatedAllInOne.url,
    'https://github.com/jaeseongs95/extenra/releases/latest/download/antigravity-curated-all-in-one.user.js'
  );
  assert.equal(hubManifest.channels.desktopCli.installCommand, 'npx extenra --install');
  assert.ok(hubFiles['index.html'].includes('<title>Extenra — 1-Click Install Hub (v3.2.0)</title>'));
  assert.ok(hubFiles['index.html'].includes('<h1>Extenra — 1-Click Install Hub</h1>'));

  const curated = buildCuratedAllInOneUserscript({ version: rootPkg.version });
  assert.ok(curated.includes('// @name         Extenra — Curated All-in-One'));
  assert.ok(curated.includes('// @namespace    https://github.com/jaeseongs95/extenra'));

  const metaHeader = buildUserscriptMetaHeader({ version: rootPkg.version });
  assert.ok(metaHeader.includes('// @namespace    https://github.com/jaeseongs95/extenra'));

  // 4. Real CLI --help prints Extenra branding and backward-compatible aliases
  const helpOut = execFileSync(process.execPath, [path.join(REPO_ROOT, 'bin', 'addon-host.js'), '--help'], {
    encoding: 'utf8',
  });
  assert.ok(helpOut.includes(`Extenra v${rootPkg.version}`));
  assert.ok(helpOut.includes('Usage: extenra [options] <command>'));
  assert.ok(helpOut.includes('addon-host'));
});
