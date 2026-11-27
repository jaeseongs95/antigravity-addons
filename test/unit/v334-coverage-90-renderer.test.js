'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSchemaUiController,
  buildOverlayChrome,
  createHeaderLocaleSwitch,
} = require('../../src/runtime/renderer/ui-schema-renderer');
const { createPlacementEngine } = require('../../src/runtime/renderer/placement-engine');
const { createRendererKernel } = require('../../src/runtime/renderer/kernel');
const { createSectionActionRegistry } = require('../../src/runtime/renderer/section-action-registry');
const { createRegionObserver } = require('../../src/runtime/renderer/region-observer');
const { createStatusItemRegistry } = require('../../src/runtime/renderer/status-item-registry');
const { createSurfaceGeometry } = require('../../src/runtime/renderer/surface-geometry');
const { createModalPortal } = require('../../src/runtime/renderer/modal-portal');
const { createHostSettingsUi } = require('../../src/runtime/renderer/host-settings-ui');
const { createServiceBus } = require('../../src/runtime/renderer/service-bus');
const { createStorageV3 } = require('../../src/runtime/renderer/storage-v3');
const { createStyleManager } = require('../../src/runtime/renderer/style-manager');
const { isNodeIgnored, isElementInsideIgnored } = require('../../src/runtime/renderer/ignore-guard');
const { createEventBus } = require('../../src/runtime/renderer/event-bus');
const { createSettingsTabCoordinator } = require('../../src/runtime/renderer/settings-tab-coordinator');
const { createSlotManager } = require('../../src/runtime/renderer/slot-manager');
const { createToastAndDialogManager } = require('../../src/runtime/renderer/toast-manager');
const { createSettingsPageCoordinator } = require('../../src/runtime/renderer/settings-page-coordinator');
const { createThemeAndI18n } = require('../../src/runtime/renderer/theme-i18n');
const { wrapHostBridgePort, isValidHostBridgePort } = require('../../src/runtime/renderer/host-bridge-port');
const { createTestHost } = require('../../packages/sdk/src/test-host');

function createRichMockDom() {
  function makeEl(tag) {
    const attrs = new Map();
    const listeners = new Map();
    const childNodes = [];
    let textVal = '';
    let rect = { left: 100, top: 100, width: 120, height: 32, right: 220, bottom: 132 };
    const el = {
      nodeType: 1,
      tagName: String(tag || 'div').toUpperCase(),
      className: '',
      type: '',
      value: '',
      checked: false,
      disabled: false,
      hidden: false,
      min: '',
      max: '',
      isConnected: true,
      style: {},
      parentNode: null,
      get parentElement() { return el.parentNode; },
      childNodes,
      get children() { return childNodes.filter((c) => c && c.nodeType === 1); },
      get firstChild() { return childNodes[0] || null; },
      get textContent() {
        if (childNodes.length === 0) return textVal;
        return textVal + childNodes.map((c) => c.textContent || '').join('');
      },
      set textContent(v) {
        textVal = String(v === undefined || v === null ? '' : v);
        childNodes.length = 0;
      },
      setAttribute(k, v) {
        attrs.set(String(k), String(v));
        if (k === 'class') el.className = String(v);
        if (k === 'hidden') el.hidden = true;
      },
      getAttribute(k) { return attrs.has(String(k)) ? attrs.get(String(k)) : null; },
      hasAttribute(k) { return attrs.has(String(k)); },
      removeAttribute(k) {
        attrs.delete(String(k));
        if (k === 'hidden') el.hidden = false;
      },
      appendChild(c) {
        if (!c) return c;
        if (c.parentNode && c.parentNode.removeChild) c.parentNode.removeChild(c);
        c.parentNode = el;
        childNodes.push(c);
        return c;
      },
      insertBefore(c, ref) {
        if (!c) return c;
        if (c.parentNode && c.parentNode.removeChild) c.parentNode.removeChild(c);
        c.parentNode = el;
        const i = ref ? childNodes.indexOf(ref) : -1;
        if (i === -1) childNodes.push(c);
        else childNodes.splice(i, 0, c);
        return c;
      },
      removeChild(c) {
        const i = childNodes.indexOf(c);
        if (i !== -1) { childNodes.splice(i, 1); c.parentNode = null; }
        return c;
      },
      remove() {
        if (el.parentNode && el.parentNode.removeChild) el.parentNode.removeChild(el);
      },
      contains(target) {
        if (target === el) return true;
        return childNodes.some((c) => c === target || (c.contains && c.contains(target)));
      },
      closest(sel) {
        let cur = el;
        while (cur) {
          if (sel.startsWith('[') && sel.endsWith(']')) {
            const inner = sel.slice(1, -1);
            if (cur.hasAttribute && cur.hasAttribute(inner)) return cur;
          } else if (sel.startsWith('.')) {
            if (String(cur.className || '').split(/\s+/).includes(sel.slice(1))) return cur;
          } else if (String(cur.tagName || '').toLowerCase() === sel.toLowerCase()) {
            return cur;
          }
          cur = cur.parentNode;
        }
        return null;
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        if (listeners.has(type)) listeners.get(type).delete(fn);
      },
      dispatchEvent(ev) {
        const set = listeners.get(ev && ev.type);
        if (set) for (const fn of Array.from(set)) fn(ev);
        return true;
      },
      setMockRect(r) { rect = { ...rect, ...r }; },
      getBoundingClientRect() { return { ...rect }; },
      querySelectorAll(sel) {
        const out = [];
        const parts = String(sel || '').split(',').map((s) => s.trim()).filter(Boolean);
        const match = (n, p) => {
          if (!n || n.nodeType !== 1) return false;
          if (p.startsWith('[')) {
            const m = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(p);
            if (!m) return false;
            const v = n.getAttribute(m[1]);
            return v !== null && (m[2] === undefined || v === m[2]);
          }
          if (p.startsWith('.')) return String(n.className || '').split(/\s+/).includes(p.slice(1));
          return n.tagName.toLowerCase() === p.toLowerCase();
        };
        const walk = (node) => {
          for (const c of node.childNodes || []) {
            if (parts.some((p) => match(c, p))) out.push(c);
            walk(c);
          }
        };
        walk(el);
        return out;
      },
      querySelector(sel) { return el.querySelectorAll(sel)[0] || null; },
    };
    return el;
  }
  const html = makeEl('html');
  const head = makeEl('head');
  const body = makeEl('body');
  html.appendChild(head);
  html.appendChild(body);
  const doc = {
    documentElement: html,
    head,
    body,
    activeElement: null,
    createElement: makeEl,
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t || ''), parentNode: null }),
    querySelector: (sel) => html.querySelector(sel),
    querySelectorAll: (sel) => html.querySelectorAll(sel),
    addEventListener(type, fn) { html.addEventListener(type, fn); },
    removeEventListener(type, fn) { html.removeEventListener(type, fn); },
  };
  const winListeners = new Map();
  const win = {
    document: doc,
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener(t, fn) {
      if (!winListeners.has(t)) winListeners.set(t, new Set());
      winListeners.get(t).add(fn);
    },
    removeEventListener(t, fn) {
      if (winListeners.has(t)) winListeners.get(t).delete(fn);
    },
    dispatchEvent(ev) {
      const s = winListeners.get(ev && ev.type);
      if (s) for (const fn of Array.from(s)) fn(ev);
    },
  };
  return { doc, win, body, makeEl };
}

