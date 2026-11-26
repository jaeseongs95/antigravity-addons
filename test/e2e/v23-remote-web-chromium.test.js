'use strict';

/**
 * Real Chromium E2E Test for Remote Web Addon Host (v2.3.0 — Zero New npm Deps).
 *
 * Launches real Chromium via the already-installed `electron` devDependency
 * (`nodeIntegration: false`, `contextIsolation: true`) against two local HTTP origins:
 *   1. Allowed mock Remote Web origin (`http://127.0.0.1:<allowedPort>/workspace`):
 *      - Packs two compliant `AddonManifest.v2` (`antigravity-desktop`) plugins via `buildDistRemote`.
 *      - Verifies Option B2 ShadowRoot mounting, CSS isolation (`document.body` stays white),
 *        `addonHost.hostProfileId === 'antigravity-remote-web'`, Settings Tab registration,
 *        Shadow-DOM Remote Host Drawer open + keyboard Escape close,
 *        `mainHook` fail-closed skip on dual-capability plugin,
 *        `settingsBridge` initial snapshot + `saveSettings` + live `onSettingsChange` + reload persistence.
 *   2. Disallowed origin (`http://127.0.0.1:<blockedPort>/evil`):
 *      - Verifies fail-closed abort (`ERR_ORIGIN_NOT_ALLOWED`) and ZERO injected DOM nodes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { ANTIGRAVITY_REMOTE_WEB_PROFILE } = require('../../src/profiles/antigravity-remote-web');
const { buildDistRemote, buildAddonUserscript } = require('../../scripts/build-remote');

let ELECTRON_BIN = null;
try {
  ELECTRON_BIN = require('electron');
} catch (_err) {
  ELECTRON_BIN = null;
}

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

const CLICK_SHADOW_TRUSTED_HELPER = `
async function ensureInputReady(win) {
  try { win.setOpacity(0); } catch (_e) { /* headless platforms may not support setOpacity */ }
  win.showInactive();
  win.webContents.focus();
  await new Promise((r) => setTimeout(r, 120));
  await win.webContents.executeJavaScript(
    'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
  );
}

