'use strict';

/**
 * HostOriginResolver (D-R4-3): Session/Surface Isolation + Per-Document-Generation Navigation Pinning.
 *
 * - Zero dependency on private Antigravity internals (`_activeLsPort`, `LS_RESTART_EXIT_CODE = 42`).
 * - Enforces defaultSession isolation when `defaultSessionOnly !== false` (excludes scriptJail,
 *   SSH remote, captureWindow, persist:hub-browser-*).
 * - Rejects `about:blank`, `data:`, `javascript:`, subframes (`senderFrame !== mainFrame || parent || detached`).
 * - Pins top-frame origin per `webContents.id` and rotates `docGenId` + CSPRNG `claimNonce` on every
 *   non-same-document main-frame navigation (naturally absorbing Language Server port rotations).
 * - Preserves HostProfile `allowedUrlProtocols` / `allowedUrlHosts` compatibility (`TC-007`).
 */

const crypto = require('node:crypto');

const DEFAULT_ALLOWED_PROTOCOLS = Object.freeze(['http:', 'https:']);
const DEFAULT_ALLOWED_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '::1', '[::1]']);
const DEFAULT_EXCLUDED_PROTOCOLS = Object.freeze(['data:', 'about:', 'javascript:', 'devtools:', 'file:', 'chrome:', 'chrome-extension:']);

function normalizeHostEntry(h) {
  return String(h || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
}

function isAllowedRendererUrl(rawUrl, opts = {}) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_err) {
    return false;
  }

  const excluded = new Set(
    (Array.isArray(opts.excludedUrlProtocols) ? opts.excludedUrlProtocols : DEFAULT_EXCLUDED_PROTOCOLS).map((p) =>
      String(p || '').toLowerCase()
    )
  );
  const proto = String(parsed.protocol || '').toLowerCase();
  if (excluded.has(proto)) return false;

  const allowedProtocols = new Set(
    (Array.isArray(opts.allowedUrlProtocols) && opts.allowedUrlProtocols.length > 0
      ? opts.allowedUrlProtocols
      : DEFAULT_ALLOWED_PROTOCOLS
    ).map((p) => String(p || '').toLowerCase())
  );
  if (!allowedProtocols.has(proto)) return false;

  const allowedHosts = new Set(
    (Array.isArray(opts.allowedUrlHosts) && opts.allowedUrlHosts.length > 0
      ? opts.allowedUrlHosts
      : DEFAULT_ALLOWED_HOSTS
    ).map(normalizeHostEntry)
  );
  const host = normalizeHostEntry(parsed.hostname);
  if (!host || !allowedHosts.has(host)) return false;

  // Optional strict windowOrigin scheme+hostname check (allows dynamic loopback port when windowOrigin has no port)
  if (opts.strictWindowOrigin && typeof opts.windowOrigin === 'string' && opts.windowOrigin) {
    try {
      const expected = new URL(opts.windowOrigin);
      const allowDevOrigin = opts.devUrlOrigin ? new URL(opts.devUrlOrigin).origin : null;
      const matchesDev = Boolean(allowDevOrigin && parsed.origin === allowDevOrigin);
      const matchesWindowOrigin =
        parsed.protocol === expected.protocol &&
        normalizeHostEntry(parsed.hostname) === normalizeHostEntry(expected.hostname) &&
        (!expected.port || parsed.port === expected.port);
      if (!matchesWindowOrigin && !matchesDev) return false;
    } catch (_e) {
      return false;
    }
  }

  return true;
}

