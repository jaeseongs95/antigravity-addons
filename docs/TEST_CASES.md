# Test Cases (`antigravity-native-addon-host` v1.0.1)

| Case ID | Module / Boundary | Scenario & Expected Result | Test File |
| --- | --- | --- | --- |
| `TC-001` | `src/core/` & `src/adapters/electron/` DIP | Zero Antigravity/Electron literals in `src/core/`; zero hardcoded `data-agy-no-translate` or profile literals in `src/adapters/electron/` | `test/unit/architecture-boundaries.test.js` |
| `TC-002` | `manifest-validator.js` | Valid `AddonManifest.v1` for all 3 reference plugins pass Ajv + capability/entry/compatibility checks | `test/unit/manifest-and-slots.test.js` |
| `TC-003` | `manifest-validator.js` | Invalid schema, unknown keys, non-SemVer, duplicate `slotId` in one manifest, `compatibility` mismatch, `document-transform` without `scope: "native-host-only"` fail closed | `test/unit/manifest-and-slots.test.js` |
| `TC-004` | `manifest-validator.js` | `..` traversal, absolute path, and `<pluginsRoot>/<pluginId>` symlink escape rejected | `test/unit/manifest-and-slots.test.js` |
| `TC-005` | `slot-registry.js` | Duplicate `slotId`, exclusive slot collision, `storageNamespace` conflict, `ipcChannelPrefix` overlap rejected; separate `custom` slots coexist | `test/unit/manifest-and-slots.test.js` |
| `TC-006` | `lifecycle-coordinator.js` | Deterministic `loadOrder` sorting, `enabled: false` skip, invalid/incompatible manifest isolation | `test/unit/lifecycle-and-loader.test.js` |
| `TC-007` | `host-loader-builder.js` | `isAllowedRendererUrl` honors `HostProfile` protocols/hosts and rejects `devtools://`, `file://`, external origins | `test/unit/lifecycle-and-loader.test.js` |
| `TC-008` | `host-loader-builder.js` | Generated loader blocks `pluginId: "../../outside"`, enforces scoped `addonHost` capability handle (zero impersonation, undeclared slot blocked), serializes concurrent `dom-ready`+`did-finish-load` in `loadOrder`, avoids SPA `pushState` re-injection, disposes disabled `mainHook`s, records diagnostics | `test/unit/lifecycle-and-loader.test.js` |
| `TC-009` | `asar-patcher.js` | Synthetic ASAR exact-size install (with & without `integrity`), CRLF & template-literal `//` preservation, `appVersion` filename sanitization, tampered `.orig.json` fail-closed, `ERR_LOCK_FS_ERROR` vs `LOCK_BUSY`, byte-identical rollback | `test/unit/asar-patcher-and-cli.test.js` |
| `TC-010` | `asar-patcher.js` + `HostProfile` | Custom non-Antigravity `HostProfile` works across install, `delta > 0` comment stripping, `.orig` reinstall, rollback, and CLI `--profile` | `test/unit/asar-patcher-and-cli.test.js` |
| `TC-011` | `asar-patcher.js` `--doctor` | Detects legacy direct patches (`AGY_STATUSBAR`, `AGY_MCP`) and fails closed on `--install` without `--replace-legacy` | `test/unit/asar-patcher-and-cli.test.js` |
| `TC-012` | `bin/addon-host.js` real CLI process | Spawns real `node bin/addon-host.js` for `--version`, `--help`, `--status`, `--doctor`, `--validate`, `--register`, `--unregister`, `--profile` and verifies exit codes & JSON stdout | `test/unit/asar-patcher-and-cli.test.js` |
| `TC-013` | Real Antigravity `app.asar` copy | Exact-size patch & byte-identical rollback on local `app.asar.v2.33.0.orig` copy (skipped on CI runners without local fixture) | `test/unit/asar-patcher-and-cli.test.js` |
