'use strict';
const { app, BrowserWindow, Menu, Tray, Notification, ipcMain, powerMonitor, dialog, shell, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Store, dateKey } = require('./lib/store.cjs');
const { TimerEngine } = require('./lib/engine.cjs');

const APP_ID = 'cn.xiaoyu.littlemoment';
const entry = path.join(__dirname, 'renderer', 'index.html');
const dataOverride = !app.isPackaged && process.argv.find(v => v.startsWith('--data-dir='));
app.setName('山间小憩');
app.setAppUserModelId(APP_ID);
app.setPath('userData', dataOverride ? path.resolve(dataOverride.slice(11)) : path.join(app.getPath('appData'), 'LittleMoment'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-background-networking');
const dataDir = app.getPath('userData');
let win, tray, store, engine, interval, quitting = false, shownTrayHint = false, traySignature = '', lastBackupDay = '';
const activeNotifications = new Set();

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}
function sendEvent(data) { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('app-event', data); }
function atomicJSON(filename, data) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temp = `${filename}.tmp`;
  const fd = fs.openSync(temp, 'w');
  try { fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, filename);
}
function backup(filename) { atomicJSON(filename, store.dump(engine.settings, engine.timer)); }
function dailyBackup() {
  const today = dateKey();
  if (lastBackupDay === today) return;
  const filename = path.join(dataDir, 'backups', `daily-${today}.json`);
  if (!fs.existsSync(filename)) backup(filename);
  lastBackupDay = today;
}
function notify(title, body, isTest = false) {
  if (!Notification.isSupported()) return false;
  try {
  const n = new Notification({ title, body, icon: path.join(__dirname, '..', 'assets', 'app.png'), silent: true, timeoutType: 'default' });
  activeNotifications.add(n);
  n.on('click', () => { showWindow(); sendEvent({ type: 'navigate', page: 'home' }); });
  n.on('close', () => activeNotifications.delete(n));
  n.on('failed', () => { activeNotifications.delete(n); sendEvent({ type: 'message', message: isTest ? 'Windows 未能显示通知，请检查系统通知设置。' : '计时已结束，请稍作休息。' }); });
  n.show();
  return true;
  } catch (e) {
    reportError(Error(`Windows 通知未能显示：${e.message}`));
    return false;
  }
}
function processEvents() {
  for (const event of engine.drain()) {
    if (event.type === 'completed') {
      if (engine.settings.notifications) notify(event.mode === 'focus' ? '山间小憩 · 专注完成' : '山间小憩 · 休息结束', event.mode === 'focus' ? `完成了 ${Math.round(event.totalMs / 60000)} 分钟专注，伸个懒腰吧。` : '带着新的能量，开始下一段专注时光。');
      if ((!win || win.webContents.isCrashed()) && engine.settings.sound && engine.settings.volume > 0) shell.beep();
    }
    sendEvent(event);
  }
}
function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  const t = engine.timer;
  const sec = Math.ceil((t.totalMs - t.elapsedMs) / 1000);
  const time = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  const state = { idle: '等待开始', running: t.mode === 'focus' ? '专注中' : '休息中', paused: '已暂停', completed: '计时完成' }[t.status];
  const signature = `${time}|${t.status}|${t.mode}`;
  if (signature === traySignature) return;
  traySignature = signature;
  tray.setToolTip(`山间小憩 · ${state} ${time}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `${state} · ${time}`, enabled: false },
    { label: '打开山间小憩', click: showWindow },
    { label: t.status === 'running' ? '暂停计时' : t.status === 'paused' ? '继续计时' : '开始计时', click: () => { try { engine.toggle(); broadcast(); } catch (e) { reportError(e); } } },
    { type: 'separator' },
    { label: '退出（暂停并保存）', click: () => app.quit() }
  ]));
}
function broadcast() {
  processEvents();
  if (win && !win.isDestroyed()) win.webContents.send('snapshot', engine.snapshot());
  updateTray();
}
function reportError(e) {
  sendEvent({ type: 'message', message: e.message || '操作未完成，请重试。' });
  try { fs.appendFileSync(path.join(dataDir, 'app-errors.log'), `${new Date().toISOString()} ${e.stack || e}\n`); } catch {}
}
function trusted(event) { return win && event.sender === win.webContents && event.senderFrame?.url === pathToFileURL(entry).href; }
function createWindow() {
  win = new BrowserWindow({ width: 1240, height: 920, minWidth: 980, minHeight: 730, show: false,
    title: '山间小憩', icon: path.join(__dirname, '..', 'assets', 'app.ico'), backgroundColor: '#e5eadd', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, spellcheck: false }
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (url !== pathToFileURL(entry).href) event.preventDefault(); });
  win.webContents.on('render-process-gone', () => { if (!quitting) { engine.pause('renderer'); reportError(Error('界面出现异常，计时已暂停并保存。重新打开应用可恢复。')); } });
  win.on('ready-to-show', () => win.show());
  win.on('close', event => {
    if (quitting) return;
    if (!tray || tray.isDestroyed()) { app.quit(); return; }
    event.preventDefault(); win.hide();
    if (!shownTrayHint) { shownTrayHint = true; tray.displayBalloon({ title: '山间小憩仍在计时', content: '从系统托盘重新打开，或右键选择“退出（暂停并保存）”。', noSound: true }); }
  });
  const saveForShutdown = () => { if (!quitting) { try { engine.pause('shutdown'); store.checkpoint(); } catch (e) { reportError(e); } } };
  win.on('query-session-end', saveForShutdown);
  win.on('session-end', saveForShutdown);
  win.loadFile(entry);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('window-all-closed', () => {});
  app.whenReady().then(() => {
    store = new Store(path.join(dataDir, 'focus.sqlite3'));
    engine = new TimerEngine(store);
    session.defaultSession.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
    createWindow();
    tray = new Tray(path.join(__dirname, '..', 'assets', 'app.ico'));
    tray.on('click', showWindow); tray.on('double-click', showWindow);
    updateTray(); dailyBackup();
    powerMonitor.on('suspend', () => { try { engine.pause('sleep'); store.checkpoint(); broadcast(); } catch (e) { reportError(e); } });
    powerMonitor.on('resume', () => { try { engine.pause('sleep'); broadcast(); sendEvent({ type: 'message', message: '欢迎回来。睡眠期间未计入专注，准备好后点击继续。' }); } catch (e) { reportError(e); } });
    ipcMain.handle('snapshot', event => { if (!trusted(event)) throw Error('无效请求。'); return { ...engine.snapshot(), dataDir, version: app.getVersion() }; });
    ipcMain.handle('command', async (event, name, payload) => {
      if (!trusted(event)) return { ok: false, error: '无效请求。' };
      try {
        if (name !== 'toggle') engine.tick();
        let result = null;
        switch (name) {
          case 'toggle': engine.toggle(); break;
          case 'pause': engine.pause('manual'); break;
          case 'reset': engine.reset(); break;
          case 'mode': engine.reset(payload?.mode); break;
          case 'select-plan': engine.selectPlan(payload?.id ?? null); break;
          case 'settings': engine.updateSettings(payload); break;
          case 'save-plan': result = store.savePlan(payload || {}); break;
          case 'toggle-plan': store.togglePlan(payload?.id); break;
          case 'delete-plan': store.deletePlan(payload?.id); break;
          case 'day-details': result = store.dayDetails(payload?.day); break;
          case 'test-notification':
            result = notify('山间小憩 · 测试通知', '这就是计时结束时的提醒。点击通知可回到应用。', true);
            if (!result) throw Error('Windows 通知不可用，请检查系统通知设置。');
            break;
          case 'open-data': { const error = await shell.openPath(dataDir); if (error) throw Error('无法打开数据文件夹。'); break; }
          case 'export': {
            const answer = await dialog.showSaveDialog(win, { title: '导出专注记录备份', defaultPath: `山间小憩-备份-${dateKey()}.json`, filters: [{ name: '山间小憩备份', extensions: ['json'] }] });
            if (!answer.canceled && answer.filePath) { engine.tick(); backup(answer.filePath); result = '备份已导出。'; }
            break;
          }
          case 'import': {
            const answer = await dialog.showOpenDialog(win, { title: '选择山间小憩备份', filters: [{ name: '山间小憩备份', extensions: ['json'] }], properties: ['openFile'] });
            if (answer.canceled || !answer.filePaths[0]) break;
            if (fs.statSync(answer.filePaths[0]).size > 100 * 1024 * 1024) throw Error('备份文件超过 100 MB，请选择较小的备份。');
            let data;
            try { data = Store.validateBackup(JSON.parse(fs.readFileSync(answer.filePaths[0], 'utf8'))); }
            catch (e) { throw Error(e instanceof SyntaxError ? '备份文件无法读取，当前数据未更改。' : e.message); }
            const confirm = await dialog.showMessageBox(win, { type: 'question', title: '恢复备份', message: '用这份备份恢复数据？', detail: `包含 ${data.plans.length} 条计划、${data.sessions.length} 段计时。当前数据会先自动备份到本机，恢复后的计时保持暂停。`, buttons: ['取消', '备份当前数据并恢复'], defaultId: 0, cancelId: 0, noLink: true });
            if (confirm.response !== 1) break;
            engine.pause('import');
            backup(path.join(dataDir, 'backups', `before-import-${Date.now()}.json`));
            store.restore(data); engine = new TimerEngine(store); result = '备份已恢复，计时保持暂停。';
            break;
          }
          default: throw Error('不支持这项操作。');
        }
        broadcast();
        return { ok: true, result, snapshot: engine.snapshot() };
      } catch (e) { reportError(e); return { ok: false, error: e.message || '操作失败，请重试。' }; }
    });
    interval = setInterval(() => {
      try { engine.tick(); broadcast(); dailyBackup(); }
      catch (e) {
        try { engine.pause('error'); } catch { engine.timer.status = 'paused'; engine.timer.pauseReason = 'storage-error'; }
        reportError(e);
      }
    }, 1000);
  }).catch(e => { dialog.showErrorBox('山间小憩启动失败', `本地数据会保留，请检查磁盘与文件权限。\n${e.message}`); quitting = true; app.quit(); });
  app.on('before-quit', () => {
    if (quitting) return;
    quitting = true; clearInterval(interval);
    try { if (engine) engine.pause('exit'); if (store) store.close(); } catch (e) { try { fs.appendFileSync(path.join(dataDir, 'app-errors.log'), `${e.stack}\n`); } catch {} }
    if (tray && !tray.isDestroyed()) tray.destroy();
  });
}
