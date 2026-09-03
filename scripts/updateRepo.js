const { execFileSync } = require('node:child_process');
const path = require('node:path');

const FALLBACK_UPDATE_REPOSITORY = 'GooseMod/OpenAsar';
const FORK_UPDATE_CHANNEL = 'nightly-fork';
const UPSTREAM_UPDATE_CHANNEL = 'nightly';

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;

const asTrimmedString = value => {
  if (typeof value === 'string') return value.trim();
  if (Buffer.isBuffer(value)) return value.toString('utf8').trim();
  return '';
};

const isValidRepository = repository => {
  const value = asTrimmedString(repository);
  const match = /^([^/]+)\/([^/]+)$/.exec(value);
  if (!match) return false;

  const [, owner, name] = match;
  return (
    owner.length <= 39 &&
    name.length <= 100 &&
    OWNER_PATTERN.test(owner) &&
    REPOSITORY_PATTERN.test(name)
  );
};

const parseGitHubRepository = remote => {
  const value = asTrimmedString(remote);
  if (!value) return undefined;

  let match;

  if (/^(?:https?|ssh|git):\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)) return undefined;

      const hostname = url.hostname.toLowerCase();
      const isGitHubHost = hostname === 'github.com';
      const isGitHubSshOver443Host = hostname === 'ssh.github.com' && url.protocol === 'ssh:';
      if (!isGitHubHost && !isGitHubSshOver443Host) return undefined;
      if (url.search || url.hash) return undefined;

      match = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.pathname);
    } catch {
      return undefined;
    }
  } else {
    match = /^(?:[^@/\s]+@)?(?:github\.com|ssh\.github\.com):([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(value);
  }

  if (!match) return undefined;

  const repository = `${match[1]}/${match[2]}`;
  return isValidRepository(repository) ? repository : undefined;
};

const defaultReadOrigin = cwd => execFileSync(
  'git',
  ['config', '--get', 'remote.origin.url'],
  {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }
);

/**
 * Resolve the repository used by the generated updater.
 *
 * `cliValue` is considered explicit whenever the property is present, which
 * lets pack.js reject `--update-repo` without a value. `readOrigin` receives
 * the repository root and can be replaced by tests without shell parsing.
 */
const resolveUpdateRepository = (options = {}) => {
  const settings = options && typeof options === 'object' ? options : {};
  const env = settings.env ?? process.env;
  const hasCliValue = Object.prototype.hasOwnProperty.call(settings, 'cliValue') || settings.cliProvided === true;
  const cliValue = Object.prototype.hasOwnProperty.call(settings, 'cliValue')
    ? settings.cliValue
    : settings.updateRepo;
  const cwd = settings.cwd ?? path.resolve(__dirname, '..');

  if (hasCliValue) {
    if (!isValidRepository(cliValue)) {
      throw new Error(`Invalid --update-repo value: ${cliValue ?? ''}`);
    }

    return { repository: asTrimmedString(cliValue), source: 'cli' };
  }

  if (isValidRepository(env?.OPENASAR_UPDATE_REPO)) {
    return {
      repository: asTrimmedString(env.OPENASAR_UPDATE_REPO),
      source: 'env'
    };
  }

  if (env?.GITHUB_ACTIONS === 'true' && isValidRepository(env.GITHUB_REPOSITORY)) {
    return {
      repository: asTrimmedString(env.GITHUB_REPOSITORY),
      source: 'actions'
    };
  }

  const readOrigin = typeof settings.readOrigin === 'function'
    ? settings.readOrigin
    : defaultReadOrigin;

  try {
    const originRepository = parseGitHubRepository(readOrigin(cwd));
    if (originRepository) return { repository: originRepository, source: 'origin' };
  } catch {
    // Archives, detached source trees, and checkouts without an origin still build.
  }

  return { repository: FALLBACK_UPDATE_REPOSITORY, source: 'fallback' };
};

const resolveUpdateChannel = repository => (
  asTrimmedString(repository).toLowerCase() === FALLBACK_UPDATE_REPOSITORY.toLowerCase()
    ? UPSTREAM_UPDATE_CHANNEL
    : FORK_UPDATE_CHANNEL
);

module.exports = {
  FALLBACK_UPDATE_REPOSITORY,
  FORK_UPDATE_CHANNEL,
  isValidRepository,
  parseGitHubRepository,
  resolveUpdateRepository,
  resolveUpdateChannel
};
