'use strict';

/**
 * Main Process Entry (`initMain(app, cfg)`) — v2.0.0 Runtime Orchestrator.
 *
 * - Guarded by `globalThis[MAIN_INIT_SYMBOL]` for 100% idempotency across
 *   repeated invocations or dual-transport safety.
 * - Zero writes inside `~/.gemini/config/plugins/` (read-only manifest & config inspection).
 * - Wires PortalArbiter (pre-whenReady), PreloadRegistrar (defaultSession post-whenReady),
 *   HostOriginResolver, MainHookRunner, and RendererInjector.
 */

const fs = require('node:fs');
const path = require('node:path');
const { MAIN_INIT_SYMBOL, ISOLATED_WORLD_ID, IPC_CHANNELS } = require('../shared/constants');
const { parseSafeJson } = require('../shared/safe-json');
const { createPreloadRegistrar } = require('./preload-registrar');
const { createHostOriginResolver } = require('./host-origin-resolver');
const { createPortalArbiter } = require('./portal-arbiter');
const { loadTrustPolicyFile } = require('./trust-verifier');
const { createMainHookRunner } = require('./main-hook-runner');
const { createSettingsBridge } = require('./settings-bridge');
const { createConfigBridge } = require('./config-bridge');
const { createHostAdminService } = require('./host-admin-service');
const { createRendererInjector } = require('./renderer-injector');
const { createUpdateSurvivalHook } = require('./update-survival-hook');
const { createNetFetchBroker } = require('./net-fetch-broker');
const { planAddonExecution } = require('../../core/lifecycle-coordinator');
const { createNodeFileSystemPort } = require('../../adapters/node-fs-port');
const { isPluginEnabledInConfig } = require('../../adapters/electron/config-reader');

function loadRawManifestsFromDir(addonsDir) {
  const entries = [];
  if (!addonsDir || !fs.existsSync(addonsDir)) return entries;
  let names = [];
  try {
    names = fs.readdirSync(addonsDir).sort();
  } catch (_err) {
    return entries;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(addonsDir, name);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      const manifest = parseSafeJson(fs.readFileSync(full, 'utf8'));
      entries.push({ source: full, manifest });
    } catch (err) {
      entries.push({
        source: full,
        manifest: null,
        parseError: err && err.message ? err.message : String(err),
      });
    }
  }
  return entries;
}

