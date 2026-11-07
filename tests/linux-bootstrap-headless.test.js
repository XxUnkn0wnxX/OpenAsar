const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, describe, test } = require('node:test');
const { spawnSync } = require('node:child_process');

const helper = path.join(__dirname, '..', 'scripts', 'linux-bootstrap.sh');

describe('Linux Discord bootstrap headless option', () => {
  let root;
  let bootstrap;
  let installLog;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openasar-linux-bootstrap-'));
    bootstrap = path.join(root, 'updater_bootstrap');
    installLog = path.join(root, 'install-args');
    fs.writeFileSync(bootstrap, [
      '#!/usr/bin/env bash',
      'if [[ $1 == --help ]]; then',
      '  printf "%s\\n" "$HELP_OUTPUT"',
      '  exit "${HELP_STATUS:-0}"',
      'fi',
      'printf "%s\\0" "$@" >> "$INSTALL_LOG"',
      'printf app-1',
      'exit "${INSTALL_STATUS:-0}"',
      ''
    ].join('\n'));
    fs.chmodSync(bootstrap, 0o755);
  });

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  const runHelper = (helpOutput, args = [], options = {}) => spawnSync('bash', [helper, bootstrap, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HELP_OUTPUT: helpOutput,
      INSTALL_LOG: installLog,
      ...options
    }
  });

  const installedArgs = () => fs.readFileSync(installLog).toString().split('\0').slice(0, -1);

  test('uses --no-gui and preserves original arguments including spaces', () => {
    const args = ['/tmp/install root', 'canary', 'https://example.test/update?channel=nightly'];
    const result = runHelper('Options: --no-gui', args);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'app-1');
    assert.deepEqual(installedArgs(), ['--no-gui', ...args]);
  });

  test('falls back to the legacy --no-zenity option', () => {
    const result = runHelper('Options: --no-zenity');

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(installedArgs(), ['--no-zenity']);
  });

  test('prefers --no-gui when both headless options are advertised', () => {
    const result = runHelper('Options: --no-zenity, --no-gui');

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(installedArgs(), ['--no-gui']);
  });

  test('fails without running install when help fails or no headless option exists', () => {
    const helpFailure = runHelper('--no-gui', [], { HELP_STATUS: '9' });
    assert.notEqual(helpFailure.status, 0);
    assert.match(helpFailure.stderr, /Could not read help/);
    assert.equal(fs.existsSync(installLog), false);

    const unsupported = runHelper('Options: --no-gui-extra, --some-other-flag');
    assert.notEqual(unsupported.status, 0);
    assert.match(unsupported.stderr, /no supported headless option/);
    assert.equal(fs.existsSync(installLog), false);
  });

  test('propagates installer failure without retrying', () => {
    const result = runHelper('--no-gui', [], { INSTALL_STATUS: '17' });

    assert.equal(result.status, 17);
    assert.deepEqual(installedArgs(), ['--no-gui']);
  });
});
