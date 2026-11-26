'use strict';

/**
 * 1-Major Backward-Compatibility Adapter (`createV2CompatAdapter(v3, legacy)`) — v3.0.0.
 *
 * Preserves 100% of the v2.x flat 21-method `addonHost` API contract for existing
 * AddonManifest v1/v2 plugins throughout `v3.x` (planned removal: `v4.0.0`), while
 * delegating shared primitives directly to `AddonContextV3`.
 */

const _ObjectFreeze = Object.freeze;
const _ReflectApply = Reflect.apply;

function createV2CompatAdapter(v3Context, legacy = {}) {
  const {
    hostProfileId = null,
    hasSettingsBridge = false,
    hasConfigBridge = false,
    configScopes = _ObjectFreeze([]),
    mountSlot,
    unmountSlot,
    openModal,
    openPopover,
    observeRegion,
    registerSettingsTab,
    isElementInsideIgnored,
    getSettings,
    onSettingsChange,
    saveSettings,
    readConfigScope,
    writeConfigScope,
  } = legacy;

  return _ObjectFreeze({
    pluginId: v3Context.meta.pluginId,
    version: v3Context.meta.version,
    trustLevel: v3Context.meta.trustLevel,
    hostProfileId,
    schemaVersion: 2,
    sourceSchemaVersion: v3Context.meta.sourceSchemaVersion,
    hasSettingsBridge,
    hasConfigBridge,
    configScopes,
    // Opt-in bridge allowing v2 plugins to adopt v3 APIs incrementally during migration
    v3: v3Context,

    mountSlot(slotId, opts) {
      return mountSlot(slotId, opts);
    },
    unmountSlot(slotId) {
      return unmountSlot(slotId);
    },
    injectStyle(styleId, cssText, opts) {
      return v3Context.ui.injectStyle(styleId, cssText, opts);
    },
    removeStyle(styleId) {
      return v3Context.ui.removeStyle(styleId);
    },
    openModal(slotId, opts) {
      return openModal(slotId, opts);
    },
    openPopover(slotId, opts) {
      return openPopover(slotId, opts);
    },
    getSurfaceBounds(surfaceIdOrOpts) {
      return v3Context.ui.getSurfaceBounds(surfaceIdOrOpts);
    },
    getActiveSurface() {
      return v3Context.ui.getActiveSurface();
    },
    listSurfaces() {
      return v3Context.ui.listSurfaces();
    },
    observeRegion(selector, callback, opts) {
      return observeRegion(selector, callback, opts);
    },
    registerSettingsTab(tabId, opts) {
      return registerSettingsTab(tabId, opts);
    },
    registerAction(actionId, spec) {
      return v3Context.ui.registerCommand(actionId, spec);
    },
    listActions() {
      return v3Context.ui.listCommands();
    },
    invokeAction() {
      return _ReflectApply(v3Context.ui.invokeCommand, v3Context.ui, arguments);
    },
    isElementInsideIgnored(nodeOrEvent, opts) {
      return isElementInsideIgnored(nodeOrEvent, opts);
    },
    getSettings() {
      return getSettings();
    },
    onSettingsChange(callback) {
      return onSettingsChange(callback);
    },
    saveSettings(nextData) {
      return saveSettings(nextData);
    },
    readConfigScope(scopeId) {
      return readConfigScope(scopeId);
    },
    writeConfigScope(scopeId, nextDataOrRawJson, opts) {
      return writeConfigScope(scopeId, nextDataOrRawJson, opts);
    },
    addManagedListener(target, type, listener, opts) {
      return v3Context.lifecycle.addManagedListener(target, type, listener, opts);
    },
    runSafe(fn) {
      return v3Context.lifecycle.runSafe(fn);
    },
    onDispose(fn) {
      return v3Context.lifecycle.onDispose(fn);
    },
    dispose() {
      return v3Context.lifecycle.dispose();
    },
  });
}

module.exports = {
  createV2CompatAdapter,
};
