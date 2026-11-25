# 원격 웹 호스트 (`antigravity-remote-web`)

[English Documentation](./REMOTE_WEB.md)

`antigravity-addons` v2.7.0은 공용 렌더러 커널(`src/runtime/renderer/kernel.js`)과 `HostBridgePort` 계약 위에 통합된 **범용 원격 웹 호스트**(`antigravity-remote-web`)를 제공합니다.

핵심 목표는 **데스크톱·태블릿·모바일의 다양한 브라우저 환경에서 범용적으로 사용할 수 있는 원격 웹 전달**입니다. `antigravity-desktop`용으로 개발된 `AddonManifest.v2` 준수 렌더러 플러그인은 별도의 원격 전용 API로 다시 작성하지 않아도 Antigravity Remote Web(`https://antigravity.google.com/*`)에서 동작합니다.

## 플랫폼 지원 매트릭스 (범용 Userscript 1차)

| 환경 | 1차 권장 방식 | 비고 및 실제 제약 |
| --- | --- | --- |
| **iOS / iPadOS Safari** | **Userscripts** (무료 오픈소스 App Store 확장) + `antigravity-remote.user.js` | Safari 확장으로 동작. *홈 화면에 추가한 독립 실행 PWA 웹앱에서는 Safari 확장이 실행되지 않습니다.* |
| **Android Firefox** | **Violentmonkey** 확장 + `antigravity-remote.user.js` | 모바일 Firefox 애드온 스토어에서 직접 설치 가능. *순정 Android Chrome은 확장·Userscript를 지원하지 않습니다.* |
| **macOS / Windows / Linux 브라우저** (Chrome, Edge, Firefox, Safari, Brave, Arc) | **Violentmonkey / Tampermonkey / Userscripts** + `antigravity-remote.user.js` | `@inject-into content`로 격리 월드 실행, `GM_getValue`/`GM_setValue` 영속 저장, 선택적 `@updateURL`/`@downloadURL` 자동 갱신 지원 |
| **로컬 데스크톱 Chrome / Edge (2차 보조)** | `remote-dist/extension/` 압축해제형 MV3 확장 | Userscript 매니저 없이 로컬 PC에서 바로 쓰기 위한 보조 수단 (`world: "ISOLATED"`) |

> **참고 (검증 경계)**: 북마클릿(`javascript:`)은 `antigravity.google.com`의 3중 교차 CSP(`script-src 'nonce-...'` + `require-trusted-types-for 'script'`) 및 브라우저 길이 상한 때문에 차단되므로 1차 수단이 아닙니다. 또한 로그인 후 동적 DOM 셀렉터와 브라우저 내 외부 번역 API CORS 정책은 실제 로그인 세션에 따라 달라질 수 있습니다.

## 아키텍처 및 SOLID 경계

- **호스트 프로파일 (`src/profiles/antigravity-remote-web.js`)**:
  - `id`: `'antigravity-remote-web'`
  - `compatibleHostProfiles`: `['antigravity-desktop']`
  - `supportedCapabilities`: `['renderer']`
  - `allowedOrigins`: `['https://antigravity.google.com']`
  - `trustedTypesPolicyName`: `'antigravity-remote-addon-host'`
  - `excludeOfflineConfigBridge`: `true`
  - Antigravity 전용 오리진, 네임스페이스, UI 앵커 셀렉터, 기본 배포 URL은 이 프로파일에만 격리됩니다.
