# Extenra v3.2.1 — Tier-1 Toast & Tier-2 Declarative Modal/Form UI/UX Polish

## English

### Highlights
- **Tier-2 Declarative Modal / Popup / Form Overhaul (`ui-schema-renderer.js`, `theme-i18n.js`)**:
  - **Color-Scheme & Sleek Custom Scrollbars**: Emits `color-scheme: dark` / `color-scheme: light` on Shadow DOM `:host` and applies thin rounded scrollbars to `.ag-ui-body` and `.ag-textarea`, eliminating harsh light native scrollbars inside dark modals.
  - **Pure-CSS Pill Toggle Switches**: Transforms declarative `toggle` checkboxes into modern pill switches with smooth thumb animation and accessible focus rings without changing any DOM contract.
  - **Refined Visual Hierarchy & Typography**: Upgraded section cards, spacing, subtle hairline borders, understated neutral `Addon: <displayName>` attribution pill (non-removable), cobalt-blue primary buttons (`#2563eb` → `#3b82f6` with crisp white text), generous textarea height (`min-height: 92px`), CSP-safe pure-CSS `<select>` chevron (zero `data:` URIs), custom rounded progress bars, and `prefers-reduced-motion` support.
- **Blurred Modal Backdrop Scrim (`context-v3.js`)**:
  - Lazily injects a single host-owned `<style data-addon-host-v3-backdrop="1">` with `rgba(5, 8, 15, 0.56)` + `backdrop-filter: blur(4px)` so modals and stacked sub-modals separate cleanly from background surfaces.
- **Compact Locale-Aware Tier-1 Toast (`toast-manager.js`)**:
  - Replaces raw uppercase English fallback titles (`SUCCESS`) with locale-aware human labels (`완료` / `안내` / `주의` / `오류` in Korean; `Success` / `Info` / `Warning` / `Error` in English).
  - Moves dismiss to a compact `×` icon button in the header and omits the bulky bottom action row unless a custom `spec.action` is provided, while keeping non-removable `Addon: <displayName>` attribution intact.
- **100% Backward Compatible**: Preserves all `--ag-*` tokens (`--ag-surface: #161b24`, `--ag-accent`), DOM structure, and AddonManifest v1/v2/v3 contracts.

---

## 한국어

### 주요 변경 사항
- **Tier-2 선언형 모달 · 팝업 · 폼 UI/UX 전면 개선 (`ui-schema-renderer.js`, `theme-i18n.js`)**:
  - **다크/라이트 `color-scheme` 동기화 및 커스텀 스크롤바**: Shadow DOM `:host`에 `color-scheme`을 동기화하고 `.ag-ui-body`·`.ag-textarea`에 얇은 둥근 커스텀 스크롤바를 적용해, 다크 모달 안에 하얀 기본 Windows 스크롤바가 뜨던 문제를 해결했습니다.
  - **순수 CSS 필 토글 스위치**: 기존 DOM 계약을 그대로 유지하면서 `toggle` 체크박스를 현대적인 필 토글 스위치(부드러운 슬라이드·포커스 링·`prefers-reduced-motion` 지원)로 업그레이드했습니다.
  - **정보 계층·버튼·입력 컨트롤 정돈**: 카드 여백과 헤어라인 테두리, 차분한 중립 톤 `Addon: <displayName>` 배지(제거 불가 유지), 가독성 높은 코발트 블루 기본 버튼(`#2563eb` / 흰색 텍스트), 넉넉한 `<textarea>` 높이(`min-height: 92px`), CSP 안전한 순수 CSS `<select>` 화살표(`data:` URI 미사용), 둥근 프로그레스 바를 적용했습니다.
- **모달 배경 블러 스크림 (`context-v3.js`)**:
  - `<dialog>::backdrop`에 어두운 반투명 블러(`rgba(5, 8, 15, 0.56)`, `blur(4px)`)를 자동 적용해 모달 및 중첩 모달이 뒤 화면과 깔끔하게 분리됩니다.
- **컴팩트 로캘 인식 Tier-1 토스트 (`toast-manager.js`)**:
  - `title` 미지정 시 영문 대문자 `SUCCESS` 대신 로캘별 문구(`완료`/`안내`/`주의`/`오류`, 영문 `Success`/`Info`/`Warning`/`Error`)를 표시합니다.
  - 하단 `Dismiss` 버튼 줄을 없애고 헤더 우측 컴팩트 `×` 버튼으로 정리해(커스텀 `action`이 있을 때만 액션 줄 표시) 토스트가 훨씬 간결해졌습니다.
- **100% 하위 호환**: 기존 `--ag-*` 토큰, DOM 구조, AddonManifest v1/v2/v3 계약을 깨뜨리지 않습니다.
