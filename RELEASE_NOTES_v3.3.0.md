# Extenra v3.3.0 Release Notes

## English

### Highlights
- **OS-Encrypted Secrets API (`ctx.secrets`)**:
  - Adds a first-class, per-plugin isolated secrets vault (`permissions.secrets` in `AddonManifest.v3`, `trusted` plugins only).
  - On Desktop, secrets are encrypted at rest with Electron `safeStorage` (Windows DPAPI / macOS Keychain / Linux Secret Service) inside host-reserved `secrets-vault.json` (`0o600`, symlink-rejected, atomic write). Fails closed (`ERR_SECRETS_ENCRYPTION_UNAVAILABLE`) if OS encryption is unavailable — never silently writes plaintext.
  - **Host-Side Header Injection (`ctx.net.fetch(..., { secretHeaders })`)**:
    - Main-process `netFetchBroker` injects encrypted secrets into outbound HTTP headers (e.g. `Authorization: Bearer <key>`, `x-api-key`, `x-goog-api-key`) **only after** the target URL passes `httpsHosts` / `userApprovedHttps` allowlist validation.
    - Plaintext secrets stay out of renderer World 998 unless a trusted plugin explicitly opts in via `permissions.secrets.allowRead: true` (`ctx.secrets.get` is omitted otherwise).
    - Cross-host redirects automatically strip `Authorization`, API-key headers (`x-api-key`, `x-goog-api-key`, `api-key`, etc.), and every header injected via `secretHeaders`.
- **Remote Web Parity (Remote Bridge + Ephemeral Session Memory)**:
  - When Remote Web is paired with the Desktop Remote Bridge, `ctx.secrets` and `net.fetch({ secretHeaders })` delegate directly to the Desktop encrypted vault so plaintext keys never touch browser storage.
  - When standalone (unpaired), secrets stay strictly in ephemeral in-memory session storage (wiped on `dispose()` / tab close) and are never persisted to `localStorage` or `GM_*`.
- **Tier-2 `segmented` Primitive & Button Variant Patch Fix**:
  - Adds the 17th Tier-2 Declarative UI primitive (`type: 'segmented'`) with pill-toggle styling matching the host language switch, `role="group"`, `aria-pressed`, disabled state handling, and `ev.isTrusted !== false` gating.
  - Fixes `ui-schema-renderer.js` `case 'button'` in-place patching so removing `node.variant` clears `data-variant` cleanly.
- **Central Host Global i18n (`ctx.i18n.onDidChange`)**:
  - Promotes `addon-host:settings-ui-lang` to the central host locale store in `theme-i18n.js` with cross-tab `storage` sync.
  - Exposes `ctx.i18n.onDidChange(cb)` (auto-disposed with plugin lifecycle) driven by both Desktop Addon Manager and a new Remote Web drawer `[ 한국어 | EN ]` switcher.
- **Tier-1 Declarative Section Actions (`ctx.ui.registerSectionAction`)**:
  - Adds zero-DOM `ctx.ui.registerSectionAction(spec)` (respecting `permissions.ui.sectionActions`, default `true`) backed by declarative `HostProfile.uiSectionTargets`.
  - Ships Antigravity Desktop & Remote Web profile target `'customizations.mcp-servers.header'` (`MCP Servers` / `MCP 서버` header action bar) with SPA re-render re-attachment and lazy single-observer cleanup.
- **SDK & Verification**:
  - Updated `@extenra/sdk` TypeScript definitions (`AddonContextV3.secrets`, `NetSecretHeaderSpec`, `SecretsPersistenceMode`, `'segmented'`, `ctx.i18n.onDidChange`, `ctx.ui.registerSectionAction`, `SectionActionSpec`) and `createTestHost()` with full `ctx.secrets`, `setLocale()`, and `getSectionActions()` / `invokeSectionAction()` Desktop/Remote parity.

---

## 한국어

