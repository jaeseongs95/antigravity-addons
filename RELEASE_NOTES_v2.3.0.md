# antigravity-native-addon-host v2.3.0 Release Notes

> **Language**: English | [한국어](#한국어-릴리스-노트)

## English Release Notes

### Overview
`v2.3.0` is an additive, zero-`app.asar`-repatch release over `v2.2.0` that introduces **Remote Web Host support (`antigravity-remote-web`)** via a unified `HostBridgePort` renderer kernel and **Option A Declarative Named-Scope `configBridge`** for trusted plugins — with **zero new npm dependencies** and full backward compatibility for existing `AddonManifest.v1` / `v2` plugins.

### What's New
- **Remote Web Host (`antigravity-remote-web`) & Unified `HostBridgePort`**:
  - Extracts a transport-neutral `HostBridgePort` (`src/runtime/renderer/host-bridge-port.js`) so the exact same `src/runtime/renderer/kernel.js` runs on both Desktop Electron (preload `claim(nonce)`) and Remote Web (`cfg.hostBridge` direct injection) with full primordial capture.
  - Adds multi-profile compatibility (`compatibleHostProfiles`, `compatibility.hostProfiles`, `compatibility.excludeHostProfiles`) and `supportedCapabilities` gating: existing `antigravity-desktop` `AddonManifest.v2` renderer addons automatically run on Remote Web, dual-capability addons safely skip `mainHook` fail-closed, and `mainHook`-only addons reject with `ERR_UNSUPPORTED_HOST_CAPABILITY`.
  - Adds the vendor-neutral `src/adapters/remote-web/` browser runtime (`origin-guard`, scoped `trusted-types-guard`, zero-HTML-sink `dom-guard`, `remote-host-bridge` with `localStorage` persistence & Phase-2 `remoteTransport` OCP hook, `addon-collector`, Shadow-DOM status/settings/diagnostics drawer) and `src/profiles/antigravity-remote-web.js` (`https://antigravity.google.com`).
  - Adds deterministic Remote Web Userscript & Bookmarklet builder (`npm run build:remote`, `npm run check:remote`, `addon-host --build-remote`, `addon-host --profile remote-web --status|--doctor|--validate`) with Acorn AST security verification (0 HTML sinks, 0 `eval`/`new Function`, 0 external requires).
  - Verified with unit tests (`test/unit/v23-remote-web-adapter.test.js`) and real headless Chromium E2E (`npm run test:e2e:remote`).
- **Option A Declarative Named-Scope `configBridge` (`AddonManifest.v2`)**:
  - Adds vendor-neutral `configBridge.scopes: [{ scopeId, access: "ro" | "rw", maxBytes? }]` to `AddonManifest.v2` schema, validator, trust policy (requires `trustLevel: "trusted"` + SHA-256 `trust-policy.json` pinning), and `SlotRegistry` (enforces single `rw` writer per `scopeId` with `ERR_DUPLICATE_CONFIG_SCOPE_WRITER`).
  - Defines 3 Antigravity-specific named scopes exclusively in `src/profiles/antigravity.js`:
    - `antigravity:mcp-config` (`file`, `rw`, `~/.gemini/config/mcp_config.json`, private rotating backups up to 10 in `~/.gemini/config/.mcp-manager-backups/`)
    - `antigravity:plugin-mcp-configs` (`plugin-files`, `ro`, `~/.gemini/config/plugins/*/mcp_config.json`, up to 128 plugins)
    - `antigravity:mcp-config-legacy` (`file`, `ro`, `~/.gemini/antigravity/mcp_config.json`)
  - Implements zero-dependency `src/runtime/main/config-bridge.js` with ancestor symlink/junction confinement, target symlink & reserved-path rejection, single-fd bounded reads, raw-text corruption recovery (`status: "corrupt"`, `rawText`, `sha256`), advisory lockfile with stale-lock recovery, SHA-256 CAS (`ERR_CONFIG_CAS_CONFLICT`), `fsyncSync` + Windows retryable atomic `renameSync`, and `addonHost.readConfigScope()` / `writeConfigScope()` in World `998`.

### Upgrade Notes
- Upgrading from `v2.0.0`, `v2.1.0`, or `v2.2.0` requires **zero `app.asar` re-patching** (`addon-host --upgrade` only updates the staged runtime in `~/.gemini/antigravity/runtime/<buildSha8>`).
- Restart Antigravity Desktop after upgrading so Electron main/preload loads the new staged runtime.
- See [docs/REMOTE_WEB.md](./docs/REMOTE_WEB.md) for Remote Web bundle building and usage.

---

## 한국어 릴리스 노트

### 개요
`v2.3.0`은 `v2.2.0` 대비 `app.asar` 재패치 없이 하위 호환으로 확장되는 마이너 릴리스로, 공용 `HostBridgePort` 기반의 **Remote Web 호스트(`antigravity-remote-web`) 통합 지원**과 신뢰 플러그인용 **Option A 선언형 Named-Scope `configBridge`**를 신규 의존성 0건으로 추가합니다.

### 주요 변경 사항
- **Remote Web 호스트(`antigravity-remote-web`) 및 공용 `HostBridgePort` 통합**:
  - 전송 계층 중립 `HostBridgePort`(`src/runtime/renderer/host-bridge-port.js`)를 도입하여 단일 `src/runtime/renderer/kernel.js`가 Desktop Electron(프리로드 `claim(nonce)`)과 Remote Web(`cfg.hostBridge` 직접 주입) 모두에서 동일한 원시 객체 보호와 함께 실행됩니다.
  - 다중 프로필 호환성(`compatibleHostProfiles`, `compatibility.hostProfiles`, `compatibility.excludeHostProfiles`) 및 `supportedCapabilities` 게이팅을 추가했습니다. 기존 `antigravity-desktop`용 `AddonManifest.v2` 렌더러 애드온은 별도 수정 없이 Remote Web에 자동 포함되며, `mainHook` 병행 애드온은 안전하게 `mainHook`만 스킵하고 `mainHook` 전용 애드온은 `ERR_UNSUPPORTED_HOST_CAPABILITY`로 Fail-Closed 거부합니다.
  - 벤더 중립 브라우저 어댑터(`src/adapters/remote-web/`: `origin-guard`, 스코프드 `trusted-types-guard`, HTML 싱크 제로 `dom-guard`, `localStorage` 영속화 및 Phase-2 `remoteTransport` OCP 확장점 포함 `remote-host-bridge`, `addon-collector`, Shadow-DOM 상태·설정·진단 드로어)와 `src/profiles/antigravity-remote-web.js`(`https://antigravity.google.com`)를 추가했습니다.
  - 결정적 Remote Web Userscript & Bookmarklet 빌더(`npm run build:remote`, `npm run check:remote`, `addon-host --build-remote`, `addon-host --profile remote-web --status|--doctor|--validate`)와 Acorn AST 보안 게이트(HTML 싱크 0건, `eval`/`new Function` 0건, 외부 `require` 0건)를 제공합니다.
  - 단위 테스트(`test/unit/v23-remote-web-adapter.test.js`) 및 실제 Headless Chromium E2E(`npm run test:e2e:remote`)로 검증했습니다.
- **Option A 선언형 Named-Scope `configBridge` (`AddonManifest.v2`)**:
  - 벤더 중립 `configBridge.scopes: [{ scopeId, access: "ro" | "rw", maxBytes? }]` 계약을 스키마·검증기·신뢰 정책(`trustLevel: "trusted"` + `trust-policy.json` SHA-256 핀닝 필수)·`SlotRegistry`(`scopeId`당 `rw` 단일 작성자 배타성, `ERR_DUPLICATE_CONFIG_SCOPE_WRITER`)에 추가했습니다.
  - Antigravity 전용 3개 Named Scope를 `src/profiles/antigravity.js`에만 격리 정의했습니다:
    - `antigravity:mcp-config` (`file`, `rw`, `~/.gemini/config/mcp_config.json`, `~/.gemini/config/.mcp-manager-backups/` 비공개 회전 백업 최대 10개)
    - `antigravity:plugin-mcp-configs` (`plugin-files`, `ro`, `~/.gemini/config/plugins/*/mcp_config.json`, 최대 128개 플러그인)
    - `antigravity:mcp-config-legacy` (`file`, `ro`, `~/.gemini/antigravity/mcp_config.json`)
  - 무의존성 `src/runtime/main/config-bridge.js`에서 상위 디렉터리 심볼릭 링크/정션 차단, 대상 심볼릭 링크 및 예약 경로 거부, 단일 fd 크기 제한 읽기, 손상 JSON 원문 복구(`status: "corrupt"`, `rawText`, `sha256`), stale lock 복구 포함 권고 락 파일, SHA-256 CAS(`ERR_CONFIG_CAS_CONFLICT`), `fsyncSync` + Windows 재시도 원자적 `renameSync`, 그리고 World `998` `addonHost.readConfigScope()` / `writeConfigScope()` API를 제공합니다.

### 업그레이드 안내
- `v2.0.0` / `v2.1.0` / `v2.2.0`에서 업그레이드 시 **`app.asar` 재패치는 발생하지 않습니다**(`addon-host --upgrade`가 `~/.gemini/antigravity/runtime/<buildSha8>` 스테이징 런타임만 갱신합니다).
- 업그레이드 후 Antigravity Desktop을 완전히 종료하고 재시작하면 새 런타임이 적용됩니다.
- Remote Web 번들 빌드 및 사용법은 [docs/REMOTE_WEB.ko.md](./docs/REMOTE_WEB.ko.md)를 참고하세요.