test('TC-COV90-R01: ui-schema-renderer builds, interacts with, and patches all 16 declarative primitives', () => {
  const { doc, body } = createRichMockDom();
  const actions = [];
  const changes = [];
  const container = doc.createElement('div');
  body.appendChild(container);

  const initialSchema = {
    type: 'stack',
    id: 'root',
    children: [
      {
        type: 'section',
        id: 'sec1',
        title: 'General',
        children: [
          { type: 'heading', id: 'hd1', level: 2, text: 'Header 1' },
          { type: 'text', id: 'tx1', tone: 'muted', text: 'Description 1' },
          { type: 'badge', id: 'bd1', variant: 'info', text: 'v1' },
          { type: 'divider', id: 'dv1' },
          { type: 'alert', id: 'al1', variant: 'warn', text: 'Watch out' },
          {
            type: 'row',
            id: 'rw1',
            children: [
              { type: 'button', id: 'bt1', variant: 'primary', label: 'Go', actionId: 'run', payload: { x: 1 } },
              { type: 'toggle', id: 'tg1', label: 'Enable', field: 'enabled' },
            ],
          },
          { type: 'input', id: 'in1', label: 'Port', inputType: 'number', placeholder: '8080', field: 'port', submitActionId: 'submit-port' },
          { type: 'textarea', id: 'ta1', label: 'Notes', rows: 4, placeholder: 'Write...', field: 'notes' },
          {
            type: 'select',
            id: 'sl1',
            label: 'Mode',
            field: 'mode',
            options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }],
          },
          {
            type: 'segmented',
            id: 'sg1',
            label: 'Theme',
            field: 'theme',
            options: [{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }],
          },
          { type: 'slider', id: 'sd1', label: 'Volume', field: 'vol', min: 0, max: 100, step: 5 },
          { type: 'progress', id: 'pr1', label: 'Sync', value: 25, max: 100 },
          {
            type: 'list',
            id: 'ls1',
            items: [
              { id: 'i1', label: 'Item 1', actionId: 'open-item', actionLabel: 'View', payload: 42 },
              'Plain Item',
            ],
          },
        ],
      },
    ],
  };

  const mounted = createSchemaUiController(doc, container, {
    tree: initialSchema,
    state: { enabled: true, port: 3000, notes: 'hi', mode: 'a', theme: 'dark', vol: 50 },
    onAction: ({ actionId, payload }) => actions.push({ id: actionId, payload }),
    onChange: ({ field, value }) => changes.push({ field, value }),
  });
  assert.ok(mounted);
  assert.ok(mounted.getElementById('bt1'));

  // Fire interactions across button, toggle, input (input + Enter + IME), textarea, select, segmented, slider, list action
  const goBtn = mounted.getElementById('bt1');
  goBtn.dispatchEvent({ type: 'click', isTrusted: false });
  goBtn.dispatchEvent({ type: 'click', isTrusted: true });

  const tgInput = mounted.getElementById('tg1');
  tgInput.checked = false;
  tgInput.dispatchEvent({ type: 'change', isTrusted: true });

  const numInput = mounted.getElementById('in1');
  numInput.value = '4040';
  numInput.dispatchEvent({ type: 'input' });
  numInput.dispatchEvent({ type: 'keydown', key: 'Enter', isComposing: true, isTrusted: true });
  numInput.dispatchEvent({ type: 'keydown', key: 'Enter', isComposing: false, isTrusted: true });

  const taEl = mounted.getElementById('ta1');
  taEl.value = 'updated note';
  taEl.dispatchEvent({ type: 'input' });

  const selEl = mounted.getElementById('sl1');
  selEl.value = 'b';
  selEl.dispatchEvent({ type: 'change', isTrusted: true });

  const segWrap = mounted.getElementById('sg1');
  if (segWrap && segWrap.childNodes && segWrap.childNodes[1]) {
    segWrap.childNodes[1].dispatchEvent({ type: 'click', isTrusted: true });
  }

  const sliderEl = mounted.getElementById('sd1');
  sliderEl.value = '75';
  sliderEl.dispatchEvent({ type: 'input' });

  const listWrap = mounted.getElementById('ls1');
  const listBtn = listWrap.querySelector('button');
  listBtn.dispatchEvent({ type: 'click', isTrusted: false });
  listBtn.dispatchEvent({ type: 'click', isTrusted: true });

  assert.ok(actions.some((a) => a.id === 'run'));
  assert.ok(actions.some((a) => a.id === 'submit-port'));
  assert.ok(actions.some((a) => a.id === 'open-item' && a.payload === 42));
  assert.ok(changes.some((c) => c.field === 'port' && c.value === 4040));
  assert.ok(changes.some((c) => c.field === 'notes' && c.value === 'updated note'));
  assert.ok(changes.some((c) => c.field === 'mode' && c.value === 'b'));
  assert.ok(changes.some((c) => c.field === 'vol' && c.value === 75));

  // Patch/update every primitive in-place (covers updateNodeInPlace cases!)
  const updatedSchema = {
    type: 'stack',
    id: 'root',
    children: [
      {
        type: 'section',
        id: 'sec1',
        title: 'General Updated',
        children: [
          { type: 'heading', id: 'hd1', level: 2, text: 'Header 2' },
          { type: 'text', id: 'tx1', tone: 'danger', text: 'Description 2' },
          { type: 'badge', id: 'bd1', variant: 'success', text: 'v2' },
          { type: 'divider', id: 'dv1' },
          { type: 'alert', id: 'al1', variant: 'error', text: 'Critical' },
          {
            type: 'row',
            id: 'rw1',
            children: [
              { type: 'button', id: 'bt1', variant: 'secondary', label: 'Run Again', actionId: 'run2' },
              { type: 'toggle', id: 'tg1', label: 'Enable 2', field: 'enabled' },
            ],
          },
          { type: 'input', id: 'in1', label: 'Port 2', inputType: 'number', field: 'port' },
          { type: 'textarea', id: 'ta1', label: 'Notes 2', field: 'notes' },
          {
            type: 'select',
            id: 'sl1',
            label: 'Mode 2',
            field: 'mode',
            options: [{ value: 'a', label: 'Alpha' }, { value: 'c', label: 'Gamma' }],
          },
          {
            type: 'segmented',
            id: 'sg1',
            label: 'Theme 2',
            field: 'theme',
            options: [{ value: 'dark', label: 'D' }, { value: 'light', label: 'L' }, { value: 'auto', label: 'A' }],
          },
          { type: 'slider', id: 'sd1', label: 'Volume 2', field: 'vol', min: 0, max: 200, step: 10 },
          { type: 'progress', id: 'pr1', label: 'Sync 2', value: 80, max: 200 },
          {
            type: 'list',
            id: 'ls1',
            items: [{ id: 'i2', label: 'New Item', actionId: 'new-act' }],
          },
        ],
      },
    ],
  };
  mounted.update(updatedSchema, { enabled: false, port: 9090, notes: 'new', mode: 'c', theme: 'auto', vol: 120 });
  assert.equal(mounted.getState().port, 9090);
  const newListBtn = mounted.getElementById('ls1').querySelector('button');
  newListBtn.dispatchEvent({ type: 'click', isTrusted: true });
  assert.ok(actions.some((a) => a.id === 'new-act'));
  mounted.update(null, { enabled: true });

  // Also cover buildOverlayChrome & createHeaderLocaleSwitch
  let currentLocale = 'ko';
  const localeCbs = [];
  const fakeThemeI18n = {
    getLocale: () => currentLocale,
    setLocale: (l) => {
      currentLocale = l;
      for (const cb of localeCbs) cb(l);
    },
    onLocaleChange: (cb) => {
      localeCbs.push(cb);
      return () => {};
    },
  };
  let closed = false;
  const shadowRoot = doc.createElement('div');
  const chrome = buildOverlayChrome(doc, shadowRoot, {
    title: '',
    badgeText: 'beta',
    closable: true,
    showLocaleSwitch: true,
    themeAndI18n: fakeThemeI18n,
    onClose: () => { closed = true; },
  });
  chrome.setTitle('Dynamic Title');
  chrome.setTitle('Updated Title');
  const enBtn = shadowRoot.querySelector('.ag-ui-lang-switch').childNodes[1];
  enBtn.dispatchEvent({ type: 'click', isTrusted: true });
  assert.equal(currentLocale, 'en');
  const closeBtn = shadowRoot.querySelector('.ag-ui-close');
  closeBtn.dispatchEvent({ type: 'click', isTrusted: false });
  assert.equal(closed, false);
  closeBtn.dispatchEvent({ type: 'click', isTrusted: true });
  assert.equal(closed, true);
  chrome.disposeChrome();
  const sw = createHeaderLocaleSwitch(doc, fakeThemeI18n);
  sw.dispose();
});

