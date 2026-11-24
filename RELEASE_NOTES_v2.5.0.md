# Release Notes — `v2.5.0` (EN / KO)

## English

### Highlights
- **Built-in Settings `Addon Manager` (`애드온 관리`) UI**:
  - Ships a host-owned, vendor-neutral Shadow DOM Settings panel (`src/runtime/renderer/host-settings-ui.js`) driven by declarative `HostProfile.settingsUi` descriptors — keeping the host's plugin catalog clean while coexisting seamlessly with native Settings tabs and peer plugin tabs (such as `MCP Manager`).
  - Displays live Desktop addon execution state (`Running`, `Disabled`, `Blocked`, `Failed`, `Pending`), trust approval status, declared capabilities (`Renderer`, `Main Hook`, `Settings`, `Config`), and Remote Web bundle synchronization status (`Up to date`, `Rebuild needed`, `Not built yet`) with one-click copy buttons for `addon-host --build-remote` and the generated Bookmarklet.
- **Per-Addon Remote Web Visibility Controls (`remote-preferences.json`)**:
  - Adds `src/runtime/main/host-admin-service.js` and claimed IPC channels (`addon-host:v2:host-admin-state`, `addon-host:v2:host-admin-set-remote-pref`) accessible exclusively to the host kernel and **never** exposed on consumer `addonHost` plugin handles.
  - Persists user `Show on Remote Web` (`원격 웹 표시`) toggles atomically in `HOST_DATA_DIR/remote-preferences.json` with symlink rejection, prototype-pollution guards, size limits, and zero writes under `~/.gemini/config/plugins/`.
  - Updates `src/adapters/remote-web/addon-collector.js` and `scripts/build-remote.js` (`--remote-prefs`) to exclude disabled addons (`DISABLED_BY_REMOTE_PREFERENCES`) when building Remote Web Userscript & Bookmarklet bundles while preserving explicit `remotePrefsPath: null` opt-out.
- **Host Loader Profile Forwarding**:
  - Updates `src/adapters/electron/host-loader-builder.js` to forward `uiSurfaces`, `settingsUi`, `remoteProfileId`, `remoteSupportedCapabilities`, `remotePrefsPath`, and `remoteDistDir` on `addon-host --upgrade` with **zero `app.asar` re-patching** (`PATCH_MARKER = ADDON_HOST_LOADER_V2`).

### Upgrade Notes
- Existing `v2.0.0`–`v2.4.0` installations upgrade cleanly with `addon-host --upgrade` (zero `app.asar` writes).
- After toggling addons in Settings → **Addon Manager**, run `addon-host --build-remote` to refresh your Remote Web Userscript & Bookmarklet bundle.

---

## 한국어

### 주요 변경 사항
- **설정 화면 내장 `애드온 관리(Addon Manager)` UI**:
  - 별도 플러그인을 추가하지 않고 호스트 렌더러 커널에 직접 내장된 벤더 중립 Shadow DOM 설정 패널(`src/runtime/renderer/host-settings-ui.js`, 프로필 선언형 `HostProfile.settingsUi`)을 제공합니다. 기본 설정 탭 및 동료 플러그인 탭(`MCP Manager` 등)과 자연스럽게 공존합니다.
  - 네이티브 애드온 호스트에서 실행 중인 플러그인의 데스크톱 실행 상태(`실행 중`, `비활성`, `차단됨`, `오류`, `대기 중`), 신뢰 승인 상태, 선언 기능(`렌더러 UI`, `메인 훅`, `설정 브리지`, `구성 브리지`), 원격 웹 번들 동기화 상태(`최신 상태`, `재빌드 필요`, `미빌드`)와 빌드 명령·북마클릿 원클릭 복사 기능을 제공합니다.
- **애드온별 원격 웹 표시 토글 및 영구 저장 (`remote-preferences.json`)**:
  - 호스트 전용 메인 서비스(`src/runtime/main/host-admin-service.js`)와 인증된 IPC 채널(`addon-host:v2:host-admin-state`, `addon-host:v2:host-admin-set-remote-pref`)을 추가했으며, 소비자 플러그인 `addonHost` 핸들에서는 접근할 수 없도록 권한 경계를 엄격히 분리했습니다.
  - 사용자가 변경한 `원격 웹 표시` 토글은 심볼릭 링크 거부·프로토타입 오염 차단·크기 제한 검증을 거쳐 `HOST_DATA_DIR/remote-preferences.json`에 원자적으로 저장됩니다(`~/.gemini/config/plugins/` 무쓰기 원칙 유지).
  - `src/adapters/remote-web/addon-collector.js`와 `scripts/build-remote.js`(`--remote-prefs`)가 해당 설정을 읽어 꺼진 애드온을 `DISABLED_BY_REMOTE_PREFERENCES` 사유로 원격 번들에서 제외합니다(프로그래매틱 `remotePrefsPath: null` 전달 시 기본 전체 수집 보존).
- **호스트 로더 프로필 전달 보강**:
  - `src/adapters/electron/host-loader-builder.js`가 `uiSurfaces`, `settingsUi`, `remoteProfileId`, `remoteSupportedCapabilities`, `remotePrefsPath`, `remoteDistDir`를 로더 설정으로 전달하며, `addon-host --upgrade` 시 `app.asar` 재패치는 0바이트입니다(`PATCH_MARKER = ADDON_HOST_LOADER_V2`).

### 업그레이드 안내
- 기존 `v2.0.0`–`v2.4.0` 설치 환경은 `addon-host --upgrade`만으로 `app.asar` 재패치 없이 업그레이드됩니다.
- 설정 → **애드온 관리**에서 원격 웹 표시 여부를 변경한 뒤 `addon-host --build-remote`를 실행하면 원격 웹 Userscript와 북마클릿에 즉시 반영됩니다.
