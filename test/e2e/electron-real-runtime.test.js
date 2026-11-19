'use strict';

/**
 * TC-016 (R6-F5): Real Electron BrowserWindow + executeJavaScriptInIsolatedWorld E2E Test.
 *
 * Launches a real headless Electron process (devDependency), attaches the generated
 * `addon-host-loader.js` via `app.on('web-contents-created', ...)`, loads a real local
 * HTTP page in a `BrowserWindow`, and verifies:
 *   1. Real `executeJavaScriptInIsolatedWorld` isolates plugin prototype pollution from main world.
 *   2. Real Chromium DOM receives `translate="no"`, `data-addon-host-owner`, `data-agy-no-translate="true"`, and `<style>`.
 *   3. Disabling an addon in `config.json` + reload disposes BOTH its `mainHook` and its Chromium DOM slot/style.
 *   4. Navigating to a disallowed origin (`about:blank`) triggers `did-start-navigation` and injects 0 addons.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { ANTIGRAVITY_HOST_PROFILE } = require('../../src/profiles/antigravity');
const { buildHostLoaderScriptSource } = require('../../src/adapters/electron/host-loader-builder');

let ELECTRON_BIN = null;
try {
  ELECTRON_BIN = require('electron');
} catch (_err) {
  ELECTRON_BIN = null;
}

test(
  'TC-016 (R6-F5): real Electron BrowserWindow E2E verifies executeJavaScriptInIsolatedWorld, DOM slots/styles, prototype isolation, disabled dispose, and navigation abort',
  { skip: ELECTRON_BIN ? false : 'electron devDependency not installed' },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-electron-e2e-'));
    try {
      const pluginsRoot = path.join(dir, 'plugins');
      const addonsDir = path.join(dir, 'addons.d');
      const configPath = path.join(dir, 'config.json');
      const loaderPath = path.join(dir, 'addon-host-loader.js');
      fs.mkdirSync(addonsDir, { recursive: true });
      fs.mkdirSync(path.join(pluginsRoot, 'e2e-first'), { recursive: true });
      fs.mkdirSync(path.join(pluginsRoot, 'e2e-second'), { recursive: true });

      // Plugin 1: pollutes Object.prototype.get & Function.prototype.call inside isolated world, mounts slot
      fs.writeFileSync(
        path.join(pluginsRoot, 'e2e-first', 'renderer.js'),
        `
        Object.defineProperty(Object.prototype, 'get', {
          configurable: true,
          writable: true,
          value() { return 'isolated-polluted'; },
        });
        const el = addonHost.mountSlot('e2e-first.bar');
        el.textContent = 'E2E_FIRST_READY';
        addonHost.injectStyle('s1', '.e2e-first{color:green}');
        `,
        'utf8'
      );
      fs.writeFileSync(
        path.join(addonsDir, 'e2e-first.json'),
        JSON.stringify({
          schemaVersion: 1,
          pluginId: 'e2e-first',
          displayName: 'E2E First',
          version: '1.0.0',
          capabilities: ['renderer'],
          entry: { rendererScript: 'renderer.js', mainHookScript: null },
          uiSlots: [{ slot: 'status-bar', slotId: 'e2e-first.bar', exclusive: true }],
          isolation: { noTranslate: true, i18nSelfManaged: true, storageNamespace: 'e2e-first' },
          loadOrder: 10,
        }),
        'utf8'
      );

      // Plugin 2: mounts slot + style + mainHook, then gets disabled on reload
      fs.writeFileSync(
        path.join(pluginsRoot, 'e2e-second', 'renderer.js'),
        `
        const el = addonHost.mountSlot('e2e-second.overlay');
        el.textContent = 'E2E_SECOND_READY';
        addonHost.injectStyle('s2', '.e2e-second{color:blue}');
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
          activate(ctx) { ctx.app.__e2eHookState = { get disposed() { return disposed; } }; },
          dispose() { disposed++; },
        };
        `,
        'utf8'
      );
      fs.writeFileSync(
        path.join(addonsDir, 'e2e-second.json'),
        JSON.stringify({
          schemaVersion: 1,
          pluginId: 'e2e-second',
          displayName: 'E2E Second',
          version: '1.0.0',
          capabilities: ['mainHook', 'renderer'],
          entry: { rendererScript: 'renderer.js', mainHookScript: 'hook.cjs' },
          uiSlots: [{ slot: 'overlay', slotId: 'e2e-second.overlay' }],
          isolation: { noTranslate: true, i18nSelfManaged: true, storageNamespace: 'e2e-second' },
          loadOrder: 20,
        }),
        'utf8'
      );

      fs.writeFileSync(configPath, JSON.stringify({ plugins: {} }), 'utf8');

      const loaderSrc = buildHostLoaderScriptSource(
        {
          ADDONS_DIR: addonsDir,
          PLUGINS_ROOT_DIR: pluginsRoot,
          CONFIG_JSON_PATH: configPath,
        },
        ANTIGRAVITY_HOST_PROFILE
      );
      fs.writeFileSync(loaderPath, loaderSrc, 'utf8');

      const appScript = path.join(dir, 'electron-e2e-main.cjs');
      fs.writeFileSync(
        appScript,
        `
        'use strict';
        const http = require('node:http');
        const fs = require('node:fs');
        const { app, BrowserWindow } = require('electron');

        app.commandLine.appendSwitch('no-sandbox');
        app.commandLine.appendSwitch('disable-gpu');
        app.commandLine.appendSwitch('disable-dev-shm-usage');

        const loader = require(${JSON.stringify(loaderPath)});
        const configPath = ${JSON.stringify(configPath)};

        app.on('web-contents-created', (_event, contents) => {
          loader.attachWebContents(contents, app);
        });

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
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<!doctype html><html><head><title>E2E</title></head><body><div id="app">Host</div></body></html>');
          });
          await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
          const port = server.address().port;

          const win = new BrowserWindow({
            show: false,
            webPreferences: {
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
                if (!s1 || !s2) return null;
                return {
                  firstText: s1.textContent,
                  firstTranslate: s1.getAttribute('translate'),
                  firstAgyAttr: s1.getAttribute('data-agy-no-translate'),
                  secondText: s2.textContent,
                  mainWorldObjectProtoGet: typeof Object.prototype.get,
                  mainWorldHostApiExposed: typeof window.__ADDON_HOST_API__,
                  styleCount: document.querySelectorAll('style[data-addon-host-owner]').length,
                };
              })()\`)
            );

            // Disable e2e-second in config.json and trigger did-finish-load on same document (or reload)
            fs.writeFileSync(configPath, JSON.stringify({ plugins: { 'e2e-second': { enabled: false } } }), 'utf8');
            win.webContents.emit('did-finish-load');
            const afterDisable = await waitFor(() =>
              win.webContents.executeJavaScript(\`(() => {
                const disposedAttr = document.documentElement.getAttribute('data-e2e-second-disposed');
                if (disposedAttr !== 'yes') return null;
                return {
                  disposedAttr,
                  secondRemainingEls: document.querySelectorAll('[data-addon-host-owner="e2e-second"]').length,
                  firstRemainingEls: document.querySelectorAll('[data-addon-host-owner="e2e-first"]').length,
                };
              })()\`)
            );

            // Navigate to disallowed origin (about:blank) -> must inject 0 addon elements
            await win.loadURL('about:blank');
            await new Promise((r) => setTimeout(r, 150));
            const blankCount = await win.webContents.executeJavaScript(
              'document.querySelectorAll("[data-addon-host-owner]").length'
            );

            const result = {
              electronVersion: process.versions.electron,
              initial,
              afterDisable,
              mainHookDisposed: app.__e2eHookState ? app.__e2eHookState.disposed : -1,
              blankCount,
            };
            process.stdout.write('E2E_RESULT:' + JSON.stringify(result) + '\\n');
            server.close();
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

      const line = stdout
        .split(/\r?\n/)
        .find((l) => l.startsWith('E2E_RESULT:'));
      assert.ok(line, `Expected E2E_RESULT line in Electron stdout, got:\n${stdout}`);
      const res = JSON.parse(line.slice('E2E_RESULT:'.length));

      assert.ok(res.electronVersion, 'Real Electron runtime version present');
      assert.equal(res.initial.firstText, 'E2E_FIRST_READY');
      assert.equal(res.initial.firstTranslate, 'no');
      assert.equal(res.initial.firstAgyAttr, 'true');
      assert.equal(res.initial.secondText, 'E2E_SECOND_READY');
      assert.equal(res.initial.styleCount, 2);
      assert.equal(res.initial.mainWorldObjectProtoGet, 'undefined', 'Isolated world must protect main-world Object.prototype');
      assert.equal(res.initial.mainWorldHostApiExposed, 'undefined', 'Isolated world must not expose host globals in main world');
      assert.equal(res.afterDisable.disposedAttr, 'yes');
      assert.equal(res.afterDisable.secondRemainingEls, 0);
      assert.equal(res.afterDisable.firstRemainingEls, 2);
      assert.equal(res.mainHookDisposed, 1);
      assert.equal(res.blankCount, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);