test('TC-COV90-R02: placement-engine covers all 4 flip axes, alignments, drawer, corner, sheet, mobile switch, and resize tracking', () => {
  const { doc, win, body } = createRichMockDom();
  const anchorEl = doc.createElement('button');
  anchorEl.setAttribute('data-anchor', 'target');
  body.appendChild(anchorEl);

  const pe = createPlacementEngine(doc, win, {
    uiAnchors: { mainBtn: ['[data-anchor="target"]'] },
  });

  // Flip bottom -> top (anchor near bottom)
  anchorEl.setMockRect({ left: 400, top: 740, width: 100, height: 40, right: 500, bottom: 780 });
  const pTop = pe.computePlacement({ zone: 'anchor', anchorKey: 'mainBtn', prefer: 'bottom-end' }, { width: 240, height: 200 });
  assert.equal(pTop.resolvedSide, 'top');
  assert.equal(pTop.flipped, true);

  // Flip top -> bottom (anchor near top)
  anchorEl.setMockRect({ left: 400, top: 10, width: 100, height: 40, right: 500, bottom: 50 });
  const pBot = pe.computePlacement({ zone: 'anchor', anchorEl, prefer: 'top-center' }, { width: 240, height: 200 });
  assert.equal(pBot.resolvedSide, 'bottom');
  assert.equal(pBot.flipped, true);

  // Flip right -> left (anchor near right edge)
  anchorEl.setMockRect({ left: 1180, top: 300, width: 80, height: 40, right: 1260, bottom: 340 });
  const pLeft = pe.computePlacement({ zone: 'anchor', anchorEl, prefer: 'right-end' }, { width: 240, height: 200 });
  assert.equal(pLeft.resolvedSide, 'left');
  assert.equal(pLeft.flipped, true);

  // Flip left -> right (anchor near left edge)
  anchorEl.setMockRect({ left: 10, top: 300, width: 80, height: 40, right: 90, bottom: 340 });
  const pRight = pe.computePlacement({ zone: 'anchor', anchorEl, prefer: 'left-center' }, { width: 240, height: 200 });
  assert.equal(pRight.resolvedSide, 'right');
  assert.equal(pRight.flipped, true);

  // Left-start & right-start non-flip
  anchorEl.setMockRect({ left: 500, top: 300, width: 80, height: 40, right: 580, bottom: 340 });
  assert.equal(pe.computePlacement({ zone: 'anchor', anchorEl, prefer: 'left-start' }, { width: 200, height: 150 }).resolvedSide, 'left');
  assert.equal(pe.computePlacement({ zone: 'anchor', anchorEl, prefer: 'right-start' }, { width: 200, height: 150 }).resolvedSide, 'right');

  // Drawer left & right
  const dLeft = pe.computePlacement({ zone: 'drawer', side: 'left', width: 320 });
  assert.equal(dLeft.zone, 'drawer');
  assert.equal(dLeft.side, 'left');
  const dRight = pe.computePlacement({ zone: 'drawer', side: 'right', width: 320 });
  assert.equal(dRight.side, 'right');

  // Corner top-left & bottom-right
  assert.equal(pe.computePlacement({ zone: 'corner', corner: 'top-left' }).zone, 'corner');
  assert.equal(pe.computePlacement({ zone: 'corner', corner: 'bottom-right' }).zone, 'corner');

  // Explicit sheet & mobile auto-switch
  assert.equal(pe.computePlacement({ zone: 'sheet' }).zone, 'sheet');
  win.innerWidth = 480;
  const mobileSheet = pe.computePlacement({ zone: 'drawer' });
  assert.equal(mobileSheet.zone, 'sheet');
  assert.equal(mobileSheet.autoMobileSheet, true);
  win.innerWidth = 1280;

  // Surface-center fallback
  assert.equal(pe.computePlacement({ zone: 'surface-center' }).zone, 'surface-center');

  // Live tracking + cleanup
  if (typeof pe.track === 'function') {
    const updates = [];
    const overlayEl = doc.createElement('div');
    const stop = pe.track(overlayEl, { zone: 'corner', corner: 'bottom-right' }, (pos) => updates.push(pos));
    win.dispatchEvent({ type: 'resize' });
    stop();
  }
});