async function clickShadowTrusted(win, worldId, selector, index = 0) {
  let rect = null;
  const deadline = Date.now() + 1200;
  while (Date.now() < deadline) {
    rect = await win.webContents.executeJavaScriptInIsolatedWorld(worldId, [{
      code:
        '(() => {' +
        '  const host = document.getElementById("remote-addon-host-drawer-root");' +
        '  const sr = host && host.shadowRoot;' +
        '  if (!sr) return null;' +
        '  const els = sr.querySelectorAll(' + JSON.stringify(selector) + ');' +
        '  const el = els[' + Number(index) + '];' +
        '  if (!el) return null;' +
        '  if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center", inline: "center" });' +
        '  const r = el.getBoundingClientRect();' +
        '  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), width: r.width, height: r.height };' +
        '})()',
    }]);
    if (rect && rect.width > 0 && rect.height > 0) break;
    await new Promise((r) => setTimeout(r, 40));
  }
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    throw new Error('clickShadowTrusted target not visible: ' + selector + '[' + index + '] -> ' + JSON.stringify(rect));
  }
  win.webContents.focus();
  win.webContents.sendInputEvent({ type: 'mouseMove', x: rect.x, y: rect.y });
  win.webContents.sendInputEvent({ type: 'mouseDown', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await new Promise((r) => setTimeout(r, 90));
  await win.webContents.executeJavaScript(
    'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
  );
  return rect;
}
`;

test(
  'TC-RW-E2E (Real Chromium): packed AddonManifest.v2 plugins + ShadowRoot CSS isolation + Drawer Escape + settingsBridge persistence across reload + disallowed-origin abort',
  { skip: ELECTRON_BIN ? false : 'electron devDependency not installed' },
  () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-v23-rw-e2e-'));
    try {
      const pluginsRootDir = path.join(tmpDir, 'plugins');
      const addonsDir = path.join(tmpDir, 'addons.d');
      const trustPolicyPath = path.join(tmpDir, 'trust-policy.json');
      const distRemoteDir = path.join(tmpDir, 'dist-remote');
      fs.mkdirSync(addonsDir, { recursive: true });

      // Plugin 1: existing antigravity-desktop restricted renderer plugin (NO manifest edits for remote-web!)
      const p1Dir = path.join(pluginsRootDir, 'rw-status-addon');
      fs.mkdirSync(p1Dir, { recursive: true });
      fs.writeFileSync(
        path.join(p1Dir, 'renderer.js'),
        `
        const slotEl = addonHost.mountSlot('rw-status-addon.bar');
        const label = document.createElement('span');
        label.className = 'rw-label';
        label.textContent = 'RW_STATUS_OK:' + addonHost.hostProfileId;
        slotEl.appendChild(label);
        addonHost.injectStyle('rw-style', '.rw-label { color: rgb(20, 140, 60); } body { background: rgb(255, 0, 0) !important; }', { slotId: 'rw-status-addon.bar' });
        addonHost.registerSettingsTab('rw-tab', {
          label: 'RW Status Settings',
        });
        `,
        'utf8'
      );
      fs.writeFileSync(
        path.join(addonsDir, 'rw-status-addon.json'),
        JSON.stringify({
          schemaVersion: 2,
          pluginId: 'rw-status-addon',
          displayName: 'RW Status Addon',
          version: '1.0.0',
          trustLevel: 'restricted',
          compatibility: { hostProfile: 'antigravity-desktop', minHostVersion: '2.0.0' },
          capabilities: ['renderer'],
          entry: { rendererScript: 'renderer.js' },
          uiSlots: [{ slot: 'status-bar', slotId: 'rw-status-addon.bar', anchor: 'status-bar', shadow: true }],
          isolation: { noTranslate: true, i18nSelfManaged: true },
          loadOrder: 10,
        }),
        'utf8'
      );

      // Plugin 2: dual-capability (renderer + mainHook) trusted + pinned with settingsBridge
      const p2Dir = path.join(pluginsRootDir, 'rw-dual-settings');
      fs.mkdirSync(p2Dir, { recursive: true });
      const p2RendererSrc = `
        const initial = addonHost.getSettings();
        document.documentElement.setAttribute('data-rw-init-theme', initial && initial.data ? String(initial.data.theme) : 'none');
        addonHost.onSettingsChange((snap) => {
          document.documentElement.setAttribute('data-rw-live-theme', snap && snap.data ? String(snap.data.theme) : 'none');
        });
        const slotEl = addonHost.mountSlot('rw-dual-settings.sidebar');
        if (slotEl) {
          slotEl.textContent = 'DUAL_RENDERER_OK:' + (initial && initial.data ? initial.data.theme : 'none');
        }
        addonHost.registerAction('save-midnight', {
          label: 'Save Midnight',
          async run() {
            return addonHost.saveSettings({ theme: 'midnight', count: 42 });
          },
        });
      `;
      fs.writeFileSync(path.join(p2Dir, 'renderer.js'), p2RendererSrc, 'utf8');
      fs.writeFileSync(path.join(p2Dir, 'main-hook.js'), 'throw new Error("MAIN_HOOK_MUST_NOT_RUN_ON_WEB");\n', 'utf8');
      fs.writeFileSync(
        path.join(addonsDir, 'rw-dual-settings.json'),
        JSON.stringify({
          schemaVersion: 2,
          pluginId: 'rw-dual-settings',
          displayName: 'RW Dual Settings',
          version: '2.0.0',
          trustLevel: 'trusted',
          compatibility: { hostProfile: 'antigravity-desktop', minHostVersion: '2.3.0' },
          capabilities: ['renderer', 'mainHook'],
          entry: { rendererScript: 'renderer.js', mainHookScript: 'main-hook.js' },
          uiSlots: [{ slot: 'sidebar', slotId: 'rw-dual-settings.sidebar', anchor: 'sidebar', shadow: true }],
          isolation: { noTranslate: true, i18nSelfManaged: true },
          settingsBridge: { fileName: 'rw-dual-settings.json', maxBytes: 4096 },
          loadOrder: 20,
        }),
        'utf8'
      );
      fs.writeFileSync(path.join(tmpDir, 'rw-dual-settings.json'), JSON.stringify({ theme: 'packed-default', count: 1 }), 'utf8');
      fs.writeFileSync(
        trustPolicyPath,
        JSON.stringify({
          schemaVersion: 1,
          approved: {
            'rw-dual-settings': { rendererSha256: sha256(p2RendererSrc) },
          },
        }),
        'utf8'
      );

      const built = buildDistRemote({
        targetDir: distRemoteDir,
        profile: ANTIGRAVITY_REMOTE_WEB_PROFILE,
        noAddons: false,
        addonsDir,
        pluginsRootDir,
        configJsonPath: null,
        trustPolicyPath,
        settingsDataDir: tmpDir,
        includeSettingsSnapshots: true,
        hostVersion: '2.3.0',
      });
      assert.equal(built.ok, true);
      assert.equal(built.buildManifest.addonCount, 2);
      assert.deepEqual(built.buildManifest.skippedMainHookPlugins, ['rw-dual-settings']);
      assert.equal(built.buildManifest.extension.manifestVersion, 3);
      assert.equal(built.buildManifest.extension.world, 'ISOLATED');
      assert.equal(built.buildManifest.bookmarklet.emitted, false);
      assert.equal(fs.existsSync(path.join(distRemoteDir, 'bookmarklet.txt')), false);

      const extManifestPath = path.join(distRemoteDir, 'extension', 'manifest.json');
      const extContentScriptPath = path.join(distRemoteDir, 'extension', 'content-script.js');
      const userscriptPath = path.join(distRemoteDir, 'antigravity-remote.user.js');
      const extManifest = JSON.parse(fs.readFileSync(extManifestPath, 'utf8'));
      assert.equal(extManifest.manifest_version, 3);
      assert.equal(extManifest.content_scripts[0].world, 'ISOLATED');
      assert.equal(extManifest.content_scripts[0].all_frames, false);
      assert.equal('permissions' in extManifest, false);
      assert.equal('host_permissions' in extManifest, false);

      const runnerPath = path.join(tmpDir, 'chromium-runner.cjs');
      fs.writeFileSync(
        runnerPath,
        `'use strict';
const http = require('node:http');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-dev-shm-usage');

const extContentCode = fs.readFileSync(${JSON.stringify(extContentScriptPath)}, 'utf8');
const userscriptCode = fs.readFileSync(${JSON.stringify(userscriptPath)}, 'utf8');
${CLICK_SHADOW_TRUSTED_HELPER}

async function waitFor(fn, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const val = await fn();
    if (val) return val;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

function startServer(html) {
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "require-trusted-types-for 'script'; script-src 'nonce-e2e123' 'unsafe-inline'; object-src 'none'; base-uri 'self'; worker-src 'self'",
      });
      res.end(html);
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      resolve({ srv, origin: 'http://127.0.0.1:' + addr.port });
    });
  });
}

