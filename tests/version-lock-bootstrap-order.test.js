const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');

const readSource = relativePath => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

describe('VersionLock bootstrap ordering', () => {
  test('validates and applies a native pin before first-run and splash update work', () => {
    const source = readSource('src/bootstrap.js');
    const validation = source.indexOf('const lock = validateVersionLock');
    const nativeInit = source.indexOf('updater.tryInitUpdater');
    const pin = source.indexOf('await configureNativeVersionLock');
    const firstRun = source.indexOf("require('./firstRun').do()");
    const splash = source.indexOf('splash.initSplash(startMin');

    assert.notEqual(validation, -1);
    assert.notEqual(nativeInit, -1);
    assert.notEqual(pin, -1);
    assert.notEqual(firstRun, -1);
    assert.notEqual(splash, -1);
    assert.equal(validation < nativeInit, true);
    assert.equal(nativeInit < pin, true);
    assert.equal(pin < firstRun, true);
    assert.equal(firstRun < splash, true);
  });

  test('forces native updater selection for a requested non-legacy lock', () => {
    const source = readSource('src/Constants.js');

    assert.match(source, /oaConfig\.forceLegacyUpdater !== true/);
    assert.match(source, /isVersionLockRequested\(oaConfig\.VersionLock\)/);
  });

  test('keeps the native pin failure path fail-closed', () => {
    const source = readSource('src/bootstrap.js');
    const pin = source.indexOf('await configureNativeVersionLock');
    const pinFailure = source.indexOf('stopForVersionLockError(error)', pin);
    const firstRun = source.indexOf("require('./firstRun').do()");

    assert.notEqual(pinFailure, -1);
    assert.equal(pin < pinFailure, true);
    assert.equal(pinFailure < firstRun, true);
  });

  test('passes VersionLock state into splash startup to toggle obsolete host handling', () => {
    const source = readSource('src/bootstrap.js');

    assert.notEqual(source.indexOf('allowObsoleteHost: useLockedUpdaterHost'), -1);
    assert.notEqual(source.indexOf("const useLockedUpdaterHost = lock.locked === true && lock.mode === 'new'"), -1);
    assert.notEqual(source.indexOf("versionLockLogger.append('native-host-activation-policy'"), -1);
    assert.notEqual(source.indexOf('activationSuppressed: useLockedUpdaterHost'), -1);
    assert.notEqual(source.indexOf('const useLockedUpdaterHost'), -1);
    assert.notEqual(source.indexOf("splash.initSplash(startMin, {"), -1);
    assert.equal(source.indexOf('const useLockedUpdaterHost') < source.indexOf("splash.initSplash(startMin, {"), true);
  });
});