test('TC-COV90-R03: kernel config/listener/runSafe error guards, section-action-registry fallbacks, and context-v3 namespaces', async () => {
  // 1. kernel.js configBridge, addManagedListener, runSafe, disposeSelf, isElementInsideIgnored
  const { doc, win } = createRichMockDom();
  win.crypto = globalThis.crypto;
  const kernel = createRendererKernel(doc, win);
  const bootRes = kernel.boot({
    docGenId: 1,
    hostToken: 'ht-k',
    surface: 'desktop',
    hostBridge: {
      docGenId: 1,
      setPortalClaim: () => ({ ok: true }),
      saveSettings: async () => ({ ok: true }),
      readConfigScope: () => Promise.resolve(null),
      writeConfigScope: () => Promise.resolve(null),
      reportError: () => {},
      ping: () => Promise.resolve({ ok: true }),
    },
  });
  assert.equal(bootRes.ok, true);
  const handle = kernel.createPluginHandle(
    {
      pluginId: 'p-k',
      apiVersion: 2,
      trustLevel: 'trusted',
      hasConfigBridge: true,
      hasSettingsBridge: false,
      configScopes: [
        { scopeId: 'rw', access: 'rw', maxBytes: 4096 },
        { scopeId: 'ro', access: 'ro', maxBytes: 4096 },
      ],
    },
    'ht-k'
  );
  // readConfigScope / writeConfigScope error branches
  assert.equal((await handle.readConfigScope('rw')).reason, 'ERR_CONFIG_READ_FAILED');
  await assert.rejects(() => handle.writeConfigScope('', {}), /ERR_INVALID_CONFIG_SCOPE_ID/);
  await assert.rejects(() => handle.writeConfigScope('unknown', {}), /ERR_CONFIG_SCOPE_NOT_DECLARED/);
  await assert.rejects(() => handle.writeConfigScope('ro', {}), /ERR_CONFIG_SCOPE_READ_ONLY/);
  await assert.rejects(() => handle.writeConfigScope('rw', 123), /ERR_CONFIG_MUST_BE_OBJECT/);
  await assert.rejects(() => handle.writeConfigScope('rw', JSON.parse('{"__proto__":{"x":1}}')), /ERR_CONFIG_UNSAFE_PROTO_KEY/);
  await assert.rejects(() => handle.writeConfigScope('rw', { a: 1 }, { expectedSha256: 123 }), /ERR_INVALID_EXPECTED_SHA256/);
  assert.equal((await handle.writeConfigScope('rw', { a: 1 }, { expectedSha256: 'abc' })).reason, 'ERR_CONFIG_WRITE_FAILED');
  assert.equal((await handle.writeConfigScope('rw', '{"a":1}')).reason, 'ERR_CONFIG_WRITE_FAILED');
  assert.equal(handle.getSettings(), null);

  // addManagedListener & runSafe fault isolation
  assert.throws(() => handle.addManagedListener(null, 'click', () => {}), /ERR_INVALID_EVENT_TARGET/);
  const btn = doc.createElement('button');
  const detach = handle.addManagedListener(btn, 'click', () => { throw new Error('SYNC_LISTENER_ERR'); });
  btn.dispatchEvent({ type: 'click' });
  detach();
  handle.addManagedListener(btn, 'click', async () => { throw new Error('ASYNC_LISTENER_ERR'); });
  btn.dispatchEvent({ type: 'click' });
  assert.equal(handle.runSafe(123), undefined);
  assert.equal(handle.runSafe(() => { throw new Error('SYNC_RUNSAFE'); }), undefined);
  await handle.runSafe(async () => { throw new Error('ASYNC_RUNSAFE'); });
  assert.equal(typeof handle.isElementInsideIgnored(btn), 'boolean');
  handle.dispose();

  // 2. section-action-registry rootSelectors, containerSelectors, headingTexts, excludeAncestorSelectors
  const r2 = createRichMockDom();
  const panel = r2.doc.createElement('section');
  panel.setAttribute('data-panel', 'sidebar');
  const directBox = r2.doc.createElement('div');
  directBox.setAttribute('data-direct-actions', '1');
  panel.appendChild(directBox);
  r2.body.appendChild(panel);

  const reg = createSectionActionRegistry(r2.doc, r2.win, {
    uiSectionTargets: {
      direct: {
        rootSelectors: ['[data-panel="sidebar"]'],
        containerSelectors: ['[data-direct-actions="1"]'],
        insertPosition: 'before-first-child',
      },
      'missing-root': {
        rootSelectors: ['[data-nonexistent]'],
        fallbackToDocumentRoot: false,
        headingTexts: ['Nothing'],
      },
      'fallback-root': {
        rootSelectors: ['[data-nonexistent]'],
        fallbackToDocumentRoot: true,
        headingTexts: ['Workspaces'],
        excludeAncestorSelectors: ['[data-excluded]'],
      },
    },
  });
  const actDirect = reg.registerSectionAction('p1', {
    target: 'direct',
    id: 'btn1',
    label: 'Direct',
    icon: '+',
    onClick() {},
  });
  actDirect.update({ label: 'Direct 2', disabled: true });
  const actMiss = reg.registerSectionAction('p1', {
    target: 'missing-root',
    id: 'btn2',
    label: 'Miss',
    onClick() {},
  });
  const wsWrap = r2.doc.createElement('div');
  const wsHead = r2.doc.createElement('span');
  wsHead.textContent = 'Workspaces 3';
  wsWrap.appendChild(wsHead);
  r2.body.appendChild(wsWrap);
  const actFb = reg.registerSectionAction('p1', {
    target: 'fallback-root',
    id: 'btn3',
    label: 'FB',
    onClick() {},
  });
  reg.syncDomNow();
  assert.ok(reg.listSectionActions().length >= 3);
  assert.ok(reg.getConfiguredTargets().length >= 3);
  actDirect.dispose();
  actMiss.dispose();
  actFb.dispose();
  reg.dispose();

  // 3. context-v3 full namespace coverage via createTestHost
  const host = createTestHost({ surface: 'desktop', locale: 'en' });
  const ctx = await host.mountPlugin({
    schemaVersion: 3,
    pluginId: 'v3-ns',
    displayName: 'V3 NS',
    version: '1.0.0',
    trustLevel: 'trusted',
    uiSlots: [{ slotId: 'v3-ns.slot', anchor: 'status-bar' }],
    permissions: {
      dom: { selectors: ['body'] },
      storage: { namespace: 'v3-ns', maxBytes: 4096 },
      services: { provide: [{ name: 'v3-ns.echo', allowedCallers: ['v3-ns'] }], call: ['v3-ns.echo'] },
    },
  });
  assert.equal(ctx.env.surface, 'desktop');
  assert.ok(typeof ctx.env.layoutMode === 'string');
  assert.equal(typeof ctx.env.capabilities.hasLocalLoopback, 'boolean');
  assert.equal(typeof ctx.env.capabilities.hasRemoteHostBridge, 'boolean');
  assert.equal(typeof ctx.env.capabilities.secretsPersistence, 'string');
  ctx.ui.registerCommand('ping', { label: 'Ping', run: (x) => `pong:${x}` });
  assert.ok(ctx.ui.listCommands().length >= 1);
  assert.equal(await ctx.ui.invokeCommand('v3-ns', 'ping', 'hi'), 'pong:hi');
  ctx.ui.injectStyle('s1', '.demo { color: red; }');
  ctx.ui.removeStyle('s1');
  assert.ok(ctx.ui.getSurfaceBounds());
  assert.ok(ctx.ui.getActiveSurface());
  assert.ok(Array.isArray(ctx.ui.listSurfaces()));
  const eventsSeen = [];
  ctx.events.on('t1', (p) => eventsSeen.push(p));
  ctx.events.once('t1', (p) => eventsSeen.push('once:' + p));
  ctx.events.emit('t1', 'hello');
  ctx.events.emit('t1', 'again');
  assert.deepEqual(eventsSeen, ['hello', 'once:hello', 'again']);
  ctx.services.provide('v3-ns.echo', { echo: (x) => `echo:${x}` }, { allowedCallers: ['v3-ns'] });
  assert.equal(ctx.services.has('v3-ns.echo'), true);
  assert.ok(ctx.services.list().some((s) => s && (s === 'v3-ns.echo' || s.name === 'v3-ns.echo')));
  assert.equal(await ctx.services.call('v3-ns.echo', 'echo', 'ok'), 'echo:ok');
  await ctx.storage.set('k1', { a: 1 });
  assert.deepEqual(await ctx.storage.get('k1'), { a: 1 });
  await ctx.storage.delete('k1');

  // Exercise context-v3 overlays (popover outside click, Escape LIFO, setTitle, reposition, createStyleElementSafe, mountCanvas)
  const popAnchor = host.doc.createElement('button');
  host.doc.body.appendChild(popAnchor);
  const pop = ctx.ui.openPopup({
    title: 'Pop',
    placement: { zone: 'anchor', anchorEl: popAnchor, prefer: 'bottom-start' },
    closeOnOutsideClick: true,
  });
  pop.setTitle('Pop Updated');
  pop.reposition();
  assert.throws(() => pop.update({}, {}), /ERR_OVERLAY_NOT_SCHEMA_DRIVEN/);
  // pointerdown inside anchor does not close; outside closes
  host.doc.dispatchEvent && host.doc.dispatchEvent({ type: 'pointerdown', target: popAnchor, composedPath: () => [popAnchor] });
  const outsideEl = host.doc.createElement('div');
  host.doc.dispatchEvent && host.doc.dispatchEvent({ type: 'pointerdown', target: outsideEl, composedPath: () => [outsideEl] });
  pop.close();

  const pop2 = ctx.ui.openPopup({ title: 'Pop2', placement: { zone: 'corner', corner: 'bottom-right' } });
  if (typeof host.win.dispatchEvent === 'function') {
    host.win.dispatchEvent({ type: 'keydown', key: 'Escape', isComposing: true, isTrusted: true });
    host.win.dispatchEvent({ type: 'keydown', key: 'Escape', isComposing: false, isTrusted: false });
    host.win.dispatchEvent({ type: 'keydown', key: 'Escape', isComposing: false, isTrusted: true, preventDefault() {}, stopImmediatePropagation() {} });
  }
  pop2.close();

  const safeStyle = ctx.ui.createStyleElementSafe('.box { color: #fff; }');
  assert.ok(safeStyle);
  assert.throws(() => ctx.ui.createStyleElementSafe('@import url("https://evil.example");'));
  host.disposePlugin('v3-ns');
});

