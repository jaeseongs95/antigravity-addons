'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ALLOWED_UI_NODE_TYPES, validateUiTree } = require('../../src/core/ui-schema-validator');
const { createSchemaUiController } = require('../../src/runtime/renderer/ui-schema-renderer');
const { createThemeAndI18n, HOST_LOCALE_STORAGE_KEY } = require('../../src/runtime/renderer/theme-i18n');
const { createHostSettingsUi } = require('../../src/runtime/renderer/host-settings-ui');
const { createRendererKernel } = require('../../src/runtime/renderer/kernel');
const { bootRemoteWebHost } = require('../../src/adapters/remote-web/remote-bootstrap');
const { ANTIGRAVITY_HOST_PROFILE } = require('../../src/profiles/antigravity');
const { ANTIGRAVITY_REMOTE_WEB_PROFILE, toBrowserRemoteWebProfile } = require('../../src/profiles/antigravity-remote-web');
const { buildHostLoaderScriptSource } = require('../../src/adapters/electron/host-loader-builder');
const { createTestHost } = require('../../packages/sdk');

test('TC-V330-UI-01: segmented primitive validation, build, click, patch, disabled, and untrusted rejection', () => {
  assert.equal(ALLOWED_UI_NODE_TYPES.includes('segmented'), true);

  const badTree = { type: 'segmented', id: 'lang' };
  const badRes = validateUiTree(badTree);
  assert.equal(badRes.ok, false);

  const host = createTestHost({ locale: 'ko' });
  const container = host.doc.createElement('div');
  const changes = [];
  const tree = {
    type: 'stack',
    id: 'root',
    children: [
      {
        type: 'segmented',
        id: 'mode',
        field: 'mode',
        label: 'Mode',
        options: [
          { value: 'ko', label: '한국어' },
          { value: 'en', label: 'EN' },
        ],
      },
      {
        type: 'button',
        id: 'save-btn',
        label: 'Save',
        variant: 'primary',
        actionId: 'save',
      },
    ],
  };

  const ctrl = createSchemaUiController(host.doc, container, {
    tree,
    state: { mode: 'ko' },
    onChange: (ev) => changes.push(ev),
  });

  const segEl = ctrl.getElementById('mode');
  assert.ok(segEl);
  assert.equal(segEl.getAttribute('role'), 'group');
  assert.equal(segEl.getAttribute('data-ag-segmented'), '1');
  assert.equal(segEl.childNodes.length, 2);
  assert.equal(segEl.childNodes[0].getAttribute('aria-pressed'), 'true');
  assert.equal(segEl.childNodes[1].getAttribute('aria-pressed'), 'false');

  // Untrusted click must be ignored
  segEl.childNodes[1].click({ isTrusted: false });
  assert.equal(changes.length, 0);

  // Trusted click updates state and aria-pressed
  segEl.childNodes[1].click({ isTrusted: true });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].field, 'mode');
  assert.equal(changes[0].value, 'en');
  assert.equal(segEl.childNodes[0].getAttribute('aria-pressed'), 'false');
  assert.equal(segEl.childNodes[1].getAttribute('aria-pressed'), 'true');

  // Patching disabled + removing button variant
  const btnEl = ctrl.getElementById('save-btn');
  assert.equal(btnEl.getAttribute('data-variant'), 'primary');

  ctrl.update(
    {
      type: 'stack',
      id: 'root',
      children: [
        {
          type: 'segmented',
          id: 'mode',
          field: 'mode',
          label: 'Mode',
          disabled: true,
          options: [
            { value: 'ko', label: '한국어' },
            { value: 'en', label: 'EN' },
          ],
        },
        {
          type: 'button',
          id: 'save-btn',
          label: 'Save',
          actionId: 'save',
        },
      ],
    },
    { mode: 'ko' }
  );

  assert.equal(ctrl.getElementById('mode'), segEl);
  assert.equal(ctrl.getElementById('save-btn'), btnEl);
  assert.equal(segEl.childNodes[0].disabled, true);
  assert.equal(segEl.childNodes[1].disabled, true);
  assert.equal(segEl.childNodes[0].getAttribute('aria-pressed'), 'true');
  // Clicking disabled segment must be ignored
  segEl.childNodes[1].click({ isTrusted: true });
  assert.equal(changes.length, 1);

  // Button data-variant MUST be cleared when node.variant is removed
  assert.equal(btnEl.getAttribute('data-variant'), null);
});

