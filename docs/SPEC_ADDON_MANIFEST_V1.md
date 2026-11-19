# AddonManifest.v1 Common Plugin Contract Specification

## 1. Purpose

This specification defines the single common contract that native desktop plugins MUST follow so multiple plugins can coexist inside one host application without overwriting `app.asar`, colliding on DOM slots/namespaces/IPC channels, or intruding into another plugin's UI.

## 2. Core Invariants

1. **No Plugin Touches `app.asar`**: Only `antigravity-native-addon-host` patches, verifies (build-hash & `patchedSha256`), and rolls back `app.asar`.
2. **Schema & Compatibility Enforcement**: Every manifest is validated against `schemas/addon-manifest.v1.schema.json` using `ajv`, plus `compatibility.hostProfile` and `compatibility.minHostVersion` checks at both registration and runtime load time.
3. **Explicit Trust Model (`trustLevel: "trusted" | "restricted"`)**:
   - `restricted` addons (and any addon omitting `trustLevel` when `strictTrustPolicy: true`) CANNOT declare `mainHook` (`ERR_RESTRICTED_MAIN_HOOK_FORBIDDEN`) or `document-transform` (`ERR_RESTRICTED_DOCUMENT_TRANSFORM_FORBIDDEN`), and their styles are strictly auto-scoped under `[data-addon-host-owner="<pluginId>"]`.
   - `trusted` addons may declare `mainHook` (executed via least-privilege frozen host/webContents brokers, never raw Electron `app`/`webContents`) or `document-transform` (explicitly permitted `{ scope: "global" }` styles when required).
   - Omitting `trustLevel` remains backward-compatible with v1.0.x manifests in default non-strict mode while marking `implicitTrustLevel: true` for auditability.
4. **Strict Entry & Plugin Directory Confinement**: Both `<pluginsRoot>/<pluginId>` and `entry.rendererScript` / `entry.mainHookScript` MUST resolve strictly inside `<pluginsRoot>` after symlink resolution via the injected `FileSystemPort`.
5. **Scoped Capability Handle (`addonHost`) — Zero Impersonation & Owner CSS Scoping**:
   - The host wraps each renderer plugin as `(function(addonHost) { ... })` with an immutable capability handle bound to its `pluginId`, `trustLevel`, and declared `uiSlots[].slotId`s.
   - Plugins CANNOT spoof another `pluginId`, mount undeclared slots, or unmount/restyle/dispose another plugin.
   - Any UI container mounted through `addonHost.mountSlot(slotId, parentEl?, { shadow?: boolean })` automatically receives `translate="no"`, `data-addon-host-owner="<pluginId>"`, `data-addon-host-slot="<slotId>"`, plus any host-profile-specific opt-out attributes (e.g., `data-agy-no-translate="true"` in `antigravity-desktop`). Pass `{ shadow: true }` for opt-in Shadow DOM encapsulation.
   - `addonHost.injectStyle(styleId, cssText, { scope?: "owner" | "global" })` blocks `@import`, `javascript:`, `expression(`, `behavior:`, and `-moz-binding:` (`ERR_FORBIDDEN_CSS_CONSTRUCT`), auto-scopes CSS selectors under `[data-addon-host-owner="<pluginId>"]` by default for non-`document-transform` addons, and restricts `{ scope: "global" }` exclusively to `trusted` + `document-transform` addons (`ERR_FORBIDDEN_GLOBAL_STYLE_SCOPE`).
