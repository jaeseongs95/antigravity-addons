'use strict';

/**
 * Vendor-neutral Overlay Placement Engine for Tier-2 UI (v3.0.0 — SOLID #0).
 *
 * Computes deterministic, viewport-safe coordinates from a plugin's declarative
 * `PlacementSpec`:
 * - `zone`: `'anchor' | 'surface-center' | 'corner' | 'sheet' | 'drawer'`
 * - Flip on primary axis when overflowing viewport (`bottom` <-> `top`, `right` <-> `left`)
 * - Shift clamping on cross axis within safe viewport insets
 * - Automatic mobile bottom-sheet switch when `viewport.width <= mobileBreakpointPx` (default 640)
 * - Live `resize` + `scroll` repositioning with deterministic disposer cleanup.
 */

const DEFAULT_OFFSET_PX = 8;
const DEFAULT_VIEWPORT_MARGIN_PX = 8;
const DEFAULT_MOBILE_BREAKPOINT_PX = 640;

function toFiniteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(val, min, max) {
  if (max < min) return min;
  return Math.max(min, Math.min(max, val));
}

function parsePrefer(rawPrefer) {
  const raw = typeof rawPrefer === 'string' ? rawPrefer.trim().toLowerCase() : 'bottom-start';
  const [sideRaw, alignRaw] = raw.split('-');
  const side = ['top', 'bottom', 'left', 'right'].includes(sideRaw) ? sideRaw : 'bottom';
  const align = ['start', 'center', 'end'].includes(alignRaw) ? alignRaw : 'start';
  return { side, align };
}

function computeAnchoredPosition({ anchorRect, boxWidth, boxHeight, bounds, prefer, offset, margin }) {
  const { side, align } = parsePrefer(prefer);
  const minLeft = bounds.left + margin;
  const maxLeft = Math.max(minLeft, bounds.right - margin - boxWidth);
  const minTop = bounds.top + margin;
  const maxTop = Math.max(minTop, bounds.bottom - margin - boxHeight);

  let resolvedSide = side;
  let flipped = false;

  const spaceTop = anchorRect.top - (bounds.top + margin);
  const spaceBottom = bounds.bottom - margin - anchorRect.bottom;
  const spaceLeft = anchorRect.left - (bounds.left + margin);
  const spaceRight = bounds.right - margin - anchorRect.right;

  if (side === 'bottom' && spaceBottom < boxHeight + offset && spaceTop > spaceBottom) {
    resolvedSide = 'top';
    flipped = true;
  } else if (side === 'top' && spaceTop < boxHeight + offset && spaceBottom > spaceTop) {
    resolvedSide = 'bottom';
    flipped = true;
  } else if (side === 'right' && spaceRight < boxWidth + offset && spaceLeft > spaceRight) {
    resolvedSide = 'left';
    flipped = true;
  } else if (side === 'left' && spaceLeft < boxWidth + offset && spaceRight > spaceLeft) {
    resolvedSide = 'right';
    flipped = true;
  }

  let rawLeft = minLeft;
  let rawTop = minTop;

  if (resolvedSide === 'bottom' || resolvedSide === 'top') {
    rawTop = resolvedSide === 'bottom' ? anchorRect.bottom + offset : anchorRect.top - offset - boxHeight;
    if (align === 'end') {
      rawLeft = anchorRect.right - boxWidth;
    } else if (align === 'center') {
      rawLeft = anchorRect.left + (anchorRect.width - boxWidth) / 2;
    } else {
      rawLeft = anchorRect.left;
    }
  } else {
    rawLeft = resolvedSide === 'right' ? anchorRect.right + offset : anchorRect.left - offset - boxWidth;
    if (align === 'end') {
      rawTop = anchorRect.bottom - boxHeight;
    } else if (align === 'center') {
      rawTop = anchorRect.top + (anchorRect.height - boxHeight) / 2;
    } else {
      rawTop = anchorRect.top;
    }
  }

  const left = clamp(rawLeft, minLeft, maxLeft);
  const top = clamp(rawTop, minTop, maxTop);
  const shifted = Math.abs(left - rawLeft) > 0.5 || Math.abs(top - rawTop) > 0.5;

  return {
    left: Math.round(left),
    top: Math.round(top),
    resolvedSide,
    flipped,
    shifted,
  };
}

