'use strict';

/**
 * Vendor-neutral Unified Settings Page Coordinator for Tier-1 `ui.registerSettingsPage` (v3.0.3 — SOLID #0).
 *
 * - Bridges both Desktop Settings sidebar tabs (`settingsTabs` + inline Desktop Settings pane host)
 *   AND Remote Web Drawer settings tabs through a single declarative API.
 * - Supports either a Tier-2 declarative JSON `schema` (with `state`, `onChange`, `onAction`)
 *   OR a Tier-3 Shadow-DOM `render(canvasRoot)` callback.
 * - When an inline Settings host (`setInlineHost`) is mounted (Desktop Settings view), renders
 *   registered plugin pages directly inline inside the Settings content pane like a native tab;
 *   otherwise falls back cleanly to a host-managed modal/panel overlay (Command Palette / Remote Web).
 */

function createSettingsPageCoordinator({ settingsTabs = null, openTier2Modal = null, openTier3Modal = null } = {}) {
  const pagesByKey = new Map(); // `${pluginId}:${pageId}` -> record
  const changeListeners = new Set();
  let inlineHost = null;
  let activePageKey = null;
  let activePageHandle = null;

  function notifyChange() {
    for (const fn of Array.from(changeListeners)) {
      try {
        fn();
      } catch (_e) {}
    }
  }

  function closeActiveHandle() {
    const prev = activePageHandle;
    activePageHandle = null;
    activePageKey = null;
    if (prev && typeof prev.close === 'function') {
      try {
        prev.close();
      } catch (_e) {}
    }
  }

  function setInlineHost(host) {
    if (host && typeof host.canMountInline === 'function' && typeof host.mountInlinePage === 'function') {
      inlineHost = host;
      return () => {
        if (inlineHost === host) inlineHost = null;
      };
    }
    inlineHost = null;
    return () => {};
  }

  function registerSettingsPage(pluginMeta, spec = {}) {
    if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string' || !spec.id.trim()) {
      throw new Error('ERR_INVALID_SETTINGS_PAGE_ID');
    }
    const pageId = spec.id.trim();
    const key = `${pluginMeta.pluginId}:${pageId}`;
    const title = String(spec.title || spec.label || pageId);
    const hasSchema = Boolean((spec.schema && typeof spec.schema === 'object') || typeof spec.getSchema === 'function');
    const hasRender = typeof spec.render === 'function';
    if (!hasSchema && !hasRender) {
      throw new Error('ERR_SETTINGS_PAGE_REQUIRES_SCHEMA_OR_RENDER');
    }

    const openPage = () => {
      closeActiveHandle();

      let openedHandle = null;
      const onClosed = () => {
        if (activePageHandle === openedHandle) {
          activePageHandle = null;
          activePageKey = null;
        }
      };

      if (inlineHost && typeof inlineHost.canMountInline === 'function' && inlineHost.canMountInline()) {
        openedHandle = inlineHost.mountInlinePage({
          pluginMeta,
          pageId,
          key,
          title,
          kind: hasSchema ? 'schema' : 'canvas',
          spec,
          onClosed,
        });
        if (openedHandle) {
          activePageHandle = openedHandle;
          activePageKey = key;
          return openedHandle;
        }
      }

      if (hasSchema && typeof openTier2Modal === 'function') {
        openedHandle = openTier2Modal(pluginMeta, {
          title,
          placement: { zone: 'surface-center', width: spec.width || 560 },
          tree: typeof spec.getSchema === 'function' ? spec.getSchema() : spec.schema,
          state: typeof spec.getState === 'function' ? spec.getState() : spec.state || {},
          onChange: spec.onChange || null,
          onAction: spec.onAction || null,
          onClose: () => {
            onClosed();
            if (typeof spec.onClose === 'function') spec.onClose();
          },
        });
        if (openedHandle) {
          activePageHandle = openedHandle;
          activePageKey = key;
        }
        return openedHandle;
      }
      if (hasRender && typeof openTier3Modal === 'function') {
        openedHandle = openTier3Modal(pluginMeta, {
          title,
          placement: { zone: 'surface-center', width: spec.width || 560 },
          onClose: () => {
            onClosed();
            if (typeof spec.onClose === 'function') spec.onClose();
          },
        });
        if (openedHandle) {
          activePageHandle = openedHandle;
          activePageKey = key;
          if (openedHandle.bodyEl) {
            spec.render(openedHandle.bodyEl, openedHandle);
          }
        }
        return openedHandle;
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
    notifyChange();

    return Object.freeze({
      id: pageId,
      open: openPage,
      update(nextSchema, nextState) {
        if (nextSchema && typeof nextSchema === 'object') spec.schema = nextSchema;
        if (nextState && typeof nextState === 'object') spec.state = nextState;
        if (activePageKey === key && activePageHandle && typeof activePageHandle.update === 'function') {
          activePageHandle.update(nextSchema || spec.schema, nextState);
        }
      },
      dispose() {
        if (activePageKey === key) {
          closeActiveHandle();
        }
        if (tabHandle && typeof tabHandle.unregister === 'function') {
          try {
            tabHandle.unregister();
          } catch (_e) {}
        }
        const deleted = pagesByKey.delete(key);
        if (deleted) notifyChange();
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
    let removed = false;
    for (const [key, rec] of Array.from(pagesByKey.entries())) {
      if (rec.pluginId !== pluginId) continue;
      if (activePageKey === key) {
        closeActiveHandle();
      }
      if (rec.tabHandle && typeof rec.tabHandle.unregister === 'function') {
        try {
          rec.tabHandle.unregister();
        } catch (_e) {}
      }
      if (pagesByKey.delete(key)) removed = true;
    }
    if (removed) notifyChange();
  }

  function onChange(listener) {
    if (typeof listener !== 'function') return () => {};
    changeListeners.add(listener);
    return () => {
      changeListeners.delete(listener);
    };
  }

  return Object.freeze({
    registerSettingsPage,
    listSettingsPages,
    openSettingsPage,
    setInlineHost,
    getActivePageKey: () => activePageKey,
    disposePlugin,
    onChange,
  });
}

module.exports = {
  createSettingsPageCoordinator,
};
