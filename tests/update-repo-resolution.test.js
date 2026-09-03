const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  FALLBACK_UPDATE_REPOSITORY,
  FORK_UPDATE_CHANNEL,
  isValidRepository,
  parseGitHubRepository,
  resolveUpdateChannel,
  resolveUpdateRepository
} = require('../scripts/updateRepo');

const origin = value => ({
  env: {},
  readOrigin: () => value
});

describe('GitHub repository validation', () => {
  test('accepts GitHub owner/repository names within the supported limits', () => {
    const owner = `a${'b'.repeat(37)}c`;
    const repository = `a${'b'.repeat(98)}c`;

    assert.equal(isValidRepository('GooseMod/OpenAsar'), true);
    assert.equal(isValidRepository(`${owner}/${repository}`), true);
    assert.equal(isValidRepository(' owner/repository '), true);
    assert.equal(isValidRepository('owner/repo.name_2-with-dashes'), true);
  });

  test('rejects malformed and out-of-range repositories', () => {
    const owner40 = `a${'b'.repeat(38)}c`;
    const repository101 = `a${'b'.repeat(99)}c`;
    const invalid = [
      '',
      'owner',
      'owner/repo/extra',
      '/repo',
      'owner/',
      '-owner/repo',
      'owner-/repo',
      'owner/repo-',
      'owner/.repo',
      'owner/repo.',
      'owner/repo space',
      `${owner40}/repo`,
      `owner/${repository101}`,
      null,
      undefined,
      42
    ];

    for (const repository of invalid) assert.equal(isValidRepository(repository), false, String(repository));
  });
});

describe('GitHub remote parsing', () => {
  test('parses HTTP(S), legacy Git, SSH URL, and scp-style SSH origins', () => {
    const remotes = [
      'https://github.com/GooseMod/OpenAsar.git',
      'http://github.com/GooseMod/OpenAsar/',
      'ssh://git@github.com/GooseMod/OpenAsar.git/',
      'ssh://git@github.com:22/GooseMod/OpenAsar',
      'ssh://git@ssh.github.com:443/GooseMod/OpenAsar.git',
      'git://github.com/GooseMod/OpenAsar.git',
      'git@github.com:GooseMod/OpenAsar.git',
      'git@ssh.github.com:GooseMod/OpenAsar.git',
      'github.com:GooseMod/OpenAsar/'
    ];

    for (const remote of remotes) {
      assert.equal(parseGitHubRepository(remote), 'GooseMod/OpenAsar', remote);
    }
  });

  test('strips one trailing .git and preserves repository names otherwise', () => {
    assert.equal(parseGitHubRepository('git@github.com:Owner/repo.git.git'), 'Owner/repo.git');
    assert.equal(parseGitHubRepository('https://github.com/Owner/repo.name'), 'Owner/repo.name');
  });

  test('rejects non-GitHub and malformed origins', () => {
    const invalid = [
      'https://gitlab.com/GooseMod/OpenAsar.git',
      'https://ssh.github.com/GooseMod/OpenAsar.git',
      'git://ssh.github.com/GooseMod/OpenAsar.git',
      'ftp://github.com/GooseMod/OpenAsar.git',
      'https://github.com/GooseMod/OpenAsar/issues',
      'https://github.com/GooseMod/OpenAsar/extra.git',
      'ssh://git@github.com:GooseMod/OpenAsar.git',
      'git@github.com:GooseMod/OpenAsar extra.git',
      'github.com/GooseMod/OpenAsar.git',
      'github.com:GooseMod',
      'https://github.com//OpenAsar.git',
      'https://github.com/GooseMod/OpenAsar.git?ref=main'
    ];

    for (const remote of invalid) assert.equal(parseGitHubRepository(remote), undefined, remote);
    assert.equal(parseGitHubRepository(undefined), undefined);
  });
});

