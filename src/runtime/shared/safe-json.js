'use strict';

/**
 * Iterative prototype-pollution-safe JSON parser (zero external dependencies).
 */

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function hasDangerousProtoKey(value) {
  if (!value || typeof value !== 'object') return false;
  const stack = [value];
  const seen = new Set();
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur)) {
      for (let i = 0; i < cur.length; i++) {
        const item = cur[i];
        if (item && typeof item === 'object') stack.push(item);
      }
    } else {
      const keys = Object.keys(cur);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (DANGEROUS_KEYS.has(k)) return true;
        const v = cur[k];
        if (v && typeof v === 'object') stack.push(v);
      }
    }
  }
  return false;
}

function parseSafeJson(rawText) {
  const parsed = JSON.parse(rawText);
  if (hasDangerousProtoKey(parsed)) {
    throw new Error('ERR_UNSAFE_JSON_PROTO_KEY');
  }
  return parsed;
}

module.exports = {
  DANGEROUS_KEYS,
  hasDangerousProtoKey,
  parseSafeJson,
};
