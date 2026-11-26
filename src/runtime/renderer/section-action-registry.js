'use strict';

/**
 * Vendor-neutral Tier-1 Declarative Section Action Registry (v3.3.0 — SOLID #0).
 *
 * - Lets plugins register host-styled action buttons on declarative host section targets
 *   (configured exclusively in `HostProfile.uiSectionTargets` — zero vendor literals here).
 * - Strictly ZERO HTML sinks (`innerHTML` / `outerHTML` / `insertAdjacentHTML` = 0).
 * - Mounts a single debounced `MutationObserver` ONLY while at least 1 action is registered,
 *   re-attaching seamlessly across SPA re-renders and disconnecting automatically on empty/dispose.
 * - Enforces `ev.isTrusted !== false` on user clicks.
 */

const _ObjectFreeze = Object.freeze;
const _ObjectKeys = Object.keys;
const _ArrayIsArray = Array.isArray;
const _ArrayFrom = Array.from;
const _Map = Map;
const _MapGet = Function.prototype.call.bind(Map.prototype.get);
const _MapSet = Function.prototype.call.bind(Map.prototype.set);
const _MapDelete = Function.prototype.call.bind(Map.prototype.delete);
const _MapValues = Function.prototype.call.bind(Map.prototype.values);
const _Number = Number;
const _NumberIsFinite = Number.isFinite;
const _String = String;

const SAFE_ACTION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;
const SAFE_TARGET_ID_RE = /^[a-z0-9][a-z0-9._-]{1,95}$/;
const SECTION_STYLE_ATTR = 'data-addon-host-section-action-style';
const SECTION_GROUP_ATTR = 'data-addon-host-section-actions';
const SECTION_BTN_ATTR = 'data-addon-host-section-action-btn';

