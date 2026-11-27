'use strict';

/**
 * Vendor-neutral Built-in Host Settings UI (`Addon Manager` / `애드온 관리`) — v2.5.0.
 *
 * - Runs strictly inside the privileged Renderer Kernel (World 998) using the claimed
 *   HostBridgePort admin methods (`getHostAdminState`, `setRemoteAddonPreference`).
 * - NEVER exposed on consumer plugin `addonHost` handles.
 * - Zero vendor literals (SOLID #0), zero HTML sinks (`innerHTML` / `outerHTML` /
 *   `insertAdjacentHTML` = 0), zero `eval` / `new Function`, Shadow DOM isolated.
 * - Coexists cleanly with native Settings tabs and peer plugin tabs (e.g. MCP Manager).
 */

const { SCHEMA_UI_CSS, createSchemaUiController, createHeaderLocaleSwitch } = require('./ui-schema-renderer');

const NAV_ATTR = 'data-addon-host-admin-nav';
const PLUGIN_NAV_ATTR = 'data-addon-host-plugin-settings-nav';
const PANE_ATTR = 'data-addon-host-admin-pane';
const PLUGIN_PANE_ATTR = 'data-addon-host-plugin-settings-pane';
const IGNORE_ATTR = 'data-addon-host-ignore';
const NO_TRANSLATE_ATTR = 'data-addon-host-no-translate';
const LANG_STORAGE_KEY = 'addon-host:settings-ui-lang';

const DEFAULT_SETTINGS_UI_CONFIG = Object.freeze({
  navId: 'addon-manager',
  navLabel: Object.freeze({
    en: 'Addon Manager',
    ko: '애드온 관리',
  }),
  anchorGroups: Object.freeze([
    Object.freeze(['general', '일반']),
    Object.freeze(['application', '애플리케이션', '앱']),
    Object.freeze(['appearance', '모양 및 테마', '외관', '모양', '화면']),
    Object.freeze(['shortcuts', '단축키', '바로가기']),
    Object.freeze(['notifications', '알림']),
    Object.freeze(['models', '모델']),
    Object.freeze(['browser', '브라우저']),
    Object.freeze(['editor', '에디터']),
    Object.freeze(['account', '계정']),
  ]),
});

const COPY = Object.freeze({
  en: Object.freeze({
    title: 'Addon Manager',
    subtitle: 'Manage addons running on the native addon host and choose which ones appear on Remote Web.',
    refresh: 'Refresh',
    refreshing: 'Refreshing...',
    hostLabel: 'Host',
    buildLabel: 'Build',
    summaryDesktop: 'Running on Desktop',
    summaryDesktopSub: 'Registered',
    summaryRemote: 'Shown on Remote Web',
    summaryRemoteSub: 'Remote-compatible',
    summaryBundle: 'Remote Web Bundle',
    bundleUpToDate: 'Up to date',
    bundleNeedsRebuild: 'Rebuild needed',
    bundleNotBuilt: 'Not built yet',
    sectionAddons: 'Installed Native Host Addons',
    emptyTitle: 'No addons registered yet',
    emptyBody: 'Register an AddonManifest.v3 / v2 plugin with the host CLI to manage it here.',
    openSettings: 'Settings',
    sectionPluginPages: 'Plugin Settings Pages',
    statusActive: 'Running',
    statusDisabled: 'Disabled',
    statusRejected: 'Blocked',
    statusFailed: 'Failed',
    statusPending: 'Pending',
    trustApproved: 'Trusted',
    trustUnapproved: 'Approval required',
    trustRestricted: 'Restricted',
    capRenderer: 'Renderer',
    capMainHook: 'Main Hook',
    capSettings: 'Settings',
    capConfig: 'Config',
    remoteToggleLabel: 'Show on Remote Web',
    remoteToggleOn: 'Included',
    remoteToggleOff: 'Hidden',
    remoteReasonDesktopOnly: 'Desktop only',
    remoteReasonConfigBridge: 'Local config bridge only',
    remoteReasonDisabledConfig: 'Disabled in config',
    remoteReasonTrustRequired: 'Trust approval required',
    remoteReasonUnsupported: 'Not supported on Remote Web',
    remoteReasonUnconfigured: 'Remote Web unavailable',
    syncTitleUpToDate: 'Remote Web bundle is synchronized',
    syncTitleNeedsRebuild: 'Remote Web bundle needs rebuild',
    syncTitleNotBuilt: 'Remote Web bundle has not been built yet',
    syncDescUpToDate: 'Your Remote Web settings match the latest bundle. For zero-PC access from any network (LTE/5G/other devices), install each addon’s public HTTPS .user.js release, or copy this single .user.js file via cloud drive/messenger once.',
    syncDescNeedsRebuild: 'Visibility preferences are saved. Run the command below to rebuild the portable Remote Web Userscript, @require host library, and secondary extension.',
    syncDescNotBuilt: 'Run the command below to generate the portable Remote Web Userscript, @require host library, and secondary browser extension.',
    copyCommand: 'Copy command',
    rebuildNow: 'Rebuild Bundle Now',
    rebuilding: 'Rebuilding...',
    rebuildSuccess: 'Rebuilt Remote Web bundle.',
    rebuildError: 'Failed to rebuild Remote Web bundle.',
    bridgeTitle: 'Remote Host Bridge',
    bridgeDesc: 'Enable a single authenticated bridge on this desktop host so Remote Web connects ONCE via Pairing Code and runs all plugins (settings, config, local sidecars) without per-plugin URL/token setup.',
    bridgeToggleLabel: 'Enable Bridge Server',
    bridgeStatusRunning: 'Running',
    bridgeStatusStopped: 'Stopped',
    bridgePortLabel: 'Port',
    bridgeBindLabel: 'Bind Address',
    bridgeBindLocal: 'Local PC only (127.0.0.1)',
    bridgeBindAll: 'LAN / Reverse Proxy (0.0.0.0)',
    bridgePublicUrlLabel: 'Public HTTPS URL (optional, for tunnel/proxy)',
    bridgePublicUrlPlaceholder: 'https://host-bridge.example.com',
    bridgeSave: 'Save Bridge Settings',
    bridgeSaving: 'Saving...',
    bridgeSaved: 'Saved Remote Host Bridge settings.',
    bridgeSaveError: 'Failed to update Remote Host Bridge.',
    bridgePairingLabel: '1-Line Pairing Code (paste in Remote Web -> Addons -> Host Bridge)',
    bridgeCopyPairing: 'Copy Pairing Code',
    bridgeRotateToken: 'Rotate Token',
    bridgeTokenRotated: 'Rotated Remote Host Bridge token. Re-pair Remote Web.',
    copyServeCommand: 'Copy same-Wi-Fi QR command',
    copyExtensionPath: 'Copy extension path',
    copyUserscriptPath: 'Copy userscript path',
    copyBookmarklet: 'Copy bookmarklet',
    userscriptGuide: 'Universal setup (works anywhere): Install public HTTPS addon .user.js releases (auto-updating, multi-addon coexistence), OR transfer the built .user.js file once via cloud/messenger and import it in Userscripts (iOS/iPadOS Safari) or Violentmonkey/Tampermonkey (Android Firefox / Desktop). Once imported, no PC or LAN is needed. (Optional: same-Wi-Fi QR helper only works on the same local network with firewall open; desktop Chrome/Edge fallback: chrome://extensions.)',
    extensionGuide: 'Browser setup: Open chrome://extensions (Edge supported) -> Enable Developer mode -> Load unpacked -> select the copied folder path. After future rebuilds, click Reload on the extension card.',
    copied: 'Copied',
    copyFailed: 'Copy failed',
    loadError: 'Failed to load addon host status.',
    saveError: 'Failed to save Remote Web preference.',
    loading: 'Loading addon status...',
    remotePrefsSaved: 'Saved Remote Web preference.',
    langSwitchAria: 'Addon Manager language',
    langKo: '한국어',
    langEn: 'EN',
  }),
  ko: Object.freeze({
    title: '애드온 관리',
    subtitle: '네이티브 애드온 호스트에서 실행 중인 플러그인 현황과 원격 웹(Remote Web) 표시 여부를 관리합니다.',
    refresh: '새로고침',
    refreshing: '불러오는 중...',
    hostLabel: '호스트',
    buildLabel: '빌드',
    summaryDesktop: '데스크톱 실행 중',
    summaryDesktopSub: '전체 등록',
    summaryRemote: '원격 웹 표시',
    summaryRemoteSub: '원격 지원',
    summaryBundle: '원격 웹 번들',
    bundleUpToDate: '최신 상태',
    bundleNeedsRebuild: '재빌드 필요',
    bundleNotBuilt: '미빌드',
    sectionAddons: '네이티브 호스트 애드온 목록',
    emptyTitle: '등록된 애드온이 없습니다',
    emptyBody: '호스트 CLI로 AddonManifest.v3 / v2 플러그인을 등록하면 이 화면에서 관리할 수 있습니다.',
    openSettings: '설정',
    sectionPluginPages: '플러그인 설정 페이지',
    statusActive: '실행 중',
    statusDisabled: '비활성',
    statusRejected: '차단됨',
    statusFailed: '오류',
    statusPending: '대기 중',
    trustApproved: '신뢰 승인됨',
    trustUnapproved: '승인 필요',
    trustRestricted: '제한 모드',
    capRenderer: '렌더러 UI',
    capMainHook: '메인 훅',
    capSettings: '설정 브리지',
    capConfig: '구성 브리지',
    remoteToggleLabel: '원격 웹 표시',
    remoteToggleOn: '표시함',
    remoteToggleOff: '숨김',
    remoteReasonDesktopOnly: '데스크톱 전용',
    remoteReasonConfigBridge: '로컬 설정 브리지 전용',
    remoteReasonDisabledConfig: '앱 설정에서 꺼짐',
    remoteReasonTrustRequired: '신뢰 승인 필요',
    remoteReasonUnsupported: '원격 웹 미지원',
    remoteReasonUnconfigured: '원격 프로필 미구성',
    syncTitleUpToDate: '원격 웹 번들이 최신 상태입니다',
    syncTitleNeedsRebuild: '원격 웹 번들 재빌드가 필요합니다',
    syncTitleNotBuilt: '원격 웹 번들이 아직 생성되지 않았습니다',
    syncDescUpToDate: '현재 선택한 원격 웹 표시 설정이 최신 번들과 일치합니다. 외부 네트워크(LTE/5G·타 기기)에서 PC 없이 쓰려면 각 애드온의 공개 HTTPS .user.js 릴리스를 1클릭 설치하거나, 빌드된 .user.js 파일 1개를 클라우드·메신저로 옮겨 한 번만 가져오세요.',
    syncDescNeedsRebuild: '변경된 원격 웹 표시 설정은 즉시 저장되었습니다. 아래 명령으로 휴대용 Remote Web Userscript, @require 호스트 라이브러리 및 보조 확장을 재빌드하세요.',
    syncDescNotBuilt: '아래 명령을 실행하면 선택한 애드온이 포함된 휴대용 Remote Web Userscript, @require 호스트 라이브러리 및 보조 브라우저 확장을 생성합니다.',
    copyCommand: '명령 복사',
    rebuildNow: '지금 원격 번들 빌드',
    rebuilding: '빌드 중...',
    rebuildSuccess: '원격 웹 번들을 최신 상태로 다시 빌드했습니다.',
    rebuildError: '원격 웹 번들 빌드에 실패했습니다.',
    bridgeTitle: '원격 호스트 브리지 (통합 원격 연결)',
    bridgeDesc: '네이티브 호스트에서 인증된 단일 브리지 서버를 열면, 원격 웹의 Addons → Host Bridge 탭에서 페어링 코드 한 번만 연결해 모든 플러그인(설정·구성·로컬 사이드카)을 개별 URL/토큰 입력 없이 바로 사용할 수 있습니다.',
    bridgeToggleLabel: '원격 브리지 서버 켜기',
    bridgeStatusRunning: '실행 중',
    bridgeStatusStopped: '중지됨',
    bridgePortLabel: '포트',
    bridgeBindLabel: '바인드 주소',
    bridgeBindLocal: '이 PC 전용 (127.0.0.1)',
    bridgeBindAll: 'LAN / 터널·프록시 허용 (0.0.0.0)',
    bridgePublicUrlLabel: '외부 공개 HTTPS 주소 (선택 · Cloudflare Tunnel/프록시 사용 시)',
    bridgePublicUrlPlaceholder: 'https://host-bridge.example.com',
    bridgeSave: '브리지 설정 저장',
    bridgeSaving: '저장 중...',
    bridgeSaved: '원격 호스트 브리지 설정을 저장했습니다.',
    bridgeSaveError: '원격 호스트 브리지 설정 저장에 실패했습니다.',
    bridgePairingLabel: '페어링 코드 (원격 웹 Addons → Host Bridge 탭에 붙여넣기)',
    bridgeCopyPairing: '페어링 코드 복사',
    bridgeRotateToken: '토큰 재발급',
    bridgeTokenRotated: '원격 호스트 브리지 토큰을 재발급했습니다. 원격 웹을 다시 페어링하세요.',
    copyServeCommand: '같은 Wi-Fi QR 복사 명령',
    copyExtensionPath: '확장 경로 복사',
    copyUserscriptPath: 'Userscript 경로 복사',
    copyBookmarklet: '북마클릿 복사',
    userscriptGuide: '범용 설치(어디서나 동작): 공개 HTTPS 애드온 .user.js(다중 애드온 자동 공존·자동 업데이트)를 설치하거나, 빌드된 .user.js 파일 1개를 클라우드/메신저로 옮겨 iOS Safari(Userscripts)·Android Firefox/데스크톱(Violentmonkey/Tampermonkey)에 한 번만 가져오세요. 설치 후에는 PC나 사설 IP가 필요 없습니다. (보조: 같은 Wi-Fi QR 명령은 동일 네트워크·방화벽 개방 시에만 동작 / 데스크톱 Chrome·Edge: chrome://extensions.)',
    extensionGuide: '브라우저 적용: chrome://extensions 열기(Edge 동일) → 개발자 모드 켜기 → 압축해제된 확장 프로그램 로드 → 복사한 확장 폴더 선택. 재빌드 후에는 확장 카드의 새로고침(↻)만 누르면 됩니다.',
    copied: '복사됨',
    copyFailed: '복사 실패',
    loadError: '애드온 호스트 상태를 불러오지 못했습니다.',
    saveError: '원격 웹 표시 설정 저장에 실패했습니다.',
    loading: '애드온 상태를 불러오는 중...',
    remotePrefsSaved: '원격 웹 표시 설정을 저장했습니다.',
    langSwitchAria: '애드온 관리 언어',
    langKo: '한국어',
    langEn: 'EN',
  }),
});

