'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Store, DEFAULTS, dateKey } = require('../src/lib/store.cjs');
const project = path.resolve(__dirname, '..');
const source = path.join(project, '.test-data', 'desktop-qa', 'focus.sqlite3');
if (!fs.existsSync(source)) { console.log('No trial data to export.'); process.exit(0); }
const store = new Store(source);
try {
  const data = store.tx(() => {
    const settings = store.get('settings', DEFAULTS), timer = store.get('timer', null);
    return Store.validateBackup(store.dump(settings, timer));
  });
  const filename = path.join(project, 'release', `山间小憩-试用数据备份-${dateKey()}.json`);
  const fd = fs.openSync(filename, 'w');
  try { fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  console.log(JSON.stringify({ backup: filename, plans: data.plans.length, sessions: data.sessions.length, durationMs: data.spans.reduce((n, s) => n + s.duration_ms, 0) }));
} finally { store.close(); }
