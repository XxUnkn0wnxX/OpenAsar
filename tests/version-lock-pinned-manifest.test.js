const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const { createHash } = require('node:crypto');
const { afterEach, beforeEach, describe, test } = require('node:test');

const {
  getNativeUpdaterPlatform,
  getNativeUpdaterArch,
  getNativeUpdaterPlatformVersion
} = require('../src/utils/updaterIdentity');

const {
  PinnedManifestDefaults,
  fetchPinnedManifest,
  PinnedManifestErrors,
  resolvePinnedManifest,
  getPinnedManifestPath
} = require('../src/utils/pinnedUpdateManifest');

const toVersionText = version => Array.isArray(version) ? version.join('.') : version;

const nextArrayVersion = version => {
  const normalized = typeof version === 'string' ? version : toVersionText(version);
  return normalized.split('.').map((segment) => Number(segment));
};

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const buildValidManifest = ({
  channel = 'stable',
  platform = 'win',
  arch = 'x64',
  version = '0.0.402'
}) => {
  const packageArch = platform === 'osx' ? 'universal' : arch;
  const previousVersion = `0.0.${Number(version.split('.')[2]) - 1}`;

  return {
  metadata_version: 12,
  required_update: false,
  required_modules: ['core'],
  full: {
    host_version: nextArrayVersion(version),
    url: `https://discordapp.net/distro/app/${channel}/${platform}/${packageArch}/${version}/full.distro`,
    package_sha256: 'a'.repeat(64)
  },
  deltas: [
    {
      host_version: nextArrayVersion(previousVersion),
      url: `https://discordapp.net/distro/app/${channel}/${platform}/${packageArch}/${version}/from/${previousVersion}`,
      package_sha256: 'f'.repeat(64)
    }
  ],
  modules: {
    core: {
      full: {
        host_version: nextArrayVersion(version),
        module_version: 1,
        url: `https://discordapp.net/distro/app/${channel}/${platform}/${packageArch}/${version}/core/1/full.distro`,
        package_sha256: 'b'.repeat(64)
      },
      deltas: [
        {
          host_version: nextArrayVersion(previousVersion),
          module_version: 1,
          url: `https://discordapp.net/distro/app/${channel}/${platform}/${packageArch}/${version}/core/1/from/${previousVersion}/1`,
          package_sha256: 'c'.repeat(64)
        }
      ]
    },
    optional: {
      full: {
        host_version: nextArrayVersion(version),
        module_version: 2,
        url: `https://discordapp.net/distro/app/${channel}/${platform}/${packageArch}/${version}/optional/2/full.distro`,
        package_sha256: 'd'.repeat(64)
      },
      deltas: []
    }
  }
  };
};

describe('updaterIdentity', () => {
  test('maps native platforms', () => {
    assert.equal(getNativeUpdaterPlatform({ platform: 'darwin' }), 'osx');
    assert.equal(getNativeUpdaterPlatform({ platform: 'win32' }), 'win');
    assert.equal(getNativeUpdaterPlatform({ platform: 'linux' }), 'linux');
  });

  test('maps native architectures for windows and darwin', () => {
    assert.equal(getNativeUpdaterArch({
      platform: 'win32',
      env: { PROCESSOR_ARCHITECTURE: 'AMD64' }
    }), 'x64');
    assert.equal(getNativeUpdaterArch({
      platform: 'win32',
      env: { PROCESSOR_ARCHITECTURE: 'x86' }
    }), 'x86');
    assert.equal(getNativeUpdaterArch({
      platform: 'darwin',
      runUname: () => 'arm64'
    }), 'arm64');
    assert.equal(getNativeUpdaterArch({
      platform: 'darwin',
      runUname: () => 'x86_64'
    }), 'x64');
  });

  test('reads platform version from process helper when available', () => {
    assert.equal(getNativeUpdaterPlatformVersion({ getSystemVersion: () => '1.2.3' }), '1.2.3');
  });
});