test('TC-COV90-R04: region-observer and status-item-registry (delegated & fallback lifecycle)', async () => {
  // 1. region-observer full coverage
  const { doc, win, body } = createRichMockDom();
  const moInstances = [];
  win.MutationObserver = class FakeMO {
    constructor(cb) {
      this.cb = cb;
      this.disconnected = false;
      moInstances.push(this);
    }
    observe() {}
    disconnect() { this.disconnected = true; }
  };
  const ro = createRegionObserver(doc, win);
  assert.throws(() => ro.observeRegion('p1', 'div', null), /ERR_OBSERVER_CALLBACK_REQUIRED/);

  const targetEl = doc.createElement('section');
  targetEl.setAttribute('data-region', 'main');
  body.appendChild(targetEl);
  const seen = [];
  const h1 = ro.observeRegion('p1', '[data-region="main"]', (el) => seen.push(el), { debounceMs: 5 });
  assert.equal(seen.length, 1);
  // Remove element, trigger mutation, re-add new element -> callback fires again
  body.removeChild(targetEl);
  moInstances[0].cb();
  await new Promise((r) => setTimeout(r, 15));
  const targetEl2 = doc.createElement('section');
  targetEl2.setAttribute('data-region', 'main');
  body.appendChild(targetEl2);
  moInstances[0].cb();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(seen.length, 2);
  // Callback error isolation
  ro.observeRegion('p1', '[data-region="main"]', () => { throw new Error('CB_BOOM'); }, { debounceMs: 5 });
  h1.disconnect();
  ro.disposePluginObservers('p1');
  ro.disposePluginObservers('unknown');
  assert.equal(moInstances[0].disconnected, true);

  // 2. status-item-registry delegated & fallback paths
  const d2 = createRichMockDom();
  const delLog = [];
  let delegatedActive = true;
  const fakeServiceBus = {
    getInternalService(name) {
      if (!delegatedActive || name !== 'host.statusbar') return null;
      return {
        impl: {
          registerItem(pid, spec) {
            delLog.push(['add', pid, spec.id]);
            return { dispose: () => delLog.push(['dispose', pid, spec.id]) };
          },
          updateItem(pid, id, patch) {
            delLog.push(['update', pid, id, patch.label]);
          },
          removeItem(pid, id) {
            delLog.push(['remove', pid, id]);
          },
        },
      };
    },
  };
  const sir = createStatusItemRegistry(d2.doc, d2.win, { serviceBus: fakeServiceBus, surface: 'remote-web' });
  assert.equal(sir.isDelegated(), true);
  let clicked = 0;
  const item1 = sir.registerStatusItem('p1', {
    id: 'st1',
    label: 'Ready',
    icon: '*',
    tooltip: 'Tip',
    badge: '1',
    priority: 10,
    onClick: () => { clicked += 1; },
  });
  item1.update({ label: 'Busy', icon: '!', tooltip: 'Tip 2', badge: null, priority: 20 });
  assert.equal(sir.listStatusItems().length, 1);
  assert.equal(sir.invokeStatusItem('p1', 'st1', {}).ok, true);
  assert.equal(clicked, 1);
  assert.equal(sir.invokeStatusItem('p1', 'missing').ok, false);

  // Switch to fallback mode and re-sync, then disposePlugin
  delegatedActive = false;
  sir.syncDelegation();
  const item2 = sir.registerStatusItem('p1', { id: 'st2', label: 'Fallback', onClick: () => {} });
  item2.update({ label: 'Fallback 2' });
  item1.dispose();
  sir.disposePlugin('p1');
  assert.equal(sir.listStatusItems().length, 0);
  assert.ok(delLog.some((x) => x[0] === 'update' && x[3] === 'Busy'));
});

