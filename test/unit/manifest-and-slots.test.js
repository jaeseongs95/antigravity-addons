'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { compareSemver, validateAddonManifest } = require('../../src/core/manifest-validator');
const { detectSlotConflicts } = require('../../src/core/slot-registry');

const KO_TRANSLATOR_MANIFEST = {
  schemaVersion: 1,
  pluginId: 'ko-thought-translator',
  displayName: 'Antigravity Korean Translator',
  version: '2.0.0',
  compatibility: { hostProfile: 'antigravity-desktop', minHostVersion: '1.0.0' },
  capabilities: ['renderer'],
  entry: { rendererScript: 'dist/renderer.js', mainHookScript: null },
  uiSlots: [{ slot: 'document-transform', slotId: 'ko-translator.native-app', scope: 'native-host-only' }],
  isolation: {
    noTranslate: false,
    i18nSelfManaged: true,
    respectsNoTranslate: true,
    storageNamespace: 'ko-thought-translator',
  },
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
  isolation: {
    noTranslate: true,
    i18nSelfManaged: true,
    respectsNoTranslate: true,
    storageNamespace: 'antigravity-statusbar',
  },
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
  isolation: {
    noTranslate: true,
    i18nSelfManaged: true,
    respectsNoTranslate: true,
    storageNamespace: 'antigravity-mcp-manager',
    ipcChannelPrefix: 'mcp-manager:',
  },
  loadOrder: 60,
};

test('TC-002: valid AddonManifest.v1 manifests for all 3 reference plugins pass schema & compatibility checks', () => {
  for (const m of [KO_TRANSLATOR_MANIFEST, STATUSBAR_MANIFEST, MCP_MANAGER_MANIFEST]) {
    const res = validateAddonManifest(m, { hostProfileId: 'antigravity-desktop', hostVersion: '1.0.0' });
    assert.equal(res.ok, true, `Expected ${m.pluginId} manifest to be valid: ${JSON.stringify(res)}`);
  }
});

test('TC-003 (F4 & NB3): invalid schema, duplicate slotId in manifest, compatibility mismatch, and document-transform without native-host-only fail closed', () => {
  assert.equal(validateAddonManifest({ ...STATUSBAR_MANIFEST, extraKey: true }).reason, 'ERR_MANIFEST_SCHEMA_INVALID');
  assert.equal(validateAddonManifest({ ...STATUSBAR_MANIFEST, version: 'v3.1' }).reason, 'ERR_MANIFEST_SCHEMA_INVALID');
  assert.equal(
    validateAddonManifest({ ...STATUSBAR_MANIFEST, entry: { rendererScript: null, mainHookScript: null } }).reason,
    'ERR_MISSING_RENDERER_ENTRY'
  );
  // F4: compatibility.hostProfile & minHostVersion enforcement
  assert.equal(
    validateAddonManifest(KO_TRANSLATOR_MANIFEST, { hostProfileId: 'other-host', hostVersion: '1.0.0' }).reason,
    'ERR_INCOMPATIBLE_HOST_PROFILE'
  );
  assert.equal(
    validateAddonManifest(
      { ...KO_TRANSLATOR_MANIFEST, compatibility: { hostProfile: 'antigravity-desktop', minHostVersion: '2.5.0' } },
      { hostProfileId: 'antigravity-desktop', hostVersion: '1.0.0' }
    ).reason,
    'ERR_INCOMPATIBLE_HOST_VERSION'
  );
  // NB2: Strict SemVer 2.0.0 prerelease precedence & fail-closed on unparseable versions
  assert.ok(compareSemver('1.0.1-alpha.1', '1.0.1-beta.1') < 0);
  assert.ok(compareSemver('1.0.1-beta.1', '1.0.1') < 0);
  assert.equal(compareSemver('not-a-semver', '1.0.0'), null);
  assert.equal(
    validateAddonManifest(
      { ...KO_TRANSLATOR_MANIFEST, compatibility: { hostProfile: 'antigravity-desktop', minHostVersion: '1.0.1' } },
      { hostProfileId: 'antigravity-desktop', hostVersion: '1.0.1-rc.1' }
    ).reason,
    'ERR_INCOMPATIBLE_HOST_VERSION'
  );
  assert.equal(
    validateAddonManifest(
      { ...KO_TRANSLATOR_MANIFEST, compatibility: { hostProfile: 'antigravity-desktop', minHostVersion: '1.0.0' } },
      { hostProfileId: 'antigravity-desktop', hostVersion: 'invalid-ver' }
    ).reason,
    'ERR_INCOMPATIBLE_HOST_VERSION'
  );
  // F4: document-transform MUST explicitly specify scope: "native-host-only"
  assert.equal(
    validateAddonManifest({
      ...KO_TRANSLATOR_MANIFEST,
      uiSlots: [{ slot: 'document-transform', slotId: 'ko-translator.native-app' }],
    }).reason,
    'ERR_DOCUMENT_TRANSFORM_SCOPE_REQUIRED'
  );
  // NB3: duplicate slotId inside the same manifest
  assert.equal(
    validateAddonManifest({
      ...STATUSBAR_MANIFEST,
      uiSlots: [
        { slot: 'status-bar', slotId: 'dup.slot' },
        { slot: 'overlay', slotId: 'dup.slot' },
      ],
    }).reason,
    'ERR_DUPLICATE_SLOT_ID_IN_MANIFEST'
  );
});

