const { spawn, execSync } = require('child_process');
const { app } = require('electron');
const fs = require('fs');
const Module = require('module');
const { join, resolve, basename } = require('path');
const { hrtime } = require('process');

const paths = require('../paths');

let instance;
let currentVersion;
const TASK_STATE_COMPLETE = 'Complete';
const TASK_STATE_FAILED = 'Failed';
const TASK_STATE_WAITING = 'Waiting';
const TASK_STATE_WORKING = 'Working';

const updaterPath = process.platform === 'darwin' ? join(process.execPath, '..', '..', 'Resources', 'updater.node') : join(process.execPath, '..', 'updater.node');
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
    const parts = process.execPath.split('/');

    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].endsWith('.app')) return parts.slice(0, i + 1).join('/');
    }

    return null;
  }

  _prepareMacOSPostShipItHelper(next) {
    const ofs = require('original-fs');
    const userData = paths.getUserData();
    const bootstrapDir = join(userData, 'openasar-bootstrap');
    const helperPath = join(bootstrapDir, 'post-shipit-helper.zsh');
    const payloadPath = join(bootstrapDir, 'app.asar');
    const statePath = join(bootstrapDir, 'post-shipit-state.json');
    const logPath = join(bootstrapDir, 'post-shipit-helper.log');
    const consoleLogPath = join(bootstrapDir, 'post-shipit-console.log');
    const pidPath = join(bootstrapDir, 'post-shipit-helper.pid');
    const targetAppPath = this._getCurrentMacOSAppPath();
    const currentAsar = join(require.main.filename, '..');

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
    for (const file of [ logPath, consoleLogPath, pidPath ]) {
      try {
        ofs.writeFileSync(file, '');
      } catch (_) {}
    }

    ofs.copyFileSync(currentAsar, payloadPath);

    ofs.writeFileSync(helperPath, MACOS_POST_SHIPIT_HELPER);
    ofs.writeFileSync(statePath, JSON.stringify({
      bootstrapDir,
      payloadPath,
      requestPath: join(userData, 'ShipIt_request.json'),
      stagedAppPath: next,
      targetAppPath,
      helperPath,
      logPath,
      consoleLogPath,
      pidPath
    }));
    ofs.chmodSync(helperPath, 0o755);

    const child = spawn('/usr/bin/env', [
      'zsh',
      helperPath,
      payloadPath,
      join(userData, 'ShipIt_request.json'),
      next,
      targetAppPath ?? '',
      logPath,
      consoleLogPath,
      pidPath
    ], {
      detached: true,
      stdio: 'ignore'
    });

    child.unref();
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

      const cAsar = join(require.main.filename, '..');
      const nAsar = isMacOS ? null : join(next, '..', 'resources', 'app.asar');

      if (isMacOS) {
        try {
          this._prepareMacOSPostShipItHelper(next);
        } catch (e) {
          log('Updater', 'Failed to prepare post-ShipIt OpenAsar retention', e);
        }
        this._updateMacOSHostVersion(next);
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

const MACOS_POST_SHIPIT_HELPER = `#!/usr/bin/env zsh
set -u

payload_path="$1"
request_path="$2"
staged_app_path="$3"
target_app_path="$4"
log_path="$5"
console_log_path="$6"
pid_path="$7"
bundle_id=""
saw_shipit=0

/bin/mkdir -p "$(/usr/bin/dirname "$pid_path")" 2>/dev/null || true
print -r -- "$$" > "$pid_path" 2>/dev/null || true
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

file_url_to_path() {
  local value="$1"

  [[ -n "$value" ]] || return 1
  value="\${value#file://}"
  value="$(print -r -- "$value" | /usr/bin/perl -pe 's/%([0-9A-Fa-f]{2})/chr(hex($1))/eg')"
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

copy_openasar_into_target() {
  local final_asar="$target_app_path/Contents/Resources/app.asar"

  wait_for_stable_asar "$final_asar" || {
    log "Final app.asar never became available at $final_asar"
    return 1
  }

  if [[ "$saw_shipit" = "1" || ! -f "$final_asar.backup" ]]; then
    /bin/cp -f "$final_asar" "$final_asar.backup" 2>> "$log_path" || log "Failed to back up final stock app.asar"
  else
    log "Preserved existing app.asar.backup during direct patch"
  fi

  /bin/cp -f "$payload_path" "$final_asar" 2>> "$log_path" || {
    log "Failed to copy OpenAsar payload into $final_asar"
    return 1
  }

  log "Restored OpenAsar into final app $final_asar"
}

relaunch_target() {
  /usr/bin/open "$target_app_path" 2>> "$log_path" && log "Relaunched Discord $target_app_path" || log "Failed to relaunch Discord $target_app_path"
}

log "Post-ShipIt helper started; staged=$staged_app_path target=$target_app_path"

deadline="$((SECONDS + 120))"
no_shipit_deadline="$((SECONDS + 5))"
while (( SECONDS < deadline )); do
  refresh_shipit_state || true

  if shipit_running; then
    saw_shipit=1
  elif [[ "$saw_shipit" = "1" && -n "$target_app_path" && -f "$target_app_path/Contents/Resources/app.asar" ]]; then
    break
  elif (( SECONDS >= no_shipit_deadline )) && [[ -n "$target_app_path" && -f "$target_app_path/Contents/Resources/app.asar" ]]; then
    log "ShipIt did not appear during startup grace; patching target directly"
    break
  fi

  sleep 0.25
done

if [[ "$saw_shipit" != "1" ]]; then
  log "ShipIt did not appear before timeout; attempting final patch anyway"
fi

if [[ -z "$target_app_path" ]]; then
  log "Unable to determine target Discord.app path"
  exit 1
fi

kill_discord_from_target TERM
sleep 1.5
kill_discord_from_target KILL

copy_openasar_into_target || exit 1
relaunch_target
/bin/rm -f "$payload_path" 2>> "$log_path" || true

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

  getUpdater: () => (instance != null && instance.valid && instance) || null
};
