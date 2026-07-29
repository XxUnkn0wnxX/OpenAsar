const VERSION_LOCK_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHORTHAND_VERSION_PATTERN = /^(0|[1-9]\d*)$/;
const VERSION_LOCK_DIALOG_TITLE = 'OpenAsar';

const unlockedVersionLock = () => ({
  locked: false,
  lockVersion: null,
  mode: null,
  error: null
});

const buildVersionLockError = (code, message, details = {}) => ({
  locked: false,
  lockVersion: null,
  mode: null,
  error: { code, message, ...details }
});

const isVersionLockRequested = value => value !== undefined && value !== false && value !== '';

const parseVersionLockValue = (value) => {
  if (!isVersionLockRequested(value)) return unlockedVersionLock();

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return buildVersionLockError('invalid-type', 'openasar.VersionLock number values must be a safe non-negative integer.');
    return {
      locked: true,
      lockVersion: `0.0.${value}`,
      mode: null,
      error: null
    };
  }

  if (typeof value === 'string') {
    if (SHORTHAND_VERSION_PATTERN.test(value)) {
      return {
        locked: true,
        lockVersion: `0.0.${value}`,
        mode: null,
        error: null
      };
    }

    if (VERSION_LOCK_PATTERN.test(value)) {
      return {
        locked: true,
        lockVersion: value,
        mode: null,
        error: null
      };
    }
  }

  return buildVersionLockError(
    'invalid-format',
    'openasar.VersionLock must be "", false, a safe absolute version (for example 0.0.402), or a safe numeric shorthand (for example 402).'
  );
};

const validateVersionLock = ({ value, runningVersion, forceLegacyUpdater, useNewUpdater }) => {
  const parsed = parseVersionLockValue(value);

  if (parsed.error) return parsed;
  if (!parsed.locked) return parsed;

  const mode = forceLegacyUpdater === true ? 'legacy' : 'new';
  if (mode === 'legacy' && useNewUpdater === true) {
    return buildVersionLockError(
      'new-updater-active',
      'VersionLock is active and forceLegacyUpdater is true, but USE_NEW_UPDATER is currently true.',
      { expectedMode: 'legacy' }
    );
  }
  if (mode === 'new' && useNewUpdater !== true) {
    return buildVersionLockError(
      'new-updater-required',
      'VersionLock is active and forceLegacyUpdater is false, but the new updater is not available.',
      { expectedMode: 'new' }
    );
  }
  if (parsed.lockVersion !== runningVersion) {
    return buildVersionLockError(
      'version-mismatch',
      'openasar.VersionLock must match the running Discord binary version.',
      { expected: parsed.lockVersion, runningVersion, expectedMode: mode }
    );
  }

  return {
    ...parsed,
    mode
  };
};

const buildVersionMismatchMessage = ({ runningVersion, expected }) => [
  'The Discord binary version differs from the configured VersionLock.',
  '',
  `Discord binary version: ${runningVersion}`,
  `VersionLock: ${expected}`
].join('\n');

exports.VERSION_LOCK_PATTERN = VERSION_LOCK_PATTERN;
exports.SHORTHAND_VERSION_PATTERN = SHORTHAND_VERSION_PATTERN;
exports.VERSION_LOCK_DIALOG_TITLE = VERSION_LOCK_DIALOG_TITLE;
exports.LEGACY_VERSION_LOCK_DIALOG_TITLE = VERSION_LOCK_DIALOG_TITLE;
exports.isVersionLockRequested = isVersionLockRequested;
exports.parseVersionLockValue = parseVersionLockValue;
exports.validateVersionLock = validateVersionLock;
exports.buildVersionMismatchMessage = buildVersionMismatchMessage;
exports.buildLegacyVersionMismatchMessage = buildVersionMismatchMessage;
