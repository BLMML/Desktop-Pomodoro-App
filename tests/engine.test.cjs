'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store, DEFAULTS } = require('../src/lib/store.cjs');
const { TimerEngine } = require('../src/lib/engine.cjs');
const F = require('../src/renderer/stats.js');
const base = path.join(__dirname, '..', '.test-data');
fs.mkdirSync(base, { recursive: true });

function fixture(t, start = new Date(2026, 9, 20, 10).getTime()) {
  const folder = fs.mkdtempSync(path.join(base, 'case-'));
  let store = new Store(path.join(folder, 'focus.sqlite3'));
  let wall = start, mono = 0;
  const clock = { wall: () => wall, mono: () => mono };
  let engine = new TimerEngine(store, clock);
  t.after(() => { if (store) store.close(); });
  return {
    get store() { return store; }, get engine() { return engine; },
    advance(ms) { let left = ms; while (left > 0) { const n = Math.min(left, 1000); wall += n; mono += n; engine.tick(); left -= n; } },
    gap(ms) { wall += ms; mono += ms; engine.tick(); },
    elapse(ms) { wall += ms; mono += ms; },
    wallJump(ms) { wall += ms; mono += 1000; engine.tick(); },
    reopen(offlineMs = 0) { store.close(); wall += offlineMs; mono += offlineMs; store = new Store(path.join(folder, 'focus.sqlite3')); engine = new TimerEngine(store, clock); },
    total() { return store.overview().days.reduce((n, d) => n + d.ms, 0); }
  };
}

