'use strict';

/**
 * Deterministic GitHub Pages 1-Click Hub & Curated All-in-One Userscript Builder (v3.0.0).
 *
 * - Builds static 1-Click Hub (`docs/hub/index.html`, `docs/hub/hub.js`, `docs/hub/hub-manifest.json`).
 * - Zero inline `<script>` tags (external `hub.js` only, clean CSP compatibility).
 * - Automatically detects Desktop vs. Remote Web vs. Safari and routes Safari users
 *   exclusively to the Official Curated All-in-One `.user.js` (no external `@require #sha256=` SRI
 *   dependency until Safari Userscripts SRI support is empirically verified).
 * - Provides `buildCuratedAllInOneUserscript(...)` that wraps packed addons with:
 *   1. `drawerShadowMode: 'closed'` Shadow DOM isolation, and
 *   2. `GM_*` closure shadowing (`const GM_xmlhttpRequest = undefined, GM_getValue = undefined, ...`)
 *      around every plugin's `run(ctx)` body so plugins cannot bypass `AddonContextV3.net` or `storage`.
 * - `--check` mode verifies byte-exact equality against committed `docs/hub/`.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  ANTIGRAVITY_REMOTE_WEB_PROFILE,
  toBrowserRemoteWebProfile,
} = require('../src/profiles/antigravity-remote-web');
const {
  buildRemoteRuntimeBundleSource,
  normalizeConnectHosts,
} = require('./build-remote');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_HUB_DIR = path.join(REPO_ROOT, 'docs', 'hub');
const DEFAULT_RELEASE_BASE = 'https://github.com/jaeseongs95/antigravity-addons/releases/latest/download';

function toLf(text) {
  return String(text || '').replace(/\r\n/g, '\n');
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function readHostVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '3.0.0';
  } catch (_e) {
    return '3.0.0';
  }
}

/**
 * Builds an Official Curated All-in-One `.user.js` bundle with:
 * - `drawerShadowMode: 'closed'`
 * - Strict `GM_*` & `GM` closure shadowing inside every addon's `run` function
 * - No external `@require` dependencies (safe on Safari Userscripts, iOS/iPadOS, Violentmonkey, Tampermonkey)
 */
function buildCuratedAllInOneUserscript({
  profile = ANTIGRAVITY_REMOTE_WEB_PROFILE,
  packedAddons = [],
  connectHosts = [],
  version = readHostVersion(),
  updateBaseUrl = DEFAULT_RELEASE_BASE,
  bundleName = 'Antigravity Addons — Curated All-in-One',
} = {}) {
  const browserProfile = toBrowserRemoteWebProfile(profile);
  const safeConnects = normalizeConnectHosts(connectHosts);
  const matchLines = (browserProfile.allowedOrigins || []).map((o) => `// @match        ${o}/*`);
  const grants = ['GM_getValue', 'GM_setValue', 'GM_deleteValue'];
  if (safeConnects.length > 0) grants.push('GM_xmlhttpRequest');

  // Shadow GM_* & unsafeWindow inside every curated addon's closure so plugins MUST use AddonContextV3
  const shadowedAddons = (Array.isArray(packedAddons) ? packedAddons : []).map((addon) => ({
    ...addon,
    rendererSource: [
      '(function(addonHost, GM, GM_xmlhttpRequest, GM_getValue, GM_setValue, GM_deleteValue, GM_addStyle, unsafeWindow) {',
      '  "use strict";',
      toLf(addon.rendererSource || ''),
      '})(addonHost, undefined, undefined, undefined, undefined, undefined, undefined, undefined);',
    ].join('\n'),
  }));

  const runtimeSource = buildRemoteRuntimeBundleSource({
    profile,
    packedAddons: shadowedAddons,
    drawerShadowMode: 'closed',
  });

  const headerLines = [
    '// ==UserScript==',
    `// @name         ${bundleName}`,
    '// @namespace    https://github.com/jaeseongs95/antigravity-addons',
    `// @version      ${version}`,
    '// @description  Official Curated All-in-One Remote Web Userscript (closed Shadow DOM, GM_* closure shadowing, Safari-compatible).',
    ...matchLines,
    '// @run-at       document-idle',
    '// @inject-into  content',
    ...grants.map((g) => `// @grant        ${g}`),
    ...safeConnects.map((h) => `// @connect      ${h}`),
    `// @updateURL    ${updateBaseUrl}/antigravity-curated-all-in-one.meta.js`,
    `// @downloadURL  ${updateBaseUrl}/antigravity-curated-all-in-one.user.js`,
    '// ==/UserScript==',
    '',
  ];

  return toLf(headerLines.join('\n') + runtimeSource);
}