function createPlacementEngine(doc, win, { surfaceGeometry = null, uiAnchors = {} } = {}) {
  function resolveAnchorElement(spec) {
    if (!spec || typeof spec !== 'object') return null;
    if (spec.anchorEl && typeof spec.anchorEl.getBoundingClientRect === 'function') {
      return spec.anchorEl;
    }
    if (typeof spec.anchorKey === 'string' && spec.anchorKey && uiAnchors && Array.isArray(uiAnchors[spec.anchorKey])) {
      const sels = uiAnchors[spec.anchorKey];
      for (let i = 0; i < sels.length; i += 1) {
        try {
          const el = doc && typeof doc.querySelector === 'function' ? doc.querySelector(sels[i]) : null;
          if (el && typeof el.getBoundingClientRect === 'function') return el;
        } catch (_e) {}
      }
    }
    return null;
  }

  function getSurfaceRect(spec, anchorEl) {
    if (surfaceGeometry && typeof surfaceGeometry.getSurfaceBounds === 'function') {
      const surfaceArg = spec && typeof spec.surface === 'string' && spec.surface ? spec.surface : 'auto';
      const b = surfaceGeometry.getSurfaceBounds(anchorEl ? { surface: surfaceArg, anchorEl } : surfaceArg);
      if (b && b.viewport && b.viewport.width > 0 && b.viewport.height > 0) {
        return b;
      }
    }
    const vw = toFiniteNumber(win && win.innerWidth, 1280) || 1280;
    const vh = toFiniteNumber(win && win.innerHeight, 800) || 800;
    return {
      surfaceId: 'viewport',
      left: 0,
      top: 0,
      right: vw,
      bottom: vh,
      width: vw,
      height: vh,
      centerX: vw / 2,
      centerY: vh / 2,
      viewport: { width: vw, height: vh },
    };
  }

  function computePlacement(spec = {}, overlaySize = {}) {
    const requestedZone = typeof spec.zone === 'string' ? spec.zone.trim().toLowerCase() : 'surface-center';
    const margin = Math.max(0, toFiniteNumber(spec.margin, DEFAULT_VIEWPORT_MARGIN_PX));
    const offset = Math.max(0, toFiniteNumber(spec.offset, DEFAULT_OFFSET_PX));
    const mobileBp = Math.max(0, toFiniteNumber(spec.mobileBreakpointPx, DEFAULT_MOBILE_BREAKPOINT_PX));
    const anchorEl = resolveAnchorElement(spec);
    const bounds = getSurfaceRect(spec, anchorEl);
    const vw = bounds.viewport.width;
    const vh = bounds.viewport.height;

    const maxW = Math.max(200, Math.min(toFiniteNumber(spec.maxWidth, vw - margin * 2), vw - margin * 2));
    const maxH = Math.max(120, Math.min(toFiniteNumber(spec.maxHeight, vh - margin * 2), vh - margin * 2));
    const explicitW = Number.isFinite(Number(spec.width)) && Number(spec.width) > 0 ? Number(spec.width) : null;
    const explicitH = Number.isFinite(Number(spec.height)) && Number(spec.height) > 0 ? Number(spec.height) : null;
    const boxWidth = Math.min(maxW, Math.max(160, explicitW || toFiniteNumber(overlaySize.width, 320)));
    const boxHeight = Math.min(maxH, Math.max(80, explicitH || toFiniteNumber(overlaySize.height, 220)));

    // Responsive mobile bottom-sheet auto-switch
    const isMobileViewport = vw > 0 && vw <= mobileBp && spec.disableMobileSheet !== true;
    if (requestedZone === 'sheet' || (isMobileViewport && (requestedZone === 'anchor' || requestedZone === 'corner' || requestedZone === 'drawer'))) {
      return Object.freeze({
        zone: 'sheet',
        requestedZone,
        autoMobileSheet: requestedZone !== 'sheet',
        surfaceId: bounds.surfaceId,
        left: 0,
        right: 0,
        bottom: 0,
        top: null,
        width: vw,
        maxWidth: vw,
        maxHeight: Math.round(vh * 0.85),
        flipped: false,
        shifted: false,
      });
    }

    if (requestedZone === 'drawer') {
      const side = spec.side === 'left' ? 'left' : 'right';
      const drawerWidth = Math.min(Math.max(260, toFiniteNumber(spec.width, 380)), Math.max(260, vw - 24));
      return Object.freeze({
        zone: 'drawer',
        requestedZone,
        autoMobileSheet: false,
        side,
        surfaceId: bounds.surfaceId,
        left: side === 'left' ? Math.round(bounds.left) : Math.round(bounds.right - drawerWidth),
        top: Math.round(bounds.top),
        width: Math.round(drawerWidth),
        height: Math.round(bounds.height),
        maxWidth: Math.round(drawerWidth),
        maxHeight: Math.round(bounds.height),
        flipped: false,
        shifted: false,
      });
    }

    if (requestedZone === 'corner') {
      const corner = typeof spec.corner === 'string' ? spec.corner.toLowerCase() : 'bottom-right';
      const isLeft = corner.includes('left');
      const isTop = corner.includes('top');
      const left = isLeft ? bounds.left + margin : bounds.right - margin - boxWidth;
      const top = isTop ? bounds.top + margin : bounds.bottom - margin - boxHeight;
      return Object.freeze({
        zone: 'corner',
        requestedZone,
        autoMobileSheet: false,
        corner,
        surfaceId: bounds.surfaceId,
        left: Math.round(clamp(left, bounds.left + margin, bounds.right - margin - boxWidth)),
        top: Math.round(clamp(top, bounds.top + margin, bounds.bottom - margin - boxHeight)),
        maxWidth: Math.round(maxW),
        maxHeight: Math.round(maxH),
        flipped: false,
        shifted: false,
      });
    }

    if (requestedZone === 'anchor' && anchorEl) {
      let rect = null;
      try {
        rect = anchorEl.getBoundingClientRect();
      } catch (_e) {}
      if (rect && Number.isFinite(Number(rect.left)) && Number.isFinite(Number(rect.top))) {
        const anchorRect = {
          left: Number(rect.left),
          top: Number(rect.top),
          width: Math.max(0, Number(rect.width) || 0),
          height: Math.max(0, Number(rect.height) || 0),
          right: Number.isFinite(Number(rect.right)) ? Number(rect.right) : Number(rect.left) + (Number(rect.width) || 0),
          bottom: Number.isFinite(Number(rect.bottom)) ? Number(rect.bottom) : Number(rect.top) + (Number(rect.height) || 0),
        };
        const pos = computeAnchoredPosition({
          anchorRect,
          boxWidth,
          boxHeight,
          bounds,
          prefer: spec.prefer,
          offset,
          margin,
        });
        return Object.freeze({
          zone: 'anchor',
          requestedZone,
          autoMobileSheet: false,
          surfaceId: bounds.surfaceId,
          left: pos.left,
          top: pos.top,
          width: explicitW ? Math.round(boxWidth) : undefined,
          resolvedSide: pos.resolvedSide,
          flipped: pos.flipped,
          shifted: pos.shifted,
          maxWidth: Math.round(maxW),
          maxHeight: Math.round(maxH),
        });
      }
    }

    // Default: surface-center
    const centerLeft = clamp(bounds.centerX - boxWidth / 2, bounds.left + margin, bounds.right - margin - boxWidth);
    const centerTop = clamp(bounds.centerY - boxHeight / 2, bounds.top + margin, bounds.bottom - margin - boxHeight);
    return Object.freeze({
      zone: 'surface-center',
      requestedZone,
      autoMobileSheet: false,
      surfaceId: bounds.surfaceId,
      left: Math.round(centerLeft),
      top: Math.round(centerTop),
      maxWidth: Math.round(maxW),
      maxHeight: Math.round(maxH),
      flipped: false,
      shifted: false,
    });
  }

  function applyPlacementStyles(el, placement) {
    if (!el || !el.style || !placement) return placement;
    el.style.position = 'fixed';
    el.style.margin = '0';
    el.setAttribute('data-addon-host-placement-zone', placement.zone);
    if (placement.zone === 'sheet') {
      el.style.left = '0px';
      el.style.right = '0px';
      el.style.bottom = '0px';
      el.style.top = 'auto';
      el.style.width = '100vw';
      el.style.maxWidth = '100vw';
      el.style.maxHeight = `${placement.maxHeight}px`;
    } else {
      el.style.left = `${placement.left}px`;
      el.style.top = `${placement.top}px`;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      if (placement.width) {
        el.style.width = `${placement.width}px`;
      }
      if (placement.zone === 'drawer' && placement.height) {
        el.style.height = `${placement.height}px`;
      }
      el.style.maxWidth = `${placement.maxWidth}px`;
      el.style.maxHeight = `${placement.maxHeight}px`;
    }
    return placement;
  }

  function trackElementPlacement(el, spec = {}, onUpdate = null) {
    let disposed = false;
    const sync = () => {
      if (disposed) return null;
      let measured = {};
      try {
        if (el && typeof el.getBoundingClientRect === 'function') {
          const r = el.getBoundingClientRect();
          if (r && r.width > 0 && r.height > 0) {
            measured = { width: r.width, height: r.height };
          }
        }
      } catch (_e) {}
      const placement = computePlacement(spec, measured);
      applyPlacementStyles(el, placement);
      if (typeof onUpdate === 'function') {
        try {
          onUpdate(placement);
        } catch (_e) {}
      }
      return placement;
    };

    const initial = sync();
    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('resize', sync);
      win.addEventListener('scroll', sync, true);
    }

    return Object.freeze({
      initial,
      reposition: sync,
      dispose() {
        if (disposed) return;
        disposed = true;
        if (win && typeof win.removeEventListener === 'function') {
          try {
            win.removeEventListener('resize', sync);
            win.removeEventListener('scroll', sync, true);
          } catch (_e) {}
        }
      },
    });
  }

  return Object.freeze({
    computePlacement,
    applyPlacementStyles,
    trackElementPlacement,
  });
}

module.exports = {
  DEFAULT_OFFSET_PX,
  DEFAULT_VIEWPORT_MARGIN_PX,
  DEFAULT_MOBILE_BREAKPOINT_PX,
  createPlacementEngine,
};