const PANEL_CSS = `
:host {
  display: block;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", sans-serif;
  color: #f1f5f9;
  --surface-bg: transparent;
  --card-bg: rgba(255, 255, 255, 0.035);
  --card-bg-hover: rgba(255, 255, 255, 0.055);
  --card-border: rgba(255, 255, 255, 0.09);
  --text-primary: #f1f5f9;
  --text-secondary: #94a3b8;
  --text-muted: #64748b;
  --accent: #38bdf8;
  --accent-strong: #0284c7;
  --ok-bg: rgba(34, 197, 94, 0.14);
  --ok-fg: #4ade80;
  --ok-border: rgba(34, 197, 94, 0.3);
  --warn-bg: rgba(245, 158, 11, 0.14);
  --warn-fg: #fbbf24;
  --warn-border: rgba(245, 158, 11, 0.32);
  --err-bg: rgba(239, 68, 68, 0.14);
  --err-fg: #f87171;
  --err-border: rgba(239, 68, 68, 0.3);
  --chip-bg: rgba(148, 163, 184, 0.12);
  --chip-fg: #cbd5e1;
  --switch-off: rgba(148, 163, 184, 0.28);
  --switch-on: #22c55e;
  --focus-ring: #38bdf8;
}

@media (prefers-color-scheme: light) {
  :host([data-theme="light"]) {
    color: #0f172a;
    --card-bg: rgba(15, 23, 42, 0.03);
    --card-bg-hover: rgba(15, 23, 42, 0.055);
    --card-border: rgba(15, 23, 42, 0.12);
    --text-primary: #0f172a;
    --text-secondary: #475569;
    --text-muted: #64748b;
    --ok-bg: rgba(22, 163, 74, 0.12);
    --ok-fg: #15803d;
    --ok-border: rgba(22, 163, 74, 0.28);
    --warn-bg: rgba(217, 119, 6, 0.12);
    --warn-fg: #b45309;
    --warn-border: rgba(217, 119, 6, 0.3);
    --err-bg: rgba(220, 38, 38, 0.12);
    --err-fg: #b91c1c;
    --err-border: rgba(220, 38, 38, 0.28);
    --chip-bg: rgba(15, 23, 42, 0.07);
    --chip-fg: #334155;
    --switch-off: rgba(100, 116, 139, 0.35);
    --switch-on: #16a34a;
  }
}

* {
  box-sizing: border-box;
}

.ah-root {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 24px 32px 28px 28px;
  max-width: 840px;
  color: var(--text-primary);
  overflow-y: auto;
  height: 100%;
  scrollbar-width: thin;
  scrollbar-color: rgba(148, 163, 184, 0.28) transparent;
}

.ah-root::-webkit-scrollbar {
  width: 8px;
}

.ah-root::-webkit-scrollbar-track {
  background: transparent;
}

.ah-root::-webkit-scrollbar-thumb {
  background: rgba(148, 163, 184, 0.25);
  border-radius: 999px;
}

.ah-root::-webkit-scrollbar-thumb:hover {
  background: rgba(148, 163, 184, 0.4);
}

.ah-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding-right: 36px;
  flex-wrap: wrap;
}

.ah-title-wrap {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  flex: 1 1 320px;
}

.ah-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: -0.01em;
  color: var(--text-primary);
}

.ah-subtitle {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.ah-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ah-meta-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: var(--chip-bg);
  color: var(--chip-fg);
  border: 1px solid var(--card-border);
}

.ah-lang-switch {
  display: inline-flex;
  align-items: center;
  padding: 2px;
  border-radius: 8px;
  border: 1px solid var(--card-border);
  background: var(--card-bg);
  gap: 2px;
}

.ah-lang-btn {
  appearance: none;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11.5px;
  font-weight: 500;
  padding: 4px 8px;
  cursor: pointer;
  line-height: 1.2;
  transition: background-color 120ms ease, color 120ms ease;
}

.ah-lang-btn:hover {
  color: var(--text-primary);
}

.ah-lang-btn[aria-pressed="true"] {
  background: var(--accent-strong);
  color: #ffffff;
  font-weight: 600;
}

.ah-lang-btn:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
}

.ah-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--card-border);
  background: var(--card-bg);
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 140ms ease, border-color 140ms ease, opacity 140ms ease;
}

.ah-btn:hover:not(:disabled) {
  background: var(--card-bg-hover);
  border-color: rgba(148, 163, 184, 0.32);
}

.ah-btn:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.ah-btn:disabled {
  opacity: 0.55;
  cursor: default;
}

.ah-btn-primary {
  background: rgba(56, 189, 248, 0.16);
  border-color: rgba(56, 189, 248, 0.35);
  color: #7dd3fc;
}

.ah-btn-primary:hover:not(:disabled) {
  background: rgba(56, 189, 248, 0.24);
  border-color: rgba(56, 189, 248, 0.5);
}

.ah-summary-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

@media (max-width: 640px) {
  .ah-summary-grid {
    grid-template-columns: 1fr;
  }
}

.ah-stat-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 16px;
  border-radius: 12px;
  background: var(--card-bg);
  border: 1px solid var(--card-border);
}

.ah-stat-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
}

.ah-stat-value-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.ah-stat-value {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.2;
  color: var(--text-primary);
}

.ah-stat-value--ok {
  color: var(--ok-fg);
}

.ah-stat-value--warn {
  color: var(--warn-fg);
}

.ah-stat-sub {
  font-size: 11px;
  color: var(--text-muted);
}

.ah-banner {
  padding: 10px 14px;
  border-radius: 10px;
  font-size: 12.5px;
  line-height: 1.45;
  border: 1px solid var(--card-border);
}

.ah-banner--error {
  background: var(--err-bg);
  border-color: var(--err-border);
  color: var(--err-fg);
}

.ah-banner--ok {
  background: var(--ok-bg);
  border-color: var(--ok-border);
  color: var(--ok-fg);
}

.ah-section-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.ah-addon-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ah-addon-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
  border-radius: 12px;
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  transition: border-color 140ms ease, background-color 140ms ease;
}

.ah-addon-card:hover {
  background: var(--card-bg-hover);
  border-color: rgba(148, 163, 184, 0.22);
}

.ah-addon-main {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  flex: 1 1 auto;
}

.ah-addon-top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ah-addon-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.ah-addon-ver {
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--text-secondary);
  background: var(--chip-bg);
  padding: 2px 7px;
  border-radius: 6px;
}

.ah-addon-id {
  font-size: 11.5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--text-muted);
}

.ah-badge-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.ah-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.5;
  border: 1px solid transparent;
}

.ah-badge-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.ah-badge--ok {
  background: var(--ok-bg);
  color: var(--ok-fg);
  border-color: var(--ok-border);
}

.ah-badge--warn {
  background: var(--warn-bg);
  color: var(--warn-fg);
  border-color: var(--warn-border);
}

.ah-badge--err {
  background: var(--err-bg);
  color: var(--err-fg);
  border-color: var(--err-border);
}

.ah-badge--neutral {
  background: var(--chip-bg);
  color: var(--chip-fg);
  border-color: var(--card-border);
}

.ah-addon-control {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  flex: 0 0 auto;
}

.ah-addon-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  flex-wrap: wrap;
}

.ah-plugin-pages-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.ah-toggle-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.ah-toggle-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  white-space: nowrap;
}

.ah-switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  width: 40px;
  height: 22px;
  padding: 2px;
  border: none;
  border-radius: 999px;
  background: var(--switch-off);
  cursor: pointer;
  transition: background-color 150ms ease, opacity 150ms ease;
}

.ah-switch[aria-checked="true"] {
  background: var(--switch-on);
}

.ah-switch:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.ah-switch:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.ah-switch-thumb {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #ffffff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
  transform: translateX(0);
  transition: transform 150ms ease;
}

.ah-switch[aria-checked="true"] .ah-switch-thumb {
  transform: translateX(18px);
}

.ah-toggle-hint {
  font-size: 11px;
  color: var(--text-muted);
  text-align: right;
}

.ah-sync-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px;
  border-radius: 12px;
  background: var(--card-bg);
  border: 1px solid var(--card-border);
}

.ah-sync-card--warn {
  background: rgba(245, 158, 11, 0.08);
  border-color: var(--warn-border);
}

.ah-sync-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.ah-sync-title {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-primary);
}

.ah-sync-desc {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.ah-cmd-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ah-cmd-code {
  flex: 1 1 220px;
  min-width: 0;
  overflow-x: auto;
  white-space: nowrap;
  padding: 7px 11px;
  border-radius: 8px;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: rgba(0, 0, 0, 0.28);
  border: 1px solid var(--card-border);
  color: #e2e8f0;
  user-select: all;
}

.ah-delivery-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ah-bridge-grid {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 10px;
}

@media (max-width: 640px) {
  .ah-bridge-grid {
    grid-template-columns: 1fr;
  }
}

.ah-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ah-field--full {
  grid-column: 1 / -1;
}

.ah-field-label {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text-secondary);
}

.ah-input,
.ah-select {
  width: 100%;
  padding: 7px 10px;
  border-radius: 8px;
  border: 1px solid var(--card-border);
  background: rgba(0, 0, 0, 0.25);
  color: var(--text-primary);
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.ah-input:focus-visible,
.ah-select:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
}

.ah-install-guide {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-secondary);
  background: rgba(15, 23, 42, 0.42);
  border: 1px solid var(--card-border);
}

.ah-empty {
  padding: 28px 20px;
  border-radius: 12px;
  border: 1px dashed var(--card-border);
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ah-empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.ah-empty-body {
  font-size: 12.5px;
  color: var(--text-secondary);
}

@media (prefers-reduced-motion: reduce) {
  .ah-btn,
  .ah-lang-btn,
  .ah-addon-card,
  .ah-switch,
  .ah-switch-thumb {
    transition: none;
  }
}
`;

const INLINE_PLUGIN_PANE_CSS = `
:host {
  all: initial;
  display: block;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  font-family: var(--ag-font, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", sans-serif);
  color: var(--ag-text, #f0f6fc);
}
*, *::before, *::after {
  box-sizing: border-box;
}
.ag-inline-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 24px 32px 28px 28px;
  max-width: 880px;
  height: 100%;
  overflow-y: auto;
  color: var(--ag-text, #f0f6fc);
}
.ag-inline-page--canvas {
  padding: 18px 28px 28px 28px;
  max-width: 1040px;
  gap: 12px;
}
.ag-inline-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--ag-border, rgba(255, 255, 255, 0.1));
}
.ag-inline-header--compact {
  justify-content: space-between;
  padding-bottom: 6px;
  border-bottom: none;
}
.ag-inline-header-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  flex-shrink: 0;
}
.ag-inline-title {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  letter-spacing: -0.015em;
  color: var(--ag-text, #f0f6fc);
}
.ag-inline-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1 1 auto;
  min-height: 0;
}
`;

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeLang(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'ko' || v.startsWith('ko-')) return 'ko';
  if (v === 'en' || v.startsWith('en-')) return 'en';
  return null;
}

