const fs = require('node:fs');
const https = require('node:https');
const { createHash } = require('node:crypto');
const { URL } = require('node:url');
const { join, dirname } = require('node:path');

const {
  getNativeUpdaterPlatform,
  getNativeUpdaterArch,
  getNativeUpdaterPlatformVersion
} = require('./updaterIdentity');

const PinnedManifestDefaults = {
  cacheByteLimit: 2 * 1024 * 1024,
  fetchTimeoutMs: 10_000,
  fetchMaxBytes: 2 * 1024 * 1024,
  fetchRedirectLimit: 4,
  endpoint: 'https://updates.discord.com/',
  packageMaxBytes: 1024 * 1024 * 1024,
  packageAggregateMaxBytes: 4 * 1024 * 1024 * 1024
};

const PinnedManifestErrors = {
  CACHE_MISSING: 'cache-missing',
  CACHE_NOT_REGULAR: 'cache-not-regular-file',
  CACHE_TOO_LARGE: 'cache-too-large',
  CACHE_SYMLINK: 'cache-symlink',
  CACHE_PARSE: 'cache-parse-error',
  FETCH_STATUS: 'fetch-non-success-status',
  FETCH_REDIRECT_LIMIT: 'fetch-redirect-limit-exceeded',
  FETCH_TIMEOUT: 'fetch-timeout',
  FETCH_NETWORK: 'fetch-network-error',
  FETCH_BODY_TOO_LARGE: 'fetch-body-too-large',
  FETCH_PARSE: 'fetch-parse-error',
  MANIFEST_NOT_OBJECT: 'manifest-not-object',
  MANIFEST_FULL_MISSING: 'manifest-full-missing',
  MANIFEST_FULL_VERSION: 'manifest-full-version-mismatch',
  MANIFEST_SHA_INVALID: 'manifest-sha-invalid',
  MANIFEST_URL_INVALID: 'manifest-url-invalid',
  MANIFEST_REQUIRED_MODULES_INVALID: 'manifest-required-modules-invalid',
  MANIFEST_MODULES_INVALID: 'manifest-modules-invalid',
  MANIFEST_REQUIRED_ENTRY_MISSING: 'manifest-required-entry-missing',
  MANIFEST_MODULE_FULL_MISSING: 'manifest-module-full-missing',
  MANIFEST_MODULE_VERSION_INVALID: 'manifest-module-version-invalid',
  MANIFEST_PATH_INVALID: 'manifest-path-invalid',
  MANIFEST_WRITE_ERROR: 'manifest-write-error',
  MANIFEST_METADATA_INVALID: 'manifest-metadata-invalid'
};

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isFiniteSafeInteger = value => Number.isSafeInteger(value) && value >= 0;
const getVersionText = value => {
  if (typeof value === 'string') {
    return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) ? value : null;
  }
  if (!Array.isArray(value) || value.length !== 3 || !value.every(isFiniteSafeInteger)) return null;
  return value.join('.');
};
const getManifestVersionText = value => (
  Array.isArray(value) && value.length === 3 && value.every(isFiniteSafeInteger)
    ? value.join('.')
    : null
);
const isHexSha = value => typeof value === 'string' && /^[A-Fa-f0-9]{64}$/.test(value);
const isValidModuleName = value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
const getSha = entry => entry.package_sha256 || entry.sha256 || entry.sha;
const normalizeModuleVersion = value => {
  if (isFiniteSafeInteger(value)) return value;
  if (typeof value === 'string') {
    if (/^\d+$/.test(value)) {
      const parsed = Number(value);
      if (isFiniteSafeInteger(parsed)) return parsed;
    }
    return null;
  }
  return null;
};

const makeError = (code, message, details = {}) => ({ code, message, details });

const logEvent = (callback, event, details) => {
  if (typeof callback === 'function') callback({ event, ...details });
};

const pinnedManifestFileName = 'pinned_update.json';
const getPinnedManifestPath = userData => join(userData, pinnedManifestFileName);

const splitPath = value => String(value || '').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);

const isDiscordHost = hostname =>
  hostname === 'discordapp.net' || hostname.endsWith('.discordapp.net');
const isDiscordApiHost = hostname => hostname === 'discord.com' || hostname === 'api.discord.com' || hostname.endsWith('.discord.com');

const validateManifestPath = (value, constraints, versionHint) => {
  const { channel, platform, arch } = constraints;
  const expectedVersion = getVersionText(versionHint) || getVersionText(constraints.version);
  if (typeof value !== 'string' || value.length === 0) return makeError(PinnedManifestErrors.MANIFEST_PATH_INVALID, 'Path must be a string');
  if (value.startsWith('/')) return makeError(PinnedManifestErrors.MANIFEST_PATH_INVALID, 'Path must be relative');
  if (value.includes('..')) return makeError(PinnedManifestErrors.MANIFEST_PATH_INVALID, 'Path traversal not allowed');

  const segments = splitPath(value);
  if (segments.length < 6) return makeError(PinnedManifestErrors.MANIFEST_PATH_INVALID, 'Path does not match expected distribution prefix');

  if (segments[0] !== 'distributions' && segments[0] !== 'distro') {
    return makeError(PinnedManifestErrors.MANIFEST_PATH_INVALID, 'Path root is not distributions/distro');
  }

  if (segments[1] !== 'app' || segments[2] !== channel || segments[3] !== platform) {
    return makeError(PinnedManifestErrors.MANIFEST_PATH_INVALID, 'Path is not for requested channel/platform');
  }

  const archiveArch = segments[4];
  if (archiveArch !== arch && !(platform === 'osx' && archiveArch === 'universal')) {
    return makeError(PinnedManifestErrors.MANIFEST_PATH_INVALID, 'Path architecture segment does not match expected');
  }

  if (segments[5] !== expectedVersion) {
    return makeError(PinnedManifestErrors.MANIFEST_PATH_INVALID, 'Path version segment does not match requested version');
  }

  return null;
};

