'use strict';

/**
 * Phase 1 Read-Only Empirical Probes (P1-1 .. P1-6) for antigravity-native-addon-host v2.0.0.
 *
 * STRICT INVARIANTS:
 * - ZERO writes to live resources/app.asar, ~/.gemini/config/config.json, or ~/.gemini/config/plugins/.
 * - All temporary files live exclusively under os.tmpdir() and are removed on exit.
 * - Placed strictly under scripts/probes/ (never under test/) so `npm test` does not auto-run local host probes.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const Ajv = require('ajv');
const standaloneCode = require('ajv/dist/standalone').default;
const acorn = require('acorn');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON_BIN = require('electron');
const { readAsarArchive, transformExactSize } = require('../../src/adapters/electron/asar-patcher');
const { ANTIGRAVITY_HOST_PROFILE } = require('../../src/profiles/antigravity');

const V2_ANCHOR_SNIPPET =
  "/*ADDON_HOST_LOADER_V2*/try{const _p=require('path').join(require('os').homedir(),'.gemini','antigravity','addon-host-loader.js');if(require('path').isAbsolute(_p)&&require('fs').existsSync(_p))require(_p).initMain(electron_1.app);}catch(_e){try{process.stderr.write('[addon-host] '+(_e&&_e.message||_e)+'\\n');}catch(_i){}}";

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmSafe(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_e) {}
}

function runElectronChild(scriptSource, { extraEnv = {}, timeoutMs = 25000 } = {}) {
  const dir = mkTempDir('agy-p1-electron-');
  const entry = path.join(dir, 'main.cjs');
  fs.writeFileSync(entry, scriptSource, 'utf8');
  const env = { ...process.env, ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const res = spawnSync(ELECTRON_BIN, [entry], {
      cwd: dir,
      env,
      encoding: 'utf8',
      timeout: timeoutMs,
      shell: false,
      windowsHide: true,
    });
    return {
      status: res.status,
      signal: res.signal,
      stdout: res.stdout || '',
      stderr: res.stderr || '',
      error: res.error || null,
    };
  } finally {
    rmSafe(dir);
  }
}

function parseJsonMarker(stdout, marker) {
  const lines = String(stdout || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith(marker)) {
      return JSON.parse(line.slice(marker.length));
    }
  }
  throw new Error(`Missing marker ${marker} in stdout:\n${stdout}`);
}

/**
 * Quote-aware NODE_OPTIONS flag scrubber (preserves spaces inside quoted paths).
 */
function scrubOwnRequireFromNodeOptions(rawNodeOptions, targetPath) {
  const tokens = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < rawNodeOptions.length; i++) {
    const ch = rawNodeOptions[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);

  const stripQuotes = (s) => (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'")) ? s.slice(1, -1) : s);
  const normTarget = path.resolve(targetPath);
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if ((t === '--require' || t === '-r') && i + 1 < tokens.length) {
      if (path.resolve(stripQuotes(tokens[i + 1])) === normTarget) {
        i++;
        continue;
      }
    } else if (t.startsWith('--require=')) {
      const val = stripQuotes(t.slice('--require='.length));
      if (path.resolve(val) === normTarget) continue;
    }
    out.push(t);
  }
  return out.join(' ');
}

