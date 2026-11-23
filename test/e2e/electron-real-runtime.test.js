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
          '[data-addon-host-owner="e2e-first"]:is(*, .x) ~ * { color: red }',
          'body:is(*, .x) ~ * { color: red }',
          'body { ~ * { color: red } }',
          '[data-addon-host-owner="e2e-first"] { + * { color: red } }',
        ]) {
          try { addonHost.injectStyle('bad', badCss); } catch (e) { blockedErrors.push(e.message); }
        }
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
      assert.equal(res.initial.f1BlockedCount, '13');
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
