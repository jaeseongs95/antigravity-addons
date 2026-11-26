# Extenra v3.3.1 Release Notes

## English

### Bug Fixes
- **Desktop `HOST_CFG.profile.uiSectionTargets` Serialization Fix (`src/adapters/electron/host-loader-builder.js`)**:
  - Serializes `profile.uiSectionTargets` into the generated `addon-host-loader.js` shim so Desktop plugins using `ctx.ui.registerSectionAction(...)` receive declarative section target definitions at runtime instead of an empty object.
- **Real Antigravity Customizations DOM Matcher Hardening (`src/runtime/renderer/section-action-registry.js`, `src/profiles/antigravity.js`, `src/profiles/antigravity-remote-web.js`)**:
  - Supports non-heading collapsible label structures (`button`, `span`, `summary` in addition to `h1`–`h6` / `[role="heading"]`) with innermost-node preference and optional trailing numeric count badges (`MCP 서버 3`, `MCP Servers (3)`).
  - Walks up to `maxParentDepth` (5) ancestor levels to locate the header row's right-side sibling action container (or direct interactive button siblings via `before-node` insertion).
  - Broadens Antigravity `'customizations.mcp-servers.header'` `rootSelectors` with safe `fallbackToDocumentRoot: true`, `requireSiblingActions: true`, and `excludeAncestorSelectors` (`conversation-view`, `conversation-list-sidebar`, `aside`, `nav`, `pre`, `code`, `[contenteditable="true"]`) to prevent false-positive mounting in chat or sidebar views while remaining 100% vendor-neutral (SOLID #0).

---

## 한국어

### 버그 수정
- **Desktop `HOST_CFG.profile.uiSectionTargets` 직렬화 누락 수정 (`src/adapters/electron/host-loader-builder.js`)**:
  - `buildHostLoaderScriptSource()`가 생성하는 `addon-host-loader.js`의 `HOST_CFG.profile`에 `uiSectionTargets`를 정상 포함하도록 수정해, Desktop에서도 `ctx.ui.registerSectionAction(...)` 마운트 탐색이 정상 동작합니다.
- **실제 Antigravity Customizations DOM 매처 보강 (`src/runtime/renderer/section-action-registry.js`, `src/profiles/antigravity.js`, `src/profiles/antigravity-remote-web.js`)**:
  - `h1`–`h6`/`[role="heading"]`뿐 아니라 접기/펼치기 `<button><span>MCP 서버</span><span>3</span>` 같은 비-heading 구조와 뒤따르는 숫자 배지(`MCP 서버 3`, `MCP Servers (3)`)를 최내부 노드 우선으로 매칭합니다.
  - 최대 5단계 상위 헤더 행(`maxParentDepth: 5`)까지 탐색해 우측 형제 액션 컨테이너(또는 직접 형제 `<button>` 앞)에 정확히 삽입합니다.
  - `rootSelectors` 확장 + `fallbackToDocumentRoot: true` + `requireSiblingActions: true` + `excludeAncestorSelectors`(대화창·사이드바·코드·편집창 제외)를 선언형 `HostProfile`에 반영해 오탐 없이 실제 Antigravity v2.35.2 화면에서 안정적으로 마운트됩니다(SOLID #0 벤더 중립성 100% 유지).