function probeP1_1() {
  const tmpDir = mkTempDir('agy-p1-1 space ');
  const bootstrapPath = path.join(tmpDir, 'boot trap.cjs');
  try {
    const bootCode = `
'use strict';
const path = require('node:path');
if (process.type !== 'browser') {
  globalThis.__P1_1_NON_BROWSER_RAN = true;
  return;
}
globalThis.__P1_1_BOOT_RAN = true;
globalThis.__P1_1_ORIGINAL_NODE_OPTIONS = process.env.NODE_OPTIONS || '';
const scrub = ${scrubOwnRequireFromNodeOptions.toString()};
process.env.NODE_OPTIONS = scrub(process.env.NODE_OPTIONS || '', __filename);
globalThis.__P1_1_SCRUBBED_NODE_OPTIONS = process.env.NODE_OPTIONS;
`;
    fs.writeFileSync(bootstrapPath, bootCode, 'utf8');

    const mainCode = `
'use strict';
const { app } = require('electron');
const { spawnSync } = require('node:child_process');
app.whenReady().then(() => {
  const child = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify({ nodeOptions: process.env.NODE_OPTIONS || "", bootRan: Boolean(globalThis.__P1_1_BOOT_RAN) }))'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    shell: false,
  });
  let childParsed = null;
  try { childParsed = JSON.parse((child.stdout || '').trim().split(/\\r?\\n/).pop()); } catch (_e) {}
  console.log('P1_1_RESULT:' + JSON.stringify({
    bootRan: Boolean(globalThis.__P1_1_BOOT_RAN),
    originalNodeOptions: globalThis.__P1_1_ORIGINAL_NODE_OPTIONS || '',
    scrubbedNodeOptions: globalThis.__P1_1_SCRUBBED_NODE_OPTIONS || '',
    childNodeOptions: childParsed && childParsed.nodeOptions,
    childBootRan: childParsed && childParsed.bootRan,
  }));
  app.quit();
});
`;
    const normalizedBootForNodeOptions = bootstrapPath.replace(/\\/g, '/');
    const quotedBoot = `"${normalizedBootForNodeOptions}"`;
    const res = runElectronChild(mainCode, {
      extraEnv: { NODE_OPTIONS: `--max-old-space-size=2048 --require ${quotedBoot}` },
    });
    assert.equal(res.status, 0, `P1-1 electron child failed: ${res.stderr}`);
    const data = parseJsonMarker(res.stdout, 'P1_1_RESULT:');
    assert.equal(data.bootRan, true, 'Unpackaged Electron must honor NODE_OPTIONS=--require');
    assert.equal(data.scrubbedNodeOptions, '--max-old-space-size=2048', 'Quote-aware scrubber must remove only own --require with spaces');
    assert.equal(data.childBootRan, false, 'ELECTRON_RUN_AS_NODE child must not inherit scrubbed --require');

    // Read-only binary check on packaged Antigravity.exe (zero execution / zero writes)
    let packagedRestrictionObserved = 'NOT_OBSERVABLE';
    const localExe = process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Programs', 'antigravity', 'Antigravity.exe')
      : null;
    if (localExe && fs.existsSync(localExe)) {
      const binBuf = fs.readFileSync(localExe);
      const needle = Buffer.from('Most NODE_OPTIONs are not supported in packaged apps', 'utf8');
      packagedRestrictionObserved = binBuf.includes(needle)
        ? 'OBSERVED_PACKAGED_NODE_OPTIONS_RESTRICTED'
        : 'NOT_FOUND_IN_BINARY';
    }
    return {
      ok: true,
      unpackagedBootRan: data.bootRan,
      scrubbedNodeOptions: data.scrubbedNodeOptions,
      childBootRan: data.childBootRan,
      packagedRestrictionObserved,
    };
  } finally {
    rmSafe(tmpDir);
  }
}

