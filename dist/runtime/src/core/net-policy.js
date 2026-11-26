'use strict';

/**
 * Pure vendor- & runtime-neutral Dual-Key Network Policy Engine (v3.0.0 — SOLID #0).
 *
 * ZERO Node.js built-in imports, ZERO vendor literals.
 *
 * Enforces the locked deliberation contract:
 * 1. `permissions.net.httpsHosts` (Desktop + Remote Web):
 *    - Public HTTPS FQDN only (`<= 253` chars, no wildcards, no raw IPv4/IPv6,
 *      no `localhost`, no internal suffixes, no profile-forbidden auth/host origins).
 *    - `credentials: 'omit'`, forbidden headers stripped (`Cookie`, `Host`, `Origin`, `Referer`).
 *    - Manual redirects up to `MAX_HTTPS_REDIRECTS` (3), re-validating every hop.
 *    - DNS pre-resolution IP classifier blocks RFC1918, loopback, link-local, IMDS (`169.254.169.254`),
 *      CGNAT, multicast, and IPv4-mapped IPv6 equivalents.
 * 2. `permissions.net.localLoopback` (Desktop `trusted` ONLY):
 *    - Explicit integer ports (`1024..65535`) or profile-resolved named targets (no wildcards).
 *    - Normalizes `localhost` -> `127.0.0.1` literal.
 *    - ZERO redirects (`MAX_LOOPBACK_REDIRECTS = 0`).
 *    - Strictly omitted / denied on Remote Web.
 */

const MAX_FQDN_LENGTH = 253;
const PUBLIC_FQDN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const NAMED_LOOPBACK_TARGET_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const MAX_HTTPS_REDIRECTS = 3;
const MAX_LOOPBACK_REDIRECTS = 0;

const FORBIDDEN_INTERNAL_SUFFIXES = Object.freeze([
  '.local',
  '.internal',
  '.localhost',
  '.localdomain',
  '.lan',
  '.home',
  '.corp',
  '.intranet',
  '.arpa',
  '.home.arpa',
]);

const FORBIDDEN_REQUEST_HEADERS = Object.freeze([
  'cookie',
  'cookie2',
  'host',
  'origin',
  'referer',
  'proxy-authorization',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-real-ip',
]);

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

function normalizeHostName(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim().toLowerCase();
  if (s.endsWith('.')) s = s.slice(0, -1);
  return s;
}

function isForbiddenHostMatch(host, forbiddenHosts = []) {
  if (!host) return true;
  if (host === 'localhost') return true;
  for (let i = 0; i < FORBIDDEN_INTERNAL_SUFFIXES.length; i += 1) {
    if (host.endsWith(FORBIDDEN_INTERNAL_SUFFIXES[i])) return true;
  }
  if (Array.isArray(forbiddenHosts)) {
    for (let i = 0; i < forbiddenHosts.length; i += 1) {
      const f = normalizeHostName(forbiddenHosts[i]);
      if (!f) continue;
      if (host === f || host.endsWith(`.${f}`)) return true;
    }
  }
  return false;
}

function isPublicFqdnHost(rawHost, { forbiddenHosts = [] } = {}) {
  const host = normalizeHostName(rawHost);
  if (!host || host.length > MAX_FQDN_LENGTH) return false;
  if (host.includes('*') || host.includes(':') || host.includes('/') || host.includes('@')) return false;
  if (!PUBLIC_FQDN_RE.test(host)) return false;
  if (isForbiddenHostMatch(host, forbiddenHosts)) return false;
  return true;
}

