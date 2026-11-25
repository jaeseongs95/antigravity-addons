'use strict';

/**
 * Zero-dependency Ephemeral LAN QR Userscript Delivery Server (v2.7.0 — SOLID #0).
 *
 * - Pure `node:http` + `node:os` + `node:crypto` + `qr-ascii.js` (0 external deps, 0 vendor literals).
 * - Protects local userscript transfer with a 128-bit cryptographic random path token.
 * - Strict exact-path allowlist (`/<token>/`, `/<token>/install`, `/<token>/<userscript>`,
 *   `/<token>/<meta>`, `/<token>/<hostLib>`), rejecting wrong tokens, non-GET/HEAD methods,
 *   and path traversal with 404/405.
 * - Sends `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
 * - Auto-shuts down after `ttlSec` (default 300s) or immediately after the first `.user.js`
 *   download when `once: true`.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { renderQrAscii } = require('./qr-ascii');

const DEFAULT_TTL_SEC = 300;
const MIN_TTL_SEC = 5;
const MAX_TTL_SEC = 3600;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const SAFE_FILENAME_RE = /^[a-zA-Z0-9._-]+$/;

function escapeHtmlText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isRegularNonSymlinkFile(filePath) {
  try {
    const st = fs.lstatSync(filePath);
    return st.isFile() && !st.isSymbolicLink() && st.size > 0 && st.size <= MAX_ASSET_BYTES;
  } catch (_err) {
    return false;
  }
}

function isPrivateLanIpv4(addr) {
  if (typeof addr !== 'string') return false;
  if (addr.startsWith('192.168.')) return true;
  if (addr.startsWith('10.')) return true;
  const m = /^172\.(\d+)\./.exec(addr);
  if (m) {
    const second = Number(m[1]);
    return second >= 16 && second <= 31;
  }
  return false;
}

function pickLanIpv4Address(networkInterfaces = null) {
  const ifaces = networkInterfaces || os.networkInterfaces();
  const privateCandidates = [];
  const otherCandidates = [];

  for (const [name, entries] of Object.entries(ifaces || {})) {
    if (!Array.isArray(entries)) continue;
    const lowerName = String(name || '').toLowerCase();
    const isVirtual =
      lowerName.includes('vethernet') ||
      lowerName.includes('wsl') ||
      lowerName.includes('docker') ||
      lowerName.includes('vbox') ||
      lowerName.includes('vmware') ||
      lowerName.includes('tailscale') ||
      lowerName.includes('loopback');

    for (const ent of entries) {
      if (!ent || ent.internal) continue;
      const isV4 = ent.family === 'IPv4' || ent.family === 4;
      if (!isV4 || typeof ent.address !== 'string' || !ent.address) continue;
      if (ent.address.startsWith('169.254.')) continue; // link-local APIPA
      const item = { address: ent.address, isVirtual, name };
      if (isPrivateLanIpv4(ent.address)) {
        privateCandidates.push(item);
      } else {
        otherCandidates.push(item);
      }
    }
  }

  privateCandidates.sort((a, b) => Number(a.isVirtual) - Number(b.isVirtual));
  otherCandidates.sort((a, b) => Number(a.isVirtual) - Number(b.isVirtual));

  if (privateCandidates.length > 0) return privateCandidates[0].address;
  if (otherCandidates.length > 0) return otherCandidates[0].address;
  return '127.0.0.1';
}

function resolveDistAssets(distDir) {
  if (!distDir || typeof distDir !== 'string') {
    throw new Error('ERR_REMOTE_DIST_DIR_REQUIRED');
  }
  const absDir = path.resolve(distDir);
  if (!fs.existsSync(absDir)) {
    throw new Error(`ERR_REMOTE_DIST_NOT_FOUND:${absDir}`);
  }

  let manifest = null;
  const manifestPath = path.join(absDir, 'build-manifest.json');
  if (isRegularNonSymlinkFile(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (_err) {
      manifest = null;
    }
  }

  const manifestFiles =
    manifest && manifest.files && typeof manifest.files === 'object' ? Object.keys(manifest.files) : [];
  const dirEntries = fs.readdirSync(absDir);
  const candidatePool = Array.from(new Set([...manifestFiles, ...dirEntries])).filter(
    (name) => typeof name === 'string' && !name.includes('/') && !name.includes('\\') && SAFE_FILENAME_RE.test(name)
  );

  function findValidBySuffix(suffix) {
    const name = candidatePool.find((n) => n.endsWith(suffix));
    if (!name) return null;
    const full = path.join(absDir, name);
    if (!isRegularNonSymlinkFile(full)) return null;
    return { fileName: name, filePath: full };
  }

  const userscript = findValidBySuffix('.user.js');
  if (!userscript) {
    throw new Error(`ERR_REMOTE_USERSCRIPT_NOT_FOUND:${absDir}`);
  }
  const meta = findValidBySuffix('.meta.js');
  const hostLib = findValidBySuffix('.lib.js');

  return {
    distDir: absDir,
    buildSha8: manifest && typeof manifest.buildSha8 === 'string' ? manifest.buildSha8 : null,
    addonCount: manifest && Number.isInteger(manifest.addonCount) ? manifest.addonCount : null,
    userscript,
    meta,
    hostLib,
  };
}

function buildInstallLandingHtml({ userscriptUrl, userscriptFileName, metaUrl, buildSha8, addonCount }) {
  const safeUrl = escapeHtmlText(userscriptUrl);
  const safeName = escapeHtmlText(userscriptFileName);
  const safeMeta = metaUrl ? escapeHtmlText(metaUrl) : '';
  const metaBadge = buildSha8 ? `SHA ${escapeHtmlText(buildSha8)}` : 'Local bundle';
  const addonBadge = Number.isInteger(addonCount) ? `${addonCount} addon(s)` : 'Local';

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
    '<title>Remote Web Userscript Install</title>',
    '<style>',
    'body{margin:0;padding:24px 16px;font-family:system-ui,-apple-system,sans-serif;background:#0d1117;color:#e6edf3;line-height:1.5;}',
    '.card{max-width:460px;margin:0 auto;background:#161b22;border:1px solid #30363d;border-radius:14px;padding:20px;}',
    'h1{margin:0 0 8px;font-size:18px;}',
    'p{margin:0 0 14px;color:#8b949e;font-size:14px;}',
    '.meta{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;font-size:12px;color:#a5d6ff;}',
    '.pill{background:rgba(121,192,255,.14);border-radius:999px;padding:3px 10px;}',
    'a.btn{display:block;text-align:center;min-height:44px;line-height:44px;border-radius:10px;background:#238636;color:#fff;font-weight:600;text-decoration:none;font-size:15px;}',
    'a.sub{display:block;text-align:center;margin-top:10px;color:#79c0ff;font-size:13px;}',
    'ol{margin:16px 0 0;padding-left:20px;color:#c9d1d9;font-size:13px;}',
    'li{margin-bottom:6px;}',
    '</style>',
    '</head>',
    '<body>',
    '<main class="card">',
    '<h1>Remote Web Addon Host</h1>',
    '<p>Install the Userscript in your browser\'s Userscript manager (iOS Safari Userscripts, Android Firefox Violentmonkey, or Desktop Tampermonkey).</p>',
    `<div class="meta"><span class="pill">${metaBadge}</span><span class="pill">${escapeHtmlText(addonBadge)}</span></div>`,
    `<a class="btn" href="${safeUrl}">Install ${safeName}</a>`,
    safeMeta ? `<a class="sub" href="${safeMeta}">View metadata (.meta.js)</a>` : '',
    '<ol>',
    '<li>Android Firefox (Violentmonkey) / Desktop Tampermonkey: tap the green button above to open the install confirmation dialog.</li>',
    '<li>iOS / iPadOS Safari (Userscripts app): download or save the file into your Userscripts folder, then enable it in Safari Extensions.</li>',
    '</ol>',
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function startRemoteLanServer({
  distDir,
  bindHost = '0.0.0.0',
  advertiseHost = null,
  port = 0,
  ttlSec = DEFAULT_TTL_SEC,
  once = false,
  token = null,
  onDownload = null,
  onClose = null,
} = {}) {
  const assets = resolveDistAssets(distDir);
  const effectiveToken =
    typeof token === 'string' && /^[a-f0-9]{32,64}$/i.test(token)
      ? token.toLowerCase()
      : crypto.randomBytes(16).toString('hex');
  const effectiveTtlSec = Number.isFinite(Number(ttlSec))
    ? Math.max(MIN_TTL_SEC, Math.min(MAX_TTL_SEC, Math.floor(Number(ttlSec))))
    : DEFAULT_TTL_SEC;

  const displayHost =
    typeof advertiseHost === 'string' && advertiseHost.trim()
      ? advertiseHost.trim()
      : bindHost && bindHost !== '0.0.0.0' && bindHost !== '::'
        ? bindHost
        : pickLanIpv4Address();

  const userscriptRoute = `/${effectiveToken}/${assets.userscript.fileName}`;
  const metaRoute = assets.meta ? `/${effectiveToken}/${assets.meta.fileName}` : null;
  const hostLibRoute = assets.hostLib ? `/${effectiveToken}/${assets.hostLib.fileName}` : null;
  const rootRoute = `/${effectiveToken}/`;
  const installRoute = `/${effectiveToken}/install`;

  const routeMap = new Map();
  routeMap.set(userscriptRoute, {
    filePath: assets.userscript.filePath,
    contentType: 'text/javascript; charset=utf-8',
    isUserscript: true,
  });
  if (metaRoute && assets.meta) {
    routeMap.set(metaRoute, {
      filePath: assets.meta.filePath,
      contentType: 'text/javascript; charset=utf-8',
      isUserscript: false,
    });
  }
  if (hostLibRoute && assets.hostLib) {
    routeMap.set(hostLibRoute, {
      filePath: assets.hostLib.filePath,
      contentType: 'text/javascript; charset=utf-8',
      isUserscript: false,
    });
  }

  let closed = false;
  let ttlTimer = null;
  let onceTimer = null;
  let downloadCount = 0;

  function setSecurityHeaders(res, contentType, extra = {}) {
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    for (const [k, v] of Object.entries(extra)) {
      res.setHeader(k, v);
    }
  }

  const server = http.createServer((req, res) => {
    const method = String(req.method || '').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      setSecurityHeaders(res, 'text/plain; charset=utf-8');
      res.statusCode = 405;
      res.end('Method Not Allowed\n');
      return;
    }

    const rawUrl = typeof req.url === 'string' ? req.url : '/';
    // Reject encoded traversal or query-smuggling early on raw path
    if (rawUrl.includes('..') || rawUrl.includes('\\') || /%2e|%2f|%5c/i.test(rawUrl)) {
      setSecurityHeaders(res, 'text/plain; charset=utf-8');
      res.statusCode = 404;
      res.end('Not Found\n');
      return;
    }

    const pathOnly = rawUrl.split('?')[0];

    if (pathOnly === rootRoute || pathOnly === installRoute) {
      const html = buildInstallLandingHtml({
        userscriptUrl: userscriptRoute,
        userscriptFileName: assets.userscript.fileName,
        metaUrl: metaRoute,
        buildSha8: assets.buildSha8,
        addonCount: assets.addonCount,
      });
      setSecurityHeaders(res, 'text/html; charset=utf-8', {
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      });
      res.statusCode = 200;
      if (method === 'HEAD') res.end();
      else res.end(html);
      return;
    }

    const assetEntry = routeMap.get(pathOnly);
    if (!assetEntry || !isRegularNonSymlinkFile(assetEntry.filePath)) {
      setSecurityHeaders(res, 'text/plain; charset=utf-8');
      res.statusCode = 404;
      res.end('Not Found\n');
      return;
    }

    let body;
    try {
      body = fs.readFileSync(assetEntry.filePath);
    } catch (_readErr) {
      setSecurityHeaders(res, 'text/plain; charset=utf-8');
      res.statusCode = 500;
      res.end('Internal Server Error\n');
      return;
    }

    setSecurityHeaders(res, assetEntry.contentType, {
      'Content-Length': String(body.length),
    });
    res.statusCode = 200;

    if (method === 'GET' && assetEntry.isUserscript) {
      downloadCount += 1;
      if (typeof onDownload === 'function') {
        try {
          onDownload({ count: downloadCount, remoteAddress: req.socket ? req.socket.remoteAddress : null });
        } catch (_cbErr) {
          // Callback errors must not abort transfer.
        }
      }
      if (once) {
        res.on('finish', () => {
          if (!onceTimer && !closed) {
            onceTimer = setTimeout(() => {
              close('once_completed');
            }, 150);
          }
        });
      }
    }

    if (method === 'HEAD') res.end();
    else res.end(body);
  });

  function close(reason = 'manual') {
    if (closed) return Promise.resolve({ ok: true, reason });
    closed = true;
    if (ttlTimer) {
      clearTimeout(ttlTimer);
      ttlTimer = null;
    }
    if (onceTimer) {
      clearTimeout(onceTimer);
      onceTimer = null;
    }
    return new Promise((resolve) => {
      try {
        server.close(() => {
          if (typeof onClose === 'function') {
            try {
              onClose({ reason, downloadCount });
            } catch (_err) {}
          }
          resolve({ ok: true, reason, downloadCount });
        });
      } catch (_err) {
        resolve({ ok: true, reason, downloadCount });
      }
    });
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bindHost, () => {
      server.removeListener('error', reject);
      const addr = server.address();
      const actualPort = addr && typeof addr === 'object' ? addr.port : port;
      const baseOrigin = `http://${displayHost}:${actualPort}`;
      const installUrl = `${baseOrigin}${rootRoute}`;
      const userscriptUrl = `${baseOrigin}${userscriptRoute}`;
      const metaUrl = metaRoute ? `${baseOrigin}${metaRoute}` : null;
      const hostLibUrl = hostLibRoute ? `${baseOrigin}${hostLibRoute}` : null;
      const qrAscii = renderQrAscii(userscriptUrl, { quietZone: 2 });

      ttlTimer = setTimeout(() => {
        close('ttl_expired');
      }, effectiveTtlSec * 1000);

      resolve(
        Object.freeze({
          ok: true,
          bindHost,
          advertiseHost: displayHost,
          port: actualPort,
          token: effectiveToken,
          ttlSec: effectiveTtlSec,
          once: Boolean(once),
          installUrl,
          userscriptUrl,
          metaUrl,
          hostLibUrl,
          userscriptFileName: assets.userscript.fileName,
          buildSha8: assets.buildSha8,
          addonCount: assets.addonCount,
          qrAscii,
          getDownloadCount: () => downloadCount,
          isClosed: () => closed,
          close,
        })
      );
    });
  });
}

module.exports = {
  DEFAULT_TTL_SEC,
  pickLanIpv4Address,
  resolveDistAssets,
  startRemoteLanServer,
};
