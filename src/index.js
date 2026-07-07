const { join } = require('path');
const { app } = require('electron');

global.log = (area, ...args) => console.log(`[\x1b[38;2;88;101;242mOpenAsar\x1b[0m > ${area}]`, ...args); // Make log global for easy usage everywhere

const defaultUpdateRepo = 'GooseMod/OpenAsar';
const stampedUpdateRepo = '<updateRepo>';
global.oaVersion = 'nightly';
global.oaDisableAutoUpdate = '<disableAutoUpdate>' === 'true';
global.oaUpdateRepo = stampedUpdateRepo.startsWith('<') ? defaultUpdateRepo : stampedUpdateRepo;

log('Init', 'OpenAsar', oaVersion);

if (process.resourcesPath.startsWith('/usr/lib/electron')) global.systemElectron = true; // Using system electron, flag for other places
process.resourcesPath = join(__dirname, '..'); // Force resourcesPath for system electron

const paths = require('./paths');
paths.init();

global.settings = require('./appSettings').getSettings();
global.oaConfig = settings.get('openasar', {});

const openAsarDefaults = {
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
  forceLegacyUpdater: false
};

const ensureOpenAsarDefaults = () => {
  if (!global.oaConfig || typeof global.oaConfig !== 'object' || Array.isArray(global.oaConfig)) global.oaConfig = {};

  let changed = false;

  for (const [ key, value ] of Object.entries(openAsarDefaults)) {
    if (!Object.prototype.hasOwnProperty.call(global.oaConfig, key)) {
      global.oaConfig[key] = value;
      changed = true;
    }
  }

  if (changed) {
    settings.set('openasar', global.oaConfig);
    settings.save();
  }
};

ensureOpenAsarDefaults();

const enforceLegacyUpdaterSetting = reason => {
  settings.reload();
  global.oaConfig = settings.get('openasar', {});

  if (oaConfig.forceLegacyUpdater !== true) return false;
  if (settings.get('USE_NEW_UPDATER') === false) return true;

  settings.set('USE_NEW_UPDATER', false);
  settings.save();
  log('Init', `Forced USE_NEW_UPDATER=false (${reason}) because openasar.forceLegacyUpdater is enabled`);

  return true;
};

if (enforceLegacyUpdaterSetting('startup')) {
  const armMacOSLegacyUpdaterGuard = reason => {
    if (process.platform !== 'darwin') return;
    if (oaConfig.forceLegacyUpdater !== true) return;

    try {
      if (require('./updater/updater').prepareMacOSLegacyUpdaterGuard(reason)) {
        log('Init', `Armed macOS legacy updater OpenAsar guard (${reason})`);
      } else {
        log('Init', `Skipped macOS legacy updater OpenAsar guard (${reason}); no pending updater handoff`);
      }
    } catch (e) {
      log('Init', `Failed to arm macOS legacy updater OpenAsar guard (${reason})`, e);
    }
  };

  armMacOSLegacyUpdaterGuard('startup');
  app.on('before-quit', () => {
    enforceLegacyUpdaterSetting('before-quit');
    armMacOSLegacyUpdaterGuard('before-quit');
  });
  app.on('will-quit', () => {
    enforceLegacyUpdaterSetting('will-quit');
    armMacOSLegacyUpdaterGuard('will-quit');
  });
}

require('./cmdSwitches')();


// Force u2QuickLoad (pre-"minified" ish)
const M = require('module'); // Module

const b = join(paths.getExeDir(), 'modules'); // Base dir
if (process.platform === 'win32') try {
  for (const m of require('fs').readdirSync(b)) M.globalPaths.unshift(join(b, m)); // For each module dir, add to globalPaths
} catch { log('Init', 'Failed to QS globalPaths') }

// inject Module.globalPaths into resolve lookups as it was removed in Electron >=17 and Discord depend on this workaround
const rlp = M._resolveLookupPaths;
M._resolveLookupPaths = (request, parent) => {
  if (parent?.paths?.length > 0) parent.paths = parent.paths.concat(M.globalPaths);
  return rlp(request, parent);
};

if (process.argv.includes('--overlay-host')) { // If overlay
  require('discord_overlay2/standalone_host.js'); // Start overlay
} else {
  require('./bootstrap')(); // Start bootstrap
}
