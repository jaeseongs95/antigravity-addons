# Release Notes — `v3.0.1`

## English

### v3.0.1 Ecosystem Parity & Polish
- **Capability-Gated `ctx.settingsBridge` on `AddonContextV3`**:
  - Exposes frozen, World-998-primordial-hardened `ctx.settingsBridge` (`getSettings`/`getSnapshot`, `onSettingsChange`/`onDidChange`, `saveSettings`/`save`) strictly when a v3 plugin declares `settingsBridge` and is trust-approved (`undefined` otherwise, preserving ISP).
  - Automatically unsubscribes `onSettingsChange` listeners on `lifecycle.onDispose()` and adds `initialSettings` + reactive snapshot push support to `@antigravity-addons/sdk` `createTestHost`.
- **Desktop Settings Left Sidebar & Addon Manager UI for `ui.registerSettingsPage`**:
  - Connects `settingsPageCoordinator` to `createHostSettingsUi` (`host-settings-ui.js`): v3 plugins calling `ctx.ui.registerSettingsPage` now appear automatically in the **Desktop Settings left sidebar** (directly below `Addon Manager`, cloned from native sidebar styling with `data-addon-host-plugin-settings-nav`) AND as a **`Settings` / `설정`** button inside their `Addon Manager` card.
  - Reactively syncs when plugins register or dispose settings pages and cleans up every sidebar element on `dispose()`.
- **Independent `KO / EN` Language Switch in `Addon Manager`**:
  - Removes all cross-plugin sidebar Korean text sniffing from `host-settings-ui.js` so `Addon Manager` never depends on `ko-thought-translator` or any peer addon for its UI language.
  - Adds a dedicated segmented `한국어 | EN` toggle in the `Addon Manager` header that switches both panel copy and the sidebar label (`애드온 관리` ↔ `Addon Manager`) immediately and persists to `localStorage['addon-host:settings-ui-lang']` (falling back to document/OS locale on first run).
- **Desktop `localLoopback` Dynamic Port Resolution & Non-Spoofable Broker `Origin` Contract**:
  - `net-fetch-broker.js` & `init-main.js`: when a `trusted` Desktop plugin declares a named `permissions.net.localLoopback` target (e.g., `antigravity-sidecar`) alongside `settingsBridge`, the broker dynamically authorizes strictly validated loopback ports (`1024..65535`) published in that plugin's own `settingsBridge` snapshot (`baseUrl`, `sidecarUrl`, `sidecarPort`, `loopbackPort`, `port`, `sidecar.port`/`baseUrl`), preventing fixed-port `EADDRINUSE` lockouts.
  - Inside the main-process broker only, Desktop `localLoopback` requests now stamp host-controlled `Origin: http://127.0.0.1:<port>`, `X-Addon-Host-Broker: 1`, and `X-Addon-Host-Plugin: <pluginId>` headers while `net-policy.js` continues stripping all plugin-supplied `Origin` and `X-Addon-Host-*` headers so plugins cannot spoof origins or broker trust.
- **Remote Web User-Consented Runtime HTTPS Origin Allowlist (`permissions.net.userApprovedHttps`)**:
  - Adds opt-in `permissions.net.userApprovedHttps: true` to `AddonManifest.v3` (`schemas/addon-manifest.v3.schema.json`), keeping static `httpsHosts` default-deny with zero wildcards in manifests.
  - Stores per-plugin user-approved public HTTPS FQDNs exclusively in host-owned Remote Web storage (`remote-host-bridge.js`, never writable by plugins) and exposes trusted-click-only (`ev.isTrusted !== false`) **Approve / Revoke** controls inside the Remote Web Host Drawer (`remote-bootstrap.js`), enforcing `isPublicFqdnHost`, `https:` port 443, `forbiddenNetHosts`, and redirect `finalUrl` re-validation.
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
- **`Addon Manager` 독립 `한국어 / EN` 언어 전환 스위치**:
  - `host-settings-ui.js`에서 좌측 사이드바 한글 텍스트를 엿보던 결합 코드를 완전히 제거하여, `Addon Manager` 언어가 `ko-thought-translator` 등 타 플러그인에 의존하지 않도록 역할을 분리했습니다.
  - `Addon Manager` 헤더에 독립 `한국어 | EN` 전환 스위치를 추가하여 패널과 사이드바 라벨(`애드온 관리` ↔ `Addon Manager`)을 즉시 전환하고 `localStorage['addon-host:settings-ui-lang']`에 저장합니다(최초 실행 시 문서·OS 로케일 기준).
- **데스크톱 `localLoopback` 동적 포트 허용 및 브로커 `Origin` 신뢰 계약**:
  - `net-fetch-broker.js`·`init-main.js`: `trusted` 데스크톱 플러그인이 named `permissions.net.localLoopback`(예: `antigravity-sidecar`)과 `settingsBridge`를 함께 선언한 경우, 해당 플러그인 자신의 `settingsBridge` 스냅샷에 게시된 검증된 로컬 루프백 포트(`1024..65535`)를 동적 허용하여 고정 포트 `EADDRINUSE` 충돌을 방지합니다.
  - 메인 프로세스 브로커 내부에서만 데스크톱 `localLoopback` 요청에 `Origin: http://127.0.0.1:<port>`, `X-Addon-Host-Broker: 1`, `X-Addon-Host-Plugin: <pluginId>` 헤더를 부여하며, 플러그인이 넘긴 `Origin` 및 `X-Addon-Host-*` 헤더는 `net-policy.js`에서 계속 제거하여 스푸핑을 차단합니다.
- **Remote Web 사용자 명시 승인 런타임 HTTPS 허용 목록 (`permissions.net.userApprovedHttps`)**:
  - `AddonManifest.v3` 스키마에 옵트인 `permissions.net.userApprovedHttps: true`를 추가해 매니페스트 와일드카드 없이 기본 거부(default-deny)를 유지하면서, 사용자별 원격 HTTPS 사이드카·터널 호스트를 허용할 수 있습니다.
  - 호스트 전용 저장소(`remote-host-bridge.js`)와 Remote Web 드로어 UI(`remote-bootstrap.js`)의 신뢰 클릭(`ev.isTrusted !== false`) 승인·회수 제어를 통해 공인 HTTPS FQDN(포트 443, IP·루프백·사설망·와일드카드·금지 호스트 차단 및 리다이렉트 재검증)만 안전하게 허용합니다.
- **Userscript 빌더 · SDK · 런타임 버그 수정**:
  - `scripts/build-remote.js`: `--build-addon-userscript`의 `@description`에 `schemaVersion: 3` 매니페스트 기준 `AddonManifest.v3`가 정확히 표기되도록 수정했습니다.
  - `packages/sdk/src/test-host.js`: mock DOM `querySelectorAll`의 텍스트 노드(`nodeType: 3`) 예외 가드 및 `doc.createTextNode()`를 추가했습니다.
  - `src/runtime/renderer/context-v3.js`: `ui.mountCanvas`에서 `slotHandle.getRootNode()` 폴백으로 ShadowRoot에 `--ag-*` 토큰 스타일이 정상 주입되도록 수정했습니다.
  - `src/runtime/renderer/settings-page-coordinator.js`: `ui.registerSettingsPage`에서 `getSchema` 함수 단독 선언을 허용하도록 수정했습니다.
