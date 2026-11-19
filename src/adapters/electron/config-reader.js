'use strict';

/**
 * Strictly Read-Only, Fail-Closed `config.json` Plugin Enabled Gate.
 * NEVER writes to host `config.json`.
 */

const fs = require('node:fs');

function isPluginEnabledInConfig(configJsonPath, pluginId) {
  if (!pluginId || typeof pluginId !== 'string') return false;
  try {
    if (!configJsonPath || !fs.existsSync(configJsonPath)) return true;
    const parsed = JSON.parse(fs.readFileSync(configJsonPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const entry = parsed.plugins && parsed.plugins[pluginId];
    if (entry && entry.enabled === false) return false;
    return true;
  } catch (_err) {
    // Fail-closed when an existing config.json is corrupted.
    return false;
  }
}

module.exports = {
  isPluginEnabledInConfig,
};
