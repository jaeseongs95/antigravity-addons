# AddonManifest.v3 & `AddonContextV3` API Reference (v3.0.0)

`antigravity-addons` v3.0.0 introduces an **API-First, 3-Tier Progressive Abstraction** framework with strict ISP capability separation while preserving 1-major backward compatibility (`v3.x`) for all existing v1/v2 plugins via `createV2CompatAdapter(v3)`.

## 1. 3-Tier Host UI Architecture

| Tier | Ownership | APIs | When to Use |
| :--- | :--- | :--- | :--- |
| **Tier 1 (Zero-DOM Semantic)** | Host 100% | `ui.showToast`, `ui.confirm`, `ui.prompt`, `ui.registerCommand`, `ui.registerStatusItem`, `ui.registerSettingsPage` | Default for notifications, confirmations, status bar items, and settings pages across Desktop & Remote Web |
| **Tier 2 (Host-Positioned Overlays + Declarative JSON Schema)** | Host owns geometry, flip/shift, Top Layer, mobile bottom-sheet & `Addon: <displayName>` badge | `ui.openPopup`, `ui.openModal`, `ui.openPanel` (`PlacementSpec`, 16 closed primitives, static `visibleWhen`/`disabledWhen`, `handle.update(nextTree)`) | Popups, quick-settings panels, forms, and interactive drawers without writing DOM positioning code |
| **Tier 3 (Controlled Escape Hatch)** | Host owns Shadow isolation & `--ag-*` tokens; Plugin owns inner DOM | `ui.mountCanvas`, `ui.createStyleElementSafe`, `dom.*` (`document-transform` for `trusted` plugins) | Custom visualizations or host-document transforms |

## 2. ISP-Segregated `AddonContextV3`

- **Always-on namespaces**: `apiVersion: 3`, `meta`, `env` (`surface`, `layoutMode`, `capabilities` — **raw `hostProfileId` is never exposed**), `theme` (`--ag-*` tokens), `i18n`, `ui`, `storage` (KV + TTL + `onDidChange`), `events`, `services` (`<pluginId>.<name>`, default-deny `allowedCallers`, prototype-key stripping), `lifecycle` (`AbortSignal`, `onDispose`).
- **Capability-gated namespaces** (strictly `undefined` unless declared, permitted, and supported by the active surface):
  - `net.fetch(url, init)`:
    - `permissions.net.httpsHosts` (Desktop + Remote Web): public HTTPS FQDNs only (`<=253` chars, no raw IP/localhost/internal suffixes/forbidden auth origins), `credentials: 'omit'`, max 3 manual redirects with allowlist re-checks, and Desktop Main-process DNS pre-resolution rejecting RFC1918/loopback/link-local/IMDS (`169.254.169.254`) with pinned IP + TLS SNI connection (anti-DNS-rebinding).
    - `permissions.net.localLoopback` (Desktop `trusted` only): explicit integer ports `1024..65535` or profile-resolved named targets (`antigravity-sidecar`), normalized to `127.0.0.1`, **0 redirects**, strictly omitted on Remote Web.
  - `dom`: manifest-gated `observeRegion`, `isElementInsideIgnored`, `mountSlot`, `unmountSlot`.
  - `configBridge`: Desktop `trusted`-only named-scope CAS config reads/writes.

## 3. Developer SDK (`@antigravity-addons/sdk`)

Located in `packages/sdk/` as a separate `devDependency` package (keeping `antigravity-addons` runtime at **0 new runtime npm dependencies**):
- Full TypeScript definitions (`index.d.ts`)
- `defineAddon()`, `h()` declarative UI tree builder
- `createTestHost({ surface: 'desktop' | 'remote-web' })` real-kernel parity test harness
- `ag-addon init | check | dev | build | pack` CLI & reusable GitHub Action template (`templates/addon-release.yml`)
