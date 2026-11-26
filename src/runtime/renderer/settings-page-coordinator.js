'use strict';

/**
 * Vendor-neutral Unified Settings Page Coordinator for Tier-1 `ui.registerSettingsPage` (v3.0.0 — SOLID #0).
 *
 * - Bridges both Desktop Settings sidebar tabs (`settingsTabs`) AND Remote Web Drawer settings tabs
 *   through a single declarative API.
 * - Supports either a Tier-2 declarative JSON `schema` (with `state`, `onChange`, `onAction`)
 *   OR a Tier-3 Shadow-DOM `render(canvasRoot)` callback.
 * - Opens inside a host-managed modal/panel surface when triggered from Remote Web or Desktop
 *   without requiring plugins to query or mutate host Settings DOM directly.
 */

function createSettingsPageCoordinator({ settingsTabs = null, openTier2Modal = null, openTier3Modal = null } = {}) {
  const pagesByKey = new Map(); // `${pluginId}:${pageId}` -> record

  function registerSettingsPage(pluginMeta, spec = {}) {
    if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string' || !spec.id.trim()) {
      throw new Error('ERR_INVALID_SETTINGS_PAGE_ID');
    }
    const pageId = spec.id.trim();
    const key = `${pluginMeta.pluginId}:${pageId}`;
    const title = String(spec.title || spec.label || pageId);
    const hasSchema = Boolean(spec.schema && typeof spec.schema === 'object');
    const hasRender = typeof spec.render === 'function';
    if (!hasSchema && !hasRender) {
      throw new Error('ERR_SETTINGS_PAGE_REQUIRES_SCHEMA_OR_RENDER');
    }

    let activeModalHandle = null;
    const openPage = () => {
      if (activeModalHandle && typeof activeModalHandle.close === 'function') {
        try {
          activeModalHandle.close();
        } catch (_e) {}
        activeModalHandle = null;
      }
      if (hasSchema && typeof openTier2Modal === 'function') {
        activeModalHandle = openTier2Modal(pluginMeta, {
          title,
          placement: { zone: 'surface-center', width: spec.width || 560 },
          tree: typeof spec.getSchema === 'function' ? spec.getSchema() : spec.schema,
          state: typeof spec.getState === 'function' ? spec.getState() : spec.state || {},
          onChange: spec.onChange || null,
          onAction: spec.onAction || null,
          onClose: () => {
            activeModalHandle = null;
            if (typeof spec.onClose === 'function') spec.onClose();
          },
        });
        return activeModalHandle;
      }
      if (hasRender && typeof openTier3Modal === 'function') {
        activeModalHandle = openTier3Modal(pluginMeta, {
          title,
          placement: { zone: 'surface-center', width: spec.width || 560 },
          onClose: () => {
            activeModalHandle = null;
            if (typeof spec.onClose === 'function') spec.onClose();
          },
        });
        if (activeModalHandle && activeModalHandle.bodyEl) {
          spec.render(activeModalHandle.bodyEl, activeModalHandle);
        }
        return activeModalHandle;
      }
      return null;
    };

    let tabHandle = null;
    if (settingsTabs && typeof settingsTabs.registerSettingsTab === 'function') {
      tabHandle = settingsTabs.registerSettingsTab(pluginMeta.pluginId, pageId, {
        label: title,
        onSelect: () => openPage(),
      });
    }

    const record = {
      key,
      pluginId: pluginMeta.pluginId,
      id: pageId,
      title,
      order: Number.isFinite(Number(spec.order)) ? Number(spec.order) : 100,
      kind: hasSchema ? 'schema' : 'canvas',
      openPage,
      tabHandle,
    };
    pagesByKey.set(key, record);

    return Object.freeze({
      id: pageId,
      open: openPage,
      update(nextSchema, nextState) {
        if (nextSchema && typeof nextSchema === 'object') spec.schema = nextSchema;
        if (nextState && typeof nextState === 'object') spec.state = nextState;
        if (activeModalHandle && typeof activeModalHandle.update === 'function') {
          activeModalHandle.update(nextSchema || spec.schema, nextState);
        }
      },
      dispose() {
        if (activeModalHandle && typeof activeModalHandle.close === 'function') {
          try {
            activeModalHandle.close();
          } catch (_e) {}
          activeModalHandle = null;
        }
        if (tabHandle && typeof tabHandle.unregister === 'function') {
          try {
            tabHandle.unregister();
          } catch (_e) {}
        }
        pagesByKey.delete(key);
      },
    });
  }

  function listSettingsPages() {
    return Array.from(pagesByKey.values())
      .sort((a, b) => (a.order !== b.order ? a.order - b.order : a.key < b.key ? -1 : 1))
      .map((r) =>
        Object.freeze({
          pluginId: r.pluginId,
          id: r.id,
          title: r.title,
          order: r.order,
          kind: r.kind,
        })
      );
  }

  function openSettingsPage(pluginId, pageId) {
    const rec = pagesByKey.get(`${pluginId}:${pageId}`);
    if (!rec) return { ok: false, reason: 'ERR_SETTINGS_PAGE_NOT_FOUND' };
    const handle = rec.openPage();
    return { ok: true, handle };
  }

  function disposePlugin(pluginId) {
    for (const [key, rec] of Array.from(pagesByKey.entries())) {
      if (rec.pluginId !== pluginId) continue;
      if (rec.tabHandle && typeof rec.tabHandle.unregister === 'function') {
        try {
          rec.tabHandle.unregister();
        } catch (_e) {}
      }
      pagesByKey.delete(key);
    }
  }

  return Object.freeze({
    registerSettingsPage,
    listSettingsPages,
    openSettingsPage,
    disposePlugin,
  });
}

module.exports = {
  createSettingsPageCoordinator,
};
