'use strict';

/**
 * Real Chromium / Electron 45 E2E Verification for v3.0.0 API-First Framework:
 * - Real Top Layer <dialog> & popover="manual"
 * - Real getBoundingClientRect() PlacementEngine anchor flip/shift + mobile <=640px bottom-sheet switch
 * - Non-removable `Addon: <displayName>` attribution badge
 * - Tier-2 ID-based in-place `handle.update(nextTree)` preserving focus on active <input>
 * - Real trusted user click (`sendInputEvent`) vs blocked synthetic `.click()`
 * - ISP verification (`env.hostProfileId === undefined`, undeclared `net`/`configBridge` undefined)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { buildRendererKernelBundleSource } = require('../../scripts/build-runtime');

let ELECTRON_BIN = null;
try {
  ELECTRON_BIN = require('electron');
} catch (_e) {
  ELECTRON_BIN = null;
}

test(
  'TC-V30-E2E (Real Chromium): AddonContextV3 Tier 1/2 UI, anchor flip/shift, mobile sheet, in-place focus patch & trusted clicks',
  { skip: ELECTRON_BIN ? false : 'electron devDependency not installed' },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-v30-e2e-'));
    try {
      const kernelPath = path.join(dir, 'kernel-bundle.cjs');
      fs.writeFileSync(kernelPath, buildRendererKernelBundleSource({ includeHostSettingsUi: false }), 'utf8');

      const mainScript = path.join(dir, 'e2e-v30-main.cjs');
      fs.writeFileSync(
        mainScript,
        `'use strict';
        const fs = require('node:fs');
        const { app, BrowserWindow } = require('electron');
        app.commandLine.appendSwitch('no-sandbox');
        app.commandLine.appendSwitch('disable-gpu');
        app.commandLine.appendSwitch('disable-dev-shm-usage');

        const kernelSrc = fs.readFileSync(${JSON.stringify(kernelPath)}, 'utf8');

        app.whenReady().then(async () => {
          const win = new BrowserWindow({
            width: 960,
            height: 620,
            show: false,
            webPreferences: { contextIsolation: true, sandbox: true },
          });
          await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
            '<!doctype html><html><body style="margin:0;height:100vh;width:100vw;">' +
            '<button id="anchor-btn" style="position:fixed;right:12px;bottom:12px;width:80px;height:36px;">Anchor</button>' +
            '</body></html>'
          ));

          const initRes = await win.webContents.executeJavaScript(\`(() => {
            \${kernelSrc}
            const k = globalThis.__addonHostKernel;
            const tok = 'e2e-v30-host-token-0123456789abcdef';
            k.boot({
              docGenId: 1,
              hostToken: tok,
              hostProfileId: 'e2e-desktop',
              surface: 'desktop',
              hostBridge: {
                docGenId: 1,
                profileId: 'e2e-desktop',
                setPortalClaim: () => ({ ok: true }),
                saveSettings: () => Promise.resolve({ ok: true }),
                reportError: () => {},
                ping: () => Promise.resolve({ ok: true }),
              },
            });
            const ctx = k.createPluginHandle({
              pluginId: 'e2e-v3-plugin',
              displayName: 'E2E V3 Plugin',
              version: '3.0.0',
              apiVersion: 3,
              sourceSchemaVersion: 3,
              trustLevel: 'restricted',
            }, tok, null);

            globalThis.__v3ActionCount = 0;
            const anchorEl = document.getElementById('anchor-btn');
            const makeTree = (label) => ({
              type: 'stack',
              id: 'root',
              children: [
                { type: 'text', id: 'lbl', text: label },
                { type: 'input', id: 'name-input', field: 'name', label: 'Name' },
                { type: 'button', id: 'act-btn', label: 'Run', variant: 'primary', actionId: 'run' },
              ],
            });
            const popup = ctx.ui.openPopup({
              title: 'V3 Popup',
              placement: { zone: 'anchor', anchorEl, prefer: 'bottom-start', width: 280, height: 220 },
              tree: makeTree('Initial'),
              state: { name: 'Alice' },
              onAction: ({ actionId }) => {
                if (actionId === 'run') globalThis.__v3ActionCount += 1;
              },
            });
            globalThis.__v3Popup = popup;

            const inp = popup.getElementById('name-input');
            inp.focus();
            const activeBefore = popup.element.shadowRoot.activeElement === inp;
            popup.update(makeTree('Patched'), { name: 'Alice' });
            const activeAfter = popup.element.shadowRoot.activeElement === inp;
            const sameNode = popup.getElementById('name-input') === inp;

            // Synthetic .click() MUST be blocked by ev.isTrusted check
            const btn = popup.getElementById('act-btn');
            btn.click();
            const afterSynthetic = globalThis.__v3ActionCount;
            const btnRect = btn.getBoundingClientRect();
            const placementDesktop = popup.getPlacement();

            return {
              hasHostProfileId: Object.prototype.hasOwnProperty.call(ctx.env, 'hostProfileId'),
              hasNet: ctx.net !== undefined,
              hasConfigBridge: ctx.configBridge !== undefined,
              badgeText: popup.attributionBadge.textContent,
              activeBefore,
              activeAfter,
              sameNode,
              afterSynthetic,
              placementDesktop,
              btnX: Math.round(btnRect.left + btnRect.width / 2),
              btnY: Math.round(btnRect.top + btnRect.height / 2),
            };
          })()\`);

          // Perform REAL trusted Chromium click via sendInputEvent
          win.webContents.sendInputEvent({ type: 'mouseMove', x: initRes.btnX, y: initRes.btnY });
          win.webContents.sendInputEvent({ type: 'mouseDown', x: initRes.btnX, y: initRes.btnY, button: 'left', clickCount: 1 });
          win.webContents.sendInputEvent({ type: 'mouseUp', x: initRes.btnX, y: initRes.btnY, button: 'left', clickCount: 1 });
          await new Promise((r) => setTimeout(r, 150));

          const afterTrusted = await win.webContents.executeJavaScript('globalThis.__v3ActionCount');

          // Resize window to mobile width <= 640px and verify automatic bottom-sheet switch
          win.setContentSize(420, 740);
          await new Promise((r) => setTimeout(r, 150));
          const placementMobile = await win.webContents.executeJavaScript('globalThis.__v3Popup.getPlacement()');

          process.stdout.write(JSON.stringify({ initRes, afterTrusted, placementMobile }) + '\\n');
          app.exit(0);
        });
        `,
        'utf8'
      );

      const res = spawnSync(ELECTRON_BIN, [mainScript], {
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' },
      });
      assert.equal(res.status, 0, `Electron E2E exited with ${res.status}: ${res.stderr}`);
      const line = (res.stdout || '').trim().split(/\r?\n/).pop();
      const parsed = JSON.parse(line);

      assert.equal(parsed.initRes.hasHostProfileId, false);
      assert.equal(parsed.initRes.hasNet, false);
      assert.equal(parsed.initRes.hasConfigBridge, false);
      assert.equal(parsed.initRes.badgeText, 'Addon: E2E V3 Plugin');
      assert.equal(parsed.initRes.sameNode, true);
      assert.equal(parsed.initRes.activeBefore, true);
      assert.equal(parsed.initRes.activeAfter, true);
      assert.equal(parsed.initRes.afterSynthetic, 0, 'Synthetic click must be blocked by ev.isTrusted');
      assert.equal(parsed.afterTrusted, 1, 'Trusted sendInputEvent click must fire onAction');
      assert.equal(parsed.initRes.placementDesktop.flipped, true);
      assert.equal(parsed.initRes.placementDesktop.resolvedSide, 'top');
      assert.equal(parsed.placementMobile.zone, 'sheet');
      assert.equal(parsed.placementMobile.autoMobileSheet, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);
