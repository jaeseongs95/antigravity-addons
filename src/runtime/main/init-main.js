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
const { createRendererInjector } = require('./renderer-injector');
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
      hostVersion: cfg.hostVersion || '2.1.1',
      strictTrustPolicy,
      fsPort,
      isEnabled: (pluginId) => isPluginEnabledInConfig(cfg.configJsonPath, pluginId),
    });
  }

  const portalArbiter = createPortalArbiter({
    ipcMain,
    portalBridge: profile.portalBridge || null,
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

    // 1. Install PortalArbiter BEFORE app.whenReady() so we capture host's wcv:set-portal-overlay-open
    portalArbiter.install();
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
    getPreloadStatus: () => preloadRegistrar.getStatus(),
    getSettingsBridgeStatus: () => settingsBridge.getStatus(),
    refreshSettingsBridge: () => settingsBridge.refreshNow(),
    dispose: () => {
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
