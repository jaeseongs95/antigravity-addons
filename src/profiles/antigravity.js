'use strict';

/**
 * Antigravity Desktop Default HostProfile (v2.0.0 — Purified).
 * All Antigravity-specific paths, Electron ASAR anchors, URL allowlists,
 * portal bridge settings, legacy no-translate attributes, and patch markers live exclusively here.
 *
 * ZERO consumer plugin slotIds, ZERO broad fallback selectors, and ZERO production env overrides.
 */

const os = require('node:os');
const path = require('node:path');

const PATCH_MARKER = 'ADDON_HOST_LOADER_V2';
const PRIOR_HOST_MARKERS = Object.freeze(['ADDON_HOST_LOADER_V1']);
const LOADER_ENV_VAR = 'AGY_ADDON_HOST_LOADER_PATH';
const ISOLATED_WORLD_ID = 998;
const WINDOW_ORIGIN = 'https://127.0.0.1';

const MAIN_ANCHOR_TARGET = "electron_1.app.on('web-contents-created', (_event, contents) => {";
// Pre-L339 synchronous initMain(electron_1.app) entry:
// - Uses os.homedir() + path.isAbsolute() (NO process.env.AGY_ADDON_HOST_LOADER_PATH production override).
// - Runs BEFORE app.whenReady() so PortalArbiter can non-destructively wrap ipcMain.handle.
const MAIN_ANCHOR_REPLACEMENT =
  "/*ADDON_HOST_LOADER_V2*/try{const _p=require('path').join(require('os').homedir(),'.gemini','antigravity','addon-host-loader.js');if(require('path').isAbsolute(_p)&&require('fs').existsSync(_p))require(_p).initMain(electron_1.app);}catch(_e){try{process.stderr.write('[addon-host] '+(_e&&_e.message||_e)+'\\n');}catch(_i){}}" +
  MAIN_ANCHOR_TARGET;

function resolveAntigravityPaths(env = process.env) {
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const agyDir = path.join(home, '.gemini', 'antigravity');
  const pluginsRoot = path.join(home, '.gemini', 'config', 'plugins');
  const configJsonPath = path.join(home, '.gemini', 'config', 'config.json');
  const addonsDir = path.join(agyDir, 'addons.d');
  const addonsLockPath = path.join(agyDir, 'addon-host-addons.lock');
  const loaderScriptPath = path.join(agyDir, 'addon-host-loader.js');
  const asarLockPath = path.join(agyDir, 'addon-host-asar.lock');
  const backupsDir = path.join(agyDir, 'backups');
  const trustPolicyPath = path.join(agyDir, 'trust-policy.json');
  const runtimeDir = path.join(agyDir, 'runtime');

  let asarPath = env.AGY_ASAR_PATH || '';
  if (!asarPath) {
    if (process.platform === 'win32' && env.LOCALAPPDATA) {
      asarPath = path.join(env.LOCALAPPDATA, 'Programs', 'antigravity', 'resources', 'app.asar');
    } else if (process.platform === 'darwin') {
      asarPath = '/Applications/Antigravity.app/Contents/Resources/app.asar';
    } else {
      asarPath = path.join(home, '.local', 'share', 'antigravity', 'resources', 'app.asar');
    }
  }

  let appExecutablePath = env.AGY_EXECUTABLE_PATH || '';
  if (!appExecutablePath) {
    if (process.platform === 'win32' && env.LOCALAPPDATA) {
      appExecutablePath = path.join(env.LOCALAPPDATA, 'Programs', 'antigravity', 'Antigravity.exe');
    } else if (process.platform === 'darwin') {
      appExecutablePath = '/Applications/Antigravity.app/Contents/MacOS/Antigravity';
    } else {
      appExecutablePath = path.join(home, '.local', 'share', 'antigravity', 'antigravity');
    }
  }

  return {
    HOME_DIR: home,
    HOST_DATA_DIR: agyDir,
    PLUGINS_ROOT_DIR: pluginsRoot,
    CONFIG_JSON_PATH: configJsonPath,
    ADDONS_DIR: addonsDir,
    ADDONS_LOCK_PATH: addonsLockPath,
    LOADER_SCRIPT_PATH: loaderScriptPath,
    ASAR_PATH: asarPath,
    ASAR_LOCK_PATH: asarLockPath,
    BACKUPS_DIR: backupsDir,
    TRUST_POLICY_PATH: trustPolicyPath,
    RUNTIME_DIR: runtimeDir,
    APP_EXECUTABLE_PATH: appExecutablePath,
  };
}

const ANTIGRAVITY_HOST_PROFILE = Object.freeze({
  id: 'antigravity-desktop',
  patchMarker: PATCH_MARKER,
  priorHostMarkers: PRIOR_HOST_MARKERS,
  loaderEnvVar: LOADER_ENV_VAR,
  isolatedWorldId: ISOLATED_WORLD_ID,
  mainEntry: 'dist/main.js',
  mainAnchorTarget: MAIN_ANCHOR_TARGET,
  mainAnchorReplacement: MAIN_ANCHOR_REPLACEMENT,
  windowOrigin: WINDOW_ORIGIN,
  defaultSessionOnly: true,
  excludedUrlProtocols: Object.freeze(['data:', 'about:', 'javascript:']),
  portalBridge: Object.freeze({
    channel: 'wcv:set-portal-overlay-open',
    allowDegradedLocal: true,
  }),
  extraNoTranslateAttributes: Object.freeze(['data-agy-no-translate']),
  uiAnchors: Object.freeze({
    sidebar: Object.freeze(['[data-testid="sidebar"]', '[data-testid="left-sidebar"]']),
    'overview-pane': Object.freeze(['[data-testid="overview-panel"]', '[data-testid="right-sidebar"]']),
    'status-bar': Object.freeze(['[data-testid="status-bar"]', '[data-testid="app-status-bar"]']),
    'settings-pane': Object.freeze(['.settings-modal-container', '[data-testid="settings-panel"]']),
    'automation-page': Object.freeze(['[data-testid="automation-view"]']),
    'customizations-page': Object.freeze(['[data-testid="customizations-view"]']),
    'modal-root': Object.freeze(['body']),
  }),
  allowedUrlProtocols: Object.freeze(['http:', 'https:']),
  allowedUrlHosts: Object.freeze(['127.0.0.1', 'localhost', '::1', '[::1]']),
  legacyPatchMarkers: Object.freeze([
    'AGY_STATUSBAR',
    'AGY_MCP',
    'AGY_KO_THOUGHT',
    'AGY_UI_EXTENSIONS_LOADER_V1',
    'ui-extensions-loader',
  ]),
  resolvePaths: resolveAntigravityPaths,
});

module.exports = {
  PATCH_MARKER,
  PRIOR_HOST_MARKERS,
  LOADER_ENV_VAR,
  ISOLATED_WORLD_ID,
  WINDOW_ORIGIN,
  MAIN_ANCHOR_TARGET,
  MAIN_ANCHOR_REPLACEMENT,
  resolveAntigravityPaths,
  ANTIGRAVITY_HOST_PROFILE,
};
