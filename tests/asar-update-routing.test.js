const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const asarUpdateSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'asarUpdate.js'),
  'utf8'
);
const archivePath = '/mock/resources/app.asar';
const asarHeader = Buffer.from('04000000', 'hex');

const runAsarUpdate = async options => {
  const requests = [];
  const writes = [];
  const logs = [];
  const response = {
    headers: {},
    on(event, handler) {
      if (event === 'data') queueMicrotask(() => handler(asarHeader));
      if (event === 'end') queueMicrotask(() => handler());
      return this;
    }
  };
  const get = (url, callback) => {
    requests.push(url);
    callback(response);
    return response;
  };
  const writeFile = (target, data, callback) => {
    writes.push({ target, data });
    callback();
  };
  const module = { exports: {} };
  const sandbox = {
    Buffer,
    Promise,
    clearTimeout,
    console,
    __filename: path.join(__dirname, '..', 'src', 'asarUpdate.js'),
    global: null,
    log: (area, ...args) => logs.push({ area, args }),
    module,
    queueMicrotask,
    require(request) {
      if (request === 'https') return { get };
      if (request === 'original-fs') return { writeFile };
      if (request === 'path') return { basename: path.basename };
      if (request === './injection') return { getOpenAsarArchivePath: () => archivePath };
      throw new Error(`Unexpected module request: ${request}`);
    },
    setTimeout,
    oaDisableAutoUpdate: options.disableAutoUpdate ?? false,
    oaUpdateRepo: 'FreshFork/OpenAsar',
    oaVersion: 'nightly-test'
  };
  sandbox.global = sandbox;
  if (Object.prototype.hasOwnProperty.call(options, 'channel')) sandbox.oaUpdateChannel = options.channel;

  vm.runInNewContext(asarUpdateSource, sandbox, {
    filename: path.join(__dirname, '..', 'src', 'asarUpdate.js')
  });
  await module.exports();

  return { logs, requests, writes };
};

test('uses a stamped fork channel and writes the valid ASAR to the owned archive path', async () => {
  const result = await runAsarUpdate({ channel: 'nightly-fork' });

  assert.deepEqual(result.requests, [
    'https://github.com/FreshFork/OpenAsar/releases/download/nightly-fork/app.asar'
  ]);
  assert.equal(result.writes.length, 1);
  assert.equal(result.writes[0].target, archivePath);
  assert.deepEqual(result.writes[0].data, asarHeader);
});

test('uses the version-prefix channel when the channel is absent or unresolved', async () => {
  const absent = await runAsarUpdate({});
  const unresolved = await runAsarUpdate({ channel: '<updateChannel>' });

  const expectedUrl = 'https://github.com/FreshFork/OpenAsar/releases/download/nightly/app.asar';
  assert.deepEqual(absent.requests, [expectedUrl]);
  assert.deepEqual(unresolved.requests, [expectedUrl]);
  assert.equal(absent.writes[0].target, archivePath);
  assert.equal(unresolved.writes[0].target, archivePath);
});

test('does not request or write when auto-update is disabled', async () => {
  const result = await runAsarUpdate({ channel: 'nightly-fork', disableAutoUpdate: true });

  assert.deepEqual(result.requests, []);
  assert.deepEqual(result.writes, []);
});