function normalizeText(value) {
  return _String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function buildSectionActionCss(mode) {
  const isLight = mode === 'light';
  const bg = isLight ? 'rgba(15, 23, 42, 0.05)' : 'rgba(255, 255, 255, 0.06)';
  const hoverBg = isLight ? 'rgba(15, 23, 42, 0.1)' : 'rgba(255, 255, 255, 0.12)';
  const border = isLight ? 'rgba(15, 23, 42, 0.16)' : 'rgba(255, 255, 255, 0.14)';
  const text = isLight ? '#0f172a' : '#f1f5f9';
  const badgeBg = isLight ? 'rgba(37, 99, 235, 0.12)' : 'rgba(56, 189, 248, 0.16)';
  const badgeFg = isLight ? '#1d4ed8' : '#7dd3fc';
  return `
[${SECTION_GROUP_ATTR}] {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
[${SECTION_BTN_ATTR}] {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 30px;
  padding: 5px 11px;
  border-radius: 7px;
  border: 1px solid ${border};
  background: ${bg};
  color: ${text};
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.25;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 140ms ease, border-color 140ms ease, opacity 140ms ease;
}
[${SECTION_BTN_ATTR}]:hover:not(:disabled) {
  background: ${hoverBg};
}
[${SECTION_BTN_ATTR}]:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}
[${SECTION_BTN_ATTR}]:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
[${SECTION_BTN_ATTR}] .ag-sec-act-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 600;
  background: ${badgeBg};
  color: ${badgeFg};
}
@media (prefers-reduced-motion: reduce) {
  [${SECTION_BTN_ATTR}] { transition: none; }
}
`;
}

function applyShieldAttrs(el, extraNoTranslateAttributes) {
  if (!el || typeof el.setAttribute !== 'function') return;
  el.setAttribute('translate', 'no');
  el.setAttribute('data-addon-host-no-translate', 'true');
  el.setAttribute('data-addon-host-ignore', 'true');
  if (_ArrayIsArray(extraNoTranslateAttributes)) {
    for (let i = 0; i < extraNoTranslateAttributes.length; i += 1) {
      const attr = extraNoTranslateAttributes[i];
      if (typeof attr === 'string' && attr) {
        try {
          el.setAttribute(attr, 'true');
        } catch (_e) {}
      }
    }
  }
}

const DEFAULT_LABEL_SELECTORS = 'h1, h2, h3, h4, h5, h6, [role="heading"], button, span, summary';
const DEFAULT_EXCLUDE_ANCESTORS = ['aside', 'nav', 'pre', 'code', '[contenteditable="true"]'];
const COUNT_SUFFIX_RE = /\s*(?:\(\s*\d+\s*\)|\d+)$/;
const MAX_LABEL_TEXT_LEN = 64;

function matchesSimpleSelector(el, sel) {
  if (!el || el.nodeType !== 1 || typeof sel !== 'string') return false;
  const trimmed = sel.trim();
  if (!trimmed) return false;
  if (typeof el.matches === 'function') {
    try {
      return Boolean(el.matches(trimmed));
    } catch (_e) {}
  }
  const attrMatch = trimmed.match(/^([a-zA-Z0-9_-]+)?\[([^=\]]+)(?:="([^"]*)")?\]$/);
  if (attrMatch) {
    if (attrMatch[1] && _String(el.tagName || '').toLowerCase() !== attrMatch[1].toLowerCase()) return false;
    const val = typeof el.getAttribute === 'function' ? el.getAttribute(attrMatch[2]) : null;
    return val !== null && (attrMatch[3] === undefined || val === attrMatch[3]);
  }
  return _String(el.tagName || '').toLowerCase() === trimmed.toLowerCase();
}

function isInsideExcludedAncestor(el, excludeSelectors) {
  const allExcludes = ['[data-addon-host-ignore]', `[${SECTION_GROUP_ATTR}]`, ...DEFAULT_EXCLUDE_ANCESTORS];
  if (_ArrayIsArray(excludeSelectors)) {
    for (let i = 0; i < excludeSelectors.length; i += 1) {
      if (typeof excludeSelectors[i] === 'string' && excludeSelectors[i].trim()) {
        allExcludes.push(excludeSelectors[i].trim());
      }
    }
  }
  let cur = el;
  while (cur && cur.nodeType === 1) {
    for (let i = 0; i < allExcludes.length; i += 1) {
      if (matchesSimpleSelector(cur, allExcludes[i])) return true;
    }
    cur = cur.parentElement || cur.parentNode;
  }
  return false;
}

function matchesHeadingText(rawText, headingTexts, allowCountSuffix) {
  const txt = normalizeText(rawText);
  if (!txt || txt.length > MAX_LABEL_TEXT_LEN) return false;
  if (headingTexts.includes(txt)) return true;
  if (allowCountSuffix !== false) {
    const stripped = txt.replace(COUNT_SUFFIX_RE, '').trim();
    if (stripped && headingTexts.includes(stripped)) return true;
  }
  return false;
}

function isInteractiveNode(node) {
  if (!node || node.nodeType !== 1) return false;
  const tag = _String(node.tagName || '').toUpperCase();
  if (tag === 'BUTTON' || tag === 'A') return true;
  if (typeof node.getAttribute === 'function' && node.getAttribute('role') === 'button') return true;
  return false;
}

function findHeaderRowMount(matchedEl, doc, targetConfig) {
  const maxDepth =
    Number.isInteger(targetConfig.maxParentDepth) && targetConfig.maxParentDepth >= 1
      ? Math.min(8, targetConfig.maxParentDepth)
      : 5;
  const requireSiblingActions = targetConfig.requireSiblingActions === true;

  let branch = matchedEl;
  let row = branch ? branch.parentElement || branch.parentNode : null;

  for (let depth = 1; depth <= maxDepth && row && row.nodeType === 1; depth += 1) {
    if (row === doc || row === doc.body || row === doc.documentElement) {
      break;
    }
    const rawChildren = _ArrayFrom(row.children || row.childNodes || []).filter(
      (node) =>
        node &&
        node.nodeType === 1 &&
        !(typeof node.getAttribute === 'function' && node.getAttribute(SECTION_GROUP_ATTR))
    );
    const branchIdx = rawChildren.indexOf(branch);
    const siblings = rawChildren.filter((node) => node !== branch);

    // Priority 1: sibling container (div/span/nav) holding interactive buttons on the same header row
    for (let i = siblings.length - 1; i >= 0; i -= 1) {
      const sib = siblings[i];
      const tag = _String(sib.tagName || '').toUpperCase();
      if (tag === 'DIV' || tag === 'SPAN' || tag === 'NAV') {
        const hasInteractive =
          typeof sib.querySelector === 'function' && Boolean(sib.querySelector('button, a, [role="button"]'));
        if (hasInteractive) {
          return {
            container: sib,
            insertPosition: targetConfig.insertPosition || 'before-first-child',
          };
        }
      }
    }

    // Priority 2: direct interactive button/link siblings on the same header row
    let firstDirectInteractive = null;
    for (let i = 0; i < rawChildren.length; i += 1) {
      const child = rawChildren[i];
      if (child === branch) continue;
      if (isInteractiveNode(child)) {
        if (branchIdx !== -1 && i > branchIdx) {
          firstDirectInteractive = child;
          break;
        }
        if (!firstDirectInteractive) firstDirectInteractive = child;
      }
    }
    if (firstDirectInteractive) {
      return {
        container: row,
        insertPosition: 'before-node',
        referenceNode: firstDirectInteractive,
      };
    }

    branch = row;
    row = branch.parentElement || branch.parentNode;
  }

  if (requireSiblingActions) {
    return null;
  }

  const directParent = matchedEl.parentElement || matchedEl.parentNode;
  if (!directParent || directParent === doc || directParent === doc.body || directParent === doc.documentElement) {
    return null;
  }
  return {
    container: directParent,
    insertPosition: 'append',
  };
}

function resolveTargetMountPoint(doc, targetConfig) {
  if (!doc || !targetConfig || typeof targetConfig !== 'object') return null;
  const rootSelectors = _ArrayIsArray(targetConfig.rootSelectors) ? targetConfig.rootSelectors : [];
  let root = null;
  if (rootSelectors.length > 0 && typeof doc.querySelector === 'function') {
    for (let i = 0; i < rootSelectors.length; i += 1) {
      const sel = rootSelectors[i];
      if (typeof sel !== 'string' || !sel.trim()) continue;
      try {
        const hit = doc.querySelector(sel);
        if (hit) {
          root = hit;
          break;
        }
      } catch (_e) {}
    }
    if (!root) {
      if (targetConfig.fallbackToDocumentRoot === true) {
        root = doc.body || doc.documentElement || doc;
      } else {
        return null;
      }
    }
  } else {
    root = doc.body || doc.documentElement || doc;
  }

  const containerSelectors = _ArrayIsArray(targetConfig.containerSelectors) ? targetConfig.containerSelectors : [];
  if (containerSelectors.length > 0 && root && typeof root.querySelector === 'function') {
    for (let i = 0; i < containerSelectors.length; i += 1) {
      const sel = containerSelectors[i];
      if (typeof sel !== 'string' || !sel.trim()) continue;
      try {
        const hit = root.querySelector(sel);
        if (hit) {
          return {
            container: hit,
            insertPosition: targetConfig.insertPosition || 'before-first-child',
          };
        }
      } catch (_e) {}
    }
  }

  const headingTexts = _ArrayIsArray(targetConfig.headingTexts)
    ? targetConfig.headingTexts.map((t) => normalizeText(t)).filter(Boolean)
    : [];
  if (headingTexts.length === 0 || !root || typeof root.querySelectorAll !== 'function') {
    return null;
  }

  const labelSelectorStr =
    _ArrayIsArray(targetConfig.labelSelectors) && targetConfig.labelSelectors.length > 0
      ? targetConfig.labelSelectors.filter((s) => typeof s === 'string' && s.trim()).join(', ')
      : DEFAULT_LABEL_SELECTORS;
  const allowCountSuffix = targetConfig.allowCountSuffix !== false;
  const excludeAncestors = _ArrayIsArray(targetConfig.excludeAncestorSelectors)
    ? targetConfig.excludeAncestorSelectors
    : [];

  let candidates = [];
  try {
    candidates = _ArrayFrom(root.querySelectorAll(labelSelectorStr || DEFAULT_LABEL_SELECTORS));
  } catch (_e) {
    candidates = [];
  }

  const matched = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const el = candidates[i];
    if (!el || isInsideExcludedAncestor(el, excludeAncestors)) continue;
    if (matchesHeadingText(el.textContent, headingTexts, allowCountSuffix)) {
      matched.push(el);
    }
  }
  if (matched.length === 0) return null;

  // Prefer innermost matching nodes first (e.g., <span>MCP 서버</span> before its wrapping <button>)
  const innermost = matched.filter(
    (el) => !matched.some((other) => other !== el && typeof el.contains === 'function' && el.contains(other))
  );
  const ordered = innermost.concat(matched.filter((el) => !innermost.includes(el)));

  for (let i = 0; i < ordered.length; i += 1) {
    const mount = findHeaderRowMount(ordered[i], doc, targetConfig);
    if (mount && mount.container) return mount;
  }
  return null;
}