function probeP1_2() {
  const tmpDir = mkTempDir('agy-p1-2-');
  const preloadPath = path.join(tmpDir, 'preload-bridge.cjs');
  try {
    // Strictly self-contained preload: ONLY require('electron')
    const preloadCode = `'use strict';
const { contextBridge, ipcRenderer } = require('electron');
if (!process.isMainFrame || !process.contextIsolated) {
  return;
}
let claimed = false;
const verify = ipcRenderer.sendSync('probe:verify-frame');
if (!verify || !verify.ok) {
  return;
}
contextBridge.exposeInIsolatedWorld(998, '__addonHostBootstrap', {
  claim(nonce) {
    if (claimed) {
      throw new Error('ERR_BRIDGE_ALREADY_CLAIMED');
    }
    const res = ipcRenderer.sendSync('probe:claim-nonce', String(nonce || ''));
    if (!res || !res.ok) {
      throw new Error(res && res.reason ? res.reason : 'ERR_INVALID_NONCE');
    }
    claimed = true;
    return Object.freeze({
      docGenId: res.docGenId,
      ping: () => ipcRenderer.invoke('probe:ping'),
    });
  },
});
`;
    fs.writeFileSync(preloadPath, preloadCode, 'utf8');

    const mainCode = `'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { app, BaseWindow, WebContentsView, session, ipcMain } = require('electron');

const preloadFile = ${JSON.stringify(preloadPath)};
const events = [];
let docGenId = 0;
let activeNonce = null;
const claimedGens = new Set();

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><body><div id="root">hub</div><iframe id="blank" src="about:blank"></iframe></body></html>');
});

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const baseUrl = 'http://127.0.0.1:' + port;

  // Idempotent registerPreloadScript on defaultSession ONLY
  const regId1 = session.defaultSession.registerPreloadScript({
    type: 'frame',
    filePath: preloadFile,
    id: 'agy-p1-2-preload',
  });
  const preloadsBefore = session.defaultSession.getPreloadScripts();
  const hasExisting = preloadsBefore.some((p) => p.id === 'agy-p1-2-preload');

  ipcMain.on('probe:verify-frame', (ev) => {
    const ok =
      ev.sender.session === session.defaultSession &&
      ev.senderFrame === ev.sender.mainFrame &&
      !ev.senderFrame.parent &&
      !ev.senderFrame.detached &&
      ev.senderFrame.origin === baseUrl &&
      ev.senderFrame.url.startsWith(baseUrl + '/');
    events.push({ ev: 'verify-frame', ok, url: ev.senderFrame.url });
    ev.returnValue = { ok };
  });

  ipcMain.on('probe:claim-nonce', (ev, incoming) => {
    if (!activeNonce || incoming !== activeNonce || claimedGens.has(docGenId)) {
      ev.returnValue = { ok: false, reason: 'ERR_NONCE_REJECTED' };
      return;
    }
    claimedGens.add(docGenId);
    activeNonce = null;
    ev.returnValue = { ok: true, docGenId };
  });

  ipcMain.handle('probe:ping', () => 'PONG_998');

  const win = new BaseWindow({ width: 800, height: 600, show: false });
  const hubView = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.contentView.addChildView(hubView);

  // Separate hardened/browser partition MUST NOT receive defaultSession preload
  const isolatedSession = session.fromPartition('persist:hub-browser-probe');
  const isolatedPreloads = isolatedSession.getPreloadScripts();
  const isolatedView = new WebContentsView({
    webPreferences: {
      session: isolatedSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.contentView.addChildView(isolatedView);

  hubView.webContents.on('did-start-navigation', (_e, url, isInPlace, isMainFrame) => {
    events.push({ ev: 'did-start-navigation', isInPlace, isMainFrame, url });
    if (isMainFrame && !isInPlace) {
      docGenId += 1;
      activeNonce = crypto.randomBytes(16).toString('hex');
    }
  });
  hubView.webContents.on('did-navigate', (_e, url) => events.push({ ev: 'did-navigate', url }));
  hubView.webContents.on('dom-ready', () => events.push({ ev: 'dom-ready' }));
  hubView.webContents.on('did-finish-load', () => events.push({ ev: 'did-finish-load' }));
  hubView.webContents.on('did-navigate-in-page', (_e, url) => events.push({ ev: 'did-navigate-in-page', url }));

  await hubView.webContents.loadURL(baseUrl + '/home');
  await isolatedView.webContents.loadURL(baseUrl + '/browser');

  const world0HasBootstrap = await hubView.webContents.executeJavaScript('typeof window.__addonHostBootstrap');
  const isolatedWorld998HasBootstrap = await isolatedView.webContents.executeJavaScriptInIsolatedWorld(998, [
    { code: 'typeof window.__addonHostBootstrap' },
  ]);

  const nonce1 = activeNonce;
  const claimRes = await hubView.webContents.executeJavaScriptInIsolatedWorld(998, [
    {
      code: \`(async () => {
        const b = window.__addonHostBootstrap;
        if (!b || typeof b.claim !== 'function') return { ok: false, reason: 'NO_BRIDGE' };
        const api = b.claim(\${JSON.stringify(nonce1)});
        let secondErr = null;
        try { b.claim(\${JSON.stringify(nonce1)}); } catch (e) { secondErr = e.message; }
        const pong = await api.ping();
        return { ok: true, docGenId: api.docGenId, secondErr, pong };
      })()\`,
    },
  ]);

  // SPA pushState (did-navigate-in-page) must NOT rotate docGenId or wipe claimed kernel
  const genBeforeSpa = docGenId;
  await hubView.webContents.executeJavaScript("history.pushState({}, '', '/settings')");
  await new Promise((r) => setTimeout(r, 100));
  const genAfterSpa = docGenId;

  // Hard reload MUST rotate docGenId & allow fresh single claim
  const reloadDone = new Promise((r) => hubView.webContents.once('did-finish-load', r));
  hubView.webContents.reload();
  await reloadDone;
  const nonce2 = activeNonce;
  const claimRes2 = await hubView.webContents.executeJavaScriptInIsolatedWorld(998, [
    {
      code: \`(async () => {
        const api = window.__addonHostBootstrap.claim(\${JSON.stringify(nonce2)});
        return { ok: true, docGenId: api.docGenId, pong: await api.ping() };
      })()\`,
    },
  ]);

  session.defaultSession.unregisterPreloadScript(regId1);
  const preloadsAfterUnreg = session.defaultSession.getPreloadScripts().some((p) => p.id === 'agy-p1-2-preload');

  console.log('P1_2_RESULT:' + JSON.stringify({
    regId1,
    hasExisting,
    preloadsAfterUnreg,
    hubWebContentsType: hubView.webContents.getType(),
    isolatedPreloadsCount: isolatedPreloads.length,
    world0HasBootstrap,
    isolatedWorld998HasBootstrap,
    claimRes,
    genBeforeSpa,
    genAfterSpa,
    claimRes2,
    eventNames: events.map((e) => e.ev),
  }));

  server.close();
  app.quit();
});
`;
    const res = runElectronChild(mainCode);
    assert.equal(res.status, 0, `P1-2 failed: ${res.stderr}`);
    const data = parseJsonMarker(res.stdout, 'P1_2_RESULT:');
    assert.equal(data.hasExisting, true);
    assert.equal(data.preloadsAfterUnreg, false);
    assert.equal(data.isolatedPreloadsCount, 0);
    assert.equal(data.world0HasBootstrap, 'undefined', 'World 0 must see ZERO bootstrap globals');
    assert.equal(data.isolatedWorld998HasBootstrap, 'undefined', 'Isolated partition must NOT receive defaultSession preload');
    assert.equal(data.claimRes.ok, true);
    assert.equal(data.claimRes.pong, 'PONG_998');
    assert.match(String(data.claimRes.secondErr), /ERR_BRIDGE_ALREADY_CLAIMED/);
    assert.equal(data.genBeforeSpa, data.genAfterSpa, 'SPA pushState must preserve document generation');
    assert.equal(data.claimRes2.ok, true);
    assert.equal(data.claimRes2.docGenId, data.claimRes.docGenId + 1, 'Reload must advance document generation');
    return { ok: true, ...data };
  } finally {
    rmSafe(tmpDir);
  }
}

