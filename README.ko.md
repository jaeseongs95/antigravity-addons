# antigravity-addons

[![CI](https://github.com/jaeseongs95/antigravity-addons/actions/workflows/ci.yml/badge.svg)](https://github.com/jaeseongs95/antigravity-addons/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> **언어**: [English (README.md)](./README.md) | 한국어  
> *(구 `antigravity-native-addon-host` — 기존 `addon-host` CLI 명령, `ADDON_HOST_LOADER_V2` 패치 마커 및 `antigravity-desktop` / `antigravity-remote-web` 프로필은 100% 하위 호환됩니다.)*

**크로스 디바이스 범용 Userscript(`@inject-into content` + `GM_*` 저장소 + 모듈형 `@require` 호스트 라이브러리) · 무의존성 LAN QR 모바일 전송(`--serve-remote`) · 보조 MV3 확장 기반 원격 웹 배포, 내장 설정 화면 `애드온 관리(Addon Manager)` UI, 무의존성(0-dep) 스테이징 런타임, Electron 45 샌드박스 프리로드 격리, Shadow DOM UI 격리, 화면별 콘텐츠 영역·중앙 좌표 API, SHA-256 신뢰 핀닝, 양방향 `settingsBridge` 및 선언형 Named-Scope `configBridge`를 제공하는 벤더 중립 데스크톱·원격 웹 애드온 호스트 프레임워크(`v2.7.0`, `AddonManifest.v2` 및 `v1` 하위 호환 지원)입니다.**

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

## 문서

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
