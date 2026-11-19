# Test Cases (`antigravity-native-addon-host` v1.0.0)

| Case ID | Module / Boundary | Scenario & Expected Result | Test File |
| --- | --- | --- | --- |
| `TC-001` | `src/core/` DIP boundary | Zero Antigravity/Electron vendor literals or direct `app.asar` strings in `src/core/` | `test/unit/architecture-boundaries.test.js` |
| `TC-002` | `manifest-validator.js` | Valid `AddonManifest.v1` for `ko-thought-translator`, `antigravity-statusbar`, `antigravity-mcp-manager` pass Ajv + capability/entry consistency | `test/unit/manifest-and-slots.test.js` |
| `TC-003` | `manifest-validator.js` | Missing required fields, unknown keys, non-SemVer version, capability without matching entry script fail closed | `test/unit/manifest-and-slots.test.js` |
| `TC-004` | `manifest-validator.js` | Entry script with `..` traversal or absolute path escaping `<pluginsRoot>/<pluginId>` rejected (`ERR_ENTRY_ESCAPES_PLUGIN_DIR`) | `test/unit/manifest-and-slots.test.js` |
| `TC-005` | `slot-registry.js` | Duplicate `slotId` or second plugin claiming an `exclusive: true` slot rejected (`ERR_SLOT_CONFLICT`); non-exclusive slots coexist | `test/unit/manifest-and-slots.test.js` |
| `TC-006` | `lifecycle-coordinator.js` | Sorts by `loadOrder` + `pluginId`, skips `enabled: false` plugins, isolates invalid manifests without blocking valid peers | `test/unit/lifecycle-and-loader.test.js` |
| `TC-007` | `host-loader-builder.js` | `isAllowedHubUrl` allows only local HTTP(S) top-frame URLs; rejects `devtools://`, `file://`, external HTTPS | `test/unit/lifecycle-and-loader.test.js` |
| `TC-008` | `host-loader-builder.js` | Generated loader executes in isolated VM: isolates throwing plugin, honors `config.json` enabled gate, attaches `translate="no"` + `data-agy-no-translate="true"` + `data-addon-host-owner` on `mountSlot`, blocks cross-plugin `unmountSlot` | `test/unit/lifecycle-and-loader.test.js` |
| `TC-009` | `asar-patcher.js` | Synthetic ASAR exact-size install, `.orig` + `.orig.json` integrity check, tampered `.orig.json` fail-closed, byte-identical rollback | `test/unit/asar-patcher-and-cli.test.js` |
| `TC-010` | `asar-patcher.js` + `HostProfile` | Non-Antigravity custom `HostProfile` works end-to-end across install, `delta > 0` comment stripping preserving custom marker, `.orig` reinstall, and rollback | `test/unit/asar-patcher-and-cli.test.js` |
| `TC-011` | `asar-patcher.js` `--doctor` | Detects legacy direct patches (`AGY_STATUSBAR`, `AGY_MCP`) in `app.asar` and reports non-destructive conflict diagnostics | `test/unit/asar-patcher-and-cli.test.js` |
| `TC-012` | `cli/main.js` | `--status` (read-only), `--validate`, `--register`, `--unregister`, `--doctor`, `--install`, `--rollback` end-to-end | `test/unit/asar-patcher-and-cli.test.js` |
| `TC-013` | Real Antigravity `app.asar` copy | Exact-size patch & byte-identical rollback on local `app.asar.v2.33.0.orig` copy (skipped on CI runners without local fixture) | `test/unit/asar-patcher-and-cli.test.js` |
