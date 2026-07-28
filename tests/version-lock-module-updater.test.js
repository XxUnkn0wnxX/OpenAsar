const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, describe, test } = require('node:test');

describe('moduleUpdater version lock behavior', () => {
  let autoUpdater;
  let fakeSetFeed;
  let getCalls;
  let hostCheckCalls;
  let originalLoad;
  let originalPlatform;
  let root;

  const makeFixture = (buildVersion = '0.0.402') => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openasar-vlock-'));

    const resources = path.join(root, 'resources');
    fs.mkdirSync(path.join(root, 'v', 'modules'), { recursive: true });
    fs.mkdirSync(path.join(resources, 'bootstrap'), { recursive: true });
    fs.writeFileSync(path.join(root, 'v', 'modules', 'installed.json'), '{}');
    fs.writeFileSync(path.join(resources, 'bootstrap', 'manifest.json'), '{}');

    const fakeBuildInfo = {
      localModulesRoot: undefined,
      releaseChannel: 'stable',
      version: buildVersion
    };

    autoUpdater = new EventEmitter();
    autoUpdater.setFeedURL = url => {
      fakeSetFeed = url;
      autoUpdater.feedUrl = url;
    };
    autoUpdater.checkForUpdates = () => {
      hostCheckCalls += 1;
      autoUpdater.emit('update-not-available');
    };

    fakeSetFeed = undefined;
    getCalls = [];
    hostCheckCalls = 0;

    const fakeGet = (url, cb) => {
      getCalls.push(url);
      const emitter = new EventEmitter();
      emitter.statusCode = 200;
      emitter.headers = {};
      if (cb) cb(emitter);
      process.nextTick(() => {
        emitter.emit('data', Buffer.from('{}'));
        emitter.emit('end');
      });
      return emitter;
    };

    global.log = () => {};
    global.settings = {
      get: (key, fallback) => {
        if (key === 'SKIP_HOST_UPDATE' || key === 'SKIP_MODULE_UPDATE') return false;
        if (key === 'localModulesRoot') return undefined;
        return fallback;
      }
    };

    originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === 'electron') return { app: { relaunch: () => {}, quit: () => {} }, autoUpdater };
      if (request === '../paths') return {
        getResources: () => resources,
        getUserDataVersioned: () => path.join(root, 'v'),
      };
      if (request === '../utils/buildInfo') return fakeBuildInfo;
      if (request === 'https') return { get: fakeGet };
      return originalLoad.call(this, request, parent, isMain);
    };

    const moduleUpdaterPath = require.resolve('../src/updater/moduleUpdater');
    delete require.cache[moduleUpdaterPath];
    const updater = require(moduleUpdaterPath);
    updater.events.removeAllListeners();

    return updater;
  };

  const waitForChecked = updater => new Promise(resolve => updater.events.once('checked', resolve));

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' });
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
    Module._load = originalLoad;
    delete global.log;
    delete global.settings;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  test('skips host check and still requests module versions with lock enabled', async () => {
    const updater = makeFixture();
    const endpoint = 'https://discord.com/api';
    const checked = waitForChecked(updater);

    updater.init(endpoint, { releaseChannel: 'stable', version: '0.0.402' }, '0.0.402');
    updater.checkForUpdates();
    const event = await checked;

    assert.equal(hostCheckCalls, 0);
    assert.equal(fakeSetFeed?.includes('/updates/stable?platform=osx&version=0.0.402'), true);
    assert.equal(getCalls.length, 1);
    assert.equal(getCalls[0], 'https://discord.com/api/modules/stable/versions.json?host_version=0.0.402&platform=osx');
    assert.equal(getCalls[0], endpoint + '/modules/stable/versions.json?host_version=0.0.402&platform=osx');
    assert.equal(event.count, 0);
  });

  test('keeps host+module checks when lock is absent', async () => {
    const updater = makeFixture();
    const endpoint = 'https://discord.com/api';
    const checked = waitForChecked(updater);

    updater.init(endpoint, { releaseChannel: 'stable', version: '0.0.402' });
    updater.checkForUpdates();
    const event = await checked;

    assert.equal(hostCheckCalls, 1);
    assert.equal(fakeSetFeed?.includes('/updates/stable?platform=osx&version=0.0.402'), true);
    assert.equal(getCalls.length, 1);
    assert.equal(getCalls[0], 'https://discord.com/api/modules/stable/versions.json?host_version=0.0.402&platform=osx');
    assert.equal(event.count, 0);
  });
});