6. **Document-Transform Scope**: Plugins with `slot: "document-transform"` MUST explicitly set `scope: "native-host-only"` and `isolation.respectsNoTranslate !== false`, and MUST skip any subtree matching `addonHost.getNoTranslateSelector()`.
7. **Namespace & IPC Isolation**: `isolation.storageNamespace` and `isolation.ipcChannelPrefix` MUST be unique across active plugins; overlapping IPC prefixes are rejected (`ERR_IPC_PREFIX_CONFLICT`).
8. **Async Fault Isolation & Read-Only Host Config Gate**: `config.json` is NEVER mutated by the addon host. If `plugins[pluginId].enabled === false` (or `config.json` is corrupted), loading fails closed and active `mainHook`s & managed listeners are disposed. Both synchronous throws and returned Promise rejections / timeouts are isolated and tracked per addon (`PENDING -> ACTIVATING -> ACTIVE / FAILED / DISPOSING -> DISPOSED`).

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
- `pluginId`, `trustLevel`, `loadOrder`, `hostVersion`, `hostProfileId`, `storageNamespace`, `ipcChannelPrefix`
- `getNoTranslateSelector()`: same selector as `window.__ADDON_HOST_API__.getNoTranslateSelector()`.
- `resolveAnchor(anchorKey)`: resolves a semantic `HostProfile.uiAnchors` region (`sidebar`, `overview-pane`, `status-bar`, `settings-pane`, `automation-page`, `customizations-page`, `modal-root`) to its live native DOM element (or `null` when that view is not currently mounted).
- `mountSlot(slotId, parentEl?, { anchor?, position?, shadow?: boolean })`: mounts only a `slotId` declared in this plugin's `uiSlots` into an owner-isolated container (`data-addon-host-owner`, `data-addon-host-slot`, `data-addon-host-order`, `translate="no"`, zero `contain: layout` so `position: fixed` descendants stay intact), ordered deterministically by `loadOrder` inside shared native regions (optionally returning an attached ShadowRoot when `{ shadow: true }`).
- `unmountSlot(slotId)`: removes only a slot owned by this plugin.
- `openModal(slotId, { title?, badge?, mode?: "dialog" | "popover", anchorEl?, placement?, ignoreOutsideClickEls?, width?, maxWidth?, closeOnBackdrop?, closeOnEsc?, shadow?, onClose? })` / `closeModal(slotId)` / `toggleModal(slotId, opts?)` / `isModalOpen(slotId)`: host-owned single modal/popover z-index stack with top-most `Escape` dismissal, backdrop/outside-click handling, focus restoration, dark/light tokens, `role="dialog"`, `data-addon-host-owner="<pluginId>"` on portal containers, cross-plugin close guard (`ERR_FORBIDDEN_CROSS_PLUGIN_MODAL`), and automatic teardown on `dispose()`.
- `registerAction({ surface, id, label, title?, description?, order?, source?, disabled?, onClick })` / `updateAction(id, patch)` / `unregisterAction(id)` / `listActions(surface)` / `onActionsChanged(surface, listener)`: host-neutral Action Contribution Port decoupling surface owners (e.g., `status-bar`) from contributing plugins regardless of `loadOrder`, passing `{ pluginId, actionId, surface, event, buttonEl, anchorEl, sessionId }` to `onClick` with fault isolation and automatic cleanup on `dispose()`.
- `injectStyle(styleId, cssText, { scope?: "owner" | "global" })` / `removeStyle(styleId)`: decodes CSS escapes before checking forbidden constructs (`@import`, `javascript:`, `expression(`, `behavior:`, `-moz-binding:`), enforces a strict `@`-rule allowlist (`@media`/`@supports`/`@container`/`@layer`/`@keyframes` only; blocks `@scope`, `@property`, `@starting-style`, `@font-face`, escaped `@`-rules), rejects owner-escaping sibling selectors (`~`/`+`), and strictly scopes rules under `[data-addon-host-owner="<pluginId>"]` (global scope restricted to `trusted` + `document-transform`).
- `listOwnedSlots()`: lists active `slotId`s owned by this plugin.
- `reportError(err)`: records plugin runtime errors into the host-authenticated diagnostics buffer (`collectRendererErrors()`).
- `runSafe(fn)`: executes a sync or async callback inside a prototype-safe error-capturing boundary that never rejects unhandled.
- `addManagedListener(target, eventType, handler, opts?)`: registers a fault-isolated event listener automatically detached on `dispose()`.
- `onDispose(fn)` / `dispose()`: cleans up contributed actions, action subscriptions, open modals/popovers, managed listeners, callbacks, slots, and styles for this plugin only.

## 5. Main Process Hook Surface (`entry.mainHookScript`)

Plugins with `"mainHook"` capability (`trustLevel: "trusted"`) export either a function or an object and receive **least-privilege frozen brokers** (never raw Electron `app` or raw `webContents`):

- `activate({ app, hostBridge, pluginId, trustLevel, hostProfileId, hostVersion, isolatedWorldId, storageNamespace, ipcChannelPrefix })`: invoked once inside a sync+async fault & timeout boundary (`mainHookTimeoutMs`). `app`/`hostBridge` exposes only `getVersion()`, whitelisted `getPath('userData' | 'temp' | 'logs')`, and auto-cleaned `onBeforeQuit(fn)`.
- `onWebContentsCreated({ app, hostBridge, contents, pluginId, isolatedWorldId, isAllowedRendererUrl })` (optional): invoked per window `webContents` creation while active. `contents` is a frozen broker exposing only `getType()`, `getURL()`, `isDestroyed()`, whitelisted `on()`/`removeListener()`, `executeInIsolatedWorld(code)`, and world-ID-verified `executeJavaScriptInIsolatedWorld(worldId, sources, userGesture)` with mandatory URL allowlist enforcement and automatic listener cleanup on `dispose()` or activation failure.
- `dispose()` (optional, sync or async): invoked automatically when the plugin is disabled or unregistered.
