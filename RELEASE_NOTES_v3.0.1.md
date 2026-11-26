# Release Notes — `v3.0.1`

## English

### v3.0.1 Ecosystem Parity & Polish
- **Capability-Gated `ctx.settingsBridge` on `AddonContextV3`**:
  - Exposes frozen, World-998-primordial-hardened `ctx.settingsBridge` (`getSettings`/`getSnapshot`, `onSettingsChange`/`onDidChange`, `saveSettings`/`save`) strictly when a v3 plugin declares `settingsBridge` and is trust-approved (`undefined` otherwise, preserving ISP).
  - Automatically unsubscribes `onSettingsChange` listeners on `lifecycle.onDispose()` and adds `initialSettings` + reactive snapshot push support to `@antigravity-addons/sdk` `createTestHost`.
- **Desktop Settings Left Sidebar & Addon Manager UI for `ui.registerSettingsPage`**:
  - Connects `settingsPageCoordinator` to `createHostSettingsUi` (`host-settings-ui.js`): v3 plugins calling `ctx.ui.registerSettingsPage` now appear automatically in the **Desktop Settings left sidebar** (directly below `Addon Manager`, cloned from native sidebar styling with `data-addon-host-plugin-settings-nav`) AND as a **`Settings` / `설정`** button inside their `Addon Manager` card.
  - Reactively syncs when plugins register or dispose settings pages and cleans up every sidebar element on `dispose()`.
- **Userscript Builder, SDK & Runtime Fixes**:
  - `scripts/build-remote.js`: `--build-addon-userscript` `@description` now dynamically reflects `AddonManifest.v3` vs `AddonManifest.v2` based on `manifest.schemaVersion`.
  - `packages/sdk/src/test-host.js`: guards mock `querySelectorAll` against text nodes (`nodeType: 3`) and implements `doc.createTextNode()`.
  - `src/runtime/renderer/context-v3.js`: fixes `ui.mountCanvas` `--ag-*` token stylesheet injection using `slotHandle.getRootNode()` fallback when `slotHandle.shadowRoot` is absent.
  - `src/runtime/renderer/settings-page-coordinator.js`: accepts dynamic `getSchema`-only pages in `ui.registerSettingsPage`.

---

## 한국어

### v3.0.1 생태계 패리티 및 품질 보강
- **`AddonContextV3` 전용 `ctx.settingsBridge` 노출**:
  - `settingsBridge`를 선언하고 신뢰 승인된 v3 플러그인에 한해 World 998 프로토타입 방어가 적용된 동결 `ctx.settingsBridge`(`getSettings`/`getSnapshot`, `onSettingsChange`/`onDidChange`, `saveSettings`/`save`)를 노출합니다(미선언 시 `undefined` 유지).
  - `lifecycle.onDispose()` 시 `onSettingsChange` 구독을 자동 정리하며, `@antigravity-addons/sdk` `createTestHost`에서도 `initialSettings` 및 저장 후 스냅샷 브로드캐스트를 지원합니다.
- **데스크톱 Settings 좌측 사이드바 및 Addon Manager에서 `ui.registerSettingsPage` 공식 노출**:
  - `settingsPageCoordinator`를 `host-settings-ui.js`에 연동하여, `ctx.ui.registerSettingsPage`를 호출하는 모든 v3 플러그인(`antigravity-mcp-manager`, `ko-thought-translator` 등)이 **데스크톱 Settings 좌측 사이드바(`Addon Manager` 바로 아래)** 와 **Addon Manager 카드 내 `설정` 버튼**에 자동으로 표시됩니다.
  - 플러그인 등록·해제에 실시간 동기화되며, `dispose()` 시 사이드바 항목을 흔적 없이 정리합니다.
- **Userscript 빌더 · SDK · 런타임 버그 수정**:
  - `scripts/build-remote.js`: `--build-addon-userscript`의 `@description`에 `schemaVersion: 3` 매니페스트 기준 `AddonManifest.v3`가 정확히 표기되도록 수정했습니다.
  - `packages/sdk/src/test-host.js`: mock DOM `querySelectorAll`의 텍스트 노드(`nodeType: 3`) 예외 가드 및 `doc.createTextNode()`를 추가했습니다.
  - `src/runtime/renderer/context-v3.js`: `ui.mountCanvas`에서 `slotHandle.getRootNode()` 폴백으로 ShadowRoot에 `--ag-*` 토큰 스타일이 정상 주입되도록 수정했습니다.
  - `src/runtime/renderer/settings-page-coordinator.js`: `ui.registerSettingsPage`에서 `getSchema` 함수 단독 선언을 허용하도록 수정했습니다.
