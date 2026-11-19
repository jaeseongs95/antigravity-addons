'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function walkJsFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJsFiles(full));
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

test('TC-001: src/core/ has zero Antigravity, Electron, or app.asar vendor literals', () => {
  const coreFiles = walkJsFiles(path.join(REPO_ROOT, 'src', 'core'));
  assert.ok(coreFiles.length >= 4);
  const forbidden = [/antigravity/i, /electron/i, /app\.asar/i, /AGY_/, /data-agy-/i];
  for (const file of coreFiles) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(REPO_ROOT, file);
    for (const re of forbidden) {
      assert.equal(re.test(src), false, `Vendor literal ${re} leaked into core module ${rel}`);
    }
  }
});

test('TC-001b (F5): src/adapters/electron/ has zero hardcoded Antigravity profile or data-agy-* literals', () => {
  const adapterFiles = walkJsFiles(path.join(REPO_ROOT, 'src', 'adapters', 'electron'));
  assert.ok(adapterFiles.length >= 4);
  const forbidden = [/AGY_STATUSBAR/, /AGY_MCP/, /AGY_KO_THOUGHT/, /antigravity-desktop/, /data-agy-no-translate/];
  for (const file of adapterFiles) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(REPO_ROOT, file);
    for (const re of forbidden) {
      assert.equal(re.test(src), false, `Hardcoded profile literal ${re} leaked into adapter ${rel}`);
    }
  }
});

test('TC-001c (R6-F1): src/cli/ has zero Electron, ASAR, Antigravity, lockfile, or concrete adapter/profile coupling', () => {
  const cliFiles = walkJsFiles(path.join(REPO_ROOT, 'src', 'cli'));
  assert.ok(cliFiles.length >= 1);
  const forbidden = [
    /antigravity/i,
    /electron/i,
    /app\.asar/i,
    /asarHost/i,
    /asarExists/i,
    /origBackup/i,
    /LOADER_SCRIPT_PATH/,
    /proper-lockfile/,
    /\.\.\/adapters\//,
    /\.\.\/profiles\//,
  ];
  for (const file of cliFiles) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(REPO_ROOT, file);
    for (const re of forbidden) {
      assert.equal(re.test(src), false, `Concrete/runtime literal ${re} leaked into CLI module ${rel}`);
    }
  }
});
