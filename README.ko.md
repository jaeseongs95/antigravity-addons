# antigravity-native-addon-host

[![CI](https://github.com/jaeseongs95/antigravity-native-addon-host/actions/workflows/ci.yml/badge.svg)](https://github.com/jaeseongs95/antigravity-native-addon-host/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> **언어**: [English (README.md)](./README.md) | 한국어

**무의존성(0-dep) 스테이징 런타임, Electron 45 샌드박스 프리로드 격리, Shadow DOM UI 격리, SHA-256 신뢰 핀닝, 단방향 읽기 전용 `settingsBridge` 설정 푸시를 제공하는 벤더 중립 데스크톱 애드온 호스트 프레임워크(`v2.1.1`, `AddonManifest.v2` 및 `v1` 하위 호환 지원)입니다.**

## v2.1.1 주요 보완 사항 (다중 창 안정성 및 World 998 보안 경화)

- **다중 창 `settingsBridge` 동기화 레이스 해소 (`I1`)**: 신규 창 진입(`readSnapshotForPlugin`) 중 설정 파일 변경을 감지하면 이미 활성화된 기존 창에도 즉시 변경 이벤트를 전파하고, 창(`wcId`)별 전달 키 추적으로 중복 푸시를 방지합니다.
- **Windows 일시 파일 잠금 유예 및 `fs.watch` 자동 복구 (`I2`)**: `EBUSY`/`EPERM`/`EACCES` 순간 잠금 시 제한 백오프 재시도(`80ms → 160ms → 320ms`) 후 Fail-Closed 전환 및 자가 복구를 수행하며, 디렉터리 미존재·`watcher` 오류 발생 시 지수 백오프(`500ms → 5000ms`)로 감시를 자동 재연결합니다.
- **World `998` 원시 객체 완전 캡처 및 `invokeAction` 신뢰 경계 (`I4`)**: `kernel.js` 로드 시점에 핵심 JS 원시 객체(`Object.freeze`, `Map`/`Set`/`WeakMap`, `Set.prototype.size`, `forEach`, `Reflect.apply`, `Error`, `String`, `Uint8Array`, `crypto.getRandomValues`)를 사전 캡처해 프로토타입·이터레이터 오염을 차단하고, `listActions()`·`invokeAction()`에 `trustLevel` 경계(`ERR_ACTION_TRUST_FORBIDDEN`)를 적용했습니다.
- **수명 주기·스타일 정리 (`I10`)**: `dispose` 시 `onDispose` 콜백 실행 후 핸들 폐기 마킹, 다중 창 `lifecycleStates` 집계 및 창 종료 시 재집계, `before-quit` → `will-quit` 전환, `[attr]` 소유자 셀렉터 보존을 반영했습니다.

## v2.1.0 주요 추가 사항 (v2.0.0 하위 호환 확장)

- **단방향 읽기 전용 `settingsBridge` (`AddonManifest.v2`)**: `trustLevel: "trusted"` 및 `trust-policy.json` SHA-256 승인을 받은 렌더러 플러그인이 호스트 소유 데이터 디렉터리(`HOST_DATA_DIR`, `~/.gemini/config/plugins/` 제외) 내 단일 JSON 파일을 선언(`settingsBridge: { fileName, maxBytes }`)할 수 있습니다. 메인 프로세스가 심볼릭 링크 거부(`lstatSync`), `realpathSync` 경로 격리, 호스트 예약 파일(`trust-policy.json`, `config.json`, `*.orig.json` 등) 차단, `maxBytes` 상한, `parseSafeJson` 프로토타입 오염 차단, 단일 디바운스 `fs.watch` + SHA-256 중복 제거를 수행한 뒤 World `998`에 `addonHost.getSettings()` / `addonHost.onSettingsChange(cb)`로 deep-frozen 스냅샷을 푸시합니다. Renderer → Main 쓰기 IPC는 열지 않으며, `v2.0.0`에서의 업그레이드 시 `app.asar` 재패치(쓰기)는 0바이트입니다.

## v2.0.0 주요 변경 사항

- **무의존성 스테이징 런타임 (`dist/runtime/` + `buildSha8`)**: 사전 컴파일된 스탠드얼론 매니페스트 검증기(`validate-v1.cjs`, `validate-v2.cjs`), 단일 파일 샌드박스 프리로드(`preload-bridge.cjs`), 모듈형 World `998` 렌더러 커널(`kernel-bundle.cjs`)이 외부 `node_modules` 없이 독립 실행됩니다. Acorn AST 0-dep 검사(`npm run check:runtime`)와 실제 무-`node_modules` 격리 Electron E2E(`npm run test:e2e:isolated`)로 검증합니다.
- **Electron 45 샌드박스 프리로드 및 단일 수령 Nonce 브리지 (World `998`)**: `preload-bridge.cjs`를 `session.defaultSession`에만 등록하여 격리 세션(내장 브라우저 등)에는 프리로드가 주입되지 않으며, Page World `0`에는 전역을 전혀 노출하지 않습니다. 문서 세대(`docGenId`)별 단일 수령 `claimNonce` 인증으로 Electron 내부 World `999` 충돌 없이 World `998`에서 안전하게 부트스트랩합니다.
- **Option B2 Shadow DOM UI 격리 및 네이티브 Top-Layer 모달/팝오버 스택**: `AddonManifest.v2` UI 슬롯은 기본적으로 open `ShadowRoot`(`shadow: true`)를 사용하고 내부 `<div class="addon-host-slot-root">`(`HTMLElement`)를 반환하여 호스트 DOM/CSS 간섭을 차단합니다(`v1`은 `shadow: false`, `document-transform`은 항상 Light DOM 유지). 네이티브 `<dialog>.showModal()`과 `popover="manual"`의 LIFO `Escape`/포커스 복원 스택을 제공하며, `webContents.id` 기준의 비파괴 `PortalArbiter`로 호스트 포털 오버레이와 조율합니다.
- **기본 거부(Default-Deny) SHA-256 신뢰 핀닝 및 메모리 기반 CJS `mainHook` 로더**: `strictTrustPolicy: true`가 기본값입니다. `trustLevel: "trusted"` 플러그인의 렌더러 스크립트와 `mainHook` 번들은 `trust-policy.json`에 명시적으로 승인(`addon-host trust approve <pluginId>`)되어야만 실행됩니다. `mainHook`은 심볼릭 링크 탈출 검사 후 단일 메모리 스냅샷에서 격리 CJS 로더로 실행되어 `fs`, `electron`, `node_modules`, 절대 경로, `file://`, `.mjs`에 대한 `require()` 호출을 차단합니다(SHA-256 핀닝 신뢰 코드의 디스크 TOCTOU 및 우발적 외부 `require()` 방지 가드이며 OS 샌드박스가 아님).
- **깨끗한 `app.asar` 소유권, `V1 -> V2` 업그레이드 및 `plugins/` 무쓰기 보장**: 백업(`.orig`, `.orig.json`, `index.json`)은 `~/.gemini/antigravity/backups/`에만 저장되어 앱 `resources/`를 오염시키지 않으며(`N=3` 보존 정리, `UPDATED_UNPATCHED`와 의도적 롤백 `rolledBackAt` 구분), 앱 실행 중 파일 잠금(`EBUSY`/`EPERM`) 시 `ERR_TARGET_LOCKED_APP_RUNNING`으로 즉시 실패합니다. 런타임은 `~/.gemini/config/plugins/` 내부에 어떤 파일도 쓰지 않습니다.
- **벤더·런타임 중립 코어 유지**: `src/core/`는 Antigravity, Electron, `node:fs`, `node:path` 의존성이 0이며(`FileSystemPort` DIP), 기존 `HostLifecyclePort` 및 `AddonStorePort` 공개 계약을 그대로 보존합니다(`TC-001`–`TC-001d`, `TC-014`, `TC-023`).

## 보안 및 격리 위협 모델

- **렌더러 격리 (World `998` — 공존 및 심층 방어)**: 플러그인은 Page World `0` 및 Electron 프리로드 World `999`와 분리된 Isolated World `998`에서 호스트 토큰으로 보호되는 비가변 커널, Option B2 Shadow DOM 슬롯, 엄격한 CSS 살균기와 함께 실행됩니다. 이는 호스트 앱과 플러그인 간의 공존 및 심층 방어(Coexistence + Defense-in-Depth)를 제공하며, 동일 렌더러 프로세스 내 적대적 멀티테넌트 OS 샌드박스를 대체하지는 않습니다.
- **`mainHook` 신뢰 경계 (SHA-256 핀닝 기반 신뢰 코드)**: `mainHook`은 기본 거부(`strictTrustPolicy: true`) 정책을 따르며, 사용자가 `addon-host trust approve <pluginId>`로 명시적 승인한 SHA-256 핀닝 번들만 메모리 기반 CJS 로더로 메인 프로세스에서 실행됩니다(디스크 TOCTOU 변조 및 비인가 외부 `require` 차단). **`v2.1.0`**에서는 호스트 설정 전달만 필요한 플러그인이 `mainHook`을 완전히 제거하고 단방향 읽기 전용 `settingsBridge`를 사용할 수 있으며, 양방향 OS 프로세스 RPC(`SidecarBridge`)는 향후 마이너 버전으로 이연되어 있습니다.

## 빠른 시작

```bash
npm ci
npm run build:runtime
npm run test:all

# 읽기 전용 상태 확인 및 진단
node ./bin/addon-host.js --status
node ./bin/addon-host.js --doctor

# 플러그인 매니페스트(v1 / v2) 검증 및 등록
node ./bin/addon-host.js --validate path/to/addon-manifest.json
node ./bin/addon-host.js --register path/to/addon-manifest.json

# trusted 플러그인 SHA-256 신뢰 승인 관리
node ./bin/addon-host.js trust list
node ./bin/addon-host.js trust approve <pluginId>
node ./bin/addon-host.js trust revoke <pluginId>

# 공유 app.asar 부트스트랩 설치, 업그레이드(V1 -> V2) 및 롤백
node ./bin/addon-host.js --install
node ./bin/addon-host.js --upgrade
node ./bin/addon-host.js --rollback
```

## 문서

- [릴리스 노트 (`v2.1.0` 영문/국문)](./RELEASE_NOTES_v2.1.0.md)
- [릴리스 노트 (`v2.0.0` 영문/국문)](./RELEASE_NOTES_v2.0.0.md)
- [English README (`README.md`)](./README.md)
- [JSON Schema v2 (`schemas/addon-manifest.v2.schema.json`)](./schemas/addon-manifest.v2.schema.json)
- [JSON Schema v1 (`schemas/addon-manifest.v1.schema.json`, 동결)](./schemas/addon-manifest.v1.schema.json)
- [아키텍처 및 벤더 중립성](./docs/ARCHITECTURE.md)
- [테스트 케이스 목록](./docs/TEST_CASES.md)

## 라이선스

[MIT](./LICENSE)