const validateManifestUrl = (value, constraints, versionHint) => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') return makeError(PinnedManifestErrors.MANIFEST_URL_INVALID, 'URL is not https');
    if (!isDiscordHost(parsed.hostname)) return makeError(PinnedManifestErrors.MANIFEST_URL_INVALID, 'URL host is not discordapp.net');

    return validateManifestPath(parsed.pathname.replace(/^\/+/, ''), constraints, versionHint);
  } catch {
    return makeError(PinnedManifestErrors.MANIFEST_URL_INVALID, 'URL parse failed');
  }
};

const validateModuleFull = ({ moduleName, full, constraints }) => {
  if (!isObject(full)) return makeError(PinnedManifestErrors.MANIFEST_MODULE_FULL_MISSING, 'Module full package is missing', { moduleName });
  const fullVersion = getManifestVersionText(full.host_version);
  const expectedVersion = getVersionText(constraints.version);

  if (!fullVersion || fullVersion !== expectedVersion) {
    return makeError(PinnedManifestErrors.MANIFEST_MODULE_FULL_MISSING, 'Module full host_version must match target version', {
      moduleName,
      expected: expectedVersion,
      actual: getVersionText(full.host_version)
    });
  }

  const moduleVersion = full.module_version ?? full.version;
  if (!isFiniteSafeInteger(moduleVersion)) {
    return makeError(PinnedManifestErrors.MANIFEST_MODULE_VERSION_INVALID, 'Module full module_version must be a safe non-negative integer', {
      moduleName,
      value: moduleVersion
    });
  }

  if (!isHexSha(getSha(full))) {
    return makeError(PinnedManifestErrors.MANIFEST_SHA_INVALID, 'Module full sha must be 64 hex chars', { moduleName });
  }

  const urlError = validateManifestUrl(full.url, constraints, expectedVersion);
  if (urlError) return urlError;

  if (full.target !== undefined) {
    const pathError = validateManifestPath(full.target, constraints, expectedVersion);
    if (pathError) return pathError;
  }

  return null;
};

const validateModuleDelta = ({ delta, moduleName, constraints }) => {
  if (!isObject(delta)) return makeError(PinnedManifestErrors.MANIFEST_MODULES_INVALID, 'Module delta must be an object', { moduleName });
  const deltaVersion = getManifestVersionText(delta.host_version);
  if (!deltaVersion) {
    return makeError(PinnedManifestErrors.MANIFEST_FULL_VERSION, 'Module delta host_version must be a valid version array or dotted string', {
      moduleName,
      actual: delta.host_version
    });
  }

  if (!isHexSha(getSha(delta))) {
    return makeError(PinnedManifestErrors.MANIFEST_SHA_INVALID, 'Module delta sha must be 64 hex chars', { moduleName });
  }

  if (delta.module_version !== undefined && !isFiniteSafeInteger(delta.module_version)) {
    return makeError(PinnedManifestErrors.MANIFEST_MODULE_VERSION_INVALID, 'Module delta module_version must be a safe non-negative integer', {
      moduleName,
      value: delta.module_version
    });
  }

  const targetVersion = getVersionText(constraints.version);
  const urlError = validateManifestUrl(delta.url, constraints, targetVersion);
  if (urlError) return urlError;

  if (delta.target !== undefined) {
    const pathError = validateManifestPath(delta.target, constraints, targetVersion);
    if (pathError) return pathError;
  }

  return null;
};

const validateModules = ({ modules, requiredModules, constraints }) => {
  if (!isObject(modules)) return makeError(PinnedManifestErrors.MANIFEST_MODULES_INVALID, 'modules must be an object');
  if (!Array.isArray(requiredModules)) return makeError(PinnedManifestErrors.MANIFEST_REQUIRED_MODULES_INVALID, 'required_modules must be an array');
  if (!requiredModules.every((entry) => typeof entry === 'string' && entry.length > 0)) {
    return makeError(PinnedManifestErrors.MANIFEST_REQUIRED_MODULES_INVALID, 'required_modules entries must be non-empty strings');
  }
  if (!requiredModules.every((entry) => isValidModuleName(entry))) {
    return makeError(PinnedManifestErrors.MANIFEST_REQUIRED_MODULES_INVALID, 'required_modules entries must be valid module names');
  }
  if (new Set(requiredModules).size !== requiredModules.length) {
    return makeError(PinnedManifestErrors.MANIFEST_REQUIRED_MODULES_INVALID, 'required_modules entries must be unique');
  }

  for (const [moduleName, moduleData] of Object.entries(modules)) {
    if (!isValidModuleName(moduleName)) {
      return makeError(PinnedManifestErrors.MANIFEST_MODULES_INVALID, 'Invalid module name in modules object', { moduleName });
    }
    if (!isObject(moduleData)) return makeError(PinnedManifestErrors.MANIFEST_REQUIRED_ENTRY_MISSING, 'Module entry must be an object', { moduleName });
    if (!isObject(moduleData.full)) return makeError(PinnedManifestErrors.MANIFEST_MODULE_FULL_MISSING, 'Module entry full payload missing', { moduleName });

    const fullError = validateModuleFull({ moduleName, full: moduleData.full, constraints });
    if (fullError) return fullError;

    const deltas = moduleData.deltas ?? [];
    if (!Array.isArray(deltas)) {
      return makeError(PinnedManifestErrors.MANIFEST_MODULES_INVALID, 'Module deltas must be an array', { moduleName });
    }
    for (const delta of deltas) {
      const deltaError = validateModuleDelta({ delta, moduleName, constraints });
      if (deltaError) return deltaError;
    }
  }

  for (const moduleName of requiredModules) {
    if (!modules[moduleName] || !isObject(modules[moduleName]) || !isObject(modules[moduleName].full)) {
      return makeError(PinnedManifestErrors.MANIFEST_REQUIRED_ENTRY_MISSING, 'required_modules contains a missing full module entry', { moduleName });
    }
  }

  return null;
};

