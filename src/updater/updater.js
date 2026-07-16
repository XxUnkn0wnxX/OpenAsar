const { spawn, execSync } = require('child_process');
const { app } = require('electron');
const fs = require('fs');
const Module = require('module');
const { join, resolve, basename, dirname } = require('path');
const { hrtime } = require('process');

const paths = require('../paths');
const { detectBetterDiscordWrapper, getOpenAsarArchivePath } = require('../injection');

let instance;
let currentVersion;
const TASK_STATE_COMPLETE = 'Complete';
const TASK_STATE_FAILED = 'Failed';
const TASK_STATE_WAITING = 'Waiting';
const TASK_STATE_WORKING = 'Working';

const updaterPath = process.platform === 'darwin' ? join(process.execPath, '..', '..', 'Resources', 'updater.node') : join(process.execPath, '..', 'updater.node');
const getCurrentOpenAsarPath = () => global.oaArchivePath ?? getOpenAsarArchivePath(__filename);
const getHostResourcesPath = () => global.oaHostResourcesPath ?? dirname(getCurrentOpenAsarPath());

const getCurrentMacOSAppPath = () => {
  const parts = process.execPath.split('/');

  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].endsWith('.app')) return parts.slice(0, i + 1).join('/');
  }

  return null;
};

const getMacOSHelperEnvironment = () => {
  const environment = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    SHELL: '/bin/zsh'
  };

  for (const key of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', '__CF_USER_TEXT_ENCODING']) {
    if (typeof process.env[key] === 'string' && process.env[key].length > 0) environment[key] = process.env[key];
  }

  return environment;
};

const prepareMacOSPostHostUpdateHelper = (stagedAppPath = '', targetAppPath = getCurrentMacOSAppPath(), mode = 'shipit', reason = '') => {
  if (process.platform !== 'darwin') return false;

  targetAppPath = targetAppPath ? resolve(targetAppPath) : targetAppPath;

  const ofs = require('original-fs');
  const userData = paths.getUserData();
  const bootstrapDir = join(userData, 'openasar-bootstrap');
  const helperPath = join(bootstrapDir, 'post-shipit-helper.zsh');
  const payloadPath = join(bootstrapDir, 'app.asar');
  const statePath = join(bootstrapDir, 'post-shipit-state.json');
  const logPath = join(bootstrapDir, 'post-shipit-helper.log');
  const consoleLogPath = join(bootstrapDir, 'post-shipit-console.log');
  const armLogPath = join(bootstrapDir, 'post-shipit-arm.log');
  const pidPath = join(bootstrapDir, 'post-shipit-helper.pid');
  const pendingPath = join(bootstrapDir, 'post-shipit-update-pending.json');
  const requestPath = join(userData, 'ShipIt_request.json');
  const currentAsar = getCurrentOpenAsarPath();
  const nestedArchiveExpected = basename(currentAsar) === 'betterdiscord.app.asar';
  let armedAt = new Date().toISOString();
  const betterDiscordWrapper = detectBetterDiscordWrapper(getHostResourcesPath());
  const betterDiscordExpected = betterDiscordWrapper.valid;
  const betterDiscordChannel = betterDiscordExpected ? betterDiscordWrapper.marker.channel : '';
  const installationId = betterDiscordExpected ? betterDiscordWrapper.marker.installationId : '';
  const nestedTarget = targetAppPath ? join(targetAppPath, 'Contents', 'Resources', 'betterdiscord.app.asar') : '';
  const betterDiscordReadyPath = join(userData, 'betterdiscord-bootstrap', 'wrapper-ready.json');
  const stoppedExistingPids = [];

  if (mode === 'guard' && betterDiscordExpected) {
    try {
      const pending = JSON.parse(ofs.readFileSync(pendingPath, 'utf8'));
      if (pending.pending === true
        && pending.betterDiscordExpected === true
        && pending.installationId === installationId
        && pending.appPath === targetAppPath
        && pending.nestedTarget === nestedTarget
        && !Number.isNaN(Date.parse(pending.armedAt))) {
        armedAt = pending.armedAt;
      }
    } catch (_) {}
  }

  const pendingIdentity = betterDiscordExpected ? {
    betterDiscordExpected: true,
    schema: 1,
    owner: 'betterdiscord',
    style: 'app-wrapper',
    channel: betterDiscordChannel,
    installationId,
    appPath: targetAppPath,
    nestedTarget,
    armedAt,
    helperPath,
    helperPidPath: pidPath
  } : {
    betterDiscordExpected: false
  };
  const writeInactivePendingMarker = reason => {
    try {
      ofs.writeFileSync(pendingPath, JSON.stringify({
        pending: false,
        updatedAt: new Date().toISOString(),
        reason,
        targetAppPath,
        ...pendingIdentity
      }, null, 2));
    } catch (_) {}
  };
  const ensurePendingMarker = () => {
    if (mode === 'shipit' || mode === 'legacy') {
      try {
        ofs.writeFileSync(pendingPath, JSON.stringify({
          pending: true,
          createdAt: new Date().toISOString(),
          mode,
          reason,
          stagedAppPath,
          targetAppPath,
          ...pendingIdentity
        }, null, 2));
      } catch (_) {}
      return;
    }

    try {
      ofs.statSync(pendingPath);
    } catch (_) {
      writeInactivePendingMarker('initialized');
    }
  };
  const appendBootstrapLog = message => {
    try {
      const line = `[${new Date().toString()}] ${message}\n`;
      ofs.appendFileSync(logPath, line);
      ofs.appendFileSync(armLogPath, line);
    } catch (_) {}
  };
  const listExistingHelpers = () => {
    const helpers = [];
    let recordedPid = 0;
    try {
      if (ofs.lstatSync(pidPath).isSymbolicLink()) return helpers;
      const rawPid = ofs.readFileSync(pidPath, 'utf8').trim();
      if (/^\d+$/.test(rawPid)) recordedPid = parseInt(rawPid, 10);
    } catch (_) {
      return helpers;
    }
    if (!Number.isFinite(recordedPid) || recordedPid <= 0) return helpers;

    const commandPrefixes = [
      `zsh -f ${helperPath} `,
      `/bin/zsh -f ${helperPath} `,
      `/usr/bin/zsh -f ${helperPath} `,
      `/usr/bin/env zsh -f ${helperPath} `
    ];
    const psOutput = execSync('/bin/ps -axo pid=,pgid=,command=', { encoding: 'utf8' });
    for (const line of psOutput.split('\n')) {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (match == null) continue;
      const candidate = { pid: parseInt(match[1], 10), pgid: parseInt(match[2], 10), command: match[3] };
      if (candidate.pid !== recordedPid || candidate.pid === process.pid || candidate.pgid !== candidate.pid) continue;
      if (!commandPrefixes.some(prefix => candidate.command.startsWith(prefix)) || !candidate.command.includes(pidPath)) continue;
      helpers.push(candidate);
    }
    return helpers;
  };
  const helperIsRunning = pid => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (_) {
      return false;
    }
  };
  const waitForHelperExit = pid => {
    for (let attempt = 0; attempt < 20; attempt++) {
      if (!helperIsRunning(pid)) return true;
      execSync('/bin/sleep 0.1');
    }
    return !helperIsRunning(pid);
  };
  const stopExistingHelpers = () => {
    for (const helper of listExistingHelpers()) {
      try {
        process.kill(-helper.pid, 'SIGTERM');
        stoppedExistingPids.push(helper.pid);
      } catch (_) {
        continue;
      }
      if (waitForHelperExit(helper.pid)) continue;
      const current = listExistingHelpers().find(candidate => candidate.pid === helper.pid);
      if (current == null) continue;
      try {
        process.kill(-helper.pid, 'SIGKILL');
        waitForHelperExit(helper.pid);
      } catch (_) {}
    }
  };
  const guardHasPendingUpdate = () => {
    if (mode !== 'guard') return true;

    let markerStat;
    try {
      markerStat = ofs.statSync(pendingPath);
    } catch (_) {
      writeInactivePendingMarker('missing-marker');
      return false;
    }

    if (Date.now() - markerStat.mtimeMs > 300000) {
      writeInactivePendingMarker('stale-marker');
      return false;
    }

    try {
      const marker = JSON.parse(ofs.readFileSync(pendingPath, 'utf8'));
      if (marker.pending !== true) return false;
      if (marker.targetAppPath && targetAppPath && marker.targetAppPath !== targetAppPath) {
        writeInactivePendingMarker('target-mismatch');
        return false;
      }
    } catch (_) {
      writeInactivePendingMarker('invalid-marker');
      return false;
    }

    return true;
  };

  ofs.mkdirSync(bootstrapDir, { recursive: true });

  for (const file of [
    'openasar-bootstrap-app.asar',
    'openasar-post-shipit-helper.js',
    'openasar-post-shipit-helper.zsh',
    'openasar-post-shipit-state.json',
    'openasar-post-shipit-helper.log',
    'openasar-post-shipit-console.log',
    'openasar-post-shipit-helper.pid'
  ]) {
    try {
      ofs.unlinkSync(join(userData, file));
    } catch (_) {}
  }
  try {
    stopExistingHelpers();
  } catch (_) {}
  for (const file of [ logPath, consoleLogPath, pidPath ]) {
    try {
      ofs.writeFileSync(file, '');
    } catch (_) {}
  }
  if (stoppedExistingPids.length > 0) appendBootstrapLog(`Stopped existing OpenAsar helper pids=${stoppedExistingPids.join(',')}`);

  if (nestedArchiveExpected && !betterDiscordExpected) {
    const message = `Refused OpenAsar helper preparation: running from betterdiscord.app.asar but BetterDiscord wrapper validation failed (${betterDiscordWrapper.reason})`;
    appendBootstrapLog(message);
    throw new Error(message);
  }

  ofs.copyFileSync(currentAsar, payloadPath);
  appendBootstrapLog(`Prepared OpenAsar helper; mode=${mode} reason=${reason || 'unspecified'} staged=${stagedAppPath || '(none)'} target=${targetAppPath || '(unknown)'} payload=${payloadPath}`);
  if (betterDiscordExpected) {
    appendBootstrapLog(`Detected BetterDiscord wrapper; installationId=${installationId} waitingFor=${betterDiscordReadyPath} nestedTarget=${nestedTarget}`);
    log('Updater', `OpenAsar recovery will wait for BetterDiscord wrapper installationId=${installationId} before writing ${nestedTarget}`);
  } else {
    appendBootstrapLog(`BetterDiscord wrapper not detected (${betterDiscordWrapper.reason}); retaining standalone app.asar recovery path`);
    log('Updater', 'OpenAsar recovery is using the standalone app.asar path');
  }
  ensurePendingMarker();

  ofs.writeFileSync(helperPath, MACOS_POST_SHIPIT_HELPER);
  ofs.writeFileSync(statePath, JSON.stringify({
    bootstrapDir,
    payloadPath,
    requestPath,
    stagedAppPath,
    targetAppPath,
    mode,
    reason,
    helperPath,
    logPath,
    consoleLogPath,
    armLogPath,
    pidPath,
    pendingPath,
    betterDiscordExpected,
    betterDiscordChannel,
    installationId,
    nestedTarget,
    betterDiscordReadyPath,
    armedAt
  }));
  ofs.chmodSync(helperPath, 0o755);

  if (!guardHasPendingUpdate()) {
    appendBootstrapLog(`Skipped OpenAsar helper start; no pending updater handoff for mode=${mode}`);
    return false;
  }

  const child = spawn('/usr/bin/env', [
    'zsh',
    '-f',
    helperPath,
    payloadPath,
    requestPath,
    stagedAppPath ?? '',
    targetAppPath ?? '',
    logPath,
    consoleLogPath,
    pidPath,
    mode,
    reason,
    pendingPath,
    betterDiscordExpected ? '1' : '0',
    installationId,
    betterDiscordReadyPath,
    armedAt,
    nestedTarget,
    betterDiscordChannel
  ], {
    detached: true,
    stdio: 'ignore',
    env: getMacOSHelperEnvironment()
  });

  if (Number.isInteger(child.pid) && child.pid > 0) {
    try {
      const pending = JSON.parse(ofs.readFileSync(pendingPath, 'utf8'));
      if (pending.pending === true) {
        const temporaryPendingPath = `${pendingPath}.${process.pid}.tmp`;
        ofs.writeFileSync(temporaryPendingPath, JSON.stringify({
          ...pending,
          helperPid: child.pid,
          helperPath,
          helperPidPath: pidPath,
          helperStartedAt: new Date().toISOString()
        }, null, 2));
        ofs.renameSync(temporaryPendingPath, pendingPath);
      }
    } catch (error) {
      appendBootstrapLog(`Could not record OpenAsar helper identity: ${String(error)}`);
    }
  }

  appendBootstrapLog(`Started OpenAsar helper pid=${child.pid} mode=${mode} reason=${reason || 'unspecified'}`);
  child.unref();
  return true;
};

