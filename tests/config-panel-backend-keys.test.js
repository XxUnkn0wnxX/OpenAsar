const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');

test('hosted config panel saves retain the CORS setting when omitted by its payload', () => {
  const listeners = {};
  let config = { deduplicateCorsHeaders: true, forceLegacyUpdater: false };
  let savedConfig;
  const fakeSettings = {
    get: () => config,
    set: (key, value) => { config = value; },
    save() { savedConfig = config; }
  };
  const originalLoad = Module._load;
  const originalSettings = global.settings;
  global.settings = fakeSettings;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { ipcMain: { on: (name, callback) => { listeners[name] = callback; } }, app: {}, shell: {} };
    if (request === '../utils/win') return () => ({ on() {}, show() {} });
    if (request === '../appSettings') return { getSettings: () => fakeSettings };
    if (request === '../paths') return { getUserData: () => '/tmp' };
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const configPath = path.join(__dirname, '..', 'src', 'config', 'index.js');
    delete require.cache[configPath];
    const configPanel = require(configPath);
    configPanel.open();
    listeners.cs({}, { setup: true });
    assert.equal(config.deduplicateCorsHeaders, true);
    assert.equal(savedConfig.deduplicateCorsHeaders, true);
    config = { deduplicateCorsHeaders: false };
    listeners.cs({}, { setup: true });
    assert.equal(savedConfig.deduplicateCorsHeaders, false);
  } finally {
    Module._load = originalLoad;
    if (originalSettings === undefined) delete global.settings;
    else global.settings = originalSettings;
  }
});
