# AddonManifest.v1 Common Plugin Contract Specification

## 1. Purpose

This specification defines the single common contract that native desktop plugins MUST follow so multiple plugins can coexist inside one host application without overwriting `app.asar`, colliding on DOM slots/namespaces/IPC channels, or intruding into another plugin's UI.

## 2. Core Invariants

1. **No Plugin Touches `app.asar`**: Only `antigravity-native-addon-host` patches and rolls back `app.asar`.
2. **Schema & Compatibility Enforcement**: Every manifest is validated against `schemas/addon-manifest.v1.schema.json` using `ajv`, plus `compatibility.hostProfile` and `compatibility.minHostVersion` checks at both registration and runtime load time.
3. **Strict Entry & Plugin Directory Confinement**: Both `<pluginsRoot>/<pluginId>` and `entry.rendererScript` / `entry.mainHookScript` MUST resolve strictly inside `<pluginsRoot>` after symlink resolution (`fs.realpathSync`).
4. **Scoped Capability Handle (`addonHost`) — Zero Impersonation**:
   - The host wraps each renderer plugin as `(function(addonHost) { ... })` with an immutable capability handle bound to its `pluginId` and declared `uiSlots[].slotId`s.
   - Plugins CANNOT spoof another `pluginId`, mount undeclared slots, or unmount/restyle/dispose another plugin.
   - Any UI container mounted through `addonHost.mountSlot(slotId, parentEl?)` automatically receives `translate="no"`, `data-addon-host-owner="<pluginId>"`, `data-addon-host-slot="<slotId>"`, plus any host-profile-specific opt-out attributes (e.g., `data-agy-no-translate="true"` in `antigravity-desktop`).
5. **Document-Transform Scope**: Plugins with `slot: "document-transform"` MUST explicitly set `scope: "native-host-only"` and `isolation.respectsNoTranslate !== false`, and MUST skip any subtree matching `addonHost.getNoTranslateSelector()`.
6. **Namespace & IPC Isolation**: `isolation.storageNamespace` and `isolation.ipcChannelPrefix` MUST be unique across active plugins; overlapping IPC prefixes are rejected (`ERR_IPC_PREFIX_CONFLICT`).
7. **Read-Only Host Config Gate**: `config.json` is NEVER mutated by the addon host. If `plugins[pluginId].enabled === false` (or `config.json` is corrupted), loading fails closed and active `mainHook`s are disposed.

## 3. Reference Plugin Profiles

| Plugin | Capabilities | UI Slots | Isolation |
| --- | --- | --- | --- |
| `ko-thought-translator` | `["renderer"]` | `[{ slot: "document-transform", slotId: "ko-translator.native-app", scope: "native-host-only" }]` | `noTranslate: false`, `i18nSelfManaged: true`, `respectsNoTranslate: true`, `storageNamespace: "ko-thought-translator"` |
| `antigravity-statusbar` | `["renderer"]` | `[{ slot: "status-bar", slotId: "antigravity-statusbar.root", exclusive: true }]` | `noTranslate: true`, `i18nSelfManaged: true`, `respectsNoTranslate: true`, `storageNamespace: "antigravity-statusbar"` |
| `antigravity-mcp-manager` | `["mainHook", "renderer"]` | `[{ slot: "settings-pane", slotId: "antigravity-mcp-manager.pane", exclusive: false }]` | `noTranslate: true`, `i18nSelfManaged: true`, `respectsNoTranslate: true`, `storageNamespace: "antigravity-mcp-manager"`, `ipcChannelPrefix: "mcp-manager:"` |

## 4. Runtime API Surface

### Global Read-Only Info (`window.__ADDON_HOST_API__`)
- `hostVersion`: string
- `hostProfileId`: string
- `getNoTranslateSelector()`: returns `"[data-addon-host-owner], [translate=\"no\"]"` plus any profile-configured opt-out attribute selectors.

### Per-Plugin Scoped Capability Handle (`addonHost` argument)
- `pluginId`, `hostVersion`, `hostProfileId`, `storageNamespace`, `ipcChannelPrefix`
- `getNoTranslateSelector()`: same selector as `window.__ADDON_HOST_API__.getNoTranslateSelector()`.
- `mountSlot(slotId, parentEl?)`: mounts only a `slotId` declared in this plugin's `uiSlots`.
- `unmountSlot(slotId)`: removes only a slot owned by this plugin.
- `injectStyle(styleId, cssText)` / `removeStyle(styleId)`: manages owner-scoped `<style>` tags isolated by `pluginId`.
- `listOwnedSlots()`: lists active `slotId`s owned by this plugin.
- `onDispose(fn)` / `dispose()`: cleans up callbacks, slots, and styles for this plugin only.

## 5. Main Process Hook Surface (`entry.mainHookScript`)

Plugins with `"mainHook"` capability export either a function or an object:

- `activate({ app, pluginId, hostProfileId, hostVersion, storageNamespace, ipcChannelPrefix })`: invoked once inside an isolated fault boundary.
- `onWebContentsCreated({ app, contents, pluginId, isAllowedRendererUrl })` (optional): invoked per window `webContents` creation while active.
- `dispose()` (optional): invoked automatically when the plugin is disabled or unregistered.
