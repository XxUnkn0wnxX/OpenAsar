const { app, dialog, session } = require('electron');
const { readFileSync } = require('fs');
const { join } = require('path');
const { validateVersionLock } = require('./utils/versionLock');
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

const startUpdate = () => {
  const lock = validateVersionLock({
    value: oaConfig.VersionLock,
    runningVersion: buildInfo.version,
    forceLegacyUpdater: oaConfig.forceLegacyUpdater,
    useNewUpdater: Constants.USE_NEW_UPDATER
  });
  if (!lock.locked && lock.error) {
    const settingsPath = join(paths.getUserData(), 'settings.json');
    const reason = lock.error.code === 'version-mismatch'
      ? `Install Discord ${lock.error.expected} first, or set openasar.VersionLock to "" and restart.`
      : `${lock.error.message} Set openasar.VersionLock to "" to continue without a lock.`;
    const message = [
      'OpenAsar could not activate the legacy Discord version lock.',
      reason,
      `Configured value: ${JSON.stringify(oaConfig.VersionLock)}`,
      lock.error.expected ? `Locked version: ${lock.error.expected}` : null,
      `Running Discord version: ${buildInfo.version}`,
      `Edit ${settingsPath} to change openasar.VersionLock.`,
      'Legacy update flow is required while locked.'
    ].filter(Boolean).join('\n');

    log('VersionLock', `Validation failed: ${lock.error.code}; ${lock.error.message}`);
    try {
      dialog.showErrorBox('OpenAsar version lock', message);
    } catch (e) {
      log('VersionLock', 'Failed to show the version-lock error dialog', e);
    }
    app.quit();
    return;
  }

  const urls = [
    oaConfig.noTrack !== false ? 'https://*/api/*/science' : '',
    oaConfig.noTrack !== false ? 'https://*/api/*/metrics' : '',
    oaConfig.noTyping === true ? 'https://*/api/*/typing' : ''
  ].filter(x => x);

  if (urls.length > 0) session.defaultSession.webRequest.onBeforeRequest({ urls }, (e, cb) => cb({ cancel: true }));

  const startMin = process.argv?.includes?.('--start-minimized');
  if (Constants.USE_NEW_UPDATER && updater.tryInitUpdater(buildInfo, Constants.NEW_UPDATE_ENDPOINT, Constants.USE_RUST_BSPATCH)) {
    const inst = updater.getUpdater();

    inst.on('host-updated', () => autoStart.update(() => {}));
    inst.on('unhandled-exception', fatal);
    inst.on('InconsistentInstallerState', fatal);
    inst.on('update-error', console.error);

    require('./firstRun').do();
  } else {
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

  splash.initSplash(startMin);
};


module.exports = () => {
  app.on('second-instance', (e, a) => {
    desktopCore?.handleOpenUrl?.(a.includes('--url') && a[a.indexOf('--') + 1]); // Change url of main window if protocol is used (uses like "discord --url -- discord://example")
  });

  if (!app.requestSingleInstanceLock() && !(process.argv?.includes?.('--multi-instance') || oaConfig.multiInstance === true)) return app.quit();

  app.whenReady().then(startUpdate);
};
