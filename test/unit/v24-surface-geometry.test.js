'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { validateHostProfile } = require('../../src/core/host-profile-port');
const { ANTIGRAVITY_HOST_PROFILE } = require('../../src/profiles/antigravity');
const {
  ANTIGRAVITY_REMOTE_WEB_PROFILE,
  toBrowserRemoteWebProfile,
} = require('../../src/profiles/antigravity-remote-web');
const { createSurfaceGeometry } = require('../../src/runtime/renderer/surface-geometry');
const { createRendererKernel } = require('../../src/runtime/renderer/kernel');
const { verifyRemoteBundleAst } = require('../../scripts/build-remote');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function makeGeometryMockDom({
  viewportWidth = 1440,
  viewportHeight = 900,
  selectorMatches = {},
} = {}) {
  const resizeListeners = new Set();
  const children = [];

  function makeEl(tag, rect = null, { display = 'block', visibility = 'visible', opacity = '1', attrs = {} } = {}) {
    const attrMap = new Map(Object.entries(attrs));
    const elChildren = [];
    const el = {
      tagName: String(tag || 'DIV').toUpperCase(),
      style: {},
      parentNode: null,
      isConnected: true,
      open: false,
      _computedStyle: { display, visibility, opacity },
      get children() {
        return elChildren;
      },
      setAttribute(k, v) {
        attrMap.set(String(k), String(v));
      },
      getAttribute(k) {
        return attrMap.has(String(k)) ? attrMap.get(String(k)) : null;
      },
      appendChild(c) {
        c.parentNode = this;
        elChildren.push(c);
        return c;
      },
      removeChild(c) {
        const idx = elChildren.indexOf(c);
        if (idx >= 0) elChildren.splice(idx, 1);
        c.parentNode = null;
        return c;
      },
      addEventListener() {},
      removeEventListener() {},
      showModal() {
        this.open = true;
      },
      close() {
        this.open = false;
      },
      getBoundingClientRect() {
        return rect || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
      },
    };
    return el;
  }

  const body = makeEl('body');
  const doc = {
    body,
    documentElement: { clientWidth: viewportWidth, clientHeight: viewportHeight },
    activeElement: null,
    createElement: (tag) => {
      const el = makeEl(tag);
      children.push(el);
      return el;
    },
    querySelectorAll(sel) {
      return selectorMatches[sel] || [];
    },
    querySelector(sel) {
      const arr = selectorMatches[sel] || [];
      return arr.length > 0 ? arr[0] : null;
    },
    addEventListener() {},
    removeEventListener() {},
  };

  const win = {
    innerWidth: viewportWidth,
    innerHeight: viewportHeight,
    getComputedStyle(el) {
      return (el && el._computedStyle) || { display: 'block', visibility: 'visible', opacity: '1' };
    },
    addEventListener(type, fn) {
      if (type === 'resize') resizeListeners.add(fn);
    },
    removeEventListener(type, fn) {
      if (type === 'resize') resizeListeners.delete(fn);
    },
    emitResize(nextW, nextH) {
      win.innerWidth = nextW;
      win.innerHeight = nextH;
      doc.documentElement.clientWidth = nextW;
      doc.documentElement.clientHeight = nextH;
      for (const fn of Array.from(resizeListeners)) fn();
    },
    getResizeListenerCount() {
      return resizeListeners.size;
    },
  };

  return { doc, win, makeEl, selectorMatches };
}