describe('resolvePinnedManifest', () => {
  let root;
  const makeRoot = () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openasar-pinned-'));
    return root;
  };

  const userData = () => path.join(root, 'user-data');
  const manifestPath = () => getPinnedManifestPath(userData());
  const writeManifest = (manifest) => {
    const target = manifestPath();
    fs.mkdirSync(userData(), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(manifest, null, 2));
    return target;
  };
  beforeEach(() => {
    makeRoot();
  });

  afterEach(() => {
    if (root) fs.rmSync(root, { force: true, recursive: true });
    root = undefined;
  });

  test('defaults to 1GiB package max and 4GiB package aggregate max', () => {
    assert.equal(PinnedManifestDefaults.packageMaxBytes, 1024 * 1024 * 1024);
    assert.equal(PinnedManifestDefaults.packageAggregateMaxBytes, 4 * 1024 * 1024 * 1024);
  });

  test('returns valid pinned cache without fetch', async () => {
    const manifest = buildValidManifest({});
    const calls = [];
    writeManifest(manifest);

    const result = await resolvePinnedManifest({
      userData: userData(),
      channel: 'stable',
      version: '0.0.402',
      platform: 'win',
      arch: 'x64',
      fetchManifest: ({ url }) => {
        calls.push(url);
        return { value: buildValidManifest({}) };
      }
    });

    assert.equal(result.source, 'cache');
    assert.equal(result.refreshed, false);
    assert.equal(toVersionText(result.manifest.full.host_version), '0.0.402');
    assert.equal(calls.length, 0);
  });

  test('accepts optional modules not listed in required_modules', async () => {
    const manifest = buildValidManifest({});
    manifest.required_modules = ['core'];
    writeManifest(manifest);

    const result = await resolvePinnedManifest({
      userData: userData(),
      channel: 'stable',
      version: '0.0.402',
      platform: 'win',
      arch: 'x64',
      fetchManifest: () => ({ value: buildValidManifest({}) })
    });

    assert.equal(result.source, 'cache');
    assert.equal(result.refreshed, false);
    assert.equal(Object.prototype.hasOwnProperty.call(result.manifest.modules, 'optional'), true);
  });

  test('rejects direct manifests with invalid required module names', async () => {
    const manifest = buildValidManifest({});
    manifest.required_modules = ['../traversal'];

    const result = await resolvePinnedManifest({
      userData: userData(),
      channel: 'stable',
      version: '0.0.402',
      platform: 'win',
      arch: 'x64',
      fetchManifest: () => ({ value: manifest })
    });

    assert.equal(result.source, 'fetch');
    assert.equal(result.refreshed, false);
    assert.equal(result.error.code, PinnedManifestErrors.MANIFEST_REQUIRED_MODULES_INVALID);
  });

  test('rejects direct manifests with invalid module object keys', async () => {
    const manifest = buildValidManifest({});
    manifest.modules['../traversal'] = {
      full: {
        host_version: [0, 0, 402],
        module_version: 9,
        url: 'https://discordapp.net/distro/app/stable/win/x64/0.0.402/traversal/9/full.distro',
        package_sha256: 'e'.repeat(64)
      },
      deltas: []
    };

    const result = await resolvePinnedManifest({
      userData: userData(),
      channel: 'stable',
      version: '0.0.402',
      platform: 'win',
      arch: 'x64',
      fetchManifest: () => ({ value: manifest })
    });

    assert.equal(result.source, 'fetch');
    assert.equal(result.refreshed, false);
    assert.equal(result.error.code, PinnedManifestErrors.MANIFEST_MODULES_INVALID);
  });

  test('refreshes when cache is missing', async () => {
    const manifest = buildValidManifest({});
    const calls = [];
    const capture = {};
    const result = await resolvePinnedManifest({
      userData: userData(),
      channel: 'stable',
      version: '0.0.402',
      platform: 'win',
      arch: 'x64',
      fetchManifest: ({ url }) => {
        calls.push(url);
        capture.url = url;
        return { value: manifest };
      }
    });

    const requested = new URL(calls[0]);
    assert.equal(requested.pathname, '/distributions/app/manifests/latest');
    assert.equal(requested.searchParams.get('channel'), 'stable');
    assert.equal(requested.searchParams.get('platform'), 'win');
    assert.equal(requested.searchParams.get('arch'), 'x64');
    assert.equal(requested.searchParams.get('version'), '0.0.402');
    assert.equal(result.source, 'fetch');
    assert.equal(result.refreshed, true);
    assert.equal(calls.length, 1);
  });

  test('refreshes when cache is not JSON', async () => {
    const target = manifestPath();
    fs.mkdirSync(userData(), { recursive: true });
    fs.writeFileSync(target, '{bad');
    const calls = [];

    const result = await resolvePinnedManifest({
      userData: userData(),
      channel: 'stable',
      version: '0.0.402',
      platform: 'win',
      arch: 'x64',
      fetchManifest: () => {
        calls.push('fetch');
        return { value: buildValidManifest({}) };
      }
    });

    assert.equal(calls.length, 1);
    assert.equal(result.source, 'fetch');
    assert.equal(result.refreshed, true);
  });

  test('refreshes when cache target is wrong', async () => {
    const wrong = buildValidManifest({ version: '0.0.401' });
    writeManifest(wrong);

    const result = await resolvePinnedManifest({
      userData: userData(),
      channel: 'stable',
      version: '0.0.402',
      platform: 'win',
      arch: 'x64',
      fetchManifest: ({}) => ({ value: buildValidManifest({}) })
    });

    assert.equal(result.source, 'fetch');
    assert.equal(result.refreshed, true);
  });

  test('synthesizes and caches a manifest when latest host version differs', async () => {
    const templateManifest = buildValidManifest({ version: '0.0.401' });
    const events = [];
    const calls = [];
    const versionsPayload = {
      core: 5,
      optional: 7
    };
    const packageMap = {
      'https://discordapp.net/distro/app/stable/win/x64/0.0.402/full.distro': Buffer.from('full-0.0.402'),
      'https://discordapp.net/distro/app/stable/win/x64/0.0.402/core/5/full.distro': Buffer.from('core-5'),
      'https://discordapp.net/distro/app/stable/win/x64/0.0.402/optional/7/full.distro': Buffer.from('optional-7')
    };
    const requestImpl = (options, callback) => {
      const requestUrl = `https://${options.hostname}${options.path}`;
      const body = packageMap[requestUrl];
      if (!body) throw new Error(`Unexpected package request: ${requestUrl}`);

      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { 'content-length': String(body.length) };
      response.on = response.addListener.bind(response);
      response.destroy = () => {};

      process.nextTick(() => {
        callback(response);
        response.emit('data', body);
        response.emit('end');
      });

      return {
        setTimeout: () => {},
        once: response.once.bind(response),
        destroy: () => {}
      };
    };

    const result = await resolvePinnedManifest({
      userData: userData(),
      channel: 'stable',
      version: '0.0.402',
      platform: 'win',
      arch: 'x64',
      fetchManifest: ({ url }) => {
        const parsed = new URL(url);
        calls.push(url);
        if (parsed.pathname === '/api/modules/stable/versions.json') {
          assert.equal(parsed.searchParams.get('host_version'), '0.0.402');
          assert.equal(parsed.searchParams.get('platform'), 'win');
          return { value: versionsPayload };
        }
        return { value: templateManifest };
      },
      logEvent: events.push.bind(events),
      requestImpl
    });

    assert.equal(result.source, 'fetch');
    assert.equal(result.refreshed, true);
    assert.equal(toVersionText(result.manifest.full.host_version), '0.0.402');
    assert.equal(result.manifest.deltas.length, 0);
    assert.equal(result.manifest.modules.core.full.module_version, 5);
    assert.equal(result.manifest.modules.optional.full.module_version, 7);
    assert.equal(result.manifest.modules.core.full.url, 'https://discordapp.net/distro/app/stable/win/x64/0.0.402/core/5/full.distro');
    assert.equal(result.manifest.modules.optional.full.url, 'https://discordapp.net/distro/app/stable/win/x64/0.0.402/optional/7/full.distro');
    assert.equal(result.manifest.full.url, 'https://discordapp.net/distro/app/stable/win/x64/0.0.402/full.distro');
    assert.equal(events[0].event, 'resolve-start');
    assert.equal(events.some((event) => event.event === 'synthesis-start'), true);
    assert.equal(events.some((event) => event.event === 'synthesis-package-complete' && event.name === 'full'), true);
    assert.equal(events.some((event) => event.event === 'synthesis-package-complete' && event.name === 'core' && typeof event.bytes === 'number' && typeof event.aggregateBytes === 'number'), true);
    assert.equal(events.some((event) => event.event === 'synthesis-package-complete' && event.name === 'optional' && typeof event.bytes === 'number' && typeof event.aggregateBytes === 'number'), true);
    assert.equal(events.some((event) => event.event === 'synthesis-complete'), true);
    assert.equal(new URL(calls[1]).pathname, '/api/modules/stable/versions.json');
    assert.equal(calls.filter((entry) => entry.includes('/api/modules/stable/versions.json')).length, 1);
    assert.equal(calls.filter((entry) => entry.includes('/distributions/app/manifests/latest')).length, 1);
  });

  test('includes extra versions payload modules not present in template', async () => {
    const templateManifest = buildValidManifest({ version: '0.0.401' });
    const events = [];
    const calls = [];
    const versionsPayload = {
      core: 5,
      optional: 7,
      discord_arborium: 9
    };
    const packageMap = {
      'https://discordapp.net/distro/app/stable/win/x64/0.0.402/full.distro': Buffer.from('full-0.0.402'),
      'https://discordapp.net/distro/app/stable/win/x64/0.0.402/core/5/full.distro': Buffer.from('core-5'),
      'https://discordapp.net/distro/app/stable/win/x64/0.0.402/optional/7/full.distro': Buffer.from('optional-7'),
      'https://discordapp.net/distro/app/stable/win/x64/0.0.402/discord_arborium/9/full.distro': Buffer.from('arborium-9')
    };
    const requestImpl = (options, callback) => {
      const requestUrl = `https://${options.hostname}${options.path}`;
      const body = packageMap[requestUrl];
      if (!body) throw new Error(`Unexpected package request: ${requestUrl}`);

      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { 'content-length': String(body.length) };
      response.on = response.addListener.bind(response);
      response.destroy = () => {};

      process.nextTick(() => {
        callback(response);
        response.emit('data', body);
        response.emit('end');
      });

      return {
        setTimeout: () => {},
        once: response.once.bind(response),
        destroy: () => {}
      };
    };

    const result = await resolvePinnedManifest({
      userData: userData(),
      channel: 'stable',
      version: '0.0.402',
      platform: 'win',
      arch: 'x64',
      fetchManifest: ({ url }) => {
        const parsed = new URL(url);
        calls.push(url);
        if (parsed.pathname === '/api/modules/stable/versions.json') {
          return { value: versionsPayload };
        }
        return { value: templateManifest };
      },
      logEvent: events.push.bind(events),
      requestImpl
    });

    assert.equal(result.source, 'fetch');
    assert.equal(result.refreshed, true);
    assert.equal(toVersionText(result.manifest.full.host_version), '0.0.402');
    assert.equal(result.manifest.modules.discord_arborium.full.module_version, 9);
    assert.equal(result.manifest.modules.discord_arborium.full.url, 'https://discordapp.net/distro/app/stable/win/x64/0.0.402/discord_arborium/9/full.distro');
    assert.equal(events.some((event) => event.event === 'synthesis-package-complete' && event.name === 'discord_arborium' && typeof event.bytes === 'number' && typeof event.aggregateBytes === 'number'), true);
    assert.equal(calls.filter((entry) => entry.includes('/api/modules/stable/versions.json')).length, 1);
  });

  test('synthesizes every osx/universal versions payload module and emits hashed full entries', async () => {
    const templateManifest = buildValidManifest({
      channel: 'stable',
      platform: 'osx',
      arch: 'arm64',
      version: '0.0.396'
    });
    const versionsPayload = {
      core: 5,
      optional: 7,
      discord_arborium: 9
    };
    const packageBytes = {
      full: Buffer.from('full-0.0.402-macos'),
      core: Buffer.from('core-5-macos'),
      optional: Buffer.from('optional-7-macos'),
      discord_arborium: Buffer.from('arborium-9-macos')
    };
    const expectedHashes = {
      full: sha256(packageBytes.full),
      core: sha256(packageBytes.core),
      optional: sha256(packageBytes.optional),
      discord_arborium: sha256(packageBytes.discord_arborium)
    };

    const packageMap = {
      'https://discordapp.net/distro/app/stable/osx/universal/0.0.402/full.distro': packageBytes.full,
      'https://discordapp.net/distro/app/stable/osx/universal/0.0.402/core/5/full.distro': packageBytes.core,
      'https://discordapp.net/distro/app/stable/osx/universal/0.0.402/optional/7/full.distro': packageBytes.optional,
      'https://discordapp.net/distro/app/stable/osx/universal/0.0.402/discord_arborium/9/full.distro': packageBytes.discord_arborium
    };
    const requestImpl = (options, callback) => {
      const requestUrl = `https://${options.hostname}${options.path}`;
      const body = packageMap[requestUrl];
      if (!body) throw new Error(`Unexpected package request: ${requestUrl}`);

      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { 'content-length': String(body.length) };
      response.on = response.addListener.bind(response);
      response.destroy = () => {};

      process.nextTick(() => {
        callback(response);
        response.emit('data', body);
        response.emit('end');
      });

      return {
        setTimeout: () => {},
        once: response.once.bind(response),
        destroy: () => {}
      };
    };

    const result = await resolvePinnedManifest({
      userData: userData(),
      channel: 'stable',
      version: '0.0.402',
      platform: 'osx',
      arch: 'arm64',
      fetchManifest: ({ url }) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/api/modules/stable/versions.json') {
          return { value: versionsPayload };
        }
        return { value: templateManifest };
      },
      requestImpl
    });

    assert.equal(result.source, 'fetch');
    assert.equal(result.refreshed, true);
    assert.equal(toVersionText(result.manifest.full.host_version), '0.0.402');
    assert.equal(result.manifest.full.url, 'https://discordapp.net/distro/app/stable/osx/universal/0.0.402/full.distro');
    assert.equal(result.manifest.full.package_sha256, expectedHashes.full);
    assert.equal(Object.keys(result.manifest.modules).length, Object.keys(versionsPayload).length);
    for (const [moduleName, moduleVersion] of Object.entries(versionsPayload)) {
      assert.equal(result.manifest.modules[moduleName].full.module_version, moduleVersion);
      assert.equal(result.manifest.modules[moduleName].full.url, `https://discordapp.net/distro/app/stable/osx/universal/0.0.402/${moduleName}/${moduleVersion}/full.distro`);
      assert.equal(result.manifest.modules[moduleName].full.package_sha256, expectedHashes[moduleName]);
    }
  });

  test('rejects oversize cache and triggers refresh', async () => {
    fs.mkdirSync(userData(), { recursive: true });
    const target = manifestPath();
    fs.writeFileSync(target, JSON.stringify(buildValidManifest({})));

    const result = await resolvePinnedManifest({
      userData: userData(),
      channel: 'stable',
      version: '0.0.402',
      platform: 'win',
      arch: 'x64',
      cacheMaxBytes: 10,
      fetchManifest: () => ({ value: buildValidManifest({}) })
    });

    assert.equal(result.source, 'fetch');
    assert.equal(result.refreshed, true);
  });

  test('does not overwrite cache with invalid fetched host version', async () => {
    const oldManifest = buildValidManifest({ version: '0.0.401' });
    writeManifest(oldManifest);
    const invalid = buildValidManifest({ version: '0.0.401' });

    const result = await resolvePinnedManifest({
      userData: userData(),
      channel: 'stable',
      version: '0.0.402',
      platform: 'win',
      arch: 'x64',
      fetchManifest: () => ({ value: invalid })
    });

    const persisted = JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
    assert.equal(result.source, 'fetch');
    assert.equal(result.refreshed, false);
    assert.ok(result.error.code);
    assert.equal(toVersionText(persisted.full.host_version), '0.0.401');
  });

  test('rejects invalid module data without replacing valid cache', async () => {
    const stale = buildValidManifest({ version: '0.0.401' });
    writeManifest(stale);

    const invalid = buildValidManifest({});
    invalid.full.host_version = [0, 0, 402];
    invalid.modules.core.full.package_sha256 = 'notashash';

    const result = await resolvePinnedManifest({
      userData: userData(),
      channel: 'stable',
      version: '0.0.402',
      platform: 'win',
      arch: 'x64',
      fetchManifest: () => ({ value: invalid })
    });

    const persisted = JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
    assert.equal(result.error.code, PinnedManifestErrors.MANIFEST_SHA_INVALID);
    assert.equal(toVersionText(persisted.full.host_version), '0.0.401');
  });

  test('accepts mac package URLs with universal archived payload', async () => {
    const macManifest = buildValidManifest({
      channel: 'stable',
      platform: 'osx',
      arch: 'arm64',
      version: '0.0.402'
    });
    const result = await resolvePinnedManifest({
      userData: userData(),
      channel: 'stable',
      version: '0.0.402',
      platform: 'osx',
      arch: 'arm64',
      fetchManifest: () => ({ value: macManifest })
    });

    assert.equal(result.source, 'fetch');
    assert.equal(result.refreshed, true);
  });

  test('accepts manifest deltas with host_version from template when URL target is locked version', async () => {
    const manifest = buildValidManifest({});
    manifest.deltas[0].url = 'https://discordapp.net/distro/app/stable/win/x64/0.0.402/from/0.0.401';

    const result = await resolvePinnedManifest({
      userData: userData(),
      channel: 'stable',
      version: '0.0.402',
      platform: 'win',
      arch: 'x64',
      fetchManifest: () => ({ value: manifest })
    });

    assert.equal(result.source, 'fetch');
    assert.equal(result.error, null);
  });

  test('does not replace cache when required module is missing from versions endpoint', async () => {
    const stale = buildValidManifest({ version: '0.0.401' });
    writeManifest(stale);
    const templateManifest = buildValidManifest({ version: '0.0.401' });
    const versionsPayload = {
      optional: 7
    };

    const result = await resolvePinnedManifest({
      userData: userData(),
      channel: 'stable',
      version: '0.0.402',
      platform: 'win',
      arch: 'x64',
      fetchManifest: ({ url }) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/api/modules/stable/versions.json') {
          return { value: versionsPayload };
        }
        return { value: templateManifest };
      },
      requestImpl: () => ({})
    });

    const persisted = JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
    assert.equal(result.source, 'fetch');
    assert.equal(result.refreshed, false);
    assert.equal(result.error.code, PinnedManifestErrors.MANIFEST_REQUIRED_ENTRY_MISSING);
    assert.equal(toVersionText(persisted.full.host_version), '0.0.401');
  });

  test('rejects templates with invalid required_modules names', async () => {
    const templateManifest = buildValidManifest({ version: '0.0.401' });
    templateManifest.required_modules = ['core', '../traversal'];
    const versionsPayload = { core: 5 };

    const result = await resolvePinnedManifest({
      userData: userData(),
      channel: 'stable',
      version: '0.0.402',
      platform: 'win',
      arch: 'x64',
      fetchManifest: ({ url }) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/api/modules/stable/versions.json') {
          return { value: versionsPayload };
        }
        return { value: templateManifest };
      },
      requestImpl: () => ({})
    });

    assert.equal(result.source, 'fetch');
    assert.equal(result.refreshed, false);
    assert.equal(result.error.code, PinnedManifestErrors.MANIFEST_REQUIRED_MODULES_INVALID);
  });

  test('rejects templates with invalid module object keys', async () => {
    const templateManifest = buildValidManifest({ version: '0.0.401' });
    templateManifest.modules['../traversal'] = {
      full: {
        host_version: [0, 0, 401],
        module_version: 9,
        url: 'https://discordapp.net/distro/app/stable/win/x64/0.0.401/traversal/9/full.distro',
        package_sha256: 'd'.repeat(64)
      },
      deltas: []
    };
    const versionsPayload = { core: 5 };

    const result = await resolvePinnedManifest({
      userData: userData(),
      channel: 'stable',
      version: '0.0.402',
      platform: 'win',
      arch: 'x64',
      fetchManifest: ({ url }) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/api/modules/stable/versions.json') {
          return { value: versionsPayload };
        }
        return { value: templateManifest };
      },
      requestImpl: () => ({})
    });

    assert.equal(result.source, 'fetch');
    assert.equal(result.refreshed, false);
    assert.equal(result.error.code, PinnedManifestErrors.MANIFEST_MODULES_INVALID);
  });

  test('rejects versions payload with non-conservative module names', async () => {
    const templateManifest = buildValidManifest({ version: '0.0.401' });
    const versionsPayload = {
      'bad/name': 5
    };

    const result = await resolvePinnedManifest({
      userData: userData(),
      channel: 'stable',
      version: '0.0.402',
      platform: 'win',
      arch: 'x64',
      fetchManifest: ({ url }) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/api/modules/stable/versions.json') {
          return { value: versionsPayload };
        }
        return { value: templateManifest };
      },
      requestImpl: () => ({})
    });

    assert.equal(result.source, 'fetch');
    assert.equal(result.refreshed, false);
    assert.equal(result.error.code, PinnedManifestErrors.MANIFEST_MODULES_INVALID);
  });

  test('does not replace cache when package hash fails during synthesis', async () => {
    const stale = buildValidManifest({ version: '0.0.401' });
    writeManifest(stale);
    const templateManifest = buildValidManifest({ version: '0.0.401' });
    const versionsPayload = {
      core: 5
    };
    const packageMap = {
      'https://discordapp.net/distro/app/stable/win/x64/0.0.402/full.distro': Buffer.from('full')
    };
    const requestImpl = (options, callback) => {
      const requestUrl = `https://${options.hostname}${options.path}`;
      const body = packageMap[requestUrl];
      if (!body) throw new Error(`Unexpected package request: ${requestUrl}`);

      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { 'content-length': String(body.length) };
      response.on = response.addListener.bind(response);
      response.destroy = () => {};

      process.nextTick(() => {
        callback(response);
        response.emit('data', body);
        response.emit('end');
      });

      return {
        setTimeout: () => {},
        once: response.once.bind(response),
        destroy: () => {}
      };
    };

    const result = await resolvePinnedManifest({
      userData: userData(),
      channel: 'stable',
      version: '0.0.402',
      platform: 'win',
      arch: 'x64',
      fetchManifest: ({ url }) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/api/modules/stable/versions.json') {
          return { value: versionsPayload };
        }
        return { value: templateManifest };
      },
      requestImpl,
      packageAggregateMaxBytes: 1000
    });

    const persisted = JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
    assert.equal(result.source, 'fetch');
    assert.equal(result.refreshed, false);
    assert.equal(result.error.code, PinnedManifestErrors.FETCH_NETWORK);
    assert.equal(toVersionText(persisted.full.host_version), '0.0.401');
  });

  test('enforces remaining aggregate limit before requesting full package sizes', async () => {
    const stale = buildValidManifest({ version: '0.0.401' });
    writeManifest(stale);
    const templateManifest = buildValidManifest({ version: '0.0.401' });
    const versionsPayload = {
      core: 5
    };
    const packageMap = {
      'https://discordapp.net/distro/app/stable/win/x64/0.0.402/full.distro': Buffer.from('F'),
      'https://discordapp.net/distro/app/stable/win/x64/0.0.402/core/5/full.distro': Buffer.from('core1')
    };
    const requestCalls = [];
    let responseDestroyCount = 0;
    const requestImpl = (options, callback) => {
      const requestUrl = `https://${options.hostname}${options.path}`;
      requestCalls.push(requestUrl);
      const body = packageMap[requestUrl];
      if (!body) {
        throw new Error(`Unexpected package request: ${requestUrl}`);
      }

      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { 'content-length': String(body.length) };
      response.on = response.addListener.bind(response);
      response.destroy = () => {
        responseDestroyCount += 1;
      };

      process.nextTick(() => {
        callback(response);
        response.emit('data', body);
        response.emit('end');
      });

      return {
        setTimeout: () => {},
        once: response.once.bind(response),
        destroy: () => {}
      };
    };

    const result = await resolvePinnedManifest({
      userData: userData(),
      channel: 'stable',
      version: '0.0.402',
      platform: 'win',
      arch: 'x64',
      fetchManifest: ({ url }) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/api/modules/stable/versions.json') {
          return { value: versionsPayload };
        }
        return { value: templateManifest };
      },
      requestImpl,
      packageMaxBytes: 1024,
      packageAggregateMaxBytes: 3
    });

    const persisted = JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
    assert.equal(result.source, 'fetch');
    assert.equal(result.refreshed, false);
    assert.equal(result.error.code, PinnedManifestErrors.FETCH_BODY_TOO_LARGE);
    assert.equal(toVersionText(persisted.full.host_version), '0.0.401');
    assert.equal(requestCalls.includes('https://discordapp.net/distro/app/stable/win/x64/0.0.402/core/5/full.distro'), true);
    assert.equal(responseDestroyCount, 1);
  });

  test('does not replace cache when synthesized package bytes exceed aggregate limit', async () => {
    const stale = buildValidManifest({ version: '0.0.401' });
    writeManifest(stale);
    const templateManifest = buildValidManifest({ version: '0.0.401' });
    const versionsPayload = {
      core: 5,
      optional: 7
    };
    const packageMap = {
      'https://discordapp.net/distro/app/stable/win/x64/0.0.402/full.distro': Buffer.from('full'),
      'https://discordapp.net/distro/app/stable/win/x64/0.0.402/core/5/full.distro': Buffer.from('core'),
      'https://discordapp.net/distro/app/stable/win/x64/0.0.402/optional/7/full.distro': Buffer.from('optn')
    };
    const requestImpl = (options, callback) => {
      const requestUrl = `https://${options.hostname}${options.path}`;
      const body = packageMap[requestUrl];
      if (!body) {
        throw new Error(`Unexpected package request: ${requestUrl}`);
      }

      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { 'content-length': String(body.length) };
      response.on = response.addListener.bind(response);
      response.destroy = () => {};

      process.nextTick(() => {
        callback(response);
        response.emit('data', body);
        response.emit('end');
      });

      return {
        setTimeout: () => {},
        once: response.once.bind(response),
        destroy: () => {}
      };
    };

    const result = await resolvePinnedManifest({
      userData: userData(),
      channel: 'stable',
      version: '0.0.402',
      platform: 'win',
      arch: 'x64',
      fetchManifest: ({ url }) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/api/modules/stable/versions.json') {
          return { value: versionsPayload };
        }
        return { value: templateManifest };
      },
      requestImpl,
      packageAggregateMaxBytes: 10
    });

    const persisted = JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
    assert.equal(result.source, 'fetch');
    assert.equal(result.refreshed, false);
    assert.equal(result.error.code, PinnedManifestErrors.FETCH_BODY_TOO_LARGE);
    assert.equal(toVersionText(persisted.full.host_version), '0.0.401');
  });

  test('validates package_sha256 as hash input', async () => {
    const manifest = buildValidManifest({});
    delete manifest.full.sha;
    delete manifest.modules.core.full.sha;
    manifest.full.package_sha256 = 'a'.repeat(64);
    manifest.modules.core.full.package_sha256 = 'b'.repeat(64);

    const result = await resolvePinnedManifest({
      userData: userData(),
      channel: 'stable',
      version: '0.0.402',
      platform: 'win',
      arch: 'x64',
      fetchManifest: () => ({ value: manifest })
    });

    assert.equal(result.source, 'fetch');
    assert.equal(result.refreshed, true);
  });

  test('accepts delta module_version when present and invalid when malformed', async () => {
    const manifest = buildValidManifest({});
    manifest.modules.core.deltas[0].module_version = 'bad';

    const result = await resolvePinnedManifest({
      userData: userData(),
      channel: 'stable',
      version: '0.0.402',
      platform: 'win',
      arch: 'x64',
      fetchManifest: () => ({ value: manifest })
    });

    assert.equal(result.source, 'fetch');
    assert.equal(result.error.code, PinnedManifestErrors.MANIFEST_MODULE_VERSION_INVALID);
  });

  test('writes atomically using a temp file and rename', async () => {
    const realFs = {
      ...fs,
      renameSyncCalls: []
    };
    const callLog = [];
    realFs.writeFileSync = (pathValue, value) => {
      callLog.push(['write', pathValue]);
      return fs.writeFileSync(pathValue, value);
    };
    realFs.renameSync = (from, to) => {
      callLog.push(['rename', from, to]);
      return fs.renameSync(from, to);
    };
    realFs.chmodSync = (pathValue) => {
      callLog.push(['chmod', pathValue]);
      return fs.chmodSync(pathValue);
    };
    realFs.unlinkSync = (pathValue) => {
      callLog.push(['unlink', pathValue]);
      return fs.unlinkSync(pathValue);
    };

    const result = await resolvePinnedManifest({
      userData: userData(),
      channel: 'stable',
      version: '0.0.402',
      platform: 'win',
      arch: 'x64',
      fsModule: realFs,
      fetchManifest: () => ({ value: buildValidManifest({}) })
    });

    const rename = callLog.find((entry) => entry[0] === 'rename');
    assert.equal(result.source, 'fetch');
    assert.equal(result.refreshed, true);
    assert.notEqual(rename, undefined);
    assert.equal(rename[2], manifestPath());
    assert.equal(rename[0], 'rename');
  });

  test('preserves cache when symlink exists and refreshes from fetch', async () => {
    fs.mkdirSync(userData(), { recursive: true });
    const real = path.join(root, 'real.json');
    fs.writeFileSync(real, JSON.stringify(buildValidManifest({})));
    fs.symlinkSync(real, manifestPath());

    const result = await resolvePinnedManifest({
      userData: userData(),
      channel: 'stable',
      version: '0.0.402',
      platform: 'win',
      arch: 'x64',
      fetchManifest: () => ({ value: buildValidManifest({}) })
    });

    assert.equal(result.source, 'fetch');
    assert.equal(result.refreshed, true);
    assert.ok(!fs.lstatSync(manifestPath()).isSymbolicLink());
  });

  test('handles fetch throwing into a structured error result', async () => {
    const result = await resolvePinnedManifest({
      userData: userData(),
      channel: 'stable',
      version: '0.0.402',
      platform: 'win',
      arch: 'x64',
      fetchManifest: () => {
        throw new Error('fetch exploded');
      }
    });

    assert.equal(result.source, 'fetch');
    assert.equal(result.refreshed, false);
    assert.equal(result.error.code, PinnedManifestErrors.FETCH_NETWORK);
  });

  test('rejects non-https endpoint before request', async () => {
    const result = await resolvePinnedManifest({
      userData: userData(),
      channel: 'stable',
      version: '0.0.402',
      platform: 'win',
      arch: 'x64',
      endpoint: 'http://updates.discord.com/',
      fetchManifest: () => ({ value: buildValidManifest({}) })
    });

    assert.equal(result.source, 'fetch');
    assert.equal(result.error.code, PinnedManifestErrors.MANIFEST_URL_INVALID);
  });

  test('rejects https -> http redirect from doHttpsRequest', async () => {
    const originalGet = https.get;
    let restored = false;
    let called = false;
    const response = new EventEmitter();
    response.statusCode = 302;
    response.headers = { location: 'http://discord.com/example' };
    response.resume = () => {};
    response.on = response.addListener.bind(response);

    https.get = (_, cb) => {
      called = true;
      process.nextTick(() => cb(response));
      return {
        setTimeout: () => {},
        once: response.once.bind(response),
        destroy: () => {}
      };
    };

    try {
      const result = await fetchPinnedManifest({ url: 'https://updates.discord.com/distributions/app/manifests/latest' });
      restored = true;
      assert.equal(result.error.code, PinnedManifestErrors.MANIFEST_URL_INVALID);
      assert.equal(called, true);
    } finally {
      if (!restored) {
        https.get = originalGet;
      }
    }

    https.get = originalGet;
  });
});
