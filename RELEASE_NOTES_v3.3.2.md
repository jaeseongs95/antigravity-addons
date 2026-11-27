# Extenra v3.3.2

## English

### Features & Improvements
- **Unified Settings Page Header Locale Switch (`[한국어 | EN]`)**:
  - Desktop inline plugin Settings Pages (`.ag-inline-header`) and Modal / Remote Web Settings Pages (`.ag-ui-header`) now automatically render a host-owned `[ 한국어 | EN ]` segmented locale switch on the right side of the header, matching Addon Manager's header placement and styling.
  - Clicking the header switch persists the global host locale (`addon-host:settings-ui-lang`) and immediately synchronizes Addon Manager, sidebar nav labels, and all plugins subscribed via `ctx.i18n.onDidChange`.
  - Opt-out per page with `showLocaleSwitch: false` in `SettingsPageSpec`, and opt-in for custom modals/panels via `showLocaleSwitch: true` in `OverlayOptions`.
- **Dynamic Settings Page Titles (`getTitle` / `handle.setTitle`)**:
  - `SettingsPageSpec.getTitle?: () => string` dynamically updates the inline/modal header title and Desktop Settings sidebar tab label whenever the host locale changes.
  - `OverlayHandle.setTitle?(title: string)` allows imperative title updates on open overlays and inline Settings Pages.
- **Security & Parity**:
  - Header locale clicks enforce `ev.isTrusted !== false` and dispose subscriptions cleanly on close.
  - `ctx.i18n.setLocale` remains intentionally host-owned (not exposed to plugins) to prevent silent global-locale hijacking.
  - Desktop thin shim (`addon-host-loader.js`) unchanged and strictly `< 4096 B`.

---

## 한국어

### 기능 개선
- **플러그인 설정 페이지 상단 헤더 공용 언어 전환 토글(`[ 한국어 | EN ]`)**:
  - Desktop 인라인 플러그인 설정 헤더(`.ag-inline-header`) 및 모달·Remote Web 설정 헤더(`.ag-ui-header`) 우측에 Addon Manager와 동일한 스타일·위치의 호스트 공용 `[ 한국어 | EN ]` 토글을 기본 제공합니다.
  - 헤더 토글 클릭 시 호스트 전역 로케일(`addon-host:settings-ui-lang`)이 저장되며 Addon Manager, 사이드바 탭 라벨, `ctx.i18n.onDidChange`를 구독한 모든 플러그인에 실시간 동기화됩니다.
  - 설정 페이지에서 숨기려면 `SettingsPageSpec.showLocaleSwitch: false`를 지정할 수 있으며, 일반 모달/패널에서도 `OverlayOptions.showLocaleSwitch: true`로 동일한 호스트 토글을 켤 수 있습니다.
- **동적 설정 페이지 제목 동기화 (`getTitle` / `handle.setTitle`)**:
  - `SettingsPageSpec.getTitle?: () => string`을 제공하면 언어 전환 시 인라인·모달 헤더 제목과 Desktop 설정 사이드바 탭 이름이 자동으로 갱신됩니다.
  - `OverlayHandle.setTitle?(title: string)`으로 열린 설정 화면의 제목을 동적으로 갱신할 수 있습니다.
- **보안 및 일관성**:
  - 헤더 언어 전환은 `ev.isTrusted !== false`를 검증하며, 닫힘 시 리스너를 자동 해제합니다.
  - 플러그인이 전역 호스트 언어를 임의로 덮어쓰지 못하도록 `ctx.i18n.setLocale`은 플러그인에 노출하지 않고 호스트 헤더 토글을 통해 단일 진실 원천으로 관리합니다.
