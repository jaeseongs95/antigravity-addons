# Release Notes — `antigravity-native-addon-host` v2.0.0

## English

### Highlights

1. **Zero-Dependency Staged Runtime (`dist/runtime/` + `runtime/<buildSha8>/`)**
   - Replaced the monolithic generated `addon-host-loader.js` script with a thin entry shim delegating to an immutable, content-addressed runtime bundle (`buildSha8`).
   - Compiled standalone `Ajv` manifest validators (`validate-v1.cjs`, `validate-v2.cjs`) with localized 0-dep helpers (`equal.cjs`, `ucs2length.cjs`), verified by Acorn AST 0-dep checks (`npm run check:runtime`) and a true zero-`node_modules` isolated Electron 45 E2E harness (`npm run test:e2e:isolated`).
   - Added zero new npm dependencies.

2. **Electron 45 Sandboxed Preload & Isolated World `998` Runtime**
   - Moved renderer execution from World `999` to World `998` to avoid Electron internal isolated-world conflicts (**Coexistence + Defense-in-Depth** threat model with non-writable, host-token-authenticated kernel).
   - Added a single self-contained sandboxed preload (`preload-bridge.cjs`, `require('electron')` only) registered strictly on `session.defaultSession` so isolated partitions (such as browser webviews) receive zero preloads.
   - Enforced zero Page World `0` exposure and single-claim per-document-generation `claimNonce` authentication (`ERR_BRIDGE_ALREADY_CLAIMED`).

3. **Option B2 Shadow DOM UI Isolation & Dual-Source `PortalArbiter`**
   - Introduced `AddonManifest.v2` (`schemas/addon-manifest.v2.schema.json`) alongside frozen `v1` compatibility (`normalizeManifestToV2`).
   - `v2` UI slots default to open `ShadowRoot` (`shadow: true`) returning an inner `<div class="addon-host-slot-root">` (`HTMLElement`) with automatic ShadowRoot style routing (`v1` defaults `shadow: false`; `document-transform` always stays Light DOM).
   - Replaced custom div overlays with native `<dialog>.showModal()` + `popover="manual"` LIFO `Escape` / focus-restore management and a non-destructive `PortalArbiter` keyed by `webContents.id`.

4. **Default-Deny SHA-256 Trust Policy & Memory-Backed CJS `mainHook` Loader**
   - Enabled `strictTrustPolicy: true` by default; `trustLevel: "trusted"` plugins must be explicitly approved via `addon-host trust approve <pluginId>` (persisted in `trust-policy.json`).
   - Added single-buffer SHA-256 verification for trusted renderer scripts and a memory-backed isolated CommonJS loader for `mainHook` bundles that rejects symlinks and blocks `require()` of `fs`, `electron`, `node_modules`, absolute paths, `file://`, and `.mjs` (a TOCTOU and casual-`require()` guard on SHA-256-pinned trusted Node code, not an OS sandbox).

5. **ASAR Upgrade, Backup Retention & Operational Hardening**
   - Moved `.orig` / `.orig.json` / `index.json` backups into `~/.gemini/antigravity/backups/` with `N=3` retention pruning and automatic `V1 -> V2` upgrade (`--upgrade`).
   - Distinguished vendor updates (`UPDATED_UNPATCHED`) from intentional rollbacks (`rolledBackAt`), failed fast on locked `app.asar` (`ERR_TARGET_LOCKED_APP_RUNNING`), and removed production `process.env` loader overrides from ASAR anchors.
   - Deferred `SidecarBridge` (`Option S1`) cleanly to v2.1.0.

### Breaking Changes

- `strictTrustPolicy: true` is now the default: plugins declaring `mainHook` or `document-transform` must declare `trustLevel: "trusted"` and be approved via `addon-host trust approve <pluginId>`.
- `addon-host-loader.js` now exports `initMain(app)` (pre-`app.whenReady()` entry) rather than the v1 `attachWebContents(contents, app)` API.
- Production ASAR anchors no longer allow `process.env.*` path overrides (`ERR_ANCHOR_ENV_OVERRIDE_FORBIDDEN`).

---

## 한국어

### 주요 변경 사항

1. **무의존성 스테이징 런타임 (`dist/runtime/` + `runtime/<buildSha8>/`)**
   - 기존의 거대한 단일 문자열 생성 `addon-host-loader.js`를 얇은 진입 심(shim)과 불변 콘텐츠 주소 기반 런타임 디렉터리(`buildSha8`) 구조로 전면 개편했습니다.
   - `Ajv` 스탠드얼론 검증기(`validate-v1.cjs`, `validate-v2.cjs`)와 0-dep 헬퍼(`equal.cjs`, `ucs2length.cjs`)를 사전 빌드하며, Acorn AST 0-dep 게이트(`npm run check:runtime`)와 실제 무-`node_modules` 격리 Electron 45 E2E(`npm run test:e2e:isolated`)로 검증합니다.
   - 신규 npm 의존성은 **0개**입니다.