test('TC-V330-I18N-02: central host locale, ctx.i18n.onDidChange, Addon Manager sync, and auto-dispose', async () => {
  const host = createTestHost({ locale: 'en' });
  const received = [];
  const ctx = await host.mountPlugin(
    {
      schemaVersion: 3,
      pluginId: 'i18n-observer-plugin',
      displayName: 'i18n Observer',
      version: '1.0.0',
      capabilities: ['renderer'],
      entry: { rendererScript: 'renderer.js' },
    },
    (c) => {
      c.i18n.onDidChange((loc) => received.push(loc));
    }
  );

  assert.equal(ctx.i18n.getLocale(), 'en');
  host.setLocale('ko');
  assert.equal(ctx.i18n.getLocale(), 'ko');
  assert.equal(host.win.localStorage.getItem(HOST_LOCALE_STORAGE_KEY), 'ko');
  assert.deepEqual(received, ['ko']);

  // Calling setLocale with same value should not double-fire
  host.setLocale('ko-KR');
  assert.deepEqual(received, ['ko']);

  // Cross-tab storage event updates locale and notifies subscribers
  host.win.dispatchEvent({ type: 'storage', key: HOST_LOCALE_STORAGE_KEY, newValue: 'en' });
  assert.equal(ctx.i18n.getLocale(), 'en');
  assert.deepEqual(received, ['ko', 'en']);

  // Disposing plugin auto-unsubscribes its i18n listener
  host.disposePlugin('i18n-observer-plugin');
  host.setLocale('ko');
  assert.deepEqual(received, ['ko', 'en']);

  // HostSettingsUi syncs directly with central themeAndI18n
  const themeAndI18n = createThemeAndI18n(host.doc, host.win);
  const settingsUiChanges = [];
  themeAndI18n.onLocaleDidChange((loc) => settingsUiChanges.push(loc));
  const settingsUi = createHostSettingsUi(host.doc, host.win, {
    themeAndI18n,
    hostBridge: { getHostAdminState: async () => ({ ok: true, addons: [] }) },
  });
  settingsUi.setLanguage('en');
  assert.equal(themeAndI18n.getLocale(), 'en');
  assert.deepEqual(settingsUiChanges, ['en']);
  settingsUi.dispose();
  themeAndI18n.dispose();
});

test('TC-V330-I18N-03: Remote Web drawer language switcher drives ctx.i18n.onDidChange', async () => {
  const host = createTestHost({ surface: 'remote-web', locale: 'en' });
  host.win.location = { href: 'https://antigravity.google.com/chat', origin: 'https://antigravity.google.com' };
  const observedLocales = [];

  const profile = toBrowserRemoteWebProfile(ANTIGRAVITY_REMOTE_WEB_PROFILE);
  assert.ok(profile.uiSectionTargets && profile.uiSectionTargets['customizations.mcp-servers.header']);

  const kernel = createRendererKernel(host.doc, host.win);
  const boot = await bootRemoteWebHost({
    doc: host.doc,
    win: host.win,
    profile,
    kernel,
    packedAddons: [
      {
        pluginMeta: {
          pluginId: 'remote-i18n-addon',
          displayName: 'Remote i18n Addon',
          version: '1.0.0',
          schemaVersion: 3,
          apiVersion: 3,
          sourceSchemaVersion: 3,
          trustLevel: 'restricted',
        },
        run(ctx) {
          ctx.i18n.onDidChange((loc) => observedLocales.push(loc));
        },
      },
    ],
  });
  assert.equal(boot.ok, true);
  assert.equal(boot.controller.getHostLocale(), 'en');

  // Click [한국어] button inside drawer shadow root
  const koBtn = boot.controller.drawerUi.shadowRoot.querySelector('[data-rah-lang="ko"]');
  assert.ok(koBtn, 'Remote Web drawer must render [한국어] language switch button');
  koBtn.click({ isTrusted: true });

  assert.equal(boot.controller.getHostLocale(), 'ko');
  assert.deepEqual(observedLocales, ['ko']);
  assert.equal(koBtn.getAttribute('aria-pressed'), 'true');

  boot.controller.dispose();
});

