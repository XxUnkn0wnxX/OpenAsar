const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const checkoutRoot = path.resolve(__dirname, '..');
const packSource = path.join(checkoutRoot, 'scripts', 'pack.js');
const resolverSource = path.join(checkoutRoot, 'scripts', 'updateRepo.js');
const asarUpdateFixture = `module.exports = require('./updater');\n`;
const packageFixture = JSON.stringify({ name: 'openasar-test-fixture' });
const indexFixture = `
global.oaVersion = 'nightly';
global.oaDisableAutoUpdate = '<disableAutoUpdate>' === 'true';
global.oaUpdateRepo = '<updateRepo>';
global.oaUpdateChannel = '<updateChannel>';
`;

const makeFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openasar-pack-test-'));
  const scripts = path.join(root, 'scripts');
  const src = path.join(root, 'src');
  const updater = path.join(src, 'updater');
  const bin = path.join(root, 'bin');

  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(updater, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(packSource, path.join(scripts, 'pack.js'));
  fs.copyFileSync(resolverSource, path.join(scripts, 'updateRepo.js'));
  fs.writeFileSync(path.join(src, 'index.js'), indexFixture);
  fs.writeFileSync(path.join(src, 'package.json'), packageFixture);
  fs.writeFileSync(path.join(updater, 'updater.js'), asarUpdateFixture);

  const asarScript = path.join(bin, 'asar.js');
  fs.writeFileSync(asarScript, `
const fs = require('node:fs');
const path = require('node:path');
const [command, source, output] = process.argv.slice(2);
if (command !== 'pack' || !source || !output) process.exit(2);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, fs.readFileSync(path.join(source, 'index.js')));
`);

  const asar = path.join(bin, 'asar');
  fs.writeFileSync(asar, `#!/usr/bin/env node\nrequire(${JSON.stringify(asarScript)});\n`);
  fs.chmodSync(asar, 0o755);
  fs.writeFileSync(path.join(bin, 'asar.cmd'), `@echo off\r\nnode "%~dp0asar.js" %*\r\n`);

  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });

  return { root, bin };
};

const runPackScenario = ({ env: scenarioEnv, expectedChannel, expectedRepository, expectedSource, cliArgs = [] }) => {
  const fixture = makeFixture();
  const output = path.join(fixture.root, 'out', 'app.asar');
  const env = { ...process.env };
  delete env.OPENASAR_UPDATE_REPO;
  delete env.GITHUB_ACTIONS;
  delete env.GITHUB_REPOSITORY;
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = `${fixture.bin}${path.delimiter}${env[pathKey] ?? ''}`;
  Object.assign(env, scenarioEnv);

  try {
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:LocalFork/OpenAsar.git'], {
      cwd: fixture.root,
      stdio: 'ignore'
    });

    const stdout = execFileSync(
      process.execPath,
      [path.join(fixture.root, 'scripts', 'pack.js'), ...cliArgs, '--version', 'nightly-test', '--output', output],
      { cwd: fixture.root, encoding: 'utf8', env }
    );
    const stampedIndex = fs.readFileSync(path.join(fixture.root, 'tmp', 'pack-build', 'src', 'index.js'), 'utf8');
    const packedOutput = fs.readFileSync(output, 'utf8');
    const expectedRepositoryAssignment = `global.oaUpdateRepo='${expectedRepository}'`;
    const expectedChannelAssignment = `global.oaUpdateChannel='${expectedChannel}'`;

    assert.match(stdout, new RegExp(`Resolved update repository ${expectedRepository} \\(source: ${expectedSource}, channel: ${expectedChannel}\\)`));
    assert.match(stampedIndex, new RegExp(expectedRepositoryAssignment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(stampedIndex, new RegExp(expectedChannelAssignment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(packedOutput, new RegExp(expectedRepositoryAssignment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(packedOutput, new RegExp(expectedChannelAssignment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(stampedIndex, /global\.oaDisableAutoUpdate='false'==='true'/);
    assert.match(packedOutput, /global\.oaDisableAutoUpdate='false'==='true'/);
    assert.doesNotMatch(stampedIndex, /<(?:updateRepo|updateChannel|disableAutoUpdate)>/);
    assert.doesNotMatch(packedOutput, /<(?:updateRepo|updateChannel|disableAutoUpdate)>/);
    assert.equal(fs.existsSync(output), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
};

test('pack.js resolves and stamps every repository precedence layer in an isolated sandbox', () => {
  const beforeStatus = execFileSync('git', ['status', '--short'], {
    cwd: checkoutRoot,
    encoding: 'utf8'
  });

  try {
    runPackScenario({
      expectedChannel: 'nightly-fork',
      expectedRepository: 'LocalFork/OpenAsar',
      expectedSource: 'origin'
    });
    runPackScenario({
      env: {
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'ActionsFork/OpenAsar'
      },
      expectedChannel: 'nightly-fork',
      expectedRepository: 'ActionsFork/OpenAsar',
      expectedSource: 'actions'
    });
    runPackScenario({
      env: {
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'ActionsFork/OpenAsar',
        OPENASAR_UPDATE_REPO: 'EnvFork/OpenAsar'
      },
      expectedChannel: 'nightly-fork',
      expectedRepository: 'EnvFork/OpenAsar',
      expectedSource: 'env'
    });
    runPackScenario({
      cliArgs: ['--update-repo', 'GooseMod/OpenAsar'],
      env: {
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'ActionsFork/OpenAsar',
        OPENASAR_UPDATE_REPO: 'EnvFork/OpenAsar'
      },
      expectedChannel: 'nightly',
      expectedRepository: 'GooseMod/OpenAsar',
      expectedSource: 'cli'
    });
  } finally {
    assert.equal(execFileSync('git', ['status', '--short'], {
      cwd: checkoutRoot,
      encoding: 'utf8'
    }), beforeStatus);
  }
});
