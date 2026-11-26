# AddonManifest.v3 & `AddonContextV3` API 가이드 (v3.2.0)

**Extenra** (`extenra`, 구 `antigravity-addons`)는 **API-First 3-Tier 점진적 추상화**와 **ISP 권한 분리** 프레임워크(`v3.0.0+`)를 제공하며, 기존 v1/v2 플러그인을 위해 `v3.x` 전 기간 동안 `createV2CompatAdapter(v3)` 하위 호환 어댑터를 유지합니다.

## 1. 3-Tier 호스트 UI 구조

| 계층 | 소유 경계 | 주요 API | 권장 용도 |
| :--- | :--- | :--- | :--- |
| **Tier 1 (Zero-DOM 시맨틱 표면)** | 호스트 100% | `ui.showToast`, `ui.confirm`, `ui.prompt`, `ui.registerCommand`, `ui.registerStatusItem`, `ui.registerSettingsPage` | 알림, 확인/입력 다이얼로그, 상태바 버튼(`host.statusbar` 위임 + 기본 폴백 바), Desktop·Remote Web 통합 설정 페이지 |
| **Tier 2 (호스트 배치 오버레이 + 선언형 JSON 스키마)** | 호스트가 좌표·플립/시프트·모바일 바텀시트·Top Layer·`Addon: <displayName>` 배지 소유 | `ui.openPopup`, `ui.openModal`, `ui.openPanel` (`PlacementSpec`, 16종 폐쇄형 프리미티브, 정적 `visibleWhen`/`disabledWhen`, `handle.update(nextTree)` ID 인플레이스 패치) | 직접 DOM 배치 코드를 쓰지 않는 팝업, 빠른 설정 패널, 폼, 드로어 |
| **Tier 3 (통제된 탈출구)** | 호스트가 Shadow DOM 격리 및 `--ag-*` 토큰 소유, 플러그인이 내부 DOM 소유 | `ui.mountCanvas`, `ui.createStyleElementSafe`, `dom.*` (`trusted` 전용 `document-transform`) | 리치 커스텀 캔버스 UI 또는 호스트 문서 변환 |

## 2. ISP 분리 `AddonContextV3` 및 이중 키 `net.fetch`

- **상시 제공 네임스페이스**: `apiVersion: 3`, `meta`, `env`(`surface`, `layoutMode`, `capabilities` — **원시 `hostProfileId` 비노출**), `theme`(`--ag-*` 토큰), `i18n`, `ui`, `storage`(KV + TTL + `onDidChange`), `events`, `services`(`<pluginId>.<name>`, 기본 거부 `allowedCallers`, 프로토타입 키 제거), `lifecycle`(`AbortSignal`, `onDispose`).
- **권한 게이팅 네임스페이스** (미선언·미승인·미지원 표면에서는 `undefined`로 생략):
  - `net.fetch(url, init)`:
    - `permissions.net.httpsHosts` (Desktop + Remote Web 공통): 공개 HTTPS FQDN만 허용(원시 IP·localhost·내부 접미사·인증 오리진 차단), `credentials: 'omit'`, 최대 3홉 수동 리다이렉트 allowlist 재검증, Desktop Main 프로세스 사전 DNS 조회로 RFC1918·루프백·링크로컬·IMDS(`169.254.169.254`) 차단 및 조회 IP 직접 연결(DNS Rebinding 차단).
    - `permissions.net.localLoopback` (Desktop `trusted` 전용): 명시적 정수 포트(`1024..65535`) 또는 프로필 명명 타깃(`antigravity-sidecar`), `127.0.0.1` 정규화, **리다이렉트 0회**, Remote Web 비노출.
  - `dom`, `configBridge`: 매니페스트 권한 및 신뢰 승인 시에만 노출.

## 3. 별도 개발 SDK (`@extenra/sdk`) 및 1-Click Hub

- `packages/sdk/`에 별도 패키지로 분리되어 런타임 호스트의 신규 npm 의존성 0개 원칙을 지킵니다.
- `index.d.ts`, `defineAddon()`, `h()`, `createTestHost({ surface: 'desktop' | 'remote-web' })`, `extenra-addon` / `ag-addon init|check|dev|build|pack` CLI, 재사용 GitHub Action 템플릿을 제공합니다.
- GitHub Pages 1-Click Hub(`docs/hub/`)는 Safari 환경을 자동 감지해 외부 `@require #sha256=` 대신 공식 큐레이션 올인원 `.user.js`(closed Shadow DOM + `GM_*` 클로저 섀도잉)로 안내합니다.
