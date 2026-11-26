'use strict';

/**
 * Antigravity Remote Web HostProfile (v2.3.0 — SOLID DIP).
 *
 * All Antigravity Remote Web-specific origins, TrustedTypes policy name,
 * storage namespace, no-translate attributes, and UI anchor selectors live
 * exclusively in this profile — keeping `src/core/` and `src/adapters/remote-web/`
 * 100% vendor-neutral.
 */

const path = require('node:path');
const {
  resolveAntigravityPaths,
  resolveAntigravityConfigScopes,
} = require('./antigravity');

const REMOTE_WEB_PROFILE_ID = 'antigravity-remote-web';
const DEFAULT_ALLOWED_ORIGINS = Object.freeze(['https://antigravity.google.com']);
const DEFAULT_EXCLUDED_URL_PROTOCOLS = Object.freeze([
  'data:',
  'about:',
  'javascript:',
  'blob:',
  'file:',
  'chrome:',
  'chrome-extension:',
]);
const DEFAULT_TRUSTED_TYPES_POLICY_NAME = 'antigravity-remote-addon-host';
const DEFAULT_STORAGE_NAMESPACE = 'agy-remote-addon-host:v2';
const DEFAULT_UPDATE_BASE_URL = 'https://github.com/jaeseongs95/antigravity-addons/releases/latest/download';

function resolveAntigravityRemoteWebPaths(env = process.env) {
  const base = resolveAntigravityPaths(env);
  const remoteDistDir =
    env && typeof env.AGY_REMOTE_DIST_DIR === 'string' && env.AGY_REMOTE_DIST_DIR.trim()
      ? path.resolve(env.AGY_REMOTE_DIST_DIR.trim())
      : path.join(base.HOST_DATA_DIR, 'remote-dist');

  return {
    ...base,
    REMOTE_DIST_DIR: remoteDistDir,
  };
}

const REMOTE_WEB_UI_ANCHORS = Object.freeze({
  sidebar: Object.freeze([
    '[data-testid="sidebar-split"] > :first-child',
    '[data-testid="conversation-list-sidebar"]',
    '[data-testid="sidebar"]',
    '[data-testid="left-sidebar"]',
    '[data-remote-addon-host-slot-host="sidebar"]',
  ]),
  'overview-pane': Object.freeze([
    '[data-testid="overview-panel"]',
    '[data-testid="overview-panel-host"]',
    '[data-testid="right-sidebar"]',
    '[data-remote-addon-host-slot-host="overview-pane"]',
  ]),
  'status-bar': Object.freeze([
    '[data-testid="layout-status-bar"]',
    '[data-testid="status-bar"]',
    '[data-testid="app-status-bar"]',
    '[data-remote-addon-host-slot-host="status-bar"]',
  ]),
  'settings-pane': Object.freeze([
    '.settings-modal-container',
    '[data-testid="settings-panel"]',
    '[data-remote-addon-host-slot-host="settings-pane"]',
  ]),
  'automation-page': Object.freeze([
    '[data-testid="sidecars-view"]',
    '[data-testid="automation-view"]',
    '[data-remote-addon-host-slot-host="automation-page"]',
  ]),
  'customizations-page': Object.freeze([
    '[data-testid="customizations-view"]',
    '[data-testid="customizations-installed"]',
    '[data-testid="customizations-marketplace"]',
    '[data-remote-addon-host-slot-host="customizations-page"]',
  ]),
  'modal-root': Object.freeze(['body']),
});

const REMOTE_WEB_UI_SURFACES = Object.freeze({
  'settings-pane': Object.freeze({
    priority: 100,
    selectors: Object.freeze([
      '.settings-modal-container',
      '[data-testid="settings-panel"]',
      '[role="dialog"]:not([data-addon-host-modal-dialog])',
    ]),
    safeInsets: Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 }),
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
    safeInsets: Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 }),
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
    safeInsets: Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 }),
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
    safeInsets: Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 }),
  }),
});

const REMOTE_WEB_UI_GRID_MERGES = Object.freeze([
  Object.freeze({
    section: '[data-testid="customizations-installed-plugins"]',
    secondary: '[data-testid="cloud-app-cards"]',
    wrapperSelector: 'div',
    gridSelector: 'div.grid',
  }),
]);