### 주요 변경 사항
- **OS 암호화 시크릿 저장 API (`ctx.secrets`) 추가**:
  - `AddonManifest.v3`의 `permissions.secrets`(`trusted` 플러그인 전용)를 통해 플러그인별 격리된 시크릿 저장소 API를 공식 제공합니다.
  - Desktop에서는 Electron `safeStorage`(Windows DPAPI / macOS Keychain / Linux Secret Service)로 암호화하여 호스트 예약 파일 `secrets-vault.json`(`0o600`, 심볼릭 링크 차단, 원자적 쓰기)에 보관합니다. OS 암호화를 사용할 수 없을 때는 평문 저장으로 폴백하지 않고 안전 차단(`ERR_SECRETS_ENCRYPTION_UNAVAILABLE`)합니다.
  - **메인 프로세스 `net.fetch` 헤더 주입 (`secretHeaders`) 우선 모델**:
    - `ctx.net.fetch(url, { secretHeaders })` 호출 시 대상 URL이 `httpsHosts` / `userApprovedHttps` 허용 목록을 통과한 뒤에만 메인 프로세스에서 시크릿을 복호화하여 헤더(`Authorization`, `x-api-key`, `x-goog-api-key` 등)를 주입합니다.
    - 매니페스트에서 `permissions.secrets.allowRead: true`를 명시하지 않으면 `ctx.secrets.get()`이 아예 노출되지 않아 평문 키가 렌더러 World 998에 남지 않습니다.
    - 교차 호스트 리다이렉트 시 `Authorization`뿐 아니라 API 키 헤더(`x-api-key`, `x-goog-api-key` 등)와 `secretHeaders`로 주입된 모든 헤더를 자동 제거합니다.
- **Remote Web 지원 (Remote Bridge 우선 + 미연결 시 세션 메모리 전용)**:
  - Remote Web이 Desktop Remote Bridge에 연결되어 있으면 Desktop 암호화 금고 및 서버 측 헤더 주입을 그대로 사용합니다.
  - 미연결 단독 실행 시에는 브라우저 `localStorage`나 `GM_*`에 평문 키를 절대 저장하지 않고, 탭 종료/`dispose()` 시 자동 삭제되는 세션 메모리 전용으로 안전 동작합니다.
- **Tier-2 `segmented` 프리미티브 추가 및 `button` variant 패치 결함 수정**:
  - 호스트 언어 스위치와 동일한 필 토글 스타일의 17번째 선언형 UI 프리미티브(`type: 'segmented'`)를 추가했습니다(`role="group"`, `aria-pressed`, `disabled`/`disabledWhen`, `ev.isTrusted !== false` 지원).
  - `ui-schema-renderer.js`의 `button` 패치 시 `node.variant`가 제거되면 `data-variant` 속성도 함께 제거되도록 수정했습니다.
- **호스트 중앙 전역 언어(i18n) 및 `ctx.i18n.onDidChange` 구독 지원**:
  - `addon-host:settings-ui-lang`을 호스트 중앙 언어 저장소로 승격하고, Desktop `애드온 관리` 및 Remote Web 드로어 헤더의 `[ 한국어 | EN ]` 스위처와 실시간 동기화합니다.
  - 모든 v3 플러그인이 `ctx.i18n.onDidChange(cb)`로 전역 언어 변경을 구독하고 `dispose()` 시 자동 해제할 수 있습니다.
- **Tier-1 선언형 섹션 액션(`ctx.ui.registerSectionAction`) 추가**:
  - 호스트 프로필의 `uiSectionTargets` 선언에 따라 Zero-DOM으로 호스트 섹션 헤더에 액션 버튼을 등록할 수 있는 `ctx.ui.registerSectionAction(spec)` API를 추가했습니다(`permissions.ui.sectionActions`, 기본 `true`).
  - Antigravity Desktop 및 Remote Web 프로필에 `'customizations.mcp-servers.header'`(`MCP Servers` / `MCP 서버` 헤더 액션 바) 타깃을 기본 포함하고, SPA 재렌더 자동 재부착 및 미사용 시 옵저버 자동 해제를 지원합니다.
- **SDK 및 검증 강화**:
  - `@extenra/sdk` 타입 정의 및 `createTestHost()`에 `ctx.secrets`, `secretHeaders`, `segmented`, `setLocale()`, `getSectionActions()` / `invokeSectionAction()` Desktop/Remote 패리티 지원을 추가했습니다.
