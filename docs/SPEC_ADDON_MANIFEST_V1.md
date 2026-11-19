# AddonManifest.v1 Common Plugin Contract Specification

## 1. Purpose

This specification defines the single common contract that native desktop plugins MUST follow so multiple plugins can coexist inside one host application without overwriting `app.asar`, colliding on DOM slots, or intruding into another plugin's UI.

## 2. Core Invariants

1. **No Plugin Touches `app.asar`**: Only `antigravity-native-addon-host` patches and rolls back `app.asar`.
2. **Schema-Validated Manifests**: Every plugin registers a JSON manifest validated against `schemas/addon-manifest.v1.schema.json` using `ajv`.
3. **Strict Entry Path Confinement**: `entry.rendererScript` and `entry.mainHookScript` MUST resolve inside `<pluginsRoot>/<pluginId>/` after symlink resolution (`fs.realpathSync`). Path traversal (`..`) and absolute paths are rejected.
4. **DOM Ownership & Opt-Out**:
   - Any UI container mounted through `window.__ADDON_HOST_API__.mountSlot(slotId)` automatically receives:
     - `translate="no"`
     - `data-agy-no-translate="true"`
     - `data-addon-host-owner="<pluginId>"`
     - `data-addon-host-slot="<slotId>"`
   - Plugins with `slot: "document-transform"` (e.g., native-app translation) MUST set `scope: "native-host-only"` and `isolation.respectsNoTranslate: true`, and MUST NEVER mutate any subtree marked with `[data-addon-host-owner]`, `[translate="no"]`, or `[data-agy-no-translate="true"]`.
5. **Self-Managed i18n**: UI plugins SHOULD set `isolation.i18nSelfManaged: true` and `isolation.noTranslate: true`, owning their own language switcher.
6. **Read-Only Host Config Gate**: `config.json` is NEVER mutated by the addon host. If `plugins[pluginId].enabled === false` (or `config.json` is corrupted), loading fails closed.

## 3. Reference Plugin Profiles

| Plugin | Capabilities | UI Slots | Isolation |
| --- | --- | --- | --- |
| `ko-thought-translator` | `["renderer"]` | `[{ slot: "document-transform", slotId: "ko-translator.native-app", scope: "native-host-only" }]` | `noTranslate: false`, `i18nSelfManaged: true`, `respectsNoTranslate: true` |
| `antigravity-statusbar` | `["renderer"]` | `[{ slot: "status-bar", slotId: "antigravity-statusbar.root", exclusive: true }]` | `noTranslate: true`, `i18nSelfManaged: true`, `respectsNoTranslate: true` |
| `antigravity-mcp-manager` | `["mainHook", "renderer"]` | `[{ slot: "settings-pane", slotId: "antigravity-mcp-manager.pane", exclusive: false }]` | `noTranslate: true`, `i18nSelfManaged: true`, `respectsNoTranslate: true` |

## 4. Runtime API Surface (`window.__ADDON_HOST_API__`)

Exposed per top-frame local HTTP(S) Hub window (never in `devtools://`, `file://`, or external origins):

- `hostVersion`: string
- `hostProfileId`: string
- `getNoTranslateSelector()`: returns `"[data-addon-host-owner], [translate=\"no\"], [data-agy-no-translate=\"true\"]"` so `document-transform` addons automatically skip every peer addon without knowing its name.
- `mountSlot(pluginId, slotId, parentEl?)`: creates/returns an isolated container with `translate="no"`, `data-agy-no-translate="true"`, `data-addon-host-owner`, `data-addon-host-slot`.
- `unmountSlot(pluginId, slotId)`: removes only a container owned by `pluginId`.
- `injectStyle(pluginId, styleId, cssText)` / `removeStyle(pluginId, styleId)`: manages owner-scoped `<style>` tags without allowing cross-plugin overwrites.
- `listOwnedSlots(pluginId)`: returns active `slotId`s owned by `pluginId`.
- `onDispose(pluginId, fn)` / `disposePlugin(pluginId)`: cleans up callbacks, slots, and styles for a single plugin without affecting peers.

## 5. Main Process Hook Surface (`entry.mainHookScript`)

Plugins with `"mainHook"` capability export either a function or an object:

- `activate({ app, pluginId, hostProfileId, hostVersion })`: invoked once at host startup inside an isolated fault boundary.
- `onWebContentsCreated({ app, contents, pluginId, isAllowedHubUrl })` (optional): invoked per window `webContents` creation inside an isolated fault boundary.