2. **Electron 45 샌드박스 프리로드 및 Isolated World `998` 런타임**
   - Electron 내부 격리 월드(`999`) 충돌을 피하기 위해 렌더러 커널 실행 월드를 `998`로 이전했습니다(비가변·호스트 토큰 인증 커널 기반의 **공존 및 심층 방어(Coexistence + Defense-in-Depth)** 위협 모델).
   - `require('electron')`만 사용하는 단일 파일 샌드박스 프리로드(`preload-bridge.cjs`)를 `session.defaultSession`에만 등록하여 격리 파티션에는 프리로드가 전혀 로드되지 않도록 보장합니다.
   - Page World `0`에는 어떠한 전역도 노출하지 않으며, 문서 세대(`docGenId`)별 단일 수령 `claimNonce` 인증(`ERR_BRIDGE_ALREADY_CLAIMED`)을 적용했습니다.

3. **Option B2 Shadow DOM UI 격리 및 이중 소스 `PortalArbiter`**
   - 동결된 `v1` 스키마와 완벽히 하위 호환되는 `AddonManifest.v2`(`schemas/addon-manifest.v2.schema.json`) 및 정규화 계층(`normalizeManifestToV2`)을 도입했습니다.
   - `v2` UI 슬롯은 기본적으로 open `ShadowRoot`(`shadow: true`) 내부의 `<div class="addon-host-slot-root">`(`HTMLElement`)를 반환하며, 스타일을 ShadowRoot로 자동 라우팅합니다(`v1`은 `shadow: false`, `document-transform`은 항상 Light DOM 유지).
   - 네이티브 `<dialog>.showModal()`과 `popover="manual"` 기반 LIFO `Escape`/포커스 복원 스택과 `webContents.id` 기준의 비파괴 `PortalArbiter`를 제공합니다.

4. **기본 거부(Default-Deny) SHA-256 신뢰 정책 및 메모리 기반 CJS `mainHook` 로더**
   - `strictTrustPolicy: true`가 기본값으로 적용되며, `trustLevel: "trusted"` 플러그인은 `addon-host trust approve <pluginId>`로 명시적 승인(`trust-policy.json`) 후 실행됩니다.
   - 렌더러 스크립트 단일 버퍼 SHA-256 검증과 `mainHook` 번들 메모리 스냅샷 기반 격리 CJS 로더(심볼릭 링크 탈출 거부 및 `fs`, `electron`, `node_modules`, 절대 경로, `file://`, `.mjs`에 대한 `require()` 차단 — SHA-256 핀닝 신뢰 코드용 TOCTOU·우발적 `require()` 가드이며 OS 샌드박스가 아님)를 구현했습니다.

5. **ASAR 업그레이드, 백업 보존 정책 및 운영 안정성 강화**
   - `.orig` / `.orig.json` / `index.json` 백업을 `~/.gemini/antigravity/backups/`로 분리하고 `N=3` 보존 정리 및 `V1 -> V2` 자동 업그레이드(`--upgrade`)를 지원합니다.
   - 벤더 앱 업데이트(`UPDATED_UNPATCHED`)와 의도적 롤백(`rolledBackAt`)을 구분하며, 앱 실행 중 파일 잠금 시 `ERR_TARGET_LOCKED_APP_RUNNING`으로 즉시 실패합니다. 또한 프로덕션 ASAR 앵커에서 `process.env` 경로 오버라이드를 제거했습니다.
   - `SidecarBridge`(`Option S1`)는 v2.1.0으로 깔끔하게 이월되었습니다.

### 주요 호환성 변경 (Breaking Changes)

- `strictTrustPolicy: true`가 기본값입니다. `mainHook` 또는 `document-transform`을 사용하는 플러그인은 `trustLevel: "trusted"` 선언 및 `addon-host trust approve <pluginId>` 승인이 필요합니다.
- `addon-host-loader.js`의 진입점이 v1 `attachWebContents(contents, app)`에서 `app.whenReady()` 이전 동기 호출 `initMain(app)`으로 변경되었습니다.
- 프로덕션 ASAR 앵커에서 `process.env.*` 경로 오버라이드는 보안상 금지됩니다(`ERR_ANCHOR_ENV_OVERRIDE_FORBIDDEN`).
