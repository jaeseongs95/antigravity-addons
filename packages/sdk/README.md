# `@extenra/sdk`

Developer SDK for building **AddonManifest.v3** plugins targeting the **Extenra** (`extenra`, formerly `antigravity-addons`) Desktop & Remote Web host framework.

- **Zero impact on host runtime**: Installed strictly as a `devDependency` in plugin repos (`extenra` runtime stays zero-dependency).
- **Full TypeScript definitions** (`index.d.ts`) for `AddonContextV3`, `PlacementSpec`, and all 16 Tier-2 declarative UI primitives.
- **`defineAddon()` & `h()`**: Concise declarative UI tree helpers with static `visibleWhen`/`disabledWhen` predicates (zero `eval`).
- **`createTestHost({ surface: 'desktop' | 'remote-web' })`**: Boots the real renderer kernel in Node for Desktop/Remote parity testing.
- **`extenra-addon` / `ag-addon` CLI**: `init`, `check`, `dev`, `build`, and `pack` with manifest validation, unsafe DOM/eval sink scanning, and `SHA256SUMS.txt` generation.
