(function (root) {
  'use strict';
  function key(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
  function fromKey(s) { return new Date(`${s}T12:00:00`); }
  function addDay(s, n) { const d = fromKey(s); d.setDate(d.getDate() + n); return key(d); }
  function duration(ms, seconds = false) {
    const s = Math.max(0, Math.floor(ms / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60);
    if (s === 0) return '0 分钟';
    if (m === 0) return `${s} 秒`;
    if (h) return `${h} 小时${m % 60 ? ` ${m % 60} 分` : ''}${seconds && s % 60 ? ` ${s % 60} 秒` : ''}`;
    return `${m} 分钟${seconds && s % 60 ? ` ${s % 60} 秒` : ''}`;
  }
  function level(ms) { return ms <= 0 ? 0 : ms < 1800000 ? 1 : ms < 3600000 ? 2 : ms < 7200000 ? 3 : 4; }
  function summary(days, today) {
    const map = new Map(days.map(d => [d.day, d]));
    const active = days.filter(d => d.ms > 0).map(d => d.day).sort();
    let longest = 0, run = 0, prev;
    for (const d of active) { run = prev && addDay(prev, 1) === d ? run + 1 : 1; longest = Math.max(longest, run); prev = d; }
    let streak = 0, cursor = map.get(today)?.ms > 0 ? today : addDay(today, -1);
    while ((map.get(cursor)?.ms || 0) > 0) { streak++; cursor = addDay(cursor, -1); }
    const offset = (fromKey(today).getDay() + 6) % 7;
    const monday = addDay(today, -offset);
    return { today: map.get(today)?.ms || 0, todaySessions: map.get(today)?.sessions || 0,
      week: days.filter(d => d.day >= monday && d.day <= today).reduce((n, d) => n + d.ms, 0),
      total: days.reduce((n, d) => n + d.ms, 0), activeDays: active.length, longest, streak };
  }
  function yearGrid(year, today) {
    const first = `${year}-01-01`, last = `${year}-12-31`;
    let cursor = addDay(first, -((fromKey(first).getDay() + 6) % 7));
    const cells = [];
    do { cells.push({ day: cursor, inYear: cursor >= first && cursor <= last, future: cursor > today }); cursor = addDay(cursor, 1); }
    while (cursor <= last || cells.length % 7 !== 0);
    return { weeks: cells.length / 7, cells };
  }
  function monthGrid(year, month) {
    const first = key(new Date(year, month, 1, 12));
    let cursor = addDay(first, -((fromKey(first).getDay() + 6) % 7));
    return Array.from({ length: 42 }, () => { const d = cursor; cursor = addDay(cursor, 1); return { day: d, inMonth: fromKey(d).getMonth() === month }; });
  }
  const api = { key, fromKey, addDay, duration, level, summary, yearGrid, monthGrid };
  root.FocusStats = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
