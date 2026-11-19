'use strict';

/**
 * Runtime- & vendor-neutral AddonManifest.v1 validator backed by Ajv JSON Schema,
 * injected `FileSystemPort` (`src/core/fs-port.js`) realpath confinement,
 * compatibility checks (hostProfile, minHostVersion), explicit trust model
 * (`trusted` | `restricted`), and document-transform scope enforcement.
 *
 * ZERO direct `node:fs` or `node:path` imports (SOLID DIP).
 */

const Ajv = require('ajv');
const MANIFEST_SCHEMA = require('../../schemas/addon-manifest.v1.schema.json');
const { assertFileSystemPort } = require('./fs-port');

const FORBIDDEN_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function validatePluginId(pluginId) {
  if (typeof pluginId !== 'string' || !PLUGIN_ID_RE.test(pluginId)) {
    return { ok: false, reason: 'ERR_INVALID_PLUGIN_ID' };
  }
  if (FORBIDDEN_IDS.has(pluginId)) {
    return { ok: false, reason: 'ERR_FORBIDDEN_PLUGIN_ID' };
  }
  return { ok: true, pluginId };
}

function parseSemver(ver) {
  if (typeof ver !== 'string') return null;
  const m = ver.trim().match(SEMVER_RE);
  if (!m) return null;
  const prerelease = m[4] ? m[4].split('.') : null;
  if (prerelease && prerelease.some((id) => /^\d+$/.test(id) && id.length > 1 && id.startsWith('0'))) {
    return null;
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease,
  };
}

/**
 * Strict SemVer 2.0.0 comparator (fail-closed: returns `null` when either input is invalid).
 */
function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;

  if (!pa.prerelease && !pb.prerelease) return 0;
  if (!pa.prerelease) return 1;
  if (!pb.prerelease) return -1;

  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i++) {
    const ia = pa.prerelease[i];
    const ib = pb.prerelease[i];
    if (ia === undefined) return -1;
    if (ib === undefined) return 1;
    if (ia === ib) continue;
    const na = /^\d+$/.test(ia);
    const nb = /^\d+$/.test(ib);
    if (na && nb) return Number(ia) - Number(ib);
    if (na) return -1;
    if (nb) return 1;
    return ia < ib ? -1 : 1;
  }
  return 0;
}

/**
 * Pure JS portable path-only fallback used when `checkExists` is false and no `fsPort` was supplied.
 */
function normalizePortableSegments(rawPath) {
  const slashNorm = String(rawPath || '').replace(/\\/g, '/');
  const isAbs = slashNorm.startsWith('/') || /^[A-Za-z]:\//.test(slashNorm);
  const parts = slashNorm.split('/');
  const stack = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') {
        stack.pop();
      } else if (!isAbs) {
        stack.push('..');
      }
    } else {
      stack.push(part);
    }
  }
  return { isAbs, normalized: (isAbs ? '/' : '') + stack.join('/') };
}

function resolveConfinedScriptPath(
  relScript,
  pluginDir,
  { pluginsRootDir = null, checkExists = true, fsPort = null } = {}
) {
  if (typeof relScript !== 'string' || !relScript.trim()) {
    return { ok: false, reason: 'EMPTY_ENTRY_SCRIPT' };
  }
  if (relScript.includes('\0') || /^[A-Za-z]:/.test(relScript) || relScript.startsWith('/') || relScript.startsWith('\\')) {
    return { ok: false, reason: 'ERR_ENTRY_ESCAPES_PLUGIN_DIR' };
  }

  if (!fsPort) {
    if (checkExists) {
      return { ok: false, reason: 'ERR_FS_PORT_REQUIRED' };
    }
    const { isAbs, normalized } = normalizePortableSegments(relScript);
    if (isAbs || !normalized || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
      return { ok: false, reason: 'ERR_ENTRY_ESCAPES_PLUGIN_DIR' };
    }
    const baseClean = String(pluginDir || '').replace(/[\\/]+$/, '');
    return { ok: true, resolvedPath: baseClean ? `${baseClean}/${normalized}` : normalized };
  }

  const io = assertFileSystemPort(fsPort);
  if (io.isAbsolute(relScript)) {
    return { ok: false, reason: 'ERR_ENTRY_ESCAPES_PLUGIN_DIR' };
  }
  const normalized = io.normalize(relScript);
  if (normalized === '..' || normalized.startsWith(`..${io.sep}`) || normalized.includes(`${io.sep}..${io.sep}`) || normalized.startsWith('..')) {
    return { ok: false, reason: 'ERR_ENTRY_ESCAPES_PLUGIN_DIR' };
  }
  const resolvedBase = io.resolve(pluginDir);
  const resolvedTarget = io.resolve(resolvedBase, normalized);
  const rel = io.relative(resolvedBase, resolvedTarget);
  if (!rel || rel.startsWith('..') || io.isAbsolute(rel)) {
    return { ok: false, reason: 'ERR_ENTRY_ESCAPES_PLUGIN_DIR' };
  }

  if (pluginsRootDir) {
    const resolvedRoot = io.resolve(pluginsRootDir);
    const rootRel = io.relative(resolvedRoot, resolvedBase);
    if (!rootRel || rootRel.startsWith('..') || io.isAbsolute(rootRel)) {
      return { ok: false, reason: 'ERR_PLUGIN_DIR_ESCAPES_ROOT' };
    }
  }

  if (!checkExists) {
    return { ok: true, resolvedPath: resolvedTarget };
  }

  if (!io.existsSync(resolvedTarget) || !io.isFileSync(resolvedTarget)) {
    return { ok: false, reason: 'ERR_ENTRY_SCRIPT_NOT_FOUND', resolvedPath: resolvedTarget };
  }

  try {
    const realBase = io.realpathSync(resolvedBase);
    if (pluginsRootDir && io.existsSync(pluginsRootDir)) {
      const realRoot = io.realpathSync(io.resolve(pluginsRootDir));
      const realRootRel = io.relative(realRoot, realBase);
      if (!realRootRel || realRootRel.startsWith('..') || io.isAbsolute(realRootRel)) {
        return { ok: false, reason: 'ERR_PLUGIN_DIR_SYMLINK_ESCAPE' };
      }
    }
    const realTarget = io.realpathSync(resolvedTarget);
    const realRel = io.relative(realBase, realTarget);
    if (!realRel || realRel.startsWith('..') || io.isAbsolute(realRel)) {
      return { ok: false, reason: 'ERR_ENTRY_ESCAPES_PLUGIN_DIR' };
    }
    return { ok: true, resolvedPath: realTarget };
  } catch (_err) {
    return { ok: false, reason: 'ERR_ENTRY_REALPATH_FAILED' };
  }
}

