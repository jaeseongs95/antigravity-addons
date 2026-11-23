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
        out.push({ pluginId, tabId: tab.tabId, label: tab.label });
      }
    }
    return out;
  }

  function disposePluginTabs(pluginId) {
    tabsByPlugin.delete(pluginId);
  }

  return Object.freeze({
    registerSettingsTab,
    listTabs,
    disposePluginTabs,
  });
}

module.exports = {
  createSettingsTabCoordinator,
};