const prepareMacOSLegacyUpdaterGuard = reason => prepareMacOSPostHostUpdateHelper('', getCurrentMacOSAppPath(), 'guard', reason);

class Updater extends require('events').EventEmitter {
  constructor(options) {
    super();

    let Native;
    try {
      Native = options.nativeUpdaterModule ?? require(updaterPath);
    } catch (e) {
      log('Updater', e); // Error when requiring

      if (e.code === 'MODULE_NOT_FOUND') return;
      throw e;
    }

    this.committedHostVersion = null;
    this.committedModules = new Set();
    this.committedModulePaths = new Map();
    this.rootPath = options.root_path;
    this.nextRequestId = 0;
    this.requests = new Map();
    this.updateEventHistory = [];
    this.currentlyDownloading = {};
    this.currentlyInstalling = {};
    this.installedHostThisSession = false;
    this.hasEmittedUnhandledException = false;

    this.nativeUpdater = new Native.Updater({
      response_handler: this._handleResponse.bind(this),
      ...options
    });
  }

  get valid() {
    return this.nativeUpdater != null;
  }

  _sendRequest(detail, progressCallback = null) {
    if (!this.valid) throw 'No native';

    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.requests.set(requestId, {
        resolve,
        reject,
        progressCallback
      });

      this.nativeUpdater.command(JSON.stringify([ requestId, detail ]));
    });
  }

  _sendRequestSync(detail) {
    if (!this.valid) throw 'No native';

    return this.nativeUpdater.command_blocking(JSON.stringify([ this.nextRequestId++, detail ]));
  }

  _handleResponse(response) {
    try {
      const [ id, detail ] = JSON.parse(response);
      const request = this.requests.get(id);

      if (request == null) return log('Updater', id, detail); // No request handlers for id / type

      if (detail['Error'] != null) {
        const {
          kind,
          details,
          severity
        } = detail['Error'];
        const e = new Error(`(${kind}) ${details}`);

        if (severity === 'Fatal') {
          if (!this.emit(kind, e)) throw e;
        } else {
          this.emit('update-error', e);
          request.reject(e);
          this.requests.delete(id);
        }
      } else if (detail === 'Ok') {
        request.resolve();
        this.requests.delete(id);
      } else if (detail['VersionInfo'] != null) {
        request.resolve(detail['VersionInfo']);
        this.requests.delete(id);
      } else if (detail['ManifestInfo'] != null) {
        request.resolve(detail['ManifestInfo']);
        this.requests.delete(id);
      } else if (detail['TaskProgress'] != null) {
        const msg = detail['TaskProgress'];
        const progress = {
          task: msg[0],
          state: msg[1],
          percent: msg[2],
          bytesProcessed: msg[3]
        };

        this._recordTaskProgress(progress);

        request.progressCallback?.(progress);

        if (progress.task['HostInstall'] != null && progress.state === TASK_STATE_COMPLETE) {
          this.installedHostThisSession = true;
          this.emit('host-updated');
        }
      } else log('Updater', id, detail); // Unknown response
    } catch (e) {
      log('Updater', e); // Error handling response

      if (!this.hasEmittedUnhandledException) {
        this.hasEmittedUnhandledException = true;
        this.emit('unhandled-exception', e);
      }
    }
  }

  _handleSyncResponse(response) {
    const detail = JSON.parse(response);

    if (detail.Error != null) throw detail.Error;
      else if (detail === 'Ok') return;
      else if (detail.VersionInfo != null) return detail.VersionInfo;

    log('Updater', detail); // Unknown response
  }

  _getHostPath() {
    return join(this.rootPath, `app-${this.committedHostVersion.join('.')}`);
  }

  _getHostExePath() {
    const hostPath = this._getHostPath();
    if (process.platform === 'darwin') {
      const app = process.execPath.split('/').findLast(x => x.endsWith('.app'));
      if (app) return join(hostPath, app);
    }

    return join(hostPath, basename(process.execPath));
  }

  _updateMacOSHostVersion(hostExePath) {
    return this._handleSyncResponse(this._sendRequestSync({
      UpdateMacOSHostVersion: {
        host_exe_path: hostExePath
      }
    }));
  }

  _getCurrentMacOSAppPath() {
    return getCurrentMacOSAppPath();
  }

  _prepareMacOSPostShipItHelper(next) {
    prepareMacOSPostHostUpdateHelper(next, this._getCurrentMacOSAppPath(), 'shipit', 'new-updater-host');
  }

  _startCurrentVersionInner(options, versions) {
    if (this.committedHostVersion == null) this.committedHostVersion = versions.current_host;

    const next = resolve(this._getHostExePath());
    const isMacOS = process.platform === 'darwin';
    const hostIsObsolete = isMacOS ? currentVersion !== this.committedHostVersion.join('.') : next !== resolve(process.execPath);
    const shouldCommitMacOSHost = isMacOS && this.installedHostThisSession;

    if ((hostIsObsolete || shouldCommitMacOSHost) && !options?.allowObsoleteHost) {
      // Retain OpenAsar
      const fs = require('original-fs');

      const cAsar = getCurrentOpenAsarPath();
      const nextResources = isMacOS ? null : join(next, '..', 'resources');
      const nAsar = isMacOS ? null : join(nextResources, 'app.asar');
      const betterDiscordWrapper = detectBetterDiscordWrapper(getHostResourcesPath());
      const nestedArchiveExpected = basename(cAsar) === 'betterdiscord.app.asar';

      if (isMacOS) {
        try {
          this._prepareMacOSPostShipItHelper(next);
        } catch (e) {
          log('Updater', 'Failed to prepare post-ShipIt OpenAsar retention', e);
        }
        this._updateMacOSHostVersion(next);
      } else if (betterDiscordWrapper.valid) {
        const installationId = betterDiscordWrapper.marker.installationId;
        const nestedTarget = join(nextResources, 'betterdiscord.app.asar');

        log('Updater', `BetterDiscord wrapper detected; staging OpenAsar until migrated wrapper is ready installationId=${installationId}`);
        app.once('will-quit', () => {
          const migratedWrapper = detectBetterDiscordWrapper(nextResources);

          if (!migratedWrapper.valid) {
            log('Updater', `BetterDiscord wrapper was not ready (${migratedWrapper.reason}); refusing top-level app.asar fallback`);
          }
          else if (migratedWrapper.marker.installationId !== installationId) {
            log('Updater', `BetterDiscord wrapper installationId mismatch; expected=${installationId} actual=${migratedWrapper.marker.installationId}; refusing top-level app.asar fallback`);
          }
          else if (migratedWrapper.nestedTarget !== nestedTarget) {
            log('Updater', `BetterDiscord nested target mismatch; expected=${nestedTarget} actual=${migratedWrapper.nestedTarget}; refusing top-level app.asar fallback`);
          }
          else {
            try {
              fs.copyFileSync(nestedTarget, nestedTarget + '.backup');
              fs.copyFileSync(cAsar, nestedTarget);
              log('Updater', `BetterDiscord wrapper ready; retained OpenAsar in nested payload ${nestedTarget}`);
            } catch (e) {
              log('Updater', 'Failed to retain OpenAsar in BetterDiscord nested payload', e);
            }
          }

          spawn(next, [], {
            detached: true,
            stdio: 'inherit'
          });
        });
      } else if (nestedArchiveExpected) {
        log('Updater', `Running from BetterDiscord nested payload but wrapper validation failed (${betterDiscordWrapper.reason}); refusing top-level app.asar fallback`);
        app.once('will-quit', () => spawn(next, [], {
          detached: true,
          stdio: 'inherit'
        }));
      } else {
        try {
          fs.copyFileSync(nAsar, nAsar + '.backup'); // Copy new app.asar to backup file (<new>/app.asar -> <new>/app.asar.backup)
          fs.copyFileSync(cAsar, nAsar); // Copy old app.asar to new app.asar (<old>/app.asar -> <new>/app.asar)
        } catch (e) {
          log('Updater', 'Failed to retain OpenAsar', e);
        }

        app.once('will-quit', () => spawn(next, [], {
          detached: true,
          stdio: 'inherit'
        }));
      }

      log('Updater', 'Restarting', next);
      return app.quit();
    }

    this._commitModulesInner(versions);
  }

  _commitModulesInner(versions) {
    const base = join(this._getHostPath(), 'modules');

    for (const m in versions.current_modules) {
      const path = join(base, `${m}-${versions.current_modules[m]}`);
      if (this.committedModules.has(m) || Module.globalPaths.includes(path)) continue;

      this.committedModules.add(m);
      this.committedModulePaths.set(m, join(path, m));
      Module.globalPaths.unshift(path);
    }
  }

  _recordDownloadProgress(name, progress) {
    const now = String(hrtime.bigint());

    if (progress.state === TASK_STATE_WORKING && !this.currentlyDownloading[name]) {
      this.currentlyDownloading[name] = true;
      this.updateEventHistory.push({
        type: 'downloading-module',
        name,
        now
      });
    } else if (progress.state === TASK_STATE_COMPLETE || progress.state === TASK_STATE_FAILED) {
      this.currentlyDownloading[name] = false;
      this.updateEventHistory.push({
        type: 'downloaded-module',
        name,
        now,
        succeeded: progress.state === TASK_STATE_COMPLETE,
        receivedBytes: progress.bytesProcessed
      });
    }
  }

  _recordInstallProgress(name, progress, newVersion, isDelta) {
    const now = String(hrtime.bigint());

    if (progress.state === TASK_STATE_WORKING && !this.currentlyInstalling[name]) {
      this.currentlyInstalling[name] = true;
      this.updateEventHistory.push({
        type: 'installing-module',
        name,
        now,
        newVersion
      });
    } else if (progress.state === TASK_STATE_COMPLETE || progress.state === TASK_STATE_FAILED) {
      this.currentlyInstalling[name] = false;
      this.updateEventHistory.push({
        type: 'installed-module',
        name,
        now,
        newVersion,
        succeeded: progress.state === TASK_STATE_COMPLETE,
        delta: isDelta
      });
    }
  }

  _recordTaskProgress(progress) {
    if (progress.task.HostDownload != null) this._recordDownloadProgress('host', progress);
      else if (progress.task.HostInstall != null) this._recordInstallProgress('host', progress, null, progress.task.HostInstall.from_version != null);
      else if (progress.task.ModuleDownload != null) this._recordDownloadProgress(progress.task.ModuleDownload.version.module.name, progress);
      else if (progress.task.ModuleInstall != null) this._recordInstallProgress(progress.task.ModuleInstall.version.module.name, progress, progress.task.ModuleInstall.version.version, progress.task.ModuleInstall.from_version != null);
  }

  constructQueryCurrentVersionsRequest(options) {
    return {
      QueryCurrentVersions: {
        options
      }
    };
  }

  queryCurrentVersionsWithOptions(options) {
    return this._sendRequest(this.constructQueryCurrentVersionsRequest(options));
  }
  queryCurrentVersions() {
    return this.queryCurrentVersionsWithOptions(null);
  }

  queryCurrentVersionsWithOptionsSync(options) {
    return this._handleSyncResponse(this._sendRequestSync(this.constructQueryCurrentVersionsRequest(options)));
  }
  queryCurrentVersionsSync() {
    return this.queryCurrentVersionsWithOptionsSync(null);
  }

  repair(progressCallback) {
    return this.repairWithOptions(null, progressCallback);
  }

  repairWithOptions(options, progressCallback) {
    return this._sendRequest({
      Repair: {
        options
      }
    }, progressCallback);
  }

  collectGarbage() {
    return this._sendRequest('CollectGarbage');
  }

  setRunningManifest(manifest) {
    return this._sendRequest({
      SetManifests: ['Running', manifest]
    });
  }

  setPinnedManifestSync(manifest) {
    return this._handleSyncResponse(this._sendRequestSync({
      SetManifests: ['Pinned', manifest]
    }));
  }

  installModule(name, progressCallback) {
    return this.installModuleWithOptions(name, null, progressCallback);
  }

  installModuleWithOptions(name, options, progressCallback) {
    return this._sendRequest({
      InstallModule: {
        name,
        options
      }
    }, progressCallback);
  }

  updateToLatest(progressCallback) {
    return this.updateToLatestWithOptions(null, progressCallback);
  }

  updateToLatestWithOptions(options, progressCallback) {
    return this._sendRequest({
      UpdateToLatest: {
        options
      }
    }, progressCallback);
  }


  async startCurrentVersion(queryOptions, options) {
    const versions = await this.queryCurrentVersionsWithOptions(queryOptions);
    await this.setRunningManifest(versions.last_successful_update);

    this._startCurrentVersionInner(options, versions);
  }

  startCurrentVersionSync(options) {
    this._startCurrentVersionInner(options, this.queryCurrentVersionsSync());
  }

  async commitModules(queryOptions, versions) {
    if (this.committedHostVersion == null) throw 'No host';

    this._commitModulesInner(versions ?? await this.queryCurrentVersionsWithOptions(queryOptions));
  }

  queryAndTruncateHistory() {
    const history = this.updateEventHistory;
    this.updateEventHistory = [];
    return history;
  }

  getKnownFolder(name) {
    if (!this.valid) throw 'No native';

    return this.nativeUpdater.known_folder(name);
  }

  createShortcut(options) {
    if (!this.valid) throw 'No native';

    return this.nativeUpdater.create_shortcut(options);
  }
}

