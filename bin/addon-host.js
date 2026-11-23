#!/usr/bin/env node
'use strict';

/**
 * CLI Composition Root: wires segregated host ports (`HostLifecyclePort`, `AddonStorePort`,
 * optional `TrustPolicyPort`) and built-in Antigravity profiles (`antigravity-desktop`,
 * `antigravity-remote-web`) into the host-agnostic CLI factory (`src/cli/main.js`).
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { assertValidHostProfile } = require('../src/core/host-profile-port');
const { createCliApp } = require('../src/cli/main');
const { createElectronHostLifecyclePort } = require('../src/adapters/electron/electron-host-lifecycle-port');
const { createElectronAddonStorePort } = require('../src/adapters/electron/electron-addon-store-port');
const { createElectronTrustPolicyPort } = require('../src/adapters/electron/trust-policy-store');
const { ANTIGRAVITY_HOST_PROFILE } = require('../src/profiles/antigravity');
const { ANTIGRAVITY_REMOTE_WEB_PROFILE } = require('../src/profiles/antigravity-remote-web');

function createRemoteWebHostLifecyclePort() {
  return Object.freeze({
    validateProfile(profile) {
      return assertValidHostProfile(profile);
    },

    resolveContext(profile = ANTIGRAVITY_REMOTE_WEB_PROFILE, env = process.env, overrides = null) {
      const activeProfile = assertValidHostProfile(profile || ANTIGRAVITY_REMOTE_WEB_PROFILE);
      const basePaths = activeProfile.resolvePaths(env || process.env);
      const paths = overrides && typeof overrides === 'object' ? { ...basePaths, ...overrides } : basePaths;
      return Object.freeze({
        activeProfile,
        hostProfileId: activeProfile.id,
        paths,
      });
    },

    getHostStatus(ctx) {
      const { activeProfile, paths } = ctx;
      const distDir = paths && paths.REMOTE_DIST_DIR ? paths.REMOTE_DIST_DIR : null;
      const manifestPath = distDir ? path.join(distDir, 'build-manifest.json') : null;
      let buildManifest = null;
      if (manifestPath && fs.existsSync(manifestPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          if (
            !parsed ||
            typeof parsed !== 'object' ||
            Array.isArray(parsed) ||
            typeof parsed.buildSha8 !== 'string' ||
            !parsed.buildSha8
          ) {
            buildManifest = { corrupt: true };
          } else {
            buildManifest = parsed;
          }
        } catch (_err) {
          buildManifest = { corrupt: true };
        }
      }
      const manifestCorrupt = Boolean(buildManifest && buildManifest.corrupt);
      return {
        installed: Boolean(buildManifest && !manifestCorrupt && buildManifest.buildSha8),
        manifestCorrupt,
        mode: 'remote-web',
        hostProfileId: activeProfile.id,
        compatibleHostProfiles: activeProfile.compatibleHostProfiles || [],
        supportedCapabilities: activeProfile.supportedCapabilities || ['renderer'],
        allowedOrigins: activeProfile.allowedOrigins || [],
        remoteDistDir: distDir,
        buildSha8: buildManifest && !manifestCorrupt ? buildManifest.buildSha8 || null : null,
        bundleMode: buildManifest && !manifestCorrupt ? buildManifest.mode || null : null,
      };
    },

    diagnoseHost(ctx) {
      const status = this.getHostStatus(ctx);
      const { paths } = ctx;
      const addonsDirExists = Boolean(paths && paths.ADDONS_DIR && fs.existsSync(paths.ADDONS_DIR));
      const pluginsRootExists = Boolean(paths && paths.PLUGINS_ROOT_DIR && fs.existsSync(paths.PLUGINS_ROOT_DIR));
      const healthy = !status.manifestCorrupt && (addonsDirExists || pluginsRootExists || status.installed);
      return {
        healthy,
        manifestCorrupt: status.manifestCorrupt,
        mode: 'remote-web',
        addonsDirExists,
        pluginsRootExists,
        remoteBundleBuilt: status.installed,
        remoteDistDir: status.remoteDistDir,
        buildSha8: status.buildSha8,
        allowedOrigins: status.allowedOrigins,
      };
    },

    installHost() {
      return {
        ok: false,
        reason: 'ERR_REMOTE_WEB_USES_BUILD_REMOTE',
        hint: 'Run "addon-host --build-remote" (or "npm run build:remote") to build the Remote Web Userscript & Bookmarklet bundle.',
      };
    },

    upgradeHost() {
      return {
        ok: false,
        reason: 'ERR_REMOTE_WEB_USES_BUILD_REMOTE',
        hint: 'Run "addon-host --build-remote" (or "npm run build:remote") to rebuild the Remote Web bundle.',
      };
    },

    rollbackHost() {
      return {
        ok: false,
        reason: 'ERR_REMOTE_WEB_USES_BUILD_REMOTE',
        hint: 'Remote Web does not patch app.asar; remove the Userscript from your browser extension to uninstall.',
      };
    },
  });
}

function runBuildRemoteCommand(rawArgs) {
  const forwardArgs = rawArgs.filter((arg) => arg !== '--build-remote');
  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'build-remote.js');
  const res = spawnSync(process.execPath, [scriptPath, ...forwardArgs], {
    stdio: 'inherit',
  });
  if (res.error) {
    throw res.error;
  }
  if (typeof res.status === 'number' && res.status !== 0) {
    process.exitCode = res.status;
  }
  return { ok: res.status === 0, exitCode: res.status };
}

async function main(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? argv.slice() : [];

  if (args.includes('--build-remote')) {
    return runBuildRemoteCommand(args);
  }

  let selectedProfileAlias = null;
  const profIdx = args.indexOf('--profile');
  if (profIdx !== -1) {
    const candidate = args[profIdx + 1];
    if (
      candidate === 'remote-web' ||
      candidate === 'antigravity-remote-web' ||
      candidate === 'desktop' ||
      candidate === 'antigravity-desktop'
    ) {
      selectedProfileAlias = candidate;
      args.splice(profIdx, 2);
    }
  }

  const isRemoteWeb =
    selectedProfileAlias === 'remote-web' || selectedProfileAlias === 'antigravity-remote-web';

  const cliApp = createCliApp({
    hostLifecycle: isRemoteWeb ? createRemoteWebHostLifecyclePort() : createElectronHostLifecyclePort(),
    addonStore: createElectronAddonStorePort(),
    trustPolicy: createElectronTrustPolicyPort(),
    defaultProfile: isRemoteWeb ? ANTIGRAVITY_REMOTE_WEB_PROFILE : ANTIGRAVITY_HOST_PROFILE,
  });

  const isHelp = args.includes('--help') || args.includes('-h');
  const result = await cliApp.runCli(args);
  if (isHelp) {
    process.stdout.write(
      [
        '  --build-remote [options]               Build/verify Remote Web Userscript & Bookmarklet bundle',
        '  --profile remote-web|desktop|<path>    Built-in profile alias or custom HostProfile module',
      ].join('\n') + '\n'
    );
  }
  return result;
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err && err.message ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  createRemoteWebHostLifecyclePort,
  main,
};