- **벤더 중립 브라우저·전달 어댑터 (`src/adapters/remote-web/`)**:
  - `origin-guard.js`: Fail-closed 오리진 허용 목록 검증 (비-HTTPS 스킴, URL 자격 증명, 유사 도메인, `about:`, `data:`, `javascript:`, `file:` 차단).
  - `trusted-types-guard.js`: `default`·`dompurify`·`angular` 정책 생성 금지 및 HTML 문자열 싱크 무조건 거부.
  - `dom-guard.js`: HTML 싱크 제로 DOM 생성 도우미 (`createElement`, `textContent`, Shadow DOM 컨테이너 팩토리).
  - `remote-host-bridge.js`: `HostBridgePort` 구현체. `GM_getValue`/`GM_setValue`/`GM_deleteValue`(동기) 및 `GM.getValue`/`GM.setValue`/`GM.deleteValue`(비동기 + `hydrateSettings()`)를 우선 사용하고, 없을 때 `localStorage` → `memory-ephemeral`로 안전하게 폴백합니다.
  - `addon-collector.js`: `planAddonExecution`, `readVerifiedRendererScript`, Default-Deny `trust-policy.json` SHA-256 검증을 재사용하며, `configBridge`에 의존하는 데스크톱 전용 애드온은 기본 제외(`ERR_REMOTE_REQUIRES_LOCAL_CONFIG_BRIDGE`)합니다.
  - `remote-bootstrap.js`: 오리진 검증 통과 시 공용 커널을 부팅하고, 정적 패킹 애드온 + `@require` 기반 동적 `registerAddon(descriptor)` 등록 애드온을 실행합니다. 모바일 우선 Shadow-DOM 드로어(`44px` 터치 타깃, `<= 640px` 바텀 시트, `env(safe-area-inset-*)`, 클릭 가능한 Settings Tab·Quick Actions)를 마운트합니다.
  - `qr-ascii.js` & `remote-lan-server.js`: 외부 의존성 0건의 ISO/IEC 18004 QR 코드 인코더 및 128비트 일회성 토큰 LAN HTTP 전송 서버 (`--serve-remote`).

## 플러그인 호환성 규칙

1. **매니페스트 수정 없는 자동 포함**: `compatibility.hostProfile: "antigravity-desktop"`을 선언하거나 생략한 기존 `AddonManifest.v2` 렌더러 애드온은 원격 웹 패킹 시 기본으로 자동 포함됩니다.
2. **데스크톱 로컬 `configBridge` 애드온 기본 제외 (`v2.7.0`)**:
   - `configBridge.scopes`를 선언한 애드온(예: 로컬 `~/.gemini/config/mcp_config.json` 편집기)은 원격 웹에서 로컬 파일시스템에 접근할 수 없으므로 기본 제외(`ERR_REMOTE_REQUIRES_LOCAL_CONFIG_BRIDGE`)됩니다.
   - `compatibility.hostProfiles`에 `"antigravity-remote-web"`을 명시하거나 CLI에 `--include-offline-config-bridge`를 지정하면 포함할 수 있습니다.
3. **명시적 제외(Opt-out)**: `compatibility.excludeHostProfiles: ["antigravity-remote-web"]`, `"antigravity-remote-web"`을 제외한 명시적 `compatibility.hostProfiles`, 또는 `remote-preferences.json`에서 비활성화된 애드온은 제외됩니다.
4. **`mainHook` Fail-Closed 처리**:
   - 복합 역량 애드온(`["renderer", "mainHook"]`)은 `mainHook`을 안전하게 스킵하고 검증된 `rendererScript`만 로드합니다.
   - `mainHook` 전용 애드온은 fail-closed(`ERR_UNSUPPORTED_HOST_CAPABILITY`)로 차단됩니다.
5. **SHA-256 신뢰 피닝**: `trustLevel: "trusted"` 또는 특권 기능(`settingsBridge`·`configBridge`·`document-transform`)을 선언한 애드온은 `trust-policy.json`의 SHA-256 승인이 일치해야 포함됩니다.

## 모듈형 `@require` 플러그인 조합 (`v2.7.0`)

`antigravity-remote-host.lib.js`는 애드온 0건의 자립형 원격 호스트 런타임 라이브러리입니다. 서드파티 또는 개별 플러그인 제작자는 각자의 `.user.js`에서 `@require`로 호스트를 불러온 뒤 `registerAddon()`으로 등록할 수 있습니다.