test('TC-V330-SEC-04: ctx.ui.registerSectionAction mounts on Antigravity target, supports update/click/dispose and SDK parity', async () => {
  assert.ok(
    ANTIGRAVITY_HOST_PROFILE.uiSectionTargets &&
      ANTIGRAVITY_HOST_PROFILE.uiSectionTargets['customizations.mcp-servers.header']
  );

  const host = createTestHost({
    surface: 'desktop',
    uiSectionTargets: ANTIGRAVITY_HOST_PROFILE.uiSectionTargets,
  });

  // Build simulated Antigravity Customizations > MCP Servers header DOM
  const customView = host.doc.createElement('div');
  customView.setAttribute('data-testid', 'customizations-view');
  const headerRow = host.doc.createElement('div');
  const heading = host.doc.createElement('h2');
  heading.textContent = 'MCP Servers';
  const actionsWrap = host.doc.createElement('div');
  const nativeBtn = host.doc.createElement('button');
  nativeBtn.textContent = 'Manage MCP Servers';
  actionsWrap.appendChild(nativeBtn);
  headerRow.appendChild(heading);
  headerRow.appendChild(actionsWrap);
  customView.appendChild(headerRow);
  host.doc.body.appendChild(customView);

  const clicks = [];
  let handle = null;
  await host.mountPlugin(
    {
      schemaVersion: 3,
      pluginId: 'antigravity-mcp-manager',
      displayName: 'MCP Manager',
      version: '1.0.0',
      capabilities: ['renderer'],
      entry: { rendererScript: 'renderer.js' },
      permissions: { ui: { sectionActions: true } },
    },
    (ctx) => {
      handle = ctx.ui.registerSectionAction({
        id: 'manage-mcp',
        target: 'customizations.mcp-servers.header',
        label: 'MCP 관리',
        tooltip: 'Open MCP Manager',
        badge: '3',
        order: 10,
        onClick: (ev) => clicks.push(ev),
      });
    }
  );

  const actions = host.getSectionActions();
  assert.equal(actions.length, 1);
  assert.equal(actions[0].id, 'manage-mcp');
  assert.equal(actions[0].mounted, true);

  // Inserted BEFORE native Manage MCP Servers button
  assert.equal(actionsWrap.childNodes[0].getAttribute('data-addon-host-section-actions'), 'customizations.mcp-servers.header');
  assert.equal(actionsWrap.childNodes[1], nativeBtn);

  const mountedBtn = actionsWrap.querySelector('[data-addon-host-section-action-btn="antigravity-mcp-manager:manage-mcp"]');
  assert.ok(mountedBtn);
  assert.equal(mountedBtn.getAttribute('data-addon-host-no-translate'), 'true');
  assert.equal(mountedBtn.textContent.includes('MCP 관리'), true);
  assert.equal(mountedBtn.textContent.includes('3'), true);

  // Untrusted click ignored, trusted click delivered
  mountedBtn.click({ isTrusted: false });
  assert.equal(clicks.length, 0);
  mountedBtn.click({ isTrusted: true, shiftKey: true });
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].actionId, 'manage-mcp');
  assert.equal(clicks[0].target, 'customizations.mcp-servers.header');
  assert.equal(clicks[0].shiftKey, true);

  // Update patch updates rendered label/badge in place
  handle.update({ label: 'MCP 설정', badge: '5' });
  const updatedBtn = actionsWrap.querySelector('[data-addon-host-section-action-btn="antigravity-mcp-manager:manage-mcp"]');
  assert.equal(updatedBtn.textContent.includes('MCP 설정'), true);
  assert.equal(updatedBtn.textContent.includes('5'), true);

  // Programmatic invoke via SDK TestHost
  const invRes = host.invokeSectionAction('antigravity-mcp-manager', 'manage-mcp', { altKey: true });
  assert.equal(invRes.ok, true);
  assert.equal(clicks.length, 2);
  assert.equal(clicks[1].altKey, true);

  // Dispose plugin cleans up button and wrapper group
  host.disposePlugin('antigravity-mcp-manager');
  assert.equal(host.getSectionActions().length, 0);
  assert.equal(actionsWrap.childNodes.length, 1);
  assert.equal(actionsWrap.childNodes[0], nativeBtn);

  // Permission denial when permissions.ui.sectionActions === false
  await assert.rejects(async () => {
    await host.mountPlugin(
      {
        schemaVersion: 3,
        pluginId: 'no-sec-action-plugin',
        displayName: 'No Section Actions',
        version: '1.0.0',
        capabilities: ['renderer'],
        entry: { rendererScript: 'renderer.js' },
        permissions: { ui: { sectionActions: false } },
      },
      (ctx) => {
        ctx.ui.registerSectionAction({
          id: 'denied',
          target: 'customizations.mcp-servers.header',
          label: 'Denied',
        });
      }
    );
  }, /ERR_UI_SECTION_ACTIONS_FORBIDDEN/);
});

