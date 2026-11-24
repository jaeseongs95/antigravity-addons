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
    '[data-testid="sidebar"]',
    '[data-testid="left-sidebar"]',
    '[data-remote-addon-host-slot-host="sidebar"]',
  ]),
  'overview-pane': Object.freeze([
    '[data-testid="overview-panel"]',
    '[data-testid="right-sidebar"]',
    '[data-remote-addon-host-slot-host="overview-pane"]',
  ]),
  'status-bar': Object.freeze([
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
    '[data-testid="automation-view"]',
    '[data-remote-addon-host-slot-host="automation-page"]',
  ]),
  'customizations-page': Object.freeze([
    '[data-testid="customizations-view"]',
    '[data-remote-addon-host-slot-host="customizations-page"]',
  ]),
  'modal-root': Object.freeze(['body']),
});

const ANTIGRAVITY_REMOTE_WEB_PROFILE = Object.freeze({
  id: REMOTE_WEB_PROFILE_ID,
  displayName: 'Antigravity Remote Web',
  compatibleHostProfiles: Object.freeze(['antigravity-desktop']),
  supportedCapabilities: Object.freeze(['renderer']),
  allowedOrigins: DEFAULT_ALLOWED_ORIGINS,
  excludedUrlProtocols: DEFAULT_EXCLUDED_URL_PROTOCOLS,
  trustedTypesPolicyName: DEFAULT_TRUSTED_TYPES_POLICY_NAME,
  storageNamespace: DEFAULT_STORAGE_NAMESPACE,
  extraNoTranslateAttributes: Object.freeze(['data-agy-no-translate']),
  uiAnchors: REMOTE_WEB_UI_ANCHORS,
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
  });
}

module.exports = {
  REMOTE_WEB_PROFILE_ID,
  DEFAULT_ALLOWED_ORIGINS,
  DEFAULT_EXCLUDED_URL_PROTOCOLS,
  DEFAULT_TRUSTED_TYPES_POLICY_NAME,
  DEFAULT_STORAGE_NAMESPACE,
  REMOTE_WEB_UI_ANCHORS,
  resolveAntigravityRemoteWebPaths,
  toBrowserRemoteWebProfile,
  ANTIGRAVITY_REMOTE_WEB_PROFILE,
};
