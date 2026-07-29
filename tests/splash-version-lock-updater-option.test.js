const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');
const { describe, test } = require('node:test');

const loadSplashAndRun = async ({ allowObsoleteHost }) => {
  const calls = [];
  const window = {
    webContents: { send: () => {} },
    setSkipTaskbar: () => {},
    on: () => {},
    once: (event, cb) => {
      if (event === 'ready-to-show') cb();
    },
    show: () => {},
    hide: () => {},
    close: () => {},
    focus: () => {}
  };

  const app = {
    on: () => {},
    once: () => {},
    quit: () => {},
    exit: () => {}
  };

  const fakeUpdater = {
    updateToLatestWithOptions: async () => {},
    startCurrentVersion: async (...callArgs) => {
      calls.push({
        hasSecondArg: callArgs.length > 1,
        options: callArgs[1]
      });
    },
    collectGarbage: () => {}
  };

  const originalLoad = Module._load;
  const splashPath = path.join(__dirname, '..', 'src', 'splash', 'index.js');

  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { app, ipcMain: { on: () => {} } };
    if (request === '../updater/moduleUpdater') {
      return {
        events: new EventEmitter()
      };
    }
    if (request === '../updater/updater') {
      return {
        getUpdater: () => fakeUpdater
      };
    }
    if (request === '../utils/win') return () => window;

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[splashPath];
    global.settings = {
      get: key => key === 'ALLOW_OPTIONAL_UPDATES' ? true : undefined
    };
    const splash = require(splashPath);
    global.oaConfig = { quickstart: false };

    const launched = new Promise(resolve => splash.events.once('APP_SHOULD_LAUNCH', resolve));
    splash.initSplash(false, { allowObsoleteHost });
    await launched;
  } finally {
    Module._load = originalLoad;
    delete global.settings;
    delete global.oaConfig;
    delete require.cache[splashPath];
  }

  return calls;
};

describe('splash new-updater launch option wiring', () => {
  test('passes allowObsoleteHost=true for locked new VersionLock launch', async () => {
    const calls = await loadSplashAndRun({ allowObsoleteHost: true });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].hasSecondArg, true);
    assert.deepEqual(calls[0].options, { allowObsoleteHost: true });
  });

  test('does not pass allowObsoleteHost for unlocked native launch', async () => {
    const calls = await loadSplashAndRun({ allowObsoleteHost: false });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].hasSecondArg, false);
    assert.equal(calls[0].options, undefined);
  });
});
