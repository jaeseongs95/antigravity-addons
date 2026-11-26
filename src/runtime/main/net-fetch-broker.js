'use strict';

/**
 * Main-Process Dual-Key `net.fetch` Broker with DNS-Rebinding Protection (v3.0.0 — SOLID #0).
 *
 * Security invariants enforced:
 * 1. `httpsHosts` channel:
 *    - Pre-resolves DNS via `dns.promises.lookup(hostname, { all: true })`.
 *    - Rejects if ANY returned IP is RFC1918, loopback, link-local, IMDS (`169.254.169.254`),
 *      CGNAT, multicast, or IPv4-mapped private IPv6 (`isPrivateOrReservedIp`).
 *    - Connects directly to the verified resolved IP with explicit TLS `servername: hostname`
 *      and `Host: hostname` header so DNS rebinding between lookup and connect is impossible.
 *    - Manual redirect handling up to `MAX_HTTPS_REDIRECTS` (3), re-evaluating every hop
 *      against `httpsHosts` + DNS pre-resolution.
 * 2. `localLoopback` channel (Desktop `trusted` ONLY):
 *    - Normalizes `localhost` / `::1` -> `127.0.0.1`.
 *    - Allows only manifest-declared integer ports (`1024..65535`) or profile-resolved named targets.
 *    - Enforces ZERO redirects (`MAX_LOOPBACK_REDIRECTS = 0`).
 * 3. Bounded timeouts (default 15s, max 30s) and response size limit (default 2 MiB, max 4 MiB).
 */

const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const {
  isPrivateOrReservedIp,
  evaluateNetRequest,
} = require('../../core/net-policy');
const {
  SENSITIVE_REDIRECT_STRIP_HEADERS,
  resolveSecretHeaders,
} = require('../../core/secrets-policy');

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