function readStoredLanguage(win) {
  try {
    const storage = win && win.localStorage;
    if (storage && typeof storage.getItem === 'function') {
      return normalizeLang(storage.getItem(LANG_STORAGE_KEY));
    }
  } catch (_err) {}
  return null;
}

function writeStoredLanguage(win, lang) {
  try {
    const storage = win && win.localStorage;
    if (storage && typeof storage.setItem === 'function') {
      storage.setItem(LANG_STORAGE_KEY, lang);
      return true;
    }
  } catch (_err) {}
  return false;
}

function resolveLanguage(win, doc, overrideLang) {
  const explicit = normalizeLang(overrideLang);
  if (explicit) return explicit;
  const stored = readStoredLanguage(win);
  if (stored) return stored;
  try {
    const docLang =
      doc && doc.documentElement && doc.documentElement.lang
        ? normalizeLang(String(doc.documentElement.lang))
        : null;
    if (docLang) return docLang;
    const nav = win && win.navigator;
    const navLang = nav
      ? normalizeLang(nav.language || (Array.isArray(nav.languages) ? nav.languages[0] : ''))
      : null;
    if (navLang) return navLang;
  } catch (_err) {}
  return 'en';
}

function applyShieldAttributes(el, extraNoTranslateAttributes) {
  if (!el || typeof el.setAttribute !== 'function') return;
  el.setAttribute(IGNORE_ATTR, 'true');
  el.setAttribute(NO_TRANSLATE_ATTR, 'true');
  el.setAttribute('translate', 'no');
  if (Array.isArray(extraNoTranslateAttributes)) {
    for (let i = 0; i < extraNoTranslateAttributes.length; i += 1) {
      const attr = extraNoTranslateAttributes[i];
      if (typeof attr === 'string' && attr) {
        try {
          el.setAttribute(attr, 'true');
        } catch (_e) {}
      }
    }
  }
}

function resolveRemoteReasonLabel(reason, t) {
  switch (reason) {
    case 'ERR_UNSUPPORTED_HOST_CAPABILITY':
      return t.remoteReasonDesktopOnly;
    case 'ERR_REMOTE_REQUIRES_LOCAL_CONFIG_BRIDGE':
      return t.remoteReasonConfigBridge;
    case 'DISABLED_IN_CONFIG':
      return t.remoteReasonDisabledConfig;
    case 'ERR_TRUST_POLICY_NOT_APPROVED':
    case 'ERR_TRUST_HASH_MISMATCH':
    case 'ERR_TRUST_POLICY_READ_FAILED':
      return t.remoteReasonTrustRequired;
    case 'ERR_REMOTE_PROFILE_UNCONFIGURED':
      return t.remoteReasonUnconfigured;
    default:
      return t.remoteReasonUnsupported;
  }
}

function hasVisibleBackground(el, win) {
  if (!el || !win || typeof win.getComputedStyle !== 'function') return false;
  try {
    const bg = String(win.getComputedStyle(el).backgroundColor || '').trim().toLowerCase();
    if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)' || bg === 'rgba(0,0,0,0)') {
      return false;
    }
    return true;
  } catch (_err) {
    return false;
  }
}

function replaceLeafText(rootEl, nextText, doc) {
  if (!rootEl) return;
  const textNodes = [];
  function walk(node) {
    const list = node && node.childNodes ? node.childNodes : [];
    for (let i = 0; i < list.length; i += 1) {
      const ch = list[i];
      if (!ch) continue;
      if (ch.nodeType === 3) {
        if (String(ch.nodeValue !== undefined ? ch.nodeValue : ch.textContent || '').trim().length > 0) {
          textNodes.push(ch);
        }
      } else if (ch.nodeType === 1) {
        const tag = String(ch.tagName || '').toUpperCase();
        if (tag !== 'SVG' && tag !== 'STYLE' && tag !== 'SCRIPT') {
          walk(ch);
        }
      }
    }
  }
  walk(rootEl);
  if (textNodes.length > 0) {
    for (let i = 0; i < textNodes.length; i += 1) {
      const val = i === 0 ? nextText : '';
      if ('nodeValue' in textNodes[i]) {
        textNodes[i].nodeValue = val;
      } else {
        textNodes[i].textContent = val;
      }
    }
    return;
  }
  // If cloned item contains an SVG icon alongside empty text wrapper, preserve SVG; otherwise replace text cleanly
  const hasSvg = Boolean(rootEl.querySelector && rootEl.querySelector('svg'));
  if (hasSvg && doc && typeof doc.createElement === 'function') {
    const span = doc.createElement('span');
    span.textContent = nextText;
    rootEl.appendChild(span);
    return;
  }
  rootEl.textContent = nextText;
}

function setImportantStyle(el, prop, value) {
  if (!el || !el.style) return;
  if (typeof el.style.setProperty === 'function') {
    el.style.setProperty(prop, value, 'important');
  } else {
    const camel = prop.replace(/-([a-z])/g, (_m, ch) => ch.toUpperCase());
    el.style[camel] = value;
  }
}

function removeStyleProp(el, prop, restoreValue) {
  if (!el || !el.style) return;
  if (typeof el.style.removeProperty === 'function') {
    el.style.removeProperty(prop);
  }
  const camel = prop.replace(/-([a-z])/g, (_m, ch) => ch.toUpperCase());
  el.style[camel] = restoreValue || '';
}

