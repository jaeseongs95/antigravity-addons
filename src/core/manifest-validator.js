'use strict';

/**
 * Runtime- & vendor-neutral AddonManifest v1/v2 validator backed by precompiled
 * zero-dependency standalone JSON Schema validators, injected `FileSystemPort`
 * realpath confinement, compatibility checks (hostProfile, minHostVersion),
 * Default-Deny trust metadata (`strictTrustPolicy = true`), and v2 normalization.
 *
 * ZERO direct `node:fs`, `node:path`, `node:os`, `node:child_process`, vendor,
 * or runtime `ajv` imports (SOLID DIP — TC-001 / TC-023 / 0-dep AST gate).
 */

const MANIFEST_SCHEMA_V1 = require('../../schemas/addon-manifest.v1.schema.json');
const MANIFEST_SCHEMA_V2 = require('../../schemas/addon-manifest.v2.schema.json');
const MANIFEST_SCHEMA_V3 = require('../../schemas/addon-manifest.v3.schema.json');
const defaultValidateV1 = require('./generated/validate-v1.cjs');
const defaultValidateV2 = require('./generated/validate-v2.cjs');
const defaultValidateV3 = require('./generated/validate-v3.cjs');
const { assertFileSystemPort } = require('./fs-port');
const { normalizeManifestToV2 } = require('./manifest-normalizer');
const { getPrivilegedRequirements } = require('./trust-policy-port');
const { validateNetPermissions } = require('./net-policy');
const { validateServicePermissions } = require('./service-bus-policy');
const { validateSecretsPermissions } = require('./secrets-policy');

const MANIFEST_SCHEMA = MANIFEST_SCHEMA_V1;
const FORBIDDEN_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const RESERVED_SETTINGS_BRIDGE_FILES = new Set([
  'trust-policy.json',
  'remote-bridge.json',
  'remote-preferences.json',
  'secrets-vault.json',
  'host-cli.json',
  'config.json',
  'index.json',
  'build-manifest.json',
  'package.json',
]);
const SETTINGS_FILE_RE = /^[a-z0-9][a-z0-9._-]{1,63}\.json$/;
const WINDOWS_DOS_DEVICE_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

function isReservedSettingsFileName(fileName) {
  if (typeof fileName !== 'string' || !SETTINGS_FILE_RE.test(fileName)) return true;
  if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) return true;
  const lower = fileName.toLowerCase();
  if (RESERVED_SETTINGS_BRIDGE_FILES.has(lower)) return true;
  if (lower.endsWith('.orig.json')) return true;
  if (WINDOWS_DOS_DEVICE_RE.test(lower)) return true;
  return false;
}
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

