# Architecture & Vendor Independence

`antigravity-native-addon-host` follows a strict hexagonal (Ports & Adapters) design with SOLID ISP/DIP enforcement across `src/core/`, `src/cli/`, and `src/adapters/electron/`:

- **`src/core/` (Vendor- & Runtime-Neutral Policy — `TC-001`)**:
  - `host-profile-port.js`: minimal runtime-neutral `HostProfile` contract (`id`, `resolvePaths`). Contains zero Electron, ASAR, or vendor fields.
  - `host-ports.js`: segregated CLI ports (`HostLifecyclePort`, `AddonStorePort`) so CLI depends only on small host-neutral abstractions.
  - `manifest-validator.js`: compiles and enforces `schemas/addon-manifest.v1.schema.json` via `ajv`, strict SemVer 2.0.0 compatibility comparison (fail-closed + prerelease precedence), and `<pluginsRoot>/<pluginId>/` realpath symlink confinement.
  - `slot-registry.js`: null-prototype (`Object.create(null)`) exclusive slot, `storageNamespace`, and `ipcChannelPrefix` collision detector.
  - `lifecycle-coordinator.js`: deterministic `(loadOrder, pluginId)` sorting, duplicate `pluginId` rejection, read-only enabled-gate filtering, and fault-isolated execution planning.
- **`src/cli/` (Host-Agnostic CLI Factory — `TC-001c`)**:
  - `main.js`: `createCliApp({ hostLifecycle, addonStore, defaultProfile })` orchestrates CLI commands with zero `node:fs` writes/locks, zero Electron/ASAR fields, and zero concrete adapter/profile imports.
- **`src/adapters/electron/` (Electron Host Adapter — `TC-001b`)**:
  - `electron-host-profile-port.js`: validates Electron/ASAR/URL fields and required resolved paths (`ADDONS_DIR`, `PLUGINS_ROOT_DIR`, `LOADER_SCRIPT_PATH`, `ASAR_PATH`, `ASAR_LOCK_PATH`).
  - `electron-host-lifecycle-port.js` & `electron-addon-store-port.js`: segregated `HostLifecyclePort` and `AddonStorePort` implementations (including co-located `ADDONS_LOCK_PATH` re-derivation and non-canonical manifest cleanup).
  - `config-reader.js`: read-only fail-closed `config.json` reader.
  - `asar-patcher.js`: `@electron/asar` + `proper-lockfile` + `acorn` character-offset (`[start, end]`) exact-size patcher and syntax verifier (CJS, ESM, Hashbang, `\r`/`\u2028`/`\u2029` safe), `.orig` SHA-256 verifier, locked rollback, and legacy direct-patch doctor.
  - `host-loader-builder.js`: generates the shared `addon-host-loader.js` using `executeJavaScriptInIsolatedWorld` (with main-world fallback), `'use strict'` + `Reflect.apply` + null-prototype descriptors, `did-start-navigation`/`did-navigate` credential invalidation, renderer-side synchronous origin+nonce verification, partial-throw immediate cleanup + `failedIds` isolation, and post-`dispose()` handle guards.
- **`src/profiles/antigravity.js` & Composition Roots (`bin/addon-host.js`, `src/index.js`)**:
  - Wires `ANTIGRAVITY_HOST_PROFILE` and the Electron ports into `createCliApp(...)`. Any other desktop host can supply its own profile and/or ports without modifying `src/core/` or `src/cli/`.
