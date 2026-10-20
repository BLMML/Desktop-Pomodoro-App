'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { Store } = require('../src/lib/store.cjs');
const { TimerEngine } = require('../src/lib/engine.cjs');
const root = path.resolve(__dirname, '..');

async function desktopFixture(t) {
  const base = path.join(root, '.test-data'); fs.mkdirSync(base, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(base, 'desktop-'));
  let wall = new Date(2026, 9, 20, 10).getTime(), mono = 0;
  const clock = { wall: () => wall, mono: () => mono };
  const ipc = new Map(), intervals = [], notifications = [], events = [], power = new EventEmitter();
  let window, tray, closed = false;
  class ClockEngine extends TimerEngine { constructor(store) { super(store, clock); } }
  const app = new EventEmitter();
  Object.assign(app, { isPackaged: false, setName() {}, setAppUserModelId() {}, setPath() {}, getPath: () => dataDir,
    getVersion: () => '1.0.0', commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(), quit: () => { if (!closed) { app.emit('before-quit'); closed = true; } } });
  class Window extends EventEmitter {
    constructor() {
      super(); window = this; this.hidden = false; this.showCount = 0;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, { setWindowOpenHandler() {}, isDestroyed: () => false, isCrashed: () => false, send: (name, data) => events.push({ name, data }) });
    }
    removeMenu() {} loadFile() {} isDestroyed() { return false; } isMinimized() { return false; } restore() {}
    show() { this.hidden = false; this.showCount++; } hide() { this.hidden = true; } focus() {}
  }
  class TestTray extends EventEmitter {
    constructor() { super(); tray = this; this.dead = false; }
    isDestroyed() { return this.dead; } destroy() { this.dead = true; } setToolTip(s) { this.tip = s; }
    setContextMenu(menu) { this.menu = menu; } displayBalloon() {}
  }
  class TestNotification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; notifications.push(this); }
    show() { this.shown = true; }
  }
  const electron = { app, BrowserWindow: Window, Menu: { buildFromTemplate: x => x }, Tray: TestTray, Notification: TestNotification,
    ipcMain: { handle: (name, fn) => ipc.set(name, fn) }, powerMonitor: power,
    dialog: { showErrorBox: (_title, message) => { throw Error(message); } }, shell: { beep() {}, openPath: async () => '' },
    session: { defaultSession: { setPermissionRequestHandler() {}, webRequest: { onBeforeRequest(_filter, callback) { this.block = callback; } } } } };
  const context = vm.createContext({ require: name => name === 'electron' ? electron : name === './lib/store.cjs' ? require('../src/lib/store.cjs') : name === './lib/engine.cjs' ? { TimerEngine: ClockEngine } : require(name),
    __dirname: path.join(root, 'src'), process: { argv: [] }, console, setInterval: fn => { intervals.push(fn); return 1; }, clearInterval() {}, Date });
  vm.runInContext(fs.readFileSync(path.join(root, 'src/main.cjs'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(ipc.has('snapshot'), 'main process must initialize successfully');
  const event = { sender: window.webContents, senderFrame: { url: pathToFileURL(path.join(root, 'src/renderer/index.html')).href } };
  t.after(() => app.quit());
  return { app, window, tray, power, notifications, events, dataDir, electron,
    async command(name, payload) { const r = await ipc.get('command')(event, name, payload); assert.equal(r.ok, true, r.error); return r; },
    async snapshot() { return ipc.get('snapshot')(event); },
    advance(ms) { let left = ms; while (left > 0) { const n = Math.min(1000, left); wall += n; mono += n; for (const tick of intervals) tick(); left -= n; } }
  };
}

test('desktop wiring: close hides to tray and keeps counting; sleep and tray exit pause and persist', async t => {
  const f = await desktopFixture(t);
  await f.command('toggle'); f.advance(3700);
  let prevented = false; f.window.emit('close', { preventDefault() { prevented = true; } });
  assert.ok(prevented); assert.ok(f.window.hidden); f.advance(3000);
  assert.equal((await f.snapshot()).timer.elapsedMs, 6700);
  f.power.emit('suspend'); f.advance(3600000); f.power.emit('resume');
  assert.equal((await f.snapshot()).timer.status, 'paused'); assert.equal((await f.snapshot()).timer.elapsedMs, 6700);
  await f.command('toggle'); f.advance(2300);
  const quit = f.tray.menu.find(item => item.label?.startsWith('退出')); quit.click();
  const store = new Store(path.join(f.dataDir, 'focus.sqlite3'));
  try { const timer = store.get('timer', null); assert.equal(timer.status, 'paused'); assert.equal(timer.pauseReason, 'exit'); assert.equal(timer.elapsedMs, 9000); } finally { store.close(); }
  assert.equal(f.tray.dead, true);
});
test('desktop wiring: completion uses Windows notification, clicking it reopens timer, and toggle is respected', async t => {
  const f = await desktopFixture(t);
  await f.command('settings', { durations: { focus: 1, short: 1, long: 1 }, notifications: true, sound: true });
  await f.command('toggle'); f.advance(60000);
  assert.equal(f.notifications.length, 1); assert.equal(f.notifications[0].shown, true);
  assert.match(f.notifications[0].options.title, /专注完成/);
  const count = f.window.showCount; f.notifications[0].emit('click'); assert.equal(f.window.showCount, count + 1);
  assert.ok(f.events.some(e => e.name === 'app-event' && e.data.type === 'navigate' && e.data.page === 'home'));
  f.advance(2000); assert.equal(f.notifications.length, 1, 'completion notification must not repeat');
  await f.command('settings', { durations: { focus: 1, short: 1, long: 1 }, notifications: false });
  await f.command('mode', { mode: 'short' }); await f.command('toggle'); f.advance(60000);
  assert.equal(f.notifications.length, 1, 'disabled notification must not be sent');
  let canceled;
  f.electron.session.defaultSession.webRequest.block({}, value => { canceled = value.cancel; });
  assert.equal(canceled, true, 'runtime must block external networking');
});