app.whenReady().then(async () => {
  const allowed = await startServer(
    '<!doctype html><html><body style="background: rgb(255, 255, 255);"><div data-testid="status-bar"></div></body></html>'
  );
  const blocked = await startServer(
    '<!doctype html><html><body><div data-testid="status-bar"></div></body></html>'
  );

  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 768,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  try {
    await win.loadURL(allowed.origin + '/workspace');
    await ensureInputReady(win);
    // Inject MV3 extension content-script.js into Chromium Isolated World 998 under strict TrustedTypes + nonce CSP
    await win.webContents.executeJavaScriptInIsolatedWorld(998, [{ code: extContentCode }]);

    const bootBase = await win.webContents.executeJavaScriptInIsolatedWorld(998, [
      {
        code:
          '(async () => {' +
          'const res = await globalThis.__addonHostRemoteRuntime.bootRemoteWebHost({ allowedOrigins: [' +
          JSON.stringify(allowed.origin) +
          '], allowLoopbackHttp: true });' +
          'if (!res.ok) return { ok: false, reason: res.reason };' +
          'globalThis.__rwE2eBoot = res;' +
          'const statusHost = document.querySelector(\\'[data-addon-host-slot="rw-status-addon.bar"]\\');' +
          'const statusLabel = statusHost && statusHost.shadowRoot && statusHost.shadowRoot.querySelector(".rw-label");' +
          'const labelColor = statusLabel ? getComputedStyle(statusLabel).color : null;' +
          'const bodyBg = getComputedStyle(document.body).backgroundColor;' +
          'const drawerHost = document.getElementById("remote-addon-host-drawer-root");' +
          'const pill = drawerHost && drawerHost.shadowRoot && drawerHost.shadowRoot.querySelector(".rah-pill");' +
          'const drawerPanel = drawerHost.shadowRoot.querySelector("#rah-drawer-panel");' +
          'pill.click();' +
          'const blockedSyntheticOpen = drawerPanel.hasAttribute("hidden");' +
          'return {' +
          '  ok: true,' +
          '  profileId: res.controller.profileId,' +
          '  statusText: statusLabel ? statusLabel.textContent : null,' +
          '  labelColor,' +
          '  bodyBg,' +
          '  blockedSyntheticOpen,' +
          '  initTheme: document.documentElement.getAttribute("data-rw-init-theme"),' +
          '};' +
          '})()',
      },
    ]);

    let firstBoot = bootBase;
    if (bootBase.ok) {
      let openedAfterClick = false;
      for (let attempt = 0; attempt < 3 && !openedAfterClick; attempt += 1) {
        await clickShadowTrusted(win, 998, '.rah-pill', 0);
        openedAfterClick = await win.webContents.executeJavaScriptInIsolatedWorld(998, [
          {
            code:
              '(() => {' +
              'const h = document.getElementById("remote-addon-host-drawer-root");' +
              'const p = h && h.shadowRoot && h.shadowRoot.querySelector("#rah-drawer-panel");' +
              'return Boolean(p && !p.hasAttribute("hidden"));' +
              '})()',
          },
        ]);
      }
      await clickShadowTrusted(win, 998, '.rah-tab', 1);
      const afterTab = await win.webContents.executeJavaScriptInIsolatedWorld(998, [
        {
          code:
            '(async () => {' +
            'const res = globalThis.__rwE2eBoot;' +
            'const drawerHost = document.getElementById("remote-addon-host-drawer-root");' +
            'const tabLabel = drawerHost.shadowRoot.querySelector(".rah-tab-label");' +
            'const tabText = tabLabel ? tabLabel.textContent : null;' +
            'const saveRes = await res.controller.bridge.port.saveSettings("rw-dual-settings", JSON.stringify({ theme: "midnight", count: 42 }));' +
            'return {' +
            '  addonStates: res.controller.getAddonStates(),' +
            '  tabText,' +
            '  liveTheme: document.documentElement.getAttribute("data-rw-live-theme"),' +
            '  saveOk: saveRes.ok,' +
            '};' +
            '})()',
        },
      ]);
      firstBoot = { ...bootBase, openedAfterClick, ...afterTab };
    }

    // Verify MAIN world cannot see ISOLATED world runtime globals
    const pageWorldSeesGlobals = await win.webContents.executeJavaScript(
      'Boolean(globalThis.__addonHostKernel || globalThis.__addonHostRemoteRuntime)'
    );

    // Inject userscript in MAIN world afterwards and prove cross-world duplicate-boot guard prevents double mount
    await win.webContents.executeJavaScript(userscriptCode);
    const crossWorldAttempt = await win.webContents.executeJavaScript(
      '(async () => {' +
        'const res = await globalThis.__addonHostRemoteRuntime.bootRemoteWebHost({ allowedOrigins: [' +
        JSON.stringify(allowed.origin) +
        '], allowLoopbackHttp: true });' +
        'return {' +
        '  ok: res.ok,' +
        '  alreadyBooted: Boolean(res.alreadyBooted),' +
        '  crossWorld: Boolean(res.crossWorld),' +
        '  drawerCount: document.querySelectorAll("#remote-addon-host-drawer-root").length,' +
        '};' +
      '})()'
    );

    try { win.setOpacity(0); } catch (_e) { /* headless platforms may not support setOpacity */ }
    win.showInactive();
    win.webContents.focus();
    await win.webContents.executeJavaScript(
      'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
    );
    const drawerClosedByEscape = await waitFor(async () => {
      win.webContents.focus();
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await new Promise((r) => setTimeout(r, 80));
      return win.webContents.executeJavaScript(
        '(() => {' +
          'const drawerHost = document.getElementById("remote-addon-host-drawer-root");' +
          'const drawerPanel = drawerHost && drawerHost.shadowRoot && drawerHost.shadowRoot.querySelector("#rah-drawer-panel");' +
          'return Boolean(drawerPanel && drawerPanel.hasAttribute("hidden"));' +
        '})()'
      );
    }, 3000);

    await win.loadURL(allowed.origin + '/workspace');
    await win.webContents.executeJavaScriptInIsolatedWorld(998, [{ code: extContentCode }]);
    const afterReload = await win.webContents.executeJavaScriptInIsolatedWorld(998, [
      {
        code:
          '(async () => {' +
          'const res = await globalThis.__addonHostRemoteRuntime.bootRemoteWebHost({ allowedOrigins: [' +
          JSON.stringify(allowed.origin) +
          '], allowLoopbackHttp: true });' +
          'return { ok: res.ok, initThemeAfterReload: document.documentElement.getAttribute("data-rw-init-theme") };' +
          '})()',
      },
    ]);

    await win.loadURL(blocked.origin + '/evil');
    await win.webContents.executeJavaScriptInIsolatedWorld(998, [{ code: extContentCode }]);
    const onBlocked = await win.webContents.executeJavaScriptInIsolatedWorld(998, [
      {
        code:
          '(async () => {' +
          'const res = await globalThis.__addonHostRemoteRuntime.bootRemoteWebHost({ allowedOrigins: [' +
          JSON.stringify(allowed.origin) +
          '], allowLoopbackHttp: true });' +
          'return {' +
          '  ok: res.ok,' +
          '  reason: res.reason,' +
          '  hasDrawer: Boolean(document.getElementById("remote-addon-host-drawer-root")),' +
          '  hasSlot: Boolean(document.querySelector("[data-addon-host-owner]")),' +
          '};' +
          '})()',
      },
    ]);

    process.stdout.write(
      JSON.stringify({ firstBoot, pageWorldSeesGlobals, crossWorldAttempt, drawerClosedByEscape, afterReload, onBlocked }) + '\\n'
    );
    win.destroy();
    allowed.srv.close();
    blocked.srv.close();
    app.exit(0);
  } catch (err) {
    process.stderr.write((err && err.stack ? err.stack : String(err)) + '\\n');
    allowed.srv.close();
    blocked.srv.close();
    app.exit(1);
  }
});
`,
        'utf8'
      );

      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const args = [runnerPath];
      if (process.platform === 'linux') {
        args.unshift('--no-sandbox', '--disable-gpu');
      }

      const rawOut = execFileSync(ELECTRON_BIN, args, {
        env,
        encoding: 'utf8',
        timeout: 45000,
      });

      const lastLine = rawOut.trim().split(/\r?\n/).pop();
      const result = JSON.parse(lastLine);

      assert.equal(result.firstBoot.ok, true);
      assert.equal(result.firstBoot.profileId, 'antigravity-remote-web');
      assert.equal(result.firstBoot.statusText, 'RW_STATUS_OK:antigravity-remote-web');
      assert.equal(result.firstBoot.labelColor, 'rgb(20, 140, 60)');
      assert.equal(result.firstBoot.bodyBg, 'rgb(255, 255, 255)', 'ShadowRoot CSS isolation must protect document.body');
      assert.equal(result.firstBoot.blockedSyntheticOpen, true, 'Synthetic ev.isTrusted===false click must not open Remote Host drawer');
      assert.equal(result.firstBoot.openedAfterClick, true);
      assert.equal(result.firstBoot.tabText, 'RW Status Settings');
      assert.equal(result.firstBoot.initTheme, 'packed-default');
      assert.equal(result.firstBoot.liveTheme, 'midnight');
      assert.equal(result.firstBoot.saveOk, true);
      assert.equal(result.firstBoot.addonStates.every((a) => a.status === 'active'), true);

      assert.equal(result.pageWorldSeesGlobals, false, 'ISOLATED world extension must not expose runtime globals to page MAIN world');
      assert.equal(result.crossWorldAttempt.ok, true);
      assert.equal(result.crossWorldAttempt.alreadyBooted, true);
      assert.equal(result.crossWorldAttempt.crossWorld, true);
      assert.equal(result.crossWorldAttempt.drawerCount, 1);

      assert.equal(result.drawerClosedByEscape, true, 'Escape key must close Remote Host drawer');

      assert.equal(result.afterReload.ok, true);
      assert.equal(result.afterReload.initThemeAfterReload, 'midnight', 'Saved settings must persist in localStorage across reload');

      assert.equal(result.onBlocked.ok, false);
      assert.equal(result.onBlocked.reason, 'ERR_ORIGIN_NOT_ALLOWED');
      assert.equal(result.onBlocked.hasDrawer, false);
      assert.equal(result.onBlocked.hasSlot, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
);

test(
  'TC-U6 (Real Chromium — v2.7.0): live 3-policy CSP + ppConfig + modular @require host lib + mobile 390x844 bottom-sheet drawer + clickable Settings Tab & Quick Action',
  { skip: ELECTRON_BIN ? false : 'electron devDependency not installed' },
  () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-v27-u6-e2e-'));
    try {
      const distRemoteDir = path.join(tmpDir, 'dist-remote');
      const built = buildDistRemote({
        targetDir: distRemoteDir,
        profile: ANTIGRAVITY_REMOTE_WEB_PROFILE,
        noAddons: true,
        hostVersion: '2.7.0',
      });
      assert.equal(built.ok, true);

      const hostLibPath = path.join(distRemoteDir, 'antigravity-remote-host.lib.js');
      assert.equal(fs.existsSync(hostLibPath), true);

      const runnerPath = path.join(tmpDir, 'chromium-u6-runner.cjs');
      fs.writeFileSync(
        runnerPath,
        `'use strict';
