#!/usr/bin/env node
'use strict';

/**
 * `@extenra/sdk` Developer CLI (`extenra-addon` / `ag-addon init|check|dev|build|pack`) — v3.2.0.
 * Zero external runtime dependencies (uses Node built-ins + host manifest validator when present).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const UNSAFE_SINK_RE = /\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\s*\(|new\s+Function\s*\()/;

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function cmdInit(targetDir, pluginId = 'my-addon') {
  const dir = path.resolve(targetDir || '.');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const manifest = {
    schemaVersion: 3,
    apiVersion: 3,
    pluginId,
    displayName: pluginId,
    description: 'Antigravity AddonManifest.v3 plugin',
    version: '0.1.0',
    trustLevel: 'restricted',
    capabilities: ['renderer'],
    entry: {
      rendererScript: 'src/index.js',
    },
    permissions: {
      ui: { toasts: true, overlays: true, statusItems: true, settingsPages: true },
      storage: { maxBytes: 65536 },
    },
  };
  fs.writeFileSync(path.join(dir, 'addon-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  const entryCode = `'use strict';

// AddonManifest.v3 renderer entry receives frozen AddonContextV3 as \`addonHost\`.
(function setup(ctx) {
  ctx.ui.registerStatusItem({
    id: 'main',
    label: ctx.meta.displayName,
    onClick: ({ anchorEl }) => {
      ctx.ui.openPopup({
        title: ctx.meta.displayName,
        placement: { zone: 'anchor', anchorEl, prefer: 'top-end' },
        tree: {
          type: 'stack',
          children: [
            { type: 'text', text: 'Hello from ' + ctx.meta.displayName + ' (' + ctx.env.surface + ')' },
            { type: 'button', id: 'toast-btn', label: 'Say Hi', variant: 'primary', actionId: 'hi' },
          ],
        },
        onAction: ({ actionId }) => {
          if (actionId === 'hi') {
            ctx.ui.showToast({ message: 'Hello from v3 API!', variant: 'success' });
          }
        },
      });
    },
  });
})(addonHost);
`;
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), entryCode, 'utf8');
  return { ok: true, command: 'init', dir, pluginId };
}

function cmdCheck(targetDir) {
  const dir = path.resolve(targetDir || '.');
  const manifestPath = path.join(dir, 'addon-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, command: 'check', errors: [`Missing ${manifestPath}`] };
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return { ok: false, command: 'check', errors: [`Invalid JSON: ${err.message}`] };
  }

  const errors = [];
  if (manifest.schemaVersion !== 3) {
    errors.push(`Expected schemaVersion: 3 (got ${String(manifest.schemaVersion)})`);
  }
  if (typeof manifest.pluginId !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(manifest.pluginId)) {
    errors.push(`Invalid pluginId: ${String(manifest.pluginId)}`);
  }

  // Optional deep schema check using parent workspace validator when available
  try {
    const validatorPath = path.resolve(__dirname, '..', '..', '..', 'src', 'core', 'manifest-validator.js');
    if (fs.existsSync(validatorPath)) {
      const { validateAddonManifest } = require(validatorPath);
      const res = validateAddonManifest(manifest, { checkFilesExist: false, strictTrustPolicy: true });
      if (!res.ok) {
        errors.push(...(res.errors || [res.reason]));
      }
    }
  } catch (_e) {}

  const rendererRel = manifest.entry && manifest.entry.rendererScript;
  let rendererSha256 = null;
  if (rendererRel) {
    const rendererAbs = path.resolve(dir, rendererRel);
    if (!fs.existsSync(rendererAbs)) {
      errors.push(`Missing rendererScript: ${rendererRel}`);
    } else {
      const src = fs.readFileSync(rendererAbs, 'utf8');
      if (UNSAFE_SINK_RE.test(src)) {
        errors.push(`Unsafe DOM/eval sink detected in ${rendererRel}`);
      }
      rendererSha256 = sha256File(rendererAbs);
    }
  }

  return {
    ok: errors.length === 0,
    command: 'check',
    pluginId: manifest.pluginId || null,
    schemaVersion: manifest.schemaVersion || null,
    rendererSha256,
    errors,
  };
}

function cmdBuildOrPack(targetDir, mode = 'build') {
  const check = cmdCheck(targetDir);
  if (!check.ok) return { ...check, command: mode };
  const dir = path.resolve(targetDir || '.');
  const distDir = path.join(dir, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'addon-manifest.json'), 'utf8'));
  const rendererRel = manifest.entry && manifest.entry.rendererScript;
  const outManifest = {
    ...manifest,
    integrity: {
      ...(manifest.integrity || {}),
      rendererSha256: check.rendererSha256,
    },
  };
  fs.writeFileSync(path.join(distDir, 'addon-manifest.json'), JSON.stringify(outManifest, null, 2) + '\n', 'utf8');
  if (rendererRel) {
    const srcAbs = path.resolve(dir, rendererRel);
    const dstAbs = path.resolve(distDir, rendererRel);
    fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
    fs.copyFileSync(srcAbs, dstAbs);
  }
  const shaPath = path.join(distDir, 'SHA256SUMS.txt');
  const lines = [];
  if (check.rendererSha256 && rendererRel) {
    lines.push(`${check.rendererSha256}  ${rendererRel}`);
  }
  lines.push(`${sha256File(path.join(distDir, 'addon-manifest.json'))}  addon-manifest.json`);
  fs.writeFileSync(shaPath, lines.join('\n') + '\n', 'utf8');
  return {
    ok: true,
    command: mode,
    distDir,
    pluginId: manifest.pluginId,
    rendererSha256: check.rendererSha256,
  };
}

function runSdkCli(argv = process.argv.slice(2)) {
  const [cmd, arg1, arg2] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    return {
      ok: true,
      usage: 'ag-addon <init|check|dev|build|pack> [dir] [pluginId]',
    };
  }
  if (cmd === 'init') return cmdInit(arg1 || '.', arg2 || 'my-addon');
  if (cmd === 'check') return cmdCheck(arg1 || '.');
  if (cmd === 'dev') return { ...cmdCheck(arg1 || '.'), command: 'dev', watchReady: true };
  if (cmd === 'build' || cmd === 'pack') return cmdBuildOrPack(arg1 || '.', cmd);
  return { ok: false, errors: [`Unknown command: ${cmd}`] };
}

if (require.main === module) {
  const res = runSdkCli(process.argv.slice(2));
  process.stdout.write(JSON.stringify(res, null, 2) + '\n');
  if (!res.ok) process.exitCode = 1;
}

module.exports = {
  cmdInit,
  cmdCheck,
  cmdBuildOrPack,
  runSdkCli,
};
