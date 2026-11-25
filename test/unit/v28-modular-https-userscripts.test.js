'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createRendererKernel } = require('../../src/runtime/renderer/kernel');
const { ANTIGRAVITY_REMOTE_WEB_PROFILE } = require('../../src/profiles/antigravity-remote-web');
const {
  MOUNTED_PLUGINS_ATTR,
  registerAddon,
  bootRemoteWebHost,
} = require('../../src/adapters/remote-web/remote-bootstrap');
const {
  buildAddonUserscript,
  normalizeHostLibUrl,
  normalizeConnectHosts,
} = require('../../scripts/build-remote');

function makeMockDom(urlStr) {
  let idSeq = 0;
  function makeNode(tagName) {
    const attrs = new Map();
    const listeners = new Map();
    const node = {
      _id: ++idSeq,
      nodeType: 1,
      tagName: String(tagName || 'DIV').toUpperCase(),
      style: {},
      children: [],
      parentNode: null,
      shadowRoot: null,
      isConnected: true,
      disabled: false,
      _text: '',
      get id() {
        return attrs.get('id') || '';
      },
      set id(v) {
        attrs.set('id', String(v));
      },
      get className() {
        return attrs.get('class') || '';
      },
      set className(v) {
        attrs.set('class', String(v));
      },
      get textContent() {
        if (this.children.length === 0) return this._text;
        return this.children.map((c) => c.textContent).join('');
      },
      set textContent(v) {
        this._text = String(v === undefined || v === null ? '' : v);
        this.children = [];
      },
      get firstChild() {
        return this.children[0] || null;
      },
      setAttribute(k, v) {
        attrs.set(String(k), String(v));
      },
      getAttribute(k) {
        return attrs.has(String(k)) ? attrs.get(String(k)) : null;
      },
      hasAttribute(k) {
        return attrs.has(String(k));
      },
      removeAttribute(k) {
        attrs.delete(String(k));
      },
      appendChild(child) {
        if (!child) return child;
        if (child.parentNode && child.parentNode !== this) {
          child.parentNode.removeChild(child);
        }
        child.parentNode = this;
        this.children.push(child);
        return child;
      },
      removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx >= 0) {
          this.children.splice(idx, 1);
          child.parentNode = null;
        }
        return child;
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        if (listeners.has(type)) listeners.get(type).delete(fn);
      },
      dispatchEvent(ev) {
        const set = listeners.get(ev.type);
        if (!set) return true;
        for (const fn of Array.from(set)) fn(ev);
        return true;
      },
      click() {
        if (this.disabled) return;
        this.dispatchEvent({ type: 'click', target: this, preventDefault() {}, stopPropagation() {} });
      },
      focus() {},
      attachShadow() {
        const sr = makeNode('#shadow-root');
        sr.host = this;
        this.shadowRoot = sr;
        return sr;
      },
      matches(sel) {
        return matchesSimple(this, sel);
      },
      querySelectorAll(sel) {
        const results = [];
        const walk = (n) => {
          for (const c of n.children) {
            if (matchesSelector(c, sel)) results.push(c);
            walk(c);
          }
        };
        walk(this);
        return results;
      },
      querySelector(sel) {
        return this.querySelectorAll(sel)[0] || null;
      },
    };
    return node;
  }

  function matchesSimple(el, part) {
    const trimmed = part.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('#')) {
      return el.id === trimmed.slice(1);
    }
    const tokens = trimmed.match(/(\.[A-Za-z0-9_-]+|\[[^\]]+\]|^[A-Za-z0-9_-]+)/g) || [];
    if (tokens.length === 0) return false;
    for (const tok of tokens) {
      if (tok.startsWith('.')) {
        const cls = el.getAttribute('class') || '';
        if (!cls.split(/\s+/).includes(tok.slice(1))) return false;
      } else if (tok.startsWith('[')) {
        const m = tok.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
        if (!m) return false;
        const val = el.getAttribute(m[1]);
        if (m[2] !== undefined) {
          if (val !== m[2]) return false;
        } else if (val === null) {
          return false;
        }
      } else {
        if (el.tagName !== tok.toUpperCase()) return false;
      }
    }
    return true;
  }

  function matchesSelector(el, sel) {
    if (sel.includes('>')) {
      const [parentSel, childSel] = sel.split('>').map((s) => s.trim());
      return Boolean(el.parentNode && matchesSimple(el.parentNode, parentSel) && matchesSimple(el, childSel));
    }
    return matchesSimple(el, sel);
  }

  const documentElement = makeNode('html');
  const body = makeNode('body');
  documentElement.appendChild(body);
  const doc = {
    documentElement,
    body,
    createElement: (tag) => makeNode(tag),
    getElementById: (id) => documentElement.querySelector(`#${id}`),
    querySelector: (sel) => documentElement.querySelector(sel),
    querySelectorAll: (sel) => documentElement.querySelectorAll(sel),
  };

  function makeSandboxWin() {
    return {
      location: new URL(urlStr),
      document: doc,
      addEventListener() {},
      removeEventListener() {},
    };
  }

  return { doc, makeSandboxWin };
}

