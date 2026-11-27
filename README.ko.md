# Extenra

[![CI](https://github.com/jaeseongs95/extenra/actions/workflows/ci.yml/badge.svg)](https://github.com/jaeseongs95/extenra/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> **언어**: [English (README.md)](./README.md) | 한국어  
> *(구 `antigravity-addons` / `antigravity-native-addon-host` — 기존 `addon-host` / `antigravity-addons` CLI 별칭, `ag-addon` SDK 별칭, `ADDON_HOST_LOADER_V2` 패치 마커, `~/.gemini/antigravity` 경로, `ag-bridge-v1:` 페어링 접두어, 원격 번들 파일명 및 `antigravity-desktop` / `antigravity-remote-web` 프로필은 100% 하위 호환됩니다.)*

**Extenra (`v3.3.4`)는 호스트 중앙 관리형 통합 원격 브리지(`ag-bridge-v1:` 한 줄 페어링 코드 + Chrome PNA 프리플라이트 + 앱 내 1클릭 원격 번들 재빌드), 3-Tier `AddonContextV3` (`AddonManifest.v3` + 1-메이저 `v2` 하위 호환 어댑터), 이중 키 `net.fetch`(DNS Rebinding 차단 + 신뢰 `localLoopback`), 별도 `@extenra/sdk`, GitHub Pages 1-Click Hub, 데스크톱 자동 업데이트 생존(`--reconcile --handoff`), 무의존성 스테이징 런타임, Shadow DOM 격리 및 SHA-256 신뢰 핀닝을 제공하는 벤더 중립 API-First 데스크톱·원격 웹 애드온 호스트 프레임워크입니다.**

## v3.3.4 주요 업데이트 (인라인 설정 헤더 닫기 버튼 겹침 수정)

- **결함 수정: 인라인 플러그인 설정 헤더 우측 여백 보정 (`.ag-inline-header`)**:
  - `src/runtime/renderer/host-settings-ui.js`의 `.ag-inline-header`에 Addon Manager(`.ah-header`)와 동일한 `padding-right: 36px;`를 추가해, 일반 및 캔버스(`--compact`) 인라인 플러그인 설정 헤더 우측의 `[ 한국어 | EN ]` 토글이 Antigravity 네이티브 설정 창의 우상단 닫기(`×`) 버튼과 겹치지 않도록 수정했습니다.
  - `test/unit/v330-ui-i18n-section-actions.test.js` (`TC-V332-HEADER-LOCALE-06`)에 `.ag-inline-header`의 `padding-right: 36px` 회귀 검증을 추가했습니다.

## v3.3.3 주요 업데이트 (보안·ReDoS·Promise 안전성 강화 및 무의존성 커버리지 연동)

- **보안 및 암호화 난수 강화**:
  - `src/runtime/renderer/kernel.js`와 `src/adapters/remote-web/remote-bootstrap.js`의 약한 `Math.random()` 토큰·논스 폴백을 제거하고, WebCrypto 미지원 시 `ERR_WEBCRYPTO_UNAVAILABLE`로 fail-closed 처리합니다.
  - `src/runtime/main/trust-verifier.js`의 문자열 래핑 `vm.runInThisContext` 호출을 Node 표준 `vm.compileFunction`으로 교체했습니다.
- **신뢰성·결정성 및 선형 시간 파싱 보강**:
  - 런타임·매니페스트·스타일·전송·빌드 스크립트의 초선형 역추적(ReDoS 취약) 정규식 12건을 선형 시간 `O(n)` 루프와 비중첩 패턴으로 교체했습니다.
  - 21개 `.sort()` 호출에 로케일 독립 UTF-16 코드 유닛 비교자를 명시해 결정적 정렬을 보장하고, `init-main.js`·`remote-bootstrap.js`·`remote-lan-server.js`·`host-settings-ui.js`의 부유 Promise 20건을 정비했습니다.
- **무의존성 LCOV 커버리지 연동 및 회귀·실패 경로 시험 확장**:
  - 신규 패키지 추가 없이 Node.js 내장 `--experimental-test-coverage` 기반 `npm run test:coverage` LCOV 파이프라인을 연동하고, 핵심 정책·분기·SDK `createTestHost`·`preload-bridge` 실패 경로 테스트를 확장(`171`건 통과, `0`건 실패)해 SonarQube MQR 품질 게이트 `OK`(보안·신뢰성·유지보수성·핫스팟 미해결 이슈 `0`건)를 달성했습니다.

## v3.2.0 주요 업데이트 (프로젝트명 Extenra 변경 · 100% 하위 호환 유지)

- **프로젝트·패키지명 변경 (`Extenra`)**:
  - 프로젝트 및 패키지명을 **`extenra`**, **`@extenra/sdk`**로 변경하고 **`extenra`** · **`extenra-addon`** CLI 명령을 추가했습니다. GitHub 저장소 URL(`https://github.com/jaeseongs95/extenra`), 1-Click Hub, JSON Schema v3 `$id`, 기본 Userscript `@namespace`/`@require` 주소 및 영문·국문 문서를 일괄 갱신했습니다.
- **100% 하위 호환성 유지**:
  - 기존 CLI 별칭(`addon-host`, `antigravity-addons`, `ag-addon`), Antigravity 호스트 프로필(`antigravity-desktop`, `antigravity-remote-web`), 로컬 경로(`~/.gemini/antigravity/...`), ASAR 패치 마커(`ADDON_HOST_LOADER_V2`), 페어링 접두어(`ag-bridge-v1:`), 원격 번들 파일명(`antigravity-remote-host.lib.js`, `antigravity-remote.user.js`, `antigravity-curated-all-in-one.user.js`)은 그대로 유지되어 기존 플러그인들이 수정 없이 동작합니다.

## v3.1.1 주요 업데이트 (Chrome PNA 프리플라이트 지원 · 원격 브리지 셀프 호스팅 예시 문서화)

- **Chrome/Edge Private Network Access(PNA) 프리플라이트 지원 (`remote-bridge-server.js`)**:
  - 허용된 `Origin`의 `OPTIONS` 프리플라이트 요청에 한해 `Access-Control-Allow-Private-Network: true`(`Vary: Origin, Access-Control-Request-Private-Network`)를 응답하여, 최신 Chromium에서 `https://antigravity.google.com` → 같은 PC `http://127.0.0.1:19384` 또는 사설망 HTTPS 리버스 프록시 연결이 차단되지 않도록 보강했습니다(미허용 오리진은 `403` 차단 유지).
- **원격 호스트 브리지 셀프 호스팅 연결 예시 추가**:
  - 같은 PC · 공유기(포트포워딩 + DDNS + HTTPS 리버스 프록시) · Cloudflare Tunnel · Tailscale Funnel 연결 예시를 문서화했습니다.

## v3.1.0 주요 업데이트 (호스트 중앙 관리형 통합 원격 브리지 · `userApprovedHttps` 수정)

- **Native Host 중앙 관리형 통합 원격 브리지 (`src/runtime/main/remote-bridge-server.js` + `src/adapters/remote-web/remote-host-transport.js`)**:
  - 원격 웹 <-> 데스크톱 통신을 Native Host가 단일 프레임워크로 통합 관리해 개별 플러그인이 각자 원격 URL/토큰 입력 UI나 독자 원격 서버를 만들 필요가 없습니다.
  - 기본 비활성(`enabled: false`)이며 데스크톱 **설정 -> 애드온 관리**에서 활성화·설정합니다. CSPRNG 256비트 토큰을 예약 파일 `remote-bridge.json`(`0o600`)에 저장하고 엄격한 정확 일치 `Origin` CORS, 상수 시간 Bearer 인증, 매 요청 실시간 SHA-256 신뢰 검증, 한 줄 페어링 코드(`ag-bridge-v1:...`)를 제공합니다.
  - 원격 웹 드로어의 **Host Bridge** 탭(인덱스 3)에서 한 번만 페어링하면 모든 플러그인의 `ctx.settingsBridge`, `ctx.configBridge`, `ctx.net.fetch`(신뢰 `localLoopback` 사이드카 포함)를 투명하게 라우팅하고 `host:remote-bridge-changed` 이벤트를 전파합니다.
- **데스크톱 앱 내 1클릭 원격 번들 재빌드**:
  - 데스크톱 **설정 -> 애드온 관리**에 **`지금 원격 번들 빌드`** 버튼을 추가해 `execFile`(`shell: false`)로 호스트 CLI를 직접 실행합니다.
- **결함 수정: `permissions.net.userApprovedHttps: true` 보존**:
  - `src/core/manifest-normalizer.js` (`normalizePermissionsV3`)에서 v3 매니페스트 정규화 시 `userApprovedHttps: true`가 누락되던 문제를 수정했습니다.

## v3.0.1 주요 업데이트 (v3 생태계 패리티 및 품질 보강)

- **`AddonContextV3` 전용 `ctx.settingsBridge` 노출**:
  - `settingsBridge`를 선언하고 신뢰 승인된 v3 플러그인에 한해 World 998 프로토타입 방어가 적용된 동결 `ctx.settingsBridge`(`getSettings`/`getSnapshot`, `onSettingsChange`/`onDidChange`, `saveSettings`/`save`)를 노출하며, `lifecycle.onDispose` 시 구독 자동 해제 및 SDK `createTestHost({ initialSettings })` 패리티를 지원합니다.
- **데스크톱 Settings 좌측 사이드바 및 Addon Manager 카드에서 `ui.registerSettingsPage` 공식 노출**:
  - `settingsPageCoordinator`를 `createHostSettingsUi`에 연동하여, `ctx.ui.registerSettingsPage`로 등록된 모든 v3 플러그인 설정 페이지가 **데스크톱 Settings 좌측 사이드바(`Addon Manager` 바로 아래)** 와 **Addon Manager 카드 내 `설정` 버튼** 양쪽에서 표시·실행되며 마운트/해제에 실시간 반응합니다.
- **Userscript 헤더·SDK·Canvas·동적 스키마 보강**:
  - `scripts/build-remote.js`: `--build-addon-userscript`의 `@description`이 매니페스트 버전에 맞춰 `AddonManifest.v3` / `v2`를 동적으로 표기합니다.
  - `packages/sdk/src/test-host.js`: mock DOM `querySelectorAll`의 텍스트 노드(`nodeType: 3`) 예외 가드 및 `doc.createTextNode()`를 추가했습니다.
  - `src/runtime/renderer/context-v3.js`: `ui.mountCanvas`에서 `slotHandle.getRootNode()`를 통해 ShadowRoot 토큰 CSS가 안정적으로 주입되도록 수정했습니다.
  - `src/runtime/renderer/settings-page-coordinator.js`: `ui.registerSettingsPage`에서 `getSchema` 단독 선언도 허용하도록 수정했습니다.

## v3.0.0 주요 업데이트 (API-First 3-Tier 프레임워크 · `@antigravity-addons/sdk` · 1-Click Hub)

- **3-Tier ISP 분리 `AddonContextV3` 및 `v2` 하위 호환 어댑터** ([API_V3.ko.md](./docs/API_V3.ko.md)):
  - **Tier 1 (Zero-DOM)**: `ui.showToast`, `ui.confirm`, `ui.prompt`, `ui.registerCommand`, `ui.registerStatusItem`(`host.statusbar` 서비스 위임 + 기본 폴백 바 + 클릭 modifier), `ui.registerSettingsPage`(Desktop + Remote Web 통합).
  - **Tier 2 (호스트 배치 오버레이 + 선언형 JSON 스키마)**: `ui.openPopup`, `ui.openModal`, `ui.openPanel` (`PlacementSpec` 플립/시프트/리사이즈·스크롤 추적, 모바일 `<=640px` 바텀시트 자동 전환, Top Layer `<dialog>`/`popover`, 제거 불가 `Addon: <displayName>` 배지, 16종 폐쇄형 프리미티브, 정적 `visibleWhen`/`disabledWhen`, ID 기반 인플레이스 `handle.update(nextTree)`).
  - **Tier 3 (통제된 탈출구)**: `ui.mountCanvas`(open Shadow DOM + `--ag-*` 시맨틱 토큰), `ui.createStyleElementSafe`, 매니페스트 권한 게이팅 `dom`.
  - **ISP·보안·SOLID #0**: `env`에서 원시 `hostProfileId` 제거, 미선언 `net`/`dom`/`configBridge` 생략, 이중 키 `net.fetch`(사전 DNS 조회로 RFC1918·IMDS·DNS Rebinding 차단 및 `localLoopback` 0-리다이렉트), `services` 기본 거부 `allowedCallers`·프로토타입 키 제거, `kernel.js` 벤더 셀렉터 프로필 분리 및 CI `npm run check:solid` 게이트 적용.
- **별도 `@antigravity-addons/sdk` (`packages/sdk/`) 및 GitHub Pages 1-Click Hub (`docs/hub/`)**:
  - 런타임 호스트 신규 npm 의존성 0개를 유지하면서 `index.d.ts`, `defineAddon()`, `h()`, 실제 커널 기반 `createTestHost({ surface })`, `ag-addon init|check|dev|build|pack` CLI 및 재사용 GitHub Action 제공.
  - 결정적 `npm run build:hub` / `check:hub`로 Safari 감지 시 공식 큐레이션 올인원 `.user.js`(`closed` Shadow DOM + `GM_*` 클로저 섀도잉)로 안내하는 1-Click Hub 생성.

## v2.8.0 주요 업데이트 (공개 HTTPS 모듈형 애드온 Userscript · 다중 샌드박스 공존)

- **다중 Userscript 샌드박스 자동 공존 (사설 IP·로컬 PC 불필요, 진짜 1클릭 공개 HTTPS 배포)**:
  - `src/adapters/remote-web/remote-bootstrap.js`에 플러그인별 DOM 점유 추적(`data-remote-addon-host-plugins`)과 피어 드로어 투영을 추가했습니다. Tampermonkey/Violentmonkey/Safari Userscripts에서 서로 다른 샌드박스로 실행되는 여러 `@require` 애드온이 **단일 Shadow-DOM 드로어**(`drawerCount === 1`, 합산 `active/total` 배지, 샌드박스별 클릭 가능한 Quick Action·Settings Tab, `hostToken`·`GM_*` 저장소 완전 격리, 독립 해제) 안에서 자동 공존하며, 기존 동일 번들 교차 월드 중복 부트 가드(`TC-RW-E2E`)도 100% 유지됩니다.
- **표준 모듈형 애드온 Userscript 빌더 (`addon-host --build-addon-userscript`)**:
  - `scripts/build-remote.js`(`buildAddonUserscript`)와 `bin/addon-host.js`를 확장해 어떤 `AddonManifest.v2` 플러그인 저장소든 Acorn AST 보안 검증을 통과한 `<pluginId>.user.js` + `<pluginId>.meta.js`(공개 HTTPS `@require antigravity-remote-host.lib.js`, 선택적 HTTPS `@updateURL`/`@downloadURL`, 엄격한 `@connect` 호스트 허용 목록 및 `--grant-xhr`)를 결정적으로 생성할 수 있습니다.
- **현실 기준 설정 UI 및 문서 정비**:
  - 외부 네트워크(LTE/5G·타 기기·PC 꺼짐)에서는 공개 HTTPS 애드온 `.user.js` 1클릭 설치 또는 단일 `.user.js` 파일 1회 가져오기가 1차 경로임을 명확히 하고, `--serve-remote`는 같은 Wi-Fi + 방화벽 개방 환경용 로컬 복사 보조 도구로 정확히 구분했습니다.

## v2.7.0 주요 업데이트 (범용 원격 웹 전달 · 인터랙티브 모바일 드로어 · 모듈형 `@require` 호스트)

- **범용 Userscript 1차 배포 및 모듈형 `@require` 호스트 라이브러리**:
  - **iOS/iPadOS Safari (`Userscripts`)**, **Android Firefox (`Violentmonkey`)**, **데스크톱 브라우저 (`Violentmonkey`/`Tampermonkey`)**를 아우르는 범용 Userscript(`antigravity-remote.user.js` + `antigravity-remote.meta.js`)를 1차 배포 수단으로 승격하고, 로컬 압축해제형 MV3 확장(`remote-dist/extension/`)을 2차 보조 경로로 정리했습니다.
  - 0-애드온 순수 호스트 라이브러리 `antigravity-remote-host.lib.js`와 `globalThis.__addonHostRemoteRuntime.registerAddon(descriptor)` API를 추가해 독립 플러그인들이 `@require`로 호스트를 공유할 수 있습니다.
  - Userscript 헤더를 `@inject-into content`, `@grant GM_getValue`/`GM_setValue`/`GM_deleteValue`(`GM_*` → `localStorage` → `memory-ephemeral` 자동 폴백), 선택적 `--update-base-url <https-url>`(`@updateURL`/`@downloadURL`)로 고도화했습니다.
- **무의존성 LAN QR 모바일 일회성 전송 (`addon-host --serve-remote`)**:
  - 외부 패키지 0건의 ISO/IEC 18004 QR 인코더(`src/adapters/remote-web/qr-ascii.js`)와 128비트 랜덤 토큰 LAN HTTP 서버(`src/adapters/remote-web/remote-lan-server.js`)를 추가했습니다. 정확한 경로 화이트리스트, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, 기본 `300초` 자동 종료, `--once` 첫 다운로드 후 자동 종료를 지원합니다.
- **인터랙티브 모바일 우선 드로어 및 데스크톱 `configBridge` 기본 제외**:
  - `kernel.js` / `settings-tab-coordinator.js` / `remote-bootstrap.js`에 호스트 토큰 보호 `selectSettingsTab`·`listHostActions`·`invokeHostAction`을 추가하여 드로어 안의 Settings Tab과 Quick Action을 클릭으로 바로 실행할 수 있으며, `44px` 터치 타깃·`<= 640px` 하단 바텀 시트·`env(safe-area-inset-*)`를 적용했습니다.
  - 로컬 파일시스템에 의존하는 데스크톱 `configBridge` 애드온은 원격 웹 번들에서 기본 제외(`ERR_REMOTE_REQUIRES_LOCAL_CONFIG_BRIDGE`, 명시적 `antigravity-remote-web` opt-in 또는 `--include-offline-config-bridge`로 재정의 가능)하고, 데스크톱 `설정 > 애드온 관리`의 1차 CTA를 `Userscript 경로 복사`·`모바일 QR 전달 명령 복사`로 전환했습니다.

## v2.6.0 주요 업데이트 (로컬 MV3 브라우저 확장 배포 · 커널 슬리밍 · CSP/TrustedTypes 보안 강화)

- **원격 웹 1차 배포 수단 — 로컬 압축해제형 MV3 브라우저 확장 (`remote-dist/extension/`)**:
  - `addon-host --build-remote`가 기존 `antigravity-remote.user.js`·`remote-runtime.cjs`와 함께 자립형 Manifest V3 브라우저 확장(`extension/manifest.json` + `extension/content-script.js`)을 자동 생성합니다.
  - 데스크톱 Electron World `998`과 동일한 `"world": "ISOLATED"` 환경에서 실행되어 `script-src 'nonce-...'`와 TrustedTypes 주입 제약을 별도 Userscript 관리자 없이 통과하며, `permissions`·`host_permissions`·`background`·`web_accessible_resources` 0건 및 벤더 중립 `src/adapters/remote-web/extension-manifest.js`(SOLID #0) 기반의 fail-closed HTTPS `matches`만 허용합니다.
  - 공개 GitHub 저장소는 철저히 호스트 전용(`--no-addons`)을 유지하며, 타 플러그인 코드나 로컬 설정 스냅샷을 공개 게시하지 않습니다.
- **64 KB Fail-Closed 북마클릿 상한 및 원격 웹 커널 슬리밍**:
  - 원격 웹 번들에서 데스크톱 전용 `host-settings-ui.js`(약 61.5 KB)를 제외합니다(`buildRendererKernelBundleSource({ includeHostSettingsUi: false })`).
  - 브라우저 `<input>` 잘림을 유발하던 기존 2 MB 상한을 `BOOKMARKLET_MAX_RUNNABLE_CHARS = 65536`으로 교체해, 실행 불가 크기의 `bookmarklet.txt`는 디스크 생성을 생략(기존 구버전 파일 정리)하고 Electron IPC로 전송하지 않습니다.
- **Acorn AST TrustedTypes 검사 확장 및 운영성 보강**:
  - `verifyRemoteBundleAst`가 `setHTMLUnsafe`, `srcdoc`, `createContextualFragment`, `parseFromString`, 문자열 `setTimeout`/`setInterval`, `createElement('script')`, `new Worker`/`SharedWorker`, 인라인 `setAttribute('on*', ...)`까지 차단합니다.
  - 확장(`ISOLATED`)과 Userscript(`MAIN`) 동시 활성화 시 중복 마운트를 막는 교차 월드 DOM 가드(`data-remote-addon-host-active`), 애드온 실행 전 드로어 선마운트 및 실패 배지 표시, 부트 실패 콘솔 경고, Windows `EBUSY` 안전 제자리 갱신, 그리고 `설정 > 애드온 관리`의 `확장 경로 복사`·`Userscript 경로 복사`·`chrome://extensions` 2단계 안내를 추가했습니다.

## v2.5.0 주요 업데이트 (설정 화면 내장 `애드온 관리` UI · 원격 웹 표시 제어)

- **설정 화면 내장 `애드온 관리(Addon Manager)` UI (호스트 자체 Shadow DOM · SOLID #0)**:
  - 별도 관리 플러그인을 추가하지 않고 렌더러 커널에 직접 내장된 벤더 중립 설정 탭(`src/runtime/renderer/host-settings-ui.js`, 프로필 선언형 `HostProfile.settingsUi`)을 제공합니다. 기본 설정 탭 및 동료 플러그인 탭(`MCP Manager` 등)과 충돌 없이 공존합니다.
  - 네이티브 호스트 기반으로 실행 중인 애드온의 데스크톱 상태(`실행 중`/`비활성`/`차단됨`/`오류`), 신뢰 승인 여부, 선언 기능(`렌더러 UI`/`메인 훅`/`설정 브리지`/`구성 브리지`), 원격 웹 번들 동기화 상태(`최신 상태`/`재빌드 필요`/`미빌드`)와 원클릭 빌드 명령·북마클릿 복사를 한 화면에서 제공합니다.
- **애드온별 원격 웹 표시 설정 (`remote-preferences.json`)**:
  - 호스트 전용 메인 서비스(`src/runtime/main/host-admin-service.js`)와 인증된 IPC 채널(`HOST_ADMIN_STATE`, `HOST_ADMIN_SET_REMOTE_PREF`)을 추가했으며, 소비자 플러그인 `addonHost` 핸들에는 일절 노출하지 않습니다.
  - 원격 웹 호환 애드온마다 `원격 웹 표시` 토글을 켜거나 끌 수 있으며 변경 사항은 `HOST_DATA_DIR/remote-preferences.json`에 원자적으로 저장됩니다(`~/.gemini/config/plugins/` 무쓰기 원칙 유지).
  - `src/adapters/remote-web/addon-collector.js`와 `scripts/build-remote.js`(`--remote-prefs`)가 해당 설정을 반영해 꺼진 애드온을 `DISABLED_BY_REMOTE_PREFERENCES`로 제외합니다.
- **로더 프로필 전달 보강**:
  - `src/adapters/electron/host-loader-builder.js`가 `uiSurfaces`, `settingsUi`, `remoteProfileId`, `remoteSupportedCapabilities`, `remotePrefsPath`, `remoteDistDir`를 로더 설정으로 전달하며 `addon-host --upgrade` 시 `app.asar` 재패치는 0바이트입니다.

## v2.4.0 주요 업데이트 (화면별 중앙 좌표 API · `--build-remote` 기본 경로 결함 수정 · F7 보강)

- **화면(Surface)별 콘텐츠 영역·중앙 좌표 API (SOLID #0)**:
  - 벤더 중립 `src/runtime/renderer/surface-geometry.js`와 프로필 선언형 `HostProfile.uiSurfaces`(`settings-pane`, `customizations-page`, `automation-page`, `workspace`)를 추가했습니다.
  - 모든 `addonHost` 핸들에 `getSurfaceBounds(surfaceIdOrOpts?)`, `getActiveSurface()`, `listSurfaces()`를 제공하여 각 화면의 실제 콘텐츠 영역과 중앙 좌표(`centerX`, `centerY`) 및 고정 inset을 반환합니다.
  - `openModal(slotId, { surface, align })` 및 `modalHandle.reposition(nextSurface?)`를 지원해 사이드바 등 크롬 영역을 제외한 활성 화면 정중앙에 모달을 정렬하며, 창 크기 변경(`resize`)을 자동 추적합니다(옵션 미지정 시 기존 전체 뷰포트 중앙 정렬 하위 호환 유지).
- **결함 수정: `--build-remote` 기본 CLI 경로 폴백 복구 (`scripts/build-remote.js`)**:
  - 미지정 `configJsonPath`/`trustPolicyPath` 기본값을 `null`에서 `undefined`로 교정해 기본 `addon-host --build-remote` 실행 시 `TRUST_POLICY_PATH`·`CONFIG_JSON_PATH`로 정상 폴백하도록 수정했습니다(명시적 `null` 전달 의미는 보존).
- **보안 보강 (`F7`)**:
  - `src/adapters/remote-web/remote-bootstrap.js`에서 `activeKernel.boot()` 호출 전 `profile.extraNoTranslateAttributes`를 `isSafeExtraAttrName`으로 사전 필터링합니다.

## v2.3.0 주요 업데이트 (Remote Web 호스트 통합 · Option A Named-Scope `configBridge`)

- **Remote Web 호스트(`antigravity-remote-web`) 및 공용 `HostBridgePort` 통합**:
  - 전송 계층 중립 `HostBridgePort`를 도입해 단일 렌더러 커널(`src/runtime/renderer/kernel.js`)이 Desktop Electron(프리로드 `claim(nonce)`)과 Remote Web(`https://antigravity.google.com/*`) 모두에서 동일하게 실행됩니다.
  - 다중 프로필 호환성(`compatibleHostProfiles`, `compatibility.hostProfiles`, `compatibility.excludeHostProfiles`)과 `supportedCapabilities` 게이팅을 추가했습니다. 기존 `antigravity-desktop`용 `AddonManifest.v2` 렌더러 애드온은 수정 없이 Remote Web에 자동 포함되며, `mainHook` 병행 애드온은 안전하게 `mainHook`만 스킵하고 `mainHook` 전용 애드온은 `ERR_UNSUPPORTED_HOST_CAPABILITY`로 차단됩니다.
  - 벤더 중립 브라우저 어댑터(`src/adapters/remote-web/`), Shadow-DOM 상태·설정·진단 드로어, HTML 싱크 제로 DOM 헬퍼, 스코프드 TrustedTypes 가드, 결정적 Userscript & Bookmarklet 빌더(`npm run build:remote`, `npm run check:remote`, `addon-host --build-remote`, `addon-host --profile remote-web --status`)를 제공합니다. 자세한 내용은 [Remote Web 호스트 가이드 (`docs/REMOTE_WEB.ko.md`)](./docs/REMOTE_WEB.ko.md)를 참고하세요.
- **Option A 선언형 Named-Scope `configBridge` (`AddonManifest.v2`)**:
  - `trustLevel: "trusted"` 및 `trust-policy.json` SHA-256 승인을 받은 렌더러 플러그인이 벤더 중립 `configBridge.scopes` (`[{ scopeId, access: "ro" | "rw", maxBytes? }]`)를 선언할 수 있으며, `SlotRegistry`가 `scopeId`당 단일 `rw` 작성자 배타성(`ERR_DUPLICATE_CONFIG_SCOPE_WRITER`)을 강제합니다.
  - Antigravity 전용 3개 Named Scope(`antigravity:mcp-config` `rw`, `antigravity:plugin-mcp-configs` `ro`, `antigravity:mcp-config-legacy` `ro`)는 `src/profiles/antigravity.js`에만 격리 정의됩니다.
  - 메인 프로세스에서 상위 경로 심볼릭 링크/정션 차단, 단일 fd 크기 제한 읽기, 손상 JSON 원문 복구(`status: "corrupt"`), 권고 락 파일, SHA-256 CAS(`ERR_CONFIG_CAS_CONFLICT`), `fsyncSync` + Windows 재시도 원자적 `renameSync`를 수행하며 `app.asar` 재패치는 0바이트입니다.

## v2.2.0 주요 업데이트 (신뢰 `settingsBridge.saveSettings` IPC · 모달 중앙 정렬 · 보안 경화)

- **신뢰 `settingsBridge.saveSettings()` 양방향 영구 저장**: `trustLevel: "trusted"` 및 `trust-policy.json` SHA-256 승인을 받은 플러그인이 World `998`에서 `addonHost.saveSettings(nextData)`로 검증된 설정 JSON을 원자적 저장할 수 있습니다. 메인 프로세스가 `verifyClaimedEvent`, `(wcId, pluginId)` 신뢰 바인딩, 경로 격리, 예약 파일·심볼릭 링크 차단, `parseSafeJson` 프로토타입 오염 방지, `maxBytes` 상한, Windows 락 재시도 원자적 rename, 그리고 모든 열린 창으로의 즉시 브로드캐스트를 강제합니다(`app.asar` 재패치 0바이트).
- **앱 CSS 리셋 환경에서의 Top-Layer `<dialog>` 중앙 정렬**: `modal-portal.js`가 `position: fixed; inset: 0; top: max(env(titlebar-area-height, 36px), 36px); margin: auto; width: fit-content; height: fit-content;`를 적용하여 Tailwind Preflight(`* { margin: 0 }`) 환경에서도 모든 플러그인 모달이 타이틀바 아래 정중앙에 배치됩니다.
- **다중 창 `settingsBridge` 동기화 레이스 해소 (`I1`)**: 신규 창 진입(`readSnapshotForPlugin`) 중 설정 파일 변경을 감지하면 이미 활성화된 기존 창에도 즉시 변경 이벤트를 전파하고, 창(`wcId`)별 전달 키 추적으로 중복 푸시를 방지합니다.
- **Windows 일시 파일 잠금 유예 및 `fs.watch` 자동 복구 (`I2`)**: `EBUSY`/`EPERM`/`EACCES` 순간 잠금 시 제한 백오프 재시도(`80ms → 160ms → 320ms`) 후 Fail-Closed 전환 및 자가 복구를 수행하며, 디렉터리 미존재·`watcher` 오류 발생 시 지수 백오프(`500ms → 5000ms`)로 감시를 자동 재연결합니다.
- **World `998` 원시 객체 완전 캡처 및 `invokeAction` 신뢰 경계 (`I4`)**: `kernel.js` 로드 시점에 핵심 JS 원시 객체(`Object.freeze`, `Map`/`Set`/`WeakMap`/`WeakSet`, `Set.prototype.size`, `JSON.stringify`, `Promise`, `forEach`, `Reflect.apply`, `Error`, `String`, `Uint8Array`, `crypto.getRandomValues`)를 사전 캡처해 프로토타입·이터레이터 오염을 차단하고, `listActions()`·`invokeAction()`에 `trustLevel` 경계(`ERR_ACTION_TRUST_FORBIDDEN`)를 적용했습니다.
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

# Remote Web 범용 Userscript 번들 빌드 · 검증 · 모바일 LAN QR 전송
npm run check:remote
npm run build:remote
node ./bin/addon-host.js --profile remote-web --status
node ./bin/addon-host.js --build-remote --no-addons --check
node ./bin/addon-host.js --serve-remote --once

# 공유 app.asar 부트스트랩 설치, 업그레이드(V1 -> V2) 및 롤백
node ./bin/addon-host.js --install
node ./bin/addon-host.js --upgrade
node ./bin/addon-host.js --rollback
```

## 원격 호스트 브리지 외부 연결 예시 (셀프 호스팅)

원격 호스트 브리지는 **기본 비활성**(`127.0.0.1:19384`)입니다. 데스크톱 **설정 → 애드온 관리 → 원격 호스트 브리지**에서 활성화한 뒤, 원격 웹 드로어의 **Host Bridge** 탭에 1줄 페어링 코드(`ag-bridge-v1:...`)를 한 번만 붙여 넣어 연결합니다.

> **보안 주의**: `https://antigravity.google.com`은 HTTPS 페이지이며 모든 요청에 `Authorization: Bearer <토큰>`이 포함되므로 **평문 HTTP를 외부 인터넷에 직접 열지 마세요.** 외부 접속 시에는 반드시 HTTPS(TLS) 앞단을 두어야 합니다.

### 1. 같은 PC (터널 불필요)
1. **애드온 관리**에서 `바인드: 127.0.0.1`, `포트: 19384`, **공개 HTTPS URL**은 비워 두고 활성화·저장합니다.
2. **페어링 코드 복사** 후 브라우저 원격 웹 드로어 **Host Bridge** 탭에 붙여 넣습니다.

### 2. 공유기 (포트포워딩 + DDNS + HTTPS 리버스 프록시)
1. **애드온 관리**에서 포트를 `19384`로 켭니다(리버스 프록시가 같은 PC에 있으면 `127.0.0.1`, NAS/공유기 등 다른 기기에 있으면 `0.0.0.0` + 방화벽 허용).
2. 공유기에서 DDNS(`bridge.example.com` 또는 `xxx.iptime.org`)를 설정하고 외부 `443`(인증서 자동 발급용 `80`) 포트를 리버스 프록시 장비(PC · 시놀로지 NAS · Nginx Proxy Manager · Caddy 등)로 포트포워딩합니다.
3. 리버스 프록시에서 HTTPS(Let's Encrypt)를 종단해 내부 `19384`로 전달합니다 — `Caddyfile` 예시:
   ```caddyfile
   bridge.example.com {
       reverse_proxy 127.0.0.1:19384
   }
   ```
4. 데스크톱 **공개 HTTPS URL**에 `https://bridge.example.com`을 입력·저장한 뒤 갱신된 페어링 코드를 복사합니다.

### 3. Cloudflare Tunnel (포트포워딩 불필요)
```bash
cloudflared tunnel --url http://127.0.0.1:19384
```
출력된 `https://<random>.trycloudflare.com` (또는 고정 터널 도메인)을 **공개 HTTPS URL**에 입력·저장한 뒤 페어링 코드를 복사합니다.

### 4. Tailscale Funnel (포트포워딩 불필요 · 자동 HTTPS)
```bash
tailscale funnel 19384
```
발급된 `https://<machine>.<tailnet>.ts.net` 주소를 **공개 HTTPS URL**에 입력·저장한 뒤 페어링 코드를 복사합니다.

## 문서

- [릴리스 노트 (`v3.2.0` 영문/국문)](./RELEASE_NOTES_v3.2.0.md)
- [릴리스 노트 (`v3.1.1` 영문/국문)](./RELEASE_NOTES_v3.1.1.md)
- [릴리스 노트 (`v3.1.0` 영문/국문)](./RELEASE_NOTES_v3.1.0.md)
- [릴리스 노트 (`v2.5.0` 영문/국문)](./RELEASE_NOTES_v2.5.0.md)
- [릴리스 노트 (`v2.4.0` 영문/국문)](./RELEASE_NOTES_v2.4.0.md)
- [릴리스 노트 (`v2.3.0` 영문/국문)](./RELEASE_NOTES_v2.3.0.md)
- [Remote Web 호스트 가이드 (`docs/REMOTE_WEB.ko.md`)](./docs/REMOTE_WEB.ko.md)
- [릴리스 노트 (`v2.2.0` 영문/국문)](./RELEASE_NOTES_v2.2.0.md)
- [릴리스 노트 (`v2.1.0` 영문/국문)](./RELEASE_NOTES_v2.1.0.md)
- [릴리스 노트 (`v2.0.0` 영문/국문)](./RELEASE_NOTES_v2.0.0.md)
- [English README (`README.md`)](./README.md)
- [JSON Schema v2 (`schemas/addon-manifest.v2.schema.json`)](./schemas/addon-manifest.v2.schema.json)
- [JSON Schema v1 (`schemas/addon-manifest.v1.schema.json`, 동결)](./schemas/addon-manifest.v1.schema.json)
- [아키텍처 및 벤더 중립성](./docs/ARCHITECTURE.md)
- [테스트 케이스 목록](./docs/TEST_CASES.md)

## 라이선스

[MIT](./LICENSE)
