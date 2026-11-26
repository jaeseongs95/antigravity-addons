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
  const configDir = path.join(home, '.gemini', 'config');
  const pluginsRoot = path.join(configDir, 'plugins');
  const configJsonPath = path.join(configDir, 'config.json');
  const mcpConfigPath = path.join(configDir, 'mcp_config.json');
  const mcpConfigLegacyPath = path.join(agyDir, 'mcp_config.json');
  const configBackupsDir = path.join(configDir, '.mcp-manager-backups');
  const addonsDir = path.join(agyDir, 'addons.d');
  const addonsLockPath = path.join(agyDir, 'addon-host-addons.lock');
  const loaderScriptPath = path.join(agyDir, 'addon-host-loader.js');
  const asarLockPath = path.join(agyDir, 'addon-host-asar.lock');
  const backupsDir = path.join(agyDir, 'backups');
  const trustPolicyPath = path.join(agyDir, 'trust-policy.json');
  const reconcileStatePath = path.join(agyDir, 'reconcile-state.json');
  const remotePrefsPath = path.join(agyDir, 'remote-preferences.json');
  const remoteDistDir =
    env && typeof env.AGY_REMOTE_DIST_DIR === 'string' && env.AGY_REMOTE_DIST_DIR.trim()
      ? path.resolve(env.AGY_REMOTE_DIST_DIR.trim())
      : path.join(agyDir, 'remote-dist');
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
    MCP_CONFIG_PATH: mcpConfigPath,
    MCP_CONFIG_LEGACY_PATH: mcpConfigLegacyPath,
    CONFIG_BACKUPS_DIR: configBackupsDir,
    ADDONS_DIR: addonsDir,
    ADDONS_LOCK_PATH: addonsLockPath,
    LOADER_SCRIPT_PATH: loaderScriptPath,
    ASAR_PATH: asarPath,
    ASAR_LOCK_PATH: asarLockPath,
    BACKUPS_DIR: backupsDir,
    TRUST_POLICY_PATH: trustPolicyPath,
    RECONCILE_STATE_PATH: reconcileStatePath,
    REMOTE_PREFS_PATH: remotePrefsPath,
    REMOTE_DIST_DIR: remoteDistDir,
    RUNTIME_DIR: runtimeDir,
    APP_EXECUTABLE_PATH: appExecutablePath,
  };
}

function resolveAntigravityConfigScopes(paths = {}) {
  const home = paths.HOME_DIR || os.homedir();
  const configDir = paths.CONFIG_JSON_PATH ? path.dirname(paths.CONFIG_JSON_PATH) : path.join(home, '.gemini', 'config');
  const hostDataDir = paths.HOST_DATA_DIR || path.join(home, '.gemini', 'antigravity');
  const mcpConfigPath = paths.MCP_CONFIG_PATH || path.join(configDir, 'mcp_config.json');
  const mcpConfigLegacyPath = paths.MCP_CONFIG_LEGACY_PATH || path.join(hostDataDir, 'mcp_config.json');
  const backupDir = paths.CONFIG_BACKUPS_DIR || path.join(configDir, '.mcp-manager-backups');
  const pluginsRootDir = paths.PLUGINS_ROOT_DIR || path.join(configDir, 'plugins');

  return Object.freeze({
    'antigravity:mcp-config': Object.freeze({
      kind: 'file',
      access: 'rw',
      maxBytes: 262144,
      path: mcpConfigPath,
      backupDir,
      maxBackups: 10,
      allowRawRecovery: true,
      ancestorSymlinkDepth: 2,
    }),
    'antigravity:plugin-mcp-configs': Object.freeze({
      kind: 'plugin-files',
      access: 'ro',
      maxBytes: 262144,
      rootDir: pluginsRootDir,
      fileName: 'mcp_config.json',
      maxPlugins: 128,
      allowRawRecovery: true,
    }),
    'antigravity:mcp-config-legacy': Object.freeze({
      kind: 'file',
      access: 'ro',
      maxBytes: 262144,
      path: mcpConfigLegacyPath,
      allowRawRecovery: true,
      ancestorSymlinkDepth: 2,
    }),
  });
}

