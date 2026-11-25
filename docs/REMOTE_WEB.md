# Remote Web Host (`antigravity-remote-web`)

[한국어 문서 (Korean)](./REMOTE_WEB.ko.md)

`antigravity-addons` v2.7.0 delivers a **universal Remote Web Host** (`antigravity-remote-web`) built directly on top of the shared renderer kernel (`src/runtime/renderer/kernel.js`) and `HostBridgePort` contract.

Its primary design goal is **universal cross-device and cross-browser usability** (iOS/iPadOS, Android, and any desktop browser). Any compliant `AddonManifest.v2` renderer plugin written for `antigravity-desktop` runs on Antigravity Remote Web (`https://antigravity.google.com/*`) without rewriting against a separate web-only API.

## Platform Support Matrix (Universal Userscript Primary)

| Platform / Browser | Primary Delivery | Notes & Honest Caveats |
| --- | --- | --- |
| **iOS / iPadOS Safari** | **Userscripts** (free open-source App Store extension) + `antigravity-remote.user.js` | Runs as a Safari Web Extension. *Standalone Home-Screen PWA web apps on iOS do not execute Safari extensions.* |
| **Android Firefox** | **Violentmonkey** add-on + `antigravity-remote.user.js` | Installable directly from Mozilla Add-ons. *Stock Android Chrome does not support extensions or Userscripts.* |
| **macOS / Windows / Linux Browsers** (Chrome, Edge, Firefox, Safari, Brave, Arc) | **Violentmonkey / Tampermonkey / Userscripts** + `antigravity-remote.user.js` | Isolated execution via `@inject-into content`, `GM_getValue`/`GM_setValue` persistence, optional `@updateURL`/`@downloadURL` auto-updates. |
| **Local Desktop Chrome / Edge (Secondary)** | Unpacked MV3 extension (`remote-dist/extension/`) | Secondary convenience path when no Userscript manager is installed (`world: "ISOLATED"`). |

> **Verification boundary**: Bookmarklets (`javascript:`) are blocked by `antigravity.google.com`'s 3-policy intersected CSP (`script-src 'nonce-...'` + `require-trusted-types-for 'script'`) and browser length limits. Authenticated post-login DOM selectors and in-browser external translation API CORS behavior depend on a live signed-in session.

## Architecture & SOLID Boundaries

- **Host Profile (`src/profiles/antigravity-remote-web.js`)**:
  - `id`: `'antigravity-remote-web'`
  - `compatibleHostProfiles`: `['antigravity-desktop']`
  - `supportedCapabilities`: `['renderer']`
  - `allowedOrigins`: `['https://antigravity.google.com']`
  - `trustedTypesPolicyName`: `'antigravity-remote-addon-host'`
  - `excludeOfflineConfigBridge`: `true`
  - All Antigravity-specific origins, namespaces, UI anchor selectors, and default release base URLs live exclusively in this profile.
- **Vendor-Neutral Browser & Delivery Adapter (`src/adapters/remote-web/`)**:
  - `origin-guard.js`: Fail-closed origin allowlist (blocks non-HTTPS schemes, credentials, lookalike domains, `about:`, `data:`, `javascript:`, `file:`).
  - `trusted-types-guard.js`: Scoped TrustedTypes policy forbidding `default` / `dompurify` / `angular` and unconditionally rejecting HTML string sinks.
  - `dom-guard.js`: Zero-HTML-sink DOM helpers (`createElement`, `textContent`, Shadow DOM container factory).
  - `remote-host-bridge.js`: Concrete `HostBridgePort` with automatic storage selection: `GM_getValue`/`GM_setValue`/`GM_deleteValue` (sync) or `GM.getValue`/`GM.setValue`/`GM.deleteValue` (async + `hydrateSettings()`) first, falling back cleanly to `localStorage` → `memory-ephemeral`.
  - `addon-collector.js`: Reuses `planAddonExecution`, `readVerifiedRendererScript`, and Default-Deny `trust-policy.json` SHA-256 verification while excluding desktop-only `configBridge` addons by default (`ERR_REMOTE_REQUIRES_LOCAL_CONFIG_BRIDGE`).
  - `remote-bootstrap.js`: Origin-gated browser bootstrap supporting both static packed addons and modular `@require` dynamic `registerAddon(descriptor)` addons, mounting a mobile-first Shadow-DOM drawer (`44px` touch targets, `<= 640px` bottom sheet, `env(safe-area-inset-*)`, clickable Settings Tabs & Quick Actions).
  - `qr-ascii.js` & `remote-lan-server.js`: Zero-dependency ISO/IEC 18004 QR code encoder and 128-bit random-token LAN HTTP transfer server (`--serve-remote`).

## Plugin Compatibility Rules

1. **Zero-Edit Auto-Inclusion**: Existing `AddonManifest.v2` renderer addons targeting `compatibility.hostProfile: "antigravity-desktop"` (or omitting `hostProfile`) are automatically included when packing for Remote Web.
2. **Desktop-Only `configBridge` Default Exclusion (`v2.7.0`)**:
   - Addons declaring `configBridge.scopes` (e.g. local `~/.gemini/config/mcp_config.json` managers) cannot access the local filesystem from a browser and are excluded by default (`ERR_REMOTE_REQUIRES_LOCAL_CONFIG_BRIDGE`).
   - Addons can opt in explicitly via `compatibility.hostProfiles: ["antigravity-remote-web"]` or CLI `--include-offline-config-bridge`.