function createManifestValidator({ schema = MANIFEST_SCHEMA, fsPort = null } = {}) {
  const defaultFsPort = fsPort ? assertFileSystemPort(fsPort) : null;
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validateSchema = ajv.compile(schema);

  function validate(
    manifest,
    {
      pluginsRootDir = null,
      checkFilesExist = false,
      hostProfileId = null,
      hostVersion = undefined,
      strictTrustPolicy = false,
      fsPort: callFsPort = null,
    } = {}
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
      if (manifest.compatibility.minHostVersion) {
        if (!parseSemver(manifest.compatibility.minHostVersion)) {
          return {
            ok: false,
            reason: 'ERR_MANIFEST_SCHEMA_INVALID',
            errors: [`Invalid SemVer 2.0.0 minHostVersion: ${manifest.compatibility.minHostVersion}`],
          };
        }
        if (hostVersion !== undefined) {
          const cmp = compareSemver(hostVersion, manifest.compatibility.minHostVersion);
          if (cmp === null || cmp < 0) {
            return {
              ok: false,
              reason: 'ERR_INCOMPATIBLE_HOST_VERSION',
              errors: [`Requires hostVersion >= ${manifest.compatibility.minHostVersion}, current is ${hostVersion}`],
            };
          }
        }
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
    let hasDocumentTransformSlot = false;
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
        hasDocumentTransformSlot = true;
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

    // Explicit trust policy enforcement (P1):
    // - Declared `restricted` (or `strictTrustPolicy: true` without explicit `trusted`) CANNOT use
    //   `mainHook` or `document-transform`.
    // - Legacy v1.0 manifests omitting `trustLevel` stay compatible in non-strict mode while carrying
    //   `implicitTrustLevel: true` so hosts/diagnostics can audit them.
    const declaredTrust = manifest.trustLevel || null;
    const requiresTrusted = caps.has('mainHook') || hasDocumentTransformSlot;
    const effectiveTrustLevel = declaredTrust || (strictTrustPolicy ? 'restricted' : requiresTrusted ? 'trusted' : 'restricted');
    if (effectiveTrustLevel === 'restricted') {
      if (caps.has('mainHook')) {
        return {
          ok: false,
          reason: 'ERR_RESTRICTED_MAIN_HOOK_FORBIDDEN',
          errors: ['Restricted plugins cannot declare "mainHook" capability; requires trustLevel: "trusted"'],
        };
      }
      if (hasDocumentTransformSlot) {
        return {
          ok: false,
          reason: 'ERR_RESTRICTED_DOCUMENT_TRANSFORM_FORBIDDEN',
          errors: ['Restricted plugins cannot declare "document-transform" slot; requires trustLevel: "trusted"'],
        };
      }
    }

    const activeFsPort = callFsPort ? assertFileSystemPort(callFsPort) : defaultFsPort;
    const resolvedEntries = { rendererScript: null, mainHookScript: null };
    const pluginDir = activeFsPort
      ? pluginsRootDir
        ? activeFsPort.join(pluginsRootDir, manifest.pluginId)
        : activeFsPort.join('plugins', manifest.pluginId)
      : pluginsRootDir
        ? `${String(pluginsRootDir).replace(/[\\/]+$/, '')}/${manifest.pluginId}`
        : `plugins/${manifest.pluginId}`;

    if (entry.rendererScript) {
      const res = resolveConfinedScriptPath(entry.rendererScript, pluginDir, {
        pluginsRootDir,
        checkExists: Boolean(checkFilesExist && pluginsRootDir),
        fsPort: activeFsPort,
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
        fsPort: activeFsPort,
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
      trustLevel: effectiveTrustLevel,
      implicitTrustLevel: !declaredTrust,
      hasDocumentTransformSlot,
      resolvedEntries,
      manifest,
    };
  }

  return Object.freeze({ validate });
}

const defaultValidator = createManifestValidator();

function validateAddonManifest(manifest, opts = {}) {
  return defaultValidator.validate(manifest, opts);
}

module.exports = {
  MANIFEST_SCHEMA,
  FORBIDDEN_IDS,
  PLUGIN_ID_RE,
  validatePluginId,
  compareSemver,
  resolveConfinedScriptPath,
  createManifestValidator,
  validateAddonManifest,
};