test('TC-SG-001: surface-geometry.js satisfies SOLID #0 (zero vendor literals, zero Node imports, AST clean)', () => {
  const filePath = path.join(REPO_ROOT, 'src', 'runtime', 'renderer', 'surface-geometry.js');
  const src = fs.readFileSync(filePath, 'utf8');
  const forbidden = [/antigravity/i, /data-agy-/i, /\bAGY_/, /require\(['"](?:node:)?(?:fs|path|os|electron)['"]\)/];
  for (const re of forbidden) {
    assert.equal(re.test(src), false, `Forbidden pattern ${re} leaked into surface-geometry.js`);
  }
  const ast = verifyRemoteBundleAst(src);
  assert.equal(ast.ok, true, `AST violations: ${JSON.stringify(ast.violations)}`);
});

test('TC-SG-002: HostProfile uiSurfaces validates on Desktop & Remote Web profiles and rejects malformed descriptors', () => {
  assert.equal(validateHostProfile(ANTIGRAVITY_HOST_PROFILE).ok, true);
  assert.equal(validateHostProfile(ANTIGRAVITY_REMOTE_WEB_PROFILE).ok, true);

  const browserProfile = toBrowserRemoteWebProfile(ANTIGRAVITY_REMOTE_WEB_PROFILE);
  assert.ok(browserProfile.uiSurfaces['customizations-page']);
  assert.ok(browserProfile.uiSurfaces['settings-pane']);
  assert.ok(browserProfile.uiSurfaces.workspace);
  assert.doesNotThrow(() => JSON.stringify(browserProfile));

  const base = { id: 'test-host', resolvePaths: () => ({}) };
  assert.equal(validateHostProfile({ ...base, uiSurfaces: [] }).ok, false);
  assert.equal(validateHostProfile({ ...base, uiSurfaces: { bad: { selectors: [123] } } }).ok, false);
  assert.equal(validateHostProfile({ ...base, uiSurfaces: { bad: { priority: NaN } } }).ok, false);
  assert.equal(validateHostProfile({ ...base, uiSurfaces: { bad: { safeInsets: { top: -10 } } } }).ok, false);
});

test('TC-SG-003: Direct selector resolution respects surface priority, skips hidden/zero elements, and ignores addon portals', () => {
  const { doc, win, makeEl, selectorMatches } = makeGeometryMockDom({ viewportWidth: 1440, viewportHeight: 900 });

  // Hidden settings modal (display: none) + addon modal portal dialog MUST be ignored
  const hiddenSettings = makeEl('div', { left: 200, top: 80, right: 1200, bottom: 820, width: 1000, height: 740 }, { display: 'none' });
  const addonDialog = makeEl(
    'dialog',
    { left: 100, top: 50, right: 900, bottom: 700, width: 800, height: 650 },
    { attrs: { 'data-addon-host-modal-dialog': '1' } }
  );
  const customizationsEl = makeEl('div', { left: 260, top: 36, right: 1440, bottom: 872, width: 1180, height: 836 });
  const workspaceEl = makeEl('main', { left: 260, top: 36, right: 1440, bottom: 900, width: 1180, height: 864 });

  selectorMatches['.settings-modal-container'] = [hiddenSettings, addonDialog];
  selectorMatches['[data-testid="customizations-view"]'] = [customizationsEl];
  selectorMatches.main = [workspaceEl];

  const sg = createSurfaceGeometry(doc, win, {
    uiSurfaces: ANTIGRAVITY_HOST_PROFILE.uiSurfaces,
    uiAnchors: ANTIGRAVITY_HOST_PROFILE.uiAnchors,
  });

  assert.deepEqual(sg.listSurfaces(), ['settings-pane', 'customizations-page', 'automation-page', 'workspace', 'viewport']);

  // customizations-page (priority 80) beats workspace (priority 50), while hidden/addon settings are ignored
  const active = sg.getActiveSurface();
  assert.equal(Object.isFrozen(active), true);
  assert.equal(active.surfaceId, 'customizations-page');
  assert.equal(active.matched, true);
  assert.equal(active.source, 'selector');
  assert.equal(active.left, 260);
  assert.equal(active.top, 36);
  assert.equal(active.width, 1180);
  assert.equal(active.height, 836);
  assert.equal(active.centerX, 850);
  assert.equal(active.centerY, 454);
  assert.equal(active.insetLeft, 260);
  assert.equal(active.insetTop, 36);
  assert.equal(active.insetRight, 0);
  assert.equal(active.insetBottom, 28);

  // When a real visible settings modal opens, priority 100 takes over
  const visibleSettings = makeEl('div', { left: 220, top: 100, right: 1220, bottom: 800, width: 1000, height: 700 });
  selectorMatches['.settings-modal-container'] = [visibleSettings];
  const nextActive = sg.getActiveSurface();
  assert.equal(nextActive.surfaceId, 'settings-pane');
  assert.equal(nextActive.centerX, 720);
  assert.equal(nextActive.centerY, 450);
});

test('TC-SG-004: Chrome subtraction computes exact content center when direct selector is absent and ignores top horizontal nav', () => {
  const { doc, win, makeEl, selectorMatches } = makeGeometryMockDom({ viewportWidth: 1440, viewportHeight: 900 });

  const leftSidebar = makeEl('aside', { left: 0, top: 36, right: 260, bottom: 900, width: 260, height: 864 });
  const topNav = makeEl('nav', { left: 0, top: 36, right: 1440, bottom: 80, width: 1440, height: 44 }); // horizontal bar -> must NOT be treated as left sidebar
  const rightOverview = makeEl('div', { left: 1180, top: 36, right: 1440, bottom: 900, width: 260, height: 864 });
  const bottomBar = makeEl('div', { left: 0, top: 872, right: 1440, bottom: 900, width: 1440, height: 28 });

  selectorMatches.aside = [leftSidebar];
  selectorMatches.nav = [topNav];
  selectorMatches['[data-testid="overview-panel"]'] = [rightOverview];
  selectorMatches['[data-testid="status-bar"]'] = [bottomBar];

  const sg = createSurfaceGeometry(doc, win, {
    uiSurfaces: ANTIGRAVITY_HOST_PROFILE.uiSurfaces,
    uiAnchors: ANTIGRAVITY_HOST_PROFILE.uiAnchors,
  });

  const bounds = sg.getSurfaceBounds('customizations-page');
  assert.equal(bounds.surfaceId, 'customizations-page');
  assert.equal(bounds.matched, true);
  assert.equal(bounds.source, 'chrome-subtracted');
  assert.equal(bounds.left, 260);
  assert.equal(bounds.right, 1180);
  assert.equal(bounds.top, 36);
  assert.equal(bounds.bottom, 872);
  assert.equal(bounds.width, 920);
  assert.equal(bounds.height, 836);
  assert.equal(bounds.centerX, 720);
  assert.equal(bounds.centerY, 454);
  assert.equal(bounds.insetLeft, 260);
  assert.equal(bounds.insetRight, 260);
  assert.equal(bounds.insetTop, 36);
  assert.equal(bounds.insetBottom, 28);
});

test('TC-SG-005: Safe viewport fallback handles absent DOM matches and unknown surface IDs safely', () => {
  const { doc, win } = makeGeometryMockDom({ viewportWidth: 1200, viewportHeight: 800 });
  const sg = createSurfaceGeometry(doc, win, {
    uiSurfaces: ANTIGRAVITY_HOST_PROFILE.uiSurfaces,
    uiAnchors: ANTIGRAVITY_HOST_PROFILE.uiAnchors,
  });

  const vp = sg.getSurfaceBounds('viewport');
  assert.equal(vp.surfaceId, 'viewport');
  assert.equal(vp.matched, true);
  assert.equal(vp.source, 'viewport');
  assert.equal(vp.top, 36);
  assert.equal(vp.width, 1200);
  assert.equal(vp.height, 764);
  assert.equal(vp.centerX, 600);
  assert.equal(vp.centerY, 418);

  const unknown = sg.getSurfaceBounds('non-existent-screen');
  assert.equal(unknown.surfaceId, 'viewport');
  assert.equal(unknown.requestedSurfaceId, 'non-existent-screen');
  assert.equal(unknown.matched, false);
  assert.equal(unknown.centerX, 600);
});

test('TC-SG-006: Kernel addonHost exposes getSurfaceBounds/getActiveSurface/listSurfaces and openModal surface alignment + resize sync', () => {
  const { doc, win, makeEl, selectorMatches } = makeGeometryMockDom({ viewportWidth: 1440, viewportHeight: 900 });
  const leftSidebar = makeEl('aside', { left: 0, top: 36, right: 280, bottom: 900, width: 280, height: 864 });
  selectorMatches.aside = [leftSidebar];

  const kernel = createRendererKernel(doc, win);
  const token = 'test-token-surface-geometry-123456';
  const boot = kernel.boot({
    docGenId: 1,
    hostToken: token,
    hostProfileId: 'antigravity-desktop',
    uiAnchors: ANTIGRAVITY_HOST_PROFILE.uiAnchors,
    uiSurfaces: ANTIGRAVITY_HOST_PROFILE.uiSurfaces,
  });
  assert.equal(boot.ok, true);

  const handle = kernel.createPluginHandle(
    {
      pluginId: 'mcp-manager-test',
      version: '3.0.0',
      trustLevel: 'restricted',
      uiSlots: [{ slot: 'modal', slotId: 'mcp.overlay', shadow: false }],
    },
    token
  );

  // 1. Direct query APIs on addonHost
  const bounds = handle.getSurfaceBounds('customizations-page');
  assert.equal(bounds.left, 280);
  assert.equal(bounds.width, 1160);
  assert.equal(bounds.centerX, 860);
  assert.equal(bounds.centerY, 468);
  assert.equal(handle.getActiveSurface().centerX, 860);
  assert.ok(handle.listSurfaces().includes('customizations-page'));

  // 2. openModal({ surface: 'customizations-page' }) aligns dialog insets to surface & tracks resize
  const modal = handle.openModal('mcp.overlay', { surface: 'customizations-page' });
  assert.equal(modal.element.getAttribute('data-addon-host-modal-surface'), 'customizations-page');
  assert.equal(modal.element.style.left, '280px');
  assert.equal(modal.element.style.top, '36px');
  assert.equal(modal.element.style.right, '0px');
  assert.equal(modal.element.style.bottom, '0px');
  assert.equal(modal.element.style.margin, 'auto');
  assert.equal(win.getResizeListenerCount(), 1);

  // Window resize recalculates insets cleanly
  const settingsPanel = makeEl('div', { left: 300, top: 100, right: 1100, bottom: 700, width: 800, height: 600 });
  selectorMatches['.settings-modal-container'] = [settingsPanel];
  win.emitResize(1600, 900);
  assert.equal(modal.element.style.left, '280px');
  assert.equal(modal.element.style.maxWidth, '1296px');

  // On-demand reposition('settings-pane') switches alignment cleanly
  const rep = modal.reposition('settings-pane');
  assert.equal(rep.surfaceId, 'settings-pane');
  assert.equal(modal.element.getAttribute('data-addon-host-modal-surface'), 'settings-pane');
  assert.equal(modal.element.style.left, '300px');
  assert.equal(modal.element.style.right, '500px');
  assert.equal(modal.element.style.top, '100px');
  assert.equal(modal.element.style.bottom, '200px');

  // Closing detaches resize listener cleanly
  modal.close();
  assert.equal(win.getResizeListenerCount(), 0);
  assert.equal(modal.reposition('workspace'), null);

  // 3. Legacy openModal without surface/align keeps original full-viewport centering
  const legacyModal = handle.openModal('mcp.overlay');
  assert.equal(legacyModal.element.getAttribute('data-addon-host-modal-surface'), null);
  assert.equal(legacyModal.element.style.left, '0');
  assert.equal(legacyModal.element.style.right, '0');
  assert.equal(legacyModal.element.style.margin, 'auto');
  legacyModal.close();

  // 4. Disposed handle throws ERR_PLUGIN_HANDLE_DISPOSED
  handle.dispose();
  assert.throws(() => handle.getSurfaceBounds(), /ERR_PLUGIN_HANDLE_DISPOSED/);
  assert.throws(() => handle.getActiveSurface(), /ERR_PLUGIN_HANDLE_DISPOSED/);
  assert.throws(() => handle.listSurfaces(), /ERR_PLUGIN_HANDLE_DISPOSED/);
});

test('TC-SG-007: Real Antigravity 2.0 DOM selectors (sidebar-split / conversation-list-sidebar / layout-status-bar / sidecars-view / conversation-view) and anchorEl container fallback center modals accurately', () => {
  // 1. Real Antigravity 2.0 Customizations page DOM (ZERO legacy customizations-view / aside / nav)
  const { doc, win, makeEl, selectorMatches } = makeGeometryMockDom({ viewportWidth: 1440, viewportHeight: 900 });
  const sidebarSplitPane = makeEl('div', { left: 0, top: 36, right: 260, bottom: 872, width: 260, height: 836 });
  const convoSidebar = makeEl('div', { left: 0, top: 84, right: 260, bottom: 812, width: 260, height: 728 });
  const layoutStatusBar = makeEl('div', { left: 0, top: 872, right: 1440, bottom: 900, width: 1440, height: 28 });

  selectorMatches['[data-testid="sidebar-split"] > :first-child'] = [sidebarSplitPane];
  selectorMatches['[data-testid="conversation-list-sidebar"]'] = [convoSidebar];
  selectorMatches['[data-testid="layout-status-bar"]'] = [layoutStatusBar];

  const kernel = createRendererKernel(doc, win);
  const token = 'test-token-real-dom-v252-123456';
  assert.equal(
    kernel.boot({
      docGenId: 1,
      hostToken: token,
      hostProfileId: 'antigravity-desktop',
      uiAnchors: ANTIGRAVITY_HOST_PROFILE.uiAnchors,
      uiSurfaces: ANTIGRAVITY_HOST_PROFILE.uiSurfaces,
    }).ok,
    true
  );

  const handle = kernel.createPluginHandle(
    {
      pluginId: 'mcp-manager-real-dom',
      version: '3.0.1',
      trustLevel: 'trusted',
      uiSlots: [{ slot: 'modal', slotId: 'mcp.overlay', shadow: false }],
    },
    token
  );

  const bounds = handle.getSurfaceBounds('customizations-page');
  assert.equal(bounds.surfaceId, 'customizations-page');
  assert.equal(bounds.matched, true);
  assert.equal(bounds.source, 'chrome-subtracted');
  assert.equal(bounds.left, 260);
  assert.equal(bounds.top, 36);
  assert.equal(bounds.right, 1440);
  assert.equal(bounds.bottom, 872);
  assert.equal(bounds.width, 1180);
  assert.equal(bounds.height, 836);
  assert.equal(bounds.centerX, 850);
  assert.equal(bounds.centerY, 454);
  assert.equal(bounds.insetLeft, 260);
  assert.equal(bounds.insetBottom, 28);

  const modal = handle.openModal('mcp.overlay', { surface: 'customizations-page' });
  assert.equal(modal.element.getAttribute('data-addon-host-modal-surface'), 'customizations-page');
  assert.equal(modal.element.getAttribute('data-addon-host-modal-surface-source'), 'chrome-subtracted');
  assert.equal(modal.element.getAttribute('data-addon-host-modal-surface-matched'), 'true');
  assert.equal(modal.element.style.left, '260px');
  assert.equal(modal.element.style.bottom, '28px');
  modal.close();

  // 2. Real Antigravity 2.0 Automations (sidecars-view) and Conversation (conversation-view) direct matches
  selectorMatches['[data-testid="sidecars-view"]'] = [
    makeEl('div', { left: 260, top: 36, right: 1440, bottom: 872, width: 1180, height: 836 }),
  ];
  const autoBounds = handle.getSurfaceBounds('automation-page');
  assert.equal(autoBounds.matched, true);
  assert.equal(autoBounds.source, 'selector');
  assert.equal(autoBounds.centerX, 850);

  selectorMatches['[data-testid="conversation-view"]'] = [
    makeEl('div', { left: 260, top: 36, right: 1120, bottom: 872, width: 860, height: 836 }),
  ];
  const wsBounds = handle.getSurfaceBounds('workspace');
  assert.equal(wsBounds.matched, true);
  assert.equal(wsBounds.source, 'selector');
  assert.equal(wsBounds.centerX, 690);

  // 3. Collapsed left sidebar (width: 0) must NOT falsely offset left
  const collapsedDom = makeGeometryMockDom({ viewportWidth: 1440, viewportHeight: 900 });
  collapsedDom.selectorMatches['[data-testid="sidebar-split"] > :first-child'] = [
    collapsedDom.makeEl('div', { left: 0, top: 36, right: 0, bottom: 872, width: 0, height: 836 }),
  ];
  collapsedDom.selectorMatches['[data-testid="layout-status-bar"]'] = [
    collapsedDom.makeEl('div', { left: 0, top: 872, right: 1440, bottom: 900, width: 1440, height: 28 }),
  ];
  const collapsedSg = createSurfaceGeometry(collapsedDom.doc, collapsedDom.win, {
    uiSurfaces: ANTIGRAVITY_REMOTE_WEB_PROFILE.uiSurfaces,
    uiAnchors: ANTIGRAVITY_REMOTE_WEB_PROFILE.uiAnchors,
  });
  const collapsedBounds = collapsedSg.getSurfaceBounds('customizations-page');
  assert.equal(collapsedBounds.matched, true);
  assert.equal(collapsedBounds.source, 'chrome-subtracted');
  assert.equal(collapsedBounds.left, 0);
  assert.equal(collapsedBounds.centerX, 720);
  assert.equal(collapsedBounds.insetBottom, 28);

  // 4. Vendor-neutral anchorEl container fallback when ZERO profile selectors match (resilient to future DOM renames)
  const renamedDom = makeGeometryMockDom({ viewportWidth: 1440, viewportHeight: 900 });
  const rootWrapper = renamedDom.makeEl('div', { left: 0, top: 0, right: 1440, bottom: 900, width: 1440, height: 900 });
  const contentPane = renamedDom.makeEl('div', { left: 280, top: 36, right: 1440, bottom: 872, width: 1160, height: 836 });
  const innerCard = renamedDom.makeEl('div', { left: 420, top: 200, right: 820, bottom: 260, width: 400, height: 60 });
  const triggerBtn = renamedDom.makeEl('button', { left: 440, top: 210, right: 560, bottom: 242, width: 120, height: 32 });
  renamedDom.doc.body.appendChild(rootWrapper);
  rootWrapper.appendChild(contentPane);
  contentPane.appendChild(innerCard);
  innerCard.appendChild(triggerBtn);

  const renamedKernel = createRendererKernel(renamedDom.doc, renamedDom.win);
  assert.equal(
    renamedKernel.boot({
      docGenId: 1,
      hostToken: token,
      hostProfileId: 'antigravity-desktop',
      uiAnchors: ANTIGRAVITY_HOST_PROFILE.uiAnchors,
      uiSurfaces: ANTIGRAVITY_HOST_PROFILE.uiSurfaces,
    }).ok,
    true
  );
  const renamedHandle = renamedKernel.createPluginHandle(
    {
      pluginId: 'mcp-manager-anchor-fallback',
      version: '3.0.1',
      trustLevel: 'trusted',
      uiSlots: [{ slot: 'modal', slotId: 'mcp.overlay', shadow: false }],
    },
    token
  );

  // Without anchorEl -> viewport fallback
  const noAnchorBounds = renamedHandle.getSurfaceBounds('customizations-page');
  assert.equal(noAnchorBounds.matched, false);
  assert.equal(noAnchorBounds.source, 'viewport');

  // With anchorEl -> picks right-hand contentPane (ignoring full-viewport rootWrapper and tiny innerCard)
  const anchorModal = renamedHandle.openModal('mcp.overlay', {
    surface: 'customizations-page',
    anchorEl: triggerBtn,
  });
  assert.equal(anchorModal.element.getAttribute('data-addon-host-modal-surface'), 'customizations-page');
  assert.equal(anchorModal.element.getAttribute('data-addon-host-modal-surface-source'), 'anchor-container');
  assert.equal(anchorModal.element.getAttribute('data-addon-host-modal-surface-matched'), 'true');
  assert.equal(anchorModal.element.style.left, '280px');
  assert.equal(anchorModal.element.style.bottom, '28px');
  anchorModal.close();

  handle.dispose();
  renamedHandle.dispose();
});