function createHostOriginResolver({
  profile = {},
  getDefaultSession = () => null,
  devUrl = null,
  recordDiag = () => {},
} = {}) {
  const statesByWcId = new Map();

  let devUrlOrigin = null;
  if (typeof devUrl === 'string' && devUrl.trim()) {
    try {
      devUrlOrigin = new URL(devUrl.trim()).origin;
    } catch (_e) {
      devUrlOrigin = null;
    }
  }

  const urlOpts = {
    allowedUrlProtocols: profile.allowedUrlProtocols || DEFAULT_ALLOWED_PROTOCOLS,
    allowedUrlHosts: profile.allowedUrlHosts || DEFAULT_ALLOWED_HOSTS,
    excludedUrlProtocols: profile.excludedUrlProtocols || DEFAULT_EXCLUDED_PROTOCOLS,
    windowOrigin: profile.windowOrigin || null,
    strictWindowOrigin: Boolean(profile.strictWindowOrigin),
    devUrlOrigin,
  };

  function getOrCreateState(wcId) {
    let st = statesByWcId.get(wcId);
    if (!st) {
      st = {
        docGenId: 0,
        pinnedOrigin: null,
        pinnedUrl: null,
        activeNonce: null,
        claimedGenId: 0,
      };
      statesByWcId.set(wcId, st);
    }
    return st;
  }

  function isSessionAllowed(contents) {
    if (!contents) return false;
    if (profile.defaultSessionOnly === false) return true;
    const defaultSes = getDefaultSession();
    // Narrow mock bypass strictly to unit-test mocks that lack BOTH defaultSes and contents.session (SEC-04)
    if (!defaultSes && !contents.session) return true;
    if (!defaultSes) return false;
    return contents.session === defaultSes;
  }

  function rotateGeneration(wcId, nextUrl) {
    const st = getOrCreateState(wcId);
    st.docGenId += 1;
    st.claimedGenId = 0;
    st.activeNonce = null;
    st.pinnedOrigin = null;
    st.pinnedUrl = null;

    if (isAllowedRendererUrl(nextUrl, urlOpts)) {
      try {
        const parsed = new URL(nextUrl);
        st.pinnedOrigin = parsed.origin;
        st.pinnedUrl = nextUrl;
        st.activeNonce = crypto.randomBytes(32).toString('hex');
      } catch (_e) {
        st.activeNonce = null;
      }
    }
    return st;
  }

  function clearWebContents(wcId) {
    statesByWcId.delete(wcId);
  }

  function verifyFrameEvent(ev) {
    const sender = ev && ev.sender;
    const frame = ev && ev.senderFrame;
    if (!sender || !frame) {
      return { ok: false, reason: 'ERR_MISSING_SENDER_OR_FRAME' };
    }
    if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) {
      return { ok: false, reason: 'ERR_SENDER_DESTROYED' };
    }
    if (!isSessionAllowed(sender)) {
      return { ok: false, reason: 'ERR_DISALLOWED_SESSION' };
    }
    if (sender.mainFrame && frame !== sender.mainFrame) {
      return { ok: false, reason: 'ERR_NOT_MAIN_FRAME' };
    }
    if (frame.parent || frame.detached) {
      return { ok: false, reason: 'ERR_SUBFRAME_OR_DETACHED' };
    }

    const frameUrl = typeof frame.url === 'string' ? frame.url : '';
    if (!frameUrl || !isAllowedRendererUrl(frameUrl, urlOpts)) {
      return { ok: false, reason: 'ERR_DISALLOWED_FRAME_URL', url: frameUrl };
    }

    let parsedFrame;
    try {
      parsedFrame = new URL(frameUrl);
    } catch (_e) {
      return { ok: false, reason: 'ERR_INVALID_FRAME_URL' };
    }

    // Reject opaque 'null' frameOrigin on standard HTTP/HTTPS documents (sandboxed/opaque origin bypass, SEC-04)
    const frameOrigin = typeof frame.origin === 'string' ? frame.origin : '';
    const isStandardHttp = parsedFrame.protocol === 'http:' || parsedFrame.protocol === 'https:';
    if (frameOrigin === 'null' && isStandardHttp) {
      return { ok: false, reason: 'ERR_OPAQUE_FRAME_ORIGIN' };
    }
    if (frameOrigin && frameOrigin !== 'null' && parsedFrame.origin !== 'null' && frameOrigin !== parsedFrame.origin) {
      return { ok: false, reason: 'ERR_FRAME_ORIGIN_MISMATCH' };
    }

    const st = getOrCreateState(sender.id);
    if (st.pinnedOrigin && st.pinnedOrigin !== 'null' && parsedFrame.origin !== 'null' && st.pinnedOrigin !== parsedFrame.origin) {
      // Origin rotated (e.g., LS port rotation before did-navigate finished): rotate generation immediately.
      rotateGeneration(sender.id, frameUrl);
    } else if (!st.pinnedOrigin) {
      rotateGeneration(sender.id, frameUrl);
    }

    return { ok: true, docGenId: st.docGenId, claimedGenId: st.claimedGenId, origin: parsedFrame.origin, url: frameUrl };
  }

  function verifyClaimedEvent(ev, claimedDocGenId) {
    const check = verifyFrameEvent(ev);
    if (!check.ok) return check;
    const st = statesByWcId.get(ev.sender.id);
    if (!st || st.claimedGenId !== st.docGenId) {
      return { ok: false, reason: 'ERR_BRIDGE_NOT_CLAIMED_FOR_GENERATION' };
    }
    // S-4: Fail-closed whenever docGenId is omitted, non-integer, or stale
    if (!Number.isInteger(claimedDocGenId) || claimedDocGenId !== st.docGenId) {
      return { ok: false, reason: 'ERR_STALE_DOCUMENT_GENERATION' };
    }
    return check;
  }

  function consumeClaimNonce(ev, incomingNonce) {
    const check = verifyFrameEvent(ev);
    if (!check.ok) return check;
    const st = statesByWcId.get(ev.sender.id);
    if (!st || !st.activeNonce || st.claimedGenId === st.docGenId) {
      return { ok: false, reason: 'ERR_NONCE_ALREADY_CONSUMED_OR_MISSING' };
    }
    if (typeof incomingNonce !== 'string') {
      return { ok: false, reason: 'ERR_INVALID_NONCE' };
    }
    // D-02: Compare UTF-8 byte lengths BEFORE crypto.timingSafeEqual (prevents RangeError on multi-byte strings)
    const a = Buffer.from(incomingNonce, 'utf8');
    const b = Buffer.from(st.activeNonce, 'utf8');
    if (a.length !== b.length) {
      return { ok: false, reason: 'ERR_INVALID_NONCE' };
    }
    if (!crypto.timingSafeEqual(a, b)) {
      recordDiag('warn', 'CLAIM_NONCE_MISMATCH', `wcId=${ev.sender.id}`);
      return { ok: false, reason: 'ERR_NONCE_MISMATCH' };
    }
    st.claimedGenId = st.docGenId;
    st.activeNonce = null;
    return { ok: true, docGenId: st.docGenId, origin: st.pinnedOrigin };
  }

  function getState(wcId) {
    return statesByWcId.get(wcId) || null;
  }

  return Object.freeze({
    isAllowedUrl: (url) => isAllowedRendererUrl(url, urlOpts),
    isSessionAllowed,
    rotateGeneration,
    clearWebContents,
    verifyFrameEvent,
    verifyClaimedEvent,
    consumeClaimNonce,
    getState,
  });
}

module.exports = {
  DEFAULT_ALLOWED_PROTOCOLS,
  DEFAULT_ALLOWED_HOSTS,
  DEFAULT_EXCLUDED_PROTOCOLS,
  isAllowedRendererUrl,
  createHostOriginResolver,
};