const validateMetadata = ({ metadata_version, required_update }) => {
  if (metadata_version != null && !isFiniteSafeInteger(metadata_version)) {
    return makeError(PinnedManifestErrors.MANIFEST_METADATA_INVALID, 'metadata_version must be a safe non-negative integer');
  }
  if (typeof required_update !== 'boolean') {
    return makeError(PinnedManifestErrors.MANIFEST_METADATA_INVALID, 'required_update must be a boolean');
  }
  return null;
};

const validatePinnedManifest = ({ manifest, constraints }) => {
  if (!isObject(manifest)) return makeError(PinnedManifestErrors.MANIFEST_NOT_OBJECT, 'Manifest must be an object');

  if (!isObject(manifest.full)) return makeError(PinnedManifestErrors.MANIFEST_FULL_MISSING, 'Manifest full payload is required');
  const manifestVersion = getVersionText(constraints.version);
  const fullVersion = getManifestVersionText(manifest.full.host_version);
  if (!fullVersion || fullVersion !== manifestVersion) return makeError(PinnedManifestErrors.MANIFEST_FULL_VERSION, 'Manifest full host_version mismatch', {
    expected: manifestVersion,
    actual: getVersionText(manifest.full.host_version)
  });
  if (!isHexSha(getSha(manifest.full))) return makeError(PinnedManifestErrors.MANIFEST_SHA_INVALID, 'Manifest full sha must be 64 hex chars');
  const fullUrlError = validateManifestUrl(manifest.full.url, constraints, fullVersion);
  if (fullUrlError) return fullUrlError;
  if (manifest.full.target !== undefined) {
    const targetError = validateManifestPath(manifest.full.target, constraints, fullVersion);
    if (targetError) return targetError;
  }

  if (!Array.isArray(manifest.deltas)) {
    return makeError(PinnedManifestErrors.MANIFEST_MODULES_INVALID, 'Manifest deltas must be an array');
  }
  for (const delta of manifest.deltas) {
    const deltaError = validateModuleDelta({ delta, moduleName: 'full', constraints });
    if (deltaError) return deltaError;
  }

  const modulesError = validateModules({
    modules: manifest.modules,
    requiredModules: manifest.required_modules,
    constraints
  });
  if (modulesError) return modulesError;

  const metadataError = validateMetadata(manifest);
  if (metadataError) return metadataError;

  return null;
};

const validatePinnedManifestTemplate = ({ manifest, constraints }) => {
  if (!isObject(manifest)) return makeError(PinnedManifestErrors.MANIFEST_NOT_OBJECT, 'Manifest must be an object');
  if (!isObject(manifest.full)) return makeError(PinnedManifestErrors.MANIFEST_FULL_MISSING, 'Manifest full payload is required');

  const templateVersion = getManifestVersionText(manifest.full.host_version);
  if (!templateVersion) {
    return makeError(PinnedManifestErrors.MANIFEST_FULL_VERSION, 'Manifest full host_version mismatch', {
      expected: getVersionText(constraints.version),
      actual: getVersionText(manifest.full.host_version)
    });
  }
  if (!isHexSha(getSha(manifest.full))) {
    return makeError(PinnedManifestErrors.MANIFEST_SHA_INVALID, 'Manifest full sha must be 64 hex chars');
  }

  const fullUrlError = validateManifestUrl(manifest.full.url, {
    channel: constraints.channel,
    platform: constraints.platform,
    arch: constraints.arch
  }, templateVersion);
  if (fullUrlError) return fullUrlError;

  if (manifest.full.target !== undefined) {
    const targetError = validateManifestPath(manifest.full.target, {
      channel: constraints.channel,
      platform: constraints.platform,
      arch: constraints.arch
    }, templateVersion);
    if (targetError) return targetError;
  }

  if (!isObject(manifest.modules)) return makeError(PinnedManifestErrors.MANIFEST_MODULES_INVALID, 'modules must be an object');
  if (!Array.isArray(manifest.required_modules)) return makeError(PinnedManifestErrors.MANIFEST_REQUIRED_MODULES_INVALID, 'required_modules must be an array');
  if (!manifest.required_modules.every((entry) => typeof entry === 'string' && entry.length > 0)) {
    return makeError(PinnedManifestErrors.MANIFEST_REQUIRED_MODULES_INVALID, 'required_modules entries must be non-empty strings');
  }
  if (!manifest.required_modules.every((entry) => isValidModuleName(entry))) {
    return makeError(PinnedManifestErrors.MANIFEST_REQUIRED_MODULES_INVALID, 'required_modules entries must be valid module names');
  }

  if (new Set(manifest.required_modules).size !== manifest.required_modules.length) {
    return makeError(PinnedManifestErrors.MANIFEST_REQUIRED_MODULES_INVALID, 'required_modules entries must be unique');
  }

  for (const [moduleName, moduleData] of Object.entries(manifest.modules)) {
    if (!isValidModuleName(moduleName)) {
      return makeError(PinnedManifestErrors.MANIFEST_MODULES_INVALID, 'Invalid module name in template modules object', { moduleName });
    }
    if (!isObject(moduleData)) return makeError(PinnedManifestErrors.MANIFEST_REQUIRED_ENTRY_MISSING, 'Module entry must be an object', { moduleName });
    if (!isObject(moduleData.full)) return makeError(PinnedManifestErrors.MANIFEST_MODULE_FULL_MISSING, 'Module entry full payload missing', { moduleName });

    const full = moduleData.full;
    const moduleVersion = getManifestVersionText(full.host_version);
    if (!moduleVersion || moduleVersion !== templateVersion) {
      return makeError(PinnedManifestErrors.MANIFEST_MODULE_FULL_MISSING, 'Template module full host_version must match template full host_version', {
        moduleName,
        expected: templateVersion,
        actual: getVersionText(full.host_version)
      });
    }

    const moduleModuleVersion = normalizeModuleVersion(full.module_version ?? full.version);
    if (!isFiniteSafeInteger(moduleModuleVersion)) {
      return makeError(PinnedManifestErrors.MANIFEST_MODULE_VERSION_INVALID, 'Template module full module_version must be a valid integer', {
        moduleName,
        value: full.module_version
      });
    }

    if (!isHexSha(getSha(full))) {
      return makeError(PinnedManifestErrors.MANIFEST_SHA_INVALID, 'Template module sha must be 64 hex chars', { moduleName });
    }

    const urlError = validateManifestUrl(full.url, {
      channel: constraints.channel,
      platform: constraints.platform,
      arch: constraints.arch
    }, templateVersion);
    if (urlError) return urlError;

    if (full.target !== undefined) {
      const pathError = validateManifestPath(full.target, {
        channel: constraints.channel,
        platform: constraints.platform,
        arch: constraints.arch
      }, templateVersion);
      if (pathError) return pathError;
    }
  }

  for (const moduleName of manifest.required_modules) {
    if (!isObject(manifest.modules[moduleName]) || !isObject(manifest.modules[moduleName].full)) {
      return makeError(PinnedManifestErrors.MANIFEST_REQUIRED_ENTRY_MISSING, 'Template required module missing from modules object', { moduleName });
    }
  }

  const metadataError = validateMetadata(manifest);
  if (metadataError) return metadataError;

  return null;
};

