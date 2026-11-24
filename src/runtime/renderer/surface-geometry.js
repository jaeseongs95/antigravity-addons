'use strict';

/**
 * Vendor-neutral Per-Surface Content Bounds & Center-Point Geometry Engine (v2.4.0 — SOLID #0).
 *
 * - ZERO vendor/app-specific literals: every surface selector, priority, chrome-exclusion
 *   selector, and safe inset comes declaratively from `HostProfile.uiSurfaces` / `uiAnchors`.
 * - Ignores addon-host modal/popover portals (`[data-addon-host-modal-dialog]`,
 *   `[data-addon-host-popover]`) so open plugin overlays never distort host surface measurements.
 * - Resolution order per surface:
 *   1. Direct visible container matching `selectors` (`source: 'selector'`).
 *   2. Viewport minus visible edge chrome matching `exclude{Left,Right,Top,Bottom}Selectors`
 *      (`source: 'chrome-subtracted'`).
 *   3. Optional caller-provided `anchorEl` nearest inset content-pane ancestor
 *      (`source: 'anchor-container'`).
 *   4. Safe viewport fallback (`source: 'viewport'`).
 * - Always returns finite, viewport-clamped, deep-frozen coordinates including `centerX`,
 *   `centerY`, bounding box (`left/top/right/bottom/width/height`), and CSS fixed insets
 *   (`insetLeft/insetTop/insetRight/insetBottom`).
 */

const _ObjectFreeze = Object.freeze;
const _ObjectKeys = Object.keys;
const _ArrayIsArray = Array.isArray;
const _Number = Number;
const _NumberIsFinite = Number.isFinite;
const _MathMax = Math.max;
const _MathMin = Math.min;
const _MathRound = Math.round;

const EDGE_TOUCH_TOLERANCE_PX = 12;

function toNonNegativeNumber(value, fallback = 0) {
  const n = _Number(value);
  return _NumberIsFinite(n) && n >= 0 ? n : fallback;
}

function roundCoord(value) {
  return _MathRound(value * 100) / 100;
}

function normalizeStringList(list) {
  if (!_ArrayIsArray(list)) return [];
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const s = list[i];
    if (typeof s === 'string' && s.trim()) {
      out.push(s.trim());
    }
  }
  return out;
}

function normalizeSafeInsets(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return _ObjectFreeze({
    top: toNonNegativeNumber(src.top, 0),
    right: toNonNegativeNumber(src.right, 0),
    bottom: toNonNegativeNumber(src.bottom, 0),
    left: toNonNegativeNumber(src.left, 0),
  });
}