function createNetFetchBroker({
  forbiddenHosts = [],
  namedLoopbackTargets = {},
  resolveDynamicLoopbackPorts = null,
  resolveDynamicHttpsHosts = null,
  resolvePluginSecret = null,
  lookupFn = null,
  httpModule = http,
  httpsModule = https,
  recordDiag = () => {},
} = {}) {
  const resolveDnsAll =
    typeof lookupFn === 'function'
      ? lookupFn
      : (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

  async function executeSingleHop(plan, { body, timeoutMs, maxResponseBytes, pluginId = null }) {
    let connectHost = plan.hostname;
    let family;
    let tlsServerName;

    if (plan.channel === 'https') {
      let records;
      try {
        records = await resolveDnsAll(plan.hostname);
      } catch (_dnsErr) {
        return { ok: false, reason: 'ERR_NET_DNS_RESOLUTION_FAILED' };
      }
      if (!Array.isArray(records) || records.length === 0) {
        return { ok: false, reason: 'ERR_NET_DNS_NO_RECORDS' };
      }
      for (let i = 0; i < records.length; i += 1) {
        const ip = records[i] && records[i].address ? String(records[i].address) : '';
        if (isPrivateOrReservedIp(ip)) {
          recordDiag('warn', 'NET_DNS_REBIND_BLOCKED', `${plan.hostname} -> ${ip}`);
          return { ok: false, reason: `ERR_NET_PRIVATE_IP_BLOCKED:${ip}` };
        }
      }
      connectHost = records[0].address;
      family = records[0].family || undefined;
      tlsServerName = plan.hostname;
    } else {
      // localLoopback strictly connects to 127.0.0.1
      connectHost = '127.0.0.1';
      family = 4;
    }

    const transport = plan.protocol === 'https:' ? httpsModule : httpModule;
    const reqHeaders = { ...plan.headers };
    if (plan.channel === 'https') {
      reqHeaders.Host = plan.hostname;
    } else {
      reqHeaders.Host = `127.0.0.1:${plan.port}`;
      // Host-controlled, non-spoofable loopback Origin + broker trust headers (plugin-supplied values stripped in net-policy)
      reqHeaders.Origin = `${plan.protocol}//127.0.0.1:${plan.port}`;
      reqHeaders['X-Addon-Host-Broker'] = '1';
      if (typeof pluginId === 'string' && pluginId.trim()) {
        reqHeaders['X-Addon-Host-Plugin'] = pluginId.trim();
      }
    }

    const canSendBody = plan.method !== 'GET' && plan.method !== 'HEAD';
    const bodyBuf = canSendBody && typeof body === 'string' && body.length > 0 ? Buffer.from(body, 'utf8') : null;
    if (bodyBuf && !Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'content-length')) {
      reqHeaders['Content-Length'] = String(bodyBuf.length);
    }

    return new Promise((resolve) => {
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const reqOpts = {
        host: connectHost,
        port: plan.port,
        path: plan.path,
        method: plan.method,
        headers: reqHeaders,
        ...(family ? { family } : {}),
        ...(tlsServerName ? { servername: tlsServerName } : {}),
      };

      const req = transport.request(reqOpts, (res) => {
        const status = Number(res.statusCode) || 0;
        const respHeaders = {};
        if (res.headers && typeof res.headers === 'object') {
          for (const [k, v] of Object.entries(res.headers)) {
            if (k.toLowerCase() === 'set-cookie') continue;
            respHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
          }
        }

        if (REDIRECT_STATUS_CODES.has(status) && respHeaders.location) {
          res.resume();
          done({
            ok: true,
            redirect: true,
            status,
            location: respHeaders.location,
            headers: respHeaders,
          });
          return;
        }

        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buf.length;
          if (total > maxResponseBytes) {
            req.destroy();
            done({ ok: false, reason: 'ERR_NET_RESPONSE_TOO_LARGE' });
            return;
          }
          chunks.push(buf);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          done({
            ok: true,
            redirect: false,
            status,
            statusText: String(res.statusMessage || ''),
            headers: respHeaders,
            bodyText: text,
            url: plan.url,
          });
        });
        res.on('error', (err) => {
          done({ ok: false, reason: `ERR_NET_RESPONSE_ERROR:${err && err.message ? err.message : String(err)}` });
        });
      });

      req.setTimeout(timeoutMs, () => {
        req.destroy();
        done({ ok: false, reason: 'ERR_NET_TIMEOUT' });
      });

      req.on('error', (err) => {
        done({ ok: false, reason: `ERR_NET_REQUEST_FAILED:${err && err.message ? err.message : String(err)}` });
      });

      if (bodyBuf && plan.method !== 'GET' && plan.method !== 'HEAD') {
        req.write(bodyBuf);
      }
      req.end();
    });
  }

  async function fetchForPlugin(pluginBinding, rawUrl, init = {}) {
    if (!pluginBinding || typeof pluginBinding !== 'object') {
      return { ok: false, reason: 'ERR_NET_NOT_DECLARED' };
    }
    const timeoutMs = Math.max(
      500,
      Math.min(MAX_TIMEOUT_MS, Number.isFinite(Number(init.timeoutMs)) ? Number(init.timeoutMs) : DEFAULT_TIMEOUT_MS)
    );
    const maxResponseBytes = Math.max(
      1024,
      Math.min(
        MAX_RESPONSE_BYTES,
        Number.isFinite(Number(init.maxResponseBytes)) ? Number(init.maxResponseBytes) : DEFAULT_MAX_RESPONSE_BYTES
      )
    );

    let dynamicLoopbackPorts = [];
    if (pluginBinding.allowLoopback && typeof resolveDynamicLoopbackPorts === 'function') {
      try {
        const resolvedPorts = resolveDynamicLoopbackPorts(pluginBinding);
        if (Array.isArray(resolvedPorts)) {
          dynamicLoopbackPorts = resolvedPorts;
        }
      } catch (_dynErr) {
        dynamicLoopbackPorts = [];
      }
    }

    let dynamicHttpsHosts = [];
    if (pluginBinding.userApprovedHttps && typeof resolveDynamicHttpsHosts === 'function') {
      try {
        const resolvedHosts = resolveDynamicHttpsHosts(pluginBinding);
        if (Array.isArray(resolvedHosts)) {
          dynamicHttpsHosts = resolvedHosts;
        }
      } catch (_dynHostErr) {
        dynamicHttpsHosts = [];
      }
    }

    const baseHttpsHosts = Array.isArray(pluginBinding.httpsHosts) ? pluginBinding.httpsHosts : [];
    const effectiveHttpsHosts =
      dynamicHttpsHosts.length > 0 ? Array.from(new Set([...baseHttpsHosts, ...dynamicHttpsHosts])) : baseHttpsHosts;

    const policy = {
      httpsHosts: effectiveHttpsHosts,
      localLoopback: Array.isArray(pluginBinding.localLoopback) ? pluginBinding.localLoopback : [],
      namedLoopbackPorts: namedLoopbackTargets,
      dynamicLoopbackPorts,
      forbiddenHosts,
      allowLoopback: Boolean(pluginBinding.allowLoopback),
    };

    const rawSecretHeaders = init && init.secretHeaders !== undefined ? init.secretHeaders : null;
    const injectedSecretHeaderLowerNames = new Set();
    let secretsInjected = false;

    let currentUrl = rawUrl;
    let currentMethod = init.method || 'GET';
    let currentBody = typeof init.body === 'string' ? init.body : null;
    let currentHeaders = init.headers && typeof init.headers === 'object' ? { ...init.headers } : {};
    let redirectsUsed = 0;

    while (true) {
      let plan = evaluateNetRequest(currentUrl, { method: currentMethod, headers: currentHeaders }, policy);
      if (!plan.ok) {
        return { ok: false, reason: plan.reason };
      }

      // Resolve & inject secretHeaders ONLY AFTER URL allowlist passes on hop 0
      if (!secretsInjected && rawSecretHeaders !== null) {
        secretsInjected = true;
        const lookupFnForPlugin =
          typeof resolvePluginSecret === 'function' && typeof pluginBinding.pluginId === 'string' && pluginBinding.pluginId
            ? (secretKey) => resolvePluginSecret(pluginBinding.pluginId, secretKey, pluginBinding)
            : null;
        const secretRes = resolveSecretHeaders(rawSecretHeaders, lookupFnForPlugin);
        if (!secretRes.ok) {
          return { ok: false, reason: secretRes.reason };
        }
        if (secretRes.injectedHeaderNames.length > 0) {
          for (let i = 0; i < secretRes.injectedHeaderNames.length; i += 1) {
            injectedSecretHeaderLowerNames.add(secretRes.injectedHeaderNames[i]);
          }
          // Strip any user-supplied header colliding case-insensitively with an injected secret header
          const mergedHeaders = {};
          for (const [k, v] of Object.entries(currentHeaders)) {
            if (injectedSecretHeaderLowerNames.has(k.toLowerCase())) continue;
            mergedHeaders[k] = v;
          }
          Object.assign(mergedHeaders, secretRes.headers);
          currentHeaders = mergedHeaders;
          plan = evaluateNetRequest(currentUrl, { method: currentMethod, headers: currentHeaders }, policy);
          if (!plan.ok) {
            return { ok: false, reason: plan.reason };
          }
        }
      }

      const hop = await executeSingleHop(plan, {
        body: currentBody,
        timeoutMs,
        maxResponseBytes,
        pluginId: typeof pluginBinding.pluginId === 'string' ? pluginBinding.pluginId : null,
      });
      if (!hop.ok) {
        return hop;
      }
      if (!hop.redirect) {
        return {
          ok: true,
          status: hop.status,
          statusText: hop.statusText,
          headers: hop.headers,
          bodyText: hop.bodyText,
          url: hop.url,
          channel: plan.channel,
        };
      }

      if (redirectsUsed >= plan.maxRedirects) {
        return {
          ok: false,
          reason:
            plan.channel === 'localLoopback'
              ? 'ERR_NET_LOOPBACK_REDIRECT_FORBIDDEN'
              : 'ERR_NET_TOO_MANY_REDIRECTS',
          status: hop.status,
        };
      }

      let nextParsed;
      try {
        nextParsed = new URL(hop.location, plan.url);
      } catch (_e) {
        return { ok: false, reason: 'ERR_NET_INVALID_REDIRECT_URL' };
      }
      // BLK-07 + v3.3.0: Strip Authorization, API-key headers, and all injected secretHeaders on cross-host redirects
      if (nextParsed.hostname.toLowerCase() !== plan.hostname.toLowerCase()) {
        const filtered = {};
        for (const [k, v] of Object.entries(currentHeaders)) {
          const lower = k.toLowerCase();
          if (SENSITIVE_REDIRECT_STRIP_HEADERS.includes(lower) || injectedSecretHeaderLowerNames.has(lower)) {
            continue;
          }
          filtered[k] = v;
        }
        currentHeaders = filtered;
      }
      redirectsUsed += 1;
      currentUrl = nextParsed.href;
      if (hop.status === 303) {
        currentMethod = 'GET';
        currentBody = null;
      }
    }
  }

  return Object.freeze({
    fetchForPlugin,
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  MAX_RESPONSE_BYTES,
  createNetFetchBroker,
};