const parseTargetModules = payload => {
  if (!isObject(payload)) return { error: makeError(PinnedManifestErrors.MANIFEST_MODULES_INVALID, 'versions response must be an object') };
  const candidate = isObject(payload.modules) ? payload.modules : payload;
  const entries = {};
  const ignoredKeys = new Set(['host_version', 'metadata_version', 'required_update', 'required_modules', 'full']);
  for (const [moduleName, rawVersion] of Object.entries(candidate)) {
    if (!isValidModuleName(moduleName)) {
      return { error: makeError(PinnedManifestErrors.MANIFEST_MODULES_INVALID, 'versions response contains invalid module name', {
        moduleName
      }) };
    }

    if (ignoredKeys.has(moduleName)) continue;
    const version = normalizeModuleVersion(rawVersion);
    if (version == null) {
      return { error: makeError(PinnedManifestErrors.MANIFEST_MODULE_VERSION_INVALID, 'versions endpoint module_version must be a safe non-negative integer', { moduleName, value: rawVersion }) };
    }
    entries[moduleName] = version;
  }

  return { value: entries };
};

const getPackageVersion = ({ templateUrl, targetVersion, templateModuleVersion, targetModuleVersion }) => {
  const parsed = new URL(templateUrl);
  const segments = splitPath(parsed.pathname);
  if (segments.length < 6) return null;
  if (segments[0] !== 'distributions' && segments[0] !== 'distro') return null;

  const canonicalVersion = getVersionText(targetVersion);
  if (!canonicalVersion) return null;
  if (segments[1] !== 'app' || !segments[2] || !segments[3] || !segments[4]) return null;

  segments[5] = canonicalVersion;

  if (templateModuleVersion != null && targetModuleVersion != null) {
    const currentModuleVersion = normalizeModuleVersion(templateModuleVersion);
    if (currentModuleVersion != null && currentModuleVersion !== targetModuleVersion) {
      const targetText = String(targetModuleVersion);
      const fromText = String(currentModuleVersion);
      let swapped = false;
      for (let i = 6; i < segments.length - 1; i++) {
        if (segments[i] === fromText) {
          segments[i] = targetText;
          swapped = true;
          break;
        }
      }
      if (!swapped) return null;
    }
  }

  return `${parsed.origin}/${segments.join('/')}${parsed.search}`;
};

const getTargetModuleBase = ({ fullUrl, targetVersion }) => {
  const parsed = new URL(fullUrl);
  const segments = splitPath(parsed.pathname);
  if (segments.length < 6) return null;
  if (segments[0] !== 'distributions' && segments[0] !== 'distro') return null;
  if (segments[1] !== 'app' || !segments[2] || !segments[3] || !segments[4]) return null;

  const canonicalVersion = getVersionText(targetVersion);
  if (!canonicalVersion) return null;
  segments[5] = canonicalVersion;

  return `${parsed.origin}/${segments.slice(0, 6).join('/')}`;
};

