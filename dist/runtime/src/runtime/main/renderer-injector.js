'use strict';

/**
 * Renderer Injector (T-A Option A1 + D-R4-2 Document-Generation Single-Claim).
 *
 * - Separates ONCE-per-document-generation kernel injection & `claim(nonce)` from
 *   idempotent plugin reconciliation (`did-finish-load`, `did-navigate-in-page`).
 * - Single-Buffer SHA-256 read-then-execute via `readVerifiedRendererScript`.
 * - Serializes per-`webContents` execution via `injectQueue` with `rendererExecTimeoutMs`.
 * - Preserves diagnostic/error inspection helpers (`collectRendererErrors`, `getDiagnostics`,
 *   `getAddonLifecycleStates`).
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const { ISOLATED_WORLD_ID, LIFECYCLE_STATES } = require('../shared/constants');
const { serializeSafeInlineJson } = require('../shared/safe-json');
const { readVerifiedRendererScript } = require('./trust-verifier');

function withExecTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let done = false;
    // Keep timeout ref'd until promise settles (clearTimeout always runs on resolve/reject; unref breaks Node 22 awaits on hanging promises)
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`ERR_RENDERER_EXEC_TIMEOUT:${label}:${timeoutMs}ms`));
    }, timeoutMs);
    Promise.resolve(promise).then(
      (v) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function createRendererInjector({
  kernelBundleSource,
  originResolver,
  profile = {},
  worldId = ISOLATED_WORLD_ID,
  strictTrustPolicy = true,
  rendererExecTimeoutMs = 10000,
  planProvider,
  policyProvider,
  settingsBridge = null,
  recordDiag = () => {},
  lifecycleStates = new Map(),
} = {}) {
  const queuesByWcId = new Map();
  const webContentsByWcId = new Map();
  const kernelGenByWcId = new Map(); // wcId -> claimed docGenId
  const hostTokensByWcId = new Map(); // wcId -> per-document-generation CSPRNG kernel auth token (SEC-02)
  const injectedPluginsByWcId = new Map(); // wcId -> Set<pluginId>
  const trustedSettingsByWcId = new Map(); // wcId -> Map<pluginId, { pluginId, fileName, maxBytes }>
  const trustedConfigByWcId = new Map(); // wcId -> Map<pluginId, { pluginId, scopes }>
  const deliveredSettingsKeyByWcId = new Map(); // wcId -> Map<pluginId, string> (I1: per-window delivery dedup)
  const lifecycleStatesByWcId = new Map(); // wcId -> Map<pluginId, state> (I10: multi-window state isolation)
  const navAttemptSeqByWcId = new Map(); // wcId -> incremented on did-start-navigation to abort in-flight loops without bricking live doc (R-1)

  function settingsDeliveryKey(snap) {
    if (!snap || typeof snap !== 'object') return 'null';
    return `${snap.revision || 0}:${snap.status || ''}:${snap.sha256 || ''}:${snap.reason || ''}`;
  }

  function setDeliveredSettingsKey(wcId, pluginId, snap) {
    let map = deliveredSettingsKeyByWcId.get(wcId);
    if (!map) {
      map = new Map();
      deliveredSettingsKeyByWcId.set(wcId, map);
    }
    map.set(pluginId, settingsDeliveryKey(snap));
  }

  function reaggregatePluginLifecycle(pluginId, fallbackState = null) {
    let aggregated = null;
    for (const m of lifecycleStatesByWcId.values()) {
      const s = m.get(pluginId);
      if (!s) continue;
      if (s === LIFECYCLE_STATES.ACTIVE) {
        aggregated = LIFECYCLE_STATES.ACTIVE;
        break;
      }
      if (s === LIFECYCLE_STATES.FAILED && aggregated !== LIFECYCLE_STATES.ACTIVE) {
        aggregated = LIFECYCLE_STATES.FAILED;
      } else if (aggregated === null) {
        aggregated = s;
      }
    }
    if (aggregated !== null) {
      lifecycleStates.set(pluginId, aggregated);
    } else if (fallbackState !== null) {
      lifecycleStates.set(pluginId, fallbackState);
    }
  }

  function setWindowLifecycleState(wcId, pluginId, state) {
    let wcMap = lifecycleStatesByWcId.get(wcId);
    if (!wcMap) {
      wcMap = new Map();
      lifecycleStatesByWcId.set(wcId, wcMap);
    }
    wcMap.set(pluginId, state);
    reaggregatePluginLifecycle(pluginId, state);
  }

  function clearWindowLifecycleStates(wcId) {
    const removed = lifecycleStatesByWcId.get(wcId);
    if (!removed) return;
    lifecycleStatesByWcId.delete(wcId);
    for (const pluginId of removed.keys()) {
      reaggregatePluginLifecycle(pluginId, null);
    }
  }
  const rendererErrors = [];

  function syncSettingsBridgeBindings() {
    if (!settingsBridge || typeof settingsBridge.syncPlugins !== 'function') return;
    const union = new Map();
    for (const map of trustedSettingsByWcId.values()) {
      for (const [pluginId, spec] of map.entries()) {
        if (!union.has(pluginId)) union.set(pluginId, spec);
      }
    }
    settingsBridge.syncPlugins(Array.from(union.values()));
  }

  function recordRendererError(pluginId, detail) {
    rendererErrors.push({
      ts: new Date().toISOString(),
      pluginId: String(pluginId || 'unknown').slice(0, 128),
      detail: String(detail || '').slice(0, 2048),
    });
    if (rendererErrors.length > 200) rendererErrors.shift();
  }

  function enqueue(wcId, task) {
    const prev = queuesByWcId.get(wcId) || Promise.resolve();
    const next = prev.then(task, task).catch((err) => {
      recordDiag('error', 'RENDERER_INJECT_QUEUE_ERR', err && err.message ? err.message : String(err));
    });
    queuesByWcId.set(wcId, next);
    return next;
  }

  async function execInWorld(contents, code, label) {
    if (!contents || (typeof contents.isDestroyed === 'function' && contents.isDestroyed())) {
      throw new Error('ERR_CONTENTS_DESTROYED');
    }
    return withExecTimeout(
      contents.executeJavaScriptInIsolatedWorld(worldId, [{ code }]),
      rendererExecTimeoutMs,
      label
    );
  }

  function getKernelSource() {
    if (typeof kernelBundleSource === 'function') return kernelBundleSource();
    if (typeof kernelBundleSource === 'string') return kernelBundleSource;
    return '';
  }

  async function ensureKernelForGeneration(contents, state) {
    const wcId = contents.id;
    if (kernelGenByWcId.get(wcId) === state.docGenId) {
      return { ok: true, alreadyBooted: true };
    }
    const nonce = state.activeNonce;
    const kernelSrc = getKernelSource();
    if (!kernelSrc) {
      return { ok: false, reason: 'ERR_KERNEL_SOURCE_MISSING' };
    }

    const hostToken = crypto.randomBytes(24).toString('hex');
    const kernelConfig = {
      docGenId: state.docGenId,
      hostProfileId: profile.id || null,
      claimNonce: nonce || null,
      hostToken,
      extraNoTranslateAttributes: Array.isArray(profile.extraNoTranslateAttributes) ? profile.extraNoTranslateAttributes : [],
      uiAnchors: profile.uiAnchors || {},
      worldId,
    };

    const bootCode = `(() => {
      const __CFG = ${JSON.stringify(kernelConfig)};
      ${kernelSrc}
      return globalThis.__addonHostKernel && globalThis.__addonHostKernel.boot(__CFG);
    })()`;

    const res = await execInWorld(contents, bootCode, `kernel:gen${state.docGenId}`);
    // Confirm document generation did not rotate mid-execution
    const latest = originResolver.getState(wcId);
    if (!latest || latest.docGenId !== state.docGenId) {
      return { ok: false, reason: 'ERR_NAVIGATION_ROTATED_MID_KERNEL_BOOT' };
    }
    if (!res || res.ok !== true) {
      return { ok: false, reason: (res && res.reason) || 'ERR_KERNEL_BOOT_FAILED' };
    }
    if (res.hasBridge === false) {
      recordDiag('warn', 'KERNEL_BOOT_NO_BRIDGE', `wcId=${wcId}: preload bridge absent at kernel boot`);
    }
    kernelGenByWcId.set(wcId, state.docGenId);
    hostTokensByWcId.set(wcId, hostToken);
    injectedPluginsByWcId.set(wcId, new Set());
    return { ok: true, alreadyBooted: false, hasBridge: Boolean(res.hasBridge) };
  }

  async function reconcilePluginsInDocument(contents, expectedGenId, expectedNavSeq) {
    const wcId = contents.id;
    const startNavSeq = expectedNavSeq !== undefined ? expectedNavSeq : navAttemptSeqByWcId.get(wcId) || 0;
    const isStillCurrent = () => {
      if ((navAttemptSeqByWcId.get(wcId) || 0) !== startNavSeq) return false;
      const latest = originResolver.getState(wcId);
      if (!latest || latest.docGenId !== expectedGenId) return false;
      const curUrl = typeof contents.getURL === 'function' ? contents.getURL() : latest.pinnedUrl;
      return originResolver.isAllowedUrl(curUrl);
    };
    if (!isStillCurrent()) return;

    const plan = planProvider();
    const policy = policyProvider();
    const activeRendererAddons = (plan.active || []).filter(
      (a) => a && a.resolvedEntries && a.resolvedEntries.rendererScript
    );
    const activeIds = new Set(activeRendererAddons.map((a) => a.pluginId));
    const injectedSet = injectedPluginsByWcId.get(wcId) || new Set();
    let trustedSettingsMap = trustedSettingsByWcId.get(wcId);
    if (!trustedSettingsMap) {
      trustedSettingsMap = new Map();
      trustedSettingsByWcId.set(wcId, trustedSettingsMap);
    }
    let trustedConfigMap = trustedConfigByWcId.get(wcId);
    if (!trustedConfigMap) {
      trustedConfigMap = new Map();
      trustedConfigByWcId.set(wcId, trustedConfigMap);
    }

    // Dispose any previously injected plugins that are now disabled/unregistered
    const hostToken = hostTokensByWcId.get(wcId) || null;
    try {
      for (const oldId of Array.from(injectedSet)) {
        if (!isStillCurrent()) return;
        if (!activeIds.has(oldId)) {
          try {
            await execInWorld(
              contents,
              `globalThis.__addonHostKernel && globalThis.__addonHostKernel.disposePlugin(${JSON.stringify(oldId)}, ${JSON.stringify(hostToken)})`,
              `dispose:${oldId}`
            );
            injectedSet.delete(oldId);
            trustedSettingsMap.delete(oldId);
            trustedConfigMap.delete(oldId);
            const delivMap = deliveredSettingsKeyByWcId.get(wcId);
            if (delivMap) delivMap.delete(oldId);
            setWindowLifecycleState(wcId, oldId, LIFECYCLE_STATES.DISPOSED);
          } catch (err) {
            if (!isStillCurrent()) return;
            recordRendererError(oldId, err && err.message ? err.message : String(err));
          }
        }
      }

      // Inject active plugins in deterministic loadOrder (Single-Buffer Read-Then-Execute + S-1 CSP-safe two-phase staged handle)
      for (const addon of activeRendererAddons) {
        if (!isStillCurrent()) return;
        if (injectedSet.has(addon.pluginId)) continue;

        const scriptPath = addon.resolvedEntries.rendererScript;
        if (!scriptPath || !fs.existsSync(scriptPath)) {
          recordDiag('warn', 'RENDERER_SCRIPT_MISSING', addon.pluginId);
          continue;
        }

        const verified = readVerifiedRendererScript(scriptPath, addon.manifest, policy, {
          strictTrustPolicy,
        });
        if (!verified.ok) {
          setWindowLifecycleState(wcId, addon.pluginId, LIFECYCLE_STATES.FAILED);
          recordDiag('warn', 'RENDERER_TRUST_REJECTED', `${addon.pluginId}: ${verified.reason}`);
          continue;
        }

        const settingsSpec =
          addon.manifest.settingsBridge &&
          typeof addon.manifest.settingsBridge === 'object' &&
          typeof addon.manifest.settingsBridge.fileName === 'string' &&
          addon.manifest.settingsBridge.fileName.length > 0
            ? addon.manifest.settingsBridge
            : null;
        const hasSettingsBridge = Boolean(settingsSpec && verified.effectiveTrustLevel === 'trusted');
        const initialSettingsSnapshot =
          hasSettingsBridge && settingsBridge && typeof settingsBridge.readSnapshotForPlugin === 'function'
            ? settingsBridge.readSnapshotForPlugin(addon.pluginId, settingsSpec)
            : null;

        const configSpec =
          addon.manifest.configBridge &&
          typeof addon.manifest.configBridge === 'object' &&
          Array.isArray(addon.manifest.configBridge.scopes) &&
          addon.manifest.configBridge.scopes.length > 0
            ? addon.manifest.configBridge
            : null;
        const hasConfigBridge = Boolean(configSpec && verified.effectiveTrustLevel === 'trusted');
        const configScopes = hasConfigBridge
          ? configSpec.scopes.map((s) => ({
              scopeId: s.scopeId,
              access: s.access,
              maxBytes: s.maxBytes,
            }))
          : [];

        const pluginMeta = {
          pluginId: addon.pluginId,
          version: addon.manifest.version,
          sourceSchemaVersion: addon.manifest.sourceSchemaVersion || 2,
          trustLevel: verified.effectiveTrustLevel,
          hasDocumentTransformSlot: Boolean(addon.hasDocumentTransformSlot),
          hasSettingsBridge,
          hasConfigBridge,
          configScopes,
          uiSlots: addon.manifest.uiSlots || [],
          isolation: addon.manifest.isolation || {},
        };

        // Phase 1 (Host-only): authenticate with hostToken and stage handle behind a single-use runNonce
        let stageRes;
        try {
          stageRes = await execInWorld(
            contents,
            `(() => {
              if (!globalThis.__addonHostKernel) return { ok: false, reason: 'NO_KERNEL' };
              return globalThis.__addonHostKernel.stagePluginHandle(${serializeSafeInlineJson(pluginMeta)}, ${JSON.stringify(hostToken)}, ${serializeSafeInlineJson(initialSettingsSnapshot)});
            })()`,
            `stage:${addon.pluginId}`
          );
        } catch (stageErr) {
          if (!isStillCurrent()) return;
          injectedSet.add(addon.pluginId);
          setWindowLifecycleState(wcId, addon.pluginId, LIFECYCLE_STATES.FAILED);
          recordRendererError(addon.pluginId, stageErr && stageErr.message ? stageErr.message : String(stageErr));
          continue;
        }

        if (!isStillCurrent()) {
          if (stageRes && stageRes.ok && stageRes.runNonce) {
            try {
              await execInWorld(
                contents,
                `globalThis.__addonHostKernel && globalThis.__addonHostKernel.clearStagedHandle(${JSON.stringify(stageRes.runNonce)}, ${JSON.stringify(hostToken)})`,
                `clear-staged-abort:${addon.pluginId}`
              );
            } catch (_c) {}
          }
          return;
        }

        if (!stageRes || !stageRes.ok || typeof stageRes.runNonce !== 'string') {
          injectedSet.add(addon.pluginId);
          setWindowLifecycleState(wcId, addon.pluginId, LIFECYCLE_STATES.FAILED);
          recordRendererError(addon.pluginId, (stageRes && stageRes.reason) || 'ERR_STAGE_HANDLE_FAILED');
          continue;
        }

        const runNonce = stageRes.runNonce;

        // Phase 2 (Plugin-only, ZERO hostToken in script text, strict mode, CSP-safe without new Function/eval)
        const runCode = `(async () => {
          'use strict';
          if (!globalThis.__addonHostKernel) return { ok: false, reason: 'NO_KERNEL' };
          const __h = globalThis.__addonHostKernel.consumeStagedHandle(${JSON.stringify(runNonce)});
          try {
            const __fn = (function(addonHost) {
              'use strict';
${verified.source}
            });
            const __ret = __fn(__h);
            if (__ret && typeof __ret.then === 'function') {
              await __ret;
            }
            return { ok: true };
          } catch (e) {
            try { __h.dispose(); } catch (_d) {}
            globalThis.__addonHostKernel.reportPluginError(${JSON.stringify(addon.pluginId)}, e && e.message ? e.message : String(e));
            return { ok: false, error: e && e.message ? e.message : String(e) };
          }
        })()`;

        if (hasConfigBridge) {
          // Bind before Phase 2 execution so verified trusted plugins can call readConfigScope during async startup.
          trustedConfigMap.set(addon.pluginId, {
            pluginId: addon.pluginId,
            scopes: configScopes,
          });
        }

        try {
          const execRes = await execInWorld(contents, runCode, `plugin:${addon.pluginId}`);
          if (!isStillCurrent()) {
            trustedConfigMap.delete(addon.pluginId);
            return;
          }
          if (execRes && execRes.ok) {
            injectedSet.add(addon.pluginId);
            if (hasSettingsBridge && settingsSpec) {
              trustedSettingsMap.set(addon.pluginId, {
                pluginId: addon.pluginId,
                fileName: settingsSpec.fileName,
                maxBytes: settingsSpec.maxBytes,
              });
              setDeliveredSettingsKey(wcId, addon.pluginId, initialSettingsSnapshot);
              // F1: Reconcile any settings file edit that arrived while async plugin startup ran
              if (settingsBridge && typeof settingsBridge.readSnapshotForPlugin === 'function') {
                const postSnap = settingsBridge.readSnapshotForPlugin(addon.pluginId, settingsSpec);
                if (
                  postSnap &&
                  settingsDeliveryKey(postSnap) !== settingsDeliveryKey(initialSettingsSnapshot)
                ) {
                  await execInWorld(
                    contents,
                    `globalThis.__addonHostKernel && globalThis.__addonHostKernel.pushPluginSettings(${JSON.stringify(addon.pluginId)}, ${serializeSafeInlineJson(postSnap)}, ${JSON.stringify(hostToken)})`,
                    `settings-catchup:${addon.pluginId}`
                  );
                  setDeliveredSettingsKey(wcId, addon.pluginId, postSnap);
                }
              }
            }
            setWindowLifecycleState(wcId, addon.pluginId, LIFECYCLE_STATES.ACTIVE);
          } else {
            injectedSet.add(addon.pluginId);
            trustedSettingsMap.delete(addon.pluginId);
            trustedConfigMap.delete(addon.pluginId);
            setWindowLifecycleState(wcId, addon.pluginId, LIFECYCLE_STATES.FAILED);
            recordRendererError(addon.pluginId, (execRes && execRes.error) || 'ERR_PLUGIN_EXEC');
            try {
              await execInWorld(
                contents,
                `globalThis.__addonHostKernel && (globalThis.__addonHostKernel.clearStagedHandle(${JSON.stringify(runNonce)}, ${JSON.stringify(hostToken)}), globalThis.__addonHostKernel.disposePlugin(${JSON.stringify(addon.pluginId)}, ${JSON.stringify(hostToken)}))`,
                `dispose-after-fail:${addon.pluginId}`
              );
            } catch (_disposeErr) {}
          }
        } catch (err) {
          trustedConfigMap.delete(addon.pluginId);
          if (!isStillCurrent()) return;
          injectedSet.add(addon.pluginId);
          trustedSettingsMap.delete(addon.pluginId);
          setWindowLifecycleState(wcId, addon.pluginId, LIFECYCLE_STATES.FAILED);
          recordRendererError(addon.pluginId, err && err.message ? err.message : String(err));
          try {
            await execInWorld(
              contents,
              `globalThis.__addonHostKernel && (globalThis.__addonHostKernel.clearStagedHandle(${JSON.stringify(runNonce)}, ${JSON.stringify(hostToken)}), globalThis.__addonHostKernel.disposePlugin(${JSON.stringify(addon.pluginId)}, ${JSON.stringify(hostToken)}))`,
              `dispose-after-err:${addon.pluginId}`
            );
          } catch (_disposeErr) {}
        }
      }

      injectedPluginsByWcId.set(wcId, injectedSet);
    } finally {
      syncSettingsBridgeBindings();
    }
  }

  function pushSettingsUpdate(pluginId, snapshot) {
    const nextKey = settingsDeliveryKey(snapshot);
    const tasks = [];
    for (const [wcId, map] of trustedSettingsByWcId.entries()) {
      if (!map || !map.has(pluginId)) continue;
      const contents = webContentsByWcId.get(wcId);
      if (!contents) continue;
      tasks.push(
        enqueue(wcId, async () => {
          if (typeof contents.isDestroyed === 'function' && contents.isDestroyed()) return;
          const activeMap = trustedSettingsByWcId.get(wcId);
          if (!activeMap || !activeMap.has(pluginId)) return;
          const delivMap = deliveredSettingsKeyByWcId.get(wcId);
          if (delivMap && delivMap.get(pluginId) === nextKey) return;
          const genId = kernelGenByWcId.get(wcId);
          const hostToken = hostTokensByWcId.get(wcId);
          const latest = originResolver.getState(wcId);
          if (!genId || !hostToken || !latest || latest.docGenId !== genId) return;
          const curUrl = typeof contents.getURL === 'function' ? contents.getURL() : latest.pinnedUrl;
          if (!originResolver.isAllowedUrl(curUrl)) return;
          try {
            await execInWorld(
              contents,
              `globalThis.__addonHostKernel && globalThis.__addonHostKernel.pushPluginSettings(${JSON.stringify(pluginId)}, ${serializeSafeInlineJson(snapshot)}, ${JSON.stringify(hostToken)})`,
              `settings-push:${pluginId}`
            );
            setDeliveredSettingsKey(wcId, pluginId, snapshot);
          } catch (err) {
            recordDiag('warn', 'SETTINGS_PUSH_ERR', `${pluginId}@wc${wcId}: ${err && err.message ? err.message : String(err)}`);
          }
        })
      );
    }
    return Promise.allSettled(tasks);
  }

  function scheduleSync(contents) {
    if (!contents || typeof contents.id !== 'number') return Promise.resolve();
    if (!originResolver.isSessionAllowed(contents)) return Promise.resolve();
    const wcId = contents.id;
    return enqueue(wcId, async () => {
      if (typeof contents.isDestroyed === 'function' && contents.isDestroyed()) return;
      const url = typeof contents.getURL === 'function' ? contents.getURL() : '';
      if (!originResolver.isAllowedUrl(url)) return;

      const startNavSeq = navAttemptSeqByWcId.get(wcId) || 0;
      let state = originResolver.getState(wcId);
      if (!state || state.docGenId === 0) {
        state = originResolver.rotateGeneration(wcId, url);
      }
      const targetGenId = state.docGenId;
      const boot = await ensureKernelForGeneration(contents, state);
      if (!boot.ok) {
        recordDiag('warn', 'KERNEL_BOOT_SKIPPED', `wcId=${wcId}: ${boot.reason}`);
        return;
      }
      await reconcilePluginsInDocument(contents, targetGenId, startNavSeq);
    });
  }

  function attachWebContents(contents) {
    if (!contents || typeof contents.on !== 'function') return;
    if (!originResolver.isSessionAllowed(contents)) return;
    const wcId = contents.id;
    webContentsByWcId.set(wcId, contents);

    contents.on('did-start-navigation', (_ev, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) {
        // R-1: Abort in-flight injection loops without destroying the live document's bridge/kernel before commit
        navAttemptSeqByWcId.set(wcId, (navAttemptSeqByWcId.get(wcId) || 0) + 1);
      }
    });

    contents.on('did-navigate', (_ev, url) => {
      // R-1: Unconditionally rotate on committed navigation (including same-URL reload())
      navAttemptSeqByWcId.set(wcId, (navAttemptSeqByWcId.get(wcId) || 0) + 1);
      kernelGenByWcId.delete(wcId);
      hostTokensByWcId.delete(wcId);
      injectedPluginsByWcId.delete(wcId);
      trustedSettingsByWcId.delete(wcId);
      trustedConfigByWcId.delete(wcId);
      deliveredSettingsKeyByWcId.delete(wcId);
      clearWindowLifecycleStates(wcId);
      syncSettingsBridgeBindings();
      originResolver.rotateGeneration(wcId, url);
    });

    contents.on('render-process-gone', () => {
      navAttemptSeqByWcId.set(wcId, (navAttemptSeqByWcId.get(wcId) || 0) + 1);
      kernelGenByWcId.delete(wcId);
      hostTokensByWcId.delete(wcId);
      injectedPluginsByWcId.delete(wcId);
      trustedSettingsByWcId.delete(wcId);
      trustedConfigByWcId.delete(wcId);
      deliveredSettingsKeyByWcId.delete(wcId);
      clearWindowLifecycleStates(wcId);
      syncSettingsBridgeBindings();
      originResolver.rotateGeneration(wcId, '');
    });

    contents.on('dom-ready', () => {
      scheduleSync(contents);
    });

    contents.on('did-finish-load', () => {
      scheduleSync(contents);
    });

    contents.on('did-navigate-in-page', () => {
      // Idempotent plugin reconcile ONLY (never rotates docGenId or re-claims bridge)
      scheduleSync(contents);
    });

    contents.once('destroyed', () => {
      queuesByWcId.delete(wcId);
      webContentsByWcId.delete(wcId);
      kernelGenByWcId.delete(wcId);
      hostTokensByWcId.delete(wcId);
      injectedPluginsByWcId.delete(wcId);
      trustedSettingsByWcId.delete(wcId);
      trustedConfigByWcId.delete(wcId);
      deliveredSettingsKeyByWcId.delete(wcId);
      clearWindowLifecycleStates(wcId);
      navAttemptSeqByWcId.delete(wcId);
      syncSettingsBridgeBindings();
      originResolver.clearWebContents(wcId);
    });
  }

  function collectRendererErrors() {
    return rendererErrors.slice();
  }

  function getTrustedSettingsBinding(wcId, pluginId) {
    if (typeof pluginId !== 'string' || !pluginId) return null;
    const map = trustedSettingsByWcId.get(wcId);
    if (!map) return null;
    const binding = map.get(pluginId);
    if (!binding) return null;
    return {
      pluginId: binding.pluginId,
      fileName: binding.fileName,
      maxBytes: binding.maxBytes,
    };
  }

  function getTrustedConfigBinding(wcId, pluginId) {
    if (typeof pluginId !== 'string' || !pluginId) return null;
    const map = trustedConfigByWcId.get(wcId);
    if (!map) return null;
    const binding = map.get(pluginId);
    if (!binding) return null;
    return {
      pluginId: binding.pluginId,
      scopes: Array.isArray(binding.scopes)
        ? binding.scopes.map((s) => ({
            scopeId: s.scopeId,
            access: s.access,
            maxBytes: s.maxBytes,
          }))
        : [],
    };
  }

  return Object.freeze({
    attachWebContents,
    scheduleSync,
    pushSettingsUpdate,
    getTrustedSettingsBinding,
    getTrustedConfigBinding,
    recordRendererError,
    collectRendererErrors,
  });
}

module.exports = {
  createRendererInjector,
};
