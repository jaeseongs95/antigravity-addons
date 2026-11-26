# Extenra v3.2.0

## English

### Highlights
- **Project Rebranding to Extenra (`extenra` / `@extenra/sdk`)**:
  - Renamed the root package from `antigravity-addons` to **`extenra`** (`v3.2.0`) and the developer SDK package from `@antigravity-addons/sdk` to **`@extenra/sdk`** (`v3.2.0`).
  - Added primary **`extenra`** and **`extenra-addon`** CLI binaries while keeping **`addon-host`**, **`antigravity-addons`**, and **`ag-addon`** as 100% backward-compatible aliases.
  - Updated GitHub repository URLs, CI badges, JSON Schema v3 `$id`, 1-Click Hub branding/commands (`docs/hub/`), default Remote Web `@namespace` and `@require` release base URLs to `https://github.com/jaeseongs95/extenra`.
- **100% Backward Compatibility for Existing Antigravity Plugins**:
  - Preserved `antigravity-desktop` and `antigravity-remote-web` host profile IDs, `~/.gemini/antigravity` runtime/data paths, `ADDON_HOST_LOADER_V2` ASAR patch marker, `ag-bridge-v1:` pairing code prefix, and Remote Web release filenames (`antigravity-remote-host.lib.js`, `antigravity-remote.user.js`, `antigravity-curated-all-in-one.user.js`).
  - Existing plugins (`antigravity-statusbar`, `antigravity-mcp-manager`, `ko-thought-translator`) require zero breaking changes.
  - Note: GitHub automatically redirects legacy `jaeseongs95/antigravity-addons` links after repository rename.

---

## 한국어

### 주요 변경 사항
- **프로젝트명 `Extenra` 변경 (`extenra` / `@extenra/sdk`)**:
  - 루트 패키지명을 `antigravity-addons`에서 **`extenra`** (`v3.2.0`)로, 개발자 SDK 패키지명을 `@antigravity-addons/sdk`에서 **`@extenra/sdk`** (`v3.2.0`)로 변경했습니다.
  - 기본 CLI 명령어로 **`extenra`** 와 **`extenra-addon`** 을 추가하고, 기존 **`addon-host`**, **`antigravity-addons`**, **`ag-addon`** 별칭을 100% 하위 호환 유지했습니다.
  - GitHub 저장소 URL, CI 배지, JSON Schema v3 `$id`, 1-Click Hub 브랜딩·명령어(`docs/hub/`), 기본 원격 웹 `@namespace` 및 `@require` 릴리스 기준 URL을 `https://github.com/jaeseongs95/extenra`로 일괄 갱신했습니다.
- **기존 Antigravity 플러그인 100% 하위 호환 유지**:
  - `antigravity-desktop` · `antigravity-remote-web` 호스트 프로필 ID, `~/.gemini/antigravity` 로컬 런타임/데이터 경로, `ADDON_HOST_LOADER_V2` 패치 마커, `ag-bridge-v1:` 페어링 접두어, 원격 웹 번들 파일명(`antigravity-remote-host.lib.js`, `antigravity-remote.user.js`, `antigravity-curated-all-in-one.user.js`)은 변경하지 않았습니다.
  - 기존 플러그인(`antigravity-statusbar`, `antigravity-mcp-manager`, `ko-thought-translator`)은 별도 마이그레이션 없이 그대로 동작합니다.
  - 참고: GitHub 저장소명 변경 후에도 기존 `jaeseongs95/antigravity-addons` 링크는 GitHub에서 자동 리다이렉트됩니다.
