# Architecture & Vendor Independence

`antigravity-native-addon-host` follows a strict hexagonal (Ports & Adapters) design:

- **`src/core/` (Vendor-Neutral Policy)**:
  - `host-profile-port.js`: validates any `HostProfile` implementation (`id`, `patchMarker`, `mainEntry`, `mainAnchorTarget`, `mainAnchorReplacement`, path resolvers, `legacyPatchMarkers`).
  - `manifest-validator.js`: compiles and enforces `schemas/addon-manifest.v1.schema.json` via `ajv`, plus `plugins/<pluginId>/` realpath confinement.
  - `slot-registry.js`: enforces exclusive slot ownership and prevents duplicate `slotId` collisions across plugins.
  - `lifecycle-coordinator.js`: deterministic `loadOrder` sorting, read-only enabled-gate filtering, and fault-isolated execution planning.
- **`src/adapters/electron/` (Electron Host Adapter)**:
  - `config-reader.js`: read-only fail-closed `config.json` reader.
  - `asar-patcher.js`: `@electron/asar` + `proper-lockfile` atomic exact-size patcher, `.orig` SHA-256 verifier, rollback, and legacy direct-patch detector (`--doctor`).
  - `host-loader-builder.js`: generates the single shared main+renderer bootstrap script (`ADDON_HOST_LOADER_V1`) with `window.__ADDON_HOST_API__` DOM isolation.
- **`src/profiles/antigravity.js` (Default Host Profile)**:
  - Provides Antigravity Desktop paths, ASAR anchor, and legacy markers (`AGY_STATUSBAR`, `AGY_MCP`, `AGY_KO_THOUGHT`, `AGY_UI_EXTENSIONS_LOADER_V1`).
  - Any other Electron app can supply its own `HostProfile` without touching `src/core/` or `src/adapters/electron/`.
