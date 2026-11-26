# Release Notes — `v3.0.3`

## English

### v3.0.3 True Desktop Inline Settings Pane Rendering for `ui.registerSettingsPage`
- **Desktop Inline Settings Host (`settings-page-coordinator.js` + `host-settings-ui.js` + `kernel.js`)**:
  - `createSettingsPageCoordinator()` now accepts an inline Settings host via `setInlineHost({ canMountInline, mountInlinePage })`, and `createHostSettingsUi()` registers itself automatically as the Desktop Settings right-pane host.
  - Clicking any v3 plugin settings page in the Desktop Settings left sidebar (`한국어 번역 설정`, `MCP Manager`, etc.) or its `Addon Manager` card `Settings` button now renders **directly inline inside the Settings right content pane** (with Shadow DOM isolation, live `--ag-*` tokens, native-matched sidebar active highlight, and non-removable host attribution) instead of opening a floating modal dialog on top of another native Settings tab.
  - Supports **both** Tier-2 declarative `schema`/`getSchema` pages (including live `pageHandle.update()` in-place patching) and Tier-3 `render(canvasRoot, handle)` canvas pages seamlessly with zero plugin changes required.
  - Cleanly switches between native Settings tabs, `Addon Manager`, and multiple plugin settings pages—invoking `onClose()` and restoring native sidebar/content state on every switch or disposal—while preserving automatic modal fallback whenever the Desktop Settings pane is not open (e.g., Command Palette or Remote Web Drawer).

---

## 한국어

### v3.0.3 데스크톱 Settings 우측 본문 인라인 플러그인 설정 렌더링 (`ui.registerSettingsPage`)
- **데스크톱 Settings 인라인 호스트 전환 (`settings-page-coordinator.js` · `host-settings-ui.js` · `kernel.js`)**:
  - `createSettingsPageCoordinator()`에 `setInlineHost()` 계약을 추가하고 `createHostSettingsUi()`가 데스크톱 Settings 우측 본문 호스트로 자동 등록되도록 개편했습니다.
  - 이제 데스크톱 Settings 좌측 사이드바(`한국어 번역 설정`, `MCP Manager` 등)나 `Addon Manager` 카드의 `설정` 버튼을 누르면, 기존 `권한` 등 다른 설정 화면 위에 팝업 모달이 뜨는 대신 **`애드온 관리` 및 네이티브 설정 탭과 똑같이 오른쪽 Settings 본문 영역에 인라인으로 꽉 차게 렌더링**됩니다(사이드바 활성 표시 + Shadow DOM 격리 + `--ag-*` 테마 토큰 + 호스트 귀속 배지 유지).
  - 플러그인 코드를 수정하지 않고도 Tier-2 선언형 `schema`/`getSchema`(실시간 `update()` 인플레이스 패치 포함)와 Tier-3 `render(canvasRoot, handle)` 캔버스 페이지 모두 동일하게 인라인 렌더링됩니다.
  - 네이티브 설정 탭 ↔ `애드온 관리` ↔ 여러 플러그인 설정 페이지 간 전환 및 해제 시 이전 페이지의 `onClose()` 정리와 네이티브 본문 복원이 깔끔하게 동작하며, Settings 창이 열려 있지 않은 진입점(커맨드 팔레트·원격 웹 드로어)에서는 기존 모달/드로어 폴백을 그대로 유지합니다.
