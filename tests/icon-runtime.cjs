'use strict';
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.test-data', 'icon-runtime');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.setAppUserModelId('cn.xiaoyu.littlemoment.iconcheck');
app.whenReady().then(async () => {
  const resources = path.join(root, 'release', 'win-unpacked', 'resources');
  const pngPath = path.join(resources, 'icons', 'app.png');
  const icoPath = path.join(resources, 'icons', 'app.ico');
  const png = nativeImage.createFromPath(pngPath), ico = nativeImage.createFromPath(icoPath);
  assert.equal(png.isEmpty(), false, 'Packaged PNG must decode in real Electron');
  assert.equal(ico.isEmpty(), false, 'External Windows ICO must decode in real Electron');
  const exePath = path.join(root, 'release', 'win-unpacked', `${require('../package.json').build.win.executableName}.exe`);
  const visual = process.argv.includes('--visual');
  const win = new BrowserWindow({ show: false, width: 560, height: 360, title: '山间小憩 · 任务栏图标验证', icon: png, webPreferences: { sandbox: true } });
  win.setIcon(png);
  win.setAppDetails({ appId: 'cn.xiaoyu.littlemoment.iconcheck' });
  const result = { passed: true, externalPngSize: png.getSize(), externalIcoSize: ico.getSize(), executable: exePath, windowIconAndTaskbarIdentityApplied: true, relaunchIconOverride: false, actualTaskbarVisualVerified: false };
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  if (visual) {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent('<html lang="zh-CN"><meta charset="utf-8"><body style="background:#e5eadd;color:#354e42;font:18px system-ui;text-align:center;padding:32px"><img width="80" src="' + png.toDataURL() + '"><h2>山间小憩 · 图标验证</h2><p>请检查任务栏是否显示同一图标。</p><p style="font-size:14px">这是独立测试窗口，不读取专注记录。</p></body></html>')}`);
    win.show();
    setTimeout(() => { win.destroy(); app.quit(); }, 90000);
  } else { win.destroy(); app.quit(); }
}).catch(error => { fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: false, error: error.stack }), 'utf8'); app.exit(1); });