const http = require('node:http');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-dev-shm-usage');

const hostLibCode = fs.readFileSync(${JSON.stringify(hostLibPath)}, 'utf8');
${CLICK_SHADOW_TRUSTED_HELPER}

function startStrictLiveCspServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => {
      // Exact 3-policy intersected CSP pattern matching live antigravity.google.com headers
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': [
          "require-trusted-types-for 'script'; report-uri /_/csp",
          "script-src 'nonce-liveE2E99' 'unsafe-inline'; object-src 'none'; base-uri 'self'",
          "script-src 'nonce-liveE2E99' 'strict-dynamic' https:; object-src 'none'",
        ],
      });
      res.end(
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<script nonce="liveE2E99">window["ppConfig"] = { productName: "GoogleAntigravity", sealIsEnforced: true, deleteIsEnforced: true };</script>' +
        '</head><body><main id="app-root">Remote Workspace</main></body></html>'
      );
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      resolve({ srv, origin: 'http://127.0.0.1:' + addr.port });
    });
  });
}

app.whenReady().then(async () => {
  const target = await startStrictLiveCspServer();
  const win = new BrowserWindow({
    show: false,
    width: 390,
    height: 844,
    useContentSize: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  const consoleErrors = [];
  win.webContents.on('console-message', (_ev, level, message) => {
    if (level >= 2) consoleErrors.push(String(message));
  });

  try {
    await win.loadURL(target.origin + '/workspace');
    await ensureInputReady(win);
    // Load 0-addon host library into Isolated World 998 (matching @inject-into content)
    await win.webContents.executeJavaScriptInIsolatedWorld(998, [{ code: hostLibCode }]);

    const bootStep = await win.webContents.executeJavaScriptInIsolatedWorld(998, [
      {
        code: \`(async () => {
          const rt = globalThis.__addonHostRemoteRuntime;
          if (!rt) return { ok: false, reason: 'NO_RUNTIME' };

          // 1. Pre-boot modular registerAddon()
          const reg1 = rt.registerAddon({
            pluginMeta: {
              schemaVersion: 2,
              pluginId: 'u6-mobile-addon',
              displayName: 'Mobile Modular Addon',
              version: '1.0.0',
              trustLevel: 'restricted',
              capabilities: ['renderer'],
              uiSlots: [{ slot: 'modal', slotId: 'u6-mobile-addon.modal', anchor: 'modal', shadow: true }],
            },
            run(addonHost) {
              let count = 0;
              addonHost.registerAction('ping-action', {
                label: 'Ping Mobile',
                run() {
                  count += 1;
                  document.documentElement.setAttribute('data-u6-action-count', String(count));
                  return { count };
                },
              });
              addonHost.registerSettingsTab('mobile-settings', {
                label: 'Mobile Settings Modal',
                onSelect() {
                  const modal = addonHost.openModal('u6-mobile-addon.modal', { title: 'U6 Modal' });
                  if (modal && modal.bodyEl) {
                    const p = document.createElement('p');
                    p.textContent = 'U6_MODAL_OPENED';
                    modal.bodyEl.appendChild(p);
                    document.documentElement.setAttribute('data-u6-modal-open', String(Boolean(modal.element && modal.element.open)));
                  }
                },
              });
            },
          });

          const boot = await rt.bootRemoteWebHost({
            allowedOrigins: [\${JSON.stringify(target.origin)}],
            allowLoopbackHttp: true,
          });
          if (!boot.ok) return { ok: false, reason: boot.reason };
          globalThis.__u6Boot = boot;

          const drawerHost = document.getElementById('remote-addon-host-drawer-root');
          const sr = drawerHost && drawerHost.shadowRoot;
          const pill = sr.querySelector('.rah-pill');
          const pillRect = pill.getBoundingClientRect();
          const panel = sr.querySelector('#rah-drawer-panel');
          pill.click();
          const blockedSyntheticOpen = panel.hasAttribute('hidden');
          return {
            ok: true,
            reg1Queued: reg1.queued,
            pillHeight: pillRect.height,
            blockedSyntheticOpen,
          };
        })()\`,
      },
    ]);

    let outcome = bootStep;
    if (bootStep.ok) {
      await clickShadowTrusted(win, 998, '.rah-pill', 0);
      const panelMetrics = await win.webContents.executeJavaScriptInIsolatedWorld(998, [
        {
          code: \`(() => {
            const sr = document.getElementById('remote-addon-host-drawer-root').shadowRoot;
            const panelRect = sr.querySelector('#rah-drawer-panel').getBoundingClientRect();
            const actBtn = sr.querySelector('[data-host-action-plugin="u6-mobile-addon"][data-host-action-id="ping-action"]');
            const actRect = actBtn ? actBtn.getBoundingClientRect() : null;
            return {
              panelWidth: panelRect.width,
              panelBottom: panelRect.bottom,
              actBtnHeight: actRect ? actRect.height : 0,
            };
          })()\`,
        },
      ]);

      await clickShadowTrusted(win, 998, '[data-host-action-plugin="u6-mobile-addon"][data-host-action-id="ping-action"]', 0);
      await clickShadowTrusted(win, 998, '.rah-tab', 1);
      const settingsMetrics = await win.webContents.executeJavaScriptInIsolatedWorld(998, [
        {
          code: \`(() => {
            const sr = document.getElementById('remote-addon-host-drawer-root').shadowRoot;
            const settingsBtn = sr.querySelector('[data-settings-tab-action="select"]');
            const settingsRect = settingsBtn ? settingsBtn.getBoundingClientRect() : null;
            return { settingsBtnHeight: settingsRect ? settingsRect.height : 0 };
          })()\`,
        },
      ]);
      await clickShadowTrusted(win, 998, '[data-settings-tab-action="select"]', 0);

      const finalStep = await win.webContents.executeJavaScriptInIsolatedWorld(998, [
        {
          code: \`(async () => {
            const rt = globalThis.__addonHostRemoteRuntime;
            const boot = globalThis.__u6Boot;
            const sr = document.getElementById('remote-addon-host-drawer-root').shadowRoot;
            const drawerHiddenAfterSelect = sr.querySelector('#rah-drawer-panel').hasAttribute('hidden');
            const reg2 = rt.registerAddon({
              pluginMeta: {
                schemaVersion: 2,
                pluginId: 'u6-late-addon',
                displayName: 'Late Dynamic Addon',
                version: '1.0.0',
                trustLevel: 'restricted',
                capabilities: ['renderer'],
                uiSlots: [],
              },
              run() {
                document.documentElement.setAttribute('data-u6-late-mounted', 'yes');
              },
            });
            const lateMount = reg2.promise ? await reg2.promise : null;
            return {
              actionCount: document.documentElement.getAttribute('data-u6-action-count'),
              modalOpen: document.documentElement.getAttribute('data-u6-modal-open'),
              drawerHiddenAfterSelect,
              lateMounted: document.documentElement.getAttribute('data-u6-late-mounted'),
              lateStatus: lateMount ? lateMount.status : null,
              addonCount: boot.controller.getAddonStates().length,
            };
          })()\`,
        },
      ]);
      outcome = { ...bootStep, ...panelMetrics, ...settingsMetrics, ...finalStep };
    }

    process.stdout.write(JSON.stringify({ outcome, consoleErrors }) + '\\n');
    win.destroy();
    target.srv.close();
    app.exit(0);
  } catch (err) {
    process.stderr.write((err && err.stack ? err.stack : String(err)) + '\\n');
    target.srv.close();
    app.exit(1);
  }
});
`,
        'utf8'
      );

      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const args = [runnerPath];
      if (process.platform === 'linux') {
        args.unshift('--no-sandbox', '--disable-gpu');
      }
      const rawOut = execFileSync(ELECTRON_BIN, args, {
        env,
        encoding: 'utf8',
        timeout: 45000,
      });
      const result = JSON.parse(rawOut.trim().split(/\r?\n/).pop());
      assert.deepEqual(result.consoleErrors, [], `Expected 0 console/CSP errors, got: ${JSON.stringify(result.consoleErrors)}`);
      assert.equal(result.outcome.ok, true);
      assert.equal(result.outcome.reg1Queued, true);
      assert.equal(result.outcome.blockedSyntheticOpen, true, 'Synthetic pill.click() must be blocked by isTrusted guard');
      assert.ok(result.outcome.pillHeight >= 44, `Pill touch target must be >= 44px, got ${result.outcome.pillHeight}`);
      assert.ok(result.outcome.panelWidth >= 360, `Mobile 390px bottom-sheet width should span viewport, got ${result.outcome.panelWidth}`);
      assert.ok(result.outcome.actBtnHeight >= 44, `Quick action button must be >= 44px, got ${result.outcome.actBtnHeight}`);
      assert.ok(result.outcome.settingsBtnHeight >= 44, `Settings tab button must be >= 44px, got ${result.outcome.settingsBtnHeight}`);
      assert.equal(result.outcome.actionCount, '1');
      assert.equal(result.outcome.modalOpen, 'true');
      assert.equal(result.outcome.drawerHiddenAfterSelect, true);
      assert.equal(result.outcome.lateMounted, 'yes');
      assert.equal(result.outcome.lateStatus, 'active');
      assert.equal(result.outcome.addonCount, 2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
);

test(
  'TC-U8 (Real Chromium — v2.8.0): two independent @require modular addon Userscripts in separate Isolated Worlds (997 & 998) coexist cleanly in one unified mobile drawer under live 3-policy CSP',
  { skip: ELECTRON_BIN ? false : 'electron devDependency not installed' },
  () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-v28-u8-e2e-'));
    try {
      const distRemoteDir = path.join(tmpDir, 'dist-remote');
      const hostBuilt = buildDistRemote({
        targetDir: distRemoteDir,
        profile: ANTIGRAVITY_REMOTE_WEB_PROFILE,
        noAddons: true,
        hostVersion: '2.8.0',
      });
      assert.equal(hostBuilt.ok, true);
      const hostLibPath = path.join(distRemoteDir, 'antigravity-remote-host.lib.js');

      function writeSamplePlugin(pluginId, displayName, attrPrefix) {
        const dir = path.join(tmpDir, pluginId);
        fs.mkdirSync(dir, { recursive: true });
        const manifestPath = path.join(dir, 'addon.json');
        fs.writeFileSync(
          manifestPath,
          JSON.stringify({
            schemaVersion: 2,
            pluginId,
            displayName,
            version: '1.0.0',
            trustLevel: 'restricted',
            compatibility: {
              hostProfile: 'antigravity-desktop',
              hostProfiles: ['antigravity-desktop', 'antigravity-remote-web'],
              minHostVersion: '2.3.0',
            },
            capabilities: ['renderer'],
            entry: { rendererScript: 'renderer.js' },
            uiSlots: [{ slot: 'modal', slotId: `${pluginId}.modal`, anchor: 'modal', shadow: true }],
            isolation: { storageNamespace: pluginId, noTranslate: true, i18nSelfManaged: true },
          })
        );
        fs.writeFileSync(
          path.join(dir, 'renderer.js'),
          `let actCount = 0;
addonHost.registerAction('act', {
  label: '${displayName} Action',
  run() {
    actCount += 1;
    document.documentElement.setAttribute('data-${attrPrefix}-act', String(actCount));
  },
});
addonHost.registerSettingsTab('prefs', {
  label: '${displayName} Settings',
  onSelect() {
    const m = addonHost.openModal('${pluginId}.modal', { title: '${displayName}' });
    if (m && m.bodyEl) {
      const p = document.createElement('p');
      p.textContent = '${attrPrefix}_MODAL';
      m.bodyEl.appendChild(p);
      document.documentElement.setAttribute('data-${attrPrefix}-modal', String(Boolean(m.element && m.element.open)));
      m.close();
    }
  },
});
document.documentElement.setAttribute('data-${attrPrefix}-mounted', 'yes');
`
        );
        return buildAddonUserscript({
          manifestPath,
          pluginDir: dir,
          targetDir: path.join(tmpDir, `out-${pluginId}`),
          updateBaseUrl: `https://github.com/example/${pluginId}/releases/latest/download/`,
        });
      }

      const alphaBuilt = writeSamplePlugin('alpha-mod', 'Alpha Modular', 'alpha');
      const betaBuilt = writeSamplePlugin('beta-mod', 'Beta Modular', 'beta');
      assert.equal(alphaBuilt.ok, true);
      assert.equal(betaBuilt.ok, true);

      const runnerPath = path.join(tmpDir, 'chromium-u8-runner.cjs');
      fs.writeFileSync(
        runnerPath,
        `'use strict';
const http = require('node:http');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-dev-shm-usage');

const hostLibCode = fs.readFileSync(${JSON.stringify(hostLibPath)}, 'utf8');
const alphaCode = fs.readFileSync(${JSON.stringify(alphaBuilt.userscriptPath)}, 'utf8');
const betaCode = fs.readFileSync(${JSON.stringify(betaBuilt.userscriptPath)}, 'utf8');
${CLICK_SHADOW_TRUSTED_HELPER}

function startStrictLiveCspServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': [
          "require-trusted-types-for 'script'; report-uri /_/csp",
          "script-src 'nonce-liveU8' 'unsafe-inline'; object-src 'none'; base-uri 'self'",
          "script-src 'nonce-liveU8' 'strict-dynamic' https:; object-src 'none'",
        ],
      });
      res.end(
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<script nonce="liveU8">window["ppConfig"] = { productName: "GoogleAntigravity", sealIsEnforced: true };</script>' +
        '</head><body><main id="app-root">Remote Workspace</main></body></html>'
      );
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      resolve({ srv, origin: 'http://127.0.0.1:' + addr.port });
    });
  });
}

app.whenReady().then(async () => {
  const target = await startStrictLiveCspServer();
  const win = new BrowserWindow({
    show: false,
    width: 390,
    height: 844,
    useContentSize: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  const consoleErrors = [];
  win.webContents.on('console-message', (_ev, level, message) => {
    if (level >= 2) consoleErrors.push(String(message));
  });

  try {
    await win.loadURL(target.origin + '/workspace');
    await ensureInputReady(win);

    const patchBootOrigin = (code) =>
      code.replace(
        'rt.bootRemoteWebHost()',
        'rt.bootRemoteWebHost({ allowedOrigins: [' + JSON.stringify(target.origin) + '], allowLoopbackHttp: true })'
      );

    // Sandbox A (Isolated World 997): @require host lib + alpha-mod.user.js
    await win.webContents.executeJavaScriptInIsolatedWorld(997, [{ code: hostLibCode + '\\n' + patchBootOrigin(alphaCode) }]);
    await new Promise((r) => setTimeout(r, 80));

    // Sandbox B (Isolated World 998): @require host lib + beta-mod.user.js
    await win.webContents.executeJavaScriptInIsolatedWorld(998, [{ code: hostLibCode + '\\n' + patchBootOrigin(betaCode) }]);
    await new Promise((r) => setTimeout(r, 80));

    const pageWorldSeesGlobals = await win.webContents.executeJavaScript(
      'Boolean(globalThis.__addonHostKernel || globalThis.__addonHostRemoteRuntime)'
    );

    const preClick = await win.webContents.executeJavaScriptInIsolatedWorld(997, [
      {
        code: \`(() => {
          const drawerHost = document.getElementById('remote-addon-host-drawer-root');
          const sr = drawerHost && drawerHost.shadowRoot;
          if (!sr) return { ok: false, reason: 'NO_DRAWER' };
          const pill = sr.querySelector('.rah-pill');
          const badgeBefore = sr.querySelector('[data-rah-count-badge]').textContent;
          pill.click();
          const blockedSyntheticOpen = sr.querySelector('#rah-drawer-panel').hasAttribute('hidden');
          return { ok: true, badgeBefore, blockedSyntheticOpen };
        })()\`,
      },
    ]);

    let outcome = preClick;
    if (preClick.ok) {
      await clickShadowTrusted(win, 997, '.rah-pill', 0);
      await clickShadowTrusted(win, 997, '[data-host-action-plugin="alpha-mod"][data-host-action-id="act"]', 0);
      await clickShadowTrusted(win, 997, '[data-host-action-plugin="beta-mod"][data-host-action-id="act"]', 0);
      await clickShadowTrusted(win, 997, '.rah-tab', 1);
      await clickShadowTrusted(win, 997, '[data-settings-tab-plugin="alpha-mod"][data-settings-tab-id="prefs"]', 0);
      const closedAfterA = await win.webContents.executeJavaScriptInIsolatedWorld(997, [
        {
          code: \`Boolean(document.getElementById('remote-addon-host-drawer-root').shadowRoot.querySelector('#rah-drawer-panel').hasAttribute('hidden'))\`,
        },
      ]);

      await clickShadowTrusted(win, 997, '.rah-pill', 0);
      await clickShadowTrusted(win, 997, '.rah-tab', 1);
      await clickShadowTrusted(win, 997, '[data-settings-tab-plugin="beta-mod"][data-settings-tab-id="prefs"]', 0);
      const postClick = await win.webContents.executeJavaScriptInIsolatedWorld(997, [
        {
          code: \`(() => {
            const sr = document.getElementById('remote-addon-host-drawer-root').shadowRoot;
            return {
              drawerCount: document.querySelectorAll('#remote-addon-host-drawer-root').length,
              dockCount: document.querySelectorAll('#remote-addon-host-slot-dock').length,
              mountedAttr: document.documentElement.getAttribute('data-remote-addon-host-plugins'),
              alphaMounted: document.documentElement.getAttribute('data-alpha-mounted'),
              betaMounted: document.documentElement.getAttribute('data-beta-mounted'),
              alphaAct: document.documentElement.getAttribute('data-alpha-act'),
              betaAct: document.documentElement.getAttribute('data-beta-act'),
              alphaModal: document.documentElement.getAttribute('data-alpha-modal'),
              betaModal: document.documentElement.getAttribute('data-beta-modal'),
              closedAfterB: sr.querySelector('#rah-drawer-panel').hasAttribute('hidden'),
            };
          })()\`,
        },
      ]);
      outcome = { ...preClick, closedAfterA, ...postClick };
    }

    process.stdout.write(JSON.stringify({ outcome, pageWorldSeesGlobals, consoleErrors }) + '\\n');
    win.destroy();
    target.srv.close();
    app.exit(0);
  } catch (err) {
    process.stderr.write((err && err.stack ? err.stack : String(err)) + '\\n');
    target.srv.close();
    app.exit(1);
  }
});
`,
        'utf8'
      );

      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const args = [runnerPath];
      if (process.platform === 'linux') {
        args.unshift('--no-sandbox', '--disable-gpu');
      }
      const rawOut = execFileSync(ELECTRON_BIN, args, {
        env,
        encoding: 'utf8',
        timeout: 45000,
      });
      const result = JSON.parse(rawOut.trim().split(/\r?\n/).pop());
      assert.deepEqual(result.consoleErrors, [], `Expected 0 CSP/console errors, got: ${JSON.stringify(result.consoleErrors)}`);
      assert.equal(result.pageWorldSeesGlobals, false);
      assert.equal(result.outcome.ok, true);
      assert.equal(result.outcome.blockedSyntheticOpen, true, 'Synthetic pill.click() must be blocked by isTrusted guard');
      assert.equal(result.outcome.drawerCount, 1);
      assert.equal(result.outcome.dockCount, 1);
      assert.equal(result.outcome.mountedAttr, 'alpha-mod,beta-mod');
      assert.equal(result.outcome.badgeBefore, '2/2');
      assert.equal(result.outcome.alphaMounted, 'yes');
      assert.equal(result.outcome.betaMounted, 'yes');
      assert.equal(result.outcome.alphaAct, '1');
      assert.equal(result.outcome.betaAct, '1');
      assert.equal(result.outcome.alphaModal, 'true');
      assert.equal(result.outcome.betaModal, 'true');
      assert.equal(result.outcome.closedAfterA, true);
      assert.equal(result.outcome.closedAfterB, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
);