describe('update repository resolution precedence', () => {
  test('explicit CLI value wins over every other source', () => {
    const result = resolveUpdateRepository({
      cliValue: 'CliOwner/CliRepo',
      env: {
        OPENASAR_UPDATE_REPO: 'EnvOwner/EnvRepo',
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'ActionsOwner/ActionsRepo'
      },
      readOrigin: () => 'git@github.com:OriginOwner/OriginRepo.git'
    });

    assert.deepEqual(result, { repository: 'CliOwner/CliRepo', source: 'cli' });
  });

  test('OPENASAR_UPDATE_REPO wins over Actions and origin', () => {
    const result = resolveUpdateRepository({
      env: {
        OPENASAR_UPDATE_REPO: 'EnvOwner/EnvRepo',
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'ActionsOwner/ActionsRepo'
      },
      readOrigin: () => 'git@github.com:OriginOwner/OriginRepo.git'
    });

    assert.deepEqual(result, { repository: 'EnvOwner/EnvRepo', source: 'env' });
  });

  test('GITHUB_REPOSITORY is used only inside GitHub Actions', () => {
    const actions = resolveUpdateRepository({
      env: {
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'ActionsOwner/ActionsRepo'
      },
      readOrigin: () => 'not a GitHub remote'
    });
    const local = resolveUpdateRepository({
      env: { GITHUB_REPOSITORY: 'ActionsOwner/ActionsRepo' },
      readOrigin: () => 'git@github.com:OriginOwner/OriginRepo.git'
    });

    assert.deepEqual(actions, { repository: 'ActionsOwner/ActionsRepo', source: 'actions' });
    assert.deepEqual(local, { repository: 'OriginOwner/OriginRepo', source: 'origin' });
  });

  test('invalid environment candidates fall through to the next source', () => {
    const actions = resolveUpdateRepository({
      env: {
        OPENASAR_UPDATE_REPO: 'not valid',
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'ActionsOwner/ActionsRepo'
      },
      readOrigin: () => 'git@github.com:OriginOwner/OriginRepo.git'
    });
    const originResult = resolveUpdateRepository({
      env: { OPENASAR_UPDATE_REPO: 'still/not valid?' },
      readOrigin: () => 'git@github.com:OriginOwner/OriginRepo.git'
    });

    assert.deepEqual(actions, { repository: 'ActionsOwner/ActionsRepo', source: 'actions' });
    assert.deepEqual(originResult, { repository: 'OriginOwner/OriginRepo', source: 'origin' });
  });

  test('uses a valid parsed origin and passes the configured repository root to the reader', () => {
    let receivedCwd;
    const result = resolveUpdateRepository({
      cwd: '/checkout/root',
      env: {},
      readOrigin: cwd => {
        receivedCwd = cwd;
        return 'https://github.com/OriginOwner/OriginRepo.git';
      }
    });

    assert.deepEqual(result, { repository: 'OriginOwner/OriginRepo', source: 'origin' });
    assert.equal(receivedCwd, '/checkout/root');
  });

  test('falls back when origin lookup fails or is not a valid GitHub origin', () => {
    const failed = resolveUpdateRepository({ env: {}, readOrigin: () => { throw new Error('no origin'); } });
    const malformed = resolveUpdateRepository({ env: {}, readOrigin: () => 'https://example.com/owner/repo.git' });

    assert.deepEqual(failed, { repository: FALLBACK_UPDATE_REPOSITORY, source: 'fallback' });
    assert.deepEqual(malformed, { repository: FALLBACK_UPDATE_REPOSITORY, source: 'fallback' });
  });

  test('uses the upstream fallback when no source resolves', () => {
    const result = resolveUpdateRepository({ env: {}, readOrigin: () => undefined });
    assert.deepEqual(result, { repository: FALLBACK_UPDATE_REPOSITORY, source: 'fallback' });
  });

  test('throws for an invalid or missing explicit CLI value', () => {
    assert.throws(
      () => resolveUpdateRepository({ cliValue: 'not valid', env: {}, readOrigin: () => 'git@github.com:owner/repo.git' }),
      /^Error: Invalid --update-repo value: not valid$/
    );
    assert.throws(
      () => resolveUpdateRepository({ cliValue: undefined, env: {}, readOrigin: () => 'git@github.com:owner/repo.git' }),
      /^Error: Invalid --update-repo value: $/
    );
  });
});

describe('update channel selection', () => {
  test('uses nightly for the upstream repository case-insensitively', () => {
    assert.equal(resolveUpdateChannel('GooseMod/OpenAsar'), 'nightly');
    assert.equal(resolveUpdateChannel('goosemod/openasar'), 'nightly');
    assert.equal(resolveUpdateChannel(' GooseMod/OpenAsar '), 'nightly');
  });

  test('uses the fork channel for any other repository', () => {
    assert.equal(resolveUpdateChannel('XxUnkn0wnxX/OpenAsar'), FORK_UPDATE_CHANNEL);
    assert.equal(resolveUpdateChannel('another-owner/another-repo'), FORK_UPDATE_CHANNEL);
  });
});