test('partial focus counts immediately; paused and rest time never count', t => {
  const f = fixture(t); f.engine.toggle(); f.advance(18500); f.engine.pause();
  assert.equal(f.total(), 18500); f.advance(50000); assert.equal(f.total(), 18500);
  f.engine.toggle(); f.advance(12500); f.engine.reset('short');
  assert.equal(f.total(), 31000); assert.equal(f.store.dayDetails('2026-10-20')[0].status, 'stopped');
  f.engine.toggle(); f.advance(20000); assert.equal(f.total(), 31000);
});
test('exit saves exact progress; restart and offline time remain paused until manual continue', t => {
  const f = fixture(t); f.engine.toggle(); f.advance(72001); f.engine.pause('exit');
  f.reopen(8 * 3600000); assert.equal(f.engine.timer.status, 'paused'); assert.equal(f.engine.timer.elapsedMs, 72001);
  f.advance(3000); assert.equal(f.total(), 72001);
  f.engine.toggle(); f.advance(1999); assert.equal(f.total(), 74000);
});
test('a renderer refresh / snapshot request does not reset or pause background timer', t => {
  const f = fixture(t); f.engine.toggle(); f.advance(12000);
  for (let n = 0; n < 5; n++) { const snap = f.engine.snapshot(); assert.equal(snap.timer.status, 'running'); assert.equal(snap.timer.elapsedMs, 12000); }
  f.advance(8000); assert.equal(f.total(), 20000);
});
test('sleep saves progress; resume keeps timer paused', t => {
  const f = fixture(t); f.engine.toggle(); f.advance(1537); f.engine.pause('sleep');
  f.gap(3600000); f.engine.pause('sleep'); assert.equal(f.total(), 1537); assert.equal(f.engine.timer.status, 'paused');
  f.engine.toggle(); f.advance(2463); assert.equal(f.total(), 4000);
});
test('unexpected app termination recovers from committed SQLite checkpoint without counting downtime', t => {
  const f = fixture(t); f.engine.toggle(); f.advance(93000);
  f.reopen(86400000); assert.equal(f.engine.timer.status, 'paused'); assert.equal(f.engine.timer.pauseReason, 'restart'); assert.equal(f.total(), 93000);
});
test('missed suspend or large execution gap pauses without adding the gap', t => {
  const f = fixture(t); f.engine.toggle(); f.advance(3000); f.gap(600000);
  assert.equal(f.engine.timer.status, 'paused'); assert.equal(f.total(), 3000);
});
test('a midnight-spanning session splits actual milliseconds across calendar days', t => {
  const f = fixture(t, new Date(2026, 9, 20, 23, 59, 58, 500).getTime());
  f.engine.toggle(); f.advance(5000); f.engine.pause();
  const days = f.store.overview().days;
  assert.equal(days.find(d => d.day === '2026-10-20').ms, 1500);
  assert.equal(days.find(d => d.day === '2026-10-21').ms, 3500);
  assert.equal(f.total(), 5000);
});
test('clock adjustment uses monotonic duration and preserves valid historical spans', t => {
  const f = fixture(t); f.engine.toggle(); f.advance(5000); f.wallJump(-3600000); f.engine.pause();
  assert.equal(f.total(), 6000);
  assert.doesNotThrow(() => Store.validateBackup(f.store.dump(f.engine.settings, f.engine.timer)));
});
test('completion emits once, caps elapsed time, and rest does not enter focus stats', t => {
  const f = fixture(t); f.engine.updateSettings({ ...DEFAULTS, durations: { focus: 1, short: 1, long: 1 } });
  f.engine.toggle(); f.advance(90000);
  assert.equal(f.total(), 60000); assert.equal(f.engine.timer.status, 'completed');
  assert.equal(f.engine.drain().filter(e => e.type === 'completed').length, 1);
  f.advance(2000); assert.equal(f.engine.drain().length, 0);
  f.engine.reset('short'); f.engine.toggle(); f.advance(60000); assert.equal(f.total(), 60000);
});
test('custom durations apply on next session; existing progress remains intact', t => {
  const f = fixture(t); f.engine.toggle(); f.advance(15000);
  f.engine.updateSettings({ ...DEFAULTS, durations: { focus: 45, short: 3, long: 10 } });
  assert.equal(f.engine.timer.totalMs, 1500000); assert.equal(f.engine.timer.elapsedMs, 15000);
  f.engine.reset(); assert.equal(f.engine.timer.totalMs, 2700000); assert.equal(f.total(), 15000);
});
test('plans can be edited, completed, and removed without losing historical attribution', t => {
  const f = fixture(t); const id = f.store.savePlan({ title: '阅读一篇论文', day: '2026-10-20' });
  f.engine.selectPlan(id); f.engine.toggle(); f.advance(3000);
  f.store.savePlan({ id, title: '修改后的计划名', day: '2026-10-20' }); f.store.togglePlan(id);
  assert.equal(f.store.plan(id).done, 1); f.store.deletePlan(id); f.engine.pause();
  assert.equal(f.total(), 3000); assert.equal(f.store.dayDetails('2026-10-20')[0].plan_title, '阅读一篇论文');
  assert.equal(f.store.overview().plans.length, 0);
});
test('backup round trip restores plans, all history, settings, and paused progress', t => {
  const f = fixture(t); const id = f.store.savePlan({ title: '练习', day: '2026-10-20' });
  f.engine.selectPlan(id); f.engine.toggle(); f.advance(5000);
  f.engine.updateSettings({ ...DEFAULTS, theme: 'sunset', notifications: false, volume: 35 });
  const data = JSON.parse(JSON.stringify(f.store.dump(f.engine.settings, f.engine.timer)));
  f.engine.pause(); f.store.deletePlan(id); f.engine.reset();
  f.store.restore(data); f.reopen(86400000);
  assert.equal(f.engine.timer.status, 'paused'); assert.equal(f.engine.timer.elapsedMs, 5000);
  assert.equal(f.engine.settings.theme, 'sunset'); assert.equal(f.engine.settings.notifications, false);
  assert.equal(f.store.plan(id).title, '练习'); assert.equal(f.total(), 5000);
});
test('invalid and inconsistent backups are rejected before replacing any live data', t => {
  const f = fixture(t); f.engine.toggle(); f.advance(3000); f.engine.pause();
  const valid = f.store.dump(f.engine.settings, f.engine.timer);
  const bad = structuredClone(valid); bad.spans[0].duration_ms += 1;
  assert.throws(() => f.store.restore(bad), /不一致/); assert.equal(f.total(), 3000);
  assert.throws(() => f.store.restore({ format: 'other', version: 1 }), /有效备份/);
  const duplicate = structuredClone(valid); duplicate.spans.push(duplicate.spans[0]); assert.throws(() => f.store.restore(duplicate), /重复/);
  assert.equal(f.engine.timer.elapsedMs, 3000);
});
test('calendar handles leap years, week boundaries, streaks, and minutes correctly', () => {
  const grid = F.yearGrid(2024, '2024-12-31');
  assert.equal(grid.cells.filter(c => c.inYear).length, 366);
  assert.ok(grid.cells.some(c => c.day === '2024-02-29'));
  assert.equal(grid.cells.length % 7, 0);
  const s = F.summary([{ day: '2026-10-18', ms: 30000 }, { day: '2026-10-19', ms: 60000 }, { day: '2026-10-20', ms: 120000 }], '2026-10-20');
  assert.equal(s.streak, 3); assert.equal(s.longest, 3); assert.equal(s.week, 180000);
  assert.equal(F.summary([{ day: '2026-10-19', ms: 1000 }], '2026-10-20').streak, 1);
  assert.equal(F.summary([{ day: '2026-10-18', ms: 1000 }], '2026-10-20').streak, 0);
  assert.equal(F.duration(18500, true), '18 秒'); assert.equal(F.duration(7200000), '2 小时');
});
test('a failed database write rolls back in-memory progress as well as stored records', t => {
  const f = fixture(t); f.engine.toggle(); f.advance(1000);
  const original = f.store.addSpan.bind(f.store);
  f.store.addSpan = () => { throw Error('simulated write failure'); };
  assert.throws(() => f.advance(1000), /simulated write failure/);
  assert.equal(f.engine.timer.elapsedMs, 1000); assert.equal(f.total(), 1000);
  f.store.addSpan = original; f.engine.tick();
  assert.equal(f.engine.timer.elapsedMs, 2000); assert.equal(f.total(), 2000);
  assert.doesNotThrow(() => Store.validateBackup(f.store.dump(f.engine.settings, f.engine.timer)));
});
test('clicking pause at the completion boundary does not accidentally start another round', t => {
  const f = fixture(t); f.engine.updateSettings({ ...DEFAULTS, durations: { focus: 1, short: 1, long: 1 } });
  f.engine.toggle(); f.advance(59900); f.elapse(100); f.engine.toggle();
  assert.equal(f.engine.timer.status, 'completed'); assert.equal(f.total(), 60000);
  assert.equal(f.engine.drain().filter(e => e.type === 'completed').length, 1);
});
