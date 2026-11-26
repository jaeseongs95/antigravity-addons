'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestHost } = require('../../packages/sdk/src/test-host');
const { createPlacementEngine } = require('../../src/runtime/renderer/placement-engine');
const { SCHEMA_UI_CSS } = require('../../src/runtime/renderer/ui-schema-renderer');

test('v3.0.4: openModal propagates max-height through shadowHost into .ag-ui-shell so .ag-ui-body scrolls instead of clipping', async () => {
  const host = createTestHost({ surface: 'desktop', viewport: { width: 1024, height: 700 } });
  const ctx = await host.mountPlugin({
    schemaVersion: 3,
    pluginId: 'modal-clamp-plugin',
    displayName: 'Modal Clamp Plugin',
    version: '1.0.0',
    capabilities: ['renderer'],
    entry: { rendererScript: 'a.js' },
  });

  const modal = ctx.ui.openModal({
    title: '한국어 번역 설정',
    placement: { zone: 'surface-center', width: 520 },
  });

  const dialogEl = modal.element;
  const shadowHost = dialogEl.childNodes[0];
  assert.equal(dialogEl.style.overflow, 'hidden');
  assert.equal(dialogEl.style.maxHeight, '684px');
  assert.equal(dialogEl.style.width, '520px');
  assert.equal(shadowHost.style.maxHeight, 'inherit');
  assert.equal(shadowHost.style.display, 'flex');
  assert.equal(shadowHost.style.flexDirection, 'column');
  assert.equal(shadowHost.style.overflow, 'hidden');

  assert.equal(SCHEMA_UI_CSS.includes('max-height: inherit;'), true);
  assert.equal(SCHEMA_UI_CSS.includes('flex: 1 1 auto; min-height: 0;'), true);

  modal.close();
});

test('v3.0.4: placementEngine auto-recenters via ResizeObserver and post-mount rAF when modal height grows after open, preventing bottom viewport overflow', () => {
  let roCb = null;
  let roDisconnected = false;
  const observedTargets = [];
  let rafCb = null;
  let rafCancelled = false;

  const fakeWin = {
    innerWidth: 1024,
    innerHeight: 700,
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame(cb) {
      rafCb = cb;
      return 77;
    },
    cancelAnimationFrame() {
      rafCancelled = true;
    },
    ResizeObserver: class {
      constructor(cb) {
        roCb = cb;
      }
      observe(target) {
        observedTargets.push(target);
      }
      disconnect() {
        roDisconnected = true;
      }
    },
  };

  const eng = createPlacementEngine({}, fakeWin);
  let measuredHeight = 48; // Empty modal header before plugin populates bodyEl
  const innerChild = { nodeType: 1 };
  const fakeDialog = {
    nodeType: 1,
    childNodes: [innerChild],
    style: {},
    setAttribute() {},
    getBoundingClientRect: () => ({ width: 520, height: measuredHeight }),
  };

  const tracker = eng.trackElementPlacement(fakeDialog, { zone: 'surface-center', width: 520 });
  assert.equal(observedTargets.length, 2, 'ResizeObserver must observe both dialog and inner shadowHost wrapper');
  assert.equal(fakeDialog.style.width, '520px');
  assert.equal(fakeDialog.style.top, '310px'); // Centered for min boxHeight 80px on 700px viewport

  // Plugin mounts 640px of form controls into bodyEl
  measuredHeight = 640;
  assert.equal(typeof roCb, 'function');
  roCb();
  assert.equal(fakeDialog.style.top, '30px', 'ResizeObserver must recenter 640px modal to top: 30px on 700px viewport');
  assert.equal(parseInt(fakeDialog.style.top, 10) + measuredHeight <= 700, true, 'Modal bottom edge must remain inside viewport');

  // Dynamic expansion beyond viewport height clamps cleanly to top margin + maxHeight
  measuredHeight = 900;
  assert.equal(typeof rafCb, 'function');
  rafCb();
  assert.equal(fakeDialog.style.top, '8px');
  assert.equal(fakeDialog.style.maxHeight, '684px');

  tracker.dispose();
  assert.equal(roDisconnected, true, 'dispose() must disconnect ResizeObserver cleanly');
  assert.equal(rafCancelled, false);
});
