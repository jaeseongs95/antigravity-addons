'use strict';
(function initAddonHub() {
  function detectBrowserEnv(ua) {
    var s = String(ua || '');
    var isSafari = /Safari\//i.test(s) && !/Chrome\/|Chromium\/|Edg\/|Firefox\/|OPR\//i.test(s);
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
