# 원격 웹 호스트 (`antigravity-remote-web`)

[English Documentation](./REMOTE_WEB.md)

`antigravity-addons`(구 `antigravity-native-addon-host`) v2.3.0+는 공용 렌더러 커널(`src/runtime/renderer/kernel.js`)과 `HostBridgePort` 계약 위에 통합된 **원격 웹 호스트** 프로파일(`antigravity-remote-web`) 및 브라우저 어댑터(`src/adapters/remote-web/`)를 제공합니다.

`antigravity-desktop`용으로 개발된 `AddonManifest.v2` 준수 렌더러 플러그인은 별도의 원격 전용 API로 다시 작성하지 않아도 Antigravity Remote Web(`https://antigravity.google.com/*`)에서 자동으로 동작합니다.

## 아키텍처 및 SOLID 경계

- **호스트 프로파일 (`src/profiles/antigravity-remote-web.js`)**:
  - `id`: `'antigravity-remote-web'`
  - `compatibleHostProfiles`: `['antigravity-desktop']`
  - `supportedCapabilities`: `['renderer']`
  - `allowedOrigins`: `['https://antigravity.google.com']`
  - `trustedTypesPolicyName`: `'antigravity-remote-addon-host'`
  - Antigravity 원격 웹 전용 오리진, 네임스페이스, UI 앵커 셀렉터는 이 프로파일에만 격리됩니다.
- **벤더 중립 브라우저 어댑터 (`src/adapters/remote-web/`)**:
  - `origin-guard.js`: Fail-closed 오리진 허용 목록 검증 (비-HTTPS 스킴, URL 자격 증명, 유사 도메인, `about:`, `data:`, `javascript:`, `file:` 차단).
  - `trusted-types-guard.js`: `default`·`dompurify`·`angular` 정책 생성 금지 및 HTML 문자열 싱크 무조건 거부.
  - `dom-guard.js`: HTML 싱크 제로 DOM 생성 도우미 (`createElement`, `textContent`, Shadow DOM 컨테이너 팩토리).
  - `remote-host-bridge.js`: `HostBridgePort` 구현체 (`setPortalClaim`, `saveSettings`, `reportError`, `ping` 및 선택 메서드 `readConfigScope`, `writeConfigScope`).
  - `addon-collector.js`: `planAddonExecution`, `readVerifiedRendererScript`, Default-Deny `trust-policy.json` SHA-256 검증을 그대로 재사용하는 Node 측 Phase-1 수집기.
  - `remote-bootstrap.js`: 오리진 검증 통과 시에만 공용 커널을 부팅하고, 정적 클로저로 패킹된 애드온을 실행(`eval`·`new Function` 0건)하며, 접근성을 갖춘 다크 모드 Shadow-DOM 상태/설정 드로어를 마운트합니다.

## 플러그인 호환성 규칙

1. **매니페스트 수정 없는 자동 포함**: `compatibility.hostProfile: "antigravity-desktop"`을 선언하거나 생략한 기존 `AddonManifest.v2` 렌더러 애드온은 원격 웹 패킹 시 기본으로 자동 포함됩니다.
2. **명시적 제외(Opt-out)**: `compatibility.excludeHostProfiles: ["antigravity-remote-web"]` 또는 `"antigravity-remote-web"`을 제외한 명시적 `compatibility.hostProfiles`를 선언한 애드온은 fail-closed(`ERR_INCOMPATIBLE_HOST_PROFILE`)로 제외됩니다.
3. **`mainHook` Fail-Closed 처리**:
   - 복합 역량 애드온(`["renderer", "mainHook"]`)은 `mainHook`을 안전하게 스킵(`skippedCapabilities: ["mainHook"]`, `mainHookScript` 미포함)하고 검증된 `rendererScript`만 로드합니다.
   - `mainHook` 전용 애드온은 fail-closed(`ERR_UNSUPPORTED_HOST_CAPABILITY`)로 차단됩니다.
4. **SHA-256 신뢰 피닝**: `trustLevel: "trusted"` 또는 특권 기능(`settingsBridge`·`configBridge`·`document-transform`)을 선언한 애드온은 `trust-policy.json`의 SHA-256 승인이 일치해야 포함됩니다.

## 설정 및 Config Bridge 동작 (Phase 1 / Phase 2)

- **Phase 1 (브라우저 로컬 영속화)**:
  - `addonHost.saveSettings(nextData)`는 네임스페이스 분리된 `localStorage`(`agy-remote-addon-host:v2:settings:<pluginId>`)에 저장하고, `maxBytes` 및 프로토타입 오염 검사를 수행한 뒤 `addonHost.onSettingsChange` 구독자에게 즉시 반영합니다.
  - `addonHost.readConfigScope` / `writeConfigScope`는 별도 스냅샷이나 인증 전송 계층이 없으면 오프라인/읽기 전용 오류(`ERR_REMOTE_CONFIG_BRIDGE_OFFLINE` / `ERR_REMOTE_CONFIG_BRIDGE_READ_ONLY`)를 명시적으로 반환합니다.
- **Phase 2 확장 지점 (OCP)**:
  - `bootRemoteWebHost({ remoteTransport })`에 인증된 원격 전송 어댑터를 주입하면 플러그인 코드나 `kernel.js` 수정 없이 실시간 데스크톱 동기화로 확장할 수 있습니다.

## 빌드 및 검증

### 결정적 호스트 전용 검증 (CI 안전, 개인 데이터 미포함)

```bash
node scripts/build-remote.js --no-addons --check
```

### 로컬 사용자 패킹 (활성화된 `addons.d/*.json` 자동 번들링)

```bash
node scripts/build-remote.js
```

주요 옵션:

- `--out-dir <경로>`: 출력 디렉터리 (기본값: `dist/remote`)
- `--addons-dir <경로>`: 사용자 지정 `addons.d` 디렉터리
- `--plugins-root <경로>`: 사용자 지정 플러그인 루트 디렉터리
- `--config-json <경로>`: 사용자 지정 `config.json` 경로
- `--trust-policy <경로>`: 사용자 지정 `trust-policy.json` 경로
- `--include-settings-snapshots`: 승인된 trusted `settingsBridge` 플러그인의 초기 스냅샷 포함 (개인 설정 유출 방지를 위해 기본 비활성)
- `--no-addons`: 애드온 0건의 호스트 전용 번들 생성

### 빌드 산출물

- `antigravity-remote.user.js`: Userscript (`@match https://antigravity.google.com/*`, `@grant none`, `@run-at document-idle`)
- `bookmarklet.txt`: 인코딩된 북마클릿 로더
- `remote-runtime.cjs`: 테스트 및 임베딩용 자립형 브라우저/Node 런타임 번들
- `build-manifest.json`: 결정적 SHA-256 파일 목록 및 패킹된 애드온 다이제스트 요약

## 원격 웹 테스트 실행

```bash
node --test test/unit/v23-remote-web-adapter.test.js
node --test test/e2e/v23-remote-web-chromium.test.js
```
