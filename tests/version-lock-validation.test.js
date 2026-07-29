const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  VERSION_LOCK_DIALOG_TITLE,
  buildVersionMismatchMessage,
  isVersionLockRequested,
  parseVersionLockValue,
  validateVersionLock,
  VERSION_LOCK_PATTERN,
  SHORTHAND_VERSION_PATTERN
} = require('../src/utils/versionLock');

describe('openasar VersionLock validation', () => {
  test('allows absent lock', () => {
    const result = validateVersionLock({
      value: undefined,
      runningVersion: '0.0.402',
      forceLegacyUpdater: false,
      useNewUpdater: false
    });

    assert.equal(result.locked, false);
    assert.equal(result.lockVersion, null);
    assert.equal(result.error, null);
  });

  test('allows false lock', () => {
    const result = validateVersionLock({
      value: false,
      runningVersion: '0.0.402',
      forceLegacyUpdater: false,
      useNewUpdater: false
    });

    assert.equal(result.locked, false);
    assert.equal(result.lockVersion, null);
    assert.equal(result.error, null);
  });

  test('allows explicit empty string lock', () => {
    const result = validateVersionLock({
      value: '',
      runningVersion: '0.0.402',
      forceLegacyUpdater: false,
      useNewUpdater: false
    });

    assert.equal(result.locked, false);
    assert.equal(result.lockVersion, null);
    assert.equal(result.error, null);
  });

  test('accepts shorthand number lock', () => {
    const result = validateVersionLock({
      value: 402,
      runningVersion: '0.0.402',
      forceLegacyUpdater: true,
      useNewUpdater: false
    });

    assert.equal(result.locked, true);
    assert.equal(result.lockVersion, '0.0.402');
    assert.equal(result.mode, 'legacy');
    assert.equal(result.error, null);
  });

  test('accepts shorthand string lock', () => {
    const result = validateVersionLock({
      value: '402',
      runningVersion: '0.0.402',
      forceLegacyUpdater: true,
      useNewUpdater: false
    });

    assert.equal(result.locked, true);
    assert.equal(result.lockVersion, '0.0.402');
    assert.equal(result.error, null);
  });

  test('accepts canonical triples unchanged', () => {
    const result = validateVersionLock({
      value: '0.0.402',
      runningVersion: '0.0.402',
      forceLegacyUpdater: true,
      useNewUpdater: false
    });

    assert.equal(result.locked, true);
    assert.equal(result.lockVersion, '0.0.402');
    assert.equal(result.error, null);
  });

  test('accepts a canonical future triple unchanged', () => {
    for (const candidate of ['0.1.10', '1.0.40']) {
      const result = validateVersionLock({
        value: candidate,
        runningVersion: candidate,
        forceLegacyUpdater: true,
        useNewUpdater: false
      });

      assert.equal(result.locked, true);
      assert.equal(result.lockVersion, candidate);
      assert.equal(result.error, null);
    }
  });

  test('rejects malformed lock values', () => {
    const malformed = ['0.0.042', '1.2', 'foo.bar.baz', '0.0', '00', '1.01.2', '1.2.003'];
    for (const candidate of malformed) {
      const result = validateVersionLock({
        value: candidate,
        runningVersion: '0.0.402',
        forceLegacyUpdater: true,
        useNewUpdater: false
      });

      assert.equal(result.locked, false);
      assert.equal(result.lockVersion, null);
      assert.equal(result.error?.code, 'invalid-format');
    }
  });

  test('rejects wrong type lock values', () => {
    const badNumberTypes = [-1, 1.1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1];
    const badNonNumberTypes = [true, null, {}, []];

    for (const candidate of badNumberTypes) {
      const result = validateVersionLock({
        value: candidate,
        runningVersion: '0.0.402',
        forceLegacyUpdater: true,
        useNewUpdater: false
      });

      assert.equal(result.locked, false);
      assert.equal(result.lockVersion, null);
      assert.equal(result.error?.code, 'invalid-type');
    }

    for (const candidate of badNonNumberTypes) {
      const result = validateVersionLock({
        value: candidate,
        runningVersion: '0.0.402',
        forceLegacyUpdater: true,
        useNewUpdater: false
      });

      assert.equal(result.locked, false);
      assert.equal(result.lockVersion, null);
      assert.equal(result.error?.code, 'invalid-format');
    }
  });

  test('normalizes shorthand number variants for matching', () => {
    const numberResult = parseVersionLockValue(402);
    const stringResult = parseVersionLockValue('402');

    assert.equal(numberResult.error, null);
    assert.equal(numberResult.lockVersion, '0.0.402');
    assert.equal(stringResult.error, null);
    assert.equal(stringResult.lockVersion, '0.0.402');
  });

  test('parses absolute and shorthand version shapes', () => {
    assert.equal(VERSION_LOCK_PATTERN.test('0.0.402'), true);
    assert.equal(VERSION_LOCK_PATTERN.test('1.0.40'), true);
    assert.equal(VERSION_LOCK_PATTERN.test('1.0.003'), false);
    assert.equal(SHORTHAND_VERSION_PATTERN.test('0'), true);
    assert.equal(SHORTHAND_VERSION_PATTERN.test('00'), false);
    assert.equal(SHORTHAND_VERSION_PATTERN.test('402'), true);
    assert.equal(SHORTHAND_VERSION_PATTERN.test('0402'), false);
  });

  test('applies a non-empty lock to the new updater when legacy force is off', () => {
    const result = validateVersionLock({
      value: '0.0.402',
      runningVersion: '0.0.402',
      forceLegacyUpdater: false,
      useNewUpdater: true
    });

    assert.equal(result.locked, true);
    assert.equal(result.lockVersion, '0.0.402');
    assert.equal(result.mode, 'new');
    assert.equal(result.error, null);
  });

  test('rejects invalid values in new updater mode', () => {
    const result = validateVersionLock({
      value: { bad: true },
      runningVersion: '0.0.402',
      forceLegacyUpdater: false,
      useNewUpdater: true
    });

    assert.equal(result.locked, false);
    assert.equal(result.lockVersion, null);
    assert.equal(result.error?.code, 'invalid-format');
  });

  test('requires the new updater for a lock when legacy force is off', () => {
    const result = validateVersionLock({
      value: '0.0.402',
      runningVersion: '0.0.402',
      forceLegacyUpdater: false,
      useNewUpdater: false
    });

    assert.equal(result.locked, false);
    assert.equal(result.error?.code, 'new-updater-required');
  });

  test('does not reject empty lock when forceLegacyUpdater is true', () => {
    const result = validateVersionLock({
      value: '',
      runningVersion: '0.0.403',
      forceLegacyUpdater: true,
      useNewUpdater: false
    });

    assert.equal(result.locked, false);
    assert.equal(result.lockVersion, null);
    assert.equal(result.error, null);
  });

  test('rejects active lock in new updater mode with forceLegacy true', () => {
    const result = validateVersionLock({
      value: '0.0.402',
      runningVersion: '0.0.402',
      forceLegacyUpdater: true,
      useNewUpdater: true
    });

    assert.equal(result.locked, false);
    assert.equal(result.error?.code, 'new-updater-active');
  });

  test('rejects version mismatch in both updater modes', () => {
    for (const mode of [
      { forceLegacyUpdater: true, useNewUpdater: false, expectedMode: 'legacy' },
      { forceLegacyUpdater: false, useNewUpdater: true, expectedMode: 'new' }
    ]) {
      const result = validateVersionLock({
        value: '0.0.402',
        runningVersion: '0.0.403',
        ...mode
      });

      assert.equal(result.locked, false);
      assert.equal(result.error?.code, 'version-mismatch');
      assert.equal(result.error?.expectedMode, mode.expectedMode);
    }
  });

  test('builds a mismatch message with explicit binary and lock versions', () => {
    const message = buildVersionMismatchMessage({
      runningVersion: '0.0.403',
      expected: '0.0.402'
    });

    assert.equal(VERSION_LOCK_DIALOG_TITLE, 'OpenAsar');
    assert.equal(message, [
      'The Discord binary version differs from the configured VersionLock.',
      '',
      'Discord binary version: 0.0.403',
      'VersionLock: 0.0.402'
    ].join('\n'));
  });

  test('detects whether VersionLock requests an updater mode', () => {
    for (const value of [undefined, false, '']) assert.equal(isVersionLockRequested(value), false);
    for (const value of [0, 402, '402', '0.0.402', null, true, {}]) assert.equal(isVersionLockRequested(value), true);
  });
});
