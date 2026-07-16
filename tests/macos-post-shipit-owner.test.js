const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
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
  let updater;

  const helperPid = () => path.join(root, 'user-data', 'openasar-bootstrap', 'post-shipit-helper.pid');
  const pendingPath = () => path.join(root, 'user-data', 'openasar-bootstrap', 'post-shipit-update-pending.json');
  const bootstrapPath = name => path.join(root, 'user-data', 'openasar-bootstrap', name);

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
    let nextPid = 42000;

    const fakeSpawn = (command, args) => {
      activePid = nextPid++;
      activeCommand = args.join(' ');
      helperRunning = true;
      spawnCalls.push({ command, args, pid: activePid });
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
      detectBetterDiscordWrapper: () => ({
        valid: true,
        marker: { channel: 'stable', installationId: 'test-installation' },
      }),
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
    if (hostPlatform === 'darwin') {
      const syntax = spawnSync('/usr/bin/env', ['zsh', '-n', bootstrapPath('post-shipit-helper.zsh')], { encoding: 'utf8' });
      assert.equal(syntax.status, 0, syntax.stderr);
    }
    assert.match(fs.readFileSync(bootstrapPath('post-shipit-helper.log'), 'utf8'), /Skipped OpenAsar helper start/);
  });

  test('one live legacy helper owns before-quit, will-quit, and startup', () => {
    const target = path.join(root, 'Discord.app');
    assert.equal(updater.prepareMacOSPostHostUpdateHelper('', target, 'legacy', 'update-downloaded'), true);
    assert.equal(spawnCalls.length, 1);

    const pendingBefore = fs.readFileSync(pendingPath(), 'utf8');
    const recordedPid = fs.readFileSync(helperPid(), 'utf8');
    assert.equal(JSON.parse(pendingBefore).helperPid, spawnCalls[0].pid);
    assert.equal(recordedPid, `${spawnCalls[0].pid}\n`);

    fs.writeFileSync(bootstrapPath('post-shipit-helper.log'), 'active helper log\n');
    fs.writeFileSync(bootstrapPath('post-shipit-console.log'), 'active console log\n');
    const payloadBefore = fs.readFileSync(bootstrapPath('app.asar'), 'utf8');
    const stateBefore = fs.readFileSync(bootstrapPath('post-shipit-state.json'), 'utf8');

    for (const reason of ['before-quit', 'will-quit', 'startup']) {
      assert.equal(updater.prepareMacOSPostHostUpdateHelper('', target, 'guard', reason), true);
    }

    assert.equal(spawnCalls.length, 1);
    assert.deepEqual(killCalls, []);
    assert.equal(fs.readFileSync(helperPid(), 'utf8'), recordedPid);
    assert.equal(fs.readFileSync(pendingPath(), 'utf8'), pendingBefore);
    assert.equal(fs.readFileSync(bootstrapPath('post-shipit-helper.log'), 'utf8'), 'active helper log\n');
    assert.equal(fs.readFileSync(bootstrapPath('post-shipit-console.log'), 'utf8'), 'active console log\n');
    assert.equal(fs.readFileSync(bootstrapPath('app.asar'), 'utf8'), payloadBefore);
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

  test('a matching BetterDiscord no-update result ends legacy recovery without relaunch', () => {
    if (hostPlatform !== 'darwin') return;

    const target = path.join(root, 'Discord.app');
    const resources = path.join(target, 'Contents', 'Resources');
    const wrapper = path.join(resources, 'app');
    const nestedTarget = path.join(resources, 'betterdiscord.app.asar');
    const resultPath = path.join(root, 'user-data', 'betterdiscord-bootstrap', 'wrapper-result.json');
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
      armedAt: new Date(Date.parse(pending.armedAt) - 1000).toISOString(),
      outcome: 'no-update',
      completedAt
    }, null, 2)}\n`);

    const helperRun = spawnSync(spawnCalls[0].command, spawnCalls[0].args, {
      encoding: 'utf8',
      timeout: 5000
    });
    assert.equal(helperRun.status, 0, helperRun.stderr);
    assert.equal(fs.readFileSync(nestedTarget, 'utf8'), 'OpenAsar fixture\n');
    assert.equal(JSON.parse(fs.readFileSync(pendingPath(), 'utf8')).pending, false);
    assert.equal(fs.existsSync(helperPid()), false);
    assert.equal(fs.existsSync(bootstrapPath('app.asar')), false);
    const log = fs.readFileSync(bootstrapPath('post-shipit-helper.log'), 'utf8');
    assert.match(log, /ending handoff without patch or relaunch/);
    assert.doesNotMatch(log, /Sent (TERM|KILL)|Copying OpenAsar|Relaunched Discord|restoration failed/);
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