function createHostSettingsUi(doc, win, opts = {}) {
  const hostBridge = opts.hostBridge || null;
  const settingsPageCoordinator = opts.settingsPageCoordinator || null;
  const themeAndI18n = opts.themeAndI18n || null;
  const settingsUiCfg = opts.settingsUi && typeof opts.settingsUi === 'object' ? opts.settingsUi : DEFAULT_SETTINGS_UI_CONFIG;
  const extraNoTranslateAttributes = Array.isArray(opts.extraNoTranslateAttributes) ? opts.extraNoTranslateAttributes : [];
  const anchorGroups =
    Array.isArray(settingsUiCfg.anchorGroups) && settingsUiCfg.anchorGroups.length > 0
      ? settingsUiCfg.anchorGroups
      : DEFAULT_SETTINGS_UI_CONFIG.anchorGroups;

  let disposed = false;
  let started = false;
  let observer = null;
  let domReadyHandler = null;
  let mountTimer = null;

  let mountedListParent = null;
  let mountedOuterSidebar = null;
  let mountedContentPane = null;
  let mountedReferenceItem = null;
  let mountedLang = null;
  let userLangOverride = readStoredLanguage(win);
  let navElement = null;
  let navInactiveColor = '';
  let pluginNavElements = [];
  let unsubSettingsPages = null;
  let unsubInlineHost = null;
  let unsubLocale = null;
  let paneHostElement = null;
  let shadowRoot = null;
  let pluginPaneHostElement = null;
  let pluginShadowRoot = null;
  let activePluginPageKey = null;
  let activePluginCloseFn = null;
  let lastActiveTheme = null;
  let isOpen = false;
  let isLoading = false;
  let lastState = null;
  let lastError = null;
  let flashMessage = null;
  let flashTimer = null;
  let pendingToggleIds = new Set();
  let bridgeBusy = false;
  let rebuildBusy = false;
  let bridgeDraft = null;
  const savedChildDisplay = new WeakMap();
  const suppressedSiblingStyles = new Map(); // el -> { bg, color }
  let clickHostElement = null;
  let listClickHandler = null;

  function getNavLabel(lang) {
    const labels = settingsUiCfg.navLabel;
    if (labels && typeof labels === 'object') {
      if (lang === 'ko' && typeof labels.ko === 'string' && labels.ko.trim()) return labels.ko.trim();
      if (typeof labels.en === 'string' && labels.en.trim()) return labels.en.trim();
    }
    return lang === 'ko' ? DEFAULT_SETTINGS_UI_CONFIG.navLabel.ko : DEFAULT_SETTINGS_UI_CONFIG.navLabel.en;
  }

  function getLanguage() {
    if (themeAndI18n && typeof themeAndI18n.getLocale === 'function') {
      const fromHost = normalizeLang(themeAndI18n.getLocale());
      if (fromHost) return fromHost;
    }
    return resolveLanguage(win, doc, userLangOverride);
  }

  function setLanguage(nextLang) {
    const norm = normalizeLang(nextLang);
    if (!norm) return getLanguage();
    userLangOverride = norm;
    if (themeAndI18n && typeof themeAndI18n.setLocale === 'function') {
      themeAndI18n.setLocale(norm, { persist: true });
    } else {
      writeStoredLanguage(win, norm);
    }
    mountedLang = norm;
    if (navElement && navElement.isConnected) {
      replaceLeafText(navElement, getNavLabel(norm), doc);
    }
    if (!disposed && isOpen) {
      renderPanel();
    }
    return norm;
  }

  function matchAnchorGroupIndex(text) {
    const norm = normalizeText(text);
    if (!norm || norm.length > 48) return -1;
    for (let g = 0; g < anchorGroups.length; g += 1) {
      const group = anchorGroups[g];
      if (!Array.isArray(group)) continue;
      for (let i = 0; i < group.length; i += 1) {
        const candidate = normalizeText(group[i]);
        if (candidate && norm === candidate) {
          return g;
        }
      }
    }
    return -1;
  }

  function unwrapNavItem(el, groupIdx, stopContainer) {
    let cur = el;
    while (
      cur &&
      cur.parentElement &&
      cur.parentElement !== stopContainer &&
      cur.parentElement !== doc.body &&
      cur.parentElement !== doc.documentElement
    ) {
      const parent = cur.parentElement;
      const isSingleChild = parent.children && parent.children.length === 1;
      const isSameAnchorItem =
        parent.children &&
        parent.children.length <= 3 &&
        matchAnchorGroupIndex(parent.textContent) === groupIdx;
      if (isSingleChild || isSameAnchorItem) {
        cur = parent;
      } else {
        break;
      }
    }
    return cur;
  }

  function findSettingsSidebarAndContent() {
    if (!doc || typeof doc.querySelectorAll !== 'function') return null;
    const NAV_CANDIDATE_SEL = 'button, a, [role="tab"], [role="menuitem"], [role="button"], li, div';
    const candidates = doc.querySelectorAll(NAV_CANDIDATE_SEL);
    const matchedLeaves = [];

    for (let i = 0; i < candidates.length; i += 1) {
      const el = candidates[i];
      if (!el || !el.parentElement) continue;
      if (el.children && el.children.length > 2) continue;
      if (el.getAttribute && el.getAttribute(NAV_ATTR) === 'true') continue;
      if (el.closest && el.closest(`[${PANE_ATTR}="true"]`)) continue;
      const groupIdx = matchAnchorGroupIndex(el.textContent);
      if (groupIdx === -1) continue;
      // Keep only the innermost matching node so outer wrappers don't shadow actual clickable items
      let hasMatchingChild = false;
      if (el.children && el.children.length > 0 && typeof el.querySelectorAll === 'function') {
        const desc = el.querySelectorAll(NAV_CANDIDATE_SEL);
        for (let j = 0; j < desc.length; j += 1) {
          if (desc[j] !== el && matchAnchorGroupIndex(desc[j].textContent) !== -1) {
            hasMatchingChild = true;
            break;
          }
        }
      }
      if (hasMatchingChild) continue;
      matchedLeaves.push({ el, groupIdx });
    }

    if (matchedLeaves.length < 2) return null;

    // Group matched leaves by ancestor containers up to depth 4 (handles both direct siblings and wrapped items)
    const byContainer = new Map();
    for (let i = 0; i < matchedLeaves.length; i += 1) {
      const { el, groupIdx } = matchedLeaves[i];
      let container = el.parentElement;
      for (let depth = 0; depth < 4 && container && container !== doc.body && container !== doc.documentElement; depth += 1) {
        let rec = byContainer.get(container);
        if (!rec) {
          rec = { container, depthSum: 0, maxDepth: depth, groups: new Set(), items: [] };
          byContainer.set(container, rec);
        }
        if (!rec.groups.has(groupIdx)) {
          rec.groups.add(groupIdx);
          rec.depthSum += depth;
          if (depth > rec.maxDepth) rec.maxDepth = depth;
          rec.items.push({ el, groupIdx });
        }
        container = container.parentElement;
      }
    }

    let best = null;
    for (const rec of byContainer.values()) {
      if (rec.groups.size < 2) continue;
      if (
        !best ||
        rec.groups.size > best.groups.size ||
        (rec.groups.size === best.groups.size && rec.maxDepth < best.maxDepth) ||
        (rec.groups.size === best.groups.size && rec.maxDepth === best.maxDepth && rec.depthSum < best.depthSum)
      ) {
        best = rec;
      }
    }
    if (!best) return null;

    // Resolve unwrapped sibling items & true listParent inside the matched sidebar container
    const unwrappedItems = best.items.map((entry) => unwrapNavItem(entry.el, entry.groupIdx, best.container));
    const listParentCounts = new Map();
    for (let i = 0; i < unwrappedItems.length; i += 1) {
      const p = unwrappedItems[i].parentElement || best.container;
      listParentCounts.set(p, (listParentCounts.get(p) || 0) + 1);
    }
    let listParent = best.container;
    let bestParentCount = 0;
    for (const [p, count] of listParentCounts.entries()) {
      if (count > bestParentCount) {
        bestParentCount = count;
        listParent = p;
      }
    }
    const directMatchedItems = unwrappedItems.filter((item) => item.parentElement === listParent);
    const matchedList = directMatchedItems.length > 0 ? directMatchedItems : unwrappedItems;

    // Walk up up to 10 levels to locate the 2-pane split container (outerSidebar + largest right-hand contentPane)
    const sidebarRect =
      typeof best.container.getBoundingClientRect === 'function' ? best.container.getBoundingClientRect() : null;
    let cur = listParent;
    let outerSidebar = best.container;
    let contentPane = null;
    for (let depth = 0; depth < 10 && cur && cur.parentElement && cur.parentElement !== doc.documentElement; depth += 1) {
      const container = cur.parentElement;
      const curRect = typeof cur.getBoundingClientRect === 'function' ? cur.getBoundingClientRect() : null;
      const hasLayout = Boolean(curRect && curRect.width > 0 && curRect.height > 0);
      const rightBoundary = hasLayout
        ? Math.max(curRect.right, sidebarRect && sidebarRect.width > 0 ? sidebarRect.right : 0)
        : 0;
      const siblings = Array.from(container.children || []).filter((child) => child !== cur);
      const viableList = siblings.filter((sib) => {
        if (!sib || sib.nodeType !== 1) return false;
        const tag = String(sib.tagName || '').toUpperCase();
        if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'BUTTON' || tag === 'HEADER' || /^H[1-6]$/.test(tag)) {
          return false;
        }
        if (hasLayout && typeof sib.getBoundingClientRect === 'function') {
          const sibRect = sib.getBoundingClientRect();
          if (sibRect.width < 260 || sibRect.height < 200) return false;
          // Require side-by-side placement to the right (or non-overlapping horizontally)
          const horizontalOverlap = Math.min(curRect.right, sibRect.right) - Math.max(curRect.left, sibRect.left);
          if (sibRect.left < rightBoundary - 24 && horizontalOverlap > Math.min(curRect.width, sibRect.width) * 0.5) {
            return false;
          }
          return true;
        }
        // Fallback for non-layout mock DOMs: skip tiny text-only sidebar titles with no element children
        const childCount = sib.children ? sib.children.length : 0;
        const textLen = String(sib.textContent || '').trim().length;
        if (childCount === 0 && textLen < 40 && tag !== 'MAIN') return false;
        return true;
      });
      if (viableList.length > 0) {
        let chosen = viableList[0];
        if (hasLayout) {
          let bestArea = 0;
          for (let i = 0; i < viableList.length; i += 1) {
            const r = viableList[i].getBoundingClientRect();
            const area = r.width * r.height;
            if (area > bestArea) {
              bestArea = area;
              chosen = viableList[i];
            }
          }
        }
        outerSidebar = cur;
        contentPane = chosen;
        break;
      }
      cur = container;
    }

    if (!contentPane) return null;

    // Pick an INACTIVE sibling as clone template so native classes/spacing match with 0px shift
    const inactiveItem =
      matchedList.find((item) => !hasVisibleBackground(item, win) && matchAnchorGroupIndex(item.textContent) !== 0) ||
      matchedList.find((item) => !hasVisibleBackground(item, win)) ||
      matchedList[matchedList.length - 1] ||
      matchedList[0];

    return {
      listParent,
      outerSidebar,
      contentPane,
      referenceItem: inactiveItem,
      lastMatchedItem: matchedList[matchedList.length - 1] || inactiveItem,
    };
  }

  function isCloseButtonElement(el, contentPaneRect) {
    if (!el || el.nodeType !== 1) return false;
    const checkBtn = (btn) => {
      const aria = normalizeText(btn.getAttribute ? btn.getAttribute('aria-label') : '');
      const title = normalizeText(btn.getAttribute ? btn.getAttribute('title') : '');
      const text = normalizeText(btn.textContent);
      if (
        aria.includes('close') ||
        aria.includes('닫기') ||
        title.includes('close') ||
        title.includes('닫기') ||
        text === '×' ||
        text === '✕' ||
        text === 'x'
      ) {
        return true;
      }
      if (contentPaneRect && typeof btn.getBoundingClientRect === 'function') {
        const r = btn.getBoundingClientRect();
        if (r && r.width > 0 && r.width <= 52 && r.height > 0 && r.height <= 52) {
          if (r.right >= contentPaneRect.right - 72 && r.top <= contentPaneRect.top + 72) {
            return true;
          }
        }
      }
      return false;
    };
    const tag = String(el.tagName || '').toUpperCase();
    if (tag === 'BUTTON' && checkBtn(el)) return true;
    if (contentPaneRect && typeof el.getBoundingClientRect === 'function') {
      const r = el.getBoundingClientRect();
      if (
        r &&
        r.width > 0 &&
        r.width <= 64 &&
        r.height > 0 &&
        r.height <= 64 &&
        r.right >= contentPaneRect.right - 72 &&
        r.top <= contentPaneRect.top + 72
      ) {
        const innerBtn = el.querySelector ? el.querySelector('button') : null;
        if (innerBtn && checkBtn(innerBtn)) return true;
      }
    }
    return false;
  }

  function suppressNativeActiveSiblings() {
    let activeBg = 'rgba(255, 255, 255, 0.08)';
    let activeColor = '#f8fafc';
    if (!mountedListParent) return { activeBg, activeColor };

    const dim = (node) => {
      if (!node || !node.style || suppressedSiblingStyles.has(node)) return;
      suppressedSiblingStyles.set(node, {
        bg: node.style.backgroundColor || '',
        color: node.style.color || '',
      });
      setImportantStyle(node, 'background-color', 'transparent');
      if (navInactiveColor) {
        setImportantStyle(node, 'color', navInactiveColor);
      }
    };

    const children = Array.from(mountedListParent.children || []);
    for (let i = 0; i < children.length; i += 1) {
      const sib = children[i];
      if (!sib || sib.nodeType !== 1 || sib === navElement) continue;
      if (sib.getAttribute && (sib.getAttribute(NAV_ATTR) === 'true' || sib.getAttribute(PLUGIN_NAV_ATTR))) continue;
      if (hasVisibleBackground(sib, win)) {
        try {
          const cs = win.getComputedStyle(sib);
          if (cs.backgroundColor) activeBg = cs.backgroundColor;
          if (cs.color) activeColor = cs.color;
        } catch (_e) {}
      }
      dim(sib);
      if (typeof sib.querySelectorAll === 'function') {
        const inners = sib.querySelectorAll('button, span, div, a');
        for (let j = 0; j < inners.length; j += 1) {
          const inner = inners[j];
          if (hasVisibleBackground(inner, win)) {
            try {
              const ics = win.getComputedStyle(inner);
              if (ics.backgroundColor) activeBg = ics.backgroundColor;
              if (ics.color) activeColor = ics.color;
            } catch (_e2) {}
          }
          dim(inner);
        }
      }
    }
    return { activeBg, activeColor };
  }

  function restoreNativeActiveSiblings() {
    for (const [node, saved] of suppressedSiblingStyles.entries()) {
      removeStyleProp(node, 'background-color', saved.bg);
      removeStyleProp(node, 'color', saved.color);
    }
    suppressedSiblingStyles.clear();
  }

  function updateNavVisualState(active, activeTheme) {
    if (!navElement) return;
    navElement.setAttribute('aria-selected', active ? 'true' : 'false');
    navElement.setAttribute('data-active', active ? 'true' : 'false');
    if (active) {
      const bg = (activeTheme && activeTheme.activeBg) || 'rgba(56, 189, 248, 0.14)';
      const fg = (activeTheme && activeTheme.activeColor) || '#f8fafc';
      setImportantStyle(navElement, 'background-color', bg);
      setImportantStyle(navElement, 'color', fg);
    } else {
      removeStyleProp(navElement, 'background-color', '');
      removeStyleProp(navElement, 'color', '');
    }
  }

  function ensureNativeSuppressed() {
    if (suppressedSiblingStyles.size === 0 || !lastActiveTheme) {
      lastActiveTheme = suppressNativeActiveSiblings();
    }
    return lastActiveTheme;
  }

  function updatePluginNavVisualState(selectedKey, activeTheme) {
    for (let i = 0; i < pluginNavElements.length; i += 1) {
      const el = pluginNavElements[i];
      if (!el) continue;
      const key = el.getAttribute ? el.getAttribute(PLUGIN_NAV_ATTR) : null;
      const active = Boolean(selectedKey && key === selectedKey);
      el.setAttribute('aria-selected', active ? 'true' : 'false');
      el.setAttribute('data-active', active ? 'true' : 'false');
      if (active) {
        const bg = (activeTheme && activeTheme.activeBg) || 'rgba(56, 189, 248, 0.14)';
        const fg = (activeTheme && activeTheme.activeColor) || '#f8fafc';
        setImportantStyle(el, 'background-color', bg);
        setImportantStyle(el, 'color', fg);
      } else {
        removeStyleProp(el, 'background-color', '');
        removeStyleProp(el, 'color', '');
      }
    }
  }

  function restoreNativeContentChildren() {
    if (!mountedContentPane) return;
    const children = Array.from(mountedContentPane.children || []);
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      if (child === paneHostElement || child === pluginPaneHostElement) continue;
      if (savedChildDisplay.has(child)) {
        child.style.display = savedChildDisplay.get(child);
        savedChildDisplay.delete(child);
      }
    }
  }

  function hideOtherContentChildren() {
    if (!mountedContentPane) return;
    const paneRect =
      typeof mountedContentPane.getBoundingClientRect === 'function'
        ? mountedContentPane.getBoundingClientRect()
        : null;
    const children = Array.from(mountedContentPane.children || []);
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      if (child === paneHostElement || child === pluginPaneHostElement) continue;
      if (isCloseButtonElement(child, paneRect)) {
        if (child.style) child.style.zIndex = '20';
        continue;
      }
      if (!savedChildDisplay.has(child)) {
        savedChildDisplay.set(child, child.style ? child.style.display || '' : '');
      }
      if (child.style) {
        child.style.display = 'none';
      }
    }
  }

  function clearFlashLater() {
    if (flashTimer) {
      clearTimeout(flashTimer);
      flashTimer = null;
    }
    flashTimer = setTimeout(() => {
      flashTimer = null;
      flashMessage = null;
      if (isOpen) renderPanel();
    }, 2600);
  }

  async function copyText(text, triggerBtn, t) {
    let ok = false;
    try {
      if (win && win.navigator && win.navigator.clipboard && typeof win.navigator.clipboard.writeText === 'function') {
        await win.navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (_err) {
      ok = false;
    }
    if (!ok && doc && typeof doc.createElement === 'function' && typeof doc.execCommand === 'function') {
      try {
        const ta = doc.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', 'true');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        doc.body.appendChild(ta);
        ta.select();
        ok = Boolean(doc.execCommand('copy'));
        ta.remove();
      } catch (_err2) {
        ok = false;
      }
    }
    if (triggerBtn) {
      const prev = triggerBtn.textContent;
      triggerBtn.textContent = ok ? t.copied : t.copyFailed;
      setTimeout(() => {
        if (triggerBtn && triggerBtn.isConnected) {
          triggerBtn.textContent = prev;
        }
      }, 1500);
    }
    return ok;
  }

  async function handleConfigureBridge(patch, t) {
    if (!hostBridge || typeof hostBridge.configureRemoteBridge !== 'function') return;
    if (bridgeBusy) return;
    bridgeBusy = true;
    lastError = null;
    renderPanel();
    try {
      const res = await Promise.resolve(hostBridge.configureRemoteBridge(patch));
      if (res && res.state) {
        lastState = res.state;
        bridgeDraft = null;
      }
      if (res && res.ok === true) {
        flashMessage = t.bridgeSaved;
        clearFlashLater();
      } else {
        lastError = `${t.bridgeSaveError}${res && res.reason ? ` (${res.reason})` : ''}`;
      }
    } catch (err) {
      lastError = `${t.bridgeSaveError}${err && err.message ? ` (${err.message})` : ''}`;
    } finally {
      bridgeBusy = false;
      if (!disposed && isOpen) renderPanel();
    }
  }

  async function handleRotateBridgeToken(t) {
    if (!hostBridge || typeof hostBridge.rotateRemoteBridgeToken !== 'function') return;
    if (bridgeBusy) return;
    bridgeBusy = true;
    lastError = null;
    renderPanel();
    try {
      const res = await Promise.resolve(hostBridge.rotateRemoteBridgeToken());
      if (res && res.state) {
        lastState = res.state;
        bridgeDraft = null;
      }
      if (res && res.ok === true) {
        flashMessage = t.bridgeTokenRotated;
        clearFlashLater();
      } else {
        lastError = `${t.bridgeSaveError}${res && res.reason ? ` (${res.reason})` : ''}`;
      }
    } catch (err) {
      lastError = `${t.bridgeSaveError}${err && err.message ? ` (${err.message})` : ''}`;
    } finally {
      bridgeBusy = false;
      if (!disposed && isOpen) renderPanel();
    }
  }

  async function handleRebuildBundle(t) {
    if (!hostBridge || typeof hostBridge.rebuildRemoteBundle !== 'function') return;
    if (rebuildBusy) return;
    rebuildBusy = true;
    lastError = null;
    renderPanel();
    try {
      const res = await Promise.resolve(hostBridge.rebuildRemoteBundle());
      if (res && res.state) {
        lastState = res.state;
      }
      if (res && res.ok === true) {
        flashMessage = `${t.rebuildSuccess}${res.buildSha8 ? ` (${res.buildSha8})` : ''}`;
        clearFlashLater();
      } else {
        lastError = `${t.rebuildError}${res && res.reason ? ` (${res.reason})` : ''}`;
      }
    } catch (err) {
      lastError = `${t.rebuildError}${err && err.message ? ` (${err.message})` : ''}`;
    } finally {
      rebuildBusy = false;
      if (!disposed && isOpen) renderPanel();
    }
  }

  async function handleToggleRemote(addon, nextEnabled, t) {
    if (!hostBridge || typeof hostBridge.setRemoteAddonPreference !== 'function') return;
    if (pendingToggleIds.has(addon.pluginId)) return;

    pendingToggleIds.add(addon.pluginId);
    lastError = null;
    renderPanel();

    try {
      const res = await Promise.resolve(hostBridge.setRemoteAddonPreference(addon.pluginId, nextEnabled));
      if (res && res.ok === true && res.state) {
        lastState = res.state;
        flashMessage = t.remotePrefsSaved;
        clearFlashLater();
      } else {
        lastError = `${t.saveError}${res && res.reason ? ` (${res.reason})` : ''}`;
      }
    } catch (err) {
      lastError = `${t.saveError}${err && err.message ? ` (${err.message})` : ''}`;
    } finally {
      pendingToggleIds.delete(addon.pluginId);
      if (!disposed && isOpen) {
        renderPanel();
      }
    }
  }

  function createEl(tag, className, text) {
    const el = doc.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined && text !== null) el.textContent = String(text);
    return el;
  }

  function createBadge(text, variant, withDot = false) {
    const badge = createEl('span', `ah-badge ah-badge--${variant}`);
    if (withDot) {
      badge.appendChild(createEl('span', 'ah-badge-dot'));
    }
    badge.appendChild(doc.createTextNode(String(text)));
    return badge;
  }

  function renderPanel() {
    if (!shadowRoot) return;
    const lang = getLanguage();
    const t = COPY[lang] || COPY.en;

    while (shadowRoot.firstChild) {
      shadowRoot.removeChild(shadowRoot.firstChild);
    }

    const styleEl = doc.createElement('style');
    styleEl.textContent = PANEL_CSS;
    shadowRoot.appendChild(styleEl);

    const root = createEl('div', 'ah-root');
    shadowRoot.appendChild(root);

    // 1. Header
    const header = createEl('div', 'ah-header');
    const titleWrap = createEl('div', 'ah-title-wrap');
    titleWrap.appendChild(createEl('h2', 'ah-title', t.title));
    titleWrap.appendChild(createEl('p', 'ah-subtitle', t.subtitle));
    header.appendChild(titleWrap);

    const actions = createEl('div', 'ah-header-actions');
    if (lastState && lastState.host) {
      actions.appendChild(
        createEl('span', 'ah-meta-pill', `${t.hostLabel} v${lastState.host.version || '3.0.1'}`)
      );
      if (lastState.host.buildSha8) {
        actions.appendChild(createEl('span', 'ah-meta-pill', `${t.buildLabel} ${lastState.host.buildSha8}`));
      }
    }
    const langGroup = createEl('div', 'ah-lang-switch');
    langGroup.setAttribute('role', 'group');
    langGroup.setAttribute('aria-label', t.langSwitchAria);
    langGroup.setAttribute('data-ah-control', 'language-switch');
    const langDefs = [
      { code: 'ko', label: t.langKo },
      { code: 'en', label: t.langEn },
    ];
    for (let i = 0; i < langDefs.length; i += 1) {
      const def = langDefs[i];
      const lBtn = createEl('button', 'ah-lang-btn', def.label);
      lBtn.setAttribute('type', 'button');
      lBtn.setAttribute('data-ah-lang', def.code);
      lBtn.setAttribute('aria-pressed', lang === def.code ? 'true' : 'false');
      lBtn.addEventListener('click', () => {
        setLanguage(def.code);
      });
      langGroup.appendChild(lBtn);
    }
    actions.appendChild(langGroup);

    const refreshBtn = createEl('button', 'ah-btn', isLoading ? t.refreshing : t.refresh);
    refreshBtn.setAttribute('type', 'button');
    refreshBtn.disabled = isLoading;
    refreshBtn.addEventListener('click', () => {
      void refresh();
    });
    actions.appendChild(refreshBtn);
    header.appendChild(actions);
    root.appendChild(header);

    if (lastError) {
      const errBanner = createEl('div', 'ah-banner ah-banner--error', lastError);
      errBanner.setAttribute('role', 'alert');
      root.appendChild(errBanner);
    } else if (flashMessage) {
      const okBanner = createEl('div', 'ah-banner ah-banner--ok', flashMessage);
      okBanner.setAttribute('role', 'status');
      root.appendChild(okBanner);
    }

    if (!lastState) {
      root.appendChild(createEl('div', 'ah-empty', isLoading ? t.loading : t.loadError));
      return;
    }

    const summary = lastState.summary || {
      totalCount: 0,
      desktopActiveCount: 0,
      remoteEligibleCount: 0,
      remoteEnabledCount: 0,
    };
    const bundle = lastState.remoteBundle || {
      built: false,
      needsRebuild: true,
      buildSha8: null,
      buildCommand: 'addon-host --build-remote',
      hasBookmarklet: false,
      bookmarkletText: null,
    };

    // 2. Summary cards
    const summaryGrid = createEl('div', 'ah-summary-grid');

    const statDesktop = createEl('div', 'ah-stat-card');
    statDesktop.appendChild(createEl('div', 'ah-stat-label', t.summaryDesktop));
    const desktopRow = createEl('div', 'ah-stat-value-row');
    desktopRow.appendChild(
      createEl('span', 'ah-stat-value ah-stat-value--ok', `${summary.desktopActiveCount} / ${summary.totalCount}`)
    );
    statDesktop.appendChild(desktopRow);
    statDesktop.appendChild(createEl('div', 'ah-stat-sub', `${t.summaryDesktopSub}: ${summary.totalCount}`));
    summaryGrid.appendChild(statDesktop);

    const statRemote = createEl('div', 'ah-stat-card');
    statRemote.appendChild(createEl('div', 'ah-stat-label', t.summaryRemote));
    const remoteRow = createEl('div', 'ah-stat-value-row');
    remoteRow.appendChild(
      createEl('span', 'ah-stat-value', `${summary.remoteEnabledCount} / ${summary.remoteEligibleCount}`)
    );
    statRemote.appendChild(remoteRow);
    statRemote.appendChild(createEl('div', 'ah-stat-sub', `${t.summaryRemoteSub}: ${summary.remoteEligibleCount}`));
    summaryGrid.appendChild(statRemote);

    const statBundle = createEl('div', 'ah-stat-card');
    statBundle.appendChild(createEl('div', 'ah-stat-label', t.summaryBundle));
    const bundleRow = createEl('div', 'ah-stat-value-row');
    const bundleLabel = !bundle.built
      ? t.bundleNotBuilt
      : bundle.needsRebuild
        ? t.bundleNeedsRebuild
        : t.bundleUpToDate;
    const bundleValueClass = !bundle.built || bundle.needsRebuild ? 'ah-stat-value ah-stat-value--warn' : 'ah-stat-value ah-stat-value--ok';
    bundleRow.appendChild(createEl('span', bundleValueClass, bundleLabel));
    statBundle.appendChild(bundleRow);
    statBundle.appendChild(
      createEl('div', 'ah-stat-sub', bundle.buildSha8 ? `SHA ${bundle.buildSha8}` : 'remote-dist')
    );
    summaryGrid.appendChild(statBundle);

    root.appendChild(summaryGrid);

    // 3. Addon list
    const registeredPages =
      settingsPageCoordinator && typeof settingsPageCoordinator.listSettingsPages === 'function'
        ? settingsPageCoordinator.listSettingsPages()
        : [];
    const pagesByPlugin = new Map();
    for (let p = 0; p < registeredPages.length; p += 1) {
      const pg = registeredPages[p];
      if (!pg || !pg.pluginId) continue;
      if (!pagesByPlugin.has(pg.pluginId)) pagesByPlugin.set(pg.pluginId, []);
      pagesByPlugin.get(pg.pluginId).push(pg);
    }
    const renderedPageKeys = new Set();

    root.appendChild(createEl('h3', 'ah-section-title', t.sectionAddons));
    const addons = Array.isArray(lastState.addons) ? lastState.addons : [];
    if (addons.length === 0) {
      const empty = createEl('div', 'ah-empty');
      empty.appendChild(createEl('div', 'ah-empty-title', t.emptyTitle));
      empty.appendChild(createEl('div', 'ah-empty-body', t.emptyBody));
      root.appendChild(empty);
    } else {
      const list = createEl('div', 'ah-addon-list');
      for (let i = 0; i < addons.length; i += 1) {
        const addon = addons[i];
        const card = createEl('div', 'ah-addon-card');
        card.setAttribute('data-plugin-id', addon.pluginId);

        const main = createEl('div', 'ah-addon-main');
        const top = createEl('div', 'ah-addon-top');
        top.appendChild(createEl('span', 'ah-addon-name', addon.displayName || addon.pluginId));
        top.appendChild(createEl('span', 'ah-addon-ver', `v${addon.version || '0.0.0'}`));
        if (addon.displayName && addon.displayName !== addon.pluginId) {
          top.appendChild(createEl('span', 'ah-addon-id', addon.pluginId));
        }
        main.appendChild(top);

        const badges = createEl('div', 'ah-badge-row');
        if (addon.desktopStatus === 'active') {
          badges.appendChild(createBadge(t.statusActive, 'ok', true));
        } else if (addon.desktopStatus === 'disabled') {
          badges.appendChild(createBadge(t.statusDisabled, 'neutral', true));
        } else if (addon.desktopStatus === 'rejected') {
          badges.appendChild(createBadge(t.statusRejected, 'err', true));
        } else if (addon.desktopStatus === 'failed') {
          badges.appendChild(createBadge(t.statusFailed, 'err', true));
        } else {
          badges.appendChild(createBadge(t.statusPending, 'warn', true));
        }

        if (addon.trustLevel === 'trusted') {
          badges.appendChild(
            createBadge(addon.trustApproved ? t.trustApproved : t.trustUnapproved, addon.trustApproved ? 'neutral' : 'warn')
          );
        } else {
          badges.appendChild(createBadge(t.trustRestricted, 'neutral'));
        }

        const caps = Array.isArray(addon.capabilities) ? addon.capabilities : [];
        if (caps.includes('renderer')) badges.appendChild(createBadge(t.capRenderer, 'neutral'));
        if (caps.includes('mainHook')) badges.appendChild(createBadge(t.capMainHook, 'neutral'));
        if (addon.hasSettingsBridge) badges.appendChild(createBadge(t.capSettings, 'neutral'));
        if (addon.hasConfigBridge) badges.appendChild(createBadge(t.capConfig, 'neutral'));
        main.appendChild(badges);
        card.appendChild(main);

        // Right control: Plugin Settings Page button(s) + Remote Web visibility toggle
        const ctrl = createEl('div', 'ah-addon-control');
        const pluginPages = pagesByPlugin.get(addon.pluginId) || [];
        if (pluginPages.length > 0 && settingsPageCoordinator && typeof settingsPageCoordinator.openSettingsPage === 'function') {
          const actionRow = createEl('div', 'ah-addon-actions');
          for (let j = 0; j < pluginPages.length; j += 1) {
            const page = pluginPages[j];
            const pageKey = `${addon.pluginId}:${page.id}`;
            renderedPageKeys.add(pageKey);
            const btnLabel = pluginPages.length === 1 ? t.openSettings : page.title;
            const openBtn = createEl('button', 'ah-btn ah-btn-primary', btnLabel);
            openBtn.setAttribute('type', 'button');
            openBtn.setAttribute('title', page.title);
            openBtn.setAttribute('aria-label', page.title);
            openBtn.setAttribute('data-ah-settings-page', pageKey);
            openBtn.addEventListener('click', () => {
              settingsPageCoordinator.openSettingsPage(addon.pluginId, page.id);
            });
            actionRow.appendChild(openBtn);
          }
          ctrl.appendChild(actionRow);
        }
        const toggleRow = createEl('div', 'ah-toggle-row');
        const toggleLabel = createEl('span', 'ah-toggle-label', t.remoteToggleLabel);
        toggleRow.appendChild(toggleLabel);

        const isPending = pendingToggleIds.has(addon.pluginId);
        const switchBtn = createEl('button', 'ah-switch');
        switchBtn.setAttribute('type', 'button');
        switchBtn.setAttribute('role', 'switch');
        switchBtn.setAttribute('aria-label', `${addon.displayName || addon.pluginId} ${t.remoteToggleLabel}`);
        switchBtn.setAttribute('aria-checked', addon.remoteEnabled ? 'true' : 'false');
        switchBtn.setAttribute('data-remote-toggle', addon.pluginId);
        if (isPending) switchBtn.setAttribute('aria-busy', 'true');
        switchBtn.disabled = !addon.remoteToggleable || isPending;
        switchBtn.appendChild(createEl('span', 'ah-switch-thumb'));

        if (addon.remoteToggleable) {
          switchBtn.addEventListener('click', () => {
            void handleToggleRemote(addon, !addon.remoteEnabled, t);
          });
        }
        toggleRow.appendChild(switchBtn);
        ctrl.appendChild(toggleRow);

        const hintText = addon.remoteToggleable
          ? addon.remoteEnabled
            ? t.remoteToggleOn
            : t.remoteToggleOff
          : resolveRemoteReasonLabel(addon.remoteBlockedReason, t);
        ctrl.appendChild(createEl('div', 'ah-toggle-hint', hintText));
        card.appendChild(ctrl);

        list.appendChild(card);
      }
      root.appendChild(list);
    }

    const extraPages = registeredPages.filter((pg) => pg && !renderedPageKeys.has(`${pg.pluginId}:${pg.id}`));
    if (extraPages.length > 0 && settingsPageCoordinator && typeof settingsPageCoordinator.openSettingsPage === 'function') {
      root.appendChild(createEl('h3', 'ah-section-title', t.sectionPluginPages));
      const extraBar = createEl('div', 'ah-plugin-pages-bar');
      for (let e = 0; e < extraPages.length; e += 1) {
        const pg = extraPages[e];
        const pageKey = `${pg.pluginId}:${pg.id}`;
        const btn = createEl('button', 'ah-btn ah-btn-primary', pg.title);
        btn.setAttribute('type', 'button');
        btn.setAttribute('data-ah-settings-page', pageKey);
        btn.addEventListener('click', () => {
          settingsPageCoordinator.openSettingsPage(pg.pluginId, pg.id);
        });
        extraBar.appendChild(btn);
      }
      root.appendChild(extraBar);
    }

    // 3.5 Native Host Remote Bridge Card
    const rb = lastState.remoteBridge && typeof lastState.remoteBridge === 'object' ? lastState.remoteBridge : null;
    if (rb) {
      if (!bridgeDraft) {
        bridgeDraft = {
          port: String(rb.port || 19384),
          bindHost: rb.bindHost || '127.0.0.1',
          publicUrl: rb.publicUrl || '',
        };
      }
      const bridgeCard = createEl('div', 'ah-sync-card');
      bridgeCard.setAttribute('data-ah-section', 'remote-bridge');
      const bridgeHead = createEl('div', 'ah-sync-head');
      bridgeHead.appendChild(createEl('h3', 'ah-sync-title', t.bridgeTitle));

      const bridgeHeadRight = createEl('div', 'ah-toggle-row');
      const statusText = rb.running
        ? `${t.bridgeStatusRunning} · :${rb.listeningPort || rb.port}`
        : t.bridgeStatusStopped;
      bridgeHeadRight.appendChild(createBadge(statusText, rb.running ? 'ok' : 'neutral', true));

      const bridgeSwitch = createEl('button', 'ah-switch');
      bridgeSwitch.setAttribute('type', 'button');
      bridgeSwitch.setAttribute('role', 'switch');
      bridgeSwitch.setAttribute('aria-label', t.bridgeToggleLabel);
      bridgeSwitch.setAttribute('aria-checked', rb.enabled ? 'true' : 'false');
      bridgeSwitch.setAttribute('data-ah-bridge-toggle', '1');
      bridgeSwitch.disabled = bridgeBusy || typeof hostBridge.configureRemoteBridge !== 'function';
      bridgeSwitch.appendChild(createEl('span', 'ah-switch-thumb'));
      bridgeSwitch.addEventListener('click', () => {
        const nextPort = Number(bridgeDraft.port);
        void handleConfigureBridge(
          {
            enabled: !rb.enabled,
            bindHost: bridgeDraft.bindHost,
            ...(Number.isInteger(nextPort) ? { port: nextPort } : {}),
            publicUrl: bridgeDraft.publicUrl,
          },
          t
        );
      });
      bridgeHeadRight.appendChild(bridgeSwitch);
      bridgeHead.appendChild(bridgeHeadRight);
      bridgeCard.appendChild(bridgeHead);

      bridgeCard.appendChild(createEl('p', 'ah-sync-desc', t.bridgeDesc));
      if (rb.error) {
        const bErr = createEl('div', 'ah-banner ah-banner--error', String(rb.error));
        bridgeCard.appendChild(bErr);
      }

      const formGrid = createEl('div', 'ah-bridge-grid');

      const portField = createEl('label', 'ah-field');
      portField.appendChild(createEl('span', 'ah-field-label', t.bridgePortLabel));
      const portInput = createEl('input', 'ah-input');
      portInput.setAttribute('type', 'number');
      portInput.setAttribute('min', '1024');
      portInput.setAttribute('max', '65535');
      portInput.setAttribute('data-ah-bridge-port', '1');
      portInput.value = bridgeDraft.port;
      portInput.addEventListener('input', () => {
        bridgeDraft.port = String(portInput.value || '').trim();
      });
      portField.appendChild(portInput);
      formGrid.appendChild(portField);

      const bindField = createEl('label', 'ah-field');
      bindField.appendChild(createEl('span', 'ah-field-label', t.bridgeBindLabel));
      const bindSelect = createEl('select', 'ah-select');
      bindSelect.setAttribute('data-ah-bridge-bind', '1');
      const optLocal = createEl('option', null, t.bridgeBindLocal);
      optLocal.value = '127.0.0.1';
      const optAll = createEl('option', null, t.bridgeBindAll);
      optAll.value = '0.0.0.0';
      bindSelect.appendChild(optLocal);
      bindSelect.appendChild(optAll);
      bindSelect.value = bridgeDraft.bindHost === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
      bindSelect.addEventListener('change', () => {
        bridgeDraft.bindHost = bindSelect.value === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
      });
      bindField.appendChild(bindSelect);
      formGrid.appendChild(bindField);

      const pubField = createEl('label', 'ah-field ah-field--full');
      pubField.appendChild(createEl('span', 'ah-field-label', t.bridgePublicUrlLabel));
      const pubInput = createEl('input', 'ah-input');
      pubInput.setAttribute('type', 'url');
      pubInput.setAttribute('placeholder', t.bridgePublicUrlPlaceholder);
      pubInput.setAttribute('data-ah-bridge-public-url', '1');
      pubInput.value = bridgeDraft.publicUrl;
      pubInput.addEventListener('input', () => {
        bridgeDraft.publicUrl = String(pubInput.value || '').trim();
      });
      pubField.appendChild(pubInput);
      formGrid.appendChild(pubField);

      bridgeCard.appendChild(formGrid);

      const bridgeActions = createEl('div', 'ah-delivery-row');
      const saveBridgeBtn = createEl('button', 'ah-btn ah-btn-primary', bridgeBusy ? t.bridgeSaving : t.bridgeSave);
      saveBridgeBtn.setAttribute('type', 'button');
      saveBridgeBtn.setAttribute('data-ah-bridge-save', '1');
      saveBridgeBtn.disabled = bridgeBusy || typeof hostBridge.configureRemoteBridge !== 'function';
      saveBridgeBtn.addEventListener('click', () => {
        const nextPort = Number(bridgeDraft.port);
        void handleConfigureBridge(
          {
            enabled: rb.enabled,
            bindHost: bridgeDraft.bindHost,
            ...(Number.isInteger(nextPort) ? { port: nextPort } : {}),
            publicUrl: bridgeDraft.publicUrl,
          },
          t
        );
      });
      bridgeActions.appendChild(saveBridgeBtn);

      if (typeof rb.pairingCode === 'string' && rb.pairingCode.length > 0) {
        const copyPairBtn = createEl('button', 'ah-btn ah-btn-primary', t.bridgeCopyPairing);
        copyPairBtn.setAttribute('type', 'button');
        copyPairBtn.setAttribute('data-ah-bridge-copy-pairing', '1');
        copyPairBtn.addEventListener('click', () => {
          void copyText(rb.pairingCode, copyPairBtn, t);
        });
        bridgeActions.appendChild(copyPairBtn);
      }

      if (typeof hostBridge.rotateRemoteBridgeToken === 'function') {
        const rotateBtn = createEl('button', 'ah-btn', t.bridgeRotateToken);
        rotateBtn.setAttribute('type', 'button');
        rotateBtn.setAttribute('data-ah-bridge-rotate-token', '1');
        rotateBtn.disabled = bridgeBusy;
        rotateBtn.addEventListener('click', () => {
          void handleRotateBridgeToken(t);
        });
        bridgeActions.appendChild(rotateBtn);
      }
      bridgeCard.appendChild(bridgeActions);

      if (rb.connectUrl) {
        const maskedHint = `${t.bridgePairingLabel}: ${rb.connectUrl}${rb.tokenHint ? ` · token ${rb.tokenHint}` : ''}`;
        bridgeCard.appendChild(createEl('p', 'ah-install-guide', maskedHint));
      }

      root.appendChild(bridgeCard);
    }

    // 4. Remote Web Bundle Sync Footer
    const needsAttention = !bundle.built || bundle.needsRebuild;
    const syncCard = createEl('div', needsAttention ? 'ah-sync-card ah-sync-card--warn' : 'ah-sync-card');
    const syncHead = createEl('div', 'ah-sync-head');
    const syncTitleText = !bundle.built
      ? t.syncTitleNotBuilt
      : bundle.needsRebuild
        ? t.syncTitleNeedsRebuild
        : t.syncTitleUpToDate;
    syncHead.appendChild(createEl('h3', 'ah-sync-title', syncTitleText));
    syncHead.appendChild(createBadge(bundleLabel, needsAttention ? 'warn' : 'ok', true));
    syncCard.appendChild(syncHead);

    const syncDescText = !bundle.built
      ? t.syncDescNotBuilt
      : bundle.needsRebuild
        ? t.syncDescNeedsRebuild
        : t.syncDescUpToDate;
    syncCard.appendChild(createEl('p', 'ah-sync-desc', syncDescText));

    const cmdRow = createEl('div', 'ah-cmd-row');
    const buildCmd = bundle.buildCommand || 'addon-host --build-remote';
    cmdRow.appendChild(createEl('code', 'ah-cmd-code', buildCmd));

    if (typeof hostBridge.rebuildRemoteBundle === 'function' && bundle.canRebuildInApp !== false) {
      const rebuildBtn = createEl(
        'button',
        needsAttention ? 'ah-btn ah-btn-primary' : 'ah-btn',
        rebuildBusy ? t.rebuilding : t.rebuildNow
      );
      rebuildBtn.setAttribute('type', 'button');
      rebuildBtn.setAttribute('data-ah-action', 'rebuild-bundle');
      rebuildBtn.disabled = rebuildBusy;
      rebuildBtn.addEventListener('click', () => {
        void handleRebuildBundle(t);
      });
      cmdRow.appendChild(rebuildBtn);
    }

    const copyCmdBtn = createEl('button', needsAttention && typeof hostBridge.rebuildRemoteBundle !== 'function' ? 'ah-btn ah-btn-primary' : 'ah-btn', t.copyCommand);
    copyCmdBtn.setAttribute('type', 'button');
    copyCmdBtn.setAttribute('data-ah-action', 'copy-command');
    copyCmdBtn.addEventListener('click', () => {
      void copyText(buildCmd, copyCmdBtn, t);
    });
    cmdRow.appendChild(copyCmdBtn);
    syncCard.appendChild(cmdRow);

    const canCopyExtension = Boolean(
      bundle.built && bundle.hasExtension && typeof bundle.extensionDir === 'string' && bundle.extensionDir.length > 0
    );
    const canCopyUserscript = Boolean(
      bundle.built && bundle.hasUserscript && typeof bundle.userscriptPath === 'string' && bundle.userscriptPath.length > 0
    );
    const canCopyServeCommand = Boolean(
      canCopyUserscript && typeof bundle.serveCommand === 'string' && bundle.serveCommand.length > 0
    );
    const canCopyBookmarklet = Boolean(
      typeof bundle.bookmarkletText === 'string' &&
        bundle.bookmarkletText.length > 0 &&
        (bundle.bookmarkletRunnable === true ||
          (bundle.bookmarkletRunnable === undefined &&
            bundle.hasBookmarklet === true &&
            bundle.bookmarkletText.length <= 65536))
    );

    if (canCopyUserscript || canCopyServeCommand || canCopyExtension || canCopyBookmarklet) {
      const deliveryRow = createEl('div', 'ah-delivery-row');
      if (canCopyUserscript) {
        const copyUserBtn = createEl(
          'button',
          !needsAttention ? 'ah-btn ah-btn-primary' : 'ah-btn',
          t.copyUserscriptPath
        );
        copyUserBtn.setAttribute('type', 'button');
        copyUserBtn.setAttribute('data-ah-action', 'copy-userscript-path');
        copyUserBtn.addEventListener('click', () => {
          void copyText(bundle.userscriptPath, copyUserBtn, t);
        });
        deliveryRow.appendChild(copyUserBtn);
      }
      if (canCopyServeCommand) {
        const copyServeBtn = createEl('button', 'ah-btn', t.copyServeCommand);
        copyServeBtn.setAttribute('type', 'button');
        copyServeBtn.setAttribute('data-ah-action', 'copy-serve-command');
        copyServeBtn.addEventListener('click', () => {
          void copyText(bundle.serveCommand, copyServeBtn, t);
        });
        deliveryRow.appendChild(copyServeBtn);
      }
      if (canCopyExtension) {
        const copyExtBtn = createEl(
          'button',
          !needsAttention && !canCopyUserscript ? 'ah-btn ah-btn-primary' : 'ah-btn',
          t.copyExtensionPath
        );
        copyExtBtn.setAttribute('type', 'button');
        copyExtBtn.setAttribute('data-ah-action', 'copy-extension-path');
        copyExtBtn.addEventListener('click', () => {
          void copyText(bundle.extensionDir, copyExtBtn, t);
        });
        deliveryRow.appendChild(copyExtBtn);
      }
      if (canCopyBookmarklet) {
        const copyBmBtn = createEl('button', 'ah-btn', t.copyBookmarklet);
        copyBmBtn.setAttribute('type', 'button');
        copyBmBtn.setAttribute('data-ah-action', 'copy-bookmarklet');
        copyBmBtn.addEventListener('click', () => {
          void copyText(bundle.bookmarkletText, copyBmBtn, t);
        });
        deliveryRow.appendChild(copyBmBtn);
      }
      syncCard.appendChild(deliveryRow);
    }

    if (canCopyUserscript) {
      syncCard.appendChild(createEl('p', 'ah-install-guide', t.userscriptGuide));
    } else if (canCopyExtension) {
      syncCard.appendChild(createEl('p', 'ah-install-guide', t.extensionGuide));
    }

    root.appendChild(syncCard);
  }

  async function refresh() {
    if (disposed || !hostBridge || typeof hostBridge.getHostAdminState !== 'function') {
      return { ok: false, reason: 'ERR_HOST_ADMIN_UNAVAILABLE' };
    }
    const lang = getLanguage();
    const t = COPY[lang] || COPY.en;
    isLoading = true;
    lastError = null;
    if (isOpen) renderPanel();

    try {
      const res = await Promise.resolve(hostBridge.getHostAdminState());
      if (res && res.ok === true) {
        lastState = res;
        bridgeDraft = null;
      } else {
        lastError = `${t.loadError}${res && res.reason ? ` (${res.reason})` : ''}`;
      }
      return res;
    } catch (err) {
      lastError = `${t.loadError}${err && err.message ? ` (${err.message})` : ''}`;
      return { ok: false, reason: err && err.message ? err.message : String(err) };
    } finally {
      isLoading = false;
      if (!disposed && isOpen) {
        renderPanel();
      }
    }
  }

  function closePluginPane({ restoreNative = true } = {}) {
    if (!activePluginPageKey && !activePluginCloseFn && !pluginPaneHostElement) return false;
    const closer = activePluginCloseFn;
    activePluginCloseFn = null;
    activePluginPageKey = null;
    updatePluginNavVisualState(null);
    if (pluginShadowRoot) {
      while (pluginShadowRoot.firstChild) pluginShadowRoot.removeChild(pluginShadowRoot.firstChild);
    }
    if (pluginPaneHostElement && pluginPaneHostElement.style) {
      pluginPaneHostElement.style.display = 'none';
    }
    if (typeof closer === 'function') {
      try {
        closer();
      } catch (_err) {}
    }
    if (restoreNative && !isOpen) {
      restoreNativeActiveSiblings();
      lastActiveTheme = null;
      restoreNativeContentChildren();
    }
    return true;
  }

  function canMountInline() {
    return Boolean(!disposed && mountedContentPane && mountedContentPane.isConnected);
  }

  function mountInlinePage({ pluginMeta, pageId, key, title, kind, spec, showLocaleSwitch = true, onClosed }) {
    if (!canMountInline()) return null;

    closePanel({ restoreNative: false });
    closePluginPane({ restoreNative: false });

    const activeTheme = ensureNativeSuppressed();
    hideOtherContentChildren();

    if (!pluginPaneHostElement || pluginPaneHostElement.parentElement !== mountedContentPane) {
      pluginPaneHostElement = doc.createElement('div');
      pluginPaneHostElement.setAttribute(PLUGIN_PANE_ATTR, 'true');
      applyShieldAttributes(pluginPaneHostElement, extraNoTranslateAttributes);
      pluginPaneHostElement.style.width = '100%';
      pluginPaneHostElement.style.height = '100%';
      pluginPaneHostElement.style.overflow = 'hidden';
      pluginShadowRoot =
        typeof pluginPaneHostElement.attachShadow === 'function'
          ? pluginPaneHostElement.attachShadow({ mode: 'open' })
          : pluginPaneHostElement;
      mountedContentPane.appendChild(pluginPaneHostElement);
    }
    pluginPaneHostElement.setAttribute('data-addon-host-owner', pluginMeta.pluginId);
    pluginPaneHostElement.setAttribute('data-addon-host-settings-page', key);

    while (pluginShadowRoot.firstChild) {
      pluginShadowRoot.removeChild(pluginShadowRoot.firstChild);
    }

    const tokenCss = themeAndI18n ? themeAndI18n.buildTokenCss(themeAndI18n.getSnapshot().mode) : '';
    const styleEl = doc.createElement('style');
    styleEl.textContent = `${tokenCss}\n${SCHEMA_UI_CSS}\n${INLINE_PLUGIN_PANE_CSS}`;
    pluginShadowRoot.appendChild(styleEl);

    const isCanvas = kind === 'canvas';
    const pageWrap = createEl('div', isCanvas ? 'ag-inline-page ag-inline-page--canvas' : 'ag-inline-page');
    const header = createEl('div', isCanvas ? 'ag-inline-header ag-inline-header--compact' : 'ag-inline-header');
    let titleEl = null;
    if (!isCanvas) {
      titleEl = createEl('h2', 'ag-inline-title', title);
      header.appendChild(titleEl);
    }
    const headerActions = createEl('div', 'ag-inline-header-actions');
    const badge = createEl('span', 'ag-ui-attribution', `Addon: ${String(pluginMeta.displayName || pluginMeta.pluginId)}`);
    badge.setAttribute('data-addon-host-attribution', '1');
    headerActions.appendChild(badge);

    let localeSwitch = null;
    if (showLocaleSwitch !== false && themeAndI18n && typeof themeAndI18n.setLocale === 'function') {
      localeSwitch = createHeaderLocaleSwitch(doc, themeAndI18n);
      headerActions.appendChild(localeSwitch.element);
    }
    header.appendChild(headerActions);
    pageWrap.appendChild(header);

    const bodyEl = createEl('div', 'ag-inline-body');
    pageWrap.appendChild(bodyEl);
    pluginShadowRoot.appendChild(pageWrap);

    let closed = false;
    let schemaController = null;
    let unsubTitleLocale = null;
    if (titleEl && spec && typeof spec.getTitle === 'function' && themeAndI18n && typeof themeAndI18n.onLocaleDidChange === 'function') {
      try {
        unsubTitleLocale = themeAndI18n.onLocaleDidChange(() => {
          if (closed || !titleEl) return;
          try {
            const nextTitle = spec.getTitle();
            if (typeof nextTitle === 'string' && nextTitle.trim()) {
              titleEl.textContent = nextTitle.trim();
            }
          } catch (_e) {}
        });
      } catch (_e) {
        unsubTitleLocale = null;
      }
    }

    const notifyClosedOnce = () => {
      if (closed) return;
      closed = true;
      if (typeof unsubTitleLocale === 'function') {
        try {
          unsubTitleLocale();
        } catch (_e) {}
        unsubTitleLocale = null;
      }
      if (localeSwitch && typeof localeSwitch.dispose === 'function') {
        try {
          localeSwitch.dispose();
        } catch (_e) {}
        localeSwitch = null;
      }
      if (typeof onClosed === 'function') {
        try {
          onClosed();
        } catch (_e) {}
      }
      if (spec && typeof spec.onClose === 'function') {
        try {
          spec.onClose();
        } catch (_e) {}
      }
    };

    const handle = Object.freeze({
      kind: 'inline-settings',
      element: pluginPaneHostElement,
      bodyEl,
      attributionBadge: badge,
      getPlacement: () => null,
      reposition: () => null,
      update(nextTree, nextState) {
        if (closed || !schemaController) return;
        schemaController.update(nextTree, nextState);
      },
      setTitle(nextTitle) {
        if (!closed && titleEl && typeof nextTitle === 'string') {
          titleEl.textContent = nextTitle;
        }
      },
      getState: () => (schemaController ? schemaController.getState() : null),
      getElementById: (nodeId) => (schemaController ? schemaController.getElementById(nodeId) : null),
      close() {
        if (closed) return false;
        if (activePluginPageKey === key) {
          closePluginPane({ restoreNative: true });
        } else {
          notifyClosedOnce();
        }
        return true;
      },
    });

    activePluginPageKey = key;
    activePluginCloseFn = notifyClosedOnce;
    pluginPaneHostElement.style.display = 'block';
    updateNavVisualState(false);
    updatePluginNavVisualState(key, activeTheme);

    if (!isCanvas) {
      const tree = typeof spec.getSchema === 'function' ? spec.getSchema() : spec.schema;
      const state = typeof spec.getState === 'function' ? spec.getState() : spec.state || {};
      schemaController = createSchemaUiController(doc, bodyEl, {
        tree,
        state,
        onChange: spec.onChange || null,
        onAction: spec.onAction || null,
      });
    } else if (typeof spec.render === 'function') {
      spec.render(bodyEl, handle);
    }

    return handle;
  }

  function openPanel() {
    if (disposed || !mountedContentPane) return false;
    closePluginPane({ restoreNative: false });
    const activeTheme = ensureNativeSuppressed();
    hideOtherContentChildren();

    if (!paneHostElement || paneHostElement.parentElement !== mountedContentPane) {
      paneHostElement = doc.createElement('div');
      paneHostElement.setAttribute(PANE_ATTR, 'true');
      applyShieldAttributes(paneHostElement, extraNoTranslateAttributes);
      paneHostElement.style.width = '100%';
      paneHostElement.style.height = '100%';
      paneHostElement.style.overflow = 'hidden';
      shadowRoot = paneHostElement.attachShadow({ mode: 'open' });
      mountedContentPane.appendChild(paneHostElement);
    }
    paneHostElement.style.display = 'block';
    isOpen = true;
    updateNavVisualState(true, activeTheme);
    updatePluginNavVisualState(null);
    renderPanel();
    void refresh();
    return true;
  }

  function closePanel({ restoreNative = true } = {}) {
    if (!isOpen && !paneHostElement) return false;
    isOpen = false;
    updateNavVisualState(false);
    if (paneHostElement && paneHostElement.style) {
      paneHostElement.style.display = 'none';
    }
    if (restoreNative && !activePluginPageKey) {
      restoreNativeActiveSiblings();
      lastActiveTheme = null;
      restoreNativeContentChildren();
    }
    return true;
  }

  function detachNavListeners() {
    if (clickHostElement && listClickHandler) {
      try {
        clickHostElement.removeEventListener('click', listClickHandler, true);
      } catch (_err) {}
    }
    clickHostElement = null;
    listClickHandler = null;
  }

  function buildNavItem(referenceItem, lang) {
    let btn;
    if (referenceItem && typeof referenceItem.cloneNode === 'function') {
      btn = referenceItem.cloneNode(true);
      btn.removeAttribute('id');
      btn.removeAttribute('aria-current');
      btn.removeAttribute('data-state');
      btn.removeAttribute('data-active');
      if (btn.tagName && String(btn.tagName).toUpperCase() === 'BUTTON') {
        btn.setAttribute('type', 'button');
      }
      if (typeof btn.querySelectorAll === 'function') {
        const innerBtns = btn.querySelectorAll('button');
        for (let i = 0; i < innerBtns.length; i += 1) {
          innerBtns[i].removeAttribute('id');
          innerBtns[i].setAttribute('type', 'button');
        }
      }
      replaceLeafText(btn, getNavLabel(lang), doc);
    } else {
      btn = doc.createElement('button');
      btn.setAttribute('type', 'button');
      btn.textContent = getNavLabel(lang);
    }

    btn.setAttribute(NAV_ATTR, 'true');
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', 'false');
    applyShieldAttributes(btn, extraNoTranslateAttributes);
    if (btn.style && !btn.style.cursor) {
      btn.style.cursor = 'pointer';
    }

    btn.addEventListener('click', (ev) => {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
      openPanel();
    });

    return btn;
  }

  function findInsertReferenceAfterSettingsGroup(listParent, lastMatchedItem) {
    if (!listParent || !lastMatchedItem || lastMatchedItem.parentElement !== listParent) {
      return null;
    }
    let anchor = lastMatchedItem;
    const siblings = Array.from(listParent.children || []);
    let idx = siblings.indexOf(anchor);
    if (idx === -1) return null;
    // Stay cleanly after any adjacent peer addon slot nav items mounted right after the settings group
    while (idx + 1 < siblings.length) {
      const next = siblings[idx + 1];
      if (
        next &&
        next.getAttribute &&
        (next.getAttribute('data-addon-host-slot') || next.getAttribute('data-addon-host-owner'))
      ) {
        idx += 1;
        anchor = next;
      } else {
        break;
      }
    }
    return idx + 1 < siblings.length ? siblings[idx + 1] : null;
  }

  function removePluginNavItems() {
    for (let i = 0; i < pluginNavElements.length; i += 1) {
      const el = pluginNavElements[i];
      if (el && el.parentNode && typeof el.parentNode.removeChild === 'function') {
        try {
          el.parentNode.removeChild(el);
        } catch (_err) {}
      }
    }
    pluginNavElements = [];
  }

  function buildPluginNavItem(referenceItem, page) {
    let btn;
    if (referenceItem && typeof referenceItem.cloneNode === 'function') {
      btn = referenceItem.cloneNode(true);
      btn.removeAttribute('id');
      btn.removeAttribute('aria-current');
      btn.removeAttribute('data-state');
      btn.removeAttribute('data-active');
      if (btn.tagName && String(btn.tagName).toUpperCase() === 'BUTTON') {
        btn.setAttribute('type', 'button');
      }
      if (typeof btn.querySelectorAll === 'function') {
        const innerBtns = btn.querySelectorAll('button');
        for (let i = 0; i < innerBtns.length; i += 1) {
          innerBtns[i].removeAttribute('id');
          innerBtns[i].setAttribute('type', 'button');
        }
      }
      replaceLeafText(btn, page.title, doc);
    } else {
      btn = doc.createElement('button');
      btn.setAttribute('type', 'button');
      btn.textContent = page.title;
    }

    const pageKey = `${page.pluginId}:${page.id}`;
    btn.setAttribute(PLUGIN_NAV_ATTR, pageKey);
    btn.setAttribute('data-addon-host-owner', page.pluginId);
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', 'false');
    applyShieldAttributes(btn, extraNoTranslateAttributes);
    if (btn.style && !btn.style.cursor) {
      btn.style.cursor = 'pointer';
    }

    btn.addEventListener('click', (ev) => {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
      if (settingsPageCoordinator && typeof settingsPageCoordinator.openSettingsPage === 'function') {
        settingsPageCoordinator.openSettingsPage(page.pluginId, page.id);
      }
    });

    return btn;
  }

  function syncPluginNavItems() {
    if (disposed || !mountedListParent || !mountedListParent.isConnected || !navElement || !navElement.isConnected) {
      return;
    }
    removePluginNavItems();
    if (!settingsPageCoordinator || typeof settingsPageCoordinator.listSettingsPages !== 'function') {
      return;
    }
    const pages = settingsPageCoordinator.listSettingsPages();
    if (!Array.isArray(pages) || pages.length === 0) return;

    let anchor = navElement;
    for (let i = 0; i < pages.length; i += 1) {
      const page = pages[i];
      if (!page || !page.pluginId || !page.id) continue;
      const btn = buildPluginNavItem(mountedReferenceItem, page);
      const nextSib = anchor.nextSibling || null;
      if (nextSib && typeof mountedListParent.insertBefore === 'function') {
        mountedListParent.insertBefore(btn, nextSib);
      } else if (typeof mountedListParent.appendChild === 'function') {
        mountedListParent.appendChild(btn);
      }
      pluginNavElements.push(btn);
      anchor = btn;
    }
    if (activePluginPageKey) {
      updatePluginNavVisualState(activePluginPageKey, lastActiveTheme);
    }
  }

  function ensureMount() {
    if (disposed || !doc) return false;

    if (navElement && navElement.isConnected && mountedListParent && mountedListParent.isConnected) {
      const liveLang = getLanguage();
      if (liveLang !== mountedLang) {
        mountedLang = liveLang;
        replaceLeafText(navElement, getNavLabel(liveLang), doc);
        if (isOpen) renderPanel();
      }
      return true;
    }

    // Previous Settings modal was unmounted; clean stale references
    closePluginPane({ restoreNative: false });
    restoreNativeActiveSiblings();
    lastActiveTheme = null;
    detachNavListeners();
    removePluginNavItems();
    navElement = null;
    navInactiveColor = '';
    paneHostElement = null;
    shadowRoot = null;
    pluginPaneHostElement = null;
    pluginShadowRoot = null;
    mountedListParent = null;
    mountedOuterSidebar = null;
    mountedContentPane = null;
    mountedReferenceItem = null;
    mountedLang = null;
    isOpen = false;

    const found = findSettingsSidebarAndContent();
    if (!found) return false;

    const { listParent, outerSidebar, contentPane, referenceItem, lastMatchedItem } = found;
    const existing = listParent.querySelector ? listParent.querySelector(`[${NAV_ATTR}="true"]`) : null;
    if (existing) {
      navElement = existing;
      mountedListParent = listParent;
      mountedOuterSidebar = outerSidebar || listParent;
      mountedContentPane = contentPane;
      mountedReferenceItem = referenceItem || null;
      mountedLang = getLanguage();
      syncPluginNavItems();
      return true;
    }

    const lang = getLanguage();
    try {
      if (referenceItem && win && typeof win.getComputedStyle === 'function') {
        navInactiveColor = String(win.getComputedStyle(referenceItem).color || '');
      }
    } catch (_e) {
      navInactiveColor = '';
    }
    const btn = buildNavItem(referenceItem, lang);
    const insertRef = findInsertReferenceAfterSettingsGroup(listParent, lastMatchedItem);
    if (insertRef && typeof listParent.insertBefore === 'function') {
      listParent.insertBefore(btn, insertRef);
    } else {
      listParent.appendChild(btn);
    }

    mountedListParent = listParent;
    mountedOuterSidebar = outerSidebar || listParent;
    mountedContentPane = contentPane;
    mountedReferenceItem = referenceItem || null;
    mountedLang = lang;
    navElement = btn;
    syncPluginNavItems();

    // Close our panels smoothly whenever the user selects any other tab/item in the sidebar (native OR peer addon)
    const clickHost = mountedOuterSidebar || listParent;
    clickHostElement = clickHost;
    listClickHandler = (ev) => {
      const target = ev && ev.target;
      if (!target || !navElement || (!isOpen && !activePluginPageKey)) return;
      if (target === navElement || (navElement.contains && navElement.contains(target))) {
        return;
      }
      for (let i = 0; i < pluginNavElements.length; i += 1) {
        const pNav = pluginNavElements[i];
        if (pNav && (target === pNav || (pNav.contains && pNav.contains(target)))) {
          return;
        }
      }
      if (clickHost && clickHost.contains && clickHost.contains(target)) {
        closePanel({ restoreNative: false });
        closePluginPane({ restoreNative: true });
        if (!isOpen && !activePluginPageKey) {
          restoreNativeActiveSiblings();
          lastActiveTheme = null;
          restoreNativeContentChildren();
        }
      }
    };
    clickHost.addEventListener('click', listClickHandler, true);
    return true;
  }

  function scheduleEnsureMount() {
    if (disposed || mountTimer) return;
    mountTimer = setTimeout(() => {
      mountTimer = null;
      if (!disposed) ensureMount();
    }, 30);
  }

  function start() {
    if (disposed || started) return false;
    started = true;
    if (settingsPageCoordinator && typeof settingsPageCoordinator.setInlineHost === 'function') {
      unsubInlineHost = settingsPageCoordinator.setInlineHost({
        canMountInline,
        mountInlinePage,
      });
    }
    if (settingsPageCoordinator && typeof settingsPageCoordinator.onChange === 'function') {
      unsubSettingsPages = settingsPageCoordinator.onChange(() => {
        if (disposed) return;
        syncPluginNavItems();
        if (isOpen) renderPanel();
      });
    }
    if (themeAndI18n && typeof themeAndI18n.onLocaleDidChange === 'function') {
      unsubLocale = themeAndI18n.onLocaleDidChange((nextLoc) => {
        if (disposed) return;
        const norm = normalizeLang(nextLoc) || getLanguage();
        userLangOverride = norm;
        mountedLang = norm;
        if (navElement && navElement.isConnected) {
          replaceLeafText(navElement, getNavLabel(norm), doc);
        }
        syncPluginNavItems();
        if (isOpen) renderPanel();
      });
    }
    ensureMount();
    const MO = (win && win.MutationObserver) || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
    const observeTarget = doc && (doc.documentElement || doc.body);
    if (MO && observeTarget) {
      observer = new MO(() => {
        scheduleEnsureMount();
      });
      observer.observe(observeTarget, {
        childList: true,
        subtree: true,
      });
    }
    if (doc && doc.readyState === 'loading' && typeof doc.addEventListener === 'function') {
      domReadyHandler = () => {
        domReadyHandler = null;
        if (!disposed) ensureMount();
      };
      doc.addEventListener('DOMContentLoaded', domReadyHandler, { once: true });
    }
    return true;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (mountTimer) {
      clearTimeout(mountTimer);
      mountTimer = null;
    }
    if (flashTimer) {
      clearTimeout(flashTimer);
      flashTimer = null;
    }
    if (domReadyHandler && doc && typeof doc.removeEventListener === 'function') {
      try {
        doc.removeEventListener('DOMContentLoaded', domReadyHandler);
      } catch (_err) {}
      domReadyHandler = null;
    }
    if (observer) {
      try {
        observer.disconnect();
      } catch (_err) {}
      observer = null;
    }
    if (unsubInlineHost) {
      try {
        unsubInlineHost();
      } catch (_err) {}
      unsubInlineHost = null;
    }
    if (unsubSettingsPages) {
      try {
        unsubSettingsPages();
      } catch (_err) {}
      unsubSettingsPages = null;
    }
    if (unsubLocale) {
      try {
        unsubLocale();
      } catch (_err) {}
      unsubLocale = null;
    }
    closePluginPane({ restoreNative: false });
    closePanel({ restoreNative: true });
    restoreNativeActiveSiblings();
    lastActiveTheme = null;
    detachNavListeners();
    removePluginNavItems();
    if (navElement && navElement.parentNode) {
      try {
        navElement.parentNode.removeChild(navElement);
      } catch (_err) {}
    }
    if (paneHostElement && paneHostElement.parentNode) {
      try {
        paneHostElement.parentNode.removeChild(paneHostElement);
      } catch (_err) {}
    }
    if (pluginPaneHostElement && pluginPaneHostElement.parentNode) {
      try {
        pluginPaneHostElement.parentNode.removeChild(pluginPaneHostElement);
      } catch (_err) {}
    }
    navElement = null;
    navInactiveColor = '';
    paneHostElement = null;
    shadowRoot = null;
    pluginPaneHostElement = null;
    pluginShadowRoot = null;
    mountedListParent = null;
    mountedOuterSidebar = null;
    mountedContentPane = null;
    mountedReferenceItem = null;
    mountedLang = null;
  }

  return Object.freeze({
    start,
    ensureMount,
    openPanel,
    closePanel,
    closePluginPane,
    refresh,
    dispose,
    getLanguage,
    setLanguage,
    isMounted: () => Boolean(navElement && navElement.isConnected),
    isOpen: () => isOpen,
    getActivePluginPageKey: () => activePluginPageKey,
    getElements: () => ({
      navElement,
      pluginNavElements: pluginNavElements.slice(),
      paneHostElement,
      shadowRoot,
      pluginPaneHostElement,
      pluginShadowRoot,
    }),
  });
}

module.exports = {
  NAV_ATTR,
  PLUGIN_NAV_ATTR,
  PANE_ATTR,
  PLUGIN_PANE_ATTR,
  LANG_STORAGE_KEY,
  DEFAULT_SETTINGS_UI_CONFIG,
  createHostSettingsUi,
};
