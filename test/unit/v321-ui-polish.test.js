'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestHost, h } = require('../../packages/sdk/src');
const { SCHEMA_UI_CSS } = require('../../src/runtime/renderer/ui-schema-renderer');
const { createThemeAndI18n, buildTokenCss, DARK_TOKENS, LIGHT_TOKENS } = require('../../src/runtime/renderer/theme-i18n');
const { createToastAndDialogManager } = require('../../src/runtime/renderer/toast-manager');

test('TC-V321-01: theme-i18n emits color-scheme sync & refined design tokens while preserving --ag-surface and --ag-accent', () => {
  const darkCss = buildTokenCss('dark');
  const lightCss = buildTokenCss('light');

  assert.equal(darkCss.includes('color-scheme: dark;'), true);
  assert.equal(lightCss.includes('color-scheme: light;'), true);
  assert.equal(DARK_TOKENS['--ag-surface'], '#161b24');
  assert.ok(DARK_TOKENS['--ag-accent']);
  assert.ok(DARK_TOKENS['--ag-primary']);
  assert.ok(DARK_TOKENS['--ag-primary-hover']);
  assert.ok(DARK_TOKENS['--ag-scrollbar-thumb']);
  assert.ok(LIGHT_TOKENS['--ag-primary']);
  assert.ok(LIGHT_TOKENS['--ag-focus-ring']);
});

test('TC-V321-02: SCHEMA_UI_CSS upgrades Tier-2 modals/forms cleanly (pill toggle, custom scrollbars, CSP-safe select, reduced-motion, zero data: URI) while preserving v3.0.4 scroll invariants', () => {
  assert.equal(SCHEMA_UI_CSS.includes('max-height: inherit;'), true);
  assert.equal(SCHEMA_UI_CSS.includes('flex: 1 1 auto; min-height: 0;'), true);
  assert.equal(SCHEMA_UI_CSS.includes('::-webkit-scrollbar'), true);
  assert.equal(SCHEMA_UI_CSS.includes('.ag-toggle-row input[type="checkbox"]::before'), true);
  assert.equal(SCHEMA_UI_CSS.includes('prefers-reduced-motion: reduce'), true);
  assert.equal(SCHEMA_UI_CSS.includes('min-height: 92px;'), true);
  assert.equal(SCHEMA_UI_CSS.includes('data:image/'), false, 'Select chevron must remain 100% CSP-safe without data: URIs');
});

