const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, describe, test } = require('node:test');

const { initializeVersionLockLogger } = require('../src/utils/versionLockLogger');

describe('version-lock launch logger', () => {
  let root;

  const makeLogger = (overrides = {}) => initializeVersionLockLogger({
    userData: path.join(root, 'user-data'),
    channel: 'stable',
    runningVersion: '0.0.402',
    useNewUpdater: false,
    forceLegacyUpdater: true,
    rawVersionLock: 402,
    ...overrides
  });

  const makeRoot = () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openasar-version-lock-'));
    return root;
  };

  const getLogPath = () => path.join(root, 'user-data', 'openasar-bootstrap', 'version-lock.log');

  beforeEach(() => {
    makeRoot();
  });

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  test('creates bootstrap directory and writes launch header metadata', () => {
    const logger = makeLogger();
    const logPath = getLogPath();
    const rows = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(x => JSON.parse(x));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event, 'launch-start');
    assert.equal(rows[0].channel, 'stable');
    assert.equal(rows[0].platform, process.platform);
    assert.equal(rows[0].arch, process.arch);
    assert.equal(rows[0].runningVersion, '0.0.402');
    assert.equal(rows[0].updaterMode, 'legacy');
    assert.equal(rows[0].forceLegacyUpdater, true);
    assert.equal(rows[0].rawVersionLock, 402);
    assert.equal(fs.existsSync(path.dirname(logPath)), true);
    logger.append('noop', {});
  });

  test('writes launch log after overwriting stale content', () => {
    const userData = path.join(root, 'user-data');
    const logPath = path.join(userData, 'openasar-bootstrap', 'version-lock.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, 'stale content\n');

    const logger = makeLogger({ userData, runningVersion: '0.0.403', forceLegacyUpdater: false, rawVersionLock: '0.0.402' });
    const firstLine = JSON.parse(fs.readFileSync(logPath, 'utf8').split('\n')[0]);

    assert.equal(firstLine.event, 'launch-start');
    assert.equal(firstLine.runningVersion, '0.0.403');
    assert.equal(firstLine.forceLegacyUpdater, false);
    assert.equal(firstLine.rawVersionLock, '0.0.402');
    logger.append('validation', { result: 'error' });
  });

  test('appends events during launch while preserving launch header', () => {
    const logger = makeLogger();
    logger.append('validation', { result: 'error', errorCode: 'version-mismatch' });
    logger.append('validation-action', { action: 'show-version-lock-dialog-and-quit' });

    const rows = fs.readFileSync(getLogPath(), 'utf8').trim().split('\n');
    assert.equal(rows.length, 3);
    assert.equal(JSON.parse(rows[1]).event, 'validation');
    assert.equal(JSON.parse(rows[2]).event, 'validation-action');
  });

  test('truncates prior launch content on re-init', () => {
    const logger = makeLogger();
    logger.append('validation', { result: 'unlocked' });

    const firstPayload = fs.readFileSync(getLogPath(), 'utf8');
    const loggerRestart = makeLogger({ useNewUpdater: true, forceLegacyUpdater: false });
    const secondPayload = fs.readFileSync(getLogPath(), 'utf8');

    assert.equal(firstPayload.includes('unlocked'), true);
    assert.equal(secondPayload.includes('unlocked'), false);
    assert.equal(secondPayload.includes('launch-start'), true);
    assert.equal(JSON.parse(secondPayload).updaterMode, 'new');
    loggerRestart.append('validation', { result: 'locked' });

    const rows = fs.readFileSync(getLogPath(), 'utf8').trim().split('\n');
    assert.equal(rows.length, 2);
  });

  test('fails gracefully when initialization or write fails', () => {
    const originalLog = global.log;
    const records = [];
    global.log = (...args) => records.push(args);

    const logger = initializeVersionLockLogger({
      userData: 'bad\0path',
      channel: 'stable',
      runningVersion: '0.0.402',
      useNewUpdater: false,
      forceLegacyUpdater: false,
      rawVersionLock: ''
    });

    logger.append('validation', { result: 'unlocked' });

    assert.equal(typeof logger.append, 'function');
    assert.equal(records.length >= 1, true);
    global.log = originalLog;
  });
});
