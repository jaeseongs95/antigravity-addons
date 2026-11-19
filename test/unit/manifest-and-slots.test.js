'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validateAddonManifest } = require('../../src/core/manifest-validator');
const { detectSlotConflicts } = require('../../src/core/slot-registry');

const KO_TRANSLATOR_MANIFEST = {
  schemaVersion: 1,
  pluginId: 'ko-thought-translator',
  displayName: 'Antigravity Korean Translator',
  version: '2.0.0',
  compatibility: { hostProfile: 'antigravity-desktop', minHostVersion: '2.0.0' },
  capabilities: ['renderer'],
  entry: { rendererScript: 'dist/renderer.js', mainHookScript: null },
  uiSlots: [{ slot: 'document-transform', slotId: 'ko-translator.native-app', scope: 'native-host-only' }],
  isolation: { noTranslate: false, i18nSelfManaged: true, respectsNoTranslate: true },
  loadOrder: 20,
};

const STATUSBAR_MANIFEST = {
  schemaVersion: 1,
  pluginId: 'antigravity-statusbar',
  displayName: 'Antigravity Statusbar',
  version: '3.1.0',
  capabilities: ['renderer'],
  entry: { rendererScript: 'dist/renderer.js', mainHookScript: null },
  uiSlots: [{ slot: 'status-bar', slotId: 'antigravity-statusbar.root', exclusive: true }],
  isolation: { noTranslate: true, i18nSelfManaged: true, respectsNoTranslate: true },
  loadOrder: 50,
};

const MCP_MANAGER_MANIFEST = {
  schemaVersion: 1,
  pluginId: 'antigravity-mcp-manager',
  displayName: 'Antigravity MCP Manager',
  version: '2.1.0',
  capabilities: ['mainHook', 'renderer'],
  entry: { rendererScript: 'dist/renderer.js', mainHookScript: 'scripts/electron-hook.cjs' },
  uiSlots: [{ slot: 'settings-pane', slotId: 'antigravity-mcp-manager.pane', exclusive: false }],
  isolation: { noTranslate: true, i18nSelfManaged: true, respectsNoTranslate: true },
  loadOrder: 60,
};

test('TC-002: valid AddonManifest.v1 manifests for all 3 reference plugins pass schema & capability checks', () => {
  for (const m of [KO_TRANSLATOR_MANIFEST, STATUSBAR_MANIFEST, MCP_MANAGER_MANIFEST]) {
    const res = validateAddonManifest(m);
    assert.equal(res.ok, true, `Expected ${m.pluginId} manifest to be valid: ${JSON.stringify(res)}`);
  }
});

test('TC-003: invalid schema, unknown fields, non-SemVer, or missing capability entry fail closed', () => {
  assert.equal(validateAddonManifest({ ...STATUSBAR_MANIFEST, extraKey: true }).reason, 'ERR_MANIFEST_SCHEMA_INVALID');
  assert.equal(validateAddonManifest({ ...STATUSBAR_MANIFEST, version: 'v3.1' }).reason, 'ERR_MANIFEST_SCHEMA_INVALID');
  assert.equal(
    validateAddonManifest({ ...STATUSBAR_MANIFEST, entry: { rendererScript: null, mainHookScript: null } }).reason,
    'ERR_MISSING_RENDERER_ENTRY'
  );
  assert.equal(
    validateAddonManifest({
      ...KO_TRANSLATOR_MANIFEST,
      isolation: { noTranslate: false, i18nSelfManaged: true, respectsNoTranslate: false },
    }).reason,
    'ERR_DOCUMENT_TRANSFORM_MUST_RESPECT_NO_TRANSLATE'
  );
});

test('TC-004: path traversal and absolute paths escaping <pluginsRoot>/<pluginId> are rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-host-manifest-'));
  try {
    const pluginsRoot = path.join(dir, 'plugins');
    const pluginDir = path.join(pluginsRoot, 'antigravity-statusbar');
    fs.mkdirSync(path.join(pluginDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'dist', 'renderer.js'), '// ok\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'escape.js'), '// bad\n', 'utf8');

    const okRes = validateAddonManifest(STATUSBAR_MANIFEST, { pluginsRootDir: pluginsRoot, checkFilesExist: true });
    assert.equal(okRes.ok, true);

    const traversal = validateAddonManifest(
      { ...STATUSBAR_MANIFEST, entry: { rendererScript: '../../escape.js', mainHookScript: null } },
      { pluginsRootDir: pluginsRoot, checkFilesExist: true }
    );
    assert.equal(traversal.ok, false);
    assert.equal(traversal.reason, 'ERR_ENTRY_ESCAPES_PLUGIN_DIR');

    const abs = validateAddonManifest(
      { ...STATUSBAR_MANIFEST, entry: { rendererScript: path.join(dir, 'escape.js'), mainHookScript: null } },
      { pluginsRootDir: pluginsRoot, checkFilesExist: true }
    );
    assert.equal(abs.ok, false);
    assert.equal(abs.reason, 'ERR_ENTRY_ESCAPES_PLUGIN_DIR');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TC-005: slot registry allows coexisting plugins and blocks duplicate slotId or exclusive slot collision', () => {
  const coexist = detectSlotConflicts([KO_TRANSLATOR_MANIFEST, STATUSBAR_MANIFEST, MCP_MANAGER_MANIFEST]);
  assert.equal(coexist.ok, true);

  const dupExclusive = detectSlotConflicts([
    STATUSBAR_MANIFEST,
    {
      ...STATUSBAR_MANIFEST,
      pluginId: 'another-statusbar',
      uiSlots: [{ slot: 'status-bar', slotId: 'another-statusbar.root', exclusive: false }],
    },
  ]);
  assert.equal(dupExclusive.ok, false);
  assert.equal(dupExclusive.conflicts[0].kind, 'EXCLUSIVE_SLOT_CONFLICT');

  const dupSlotId = detectSlotConflicts([
    MCP_MANAGER_MANIFEST,
    {
      ...MCP_MANAGER_MANIFEST,
      pluginId: 'other-settings-plugin',
      uiSlots: [{ slot: 'settings-pane', slotId: 'antigravity-mcp-manager.pane', exclusive: false }],
    },
  ]);
  assert.equal(dupSlotId.ok, false);
  assert.equal(dupSlotId.conflicts[0].kind, 'DUPLICATE_SLOT_ID');
});
