# Release Notes — `v3.0.2`

## English

### v3.0.2 Desktop Floating Pill Suppression, Remote Web Bottom-Right Placement & Accurate Theme Detection
- **Suppress Uninvited Floating Fallback Statusbar on Desktop (`surface === 'desktop'`)**:
  - `src/runtime/renderer/kernel.js` now passes `surface: hostSurface` into `createStatusItemRegistry`.
  - `src/runtime/renderer/status-item-registry.js` suppresses mounting `.ag-fallback-bar` (`[data-addon-host-fallback-statusbar]`) on Desktop when no `host.statusbar` v3 service is installed, so native Desktop windows are never cluttered with a stray floating pill (plugin settings belong in Desktop Settings; registered status items still work programmatically and auto-delegate whenever a `host.statusbar` provider registers).
- **Anchor Remote Web Fallback Statusbar to Bottom-Right (`surface === 'remote-web'`)**:
  - Moves `.ag-fallback-bar` from bottom-left (`left: 12px; bottom: 12px`) to bottom-right (`right: max(12px, env(safe-area-inset-right, 0px)); bottom: max(64px, calc(64px + env(safe-area-inset-bottom, 0px)));`) cleanly above the Remote Web `Addons` drawer pill, with dynamic theme CSS synchronization.
- **Page Background Luminance Detection in `theme-i18n.js`**:
  - `createThemeAndI18n().detectMode()` now inspects actual computed opaque background luminance on `document.body` / `document.documentElement` before falling back to `prefers-color-scheme: light`, preventing dark-mode host apps running on a Light-mode OS from rendering bright-white `--ag-surface` overlays, toasts, dialogs, or Remote Web pills.

---

## 한국어

### v3.0.2 데스크톱 플로팅 알약 제거 · Remote Web 우측 하단 배치 · 실제 배경 기반 테마 감지
- **데스크톱 네이티브 앱(`surface === 'desktop'`) 플로팅 폴백 상태바 미표시**:
  - `src/runtime/renderer/kernel.js`가 `createStatusItemRegistry`에 `surface: hostSurface`를 전달하도록 수정했습니다.
  - `host.statusbar` v3 서비스가 없는 데스크톱 네이티브 앱에서 `status-item-registry.js`가 임의의 플로팅 `.ag-fallback-bar` DOM 알약을 화면에 띄우지 않습니다(설정은 데스크톱 Settings에 표시되며, 등록된 상태 항목의 API 조회·호출 및 추후 `host.statusbar` 자동 위임은 그대로 유지됩니다).
- **Remote Web(`surface === 'remote-web'`) 폴백 상태바 우측 하단 배치**:
  - `.ag-fallback-bar` 위치를 기존 좌측 하단(`left: 12px; bottom: 12px`)에서 Remote Web `Addons` 드로어 알약 바로 위 **우측 하단**(`right: max(12px, env(safe-area-inset-right, 0px)); bottom: max(64px, calc(64px + env(safe-area-inset-bottom, 0px)));`)으로 옮기고 테마 변경 시 스타일을 동기화합니다.
- **`theme-i18n.js` 실제 페이지 배경 밝기 기반 다크/라이트 감지**:
  - `detectMode()`가 OS `prefers-color-scheme: light`로 폴백하기 전에 `document.body` / `document.documentElement`의 실제 불투명 `backgroundColor` 휘도를 먼저 판별하도록 수정하여, Windows 라이트 모드 위에서 실행 중인 다크 테마 앱이 흰색 알약·토스트·모달로 튀어나오는 결함을 근본적으로 차단했습니다.