```js
// ==UserScript==
// @name         My Remote Addon
// @match        https://antigravity.google.com/*
// @run-at       document-idle
// @inject-into  content
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @require      https://github.com/jaeseongs95/antigravity-addons/releases/latest/download/antigravity-remote-host.lib.js
// ==/UserScript==

(function () {
  'use strict';
  const rt = globalThis.__addonHostRemoteRuntime;
  if (!rt) return;
  rt.registerAddon({
    pluginMeta: {
      schemaVersion: 2,
      pluginId: 'my-remote-addon',
      displayName: 'My Remote Addon',
      version: '1.0.0',
      trustLevel: 'restricted',
      capabilities: ['renderer'],
      uiSlots: [{ slot: 'status-bar', slotId: 'my-remote-addon.bar', anchor: 'status-bar', shadow: true }],
    },
    run(addonHost) {
      addonHost.registerSettingsTab('settings', {
        label: 'My Addon Settings',
        onSelect() {
          /* 설정 모달 열기 */
        },
      });
    },
  });
  rt.bootRemoteWebHost();
})();
```

## 빌드 · 모바일 QR 전달 · 검증

### 1. 결정적 호스트 전용 검증 (CI 안전, 개인 데이터 미포함)

```bash
node scripts/build-remote.js --no-addons --check
```

### 2. 로컬 사용자 번들 빌드

```bash
node ./bin/addon-host.js --build-remote
```

주요 옵션:

- `--out-dir <경로>`: 출력 디렉터리 (기본값: `dist/remote`, CLI 기본값은 프로필의 `~/.gemini/antigravity/remote-dist`)
- `--update-base-url <https-url>`: `antigravity-remote.user.js`와 `.meta.js`에 `@updateURL` / `@downloadURL` 삽입 (HTTPS 전용)
- `--include-offline-config-bridge`: 로컬 `configBridge` 전용 애드온도 강제 포함
- `--include-settings-snapshots`: 승인된 trusted `settingsBridge` 플러그인의 초기 스냅샷 포함 (개인 설정 유출 방지를 위해 기본 비활성)
- `--no-addons`: 애드온 0건의 호스트 전용 번들 생성

### 3. 같은 Wi-Fi 모바일 기기로 QR 일회성 전송 (`--serve-remote`)

```bash
node ./bin/addon-host.js --serve-remote --once
```

- 외부 의존성 없이 터미널에 UTF-8 QR 코드와 일회성 LAN URL(`http://<LAN-IP>:<port>/<128bit-token>/`)을 출력합니다.
- 허용된 정확한 경로(`/<token>/`, `/<token>/install`, `.user.js`, `.meta.js`, `.lib.js`) 외 모든 요청은 `404`로 차단하며 `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` 헤더를 강제합니다.
- 기본 `300초` TTL 후 자동 종료되며, `--once` 지정 시 첫 `.user.js` 다운로드 완료 직후 서버를 자동 종료합니다.

### 빌드 산출물

- `antigravity-remote.user.js`: **1차 범용 산출물** — iOS Safari(`Userscripts`), Android Firefox(`Violentmonkey`), 데스크톱(`Tampermonkey`/`Violentmonkey`)용 Userscript (`@inject-into content`, `@grant GM_getValue`/`GM_setValue`/`GM_deleteValue`, `@run-at document-idle`).
- `antigravity-remote.meta.js`: Userscript 매니저 자동 업데이트 메타데이터 헤더 파일.
- `antigravity-remote-host.lib.js`: `@require` 조합용 0-애드온 순수 호스트 런타임 라이브러리 (자동 부팅 없음).
- `extension/manifest.json` + `extension/content-script.js`: **2차 데스크톱 보조 산출물** — Chrome/Edge 압축해제형 MV3 확장 (`world: "ISOLATED"`).
- `remote-runtime.cjs`: 테스트 및 임베딩용 자립형 브라우저/Node 런타임 번들.
- `build-manifest.json`: 결정적 SHA-256 파일 목록, `userscript`·`extension`·`bookmarklet` 메타데이터, 패킹된 애드온 및 제외 사유(`rejected`) 요약.

## 원격 웹 테스트 실행

```bash
node --test test/unit/v23-remote-web-adapter.test.js
node --test test/unit/v27-universal-remote-web.test.js
node --test test/e2e/v23-remote-web-chromium.test.js
```