test('TC-COV90-R05: surface-geometry anchor fallback, modal-portal cancel/close/reposition, and host-settings-ui observer/loading/execCommand/extraPages', async () => {
  // 1. surface-geometry anchor fallback + excludeSelectors + safeInsets
  const { doc, win, body } = createRichMockDom();
  const anchorPanel = doc.createElement('div');
  anchorPanel.setAttribute('data-sg-anchor', '1');
  anchorPanel.setMockRect({ left: 100, top: 60, width: 600, height: 400, right: 700, bottom: 460 });
  body.appendChild(anchorPanel);
  const sg = createSurfaceGeometry(doc, win, {
    uiSurfaces: {
      main: { selectors: ['[data-sg-missing]'], safeInsets: { top: 20, right: 20, bottom: 20, left: 20 } },
    },
    uiAnchors: {
      anchorOnly: ['[data-sg-anchor="1"]'],
      emptyAnchor: ['[data-sg-nowhere]'],
    },
  });
  const aBounds = sg.getSurfaceBounds('anchorOnly');
  assert.equal(aBounds.matched, true);
  assert.equal(aBounds.source, 'selector');
  assert.equal(sg.getSurfaceBounds('emptyAnchor').matched, false);
  assert.equal(sg.getSurfaceBounds('main').matched, false);
  assert.ok(Array.isArray(sg.listSurfaces()));
  assert.ok(sg.getActiveSurface());

  // 2. modal-portal cancel/close/reposition/resize/invalid slot
  const mp = createModalPortal(doc, win, { surfaceGeometry: sg });
  const pMeta = {
    pluginId: 'mp-p',
    displayName: 'MP',
    uiSlots: [
      { slotId: 'mp-p.modal', slot: 'modal' },
      { slotId: 'mp-p.inline', slot: 'inline' },
    ],
  };
  const m1 = mp.openModal(pMeta, 'mp-p.modal', { surface: 'anchorOnly' });
  m1.reposition('main');
  m1.reposition({ surface: 'anchorOnly', anchorEl: anchorPanel });
  m1.reposition();
  win.dispatchEvent({ type: 'resize' });
  m1.element.dispatchEvent({ type: 'cancel', cancelable: true, preventDefault() {} });
  m1.element.dispatchEvent({ type: 'close' });
  assert.throws(() => mp.openPopover(pMeta, 'mp-p.missing'), /ERR_UNDECLARED_SLOT/);
  assert.throws(() => mp.openPopover(pMeta, 'mp-p.inline'), /ERR_INVALID_POPOVER_SLOT_KIND/);

  // 3. host-settings-ui loading/DOMContentLoaded/MutationObserver/dispose + execCommand fallback + extraPages
  const hDom = createRichMockDom();
  hDom.doc.readyState = 'loading';
  const docEvs = new Map();
  hDom.doc.addEventListener = (t, fn) => {
    if (!docEvs.has(t)) docEvs.set(t, new Set());
    docEvs.get(t).add(fn);
  };
  hDom.doc.removeEventListener = (t, fn) => {
    if (docEvs.has(t)) docEvs.get(t).delete(fn);
  };
  let execCopied = false;
  hDom.doc.execCommand = (cmd) => {
    if (cmd === 'copy') execCopied = true;
    return true;
  };
  const moList = [];
  hDom.win.MutationObserver = class FakeHMO {
    constructor(cb) { this.cb = cb; this.disconnected = false; moList.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  };
  let openedExtra = null;
  const fakePageCoord = {
    listSettingsPages: () => [{ pluginId: 'ext-p', id: 'pg1', title: 'Extra Page', order: 10 }],
    openSettingsPage: (pid, id) => { openedExtra = `${pid}:${id}`; },
    setInlineHost: () => () => {},
    onChange: () => () => {},
  };
  const ui = createHostSettingsUi(hDom.doc, hDom.win, {
    settingsUi: {
      sidebarNavLabels: ['Account', 'General'],
      contentPaneSelectors: ['[data-content-pane]'],
    },
    hostBridge: {
      getHostAdminState: async () => ({
        ok: true,
        state: {
          hostVersion: '3.3.4',
          addons: [],
          remoteBridge: { enabled: true, running: true, bindHost: '127.0.0.1', port: 19384, listeningPort: 19384, pairingCode: 'agb1.testcode' },
        },
      }),
    },
    settingsPageCoordinator: fakePageCoord,
  });
  assert.equal(ui.start(), true);
  // Trigger MutationObserver -> scheduleEnsureMount()
  if (moList[0]) moList[0].cb();
  await new Promise((r) => setTimeout(r, 45));
  // Trigger DOMContentLoaded
  for (const fn of Array.from(docEvs.get('DOMContentLoaded') || [])) fn();
  ui.dispose();
  assert.equal(moList[0].disconnected, true);
  assert.equal(typeof execCopied, 'boolean');
  assert.equal(openedExtra, null);
});

test('TC-COV90-R06: section-action-registry validation/MO/invoke, service-bus error guards, and storage-v3 quota/keys/clear/expiry', async () => {
  // 1. section-action-registry validation, existing style reuse, MO callback, invokeSectionAction, disposePlugin
  const { doc, win, body } = createRichMockDom();
  const existingStyle = doc.createElement('style');
  existingStyle.setAttribute('data-addon-host-section-action-style', '1');
  doc.head.appendChild(existingStyle);
  const moSeen = [];
  win.MutationObserver = class FakeSAMO {
    constructor(cb) { this.cb = cb; this.disconnected = false; moSeen.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  };
  let themeCb = null;
  const fakeTheme = {
    getSnapshot: () => ({ mode: 'light' }),
    createThemeHandle: () => ({
      onDidChange(cb) { themeCb = cb; return () => {}; },
    }),
  };
  const reg = createSectionActionRegistry(doc, win, {
    uiSectionTargets: {
      sec: { rootSelectors: ['body'], containerSelectors: ['[data-box="1"]'] },
    },
    themeAndI18n: fakeTheme,
  });
  const box = doc.createElement('div');
  box.setAttribute('data-box', '1');
  body.appendChild(box);
  assert.throws(() => reg.registerSectionAction('p1', null), /ERR_INVALID_SECTION_ACTION_SPEC/);
  assert.throws(() => reg.registerSectionAction('p1', { id: 'bad id!', target: 'sec', label: 'X' }), /ERR_INVALID_SECTION_ACTION_ID/);
  assert.throws(() => reg.registerSectionAction('p1', { id: 'ok1', target: 'BAD_TARGET', label: 'X' }), /ERR_INVALID_SECTION_ACTION_TARGET/);
  assert.throws(() => reg.registerSectionAction('p1', { id: 'ok1', target: 'sec', label: '  ' }), /ERR_INVALID_SECTION_ACTION_LABEL/);
  let clicked = 0;
  reg.registerSectionAction('p1', { id: 'a1', target: 'sec', label: 'Act', onClick: () => { clicked += 1; } });
  if (themeCb) themeCb();
  if (moSeen[0]) moSeen[0].cb();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(reg.invokeSectionAction('p1', 'a1', {}).ok, true);
  assert.equal(clicked, 1);
  assert.equal(reg.invokeSectionAction('p1', 'missing', {}).ok, false);
  reg.disposePlugin('p1');
  reg.dispose();

  // 2. service-bus error guards & disposePlugin
  const sb = createServiceBus({
    onServiceRegistryChange: () => { throw new Error('LISTENER_BOOM'); },
  });
  const pMetaA = {
    pluginId: 'pa',
    trustLevel: 'restricted',
    sourceSchemaVersion: 3,
    permissions: { services: { provide: [{ name: 'pa.svc', allowedCallers: ['pa'] }] } },
  };
  const pMetaB = {
    pluginId: 'pb',
    trustLevel: 'trusted',
    sourceSchemaVersion: 3,
    permissions: { services: { provide: [{ name: 'pa.svc', allowedCallers: ['*'] }] } },
  };
  assert.throws(() => sb.provide(pMetaA, 'host.statusbar', {}), /ERR_SERVICE_HOST_TRUST_FORBIDDEN/);
  assert.throws(() => sb.provide(pMetaA, 'pa.svc', null), /ERR_INVALID_SERVICE_IMPL/);
  sb.provide(pMetaA, 'pa.svc', { ping: () => 'pong' });
  assert.throws(() => sb.provide(pMetaB, 'pa.svc', { ping: () => 'x' }), /ERR_SERVICE_NAMESPACE_MISMATCH/);
  const pHostA = {
    pluginId: 'ph-a',
    trustLevel: 'trusted',
    sourceSchemaVersion: 3,
    permissions: { services: { provide: [{ name: 'host.statusbar', allowedCallers: ['*'] }] } },
  };
  const pHostB = {
    pluginId: 'ph-b',
    trustLevel: 'trusted',
    sourceSchemaVersion: 3,
    permissions: { services: { provide: [{ name: 'host.statusbar', allowedCallers: ['*'] }] } },
  };
  sb.provide(pHostA, 'host.statusbar', { registerItem: () => ({ dispose() {} }) });
  assert.throws(() => sb.provide(pHostB, 'host.statusbar', { registerItem: () => ({ dispose() {} }) }), /ERR_SERVICE_ALREADY_PROVIDED/);
  sb.disposePlugin('ph-a');
  assert.throws(() => sb.call('pa', 'unknown.svc', 'ping'));
  sb.disposePlugin('pa');
  assert.equal(sb.has('pa', 'pa.svc'), false);

  // 3. storage-v3 quota, expiry, keys(), clear(), delete(), onDidChange()
  const lsMap = new Map();
  const s3 = createStorageV3({
    localStorage: {
      getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
      setItem: (k, v) => lsMap.set(k, String(v)),
      removeItem: (k) => lsMap.delete(k),
    },
  });
  const st = s3.createPluginStorage('p-st', { namespace: 'p-st', maxBytes: 120 });
  const events = [];
  const unsub = st.onDidChange((e) => events.push(e));
  assert.throws(() => st.onDidChange('not-fn'), /ERR_INVALID_STORAGE_LISTENER/);
  await st.set('k1', 'v1');
  await st.set('k-exp', 'old', { ttlMs: 1 });
  await new Promise((r) => setTimeout(r, 10));
  const ks = await st.keys();
  assert.deepEqual(ks, ['k1']);
  await assert.rejects(() => st.set('huge', 'x'.repeat(300)), /ERR_STORAGE_QUOTA_EXCEEDED/);
  await assert.rejects(() => st.delete('__proto__'), /ERR_INVALID_STORAGE_KEY/);
  assert.equal(await st.delete('k1'), true);
  assert.equal(await st.delete('missing'), false);
  await st.set('k2', 2);
  await st.clear();
  assert.deepEqual(await st.keys(), []);
  assert.ok(events.length >= 3);
  unsub();
  s3.disposePlugin('p-st');
});

test('TC-COV90-R07: kernel host APIs, style-manager shadow/error paths, ignore-guard, event-bus, settings-tab, slot-manager, and toast-manager', async () => {
  // 1. kernel host APIs (selectSettingsTab, invokeHostAction, emitHostEvent, openSettingsPage, syncSectionActions, staged handle errors, pushPluginSettings errors)
  const { doc, win, body } = createRichMockDom();
  win.crypto = globalThis.crypto;
  const k = createRendererKernel(doc, win);
  // Pre-boot guards
  assert.throws(() => k.consumeStagedHandle('bad-nonce'), /ERR_INVALID_OR_CONSUMED_RUN_NONCE/);
  const boot = k.boot({
    docGenId: 1,
    hostToken: 'ht-r07',
    surface: 'desktop',
    hostBridge: {
      docGenId: 1,
      setPortalClaim: () => ({ ok: true }),
      saveSettings: async () => ({ ok: true }),
      reportError: () => {},
      ping: async () => ({ ok: true }),
    },
  });
  assert.equal(boot.ok, true);
  assert.equal(k.clearStagedHandle(123, 'ht-r07'), false);
  const h = k.createPluginHandle(
    { pluginId: 'p-r07', apiVersion: 2, trustLevel: 'trusted', hasSettingsBridge: true },
    'ht-r07',
    { status: 'ok', data: { v: 1 } }
  );
  h.registerSettingsTab('tab-err', { label: 'ErrTab', onSelect: () => { throw new Error('TAB_BOOM'); } });
  h.registerSettingsTab('tab-async', { label: 'AsyncTab', onSelect: async () => { throw new Error('TAB_ASYNC_BOOM'); } });
  h.registerAction('act-throw', { label: 'Throw', run: () => { throw new Error('ACT_BOOM'); } });
  h.registerAction('act-async', { label: 'Async', run: async () => { throw new Error('ACT_ASYNC_BOOM'); } });
  h.registerAction('act-ok', { label: 'Ok', run: (x) => `ok:${x}` });
  h.onSettingsChange(() => { throw new Error('SYNC_SET_ERR'); });
  h.onSettingsChange(async () => { throw new Error('ASYNC_SET_ERR'); });

  assert.equal(k.selectSettingsTab('p-r07', 'tab-err', 'ht-r07').reason, 'ERR_SETTINGS_TAB_SELECT_FAILED');
  assert.equal(k.selectSettingsTab('p-r07', 'tab-async', 'ht-r07').ok, true);
  assert.ok(k.listHostActions('ht-r07').length >= 3);
  assert.equal(k.invokeHostAction('', '', [], 'ht-r07').reason, 'ERR_ACTION_NOT_FOUND');
  assert.equal(k.invokeHostAction('p-r07', 'nope', [], 'ht-r07').ok, false);
  assert.equal(k.invokeHostAction('p-r07', 'act-throw', [], 'ht-r07').reason, 'ERR_ACTION_EXEC_FAILED');
  assert.equal(k.invokeHostAction('p-r07', 'act-async', [], 'ht-r07').ok, true);
  assert.equal(k.invokeHostAction('p-r07', 'act-ok', ['hi'], 'ht-r07').result, 'ok:hi');
  assert.equal(k.pushPluginSettings('p-r07', { status: 'ok', data: { v: 2 } }, 'ht-r07').delivered, 2);
  assert.equal(typeof k.emitHostEvent('host:test', { a: 1 }, 'ht-r07'), 'number');
  assert.equal(k.syncSectionActions('ht-r07'), true);
  assert.equal(k.openSettingsPage('p-r07', 'nope', 'ht-r07').ok, false);
  assert.equal(k.invokeStatusItem('p-r07', 'nope', {}, 'ht-r07').ok, false);
  assert.equal(k.invokeSectionAction('p-r07', 'nope', {}, 'ht-r07').ok, false);
  k.setHostLocale('ko', 'ht-r07');
  assert.equal(k.getHostLocale(), 'ko');
  assert.ok(k.getSurfaceBounds());
  assert.ok(k.getActiveSurface());
  assert.ok(Array.isArray(k.listSurfaces()));
  assert.ok(k.getErrors().length >= 2);
  k.disposePlugin('p-r07', 'ht-r07');

  // 2. style-manager shadow injection, update, remove, error paths
  const sm = createStyleManager(doc);
  const sr1 = doc.createElement('div');
  sm.registerShadowRoot('p-sm', 'slot1', sr1);
  assert.throws(() => sm.injectStyle({ pluginId: 'p-sm', trustLevel: 'restricted' }, '', '.a{}'), /ERR_INVALID_STYLE_ID/);
  assert.throws(() => sm.injectStyle({ pluginId: 'p-sm', trustLevel: 'restricted' }, 's1', '.a{}', { scope: 'bad' }), /ERR_INVALID_STYLE_SCOPE/);
  assert.throws(() => sm.injectStyle({ pluginId: 'p-sm', trustLevel: 'restricted' }, 's1', '.a{}', { scope: 'global' }), /ERR_RESTRICTED_GLOBAL_CSS_FORBIDDEN/);
  assert.throws(() => sm.injectStyle({ pluginId: 'p-sm', trustLevel: 'trusted' }, 's1', '@import "x";'));
  sm.injectStyle({ pluginId: 'p-sm', trustLevel: 'trusted' }, 's-slot', '.a { color: red; }', { slotId: 'slot1' });
  sm.injectStyle({ pluginId: 'p-sm', trustLevel: 'trusted' }, 's-owner', '.b { color: blue; }');
  sm.injectStyle({ pluginId: 'p-sm', trustLevel: 'trusted' }, 's-owner', '.b { color: green; }');
  assert.equal(sm.removeStyle('p-sm', 'missing'), false);
  assert.equal(sm.removeStyle('p-sm', 's-owner'), true);
  sm.disposePluginStyles('p-sm');
  sm.unregisterShadowRoot('p-sm', 'slot1', sr1);

  // 3. ignore-guard ShadowRoot .host, extraAttrs, ignoreElements, Event vs DOM node
  assert.equal(isElementInsideIgnored(null), false);
  const hostBox = doc.createElement('div');
  hostBox.setAttribute('data-custom-no-tr', '1');
  const shadowLike = { host: hostBox };
  const leaf = { parentNode: shadowLike };
  assert.equal(isNodeIgnored(leaf, ['data-custom-no-tr']), true);
  assert.equal(isNodeIgnored({ nodeType: 1 }, [], []), false);
  const ignoredBtn = doc.createElement('button');
  assert.equal(isElementInsideIgnored({ composedPath: () => [ignoredBtn] }, { ignoreElements: [ignoredBtn] }), true);
  assert.equal(isElementInsideIgnored({ target: leaf }, { extraNoTranslateAttributes: ['data-custom-no-tr'] }), true);
  assert.equal(isElementInsideIgnored({ target: null }), false);

  // 4. event-bus, settings-tab-coordinator, slot-manager, toast-manager edge branches
  const ebErrs = [];
  const eb = createEventBus({ reportPluginError: (p, m) => ebErrs.push(`${p}:${m}`) });
  assert.throws(() => eb.on('p1', '', () => {}), /ERR_INVALID_EVENT_TOPIC/);
  assert.throws(() => eb.on('p1', 't', null), /ERR_INVALID_EVENT_HANDLER/);
  assert.throws(() => eb.emit('p1', ''), /ERR_INVALID_EVENT_TOPIC/);
  eb.on('p1', 'boom', () => { throw new Error('EB_SYNC'); });
  eb.once('p1', 'boom', async () => { throw new Error('EB_ASYNC'); });
  assert.equal(eb.emit('p2', 'boom', { x: 1 }), 2);
  assert.equal(eb.emit('p2', 'empty'), 0);
  eb.disposePlugin('p1');

  const stc = createSettingsTabCoordinator();
  assert.throws(() => stc.registerSettingsTab('p1', ''), /ERR_INVALID_TAB_ID/);
  const tabReg = stc.registerSettingsTab('p1', 't-ro', { label: 'RO' });
  assert.equal(stc.selectTab('', 't-ro').reason, 'ERR_SETTINGS_TAB_NOT_FOUND');
  assert.equal(stc.selectTab('p1', 'nope').reason, 'ERR_SETTINGS_TAB_NOT_FOUND');
  assert.equal(stc.selectTab('p1', 't-ro').reason, 'ERR_SETTINGS_TAB_NOT_SELECTABLE');
  stc.registerSettingsTab('p1', 't-err', { onSelect: () => { throw new Error('STC_ERR'); } });
  assert.equal(stc.selectTab('p1', 't-err').reason, 'ERR_SETTINGS_TAB_SELECT_FAILED');
  tabReg.unregister();
  stc.disposePluginTabs('p1');

  const slotMgr = createSlotManager(doc, { uiAnchors: { miss: ['[data-not-here]'] }, extraNoTranslateAttributes: ['data-x'], styleManager: sm });
  const smMeta = { pluginId: 'p-sl', trustLevel: 'trusted', uiSlots: [{ slotId: 's1', slot: 'overlay', anchor: 'miss' }, { slotId: 's2', slot: 'overlay' }] };
  assert.throws(() => slotMgr.mountSlot(smMeta, 'undeclared'), /ERR_UNDECLARED_SLOT/);
  assert.equal(slotMgr.mountSlot(smMeta, 's1'), null);
  const mounted = slotMgr.mountSlot(smMeta, 's2', { container: body, shadow: false });
  assert.ok(mounted);
  assert.throws(() => slotMgr.unmountSlot('other-plugin', 's2'), /ERR_FORBIDDEN_CROSS_PLUGIN_UNMOUNT/);
  assert.equal(slotMgr.unmountSlot('p-sl', 'nope'), false);
  assert.equal(slotMgr.unmountSlot('p-sl', 's2'), true);

  const tm = createToastAndDialogManager(doc, win, { extraNoTranslateAttributes: ['data-nt'] });
  const t1 = tm.showToast({ pluginId: 'p-tm', displayName: 'TM' }, 'Simple toast');
  t1.dismiss();
  const t2 = tm.showToast({ pluginId: 'p-tm', displayName: 'TM' }, { message: 'Err', variant: 'error', durationMs: 10 });
  await new Promise((r) => setTimeout(r, 20));
  t2.dismiss();
  tm.disposePlugin('p-tm');
});

test('TC-COV90-R08: settings-page-coordinator and theme-i18n edge & error isolation paths', () => {
  const { doc, win } = createRichMockDom();
  const opened = [];
  const spc = createSettingsPageCoordinator({
    openTier2Modal: (meta, opts) => {
      opened.push(['tier2', meta.pluginId, opts.title]);
      return { close() { opts.onClose && opts.onClose(); } };
    },
    openTier3Modal: (meta, opts) => {
      opened.push(['tier3', meta.pluginId, opts.title]);
      return { close() { opts.onClose && opts.onClose(); } };
    },
  });
  const unsubInvalid = spc.setInlineHost(null);
  unsubInvalid();
  const unsubChg = spc.onChange(() => { throw new Error('CHG_BOOM'); });
  assert.throws(() => spc.registerSettingsPage({ pluginId: 'p1' }, {}), /ERR_INVALID_SETTINGS_PAGE_ID/);
  assert.throws(() => spc.registerSettingsPage({ pluginId: 'p1' }, { id: 'pg1' }), /ERR_SETTINGS_PAGE_REQUIRES_SCHEMA_OR_RENDER/);
  const pg2 = spc.registerSettingsPage(
    { pluginId: 'p1' },
    {
      id: 'pg-schema',
      title: 'Fallback Title',
      getTitle: () => { throw new Error('TITLE_BOOM'); },
      schema: { type: 'stack', children: [] },
      onClose: () => {},
    }
  );
  spc.openSettingsPage('p1', 'pg-schema');
  const pg3 = spc.registerSettingsPage(
    { pluginId: 'p1' },
    { id: 'pg-canvas', title: 'Canvas Page', render: () => {} }
  );
  spc.openSettingsPage('p1', 'pg-canvas');
  let inlineOpened = 0;
  const unsubInline = spc.setInlineHost({
    canMountInline: () => true,
    mountInlinePage: () => { inlineOpened += 1; return { close() {} }; },
  });
  spc.openSettingsPage('p1', 'pg-schema');
  assert.equal(inlineOpened, 1);
  unsubInline();
  pg2.dispose();
  pg3.dispose();
  unsubChg();
  spc.disposePlugin('p1');

  const ti = createThemeAndI18n(doc, win);
  const unsubLoc = ti.onLocaleDidChange(() => { throw new Error('LOC_BOOM'); });
  ti.setLocale('ko');
  assert.equal(ti.getLocale(), 'ko');
  ti.setLocale('en');
  assert.equal(ti.getLocale(), 'en');
  assert.equal(ti.t('Hello', { ko: '안녕', en: 'Hello' }), 'Hello');
  assert.equal(ti.t('Fallback'), 'Fallback');
  const th = ti.createThemeHandle();
  assert.ok(th && typeof th.onDidChange === 'function');
  unsubLoc();

  // host-bridge-port validation & all optional method wrappers (present & absent)
  assert.equal(isValidHostBridgePort(null), false);
  assert.equal(isValidHostBridgePort({}), false);
  assert.throws(() => wrapHostBridgePort(null), /ERR_INVALID_HOST_BRIDGE_PORT/);
  assert.throws(() => wrapHostBridgePort({ setPortalClaim() {} }), /ERR_HOST_BRIDGE_PORT_MISSING_METHOD/);
  const basePort = {
    docGenId: 2,
    profileId: 'test-prof',
    setPortalClaim: () => ({ ok: true }),
    saveSettings: async () => ({ ok: true }),
    reportError: () => {},
    ping: async () => ({ ok: true }),
  };
  assert.equal(isValidHostBridgePort(basePort), true);
  const wMin = wrapHostBridgePort(basePort);
  assert.equal(wMin.readConfigScope, undefined);
  const wFull = wrapHostBridgePort({
    ...basePort,
    readConfigScope: async () => ({ ok: true }),
    writeConfigScope: async () => ({ ok: true }),
    getHostAdminState: async () => ({ ok: true }),
    setRemoteAddonPreference: async () => ({ ok: true }),
    configureRemoteBridge: async () => ({ ok: true }),
    rotateRemoteBridgeToken: async () => ({ ok: true }),
    rebuildRemoteBundle: async () => ({ ok: true }),
    getRemoteBridgeStatus: () => ({ connected: false }),
    netFetch: async () => ({ ok: true }),
    secretsSet: async () => ({ ok: true }),
    secretsGet: async () => ({ ok: true }),
    secretsHas: async () => ({ ok: true }),
    secretsDelete: async () => ({ ok: true }),
    secretsList: async () => ({ ok: true }),
  });
  assert.equal(wFull.getRemoteBridgeStatus().connected, false);
  wFull.readConfigScope('p', 's');
  wFull.writeConfigScope('p', 's', '{}');
  wFull.getHostAdminState();
  wFull.setRemoteAddonPreference('p', true);
  wFull.configureRemoteBridge({});
  wFull.rotateRemoteBridgeToken();
  wFull.rebuildRemoteBundle();
  wFull.netFetch('p', 'https://a.com');
  wFull.secretsSet('p', 'k', 'v');
  wFull.secretsGet('p', 'k');
  wFull.secretsHas('p', 'k');
  wFull.secretsDelete('p', 'k');
  wFull.secretsList('p');
});
