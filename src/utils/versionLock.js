const VERSION_LOCK_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHORTHAND_VERSION_PATTERN = /^(0|[1-9]\d*)$/;
const LEGACY_VERSION_LOCK_DIALOG_TITLE = 'OpenAsar';

const unlockedVersionLock = () => ({
  locked: false,
  lockVersion: null,
  error: null
});

const buildVersionLockError = (code, message, details = {}) => ({
  locked: false,
  lockVersion: null,
  error: { code, message, ...details }
});

const parseVersionLockValue = (value) => {
  if (value === undefined || value === false || value === '') return unlockedVersionLock();

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return buildVersionLockError('invalid-type', 'openasar.VersionLock number values must be a safe non-negative integer.');
    return {
      locked: true,
      lockVersion: `0.0.${value}`,
      error: null
    };
  }

  if (typeof value === 'string') {
    if (SHORTHAND_VERSION_PATTERN.test(value)) {
      return {
        locked: true,
        lockVersion: `0.0.${value}`,
        error: null
      };
    }

    if (VERSION_LOCK_PATTERN.test(value)) {
      return {
        locked: true,
        lockVersion: value,
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
  if (forceLegacyUpdater !== true) return unlockedVersionLock();

  const parsed = parseVersionLockValue(value);

  if (parsed.error) return parsed;
  if (!parsed.locked) return parsed;
  if (useNewUpdater === true) {
    return buildVersionLockError(
      'new-updater-active',
      'VersionLock is active and forceLegacyUpdater is true, but USE_NEW_UPDATER is currently true.',
      { expectedMode: 'legacy' }
    );
  }
  if (parsed.lockVersion !== runningVersion) {
    return buildVersionLockError(
      'version-mismatch',
      'openasar.VersionLock must match the running build version when legacy lock is active.',
      { expected: parsed.lockVersion, runningVersion }
    );
  }

  return parsed;
};

const buildLegacyVersionMismatchMessage = ({ runningVersion, expected }) => [
  'The Discord binary version differs from the configured VersionLock.',
  '',
  `Discord binary version: ${runningVersion}`,
  `VersionLock: ${expected}`
].join('\n');

exports.VERSION_LOCK_PATTERN = VERSION_LOCK_PATTERN;
exports.SHORTHAND_VERSION_PATTERN = SHORTHAND_VERSION_PATTERN;
exports.LEGACY_VERSION_LOCK_DIALOG_TITLE = LEGACY_VERSION_LOCK_DIALOG_TITLE;
exports.parseVersionLockValue = parseVersionLockValue;
exports.validateVersionLock = validateVersionLock;
exports.buildLegacyVersionMismatchMessage = buildLegacyVersionMismatchMessage;
