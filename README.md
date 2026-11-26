# antigravity-addons

[![CI](https://github.com/jaeseongs95/antigravity-addons/actions/workflows/ci.yml/badge.svg)](https://github.com/jaeseongs95/antigravity-addons/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> **Language**: English | [한국어 (README.ko.md)](./README.ko.md)  
> *(Formerly `antigravity-native-addon-host` — existing `addon-host` CLI command, `ADDON_HOST_LOADER_V2` marker, and `antigravity-desktop` / `antigravity-remote-web` profiles remain 100% backward-compatible.)*

**Single, vendor-independent API-First native desktop & universal remote web addon host framework (`v3.1.1`) with Host-Managed Unified Remote Bridge (`ag-bridge-v1:` 1-line Pairing Code + Chrome PNA preflight + 1-click in-app Remote Bundle rebuild), 3-Tier `AddonContextV3` (`AddonManifest.v3` + 1-major `v2` compatibility adapter), dual-key `net.fetch` (DNS-rebinding protection + trusted `localLoopback`), separate `@antigravity-addons/sdk`, GitHub Pages 1-Click Hub, Desktop auto-update survival (`--reconcile --handoff`), zero-dependency staged runtime, Electron 45 sandboxed preload isolation, Shadow DOM UI isolation, and SHA-256 trust pinning.**

## Key Updates in v3.1.1 (Chrome PNA Preflight & Self-Hosted Remote Bridge Guides)

- **Chrome/Edge Private Network Access (PNA) Preflight (`remote-bridge-server.js`)**:
  - Returns `Access-Control-Allow-Private-Network: true` (`Vary: Origin, Access-Control-Request-Private-Network`) on `OPTIONS` preflights strictly for allowlisted `Origin`s so `https://antigravity.google.com` connects cleanly to same-PC `http://127.0.0.1:19384` or private-network HTTPS reverse proxies in modern Chromium. Disallowed origins continue to fail closed with `403`.
- **Self-Hosted Connection Examples**:
  - Added concise setup examples below for Same PC, Home Router (Port Forwarding + DDNS + HTTPS Reverse Proxy), Cloudflare Tunnel, and Tailscale Funnel.

## Key Updates in v3.1.0 (Host-Managed Unified Remote Bridge Framework & `userApprovedHttps` Fix)

- **Native Host-Managed Unified Remote Bridge (`src/runtime/main/remote-bridge-server.js` + `src/adapters/remote-web/remote-host-transport.js`)**:
  - Centralizes Remote Web <-> Desktop communication in the Native Host so individual plugins never have to ship per-plugin Remote URL/Token inputs or bespoke remote servers.
  - Disabled by default (`enabled: false`), configured from Desktop **Settings -> Addon Manager** with a CSPRNG 256-bit Bearer token in reserved `remote-bridge.json` (`0o600`), strict exact-`Origin` CORS, constant-time auth, live SHA-256 trust verification per request, and a 1-line Pairing Code (`ag-bridge-v1:...`).
  - Remote Web Drawer adds a dedicated **Host Bridge** tab (index 3) that pairs once and transparently routes `ctx.settingsBridge`, `ctx.configBridge`, and `ctx.net.fetch` (including trusted `localLoopback` sidecars), broadcasting `host:remote-bridge-changed`.
- **1-Click In-App Remote Bundle Rebuild**:
  - Desktop **Settings -> Addon Manager** now includes a 1-click **`Rebuild Bundle Now` (`지금 원격 번들 빌드`)** button executing the host CLI directly via `execFile` (`shell: false`).
- **Fix: Preserve `permissions.net.userApprovedHttps: true`**:
  - Fixed `src/core/manifest-normalizer.js` (`normalizePermissionsV3`) dropping `userApprovedHttps: true` during v3 manifest normalization.

## Key Updates in v3.0.1 (v3 Ecosystem Parity & Polish)

- **Capability-Gated `ctx.settingsBridge` on `AddonContextV3`**:
  - Exposes primordial-hardened, frozen `ctx.settingsBridge` (`getSettings`/`getSnapshot`, `onSettingsChange`/`onDidChange`, `saveSettings`/`save`) strictly when a v3 plugin declares `settingsBridge` and is trust-approved, with automatic `lifecycle.onDispose` listener cleanup and full `createTestHost({ initialSettings })` SDK parity.
- **Desktop Settings Sidebar & Addon Manager Integration for `ui.registerSettingsPage`**:
  - Connects `settingsPageCoordinator` to `createHostSettingsUi`: every v3 plugin calling `ctx.ui.registerSettingsPage` now automatically appears in the **Desktop Settings left sidebar** (directly below `Addon Manager`) AND as a quick **`Settings` / `설정`** button inside its `Addon Manager` card, reacting live to plugin mount/dispose with zero plugin DOM scraping.
- **Userscript Header, SDK & Canvas/Schema Fixes**:
  - `scripts/build-remote.js`: `--build-addon-userscript` `@description` now dynamically emits `AddonManifest.v3` / `v2` according to `manifest.schemaVersion`.
  - `packages/sdk/src/test-host.js`: guards mock `querySelectorAll` against text nodes (`nodeType: 3`) and adds `doc.createTextNode()`.
  - `src/runtime/renderer/context-v3.js`: fixes `ui.mountCanvas` token CSS injection via `slotHandle.getRootNode()` fallback.
  - `src/runtime/renderer/settings-page-coordinator.js`: accepts `getSchema`-only dynamic pages in `ui.registerSettingsPage`.

## Key Updates in v3.0.0 (API-First 3-Tier Framework, `@antigravity-addons/sdk` & 1-Click Hub)

- **3-Tier ISP-Segregated `AddonContextV3` + 1-Major `v2` Compat Adapter** ([API_V3.md](./docs/API_V3.md)):
  - **Tier 1 (Zero-DOM)**: `ui.showToast`, `ui.confirm`, `ui.prompt`, `ui.registerCommand`, `ui.registerStatusItem` (`host.statusbar` delegation + fallback bar + click modifiers), `ui.registerSettingsPage` (unified Desktop + Remote Web).
  - **Tier 2 (Host-Positioned Overlays + Declarative JSON Schema)**: `ui.openPopup`, `ui.openModal`, `ui.openPanel` with `PlacementSpec` flip/shift/resize/scroll tracking, mobile `<=640px` bottom-sheet auto-switch, Top Layer `<dialog>`/`popover`, non-removable `Addon: <displayName>` badge, 16 closed primitives, static `visibleWhen`/`disabledWhen` (zero `eval`), and ID-based in-place `handle.update(nextTree)`.
  - **Tier 3 (Controlled Escape Hatch)**: `ui.mountCanvas` (open Shadow DOM + `--ag-*` tokens), `ui.createStyleElementSafe`, manifest-gated `dom`.
  - **ISP & Security**: `env` exposes abstract capabilities (never raw `hostProfileId`); undeclared `net`/`dom`/`configBridge` are omitted; dual-key `net.fetch` blocks SSRF/IMDS/DNS-rebinding on `httpsHosts` and enforces 0-redirect Desktop-trusted-only `localLoopback`; `services` enforces `<pluginId>.<name>`, default-deny `allowedCallers`, and prototype-key stripping.
  - **SOLID #0**: Extracted remaining layout selectors out of `kernel.js` into profiles and enforced `npm run check:solid` in CI.
- **Separate `@antigravity-addons/sdk` (`packages/sdk/`) & GitHub Pages 1-Click Hub (`docs/hub/`)**:
  - Ships `index.d.ts`, `defineAddon()`, `h()`, real-kernel `createTestHost({ surface })`, `ag-addon init|check|dev|build|pack`, and reusable GH Action while keeping `antigravity-addons` runtime at **0 new npm dependencies**.
  - Deterministic `npm run build:hub` / `check:hub` generates the static 1-Click Hub with Safari routing to the curated all-in-one `.user.js` (`mode: 'closed'` Shadow DOM + `GM_*` closure shadowing).

## Key Updates in v2.8.0 (Public HTTPS Modular Addon Userscripts & Multi-Sandbox Coexistence)

- **Multi-Userscript Sandbox Coexistence (Zero Private IP, True 1-Click Public HTTPS)**:
  - Upgrades `src/adapters/remote-web/remote-bootstrap.js` with per-plugin DOM ownership (`data-remote-addon-host-plugins`) and peer drawer projection: multiple independent `@require` Userscripts running in separate Tampermonkey/Violentmonkey/Safari sandboxes automatically coexist inside a **single unified Shadow-DOM drawer** (`drawerCount === 1`, aggregate `active/total` pill badge, clickable Quick Actions & Settings Tabs per sandbox, strict per-sandbox `hostToken` and `GM_*` isolation, independent disposal) while preserving the cross-world duplicate-bundle guard (`TC-RW-E2E`).
- **Standard Modular Addon Userscript Builder (`addon-host --build-addon-userscript`)**:
  - Adds `buildAddonUserscript` (`scripts/build-remote.js`) and CLI routing (`bin/addon-host.js`) so any `AddonManifest.v2` plugin repository can deterministically emit Acorn-AST-verified `<pluginId>.user.js` + `<pluginId>.meta.js` linked via HTTPS `@require` to `antigravity-remote-host.lib.js` with optional HTTPS `@updateURL`/`@downloadURL`, strict `@connect` host allowlists, and optional `GM_xmlhttpRequest`.
- **Honest Settings UI & Docs**:
  - Clarifies that public HTTPS per-addon `.user.js` releases (and one-time cloud/messenger import of locally packed `.user.js`) work anywhere (LTE/5G/external devices with home PC off), while `--serve-remote` is an optional same-Wi-Fi local transfer helper only.

## Key Updates in v2.7.0 (Universal Cross-Device Remote Web Delivery, Interactive Mobile Drawer & Modular `@require` Host)

- **Universal Userscript Primary Delivery & Modular `@require` Host Library**:
  - Promotes universal cross-device Userscript (`antigravity-remote.user.js` + `antigravity-remote.meta.js`) to the primary Remote Web delivery path for **iOS/iPadOS Safari (`Userscripts`)**, **Android Firefox (`Violentmonkey`)**, and **Desktop browsers (`Violentmonkey`/`Tampermonkey`)**, keeping unpacked MV3 Chrome/Edge extension (`remote-dist/extension/`) as a secondary desktop option.
  - Emits `antigravity-remote-host.lib.js` (0-addon runtime library) and adds `globalThis.__addonHostRemoteRuntime.registerAddon(descriptor)` so independent plugins can compose via `@require` without bundling the host.
  - Upgrades Userscript headers to `@inject-into content`, `@grant GM_getValue`/`GM_setValue`/`GM_deleteValue` (with automatic `GM_*` → `localStorage` → `memory-ephemeral` storage fallback), and optional `--update-base-url <https-url>` (`@updateURL`/`@downloadURL`).
- **0-Dep LAN QR Mobile Transfer (`addon-host --serve-remote`)**:
  - Adds a zero-dependency ISO/IEC 18004 QR encoder (`src/adapters/remote-web/qr-ascii.js`) and tokenized LAN HTTP server (`src/adapters/remote-web/remote-lan-server.js`) with a 128-bit random URL token, exact route allowlist, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `300s` auto-shutdown TTL, and `--once` auto-close after the first `.user.js` download.
- **Interactive Mobile-First Remote Drawer & Smart `configBridge` Filtering**:
  - Upgrades `kernel.js` / `settings-tab-coordinator.js` / `remote-bootstrap.js` with host-token-guarded `selectSettingsTab`, `listHostActions`, and `invokeHostAction`: Settings Tabs and Quick Actions inside the Shadow-DOM drawer are now clickable buttons (`>= 44px` touch targets, `@media (max-width: 640px)` full-width bottom sheet, `env(safe-area-inset-*)`).
  - Excludes desktop-only `configBridge` addons by default (`ERR_REMOTE_REQUIRES_LOCAL_CONFIG_BRIDGE`, overridable via explicit `antigravity-remote-web` opt-in or `--include-offline-config-bridge`) and updates Desktop `Settings > Addon Manager` to prioritize Userscript & LAN QR copy actions.

## Key Updates in v2.6.0 (Unpacked MV3 Browser Extension Delivery, Kernel Slimming & CSP/TrustedTypes Hardening)

- **Primary Remote Web Delivery — Local Unpacked MV3 Browser Extension (`remote-dist/extension/`)**:
  - `addon-host --build-remote` now generates a self-contained Manifest V3 browser extension (`extension/manifest.json` + `extension/content-script.js`) alongside `antigravity-remote.user.js` and `remote-runtime.cjs`.
  - Runs strictly in Chromium's `"world": "ISOLATED"` (matching Desktop Electron World `998`), natively bypassing `script-src 'nonce-...'` and TrustedTypes injection limits with **zero** `permissions`, `host_permissions`, `background`, or `web_accessible_resources`, and fail-closed HTTPS `matches` derived exclusively from `HostProfile.allowedOrigins` via vendor-neutral `src/adapters/remote-web/extension-manifest.js` (SOLID #0).
  - Public GitHub remains strictly host-only (`--no-addons`, zero packed peer plugins or local settings snapshots).
- **64 KB Fail-Closed Bookmarklet Cap & Slimmed Remote Kernel**:
  - Excludes desktop-only `host-settings-ui.js` (~61.5 KB) from Remote Web bundles (`buildRendererKernelBundleSource({ includeHostSettingsUi: false })`).
  - Replaces the old 2 MB bookmarklet cap with `BOOKMARKLET_MAX_RUNNABLE_CHARS = 65536`: oversized unrunnable `bookmarklet.txt` files are omitted on build (cleaning up stale legacy files) and never serialized across Electron IPC.
- **Expanded Acorn AST TrustedTypes Gate & Operability Hardening**:
  - Expands `verifyRemoteBundleAst` to block `setHTMLUnsafe`, `srcdoc`, `createContextualFragment`, `parseFromString`, string-argument `setTimeout`/`setInterval`, `createElement('script')`, `new Worker`/`SharedWorker`, and inline `setAttribute('on*', ...)`.
  - Adds cross-world duplicate-boot DOM guard (`data-remote-addon-host-active`), early drawer mount before addon execution with failed-addon error indicators, logged auto-boot failures, Windows `EBUSY`-safe in-place rebuilds, and updated `Settings > Addon Manager` primary/secondary copy actions (`Copy extension path`, `Copy userscript path`, `Copy command`) with a compact 2-step `chrome://extensions` guide.

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

# Build, verify & transfer Remote Web Universal Userscript bundle (LAN QR)
npm run check:remote
npm run build:remote
node ./bin/addon-host.js --profile remote-web --status
node ./bin/addon-host.js --build-remote --no-addons --check
node ./bin/addon-host.js --serve-remote --once

# Install, upgrade (V1 -> V2), or roll back the shared app.asar bootstrap hook
node ./bin/addon-host.js --install
node ./bin/addon-host.js --upgrade
node ./bin/addon-host.js --rollback
```

## Exposing Remote Host Bridge (Self-Hosted Examples)

The Remote Host Bridge is **disabled by default** (`127.0.0.1:19384`). Enable it in Desktop **Settings → Addon Manager → Remote Host Bridge**, then pair once by pasting the 1-line Pairing Code (`ag-bridge-v1:...`) into the Remote Web Drawer **Host Bridge** tab.

> **Security**: Because `https://antigravity.google.com` is an HTTPS origin and requests carry `Authorization: Bearer <token>`, **never expose plain HTTP to the internet**. Always place HTTPS/TLS in front for external access.

### 1. Same PC (Zero Tunnel)
1. Enable **Remote Host Bridge** with `Bind: 127.0.0.1`, `Port: 19384`, leave **Public HTTPS URL** blank, and click **Save**.
2. Click **Copy Pairing Code** and paste it into the Remote Web Drawer **Host Bridge** tab.

### 2. Home Router (Port Forwarding + DDNS + HTTPS Reverse Proxy)
1. Set `Bind: 0.0.0.0` (or keep `127.0.0.1` if the reverse proxy runs on the same PC) and `Port: 19384` in **Addon Manager**.
2. Configure DDNS (`bridge.example.com` or `xxx.iptime.org`) and forward TCP `443` (and `80` for ACME) on your router to your reverse proxy host (PC / NAS / OpenWrt / Nginx Proxy Manager / Caddy).
3. Terminate HTTPS with a reverse proxy — example `Caddyfile`:
   ```caddyfile
   bridge.example.com {
       reverse_proxy 127.0.0.1:19384
   }
   ```
4. Enter `https://bridge.example.com` in Desktop **Public HTTPS URL**, save, and copy the updated Pairing Code.

### 3. Cloudflare Tunnel (Zero Port Forwarding)
```bash
cloudflared tunnel --url http://127.0.0.1:19384
```
Paste the printed `https://<random>.trycloudflare.com` (or your named tunnel domain) into **Public HTTPS URL**, save, and copy the Pairing Code.

### 4. Tailscale Funnel (Zero Port Forwarding, Auto HTTPS)
```bash
tailscale funnel 19384
```
Paste your `https://<machine>.<tailnet>.ts.net` URL into **Public HTTPS URL**, save, and copy the Pairing Code.

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

- [Release Notes (`v3.1.1` EN/KO)](./RELEASE_NOTES_v3.1.1.md)
- [Release Notes (`v3.1.0` EN/KO)](./RELEASE_NOTES_v3.1.0.md)
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
