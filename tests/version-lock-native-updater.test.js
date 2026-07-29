const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { describe, test } = require('node:test');

const { configureNativeVersionLock } = require('../src/utils/nativeVersionLock');

describe('native updater VersionLock application', () => {
  test('resolves and sets the exact pin in order', async () => {
    const order = [];
    const manifest = { full: { host_version: [0, 0, 402] } };
    const result = await configureNativeVersionLock({
      instance: {
        setPinnedManifestSync(value) {
          order.push('pin');
          assert.equal(value, manifest);
        }
      },
      lock: { locked: true, lockVersion: '0.0.402', mode: 'new' },
      resolvePinnedManifest: async options => {
        order.push('resolve');
        assert.equal(options.targetVersion, '0.0.402');
        return { manifest, source: 'cache', refreshed: false };
      },
      manifestOptions: { targetVersion: '0.0.402' },
      logEvent: event => order.push(event)
    });

    assert.deepEqual(order, ['resolve', 'pin', 'pin-set']);
    assert.equal(result.locked, true);
    assert.equal(result.source, 'cache');
  });

  test('clears a persisted native pin when VersionLock is blank', async () => {
    const order = [];
    const result = await configureNativeVersionLock({
      instance: {
        clearPinnedManifestSync() {
          order.push('clear');
        }
      },
      lock: { locked: false, lockVersion: null, mode: null },
      resolvePinnedManifest: async () => {
        throw new Error('must not resolve');
      },
      manifestOptions: {},
      logEvent: event => order.push(event)
    });

    assert.deepEqual(order, ['clear', 'pin-cleared']);
    assert.equal(result.locked, false);
  });

  test('fails closed when manifest resolution or native pinning fails', async () => {
    await assert.rejects(
      configureNativeVersionLock({
        instance: {
          setPinnedManifestSync() {
            throw new Error('must not pin');
          }
        },
        lock: { locked: true, lockVersion: '0.0.402', mode: 'new' },
        resolvePinnedManifest: async () => ({
          manifest: null,
          error: {
            code: 'manifest-full-version-mismatch',
            message: 'Wrong version'
          },
          source: 'fetch'
        }),
        manifestOptions: {}
      }),
      error => error.code === 'manifest-full-version-mismatch'
    );

    await assert.rejects(
      configureNativeVersionLock({
        instance: { setPinnedManifestSync() {} },
        lock: { locked: true, lockVersion: '0.0.402', mode: 'new' },
        resolvePinnedManifest: async () => {
          const error = new Error('wrong manifest');
          error.code = 'manifest-version-mismatch';
          throw error;
        },
        manifestOptions: {}
      }),
      error => error.code === 'manifest-version-mismatch'
    );

    await assert.rejects(
      configureNativeVersionLock({
        instance: {
          setPinnedManifestSync() {
            throw new Error('native rejected');
          }
        },
        lock: { locked: true, lockVersion: '0.0.402', mode: 'new' },
        resolvePinnedManifest: async () => ({ manifest: {}, source: 'download' }),
        manifestOptions: {}
      }),
      error => error.code === 'pin-set-failed'
    );
  });

  test('fails closed when clearing a prior native pin fails', async () => {
    await assert.rejects(
      configureNativeVersionLock({
        instance: {
          clearPinnedManifestSync() {
            throw new Error('native rejected');
          }
        },
        lock: { locked: false, lockVersion: null, mode: null },
        resolvePinnedManifest: async () => {
          throw new Error('must not resolve');
        },
        manifestOptions: {}
      }),
      error => error.code === 'pin-clear-failed'
    );
  });

  test('native wrapper clears Pinned and suppresses locked host activation on every platform', () => {
    const originalLoad = Module._load;
    const updaterPath = require.resolve('../src/updater/updater');
    const requests = [];

    Module._load = function(request, parent, isMain) {
      if (request === 'electron') return { app: new EventEmitter() };
      if (request === '../paths' && parent?.filename.endsWith('/src/updater/updater.js')) {
        return {
          getRootPath: () => '/tmp/openasar-native-wrapper',
          getUserData: () => '/tmp/openasar-native-wrapper'
        };
      }
      if (request === '../injection' && parent?.filename.endsWith('/src/updater/updater.js')) {
        return {
          detectBetterDiscordWrapper: () => ({ valid: false, reason: 'test' }),
          getOpenAsarArchivePath: () => '/tmp/openasar-native-wrapper/app.asar'
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    global.log = () => {};
    delete require.cache[updaterPath];

    try {
      const { Updater } = require(updaterPath);
      class FakeNativeUpdater {
        command_blocking(request) {
          requests.push(JSON.parse(request));
          return JSON.stringify('Ok');
        }
      }

      const instance = new Updater({
        nativeUpdaterModule: { Updater: FakeNativeUpdater },
        root_path: '/tmp/openasar-native-wrapper',
        user_data_path: '/tmp/openasar-native-wrapper',
        release_channel: 'stable',
        platform: 'osx',
        current_os_arch: 'x64',
        repository_url: 'https://updates.discord.com/',
        use_rust_bspatch: true
      });

      instance.clearPinnedManifestSync();
      assert.deepEqual(requests, [[0, { SetManifests: ['Pinned', null] }]]);

      const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
      try {
        for (const platform of ['darwin', 'win32', 'linux']) {
          Object.defineProperty(process, 'platform', {
            ...platformDescriptor,
            value: platform
          });

          const moduleName = `version_lock_${platform}`;
          instance.installedHostThisSession = true;
          instance._startCurrentVersionInner({ allowObsoleteHost: true }, {
            current_host: [0, 0, 402],
            current_modules: {
              [moduleName]: 1
            }
          });

          const modulePath = instance.committedModulePaths.get(moduleName);
          assert.equal(typeof modulePath, 'string');
          assert.equal(modulePath.includes('app-0.0.402'), true);
          assert.equal(modulePath.endsWith(`/${moduleName}`), true);

          const globalPath = Module.globalPaths.indexOf(modulePath.slice(0, -moduleName.length - 1));
          if (globalPath !== -1) Module.globalPaths.splice(globalPath, 1);
        }
      } finally {
        Object.defineProperty(process, 'platform', platformDescriptor);
      }
    } finally {
      delete require.cache[updaterPath];
      Module._load = originalLoad;
      delete global.log;
    }
  });
});
