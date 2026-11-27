# Extenra v3.3.4

## English

### Bug Fixes
- **Desktop Inline Settings Header Close-Button Clearance (`.ag-inline-header`)**:
  - Added `padding-right: 36px;` to `.ag-inline-header` in `src/runtime/renderer/host-settings-ui.js` (matching Addon Manager's `.ah-header`).
  - Prevents the host-owned `[ 한국어 | EN ]` locale switch on the right side of inline plugin Settings pages (both standard and compact/canvas modes) from overlapping Antigravity's native Settings modal close (`×`) button.
- **Regression Test**:
  - Extended `TC-V332-HEADER-LOCALE-06` in `test/unit/v330-ui-i18n-section-actions.test.js` to assert that the injected inline Settings stylesheet enforces `padding-right: 36px` on `.ag-inline-header`.
- **Compatibility**:
  - 100% backward-compatible patch release; Desktop thin shim (`addon-host-loader.js`) unchanged and strictly `< 4096 B`.

---

## 한국어

### 결함 수정
- **데스크톱 인라인 플러그인 설정 헤더 닫기(`×`) 버튼 겹침 수정 (`.ag-inline-header`)**:
  - `src/runtime/renderer/host-settings-ui.js`의 `.ag-inline-header`에 Addon Manager(`.ah-header`)와 동일한 `padding-right: 36px;`를 추가했습니다.
  - 일반 및 캔버스(`--compact`) 인라인 플러그인 설정 페이지 우측의 호스트 공용 `[ 한국어 | EN ]` 언어 전환 토글이 Antigravity 네이티브 설정 창 우상단의 닫기(`×`) 버튼과 겹치던 현상을 해소했습니다.
- **회귀 테스트 추가**:
  - `test/unit/v330-ui-i18n-section-actions.test.js` (`TC-V332-HEADER-LOCALE-06`)에 인라인 설정 ShadowRoot 스타일시트의 `.ag-inline-header` `padding-right: 36px` 회귀 검증을 추가했습니다.
- **하위 호환성**:
  - 기존 플러그인·프로필·CLI와 100% 하위 호환되는 패치 릴리스이며, 데스크톱 로더 심(`addon-host-loader.js`) 크기는 `< 4096 B`를 유지합니다.
