'use strict';

/**
 * SOLID #0 Zero-Vendor-Literal CI Gate (v3.0.0).
 *
 * Scans `src/core/`, `src/runtime/`, `src/cli/`, and `src/adapters/remote-web/`
 * (excluding generated files) to ensure ZERO host-vendor-specific literals,
 * vendor URLs, vendor DOM test-ids, or hardcoded Tailwind layout selectors
 * leak into vendor-neutral framework layers.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

const SCAN_DIRS = [
  path.join(REPO_ROOT, 'src', 'core'),
  path.join(REPO_ROOT, 'src', 'runtime'),
  path.join(REPO_ROOT, 'src', 'cli'),
  path.join(REPO_ROOT, 'src', 'adapters', 'remote-web'),
];

const FORBIDDEN_PATTERNS = [
  { id: 'VENDOR_DOMAIN', re: /antigravity\.google\.com/i },
  { id: 'VENDOR_AUTH_ORIGIN', re: /accounts\.google\.com|oauth2\.googleapis\.com|myaccount\.google\.com/i },
  { id: 'VENDOR_DATA_ATTR', re: /data-agy-no-translate/i },
  { id: 'VENDOR_PORTAL_CHANNEL', re: /wcv:set-portal-overlay-open/i },
  { id: 'VENDOR_TAILWIND_GRID', re: /div\.grid\b/ },
  { id: 'VENDOR_EXE_NAME', re: /Antigravity\.exe/i },
  { id: 'VENDOR_APP_BUNDLE', re: /Antigravity\.app/i },
  { id: 'VENDOR_PROFILE_ID', re: /['"]antigravity-desktop['"]|['"]antigravity-remote-web['"]/ },
  { id: 'VENDOR_MCP_SCOPE', re: /antigravity:mcp-config/i },
];

// Explicit allowlist for Symbol.for / preload ID constants in src/runtime/shared/constants.js
// (kept strictly for backwards-compatible Symbol identity across v2/v3).
const ALLOWLIST_REL_PATHS = new Set(['src/runtime/shared/constants.js']);

function scanSolidZero(rootDir = REPO_ROOT) {
  const violations = [];
  let checkedFiles = 0;

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'generated') continue;
        walk(full);
      } else if (ent.isFile() && (ent.name.endsWith('.js') || ent.name.endsWith('.cjs'))) {
        const rel = path.relative(rootDir, full).replace(/\\/g, '/');
        checkedFiles += 1;
        if (ALLOWLIST_REL_PATHS.has(rel)) continue;
        const text = fs.readFileSync(full, 'utf8');
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i];
          for (let p = 0; p < FORBIDDEN_PATTERNS.length; p += 1) {
            const pat = FORBIDDEN_PATTERNS[p];
            if (pat.re.test(line)) {
              violations.push({
                file: rel,
                line: i + 1,
                rule: pat.id,
                snippet: line.trim().slice(0, 120),
              });
            }
          }
        }
      }
    }
  }

  for (const dir of SCAN_DIRS) {
    walk(dir);
  }

  return {
    ok: violations.length === 0,
    checkedFiles,
    violations,
  };
}

if (require.main === module) {
  const res = scanSolidZero();
  if (!res.ok) {
    process.stderr.write(`SOLID_ZERO_VIOLATIONS (${res.violations.length}):\n`);
    for (const v of res.violations) {
      process.stderr.write(`  - ${v.file}:${v.line} [${v.rule}] ${v.snippet}\n`);
    }
    process.exitCode = 1;
  } else {
    process.stdout.write(JSON.stringify({ ok: true, checkedFiles: res.checkedFiles, violations: 0 }) + '\n');
  }
}

module.exports = {
  FORBIDDEN_PATTERNS,
  scanSolidZero,
};
