# antigravity-native-addon-host

[![CI](https://github.com/jaeseongs95/antigravity-native-addon-host/actions/workflows/ci.yml/badge.svg)](https://github.com/jaeseongs95/antigravity-native-addon-host/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> **Language**: English | [한국어 (README.ko.md)](./README.ko.md)

**Single, vendor-independent native desktop addon host and common plugin isolation contract (`AddonManifest.v1`).**

`antigravity-native-addon-host` eliminates cross-plugin conflicts when multiple native desktop plugins extend the same Electron application (default profile: **Antigravity Desktop**):

- **Single `app.asar` Owner & Verified Recovery**: Only this host adapter patches, verifies (build-hash identity check + recorded `patchedSha256` rollback guard), backs up (`.orig` + `.orig.json`), and transactionally installs/rolls back `app.asar` with automatic loader compensation on failure.
- **Declarative Contract & Explicit Trust Model (`AddonManifest.v1`)**: Plugins declare `trustLevel` (`trusted` | `restricted`), capabilities (`renderer`, `mainHook`), entry scripts, UI slots, and isolation attributes via JSON Schema (`schemas/addon-manifest.v1.schema.json`). `mainHook` runs through least-privilege frozen brokers, never raw Electron `app`/`webContents`.
- **Owner CSS Scoping & Zero Cross-Plugin Intrusion**: Addon-owned UI slots automatically carry `translate="no"`, `data-agy-no-translate="true"`, and `data-addon-host-owner="<pluginId>"` (with opt-in Shadow DOM `{ shadow: true }`). `injectStyle()` blocks `@import`/`javascript:`/`expression(` and auto-scopes selectors under `[data-addon-host-owner="<pluginId>"]`.
- **Sync + Async Fault & Config Isolation**: Reads `config.json` strictly read-only (`enabled: false` blocks loading immediately and auto-cleans listeners), tracks per-addon lifecycle states (`PENDING -> ACTIVATING -> ACTIVE / FAILED / DISPOSING -> DISPOSED`), and isolates both sync throws and async Promise rejections / timeouts.
- **Vendor- & Runtime-Independent Core**: `src/core/` has zero Antigravity, Electron, `node:fs`, or `node:path` imports (`FileSystemPort` DIP); host-specific details live behind `HostProfile` (`src/profiles/antigravity.js`) and `src/adapters/electron/`.

## Quick Start

```bash
npm ci
npm test

# Read-only status & legacy direct-patch conflict diagnostics
node ./bin/addon-host.js --status
node ./bin/addon-host.js --doctor

# Validate & register a plugin manifest
node ./bin/addon-host.js --validate path/to/addon-manifest.json
node ./bin/addon-host.js --register path/to/addon-manifest.json

# Install or roll back the single shared app.asar bootstrap hook
node ./bin/addon-host.js --install
node ./bin/addon-host.js --install --refresh-orig   # Archive previous .orig when vendor updates same appVersion build
node ./bin/addon-host.js --rollback
```

## Custom `HostProfile` & Plugin Usage

```js
// Renderer plugin entry (receives its own immutable scoped `addonHost` handle):
const container = addonHost.mountSlot('my-plugin.root');
addonHost.injectStyle('base', '.my-widget { font-size: 12px; }');
addonHost.onDispose(() => { /* cleanup */ });
```

```bash
# Use a custom non-Antigravity HostProfile via CLI:
node ./bin/addon-host.js --profile ./path/to/custom-profile.js --status
```

## Documentation

- [AddonManifest.v1 Common Contract Specification](./docs/SPEC_ADDON_MANIFEST_V1.md)
- [JSON Schema (`schemas/addon-manifest.v1.schema.json`)](./schemas/addon-manifest.v1.schema.json)
- [Architecture & Vendor-Independence](./docs/ARCHITECTURE.md)
- [Test Cases](./docs/TEST_CASES.md)

## License

[MIT](./LICENSE)
