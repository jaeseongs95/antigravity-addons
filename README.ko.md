# antigravity-native-addon-host

[![CI](https://github.com/jaeseongs95/antigravity-native-addon-host/actions/workflows/ci.yml/badge.svg)](https://github.com/jaeseongs95/antigravity-native-addon-host/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> **언어**: [English (README.md)](./README.md) | 한국어

**네이티브 데스크톱 앱 플러그인들이 서로의 영역을 침범하지 않도록 격리·조율하는 단일 공용 호스트 어댑터 및 공통 규약(`AddonManifest.v1`) 프로젝트입니다.**

- **단일 `app.asar` 소유권 및 해시 검증 복구**: `app.asar`의 exact-size 패치, 동일 버전 다른 빌드 덮어쓰기 차단(`ERR_ORIG_BUILD_MISMATCH`), 패치 해시(`patchedSha256`) 대조 원복, 실패 시 로더 자동 보상 롤백까지 오직 이 어댑터 하나만 수행합니다.
- **표준 플러그인 규약 및 명시적 신뢰 모델 (`AddonManifest.v1`)**: 모든 플러그인은 `schemas/addon-manifest.v1.schema.json`을 따르는 매니페스트로 `trustLevel`(`trusted` | `restricted`), 권한(`renderer`, `mainHook`), 진입점, UI 슬롯, 격리 속성을 선언합니다. `mainHook`에는 원시 Electron `app`/`webContents` 대신 최소 권한 동결 브로커만 전달됩니다.
- **전역 UI 영역 격리·표준 팝업 스택·중립 Action Port**: 상태바·사이드바·개요 패널·설정 모달·하위 페이지(`자동화`/`맞춤 설정` 등 `HostProfile.uiAnchors`) 어디에 붙이든 호스트가 `loadOrder` 순 격리 컨테이너를 발급하며, 단일 z-index·ESC·포커스 복귀 모달/팝오버 스택(`addonHost.openModal` / `toggleModal`)과 중립 액션 기여 포트(`addonHost.registerAction` / `onActionsChanged`)로 플러그인 간 UI/UX 간섭을 원천 차단합니다.
- **엄격 CSS 스코핑 및 영역 비침범 보장**: 슬롯과 모달 포털에는 `translate="no"`, `data-agy-no-translate="true"`, `data-addon-host-owner="<pluginId>"`가 자동 부착(선택적 Shadow DOM `{ shadow: true }` 지원)되며, `injectStyle()`은 CSS 이스케이프 복원 검사·엄격 `@`-규칙 화이트리스트·형제 선택자 탈출 차단과 함께 `[data-addon-host-owner="<pluginId>"]` 하위로 엄격 스코핑합니다.
- **동기·비동기 결함 및 설정 격리**: `config.json`은 읽기 전용으로만 확인하며(`enabled: false` 즉시 차단 및 리스너 자동 해제), 애드온별 상태 전이(`PENDING -> ACTIVATING -> ACTIVE / FAILED / DISPOSING -> DISPOSED`)를 추적하고 동기 예외뿐 아니라 비동기 Promise 거부·타임아웃까지 격리합니다.
- **벤더·런타임 독립 코어**: `src/core/`에는 특정 앱·Electron은 물론 `node:fs`/`node:path` 직접 의존도 전혀 없으며(`FileSystemPort` DIP), Antigravity 데스크톱은 첫 번째 기본 `HostProfile`(`src/profiles/antigravity.js`)로 연결됩니다.

## 빠른 시작

```bash
npm ci
npm test

# 읽기 전용 상태 확인 및 레거시 직접 패치 충돌 진단
node ./bin/addon-host.js --status
node ./bin/addon-host.js --doctor

# 매니페스트 검증 및 등록
node ./bin/addon-host.js --validate path/to/addon-manifest.json
node ./bin/addon-host.js --register path/to/addon-manifest.json

# 단일 공용 app.asar 로더 설치 / 원복
node ./bin/addon-host.js --install
node ./bin/addon-host.js --install --refresh-orig   # 동일 appVersion의 새 빌드 교체 시 기존 .orig 아카이브 후 갱신
node ./bin/addon-host.js --rollback
```

## 커스텀 `HostProfile` 및 플러그인 API 예제

```js
// 렌더러 플러그인 진입점 (플러그인 전용 불변 `addonHost` 핸들 자동 주입):
const container = addonHost.mountSlot('my-plugin.root');
addonHost.injectStyle('base', '.my-widget { font-size: 12px; }');
addonHost.onDispose(() => { /* 정리 로직 */ });
```

```bash
# 커스텀 비-Antigravity HostProfile 지정 실행:
node ./bin/addon-host.js --profile ./path/to/custom-profile.js --status
```

## 문서

- [플러그인 공통 규약 명세서 (`AddonManifest.v1`)](./docs/SPEC_ADDON_MANIFEST_V1.md)
- [JSON Schema (`schemas/addon-manifest.v1.schema.json`)](./schemas/addon-manifest.v1.schema.json)
- [아키텍처 및 벤더 독립 설계](./docs/ARCHITECTURE.md)
- [테스트 케이스 목록](./docs/TEST_CASES.md)

## 라이선스

[MIT](./LICENSE)
