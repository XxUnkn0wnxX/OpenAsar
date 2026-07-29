const { execSync } = require('node:child_process');
const os = require('node:os');

const mapPlatform = (platform) => {
  if (platform === 'darwin') return 'osx';
  if (platform === 'win32') return 'win';
  return platform;
};

const getNativeUpdaterPlatform = ({ platform = process.platform, platformMap = mapPlatform } = {}) => platformMap(platform);

const getNativeUpdaterArch = ({
  platform = process.platform,
  env = process.env,
  runUname = (command) => execSync(command).toString().trim()
} = {}) => {
  if (platform === 'win32') {
    const architecture = env.PROCESSOR_ARCHITEW6432 ?? env.PROCESSOR_ARCHITECTURE;
    return (architecture === 'AMD64' || architecture === 'IA64') ? 'x64' : 'x86';
  }

  if (platform === 'darwin') {
    return runUname('uname -m') === 'arm64' ? 'arm64' : 'x64';
  }

  return 'x64';
};

const getNativeUpdaterPlatformVersion = ({
  getSystemVersion = typeof process.getSystemVersion === 'function' ? process.getSystemVersion.bind(process) : null,
  release = os.release
} = {}) => (typeof getSystemVersion === 'function' ? getSystemVersion() : undefined) || release();

exports.getNativeUpdaterPlatform = getNativeUpdaterPlatform;
exports.getNativeUpdaterArch = getNativeUpdaterArch;
exports.getNativeUpdaterPlatformVersion = getNativeUpdaterPlatformVersion;
exports.mapPlatform = mapPlatform;