const fetchVersionsFromEndpoint = ({
  channel,
  platform,
  targetVersion,
  fetchImpl,
  requestImpl,
  opts
}) => {
  const endpoint = 'https://discord.com';
  const parsedEndpoint = new URL(endpoint);
  if (!isDiscordApiHost(parsedEndpoint.hostname)) {
    return {
      error: makeError(PinnedManifestErrors.MANIFEST_URL_INVALID, 'Pinned manifest version endpoint host is invalid', {
        endpoint
      })
    };
  }

  const versionsUrl = new URL(`api/modules/${channel}/versions.json`, endpoint);
  versionsUrl.searchParams.set('host_version', targetVersion);
  versionsUrl.searchParams.set('platform', platform);

  return fetchImpl({
    url: versionsUrl.toString(),
    timeoutMs: opts.fetchTimeoutMs,
    maxBytes: opts.fetchMaxBytes,
    maxRedirects: opts.fetchRedirectLimit,
    requestImpl
  });
};

const hashPinnedPackage = async ({
  url,
  timeoutMs,
  maxBytes,
  maxRedirects,
  requestImpl,
  logEvent: eventSink = () => {}
}) => {
  const hash = createHash('sha256');
  let size = 0;
  try {
    await doHttpsRequest({
      url,
      timeoutMs,
      maxBytes,
      maxRedirects,
      requestImpl,
      hostPolicy: isDiscordHost,
      onData: (chunk) => {
        size += chunk.length;
        hash.update(chunk);
      }
    });
    return { value: { package_sha256: hash.digest('hex'), bytes: size } };
  } catch (error) {
    if (error?.code) return { error };
    return { error: makeError(PinnedManifestErrors.FETCH_NETWORK, 'Pinned manifest package fetch failed', {
      message: error?.message || 'Unknown package fetch failure'
    }) };
  }
};

const synthesizePinnedManifest = async ({
  templateManifest,
  targetVersion,
  targetModules,
  constraints,
  options,
  eventSink,
  hashPackage,
  requestImpl
}) => {
  const { version } = constraints;
  const templateVersion = getManifestVersionText(templateManifest.full.host_version);
  if (!templateVersion) return { error: makeError(PinnedManifestErrors.MANIFEST_FULL_VERSION, 'Template host_version must be a valid version', {
    actual: templateManifest.full.host_version
  })};
  logEvent(eventSink, 'synthesis-start', {
    templateVersion,
    targetVersion,
    requiredModules: templateManifest.required_modules,
    templateModules: Object.keys(templateManifest.modules || {}).length
  });

  const targetVersionText = getVersionText(targetVersion);
  if (!targetVersionText) return { error: makeError(PinnedManifestErrors.MANIFEST_FULL_VERSION, 'Target host_version must be a valid version', {
    expected: version
  })};

  const fullUrl = getPackageVersion({
    templateUrl: templateManifest.full.url,
    targetVersion: targetVersionText
  });
  if (!fullUrl) return { error: makeError(PinnedManifestErrors.MANIFEST_URL_INVALID, 'Failed to derive target full manifest URL', {
    url: templateManifest.full.url
  })};

  const packageVersions = parseTargetModules(targetModules);
  if (packageVersions.error) return { error: packageVersions.error };
  const requiredTemplateModules = new Set(templateManifest.required_modules);
  for (const moduleName of templateManifest.required_modules) {
    if (packageVersions.value[moduleName] == null) {
      return { error: makeError(PinnedManifestErrors.MANIFEST_REQUIRED_ENTRY_MISSING, 'required module missing from target versions endpoint', { moduleName }) };
    }
  }

  const packagePlan = [{
    name: 'full',
    url: fullUrl,
    packageType: 'full'
  }];
  const moduleBaseUrl = getTargetModuleBase({ fullUrl, targetVersion: targetVersionText });
  if (!moduleBaseUrl) {
    return { error: makeError(PinnedManifestErrors.MANIFEST_URL_INVALID, 'Failed to derive target module URL base', {
      url: fullUrl
    })};
  }
  for (const [moduleName, moduleVersion] of Object.entries(packageVersions.value)) {
    if (requiredTemplateModules.has(moduleName) && (!templateManifest.modules[moduleName] || !templateManifest.modules[moduleName].full || !isObject(templateManifest.modules[moduleName].full))) {
      return { error: makeError(PinnedManifestErrors.MANIFEST_REQUIRED_ENTRY_MISSING, 'Template module entry missing for required target module', { moduleName }) };
    }

    const moduleUrl = `${moduleBaseUrl}/${moduleName}/${moduleVersion}/full.distro`;

    packagePlan.push({
      name: moduleName,
      moduleVersion,
      url: moduleUrl,
      packageType: 'module'
    });
  }

  const final = {
    metadata_version: templateManifest.metadata_version == null ? null : templateManifest.metadata_version,
    required_update: templateManifest.required_update,
    required_modules: templateManifest.required_modules,
    full: {
      host_version: targetVersionText.split('.').map((segment) => Number(segment)),
      url: fullUrl,
      package_sha256: null
    },
    deltas: [],
    modules: {}
  };

  let aggregateBytes = 0;
  for (const packageEntry of packagePlan) {
    const remainingAggregateBytes = options.packageAggregateMaxBytes - aggregateBytes;
    if (remainingAggregateBytes <= 0) {
      return { error: makeError(PinnedManifestErrors.FETCH_BODY_TOO_LARGE, 'Pinned manifest package aggregate size exceeded', {
        maxBytes: options.packageAggregateMaxBytes,
        actualBytes: aggregateBytes
      })};
    }

    const packageMaxBytes = Math.min(options.packageMaxBytes, remainingAggregateBytes);
    const hashResult = await hashPackage({
      url: packageEntry.url,
      timeoutMs: options.fetchTimeoutMs,
      maxBytes: packageMaxBytes,
      maxRedirects: options.fetchRedirectLimit,
      requestImpl,
      logEvent: eventSink
    });
    if (hashResult.error) return { error: hashResult.error };
    aggregateBytes += hashResult.value.bytes;
    logEvent(eventSink, 'synthesis-package-complete', {
      name: packageEntry.name,
      bytes: hashResult.value.bytes,
      aggregateBytes
    });
    if (aggregateBytes > options.packageAggregateMaxBytes) {
      return { error: makeError(PinnedManifestErrors.FETCH_BODY_TOO_LARGE, 'Pinned manifest package aggregate size exceeded', {
        maxBytes: options.packageAggregateMaxBytes,
        actualBytes: aggregateBytes
      })};
    }

    if (packageEntry.packageType === 'full') {
      final.full.package_sha256 = hashResult.value.package_sha256;
      continue;
    }

    final.modules[packageEntry.name] = {
      full: {
        host_version: targetVersionText.split('.').map((segment) => Number(segment)),
        module_version: packageEntry.moduleVersion,
        url: packageEntry.url,
        package_sha256: hashResult.value.package_sha256
      },
      deltas: []
    };
  }
  logEvent(eventSink, 'synthesis-complete', {
    moduleCount: Object.keys(final.modules).length,
    totalBytes: aggregateBytes
  });

  return { value: final };
};

