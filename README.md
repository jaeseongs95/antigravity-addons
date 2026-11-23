# antigravity-native-addon-host

[![CI](https://github.com/jaeseongs95/antigravity-native-addon-host/actions/workflows/ci.yml/badge.svg)](https://github.com/jaeseongs95/antigravity-native-addon-host/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> **Language**: English | [한국어 (README.ko.md)](./README.ko.md)

**Single, vendor-independent native desktop addon host framework (`v2.1.0`) with zero-dependency staged runtime, Electron 45 sandboxed preload isolation, Shadow DOM UI isolation, SHA-256 trust pinning, and unidirectional read-only `settingsBridge` push (`AddonManifest.v2` with full `v1` backward compatibility).**

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

- [Release Notes (`v2.1.0` EN/KO)](./RELEASE_NOTES_v2.1.0.md)
- [Release Notes (`v2.0.0` EN/KO)](./RELEASE_NOTES_v2.0.0.md)
- [한국어 문서 (`README.ko.md`)](./README.ko.md)
- [JSON Schema v2 (`schemas/addon-manifest.v2.schema.json`)](./schemas/addon-manifest.v2.schema.json)
- [JSON Schema v1 (`schemas/addon-manifest.v1.schema.json`, frozen)](./schemas/addon-manifest.v1.schema.json)
- [Architecture & Vendor-Independence](./docs/ARCHITECTURE.md)
- [Test Cases](./docs/TEST_CASES.md)

## License

[MIT](./LICENSE)
