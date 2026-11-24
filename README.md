# antigravity-native-addon-host

[![CI](https://github.com/jaeseongs95/antigravity-native-addon-host/actions/workflows/ci.yml/badge.svg)](https://github.com/jaeseongs95/antigravity-native-addon-host/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> **Language**: English | [한국어 (README.ko.md)](./README.ko.md)

**Single, vendor-independent native desktop & remote web addon host framework (`v2.5.0`) with built-in Settings `Addon Manager` (`애드온 관리`) UI, zero-dependency staged runtime, Electron 45 sandboxed preload isolation, Shadow DOM UI isolation, per-surface content bounds & center-point API, SHA-256 trust pinning, bidirectional `settingsBridge`, and declarative named-scope `configBridge` (`AddonManifest.v2` with full `v1` backward compatibility).**

## Key Updates in v2.5.0 (Built-in Settings `Addon Manager` UI & Remote Web Visibility Controls)

- **Built-in Settings `Addon Manager` (`애드온 관리`) UI (Host-Owned Shadow DOM, SOLID #0)**:
  - Integrates a vendor-neutral Settings tab (`src/runtime/renderer/host-settings-ui.js`, declarative `HostProfile.settingsUi`) directly into the Electron renderer kernel — zero extra consumer plugin clutter and clean coexistence with native Settings tabs and peer plugin tabs (such as `MCP Manager`).
  - Displays live Desktop addon runtime status (`Running` / `Disabled` / `Blocked` / `Failed`), trust approval badges, declared capabilities (`Renderer`, `Main Hook`, `Settings`, `Config`), and Remote Web bundle sync state (`Up to date` / `Rebuild needed` / `Not built yet`) with one-click copy buttons for the build command and Bookmarklet.
- **Per-Addon Remote Web Visibility Preferences (`remote-preferences.json`)**:
  - Adds a host-privileged Main process service (`src/runtime/main/host-admin-service.js`) and claimed IPC channels (`HOST_ADMIN_STATE`, `HOST_ADMIN_SET_REMOTE_PREF`) — strictly isolated from consumer `addonHost` plugin handles.
  - Lets users toggle `Show on Remote Web` (`원격 웹 표시`) per compatible addon, persisting atomically to `HOST_DATA_DIR/remote-preferences.json` (never writing under `~/.gemini/config/plugins/`).
  - Updates `src/adapters/remote-web/addon-collector.js` and `scripts/build-remote.js` (`--remote-prefs`) so addons toggled off are excluded (`DISABLED_BY_REMOTE_PREFERENCES`) when rebuilding the Remote Web Userscript & Bookmarklet bundle.
- **Loader Profile Forwarding**:
  - `src/adapters/electron/host-loader-builder.js` forwards `uiSurfaces`, `settingsUi`, `remoteProfileId`, `remoteSupportedCapabilities`, `remotePrefsPath`, and `remoteDistDir` cleanly on `addon-host --upgrade` with zero `app.asar` re-patching.

## Key Updates in v2.4.0 (Per-Surface Bounds API, `--build-remote` Default Path Fix & F7 Hardening)

- **Per-Surface Content Bounds & Center-Point API (SOLID #0)**:
  - Adds vendor-neutral `src/runtime/renderer/surface-geometry.js` driven solely by declarative `HostProfile.uiSurfaces` descriptors (`settings-pane`, `customizations-page`, `automation-page`, `workspace` in `src/profiles/antigravity.js` and `src/profiles/antigravity-remote-web.js`).
  - Exposes `addonHost.getSurfaceBounds(surfaceIdOrOpts?)`, `addonHost.getActiveSurface()`, and `addonHost.listSurfaces()` returning deep-frozen `{ surfaceId, requestedSurfaceId, matched, source, left, top, right, bottom, width, height, centerX, centerY, insetLeft, insetTop, insetRight, insetBottom, viewport }`.
  - Extends `addonHost.openModal(slotId, { surface, align })` and `modalHandle.reposition(nextSurface?)` so plugin modals center cleanly within the active screen content area (automatically excluding sidebars/chrome and tracking window `resize` until closed), while preserving legacy viewport centering when omitted.
- **Fix: `--build-remote` Default CLI Path Fallback (`scripts/build-remote.js`)**:
  - Defaults omitted `configJsonPath`/`trustPolicyPath` to `undefined` instead of `null`, restoring profile fallback to `TRUST_POLICY_PATH` and `CONFIG_JSON_PATH` during default `addon-host --build-remote` runs while preserving programmatic explicit `null` opt-out.
- **Security Hardening (`F7`)**:
  - Filters `profile.extraNoTranslateAttributes` through `isSafeExtraAttrName` before `activeKernel.boot()` in `src/adapters/remote-web/remote-bootstrap.js`.

## Key Updates in v2.3.0 (Remote Web Host Integration & Option A Named-Scope `configBridge`)

- **Remote Web Host (`antigravity-remote-web`) & Unified `HostBridgePort`**:
  - Extracts a transport-neutral `HostBridgePort` so the exact same renderer kernel (`src/runtime/renderer/kernel.js`) runs on both Desktop Electron (preload `claim(nonce)`) and Remote Web (`https://antigravity.google.com/*`).
  - Adds multi-profile compatibility (`compatibleHostProfiles`, `compatibility.hostProfiles`, `compatibility.excludeHostProfiles`) and `supportedCapabilities` gating: existing `antigravity-desktop` `AddonManifest.v2` renderer addons automatically run on Remote Web, dual-capability addons safely skip `mainHook`, and `mainHook`-only addons fail closed (`ERR_UNSUPPORTED_HOST_CAPABILITY`).
  - Ships vendor-neutral browser runtime modules (`src/adapters/remote-web/`), Shadow-DOM status/settings/diagnostics drawer, zero-HTML-sink DOM helpers, scoped TrustedTypes guard, and deterministic Userscript & Bookmarklet builder (`npm run build:remote`, `npm run check:remote`, `addon-host --build-remote`, `addon-host --profile remote-web --status`). See [Remote Web Host Guide (`docs/REMOTE_WEB.md`)](./docs/REMOTE_WEB.md).
- **Option A Declarative Named-Scope `configBridge` (`AddonManifest.v2`)**:
  - Lets explicitly trusted (`trustLevel: "trusted"` + SHA-256 `trust-policy.json` pinned) renderer plugins declare vendor-neutral `configBridge.scopes` (`[{ scopeId, access: "ro" | "rw", maxBytes? }]`) with single-`rw` writer enforcement in `SlotRegistry` (`ERR_DUPLICATE_CONFIG_SCOPE_WRITER`).
  - Antigravity profile defines 3 named scopes exclusively in `src/profiles/antigravity.js`: `antigravity:mcp-config` (`rw`, `~/.gemini/config/mcp_config.json` with private rotating backups), `antigravity:plugin-mcp-configs` (`ro`, `~/.gemini/config/plugins/*/mcp_config.json`), and `antigravity:mcp-config-legacy` (`ro`, `~/.gemini/antigravity/mcp_config.json`).
  - Main process enforces ancestor symlink/junction confinement, single-fd bounded reads, raw-text corruption recovery (`status: "corrupt"`), advisory lockfiles, SHA-256 CAS (`ERR_CONFIG_CAS_CONFLICT`), `fsyncSync` + Windows retryable atomic `renameSync`, and zero `app.asar` re-patching.

## Key Updates in v2.2.0 (Trusted `settingsBridge.saveSettings` IPC, Centered Modal Portal & Hardening)

- **Trusted `settingsBridge.saveSettings()` Bidirectional Persistence**: Trusted (`trustLevel: "trusted"` + SHA-256 `trust-policy.json` pinned) plugins with a declared `settingsBridge` can now persist validated JSON settings atomically from World `998` via `addonHost.saveSettings(nextData)`. The Main process enforces `verifyClaimedEvent`, `(wcId, pluginId)` trusted binding, path confinement, reserved-file and symlink rejection, `parseSafeJson` prototype-pollution guards, `maxBytes` limits, atomic temp+rename writes with Windows lock retries, and immediate multi-window broadcast (`zero app.asar re-patch`).
- **Centered Top-Layer `<dialog>` Modal Portal under App CSS Resets**: `modal-portal.js` now positions `<dialog>` with `position: fixed; inset: 0; top: max(env(titlebar-area-height, 36px), 36px); margin: auto; width: fit-content; height: fit-content;` so all plugin modals center cleanly below the titlebar even under Tailwind Preflight (`* { margin: 0 }`).
- **Multi-Window `settingsBridge` Sync (`I1`)**: Joining windows calling `readSnapshotForPlugin` now propagate detected file updates to already-active windows while per-`wcId` delivery deduplication prevents duplicate pushes.
- **Windows Transient File-Lock & Watcher Self-Healing (`I2`)**: Transient `EBUSY`/`EPERM`/`EACCES` locks retry with bounded backoff (`80ms → 160ms → 320ms`) before failing closed, and `fs.watch` automatically reconnects with exponential backoff (`500ms → 5000ms`) after directory creation or watcher errors.
- **World `998` Primordial Hardening & `invokeAction` Trust Boundary (`I4`)**: `kernel.js` captures all critical JS primordials (`Object.freeze`, `Map`/`Set`/`WeakMap`/`WeakSet`, `Set.prototype.size`, `JSON.stringify`, `Promise`, `forEach`, `Reflect.apply`, `Error`, `String`, `Uint8Array`, `crypto.getRandomValues`) before plugin execution, eliminates iterator-protocol calls in privileged paths, and enforces `trustLevel` isolation on `listActions()` / `invokeAction()` (`ERR_ACTION_TRUST_FORBIDDEN`).
- **Lifecycle & CSS Cleanups (`I10`)**: `onDispose` callbacks run before marking handles disposed, `lifecycleStates` aggregates per-window state cleanly on window close, `will-quit` replaces cancellable `before-quit`, and `style-manager` preserves `[attr]` owner-prefixed selectors.

## Key Capabilities in v2.1.0 (additive over v2.0.0)

- **Unidirectional Read-Only `settingsBridge` (`AddonManifest.v2`)**: Trusted (`trustLevel: "trusted"` + `trust-policy.json` SHA-256 pinned) renderer plugins can declare an optional `settingsBridge: { fileName, maxBytes }` bound to a flat JSON file inside the host-owned data directory (`HOST_DATA_DIR`, never `~/.gemini/config/plugins/`). The Main process enforces symlink rejection (`lstatSync`), `realpathSync` confinement, reserved host file blocking (`trust-policy.json`, `config.json`, `*.orig.json`, etc.), pre/post-read `maxBytes` caps, `parseSafeJson` prototype-pollution protection, and SHA-256 deduplication over a single debounced `fs.watch`, pushing deep-frozen snapshots to World `998` via `addonHost.getSettings()` / `addonHost.onSettingsChange(cb)` with zero renderer-to-main write IPC and zero `app.asar` re-patching on upgrade from `v2.0.0`.

## Key Capabilities in v2.0.0

- **Zero-Dependency Staged Runtime (`dist/runtime/` + `buildSha8`)**: Pre-compiled standalone manifest validators (`validate-v1.cjs`, `validate-v2.cjs`), single-file sandboxed preload (`preload-bridge.cjs`), and modular World `998` renderer kernel (`kernel-bundle.cjs`) run with **zero external `node_modules`** — enforced by an Acorn AST 0-dep check (`npm run check:runtime`) and a true zero-`node_modules` isolated Electron E2E harness (`npm run test:e2e:isolated`).
- **Electron 45 Sandboxed Preload & Single-Claim Nonce Bridge (World `998`)**: Registers `preload-bridge.cjs` strictly on `session.defaultSession` (isolated partitions such as browser webviews receive zero preloads), exposes zero globals on Page World `0`, and uses single-claim per-document-generation `claimNonce` authentication inside World `998` (avoiding Electron's internal `999` world).
- **Option B2 Shadow DOM UI Isolation & Native Top-Layer Modal/Popover Stack**: `AddonManifest.v2` UI slots default to open `ShadowRoot` (`shadow: true`), returning an inner `<div class="addon-host-slot-root">` (`HTMLElement`) so plugins retain `.style`/`.classList` ergonomics while isolating styles from the host document (`v1` manifests default `shadow: false`, and `document-transform` always uses light DOM). Native `<dialog>.showModal()` and `popover="manual"` provide a LIFO `Escape` / focus-restore stack coordinated with the host via a non-destructive `PortalArbiter` keyed by `webContents.id`.
- **Default-Deny SHA-256 Trust Pinning & Memory-Backed CJS `mainHook` Loader**: `strictTrustPolicy: true` is enforced by default. Privileged (`trustLevel: "trusted"`) renderer scripts and `mainHook` bundles require explicit approval in `trust-policy.json` (`addon-host trust approve <pluginId>`). Approved `mainHook` bundles are snapshotted in memory with symlink-escape rejection and executed via an isolated in-memory CommonJS loader that blocks `require()` of `fs`, `electron`, `node_modules`, absolute paths, `file://`, and `.mjs` (a TOCTOU and casual-`require()` guard on SHA-256-pinned trusted Node code — not an OS sandbox).
- **Clean `app.asar` Ownership, `V1 -> V2` Upgrade & Zero `plugins/` Writes**: Backups (`.orig`, `.orig.json`, `index.json`) live strictly in `~/.gemini/antigravity/backups/` (keeping `resources/` clean, with `N=3` retention pruning and `UPDATED_UNPATCHED` vs `rolledBackAt` tracking), fail fast on `EBUSY`/`EPERM` (`ERR_TARGET_LOCKED_APP_RUNNING`), and never write inside `~/.gemini/config/plugins/`.
- **Vendor- & Runtime-Independent Core**: `src/core/` has zero Antigravity, Electron, `node:fs`, or `node:path` imports (`FileSystemPort` DIP), while `HostLifecyclePort` and `AddonStorePort` remain segregated and unchanged (`TC-001`–`TC-001d`, `TC-014`, `TC-023`).

## Security & Isolation Threat Model

- **Renderer Isolation (World `998` — Coexistence + Defense-in-Depth)**: Plugins execute in Electron Isolated World `998` (separated from Page World `0` and Electron preload World `999`) with a non-writable, host-token-authenticated kernel, Option B2 Shadow DOM slots, and strict CSS sanitization. This provides strong coexistence and defense-in-depth between well-behaved or buggy plugins and the host app; it is **not** a hostile multi-tenant OS sandbox between plugins sharing the same renderer process.
- **`mainHook` Trust Boundary (SHA-256 Pinned Node Code)**: `mainHook` is strictly Default-Deny (`strictTrustPolicy: true`). Only explicitly user-approved (`addon-host trust approve <pluginId>`), SHA-256-pinned bundles execute in the Main process via the memory-backed CommonJS loader (eliminating disk TOCTOU tampering and accidental external requires). In **`v2.1.0`**, plugins that only need host-persisted settings can drop `mainHook` completely and use the unidirectional read-only `settingsBridge` (full multi-process RPC `SidecarBridge` remains deferred to a future minor release).

## Quick Start

```bash
npm ci
npm run build:runtime
npm run test:all

# Read-only status & diagnostics
node ./bin/addon-host.js --status
node ./bin/addon-host.js --doctor

# Validate & register a plugin manifest (v1 or v2)
node ./bin/addon-host.js --validate path/to/addon-manifest.json
node ./bin/addon-host.js --register path/to/addon-manifest.json

# Manage SHA-256 trust approvals for trusted plugins
node ./bin/addon-host.js trust list
node ./bin/addon-host.js trust approve <pluginId>
node ./bin/addon-host.js trust revoke <pluginId>

# Build & verify Remote Web Userscript / Bookmarklet bundle
npm run check:remote
npm run build:remote
node ./bin/addon-host.js --profile remote-web --status
node ./bin/addon-host.js --build-remote --no-addons --check

# Install, upgrade (V1 -> V2), or roll back the shared app.asar bootstrap hook
node ./bin/addon-host.js --install
node ./bin/addon-host.js --upgrade
node ./bin/addon-host.js --rollback
```

## Plugin Renderer Usage (`AddonManifest.v2`)

```js
// Executed inside Isolated World 998 with a capability-scoped `addonHost` handle:
const rootEl = addonHost.mountSlot('my-plugin.panel'); // HTMLElement inside open ShadowRoot (v2 default)
if (rootEl) {
  rootEl.textContent = 'Ready';
  addonHost.injectStyle('base', '.btn { color: inherit; }', { slotId: 'my-plugin.panel' });
  addonHost.onDispose(() => { /* deterministic cleanup */ });
}
```

## Documentation

- [Release Notes (`v2.5.0` EN/KO)](./RELEASE_NOTES_v2.5.0.md)
- [Release Notes (`v2.4.0` EN/KO)](./RELEASE_NOTES_v2.4.0.md)
- [Release Notes (`v2.3.0` EN/KO)](./RELEASE_NOTES_v2.3.0.md)
- [Remote Web Host Guide (`docs/REMOTE_WEB.md`)](./docs/REMOTE_WEB.md)
- [Release Notes (`v2.2.0` EN/KO)](./RELEASE_NOTES_v2.2.0.md)
- [Release Notes (`v2.1.0` EN/KO)](./RELEASE_NOTES_v2.1.0.md)
- [Release Notes (`v2.0.0` EN/KO)](./RELEASE_NOTES_v2.0.0.md)
- [한국어 문서 (`README.ko.md`)](./README.ko.md)
- [JSON Schema v2 (`schemas/addon-manifest.v2.schema.json`)](./schemas/addon-manifest.v2.schema.json)
- [JSON Schema v1 (`schemas/addon-manifest.v1.schema.json`, frozen)](./schemas/addon-manifest.v1.schema.json)
- [Architecture & Vendor-Independence](./docs/ARCHITECTURE.md)
- [Test Cases](./docs/TEST_CASES.md)

## License

[MIT](./LICENSE)
