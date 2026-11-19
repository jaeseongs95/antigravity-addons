'use strict';

/**
 * Antigravity Desktop Default HostProfile.
 * All Antigravity-specific paths, Electron ASAR anchors, URL allowlists,
 * legacy no-translate attributes, and legacy direct-patch markers live exclusively here.
 */

const os = require('node:os');
const path = require('node:path');

const PATCH_MARKER = 'ADDON_HOST_LOADER_V1';
const LOADER_ENV_VAR = 'AGY_ADDON_HOST_LOADER_PATH';
const MAIN_ANCHOR_TARGET = "electron_1.app.on('web-contents-created', (_event, contents) => {";
const MAIN_ANCHOR_REPLACEMENT =
  "electron_1.app.on('web-contents-created', (_event, contents) => {" +
  "/*ADDON_HOST_LOADER_V1*/try{const _p=process.env.AGY_ADDON_HOST_LOADER_PATH||require('path').join(process.env.USERPROFILE||process.env.HOME||'','.gemini','antigravity','addon-host-loader.js');if(require('fs').existsSync(_p))require(_p).attachWebContents(contents,electron_1.app);}catch(_e){try{process.stderr.write('[addon-host] '+(_e&&_e.message||_e)+'\\n');}catch(_i){}}";

function resolveAntigravityPaths(env = process.env) {
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const agyDir = path.join(home, '.gemini', 'antigravity');
  const pluginsRoot = path.join(home, '.gemini', 'config', 'plugins');
  const configJsonPath = path.join(home, '.gemini', 'config', 'config.json');
  const addonsDir = path.join(agyDir, 'addons.d');
  const addonsLockPath = path.join(agyDir, 'addon-host-addons.lock');
  const loaderScriptPath = path.join(agyDir, 'addon-host-loader.js');
  const asarLockPath = path.join(agyDir, 'addon-host-asar.lock');

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
  };
}

const ANTIGRAVITY_HOST_PROFILE = Object.freeze({
  id: 'antigravity-desktop',
  patchMarker: PATCH_MARKER,
  loaderEnvVar: LOADER_ENV_VAR,
  mainEntry: 'dist/main.js',
  mainAnchorTarget: MAIN_ANCHOR_TARGET,
  mainAnchorReplacement: MAIN_ANCHOR_REPLACEMENT,
  extraNoTranslateAttributes: Object.freeze(['data-agy-no-translate']),
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
  LOADER_ENV_VAR,
  MAIN_ANCHOR_TARGET,
  MAIN_ANCHOR_REPLACEMENT,
  resolveAntigravityPaths,
  ANTIGRAVITY_HOST_PROFILE,
};
