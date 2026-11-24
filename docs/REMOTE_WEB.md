# Remote Web Host (`antigravity-remote-web`)

[한국어 문서 (Korean)](./REMOTE_WEB.ko.md)

`antigravity-addons` (formerly `antigravity-native-addon-host`) v2.3.0+ introduces a unified **Remote Web Host** profile (`antigravity-remote-web`) and browser adapter (`src/adapters/remote-web/`) built directly on top of the shared renderer kernel (`src/runtime/renderer/kernel.js`) and `HostBridgePort` contract.

Any compliant `AddonManifest.v2` renderer plugin built for `antigravity-desktop` runs automatically on Antigravity Remote Web (`https://antigravity.google.com/*`) without requiring a separate remote-only plugin API.

## Architecture & SOLID Boundaries

- **Host Profile (`src/profiles/antigravity-remote-web.js`)**:
  - `id`: `'antigravity-remote-web'`
  - `compatibleHostProfiles`: `['antigravity-desktop']`
  - `supportedCapabilities`: `['renderer']`
  - `allowedOrigins`: `['https://antigravity.google.com']`
  - `trustedTypesPolicyName`: `'antigravity-remote-addon-host'`
  - All Antigravity-specific origins, namespaces, and UI anchor selectors live exclusively in this profile.
- **Vendor-Neutral Browser Adapter (`src/adapters/remote-web/`)**:
  - `origin-guard.js`: Fail-closed origin allowlist (blocks non-HTTPS schemes, credentials, lookalike domains, `about:`, `data:`, `javascript:`, `file:`).
  - `trusted-types-guard.js`: Scoped TrustedTypes policy forbidding `default` / `dompurify` / `angular` and unconditionally rejecting HTML string sinks.
  - `dom-guard.js`: Zero-HTML-sink DOM helpers (`createElement`, `textContent`, Shadow DOM container factory).
  - `remote-host-bridge.js`: Concrete `HostBridgePort` implementation (`setPortalClaim`, `saveSettings`, `reportError`, `ping`, plus optional `readConfigScope` / `writeConfigScope`).
  - `addon-collector.js`: Node-side Phase-1 packer reusing `planAddonExecution`, `readVerifiedRendererScript`, and Default-Deny `trust-policy.json` SHA-256 verification.
  - `remote-bootstrap.js`: Origin-gated browser entry booting the shared renderer kernel, running packed renderer closures (zero `eval` / `new Function`), and mounting an accessible Shadow-DOM dark-mode status/settings drawer.

## Plugin Compatibility Rules

1. **Zero-Edit Auto-Inclusion**: Existing `AddonManifest.v2` renderer addons targeting `compatibility.hostProfile: "antigravity-desktop"` (or omitting `hostProfile`) are automatically included when packing for Remote Web.
2. **Explicit Opt-Out**: Addons declaring `compatibility.excludeHostProfiles: ["antigravity-remote-web"]` or an explicit `compatibility.hostProfiles` list omitting `"antigravity-remote-web"` are excluded fail-closed (`ERR_INCOMPATIBLE_HOST_PROFILE`).
3. **Fail-Closed `mainHook` Handling**:
   - Dual-capability addons (`["renderer", "mainHook"]`) safely skip `mainHook` (`skippedCapabilities: ["mainHook"]`, never packing `mainHookScript`) and load only their verified `rendererScript`.
   - `mainHook`-only addons are rejected fail-closed (`ERR_UNSUPPORTED_HOST_CAPABILITY`).
4. **Trust Pinning**: Trusted addons (`trustLevel: "trusted"` or declaring `settingsBridge` / `configBridge` / `document-transform`) require matching SHA-256 approval in `trust-policy.json`.

## Settings & Config Bridge Behavior (Phase 1 vs Phase 2)

- **Phase 1 (Browser-Local Persistence)**:
  - `addonHost.saveSettings(nextData)` persists JSON objects in namespaced `localStorage` (`agy-remote-addon-host:v2:settings:<pluginId>`), enforces `maxBytes` and prototype-pollution guards, and immediately notifies `addonHost.onSettingsChange` subscribers.
  - `addonHost.readConfigScope` / `writeConfigScope` return explicit offline/read-only errors (`ERR_REMOTE_CONFIG_BRIDGE_OFFLINE` / `ERR_REMOTE_CONFIG_BRIDGE_READ_ONLY`) unless read-only snapshots or an authenticated transport are provided.
- **Phase 2 Extension Point (OCP)**:
  - Injecting an authenticated `remoteTransport` into `bootRemoteWebHost({ remoteTransport })` enables live desktop sync for `saveSettings`, `readConfigScope`, and `writeConfigScope` without changing plugin code or `kernel.js`.

## Building & Verifying

### Deterministic Host-Only Verification (CI-safe, zero personal data)

```bash
node scripts/build-remote.js --no-addons --check
```

### Local Packing (Bundles Your Enabled `addons.d/*.json` Plugins)

```bash
node scripts/build-remote.js
```

Optional flags:

- `--out-dir <path>`: Output directory (default: `dist/remote`)
- `--addons-dir <path>`: Custom `addons.d` directory
- `--plugins-root <path>`: Custom plugins root directory
- `--config-json <path>`: Custom `config.json` path
- `--trust-policy <path>`: Custom `trust-policy.json` path
- `--include-settings-snapshots`: Pack sanitized initial snapshots for approved trusted `settingsBridge` plugins (off by default to avoid leaking local settings)
- `--no-addons`: Emit a 0-addon host-only bundle

### Build Outputs

- `antigravity-remote.user.js`: Userscript (`@match https://antigravity.google.com/*`, `@grant none`, `@run-at document-idle`)
- `bookmarklet.txt`: Encoded bookmarklet launcher
- `remote-runtime.cjs`: Self-contained browser/Node runtime bundle for testing and embedding
- `build-manifest.json`: Deterministic SHA-256 file inventory and packed addon digest summary

## Running Remote Web Tests

```bash
node --test test/unit/v23-remote-web-adapter.test.js
node --test test/e2e/v23-remote-web-chromium.test.js
```