const ANTIGRAVITY_HOST_PROFILE = Object.freeze({
  id: 'antigravity-desktop',
  supportedCapabilities: Object.freeze(['renderer', 'mainHook']),
  remoteProfileId: 'antigravity-remote-web',
  remoteSupportedCapabilities: Object.freeze(['renderer']),
  settingsUi: Object.freeze({
    navId: 'addon-manager',
    navLabel: Object.freeze({
      en: 'Addon Manager',
      ko: '애드온 관리',
    }),
  }),
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
  updateSurvival: Object.freeze({
    updaterModule: 'electron-updater',
    method: 'quitAndInstall',
    platforms: Object.freeze(['win32']),
    ackTimeoutMs: 250,
    waitTimeoutMs: 45000,
  }),
  extraNoTranslateAttributes: Object.freeze(['data-agy-no-translate']),
  uiAnchors: Object.freeze({
    sidebar: Object.freeze([
      '[data-testid="sidebar-split"] > :first-child',
      '[data-testid="conversation-list-sidebar"]',
      '[data-testid="sidebar"]',
      '[data-testid="left-sidebar"]',
    ]),
    'overview-pane': Object.freeze([
      '[data-testid="overview-panel"]',
      '[data-testid="overview-panel-host"]',
      '[data-testid="right-sidebar"]',
    ]),
    'status-bar': Object.freeze([
      '[data-testid="layout-status-bar"]',
      '[data-testid="status-bar"]',
      '[data-testid="app-status-bar"]',
    ]),
    'settings-pane': Object.freeze(['.settings-modal-container', '[data-testid="settings-panel"]']),
    'automation-page': Object.freeze(['[data-testid="sidecars-view"]', '[data-testid="automation-view"]']),
    'customizations-page': Object.freeze([
      '[data-testid="customizations-view"]',
      '[data-testid="customizations-installed"]',
      '[data-testid="customizations-marketplace"]',
    ]),
    'modal-root': Object.freeze(['body']),
  }),
  uiSurfaces: Object.freeze({
    'settings-pane': Object.freeze({
      priority: 100,
      selectors: Object.freeze([
        '.settings-modal-container',
        '[data-testid="settings-panel"]',
        '[role="dialog"]:not([data-addon-host-modal-dialog])',
      ]),
      safeInsets: Object.freeze({ top: 36, right: 0, bottom: 0, left: 0 }),
    }),
    'customizations-page': Object.freeze({
      priority: 80,
      selectors: Object.freeze(['[data-testid="customizations-view"]']),
      excludeLeftSelectors: Object.freeze([
        '[data-testid="sidebar-split"] > :first-child',
        '[data-testid="conversation-list-sidebar"]',
        '[data-testid="sidebar"]',
        '[data-testid="left-sidebar"]',
        'aside',
        'nav',
      ]),
      excludeRightSelectors: Object.freeze([
        '[data-testid="overview-panel"]',
        '[data-testid="overview-panel-host"]',
        '[data-testid="right-sidebar"]',
      ]),
      excludeBottomSelectors: Object.freeze([
        '[data-testid="layout-status-bar"]',
        '[data-testid="status-bar"]',
        '[data-testid="app-status-bar"]',
      ]),
      safeInsets: Object.freeze({ top: 36, right: 0, bottom: 0, left: 0 }),
    }),
    'automation-page': Object.freeze({
      priority: 75,
      selectors: Object.freeze(['[data-testid="sidecars-view"]', '[data-testid="automation-view"]']),
      excludeLeftSelectors: Object.freeze([
        '[data-testid="sidebar-split"] > :first-child',
        '[data-testid="conversation-list-sidebar"]',
        '[data-testid="sidebar"]',
        '[data-testid="left-sidebar"]',
        'aside',
        'nav',
      ]),
      excludeRightSelectors: Object.freeze([
        '[data-testid="overview-panel"]',
        '[data-testid="overview-panel-host"]',
        '[data-testid="right-sidebar"]',
      ]),
      excludeBottomSelectors: Object.freeze([
        '[data-testid="layout-status-bar"]',
        '[data-testid="status-bar"]',
        '[data-testid="app-status-bar"]',
      ]),
      safeInsets: Object.freeze({ top: 36, right: 0, bottom: 0, left: 0 }),
    }),
    workspace: Object.freeze({
      priority: 50,
      selectors: Object.freeze(['[data-testid="conversation-view"]', '[data-testid="workspace-main"]', 'main', '[role="main"]']),
      excludeLeftSelectors: Object.freeze([
        '[data-testid="sidebar-split"] > :first-child',
        '[data-testid="conversation-list-sidebar"]',
        '[data-testid="sidebar"]',
        '[data-testid="left-sidebar"]',
        'aside',
        'nav',
      ]),
      excludeRightSelectors: Object.freeze([
        '[data-testid="overview-panel"]',
        '[data-testid="overview-panel-host"]',
        '[data-testid="right-sidebar"]',
      ]),
      excludeBottomSelectors: Object.freeze([
        '[data-testid="layout-status-bar"]',
        '[data-testid="status-bar"]',
        '[data-testid="app-status-bar"]',
      ]),
      safeInsets: Object.freeze({ top: 36, right: 0, bottom: 0, left: 0 }),
    }),
  }),
  uiGridMerges: Object.freeze([
    Object.freeze({
      section: '[data-testid="customizations-installed-plugins"]',
      secondary: '[data-testid="cloud-app-cards"]',
      wrapperSelector: 'div',
      gridSelector: 'div.grid',
    }),
  ]),
  forbiddenNetHosts: Object.freeze([
    'antigravity.google.com',
    'accounts.google.com',
    'oauth2.googleapis.com',
    'myaccount.google.com',
  ]),
  namedLoopbackTargets: Object.freeze({
    'antigravity-sidecar': 18910,
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
  resolveConfigScopes: resolveAntigravityConfigScopes,
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
  resolveAntigravityConfigScopes,
  ANTIGRAVITY_HOST_PROFILE,
};