const readCache = (manifestPath, fsModule, maxBytes) => {
  try {
    const stats = fsModule.lstatSync(manifestPath);
    if (stats.isSymbolicLink()) return { error: makeError(PinnedManifestErrors.CACHE_SYMLINK, 'Pinned manifest must not be a symlink') };
    if (!stats.isFile()) return { error: makeError(PinnedManifestErrors.CACHE_NOT_REGULAR, 'Pinned manifest must be a regular file') };
    if (stats.size > maxBytes) return { error: makeError(PinnedManifestErrors.CACHE_TOO_LARGE, 'Pinned manifest cache file exceeds byte limit') };

    const raw = fsModule.readFileSync(manifestPath, 'utf8');
    if (raw.length > maxBytes) return { error: makeError(PinnedManifestErrors.CACHE_TOO_LARGE, 'Pinned manifest cache content exceeds byte limit') };

    const parsed = JSON.parse(raw);
    return { value: parsed };
  } catch (error) {
    if (error.code === 'ENOENT') return { error: makeError(PinnedManifestErrors.CACHE_MISSING, 'Pinned manifest file does not exist') };
    if (error?.name === 'SyntaxError') return { error: makeError(PinnedManifestErrors.CACHE_PARSE, 'Pinned manifest cache is not valid JSON', { message: error.message }) };
    return { error: makeError(PinnedManifestErrors.CACHE_PARSE, 'Failed reading pinned manifest cache', { message: error.message }) };
  }
};

const doHttpsRequest = ({
  url,
  timeoutMs,
  maxBytes,
  maxRedirects,
  requestImpl,
  hostPolicy,
  onData
}) => new Promise((resolve, reject) => {
  const run = (target, remainingRedirects) => {
    let parsed;
    try {
      parsed = new URL(target);
    } catch (error) {
      return reject(makeError(PinnedManifestErrors.FETCH_NETWORK, 'Pinned manifest request URL is invalid', {
        message: error.message
      }));
    }

    if (parsed.protocol !== 'https:') return reject(makeError(PinnedManifestErrors.MANIFEST_URL_INVALID, 'Pinned manifest request URL must be https', {
      url: target
    }));
    if (typeof hostPolicy === 'function' && !hostPolicy(parsed.hostname)) {
      return reject(makeError(PinnedManifestErrors.MANIFEST_URL_INVALID, 'Pinned manifest request host is not allowed', {
        url: target,
        hostname: parsed.hostname
      }));
    }

    const shouldCollectBody = typeof onData !== 'function';
    const request = (requestImpl || https.get)({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'OpenAsar-VersionLock/1'
      }
    }, (response) => {
      response.once('error', (error) => reject(makeError(PinnedManifestErrors.FETCH_NETWORK, 'Pinned manifest response failed', {
        message: error.message
      })));
      if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 303 || response.statusCode === 307 || response.statusCode === 308) {
        if (!response.headers.location) return reject(makeError(PinnedManifestErrors.FETCH_STATUS, `Redirect missing location`, { status: response.statusCode }));
        if (remainingRedirects <= 0) return reject(makeError(PinnedManifestErrors.FETCH_REDIRECT_LIMIT, 'Redirect limit exceeded'));

        let next;
        try {
          next = new URL(response.headers.location, target).toString();
        } catch (error) {
          return reject(makeError(PinnedManifestErrors.FETCH_NETWORK, 'Pinned manifest redirect URL is invalid', {
            message: error.message
          }));
        }

        if (!next.startsWith('https:')) return reject(makeError(PinnedManifestErrors.MANIFEST_URL_INVALID, 'Pinned manifest redirect must stay on https', {
          from: target,
          to: next
        }));

        response.resume();
        return run(next, remainingRedirects - 1);
      }

      if (response.statusCode !== 200) {
        response.resume();
        return reject(makeError(PinnedManifestErrors.FETCH_STATUS, 'Pinned manifest request returned non-200 status', {
          status: response.statusCode
        }));
      }

      const declaredLength = Number(response.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        response.destroy();
        return reject(makeError(PinnedManifestErrors.FETCH_BODY_TOO_LARGE, 'Pinned manifest response content-length exceeds max body size', {
          declaredLength,
          maxBytes
        }));
      }

      const chunks = shouldCollectBody ? [] : null;
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy();
          reject(makeError(PinnedManifestErrors.FETCH_BODY_TOO_LARGE, 'Pinned manifest response exceeds max body size', { maxBytes }));
          return;
        }
        if (typeof onData === 'function') {
          onData(chunk);
          return;
        }
        chunks.push(chunk);
      });
      response.once('end', () => resolve(shouldCollectBody ? Buffer.concat(chunks).toString('utf8') : ''));
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('timeout'));
      reject(makeError(PinnedManifestErrors.FETCH_TIMEOUT, 'Pinned manifest request timed out'));
    });

    request.once('error', (error) => reject(makeError(PinnedManifestErrors.FETCH_NETWORK, 'Pinned manifest request failed', {
      message: error.message
    })));
  };

  run(url, maxRedirects);
});

