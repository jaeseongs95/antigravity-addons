# Release Notes — `antigravity-native-addon-host` v2.1.0

> **Language**: English | 한국어 (아래 포함)

## English

### Highlights

`antigravity-native-addon-host` `v2.1.0` adds a minimal, vendor-neutral, unidirectional read-only **Host Settings File Bridge (`settingsBridge`)** to `AddonManifest.v2` while preserving full `v1`/`v2` backward compatibility, zero new npm dependencies, and zero `app.asar` re-patching when upgrading from `v2.0.0`.

- **Declarative `settingsBridge` Contract (`schemas/addon-manifest.v2.schema.json`)**:
  - Optional `settingsBridge: { fileName, maxBytes }` (`maxBytes` `1024..262144`, default `65536`) restricted to flat JSON filenames (`^[a-z0-9][a-z0-9._-]{1,63}\.json$`).
  - Requires `trustLevel: "trusted"` and SHA-256 approval in `trust-policy.json` (`ERR_RESTRICTED_SETTINGS_BRIDGE_FORBIDDEN`).
  - Blocks host-reserved filenames (`trust-policy.json`, `config.json`, `index.json`, `build-manifest.json`, `package.json`, `*.orig.json`) statically and at runtime, and enforces cross-plugin uniqueness in `SlotRegistry` (`ERR_DUPLICATE_SETTINGS_FILE`).
- **Hardened Read-Only Watcher (`src/runtime/main/settings-bridge.js`)**:
  - Reads strictly inside host-owned `HOST_DATA_DIR` (never `~/.gemini/config/plugins/`).
  - Enforces symlink rejection (`lstatSync`), regular-file validation, `realpathSync` confinement, pre- and post-read size caps, and `parseSafeJson` prototype-pollution blocking.
  - Uses a single debounced (`150ms`) `fs.watch` active only while trusted `settingsBridge` plugins are bound, deduplicating pushes by `(status, sha256, reason)` with monotonic `revision` and `updatedAt`.
- **Unidirectional Authenticated World `998` Push (`renderer-injector.js` & `kernel.js`)**:
  - Stages the initial deep-frozen snapshot inside `stagePluginHandle` before plugin execution (zero startup race).
  - Delivers live updates via `hostToken`-authenticated `pushPluginSettings`, exposing `addonHost.getSettings()` and `addonHost.onSettingsChange(cb)` (auto-cleaned on `disposePlugin`) with **zero renderer-to-main write IPC** (`preload-bridge.cjs` unchanged).
  - Survives dynamic loopback port rotations (where Chromium partitions `window.localStorage` per port) without fail-open defaults or shared World `0` / World `998` `localStorage` exposure.
- **Zero-`app.asar`-Write Upgrade from `v2.0.0`**:
  - When `ADDON_HOST_LOADER_V2` is already installed, `addon-host --upgrade` stages `runtime/<buildSha8>/`, atomically swaps `addon-host-loader.js`, and returns `asar.status: "ALREADY_INSTALLED"` with zero bytes written to `app.asar`.

---

## 한국어

### 주요 변경 사항

`antigravity-native-addon-host` `v2.1.0`은 `v1`/`v2` 하위 호환성, 외부 의존성 0개 추가(0 new npm deps), `v2.0.0`에서의 `app.asar` 무수정 업그레이드를 유지하면서 벤더 중립·단방향·읽기 전용 **호스트 설정 파일 브리지(`settingsBridge`)**를 추가합니다.

- **선언적 `settingsBridge` 계약 (`schemas/addon-manifest.v2.schema.json`)**:
  - 선택 필드 `settingsBridge: { fileName, maxBytes }` (`maxBytes` `1024..262144`, 기본 `65536`)로 단일 평면 JSON 파일(`^[a-z0-9][a-z0-9._-]{1,63}\.json$`)을 선언할 수 있습니다.
  - `trustLevel: "trusted"` 및 `trust-policy.json` SHA-256 승인이 필수입니다(`ERR_RESTRICTED_SETTINGS_BRIDGE_FORBIDDEN`).
  - 호스트 예약 파일(`trust-policy.json`, `config.json`, `index.json`, `build-manifest.json`, `package.json`, `*.orig.json`)을 정적·런타임 모두 차단하고, `SlotRegistry`에서 플러그인 간 파일명 중복을 방지합니다(`ERR_DUPLICATE_SETTINGS_FILE`).
- **하드닝된 읽기 전용 감시기 (`src/runtime/main/settings-bridge.js`)**:
  - 호스트 소유 `HOST_DATA_DIR` 내부만 읽기 허용합니다(`~/.gemini/config/plugins/` 절대 제외).
  - 심볼릭 링크 거부(`lstatSync`), 일반 파일 검증, `realpathSync` 경로 격리, 읽기 전·후 `maxBytes` 상한, `parseSafeJson` 프로토타입 오염 차단을 적용합니다.
  - 활성 trusted 바인딩이 있을 때만 단일 디바운스(`150ms`) `fs.watch`를 구동하고 `(status, sha256, reason)` 기반 중복 제거와 단조 증가 `revision`을 제공합니다.
- **단방향 인증 World `998` 푸시 (`renderer-injector.js` & `kernel.js`)**:
  - 초기 deep-frozen 스냅샷을 플러그인 실행 전 `stagePluginHandle`로 선전달하여 초기 레이스를 제거합니다.
  - 실시간 변경은 `hostToken` 인증 `pushPluginSettings`로 푸시하며, `addonHost.getSettings()` 및 `addonHost.onSettingsChange(cb)`(`disposePlugin` 시 자동 해제)를 제공합니다. Renderer → Main 쓰기 IPC는 열지 않습니다(`preload-bridge.cjs` 무변경).
  - 동적 loopback 포트 회전으로 `window.localStorage`가 분리·초기화되는 환경에서도 설정이 유실되거나 fail-open 되지 않습니다.
- **`v2.0.0`에서의 `app.asar` 무쓰기 업그레이드**:
  - 이미 `ADDON_HOST_LOADER_V2`가 설치된 환경에서 `addon-host --upgrade` 실행 시 `runtime/<buildSha8>/` 스테이징과 `addon-host-loader.js` 원자적 교체만 수행하고 `app.asar`는 0바이트 수정(`ALREADY_INSTALLED`)으로 완료됩니다.