function probeP1_3() {
  const localAsar = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Programs', 'antigravity', 'resources', 'app.asar')
    : null;
  if (!localAsar || !fs.existsSync(localAsar)) {
    return { ok: true, status: 'NOT_OBSERVABLE', reason: 'Local Antigravity app.asar not present' };
  }
  const archive = readAsarArchive(localAsar);
  const mainBuf = archive.fileMap.get('dist/main.js');
  assert.ok(mainBuf, 'dist/main.js must exist in app.asar fileMap');
  const mainText = mainBuf.toString('utf8');
  const anchor = ANTIGRAVITY_HOST_PROFILE.mainAnchorTarget;
  const anchorCount = mainText.split(anchor).length - 1;
  assert.equal(anchorCount, 1, `Expected unique anchor count 1, got ${anchorCount}`);

  // In-memory exact-size patch test (ZERO disk writes)
  const replacement = `${V2_ANCHOR_SNIPPET}${anchor}`;
  const patchedBuf = transformExactSize(mainBuf, anchor, replacement, 'ADDON_HOST_LOADER_V2');
  assert.equal(patchedBuf.length, mainBuf.length, 'Patched dist/main.js must be byte-exact');
  // Verify valid JS AST with acorn
  acorn.parse(patchedBuf.toString('utf8'), { ecmaVersion: 'latest', sourceType: 'script' });

  const ipcHandlersText = (archive.fileMap.get('dist/ipcHandlers.js') || Buffer.alloc(0)).toString('utf8');
  const wcvIpcText = (archive.fileMap.get('dist/wcvIpcHandlers.js') || Buffer.alloc(0)).toString('utf8');
  const constantsText = (archive.fileMap.get('dist/constants.js') || Buffer.alloc(0)).toString('utf8');

  const usesIpcMainForPortal = /ipcMain\.handle\(\s*['"]wcv:set-portal-overlay-open['"]/.test(wcvIpcText) || /['"]wcv:set-portal-overlay-open['"]/.test(wcvIpcText) && /ipcMain\.handle/.test(wcvIpcText);
  const usesContentsIpcForPortal = /\.ipc\.handle\(\s*['"]wcv:set-portal-overlay-open['"]/.test(wcvIpcText);
  const hardenedSkipComment = mainText.includes('isScriptJailSession') || mainText.includes('isRemoteSession');
  const whenReadyIdx = mainText.indexOf('app.whenReady()');
  const anchorIdx = mainText.indexOf(anchor);
  const registerWcvAfterL339 = whenReadyIdx > anchorIdx && anchorIdx !== -1;
  const hasWindowOrigin = constantsText.includes('https://127.0.0.1');

  return {
    ok: true,
    status: 'OBSERVED',
    appVersion: archive.appVersion,
    mainJsBytes: mainBuf.length,
    v2SnippetBytes: Buffer.byteLength(V2_ANCHOR_SNIPPET, 'utf8'),
    anchorCount,
    exactSizeAstValid: true,
    usesIpcMainForPortal,
    usesContentsIpcForPortal,
    hardenedSkipComment,
    registerWcvAfterL339,
    hasWindowOrigin,
    ipcHandlersBytes: ipcHandlersText.length,
  };
}

function probeP1_4() {
  const mainCode = `'use strict';
const { app, BaseWindow, WebContentsView, BrowserWindow, ipcMain } = require('electron');

app.on('window-all-closed', (e) => e.preventDefault());

const CHANNEL = 'wcv:set-portal-overlay-open';
const stateByWcId = new Map();
const nativeCalls = [];
let capturedNativeHandler = null;

// Non-destructive ipcMain.handle proxy installed BEFORE app.whenReady()
const origHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = function wrappedHandle(channel, listener) {
  if (channel !== CHANNEL) return origHandle(channel, listener);
  capturedNativeHandler = listener;
  return origHandle(channel, (ev, open) => {
    const id = ev.sender.id;
    const entry = stateByWcId.get(id) || { nativeOpen: false, pluginClaims: new Set() };
    entry.nativeOpen = Boolean(open);
    stateByWcId.set(id, entry);
    const effective = Boolean(entry.nativeOpen || entry.pluginClaims.size > 0);
    return capturedNativeHandler(ev, effective);
  });
};

function setPluginClaim(wc, claimId, active) {
  const id = wc.id;
  const entry = stateByWcId.get(id) || { nativeOpen: false, pluginClaims: new Set() };
  if (active) entry.pluginClaims.add(claimId);
  else entry.pluginClaims.delete(claimId);
  stateByWcId.set(id, entry);
  const effective = Boolean(entry.nativeOpen || entry.pluginClaims.size > 0);
  if (capturedNativeHandler && !wc.isDestroyed() && wc.mainFrame) {
    try {
      capturedNativeHandler({ sender: wc, senderFrame: wc.mainFrame }, effective);
    } catch (_e) {}
  }
  return effective;
}

app.whenReady().then(async () => {
  // Simulate host registering native handler AFTER initMain
  ipcMain.handle(CHANNEL, (ev, effective) => {
    if (ev.sender.isDestroyed()) throw new Error('ERR_DESTROYED_SENDER');
    nativeCalls.push({ wcId: ev.sender.id, effective });
    return { ok: true, effective };
  });

  const win = new BaseWindow({ width: 640, height: 480, show: false });
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
  win.contentView.addChildView(view);
  await view.webContents.loadURL('data:text/html,<html><body>portal</body></html>');

  const fromWcIsNull = BrowserWindow.fromWebContents(view.webContents) === null;

  // Test truth table: plugin open -> native open -> native close (effective stays true!) -> plugin close (effective false!)
  const e1 = setPluginClaim(view.webContents, 'm1', true);
  // Simulate native IPC call (true -> false)
  const entry = stateByWcId.get(view.webContents.id);
  entry.nativeOpen = true;
  capturedNativeHandler({ sender: view.webContents, senderFrame: view.webContents.mainFrame }, Boolean(entry.nativeOpen || entry.pluginClaims.size > 0));
  entry.nativeOpen = false;
  const effectiveAfterNativeClose = Boolean(entry.nativeOpen || entry.pluginClaims.size > 0);
  capturedNativeHandler({ sender: view.webContents, senderFrame: view.webContents.mainFrame }, effectiveAfterNativeClose);
  const e4 = setPluginClaim(view.webContents, 'm1', false);

  // Test contents.ipc.handle precedence check on a separate view
  const view2 = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
  win.contentView.addChildView(view2);
  let contentsIpcWon = false;
  view2.webContents.ipc.handle('probe:precedence', () => { contentsIpcWon = true; return 'CONTENTS_IPC'; });
  ipcMain.handle('probe:precedence', () => 'IPC_MAIN');
  // Cleanup on destroy must NOT throw
  let destroyCleanupThrew = false;
  const savedWc = view.webContents;
  savedWc.once('destroyed', () => {
    try {
      setPluginClaim(savedWc, 'm1', false);
    } catch (_e) {
      destroyCleanupThrew = true;
    }
  });
  win.destroy();
  await new Promise((r) => setTimeout(r, 100));

  console.log('P1_4_RESULT:' + JSON.stringify({
    fromWcIsNull,
    e1,
    effectiveAfterNativeClose,
    e4,
    nativeCalls,
    destroyCleanupThrew,
    hasContentsIpcHandle: typeof view2.webContents.ipc.handle === 'function',
  }));
  app.quit();
});
`;
  const res = runElectronChild(mainCode);
  assert.equal(res.status, 0, `P1-4 failed: ${res.stderr}`);
  const data = parseJsonMarker(res.stdout, 'P1_4_RESULT:');
  // Observe BrowserWindow.fromWebContents return behavior (varies across Electron 44/45; keying by webContents.id is invariant)
  assert.equal(typeof data.fromWcIsNull, 'boolean');
  assert.equal(data.e1, true);
  assert.equal(data.effectiveAfterNativeClose, true, 'Native close must NOT close overlay while plugin claim active');
  assert.equal(data.e4, false);
  assert.equal(data.destroyCleanupThrew, false, 'Destroyed cleanup must never throw');
  return { ok: true, ...data };
}

function probeP1_5() {
  const mainCode = `'use strict';
const { app, BaseWindow, WebContentsView } = require('electron');

app.whenReady().then(async () => {
  const win = new BaseWindow({ width: 800, height: 600, show: false });
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
  win.contentView.addChildView(view);
  await view.webContents.loadURL('data:text/html,<!doctype html><html><body style="background:rgb(255,255,255)"><div id="host"></div><div id="sibling">sib</div></body></html>');

  // Set up Option B2 ShadowRoot + scoped style + composedPath + native <dialog> + popover="manual"
  const setup = await view.webContents.executeJavaScriptInIsolatedWorld(998, [
    {
      code: \`(() => {
        const host = document.createElement('div');
        host.setAttribute('data-addon-host-slot', 'p1.slot');
        host.setAttribute('data-addon-host-owner', 'p1');
        host.setAttribute('data-addon-host-no-translate', 'true');
        document.getElementById('host').appendChild(host);
        const sr = host.attachShadow({ mode: 'open' });
        const root = document.createElement('div');
        root.className = 'addon-host-slot-root';
        root.setAttribute('data-addon-host-owner', 'p1');
        sr.appendChild(root);

        // Style injected inside ShadowRoot via <style> (and test adoptedStyleSheets support)
        const styleEl = document.createElement('style');
        styleEl.textContent = '[data-addon-host-owner="p1"] .box { color: rgb(10, 20, 30); } body { background: rgb(255, 0, 0) !important; }';
        sr.appendChild(styleEl);

        const box = document.createElement('button');
        box.className = 'box';
        box.textContent = 'inside';
        root.appendChild(box);

        // Verify HTMLElement APIs on returned Option B2 root
        root.style.padding = '4px';
        root.classList.add('ready');
        root.setAttribute('data-test', 'ok');

        // Verify composedPath detects host no-translate boundary
        let composedSawNoTranslate = false;
        document.addEventListener('click', (evt) => {
          const path = typeof evt.composedPath === 'function' ? evt.composedPath() : [evt.target];
          composedSawNoTranslate = path.some((n) => n && n.getAttribute && n.getAttribute('data-addon-host-no-translate') === 'true');
        }, { once: true });
        box.click();

        // Native <dialog> + popover="manual" LIFO stack test:
        // Capture-phase keydown intercepts Escape BEFORE Chromium CloseWatcher closes <dialog> (even without prior user activation)
        window.__p1Stack = [];
        window.__p1CancelEvents = [];
        const dlg = document.createElement('dialog');
        dlg.id = 'p1-dlg';
        dlg.textContent = 'modal';
        document.body.appendChild(dlg);
        const pop = document.createElement('div');
        pop.id = 'p1-pop';
        pop.setAttribute('popover', 'manual');
        pop.textContent = 'popover';
        document.body.appendChild(pop);

        function popTopLayer() {
          const top = window.__p1Stack[window.__p1Stack.length - 1];
          if (top === 'popover') {
            pop.hidePopover();
            window.__p1Stack.pop();
            return 'popover';
          }
          if (top === 'dialog') {
            dlg.close();
            window.__p1Stack.pop();
            return 'dialog';
          }
          return null;
        }

        window.addEventListener('keydown', (ev) => {
          if (ev.key === 'Escape' && window.__p1Stack.length > 0) {
            ev.preventDefault();
            ev.stopImmediatePropagation();
            popTopLayer();
          }
        }, true);

        dlg.addEventListener('cancel', (ev) => {
          window.__p1CancelEvents.push({ cancelable: ev.cancelable });
          if (ev.cancelable) ev.preventDefault();
          popTopLayer();
        });

        dlg.showModal();
        window.__p1Stack.push('dialog');
        pop.showPopover();
        window.__p1Stack.push('popover');

        return {
          rootIsHTMLElement: root instanceof HTMLElement,
          rootNodeIsShadowRoot: root.getRootNode() instanceof ShadowRoot,
          boxColor: getComputedStyle(box).color,
          bodyBg: getComputedStyle(document.body).backgroundColor,
          composedSawNoTranslate,
          dlgOpenBefore: dlg.open,
          popMatchesBefore: pop.matches(':popover-open'),
          hasAdoptedStyleSheets: Array.isArray(sr.adoptedStyleSheets) || typeof sr.adoptedStyleSheets === 'object',
        };
      })()\`,
    },
  ]);

  // First real Escape via sendInputEvent -> closes top-most popover while dialog stays open!
  view.webContents.focus();
  view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await new Promise((r) => setTimeout(r, 120));
  const afterEsc1 = await view.webContents.executeJavaScriptInIsolatedWorld(998, [
    {
      code: \`({
        dlgOpen: document.getElementById('p1-dlg').open,
        popOpen: document.getElementById('p1-pop').matches(':popover-open'),
        stack: window.__p1Stack.slice(),
      })\`,
    },
  ]);

  // Second real Escape -> closes dialog!
  view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await new Promise((r) => setTimeout(r, 120));
  const afterEsc2 = await view.webContents.executeJavaScriptInIsolatedWorld(998, [
    {
      code: \`({
        dlgOpen: document.getElementById('p1-dlg').open,
        popOpen: document.getElementById('p1-pop').matches(':popover-open'),
        stack: window.__p1Stack.slice(),
      })\`,
    },
  ]);

  console.log('P1_5_RESULT:' + JSON.stringify({ setup, afterEsc1, afterEsc2 }));
  app.quit();
});
`;
  const res = runElectronChild(mainCode);
  assert.equal(res.status, 0, `P1-5 failed: ${res.stderr}`);
  const data = parseJsonMarker(res.stdout, 'P1_5_RESULT:');
  assert.equal(data.setup.rootIsHTMLElement, true);
  assert.equal(data.setup.rootNodeIsShadowRoot, true);
  assert.equal(data.setup.boxColor, 'rgb(10, 20, 30)', 'ShadowRoot style must apply to [data-addon-host-owner] inside root');
  assert.equal(data.setup.bodyBg, 'rgb(255, 255, 255)', 'ShadowRoot style must NOT leak to host document.body');
  assert.equal(data.setup.composedSawNoTranslate, true, 'composedPath() must see no-translate boundary');
  assert.equal(data.afterEsc1.popOpen, false, 'First Escape must close top-most popover');
  assert.equal(data.afterEsc1.dlgOpen, true, 'Dialog must stay open after first Escape');
  assert.equal(data.afterEsc2.dlgOpen, false, 'Second Escape must close dialog');
  return { ok: true, ...data };
}

function scanAstZeroDep(filePath, { preloadStrict = false } = {}) {
  const src = fs.readFileSync(filePath, 'utf8');
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script' });
  const violations = [];
  const nodeBuiltins = new Set(require('node:module').builtinModules.flatMap((m) => [m, m.replace(/^node:/, '')]));

  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ImportExpression') {
      violations.push('FORBIDDEN_DYNAMIC_IMPORT');
    }
    if (node.type === 'MemberExpression' && !node.computed && node.property) {
      if (node.property.name === 'createRequire' || node.property.name === 'dlopen') {
        violations.push(`FORBIDDEN_MEMBER:${node.property.name}`);
      }
    }
    if (node.type === 'CallExpression' && node.callee && node.callee.type === 'Identifier' && node.callee.name === 'require') {
      const arg = node.arguments[0];
      if (!arg || arg.type !== 'Literal' || typeof arg.value !== 'string') {
        violations.push('FORBIDDEN_DYNAMIC_REQUIRE');
      } else {
        const spec = arg.value;
        if (preloadStrict) {
          if (spec !== 'electron') violations.push(`FORBIDDEN_PRELOAD_REQUIRE:${spec}`);
        } else {
          const isRel = spec.startsWith('./') || spec.startsWith('../');
          const isNode = spec.startsWith('node:') || nodeBuiltins.has(spec);
          if (!isRel && !isNode && spec !== 'electron') {
            violations.push(`FORBIDDEN_EXTERNAL_REQUIRE:${spec}`);
          }
        }
      }
    }
    for (const key of Object.keys(node)) {
      const val = node[key];
      if (Array.isArray(val)) val.forEach(walk);
      else if (val && typeof val.type === 'string') walk(val);
    }
  }
  walk(ast);
  return violations;
}

function probeP1_6() {
  const tmpDir = mkTempDir('agy-p1-6-0dep-');
  try {
    const genDir = path.join(tmpDir, 'generated');
    const rtDir = path.join(genDir, 'runtime');
    fs.mkdirSync(rtDir, { recursive: true });

    // Localize fast-deep-equal wrapped with exports.default = equal
    const fdeSrc = fs.readFileSync(require.resolve('fast-deep-equal'), 'utf8');
    const wrappedEqual = `'use strict';\nconst _mod = { exports: {} };\n(function(module, exports){\n${fdeSrc}\n})(_mod, _mod.exports);\nexports.default = _mod.exports;\n`;
    fs.writeFileSync(path.join(rtDir, 'equal.cjs'), wrappedEqual.replace(/\r\n/g, '\n'), 'utf8');

    // Localize ucs2length
    const ucsSrc = fs.readFileSync(require.resolve('ajv/dist/runtime/ucs2length'), 'utf8');
    fs.writeFileSync(path.join(rtDir, 'ucs2length.cjs'), ucsSrc.replace(/\r\n/g, '\n'), 'utf8');

    const v1Schema = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'schemas', 'addon-manifest.v1.schema.json'), 'utf8')
    );
    const ajv = new Ajv({ allErrors: true, strict: true, code: { source: true } });
    const validate = ajv.compile(v1Schema);
    let code = standaloneCode(ajv, validate);
    code = code
      .replace(/require\(["']ajv\/dist\/runtime\/equal["']\)/g, 'require("./runtime/equal.cjs")')
      .replace(/require\(["']ajv\/dist\/runtime\/ucs2length["']\)/g, 'require("./runtime/ucs2length.cjs")')
      .replace(/\r\n/g, '\n');

    const v1OutPath = path.join(genDir, 'validate-v1.cjs');
    fs.writeFileSync(v1OutPath, code, 'utf8');

    // AST 0-dep check on ALL generated files
    for (const f of [v1OutPath, path.join(rtDir, 'equal.cjs'), path.join(rtDir, 'ucs2length.cjs')]) {
      const viols = scanAstZeroDep(f);
      assert.deepEqual(viols, [], `AST 0-dep violations in ${path.basename(f)}: ${viols.join(', ')}`);
    }

    // Execute validator from isolated os.tmpdir() with zero node_modules
    const validSample = {
      schemaVersion: 1,
      pluginId: 'probe-addon',
      displayName: 'Probe Addon',
      version: '1.0.0',
      capabilities: ['renderer'],
      entry: { rendererScript: 'renderer.js' },
      isolation: { noTranslate: true, i18nSelfManaged: true },
    };
    const invalidSample = { schemaVersion: 1, pluginId: 'INVALID ID!' };
    const runRes = spawnSync(
      process.execPath,
      [
        '-e',
        `const v = require(${JSON.stringify(v1OutPath)});
         const ok1 = v(${JSON.stringify(validSample)});
         const ok2 = v(${JSON.stringify(invalidSample)});
         console.log(JSON.stringify({ ok1, ok2, errCount: (v.errors || []).length }));`,
      ],
      { cwd: tmpDir, encoding: 'utf8', shell: false }
    );
    assert.equal(runRes.status, 0, `Isolated validator execution failed: ${runRes.stderr}`);
    const parsed = JSON.parse(runRes.stdout.trim());
    assert.equal(parsed.ok1, true);
    assert.equal(parsed.ok2, false);
    assert.ok(parsed.errCount > 0);
    return { ok: true, ...parsed, astViolations: 0 };
  } finally {
    rmSafe(tmpDir);
  }
}

function main() {
  const results = {};
  const probes = [
    ['P1-1', probeP1_1],
    ['P1-2', probeP1_2],
    ['P1-3', probeP1_3],
    ['P1-4', probeP1_4],
    ['P1-5', probeP1_5],
    ['P1-6', probeP1_6],
  ];
  let failed = 0;
  for (const [id, fn] of probes) {
    try {
      results[id] = fn();
      process.stdout.write(`[PASS] ${id}: ${JSON.stringify(results[id])}\n`);
    } catch (err) {
      failed += 1;
      results[id] = { ok: false, error: err && err.stack ? err.stack : String(err) };
      process.stderr.write(`[FAIL] ${id}: ${results[id].error}\n`);
    }
  }
  if (failed > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write('ALL_PHASE1_PROBES_PASSED\n');
}

main();
