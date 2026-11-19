# antigravity-native-addon-host

[![CI](https://github.com/jaeseongs95/antigravity-native-addon-host/actions/workflows/ci.yml/badge.svg)](https://github.com/jaeseongs95/antigravity-native-addon-host/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> **언어**: [English (README.md)](./README.md) | 한국어

**네이티브 데스크톱 앱 플러그인들이 서로의 영역을 침범하지 않도록 격리·조율하는 단일 공용 호스트 어댑터 및 공통 규약(`AddonManifest.v1`) 프로젝트입니다.**

- **단일 `app.asar` 패치 소유권**: `app.asar`의 exact-size 패치, 순정 `.orig` 백업 검증, 원복을 오직 이 어댑터 하나만 수행합니다. 개별 플러그인은 `app.asar`를 직접 수정하지 않습니다.
- **표준 플러그인 공통 규약 (`AddonManifest.v1`)**: 모든 플러그인은 `schemas/addon-manifest.v1.schema.json`을 따르는 매니페스트로 진입점, 권한(`renderer`, `mainHook`), UI 슬롯, 격리 속성을 선언합니다.
- **영역 비침범 보장**: 어댑터가 생성하는 플러그인 UI 슬롯에는 `translate="no"`, `data-agy-no-translate="true"`, `data-addon-host-owner="<pluginId>"`가 자동 부착되며, 독점(`exclusive: true`) 슬롯 및 중복 `slotId` 충돌을 등록 단계에서 차단합니다.
- **결함·설정 격리**: `config.json`은 읽기 전용으로만 확인하며(`enabled: false` 즉시 차단), 각 플러그인 로딩을 독립 `try/catch` 및 `Promise.allSettled`로 격리합니다.
- **벤더 독립 코어**: `src/core/`에는 특정 앱·프레임워크 문자열이 전혀 없으며, Antigravity 데스크톱은 첫 번째 기본 `HostProfile`(`src/profiles/antigravity.js`)로 연결됩니다.

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
node ./bin/addon-host.js --rollback
```

## 문서

- [플러그인 공통 규약 명세서 (`AddonManifest.v1`)](./docs/SPEC_ADDON_MANIFEST_V1.md)
- [JSON Schema (`schemas/addon-manifest.v1.schema.json`)](./schemas/addon-manifest.v1.schema.json)
- [아키텍처 및 벤더 독립 설계](./docs/ARCHITECTURE.md)
- [테스트 케이스 목록](./docs/TEST_CASES.md)

## 라이선스

[MIT](./LICENSE)