const REMOTE_WEB_FORBIDDEN_NET_HOSTS = Object.freeze([
  'antigravity.google.com',
  'accounts.google.com',
  'oauth2.googleapis.com',
  'myaccount.google.com',
]);

const ANTIGRAVITY_REMOTE_WEB_PROFILE = Object.freeze({
  id: REMOTE_WEB_PROFILE_ID,
  displayName: 'Antigravity Remote Web',
  compatibleHostProfiles: Object.freeze(['antigravity-desktop']),
  supportedCapabilities: Object.freeze(['renderer']),
  allowedOrigins: DEFAULT_ALLOWED_ORIGINS,
  excludedUrlProtocols: DEFAULT_EXCLUDED_URL_PROTOCOLS,
  trustedTypesPolicyName: DEFAULT_TRUSTED_TYPES_POLICY_NAME,
  storageNamespace: DEFAULT_STORAGE_NAMESPACE,
  excludeOfflineConfigBridge: true,
  defaultUpdateBaseUrl: DEFAULT_UPDATE_BASE_URL,
  extraNoTranslateAttributes: Object.freeze(['data-agy-no-translate']),
  uiAnchors: REMOTE_WEB_UI_ANCHORS,
  uiSurfaces: REMOTE_WEB_UI_SURFACES,
  uiGridMerges: REMOTE_WEB_UI_GRID_MERGES,
  forbiddenNetHosts: REMOTE_WEB_FORBIDDEN_NET_HOSTS,
  resolvePaths: resolveAntigravityRemoteWebPaths,
  resolveConfigScopes: resolveAntigravityConfigScopes,
});

/**
 * Serializable browser-safe subset of the profile (zero Node paths or functions).
 */
function toBrowserRemoteWebProfile(profile = ANTIGRAVITY_REMOTE_WEB_PROFILE) {
  return Object.freeze({
    id: String(profile.id || REMOTE_WEB_PROFILE_ID),
    displayName: String(profile.displayName || profile.id || REMOTE_WEB_PROFILE_ID),
    compatibleHostProfiles: Object.freeze(
      Array.isArray(profile.compatibleHostProfiles) ? profile.compatibleHostProfiles.slice() : []
    ),
    supportedCapabilities: Object.freeze(
      Array.isArray(profile.supportedCapabilities) ? profile.supportedCapabilities.slice() : ['renderer']
    ),
    allowedOrigins: Object.freeze(
      Array.isArray(profile.allowedOrigins) ? profile.allowedOrigins.slice() : []
    ),
    excludedUrlProtocols: Object.freeze(
      Array.isArray(profile.excludedUrlProtocols) ? profile.excludedUrlProtocols.slice() : []
    ),
    trustedTypesPolicyName: String(profile.trustedTypesPolicyName || DEFAULT_TRUSTED_TYPES_POLICY_NAME),
    storageNamespace: String(profile.storageNamespace || DEFAULT_STORAGE_NAMESPACE),
    extraNoTranslateAttributes: Object.freeze(
      Array.isArray(profile.extraNoTranslateAttributes) ? profile.extraNoTranslateAttributes.slice() : []
    ),
    uiAnchors: profile.uiAnchors || {},
    uiSurfaces: profile.uiSurfaces || {},
    uiGridMerges: Object.freeze(
      Array.isArray(profile.uiGridMerges) ? profile.uiGridMerges.slice() : []
    ),
    forbiddenNetHosts: Object.freeze(
      Array.isArray(profile.forbiddenNetHosts) ? profile.forbiddenNetHosts.slice() : REMOTE_WEB_FORBIDDEN_NET_HOSTS.slice()
    ),
  });
}

module.exports = {
  REMOTE_WEB_PROFILE_ID,
  DEFAULT_ALLOWED_ORIGINS,
  DEFAULT_EXCLUDED_URL_PROTOCOLS,
  DEFAULT_TRUSTED_TYPES_POLICY_NAME,
  DEFAULT_STORAGE_NAMESPACE,
  DEFAULT_UPDATE_BASE_URL,
  REMOTE_WEB_UI_ANCHORS,
  REMOTE_WEB_UI_SURFACES,
  REMOTE_WEB_UI_GRID_MERGES,
  resolveAntigravityRemoteWebPaths,
  toBrowserRemoteWebProfile,
  ANTIGRAVITY_REMOTE_WEB_PROFILE,
};