function createSurfaceGeometry(doc, win, { uiSurfaces = {}, uiAnchors = {} } = {}) {
  const surfaceSpecs = new Map();
  const orderedIds = [];

  if (uiSurfaces && typeof uiSurfaces === 'object') {
    const keys = _ObjectKeys(uiSurfaces);
    for (let i = 0; i < keys.length; i += 1) {
      const id = keys[i];
      if (!id || id === 'viewport' || id === 'auto' || id === 'active') continue;
      const raw = uiSurfaces[id];
      if (!raw || typeof raw !== 'object' || _ArrayIsArray(raw)) continue;
      const anchorFallback = uiAnchors && _ArrayIsArray(uiAnchors[id]) ? uiAnchors[id] : [];
      const selectors = normalizeStringList(raw.selectors);
      const mergedSelectors = selectors.length > 0 ? selectors : normalizeStringList(anchorFallback);
      const spec = _ObjectFreeze({
        id,
        priority: _NumberIsFinite(_Number(raw.priority)) ? _Number(raw.priority) : 0,
        selectors: _ObjectFreeze(mergedSelectors),
        excludeLeftSelectors: _ObjectFreeze(normalizeStringList(raw.excludeLeftSelectors)),
        excludeRightSelectors: _ObjectFreeze(normalizeStringList(raw.excludeRightSelectors)),
        excludeTopSelectors: _ObjectFreeze(normalizeStringList(raw.excludeTopSelectors)),
        excludeBottomSelectors: _ObjectFreeze(normalizeStringList(raw.excludeBottomSelectors)),
        safeInsets: normalizeSafeInsets(raw.safeInsets),
      });
      surfaceSpecs.set(id, spec);
      orderedIds.push(id);
    }
  }

  // Sort surfaces by priority descending (stable tie-break by id)
  orderedIds.sort((a, b) => {
    const pa = surfaceSpecs.get(a).priority;
    const pb = surfaceSpecs.get(b).priority;
    if (pb !== pa) return pb - pa;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  // Compute default viewport safeInsets from the highest-priority declared surface if any
  let defaultSafeTop = 0;
  let defaultSafeRight = 0;
  let defaultSafeBottom = 0;
  let defaultSafeLeft = 0;
  for (let i = 0; i < orderedIds.length; i += 1) {
    const s = surfaceSpecs.get(orderedIds[i]).safeInsets;
    if (s.top > defaultSafeTop) defaultSafeTop = s.top;
    if (s.right > defaultSafeRight) defaultSafeRight = s.right;
    if (s.bottom > defaultSafeBottom) defaultSafeBottom = s.bottom;
    if (s.left > defaultSafeLeft) defaultSafeLeft = s.left;
  }
  const defaultSafeInsets = _ObjectFreeze({
    top: defaultSafeTop,
    right: defaultSafeRight,
    bottom: defaultSafeBottom,
    left: defaultSafeLeft,
  });

  function getViewportSize() {
    const docEl = doc && doc.documentElement ? doc.documentElement : null;
    const w =
      win && _NumberIsFinite(_Number(win.innerWidth)) && _Number(win.innerWidth) > 0
        ? _Number(win.innerWidth)
        : docEl && _NumberIsFinite(_Number(docEl.clientWidth)) && _Number(docEl.clientWidth) > 0
          ? _Number(docEl.clientWidth)
          : 0;
    const h =
      win && _NumberIsFinite(_Number(win.innerHeight)) && _Number(win.innerHeight) > 0
        ? _Number(win.innerHeight)
        : docEl && _NumberIsFinite(_Number(docEl.clientHeight)) && _Number(docEl.clientHeight) > 0
          ? _Number(docEl.clientHeight)
          : 0;
    return { width: w, height: h };
  }

  function isInsideAddonPortal(el) {
    if (!el) return false;
    if (typeof el.closest === 'function') {
      try {
        if (el.closest('[data-addon-host-modal-dialog]') || el.closest('[data-addon-host-popover]')) {
          return true;
        }
      } catch (_e) {}
    }
    let cur = el;
    let guard = 0;
    while (cur && guard < 64) {
      guard += 1;
      if (typeof cur.getAttribute === 'function') {
        try {
          if (cur.getAttribute('data-addon-host-modal-dialog') || cur.getAttribute('data-addon-host-popover')) {
            return true;
          }
        } catch (_e) {}
      }
      cur = cur.parentNode;
    }
    return false;
  }

  function readVisibleRect(el) {
    if (!el || isInsideAddonPortal(el)) return null;
    if (el.isConnected === false) return null;
    if (win && typeof win.getComputedStyle === 'function') {
      try {
        const cs = win.getComputedStyle(el);
        if (cs) {
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') {
            return null;
          }
        }
      } catch (_e) {}
    }
    if (typeof el.getBoundingClientRect !== 'function') return null;
    let rect;
    try {
      rect = el.getBoundingClientRect();
    } catch (_e) {
      return null;
    }
    if (!rect || typeof rect !== 'object') return null;
    const left = _Number(rect.left);
    const top = _Number(rect.top);
    const width = _Number(rect.width);
    const height = _Number(rect.height);
    if (!_NumberIsFinite(left) || !_NumberIsFinite(top) || !_NumberIsFinite(width) || !_NumberIsFinite(height)) {
      return null;
    }
    if (width <= 0 || height <= 0) return null;
    const right = _NumberIsFinite(_Number(rect.right)) ? _Number(rect.right) : left + width;
    const bottom = _NumberIsFinite(_Number(rect.bottom)) ? _Number(rect.bottom) : top + height;
    return { left, top, right, bottom, width, height };
  }

  function queryMatchingElements(selector) {
    if (!doc || !selector) return [];
    if (typeof doc.querySelectorAll === 'function') {
      try {
        const list = doc.querySelectorAll(selector);
        if (list && typeof list.length === 'number') {
          const out = [];
          for (let i = 0; i < list.length; i += 1) {
            if (list[i]) out.push(list[i]);
          }
          return out;
        }
      } catch (_e) {
        return [];
      }
    }
    if (typeof doc.querySelector === 'function') {
      try {
        const one = doc.querySelector(selector);
        return one ? [one] : [];
      } catch (_e) {
        return [];
      }
    }
    return [];
  }

  function findFirstVisibleSelectorRect(selectors) {
    for (let i = 0; i < selectors.length; i += 1) {
      const els = queryMatchingElements(selectors[i]);
      for (let j = 0; j < els.length; j += 1) {
        const rect = readVisibleRect(els[j]);
        if (rect) return rect;
      }
    }
    return null;
  }

  function computeSafeViewportRect(safeInsets, vw, vh) {
    const left = _MathMin(vw, toNonNegativeNumber(safeInsets.left, 0));
    const top = _MathMin(vh, toNonNegativeNumber(safeInsets.top, 0));
    const right = _MathMax(left, vw - toNonNegativeNumber(safeInsets.right, 0));
    const bottom = _MathMax(top, vh - toNonNegativeNumber(safeInsets.bottom, 0));
    return { left, top, right, bottom };
  }

  function buildBoundsDto({ surfaceId, requestedSurfaceId, matched, source, left, top, right, bottom, vw, vh }) {
    const clampedLeft = vw > 0 ? _MathMax(0, _MathMin(vw, left)) : _MathMax(0, left);
    const clampedTop = vh > 0 ? _MathMax(0, _MathMin(vh, top)) : _MathMax(0, top);
    const clampedRight = vw > 0 ? _MathMax(clampedLeft, _MathMin(vw, right)) : _MathMax(clampedLeft, right);
    const clampedBottom = vh > 0 ? _MathMax(clampedTop, _MathMin(vh, bottom)) : _MathMax(clampedTop, bottom);
    const width = clampedRight - clampedLeft;
    const height = clampedBottom - clampedTop;
    const insetRight = vw > 0 ? _MathMax(0, vw - clampedRight) : 0;
    const insetBottom = vh > 0 ? _MathMax(0, vh - clampedBottom) : 0;

    return _ObjectFreeze({
      surfaceId,
      requestedSurfaceId,
      matched: Boolean(matched),
      source,
      left: roundCoord(clampedLeft),
      top: roundCoord(clampedTop),
      right: roundCoord(clampedRight),
      bottom: roundCoord(clampedBottom),
      width: roundCoord(width),
      height: roundCoord(height),
      centerX: roundCoord(clampedLeft + width / 2),
      centerY: roundCoord(clampedTop + height / 2),
      insetLeft: roundCoord(clampedLeft),
      insetTop: roundCoord(clampedTop),
      insetRight: roundCoord(insetRight),
      insetBottom: roundCoord(insetBottom),
      viewport: _ObjectFreeze({
        width: roundCoord(vw),
        height: roundCoord(vh),
      }),
    });
  }

  function measureBySelector(spec, safeRect, vw, vh) {
    if (!spec || spec.selectors.length === 0) return null;
    const rect = findFirstVisibleSelectorRect(spec.selectors);
    if (!rect) return null;
    const left = vw > 0 ? _MathMax(safeRect.left, rect.left) : rect.left;
    const top = vh > 0 ? _MathMax(safeRect.top, rect.top) : rect.top;
    const right = vw > 0 ? _MathMin(safeRect.right, rect.right) : rect.right;
    const bottom = vh > 0 ? _MathMin(safeRect.bottom, rect.bottom) : rect.bottom;
    if (right <= left || bottom <= top) return null;
    return { left, top, right, bottom };
  }

  function measureByChromeSubtraction(spec, safeRect, vw, vh) {
    if (!spec || vw <= 0 || vh <= 0) return null;
    const hasChrome =
      spec.excludeLeftSelectors.length > 0 ||
      spec.excludeRightSelectors.length > 0 ||
      spec.excludeTopSelectors.length > 0 ||
      spec.excludeBottomSelectors.length > 0;
    if (!hasChrome) return null;

    let left = safeRect.left;
    let top = safeRect.top;
    let right = safeRect.right;
    let bottom = safeRect.bottom;
    let subtracted = false;

    for (let i = 0; i < spec.excludeLeftSelectors.length; i += 1) {
      const els = queryMatchingElements(spec.excludeLeftSelectors[i]);
      for (let j = 0; j < els.length; j += 1) {
        const r = readVisibleRect(els[j]);
        if (!r) continue;
        if (r.left <= safeRect.left + EDGE_TOUCH_TOLERANCE_PX && r.height >= vh * 0.4 && r.right < vw * 0.65) {
          if (r.right > left) {
            left = r.right;
            subtracted = true;
          }
        }
      }
    }

    for (let i = 0; i < spec.excludeRightSelectors.length; i += 1) {
      const els = queryMatchingElements(spec.excludeRightSelectors[i]);
      for (let j = 0; j < els.length; j += 1) {
        const r = readVisibleRect(els[j]);
        if (!r) continue;
        if (r.right >= safeRect.right - EDGE_TOUCH_TOLERANCE_PX && r.height >= vh * 0.4 && r.left > vw * 0.35) {
          if (r.left < right) {
            right = r.left;
            subtracted = true;
          }
        }
      }
    }

    for (let i = 0; i < spec.excludeTopSelectors.length; i += 1) {
      const els = queryMatchingElements(spec.excludeTopSelectors[i]);
      for (let j = 0; j < els.length; j += 1) {
        const r = readVisibleRect(els[j]);
        if (!r) continue;
        if (r.top <= safeRect.top + EDGE_TOUCH_TOLERANCE_PX && r.width >= vw * 0.4 && r.bottom < vh * 0.4) {
          if (r.bottom > top) {
            top = r.bottom;
            subtracted = true;
          }
        }
      }
    }

    for (let i = 0; i < spec.excludeBottomSelectors.length; i += 1) {
      const els = queryMatchingElements(spec.excludeBottomSelectors[i]);
      for (let j = 0; j < els.length; j += 1) {
        const r = readVisibleRect(els[j]);
        if (!r) continue;
        if (r.bottom >= safeRect.bottom - EDGE_TOUCH_TOLERANCE_PX && r.width >= vw * 0.4 && r.top > vh * 0.6) {
          if (r.top < bottom) {
            bottom = r.top;
            subtracted = true;
          }
        }
      }
    }

    if (!subtracted) return null;
    const minWidth = _MathMin(200, vw * 0.25);
    const minHeight = _MathMin(120, vh * 0.25);
    if (right - left < minWidth || bottom - top < minHeight) {
      return null;
    }
    return { left, top, right, bottom };
  }

  function measureByAnchorContainer(anchorEl, safeRect, vw, vh) {
    if (!anchorEl || typeof anchorEl !== 'object' || vw <= 0 || vh <= 0) return null;
    if (anchorEl.isConnected === false || isInsideAddonPortal(anchorEl)) return null;
    const minWidth = _MathMin(240, vw * 0.25);
    const minHeight = _MathMin(240, vh * 0.45);
    const bodyEl = doc && doc.body ? doc.body : null;
    const docEl = doc && doc.documentElement ? doc.documentElement : null;

    let best = null;
    let bestArea = 0;
    let cur = anchorEl.parentNode;
    let guard = 0;
    while (cur && guard < 32) {
      guard += 1;
      if (cur === bodyEl || cur === docEl) break;
      const r = readVisibleRect(cur);
      if (r) {
        const left = _MathMax(safeRect.left, r.left);
        const top = _MathMax(safeRect.top, r.top);
        const right = _MathMin(safeRect.right, r.right);
        const bottom = _MathMin(safeRect.bottom, r.bottom);
        const w = right - left;
        const h = bottom - top;
        const isHorizontallyInset = left >= safeRect.left + 16 || right <= safeRect.right - 16;
        if (w >= minWidth && h >= minHeight && w < vw - 16 && isHorizontallyInset) {
          const area = w * h;
          if (area >= bestArea) {
            bestArea = area;
            best = { left, top, right, bottom };
          }
        }
      }
      cur = cur.parentNode;
    }
    return best;
  }

  function getActiveSurface(anchorEl = null) {
    const { width: vw, height: vh } = getViewportSize();

    // Pass 1: highest-priority direct selector match wins
    for (let i = 0; i < orderedIds.length; i += 1) {
      const id = orderedIds[i];
      const spec = surfaceSpecs.get(id);
      const safeRect = computeSafeViewportRect(spec.safeInsets, vw, vh);
      const matchedRect = measureBySelector(spec, safeRect, vw, vh);
      if (matchedRect) {
        return buildBoundsDto({
          surfaceId: id,
          requestedSurfaceId: 'auto',
          matched: true,
          source: 'selector',
          left: matchedRect.left,
          top: matchedRect.top,
          right: matchedRect.right,
          bottom: matchedRect.bottom,
          vw,
          vh,
        });
      }
    }

    // Pass 2: highest-priority chrome-subtracted match wins
    for (let i = 0; i < orderedIds.length; i += 1) {
      const id = orderedIds[i];
      const spec = surfaceSpecs.get(id);
      const safeRect = computeSafeViewportRect(spec.safeInsets, vw, vh);
      const chromeRect = measureByChromeSubtraction(spec, safeRect, vw, vh);
      if (chromeRect) {
        return buildBoundsDto({
          surfaceId: id,
          requestedSurfaceId: 'auto',
          matched: true,
          source: 'chrome-subtracted',
          left: chromeRect.left,
          top: chromeRect.top,
          right: chromeRect.right,
          bottom: chromeRect.bottom,
          vw,
          vh,
        });
      }
    }

    // Pass 3: caller-supplied anchor element ancestor pane fallback
    if (anchorEl) {
      const fallbackSafeRect = computeSafeViewportRect(defaultSafeInsets, vw, vh);
      const anchorRect = measureByAnchorContainer(anchorEl, fallbackSafeRect, vw, vh);
      if (anchorRect) {
        return buildBoundsDto({
          surfaceId: 'viewport',
          requestedSurfaceId: 'auto',
          matched: true,
          source: 'anchor-container',
          left: anchorRect.left,
          top: anchorRect.top,
          right: anchorRect.right,
          bottom: anchorRect.bottom,
          vw,
          vh,
        });
      }
    }

    const fallbackRect = computeSafeViewportRect(defaultSafeInsets, vw, vh);
    return buildBoundsDto({
      surfaceId: 'viewport',
      requestedSurfaceId: 'auto',
      matched: false,
      source: 'viewport',
      left: fallbackRect.left,
      top: fallbackRect.top,
      right: fallbackRect.right,
      bottom: fallbackRect.bottom,
      vw,
      vh,
    });
  }

  function getSurfaceBounds(surfaceIdOrOpts) {
    let requested = 'auto';
    let anchorEl = null;
    if (typeof surfaceIdOrOpts === 'string' && surfaceIdOrOpts.trim()) {
      requested = surfaceIdOrOpts.trim();
    } else if (surfaceIdOrOpts && typeof surfaceIdOrOpts === 'object') {
      if (typeof surfaceIdOrOpts.surface === 'string' && surfaceIdOrOpts.surface.trim()) {
        requested = surfaceIdOrOpts.surface.trim();
      }
      if (surfaceIdOrOpts.anchorEl && typeof surfaceIdOrOpts.anchorEl === 'object') {
        anchorEl = surfaceIdOrOpts.anchorEl;
      }
    }

    if (requested === 'auto' || requested === 'active') {
      return getActiveSurface(anchorEl);
    }

    const { width: vw, height: vh } = getViewportSize();

    if (requested === 'viewport') {
      const safeRect = computeSafeViewportRect(defaultSafeInsets, vw, vh);
      return buildBoundsDto({
        surfaceId: 'viewport',
        requestedSurfaceId: 'viewport',
        matched: true,
        source: 'viewport',
        left: safeRect.left,
        top: safeRect.top,
        right: safeRect.right,
        bottom: safeRect.bottom,
        vw,
        vh,
      });
    }

    const spec = surfaceSpecs.get(requested);
    if (spec) {
      const safeRect = computeSafeViewportRect(spec.safeInsets, vw, vh);
      const matchedRect = measureBySelector(spec, safeRect, vw, vh);
      if (matchedRect) {
        return buildBoundsDto({
          surfaceId: requested,
          requestedSurfaceId: requested,
          matched: true,
          source: 'selector',
          left: matchedRect.left,
          top: matchedRect.top,
          right: matchedRect.right,
          bottom: matchedRect.bottom,
          vw,
          vh,
        });
      }
      const chromeRect = measureByChromeSubtraction(spec, safeRect, vw, vh);
      if (chromeRect) {
        return buildBoundsDto({
          surfaceId: requested,
          requestedSurfaceId: requested,
          matched: true,
          source: 'chrome-subtracted',
          left: chromeRect.left,
          top: chromeRect.top,
          right: chromeRect.right,
          bottom: chromeRect.bottom,
          vw,
          vh,
        });
      }
      const anchorRect = measureByAnchorContainer(anchorEl, safeRect, vw, vh);
      if (anchorRect) {
        return buildBoundsDto({
          surfaceId: requested,
          requestedSurfaceId: requested,
          matched: true,
          source: 'anchor-container',
          left: anchorRect.left,
          top: anchorRect.top,
          right: anchorRect.right,
          bottom: anchorRect.bottom,
          vw,
          vh,
        });
      }
      return buildBoundsDto({
        surfaceId: requested,
        requestedSurfaceId: requested,
        matched: false,
        source: 'viewport',
        left: safeRect.left,
        top: safeRect.top,
        right: safeRect.right,
        bottom: safeRect.bottom,
        vw,
        vh,
      });
    }

    // Fallback to uiAnchors[requested] if declared only in uiAnchors
    if (uiAnchors && _ArrayIsArray(uiAnchors[requested])) {
      const anchorSelectors = normalizeStringList(uiAnchors[requested]);
      const safeRect = computeSafeViewportRect(defaultSafeInsets, vw, vh);
      const rect = findFirstVisibleSelectorRect(anchorSelectors);
      if (rect) {
        const left = vw > 0 ? _MathMax(safeRect.left, rect.left) : rect.left;
        const top = vh > 0 ? _MathMax(safeRect.top, rect.top) : rect.top;
        const right = vw > 0 ? _MathMin(safeRect.right, rect.right) : rect.right;
        const bottom = vh > 0 ? _MathMin(safeRect.bottom, rect.bottom) : rect.bottom;
        if (right > left && bottom > top) {
          return buildBoundsDto({
            surfaceId: requested,
            requestedSurfaceId: requested,
            matched: true,
            source: 'selector',
            left,
            top,
            right,
            bottom,
            vw,
            vh,
          });
        }
      }
    }

    const fallbackRect = computeSafeViewportRect(defaultSafeInsets, vw, vh);
    return buildBoundsDto({
      surfaceId: 'viewport',
      requestedSurfaceId: requested,
      matched: false,
      source: 'viewport',
      left: fallbackRect.left,
      top: fallbackRect.top,
      right: fallbackRect.right,
      bottom: fallbackRect.bottom,
      vw,
      vh,
    });
  }

  function listSurfaces() {
    return _ObjectFreeze([...orderedIds, 'viewport']);
  }

  return _ObjectFreeze({
    getSurfaceBounds,
    getActiveSurface,
    listSurfaces,
  });
}

module.exports = {
  createSurfaceGeometry,
};