const MACOS_POST_SHIPIT_HELPER = `#!/usr/bin/env -S zsh -f
set -u

payload_path="$1"
request_path="$2"
staged_app_path="$3"
target_app_path="$4"
log_path="$5"
console_log_path="$6"
pid_path="$7"
mode="\${8:-shipit}"
reason="\${9:-}"
pending_path="\${10:-$(/usr/bin/dirname "$pid_path")/post-shipit-update-pending.json}"
bd_expected="\${11:-0}"
bd_installation_id="\${12:-}"
bd_ready_path="\${13:-}"
bd_armed_at="\${14:-}"
bd_nested_target="\${15:-}"
bd_channel="\${16:-}"
bd_disabled_path=""
[[ -n "$bd_ready_path" ]] && bd_disabled_path="$(/usr/bin/dirname "$bd_ready_path")/recovery-disabled"
bd_last_mismatch=""
bundle_id=""
saw_shipit=0

cleanup_pid_file() {
  local current_pid=""

  [[ -f "$pid_path" ]] && current_pid="$(/bin/cat "$pid_path" 2>/dev/null || true)"
  if [[ "$current_pid" = "$$" ]]; then
    /bin/rm -f "$pid_path" 2>/dev/null || true
  fi
}

helper_processes() {
  /bin/ps -axo pid=,pgid= 2>/dev/null || true
}

signal_helper_descendants() {
  local signal="$1"
  local process_list="$(helper_processes)"
  local child_pid=""
  local process_group=""

  while read -r child_pid process_group; do
    [[ "$child_pid" = <-> && "$process_group" = "$$" && "$child_pid" != "$$" ]] || continue
    /bin/kill "-$signal" "$child_pid" 2>/dev/null || true
  done <<< "$process_list"
}

terminate_helper() {
  local status="$1"

  trap - EXIT INT TERM
  signal_helper_descendants TERM
  /bin/sleep 0.1
  signal_helper_descendants KILL
  cleanup_pid_file
  exit "$status"
}

/bin/mkdir -p "$(/usr/bin/dirname "$pid_path")" 2>/dev/null || true
pid_temporary="$pid_path.$$.tmp"
print -r -- "$$" > "$pid_temporary" 2>/dev/null && /bin/mv -f "$pid_temporary" "$pid_path" 2>/dev/null || true
trap cleanup_pid_file EXIT
trap 'terminate_helper 130' INT
trap 'terminate_helper 143' TERM

/bin/mkdir -p "$(/usr/bin/dirname "$console_log_path")" 2>/dev/null || true
exec >> "$console_log_path" 2>&1
PS4='+openasar-bootstrap:%D{%Y-%m-%d %H:%M:%S %Z}:%N:%i: '
set -x

log() {
  /bin/mkdir -p "$(/usr/bin/dirname "$log_path")" 2>/dev/null || true
  local message="[$(/bin/date '+%Y-%m-%d %H:%M:%S %Z')] $*"
  print -r -- "$message" >> "$log_path" 2>/dev/null || true
  print -r -- "$message"
}

json_string_value() {
  local key="$1"
  local file="$2"

  [[ -f "$file" ]] || return 1
  OPENASAR_JSON_KEY="$key" /usr/bin/perl -0ne 'BEGIN { $key = quotemeta $ENV{"OPENASAR_JSON_KEY"}; } print $1 if /"$key"\\s*:\\s*"([^"]*)"/' "$file" 2>/dev/null
}

json_bool_true() {
  local key="$1"
  local file="$2"

  [[ -f "$file" ]] || return 1
  OPENASAR_JSON_KEY="$key" /usr/bin/perl -0ne 'BEGIN { $key = quotemeta $ENV{"OPENASAR_JSON_KEY"}; $found = 0; } $found = 1 if /"$key"\\s*:\\s*true\\b/; END { exit($found ? 0 : 1) }' "$file" 2>/dev/null
}

json_number_value() {
  local key="$1"
  local file="$2"

  [[ -f "$file" ]] || return 1
  OPENASAR_JSON_KEY="$key" /usr/bin/perl -0ne 'BEGIN { $key = quotemeta $ENV{"OPENASAR_JSON_KEY"}; } print $1 if /"$key"\\s*:\\s*(-?[0-9]+)/' "$file" 2>/dev/null
}

iso_to_epoch_ms() {
  local value="$1"

  OPENASAR_ISO="$value" /usr/bin/perl -MTime::Local=timegm -e '
    my $value = $ENV{"OPENASAR_ISO"} // "";
    if ($value =~ /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.(\\d+))?Z$/) {
      my ($year, $month, $day, $hour, $minute, $second, $fraction) = ($1, $2, $3, $4, $5, $6, $7 // "");
      my $millis = substr($fraction . "000", 0, 3);
      print(timegm($second, $minute, $hour, $day, $month - 1, $year) * 1000 + $millis);
      exit 0;
    }
    exit 1;
  ' 2>/dev/null
}

file_url_to_path() {
  local value="$1"

  [[ -n "$value" ]] || return 1
  value="\${value#file://}"
  value="$(print -r -- "$value" | /usr/bin/perl -pe 's/%([0-9A-Fa-f]{2})/chr(hex($1))/eg')"
  value="\${value%/}"
  print -r -- "$value"
}

patch_shipit_request() {
  [[ -f "$request_path" ]] || return 1

  /usr/bin/grep -Eq '"launchAfterInstallation"[[:space:]]*:[[:space:]]*true' "$request_path" 2>/dev/null || return 0
  /usr/bin/perl -0pi -e 's/"launchAfterInstallation"\\s*:\\s*true/"launchAfterInstallation":false/g' "$request_path" 2>> "$log_path" \
    && log "Disabled ShipIt launchAfterInstallation" \
    || log "Failed to patch ShipIt launchAfterInstallation"
}

refresh_shipit_state() {
  local target_url
  local detected_bundle_id

  [[ -f "$request_path" ]] || return 1
  patch_shipit_request

  target_url="$(json_string_value targetBundleURL "$request_path")"
  detected_bundle_id="$(json_string_value bundleIdentifier "$request_path")"

  [[ -n "$detected_bundle_id" ]] && bundle_id="$detected_bundle_id"
  [[ -n "$target_url" ]] && target_app_path="$(file_url_to_path "$target_url")"
}

shipit_running() {
  local output

  output="$(/bin/ps -axo command= 2>/dev/null | /usr/bin/grep -F 'Squirrel.framework' | /usr/bin/grep -F 'ShipIt' | /usr/bin/grep -v '/usr/bin/grep' || true)"
  [[ -n "$output" ]] || return 1

  if [[ -z "$bundle_id" ]]; then
    return 0
  fi

  print -r -- "$output" | /usr/bin/grep -F "$bundle_id" >/dev/null 2>&1 && return 0
  print -r -- "$output" | /usr/bin/grep -F "$request_path" >/dev/null 2>&1 && return 0
  return 1
}

kill_discord_from_target() {
  local signal="$1"
  local final_exe_dir
  local pids
  local pid

  [[ -n "$target_app_path" ]] || return 0
  final_exe_dir="$target_app_path/Contents/MacOS"
  pids="$(/usr/bin/pgrep -f "$final_exe_dir" 2>/dev/null || true)"

  print -r -- "$pids" | while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    [[ "$pid" = "$$" ]] && continue
    /bin/kill "-$signal" "$pid" 2>> "$log_path" && log "Sent $signal to early Discord launch pid $pid" || true
  done
}

wait_for_stable_asar() {
  local final_asar="$1"
  local deadline="$((SECONDS + 120))"
  local stable_ticks=0
  local last_size=""
  local size

  while (( stable_ticks < 3 && SECONDS < deadline )); do
    if [[ ! -f "$final_asar" ]]; then
      stable_ticks=0
      sleep 0.25
      continue
    fi

    size="$(/usr/bin/stat -f%z "$final_asar" 2>/dev/null || true)"
    if [[ -n "$size" && "$size" != "0" && "$size" = "$last_size" ]]; then
      stable_ticks="$((stable_ticks + 1))"
    else
      stable_ticks=0
    fi

    last_size="$size"
    sleep 0.25
  done

  [[ -f "$final_asar" ]]
}

target_asar_path() {
  if [[ "$bd_expected" = "1" ]]; then
    print -r -- "$bd_nested_target"
  else
    print -r -- "$target_app_path/Contents/Resources/app.asar"
  fi
}

set_bd_mismatch() {
  bd_last_mismatch="$*"
  return 1
}

bd_bundle_marker_valid() {
  local wrapper_dir="$target_app_path/Contents/Resources/app"
  local marker_path="$target_app_path/Contents/Resources/app/.betterdiscord-inject.json"
  local schema=""
  local owner=""
  local style=""
  local channel=""
  local marker_mode=""
  local loader=""
  local payload=""
  local bd_path=""
  local installation_id=""
  local entry=""
  local entry_name=""
  local -a wrapper_entries

  [[ -f "$marker_path" ]] || set_bd_mismatch "BetterDiscord bundle marker not available at $marker_path" || return 1

  schema="$(json_number_value schema "$marker_path" || true)"
  owner="$(json_string_value owner "$marker_path" || true)"
  style="$(json_string_value style "$marker_path" || true)"
  channel="$(json_string_value channel "$marker_path" || true)"
  marker_mode="$(json_string_value mode "$marker_path" || true)"
  loader="$(json_string_value loader "$marker_path" || true)"
  payload="$(json_string_value payload "$marker_path" || true)"
  bd_path="$(json_string_value bdPath "$marker_path" || true)"
  installation_id="$(json_string_value installationId "$marker_path" || true)"

  [[ "$schema" = "1" ]] || set_bd_mismatch "BetterDiscord bundle marker schema mismatch: \${schema:-missing}" || return 1
  [[ "$owner" = "betterdiscord" ]] || set_bd_mismatch "BetterDiscord bundle marker owner mismatch: \${owner:-missing}" || return 1
  [[ "$style" = "app-wrapper" ]] || set_bd_mismatch "BetterDiscord bundle marker style mismatch: \${style:-missing}" || return 1
  [[ "$channel" = "$bd_channel" ]] || set_bd_mismatch "BetterDiscord bundle marker channel mismatch: expected=$bd_channel actual=\${channel:-missing}" || return 1
  [[ "$marker_mode" = "release" || "$marker_mode" = "dev" ]] || set_bd_mismatch "BetterDiscord bundle marker mode mismatch: \${marker_mode:-missing}" || return 1
  [[ "$loader" = "index.js" ]] || set_bd_mismatch "BetterDiscord bundle marker loader mismatch: \${loader:-missing}" || return 1
  [[ "$payload" = "../betterdiscord.app.asar" ]] || set_bd_mismatch "BetterDiscord bundle marker payload mismatch: \${payload:-missing}" || return 1
  [[ -n "$bd_path" ]] || set_bd_mismatch "BetterDiscord bundle marker bdPath is missing" || return 1
  [[ "$installation_id" = "$bd_installation_id" ]] || set_bd_mismatch "BetterDiscord bundle marker installationId mismatch: expected=$bd_installation_id actual=\${installation_id:-missing}" || return 1
  [[ ! -e "$target_app_path/Contents/Resources/app.asar" ]] || set_bd_mismatch "Unexpected top-level app.asar exists beside BetterDiscord wrapper" || return 1
  [[ -f "$wrapper_dir/index.js" ]] || set_bd_mismatch "BetterDiscord wrapper loader is missing" || return 1
  [[ -f "$wrapper_dir/package.json" ]] || set_bd_mismatch "BetterDiscord wrapper package is missing" || return 1
  [[ -f "$bd_nested_target" ]] || set_bd_mismatch "BetterDiscord nested payload is missing at $bd_nested_target" || return 1

  wrapper_entries=("$wrapper_dir"/*(DN))
  [[ "\${#wrapper_entries[@]}" = "3" ]] || set_bd_mismatch "BetterDiscord wrapper contains unexpected files" || return 1
  for entry in "\${wrapper_entries[@]}"; do
    entry_name="\${entry:t}"
    [[ "$entry_name" = ".betterdiscord-inject.json" || "$entry_name" = "index.js" || "$entry_name" = "package.json" ]] \
      || set_bd_mismatch "BetterDiscord wrapper contains unexpected file $entry_name" || return 1
  done

  /usr/bin/grep -Fq -- '__betterdiscord_inject_meta__' "$wrapper_dir/index.js" \
    || set_bd_mismatch "BetterDiscord wrapper loader ownership token is missing" || return 1
  /usr/bin/grep -Fq -- '../betterdiscord.app.asar' "$wrapper_dir/index.js" \
    || set_bd_mismatch "BetterDiscord wrapper loader target is incorrect" || return 1

  local package_main="$(json_string_value main "$wrapper_dir/package.json" || true)"
  [[ "$package_main" = "index.js" || "$package_main" = "./index.js" ]] \
    || set_bd_mismatch "BetterDiscord wrapper package main is incorrect" || return 1

  return 0
}

bd_ready_marker_valid() {
  local schema=""
  local owner=""
  local style=""
  local channel=""
  local installation_id=""
  local app_path=""
  local ready_target_app_path=""
  local nested_target=""
  local ready_at=""
  local ready_epoch=""
  local armed_epoch=""

  [[ -f "$bd_ready_path" ]] || set_bd_mismatch "BetterDiscord wrapper-ready marker not available at $bd_ready_path" || return 1

  schema="$(json_number_value schema "$bd_ready_path" || true)"
  owner="$(json_string_value owner "$bd_ready_path" || true)"
  style="$(json_string_value style "$bd_ready_path" || true)"
  channel="$(json_string_value channel "$bd_ready_path" || true)"
  installation_id="$(json_string_value installationId "$bd_ready_path" || true)"
  app_path="$(json_string_value appPath "$bd_ready_path" || true)"
  ready_target_app_path="$(json_string_value targetAppPath "$bd_ready_path" || true)"
  nested_target="$(json_string_value nestedTarget "$bd_ready_path" || true)"
  ready_at="$(json_string_value readyAt "$bd_ready_path" || true)"

  [[ "$schema" = "1" ]] || set_bd_mismatch "BetterDiscord wrapper-ready schema mismatch: \${schema:-missing}" || return 1
  [[ "$owner" = "betterdiscord" ]] || set_bd_mismatch "BetterDiscord wrapper-ready owner mismatch: \${owner:-missing}" || return 1
  [[ "$style" = "app-wrapper" ]] || set_bd_mismatch "BetterDiscord wrapper-ready style mismatch: \${style:-missing}" || return 1
  [[ "$channel" = "$bd_channel" ]] || set_bd_mismatch "BetterDiscord wrapper-ready channel mismatch: expected=$bd_channel actual=\${channel:-missing}" || return 1
  [[ "$installation_id" = "$bd_installation_id" ]] || set_bd_mismatch "BetterDiscord wrapper-ready installationId mismatch: expected=$bd_installation_id actual=\${installation_id:-missing}" || return 1
  [[ "$app_path" = "$target_app_path" ]] || set_bd_mismatch "BetterDiscord wrapper-ready appPath mismatch: expected=$target_app_path actual=\${app_path:-missing}" || return 1
  [[ "$ready_target_app_path" = "$target_app_path" ]] || set_bd_mismatch "BetterDiscord wrapper-ready targetAppPath mismatch: expected=$target_app_path actual=\${ready_target_app_path:-missing}" || return 1
  [[ "$nested_target" = "$bd_nested_target" ]] || set_bd_mismatch "BetterDiscord wrapper-ready nestedTarget mismatch: expected=$bd_nested_target actual=\${nested_target:-missing}" || return 1

  ready_epoch="$(iso_to_epoch_ms "$ready_at" || true)"
  armed_epoch="$(iso_to_epoch_ms "$bd_armed_at" || true)"
  [[ -n "$ready_epoch" ]] || set_bd_mismatch "BetterDiscord wrapper-ready readyAt is invalid: \${ready_at:-missing}" || return 1
  [[ -n "$armed_epoch" ]] || set_bd_mismatch "OpenAsar armedAt is invalid: \${bd_armed_at:-missing}" || return 1
  (( ready_epoch >= armed_epoch )) || set_bd_mismatch "BetterDiscord wrapper-ready marker is stale: readyAt=$ready_at armedAt=$bd_armed_at" || return 1

  bd_bundle_marker_valid || return 1
  return 0
}

wait_for_bd_wrapper_ready() {
  local deadline="$((SECONDS + 180))"
  local previous_mismatch=""

  [[ "$bd_expected" = "1" ]] || return 0

  log "BetterDiscord wrapper expected; waiting for wrapper-ready marker installationId=$bd_installation_id target=$bd_nested_target"
  while (( SECONDS < deadline )); do
    exit_if_bd_recovery_disabled
    bd_last_mismatch=""
    if bd_ready_marker_valid; then
      log "BetterDiscord wrapper ready; installationId=$bd_installation_id target=$bd_nested_target"
      return 0
    fi

    if [[ -n "$bd_last_mismatch" && "$bd_last_mismatch" != "$previous_mismatch" ]]; then
      log "$bd_last_mismatch"
      previous_mismatch="$bd_last_mismatch"
    fi
    sleep 0.5
  done

  log "Timed out waiting for BetterDiscord wrapper; refusing top-level app.asar fallback installationId=$bd_installation_id target=$bd_nested_target lastMismatch=\${bd_last_mismatch:-unknown}"
  return 1
}

copy_openasar_into_target() {
  local final_asar="$(target_asar_path)"
  local backup_asar="$final_asar.backup"
  local backup_temporary="$final_asar.backup.$$"
  local payload_temporary="$final_asar.openasar.$$"

  exit_if_bd_recovery_disabled

  if [[ "$bd_expected" = "1" ]]; then
    wait_for_bd_wrapper_ready || return 1
    if payload_matches_target; then
      log "BetterDiscord nested payload already matches staged OpenAsar; no copy needed"
      return 0
    fi
    log "Copying OpenAsar into BetterDiscord nested payload $final_asar"
  fi

  wait_for_stable_asar "$final_asar" || {
    log "Final OpenAsar target never became available at $final_asar"
    return 1
  }

  /bin/rm -f "$backup_temporary" "$payload_temporary" 2>/dev/null || true

  if [[ "$saw_shipit" = "1" || ! -f "$backup_asar" ]]; then
    if ! /bin/cp -f "$final_asar" "$backup_temporary" 2>> "$log_path" \
      || ! /usr/bin/cmp -s "$final_asar" "$backup_temporary" \
      || ! /bin/mv -f "$backup_temporary" "$backup_asar" 2>> "$log_path"; then
      /bin/rm -f "$backup_temporary" 2>/dev/null || true
      log "Failed to create a verified backup of final OpenAsar target"
      return 1
    fi
  else
    log "Preserved existing target backup during direct patch"
  fi

  if ! /bin/cp -f "$payload_path" "$payload_temporary" 2>> "$log_path" \
    || ! /usr/bin/cmp -s "$payload_path" "$payload_temporary"; then
    /bin/rm -f "$payload_temporary" 2>/dev/null || true
    log "Failed to stage and verify OpenAsar payload for $final_asar"
    return 1
  fi

  if [[ "$bd_expected" = "1" && -n "$bd_disabled_path" && -e "$bd_disabled_path" ]]; then
    /bin/rm -f "$payload_temporary" 2>/dev/null || true
    exit_if_bd_recovery_disabled
  fi

  if ! /bin/mv -f "$payload_temporary" "$final_asar" 2>> "$log_path"; then
    /bin/rm -f "$payload_temporary" 2>/dev/null || true
    log "Failed to atomically replace OpenAsar target $final_asar"
    return 1
  fi

  if [[ "$bd_expected" = "1" ]]; then
    log "Restored OpenAsar into BetterDiscord nested payload $final_asar"
  else
    log "Restored OpenAsar into final app $final_asar"
  fi
}

payload_matches_target() {
  local final_asar="$(target_asar_path)"

  [[ -f "$payload_path" && -f "$final_asar" ]] || return 1
  /usr/bin/cmp -s "$payload_path" "$final_asar"
}

pending_update_valid() {
  local marker_target=""
  local marker_mode=""
  local marker_installation_id=""
  local marker_app_path=""
  local marker_nested_target=""
  local marker_time=""
  local now=""
  local age=""

  if [[ ! -f "$pending_path" ]]; then
    log "Guard skipped; no updater pending marker"
    /usr/bin/printf '{\n  "pending": false\n}\n' > "$pending_path" 2>/dev/null || true
    return 1
  fi

  if ! json_bool_true pending "$pending_path"; then
    log "Guard skipped; pending marker is inactive"
    return 1
  fi

  marker_target="$(json_string_value targetAppPath "$pending_path" || true)"
  marker_mode="$(json_string_value mode "$pending_path" || true)"

  if [[ -n "$marker_target" && "$marker_target" != "$target_app_path" ]]; then
    log "Guard skipped; pending marker targets $marker_target instead of $target_app_path"
    /usr/bin/printf '{\n  "pending": false\n}\n' > "$pending_path" 2>/dev/null || true
    return 1
  fi

  if [[ "$bd_expected" = "1" ]]; then
    if ! json_bool_true betterDiscordExpected "$pending_path"; then
      log "Guard skipped; pending marker does not expect BetterDiscord"
      /usr/bin/printf '{\n  "pending": false\n}\n' > "$pending_path" 2>/dev/null || true
      return 1
    fi

    marker_installation_id="$(json_string_value installationId "$pending_path" || true)"
    marker_app_path="$(json_string_value appPath "$pending_path" || true)"
    marker_nested_target="$(json_string_value nestedTarget "$pending_path" || true)"
    if [[ "$marker_installation_id" != "$bd_installation_id" || "$marker_app_path" != "$target_app_path" || "$marker_nested_target" != "$bd_nested_target" ]]; then
      log "Guard skipped; BetterDiscord pending identity mismatch expectedInstallationId=$bd_installation_id actualInstallationId=\${marker_installation_id:-missing}"
      /usr/bin/printf '{\n  "pending": false\n}\n' > "$pending_path" 2>/dev/null || true
      return 1
    fi

    log "Guard matched BetterDiscord pending handoff installationId=$bd_installation_id nestedTarget=$bd_nested_target"
  fi

  marker_time="$(/usr/bin/stat -f %m "$pending_path" 2>/dev/null || true)"
  now="$(/bin/date +%s 2>/dev/null || true)"
  if [[ -n "$marker_time" && -n "$now" ]]; then
    age="$((now - marker_time))"
    if (( age > 300 )); then
      log "Guard skipped; pending marker is stale (\${age}s old)"
      /usr/bin/printf '{\n  "pending": false\n}\n' > "$pending_path" 2>/dev/null || true
      return 1
    fi
  fi

  log "Guard accepted updater pending marker; mode=\${marker_mode:-unknown} target=\${marker_target:-unknown}"
  return 0
}

clear_pending_update_marker() {
  [[ -n "$pending_path" ]] || return 0
  /usr/bin/printf '{\n  "pending": false\n}\n' > "$pending_path" 2>/dev/null || true
}

exit_if_bd_recovery_disabled() {
  [[ "$bd_expected" = "1" && -n "$bd_disabled_path" && -e "$bd_disabled_path" ]] || return 0
  log "BetterDiscord recovery is disabled; cancelling OpenAsar handoff without killing, copying, or relaunching Discord"
  clear_pending_update_marker
  /bin/rm -f "$payload_path" 2>> "$log_path" || true
  exit 0
}

wait_for_legacy_host_replacement() {
  local final_asar="$(target_asar_path)"
  local deadline="$((SECONDS + 180))"
  local target_version=""
  local seen_stock=0

  while (( SECONDS < deadline )); do
    exit_if_bd_recovery_disabled
    if [[ "$bd_expected" = "1" ]] && bd_ready_marker_valid; then
      seen_stock=1
      log "Legacy migration observed BetterDiscord wrapper-ready marker"
      break
    fi

    if [[ -f "$final_asar" ]] && ! payload_matches_target; then
      seen_stock=1
      break
    fi

    sleep 0.5
  done

  if [[ "$seen_stock" != "1" ]]; then
    log "Legacy host replacement was not observed before timeout; attempting final patch anyway"
  fi

  if [[ -f "$target_app_path/Contents/Resources/build_info.json" ]]; then
    target_version="$(json_string_value version "$target_app_path/Contents/Resources/build_info.json" || true)"
    [[ -n "$target_version" ]] && log "Legacy target app version before patch: $target_version"
  fi
}

wait_for_guard_replacement() {
  local final_asar="$(target_asar_path)"
  local wait_seconds=30
  [[ "$bd_expected" = "1" ]] && wait_seconds=180
  local deadline="$((SECONDS + wait_seconds))"
  local target_version=""

  if [[ -f "$target_app_path/Contents/Resources/build_info.json" ]]; then
    target_version="$(json_string_value version "$target_app_path/Contents/Resources/build_info.json" || true)"
    [[ -n "$target_version" ]] && log "Guard target app version at arm time: $target_version"
  fi

  if [[ -f "$final_asar" ]] && ! payload_matches_target; then
    log "Guard found target OpenAsar location already differs from staged payload"
    return 0
  fi

  log "Guard armed; watching for target OpenAsar location replacement"
  while (( SECONDS < deadline )); do
    exit_if_bd_recovery_disabled
    if [[ "$bd_expected" = "1" ]] && bd_ready_marker_valid; then
      log "Guard detected BetterDiscord wrapper-ready marker"
      return 0
    fi

    if [[ -f "$final_asar" ]] && ! payload_matches_target; then
      wait_for_stable_asar "$final_asar" || return 1
      if ! payload_matches_target; then
        log "Guard detected target OpenAsar location replacement"
        return 0
      fi
    fi

    sleep 0.5
  done

  log "Guard saw no OpenAsar target replacement before timeout; exiting without patch"
  return 1
}

host_payload_available_for_handoff() {
  if [[ "$bd_expected" = "1" ]]; then
    [[ -f "$target_app_path/Contents/Resources/app.asar" || -f "$bd_nested_target" || -f "$target_app_path/Contents/Resources/app/.betterdiscord-inject.json" ]]
  else
    [[ -f "$target_app_path/Contents/Resources/app.asar" ]]
  fi
}

app_executable_path() {
  local info_plist="$target_app_path/Contents/Info.plist"
  local executable_name
  local app_name

  executable_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$info_plist" 2>/dev/null || true)"
  if [[ -z "$executable_name" ]]; then
    app_name="$(/usr/bin/basename "$target_app_path" .app 2>/dev/null || true)"
    executable_name="$app_name"
  fi

  [[ -n "$executable_name" ]] || return 1
  print -r -- "$target_app_path/Contents/MacOS/$executable_name"
}

wait_for_app_bundle_ready() {
  local deadline="$((SECONDS + 20))"
  local executable_path=""

  while (( SECONDS < deadline )); do
    executable_path="$(app_executable_path || true)"
    if [[ -d "$target_app_path" && -f "$target_app_path/Contents/Info.plist" && -n "$executable_path" && -x "$executable_path" ]]; then
      return 0
    fi

    sleep 0.5
  done

  log "Final app bundle executable was not ready at $executable_path"
  return 1
}

refresh_target_launch_services_registration() {
  local lsregister="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

  [[ -d "$target_app_path" ]] || return 0
  [[ -x "$lsregister" ]] || return 0
  "$lsregister" -f "$target_app_path" >/dev/null 2>&1 || true
}

relaunch_target() {
  local attempt
  local open_output
  local executable_path

  exit_if_bd_recovery_disabled
  wait_for_app_bundle_ready || return 1

  for attempt in 1 2 3; do
    exit_if_bd_recovery_disabled
    refresh_target_launch_services_registration
    if open_output="$(/usr/bin/open "$target_app_path" 2>&1)"; then
      log "Relaunched Discord $target_app_path"
      return 0
    fi

    if [[ -n "$open_output" ]]; then
      log "open attempt $attempt failed for $target_app_path: $open_output"
    else
      log "open attempt $attempt failed for $target_app_path"
    fi
    sleep 1
  done

  executable_path="$(app_executable_path || true)"
  if [[ -n "$executable_path" && -x "$executable_path" ]]; then
    log "Falling back to direct executable launch $executable_path"
    "$executable_path" >/dev/null 2>&1 &!
    return 0
  fi

  log "Failed to relaunch Discord $target_app_path"
  return 1
}

log "Post-ShipIt helper started; mode=$mode reason=$reason staged=$staged_app_path target=$target_app_path betterDiscordExpected=$bd_expected installationId=\${bd_installation_id:-none}"
exit_if_bd_recovery_disabled

if [[ "$mode" != "shipit" && -z "$target_app_path" ]]; then
  log "Unable to determine target Discord.app path"
  exit 1
fi

if [[ "$mode" = "legacy" ]]; then
  wait_for_legacy_host_replacement
elif [[ "$mode" = "guard" ]]; then
  pending_update_valid || exit 0
  if ! wait_for_guard_replacement; then
    clear_pending_update_marker
    exit 0
  fi
else
  deadline="$((SECONDS + 120))"
  no_shipit_deadline="$((SECONDS + 5))"
  while (( SECONDS < deadline )); do
    exit_if_bd_recovery_disabled
    refresh_shipit_state || true

    if shipit_running; then
      saw_shipit=1
    elif [[ "$saw_shipit" = "1" && -n "$target_app_path" ]] && host_payload_available_for_handoff; then
      break
    elif (( SECONDS >= no_shipit_deadline )) && [[ -n "$target_app_path" ]] && host_payload_available_for_handoff; then
      log "ShipIt did not appear during startup grace; patching target directly"
      break
    fi

    sleep 0.25
  done

  if [[ "$saw_shipit" != "1" ]]; then
    log "ShipIt did not appear before timeout; attempting final patch anyway"
  fi
fi

if [[ -z "$target_app_path" ]]; then
  log "Unable to determine target Discord.app path"
  exit 1
fi

exit_if_bd_recovery_disabled
kill_discord_from_target TERM
sleep 1.5
exit_if_bd_recovery_disabled
kill_discord_from_target KILL

exit_if_bd_recovery_disabled
if ! copy_openasar_into_target; then
  log "OpenAsar restoration failed; attempting to relaunch the valid Discord target"
  relaunch_target || true
  clear_pending_update_marker
  exit 1
fi
exit_if_bd_recovery_disabled
relaunch_target
/bin/rm -f "$payload_path" 2>> "$log_path" || true
clear_pending_update_marker

log "Post-ShipIt helper complete"
`;