const fetchPinnedManifest = async ({
  url,
  timeoutMs = PinnedManifestDefaults.fetchTimeoutMs,
  maxBytes = PinnedManifestDefaults.fetchMaxBytes,
  maxRedirects = PinnedManifestDefaults.fetchRedirectLimit,
  requestImpl
}) => {
  try {
    const body = await doHttpsRequest({
      url,
      timeoutMs,
      maxBytes,
      maxRedirects,
      requestImpl
    });
    try {
      const manifest = JSON.parse(body);
      return { value: manifest };
    } catch (error) {
      return { error: makeError(PinnedManifestErrors.FETCH_PARSE, 'Pinned manifest fetch response is not valid JSON', {
        message: error.message
      }) };
    }
  } catch (error) {
    if (error?.code) return { error };

    return { error: makeError(PinnedManifestErrors.FETCH_NETWORK, 'Pinned manifest fetch failed', {
      message: error?.message || 'Unknown fetch error'
    }) };
  }
};

const fetchManifestFromEndpoint = ({
  endpoint,
  channel,
  platform,
  arch,
  version,
  platformVersion,
  fetchImpl,
  requestImpl,
  opts
}) => {
  const parsedEndpoint = new URL(endpoint);
  if (parsedEndpoint.protocol !== 'https:') {
    return {
      error: makeError(PinnedManifestErrors.MANIFEST_URL_INVALID, 'Pinned manifest endpoint must be https', {
        endpoint
      })
    };
  }

  const endpointBase = parsedEndpoint.toString().endsWith('/') ? parsedEndpoint.toString() : `${parsedEndpoint.toString()}/`;
  const manifestUrl = new URL('distributions/app/manifests/latest', endpointBase);
  manifestUrl.searchParams.set('channel', channel);
  manifestUrl.searchParams.set('platform', platform);
  manifestUrl.searchParams.set('arch', arch);
  manifestUrl.searchParams.set('version', version);
  if (platformVersion != null) manifestUrl.searchParams.set('platform_version', String(platformVersion));

  return fetchImpl({
    url: manifestUrl.toString(),
    timeoutMs: opts.fetchTimeoutMs,
    maxBytes: opts.fetchMaxBytes,
    maxRedirects: opts.fetchRedirectLimit,
    requestImpl
  });
};

