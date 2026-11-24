# Release Notes — `antigravity-native-addon-host` v2.4.0

> **Languages**: English | 한국어 (below)

---

## English

### Overview

`antigravity-native-addon-host` **v2.4.0** introduces a vendor-neutral **Per-Surface Content Bounds & Center-Point API** (`addonHost.getSurfaceBounds`, `addonHost.getActiveSurface`, `addonHost.listSurfaces`, and `openModal(slotId, { surface, align })` with automatic resize re-centering and `reposition()`), fixes the **Remote Web `--build-remote` default CLI path regression** where omitted `--trust-policy` / `--config-json` flags suppressed profile path fallback, and completes low-risk security hardening (**F7** `extraNoTranslateAttributes` filtering on Remote Web boot).

All changes are 100% backward-compatible with `v2.0.0`–`v2.3.0` plugins, require **zero `app.asar` re-patching** (`PATCH_MARKER = ADDON_HOST_LOADER_V2` unchanged), and add **zero new npm dependencies**.

### Key Changes

1. **Per-Surface Content Bounds & Center-Point API (SOLID #0)**
   - Added a vendor-neutral `src/runtime/renderer/surface-geometry.js` module bundled into both Desktop World `998` (`dist/runtime/renderer/kernel-bundle.cjs`) and Remote Web (`dist/remote/`) runtimes.
   - Declared declarative `uiSurfaces` descriptors exclusively in `src/profiles/antigravity.js` and `src/profiles/antigravity-remote-web.js` (`settings-pane`, `customizations-page`, `automation-page`, `workspace`) with priority ordering, direct container selectors, edge-chrome subtraction fallbacks, and safe insets (`36px` titleBarOverlay top inset on Desktop, `0px` on Remote Web), validated by `src/core/host-profile-port.js`.
   - Exposed read-only geometry helpers on every `addonHost` handle (`restricted` and `trusted`):
     - `addonHost.getSurfaceBounds(surfaceIdOrOpts?)` → deep-frozen `{ surfaceId, requestedSurfaceId, matched, source, left, top, right, bottom, width, height, centerX, centerY, insetLeft, insetTop, insetRight, insetBottom, viewport }`.
     - `addonHost.getActiveSurface()` → highest-priority active surface bounds (`'auto'`).
     - `addonHost.listSurfaces()` → frozen array of configured surface IDs plus `'viewport'`.
   - Extended `addonHost.openModal(slotId, opts)` with optional `{ surface?: string, align?: 'surface' | 'viewport' }` positioning and `modalHandle.reposition(nextSurface?)`:
     - Aligns `<dialog>` strictly inside the target surface rectangle via fixed insets + `margin: auto`, tracks window `resize` while open, and detaches the listener deterministically on close.
     - Omitting `surface`/`align` preserves exact legacy full-viewport centering.

2. **Fix: `--build-remote` Default CLI Path Resolution (`scripts/build-remote.js`)**
   - Changed omitted `configJsonPath`, `trustPolicyPath`, `addonsDir`, `pluginsRootDir`, and `settingsDataDir` defaults in `parseCliArgs()` and `buildDistRemote()` from `null` to `undefined` so default `addon-host --build-remote` invocations fall back to `resolvedPaths.TRUST_POLICY_PATH` and `resolvedPaths.CONFIG_JSON_PATH` instead of rejecting all trusted plugins with `ERR_TRUST_POLICY_NOT_APPROVED`.
   - Programmatic callers passing explicit `null` continue to disable those files as intended.

3. **Security Hardening (F7)**
   - Filtered `profile.extraNoTranslateAttributes` through `isSafeExtraAttrName()` in `src/adapters/remote-web/remote-bootstrap.js` before forwarding to `activeKernel.boot(...)` and `mountFallbackSlotDock(...)`.

### Upgrade & Compatibility

- **Desktop Electron**: Run `addon-host --upgrade` (updates staged runtime only; `app.asar` untouched).
- **Remote Web**: Run `addon-host --build-remote` and reinstall the generated Userscript or Bookmarklet from `dist/remote/`.

---

## 한국어

### 개요

`antigravity-native-addon-host` **v2.4.0**은 벤더 중립 **화면(Surface)별 콘텐츠 영역·중앙 좌표 API** (`addonHost.getSurfaceBounds`, `addonHost.getActiveSurface`, `addonHost.listSurfaces`, `openModal(slotId, { surface, align })` 및 `reposition()`)를 추가하고, 기본 CLI 실행(`addon-host --build-remote`)에서 `--trust-policy`·`--config-json` 생략 시 기본 프로필 경로 폴백이 차단되던 결함을 수정했으며, Remote Web 부트 경로의 **F7(`extraNoTranslateAttributes` 사전 필터링)** 보안 보강을 반영했습니다.

기존 `v2.0.0`~`v2.3.0` 플러그인과 100% 하위 호환되며, `app.asar` 재패치 0바이트(`PATCH_MARKER = ADDON_HOST_LOADER_V2` 유지) 및 신규 npm 의존성 0건을 유지합니다.

### 주요 변경 사항

1. **화면(Surface)별 콘텐츠 영역·중앙 좌표 API (SOLID #0)**
   - 벤더 중립 `src/runtime/renderer/surface-geometry.js` 모듈을 추가하고 Desktop World `998`(`dist/runtime/renderer/kernel-bundle.cjs`) 및 Remote Web(`dist/remote/`) 번들에 통합했습니다.
   - Antigravity 전용 화면 셀렉터·우선순위·사이드바/상태바 제외 규칙·안전 여백은 `src/profiles/antigravity.js` 및 `src/profiles/antigravity-remote-web.js`의 선언형 `uiSurfaces`(`settings-pane`, `customizations-page`, `automation-page`, `workspace`)에만 격리 정의되며 `src/core/host-profile-port.js`가 계약을 검증합니다.
   - 모든 `addonHost` 핸들(`restricted`·`trusted` 공통)에 읽기 전용 지오메트리 API를 노출합니다:
     - `addonHost.getSurfaceBounds(surfaceIdOrOpts?)` → deep-frozen `{ surfaceId, requestedSurfaceId, matched, source, left, top, right, bottom, width, height, centerX, centerY, insetLeft, insetTop, insetRight, insetBottom, viewport }`.
     - `addonHost.getActiveSurface()` → 현재 활성화된 최상위 우선순위 화면 영역 반환.
     - `addonHost.listSurfaces()` → 등록된 화면 ID 목록(`'viewport'` 포함) 반환.
   - `addonHost.openModal(slotId, opts)`에 `{ surface?: string, align?: 'surface' | 'viewport' }` 정렬 옵션과 `modalHandle.reposition(nextSurface?)` 메서드를 추가했습니다:
     - 대상 화면 영역의 고정 inset과 `margin: auto`로 `<dialog>`를 해당 화면 정중앙에 배치하며, 모달이 열린 동안 창 크기 변경(`resize`)을 자동 추적하고 닫힘 시 리스너를 정리합니다.
     - `surface`/`align`을 생략한 기존 호출은 기존 전체 뷰포트 중앙 정렬 동작을 그대로 유지합니다.

2. **결함 수정: `--build-remote` 기본 CLI 경로 폴백 복구 (`scripts/build-remote.js`)**
   - `parseCliArgs()`와 `buildDistRemote()`에서 미지정 `configJsonPath`·`trustPolicyPath`·`addonsDir`·`pluginsRootDir`·`settingsDataDir` 기본값을 `null`에서 `undefined`로 교정하여, 플래그 없는 기본 `addon-host --build-remote` 실행 시 `TRUST_POLICY_PATH`와 `CONFIG_JSON_PATH`로 정상 폴백하도록 수정했습니다.
   - API 호출자가 의도적으로 `null`을 명시 전달하는 기존 의미는 그대로 보존됩니다.

3. **보안 보강 (F7)**
   - `src/adapters/remote-web/remote-bootstrap.js`에서 `activeKernel.boot(...)` 및 `mountFallbackSlotDock(...)` 전달 전 `profile.extraNoTranslateAttributes`를 `isSafeExtraAttrName()`으로 사전 필터링합니다.

### 업그레이드 안내

- **Desktop Electron**: `addon-host --upgrade` 실행 (`dist/runtime`만 갱신되며 `app.asar`는 변경되지 않음).
- **Remote Web**: `addon-host --build-remote` 실행 후 `dist/remote/`의 Userscript 또는 Bookmarklet을 갱신.