test('TC-V321-03: Tier-1 Toast uses locale-aware default title, compact header close button, preserves non-removable attribution, and omits empty action row', () => {
  const mkHostDoc = (lang) => {
    const createEl = (tag) => {
      const node = {
        tagName: String(tag || 'div').toUpperCase(),
        attributes: new Map(),
        children: [],
        childNodes: [],
        parentNode: null,
        shadowRoot: null,
        textContent: '',
        className: '',
        listeners: new Map(),
        setAttribute(k, v) {
          this.attributes.set(String(k), String(v));
        },
        getAttribute(k) {
          return this.attributes.has(String(k)) ? this.attributes.get(String(k)) : null;
        },
        appendChild(ch) {
          ch.parentNode = this;
          this.children.push(ch);
          this.childNodes.push(ch);
          return ch;
        },
        removeChild(ch) {
          const i = this.children.indexOf(ch);
          if (i >= 0) this.children.splice(i, 1);
          const j = this.childNodes.indexOf(ch);
          if (j >= 0) this.childNodes.splice(j, 1);
          ch.parentNode = null;
          return ch;
        },
        addEventListener(type, fn) {
          if (!this.listeners.has(type)) this.listeners.set(type, []);
          this.listeners.get(type).push(fn);
        },
        attachShadow() {
          this.shadowRoot = createEl('#shadow-root');
          return this.shadowRoot;
        },
      };
      return node;
    };
    const doc = {
      documentElement: createEl('html'),
      body: createEl('body'),
      createElement: createEl,
    };
    doc.documentElement.lang = lang;
    return doc;
  };

  const findByClass = (root, cls) => {
    const out = [];
    const walk = (n) => {
      if (!n) return;
      if (typeof n.className === 'string' && n.className.split(/\s+/).includes(cls)) out.push(n);
      for (const ch of n.children || []) walk(ch);
    };
    walk(root);
    return out;
  };

  // Korean locale: default success title renders "완료" instead of raw "SUCCESS"
  const koDoc = mkHostDoc('ko-KR');
  const koTheme = createThemeAndI18n(koDoc, { navigator: { language: 'ko-KR' } });
  const koMgr = createToastAndDialogManager(koDoc, {}, { themeAndI18n: koTheme });
  const t1 = koMgr.showToast(
    { pluginId: 'statusbar', displayName: 'Antigravity Statusbar' },
    { message: '컴팩션 요청됨', variant: 'success', durationMs: 0 }
  );
  const toastRoot = koDoc.body.children[0].shadowRoot;
  const titleEl = findByClass(toastRoot, 'ag-toast-title')[0];
  const badgeEl = findByClass(toastRoot, 'ag-toast-badge')[0];
  const closeBtn = findByClass(toastRoot, 'ag-toast-close')[0];
  const actionsRows = findByClass(toastRoot, 'ag-toast-actions');
  assert.equal(titleEl.textContent, '완료');
  assert.equal(badgeEl.textContent, 'Addon: Antigravity Statusbar');
  assert.equal(badgeEl.getAttribute('data-addon-host-attribution'), '1');
  assert.ok(closeBtn && closeBtn.textContent === '×');
  assert.equal(actionsRows.length, 0, 'Compact toast without spec.action must not render bulky empty actions row');

  // Clicking compact close button dismisses toast cleanly
  closeBtn.listeners.get('click')[0]({ isTrusted: true });
  assert.equal(findByClass(toastRoot, 'ag-toast').length, 0);
  t1.dismiss();

  // English locale + custom action renders "Success" & action button row
  const enDoc = mkHostDoc('en-US');
  const enTheme = createThemeAndI18n(enDoc, { navigator: { language: 'en-US' } });
  const enMgr = createToastAndDialogManager(enDoc, {}, { themeAndI18n: enTheme });
  let actionClicked = 0;
  const t2 = enMgr.showToast(
    { pluginId: 'demo', displayName: 'Demo' },
    {
      message: 'Updated',
      variant: 'success',
      durationMs: 0,
      action: { label: 'Undo', onClick: () => { actionClicked += 1; } },
    }
  );
  const enRoot = enDoc.body.children[0].shadowRoot;
  assert.equal(findByClass(enRoot, 'ag-toast-title')[0].textContent, 'Success');
  assert.equal(findByClass(enRoot, 'ag-toast-actions').length, 1);
  findByClass(enRoot, 'ag-toast-btn')[0].listeners.get('click')[0]({ isTrusted: true });
  assert.equal(actionClicked, 1);
  t2.dismiss();

  koTheme.dispose();
  enTheme.dispose();
});

test('TC-V321-04: openModal injects idempotent blurred ::backdrop style once and applies rounded borderRadius', async () => {
  const host = createTestHost({ surface: 'desktop', locale: 'ko-KR', themeMode: 'dark' });
  const ctx = await host.mountPlugin({
    schemaVersion: 3,
    pluginId: 'modal-polish-plugin',
    displayName: 'Modal Polish Plugin',
    version: '1.0.0',
    capabilities: ['renderer'],
    entry: { rendererScript: 'index.js' },
  });

  const m1 = ctx.ui.openModal({
    title: 'Settings',
    tree: h('stack', { id: 'r1' }, [h('toggle', { id: 't1', field: 'on', label: 'Enable' })]),
    state: { on: true },
  });
  const m2 = ctx.ui.openModal({
    title: 'Nested',
    tree: h('stack', { id: 'r2' }, [h('text', { id: 'x2', text: 'Nested body' })]),
  });

  const allNodes = [];
  const walk = (n) => {
    if (!n) return;
    allNodes.push(n);
    for (const ch of n.childNodes || []) walk(ch);
  };
  walk(host.doc.documentElement);

  const backdropStyles = allNodes.filter(
    (n) => typeof n.getAttribute === 'function' && n.getAttribute('data-addon-host-v3-backdrop') === '1'
  );
  assert.equal(backdropStyles.length, 1, 'Backdrop <style> must be injected lazily and idempotently once');
  assert.equal(backdropStyles[0].textContent.includes('backdrop-filter: blur(4px)'), true);
  assert.equal(m1.element.style.borderRadius, 'var(--ag-radius, 12px)');
  assert.equal(m2.element.style.borderRadius, 'var(--ag-radius, 12px)');

  m2.close();
  m1.close();
});
