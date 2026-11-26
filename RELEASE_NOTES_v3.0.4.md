# Release Notes — `v3.0.4`

## English

### v3.0.4 Modal Viewport Clamping, Internal Scroll Propagation & Auto-Recentering
- **Fix Broken `max-height` Inheritance Across `<dialog>` → `shadowHost` (`context-v3.js`, `ui-schema-renderer.js`)**:
  - Sets `overflow: hidden; box-sizing: border-box` on modal `<dialog>` elements and propagates `max-height: inherit; width: 100%; display: flex; flex-direction: column; overflow: hidden` onto the inner `shadowHost` wrapper.
  - Strengthens `SCHEMA_UI_CSS` (`:host`, `.ag-ui-shell`, `.ag-ui-header { flex: 0 0 auto }`, `.ag-ui-body { flex: 1 1 auto; min-height: 0; overflow-y: auto }`) so tall modals never overflow off the bottom of the viewport and always scroll cleanly inside `.ag-ui-body` while keeping header and bottom actions reachable.
- **Auto-Recenter Modals After Late Content Mount / Dynamic Height Changes (`placement-engine.js`)**:
  - `trackElementPlacement()` now attaches a re-entrancy-safe `ResizeObserver` (observing both the dialog/popover element and its inner wrapper) plus a post-mount `requestAnimationFrame` sync so Tier-3 modals populated after `openModal()` returns—or forms expanding dynamically (e.g., Local LLM options)—immediately recenter within viewport bounds without clipping below the bottom edge.
  - Applies explicit `width` (clamped to `maxWidth`) consistently on `surface-center` placements.

---

## 한국어

### v3.0.4 모달 뷰포트 하단 잘림 수정 · 내부 스크롤 연결 · 자동 중앙 재배치
- **`<dialog>` → `shadowHost` `max-height` 상속 단절 복구 (`context-v3.js`, `ui-schema-renderer.js`)**:
  - 모달 `<dialog>`의 `overflow`를 `hidden`으로 바꾸고 중간 래퍼 `shadowHost`에 `max-height: inherit; width: 100%; display: flex; flex-direction: column; overflow: hidden`을 적용했습니다.
  - `SCHEMA_UI_CSS`에 `:host` / `.ag-ui-shell` / `.ag-ui-header(flex: 0 0 auto)` / `.ag-ui-body(flex: 1 1 auto; min-height: 0; overflow-y: auto)` 제약을 연결해, 모달 높이가 뷰포트를 넘을 때 화면 아래로 잘려 나가지 않고 본문 내부에서 깔끔하게 스크롤됩니다.
- **콘텐츠 지연 마운트·높이 변화 시 자동 중앙 재배치 (`placement-engine.js`)**:
  - `trackElementPlacement()`에 재진입 방지 `ResizeObserver`와 첫 프레임 `requestAnimationFrame` 동기화를 추가해, `openModal()` 반환 직후 `bodyEl`에 DOM이 채워지거나 옵션 토글로 높이가 커져도 모달이 화면 정중앙·안전 여백 안에 자동 재배치되도록 수정했습니다.
  - `surface-center` 배치에서도 명시 `width`(뷰포트 `maxWidth` 이내 클램프)가 일관 적용되도록 보강했습니다.
