const { get } = require('https');
const fs = require('original-fs'); // Use original-fs, not Electron's modified fs
const { basename } = require('path');
const { getOpenAsarArchivePath } = require('./injection');

// todo: have these https utils centralised?
const redirs = url => new Promise(res => get(url, r => { // Minimal wrapper around https.get to follow redirects
  const loc = r.headers.location;
  if (loc) return redirs(loc).then(res);

  res(r);
}));

module.exports = async () => { // (Try) update asar
  if (global.oaDisableAutoUpdate) return log('AsarUpdate', 'Skipping build-configured auto-update disable');
  if (!oaVersion.includes('-')) return;
  const releaseChannel = global.oaUpdateChannel && !String(global.oaUpdateChannel).startsWith('<')
    ? global.oaUpdateChannel
    : oaVersion.split('-')[0];
  const updateRepo = global.oaUpdateRepo || 'GooseMod/OpenAsar';

  log('AsarUpdate', 'Updating...');

  const res = (await redirs(`https://github.com/${updateRepo}/releases/download/${releaseChannel}/app.asar`));

  let data = [];
  res.on('data', d => {
    data.push(d);
  });

  await new Promise(done => res.on('end', () => {
    const buf = Buffer.concat(data);
    if (!buf.toString('hex').startsWith('04000000')) return log('AsarUpdate', 'Download error'); // Not like ASAR header

    const archivePath = getOpenAsarArchivePath(__filename);
    const targetKind = basename(archivePath).toLowerCase() === 'betterdiscord.app.asar' ? 'BetterDiscord nested payload' : 'standalone app.asar';

    log('AsarUpdate', `Writing downloaded OpenAsar to ${targetKind} ${archivePath}`);
    fs.writeFile(archivePath, buf, e => {
      log('AsarUpdate', 'Downloaded', e ?? '');
      done();
    });
  }));
};