test('TC-004 (F1): path traversal, absolute paths, and <pluginsRoot>/<pluginId> symlink escape are rejected', () => {
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

    // F1: symlinked <pluginsRoot>/<pluginId> pointing outside pluginsRoot must be rejected
    const outsidePluginDir = path.join(dir, 'outside-evil-plugin');
    fs.mkdirSync(path.join(outsidePluginDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(outsidePluginDir, 'dist', 'renderer.js'), '// escaped\n', 'utf8');
    const symlinkDir = path.join(pluginsRoot, 'symlink-escape-plugin');
    fs.symlinkSync(outsidePluginDir, symlinkDir, 'junction');

    const symRes = validateAddonManifest(
      { ...STATUSBAR_MANIFEST, pluginId: 'symlink-escape-plugin' },
      { pluginsRootDir: pluginsRoot, checkFilesExist: true }
    );
    assert.equal(symRes.ok, false);
    assert.equal(symRes.reason, 'ERR_PLUGIN_DIR_SYMLINK_ESCAPE');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TC-005 (F4 & NB3): slot, storageNamespace, and ipcChannelPrefix collision detection; custom slots coexist', () => {
  const coexist = detectSlotConflicts([KO_TRANSLATOR_MANIFEST, STATUSBAR_MANIFEST, MCP_MANAGER_MANIFEST]);
  assert.equal(coexist.ok, true);

  // Exclusive slot collision
  const dupExclusive = detectSlotConflicts([
    STATUSBAR_MANIFEST,
    {
      ...STATUSBAR_MANIFEST,
      pluginId: 'another-statusbar',
      isolation: { noTranslate: true, i18nSelfManaged: true, storageNamespace: 'another-statusbar' },
      uiSlots: [{ slot: 'status-bar', slotId: 'another-statusbar.root', exclusive: false }],
    },
  ]);
  assert.equal(dupExclusive.ok, false);
  assert.equal(dupExclusive.conflicts[0].kind, 'EXCLUSIVE_SLOT_CONFLICT');

  // F4 & R2-F2: storageNamespace conflict (including implicit default pluginId when storageNamespace omitted)
  const dupNs = detectSlotConflicts([
    STATUSBAR_MANIFEST,
    {
      ...MCP_MANAGER_MANIFEST,
      isolation: { ...MCP_MANAGER_MANIFEST.isolation, storageNamespace: 'antigravity-statusbar' },
    },
  ]);
  assert.equal(dupNs.ok, false);
  assert.equal(dupNs.conflicts[0].code, 'ERR_NAMESPACE_CONFLICT');

  const dupImplicitNs = detectSlotConflicts([
    {
      ...STATUSBAR_MANIFEST,
      pluginId: 'implicit-ns-owner',
      uiSlots: [{ slot: 'overlay', slotId: 'implicit-ns-owner.slot' }],
      isolation: { noTranslate: true, i18nSelfManaged: true },
    },
    {
      ...MCP_MANAGER_MANIFEST,
      pluginId: 'explicit-ns-collider',
      uiSlots: [{ slot: 'settings-pane', slotId: 'explicit-ns-collider.slot' }],
      isolation: { noTranslate: true, i18nSelfManaged: true, storageNamespace: 'implicit-ns-owner' },
    },
  ]);
  assert.equal(dupImplicitNs.ok, false);
  assert.equal(dupImplicitNs.conflicts[0].code, 'ERR_NAMESPACE_CONFLICT');

  // F4: ipcChannelPrefix overlap conflict
  const dupIpc = detectSlotConflicts([
    MCP_MANAGER_MANIFEST,
    {
      ...STATUSBAR_MANIFEST,
      pluginId: 'ipc-collider',
      uiSlots: [{ slot: 'overlay', slotId: 'ipc-collider.overlay' }],
      isolation: { noTranslate: true, i18nSelfManaged: true, storageNamespace: 'ipc-collider', ipcChannelPrefix: 'mcp-manager:sub:' },
    },
  ]);
  assert.equal(dupIpc.ok, false);
  assert.equal(dupIpc.conflicts[0].code, 'ERR_IPC_PREFIX_CONFLICT');

  // NB3: Two plugins using `custom` slot with distinct slotIds coexist even with exclusive:true
  const customCoexist = detectSlotConflicts([
    {
      ...STATUSBAR_MANIFEST,
      pluginId: 'custom-a',
      isolation: { noTranslate: true, i18nSelfManaged: true, storageNamespace: 'custom-a' },
      uiSlots: [{ slot: 'custom', slotId: 'custom-a.panel', exclusive: true }],
    },
    {
      ...STATUSBAR_MANIFEST,
      pluginId: 'custom-b',
      isolation: { noTranslate: true, i18nSelfManaged: true, storageNamespace: 'custom-b' },
      uiSlots: [{ slot: 'custom', slotId: 'custom-b.panel', exclusive: true }],
    },
  ]);
  assert.equal(customCoexist.ok, true);
});
