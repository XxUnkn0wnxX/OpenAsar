class NativeVersionLockError extends Error {
  constructor(code, message, details = {}, cause) {
    super(message);
    this.name = 'NativeVersionLockError';
    this.code = code;
    Object.assign(this, details);
    if (cause !== undefined) this.cause = cause;
  }
}

const configureNativeVersionLock = async ({
  instance,
  lock,
  resolvePinnedManifest,
  manifestOptions,
  logEvent = () => {}
}) => {
  if (instance == null) {
    throw new NativeVersionLockError(
      'native-updater-unavailable',
      'The new Discord updater could not be initialized.'
    );
  }

  if (!lock.locked) {
    try {
      instance.clearPinnedManifestSync();
      logEvent('pin-cleared', { updaterMode: 'new' });
      return { locked: false, manifest: null, source: null };
    } catch (cause) {
      throw new NativeVersionLockError(
        'pin-clear-failed',
        'The saved native updater version pin could not be cleared.',
        {},
        cause
      );
    }
  }

  let resolved;
  try {
    resolved = await resolvePinnedManifest(manifestOptions);
  } catch (cause) {
    if (cause?.code) throw cause;
    throw new NativeVersionLockError(
      'manifest-resolution-failed',
      'The exact pinned update manifest could not be prepared.',
      { targetVersion: lock.lockVersion },
      cause
    );
  }
  if (resolved?.error || resolved?.manifest == null) {
    const failure = resolved?.error;
    throw new NativeVersionLockError(
      failure?.code || 'manifest-resolution-failed',
      failure?.message || 'The exact pinned update manifest could not be prepared.',
      {
        targetVersion: lock.lockVersion,
        manifestSource: resolved?.source,
        manifestPath: resolved?.manifestPath,
        details: failure?.details
      }
    );
  }

  try {
    instance.setPinnedManifestSync(resolved.manifest);
  } catch (cause) {
    throw new NativeVersionLockError(
      'pin-set-failed',
      'Discord rejected the exact pinned update manifest.',
      {
        targetVersion: lock.lockVersion,
        manifestSource: resolved.source
      },
      cause
    );
  }

  logEvent('pin-set', {
    updaterMode: 'new',
    targetVersion: lock.lockVersion,
    manifestSource: resolved.source,
    refreshed: resolved.refreshed === true
  });

  return {
    locked: true,
    manifest: resolved.manifest,
    source: resolved.source,
    refreshed: resolved.refreshed === true
  };
};

module.exports = {
  NativeVersionLockError,
  configureNativeVersionLock
};