3. **Explicit Opt-Out**: Addons declaring `compatibility.excludeHostProfiles: ["antigravity-remote-web"]`, omitting `"antigravity-remote-web"` from explicit `compatibility.hostProfiles`, or disabled in `remote-preferences.json` are excluded.
4. **Fail-Closed `mainHook` Handling**:
   - Dual-capability addons (`["renderer", "mainHook"]`) safely skip `mainHook` and load only their verified `rendererScript`.
   - `mainHook`-only addons are rejected fail-closed (`ERR_UNSUPPORTED_HOST_CAPABILITY`).
5. **Trust Pinning**: Trusted addons (`trustLevel: "trusted"` or declaring `settingsBridge` / `configBridge` / `document-transform`) require matching SHA-256 approval in `trust-policy.json`.

## Modular `@require` Plugin Composition (`v2.7.0`)

`antigravity-remote-host.lib.js` is a standalone, 0-addon Remote Web host library. Independent plugin authors can load the host via `@require` and register their own addon via `registerAddon()`:

```js
// ==UserScript==
// @name         My Remote Addon
// @match        https://antigravity.google.com/*
// @run-at       document-idle
// @inject-into  content
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @require      https://github.com/jaeseongs95/antigravity-addons/releases/latest/download/antigravity-remote-host.lib.js
// ==/UserScript==

(function () {
  'use strict';
  const rt = globalThis.__addonHostRemoteRuntime;
  if (!rt) return;
  rt.registerAddon({
    pluginMeta: {
      schemaVersion: 2,
      pluginId: 'my-remote-addon',
      displayName: 'My Remote Addon',
      version: '1.0.0',
      trustLevel: 'restricted',
      capabilities: ['renderer'],
      uiSlots: [{ slot: 'status-bar', slotId: 'my-remote-addon.bar', anchor: 'status-bar', shadow: true }],
    },
    run(addonHost) {
      addonHost.registerSettingsTab('settings', {
        label: 'My Addon Settings',
        onSelect() {
          /* open settings modal */
        },
      });
    },
  });
  rt.bootRemoteWebHost();
})();
```

## Building, LAN QR Transfer & Verification

### 1. Deterministic Host-Only Verification (CI-safe, zero personal data)

```bash
node scripts/build-remote.js --no-addons --check
```

### 2. Local Packing (Bundles Your Enabled Remote-Compatible Plugins)

```bash
node ./bin/addon-host.js --build-remote
```

Optional flags:

- `--out-dir <path>`: Output directory (default: `dist/remote`, or `~/.gemini/antigravity/remote-dist` via `addon-host`)
- `--update-base-url <https-url>`: Emit `@updateURL` / `@downloadURL` headers pointing to an HTTPS release base URL
- `--include-offline-config-bridge`: Force-include desktop `configBridge` addons
- `--include-settings-snapshots`: Pack sanitized initial snapshots for approved trusted `settingsBridge` plugins (off by default)
- `--no-addons`: Emit a 0-addon host-only bundle

### 3. One-Shot LAN QR Mobile Transfer (`--serve-remote`)

```bash
node ./bin/addon-host.js --serve-remote --once
```

- Renders a 0-dep UTF-8 QR code and one-time LAN URL (`http://<LAN-IP>:<port>/<128bit-token>/`) directly in your terminal.
- Serves only the exact tokenized allowlist (`/<token>/`, `/<token>/install`, `.user.js`, `.meta.js`, `.lib.js`) with `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`.
- Auto-shuts down after TTL (`300s` default) or immediately after the first `.user.js` download with `--once`.

### Build Outputs

- `antigravity-remote.user.js`: **Primary universal artifact** — Userscript for iOS Safari (`Userscripts`), Android Firefox (`Violentmonkey`), and Desktop (`Tampermonkey`/`Violentmonkey`) with `@inject-into content`, `@grant GM_getValue`/`GM_setValue`/`GM_deleteValue`, `@run-at document-idle`.
- `antigravity-remote.meta.js`: Userscript auto-update metadata header file.
- `antigravity-remote-host.lib.js`: 0-addon standalone host library for `@require` modular composition (no auto-boot).
- `extension/manifest.json` + `extension/content-script.js`: **Secondary desktop artifact** — Unpacked MV3 Chrome/Edge extension (`world: "ISOLATED"`).
- `remote-runtime.cjs`: Self-contained browser/Node runtime bundle for testing and embedding.
- `build-manifest.json`: Deterministic SHA-256 inventory, `userscript` / `extension` / `bookmarklet` metadata, packed addons, and `rejected` exclusions.

## Running Remote Web Tests

```bash
node --test test/unit/v23-remote-web-adapter.test.js
node --test test/unit/v27-universal-remote-web.test.js
node --test test/e2e/v23-remote-web-chromium.test.js
```
