let fs;
try {
  fs = require('original-fs');
} catch (_) {
  fs = require('fs');
}
const { dirname, join, normalize, resolve } = require('path');

const BETTERDISCORD_MARKER = join('app', '.betterdiscord-inject.json');
const BETTERDISCORD_PAYLOAD = '../betterdiscord.app.asar';
const BETTERDISCORD_CHANNELS = new Set([ 'stable', 'ptb', 'canary' ]);
const BETTERDISCORD_MODES = new Set([ 'release', 'dev' ]);

const getOpenAsarArchivePath = filename => {
  const normal = normalize(filename);
  const match = normal.match(/^(.*?\.asar)(?:[\\/]|$)/i);

  return match?.[1] ?? dirname(normal);
};

const invalidWrapper = (markerPath, reason) => ({
  valid: false,
  markerPath,
  reason
});

const detectBetterDiscordWrapper = (resourcesPath, fileSystem = fs) => {
  const markerPath = join(resourcesPath, BETTERDISCORD_MARKER);
  let marker;

  try {
    marker = JSON.parse(fileSystem.readFileSync(markerPath, 'utf8'));
  } catch (error) {
    return invalidWrapper(markerPath, error?.code === 'ENOENT' ? 'marker-missing' : 'marker-invalid');
  }

  if (marker?.schema !== 1) return invalidWrapper(markerPath, 'schema-mismatch');
  if (marker.owner !== 'betterdiscord') return invalidWrapper(markerPath, 'owner-mismatch');
  if (marker.style !== 'app-wrapper') return invalidWrapper(markerPath, 'style-mismatch');
  if (!BETTERDISCORD_CHANNELS.has(marker.channel)) return invalidWrapper(markerPath, 'channel-invalid');
  if (!BETTERDISCORD_MODES.has(marker.mode)) return invalidWrapper(markerPath, 'mode-invalid');
  if (marker.loader !== 'index.js') return invalidWrapper(markerPath, 'loader-mismatch');
  if (marker.payload !== BETTERDISCORD_PAYLOAD) return invalidWrapper(markerPath, 'payload-mismatch');
  if (typeof marker.bdPath !== 'string' || marker.bdPath.length === 0) return invalidWrapper(markerPath, 'bd-path-invalid');
  if (typeof marker.installationId !== 'string' || marker.installationId.length === 0) return invalidWrapper(markerPath, 'installation-id-invalid');

  const wrapperDir = join(resourcesPath, 'app');
  const nestedTarget = resolve(wrapperDir, marker.payload);

  try {
    const entries = fileSystem.readdirSync(wrapperDir).sort();
    if (entries.join('\0') !== [ '.betterdiscord-inject.json', 'index.js', 'package.json' ].sort().join('\0')) {
      return invalidWrapper(markerPath, 'wrapper-files-unknown');
    }

    const loaderPath = join(wrapperDir, marker.loader);
    const packagePath = join(wrapperDir, 'package.json');
    if (!fileSystem.statSync(loaderPath).isFile()) return invalidWrapper(markerPath, 'loader-missing');
    if (!fileSystem.statSync(packagePath).isFile()) return invalidWrapper(markerPath, 'package-missing');
    if (!fileSystem.statSync(nestedTarget).isFile()) return invalidWrapper(markerPath, 'nested-payload-missing');
    if (fileSystem.existsSync(join(resourcesPath, 'app.asar'))) return invalidWrapper(markerPath, 'top-level-payload-present');

    const loader = fileSystem.readFileSync(loaderPath, 'utf8');
    if (!loader.includes('__betterdiscord_inject_meta__') || !loader.includes('../betterdiscord.app.asar')) {
      return invalidWrapper(markerPath, 'loader-content-mismatch');
    }

    const pkg = JSON.parse(fileSystem.readFileSync(packagePath, 'utf8'));
    if (pkg?.main !== 'index.js' && pkg?.main !== './index.js') return invalidWrapper(markerPath, 'package-main-mismatch');
  } catch (_) {
    return invalidWrapper(markerPath, 'wrapper-files-missing');
  }

  return {
    valid: true,
    marker,
    markerPath,
    nestedTarget,
    wrapperDir
  };
};

module.exports = {
  BETTERDISCORD_MARKER,
  BETTERDISCORD_PAYLOAD,
  detectBetterDiscordWrapper,
  getOpenAsarArchivePath
};
