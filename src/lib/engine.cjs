'use strict';
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { DEFAULTS, dateKey, settingsValue } = require('./store.cjs');

class TimerEngine {
  constructor(store, clock = { wall: () => Date.now(), mono: () => performance.now() }) {
    this.store = store;
    this.clock = clock;
    this.settings = settingsValue(store.get('settings', DEFAULTS));
    this.events = [];
    this.activeSpan = null;
    this.timer = store.get('timer', this.blank('focus'));
    if (this.timer.status === 'running') { this.timer.status = 'paused'; this.timer.pauseReason = 'restart'; }
    this.lastWall = clock.wall(); this.lastMono = clock.mono();
    store.tx(() => { store.put('settings', this.settings); store.saveTimer(this.timer); });
  }
  blank(mode, plan = null) {
    return { mode, status: 'idle', totalMs: this.settings.durations[mode] * 60000, elapsedMs: 0,
      sessionId: null, planId: plan?.id || null, planTitle: plan?.title || '', startedAt: null, endedAt: null, pauseReason: '' };
  }
  commit(fn) {
    const previous = { timer: structuredClone(this.timer), span: structuredClone(this.activeSpan), settings: structuredClone(this.settings) };
    try { return this.store.tx(fn); }
    catch (error) { this.timer = previous.timer; this.activeSpan = previous.span; this.settings = previous.settings; throw error; }
  }
  tick() {
    const wall = this.clock.wall(), mono = this.clock.mono();
    const delta = Math.max(0, Math.round(mono - this.lastMono));
    const wallDelta = wall - this.lastWall;
    if (this.timer.status === 'running') {
      // A missed suspend event must never count the whole sleep / process gap.
      if (delta > 15000 || wallDelta > delta + 15000) {
        this.commit(() => { this.timer.status = 'paused'; this.timer.pauseReason = 'sleep'; this.activeSpan = null; this.store.saveTimer(this.timer); });
        this.events.push({ type: 'paused', reason: 'sleep' });
      } else if (delta > 0) {
        const amount = Math.min(delta, this.timer.totalMs - this.timer.elapsedMs);
        const clockChanged = Math.abs(wallDelta - delta) > 2000;
        const start = clockChanged ? wall - delta : this.lastWall;
        this.commit(() => {
          if (clockChanged) this.activeSpan = null;
          if (this.timer.mode === 'focus') this.accrue(start, amount);
          this.timer.elapsedMs += amount;
          if (this.timer.elapsedMs >= this.timer.totalMs) {
            this.timer.status = 'completed'; this.timer.endedAt = start + amount;
            this.timer.pauseReason = ''; this.activeSpan = null;
          }
          this.store.saveTimer(this.timer);
        });
        if (this.timer.status === 'completed') this.events.push({ type: 'completed', ...structuredClone(this.timer) });
      }
    }
    this.lastWall = wall; this.lastMono = mono;
    return this.timer;
  }
  accrue(start, amount) {
    let cursor = start, remaining = amount;
    while (remaining > 0) {
      const day = dateKey(cursor);
      const midnight = new Date(cursor); midnight.setHours(24, 0, 0, 0);
      const chunk = Math.min(remaining, +midnight - cursor);
      if (!this.activeSpan || this.activeSpan.day !== day) this.activeSpan = { id: randomUUID(), day };
      this.store.addSpan(this.activeSpan.id, this.timer.sessionId, day, cursor, cursor + chunk, chunk);
      cursor += chunk; remaining -= chunk;
    }
  }
  toggle() {
    const wasRunning = this.timer.status === 'running';
    this.tick();
    if (wasRunning && this.timer.status !== 'running') return;
    if (this.timer.status === 'running') return this.pause('manual');
    this.commit(() => {
      if (this.timer.status === 'completed') this.timer = this.blank(this.timer.mode, { id: this.timer.planId, title: this.timer.planTitle });
      if (!this.timer.sessionId) { this.timer.sessionId = randomUUID(); this.timer.startedAt = this.clock.wall(); }
      this.timer.status = 'running'; this.timer.pauseReason = '';
      this.activeSpan = null;
      this.store.saveTimer(this.timer);
    });
    this.lastWall = this.clock.wall(); this.lastMono = this.clock.mono();
  }
  pause(reason = 'manual') {
    this.tick();
    if (this.timer.status === 'running') {
      this.commit(() => {
        this.timer.status = 'paused'; this.timer.pauseReason = reason;
        this.activeSpan = null; this.store.saveTimer(this.timer);
      });
    }
  }
  reset(mode = this.timer.mode, planId = this.timer.planId) {
    if (!['focus', 'short', 'long'].includes(mode)) throw Error('计时模式无效。');
    this.tick();
    const plan = planId ? this.store.plan(planId) : null;
    this.commit(() => {
      if (this.timer.sessionId && ['running', 'paused'].includes(this.timer.status)) {
        this.timer.status = 'stopped'; this.timer.endedAt = this.clock.wall(); this.store.saveTimer(this.timer);
      }
      this.timer = this.blank(mode, mode === 'focus' ? plan : null);
      this.activeSpan = null;
      this.store.saveTimer(this.timer);
    });
  }
  selectPlan(planId) {
    if (this.timer.status === 'running' || this.timer.status === 'paused') throw Error('先结束当前计时，再切换关联计划。');
    if (planId !== null && !this.store.plan(planId)) throw Error('这条计划已不存在。');
    this.reset('focus', planId);
  }
  updateSettings(value) {
    this.tick();
    const next = settingsValue(value);
    this.commit(() => {
      this.settings = next; this.store.put('settings', next);
      if (this.timer.status === 'idle') { this.timer.totalMs = next.durations[this.timer.mode] * 60000; this.store.saveTimer(this.timer); }
    });
  }
  snapshot() {
    return { settings: this.settings, timer: this.timer, ...this.store.overview(), today: dateKey(this.clock.wall()), now: this.clock.wall() };
  }
  drain() { return this.events.splice(0); }
}
module.exports = { TimerEngine };