test('TC-U7a: buildAddonUserscript & CLI --build-addon-userscript emit deterministic AST-clean public HTTPS @require Userscripts and fail closed on unsafe inputs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-v28-u7a-'));
  try {
    const pluginDir = path.join(tmp, 'sample-addon');
    const outDir = path.join(tmp, 'out');
    fs.mkdirSync(path.join(pluginDir, 'dist'), { recursive: true });

    const manifestPath = path.join(pluginDir, 'addon-manifest.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          schemaVersion: 2,
          pluginId: 'sample-remote-addon',
          displayName: 'Sample Remote Addon',
          version: '1.2.3',
          trustLevel: 'trusted',
          compatibility: {
            hostProfile: 'antigravity-desktop',
            hostProfiles: ['antigravity-desktop', 'antigravity-remote-web'],
            minHostVersion: '2.3.0',
          },
          capabilities: ['renderer'],
          entry: { rendererScript: 'dist/renderer.js' },
          settingsBridge: { fileName: 'sample.json', maxBytes: 8192 },
          uiSlots: [{ slot: 'status-bar', slotId: 'sample-remote-addon.bar', anchor: 'status-bar', shadow: true }],
          isolation: { storageNamespace: 'sample-remote-addon', noTranslate: true, i18nSelfManaged: true },
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(pluginDir, 'dist', 'renderer.js'),
      `addonHost.registerAction('ping', { label: 'Ping', run: () => ({ ok: true }) });\n`
    );

    const built = buildAddonUserscript({
      manifestPath,
      pluginDir,
      targetDir: outDir,
      updateBaseUrl: 'https://github.com/example/sample-addon/releases/latest/download/',
      connectHosts: ['translate.googleapis.com', 'api.example.com'],
      grantXhr: true,
    });
    assert.equal(built.ok, true);
    assert.equal(built.buildManifest.mode, 'modular-addon-userscript');
    assert.equal(built.buildManifest.pluginId, 'sample-remote-addon');
    assert.equal(built.buildManifest.grantXhr, true);
    assert.deepEqual(built.buildManifest.connectHosts, ['translate.googleapis.com', 'api.example.com']);

    const ujs = fs.readFileSync(built.userscriptPath, 'utf8');
    const mjs = fs.readFileSync(built.metaPath, 'utf8');
    assert.ok(
      ujs.includes(
        '// @require      https://github.com/jaeseongs95/antigravity-addons/releases/latest/download/antigravity-remote-host.lib.js'
      )
    );
    assert.ok(ujs.includes('// @inject-into  content'));
    assert.ok(ujs.includes('// @grant        GM_getValue'));
    assert.ok(ujs.includes('// @grant        GM_xmlhttpRequest'));
    assert.ok(ujs.includes('// @connect      translate.googleapis.com'));
    assert.ok(ujs.includes('// @connect      api.example.com'));
    assert.ok(ujs.includes('// @updateURL    https://github.com/example/sample-addon/releases/latest/download/sample-remote-addon.meta.js'));
    assert.ok(ujs.includes('// @downloadURL  https://github.com/example/sample-addon/releases/latest/download/sample-remote-addon.user.js'));
    assert.ok(ujs.includes('rt.registerAddon('));
    assert.ok(ujs.includes('rt.bootRemoteWebHost()'));
    assert.ok(mjs.includes('// @require      https://github.com/jaeseongs95/antigravity-addons/releases/latest/download/antigravity-remote-host.lib.js'));

    // Fail-closed URL & @connect validation
    assert.throws(() => normalizeHostLibUrl('http://insecure.example.com/host.lib.js'), /ERR_HOST_LIB_URL_MUST_BE_HTTPS/);
    assert.throws(() => normalizeConnectHosts(['*']), /ERR_INVALID_CONNECT_HOST/);
    assert.throws(() => normalizeConnectHosts(['https://translate.googleapis.com']), /ERR_INVALID_CONNECT_HOST/);

    // AST security rejection on HTML sinks
    const badPluginDir = path.join(tmp, 'bad-addon');
    fs.mkdirSync(badPluginDir, { recursive: true });
    const badManifestPath = path.join(badPluginDir, 'addon.json');
    fs.writeFileSync(
      badManifestPath,
      JSON.stringify({
        schemaVersion: 2,
        pluginId: 'bad-sink-addon',
        displayName: 'Bad Sink',
        version: '1.0.0',
        trustLevel: 'restricted',
        compatibility: { hostProfile: 'antigravity-desktop', minHostVersion: '2.3.0' },
        capabilities: ['renderer'],
        entry: { rendererScript: 'bad.js' },
        uiSlots: [],
        isolation: { storageNamespace: 'bad-sink-addon', noTranslate: true, i18nSelfManaged: true },
      })
    );
    fs.writeFileSync(path.join(badPluginDir, 'bad.js'), `document.body.innerHTML = '<b>x</b>';\n`);
    assert.throws(
      () => buildAddonUserscript({ manifestPath: badManifestPath, targetDir: path.join(tmp, 'bad-out') }),
      /MODULAR_ADDON_USERSCRIPT_AST_VIOLATIONS/
    );

    // Real CLI --build-addon-userscript --check determinism
    const binPath = path.resolve(__dirname, '..', '..', 'bin', 'addon-host.js');
    const cliRes = spawnSync(
      process.execPath,
      [
        binPath,
        '--build-addon-userscript',
        '--manifest',
        manifestPath,
        '--plugin-dir',
        pluginDir,
        '--update-base-url',
        'https://github.com/example/sample-addon/releases/latest/download/',
        '--connect',
        'translate.googleapis.com',
        '--grant-xhr',
        '--check',
      ],
      { encoding: 'utf8' }
    );
    assert.equal(cliRes.status, 0, cliRes.stderr);
    const cliJson = JSON.parse(cliRes.stdout.trim());
    assert.equal(cliJson.ok, true);
    assert.equal(cliJson.mode, 'check');
    assert.equal(cliJson.bundleMode, 'modular-addon-userscript');
    assert.equal(cliJson.pluginId, 'sample-remote-addon');
    assert.equal(cliJson.astViolations, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('TC-U7b: Multi-sandbox @require Userscript coexistence shares one drawer, isolates sandboxes, blocks duplicates, and disposes independently', async () => {
  const { doc, makeSandboxWin } = makeMockDom('https://antigravity.google.com/workspace');
  const winA = makeSandboxWin();
  const winB = makeSandboxWin();
  const winDup = makeSandboxWin();

  const kernelA = createRendererKernel(doc, winA);
  const kernelB = createRendererKernel(doc, winB);
  const kernelDup = createRendererKernel(doc, winDup);

  let alphaActions = 0;
  let alphaTabs = 0;
  let betaActions = 0;
  let betaTabs = 0;

  registerAddon(
    {
      pluginMeta: {
        schemaVersion: 2,
        pluginId: 'addon-alpha',
        displayName: 'Addon Alpha',
        version: '1.0.0',
        trustLevel: 'restricted',
        capabilities: ['renderer'],
        uiSlots: [],
      },
      run(addonHost) {
        addonHost.registerAction('alpha-act', {
          label: 'Run Alpha',
          run() {
            alphaActions += 1;
          },
        });
        addonHost.registerSettingsTab('alpha-tab', {
          label: 'Alpha Settings',
          onSelect() {
            alphaTabs += 1;
          },
        });
      },
    },
    { win: winA }
  );

  const bootA = await bootRemoteWebHost({
    doc,
    win: winA,
    profile: ANTIGRAVITY_REMOTE_WEB_PROFILE,
    kernel: kernelA,
  });
  assert.equal(bootA.ok, true);
  assert.equal(bootA.peerCoexist, false);
  assert.equal(doc.documentElement.getAttribute(MOUNTED_PLUGINS_ATTR), 'addon-alpha');

  const sr = bootA.controller.drawerUi.shadowRoot;
  assert.equal(sr.querySelector('[data-rah-count-badge]').textContent, '1/1');

  // Sandbox B boots independent addon-beta into the same document
  registerAddon(
    {
      pluginMeta: {
        schemaVersion: 2,
        pluginId: 'addon-beta',
        displayName: 'Addon Beta',
        version: '2.0.0',
        trustLevel: 'restricted',
        capabilities: ['renderer'],
        uiSlots: [],
      },
      run(addonHost) {
        addonHost.registerAction('beta-act', {
          label: 'Run Beta',
          run() {
            betaActions += 1;
          },
        });
        addonHost.registerSettingsTab('beta-tab', {
          label: 'Beta Settings',
          onSelect() {
            betaTabs += 1;
          },
        });
      },
    },
    { win: winB }
  );

  const bootB = await bootRemoteWebHost({
    doc,
    win: winB,
    profile: ANTIGRAVITY_REMOTE_WEB_PROFILE,
    kernel: kernelB,
  });
  assert.equal(bootB.ok, true);
  assert.equal(bootB.alreadyBooted, false);
  assert.equal(bootB.peerCoexist, true);
  assert.equal(doc.querySelectorAll('#remote-addon-host-drawer-root').length, 1);
  assert.equal(doc.documentElement.getAttribute(MOUNTED_PLUGINS_ATTR), 'addon-alpha,addon-beta');
  assert.equal(sr.querySelector('[data-rah-count-badge]').textContent, '2/2');

  // Sandbox Dup attempting to re-mount already-mounted addon-alpha is blocked cleanly
  registerAddon(
    {
      pluginMeta: {
        schemaVersion: 2,
        pluginId: 'addon-alpha',
        displayName: 'Addon Alpha Dup',
        version: '1.0.0',
        trustLevel: 'restricted',
        capabilities: ['renderer'],
        uiSlots: [],
      },
      run() {},
    },
    { win: winDup }
  );
  const bootDup = await bootRemoteWebHost({
    doc,
    win: winDup,
    profile: ANTIGRAVITY_REMOTE_WEB_PROFILE,
    kernel: kernelDup,
  });
  assert.equal(bootDup.ok, true);
  assert.equal(bootDup.alreadyBooted, true);
  assert.equal(bootDup.crossWorld, true);
  assert.equal(bootDup.controller, null);

  // Open single shared drawer and invoke Quick Actions & Settings Tabs for BOTH sandboxes
  sr.querySelector('.rah-pill').click();
  sr.querySelector('[data-host-action-plugin="addon-alpha"][data-host-action-id="alpha-act"]').click();
  sr.querySelector('[data-host-action-plugin="addon-beta"][data-host-action-id="beta-act"]').click();
  assert.equal(alphaActions, 1);
  assert.equal(betaActions, 1);

  const tabs = sr.querySelectorAll('.rah-tab');
  tabs[1].click();
  sr.querySelector('[data-settings-tab-plugin="addon-alpha"][data-settings-tab-id="alpha-tab"]').click();
  assert.equal(alphaTabs, 1);
  assert.equal(sr.querySelector('#rah-drawer-panel').hasAttribute('hidden'), true);

  sr.querySelector('.rah-pill').click();
  tabs[1].click();
  sr.querySelector('[data-settings-tab-plugin="addon-beta"][data-settings-tab-id="beta-tab"]').click();
  assert.equal(betaTabs, 1);
  assert.equal(sr.querySelector('#rah-drawer-panel').hasAttribute('hidden'), true);

  // Dispose Sandbox B independently -> badge returns to 1/1, drawer & Sandbox A remain intact
  bootB.controller.dispose();
  assert.equal(doc.querySelectorAll('#remote-addon-host-drawer-root').length, 1);
  assert.equal(doc.documentElement.getAttribute(MOUNTED_PLUGINS_ATTR), 'addon-alpha');
  assert.equal(sr.querySelector('[data-rah-count-badge]').textContent, '1/1');
  assert.equal(sr.querySelector('[data-host-action-plugin="addon-beta"]'), null);
  assert.ok(sr.querySelector('[data-host-action-plugin="addon-alpha"]'));

  bootA.controller.dispose();
  assert.equal(doc.documentElement.getAttribute(MOUNTED_PLUGINS_ATTR), null);
});
