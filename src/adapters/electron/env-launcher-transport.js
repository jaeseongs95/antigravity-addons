'use strict';

/**
 * Internal Unpackaged Electron Dev/CI/Test Boot Strategy: EnvLauncherTransport (D-R4-1).
 *
 * STRICT SCOPE: Unpackaged Electron (`node_modules/electron`) CI, test, and dev harnesses ONLY.
 * Packaged Electron apps block `NODE_OPTIONS=--require` inside `NodeBindings::Initialize`.
 *
 * Guarantees (verified empirically in Phase 1 P1-1):
 * - Always uses `shell: false`.
 * - Formats Windows paths inside double-quoted `NODE_OPTIONS` with forward slashes (`/`) so
 *   Node's C-style escape parser never strips backslashes.
 * - Bootstrap guards `if (process.type !== 'browser') return;` so Renderer/Utility/GPU/Node
 *   children (`ELECTRON_RUN_AS_NODE=1`) never execute main bootstrap.
 * - Quote-aware `NODE_OPTIONS` scrubber strips ONLY its own `--require` flag while preserving
 *   unrelated user flags and paths with spaces.
 */

const path = require('node:path');
const { spawn } = require('node:child_process');

function scrubOwnRequireFromNodeOptions(rawNodeOptions, targetPath) {
  const input = String(rawNodeOptions || '');
  const tokens = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);

  const stripQuotes = (s) =>
    s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))
      ? s.slice(1, -1)
      : s;
  const normalizeForCompare = (p) => {
    const resolved = path.resolve(p);
    return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
  };
  const normTarget = normalizeForCompare(targetPath);
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if ((t === '--require' || t === '-r') && i + 1 < tokens.length) {
      if (normalizeForCompare(stripQuotes(tokens[i + 1])) === normTarget) {
        i++;
        continue;
      }
    } else if (t.startsWith('--require=')) {
      const val = stripQuotes(t.slice('--require='.length));
      if (normalizeForCompare(val) === normTarget) continue;
    }
    out.push(t);
  }
  return out.join(' ');
}

function buildNodeOptionsWithRequire(existingNodeOptions, bootstrapFilePath) {
  const absPath = path.resolve(bootstrapFilePath);
  if (/["\r\n\0]/.test(absPath)) {
    throw new Error('ERR_INVALID_BOOTSTRAP_PATH_CHARS');
  }
  const posixQuoted = `"${absPath.replace(/\\/g, '/')}"`;
  const existing = String(existingNodeOptions || '').trim();
  return existing ? `${existing} --require ${posixQuoted}` : `--require ${posixQuoted}`;
}

function buildUnpackagedBootstrapSource(loaderScriptPath) {
  const absLoader = path.resolve(loaderScriptPath);
  return `'use strict';
if (process.type !== 'browser') return;
const path = require('node:path');
const fs = require('node:fs');
const scrub = ${scrubOwnRequireFromNodeOptions.toString()};
const nextOpts = scrub(process.env.NODE_OPTIONS || '', __filename);
if (nextOpts) process.env.NODE_OPTIONS = nextOpts;
else delete process.env.NODE_OPTIONS;
try {
  const electron = require('electron');
  const loaderPath = ${JSON.stringify(absLoader)};
  if (electron && electron.app && fs.existsSync(loaderPath)) {
    require(loaderPath).initMain(electron.app);
  }
} catch (_err) {
  try { process.stderr.write('[addon-host:env-launcher] ' + (_err && _err.message || _err) + '\\n'); } catch (_i) {}
}
`;
}

function createEnvLauncherTransport() {
  return Object.freeze({
    id: 'env-launcher-unpackaged',
    scrubOwnRequireFromNodeOptions,
    buildNodeOptionsWithRequire,
    buildUnpackagedBootstrapSource,
    launchUnpackaged({ electronExecPath, appArgs = [], bootstrapFilePath, env = process.env, cwd = undefined }) {
      const nextEnv = {
        ...env,
        NODE_OPTIONS: buildNodeOptionsWithRequire(env.NODE_OPTIONS, bootstrapFilePath),
      };
      delete nextEnv.ELECTRON_RUN_AS_NODE;
      return spawn(electronExecPath, appArgs, {
        cwd,
        env: nextEnv,
        shell: false,
        windowsHide: true,
      });
    },
  });
}

module.exports = {
  scrubOwnRequireFromNodeOptions,
  buildNodeOptionsWithRequire,
  buildUnpackagedBootstrapSource,
  createEnvLauncherTransport,
};
