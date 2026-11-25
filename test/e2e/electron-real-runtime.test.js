'use strict';

/**
 * TC-016: Real Electron BrowserWindow + WebContentsView v2.0.0 Runtime E2E Test.
 *
 * Launches real Electron 45.4.1 with generated thin `addon-host-loader.js` shim + `dist/runtime/`:
 *   1. `initMain(app)` boots cleanly BEFORE `app.whenReady()`, registers `preload-bridge.cjs`
 *      on `session.defaultSession`, and wraps `wcv:set-portal-overlay-open` via `PortalArbiter`.
 *   2. Real `executeJavaScriptInIsolatedWorld(998)` isolates plugin prototype pollution from
 *      Page World 0 (`Object.prototype.get === undefined`, `window.__addonHostBootstrap === undefined`).
 *   3. Coexists v1 light-DOM slot + v2 Option B2 `HTMLElement` in `ShadowRoot` + ShadowRoot style
 *      isolation (`document.body` background untouched) + dangerous CSS rejection.
 *   4. Native `<dialog>` + `popover="manual"` LIFO dismissal via real Chromium `sendInputEvent('Escape')`.
 *   5. Disabling an addon in `config.json` + reload disposes BOTH its `mainHook` and DOM slot/style.
 *   6. Navigating to a disallowed origin (`about:blank`) injects 0 addon elements.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { ANTIGRAVITY_HOST_PROFILE } = require('../../src/profiles/antigravity');
const { buildHostLoaderScriptSource } = require('../../src/adapters/electron/host-loader-builder');
const { readDistRuntimeBuildInfo } = require('../../src/adapters/electron/electron-host-lifecycle-port');
const { snapshotPluginBundleInMemory, sha256Hex } = require('../../src/runtime/main/trust-verifier');

let ELECTRON_BIN = null;
try {
  ELECTRON_BIN = require('electron');
} catch (_err) {
  ELECTRON_BIN = null;
}

test(
  'TC-016 (v2 Real Electron E2E): BrowserWindow + initMain + World 998 + Option B2 ShadowRoot + CSS isolation + Escape LIFO + disable/reload dispose + about:blank abort',
  { skip: ELECTRON_BIN ? false : 'electron devDependency not installed' },
  () => {
    const buildInfo = readDistRuntimeBuildInfo();
    assert.ok(buildInfo, 'dist/runtime/build-manifest.json must exist (run npm run build:runtime)');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-v2-e2e-'));
    try {
      const pluginsRoot = path.join(dir, 'plugins');
      const addonsDir = path.join(dir, 'addons.d');
      const configPath = path.join(dir, 'config.json');
      const trustPolicyPath = path.join(dir, 'trust-policy.json');
      const loaderPath = path.join(dir, 'addon-host-loader.js');
      fs.mkdirSync(addonsDir, { recursive: true });
      fs.mkdirSync(path.join(pluginsRoot, 'e2e-first'), { recursive: true });
      fs.mkdirSync(path.join(pluginsRoot, 'e2e-second'), { recursive: true });

      // Plugin 1 (v2 restricted): pollutes Object.prototype.get in World 998, mounts Option B2 ShadowRoot + dangerous CSS rejection + native <dialog>/<popover>
      fs.writeFileSync(
        path.join(pluginsRoot, 'e2e-first', 'renderer.js'),
        `
        Object.defineProperty(Object.prototype, 'get', {
          configurable: true,
          writable: true,
          value() { return 'isolated-polluted'; },
        });
        const barRoot = addonHost.mountSlot('e2e-first.bar');
        barRoot.textContent = 'E2E_FIRST_READY';
        const autoSlot = addonHost.mountSlot('e2e-first.automation');
        if (autoSlot) {
          const inner = document.createElement('span');
          inner.className = 'auto-txt';
          inner.textContent = 'E2E_AUTO_SLOT';
          autoSlot.appendChild(inner);
        }
        addonHost.injectStyle('s1', '.auto-txt { color: rgb(10, 120, 40); } body { background: rgb(255, 0, 0) !important; }', { slotId: 'e2e-first.automation' });
        const blockedErrors = [];
        for (const badCss of [
          '[data-addon-host-owner="e2e-first"] ~ * { color: red }',
          '@\\\\69mport url("https://evil.example/x.css");',
          '@scope (body) { body { color: red } }',
          '.a { content: "\\n} body { color: red } }',
          '[data-addon-host-owner="e2e-first"] { & ~ * { color: red } }',
          '[data-addon-host-owner="e2e-first"] { body:has(&) { color: red } }',
          '.a { background: url(x") } body { display: none !important; } /* "); }',
          '.a { background: \\\\75\\r\\nrl(x") } body { display: none !important; } /* "); }',
          '.a { x: \\\\"; } body { display: none !important; } /* "; }',
          '.a { x: \\\\22 ; } .b { background: \\\\75 rl(x") } body { background: rgb(255, 0, 0) !important; } /* "); }',
          '.a { background: url(http://x/*); } .b { background: url("\\\\6a avascript:alert(1)"); } /* */); }',
          '[data-addon-host-owner="e2e-first"]:is(*, .x) ~ * { color: red }',
          'body:is(*, .x) ~ * { color: red }',
          '[data-addon-host-owner="e2e-first"]:is(*, a{x}) ~ * { background: rgb(255, 0, 0) !important; }',
          'body:is(*, a{x}) ~ * { background: rgb(255, 0, 0) !important; }',
          '[data-addon-host-owner="e2e-first"]:is(a;, *) ~ * { background: rgb(255, 0, 0) !important; }',
          'body { ~ * { color: red } }',
          '[data-addon-host-owner="e2e-first"] { + * { color: red } }',
        ]) {
          try { addonHost.injectStyle('bad', badCss); } catch (e) { blockedErrors.push(e.message); }
        }
        // F8 & F11 live Chromium proof: inject into Light DOM head; owner scoping & space-replaced comment keep body rgb(255,255,255)
        addonHost.injectStyle('f8-neutralized', '.a { x: //**/* "*/ } body { background: rgb(255, 0, 0) !important; } /* "; }');
        addonHost.injectStyle('f11-is-semi', ':is(body, a;) { background: rgb(255, 0, 0) !important; }');
        addonHost.injectStyle('f11-where-bracket', ':where(*, [x=;]) { background: rgb(255, 0, 0) !important; }');
        addonHost.injectStyle('f11-media-is', '@media all { :is(body, a;) { background: rgb(255, 0, 0) !important; } }');
        document.documentElement.setAttribute('data-e2e-f1-blocked', String(blockedErrors.length));
        addonHost.registerAction('e2e-act', {
          label: 'E2E_ACT',
          run() {
            document.documentElement.setAttribute('data-e2e-action-fired', 'yes');
            return 'OK';
          },
        });
        const modal = addonHost.openModal('e2e-first.modal');
        modal.bodyEl.textContent = 'MODAL_BODY_OK';
        const pop = addonHost.openPopover('e2e-first.popover');
        const popBtn = document.createElement('button');
        popBtn.id = 'e2e-pop-btn';
        popBtn.textContent = 'POPOVER_OK';
        popBtn.addEventListener('click', () => {
          document.documentElement.setAttribute('data-e2e-pop-clicked', 'yes');
        });
        pop.bodyEl.appendChild(popBtn);
        `,
        'utf8'
      );
      fs.writeFileSync(
        path.join(addonsDir, 'e2e-first.json'),
        JSON.stringify({
          schemaVersion: 2,
          pluginId: 'e2e-first',
          displayName: 'E2E First',
          version: '2.0.0',
          capabilities: ['renderer'],
          entry: { rendererScript: 'renderer.js' },
          uiSlots: [
            { slot: 'status-bar', slotId: 'e2e-first.bar', anchor: 'status-bar', exclusive: true, shadow: false },
            { slot: 'page-section', slotId: 'e2e-first.automation', anchor: 'automation-page' },
            { slot: 'modal', slotId: 'e2e-first.modal' },
            { slot: 'overlay', slotId: 'e2e-first.popover' },
          ],
          isolation: { noTranslate: true, i18nSelfManaged: true },
          loadOrder: 10,
        }),
        'utf8'
      );

      // Plugin 2 (v2 trusted): SHA-256 pinned renderer + mainHook, invokes e2e-first action, then disabled & disposed
      const p2RendererPath = path.join(pluginsRoot, 'e2e-second', 'renderer.js');
      fs.writeFileSync(
        p2RendererPath,
        `
        const el = addonHost.mountSlot('e2e-second.overlay', { fallbackToBody: true });
        el.textContent = 'E2E_SECOND_READY';
        addonHost.injectStyle('s2', '.e2e-second{color:blue}');
        addonHost.invokeAction('e2e-first', 'e2e-act');
        addonHost.onDispose(() => {
          document.documentElement.setAttribute('data-e2e-second-disposed', 'yes');
        });
        `,
        'utf8'
      );
      fs.writeFileSync(
        path.join(pluginsRoot, 'e2e-second', 'hook.cjs'),
        `
        let disposed = 0;
        module.exports = {
          onMainReady(broker) {
            globalThis.__e2eHookState = {
              get disposed() { return disposed; },
              brokerFrozen: Object.isFrozen(broker),
              quitHidden: typeof broker.quit === 'undefined',
            };
            broker.onDispose(() => { disposed++; });
          },
        };
        `,
        'utf8'
      );
      fs.writeFileSync(
        path.join(addonsDir, 'e2e-second.json'),
        JSON.stringify({
          schemaVersion: 2,
          pluginId: 'e2e-second',
          displayName: 'E2E Second',
          version: '2.0.0',
          trustLevel: 'trusted',
          capabilities: ['mainHook', 'renderer'],
          entry: { rendererScript: 'renderer.js', mainHookScript: 'hook.cjs' },
          uiSlots: [{ slot: 'overlay', slotId: 'e2e-second.overlay', shadow: false }],
          isolation: { noTranslate: true, i18nSelfManaged: true },
          loadOrder: 20,
        }),
        'utf8'
      );

      fs.writeFileSync(
        trustPolicyPath,
        JSON.stringify({
          schemaVersion: 1,
          approved: {
            'e2e-second': {
              pluginId: 'e2e-second',
              version: '2.0.0',
              rendererSha256: sha256Hex(fs.readFileSync(p2RendererPath)),
              mainHookBundleSha256: snapshotPluginBundleInMemory(path.join(pluginsRoot, 'e2e-second')).bundleSha256,
              approvedAt: new Date().toISOString(),
            },
          },
        }),
        'utf8'
      );
      fs.writeFileSync(configPath, JSON.stringify({ plugins: {} }), 'utf8');

      const loaderSrc = buildHostLoaderScriptSource(
        {
          ADDONS_DIR: addonsDir,
          PLUGINS_ROOT_DIR: pluginsRoot,
          CONFIG_JSON_PATH: configPath,
          TRUST_POLICY_PATH: trustPolicyPath,
        },
        ANTIGRAVITY_HOST_PROFILE,
        {
          runtimeEntryDir: buildInfo.distRuntimeDir,
          buildSha8: buildInfo.buildSha8,
        }
      );
      fs.writeFileSync(loaderPath, loaderSrc, 'utf8');

      const appScript = path.join(dir, 'electron-e2e-main.cjs');
      fs.writeFileSync(
        appScript,
        `'use strict';
        const http = require('node:http');
        const fs = require('node:fs');
        const { app, BrowserWindow } = require('electron');

        app.commandLine.appendSwitch('no-sandbox');
        app.commandLine.appendSwitch('disable-gpu');
        app.commandLine.appendSwitch('disable-dev-shm-usage');

        const loader = require(${JSON.stringify(loaderPath)});
        const configPath = ${JSON.stringify(configPath)};
        const controller = loader.initMain(app);

        async function waitFor(fn, timeoutMs = 8000) {
          const start = Date.now();
          while (Date.now() - start < timeoutMs) {
            const val = await fn();
            if (val) return val;
            await new Promise((r) => setTimeout(r, 50));
          }
          throw new Error('E2E_WAIT_TIMEOUT');
        }

        app.whenReady().then(async () => {
          const server = http.createServer((_req, res) => {
            // S-1: Enforce strict script-src 'self' (no 'unsafe-eval') to prove CSP-safe staged-handle execution
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'",
            });
            res.end('<!doctype html><html><body style="background:rgb(255,255,255)"><div data-testid="status-bar"></div><div data-testid="automation-view"></div></body></html>');
          });
          await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
          const port = server.address().port;

          const win = new BrowserWindow({
            width: 800,
            height: 600,
            show: false,
            webPreferences: {
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
            },
          });

          try {
            await win.loadURL('http://127.0.0.1:' + port + '/home');
            const initial = await waitFor(() =>
              win.webContents.executeJavaScript(\`(() => {
                const s1 = document.querySelector('[data-addon-host-owner="e2e-first"][data-addon-host-slot="e2e-first.bar"]');
                const s2 = document.querySelector('[data-addon-host-owner="e2e-second"][data-addon-host-slot="e2e-second.overlay"]');
                const autoHost = document.querySelector('[data-testid="automation-view"] > [data-addon-host-owner="e2e-first"][data-addon-host-slot="e2e-first.automation"]');
                const dlg = document.querySelector('dialog[data-addon-host-modal-dialog="1"]');
                const pop = document.querySelector('[data-addon-host-popover="1"]');
                if (!s1 || !s2 || !autoHost || !autoHost.shadowRoot || !dlg || !pop) return null;
                const autoTxt = autoHost.shadowRoot.querySelector('.auto-txt');
                if (!autoTxt) return null;
                const popBtn = pop.shadowRoot ? pop.shadowRoot.querySelector('#e2e-pop-btn') : pop.querySelector('#e2e-pop-btn');
                if (!popBtn) return null;
                popBtn.focus();
                const popBtnFocused = (pop.shadowRoot ? pop.shadowRoot.activeElement : document.activeElement) === popBtn;
                popBtn.click();
                return {
                  firstText: s1.textContent,
                  firstTranslate: s1.getAttribute('translate'),
                  firstAgyAttr: s1.getAttribute('data-agy-no-translate'),
                  autoInShadow: true,
                  autoColor: getComputedStyle(autoTxt).color,
                  bodyBg: getComputedStyle(document.body).backgroundColor,
                  f1BlockedCount: document.documentElement.getAttribute('data-e2e-f1-blocked'),
                  actionFired: document.documentElement.getAttribute('data-e2e-action-fired'),
                  secondText: s2.textContent,
                  dlgOpen: dlg.open,
                  popOpen: pop.matches(':popover-open'),
                  popInsideDialog: dlg.contains(pop),
                  popBtnFocused,
                  popClicked: document.documentElement.getAttribute('data-e2e-pop-clicked'),
                  mainWorldObjectProtoGet: typeof Object.prototype.get,
                  mainWorldBootstrapExposed: typeof window.__addonHostBootstrap,
                };
              })()\`)
            );

            // Real Escape #1 closes top-most popover while <dialog> stays open; Escape #2 closes <dialog>
            try { win.setOpacity(0); } catch (_e) {}
            win.showInactive();
            win.webContents.focus();
            await new Promise((r) => setTimeout(r, 50));
            win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
            win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
            await new Promise((r) => setTimeout(r, 120));
            const afterEsc1 = await win.webContents.executeJavaScript(\`({
              dlgOpen: Boolean(document.querySelector('dialog[data-addon-host-modal-dialog="1"]')?.open),
              popPresent: Boolean(document.querySelector('[data-addon-host-popover="1"]')),
            })\`);

            win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
            win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
            await new Promise((r) => setTimeout(r, 120));
            const afterEsc2 = await win.webContents.executeJavaScript(\`({
              dlgPresent: Boolean(document.querySelector('dialog[data-addon-host-modal-dialog="1"]')),
            })\`);

            // Disable e2e-second -> reconcile mainHook & reload renderer
            fs.writeFileSync(configPath, JSON.stringify({ plugins: { 'e2e-second': { enabled: false } } }), 'utf8');
            await controller.reconcileMainHooks();
            win.webContents.emit('did-finish-load');
            const afterDisable = await waitFor(() =>
              win.webContents.executeJavaScript(\`(() => {
                if (document.documentElement.getAttribute('data-e2e-second-disposed') !== 'yes') return null;
                return {
                  secondRemainingEls: document.querySelectorAll('[data-addon-host-owner="e2e-second"]').length,
                  firstRemainingEls: document.querySelectorAll('[data-addon-host-owner="e2e-first"]').length,
                };
              })()\`)
            );

            await new Promise((resolve) => {
              win.webContents.once('did-finish-load', resolve);
              win.webContents.reload();
            });
            const afterReload = await waitFor(() =>
              win.webContents.executeJavaScript(\`(() => {
                const s1 = document.querySelector('[data-addon-host-owner="e2e-first"][data-addon-host-slot="e2e-first.bar"]');
                if (!s1) return null;
                return {
                  secondRemainingEls: document.querySelectorAll('[data-addon-host-owner="e2e-second"]').length,
                };
              })()\`)
            );

            await win.loadURL('about:blank');
            await new Promise((r) => setTimeout(r, 120));
            const blankCount = await win.webContents.executeJavaScript('document.querySelectorAll("[data-addon-host-owner]").length');

            process.stdout.write('E2E_RESULT:' + JSON.stringify({
              electronVersion: process.versions.electron,
              initial,
              afterEsc1,
              afterEsc2,
              afterDisable,
              afterReload,
              mainHookDisposed: globalThis.__e2eHookState ? globalThis.__e2eHookState.disposed : -1,
              mainHookBroker: globalThis.__e2eHookState ? {
                brokerFrozen: globalThis.__e2eHookState.brokerFrozen,
                quitHidden: globalThis.__e2eHookState.quitHidden,
              } : null,
              lifecycleStates: controller.getAddonLifecycleStates(),
              blankCount,
            }) + '\\n');
            server.close();
            win.destroy();
            app.exit(0);
          } catch (err) {
            process.stderr.write(String(err && err.stack ? err.stack : err) + '\\n');
            server.close();
            app.exit(1);
          }
        });
        `,
        'utf8'
      );

      const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
      delete env.ELECTRON_RUN_AS_NODE;

      const stdout = execFileSync(ELECTRON_BIN, ['--no-sandbox', '--disable-gpu', appScript], {
        encoding: 'utf8',
        env,
        timeout: 30000,
      });

      const line = stdout.split(/\r?\n/).find((l) => l.startsWith('E2E_RESULT:'));
      assert.ok(line, `Expected E2E_RESULT line in Electron stdout, got:\n${stdout}`);
      const res = JSON.parse(line.slice('E2E_RESULT:'.length));

      assert.ok(res.electronVersion);
      assert.equal(res.initial.firstText, 'E2E_FIRST_READY');
      assert.equal(res.initial.firstTranslate, 'no');
      assert.equal(res.initial.firstAgyAttr, 'true');
      assert.equal(res.initial.autoInShadow, true);
      assert.equal(res.initial.autoColor, 'rgb(10, 120, 40)');
      assert.equal(res.initial.bodyBg, 'rgb(255, 255, 255)');
      assert.equal(res.initial.f1BlockedCount, '18');
      assert.equal(res.initial.actionFired, 'yes');
      assert.equal(res.initial.secondText, 'E2E_SECOND_READY');
      assert.equal(res.initial.dlgOpen, true);
      assert.equal(res.initial.popOpen, true);
      assert.equal(res.initial.popInsideDialog, true);
      assert.equal(res.initial.popBtnFocused, true);
      assert.equal(res.initial.popClicked, 'yes');
      assert.equal(res.initial.mainWorldObjectProtoGet, 'undefined');
      assert.equal(res.initial.mainWorldBootstrapExposed, 'undefined');
      assert.equal(res.afterEsc1.dlgOpen, true);
      assert.equal(res.afterEsc1.popPresent, false);
      assert.equal(res.afterEsc2.dlgPresent, false);
      assert.equal(res.afterDisable.secondRemainingEls, 0);
      assert.ok(res.afterDisable.firstRemainingEls >= 2);
      assert.equal(res.afterReload.secondRemainingEls, 0);
      assert.equal(res.mainHookDisposed, 1);
      assert.deepEqual(res.mainHookBroker, { brokerFrozen: true, quitHidden: true });
      assert.equal(res.lifecycleStates['e2e-second'], 'DISPOSED');
      assert.equal(res.blankCount, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

test(
  'TC-GM-E2E (v2.5.3 Real Electron E2E): uiGridMerges merges split 2-column plugin grids (Swarm + GitHub) with pure CSS and zero DOM mutation',
  { skip: ELECTRON_BIN ? false : 'electron devDependency not installed' },
  () => {
    const buildInfo = readDistRuntimeBuildInfo();
    assert.ok(buildInfo, 'dist/runtime/build-manifest.json must exist (run npm run build:runtime)');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-v253-gm-'));
    try {
      const pluginsRoot = path.join(dir, 'plugins');
      const addonsDir = path.join(dir, 'addons.d');
      const configPath = path.join(dir, 'config.json');
      const trustPolicyPath = path.join(dir, 'trust-policy.json');
      const loaderPath = path.join(dir, 'addon-host-loader.js');
      fs.mkdirSync(addonsDir, { recursive: true });
      fs.mkdirSync(pluginsRoot, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({ plugins: {} }), 'utf8');
      fs.writeFileSync(trustPolicyPath, JSON.stringify({ schemaVersion: 1, approved: {} }), 'utf8');

      const loaderSrc = buildHostLoaderScriptSource(
        {
          ADDONS_DIR: addonsDir,
          PLUGINS_ROOT_DIR: pluginsRoot,
          CONFIG_JSON_PATH: configPath,
          TRUST_POLICY_PATH: trustPolicyPath,
        },
        ANTIGRAVITY_HOST_PROFILE,
        {
          runtimeEntryDir: buildInfo.distRuntimeDir,
          buildSha8: buildInfo.buildSha8,
        }
      );
      fs.writeFileSync(loaderPath, loaderSrc, 'utf8');

      const appScript = path.join(dir, 'electron-gm-main.cjs');
      fs.writeFileSync(
        appScript,
        `'use strict';
        const http = require('node:http');
        const { app, BrowserWindow } = require('electron');

        app.commandLine.appendSwitch('no-sandbox');
        app.commandLine.appendSwitch('disable-gpu');
        app.commandLine.appendSwitch('disable-dev-shm-usage');

        const loader = require(${JSON.stringify(loaderPath)});
        loader.initMain(app);

        async function waitFor(fn, timeoutMs = 8000) {
          const start = Date.now();
          while (Date.now() - start < timeoutMs) {
            const val = await fn();
            if (val) return val;
            await new Promise((r) => setTimeout(r, 50));
          }
          throw new Error('GM_E2E_WAIT_TIMEOUT');
        }

        app.whenReady().then(async () => {
          const html = \`<!doctype html><html><head><style>
            * { box-sizing: border-box; }
            body { margin: 0; padding: 24px; font-family: sans-serif; }
            .flex { display: flex; }
            .flex-col { flex-direction: column; }
            .gap-3 { gap: 12px; }
            .gap-2 { gap: 8px; }
            .grid { display: grid; }
            .grid-cols-1 { grid-template-columns: repeat(1, minmax(0, 1fr)); }
            @media (min-width: 640px) {
              .sm\\\\:grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
            }
            .card { height: 72px; border: 1px solid #333; padding: 8px; }
          </style></head><body>
            <section class="flex flex-col gap-3" data-testid="customizations-installed-plugins">
              <div id="hdr" style="height: 28px">플러그인 6</div>
              <div class="flex flex-col gap-2">
                <div class="grid gap-2 grid-cols-1 sm:grid-cols-2">
                  <div id="p1" class="card">MCP Manager</div>
                  <div id="p2" class="card">Antigravity Statusbar</div>
                  <div id="p3" class="card">Ko Translator</div>
                  <div id="p4" class="card">Sennard</div>
                  <div id="p5" class="card">Swarm</div>
                </div>
                <button id="show-more" type="button" style="height: 30px">더 보기</button>
              </div>
              <div class="grid gap-2 grid-cols-1 sm:grid-cols-2" data-testid="cloud-app-cards">
                <div id="p6" class="card">GitHub</div>
              </div>
            </section>
          </body></html>\`;

          const server = http.createServer((_req, res) => {
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'",
            });
            res.end(html);
          });
          await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
          const port = server.address().port;

          const win = new BrowserWindow({
            width: 1024,
            height: 768,
            show: false,
            webPreferences: {
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
            },
          });

          const measureScript = \`(() => {
            const rect = (id) => {
              const b = document.getElementById(id).getBoundingClientRect();
              return {
                left: Math.round(b.left),
                top: Math.round(b.top),
                right: Math.round(b.right),
                bottom: Math.round(b.bottom),
                width: Math.round(b.width),
                height: Math.round(b.height),
              };
            };
            const hdr = rect('hdr');
            const p1 = rect('p1');
            const p2 = rect('p2');
            const p5 = rect('p5');
            const p6 = rect('p6');
            const showMore = rect('show-more');
            return {
              viewportWidth: window.innerWidth,
              styleCount: document.querySelectorAll('style[data-addon-host-ui-grid-merge="1"]').length,
              hdr,
              p1,
              p2,
              p5_swarm: p5,
              p6_github: p6,
              showMore,
              sameRowAsSwarm: Math.abs(p6.top - p5.top) <= 2,
              rightOfSwarm: p6.left > p5.right,
              domParentIntact: document.getElementById('p6').parentElement.getAttribute('data-testid') === 'cloud-app-cards',
            };
          })()\`;

          try {
            await win.loadURL('http://127.0.0.1:' + port + '/customizations');
            await waitFor(async () => {
              const booted = await win.webContents.executeJavaScriptInIsolatedWorld(998, [
                { code: 'Boolean(globalThis.__addonHostKernel && globalThis.__addonHostKernel.getBridgeStatus().booted)' },
              ]);
              return booted ? true : null;
            });
            // Allow one animation frame for Chromium style recalc
            await new Promise((r) => setTimeout(r, 80));
            const desktop = await win.webContents.executeJavaScript(measureScript);

            // Narrow viewport (< 640px) must keep 1-column mobile stack
            win.setContentSize(520, 768);
            await new Promise((r) => setTimeout(r, 120));
            const mobile = await win.webContents.executeJavaScript(measureScript);

            process.stdout.write('GM_E2E_RESULT:' + JSON.stringify({ desktop, mobile }) + '\\n');
            server.close();
            win.destroy();
            app.exit(0);
          } catch (err) {
            process.stderr.write(String(err && err.stack ? err.stack : err) + '\\n');
            server.close();
            app.exit(1);
          }
        });
        `,
        'utf8'
      );

      const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
      delete env.ELECTRON_RUN_AS_NODE;

      const stdout = execFileSync(ELECTRON_BIN, ['--no-sandbox', '--disable-gpu', appScript], {
        encoding: 'utf8',
        env,
        timeout: 30000,
      });

      const line = stdout.split(/\r?\n/).find((l) => l.startsWith('GM_E2E_RESULT:'));
      assert.ok(line, `Expected GM_E2E_RESULT line in Electron stdout, got:\n${stdout}`);
      const res = JSON.parse(line.slice('GM_E2E_RESULT:'.length));
      const d = res.desktop;
      const m = res.mobile;

      assert.equal(d.styleCount, 1, `Expected 1 ui-grid-merge style element; desktop=${JSON.stringify(d)}`);
      assert.equal(d.domParentIntact, true, `React DOM parent must stay cloud-app-cards; desktop=${JSON.stringify(d)}`);
      assert.equal(d.sameRowAsSwarm, true, `GitHub must be on same row as Swarm; desktop=${JSON.stringify(d)}`);
      assert.equal(d.rightOfSwarm, true, `GitHub must be to the right of Swarm; desktop=${JSON.stringify(d)}`);
      assert.ok(Math.abs(d.p6_github.left - d.p2.left) <= 2, `GitHub left must align with col 2; desktop=${JSON.stringify(d)}`);
      assert.ok(Math.abs(d.p6_github.width - d.p5_swarm.width) <= 2, `GitHub width must match Swarm; desktop=${JSON.stringify(d)}`);
      assert.ok(Math.abs(d.hdr.width - (d.p2.right - d.p1.left)) <= 4, `Header must span full width; desktop=${JSON.stringify(d)}`);
      assert.ok(d.showMore.top >= d.p6_github.bottom, `Show-more button must sit below merged grid; desktop=${JSON.stringify(d)}`);
      assert.ok(Math.abs(d.showMore.width - d.hdr.width) <= 4, `Show-more button must span full width; desktop=${JSON.stringify(d)}`);

      assert.equal(m.domParentIntact, true, `Mobile DOM parent must stay intact; mobile=${JSON.stringify(m)}`);
      assert.ok(m.p6_github.top >= m.p5_swarm.bottom, `Mobile (<640px) must keep 1-column vertical stack; mobile=${JSON.stringify(m)}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);