function createHostRuntimeController(cfg, deps = {}) {
  const electron = deps.electron || require('electron');
  const app = deps.app || electron.app;
  const sessionModule = deps.session || electron.session;
  const ipcMain = deps.ipcMain || electron.ipcMain;
  const fsPort = deps.fsPort || createNodeFileSystemPort();

  const diagnostics = [];
  const lifecycleStates = new Map();

  function recordDiag(level, code, detail) {
    diagnostics.push({ ts: new Date().toISOString(), level, code, detail: String(detail || '') });
    if (diagnostics.length > 200) diagnostics.shift();
  }

  const profile = cfg.profile || {};
  const strictTrustPolicy = cfg.strictTrustPolicy !== false;
  const worldId =
    Number.isInteger(cfg.isolatedWorldId) && cfg.isolatedWorldId > 0 && cfg.isolatedWorldId !== 999
      ? cfg.isolatedWorldId
      : ISOLATED_WORLD_ID;

  function resolveDefaultAsset(relFromDistRoot, relFromSrcRuntimeMain) {
    const fromDist = path.resolve(__dirname, '..', '..', '..', relFromDistRoot);
    if (fs.existsSync(fromDist)) return fromDist;
    return path.resolve(__dirname, relFromSrcRuntimeMain);
  }

  const preloadPath =
    cfg.preloadBridgePath || resolveDefaultAsset('preload/preload-bridge.cjs', '../preload/preload-bridge.js');
  const kernelBundlePath =
    cfg.kernelBundlePath || resolveDefaultAsset('renderer/kernel-bundle.cjs', '../renderer/kernel-bundle.cjs');

  let cachedKernelSource = typeof cfg.kernelBundleSource === 'string' ? cfg.kernelBundleSource : null;
  function readKernelSource() {
    if (cachedKernelSource !== null) return cachedKernelSource;
    if (fs.existsSync(kernelBundlePath)) {
      cachedKernelSource = fs.readFileSync(kernelBundlePath, 'utf8');
      return cachedKernelSource;
    }
    return '';
  }

  function readCurrentPolicy() {
    const res = loadTrustPolicyFile(cfg.trustPolicyPath);
    if (!res.ok) recordDiag('warn', res.reason, res.error || '');
    return res.policy;
  }

  function planCurrentAddons() {
    const rawEntries = loadRawManifestsFromDir(cfg.addonsDir);
    return planAddonExecution(rawEntries, {
      pluginsRootDir: cfg.pluginsRootDir,
      checkFilesExist: true,
      hostProfileId: profile.id || null,
      compatibleHostProfiles: profile.compatibleHostProfiles || null,
      supportedCapabilities: profile.supportedCapabilities || null,
      hostVersion: cfg.hostVersion || '3.0.0',
      strictTrustPolicy,
      forbiddenNetHosts: Array.isArray(profile.forbiddenNetHosts) ? profile.forbiddenNetHosts : [],
      fsPort,
      isEnabled: (pluginId) => isPluginEnabledInConfig(cfg.configJsonPath, pluginId),
    });
  }

  const portalArbiter = createPortalArbiter({
    ipcMain,
    portalBridge: profile.portalBridge || null,
    recordDiag,
  });

  const updateSurvivalHook = createUpdateSurvivalHook({
    updateSurvival: profile.updateSurvival || null,
    hostDataDir: cfg.settingsDataDir || (cfg.addonsDir ? path.dirname(path.resolve(cfg.addonsDir)) : null),
    platform: deps.platform || process.platform,
    moduleApi: deps.moduleApi,
    spawnFn: deps.spawnFn,
    sleepSyncFn: deps.sleepSyncFn,
    recordDiag,
  });

  const preloadRegistrar = createPreloadRegistrar({
    app,
    sessionModule,
    preloadPath,
    recordDiag,
  });

  const originResolver = createHostOriginResolver({
    profile,
    getDefaultSession: () => (app && typeof app.isReady === 'function' && app.isReady() && sessionModule ? sessionModule.defaultSession : null),
    devUrl: cfg.devUrl || null,
    recordDiag,
  });

  const mainHookRunner = createMainHookRunner({
    pluginsRootDir: cfg.pluginsRootDir,
    strictTrustPolicy,
    mainHookTimeoutMs: cfg.mainHookTimeoutMs || 5000,
    recordDiag,
    lifecycleStates,
  });

  const settingsDataDir =
    cfg.settingsDataDir || (cfg.addonsDir ? path.dirname(path.resolve(cfg.addonsDir)) : null);
  let rendererInjectorRef = null;
  const settingsBridge = createSettingsBridge({
    settingsDataDir,
    reservedFilePaths: [cfg.trustPolicyPath, cfg.configJsonPath].filter(Boolean),
    debounceMs: cfg.settingsWatchDebounceMs,
    onSnapshotChange: (pluginId, snapshot) => {
      if (rendererInjectorRef) {
        rendererInjectorRef.pushSettingsUpdate(pluginId, snapshot);
      }
    },
    recordDiag,
  });

  const configBridge = createConfigBridge({
    configScopes: cfg.configScopes || {},
    reservedFilePaths: [cfg.trustPolicyPath, cfg.configJsonPath].filter(Boolean),
    recordDiag,
  });

  const netFetchBroker = createNetFetchBroker({
    forbiddenHosts: Array.isArray(profile.forbiddenNetHosts) ? profile.forbiddenNetHosts : [],
    namedLoopbackTargets:
      profile.namedLoopbackTargets && typeof profile.namedLoopbackTargets === 'object'
        ? profile.namedLoopbackTargets
        : {},
    lookupFn: deps.netLookupFn || null,
    httpModule: deps.httpModule,
    httpsModule: deps.httpsModule,
    recordDiag,
  });

  const hostAdminService = createHostAdminService({
    hostVersion: cfg.hostVersion || '3.0.0',
    buildSha8: cfg.buildSha8 || 'dev',
    profile,
    addonsDir: cfg.addonsDir,
    pluginsRootDir: cfg.pluginsRootDir,
    remotePrefsPath: cfg.remotePrefsPath || null,
    remoteDistDir: cfg.remoteDistDir || null,
    strictTrustPolicy,
    fsPort,
    isEnabledInDesktopConfig: (pluginId) => isPluginEnabledInConfig(cfg.configJsonPath, pluginId),
    loadRawManifests: loadRawManifestsFromDir,
    planDesktopAddons: planCurrentAddons,
    readCurrentPolicy,
    getLifecycleStates: () => Object.fromEntries(lifecycleStates.entries()),
    recordDiag,
  });

  const rendererInjector = createRendererInjector({
    kernelBundleSource: readKernelSource,
    originResolver,
    profile,
    worldId,
    strictTrustPolicy,
    rendererExecTimeoutMs: cfg.rendererExecTimeoutMs || 10000,
    planProvider: planCurrentAddons,
    policyProvider: readCurrentPolicy,
    settingsBridge,
    recordDiag,
    lifecycleStates,
  });
  rendererInjectorRef = rendererInjector;

  let ipcRegistered = false;
  function registerIpcHandlers() {
    if (ipcRegistered || !ipcMain) return;
    ipcRegistered = true;

    if (typeof ipcMain.on === 'function') {
      ipcMain.on(IPC_CHANNELS.VERIFY_FRAME, (ev) => {
        try {
          const decision = originResolver.verifyFrameEvent(ev);
          ev.returnValue = decision && decision.ok ? { ...decision, worldId } : decision;
        } catch (err) {
          recordDiag('warn', 'VERIFY_FRAME_ERR', err && err.message ? err.message : String(err));
          ev.returnValue = { ok: false, reason: 'ERR_VERIFY_FRAME_INTERNAL' };
        }
      });

      ipcMain.on(IPC_CHANNELS.CLAIM_NONCE, (ev, nonce) => {
        try {
          ev.returnValue = originResolver.consumeClaimNonce(ev, nonce);
        } catch (err) {
          recordDiag('warn', 'CLAIM_NONCE_ERR', err && err.message ? err.message : String(err));
          ev.returnValue = { ok: false, reason: 'ERR_CLAIM_NONCE_INTERNAL' };
        }
      });

      ipcMain.on(IPC_CHANNELS.REPORT_ERROR, (ev, payload) => {
        if (!payload || typeof payload !== 'object') return;
        const check = originResolver.verifyClaimedEvent(ev, payload.docGenId);
        if (!check.ok) return;
        rendererInjector.recordRendererError(payload.pluginId, payload.detail);
      });
    }

    if (typeof ipcMain.handle === 'function') {
      ipcMain.handle(IPC_CHANNELS.PORTAL_CLAIM, (ev, payload) => {
        if (!payload || typeof payload !== 'object') return { ok: false, reason: 'ERR_INVALID_PAYLOAD' };
        const check = originResolver.verifyClaimedEvent(ev, payload.docGenId);
        if (!check.ok) return { ok: false, reason: check.reason || 'ERR_INVALID_PAYLOAD' };
        return portalArbiter.setPluginClaim(ev.sender, payload.claimId, Boolean(payload.active));
      });

      ipcMain.handle(IPC_CHANNELS.SAVE_SETTINGS, (ev, payload) => {
        if (!payload || typeof payload !== 'object') {
          return { ok: false, reason: 'ERR_INVALID_PAYLOAD', snapshot: null };
        }
        const check = originResolver.verifyClaimedEvent(ev, payload.docGenId);
        if (!check.ok) {
          return { ok: false, reason: check.reason || 'ERR_INVALID_PAYLOAD', snapshot: null };
        }
        const pluginId = typeof payload.pluginId === 'string' ? payload.pluginId : '';
        const rawJson = typeof payload.rawJson === 'string' ? payload.rawJson : null;
        if (!pluginId || rawJson === null) {
          return { ok: false, reason: 'ERR_INVALID_PAYLOAD', snapshot: null };
        }
        const wcId = ev && ev.sender && typeof ev.sender.id === 'number' ? ev.sender.id : null;
        const binding = wcId !== null ? rendererInjector.getTrustedSettingsBinding(wcId, pluginId) : null;
        if (!binding) {
          return { ok: false, reason: 'ERR_SETTINGS_BRIDGE_NOT_BOUND', snapshot: null };
        }
        return settingsBridge.writeSnapshotForPlugin(binding.pluginId, binding, rawJson);
      });

      ipcMain.handle(IPC_CHANNELS.CONFIG_READ, (ev, payload) => {
        if (!payload || typeof payload !== 'object') {
          return { ok: false, scopeId: '', status: 'error', data: null, rawText: null, sha256: null, reason: 'ERR_INVALID_PAYLOAD' };
        }
        const check = originResolver.verifyClaimedEvent(ev, payload.docGenId);
        if (!check.ok) {
          return {
            ok: false,
            scopeId: typeof payload.scopeId === 'string' ? payload.scopeId : '',
            status: 'error',
            data: null,
            rawText: null,
            sha256: null,
            reason: check.reason || 'ERR_INVALID_PAYLOAD',
          };
        }
        const pluginId = typeof payload.pluginId === 'string' ? payload.pluginId : '';
        const scopeId = typeof payload.scopeId === 'string' ? payload.scopeId : '';
        if (!pluginId || !scopeId) {
          return { ok: false, scopeId, status: 'error', data: null, rawText: null, sha256: null, reason: 'ERR_INVALID_PAYLOAD' };
        }
        const wcId = ev && ev.sender && typeof ev.sender.id === 'number' ? ev.sender.id : null;
        const binding = wcId !== null ? rendererInjector.getTrustedConfigBinding(wcId, pluginId) : null;
        if (!binding) {
          return { ok: false, scopeId, status: 'error', data: null, rawText: null, sha256: null, reason: 'ERR_CONFIG_BRIDGE_NOT_BOUND' };
        }
        return configBridge.readScopeForPlugin(binding.pluginId, binding, scopeId);
      });

      ipcMain.handle(IPC_CHANNELS.CONFIG_WRITE, (ev, payload) => {
        if (!payload || typeof payload !== 'object') {
          return { ok: false, reason: 'ERR_INVALID_PAYLOAD', currentSha256: null, snapshot: null };
        }
        const check = originResolver.verifyClaimedEvent(ev, payload.docGenId);
        if (!check.ok) {
          return { ok: false, reason: check.reason || 'ERR_INVALID_PAYLOAD', currentSha256: null, snapshot: null };
        }
        const pluginId = typeof payload.pluginId === 'string' ? payload.pluginId : '';
        const scopeId = typeof payload.scopeId === 'string' ? payload.scopeId : '';
        const rawJson = typeof payload.rawJson === 'string' ? payload.rawJson : null;
        if (!pluginId || !scopeId || rawJson === null) {
          return { ok: false, reason: 'ERR_INVALID_PAYLOAD', currentSha256: null, snapshot: null };
        }
        const wcId = ev && ev.sender && typeof ev.sender.id === 'number' ? ev.sender.id : null;
        const binding = wcId !== null ? rendererInjector.getTrustedConfigBinding(wcId, pluginId) : null;
        if (!binding) {
          return { ok: false, reason: 'ERR_CONFIG_BRIDGE_NOT_BOUND', currentSha256: null, snapshot: null };
        }
        const opts = {};
        if (Object.prototype.hasOwnProperty.call(payload, 'expectedSha256') && payload.expectedSha256 !== undefined) {
          opts.expectedSha256 = payload.expectedSha256;
        }
        return configBridge.writeScopeForPlugin(binding.pluginId, binding, scopeId, rawJson, opts);
      });

      ipcMain.handle(IPC_CHANNELS.HOST_ADMIN_STATE, (ev, payload) => {
        const check = originResolver.verifyClaimedEvent(ev, payload && payload.docGenId);
        if (!check.ok) {
          return { ok: false, reason: check.reason || 'ERR_INVALID_PAYLOAD' };
        }
        return hostAdminService.getState();
      });

      ipcMain.handle(IPC_CHANNELS.HOST_ADMIN_SET_REMOTE_PREF, (ev, payload) => {
        if (!payload || typeof payload !== 'object') {
          return { ok: false, reason: 'ERR_INVALID_PAYLOAD', state: null };
        }
        const check = originResolver.verifyClaimedEvent(ev, payload.docGenId);
        if (!check.ok) {
          return { ok: false, reason: check.reason || 'ERR_INVALID_PAYLOAD', state: null };
        }
        return hostAdminService.setRemoteAddonPreference(payload.pluginId, Boolean(payload.enabled));
      });

      ipcMain.handle(IPC_CHANNELS.NET_FETCH, (ev, payload) => {
        if (!payload || typeof payload !== 'object') {
          return { ok: false, reason: 'ERR_INVALID_PAYLOAD' };
        }
        const check = originResolver.verifyClaimedEvent(ev, payload.docGenId);
        if (!check.ok) {
          return { ok: false, reason: check.reason || 'ERR_INVALID_PAYLOAD' };
        }
        const pluginId = typeof payload.pluginId === 'string' ? payload.pluginId : '';
        const url = typeof payload.url === 'string' ? payload.url : '';
        if (!pluginId || !url) {
          return { ok: false, reason: 'ERR_INVALID_PAYLOAD' };
        }
        const wcId = ev && ev.sender && typeof ev.sender.id === 'number' ? ev.sender.id : null;
        const binding = wcId !== null ? rendererInjector.getPluginNetBinding(wcId, pluginId) : null;
        if (!binding) {
          return { ok: false, reason: 'ERR_NET_NOT_DECLARED' };
        }
        return netFetchBroker.fetchForPlugin(binding, url, {
          method: payload.method,
          headers: payload.headers,
          body: payload.body,
          timeoutMs: payload.timeoutMs,
        });
      });

      ipcMain.handle(IPC_CHANNELS.PING, (ev, payload) => {
        const check = originResolver.verifyClaimedEvent(ev, payload && payload.docGenId);
        if (!check.ok) return { ok: false, reason: check.reason };
        return { ok: true, docGenId: check.docGenId, worldId };
      });
    }
  }

  function attachWebContents(contents) {
    if (!contents) return;
    portalArbiter.attachWebContentsLifecycle(contents);
    rendererInjector.attachWebContents(contents);
  }

  let started = false;
  function start() {
    if (started) return controller;
    started = true;

    // 1. Install PortalArbiter BEFORE app.whenReady() so we capture host's portal overlay channel
    portalArbiter.install();
    // 1b. Install Layer-1 fail-open update survival hook BEFORE updater module loads
    updateSurvivalHook.install();
    // 2. Register host v2 IPC endpoints
    registerIpcHandlers();
    // 3. Schedule defaultSession preload registration strictly AFTER app.whenReady()
    preloadRegistrar.ensureRegistered().catch((err) => {
      recordDiag('error', 'PRELOAD_SCHEDULE_ERR', err && err.message ? err.message : String(err));
    });
    // 4. Observe web-contents-created for eligible defaultSession webContents
    if (app && typeof app.on === 'function') {
      app.on('web-contents-created', (_ev, contents) => {
        attachWebContents(contents);
      });
      app.whenReady().then(() => {
        try {
          const plan = planCurrentAddons();
          const policy = readCurrentPolicy();
          mainHookRunner.reconcile(plan.active, policy);
        } catch (err) {
          recordDiag('error', 'MAIN_READY_RECONCILE_ERR', err && err.message ? err.message : String(err));
        }
      });
      app.on('will-quit', () => {
        updateSurvivalHook.dispose();
        settingsBridge.dispose();
        portalArbiter.dispose();
        mainHookRunner.disposeAll();
      });
    }

    return controller;
  }

  const controller = Object.freeze({
    start,
    attachWebContents,
    reconcileMainHooks: () => mainHookRunner.reconcile(planCurrentAddons().active, readCurrentPolicy()),
    collectRendererErrors: () => rendererInjector.collectRendererErrors(),
    getDiagnostics: () => diagnostics.slice(),
    getAddonLifecycleStates: () => Object.fromEntries(lifecycleStates.entries()),
    getPortalArbiterStatus: () => portalArbiter.getStatus(),
    getUpdateSurvivalStatus: () => updateSurvivalHook.getStatus(),
    getPreloadStatus: () => preloadRegistrar.getStatus(),
    getSettingsBridgeStatus: () => settingsBridge.getStatus(),
    getConfigBridgeStatus: () => configBridge.getStatus(),
    getHostAdminState: () => hostAdminService.getState(),
    setRemoteAddonPreference: (pluginId, enabled) => hostAdminService.setRemoteAddonPreference(pluginId, enabled),
    refreshSettingsBridge: () => settingsBridge.refreshNow(),
    dispose: () => {
      updateSurvivalHook.dispose();
      settingsBridge.dispose();
      portalArbiter.dispose();
      return mainHookRunner.disposeAll();
    },
  });

  return controller;
}

function initMain(app, cfg, deps = {}) {
  if (globalThis[MAIN_INIT_SYMBOL]) {
    return globalThis[MAIN_INIT_SYMBOL];
  }
  const controller = createHostRuntimeController(cfg, { ...deps, app });
  globalThis[MAIN_INIT_SYMBOL] = controller;
  controller.start();
  return controller;
}

module.exports = {
  loadRawManifestsFromDir,
  createHostRuntimeController,
  initMain,
};
