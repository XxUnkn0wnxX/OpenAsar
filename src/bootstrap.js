const { app, dialog, session } = require('electron');
const { readFileSync } = require('fs');
const { join } = require('path');
const { VERSION_LOCK_DIALOG_TITLE, buildVersionMismatchMessage, validateVersionLock } = require('./utils/versionLock');
const { configureNativeVersionLock } = require('./utils/nativeVersionLock');
const { resolvePinnedManifest } = require('./utils/pinnedUpdateManifest');
const {
  getNativeUpdaterPlatform,
  getNativeUpdaterArch,
  getNativeUpdaterPlatformVersion
} = require('./utils/updaterIdentity');
const { initializeVersionLockLogger } = require('./utils/versionLockLogger');
const paths = require('./paths');

if (!settings.get('enableHardwareAcceleration', true)) app.disableHardwareAcceleration();
process.env.PULSE_LATENCY_MSEC = process.env.PULSE_LATENCY_MSEC ?? 30;

const buildInfo = require('./utils/buildInfo');
app.setVersion(buildInfo.version); // More global because discord / electron
global.releaseChannel = buildInfo.releaseChannel;

log('BuildInfo', buildInfo);

const Constants = require('./Constants');
app.setAppUserModelId(Constants.APP_ID);

if (buildInfo.releaseChannel !== 'stable' && process.platform === 'linux') {
  app.setName(app.getName() + '-' + buildInfo.releaseChannel);
}

const fatal = e => log('Fatal', e);
process.on('uncaughtException', console.error);

const splash = require('./splash');
const updater = require('./updater/updater');
const moduleUpdater = require('./updater/moduleUpdater');
const autoStart = require('./autoStart');

let desktopCore;
const startCore = () => {
  if (oaConfig.js || oaConfig.css) session.defaultSession.webRequest.onHeadersReceived((d, cb) => {
    delete d.responseHeaders['content-security-policy'];
    cb(d);
  });

  app.on('browser-window-created', (e, bw) => { // Main window injection
    bw.webContents.on('dom-ready', () => {
      if (!bw.resizable) return; // Main window only
      splash.pageReady(); // Override Core's pageReady with our own on dom-ready to show main window earlier

      const [ channel = '', hash = '' ] = oaVersion.split('-'); // Split via -

      bw.webContents.executeJavaScript(readFileSync(join(__dirname, 'mainWindow.js'), 'utf8')
        .replaceAll('<hash>', hash).replaceAll('<channel>', channel === 'nightly' ? '' : channel)
        .replaceAll('<notrack>', oaConfig.noTrack !== false)
        .replaceAll('<domopt>', oaConfig.domOptimizer !== false)
        .replace('<css>', (oaConfig.css ?? '').replaceAll('\\', '\\\\').replaceAll('`', '\\`')));

      if (oaConfig.js) bw.webContents.executeJavaScript(oaConfig.js);
    });
  });

  desktopCore = require('discord_desktop_core');

  const desktopTTI = new Proxy({}, {
    get: (target, prop) => {
      if (typeof target[prop] === 'undefined') {
        target[prop] = () => { };
      }
      return target[prop];
    }
  });

  desktopCore.startup({
    splashScreen: splash,
    moduleUpdater,
    buildInfo,
    Constants,
    updater,
    autoStart,

    // Just requires
    appSettings: require('./appSettings'),
    paths: require('./paths'),

    // Stubs
    GPUSettings: {
      replace: () => {}
    },
    crashReporterSetup: {
      isInitialized: () => true,
      getGlobalSentry: () => null,
      metadata: {}
    },
    logger: {
      createLogger: () => ({
        error: () => {},
        info: () => {},
        warn: () => {}
      }),
      initializeLogging: () => {},
      ipcMainRendererLogger: () => {}
    },
    analytics: new Proxy({}, {
      get: (target, prop) => {
        if (prop === 'getDesktopTTI') return () => desktopTTI;
        if (typeof target[prop] === 'undefined') {
          target[prop] = () => { };
        }
        return target[prop];
      }
    })
  });
};

