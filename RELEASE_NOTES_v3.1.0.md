# antigravity-addons v3.1.0

## English

### 1. Native Host-Managed Unified Remote Bridge Framework
- **One Host-Managed Remote Connection for All Plugins**: Individual plugins no longer need to build their own Remote Sidecar URL/Token settings UI or bespoke remote transports.
- **Authenticated Main-Process Remote Bridge Server (`src/runtime/main/remote-bridge-server.js`)**:
  - Disabled by default (`enabled: false`), explicitly toggled and configured in Desktop **Settings -> Addon Manager (애드온 관리)**.
  - Persists configuration and a CSPRNG 256-bit Bearer token in `remote-bridge.json` (`0o600`, symlink-rejected, atomic writes, strictly reserved from plugin `settingsBridge` / `configBridge` access).
  - Enforces constant-time (`crypto.timingSafeEqual`) Bearer auth on every route, strict exact `Origin` CORS allowlist (never `*`), 512 KiB body cap, and live manifest + SHA-256 trust verification on every `/v1/settings/*`, `/v1/config/*`, and `/v1/net/fetch` request.
  - Generates a 1-line Pairing Code (`ag-bridge-v1:...`) for 1-click copy from Desktop Addon Manager.
- **Desktop Addon Manager (`host-settings-ui.js`)**:
  - Built-in **Remote Host Bridge (`원격 호스트 브리지`)** management card (Enable switch, Port, Bind address, optional Public HTTPS URL, 1-click Pairing Code copy, Token rotation, live running status).
  - Built-in **1-click `Rebuild Bundle Now` (`지금 원격 번들 빌드`)** button executing the host CLI directly via `execFile` (`shell: false`).
- **Remote Web Host Drawer (`remote-bootstrap.js` + `remote-host-transport.js`)**:
  - Dedicated **Host Bridge** tab (index 3, preserving existing tab indices) where the user pastes the Pairing Code once.
  - Transparently routes `ctx.settingsBridge`, `ctx.configBridge`, and `ctx.net.fetch` (including trusted `localLoopback` sidecars) for all plugins, re-hydrates settings snapshots, and broadcasts `host:remote-bridge-changed`.
- **SDK Test Host Parity (`@antigravity-addons/sdk v3.1.0`)**:
  - Added optional `remoteBridgeConnected` option to `createTestHost` and `env.capabilities.hasRemoteHostBridge` typing.

### 2. Manifest Normalizer Fix (`userApprovedHttps: true`)
- Fixed `src/core/manifest-normalizer.js` (`normalizePermissionsV3`) dropping `permissions.net.userApprovedHttps: true` during v3 manifest normalization so user-approved HTTPS hosts on Remote Web work as designed.

---

## 한국어

### 1. Native Host 중앙 관리형 통합 원격 브리지 프레임워크
- **모든 플러그인을 위한 단일 호스트 원격 연결**: 개별 플러그인(상태바, MCP 매니저 등)이 각자 원격 Sidecar URL/토큰 입력 UI나 독자 원격 서버·전송 계층을 만들 필요 없이 Native Host 프레임워크가 일원화해 관리합니다.
- **인증형 메인 프로세스 원격 브리지 서버 (`src/runtime/main/remote-bridge-server.js`)**:
  - 기본 비활성(`enabled: false`)이며 데스크톱 **설정 -> 애드온 관리**에서 명시적으로 켜고 설정합니다.
  - 설정과 CSPRNG 256비트 Bearer 토큰을 `remote-bridge.json`에 원자적(`0o600`, 심볼릭 링크 거부, 플러그인 `settingsBridge`/`configBridge` 예약 파일 차단)으로 저장합니다.
  - 모든 라우트에 상수 시간(`crypto.timingSafeEqual`) Bearer 인증, 엄격한 정확 일치 `Origin` CORS 허용 목록(`*` 금지), 512 KiB 본문 상한, 그리고 `/v1/settings/*`·`/v1/config/*`·`/v1/net/fetch` 매 요청마다 실시간 매니페스트 및 SHA-256 신뢰 검증을 강제합니다.
  - 데스크톱 애드온 관리 화면에서 1클릭 복사할 수 있는 한 줄 페어링 코드(`ag-bridge-v1:...`)를 생성합니다.
- **데스크톱 애드온 관리 UI (`host-settings-ui.js`)**:
  - 내장 **원격 호스트 브리지** 관리 카드(활성 스위치, 포트, 바인드 주소, 선택적 공개 HTTPS URL, 페어링 코드 1클릭 복사, 토큰 재발급, 실시간 실행 상태)를 추가했습니다.
  - 내장 **원클릭 `지금 원격 번들 빌드`** 버튼을 추가해 `execFile`(`shell: false`)로 호스트 CLI를 직접 실행합니다.
- **원격 웹 호스트 드로어 (`remote-bootstrap.js` + `remote-host-transport.js`)**:
  - 전용 **Host Bridge** 탭(인덱스 3, 기존 탭 순서 보존)에서 페어링 코드를 한 번만 붙여 넣으면 연결됩니다.
  - 연결된 동안 모든 플러그인의 `ctx.settingsBridge`, `ctx.configBridge`, `ctx.net.fetch`(신뢰 `localLoopback` 사이드카 포함)를 투명하게 라우팅하고 설정 스냅샷 재동기화 및 `host:remote-bridge-changed` 이벤트를 브로드캐스트합니다.
- **SDK 테스트 호스트 패리티 (`@antigravity-addons/sdk v3.1.0`)**:
  - `createTestHost`에 선택적 `remoteBridgeConnected` 옵션과 `env.capabilities.hasRemoteHostBridge` 타입을 추가했습니다.

### 2. 매니페스트 정규화 결함 수정 (`userApprovedHttps: true`)
- `src/core/manifest-normalizer.js` (`normalizePermissionsV3`)에서 v3 매니페스트 정규화 시 `permissions.net.userApprovedHttps: true`가 누락되던 문제를 수정해 원격 웹 사용자 승인 HTTPS 호스트 기능이 정상 동작하도록 복구했습니다.
