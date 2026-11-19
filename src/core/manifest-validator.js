'use strict';

/**
 * Vendor-neutral AddonManifest.v1 validator backed by Ajv JSON Schema,
 * strict `<pluginsRoot>/<pluginId>/` realpath confinement (blocks pluginId dir symlink escape),
 * compatibility checks (hostProfile, minHostVersion), and document-transform scope enforcement.
 */

const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');

const SCHEMA_PATH = path.resolve(__dirname, '..', '..', 'schemas', 'addon-manifest.v1.schema.json');
const MANIFEST_SCHEMA = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));

const ajv = new Ajv({ allErrors: true, strict: false });
const validateSchema = ajv.compile(MANIFEST_SCHEMA);

const FORBIDDEN_IDS = new Set(['__proto__', 'constructor', 'prototype']);

function parseSemverCore(ver) {
  const m = String(ver || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemver(a, b) {
  const pa = parseSemverCore(a);
  const pb = parseSemverCore(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function resolveConfinedScriptPath(relScript, pluginDir, { pluginsRootDir = null, checkExists = true } = {}) {
  if (typeof relScript !== 'string' || !relScript.trim()) {
    return { ok: false, reason: 'EMPTY_ENTRY_SCRIPT' };
  }
  if (path.isAbsolute(relScript) || /^[A-Za-z]:/.test(relScript) || relScript.includes('\0')) {
    return { ok: false, reason: 'ERR_ENTRY_ESCAPES_PLUGIN_DIR' };
  }
  const normalized = path.normalize(relScript);
  if (normalized.startsWith('..') || normalized.includes(`..${path.sep}`)) {
    return { ok: false, reason: 'ERR_ENTRY_ESCAPES_PLUGIN_DIR' };
  }
  const resolvedBase = path.resolve(pluginDir);
  const resolvedTarget = path.resolve(resolvedBase, normalized);
  const rel = path.relative(resolvedBase, resolvedTarget);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, reason: 'ERR_ENTRY_ESCAPES_PLUGIN_DIR' };
  }

  if (pluginsRootDir) {
    const resolvedRoot = path.resolve(pluginsRootDir);
    const rootRel = path.relative(resolvedRoot, resolvedBase);
    if (!rootRel || rootRel.startsWith('..') || path.isAbsolute(rootRel)) {
      return { ok: false, reason: 'ERR_PLUGIN_DIR_ESCAPES_ROOT' };
    }
  }

  if (!checkExists) {
    return { ok: true, resolvedPath: resolvedTarget };
  }

  if (!fs.existsSync(resolvedTarget)) {
    return { ok: false, reason: 'ERR_ENTRY_SCRIPT_NOT_FOUND', resolvedPath: resolvedTarget };
  }

  try {
    const realBase = fs.realpathSync(resolvedBase);
    if (pluginsRootDir && fs.existsSync(pluginsRootDir)) {
      const realRoot = fs.realpathSync(path.resolve(pluginsRootDir));
      const realRootRel = path.relative(realRoot, realBase);
      if (!realRootRel || realRootRel.startsWith('..') || path.isAbsolute(realRootRel)) {
        return { ok: false, reason: 'ERR_PLUGIN_DIR_SYMLINK_ESCAPE' };
      }
    }
    const realTarget = fs.realpathSync(resolvedTarget);
    const realRel = path.relative(realBase, realTarget);
    if (!realRel || realRel.startsWith('..') || path.isAbsolute(realRel)) {
      return { ok: false, reason: 'ERR_ENTRY_ESCAPES_PLUGIN_DIR' };
    }
    return { ok: true, resolvedPath: realTarget };
  } catch (_err) {
    return { ok: false, reason: 'ERR_ENTRY_REALPATH_FAILED' };
  }
}

function validateAddonManifest(
  manifest,
  { pluginsRootDir = null, checkFilesExist = false, hostProfileId = null, hostVersion = null } = {}
) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, reason: 'INVALID_MANIFEST_OBJECT', errors: ['Manifest must be a JSON object'] };
  }

  const schemaOk = validateSchema(manifest);
  if (!schemaOk) {
    const errors = (validateSchema.errors || []).map((e) => `${e.instancePath || '/'} ${e.message}`);
    return { ok: false, reason: 'ERR_MANIFEST_SCHEMA_INVALID', errors };
  }

  if (FORBIDDEN_IDS.has(manifest.pluginId)) {
    return { ok: false, reason: 'ERR_FORBIDDEN_PLUGIN_ID', errors: [`Forbidden pluginId: ${manifest.pluginId}`] };
  }

  if (manifest.compatibility) {
    if (hostProfileId && manifest.compatibility.hostProfile && manifest.compatibility.hostProfile !== hostProfileId) {
      return {
        ok: false,
        reason: 'ERR_INCOMPATIBLE_HOST_PROFILE',
        errors: [`Requires hostProfile "${manifest.compatibility.hostProfile}", current is "${hostProfileId}"`],
      };
    }
    if (
      hostVersion &&
      manifest.compatibility.minHostVersion &&
      compareSemver(hostVersion, manifest.compatibility.minHostVersion) < 0
    ) {
      return {
        ok: false,
        reason: 'ERR_INCOMPATIBLE_HOST_VERSION',
        errors: [`Requires hostVersion >= ${manifest.compatibility.minHostVersion}, current is ${hostVersion}`],
      };
    }
  }

  const caps = new Set(manifest.capabilities || []);
  const entry = manifest.entry || {};
  if (caps.has('renderer') && !entry.rendererScript) {
    return {
      ok: false,
      reason: 'ERR_MISSING_RENDERER_ENTRY',
      errors: ['Capability "renderer" requires entry.rendererScript'],
    };
  }
  if (caps.has('mainHook') && !entry.mainHookScript) {
    return {
      ok: false,
      reason: 'ERR_MISSING_MAIN_HOOK_ENTRY',
      errors: ['Capability "mainHook" requires entry.mainHookScript'],
    };
  }
  if (!caps.has('renderer') && entry.rendererScript) {
    return {
      ok: false,
      reason: 'ERR_UNDECLARED_RENDERER_CAPABILITY',
      errors: ['entry.rendererScript declared without "renderer" capability'],
    };
  }
  if (!caps.has('mainHook') && entry.mainHookScript) {
    return {
      ok: false,
      reason: 'ERR_UNDECLARED_MAIN_HOOK_CAPABILITY',
      errors: ['entry.mainHookScript declared without "mainHook" capability'],
    };
  }

  const uiSlots = Array.isArray(manifest.uiSlots) ? manifest.uiSlots : [];
  const seenSlotIds = new Set();
  for (const s of uiSlots) {
    if (seenSlotIds.has(s.slotId)) {
      return {
        ok: false,
        reason: 'ERR_DUPLICATE_SLOT_ID_IN_MANIFEST',
        errors: [`Duplicate slotId "${s.slotId}" within the same manifest`],
      };
    }
    seenSlotIds.add(s.slotId);
    if (s.slot === 'document-transform') {
      if (s.scope !== 'native-host-only') {
        return {
          ok: false,
          reason: 'ERR_DOCUMENT_TRANSFORM_SCOPE_REQUIRED',
          errors: ['document-transform slot MUST explicitly set scope: "native-host-only"'],
        };
      }
      if (manifest.isolation && manifest.isolation.respectsNoTranslate === false) {
        return {
          ok: false,
          reason: 'ERR_DOCUMENT_TRANSFORM_MUST_RESPECT_NO_TRANSLATE',
          errors: ['document-transform addons must keep isolation.respectsNoTranslate !== false'],
        };
      }
    }
  }

  const resolvedEntries = { rendererScript: null, mainHookScript: null };
  const pluginDir = pluginsRootDir ? path.join(pluginsRootDir, manifest.pluginId) : path.join('plugins', manifest.pluginId);

  if (entry.rendererScript) {
    const res = resolveConfinedScriptPath(entry.rendererScript, pluginDir, {
      pluginsRootDir,
      checkExists: Boolean(checkFilesExist && pluginsRootDir),
    });
    if (!res.ok) {
      return { ok: false, reason: res.reason, errors: [`rendererScript: ${res.reason}`] };
    }
    resolvedEntries.rendererScript = res.resolvedPath;
  }

  if (entry.mainHookScript) {
    const res = resolveConfinedScriptPath(entry.mainHookScript, pluginDir, {
      pluginsRootDir,
      checkExists: Boolean(checkFilesExist && pluginsRootDir),
    });
    if (!res.ok) {
      return { ok: false, reason: res.reason, errors: [`mainHookScript: ${res.reason}`] };
    }
    resolvedEntries.mainHookScript = res.resolvedPath;
  }

  return {
    ok: true,
    pluginId: manifest.pluginId,
    loadOrder: typeof manifest.loadOrder === 'number' ? manifest.loadOrder : 100,
    resolvedEntries,
    manifest,
  };
}

module.exports = {
  SCHEMA_PATH,
  MANIFEST_SCHEMA,
  FORBIDDEN_IDS,
  compareSemver,
  resolveConfinedScriptPath,
  validateAddonManifest,
};