function createManifestValidator({ validators = null, fsPort = null } = {}) {
  const defaultFsPort = fsPort ? assertFileSystemPort(fsPort) : null;
  const compiled = {
    1: (validators && validators[1]) || defaultValidateV1,
    2: (validators && validators[2]) || defaultValidateV2,
    3: (validators && validators[3]) || defaultValidateV3,
  };

  function validate(
    manifest,
    {
      pluginsRootDir = null,
      checkFilesExist = false,
      hostProfileId = null,
      compatibleHostProfiles = null,
      supportedCapabilities = null,
      forbiddenNetHosts = null,
      hostVersion = undefined,
      strictTrustPolicy = true,
      fsPort: callFsPort = null,
    } = {}
  ) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      return { ok: false, reason: 'INVALID_MANIFEST_OBJECT', errors: ['Manifest must be a JSON object'] };
    }

    const schemaVer = manifest.schemaVersion;
    const validateSchema =
      schemaVer === 1 ? compiled[1] : schemaVer === 2 ? compiled[2] : schemaVer === 3 ? compiled[3] : null;
    if (!validateSchema) {
      return {
        ok: false,
        reason: 'ERR_MANIFEST_SCHEMA_INVALID',
        errors: [`/schemaVersion must be 1, 2, or 3 (got ${String(schemaVer)})`],
      };
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
      const compat = manifest.compatibility;
      if (hostProfileId) {
        if (Array.isArray(compat.excludeHostProfiles) && compat.excludeHostProfiles.includes(hostProfileId)) {
          return {
            ok: false,
            reason: 'ERR_INCOMPATIBLE_HOST_PROFILE',
            errors: [`Host profile "${hostProfileId}" is excluded by compatibility.excludeHostProfiles`],
          };
        }
        if (Array.isArray(compat.hostProfiles) && compat.hostProfiles.length > 0) {
          if (!compat.hostProfiles.includes(hostProfileId)) {
            return {
              ok: false,
              reason: 'ERR_INCOMPATIBLE_HOST_PROFILE',
              errors: [`Requires hostProfile in [${compat.hostProfiles.join(', ')}], current is "${hostProfileId}"`],
            };
          }
        } else if (compat.hostProfile && compat.hostProfile !== hostProfileId) {
          const acceptedCompat =
            Array.isArray(compatibleHostProfiles) && compatibleHostProfiles.includes(compat.hostProfile);
          if (!acceptedCompat) {
            return {
              ok: false,
              reason: 'ERR_INCOMPATIBLE_HOST_PROFILE',
              errors: [`Requires hostProfile "${compat.hostProfile}", current is "${hostProfileId}"`],
            };
          }
        }
      }
      if (compat.minHostVersion) {
        if (!parseSemver(compat.minHostVersion)) {
          return {
            ok: false,
            reason: 'ERR_MANIFEST_SCHEMA_INVALID',
            errors: [`Invalid SemVer 2.0.0 minHostVersion: ${compat.minHostVersion}`],
          };
        }
        if (hostVersion !== undefined) {
          const cmp = compareSemver(hostVersion, compat.minHostVersion);
          if (cmp === null || cmp < 0) {
            return {
              ok: false,
              reason: 'ERR_INCOMPATIBLE_HOST_VERSION',
              errors: [`Requires hostVersion >= ${compat.minHostVersion}, current is ${hostVersion}`],
            };
          }
        }
      }
    }

    const caps = new Set(manifest.capabilities || []);
    const skippedCapabilities = [];
    if (Array.isArray(supportedCapabilities) && supportedCapabilities.length > 0) {
      const supportedSet = new Set(supportedCapabilities);
      let supportedCount = 0;
      for (const c of caps) {
        if (supportedSet.has(c)) {
          supportedCount += 1;
        } else {
          skippedCapabilities.push(c);
        }
      }
      if (supportedCount === 0) {
        return {
          ok: false,
          reason: 'ERR_UNSUPPORTED_HOST_CAPABILITY',
          errors: [
            `None of declared capabilities [${Array.from(caps).join(', ')}] are supported by host [${supportedCapabilities.join(', ')}]`,
          ],
        };
      }
    }
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
        if (s.shadow === true) {
          return {
            ok: false,
            reason: 'ERR_DOCUMENT_TRANSFORM_CANNOT_USE_SHADOW',
            errors: ['document-transform slot cannot set shadow: true'],
          };
        }
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

    if (manifest.settingsBridge && typeof manifest.settingsBridge === 'object') {
      if (isReservedSettingsFileName(manifest.settingsBridge.fileName)) {
        return {
          ok: false,
          reason: 'ERR_RESERVED_SETTINGS_BRIDGE_FILE',
          errors: [`settingsBridge.fileName "${String(manifest.settingsBridge.fileName || '')}" is reserved or invalid`],
        };
      }
    }

    const configBridgeSource =
      manifest.configBridge ||
      (manifest.permissions && typeof manifest.permissions === 'object' ? manifest.permissions.configBridge : null);
    if (configBridgeSource && typeof configBridgeSource === 'object' && Array.isArray(configBridgeSource.scopes)) {
      const seenScopes = new Set();
      for (const sc of configBridgeSource.scopes) {
        if (!sc || typeof sc.scopeId !== 'string') continue;
        if (seenScopes.has(sc.scopeId)) {
          return {
            ok: false,
            reason: 'ERR_DUPLICATE_CONFIG_SCOPE_IN_MANIFEST',
            errors: [`Duplicate configBridge scopeId "${sc.scopeId}" within the same manifest`],
          };
        }
        seenScopes.add(sc.scopeId);
      }
    }

    const perms = manifest.permissions && typeof manifest.permissions === 'object' ? manifest.permissions : null;
    if (perms && perms.dom && perms.dom.documentTransform === true) {
      hasDocumentTransformSlot = true;
      if (manifest.isolation && manifest.isolation.respectsNoTranslate === false) {
        return {
          ok: false,
          reason: 'ERR_DOCUMENT_TRANSFORM_MUST_RESPECT_NO_TRANSLATE',
          errors: ['document-transform addons must keep isolation.respectsNoTranslate !== false'],
        };
      }
    }

    // Declarative trust validation (v2/v3 Default-Deny):
    // - `strictTrustPolicy` defaults to `true`.
    // - Omitting `trustLevel` under strict mode defaults to `restricted`, blocking `mainHook`,
    //   `document-transform`, `settingsBridge`, `configBridge`, and `net.localLoopback`.
    // - Declaring `trustLevel: "trusted"` passes static manifest validation with `requiresTrustApproval: true`;
    //   actual runtime execution STILL requires host `trust-policy.json` SHA-256 pinning (TrustPolicyPort / TrustVerifier).
    const declaredTrust = manifest.trustLevel || null;
    const reqs = getPrivilegedRequirements(manifest);
    const effectiveTrustLevel =
      declaredTrust ||
      (strictTrustPolicy
        ? 'restricted'
        : reqs.hasMainHook ||
            reqs.hasDocumentTransform ||
            reqs.hasSettingsBridge ||
            reqs.hasConfigBridge ||
            reqs.hasLocalLoopback ||
            reqs.hasHostServiceProvide ||
            reqs.hasSecrets
          ? 'trusted'
          : 'restricted');
    if (effectiveTrustLevel === 'restricted') {
      if (caps.has('mainHook')) {
        return {
          ok: false,
          reason: 'ERR_RESTRICTED_MAIN_HOOK_FORBIDDEN',
          errors: ['Restricted plugins cannot declare "mainHook" capability; requires trustLevel: "trusted" and host trust approval'],
        };
      }
      if (hasDocumentTransformSlot) {
        return {
          ok: false,
          reason: 'ERR_RESTRICTED_DOCUMENT_TRANSFORM_FORBIDDEN',
          errors: ['Restricted plugins cannot declare "document-transform" slot; requires trustLevel: "trusted" and host trust approval'],
        };
      }
      if (reqs.hasSettingsBridge) {
        return {
          ok: false,
          reason: 'ERR_RESTRICTED_SETTINGS_BRIDGE_FORBIDDEN',
          errors: ['Restricted plugins cannot declare "settingsBridge"; requires trustLevel: "trusted" and host trust approval'],
        };
      }
      if (reqs.hasConfigBridge) {
        return {
          ok: false,
          reason: 'ERR_RESTRICTED_CONFIG_BRIDGE_FORBIDDEN',
          errors: ['Restricted plugins cannot declare "configBridge"; requires trustLevel: "trusted" and host trust approval'],
        };
      }
      if (reqs.hasLocalLoopback) {
        return {
          ok: false,
          reason: 'ERR_RESTRICTED_LOCAL_LOOPBACK_FORBIDDEN',
          errors: ['Restricted plugins cannot declare "permissions.net.localLoopback"; requires trustLevel: "trusted" and host trust approval'],
        };
      }
      if (reqs.hasHostServiceProvide) {
        return {
          ok: false,
          reason: 'ERR_RESTRICTED_HOST_SERVICE_FORBIDDEN',
          errors: ['Restricted plugins cannot provide well-known "host.*" services; requires trustLevel: "trusted" and host trust approval'],
        };
      }
      if (reqs.hasSecrets) {
        return {
          ok: false,
          reason: 'ERR_RESTRICTED_SECRETS_FORBIDDEN',
          errors: ['Restricted plugins cannot declare "permissions.secrets"; requires trustLevel: "trusted" and host trust approval'],
        };
      }
    }

    if (perms && perms.net) {
      const netCheck = validateNetPermissions(perms.net, {
        trustLevel: effectiveTrustLevel,
        forbiddenHosts: Array.isArray(forbiddenNetHosts) ? forbiddenNetHosts : [],
      });
      if (!netCheck.ok) {
        return { ok: false, reason: netCheck.reason, errors: netCheck.errors || [netCheck.reason] };
      }
    }

    if (perms && perms.secrets) {
      const secretsCheck = validateSecretsPermissions(perms.secrets, {
        trustLevel: effectiveTrustLevel,
      });
      if (!secretsCheck.ok) {
        return { ok: false, reason: secretsCheck.reason, errors: secretsCheck.errors || [secretsCheck.reason] };
      }
    }

    if (perms && perms.services) {
      const svcCheck = validateServicePermissions(manifest.pluginId, perms.services);
      if (!svcCheck.ok) {
        return { ok: false, reason: svcCheck.reason, errors: svcCheck.errors || [svcCheck.reason] };
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

    if (entry.rendererScript && !skippedCapabilities.includes('renderer')) {
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

    if (entry.mainHookScript && !skippedCapabilities.includes('mainHook')) {
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

    const normalizedManifest = normalizeManifestToV2(manifest);

    return {
      ok: true,
      pluginId: manifest.pluginId,
      sourceSchemaVersion: normalizedManifest.sourceSchemaVersion,
      loadOrder: normalizedManifest.loadOrder,
      trustLevel: effectiveTrustLevel,
      implicitTrustLevel: !declaredTrust,
      requiresTrustApproval: reqs.requiresTrustApproval,
      privilegedCapabilities: reqs.privilegedCapabilities,
      hasDocumentTransformSlot,
      hasSettingsBridge: reqs.hasSettingsBridge,
      hasConfigBridge: reqs.hasConfigBridge,
      hasSecrets: reqs.hasSecrets,
      skippedCapabilities,
      resolvedEntries,
      manifest: normalizedManifest,
      rawManifest: manifest,
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
  MANIFEST_SCHEMA_V1,
  MANIFEST_SCHEMA_V2,
  MANIFEST_SCHEMA_V3,
  FORBIDDEN_IDS,
  RESERVED_SETTINGS_BRIDGE_FILES,
  SETTINGS_FILE_RE,
  PLUGIN_ID_RE,
  isReservedSettingsFileName,
  validatePluginId,
  compareSemver,
  resolveConfinedScriptPath,
  createManifestValidator,
  validateAddonManifest,
};
