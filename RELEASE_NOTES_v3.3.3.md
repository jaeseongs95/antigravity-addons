# Extenra v3.3.3

## English

### Security & Reliability Hardening
- **Fail-Closed Cryptographic Randomness**:
  - Removed weak `Math.random()` fallback paths from `src/runtime/renderer/kernel.js` and `src/adapters/remote-web/remote-bootstrap.js`; both now fail closed with `ERR_WEBCRYPTO_UNAVAILABLE` when WebCrypto (`crypto.getRandomValues`) is unavailable.
  - Replaced string-wrapped `vm.runInThisContext` in `src/runtime/main/trust-verifier.js` with Node.js `vm.compileFunction`.
- **Linear-Time Parsing (ReDoS Elimination)**:
  - Replaced 12 super-linear backtracking regular expressions across `scripts/build-remote.js`, `src/adapters/electron/asar-patcher.js`, `src/adapters/remote-web/remote-host-transport.js`, `src/core/manifest-validator.js`, `src/runtime/main/remote-bridge-server.js`, `src/runtime/renderer/section-action-registry.js`, `src/runtime/renderer/style-manager.js`, and `src/runtime/renderer/theme-i18n.js` with `O(n)` linear loops and non-overlapping patterns.
- **Deterministic Sorting & Floating Promise Safety**:
  - Added explicit locale-independent UTF-16 code-unit comparators across 21 `.sort()` sites (`S2871`).
  - Resolved 20 floating Promise paths across `init-main.js` (async error capture on `whenReady`/`will-quit`, awaited disposal in `dispose()`), `remote-bootstrap.js`, `remote-lan-server.js`, and `host-settings-ui.js`.
  - Updated `style-manager.js`, `net-policy.js`, and `qr-ascii.js` (`replaceAll`, `Number.parseInt`, and `while` loop cleanup).

### Testing, Coverage & Verification
- **Zero-Dependency LCOV Coverage (`npm run test:coverage`)**:
  - Wired Node.js built-in `--experimental-test-coverage` LCOV output (`coverage/lcov.info`) with zero added runtime or dev dependencies.
- **Expanded Core, Branch, SDK & Preload Regression Suites**:
  - Added `test/unit/v332-sonar-hardening.test.js`, `test/unit/v332-core-coverage.test.js`, and `test/unit/v332-runtime-branch-coverage.test.js` covering all 15 core/shared policy modules, `@extenra/sdk` `createTestHost`, `preload-bridge.js`, `config-bridge.js`, `remote-host-transport.js`, `init-main.js`, and failure paths (`171` passing tests, `0` failures).
  - Verified SonarQube MQR Quality Gate `OK` (`0` open issues; Security/Reliability/Maintainability/Hotspots all `A (0)`), `12/12` targeted core security/boundary mutants killed on isolated copies, and `ubuntu-latest` + `windows-latest` GitHub Actions CI green.
- **Compatibility**:
  - 100% backward-compatible patch release; Desktop thin shim (`addon-host-loader.js`) unchanged and strictly `< 4096 B`.

---

## 한국어

### 보안 및 신뢰성 강화
- **암호화 난수 Fail-Closed 전환 및 VM 실행 보강**:
  - `src/runtime/renderer/kernel.js`와 `src/adapters/remote-web/remote-bootstrap.js`에서 약한 `Math.random()` 폴백을 제거하여, WebCrypto(`crypto.getRandomValues`)가 없는 환경에서는 `ERR_WEBCRYPTO_UNAVAILABLE`로 안전하게 차단합니다.
  - `src/runtime/main/trust-verifier.js`의 문자열 래핑 `vm.runInThisContext` 호출을 Node.js `vm.compileFunction`으로 교체했습니다.
- **선형 시간 파싱(ReDoS 제거)**:
  - `scripts/build-remote.js`, `src/adapters/electron/asar-patcher.js`, `src/adapters/remote-web/remote-host-transport.js`, `src/core/manifest-validator.js`, `src/runtime/main/remote-bridge-server.js`, `src/runtime/renderer/section-action-registry.js`, `src/runtime/renderer/style-manager.js`, `src/runtime/renderer/theme-i18n.js`의 초선형 역추적 정규식 12건을 선형 시간 `O(n)` 루프와 비중첩 패턴으로 교체했습니다.
- **결정적 정렬 및 부유 Promise 정비**:
  - 21개 `.sort()` 지점에 로케일 독립 UTF-16 코드 유닛 비교자를 명시했습니다(`S2871`).
  - `init-main.js`(`whenReady`/`will-quit` 비동기 오류 포착 및 `dispose()` 완료 대기), `remote-bootstrap.js`, `remote-lan-server.js`, `host-settings-ui.js`의 부유 Promise 20건을 정비했습니다.
  - `style-manager.js`, `net-policy.js`, `qr-ascii.js`의 문자열 치환·정수 파싱·반복문 구조를 개선했습니다.

### 테스트·커버리지 및 검증
- **무의존성 LCOV 커버리지 연동 (`npm run test:coverage`)**:
  - 신규 런타임·개발 의존성 없이 Node.js 내장 `--experimental-test-coverage`로 `coverage/lcov.info`를 생성하도록 구성했습니다.
- **핵심·분기·SDK·Preload 회귀 및 실패 경로 테스트 확장**:
  - `test/unit/v332-sonar-hardening.test.js`, `test/unit/v332-core-coverage.test.js`, `test/unit/v332-runtime-branch-coverage.test.js`를 추가해 핵심·공유 정책 모듈 15종, `@extenra/sdk` `createTestHost`, `preload-bridge.js`, `config-bridge.js`, `remote-host-transport.js`, `init-main.js`의 경계·실패 경로를 검증했습니다(`171`건 통과, `0`건 실패).
  - SonarQube MQR 품질 게이트 `OK`(미해결 이슈 `0`건, 보안·신뢰성·유지보수성·핫스팟 모두 `A (0)`), 격리 사본 핵심 보안·경계 표적 변이 테스트 `12/12` 탐지, GitHub Actions CI(`ubuntu-latest`·`windows-latest`) 전체 통과를 확인했습니다.
- **하위 호환성**:
  - 기존 플러그인·프로필·CLI와 100% 하위 호환되는 패치 릴리스이며, 데스크톱 로더 심(`addon-host-loader.js`) 크기는 `< 4096 B`를 유지합니다.