test('TC-V331-SEC-05: Desktop host-loader serializes uiSectionTargets and section-action-registry mounts on real Antigravity nested button/count DOM without false positives', async () => {
  // 1. Desktop addon-host-loader.js MUST serialize profile.uiSectionTargets
  const loaderSrc = buildHostLoaderScriptSource(
    ANTIGRAVITY_HOST_PROFILE.resolvePaths(process.env),
    ANTIGRAVITY_HOST_PROFILE,
    { hostVersion: '3.3.1', buildSha8: 'test3310' }
  );
  assert.equal(loaderSrc.includes('uiSectionTargets'), true);
  assert.equal(loaderSrc.includes('customizations.mcp-servers.header'), true);

  // 2. Real Antigravity v2.35.2 nested collapsible header DOM (no data-testid="customizations-view", no h2)
  const host = createTestHost({
    surface: 'desktop',
    uiSectionTargets: ANTIGRAVITY_HOST_PROFILE.uiSectionTargets,
  });

  // False-positive decoy inside conversation-view MUST be ignored
  const convView = host.doc.createElement('div');
  convView.setAttribute('data-testid', 'conversation-view');
  const convRow = host.doc.createElement('div');
  const convLabel = host.doc.createElement('span');
  convLabel.textContent = 'MCP 서버';
  const convBtns = host.doc.createElement('div');
  const convCopy = host.doc.createElement('button');
  convCopy.textContent = 'Copy';
  convBtns.appendChild(convCopy);
  convRow.appendChild(convLabel);
  convRow.appendChild(convBtns);
  convView.appendChild(convRow);
  host.doc.body.appendChild(convView);

  // Real Customizations -> Installed -> MCP 서버 3 v header
  const page = host.doc.createElement('div');
  const headerRow = host.doc.createElement('div');
  headerRow.setAttribute('id', 'mcp-header-row');
  const leftWrap = host.doc.createElement('div');
  const toggleBtn = host.doc.createElement('button');
  const titleSpan = host.doc.createElement('span');
  titleSpan.textContent = 'MCP 서버';
  const countSpan = host.doc.createElement('span');
  countSpan.textContent = '3';
  const chevSvg = host.doc.createElement('svg');
  toggleBtn.appendChild(titleSpan);
  toggleBtn.appendChild(countSpan);
  toggleBtn.appendChild(chevSvg);
  leftWrap.appendChild(toggleBtn);

  const rightActions = host.doc.createElement('div');
  rightActions.setAttribute('id', 'mcp-right-actions');
  const cfgBtn = host.doc.createElement('button');
  cfgBtn.textContent = '설정';
  const addBtn = host.doc.createElement('button');
  addBtn.textContent = '+';
  rightActions.appendChild(cfgBtn);
  rightActions.appendChild(addBtn);
  headerRow.appendChild(leftWrap);
  headerRow.appendChild(rightActions);
  page.appendChild(headerRow);
  host.doc.body.appendChild(page);

  await host.mountPlugin(
    {
      schemaVersion: 3,
      pluginId: 'antigravity-mcp-manager',
      displayName: 'MCP Manager',
      version: '4.3.0',
      capabilities: ['renderer'],
      entry: { rendererScript: 'renderer.js' },
      permissions: { ui: { sectionActions: true } },
    },
    (ctx) => {
      ctx.ui.registerSectionAction({
        id: 'manage-mcp',
        target: 'customizations.mcp-servers.header',
        label: 'MCP 관리',
        badge: '3',
        onClick: () => {},
      });
    }
  );

  // Mounted inside rightActions BEFORE native buttons; ZERO mount inside conversation-view
  assert.equal(convBtns.childNodes.length, 1);
  assert.equal(rightActions.childNodes.length, 3);
  assert.equal(
    rightActions.childNodes[0].getAttribute('data-addon-host-section-actions'),
    'customizations.mcp-servers.header'
  );
  assert.equal(rightActions.childNodes[1], cfgBtn);
  assert.equal(host.getSectionActions()[0].mounted, true);
  host.disposePlugin('antigravity-mcp-manager');

  // 3. Direct button sibling header row (button('MCP Servers 3') + button(settings) + button(+))
  const host2 = createTestHost({
    surface: 'desktop',
    uiSectionTargets: ANTIGRAVITY_HOST_PROFILE.uiSectionTargets,
  });
  const directRow = host2.doc.createElement('div');
  const collapseBtn = host2.doc.createElement('button');
  collapseBtn.textContent = 'MCP Servers 3';
  const settingsBtn = host2.doc.createElement('button');
  settingsBtn.textContent = 'Settings';
  directRow.appendChild(collapseBtn);
  directRow.appendChild(settingsBtn);
  host2.doc.body.appendChild(directRow);

  await host2.mountPlugin(
    {
      schemaVersion: 3,
      pluginId: 'antigravity-mcp-manager',
      displayName: 'MCP Manager',
      version: '4.3.0',
      capabilities: ['renderer'],
      entry: { rendererScript: 'renderer.js' },
      permissions: { ui: { sectionActions: true } },
    },
    (ctx) => {
      ctx.ui.registerSectionAction({
        id: 'manage-mcp',
        target: 'customizations.mcp-servers.header',
        label: 'MCP 관리',
        onClick: () => {},
      });
    }
  );
  assert.equal(directRow.childNodes.length, 3);
  assert.equal(directRow.childNodes[0], collapseBtn);
  assert.equal(
    directRow.childNodes[1].getAttribute('data-addon-host-section-actions'),
    'customizations.mcp-servers.header'
  );
  assert.equal(directRow.childNodes[2], settingsBtn);
  host2.disposePlugin('antigravity-mcp-manager');
});

