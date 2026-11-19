# antigravity-native-addon-host

[![CI](https://github.com/jaeseongs95/antigravity-native-addon-host/actions/workflows/ci.yml/badge.svg)](https://github.com/jaeseongs95/antigravity-native-addon-host/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> **Language**: English | [한국어 (README.ko.md)](./README.ko.md)

**Single, vendor-independent native desktop addon host and common plugin isolation contract (`AddonManifest.v1`).**

`antigravity-native-addon-host` eliminates cross-plugin conflicts when multiple native desktop plugins extend the same Electron application (default profile: **Antigravity Desktop**):

- **Single `app.asar` Owner**: Only this host adapter patches, verifies, backs up (`.orig` + `.orig.json`), and rolls back `app.asar`. Plugins never touch `app.asar`.
- **Declarative Contract (`AddonManifest.v1`)**: Plugins declare capabilities (`renderer`, `mainHook`), entry scripts, UI slots, and isolation attributes via JSON Schema (`schemas/addon-manifest.v1.schema.json`).
- **Zero Cross-Plugin Intrusion**: Addon-owned UI slots automatically carry `translate="no"`, `data-agy-no-translate="true"`, and `data-addon-host-owner="<pluginId>"`. Exclusive slots and duplicate `slotId`s are blocked before registration.
- **Fault & Config Isolation**: Reads `config.json` strictly read-only (`enabled: false` blocks loading immediately) and executes addons sequentially in deterministic `loadOrder` under per-plugin `try/catch` fault boundaries.
- **Vendor-Independent Core**: `src/core/` has zero Antigravity or Electron literals; host-specific details live behind `HostProfile` (`src/profiles/antigravity.js`) and `src/adapters/electron/`.

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
