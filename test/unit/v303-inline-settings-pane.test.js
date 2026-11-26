'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createHostSettingsUi,
  PLUGIN_NAV_ATTR,
  PLUGIN_PANE_ATTR,
} = require('../../src/runtime/renderer/host-settings-ui');
const { createSettingsPageCoordinator } = require('../../src/runtime/renderer/settings-page-coordinator');
const { createThemeAndI18n } = require('../../src/runtime/renderer/theme-i18n');

function createSettingsDomFixture() {
  class FakeNode {
    constructor(tagName, ownerDoc) {
      this.tagName = String(tagName || 'div').toUpperCase();
      this.nodeType = 1;
      this.ownerDocument = ownerDoc;
      this.parentElement = null;
      this.parentNode = null;
      this.children = [];
      this.childNodes = [];
      this.attributes = new Map();
      this.style = {
        setProperty(k, v) {
          const camel = k.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
          this[camel] = v;
        },
        removeProperty(k) {
          const camel = k.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
          delete this[camel];
        },
      };
      this.listeners = new Map();
      this.shadowRoot = null;
      this.disabled = false;
      this.hidden = false;
      this._text = '';
      this.className = '';
      this.value = '';
      this.checked = false;
    }
    get isConnected() {
      let cur = this;
      while (cur) {
        if (cur === this.ownerDocument.documentElement || cur === this.ownerDocument.body) return true;
        cur = cur.parentNode;
      }
      return false;
    }
    get firstChild() {
      return this.childNodes[0] || null;
    }
    get nextSibling() {
      if (!this.parentNode) return null;
      const idx = this.parentNode.childNodes.indexOf(this);
      return idx >= 0 ? this.parentNode.childNodes[idx + 1] || null : null;
    }
    get textContent() {
      if (this.childNodes.length === 0) return this._text;
      return this.childNodes.map((c) => c.textContent || '').join('');
    }
    set textContent(v) {
      this.childNodes = [];
      this.children = [];
      this._text = String(v == null ? '' : v);
    }
    setAttribute(k, v) {
      this.attributes.set(String(k), String(v));
      if (k === 'class') this.className = String(v);
      if (k === 'hidden') this.hidden = true;
    }
    getAttribute(k) {
      return this.attributes.has(String(k)) ? this.attributes.get(String(k)) : null;
    }
    removeAttribute(k) {
      this.attributes.delete(String(k));
      if (k === 'hidden') this.hidden = false;
    }
    appendChild(child) {
      if (!child) return child;
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      child.parentElement = this.nodeType === 1 ? this : null;
      this.childNodes.push(child);
      if (child.nodeType === 1) this.children.push(child);
      return child;
    }
    insertBefore(child, ref) {
      if (!ref) return this.appendChild(child);
      if (!child) return child;
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      child.parentElement = this.nodeType === 1 ? this : null;
      const ci = this.childNodes.indexOf(ref);
      if (ci >= 0) this.childNodes.splice(ci, 0, child);
      else this.childNodes.push(child);
      if (child.nodeType === 1) {
        const ei = this.children.indexOf(ref);
        if (ei >= 0) this.children.splice(ei, 0, child);
        else this.children.push(child);
      }
      return child;
    }
    removeChild(child) {
      const idx = this.childNodes.indexOf(child);
      if (idx !== -1) this.childNodes.splice(idx, 1);
      const cIdx = this.children.indexOf(child);
      if (cIdx !== -1) this.children.splice(cIdx, 1);
      child.parentNode = null;
      child.parentElement = null;
      return child;
    }
    cloneNode(deep) {
      const copy = new FakeNode(this.tagName, this.ownerDocument);
      copy.className = this.className;
      copy._text = this._text;
      for (const [k, v] of this.attributes.entries()) copy.setAttribute(k, v);
      if (deep) {
        for (const ch of this.childNodes) {
          if (ch.nodeType === 3) copy.appendChild(this.ownerDocument.createTextNode(ch.nodeValue));
          else copy.appendChild(ch.cloneNode(true));
        }
      }
      return copy;
    }
    attachShadow() {
      const sr = new FakeNode('shadow-root', this.ownerDocument);
      sr.nodeType = 11;
      this.shadowRoot = sr;
      return sr;
    }
    contains(target) {
      if (target === this) return true;
      for (const ch of this.childNodes) {
        if (ch === target || (typeof ch.contains === 'function' && ch.contains(target))) return true;
      }
      return false;
    }
    addEventListener(type, fn, capture = false) {
      const key = `${type}:${capture ? 'c' : 'b'}`;
      if (!this.listeners.has(key)) this.listeners.set(key, new Set());
      this.listeners.get(key).add(fn);
    }
    removeEventListener(type, fn, capture = false) {
      const key = `${type}:${capture ? 'c' : 'b'}`;
      if (this.listeners.has(key)) this.listeners.get(key).delete(fn);
    }
    dispatchClick(targetEl) {
      const target = targetEl || this;
      const chain = [];
      let cur = target;
      while (cur) {
        chain.push(cur);
        cur = cur.parentNode;
      }
      let stopped = false;
      const ev = {
        target,
        isTrusted: true,
        preventDefault() {},
        stopPropagation() {
          stopped = true;
        },
      };
      // Capture phase top-down
      for (let i = chain.length - 1; i >= 0; i -= 1) {
        const set = chain[i].listeners.get('click:c');
        if (set) {
          for (const fn of Array.from(set)) fn(ev);
        }
        if (stopped) return;
      }
      // Bubble phase bottom-up
      for (let i = 0; i < chain.length; i += 1) {
        const set = chain[i].listeners.get('click:b');
        if (set) {
          for (const fn of Array.from(set)) fn(ev);
        }
        if (stopped) return;
      }
    }
    click() {
      this.dispatchClick(this);
    }
    getBoundingClientRect() {
      return this._rect || { left: 0, top: 0, width: 220, height: 36, right: 220, bottom: 36 };
    }
    matches(selector) {
      const parts = String(selector || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const p of parts) {
        if (p.startsWith('[') && p.endsWith(']')) {
          const inner = p.slice(1, -1);
          const eq = inner.indexOf('=');
          if (eq === -1) {
            if (this.attributes.has(inner)) return true;
          } else {
            const k = inner.slice(0, eq).trim();
            const val = inner.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
            if (this.getAttribute(k) === val) return true;
          }
        } else if (p.startsWith('.')) {
          if (String(this.className || '').split(/\s+/).includes(p.slice(1))) return true;
        } else if (this.tagName.toLowerCase() === p.toLowerCase()) {
          return true;
        }
      }
      return false;
    }
    querySelectorAll(selector) {
      const out = [];
      const walk = (n) => {
        for (const c of n.childNodes) {
          if (!c || c.nodeType !== 1) continue;
          if (c.matches(selector)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
  }

  const doc = {
    readyState: 'complete',
    createElement(tag) {
      return new FakeNode(tag, doc);
    },
    createTextNode(text) {
      return {
        nodeType: 3,
        nodeName: '#text',
        ownerDocument: doc,
        parentNode: null,
        nodeValue: String(text == null ? '' : text),
        get textContent() {
          return this.nodeValue;
        },
        set textContent(v) {
          this.nodeValue = String(v == null ? '' : v);
        },
      };
    },
    querySelectorAll(sel) {
      return doc.body.querySelectorAll(sel);
    },
    querySelector(sel) {
      return doc.body.querySelector(sel);
    },
    addEventListener() {},
    removeEventListener() {},
  };
  doc.documentElement = new FakeNode('html', doc);
  doc.documentElement.lang = 'ko';
  doc.body = new FakeNode('body', doc);
  doc.documentElement.appendChild(doc.body);

  const shell = doc.createElement('div');
  shell._rect = { left: 0, top: 0, width: 960, height: 640, right: 960, bottom: 640 };
  const sidebar = doc.createElement('div');
  sidebar._rect = { left: 0, top: 0, width: 220, height: 640, right: 220, bottom: 640 };
  const navList = doc.createElement('div');
  navList._rect = { left: 0, top: 0, width: 220, height: 400, right: 220, bottom: 400 };
  const nativeButtons = {};
  for (const label of ['일반', '애플리케이션', '모양', '브라우저']) {
    const btn = doc.createElement('button');
    btn.setAttribute('type', 'button');
    const span = doc.createElement('span');
    span.appendChild(doc.createTextNode(label));
    btn.appendChild(span);
    navList.appendChild(btn);
    nativeButtons[label] = btn;
  }
  sidebar.appendChild(navList);

  const contentPane = doc.createElement('div');
  contentPane._rect = { left: 220, top: 0, width: 740, height: 640, right: 960, bottom: 640 };
  const nativePanel = doc.createElement('div');
  nativePanel.textContent = 'Native Permissions View';
  contentPane.appendChild(nativePanel);

  shell.appendChild(sidebar);
  shell.appendChild(contentPane);
  doc.body.appendChild(shell);

  const win = {
    document: doc,
    innerWidth: 1280,
    innerHeight: 800,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: (el) => {
      if (el === doc.body) return { backgroundColor: 'rgb(15, 19, 26)' };
      if (el === nativeButtons['일반']) return { display: 'flex', visibility: 'visible', opacity: '1', backgroundColor: 'rgba(255, 255, 255, 0.1)', color: '#ffffff' };
      return { display: 'flex', visibility: 'visible', opacity: '1', backgroundColor: 'transparent', color: '#cbd5e1' };
    },
    addEventListener() {},
    removeEventListener() {},
  };

  return { doc, win, shell, sidebar, navList, contentPane, nativePanel, nativeButtons };
}

test('v3.0.3: Desktop Settings renders Tier-2 schema and Tier-3 canvas plugin pages INLINE inside contentPane, switches cleanly, and falls back to modal when Settings is closed', () => {
  const { doc, win, shell, navList, contentPane, nativePanel, nativeButtons } = createSettingsDomFixture();
  const themeAndI18n = createThemeAndI18n(doc, win);

  let tier2ModalOpens = 0;
  let tier3ModalOpens = 0;
  const coordinator = createSettingsPageCoordinator({
    openTier2Modal: () => {
      tier2ModalOpens += 1;
      return { kind: 'modal', close() {} };
    },
    openTier3Modal: () => {
      tier3ModalOpens += 1;
      return { kind: 'modal', bodyEl: doc.createElement('div'), close() {} };
    },
  });

  const adminState = {
    ok: true,
    host: { version: '3.0.3', buildSha8: 'cafebabe' },
    summary: { totalCount: 2, desktopActiveCount: 2, remoteEligibleCount: 2, remoteEnabledCount: 2 },
    addons: [],
    remoteBundle: { built: true, needsRebuild: false, buildSha8: '11223344' },
  };
  const ui = createHostSettingsUi(doc, win, {
    hostBridge: {
      getHostAdminState: async () => adminState,
      setRemoteAddonPreference: async () => ({ ok: true, state: adminState }),
    },
    settingsPageCoordinator: coordinator,
    themeAndI18n,
  });
  ui.start();

  let koClosedCount = 0;
  const koPage = coordinator.registerSettingsPage(
    { pluginId: 'ko-thought-translator', displayName: 'Korean Translator' },
    {
      id: 'ko-settings',
      title: '한국어 번역 설정',
      order: 10,
      getSchema: () => ({
        type: 'stack',
        id: 'ko-root',
        children: [{ type: 'text', id: 'ko-msg', text: 'Engine: Google' }],
      }),
      onClose: () => {
        koClosedCount += 1;
      },
    }
  );

  let mcpClosedCount = 0;
  const mcpPage = coordinator.registerSettingsPage(
    { pluginId: 'antigravity-mcp-manager', displayName: 'Antigravity MCP Manager' },
    {
      id: 'mcp-settings',
      title: 'MCP Manager',
      order: 20,
      render: (canvasRoot) => {
        const box = doc.createElement('div');
        box.textContent = 'Inline MCP Canvas Ready';
        canvasRoot.appendChild(box);
      },
      onClose: () => {
        mcpClosedCount += 1;
      },
    }
  );

  const koBtn = navList.querySelector(`[${PLUGIN_NAV_ATTR}="ko-thought-translator:ko-settings"]`);
  const mcpBtn = navList.querySelector(`[${PLUGIN_NAV_ATTR}="antigravity-mcp-manager:mcp-settings"]`);
  assert.ok(koBtn && mcpBtn, 'Both plugin settings pages must appear in the left sidebar');

  // 1. Open Tier-3 canvas page directly (WITHOUT ever opening Addon Manager first!)
  mcpBtn.click();
  assert.equal(tier3ModalOpens, 0, 'Must render inline inside Settings right pane, NOT as a floating modal');
  assert.equal(ui.getActivePluginPageKey(), 'antigravity-mcp-manager:mcp-settings');
  assert.equal(coordinator.getActivePageKey(), 'antigravity-mcp-manager:mcp-settings');
  assert.equal(nativePanel.style.display, 'none', 'Native Settings panel must be hidden while inline plugin page is active');
  assert.equal(mcpBtn.getAttribute('aria-selected'), 'true');
  assert.equal(koBtn.getAttribute('aria-selected'), 'false');

  const inlineHostEl = contentPane.querySelector(`[${PLUGIN_PANE_ATTR}="true"]`);
  assert.ok(inlineHostEl, 'Inline plugin pane host element must be mounted inside contentPane');
  assert.equal(inlineHostEl.style.display, 'block');
  assert.ok(inlineHostEl.shadowRoot.textContent.includes('Inline MCP Canvas Ready'));
  assert.ok(inlineHostEl.shadowRoot.textContent.includes('Addon: Antigravity MCP Manager'));
  assert.equal(inlineHostEl.shadowRoot.querySelector('h2'), null, 'Canvas inline page should use compact attribution header without duplicating plugin title');

  // 2. Click a native tab directly -> MUST close plugin pane and restore native content even though Addon Manager was never opened
  nativeButtons['일반'].click();
  assert.equal(mcpClosedCount, 1, 'Switching to a native Settings tab must call plugin page onClose()');
  assert.equal(ui.getActivePluginPageKey(), null);
  assert.equal(nativePanel.style.display, '', 'Native Settings content must be restored immediately');
  assert.equal(inlineHostEl.style.display, 'none');

  // 3. Open Tier-2 schema page inline & verify live update() patching
  koBtn.click();
  assert.equal(tier2ModalOpens, 0);
  assert.equal(ui.getActivePluginPageKey(), 'ko-thought-translator:ko-settings');
  assert.equal(nativePanel.style.display, 'none');
  assert.equal(koBtn.getAttribute('aria-selected'), 'true');
  assert.ok(inlineHostEl.shadowRoot.textContent.includes('한국어 번역 설정'));
  assert.ok(inlineHostEl.shadowRoot.textContent.includes('Engine: Google'));

  koPage.update({
    type: 'stack',
    id: 'ko-root',
    children: [{ type: 'text', id: 'ko-msg', text: 'Engine: LLM' }],
  });
  assert.ok(inlineHostEl.shadowRoot.textContent.includes('Engine: LLM'), 'pageHandle.update() must patch inline Tier-2 schema page in place');

  // 4. Switch from Tier-2 plugin page to Addon Manager -> closes Tier-2 page, keeps native content hidden
  ui.openPanel();
  assert.equal(koClosedCount, 1);
  assert.equal(ui.isOpen(), true);
  assert.equal(ui.getActivePluginPageKey(), null);
  assert.equal(nativePanel.style.display, 'none');
  assert.equal(koBtn.getAttribute('aria-selected'), 'false');

  // 5. Switch from Addon Manager directly back to MCP Manager -> closes Addon Manager, mounts MCP inline
  mcpBtn.click();
  assert.equal(ui.isOpen(), false);
  assert.equal(ui.getActivePluginPageKey(), 'antigravity-mcp-manager:mcp-settings');
  assert.equal(nativePanel.style.display, 'none');

  // 6. Unmount Settings shell -> falls back cleanly to modal when opened outside Settings (e.g. Command Palette / Remote Web)
  doc.body.removeChild(shell);
  ui.ensureMount();
  assert.equal(mcpClosedCount, 2, 'Unmounting Settings shell must cleanly close active inline plugin page');
  const fallbackRes = coordinator.openSettingsPage('antigravity-mcp-manager', 'mcp-settings');
  assert.equal(fallbackRes.ok, true);
  assert.equal(tier3ModalOpens, 1, 'Opening settings page when Desktop Settings pane is closed must fall back to modal');

  koPage.dispose();
  mcpPage.dispose();
  ui.dispose();
  themeAndI18n.dispose();
});