const startUpdate = async () => {
  const versionLockLogger = initializeVersionLockLogger({
    userData: paths.getUserData(),
    channel: buildInfo.releaseChannel,
    runningVersion: buildInfo.version,
    useNewUpdater: Constants.USE_NEW_UPDATER,
    forceLegacyUpdater: oaConfig.forceLegacyUpdater,
    rawVersionLock: oaConfig.VersionLock
  });

  const lock = validateVersionLock({
    value: oaConfig.VersionLock,
    runningVersion: buildInfo.version,
    forceLegacyUpdater: oaConfig.forceLegacyUpdater,
    useNewUpdater: Constants.USE_NEW_UPDATER
  });

  versionLockLogger.append('validation', {
    updaterMode: lock.mode || (Constants.USE_NEW_UPDATER ? 'new' : 'legacy'),
    result: lock.error ? 'error' : lock.locked ? 'locked' : 'unlocked',
    locked: lock.locked,
    errorCode: lock.error?.code || null,
    normalizedVersionLock: lock.lockVersion || lock.error?.expected || null
  });

  const stopForVersionLockError = error => {
    const settingsPath = join(paths.getUserData(), 'settings.json');
    const expected = error.expected || lock.lockVersion;
    const updaterMode = error.expectedMode || lock.mode || (oaConfig.forceLegacyUpdater === true ? 'legacy' : 'new');
    const message = error.code === 'version-mismatch'
      ? buildVersionMismatchMessage({
        runningVersion: buildInfo.version,
        expected
      })
      : [
        'OpenAsar could not activate the Discord version lock.',
        '',
        `Updater mode: ${updaterMode}`,
        `Discord binary version: ${buildInfo.version}`,
        `VersionLock: ${expected || JSON.stringify(oaConfig.VersionLock)}`,
        `Reason: ${error.message || error.code || 'Unknown version-lock error'}`,
        '',
        'No Discord update was started.',
        `Set openasar.VersionLock to "" in ${settingsPath} to continue without a lock.`
      ].join('\n');

    log('VersionLock', `Validation failed: ${error.code || 'unknown'}; ${error.message || String(error)}`);
    versionLockLogger.append('validation-action', {
      updaterMode,
      rawVersionLock: oaConfig.VersionLock,
      normalizedVersionLock: expected || null,
      action: 'show-version-lock-dialog-and-quit',
      errorCode: error.code || 'unknown',
      errorMessage: error.message || String(error),
      errorDetails: error.details || null,
      errorCause: error.cause ? String(error.cause?.message || error.cause) : null
    });
    try {
      dialog.showErrorBox(VERSION_LOCK_DIALOG_TITLE, message);
    } catch (dialogError) {
      log('VersionLock', 'Failed to show the version-lock error dialog', dialogError);
    }
    app.quit();
  };

  if (lock.error) {
    stopForVersionLockError(lock.error);
    return;
  }

  const urls = [
    oaConfig.noTrack !== false ? 'https://*/api/*/science' : '',
    oaConfig.noTrack !== false ? 'https://*/api/*/metrics' : '',
    oaConfig.noTyping === true ? 'https://*/api/*/typing' : ''
  ].filter(x => x);

  if (urls.length > 0) session.defaultSession.webRequest.onBeforeRequest({ urls }, (e, cb) => cb({ cancel: true }));

  const startMin = process.argv?.includes?.('--start-minimized');
  let newUpdaterInitialized = false;

  if (Constants.USE_NEW_UPDATER) {
    newUpdaterInitialized = updater.tryInitUpdater(buildInfo, Constants.NEW_UPDATE_ENDPOINT, Constants.USE_RUST_BSPATCH);
    versionLockLogger.append('new-updater-init', {
      updaterMode: 'new',
      initialized: newUpdaterInitialized,
      locked: lock.locked
    });

    if (newUpdaterInitialized) {
      const inst = updater.getUpdater();

      inst.on('host-updated', () => autoStart.update(() => {}));
      inst.on('unhandled-exception', fatal);
      inst.on('InconsistentInstallerState', fatal);
      inst.on('update-error', console.error);

      try {
        await configureNativeVersionLock({
          instance: inst,
          lock,
          resolvePinnedManifest,
          manifestOptions: {
            userData: paths.getUserData(),
            channel: buildInfo.releaseChannel,
            version: lock.lockVersion,
            platform: getNativeUpdaterPlatform(),
            arch: getNativeUpdaterArch(),
            platformVersion: getNativeUpdaterPlatformVersion(),
            endpoint: Constants.NEW_UPDATE_ENDPOINT,
            logEvent: ({ event, ...details }) => versionLockLogger.append(`manifest-${event}`, {
              updaterMode: 'new',
              ...details
            })
          },
          logEvent: (event, details) => versionLockLogger.append(event, details)
        });
      } catch (error) {
        stopForVersionLockError(error);
        return;
      }

      require('./firstRun').do();
    } else if (lock.locked && lock.mode === 'new') {
      stopForVersionLockError({
        code: 'native-updater-unavailable',
        message: 'The new Discord updater could not be initialized.',
        expected: lock.lockVersion,
        expectedMode: 'new'
      });
      return;
    }
  }

  if (!newUpdaterInitialized) {
    const hostCheckEnabled = settings.get('SKIP_HOST_UPDATE') !== true && lock.locked !== true;
    const moduleUpdateEnabled = settings.get('SKIP_MODULE_UPDATE') !== true && buildInfo.localModulesRoot == null;

    versionLockLogger.append('legacy-init', {
      updaterMode: 'legacy',
      hostCheckEnabled,
      moduleUpdateEnabled,
      localModulesRoot: buildInfo.localModulesRoot == null ? null : buildInfo.localModulesRoot,
      fallbackFromNewUpdater: Constants.USE_NEW_UPDATER
    });

    moduleUpdater.init(Constants.UPDATE_ENDPOINT, buildInfo, lock.locked ? lock.lockVersion : null);
  }

  splash.events.once('APP_SHOULD_LAUNCH', () => {
    if (!process.env.OPENASAR_NOSTART) startCore();
  });

  let done;
  splash.events.once('APP_SHOULD_SHOW', () => {
    if (done) return;
    done = true;

    desktopCore.setMainWindowVisible(!startMin);

    setTimeout(() => { // Try to update our asar
      const config = require('./config');
      if (oaConfig.setup !== true) config.open();

      if (oaConfig.autoupdate !== false) {
        try {
          require('./asarUpdate')();
        } catch (e) {
          log('AsarUpdate', e);
        }
      }
    }, 3000);
  });

  const useLockedUpdaterHost = lock.locked === true && lock.mode === 'new';

  if (newUpdaterInitialized) {
    versionLockLogger.append('native-host-activation-policy', {
      updaterMode: 'new',
      locked: useLockedUpdaterHost,
      activationSuppressed: useLockedUpdaterHost
    });
  }

  splash.initSplash(startMin, {
    allowObsoleteHost: useLockedUpdaterHost
  });
};


module.exports = () => {
  app.on('second-instance', (e, a) => {
    desktopCore?.handleOpenUrl?.(a.includes('--url') && a[a.indexOf('--') + 1]); // Change url of main window if protocol is used (uses like "discord --url -- discord://example")
  });

  if (!app.requestSingleInstanceLock() && !(process.argv?.includes?.('--multi-instance') || oaConfig.multiInstance === true)) return app.quit();

  app.whenReady().then(startUpdate);
};