function createSectionActionRegistry(
  doc,
  win,
  { uiSectionTargets = {}, themeAndI18n = null, extraNoTranslateAttributes = [] } = {}
) {
  const targetsConfig = uiSectionTargets && typeof uiSectionTargets === 'object' ? uiSectionTargets : {};
  const items = new _Map(); // key (`${pluginId}:${id}`) -> record
  const mountedGroups = new _Map(); // target -> wrapperEl
  let observer = null;
  let syncTimer = null;
  let styleEl = null;
  let unsubTheme = null;
  let disposed = false;

  function ensureStyle() {
    if (!doc || typeof doc.createElement !== 'function') return;
    const mode = themeAndI18n && typeof themeAndI18n.getSnapshot === 'function' ? themeAndI18n.getSnapshot().mode : 'dark';
    const css = buildSectionActionCss(mode);
    if (styleEl && styleEl.isConnected !== false) {
      styleEl.textContent = css;
      return;
    }
    const existing = typeof doc.querySelector === 'function' ? doc.querySelector(`style[${SECTION_STYLE_ATTR}="1"]`) : null;
    if (existing) {
      styleEl = existing;
      styleEl.textContent = css;
      return;
    }
    const parent = doc.head || doc.documentElement || doc.body;
    if (!parent || typeof parent.appendChild !== 'function') return;
    const el = doc.createElement('style');
    el.setAttribute(SECTION_STYLE_ATTR, '1');
    el.setAttribute('data-addon-host-ignore', 'true');
    el.textContent = css;
    parent.appendChild(el);
    styleEl = el;
  }

  function disconnectObserver() {
    if (syncTimer) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
    if (observer) {
      try {
        observer.disconnect();
      } catch (_e) {}
      observer = null;
    }
  }

  function ensureObserver() {
    if (disposed || observer || items.size === 0) return;
    const MO = (win && win.MutationObserver) || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
    const observeTarget = doc && (doc.body || doc.documentElement);
    if (!MO || !observeTarget) return;
    observer = new MO(() => {
      if (disposed || syncTimer) return;
      syncTimer = setTimeout(() => {
        syncTimer = null;
        if (!disposed) syncDomNow();
      }, 30);
    });
    try {
      observer.observe(observeTarget, { childList: true, subtree: true });
    } catch (_e) {
      observer = null;
    }
  }

  function removeGroupForTarget(target) {
    const grp = _MapGet(mountedGroups, target);
    if (grp && grp.parentNode && typeof grp.parentNode.removeChild === 'function') {
      try {
        grp.parentNode.removeChild(grp);
      } catch (_e) {}
    }
    _MapDelete(mountedGroups, target);
  }

  function buildButtonElement(rec) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.setAttribute(SECTION_BTN_ATTR, `${rec.pluginId}:${rec.id}`);
    btn.setAttribute('data-addon-host-owner', rec.pluginId);
    btn.setAttribute('data-addon-host-section-target', rec.target);
    if (rec.tooltip) btn.setAttribute('title', rec.tooltip);
    applyShieldAttrs(btn, extraNoTranslateAttributes);

    if (rec.icon) {
      const iconSpan = doc.createElement('span');
      iconSpan.className = 'ag-sec-act-icon';
      iconSpan.setAttribute('aria-hidden', 'true');
      iconSpan.textContent = rec.icon;
      btn.appendChild(iconSpan);
    }
    const labelSpan = doc.createElement('span');
    labelSpan.className = 'ag-sec-act-label';
    labelSpan.textContent = rec.label;
    btn.appendChild(labelSpan);

    if (rec.badge) {
      const badgeSpan = doc.createElement('span');
      badgeSpan.className = 'ag-sec-act-badge';
      badgeSpan.textContent = rec.badge;
      btn.appendChild(badgeSpan);
    }

    btn.addEventListener('click', (ev) => {
      if (ev && ev.isTrusted === false) return;
      invokeRecord(rec, {
        shiftKey: Boolean(ev && ev.shiftKey),
        ctrlKey: Boolean(ev && ev.ctrlKey),
        metaKey: Boolean(ev && ev.metaKey),
        altKey: Boolean(ev && ev.altKey),
        anchorEl: btn,
      });
    });

    rec.buttonEl = btn;
    return btn;
  }

  function invokeRecord(rec, clickEv = {}) {
    if (!rec || typeof rec.onClick !== 'function') {
      return { ok: false, reason: 'ERR_SECTION_ACTION_NO_HANDLER' };
    }
    const payload = _ObjectFreeze({
      pluginId: rec.pluginId,
      actionId: rec.id,
      target: rec.target,
      shiftKey: Boolean(clickEv && clickEv.shiftKey),
      ctrlKey: Boolean(clickEv && clickEv.ctrlKey),
      metaKey: Boolean(clickEv && clickEv.metaKey),
      altKey: Boolean(clickEv && clickEv.altKey),
      anchorEl: (clickEv && clickEv.anchorEl) || rec.buttonEl || null,
    });
    try {
      rec.onClick(payload);
      return { ok: true, reason: null };
    } catch (err) {
      return { ok: false, reason: err && err.message ? err.message : 'ERR_SECTION_ACTION_CLICK_FAILED' };
    }
  }

  function syncDomNow() {
    if (disposed || !doc || typeof doc.createElement !== 'function') return;

    // Group active items by target
    const byTarget = new _Map();
    for (const rec of _MapValues(items)) {
      let arr = _MapGet(byTarget, rec.target);
      if (!arr) {
        arr = [];
        _MapSet(byTarget, rec.target, arr);
      }
      arr.push(rec);
    }

    // Remove mounted groups whose targets no longer have items
    for (const existingTarget of _ArrayFrom(mountedGroups.keys())) {
      if (!byTarget.has(existingTarget)) {
        removeGroupForTarget(existingTarget);
      }
    }

    if (byTarget.size === 0) {
      disconnectObserver();
      return;
    }

    ensureStyle();

    for (const [target, targetItems] of byTarget.entries()) {
      const targetCfg = Object.prototype.hasOwnProperty.call(targetsConfig, target) ? targetsConfig[target] : null;
      const mount = resolveTargetMountPoint(doc, targetCfg);
      if (!mount || !mount.container) {
        removeGroupForTarget(target);
        continue;
      }

      targetItems.sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        return a.seq - b.seq;
      });

      let grp = _MapGet(mountedGroups, target);
      if (!grp || grp.parentNode !== mount.container) {
        if (grp && grp.parentNode && typeof grp.parentNode.removeChild === 'function') {
          try {
            grp.parentNode.removeChild(grp);
          } catch (_e) {}
        }
        grp = doc.createElement('span');
        grp.setAttribute(SECTION_GROUP_ATTR, target);
        applyShieldAttrs(grp, extraNoTranslateAttributes);

        if (
          mount.insertPosition === 'before-node' &&
          mount.referenceNode &&
          mount.referenceNode.parentNode === mount.container &&
          typeof mount.container.insertBefore === 'function'
        ) {
          mount.container.insertBefore(grp, mount.referenceNode);
        } else if (
          (mount.insertPosition === 'before-first-child' || mount.insertPosition === 'prepend') &&
          mount.container.firstChild &&
          typeof mount.container.insertBefore === 'function'
        ) {
          mount.container.insertBefore(grp, mount.container.firstChild);
        } else if (typeof mount.container.appendChild === 'function') {
          mount.container.appendChild(grp);
        }
        _MapSet(mountedGroups, target, grp);
      }

      while (grp.firstChild) {
        grp.removeChild(grp.firstChild);
      }
      for (let i = 0; i < targetItems.length; i += 1) {
        grp.appendChild(buildButtonElement(targetItems[i]));
      }
    }
  }

  let seqCounter = 0;

  if (themeAndI18n && typeof themeAndI18n.createThemeHandle === 'function') {
    try {
      const th = themeAndI18n.createThemeHandle();
      if (th && typeof th.onDidChange === 'function') {
        unsubTheme = th.onDidChange(() => {
          if (!disposed && styleEl) ensureStyle();
        });
      }
    } catch (_e) {}
  }

  function registerSectionAction(pluginId, spec = {}) {
    if (!spec || typeof spec !== 'object') {
      throw new Error('ERR_INVALID_SECTION_ACTION_SPEC');
    }
    const id = typeof spec.id === 'string' ? spec.id.trim() : '';
    if (!id || !SAFE_ACTION_ID_RE.test(id)) {
      throw new Error('ERR_INVALID_SECTION_ACTION_ID');
    }
    const target = typeof spec.target === 'string' ? spec.target.trim() : '';
    if (!target || !SAFE_TARGET_ID_RE.test(target)) {
      throw new Error('ERR_INVALID_SECTION_ACTION_TARGET');
    }
    const label = typeof spec.label === 'string' && spec.label.trim() ? spec.label.trim() : '';
    if (!label) {
      throw new Error('ERR_INVALID_SECTION_ACTION_LABEL');
    }

    const key = `${pluginId}:${id}`;
    seqCounter += 1;
    const record = {
      key,
      pluginId,
      id,
      target,
      label,
      icon: typeof spec.icon === 'string' ? spec.icon : '',
      tooltip: typeof spec.tooltip === 'string' ? spec.tooltip : '',
      badge: spec.badge !== undefined && spec.badge !== null ? _String(spec.badge) : null,
      order: _NumberIsFinite(_Number(spec.order)) ? _Number(spec.order) : 100,
      onClick: typeof spec.onClick === 'function' ? spec.onClick : null,
      seq: seqCounter,
      buttonEl: null,
    };
    _MapSet(items, key, record);
    syncDomNow();
    ensureObserver();

    let handleDisposed = false;
    return _ObjectFreeze({
      id,
      target,
      update(patch = {}) {
        if (handleDisposed || disposed || !patch || typeof patch !== 'object') return;
        if (typeof patch.label === 'string' && patch.label.trim()) record.label = patch.label.trim();
        if (patch.icon !== undefined) record.icon = typeof patch.icon === 'string' ? patch.icon : '';
        if (patch.tooltip !== undefined) record.tooltip = typeof patch.tooltip === 'string' ? patch.tooltip : '';
        if (patch.badge !== undefined) record.badge = patch.badge === null ? null : _String(patch.badge);
        if (patch.order !== undefined && _NumberIsFinite(_Number(patch.order))) record.order = _Number(patch.order);
        syncDomNow();
      },
      dispose() {
        if (handleDisposed) return;
        handleDisposed = true;
        if (_MapGet(items, key) === record) {
          _MapDelete(items, key);
          syncDomNow();
        }
      },
    });
  }

  function listSectionActions() {
    const out = [];
    for (const rec of _MapValues(items)) {
      out.push(
        _ObjectFreeze({
          pluginId: rec.pluginId,
          id: rec.id,
          target: rec.target,
          label: rec.label,
          icon: rec.icon,
          tooltip: rec.tooltip,
          badge: rec.badge,
          order: rec.order,
          mounted: Boolean(rec.buttonEl && rec.buttonEl.parentNode),
        })
      );
    }
    return _ObjectFreeze(out);
  }

  function invokeSectionAction(pluginId, actionId, clickEv = {}) {
    const rec = _MapGet(items, `${pluginId}:${actionId}`);
    if (!rec) {
      return { ok: false, reason: `ERR_SECTION_ACTION_NOT_FOUND:${pluginId}:${actionId}` };
    }
    return invokeRecord(rec, clickEv);
  }

  function disposePlugin(pluginId) {
    let changed = false;
    for (const rec of _ArrayFrom(_MapValues(items))) {
      if (rec.pluginId === pluginId) {
        _MapDelete(items, rec.key);
        changed = true;
      }
    }
    if (changed) syncDomNow();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    disconnectObserver();
    if (typeof unsubTheme === 'function') {
      try {
        unsubTheme();
      } catch (_e) {}
      unsubTheme = null;
    }
    items.clear();
    for (const target of _ArrayFrom(mountedGroups.keys())) {
      removeGroupForTarget(target);
    }
    if (styleEl && styleEl.parentNode && typeof styleEl.parentNode.removeChild === 'function') {
      try {
        styleEl.parentNode.removeChild(styleEl);
      } catch (_e) {}
    }
    styleEl = null;
  }

  return _ObjectFreeze({
    registerSectionAction,
    listSectionActions,
    invokeSectionAction,
    syncDomNow,
    disposePlugin,
    dispose,
    getConfiguredTargets: () => _ObjectFreeze(_ObjectKeys(targetsConfig)),
  });
}

module.exports = {
  SECTION_STYLE_ATTR,
  SECTION_GROUP_ATTR,
  SECTION_BTN_ATTR,
  createSectionActionRegistry,
};