const getCurrentArch = () => {
  if (process.platform === 'win32') {
    return ['AMD64', 'IA64'].includes(process.env.PROCESSOR_ARCHITEW6432 ?? process.env.PROCESSOR_ARCHITECTURE) ? 'x64' : 'x86';
  }

  if (process.platform === 'darwin') {
    return execSync('uname -m').toString().trim() === 'arm64' ? 'arm64' : 'x64';
  }

  // linux (discord only support it anyway)
  return 'x64';
};

const getPlatform = () => {
  switch (process.platform) {
    case 'darwin': return 'osx';
    case 'win32': return 'win';
    default: return process.platform;
  }
};

module.exports = {
  Updater,
  TASK_STATE_COMPLETE,
  TASK_STATE_FAILED,
  TASK_STATE_WAITING,
  TASK_STATE_WORKING,

  INCONSISTENT_INSTALLER_STATE_ERROR: 'InconsistentInstallerState',

  tryInitUpdater: (buildInfo, repository_url, use_rust_bspatch) => {
    const root_path = paths.getRootPath();
    if (root_path == null || !fs.existsSync(updaterPath)) return false;

    const opts = {
      release_channel: buildInfo.releaseChannel,
      platform: getPlatform(),
      repository_url,
      root_path,
      user_data_path: paths.getUserData(),
      current_os_arch: getCurrentArch(),
      use_rust_bspatch: use_rust_bspatch === true
    };

    instance = new Updater(opts);
    currentVersion = buildInfo.version;
    return instance.valid;
  },

  getUpdater: () => (instance != null && instance.valid && instance) || null,
  prepareMacOSPostHostUpdateHelper,
  prepareMacOSLegacyUpdaterGuard
};