test('TC-V332-HEADER-LOCALE-06: Settings Page header renders host [한국어|EN] switcher in Desktop inline & modal/Remote Web, syncs global locale + Addon Manager + getTitle, and honors showLocaleSwitch:false', async () => {
  const baseHost = createTestHost({ locale: 'en' });
  const { doc, win } = baseHost;
  const storage = new Map();
  win.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(String(k), String(v)),
    removeItem: (k) => storage.delete(String(k)),
  };

  // Build mock Desktop Settings container with real geometry so host-settings-ui mounts inline
  const shell = doc.createElement('div');
  shell.setMockRect({ left: 0, top: 0, width: 960, height: 640, right: 960, bottom: 640 });
  const sidebarCol = doc.createElement('div');
  sidebarCol.setMockRect({ left: 0, top: 0, width: 220, height: 640, right: 220, bottom: 640 });
  const sidebar = doc.createElement('div');
  sidebar.setMockRect({ left: 0, top: 0, width: 220, height: 400, right: 220, bottom: 400 });
  for (const label of ['General', 'Application', 'Appearance', 'Shortcuts']) {
    const btn = doc.createElement('button');
    btn.setAttribute('type', 'button');
    const sp = doc.createElement('span');
    sp.appendChild(doc.createTextNode(label));
    btn.appendChild(sp);
    sidebar.appendChild(btn);
  }
  sidebarCol.appendChild(sidebar);
  const contentPane = doc.createElement('div');
  contentPane.setMockRect({ left: 220, top: 0, width: 740, height: 640, right: 960, bottom: 640 });
  const nativePanel = doc.createElement('div');
  nativePanel.textContent = 'Native General View';
  contentPane.appendChild(nativePanel);
  shell.appendChild(sidebarCol);
  shell.appendChild(contentPane);
  doc.body.appendChild(shell);
  win.getComputedStyle = () => ({ display: 'flex', visibility: 'visible', opacity: '1', backgroundColor: 'transparent', color: '#cbd5e1' });

  const kernel = createRendererKernel(doc, win);
  const token = 'test-token-v332-header-locale';
  kernel.boot({
    docGenId: 1,
    hostToken: token,
    hostProfileId: 'antigravity-desktop',
    surface: 'desktop',
    settingsUi: { navId: 'addon-manager', navLabel: { en: 'Addon Manager', ko: '애드온 관리' } },
    hostBridge: {
      docGenId: 1,
      profileId: 'antigravity-desktop',
      setPortalClaim: () => ({ ok: true }),
      saveSettings: async () => ({ ok: true }),
      reportError: () => {},
      ping: async () => ({ ok: true }),
      getHostAdminState: async () => ({ ok: true, state: { host: { version: '3.3.2', buildSha8: 'testsha8' }, addons: [] } }),
      setRemoteAddonPreference: async () => ({ ok: true }),
    },
  });

  const seenLocales = [];
  const ctx = kernel.createPluginHandle(
    {
      pluginId: 'statusbar-test',
      displayName: 'Statusbar',
      version: '3.5.0',
      apiVersion: 3,
      sourceSchemaVersion: 3,
      trustLevel: 'trusted',
      permissions: { ui: { settingsPages: true } },
    },
    token
  );
  ctx.i18n.onDidChange((loc) => seenLocales.push(loc));

  const pageHandle = ctx.ui.registerSettingsPage({
    id: 'main',
    title: 'Statusbar Settings',
    getTitle: () => (ctx.i18n.getLocale().startsWith('ko') ? '상태바 설정' : 'Statusbar Settings'),
    getSchema: () => ({ type: 'text', id: 'body-txt', text: 'ok' }),
  });

  // 1. Desktop inline Settings Page mounts header-right [한국어|EN] switch by default
  const inlineOpen = pageHandle.open();
  assert.ok(inlineOpen);
  assert.equal(inlineOpen.kind, 'inline-settings');
  const sr = inlineOpen.element.shadowRoot;
  assert.ok(sr);
  const langGroup = sr.querySelector('[data-addon-host-control="locale-switch"]');
  assert.ok(langGroup, 'Inline Settings header must render host locale switch by default');
  const koBtn = sr.querySelector('[data-addon-host-lang="ko"]');
  const enBtn = sr.querySelector('[data-addon-host-lang="en"]');
  assert.ok(koBtn && enBtn);
  assert.equal(enBtn.getAttribute('aria-pressed'), 'true');
  assert.equal(sr.querySelector('h2').textContent, 'Statusbar Settings');

  // Clicking [한국어] updates global host locale storage, fires ctx.i18n.onDidChange, and updates dynamic getTitle()
  koBtn.click({ isTrusted: true });
  assert.equal(storage.get(HOST_LOCALE_STORAGE_KEY), 'ko');
  assert.equal(ctx.i18n.getLocale(), 'ko');
  assert.deepEqual(seenLocales, ['ko']);
  assert.equal(koBtn.getAttribute('aria-pressed'), 'true');
  assert.equal(enBtn.getAttribute('aria-pressed'), 'false');
  assert.equal(sr.querySelector('h2').textContent, '상태바 설정');

  // Untrusted synthetic click is ignored
  enBtn.click({ isTrusted: false });
  assert.equal(ctx.i18n.getLocale(), 'ko');

  // Closing inline page disposes header locale listeners cleanly
  inlineOpen.close();

  // 2. Opt-out: showLocaleSwitch: false omits switcher in inline header
  const quietPage = ctx.ui.registerSettingsPage({
    id: 'quiet',
    title: 'Quiet Page',
    showLocaleSwitch: false,
    schema: { type: 'text', id: 'q-txt', text: 'quiet' },
  });
  const quietOpen = quietPage.open();
  assert.equal(quietOpen.element.shadowRoot.querySelector('[data-addon-host-control="locale-switch"]'), null);
  quietOpen.close();

  // 3. Modal / Remote Web Settings Page (.ag-ui-header) also mounts [한국어|EN] switch and syncs global locale
  const remoteHost = createTestHost({ surface: 'remote-web', locale: 'en' });
  const remoteLocales = [];
  let remotePage = null;
  await remoteHost.mountPlugin(
    {
      schemaVersion: 3,
      pluginId: 'statusbar-remote',
      displayName: 'Statusbar',
      version: '3.5.0',
      capabilities: ['renderer'],
      entry: { rendererScript: 'renderer.js' },
      permissions: { ui: { settingsPages: true } },
    },
    (rCtx) => {
      rCtx.i18n.onDidChange((loc) => remoteLocales.push(loc));
      remotePage = rCtx.ui.registerSettingsPage({
        id: 'main',
        title: 'Statusbar Settings',
        getTitle: () => (rCtx.i18n.getLocale().startsWith('ko') ? '상태바 설정' : 'Statusbar Settings'),
        schema: { type: 'text', id: 'r-txt', text: 'remote' },
      });
    }
  );
  const modalHandle = remotePage.open();
  assert.ok(modalHandle);
  const modalSr = modalHandle.element.childNodes[0].shadowRoot;
  const rKoBtn = modalSr.querySelector('[data-addon-host-lang="ko"]');
  assert.ok(rKoBtn, 'Modal/Remote Web Settings Page header must render host locale switch by default');
  rKoBtn.click({ isTrusted: true });
  assert.deepEqual(remoteLocales, ['ko']);
  const titleDiv = modalSr.querySelectorAll('div').find((d) => d.className === 'ag-ui-title');
  assert.ok(titleDiv);
  assert.equal(titleDiv.textContent, '상태바 설정');
  modalHandle.close();

  remoteHost.disposePlugin('statusbar-remote');
  kernel.disposePlugin('statusbar-test', token);
});
