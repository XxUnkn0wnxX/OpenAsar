const { existsSync, mkdirSync, writeFileSync, appendFileSync } = require('node:fs');
const { join } = require('node:path');

const LOG_SUBDIR = 'openasar-bootstrap';
const LOG_FILE = 'version-lock.log';

const formatRecord = ({ event, ...fields }) => {
  const payload = {
    event,
    timestamp: new Date().toISOString(),
    ...fields
  };

  return `${JSON.stringify(payload)}\n`;
};

const logFailure = (message, error) => {
  if (typeof global.log === 'function') {
    global.log('VersionLock', message, error);
  }
};

const initializeVersionLockLogger = ({
  userData,
  channel,
  runningVersion,
  useNewUpdater,
  forceLegacyUpdater,
  rawVersionLock
}) => {
  const logPath = join(userData, LOG_SUBDIR, LOG_FILE);
  const logger = {
    logPath,
    append: () => {}
  };

  try {
    const launchDir = join(userData, LOG_SUBDIR);
    const hadExistingLog = existsSync(logPath);
    if (!existsSync(launchDir)) mkdirSync(launchDir, { recursive: true });

    const updaterMode = useNewUpdater ? 'new' : 'legacy';
    const launchRecord = formatRecord({
      event: 'launch-start',
      channel,
      platform: process.platform,
      arch: process.arch,
      runningVersion,
      updaterMode,
      forceLegacyUpdater,
      rawVersionLock,
      hadExistingLog
    });

    writeFileSync(logPath, launchRecord, { encoding: 'utf8', mode: 0o600 });

    logger.append = (event, fields = {}) => {
      const entry = formatRecord({ event, ...fields });
      try {
        appendFileSync(logPath, entry, 'utf8');
      } catch (error) {
        logger.append = () => {};
        logFailure('Failed to append version-lock launch event', error);
      }
    };

    return logger;
  } catch (error) {
    logFailure('Failed to initialize version-lock launch logger', error);
    return logger;
  }
};

module.exports = {
  initializeVersionLockLogger
};