function buildHubFiles({
  version = readHostVersion(),
  releaseBaseUrl = DEFAULT_RELEASE_BASE,
  hostLibSha256 = null,
} = {}) {
  const hostLibUrl = hostLibSha256
    ? `${releaseBaseUrl}/antigravity-remote-host.lib.js#sha256=${hostLibSha256}`
    : `${releaseBaseUrl}/antigravity-remote-host.lib.js`;
  const curatedUrl = `${releaseBaseUrl}/antigravity-curated-all-in-one.user.js`;
  const hostOnlyUrl = `${releaseBaseUrl}/antigravity-remote-host.user.js`;

  const manifest = {
    schemaVersion: 1,
    hostVersion: version,
    releaseBaseUrl,
    safariRequiresCuratedBundle: true,
    channels: {
      curatedAllInOne: {
        id: 'curated-all-in-one',
        title: 'Official Curated All-in-One (.user.js)',
        url: curatedUrl,
        shadowMode: 'closed',
        gmClosureShadowing: true,
        requiresExternalSri: false,
        safariSupported: true,
      },
      modularHostLib: {
        id: 'modular-host-lib',
        title: 'Modular @require Host Library (SRI-Pinned)',
        url: hostLibUrl,
        hostLibSha256: hostLibSha256 || null,
        requiresExternalSri: true,
        safariSupported: false,
      },
      hostOnlyUserscript: {
        id: 'host-only-userscript',
        title: 'Host-Only Remote Web Userscript (.user.js)',
        url: hostOnlyUrl,
        safariSupported: true,
      },
      desktopCli: {
        installCommand: 'npx antigravity-addons --install',
        reconcileCommand: 'npx antigravity-addons --reconcile --handoff --relaunch',
      },
    },
  };

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Antigravity Addons — 1-Click Install Hub (v${version})</title>
  <style>
    :root {
      color-scheme: dark light;
      --bg: #0d1117;
      --surface: #161b22;
      --border: rgba(240, 246, 252, 0.14);
      --text: #f0f6fc;
      --muted: #8b949e;
      --accent: #38bdf8;
      --accent-fg: #082f49;
      --warn-bg: rgba(251, 191, 36, 0.14);
      --warn-fg: #fbbf24;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f8fafc;
        --surface: #ffffff;
        --border: rgba(15, 23, 42, 0.14);
        --text: #0f172a;
        --muted: #475569;
        --accent: #0284c7;
        --accent-fg: #ffffff;
        --warn-bg: rgba(217, 119, 6, 0.12);
        --warn-fg: #b45309;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 32px 20px;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }
    main { max-width: 840px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    h1, h2 { margin: 0; }
    p { margin: 0; color: var(--muted); }
    .badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      background: rgba(56, 189, 248, 0.16);
      color: var(--accent);
      width: fit-content;
    }
    .notice {
      padding: 12px 14px;
      border-radius: 8px;
      background: var(--warn-bg);
      color: var(--warn-fg);
      font-size: 13px;
    }
    .notice[hidden] { display: none; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; }
    a.btn, button.btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 40px;
      padding: 8px 16px;
      border-radius: 8px;
      font-weight: 600;
      font-size: 14px;
      text-decoration: none;
      cursor: pointer;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--text);
    }
    a.btn.primary {
      background: var(--accent);
      color: var(--accent-fg);
      border-color: transparent;
    }
    a.btn[aria-disabled="true"] {
      opacity: 0.45;
      pointer-events: none;
    }
    pre {
      margin: 0;
      padding: 12px;
      border-radius: 8px;
      background: rgba(127, 127, 127, 0.12);
      overflow-x: auto;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <main>
    <header class="card">
      <span class="badge" id="hub-env-badge">Detecting environment...</span>
      <h1>Antigravity Addons — 1-Click Install Hub</h1>
      <p>API-First AddonManifest.v3 Host Framework (v${version}) for Desktop &amp; Remote Web.</p>
      <div class="notice" id="hub-safari-notice" hidden>
        Safari detected: External <code>@require #sha256=</code> SRI links are hidden on Safari until Userscripts SRI support is verified. Use the Official Curated All-in-One <code>.user.js</code> bundle below.
      </div>
    </header>

    <section class="card" id="hub-remote-curated">
      <h2>1. Remote Web — Official Curated All-in-One (Recommended)</h2>
      <p>Single self-contained <code>.user.js</code> with closed Shadow DOM, <code>GM_*</code> closure shadowing, and zero external <code>@require</code> dependencies. Works on Safari (iOS/iPadOS/macOS), Violentmonkey, and Tampermonkey.</p>
      <div class="actions">
        <a class="btn primary" id="btn-curated-install" href="${curatedUrl}">Install Curated All-in-One (.user.js)</a>
        <a class="btn" id="btn-host-only-install" href="${hostOnlyUrl}">Install Host-Only (.user.js)</a>
      </div>
    </section>

    <section class="card" id="hub-remote-modular">
      <h2>2. Remote Web — Modular SRI-Pinned @require (Chromium / Firefox)</h2>
      <p>For Violentmonkey / Tampermonkey users installing individual modular addon Userscripts pinned via SHA-256 SRI.</p>
      <div class="actions">
        <a class="btn" id="btn-modular-lib" href="${hostLibUrl}">Download SRI-Pinned Host Library</a>
      </div>
    </section>

    <section class="card" id="hub-desktop">
      <h2>3. Native Desktop App (Windows / macOS / Linux)</h2>
      <p>Install or recover the native Desktop host after an app auto-update without losing addons or trust pins.</p>
      <pre><code>npx antigravity-addons --install
npx antigravity-addons --reconcile --handoff --relaunch</code></pre>
    </section>
  </main>
  <script src="./hub.js" defer></script>
</body>
</html>
`;

  const hubJs = `'use strict';
(function initAddonHub() {
  function detectBrowserEnv(ua) {
    var s = String(ua || '');
    var isSafari = /Safari\\//i.test(s) && !/Chrome\\/|Chromium\\/|Edg\\/|Firefox\\/|OPR\\//i.test(s);
    var isMobile = /iPhone|iPad|iPod|Android/i.test(s);
    return { isSafari: isSafari, isMobile: isMobile };
  }

  function applyHubRouting(doc, nav) {
    var env = detectBrowserEnv(nav && nav.userAgent);
    var badge = doc.getElementById('hub-env-badge');
    var safariNotice = doc.getElementById('hub-safari-notice');
    var modularSection = doc.getElementById('hub-remote-modular');
    var modularBtn = doc.getElementById('btn-modular-lib');

    if (badge) {
      badge.textContent = env.isSafari
        ? 'Safari detected — Curated All-in-One Recommended'
        : env.isMobile
          ? 'Mobile browser detected — Remote Web Ready'
          : 'Desktop / Chromium / Firefox — All Channels Available';
    }
    if (env.isSafari) {
      if (safariNotice) safariNotice.removeAttribute('hidden');
      if (modularSection) modularSection.setAttribute('hidden', 'true');
      if (modularBtn) modularBtn.setAttribute('aria-disabled', 'true');
    }
    return env;
  }

  if (typeof document !== 'undefined' && typeof navigator !== 'undefined') {
    applyHubRouting(document, navigator);
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { detectBrowserEnv: detectBrowserEnv, applyHubRouting: applyHubRouting };
  }
})();
`;

  return {
    'index.html': toLf(html),
    'hub.js': toLf(hubJs),
    'hub-manifest.json': toLf(JSON.stringify(manifest, null, 2) + '\n'),
  };
}

function buildHubToDir(targetDir = DEFAULT_HUB_DIR, opts = {}) {
  const files = buildHubFiles(opts);
  fs.mkdirSync(targetDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(targetDir, rel), content, 'utf8');
  }
  return { ok: true, targetDir, files: Object.keys(files).sort() };
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const files = buildHubFiles();
  if (checkOnly) {
    const diffs = [];
    for (const [rel, expected] of Object.entries(files)) {
      const full = path.join(DEFAULT_HUB_DIR, rel);
      if (!fs.existsSync(full)) {
        diffs.push(`MISSING docs/hub/${rel}`);
      } else {
        const actual = toLf(fs.readFileSync(full, 'utf8'));
        if (sha256Hex(actual) !== sha256Hex(expected)) {
          diffs.push(`DRIFT docs/hub/${rel}`);
        }
      }
    }
    if (diffs.length > 0) {
      process.stderr.write(`HUB_DRIFT_DETECTED:\n${diffs.join('\n')}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(JSON.stringify({ ok: true, mode: 'check', fileCount: Object.keys(files).length }) + '\n');
    return;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hub-'));
  try {
    buildHubToDir(tmpDir);
    buildHubToDir(DEFAULT_HUB_DIR);
    process.stdout.write(JSON.stringify({ ok: true, mode: 'build', fileCount: Object.keys(files).length }) + '\n');
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_e) {}
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_HUB_DIR,
  buildCuratedAllInOneUserscript,
  buildHubFiles,
  buildHubToDir,
};
