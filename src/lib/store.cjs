'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULTS = Object.freeze({ durations: { focus: 25, short: 5, long: 15 }, theme: 'morning', sound: true, volume: 60, notifications: true });
function dateKey(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T12:00:00`);
  return Number.isFinite(+d) && dateKey(+d) === s;
}
function settingsValue(v = {}) {
  const out = structuredClone(DEFAULTS);
  for (const [k, max] of [['focus', 180], ['short', 60], ['long', 120]]) {
    if (v.durations?.[k] !== undefined) {
      if (!Number.isInteger(v.durations[k]) || v.durations[k] < 1 || v.durations[k] > max) throw Error('请填写有效的计时时长。');
      out.durations[k] = v.durations[k];
    }
  }
  if (v.theme !== undefined) {
    if (!['morning', 'forest', 'sunset'].includes(v.theme)) throw Error('风景设置无效。');
    out.theme = v.theme;
  }
  for (const k of ['sound', 'notifications']) if (v[k] !== undefined) {
    if (typeof v[k] !== 'boolean') throw Error('设置格式无效。');
    out[k] = v[k];
  }
  if (v.volume !== undefined) {
    if (!Number.isFinite(v.volume) || v.volume < 0 || v.volume > 100) throw Error('音量应为 0–100。');
    out.volume = v.volume;
  }
  return out;
}
function text(v, max = 200) {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v)) throw Error('计划名称应为 1–200 个字。');
  return v.trim();
}
function validId(id) { return typeof id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(id); }
function number(n, max = Number.MAX_SAFE_INTEGER) { return Number.isSafeInteger(n) && n >= 0 && n <= max; }

class Store {
  constructor(filename) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.filename = filename;
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, title TEXT NOT NULL, day TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, mode TEXT NOT NULL, plan_id TEXT, plan_title TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, total_ms INTEGER NOT NULL, elapsed_ms INTEGER NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS spans (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), day TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS spans_day ON spans(day);
      CREATE INDEX IF NOT EXISTS spans_session ON spans(session_id);
      CREATE INDEX IF NOT EXISTS plans_day ON plans(day);
      PRAGMA foreign_keys=ON;`);
  }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  get(key, fallback) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : structuredClone(fallback);
  }
  put(key, value) { this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  saveTimer(t) {
    this.put('timer', t);
    if (t.sessionId) this.db.prepare(`INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET ended_at=excluded.ended_at, elapsed_ms=excluded.elapsed_ms, status=excluded.status`).run(
      t.sessionId, t.mode, t.planId, t.planTitle, t.startedAt, t.endedAt, t.totalMs, t.elapsedMs, t.status);
  }
  addSpan(id, sessionId, day, start, end, duration) {
    this.db.prepare(`INSERT INTO spans VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ended_at=excluded.ended_at, duration_ms=spans.duration_ms+excluded.duration_ms`).run(id, sessionId, day, start, end, duration);
  }
  plan(id) { return this.db.prepare('SELECT * FROM plans WHERE id=?').get(id); }
  savePlan(v) {
    const title = text(v.title);
    if (!validDate(v.day)) throw Error('请选择有效日期。');
    if (v.id) {
      if (!this.plan(v.id)) throw Error('这条计划已不存在。');
      this.db.prepare('UPDATE plans SET title=?,day=? WHERE id=?').run(title, v.day, v.id);
      return v.id;
    }
    const id = randomUUID();
    this.db.prepare('INSERT INTO plans VALUES(?,?,?,?,?)').run(id, title, v.day, 0, Date.now());
    return id;
  }
  togglePlan(id) {
    if (!this.plan(id)) throw Error('这条计划已不存在。');
    this.db.prepare('UPDATE plans SET done=1-done WHERE id=?').run(id);
  }
  deletePlan(id) { this.db.prepare('DELETE FROM plans WHERE id=?').run(id); }
  overview() {
    return {
      plans: this.db.prepare(`SELECT p.*,COALESCE((SELECT SUM(s.elapsed_ms) FROM sessions s WHERE s.plan_id=p.id AND s.mode='focus'),0) AS focus_ms FROM plans p ORDER BY p.day DESC,p.done,p.created_at`).all(),
      days: this.db.prepare('SELECT day,SUM(duration_ms) AS ms,COUNT(DISTINCT session_id) AS sessions FROM spans GROUP BY day ORDER BY day').all()
    };
  }
  dayDetails(day) {
    if (!validDate(day)) throw Error('日期无效。');
    return this.db.prepare(`SELECT s.id,s.plan_title,s.status,s.total_ms,s.elapsed_ms,MIN(p.started_at) AS started_at,MAX(p.ended_at) AS ended_at,SUM(p.duration_ms) AS ms FROM spans p JOIN sessions s ON p.session_id=s.id WHERE p.day=? GROUP BY s.id ORDER BY started_at DESC`).all(day);
  }
  dump(settings, timer) {
    return { format: 'little-moment-backup', version: 1, exportedAt: new Date().toISOString(), settings, timer,
      plans: this.db.prepare('SELECT * FROM plans ORDER BY created_at').all(),
      sessions: this.db.prepare('SELECT * FROM sessions ORDER BY started_at').all(),
      spans: this.db.prepare('SELECT * FROM spans ORDER BY started_at').all() };
  }
  static validateBackup(data) {
    if (!data || data.format !== 'little-moment-backup' || data.version !== 1) throw Error('这不是山间小憩的有效备份文件。');
    const settings = settingsValue(data.settings);
    if (!Array.isArray(data.plans) || !Array.isArray(data.sessions) || !Array.isArray(data.spans) || data.plans.length > 100000 || data.sessions.length > 200000 || data.spans.length > 1000000) throw Error('备份记录格式无效或文件过大。');
    for (const collection of [data.plans, data.sessions, data.spans]) {
      const ids = new Set();
      for (const row of collection) { if (!row || !validId(row.id) || ids.has(row.id)) throw Error('备份中含有无效或重复记录。'); ids.add(row.id); }
    }
    for (const p of data.plans) if (text(p.title) !== p.title || !validDate(p.day) || ![0, 1].includes(p.done) || !number(p.created_at)) throw Error('备份的计划数据无效。');
    const sessionMap = new Map();
    for (const s of data.sessions) {
      if (!['focus', 'short', 'long'].includes(s.mode) || !['running', 'paused', 'completed', 'stopped'].includes(s.status) || !number(s.started_at) || !(s.ended_at === null || number(s.ended_at)) || !number(s.total_ms, 10800000) || s.total_ms < 60000 || !number(s.elapsed_ms, s.total_ms) || !(s.plan_id === null || validId(s.plan_id)) || typeof s.plan_title !== 'string' || s.plan_title.length > 200) throw Error('备份的计时记录无效。');
      sessionMap.set(s.id, s);
    }
    const totals = new Map();
    for (const p of data.spans) {
      const s = sessionMap.get(p.session_id);
      if (!s || s.mode !== 'focus' || !validDate(p.day) || !number(p.started_at) || !number(p.ended_at) || p.ended_at < p.started_at || !number(p.duration_ms, 10800000) || p.duration_ms === 0) throw Error('备份的每日时长数据无效。');
      totals.set(s.id, (totals.get(s.id) || 0) + p.duration_ms);
    }
    for (const s of data.sessions) if (s.mode === 'focus' && (totals.get(s.id) || 0) !== s.elapsed_ms) throw Error('备份中的专注时长不一致，未更改当前数据。');
    const t = data.timer;
    if (!t || !['focus', 'short', 'long'].includes(t.mode) || !['idle', 'running', 'paused', 'completed'].includes(t.status) || !number(t.totalMs, 10800000) || t.totalMs < 60000 || !number(t.elapsedMs, t.totalMs) || !(t.sessionId === null || validId(t.sessionId)) || !(t.planId === null || validId(t.planId)) || typeof t.planTitle !== 'string' || t.planTitle.length > 200 || !(t.startedAt === null || number(t.startedAt, 8640000000000000)) || !(t.endedAt === null || number(t.endedAt, 8640000000000000)) || typeof t.pauseReason !== 'string' || t.pauseReason.length > 100) throw Error('备份的当前进度无效。');
    if (t.sessionId) {
      const s = sessionMap.get(t.sessionId);
      if (!s || s.mode !== t.mode || s.elapsed_ms !== t.elapsedMs || s.total_ms !== t.totalMs || s.status !== t.status || s.plan_id !== t.planId || s.plan_title !== t.planTitle || s.started_at !== t.startedAt) throw Error('备份的当前计时与记录不一致。');
    } else if (t.status !== 'idle' || t.elapsedMs !== 0 || t.startedAt !== null || t.endedAt !== null) throw Error('备份的空闲进度无效。');
    return { ...data, settings };
  }
  restore(data) {
    const clean = Store.validateBackup(data);
    this.tx(() => {
      this.db.exec('DELETE FROM spans; DELETE FROM sessions; DELETE FROM plans;');
      const pp = this.db.prepare('INSERT INTO plans VALUES(?,?,?,?,?)');
      for (const p of clean.plans) pp.run(p.id, p.title, p.day, p.done, p.created_at);
      const ps = this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?)');
      for (const s of clean.sessions) ps.run(s.id, s.mode, s.plan_id, s.plan_title, s.started_at, s.ended_at, s.total_ms, s.elapsed_ms, s.status === 'running' ? 'paused' : s.status);
      const pf = this.db.prepare('INSERT INTO spans VALUES(?,?,?,?,?,?)');
      for (const p of clean.spans) pf.run(p.id, p.session_id, p.day, p.started_at, p.ended_at, p.duration_ms);
      this.put('settings', clean.settings);
      this.put('timer', { ...clean.timer, status: clean.timer.status === 'running' ? 'paused' : clean.timer.status, pauseReason: 'import' });
    });
  }
  checkpoint() { this.db.exec('PRAGMA wal_checkpoint(FULL)'); }
  close() { this.checkpoint(); this.db.close(); }
}
module.exports = { Store, DEFAULTS, dateKey, validDate, settingsValue, text };