const writePinnedManifest = ({ manifest, targetPath, fsModule }) => {
  try {
    fsModule.mkdirSync(dirname(targetPath), { recursive: true });
  } catch (_) {}

  const tempPath = `${targetPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  let tempCreated = false;
  try {
    fsModule.writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    tempCreated = true;
    try {
      fsModule.chmodSync(tempPath, 0o600);
    } catch (_) {}
    fsModule.renameSync(tempPath, targetPath);
    return { value: true };
  } catch (error) {
    return { error: makeError(PinnedManifestErrors.MANIFEST_WRITE_ERROR, 'Failed to replace pinned manifest cache', {
      message: error.message
    }) };
  } finally {
    if (tempCreated) {
      try { fsModule.unlinkSync(tempPath); } catch (_) {}
    }
  }
};

const resolvePinnedManifest = async (options = {}) => {
  const {
    userData,
    channel,
    version,
    platform = getNativeUpdaterPlatform(),
    arch = getNativeUpdaterArch(),
    endpoint = PinnedManifestDefaults.endpoint,
    platformVersion = getNativeUpdaterPlatformVersion(),
    cacheMaxBytes = PinnedManifestDefaults.cacheByteLimit,
    fetchMaxBytes = PinnedManifestDefaults.fetchMaxBytes,
    packageMaxBytes = PinnedManifestDefaults.packageMaxBytes,
    packageAggregateMaxBytes = PinnedManifestDefaults.packageAggregateMaxBytes,
    fetchTimeoutMs = PinnedManifestDefaults.fetchTimeoutMs,
    fetchRedirectLimit = PinnedManifestDefaults.fetchRedirectLimit,
    fetchManifest = fetchPinnedManifest,
    requestImpl,
    fsModule = fs,
    logEvent: eventSink = () => {}
  } = options;

  const manifestPath = getPinnedManifestPath(userData);
  const constraints = { channel, platform, arch, version };
  const targetVersion = getVersionText(version);
  logEvent(eventSink, 'resolve-start', { manifestPath });
  if (!targetVersion) {
    const targetError = makeError(PinnedManifestErrors.MANIFEST_FULL_VERSION, 'Target host_version must be a valid version', {
      version
    });
    logEvent(eventSink, 'target-invalid', { manifestPath, error: targetError });
    return {
      source: 'fetch',
      refreshed: false,
      manifestPath,
      manifest: null,
      error: targetError
    };
  }
  const versionedConstraints = { ...constraints, version: targetVersion };

  const cache = readCache(manifestPath, fsModule, cacheMaxBytes);
  if (!cache.error && cache.value) {
    const cacheValidation = validatePinnedManifest({ manifest: cache.value, constraints: versionedConstraints });
    if (!cacheValidation) {
      logEvent(eventSink, 'cache-valid', { manifestPath });
      return {
        source: 'cache',
        refreshed: false,
        manifestPath,
        manifest: cache.value,
        error: null
      };
    }
    logEvent(eventSink, 'cache-invalid', { manifestPath, error: cacheValidation });
  } else if (cache.error) {
    logEvent(eventSink, 'cache-miss-or-invalid', { manifestPath, error: cache.error });
  }

  logEvent(eventSink, 'cache-refresh', { manifestPath });
  let fetchResult;
  try {
    fetchResult = await fetchManifestFromEndpoint({
      endpoint,
      channel,
      platform,
      arch,
      version,
      platformVersion,
      fetchImpl: fetchManifest,
      requestImpl,
      opts: { fetchTimeoutMs, fetchMaxBytes, fetchRedirectLimit }
    });
  } catch (cause) {
    const failure = cause?.code ? cause : makeError(PinnedManifestErrors.FETCH_NETWORK, 'Pinned manifest request failed', {
      message: cause?.message || 'Unknown fetch failure'
    });
    fetchResult = { error: failure };
  }

  if (fetchResult?.error) {
    logEvent(eventSink, 'fetch-failed', { manifestPath, error: fetchResult.error });
    return {
      source: 'fetch',
      refreshed: false,
      manifestPath,
      manifest: null,
      error: fetchResult.error
    };
  }

  const fetchedManifest = fetchResult.value;
  const fetchedVersionText = getVersionText(fetchedManifest?.full?.host_version);
  let manifest = null;

  if (fetchedVersionText === targetVersion) {
    const fetchedValidation = validatePinnedManifest({
      manifest: fetchedManifest,
      constraints: versionedConstraints
    });
    if (fetchedValidation) {
      logEvent(eventSink, 'manifest-invalid', { manifestPath, error: fetchedValidation });
      return {
        source: 'fetch',
        refreshed: false,
        manifestPath,
        manifest: null,
        error: fetchedValidation
      };
    }
    manifest = fetchedManifest;
  } else {
    const templateValidation = validatePinnedManifestTemplate({
      manifest: fetchedManifest,
      constraints: { ...versionedConstraints, version: fetchedVersionText }
    });
    if (templateValidation) {
      logEvent(eventSink, 'template-manifest-invalid', { manifestPath, error: templateValidation });
      return {
        source: 'fetch',
        refreshed: false,
        manifestPath,
        manifest: null,
        error: templateValidation
      };
    }

    let versionsResult;
    try {
      versionsResult = await fetchVersionsFromEndpoint({
        channel,
        platform,
        targetVersion,
        fetchImpl: fetchManifest,
        requestImpl,
        opts: { fetchTimeoutMs, fetchMaxBytes, fetchRedirectLimit }
      });
    } catch (cause) {
      const failure = cause?.code ? cause : makeError(PinnedManifestErrors.FETCH_NETWORK, 'Pinned manifest versions request failed', {
        message: cause?.message || 'Unknown versions fetch failure'
      });
      versionsResult = { error: failure };
    }
    if (versionsResult.error) {
      logEvent(eventSink, 'versions-failed', { manifestPath, error: versionsResult.error });
      return {
        source: 'fetch',
        refreshed: false,
        manifestPath,
        manifest: null,
        error: versionsResult.error
      };
    }

    const synthesized = await synthesizePinnedManifest({
      templateManifest: fetchedManifest,
      targetVersion,
      targetModules: versionsResult.value,
      constraints: versionedConstraints,
      options: {
        fetchTimeoutMs,
        packageMaxBytes,
        packageAggregateMaxBytes,
        fetchRedirectLimit
      },
      eventSink,
      hashPackage: hashPinnedPackage,
      requestImpl
    });
    if (synthesized.error) {
      logEvent(eventSink, 'manifest-invalid', { manifestPath, error: synthesized.error });
      return {
        source: 'fetch',
        refreshed: false,
        manifestPath,
        manifest: null,
        error: synthesized.error
      };
    }

    const synthesizedValidation = validatePinnedManifest({
      manifest: synthesized.value,
      constraints: versionedConstraints
    });
    if (synthesizedValidation) {
      logEvent(eventSink, 'manifest-invalid', { manifestPath, error: synthesizedValidation });
      return {
        source: 'fetch',
        refreshed: false,
        manifestPath,
        manifest: null,
        error: synthesizedValidation
      };
    }

    manifest = synthesized.value;
  }

  const writeResult = writePinnedManifest({ manifest, targetPath: manifestPath, fsModule });
  if (writeResult.error) {
    logEvent(eventSink, 'write-failed', { manifestPath, error: writeResult.error });
    return {
      source: 'fetch',
      refreshed: false,
      manifestPath,
      manifest: null,
      error: writeResult.error
    };
  }

  logEvent(eventSink, 'manifest-written', { manifestPath });
  return {
    source: 'fetch',
    refreshed: true,
    manifestPath,
    manifest,
    error: null
  };
};

exports.validateManifestPath = validateManifestPath;
exports.validateManifestUrl = validateManifestUrl;
exports.validatePinnedManifest = validatePinnedManifest;
exports.getPinnedManifestPath = getPinnedManifestPath;
exports.fetchPinnedManifest = fetchPinnedManifest;
exports.resolvePinnedManifest = resolvePinnedManifest;
exports.PinnedManifestDefaults = PinnedManifestDefaults;
exports.PinnedManifestErrors = PinnedManifestErrors;
exports.pinnedManifestFileName = pinnedManifestFileName;