function parseIpv4Octets(ip) {
  const parts = String(ip || '').trim().split('.');
  if (parts.length !== 4) return null;
  const out = [];
  for (let i = 0; i < 4; i += 1) {
    if (!/^\d{1,3}$/.test(parts[i])) return null;
    if (parts[i].length > 1 && parts[i].startsWith('0')) return null;
    const n = Number(parts[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out.push(n);
  }
  return out;
}

function isPrivateOrReservedIpv4Octets(octets) {
  if (!octets || octets.length !== 4) return true;
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8 (RFC1918)
  if (a === 127) return true; // 127.0.0.0/8 (Loopback)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (Link-local & Cloud IMDS 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC1918)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC1918)
  if (a === 192 && b === 0 && (octets[2] === 0 || octets[2] === 2)) return true; // IETF / TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // Benchmarking
  if (a === 198 && b === 51 && octets[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && octets[2] === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // Multicast & Reserved (224.0.0.0/4, 240.0.0.0/4, broadcast)
  return false;
}

function expandIpv6Groups(rawIp) {
  let ip = String(rawIp || '').trim().toLowerCase();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const zoneIdx = ip.indexOf('%');
  if (zoneIdx !== -1) ip = ip.slice(0, zoneIdx);
  if (!ip.includes(':')) return null;

  // Handle embedded IPv4 tail (e.g. ::ffff:127.0.0.1)
  const lastColon = ip.lastIndexOf(':');
  const tail = ip.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4Octets(tail);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    ip = `${ip.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = halves.length === 2 ? 8 - (left.length + right.length) : 0;
  if (missing < 0 || (halves.length === 1 && left.length !== 8)) return null;

  const groups = [...left, ...new Array(missing).fill('0'), ...right];
  if (groups.length !== 8) return null;
  const nums = [];
  for (let i = 0; i < 8; i += 1) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null;
    nums.push(parseInt(groups[i], 16));
  }
  return nums;
}

/**
 * Returns true if the IP address is private, loopback, link-local, IMDS, multicast,
 * reserved, IPv4-mapped private IPv6, or unparseable (fail-closed).
 */
function isPrivateOrReservedIp(rawIp) {
  if (typeof rawIp !== 'string' || !rawIp.trim()) return true;
  const trimmed = rawIp.trim();
  const v4 = parseIpv4Octets(trimmed);
  if (v4) {
    return isPrivateOrReservedIpv4Octets(v4);
  }
  const v6 = expandIpv6Groups(trimmed);
  if (!v6) return true; // Fail-closed on unparseable IP

  const allZeroPrefix6 = v6[0] === 0 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0 && v6[4] === 0;
  // Unspecified :: and Loopback ::1
  if (allZeroPrefix6 && v6[5] === 0 && v6[6] === 0 && (v6[7] === 0 || v6[7] === 1)) {
    return true;
  }
  // IPv4-mapped ::ffff:0:0/96 or IPv4-compatible ::/96 or NAT64 64:ff9b::/96
  const isV4Mapped = allZeroPrefix6 && (v6[5] === 0xffff || v6[5] === 0);
  const isNat64 = v6[0] === 0x0064 && v6[1] === 0xff9b && v6[2] === 0 && v6[3] === 0 && v6[4] === 0 && v6[5] === 0;
  if (isV4Mapped || isNat64) {
    const mappedOctets = [(v6[6] >> 8) & 0xff, v6[6] & 0xff, (v6[7] >> 8) & 0xff, v6[7] & 0xff];
    return isPrivateOrReservedIpv4Octets(mappedOctets);
  }
  // Unique Local fc00::/7
  if ((v6[0] & 0xfe00) === 0xfc00) return true;
  // Link-Local fe80::/10
  if ((v6[0] & 0xffc0) === 0xfe80) return true;
  // Site-Local (deprecated) fec0::/10
  if ((v6[0] & 0xffc0) === 0xfec0) return true;
  // Multicast ff00::/8
  if ((v6[0] & 0xff00) === 0xff00) return true;
  // Documentation 2001:db8::/32
  if (v6[0] === 0x2001 && v6[1] === 0x0db8) return true;
  return false;
}

function normalizeLoopbackTarget(entry) {
  if (typeof entry === 'number' && Number.isInteger(entry) && entry >= 1024 && entry <= 65535) {
    return { kind: 'port', port: entry };
  }
  if (typeof entry === 'string') {
    const trimmed = entry.trim();
    if (NAMED_LOOPBACK_TARGET_RE.test(trimmed)) {
      return { kind: 'named', name: trimmed };
    }
  }
  return null;
}

function validateNetPermissions(netPerm, { trustLevel = 'restricted', forbiddenHosts = [] } = {}) {
  if (netPerm === null || netPerm === undefined) {
    return { ok: true, httpsHosts: [], localLoopback: [] };
  }
  if (typeof netPerm !== 'object' || Array.isArray(netPerm)) {
    return { ok: false, reason: 'ERR_INVALID_NET_PERMISSIONS', errors: ['permissions.net must be an object'] };
  }
  const errors = [];
  const httpsHosts = [];
  const seenHosts = new Set();
  if (netPerm.httpsHosts !== undefined) {
    if (!Array.isArray(netPerm.httpsHosts)) {
      errors.push('permissions.net.httpsHosts must be an array');
    } else {
      for (let i = 0; i < netPerm.httpsHosts.length; i += 1) {
        const raw = netPerm.httpsHosts[i];
        const norm = normalizeHostName(raw);
        if (!isPublicFqdnHost(norm, { forbiddenHosts })) {
          errors.push(`Invalid or forbidden httpsHost "${String(raw)}"`);
        } else if (!seenHosts.has(norm)) {
          seenHosts.add(norm);
          httpsHosts.push(norm);
        }
      }
    }
  }

  const localLoopback = [];
  const seenLoopback = new Set();
  if (netPerm.localLoopback !== undefined) {
    if (!Array.isArray(netPerm.localLoopback)) {
      errors.push('permissions.net.localLoopback must be an array');
    } else {
      if (netPerm.localLoopback.length > 0 && trustLevel !== 'trusted') {
        return {
          ok: false,
          reason: 'ERR_RESTRICTED_LOCAL_LOOPBACK_FORBIDDEN',
          errors: ['permissions.net.localLoopback requires trustLevel: "trusted" and Desktop host trust approval'],
        };
      }
      for (let i = 0; i < netPerm.localLoopback.length; i += 1) {
        const parsed = normalizeLoopbackTarget(netPerm.localLoopback[i]);
        if (!parsed) {
          errors.push(`Invalid localLoopback target "${String(netPerm.localLoopback[i])}" (must be port 1024..65535 or named target)`);
        } else {
          const key = parsed.kind === 'port' ? `port:${parsed.port}` : `named:${parsed.name}`;
          if (!seenLoopback.has(key)) {
            seenLoopback.add(key);
            localLoopback.push(parsed.kind === 'port' ? parsed.port : parsed.name);
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, reason: 'ERR_INVALID_NET_PERMISSIONS', errors };
  }
  return { ok: true, httpsHosts, localLoopback };
}

function sanitizeNetHeaders(rawHeaders) {
  const clean = {};
  if (!rawHeaders || typeof rawHeaders !== 'object') return clean;
  const entries = Array.isArray(rawHeaders) ? rawHeaders : Object.entries(rawHeaders);
  for (let i = 0; i < entries.length; i += 1) {
    const pair = entries[i];
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const rawName = String(pair[0] || '').trim();
    const lower = rawName.toLowerCase();
    if (!rawName || !/^[a-z0-9-]+$/i.test(rawName)) continue;
    if (FORBIDDEN_REQUEST_HEADERS.includes(lower) || lower.startsWith('sec-fetch-') || lower.startsWith('proxy-')) {
      continue;
    }
    const rawVal = String(pair[1] === undefined || pair[1] === null ? '' : pair[1]);
    if (/[\r\n\0]/.test(rawVal)) continue;
    clean[rawName] = rawVal;
  }
  return clean;
}

/**
 * Classifies and authorizes a single `net.fetch(url, init)` target against a plugin's
 * validated dual-key net policy.
 *
 * @param {string} rawUrl
 * @param {object} init
 * @param {{
 *   httpsHosts?: string[],
 *   localLoopback?: Array<number|string>,
 *   namedLoopbackPorts?: Record<string, number>,
 *   forbiddenHosts?: string[],
 *   allowLoopback?: boolean,
 * }} policy
 */
function evaluateNetRequest(rawUrl, init = {}, policy = {}) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { ok: false, reason: 'ERR_NET_INVALID_URL' };
  }
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch (_e) {
    return { ok: false, reason: 'ERR_NET_INVALID_URL' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'ERR_NET_CREDENTIALS_IN_URL_FORBIDDEN' };
  }

  const method = String((init && init.method) || 'GET').trim().toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    return { ok: false, reason: `ERR_NET_METHOD_FORBIDDEN:${method}` };
  }

  const headers = sanitizeNetHeaders(init && init.headers);
  const rawHost = normalizeHostName(parsed.hostname);
  const isLoopbackHost = rawHost === 'localhost' || rawHost === '127.0.0.1' || rawHost === '[::1]' || rawHost === '::1';

  if (isLoopbackHost) {
    if (policy.allowLoopback !== true) {
      return { ok: false, reason: 'ERR_NET_LOOPBACK_NOT_SUPPORTED' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, reason: 'ERR_NET_SCHEME_FORBIDDEN' };
    }
    const explicitPort = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    if (!Number.isInteger(explicitPort) || explicitPort < 1024 || explicitPort > 65535) {
      return { ok: false, reason: 'ERR_NET_LOOPBACK_PORT_FORBIDDEN' };
    }
    const allowedPorts = new Set();
    const declared = Array.isArray(policy.localLoopback) ? policy.localLoopback : [];
    const namedMap = policy.namedLoopbackPorts && typeof policy.namedLoopbackPorts === 'object' ? policy.namedLoopbackPorts : {};
    for (let i = 0; i < declared.length; i += 1) {
      const entry = declared[i];
      if (typeof entry === 'number' && Number.isInteger(entry) && entry >= 1024 && entry <= 65535) {
        allowedPorts.add(entry);
      } else if (typeof entry === 'string' && Object.prototype.hasOwnProperty.call(namedMap, entry)) {
        const resolvedPort = Number(namedMap[entry]);
        if (Number.isInteger(resolvedPort) && resolvedPort >= 1024 && resolvedPort <= 65535) {
          allowedPorts.add(resolvedPort);
        }
      }
    }
    if (!allowedPorts.has(explicitPort)) {
      return { ok: false, reason: `ERR_NET_LOOPBACK_PORT_NOT_ALLOWED:${explicitPort}` };
    }
    // Always normalize localhost / ::1 -> 127.0.0.1 literal, 0 redirects
    const normalizedUrl = `${parsed.protocol}//127.0.0.1:${explicitPort}${parsed.pathname}${parsed.search}`;
    return {
      ok: true,
      channel: 'localLoopback',
      method,
      url: normalizedUrl,
      hostname: '127.0.0.1',
      port: explicitPort,
      protocol: parsed.protocol,
      path: `${parsed.pathname}${parsed.search}`,
      headers,
      maxRedirects: MAX_LOOPBACK_REDIRECTS,
      credentials: 'omit',
    };
  }

  // Public HTTPS FQDN channel
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'ERR_NET_HTTPS_REQUIRED' };
  }
  const port = parsed.port ? Number(parsed.port) : 443;
  if (!Number.isInteger(port) || port !== 443) {
    return { ok: false, reason: 'ERR_NET_NON_STANDARD_HTTPS_PORT_FORBIDDEN' };
  }
  const forbiddenHosts = Array.isArray(policy.forbiddenHosts) ? policy.forbiddenHosts : [];
  if (!isPublicFqdnHost(rawHost, { forbiddenHosts })) {
    return { ok: false, reason: `ERR_NET_HOST_FORBIDDEN:${rawHost}` };
  }
  const allowSet = new Set(
    (Array.isArray(policy.httpsHosts) ? policy.httpsHosts : []).map((h) => normalizeHostName(h)).filter(Boolean)
  );
  if (!allowSet.has(rawHost)) {
    return { ok: false, reason: `ERR_NET_HOST_NOT_ALLOWED:${rawHost}` };
  }

  return {
    ok: true,
    channel: 'https',
    method,
    url: parsed.href,
    hostname: rawHost,
    port: 443,
    protocol: 'https:',
    path: `${parsed.pathname}${parsed.search}`,
    headers,
    maxRedirects: MAX_HTTPS_REDIRECTS,
    credentials: 'omit',
  };
}

module.exports = {
  MAX_FQDN_LENGTH,
  PUBLIC_FQDN_RE,
  NAMED_LOOPBACK_TARGET_RE,
  MAX_HTTPS_REDIRECTS,
  MAX_LOOPBACK_REDIRECTS,
  FORBIDDEN_INTERNAL_SUFFIXES,
  FORBIDDEN_REQUEST_HEADERS,
  normalizeHostName,
  isPublicFqdnHost,
  isPrivateOrReservedIp,
  normalizeLoopbackTarget,
  validateNetPermissions,
  sanitizeNetHeaders,
  evaluateNetRequest,
};
