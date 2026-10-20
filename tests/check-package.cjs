'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const archive = path.join(root, 'release/win-unpacked/resources/app.asar');
const files = ['src/main.cjs', 'src/preload.cjs', 'src/lib/store.cjs', 'src/lib/engine.cjs', 'src/renderer/index.html', 'src/renderer/app.js', 'src/renderer/stats.js', 'src/renderer/app.css', 'src/renderer/landscape.css', 'assets/app.ico', 'assets/app.png'];
for (const file of files) assert.ok(asar.extractFile(archive, path.normalize(file)).equals(fs.readFileSync(path.join(root, file))), `Packaged source differs: ${file}`);
for (const file of ['app.ico', 'app.png']) assert.ok(fs.readFileSync(path.join(root, 'release/win-unpacked/resources/icons', file)).equals(fs.readFileSync(path.join(root, 'assets', file))), `External Windows icon differs: ${file}`);
// Check the resource Windows actually extracts from the desktop/taskbar EXE.
const pe = require('pe-library');
const { Resource } = require('resedit');
const exePath = path.join(root, 'release/win-unpacked', `${require('../package.json').build.win.executableName}.exe`);
const resources = pe.NtExecutableResource.from(pe.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true }));
const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
assert.equal(groups.length, 1, 'Executable must have one unambiguous application icon');
const sourceIcon = fs.readFileSync(path.join(root, 'assets/app.ico'));
const frameCount = sourceIcon.readUInt16LE(4);
assert.equal(groups[0].icons.length, frameCount);
for (let i = 0; i < frameCount; i++) {
  const offset = 6 + i * 16;
  const length = sourceIcon.readUInt32LE(offset + 8), start = sourceIcon.readUInt32LE(offset + 12);
  const frame = groups[0].icons[i];
  const embedded = resources.entries.find(e => e.type === 3 && e.id === frame.iconID && e.lang === groups[0].lang);
  assert.ok(embedded && Buffer.from(embedded.bin).equals(sourceIcon.subarray(start, start + length)), `Embedded executable icon frame ${i} differs`);
}
const names = asar.listPackage(archive);
assert.ok(!names.some(name => /(?:\.test-data|tests|node_modules|focus\.sqlite3|试用数据备份)/.test(name)), 'Development/test/user data must not be inside the app');
const installerName = `LittleMoment-Setup-${require('../package.json').version}.exe`;
const installer = path.join(root, 'release', installerName);
const bytes = fs.readFileSync(installer);
assert.equal(bytes.subarray(0, 2).toString(), 'MZ');
assert.ok(bytes.length > 50 * 1024 * 1024);
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
fs.writeFileSync(path.join(root, 'release/SHA256SUMS.txt'), `${sha256}  ${installerName}\n`, 'utf8');
console.log(JSON.stringify({ packagedFilesVerified: files.length, externalIconsVerified: 2, embeddedIconFramesVerified: frameCount, executable: exePath, testDataExcluded: true, installer, bytes: bytes.length, sha256 }, null, 2));
