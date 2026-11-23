# antigravity-native-addon-host v2.2.0 Release Notes

> **Language**: English | [한국어](#한국어-릴리스-노트)

## English Release Notes

### Overview
`v2.2.0` is an additive, zero-`app.asar`-repatch release over `v2.1.0` that introduces **trusted `settingsBridge.saveSettings()` persistence**, fixes **top-layer `<dialog>` modal centering under app CSS resets**, and bundles all **multi-window reliability and World `998` primordial hardening** improvements.

### What's New
- **Trusted `settingsBridge.saveSettings()` IPC (`AddonManifest.v2`)**:
  - Trusted (`trustLevel: "trusted"` + SHA-256 `trust-policy.json` pinned) renderer plugins declaring `settingsBridge` can now persist validated JSON settings via `addonHost.saveSettings(nextData)`.
  - Main process enforces `verifyClaimedEvent`, `(wcId, pluginId)` trusted binding (`getTrustedSettingsBinding`), `HOST_DATA_DIR` path confinement, reserved-file and symlink rejection, `parseSafeJson` prototype-pollution blocking, `maxBytes` caps, atomic temp+rename writes with Windows `EBUSY`/`EPERM`/`EACCES` retries, and immediate multi-window snapshot broadcasts.
  - Restricted plugins receive `ERR_SETTINGS_BRIDGE_NOT_DECLARED` and never gain write access.
- **Centered Top-Layer Modal Portal (`modal-portal.js`)**:
  - Replaces inline `marginTop` with `position: fixed; inset: 0; top: max(env(titlebar-area-height, 36px), 36px); margin: auto; width: fit-content; height: fit-content;` so plugin `<dialog>` modals center horizontally and vertically below the titlebar safe area even under Tailwind Preflight (`* { margin: 0 }`).
- **Multi-Window Reliability, Lock Recovery & World `998` Primordial Hardening (`I1`, `I2`, `I4`, `I10`)**:
  - Propagates file updates detected during joining-window `readSnapshotForPlugin` to existing windows with per-`wcId` delivery deduplication.
  - Adds bounded Windows file-lock retry (`80ms → 160ms → 320ms`) and `fs.watch` exponential reconnect (`500ms → 5000ms`).
  - Captures all critical JS primordials in `kernel.js` before plugin execution and enforces `trustLevel` isolation on `listActions()` / `invokeAction()`.
  - Runs `onDispose` callbacks before marking handles disposed, re-aggregates `lifecycleStates` on window close, switches `before-quit` to `will-quit`, and preserves `[attr]` owner-prefixed CSS selectors.

### Upgrade Notes
- Upgrading from `v2.0.0` or `v2.1.0` requires **zero `app.asar` re-patching** (`addon-host --upgrade` only updates the staged runtime in `~/.gemini/antigravity/runtime/<buildSha8>`).
- Restart Antigravity Desktop after upgrading so Electron main/preload loads the new staged runtime.

---

## 한국어 릴리스 노트

### 개요
`v2.2.0`은 `v2.1.0` 대비 `app.asar` 재패치 없이 하위 호환으로 확장되는 마이너 릴리스로, **신뢰 플러그인 전용 `settingsBridge.saveSettings()` 원자적 저장 IPC**, **앱 CSS 리셋 환경에서의 `<dialog>` 모달 중앙 정렬 수정**, 그리고 **다중 창 안정성 및 World `998` 원시 객체 보안 경화**를 포함합니다.

### 주요 변경 사항
- **신뢰 `settingsBridge.saveSettings()` 양방향 영구 저장 IPC (`AddonManifest.v2`)**:
  - `trustLevel: "trusted"` 및 `trust-policy.json` SHA-256 승인을 받은 렌더러 플러그인이 World `998`에서 `addonHost.saveSettings(nextData)`로 설정 JSON을 영구 저장할 수 있습니다.
  - 메인 프로세스에서 `verifyClaimedEvent`, `(wcId, pluginId)` 신뢰 바인딩(`getTrustedSettingsBinding`), `HOST_DATA_DIR` 경로 격리, 예약 파일·심볼릭 링크 차단, `parseSafeJson` 프로토타입 오염 차단, `maxBytes` 상한, Windows `EBUSY`/`EPERM`/`EACCES` 락 재시도 원자적 쓰기, 그리고 모든 열린 창으로의 즉시 브로드캐스트를 강제합니다.
  - `restricted` 플러그인은 쓰기 권한이 차단됩니다(`ERR_SETTINGS_BRIDGE_NOT_DECLARED`).
- **Top-Layer 모달 포털 중앙 정렬 수정 (`modal-portal.js`)**:
  - 인라인 `marginTop` 대신 `position: fixed; inset: 0; top: max(env(titlebar-area-height, 36px), 36px); margin: auto; width: fit-content; height: fit-content;`를 적용해 Tailwind Preflight(`* { margin: 0 }`) 환경에서도 모든 플러그인 모달이 타이틀바 아래 정중앙에 표시됩니다.
- **다중 창 안정성·락 복구·World `998` 원시 객체 보안 경화 (`I1`, `I2`, `I4`, `I10`)**:
  - 신규 창 진입 시 감지된 설정 변경을 기존 활성 창에도 즉시 전파하고 창별 중복 푸시를 제거했습니다.
  - Windows 일시 파일 잠금 재시도(`80ms → 160ms → 320ms`) 및 `fs.watch` 지수 백오프 자동 재연결(`500ms → 5000ms`)을 추가했습니다.
  - `kernel.js` 로드 시 핵심 JS 원시 객체를 사전 캡처하고 `listActions()`/`invokeAction()`에 `trustLevel` 경계를 적용했습니다.
  - `onDispose` 선실행 후 폐기 마킹, 창 종료 시 `lifecycleStates` 재집계, `will-quit` 전환, `[attr]` 소유자 셀렉터 보존을 반영했습니다.

### 업그레이드 안내
- `v2.0.0` / `v2.1.0`에서 업그레이드 시 **`app.asar` 재패치는 발생하지 않습니다**(`addon-host --upgrade`가 `~/.gemini/antigravity/runtime/<buildSha8>` 스테이징 런타임만 갱신합니다).
- 업그레이드 후 Antigravity Desktop을 완전히 종료하고 재시작하면 새 런타임이 적용됩니다.
