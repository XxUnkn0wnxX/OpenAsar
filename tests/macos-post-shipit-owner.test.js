const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, describe, test } = require('node:test');

const hostPlatform = process.platform;

describe('macOS post-update helper ownership', () => {
  let activeCommand;
  let activePid;
  let helperRunning;
  let killCalls;
  let originalKill;
  let originalLoad;
  let originalPlatform;
  let root;
  let spawnCalls;
  let supersedeOnSpawn;
  let updater;
  let wrapperValid;

  const helperPid = () => path.join(root, 'user-data', 'openasar-bootstrap', 'post-shipit-helper.pid');
  const pendingPath = () => path.join(root, 'user-data', 'openasar-bootstrap', 'post-shipit-update-pending.json');
  const bootstrapPath = name => path.join(root, 'user-data', 'openasar-bootstrap', name);
  const writeJsonAtomically = (file, value) => {
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporary, file);
  };
  const runPreparedHelper = async (timeout = 5000, afterStart = null) => {
    const prepared = spawnCalls.at(-1);
    const child = spawn(prepared.command, prepared.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });

    const pending = JSON.parse(fs.readFileSync(pendingPath(), 'utf8'));
    writeJsonAtomically(pendingPath(), { ...pending, helperPid: child.pid });
    fs.writeFileSync(helperPid(), `${child.pid}\n`);
    afterStart?.({ child, pending });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`OpenAsar helper timed out after ${timeout}ms`));
      }, timeout);
      child.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (status, signal) => {
        clearTimeout(timer);
        const consoleLog = fs.existsSync(bootstrapPath('post-shipit-console.log'))
          ? fs.readFileSync(bootstrapPath('post-shipit-console.log'), 'utf8')
          : '';
        resolve({ status, signal, stderr, consoleLog });
      });
    });
  };

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' });
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openasar-owner-'));
    fs.mkdirSync(path.join(root, 'host-resources'), { recursive: true });
    fs.writeFileSync(path.join(root, 'betterdiscord.app.asar'), 'OpenAsar fixture\n');

    activeCommand = '';
    activePid = 0;
    helperRunning = false;
    killCalls = [];
    spawnCalls = [];
    supersedeOnSpawn = false;
    wrapperValid = true;
    let nextPid = 42000;

    const fakeSpawn = (command, args) => {
      activePid = nextPid++;
      activeCommand = args.join(' ');
      helperRunning = true;
      spawnCalls.push({ command, args, pid: activePid });
      if (supersedeOnSpawn && fs.existsSync(pendingPath())) {
        const pending = JSON.parse(fs.readFileSync(pendingPath(), 'utf8'));
        writeJsonAtomically(pendingPath(), {
          ...pending,
          handoffId: 'newer-handoff',
          sourceProcessPid: process.pid + 1,
        });
      }
      return { pid: activePid, unref() {} };
    };
    const fakeExecSync = command => {
      if (command.startsWith('/bin/ps ')) {
        return helperRunning ? `${activePid} ${activePid} ${activeCommand}\n` : '';
      }
      if (command === '/bin/sleep 0.1') return '';
      if (command === 'uname -m') return 'x86_64\n';
      throw new Error(`Unexpected execSync command: ${command}`);
    };

    const fakePaths = {
      getRootPath: () => root,
      getUserData: () => path.join(root, 'user-data'),
    };
    const fakeInjection = {
      detectBetterDiscordWrapper: () => wrapperValid ? ({
        valid: true,
        marker: { channel: 'stable', installationId: 'test-installation' },
      }) : ({ valid: false, reason: 'standalone test' }),
      getOpenAsarArchivePath: () => path.join(root, 'betterdiscord.app.asar'),
    };

    originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === 'child_process') return { spawn: fakeSpawn, execSync: fakeExecSync };
      if (request === 'electron') return { app: new EventEmitter() };
      if (request === 'original-fs') return fs;
      if (request === '../paths' && parent?.filename.endsWith('/src/updater/updater.js')) return fakePaths;
      if (request === '../injection' && parent?.filename.endsWith('/src/updater/updater.js')) return fakeInjection;
      return originalLoad.call(this, request, parent, isMain);
    };

    originalKill = process.kill;
    process.kill = (pid, signal) => {
      killCalls.push({ pid, signal });
      if (Math.abs(pid) !== activePid) throw new Error(`Refusing unexpected test PID ${pid}`);
      if (signal === 0) {
        if (!helperRunning) throw Object.assign(new Error('not running'), { code: 'ESRCH' });
        return true;
      }
      helperRunning = false;
      return true;
    };

    global.log = () => {};
    global.oaArchivePath = path.join(root, 'betterdiscord.app.asar');
    global.oaHostResourcesPath = path.join(root, 'host-resources');
    const updaterPath = require.resolve('../src/updater/updater');
    delete require.cache[updaterPath];
    updater = require(updaterPath);
  });

  afterEach(() => {
    Module._load = originalLoad;
    process.kill = originalKill;
    Object.defineProperty(process, 'platform', originalPlatform);
    delete global.log;
    delete global.oaArchivePath;
    delete global.oaHostResourcesPath;
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('inactive startup refreshes bootstrap files without leaving a PID', () => {
    const target = path.join(root, 'Discord.app');
    const started = updater.prepareMacOSPostHostUpdateHelper('', target, 'guard', 'startup');

    assert.equal(started, false);
    assert.equal(spawnCalls.length, 0);
    assert.equal(fs.existsSync(helperPid()), false);
    assert.equal(JSON.parse(fs.readFileSync(pendingPath(), 'utf8')).pending, false);
    const helperSource = fs.readFileSync(bootstrapPath('post-shipit-helper.zsh'), 'utf8');
    assert.match(helperSource, /local exit_status="\$1"/);
    assert.doesNotMatch(helperSource, /local status="\$1"/);
    assert.match(helperSource, /helper_script_path="\$0"/);
    assert.match(helperSource, /json_string_value recoveryRunId "\$bd_result_path"/);
    assert.match(helperSource, /json_string_value openAsarHandoffId "\$bd_result_path"/);
    assert.match(helperSource, /json_number_value openAsarSourceProcessPid "\$bd_result_path"/);
    assert.match(helperSource, /result_armed_epoch < openasar_armed_epoch/);
    assert.match(helperSource, /expected_recovery_run_id.*recovery_run_id/);
    assert.match(helperSource, /local deadline="\$\(\(SECONDS \+ 90 \+ 10\)\)"/);
    assert.match(helperSource, /local wait_seconds=90\n  \[\[ "\$bd_expected" = "1" \]\] && wait_seconds="\$\(\(wait_seconds \+ 10\)\)"/);
    assert.match(helperSource, /local wait_seconds=30\n  \[\[ "\$bd_expected" = "1" \]\] && wait_seconds="\$\(\(90 \+ 10\)\)"/);
    assert.match(helperSource, /local wait_seconds=30/);
    const indexSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    assert.match(indexSource, /app\.prependListener\('before-quit'/);
    assert.match(indexSource, /app\.prependListener\('will-quit'/);
    if (hostPlatform === 'darwin') {
      const syntax = spawnSync('/usr/bin/env', ['zsh', '-n', bootstrapPath('post-shipit-helper.zsh')], { encoding: 'utf8' });
      assert.equal(syntax.status, 0, syntax.stderr);
    }
    assert.match(fs.readFileSync(bootstrapPath('post-shipit-helper.log'), 'utf8'), /Skipped OpenAsar helper start/);
  });

  test('a fresh before-quit guard starts a uniquely owned helper', () => {
    const target = path.join(root, 'Discord.app');
    const nestedTarget = path.join(target, 'Contents', 'Resources', 'betterdiscord.app.asar');
    const betterDiscordBootstrap = path.join(root, 'user-data', 'betterdiscord-bootstrap');
    fs.mkdirSync(betterDiscordBootstrap, { recursive: true });
    writeJsonAtomically(path.join(betterDiscordBootstrap, 'update-pending.json'), {
      pending: true,
      sourceProcessPid: process.pid,
      installationId: 'test-installation',
      targetAppPath: target,
      nestedTarget,
      runId: 'test-recovery-run',
    });
    fs.writeFileSync(path.join(betterDiscordBootstrap, 'active-run'), 'test-recovery-run\n');
    assert.equal(updater.prepareMacOSPostHostUpdateHelper('', target, 'guard', 'before-quit'), true);
    assert.equal(spawnCalls.length, 1);

    const pending = JSON.parse(fs.readFileSync(pendingPath(), 'utf8'));
    assert.equal(pending.pending, true);
    assert.equal(pending.mode, 'guard');
    assert.equal(pending.reason, 'before-quit');
    assert.equal(pending.restartRequested, false);
    assert.equal(pending.sourceProcessPid, process.pid);
    assert.equal(pending.betterDiscordRecoveryRunId, 'test-recovery-run');
    assert.equal(typeof pending.armedAt, 'string');
    assert.equal(pending.helperPath, bootstrapPath('post-shipit-helper.zsh'));
    assert.equal(pending.helperPidPath, helperPid());
    assert.equal(typeof pending.handoffId, 'string');
    assert.notEqual(pending.handoffId, '');
    assert.equal(pending.helperPid, spawnCalls[0].pid);
    assert.equal(fs.readFileSync(helperPid(), 'utf8'), `${spawnCalls[0].pid}\n`);
  });

  test('standalone OpenAsar preserves one helper and never downgrades restart intent', () => {
    const target = path.join(root, 'Discord.app');
    const standaloneArchive = path.join(root, 'app.asar');
    fs.writeFileSync(standaloneArchive, 'Standalone OpenAsar fixture\n');
    global.oaArchivePath = standaloneArchive;
    wrapperValid = false;

    assert.equal(updater.prepareMacOSPostHostUpdateHelper('', target, 'legacy', 'update-downloaded'), true);
    const firstPending = JSON.parse(fs.readFileSync(pendingPath(), 'utf8'));
    const firstPid = fs.readFileSync(helperPid(), 'utf8');
    assert.equal(firstPending.betterDiscordExpected, false);
    assert.equal(typeof firstPending.armedAt, 'string');
    assert.equal(firstPending.helperPath, bootstrapPath('post-shipit-helper.zsh'));
    assert.equal(firstPending.helperPidPath, helperPid());

    assert.equal(updater.prepareMacOSPostHostUpdateHelper('', target, 'guard', 'before-quit', true), true);
    assert.equal(updater.prepareMacOSPostHostUpdateHelper('', target, 'guard', 'will-quit', false), true);

    const finalPending = JSON.parse(fs.readFileSync(pendingPath(), 'utf8'));
    assert.equal(spawnCalls.length, 1);
    assert.deepEqual(killCalls, []);
    assert.equal(finalPending.handoffId, firstPending.handoffId);
    assert.equal(finalPending.sourceProcessPid, firstPending.sourceProcessPid);
    assert.equal(finalPending.restartRequested, true);
    assert.equal(fs.readFileSync(helperPid(), 'utf8'), firstPid);
  });

  test('post-spawn publication refuses to overwrite a newer handoff generation', () => {
    const target = path.join(root, 'Discord.app');
    supersedeOnSpawn = true;

    assert.equal(updater.prepareMacOSPostHostUpdateHelper('', target, 'guard', 'before-quit'), false);
    assert.equal(spawnCalls.length, 1);
    assert.deepEqual(killCalls.at(-1), { pid: -spawnCalls[0].pid, signal: 'SIGTERM' });
    const pending = JSON.parse(fs.readFileSync(pendingPath(), 'utf8'));
    assert.equal(pending.handoffId, 'newer-handoff');
    assert.equal(pending.sourceProcessPid, process.pid + 1);
    const state = JSON.parse(fs.readFileSync(bootstrapPath('post-shipit-state.json'), 'utf8'));
    assert.equal(fs.existsSync(state.payloadPath), false);
  });

  test('a superseded helper exits without deleting the newer generation payload', async () => {
    if (hostPlatform !== 'darwin') return;

    const target = path.join(root, 'Discord.app');
    const resources = path.join(target, 'Contents', 'Resources');
    const standaloneArchive = path.join(root, 'app.asar');
    fs.mkdirSync(resources, { recursive: true });
    fs.writeFileSync(standaloneArchive, 'Standalone OpenAsar fixture\n');
    fs.copyFileSync(standaloneArchive, path.join(resources, 'app.asar'));
    global.oaArchivePath = standaloneArchive;
    wrapperValid = false;

    assert.equal(updater.prepareMacOSPostHostUpdateHelper('', target, 'guard', 'before-quit'), true);
    const supersededPayload = JSON.parse(fs.readFileSync(bootstrapPath('post-shipit-state.json'), 'utf8')).payloadPath;
    const newerPayload = bootstrapPath(path.join('recovery-runs', 'newer-handoff', 'app.asar'));
    fs.mkdirSync(path.dirname(newerPayload), { recursive: true });
    fs.writeFileSync(newerPayload, 'newer payload\n');

    const helperRun = await runPreparedHelper(5000, () => {
      setTimeout(() => {
        const current = JSON.parse(fs.readFileSync(pendingPath(), 'utf8'));
        writeJsonAtomically(pendingPath(), {
          ...current,
          handoffId: 'newer-handoff',
          sourceProcessPid: process.pid + 1,
          helperPid: 99999,
        });
        fs.writeFileSync(helperPid(), '99999\n');
      }, 300);
    });

    assert.equal(helperRun.status, 0, `${helperRun.stderr}\n${helperRun.consoleLog}`);
    assert.equal(fs.existsSync(supersededPayload), false);
    assert.equal(fs.readFileSync(newerPayload, 'utf8'), 'newer payload\n');
    assert.equal(JSON.parse(fs.readFileSync(pendingPath(), 'utf8')).handoffId, 'newer-handoff');
    assert.equal(fs.readFileSync(helperPid(), 'utf8'), '99999\n');
    assert.equal(fs.readFileSync(path.join(resources, 'app.asar'), 'utf8'), 'Standalone OpenAsar fixture\n');
  });

  test('a normal standalone quit removes only its unused recovery payload', async () => {
    if (hostPlatform !== 'darwin') return;

    const target = path.join(root, 'Discord.app');
    const resources = path.join(target, 'Contents', 'Resources');
    const standaloneArchive = path.join(root, 'app.asar');
    fs.mkdirSync(resources, { recursive: true });
    fs.writeFileSync(standaloneArchive, 'Standalone OpenAsar fixture\n');
    fs.copyFileSync(standaloneArchive, path.join(resources, 'app.asar'));
    global.oaArchivePath = standaloneArchive;
    wrapperValid = false;

    assert.equal(updater.prepareMacOSPostHostUpdateHelper('', target, 'guard', 'before-quit'), true);
    const state = JSON.parse(fs.readFileSync(bootstrapPath('post-shipit-state.json'), 'utf8'));
    const helperPath = bootstrapPath('post-shipit-helper.zsh');
    fs.writeFileSync(helperPath, fs.readFileSync(helperPath, 'utf8').replace('local wait_seconds=30', 'local wait_seconds=1'));

    const helperRun = await runPreparedHelper(5000);
    assert.equal(helperRun.status, 0, `${helperRun.stderr}\n${helperRun.consoleLog}`);
    assert.equal(fs.existsSync(state.payloadPath), false);
    assert.equal(JSON.parse(fs.readFileSync(pendingPath(), 'utf8')).pending, false);
    assert.equal(fs.readFileSync(path.join(resources, 'app.asar'), 'utf8'), 'Standalone OpenAsar fixture\n');
    assert.doesNotMatch(fs.readFileSync(bootstrapPath('post-shipit-helper.log'), 'utf8'), /Relaunched Discord/);
  });

  test('one live legacy helper owns before-quit, will-quit, and startup', () => {
    const target = path.join(root, 'Discord.app');
    assert.equal(updater.prepareMacOSPostHostUpdateHelper('', target, 'legacy', 'update-downloaded'), true);
    assert.equal(spawnCalls.length, 1);

    const pendingBefore = JSON.parse(fs.readFileSync(pendingPath(), 'utf8'));
    const recordedPid = fs.readFileSync(helperPid(), 'utf8');
    assert.equal(pendingBefore.helperPid, spawnCalls[0].pid);
    assert.equal(recordedPid, `${spawnCalls[0].pid}\n`);

    fs.writeFileSync(bootstrapPath('post-shipit-helper.log'), 'active helper log\n');
    fs.writeFileSync(bootstrapPath('post-shipit-console.log'), 'active console log\n');
    const stateBefore = fs.readFileSync(bootstrapPath('post-shipit-state.json'), 'utf8');
    const payloadPath = JSON.parse(stateBefore).payloadPath;
    const payloadBefore = fs.readFileSync(payloadPath, 'utf8');

    assert.equal(updater.prepareMacOSPostHostUpdateHelper('', target, 'guard', 'startup'), true);
    assert.equal(updater.prepareMacOSPostHostUpdateHelper('', target, 'guard', 'before-quit', true), true);
    assert.equal(updater.prepareMacOSPostHostUpdateHelper('', target, 'guard', 'will-quit', true), true);

    assert.equal(spawnCalls.length, 1);
    assert.deepEqual(killCalls, []);
    assert.equal(fs.readFileSync(helperPid(), 'utf8'), recordedPid);
    const pendingAfter = JSON.parse(fs.readFileSync(pendingPath(), 'utf8'));
    assert.equal(pendingAfter.handoffId, pendingBefore.handoffId);
    assert.equal(pendingAfter.sourceProcessPid, pendingBefore.sourceProcessPid);
    assert.equal(pendingAfter.helperPid, pendingBefore.helperPid);
    assert.equal(pendingAfter.createdAt, pendingBefore.createdAt);
    assert.equal(pendingAfter.restartRequested, true);
    assert.equal(typeof pendingAfter.updatedAt, 'string');

    assert.equal(updater.prepareMacOSPostHostUpdateHelper('', target, 'guard', 'will-quit', false), true);
    assert.equal(JSON.parse(fs.readFileSync(pendingPath(), 'utf8')).restartRequested, true);
    assert.equal(fs.readFileSync(bootstrapPath('post-shipit-helper.log'), 'utf8'), 'active helper log\n');
    assert.equal(fs.readFileSync(bootstrapPath('post-shipit-console.log'), 'utf8'), 'active console log\n');
    assert.equal(fs.readFileSync(payloadPath, 'utf8'), payloadBefore);
    assert.equal(fs.readFileSync(bootstrapPath('post-shipit-state.json'), 'utf8'), stateBefore);
    assert.match(fs.readFileSync(bootstrapPath('post-shipit-arm.log'), 'utf8'), /Preserved live OpenAsar helper/);
  });

  test('a mismatched owner is stopped before a replacement starts', () => {
    const target = path.join(root, 'Discord.app');
    assert.equal(updater.prepareMacOSPostHostUpdateHelper('', target, 'legacy', 'update-downloaded'), true);
    const firstPid = activePid;
    const pending = JSON.parse(fs.readFileSync(pendingPath(), 'utf8'));
    pending.installationId = 'different-installation';
    fs.writeFileSync(pendingPath(), JSON.stringify(pending, null, 2));

    assert.equal(updater.prepareMacOSPostHostUpdateHelper('', target, 'legacy', 'update-downloaded'), true);
    assert.equal(spawnCalls.length, 2);
    assert.deepEqual(killCalls[0], { pid: -firstPid, signal: 'SIGTERM' });
    assert.notEqual(activePid, firstPid);
    assert.equal(fs.readFileSync(helperPid(), 'utf8'), `${activePid}\n`);
  });

  test('a matching BetterDiscord no-update result only relaunches for explicit restart intent', async () => {
    if (hostPlatform !== 'darwin') return;

    const target = path.join(root, 'Discord.app');
    const resources = path.join(target, 'Contents', 'Resources');
    const wrapper = path.join(resources, 'app');
    const nestedTarget = path.join(resources, 'betterdiscord.app.asar');
    const resultPath = path.join(root, 'user-data', 'betterdiscord-bootstrap', 'wrapper-result.json');
    const installationId = 'test-installation';
    const executablePath = path.join(target, 'Contents', 'MacOS', 'Discord');

    fs.mkdirSync(wrapper, { recursive: true });
    fs.mkdirSync(path.dirname(executablePath), { recursive: true });
    fs.writeFileSync(path.join(target, 'Contents', 'Info.plist'), [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Discord</string></dict></plist>',
      ''
    ].join('\n'));
    fs.writeFileSync(executablePath, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(executablePath, 0o755);
    fs.writeFileSync(path.join(wrapper, 'index.js'), '// __betterdiscord_inject_meta__\nmodule.exports = require("../betterdiscord.app.asar");\n');
    fs.writeFileSync(path.join(wrapper, 'package.json'), `${JSON.stringify({ name: 'discord', main: './index.js' })}\n`);
    fs.writeFileSync(path.join(wrapper, '.betterdiscord-inject.json'), `${JSON.stringify({
      schema: 1,
      owner: 'betterdiscord',
      style: 'app-wrapper',
      channel: 'stable',
      mode: 'release',
      loader: 'index.js',
      payload: '../betterdiscord.app.asar',
      bdPath: '/fixture/betterdiscord.asar',
      installationId
    })}\n`);
    fs.copyFileSync(path.join(root, 'betterdiscord.app.asar'), nestedTarget);

    const runNoUpdate = async restartRequested => {
      assert.equal(updater.prepareMacOSPostHostUpdateHelper('', target, 'legacy', 'update-downloaded', restartRequested), true);
      const pending = JSON.parse(fs.readFileSync(pendingPath(), 'utf8'));
      pending.betterDiscordRecoveryRunId = 'test-recovery-run';
      writeJsonAtomically(pendingPath(), pending);
      const preparedPayloadPath = JSON.parse(fs.readFileSync(bootstrapPath('post-shipit-state.json'), 'utf8')).payloadPath;
      const recoveryArmedAt = new Date(Date.parse(pending.armedAt) - 500).toISOString();
      const completedAt = new Date(Date.parse(pending.armedAt) + 1000).toISOString();
      fs.mkdirSync(path.dirname(resultPath), { recursive: true });
      fs.writeFileSync(resultPath, `${JSON.stringify({
        schema: 1,
        owner: 'betterdiscord',
        style: 'app-wrapper',
        channel: 'stable',
        installationId,
        appPath: target,
        targetAppPath: target,
        nestedTarget,
        recoveryRunId: 'test-recovery-run',
        openAsarHandoffId: pending.handoffId,
        openAsarSourceProcessPid: pending.sourceProcessPid,
        armedAt: recoveryArmedAt,
        outcome: 'no-update',
        completedAt
      }, null, 2)}\n`);

      if (restartRequested) {
        const helperPath = bootstrapPath('post-shipit-helper.zsh');
        const installedHelperSource = fs.readFileSync(helperPath, 'utf8');
        const helperSource = installedHelperSource
          .replace('local lsregister="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"', 'local lsregister="/usr/bin/true"')
          .replace('/usr/bin/open "$target_app_path"', '/usr/bin/true "$target_app_path"');
        assert.notEqual(helperSource, installedHelperSource);
        assert.doesNotMatch(helperSource, /System\/Library.*lsregister|\/usr\/bin\/open/);
        fs.writeFileSync(helperPath, helperSource);
      }

      const helperRun = await runPreparedHelper();
      assert.equal(helperRun.status, 0, `${helperRun.stderr}\n${helperRun.consoleLog}`);
      assert.equal(fs.readFileSync(nestedTarget, 'utf8'), 'OpenAsar fixture\n');
      assert.equal(JSON.parse(fs.readFileSync(pendingPath(), 'utf8')).pending, false, helperRun.consoleLog);
      assert.equal(fs.existsSync(helperPid()), false);
      assert.equal(fs.existsSync(preparedPayloadPath), false);
      return fs.readFileSync(bootstrapPath('post-shipit-helper.log'), 'utf8');
    };

    const quietLog = await runNoUpdate(false);
    assert.match(quietLog, /ending handoff without patch or relaunch/);
    assert.doesNotMatch(quietLog, /Sent (TERM|KILL)|Copying OpenAsar|Relaunched Discord|restoration failed/);

    const restartLog = await runNoUpdate(true);
    assert.match(restartLog, /relaunching the existing target/);
    assert.match(restartLog, /Relaunched Discord/);
    assert.doesNotMatch(restartLog, /Sent (TERM|KILL)|Copying OpenAsar|restoration failed/);
  });

  test('a stale BetterDiscord result is rejected and quiet recovery uses the current generation', async () => {
    if (hostPlatform !== 'darwin') return;

    const target = path.join(root, 'Discord.app');
    const resources = path.join(target, 'Contents', 'Resources');
    const wrapper = path.join(resources, 'app');
    const nestedTarget = path.join(resources, 'betterdiscord.app.asar');
    const bootstrapDir = path.join(root, 'user-data', 'betterdiscord-bootstrap');
    const resultPath = path.join(bootstrapDir, 'wrapper-result.json');
    const readyPath = path.join(bootstrapDir, 'wrapper-ready.json');
    const installationId = 'test-installation';

    fs.mkdirSync(wrapper, { recursive: true });
    fs.writeFileSync(path.join(wrapper, 'index.js'), '// __betterdiscord_inject_meta__\nmodule.exports = require("../betterdiscord.app.asar");\n');
    fs.writeFileSync(path.join(wrapper, 'package.json'), `${JSON.stringify({ name: 'discord', main: './index.js' })}\n`);
    fs.writeFileSync(path.join(wrapper, '.betterdiscord-inject.json'), `${JSON.stringify({
      schema: 1,
      owner: 'betterdiscord',
      style: 'app-wrapper',
      channel: 'stable',
      mode: 'release',
      loader: 'index.js',
      payload: '../betterdiscord.app.asar',
      bdPath: '/fixture/betterdiscord.asar',
      installationId
    })}\n`);
    fs.copyFileSync(path.join(root, 'betterdiscord.app.asar'), nestedTarget);

    assert.equal(updater.prepareMacOSPostHostUpdateHelper('', target, 'legacy', 'update-downloaded'), true);
    const pending = JSON.parse(fs.readFileSync(pendingPath(), 'utf8'));
    pending.betterDiscordRecoveryRunId = 'current-recovery-run';
    writeJsonAtomically(pendingPath(), pending);
    const staleArmedAt = new Date(Date.parse(pending.armedAt) - 1000).toISOString();
    const recoveryArmedAt = new Date(Date.parse(pending.armedAt) - 500).toISOString();
    const completedAt = new Date(Date.parse(pending.armedAt) + 1000).toISOString();
    fs.mkdirSync(bootstrapDir, { recursive: true });
    writeJsonAtomically(resultPath, {
      schema: 1,
      owner: 'betterdiscord',
      style: 'app-wrapper',
      channel: 'stable',
      installationId,
      appPath: target,
      targetAppPath: target,
      nestedTarget,
      recoveryRunId: 'stale-recovery-run',
      openAsarHandoffId: pending.handoffId,
      openAsarSourceProcessPid: pending.sourceProcessPid,
      armedAt: staleArmedAt,
      outcome: 'no-update',
      completedAt
    });
    writeJsonAtomically(readyPath, {
      schema: 1,
      owner: 'betterdiscord',
      style: 'app-wrapper',
      channel: 'stable',
      installationId,
      appPath: target,
      targetAppPath: target,
      nestedTarget,
      recoveryRunId: 'current-recovery-run',
      openAsarHandoffId: pending.handoffId,
      openAsarSourceProcessPid: pending.sourceProcessPid,
      armedAt: recoveryArmedAt,
      readyAt: completedAt
    });

    const helperRun = await runPreparedHelper(8000);
    assert.equal(helperRun.status, 0, `${helperRun.stderr}\n${helperRun.consoleLog}`);
    const log = fs.readFileSync(bootstrapPath('post-shipit-helper.log'), 'utf8');
    assert.doesNotMatch(log, /ending handoff without patch or relaunch/);
    assert.match(log, /Legacy migration observed BetterDiscord wrapper-ready marker/, helperRun.consoleLog);
    assert.match(log, /Discord restart was not requested.*leaving Discord closed/);
    assert.doesNotMatch(log, /Relaunched Discord/);
    assert.equal(JSON.parse(fs.readFileSync(pendingPath(), 'utf8')).pending, false);
  });

  test('disagreed PID ownership is replaced instead of reused', () => {
    const target = path.join(root, 'Discord.app');
    assert.equal(updater.prepareMacOSPostHostUpdateHelper('', target, 'legacy', 'update-downloaded'), true);
    const firstPid = activePid;
    fs.writeFileSync(helperPid(), '99999\n');

    assert.equal(updater.prepareMacOSPostHostUpdateHelper('', target, 'legacy', 'update-downloaded'), true);
    assert.equal(spawnCalls.length, 2);
    assert.deepEqual(killCalls[0], { pid: -firstPid, signal: 'SIGTERM' });
    assert.notEqual(activePid, firstPid);
    assert.equal(fs.readFileSync(helperPid(), 'utf8'), `${activePid}\n`);
  });
});
