const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { describe, test } = require('node:test');

const readSource = relativePath => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

const makeOpenAsarConfig = forceLegacyUpdater => ({
  setup: false,
  cmdPreset: 'perf',
  customFlags: '',
  noTrack: true,
  noTyping: false,
  themeSync: true,
  quickstart: false,
  multiInstance: false,
  domOptimizer: true,
  autoupdate: true,
  css: '',
  js: '',
  VersionLock: '',
  forceLegacyUpdater
});

const loadIndexWithMockSettings = ({ forceLegacyUpdater, existingUseNewUpdater }) => {
  const events = [];
  const fakeSettings = {
    openasar: makeOpenAsarConfig(forceLegacyUpdater),
    useNewUpdater: existingUseNewUpdater,
    saveCount: 0,
    reload() {
      events.push('settings.reload');
    },
    get(key, fallback) {
      events.push(`settings.get:${key}`);
      if (key === 'openasar') return this.openasar;
      if (key === 'USE_NEW_UPDATER') return this.useNewUpdater ?? fallback;
      return fallback;
    },
    set(key, value) {
      events.push(`settings.set:${key}:${value}`);
      if (key === 'USE_NEW_UPDATER') this.useNewUpdater = value;
      if (key === 'openasar') this.openasar = value;
    },
    save() {
      this.saveCount += 1;
      events.push('settings.save');
    }
  };

  const fakeApp = {
    on: () => events.push('app.on'),
    prependListener: () => events.push('app.prependListener'),
    relaunch: () => {},
    exit: () => {}
  };
  const fakeBootstrap = () => {
    events.push('bootstrap');
    return undefined;
  };

  const originalLoad = Module._load;
  const originalResourcesPath = process.resourcesPath;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'linux' });
  process.resourcesPath = '/tmp/openasar-resources';

  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { app: fakeApp };
    if (request === './injection') {
      return {
        detectBetterDiscordWrapper: () => ({ valid: false, reason: 'mocked' }),
        getOpenAsarArchivePath: () => '/tmp/openasar/app.asar'
      };
    }
    if (request === './paths') {
      return {
        init: () => {
          events.push('paths.init');
        },
        getExeDir: () => '/tmp/openasar'
      };
    }
    if (request === './appSettings') return { getSettings: () => fakeSettings };
    if (request === './cmdSwitches') return () => {};
    if (request === './bootstrap') return fakeBootstrap;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const indexPath = path.join(__dirname, '..', 'src', 'index.js');
    delete require.cache[indexPath];
    require(indexPath);
  } finally {
    Module._load = originalLoad;
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
    process.resourcesPath = originalResourcesPath;
  }

  return { fakeSettings, events };
};

describe('index USE_NEW_UPDATER persistence contract', () => {
  test('forces USE_NEW_UPDATER=false when forceLegacyUpdater is true', () => {
    const { fakeSettings, events } = loadIndexWithMockSettings({
      forceLegacyUpdater: true,
      existingUseNewUpdater: true
    });

    assert.equal(fakeSettings.useNewUpdater, false);
    assert.equal(events.includes('settings.set:USE_NEW_UPDATER:false'), true);
    assert.equal(fakeSettings.saveCount, 1);
  });

  test('forces USE_NEW_UPDATER=true when forceLegacyUpdater is false and setting is false', () => {
    const { fakeSettings, events } = loadIndexWithMockSettings({
      forceLegacyUpdater: false,
      existingUseNewUpdater: false
    });

    assert.equal(fakeSettings.useNewUpdater, true);
    assert.equal(events.includes('settings.set:USE_NEW_UPDATER:true'), true);
    assert.equal(fakeSettings.saveCount, 1);
  });

  test('is idempotent when USE_NEW_UPDATER already matches forceLegacyUpdater=false', () => {
    const { fakeSettings, events } = loadIndexWithMockSettings({
      forceLegacyUpdater: false,
      existingUseNewUpdater: true
    });

    assert.equal(fakeSettings.useNewUpdater, true);
    assert.equal(events.includes('settings.set:USE_NEW_UPDATER:true'), false);
    assert.equal(fakeSettings.saveCount, 0);
  });

  test('is idempotent when USE_NEW_UPDATER already matches forceLegacyUpdater=true', () => {
    const { fakeSettings, events } = loadIndexWithMockSettings({
      forceLegacyUpdater: true,
      existingUseNewUpdater: false
    });

    assert.equal(fakeSettings.useNewUpdater, false);
    assert.equal(events.includes('settings.set:USE_NEW_UPDATER:false'), false);
    assert.equal(fakeSettings.saveCount, 0);
  });

  test('startup enforcement runs before bootstrap loading', () => {
    const { events } = loadIndexWithMockSettings({
      forceLegacyUpdater: false,
      existingUseNewUpdater: false
    });

    const reloadIndex = events.indexOf('settings.reload');
    const bootstrapIndex = events.indexOf('bootstrap');
    assert.notEqual(reloadIndex, -1);
    assert.notEqual(bootstrapIndex, -1);
    assert.equal(reloadIndex < bootstrapIndex, true);
  });

  test('startup enforcement executes before macOS updater guard setup in source order', () => {
    const source = readSource('src/index.js');
    const startupEnforceIndex = source.indexOf("enforceLegacyUpdaterSetting('startup', true)");
    const platformGateIndex = source.indexOf("if (process.platform === 'darwin') {");
    const darwinGuardIndex = source.indexOf('app.prependListener(\'before-quit\',');
    const bootstrapIndex = source.indexOf("require('./bootstrap')();");

    assert.notEqual(startupEnforceIndex, -1);
    assert.notEqual(platformGateIndex, -1);
    assert.notEqual(darwinGuardIndex, -1);
    assert.notEqual(bootstrapIndex, -1);
    assert.equal(startupEnforceIndex < platformGateIndex, true);
    assert.equal(startupEnforceIndex < darwinGuardIndex, true);
    assert.equal(startupEnforceIndex < bootstrapIndex, true);
  });

  test('keeps the self-healing updater guard explicitly macOS-only', () => {
    const source = readSource('src/index.js');
    const guardFunctionIndex = source.indexOf('const armMacOSUpdaterGuard = reason =>');
    const darwinReturnIndex = source.indexOf("if (process.platform !== 'darwin') return;", guardFunctionIndex);
    const helperCallIndex = source.indexOf("prepareMacOSLegacyUpdaterGuard(reason)", guardFunctionIndex);

    assert.notEqual(guardFunctionIndex, -1);
    assert.notEqual(darwinReturnIndex, -1);
    assert.notEqual(helperCallIndex, -1);
    assert.equal(guardFunctionIndex < darwinReturnIndex, true);
    assert.equal(darwinReturnIndex < helperCallIndex, true);
  });
});
