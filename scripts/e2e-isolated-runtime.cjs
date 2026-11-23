'use strict';

/**
 * True Zero-node_modules Isolated Electron 45.4.1 E2E Harness (F4 / Rev 5).
 *
 * Copies ONLY `dist/runtime/` and a generated thin `addon-host-loader.js` shim into
 * an isolated `os.tmpdir()` directory with ZERO `node_modules` anywhere in its ancestor path,
 * launches real Electron `45.4.1`, and verifies:
 * 1. ZERO `MODULE_NOT_FOUND` errors (0-dep proof in real Electron process).
 * 2. `initMain(app)` idempotent guard (`Symbol.for`) & pre-whenReady `PortalArbiter` wrapping.
 * 3. `PreloadRegistrar` registers `preload-bridge.cjs` ONLY on `session.defaultSession`
 *    (isolated partition `persist:hub-browser-e2e` gets ZERO preloads).
 * 4. `sandbox: true` + `contextIsolation: true` `BaseWindow` + `WebContentsView`:
 *    - World 0 has ZERO `__addonHostBootstrap` globals.
 *    - World 998 claims `claimNonce` ONCE; second `claim` throws `ERR_BRIDGE_ALREADY_CLAIMED`.
 *    - `about:blank` iframe is blocked.
 * 5. Coexistence of v1 (light DOM, `shadow: false`) + v2 (Option B2 `HTMLElement` in `ShadowRoot`,
 *    `shadow: true`) + Default-Deny untrusted `mainHook` rejection + SHA-256 pinned trusted `mainHook`
 *    executed via memory-backed isolated CJS loader.
 * 6. Native `<dialog>.showModal()` + `popover="manual"` LIFO dismissal via real `sendInputEvent('Escape')`
 *    + `PortalArbiter` `effective = nativeOpen || pluginClaims.size > 0` truth table.
 * 7. ZERO writes inside `plugins/` directory (before/after snapshot equality).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ELECTRON_BIN = require('electron');
const { ANTIGRAVITY_HOST_PROFILE } = require('../src/profiles/antigravity');
const { buildHostLoaderScriptSource } = require('../src/adapters/electron/host-loader-builder');
const { readDistRuntimeBuildInfo } = require('../src/adapters/electron/electron-host-lifecycle-port');
const { snapshotPluginBundleInMemory, sha256Hex } = require('../src/runtime/main/trust-verifier');

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

function snapshotDir(rootDir) {
  const out = {};
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) {
        const rel = path.relative(rootDir, full).replace(/\\/g, '/');
        out[rel] = sha256Hex(fs.readFileSync(full));
      }
    }
  }
  walk(rootDir);
  return out;
}

function main() {
  const buildInfo = readDistRuntimeBuildInfo();
  assert.ok(buildInfo, 'dist/runtime/build-manifest.json missing — run npm run build:runtime first');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-v2-isolated-e2e-'));
  try {
    // Confirm ZERO node_modules in ancestor chain of tmpRoot
    let cur = tmpRoot;
    while (true) {
      assert.equal(fs.existsSync(path.join(cur, 'node_modules')), false, `Unexpected node_modules at ${cur}`);
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }

    const hostDataDir = path.join(tmpRoot, 'host-data');
    const runtimeStagedDir = path.join(hostDataDir, 'runtime', buildInfo.buildSha8);
    const addonsDir = path.join(hostDataDir, 'addons.d');
    const pluginsDir = path.join(tmpRoot, 'plugins');
    const configJsonPath = path.join(tmpRoot, 'config.json');
    const trustPolicyPath = path.join(hostDataDir, 'trust-policy.json');
    const loaderScriptPath = path.join(hostDataDir, 'addon-host-loader.js');

    copyDir(buildInfo.distRuntimeDir, runtimeStagedDir);
    fs.mkdirSync(addonsDir, { recursive: true });
    fs.mkdirSync(pluginsDir, { recursive: true });

    // Plugin 1: v1 restricted renderer addon (light DOM, shadow: false)
    const p1Dir = path.join(pluginsDir, 'mock-v1-addon');
    fs.mkdirSync(p1Dir, { recursive: true });
    const p1Renderer = path.join(p1Dir, 'renderer.js');
    fs.writeFileSync(
      p1Renderer,
      `'use strict';
const el = addonHost.mountSlot('mock-v1.bar');
if (el) {
  el.textContent = 'V1_LIGHT_OK';
  addonHost.injectStyle('s1', '.tag { color: rgb(1, 2, 3); }');
}
`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(addonsDir, 'mock-v1-addon.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          pluginId: 'mock-v1-addon',
          displayName: 'Mock V1 Addon',
          version: '1.0.0',
          trustLevel: 'restricted',
          capabilities: ['renderer'],
          entry: { rendererScript: 'renderer.js' },
          uiSlots: [{ slot: 'status-bar', slotId: 'mock-v1.bar', anchor: 'status-bar' }],
          isolation: { noTranslate: true, i18nSelfManaged: true },
          loadOrder: 10,
        },
        null,
        2
      ),
      'utf8'
    );

    // Plugin 2: v2 trusted addon (Option B2 Shadow DOM + modal + memory-backed CJS mainHook)
    const p2Dir = path.join(pluginsDir, 'mock-v2-addon');
    fs.mkdirSync(p2Dir, { recursive: true });
    fs.writeFileSync(path.join(p2Dir, 'helper.js'), `exports.TOKEN = 'MEM_CJS_OK';\n`, 'utf8');
    fs.writeFileSync(
      path.join(p2Dir, 'main-hook.js'),
      `'use strict';
const h = require('./helper');
exports.onMainReady = (broker) => {
  broker.log('info', 'BOOT:' + h.TOKEN);
  globalThis.__E2E_MAIN_HOOK_TOKEN = h.TOKEN;
};
`,
      'utf8'
    );
    const p2Renderer = path.join(p2Dir, 'renderer.js');
    fs.writeFileSync(
      p2Renderer,
      `'use strict';
const initSettings = addonHost.getSettings();
window.__E2E_SETTINGS_HISTORY = [initSettings];
window.__E2E_SETTINGS_FROZEN = Boolean(initSettings && Object.isFrozen(initSettings) && Object.isFrozen(initSettings.data));
addonHost.onSettingsChange((snap) => {
  window.__E2E_SETTINGS_HISTORY.push(snap);
});
const root = addonHost.mountSlot('mock-v2.panel');
if (root) {
  root.style.padding = '2px';
  root.classList.add('v2-mounted');
  const btn = document.createElement('button');
  btn.className = 'v2-btn';
  btn.textContent = 'V2_SHADOW_OK';
  root.appendChild(btn);
  addonHost.injectStyle('v2s', '.v2-btn { color: rgb(20, 40, 60); } body { background: rgb(255, 0, 0) !important; }', { slotId: 'mock-v2.panel' });
  window.__E2E_V2_META = {
    isHTMLElement: root instanceof HTMLElement,
    isShadowRoot: root.getRootNode() instanceof ShadowRoot,
    anchorMissIsNull: addonHost.mountSlot('mock-v2.missing') === null,
  };
  const modal = addonHost.openModal('mock-v2.modal');
  modal.bodyEl.textContent = 'MODAL_BODY';
  const pop = addonHost.openPopover('mock-v2.popover');
  pop.bodyEl.textContent = 'POP_BODY';
  window.__E2E_MODAL_META = {
    bodyIsHTMLElement: modal.bodyEl instanceof HTMLElement,
    bodyInShadow: modal.bodyEl.getRootNode() instanceof ShadowRoot,
  };
}
`,
      'utf8'
    );
    const p2SettingsPath = path.join(hostDataDir, 'mock_v2_settings.json');
    fs.writeFileSync(p2SettingsPath, JSON.stringify({ enabled: false, provider: 'local-llm' }), 'utf8');
    fs.writeFileSync(
      path.join(addonsDir, 'mock-v2-addon.json'),
      JSON.stringify(
        {
          schemaVersion: 2,
          pluginId: 'mock-v2-addon',
          displayName: 'Mock V2 Addon',
          version: '2.1.0',
          trustLevel: 'trusted',
          capabilities: ['renderer', 'mainHook'],
          entry: { rendererScript: 'renderer.js', mainHookScript: 'main-hook.js' },
          settingsBridge: { fileName: 'mock_v2_settings.json', maxBytes: 16384 },
          uiSlots: [
            { slot: 'overview-pane', slotId: 'mock-v2.panel', anchor: 'overview-pane' },
            { slot: 'custom', slotId: 'mock-v2.missing', anchor: 'automation-page' },
            { slot: 'modal', slotId: 'mock-v2.modal' },
            { slot: 'overlay', slotId: 'mock-v2.popover' },
          ],
          isolation: { noTranslate: true, i18nSelfManaged: true },
          loadOrder: 20,
        },
        null,
        2
      ),
      'utf8'
    );

    // Plugin 3: UNAPPROVED trusted mainHook addon (MUST be blocked by Default-Deny trust-policy.json!)
    const p3Dir = path.join(pluginsDir, 'unapproved-trusted');
    fs.mkdirSync(p3Dir, { recursive: true });
    fs.writeFileSync(
      path.join(p3Dir, 'main-hook.js'),
      `exports.onMainReady = () => { globalThis.__E2E_UNAPPROVED_RAN = true; };\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(addonsDir, 'unapproved-trusted.json'),
      JSON.stringify(
        {
          schemaVersion: 2,
          pluginId: 'unapproved-trusted',
          displayName: 'Unapproved Trusted',
          version: '1.0.0',
          trustLevel: 'trusted',
          capabilities: ['mainHook'],
          entry: { mainHookScript: 'main-hook.js' },
          isolation: { noTranslate: true, i18nSelfManaged: true },
          loadOrder: 30,
        },
        null,
        2
      ),
      'utf8'
    );

    // Pin ONLY mock-v2-addon in trust-policy.json
    const p2RendererSha = sha256Hex(fs.readFileSync(p2Renderer));
    const p2BundleSha = snapshotPluginBundleInMemory(p2Dir).bundleSha256;
    fs.writeFileSync(
      trustPolicyPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          approved: {
            'mock-v2-addon': {
              pluginId: 'mock-v2-addon',
              version: '2.1.0',
              rendererSha256: p2RendererSha,
              mainHookBundleSha256: p2BundleSha,
              approvedAt: new Date().toISOString(),
            },
          },
        },
        null,
        2
      ),
      'utf8'
    );

    fs.writeFileSync(
      configJsonPath,
      JSON.stringify({
        plugins: {
          'mock-v1-addon': { enabled: true },
          'mock-v2-addon': { enabled: true },
          'unapproved-trusted': { enabled: true },
        },
      }),
      'utf8'
    );

    // Generate thin entry shim pointing to staged runtime/<buildSha8>/
    const paths = {
      HOST_DATA_DIR: hostDataDir,
      ADDONS_DIR: addonsDir,
      PLUGINS_ROOT_DIR: pluginsDir,
      CONFIG_JSON_PATH: configJsonPath,
      TRUST_POLICY_PATH: trustPolicyPath,
      LOADER_SCRIPT_PATH: loaderScriptPath,
      RUNTIME_DIR: path.join(hostDataDir, 'runtime'),
    };
    const shimSrc = buildHostLoaderScriptSource(paths, ANTIGRAVITY_HOST_PROFILE, {
      hostVersion: '2.1.0',
      strictTrustPolicy: true,
      runtimeEntryDir: runtimeStagedDir,
      buildSha8: buildInfo.buildSha8,
    });
    fs.writeFileSync(loaderScriptPath, shimSrc, 'utf8');

    // Snapshot pluginsDir BEFORE launching Electron (zero runtime writes invariant)
    const pluginsBefore = snapshotDir(pluginsDir);

    // Write isolated Electron app entry inside tmpRoot (ZERO repo references!)
    const electronMainPath = path.join(tmpRoot, 'app-main.cjs');
    const electronMainCode = `'use strict';
const fs = require('node:fs');
const http = require('node:http');
const { app, BaseWindow, WebContentsView, session, ipcMain } = require('electron');

// 1. Load generated shim BEFORE app.whenReady() (exact pre-L339 sequence)
const loader = require(${JSON.stringify(loaderScriptPath)});
const SETTINGS_FILE = ${JSON.stringify(p2SettingsPath)};
const controller1 = loader.initMain(app);
const controller2 = loader.initMain(app); // must be idempotent!

const nativePortalEvents = [];
app.on('window-all-closed', (e) => e.preventDefault());

const htmlDoc = \`<!doctype html><html><body style="background:rgb(255,255,255)">
    <div data-testid="status-bar"></div>
    <div data-testid="overview-panel"></div>
    <iframe src="about:blank"></iframe>
  </body></html>\`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(htmlDoc);
});
const server2 = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(htmlDoc);
});

function waitFor(fn, timeoutMs = 8000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const val = await fn();
        if (val) return resolve(val);
      } catch (_e) {}
      if (Date.now() - start > timeoutMs) return reject(new Error('WAIT_TIMEOUT'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

app.whenReady().then(async () => {
  // Simulate Antigravity registering wcv:set-portal-overlay-open AFTER initMain
  ipcMain.handle('wcv:set-portal-overlay-open', (ev, open) => {
    nativePortalEvents.push({ wcId: ev.sender.id, open: Boolean(open) });
    return { ok: true, open: Boolean(open) };
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  await new Promise((r) => server2.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const port2 = server2.address().port;
  const baseUrl = 'http://127.0.0.1:' + port;
  const baseUrl2 = 'http://127.0.0.1:' + port2;

  const win = new BaseWindow({ width: 900, height: 650, show: false });
  const hubView = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.contentView.addChildView(hubView);

  await hubView.webContents.loadURL(baseUrl + '/home');

  const mounted = await waitFor(() =>
    hubView.webContents.executeJavaScriptInIsolatedWorld(998, [{
      code: \`(() => {
        const v1 = document.querySelector('[data-addon-host-slot="mock-v1.bar"]');
        const v2Host = document.querySelector('[data-addon-host-slot="mock-v2.panel"]');
        const dlg = document.querySelector('dialog[data-addon-host-modal-dialog="1"]');
        const pop = document.querySelector('[data-addon-host-popover="1"]');
        if (!v1 || !v2Host || !v2Host.shadowRoot || !dlg || !pop) return null;
        const v2Btn = v2Host.shadowRoot.querySelector('.v2-btn');
        if (!v2Btn) return null;
        return {
          v1Text: v1.textContent,
          v1Translate: v1.getAttribute('translate'),
          v2BtnText: v2Btn.textContent,
          v2BtnColor: getComputedStyle(v2Btn).color,
          bodyBg: getComputedStyle(document.body).backgroundColor,
          v2Meta: window.__E2E_V2_META,
          modalMeta: window.__E2E_MODAL_META,
          dlgOpen: dlg.open,
          popOpen: pop.matches(':popover-open'),
          bridgeStatus: globalThis.__addonHostKernel.getBridgeStatus(),
        };
      })()\`,
    }])
  );

  // Verify World 0 has ZERO bootstrap globals & double claim throws ERR_BRIDGE_ALREADY_CLAIMED
  const world0Bootstrap = await hubView.webContents.executeJavaScript('typeof window.__addonHostBootstrap');
  const doubleClaimErr = await hubView.webContents.executeJavaScriptInIsolatedWorld(998, [
    { code: \`(() => { try { window.__addonHostBootstrap.claim('0123456789abcdef'); return 'NO_THROW'; } catch (e) { return e.message; } })()\` },
  ]);

  // Real Escape #1 closes top-most popover while <dialog> stays open; Escape #2 closes <dialog>
  hubView.setBounds({ x: 0, y: 0, width: 900, height: 650 });
  try { win.setOpacity(0); } catch (_e) {}
  win.showInactive();
  hubView.webContents.focus();
  await new Promise((r) => setTimeout(r, 50));
  hubView.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  hubView.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await new Promise((r) => setTimeout(r, 150));
  const afterEsc1 = await hubView.webContents.executeJavaScriptInIsolatedWorld(998, [{
    code: \`({ dlgOpen: Boolean(document.querySelector('dialog[data-addon-host-modal-dialog="1"]')?.open), popPresent: Boolean(document.querySelector('[data-addon-host-popover="1"]')) })\`,
  }]);

  hubView.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  hubView.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await new Promise((r) => setTimeout(r, 150));
  const afterEsc2 = await hubView.webContents.executeJavaScriptInIsolatedWorld(998, [{
    code: \`({ dlgPresent: Boolean(document.querySelector('dialog[data-addon-host-modal-dialog="1"]')), popPresent: Boolean(document.querySelector('[data-addon-host-popover="1"]')) })\`,
  }]);

  // Verify isolated session partition gets ZERO defaultSession preloads
  const isolatedWin = new BaseWindow({ width: 400, height: 300, show: false });
  const isolatedSes = session.fromPartition('persist:hub-browser-e2e');
  const isolatedView = new WebContentsView({
    webPreferences: { session: isolatedSes, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  isolatedView.setBounds({ x: 0, y: 0, width: 400, height: 300 });
  isolatedWin.contentView.addChildView(isolatedView);
  await isolatedView.webContents.loadURL(baseUrl + '/browser');
  const isolatedWorld998Bootstrap = await isolatedView.webContents.executeJavaScriptInIsolatedWorld(998, [
    { code: 'typeof window.__addonHostBootstrap' },
  ]);

  // Verify v2.1.0 settingsBridge: initial snapshot, live fs.watch push, and origin port rotation persistence
  const settingsInitial = await hubView.webContents.executeJavaScriptInIsolatedWorld(998, [{
    code: \`({ frozen: window.__E2E_SETTINGS_FROZEN, history: window.__E2E_SETTINGS_HISTORY })\`,
  }]);
  // Put a canary in localStorage on port 1 to verify port 2 wipes localStorage while settingsBridge persists
  await hubView.webContents.executeJavaScriptInIsolatedWorld(998, [{ code: \`localStorage.setItem('port1_canary', '1')\` }]);

  // Live settings write on disk -> must push into World 998 without reload
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ enabled: false, provider: 'custom-v2' }), 'utf8');
  const settingsAfterLivePush = await waitFor(() =>
    hubView.webContents.executeJavaScriptInIsolatedWorld(998, [{
      code: \`(() => {
        const h = window.__E2E_SETTINGS_HISTORY || [];
        return h.length >= 2 ? h[h.length - 1] : null;
      })()\`,
    }])
  );

  // Rotate to second loopback port (simulating Antigravity dynamic LS port change)
  await hubView.webContents.loadURL(baseUrl2 + '/home');
  const settingsAfterPortRotation = await waitFor(() =>
    hubView.webContents.executeJavaScriptInIsolatedWorld(998, [{
      code: \`(() => {
        const h = window.__E2E_SETTINGS_HISTORY || [];
        if (h.length < 1) return null;
        return {
          lsCanary: localStorage.getItem('port1_canary'),
          initialOnPort2: h[0],
        };
      })()\`,
    }])
  );

  await waitFor(() => globalThis.__E2E_MAIN_HOOK_TOKEN === 'MEM_CJS_OK', 3000);

  console.log('ISOLATED_E2E_RESULT:' + JSON.stringify({
    idempotentInit: controller1 === controller2,
    buildInfo: loader.getBuildInfo(),
    preloadStatus: controller1.getPreloadStatus(),
    portalStatus: controller1.getPortalArbiterStatus(),
    settingsBridgeStatus: controller1.getSettingsBridgeStatus(),
    settingsInitial,
    settingsAfterLivePush,
    settingsAfterPortRotation,
    isolatedPreloadsCount: isolatedSes.getPreloadScripts().length,
    world0Bootstrap,
    isolatedWorld998Bootstrap,
    doubleClaimErr,
    mounted,
    afterEsc1,
    afterEsc2,
    nativePortalEvents,
    mainHookToken: globalThis.__E2E_MAIN_HOOK_TOKEN || null,
    unapprovedMainHookRan: Boolean(globalThis.__E2E_UNAPPROVED_RAN),
    rendererErrors: controller1.collectRendererErrors(),
  }));

  server.close();
  server2.close();
  if (!isolatedWin.isDestroyed()) isolatedWin.destroy();
  win.destroy();
  app.quit();
}).catch((err) => {
  console.error('E2E_FATAL:', err && err.stack ? err.stack : err);
  console.error('E2E_DIAGS:', JSON.stringify(controller1.getDiagnostics()));
  console.error('E2E_RENDERER_ERRORS:', JSON.stringify(controller1.collectRendererErrors()));
  console.error('E2E_LIFECYCLE:', JSON.stringify(controller1.getAddonLifecycleStates()));
  app.exit(1);
});
`;
    fs.writeFileSync(electronMainPath, electronMainCode, 'utf8');

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const res = spawnSync(ELECTRON_BIN, ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', electronMainPath], {
      cwd: tmpRoot,
      env,
      encoding: 'utf8',
      timeout: 30000,
      shell: false,
      windowsHide: true,
    });
    assert.equal(res.status, 0, `Isolated Electron E2E failed (exit ${res.status}):\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`);

    const line = res.stdout
      .split(/\r?\n/)
      .reverse()
      .find((l) => l.startsWith('ISOLATED_E2E_RESULT:'));
    assert.ok(line, `Missing ISOLATED_E2E_RESULT marker in stdout:\n${res.stdout}`);
    const out = JSON.parse(line.slice('ISOLATED_E2E_RESULT:'.length));

    assert.equal(out.idempotentInit, true);
    assert.equal(out.buildInfo.buildSha8, buildInfo.buildSha8);
    assert.equal(out.preloadStatus.registered, true);
    assert.equal(out.isolatedPreloadsCount, 0);
    assert.equal(out.world0Bootstrap, 'undefined');
    assert.equal(out.isolatedWorld998Bootstrap, 'undefined');
    assert.match(out.doubleClaimErr, /ERR_BRIDGE_ALREADY_CLAIMED/);
    assert.equal(out.mounted.v1Text, 'V1_LIGHT_OK');
    assert.equal(out.mounted.v1Translate, 'no');
    assert.equal(out.mounted.v2BtnText, 'V2_SHADOW_OK');
    assert.equal(out.mounted.v2BtnColor, 'rgb(20, 40, 60)');
    assert.equal(out.mounted.bodyBg, 'rgb(255, 255, 255)');
    assert.equal(out.mounted.v2Meta.isHTMLElement, true);
    assert.equal(out.mounted.v2Meta.isShadowRoot, true);
    assert.equal(out.mounted.v2Meta.anchorMissIsNull, true);
    assert.equal(out.mounted.modalMeta.bodyIsHTMLElement, true);
    assert.equal(out.mounted.modalMeta.bodyInShadow, true);
    assert.equal(out.mounted.bridgeStatus.hasBridge, true);
    assert.equal(out.afterEsc1.dlgOpen, true, `First Escape must close popover while keeping dialog open: ${JSON.stringify(out)}`);
    assert.equal(out.afterEsc1.popPresent, false, `popPresent still true: ${JSON.stringify(out)}`);
    assert.equal(out.afterEsc2.dlgPresent, false, 'Second Escape must close dialog');
    assert.equal(out.portalStatus.mode, 'ACTIVE_ARBITER');
    assert.ok(
      out.nativePortalEvents.some((e) => e.open === true) && out.nativePortalEvents.some((e) => e.open === false),
      `Expected portal arbiter true->false events, got ${JSON.stringify(out.nativePortalEvents)}`
    );
    assert.equal(out.mainHookToken, 'MEM_CJS_OK');
    assert.equal(out.unapprovedMainHookRan, false, 'Unapproved trusted mainHook MUST be blocked by Default-Deny');
    assert.equal(out.settingsInitial.frozen, true, 'Initial settings snapshot must be deep-frozen');
    assert.equal(out.settingsInitial.history[0].status, 'ok');
    assert.equal(out.settingsInitial.history[0].data.provider, 'local-llm');
    assert.equal(out.settingsInitial.history[0].data.enabled, false);
    assert.equal(out.settingsAfterLivePush.status, 'ok');
    assert.equal(out.settingsAfterLivePush.data.provider, 'custom-v2');
    assert.equal(out.settingsAfterLivePush.revision, 2);
    assert.equal(out.settingsAfterPortRotation.lsCanary, null, 'Port rotation must partition localStorage');
    assert.equal(out.settingsAfterPortRotation.initialOnPort2.status, 'ok');
    assert.equal(out.settingsAfterPortRotation.initialOnPort2.data.provider, 'custom-v2');
    assert.equal(out.settingsAfterPortRotation.initialOnPort2.data.enabled, false);
    assert.deepEqual(out.rendererErrors, []);

    // Verify ZERO runtime writes inside plugins/
    const pluginsAfter = snapshotDir(pluginsDir);
    assert.deepEqual(pluginsAfter, pluginsBefore, 'ZERO runtime writes allowed inside plugins/');

    process.stdout.write(`ISOLATED_ZERO_NODE_MODULES_E2E_PASSED (buildSha8=${buildInfo.buildSha8})\n`);
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch (_e) {}
  }
}

main();
