'use strict';

/**
 * Fail-Open Settings Tab Coordinator with per-plugin cleanup.
 */

function createSettingsTabCoordinator() {
  const tabsByPlugin = new Map(); // pluginId -> Map<tabId, { tabId, label, onSelect }>

  function registerSettingsTab(pluginId, tabId, { label, onSelect } = {}) {
    if (!tabId || typeof tabId !== 'string') throw new Error('ERR_INVALID_TAB_ID');
    let map = tabsByPlugin.get(pluginId);
    if (!map) {
      map = new Map();
      tabsByPlugin.set(pluginId, map);
    }
    map.set(tabId, { tabId, label: String(label || tabId), onSelect: typeof onSelect === 'function' ? onSelect : null });
    return {
      unregister() {
        map.delete(tabId);
      },
    };
  }

  function listTabs() {
    const out = [];
    for (const [pluginId, map] of tabsByPlugin.entries()) {
      for (const tab of map.values()) {
        out.push({
          pluginId,
          tabId: tab.tabId,
          label: tab.label,
          selectable: typeof tab.onSelect === 'function',
        });
      }
    }
    return out;
  }

  function selectTab(pluginId, tabId) {
    if (typeof pluginId !== 'string' || !pluginId || typeof tabId !== 'string' || !tabId) {
      return { ok: false, reason: 'ERR_SETTINGS_TAB_NOT_FOUND' };
    }
    const map = tabsByPlugin.get(pluginId);
    const tab = map ? map.get(tabId) : null;
    if (!tab) {
      return { ok: false, reason: 'ERR_SETTINGS_TAB_NOT_FOUND' };
    }
    if (typeof tab.onSelect !== 'function') {
      return { ok: false, reason: 'ERR_SETTINGS_TAB_NOT_SELECTABLE' };
    }
    try {
      const result = tab.onSelect({ pluginId, tabId: tab.tabId, label: tab.label });
      return { ok: true, reason: null, result };
    } catch (err) {
      return {
        ok: false,
        reason: 'ERR_SETTINGS_TAB_SELECT_FAILED',
        error: err && err.message ? err.message : String(err),
      };
    }
  }

  function disposePluginTabs(pluginId) {
    tabsByPlugin.delete(pluginId);
  }

  return Object.freeze({
    registerSettingsTab,
    listTabs,
    selectTab,
    disposePluginTabs,
  });
}

module.exports = {
  createSettingsTabCoordinator,
};
