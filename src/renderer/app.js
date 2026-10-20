(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const F = window.FocusStats;
  let state, currentPage = 'home', selectedDay, selectedYear, monthYear, monthIndex, editPlanId;
  let appInfo = {}, plansSignature = '', selectorSignature = '', heatSignature = '', monthSignature = '';
  let audio, toastTimer, confirmResolver, completeMode = 'focus', detailPending = false, detailLastAt = 0;
  let commandBusy = false;
  const modes = {
    focus: { name: '专注', intro: '让纷扰暂时走远，只做眼前这一件事。', caption: '此刻，只需专注', footer: '一小步专注，也是在好好生长。' },
    short: { name: '休息', intro: '松开紧绷的肩膀，听一听自己的呼吸。', caption: '停一停，也很好', footer: '好好休息，是为了更轻盈地出发。' },
    long: { name: '休息', intro: '去喝杯水，看看窗外，让思绪自在漫游。', caption: '慢下来，深呼吸', footer: '把这一段留白，送给自己。' }
  };
  const el = (tag, className, content) => { const n = document.createElement(tag); if (className) n.className = className; if (content !== undefined) n.textContent = content; return n; };
  const icon = name => { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', `#i-${name}`); svg.append(use); svg.setAttribute('aria-hidden', 'true'); return svg; };
  function listen(selector, event, callback) { $(selector).addEventListener(event, e => { Promise.resolve(callback(e)).catch(error => toast(error.message || '操作未完成，请重试。')); }); }
  function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 5000); }
  async function command(name, payload) {
    const response = await window.desktop.command(name, payload);
    if (!response.ok) throw Error(response.error);
    if (response.snapshot) receive(response.snapshot);
    return response.result;
  }
  async function guarded(callback) {
    if (commandBusy) return;
    commandBusy = true;
    try { await callback(); } finally { commandBusy = false; }
  }
  function receive(next) {
    if (!next?.timer) return;
    const previousToday = state?.today;
    state = next;
    if (next.dataDir) appInfo = { dataDir: next.dataDir, version: next.version };
    if (!selectedDay) { selectedDay = next.today; selectedYear = Number(next.today.slice(0, 4)); monthYear = selectedYear; monthIndex = Number(next.today.slice(5, 7)) - 1; $('#plan-date').value = next.today; }
    else if (previousToday && previousToday !== next.today && $('#plan-date').value === previousToday) $('#plan-date').value = next.today;
    renderHome();
    if (currentPage === 'plans') renderPlans();
    if (currentPage === 'data') renderData();
  }
  function navigate(page) {
    if (!['home', 'plans', 'data'].includes(page)) return;
    currentPage = page;
    for (const name of ['home', 'plans', 'data']) $(`#page-${name}`).hidden = name !== page;
    for (const button of $$('.nav-button')) {
      const active = button.dataset.page === page; button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    }
    $('main').scrollTop = 0;
    if (page === 'plans') renderPlans();
    if (page === 'data') { renderData(); refreshDetails(); }
  }
  function renderHome() {
    const t = state.timer, settings = state.settings, meta = modes[t.mode];
    document.documentElement.dataset.theme = settings.theme;
    document.body.classList.toggle('is-running', t.status === 'running');
    const sec = Math.ceil((t.totalMs - t.elapsedMs) / 1000), m = Math.floor(sec / 60), s = sec % 60;
    const digits = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    if ($('#timer').dataset.digits !== digits) { $('#timer').innerHTML = digits.replace(':', '<span>:</span>'); $('#timer').dataset.digits = digits; }
    $('#timer').setAttribute('aria-label', `剩余 ${m} 分 ${s} 秒`);
    const progress = Math.min(1, t.elapsedMs / t.totalMs);
    $('#ring-progress').style.strokeDashoffset = String(100 * progress);
    $('#ring-dot').style.transform = `rotate(${progress * 360}deg)`;
    $('#ring-dot').style.opacity = t.status === 'completed' ? '0' : '1';
    const text = t.status === 'running' ? '暂停一下' : t.status === 'paused' ? `继续${meta.name}` : t.status === 'completed' ? '再来一轮' : `开始${meta.name}`;
    $('#start-button span').textContent = text;
    $('#start-button use').setAttribute('href', t.status === 'running' ? '#i-pause' : '#i-play');
    let label = t.status === 'running' ? (t.mode === 'focus' ? '正在慢慢靠近目标' : '正在为自己充电') : t.status === 'paused' ? '已暂停，随时继续' : t.status === 'completed' ? '这一段时光，已完成' : `${t.mode === 'focus' ? '心无旁骛' : '自在放松'}的 ${t.totalMs / 60000} 分钟`;
    $('#clock-label').replaceChildren(el('span', 'status-dot'), document.createTextNode(` ${label}`));
    $('#clock-caption').textContent = t.status === 'paused' ? '调整呼吸，再出发' : t.status === 'completed' ? '给自己一点掌声' : meta.caption;
    $('#intro-copy').textContent = meta.intro; $('#card-footer-copy').textContent = meta.footer;
    $('#timer-panel').setAttribute('aria-labelledby', `tab-${t.mode}`);
    for (const tab of $$('.mode-tab')) { const active = tab.dataset.mode === t.mode; tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; }
    for (const button of $$('.scene-button')) { const active = button.dataset.theme === settings.theme; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }
    const sound = settings.sound && settings.volume > 0;
    $('#sound-toggle').setAttribute('aria-pressed', String(sound));
    $('#sound-toggle').setAttribute('aria-label', sound ? '关闭完成提示音' : '开启完成提示音');
    $('#sound-toggle').title = sound ? '关闭完成提示音' : '开启完成提示音';
    $('#sound-toggle use').setAttribute('href', sound ? '#i-sound' : '#i-mute');
    $('#sound-status-text').textContent = settings.notifications ? (sound ? '清铃与 Windows 通知已开启' : 'Windows 通知已开启') : sound ? '结束时，轻声提醒你' : '结束提醒已静音';
    const today = state.days.find(d => d.day === state.today);
    $('#today-duration').textContent = F.duration(today?.ms || 0, true);
    $('#today-count').textContent = `${today?.sessions || 0} 段`;
    $('#footer-message').textContent = t.status === 'paused' && ['sleep', 'restart', 'exit', 'shutdown'].includes(t.pauseReason) ? '进度已保存。准备好后，点击继续。' : '不必着急，按自己的节奏来。';
    document.title = ['running', 'paused'].includes(t.status) ? `${digits} · ${t.status === 'paused' ? '已暂停' : `${meta.name}中`} — 山间小憩` : '山间小憩';
    renderPlanSelector();
  }
  function renderPlanSelector() {
    const t = state.timer;
    $('.plan-association').hidden = t.mode !== 'focus';
    $('#current-plan').disabled = ['running', 'paused'].includes(t.status);
    const plans = state.plans.filter(p => (p.day === state.today && !p.done) || p.id === t.planId);
    const signature = JSON.stringify([plans.map(p => [p.id, p.title, p.done]), t.planId, t.planTitle]);
    if (signature === selectorSignature) return;
    selectorSignature = signature;
    $('#current-plan').replaceChildren(new Option('自由专注 · 暂不关联计划', ''));
    for (const p of plans) $('#current-plan').append(new Option(p.title, p.id));
    if (t.planId && !plans.some(p => p.id === t.planId)) $('#current-plan').append(new Option(t.planTitle || '原关联计划', t.planId));
    $('#current-plan').value = t.planId || '';
  }
  function renderPlans() {
    const date = $('#plan-date').value || state.today;
    const plans = state.plans.filter(p => p.day === date);
    const done = plans.filter(p => p.done).length;
    $('#plans-heading').textContent = date === state.today ? '今日计划' : `${date.replaceAll('-', '.')} 的计划`;
    $('#plan-progress').textContent = `${done} / ${plans.length} 已完成`;
    $('#plans-summary').textContent = plans.length ? `${plans.length} 件小事 · 已累计投入 ${F.duration(plans.reduce((n, p) => n + p.focus_ms, 0), true)}` : '还没有计划，慢慢来。';
    $('#plans-empty').hidden = plans.length > 0;
    const signature = JSON.stringify(plans.map(p => [p.id, p.title, p.done, p.day]));
    if (signature !== plansSignature) {
      plansSignature = signature;
      const fragment = document.createDocumentFragment();
      for (const p of plans) {
        const row = el('div', `plan-row${p.done ? ' done' : ''}`); row.dataset.id = p.id;
        const check = el('button', 'plan-check'); check.dataset.action = 'toggle'; check.setAttribute('aria-label', p.done ? `标记未完成：${p.title}` : `标记完成：${p.title}`); check.setAttribute('aria-pressed', String(Boolean(p.done))); if (p.done) check.append(icon('check'));
        const info = el('div', 'plan-info'); info.append(el('p', 'plan-title', p.title), el('div', 'plan-duration'));
        const actions = el('div', 'plan-row-actions');
        const focus = el('button', 'plan-focus'); focus.dataset.action = 'focus'; focus.append(icon('play'), document.createTextNode('专注')); focus.setAttribute('aria-label', `为“${p.title}”开始专注`);
        const edit = el('button', 'icon-button', '✎'); edit.dataset.action = 'edit'; edit.title = '编辑计划'; edit.setAttribute('aria-label', `编辑：${p.title}`);
        const del = el('button', 'icon-button'); del.dataset.action = 'delete'; del.append(icon('close')); del.title = '删除计划'; del.setAttribute('aria-label', `删除：${p.title}`);
        actions.append(focus, edit, del); row.append(check, info, actions); fragment.append(row);
      }
      $('#plan-list').replaceChildren(fragment);
    }
    for (const row of $$('.plan-row')) { const p = plans.find(p => p.id === row.dataset.id); if (p) row.querySelector('.plan-duration').textContent = p.focus_ms ? `已投入 ${F.duration(p.focus_ms, true)}` : '还未开始，给它一点时间'; }
  }
  function renderData() {
    const result = F.summary(state.days, state.today);
    for (const [id, value] of [['today', result.today], ['week', result.week], ['total', result.total]]) $(`#metric-${id}`).textContent = F.duration(value);
    $('#metric-today-sessions').textContent = `${result.todaySessions} 段专注`;
    $('#metric-days').textContent = `${result.activeDays} 个专注日`;
    $('#metric-longest').textContent = `${result.longest} 天`; $('#metric-streak').textContent = `${result.streak} 天`;
    const thisYear = Number(state.today.slice(0, 4));
    const years = new Set([...Array.from({ length: 5 }, (_, i) => thisYear - i), selectedYear, ...state.days.map(d => Number(d.day.slice(0, 4)))]);
    const sig = [...years].sort((a, b) => b - a).join(',');
    if ($('#stats-year').dataset.years !== sig) { $('#stats-year').replaceChildren(...sig.split(',').map(y => new Option(`${y} 年`, y))); $('#stats-year').dataset.years = sig; }
    $('#stats-year').value = selectedYear;
    const yearly = state.days.filter(d => d.day.startsWith(`${selectedYear}-`));
    $('#year-summary').textContent = `${selectedYear} 年 · ${yearly.filter(d => d.ms > 0).length} 个专注日 · 共 ${F.duration(yearly.reduce((n, d) => n + d.ms, 0))}`;
    renderHeatmap(); renderMonth();
    const settings = state.settings;
    $('#settings-overview').textContent = `专注 ${settings.durations.focus} 分钟 · 短休息 ${settings.durations.short} 分钟 · 长休息 ${settings.durations.long} 分钟`;
    $('#notification-status').textContent = settings.notifications ? '已开启。结束时发送系统通知，点击后回到应用。' : '已关闭。可在“调整设置”中开启 Windows 通知。';
    $('#data-location').textContent = appInfo.dataDir || '数据仅保存在当前电脑';
    $('#app-version').textContent = `山间小憩 ${appInfo.version || '1.0.0'} · 离线桌面版`;
    if (!detailPending && Date.now() - detailLastAt > 3000) refreshDetails();
  }
  function dayMap() { return new Map(state.days.map(d => [d.day, d.ms])); }
  function renderHeatmap() {
    const signature = `${selectedYear}|${selectedDay}|${state.today}|${state.days.map(d => `${d.day}:${Math.ceil(d.ms / 60000)}`).join(',')}`;
    if (signature === heatSignature) return;
    heatSignature = signature;
    const { weeks, cells } = F.yearGrid(selectedYear, state.today), map = dayMap();
    $('#heatmap').style.setProperty('--weeks', weeks); $('#heatmap-months').style.setProperty('--weeks', weeks);
    const fragment = document.createDocumentFragment(), months = document.createDocumentFragment();
    cells.forEach((cell, index) => {
      const ms = map.get(cell.day) || 0, button = el('button', `heatmap-day level-${F.level(ms)}${cell.day === selectedDay ? ' selected' : ''}${cell.day === state.today ? ' today' : ''}`);
      button.dataset.day = cell.day; button.title = `${cell.day} · ${F.duration(ms, true)}`; button.setAttribute('aria-label', button.title);
      button.disabled = !cell.inYear || cell.future;
      if (!cell.inYear) button.style.visibility = 'hidden';
      fragment.append(button);
      if (cell.inYear && cell.day.endsWith('-01')) { const label = el('span', '', `${Number(cell.day.slice(5, 7))}月`); label.style.gridColumn = `${Math.floor(index / 7) + 1}`; months.append(label); }
    });
    $('#heatmap').replaceChildren(fragment); $('#heatmap-months').replaceChildren(months);
  }
  function renderMonth() {
    const signature = `${monthYear}|${monthIndex}|${selectedDay}|${state.today}|${state.days.map(d => `${d.day}:${Math.ceil(d.ms / 60000)}`).join(',')}`;
    if (signature === monthSignature) return;
    monthSignature = signature;
    $('#month-title').textContent = `${monthYear} 年 ${monthIndex + 1} 月`;
    const map = dayMap(), fragment = document.createDocumentFragment();
    for (const cell of F.monthGrid(monthYear, monthIndex)) {
      const ms = map.get(cell.day) || 0;
      const button = el('button', `calendar-day${!cell.inMonth ? ' other-month' : ''}${cell.day === selectedDay ? ' selected' : ''}${cell.day === state.today ? ' today' : ''}`);
      button.dataset.day = cell.day; button.title = `${cell.day} · ${F.duration(ms, true)}`; button.setAttribute('aria-label', button.title);
      button.append(el('span', '', Number(cell.day.slice(-2))), el('small', '', ms ? ms < 60000 ? '<1分' : `${Math.floor(ms / 60000)}分` : ''));
      if (cell.day > state.today) button.disabled = true;
      fragment.append(button);
    }
    $('#month-calendar').replaceChildren(fragment);
  }
  function selectDay(day) {
    selectedDay = day; monthYear = Number(day.slice(0, 4)); monthIndex = Number(day.slice(5, 7)) - 1; selectedYear = monthYear;
    heatSignature = ''; monthSignature = ''; renderData(); refreshDetails();
  }
  async function refreshDetails() {
    if (!selectedDay || detailPending) return;
    detailPending = true;
    const day = selectedDay;
    try {
      const response = await window.desktop.command('day-details', { day });
      if (!response.ok) throw Error(response.error);
      if (day !== selectedDay) { detailLastAt = 0; return; }
      detailLastAt = Date.now();
      $('#detail-title').textContent = day === state.today ? '今天的专注' : `${day.replaceAll('-', '.')} 的专注`;
      const records = response.result || [];
      $('#detail-total').textContent = F.duration(records.reduce((n, r) => n + r.ms, 0), true);
      const fragment = document.createDocumentFragment();
      if (!records.length) { const empty = el('div', 'day-empty'); empty.append(document.createTextNode('这一天还没有专注记录。'), el('br'), document.createTextNode('从一个小小的开始，慢慢积累。')); fragment.append(empty); }
      for (const record of records) {
        const row = el('div', 'record-row'), info = el('div');
        const time = ms => new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
        const status = { running: '专注中', paused: '已暂停', completed: '已完成', stopped: '已结束' }[record.status] || '';
        info.append(el('div', 'record-title', record.plan_title || '自由专注'), el('div', 'record-meta', `${time(record.started_at)} — ${time(record.ended_at)} · ${status}`));
        row.append(info, el('div', 'record-duration', F.duration(record.ms, true))); fragment.append(row);
      }
      $('#day-records').replaceChildren(fragment);
    } catch (e) { detailLastAt = Date.now(); toast(e.message); }
    finally { detailPending = false; }
    if (day !== selectedDay) refreshDetails();
  }
  async function ask(title, copy, action = '确认') {
    if (confirmResolver) return false;
    $('#confirm-title').textContent = title; $('#confirm-copy').textContent = copy; $('#confirm-action').textContent = action;
    $('#confirm-dialog .secondary-button').textContent = '取消';
    return new Promise(resolve => { confirmResolver = resolve; $('#confirm-dialog').showModal(); });
  }
  function activeTimer() { return ['running', 'paused'].includes(state.timer.status); }
  async function resetTimer(mode) {
    if (activeTimer() && !(await ask(mode ? '切换到另一段时光？' : '重新开始这一刻？', '已投入的专注时间会保留在记录里，当前倒计时将重新开始。', mode ? '切换模式' : '重置计时'))) return;
    await command(mode ? 'mode' : 'reset', mode ? { mode } : undefined);
  }
  async function startPlan(id) {
    if (activeTimer() && state.timer.mode === 'focus' && state.timer.planId === id) {
      navigate('home'); if (state.timer.status === 'paused') await command('toggle'); return;
    }
    if (activeTimer() && !(await ask('为这件事开启一段专注？', '当前已专注的时间会保存，然后为这条计划开始新的计时。', '开始新的专注'))) return;
    await command('mode', { mode: 'focus' }); await command('select-plan', { id }); await command('toggle'); navigate('home');
  }
  function openSettings() {
    for (const mode of Object.keys(modes)) $(`#duration-${mode}`).value = state.settings.durations[mode];
    $('#volume').value = state.settings.volume; $('#volume-value').value = `${state.settings.volume}%`;
    $('#setting-sound').checked = state.settings.sound; $('#setting-notifications').checked = state.settings.notifications;
    $('#settings-note').textContent = activeTimer() ? '新时长从下一轮生效；当前进度会保留。' : '音量设为 0 时静音。系统通知可单独开关。';
    $('#settings-dialog').showModal();
  }
  async function unlockAudio() {
    try { if (!audio) audio = new AudioContext(); if (audio.state === 'suspended') await audio.resume(); return audio.state === 'running'; } catch { return false; }
  }
  async function playChime(volume = state.settings.volume) {
    if (volume <= 0 || !(await unlockAudio())) return;
    const start = audio.currentTime + .04;
    for (const [offset, frequency, duration] of [[0, 659.25, .28], [.16, 880, .42]]) for (const [harmonic, strength] of [[1, .24], [2, .024]]) {
      const oscillator = audio.createOscillator(), gain = audio.createGain(), when = start + offset, peak = strength * volume / 100;
      oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(frequency * harmonic * 1.018, when); oscillator.frequency.exponentialRampToValueAtTime(frequency * harmonic, when + .05);
      gain.gain.setValueAtTime(0, when); gain.gain.linearRampToValueAtTime(peak, when + .009); gain.gain.exponentialRampToValueAtTime(peak * .32, when + .1); gain.gain.exponentialRampToValueAtTime(.0001, when + duration); gain.gain.linearRampToValueAtTime(0, when + duration + .02);
      oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(when); oscillator.stop(when + duration + .03); oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    }
  }
  function appEvent(event) {
    if (event.type === 'message') toast(event.message);
    if (event.type === 'navigate') navigate(event.page);
    if (event.type === 'paused' && event.reason === 'sleep') toast('计时已自动暂停，进度已保存。准备好后点击继续。');
    if (event.type === 'completed') {
      completeMode = event.mode;
      if (state.settings.sound) playChime();
      for (const dialog of $$('dialog[open]')) dialog.close();
      $('#complete-title').textContent = completeMode === 'focus' ? '这一刻，做得很好。' : '休息好了，轻盈出发。';
      $('#complete-copy').textContent = completeMode === 'focus' ? `完成了 ${event.totalMs / 60000} 分钟专注。伸个懒腰，让眼睛看看远方吧。` : '带着一点新的能量，开始下一段专注时光。';
      $('#complete-next').textContent = completeMode === 'focus' ? `开始 ${state.settings.durations.short} 分钟休息` : `开始 ${state.settings.durations.focus} 分钟专注`;
      $('#announcer').textContent = completeMode === 'focus' ? '专注计时完成，可以休息一下了。' : '休息已结束。';
      $('#complete-dialog').showModal();
    }
  }

  $$('[data-page]').forEach(button => button.addEventListener('click', e => { e.preventDefault(); if (state) navigate(button.dataset.page); }));
  listen('#start-button', 'click', () => guarded(() => command('toggle')));
  listen('#reset-button', 'click', () => guarded(() => resetTimer()));
  $$('.mode-tab').forEach((button, index, tabs) => {
    button.addEventListener('click', () => { if (state && button.dataset.mode !== state.timer.mode) guarded(() => resetTimer(button.dataset.mode)).catch(e => toast(e.message)); });
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : -1) + 3) % 3;
      tabs[next].focus(); tabs[next].click();
    });
  });
  $$('.scene-button').forEach(button => button.addEventListener('click', () => { if (state) command('settings', { ...state.settings, theme: button.dataset.theme }).catch(e => toast(e.message)); }));
  listen('#current-plan', 'change', event => guarded(() => command('select-plan', { id: event.target.value || null })));
  listen('#sound-toggle', 'click', () => command('settings', { ...state.settings, sound: !(state.settings.sound && state.settings.volume > 0), volume: state.settings.volume || 60 }));
  listen('#settings-open', 'click', openSettings); listen('#data-settings-open', 'click', openSettings);
  listen('#volume', 'input', event => { $('#volume-value').value = `${event.target.value}%`; });
  listen('#preview-sound', 'click', async () => { const volume = Number($('#volume').value); if (!volume) { toast('先把提示音量调高一点吧。'); return; } await playChime(volume); });
  listen('#settings-form', 'submit', async event => {
    event.preventDefault(); if (!event.target.reportValidity()) return;
    await command('settings', { ...state.settings, durations: Object.fromEntries(Object.keys(modes).map(mode => [mode, Number($(`#duration-${mode}`).value)])), volume: Number($('#volume').value), sound: $('#setting-sound').checked, notifications: $('#setting-notifications').checked });
    $('#settings-dialog').close(); toast('已保存，按自己的节奏来。');
  });
  $$('[data-close]').forEach(button => button.addEventListener('click', () => $(`#${button.dataset.close}`).close()));
  listen('#confirm-action', 'click', () => { const resolve = confirmResolver; confirmResolver = null; $('#confirm-dialog').close(); resolve?.(true); });
  listen('#confirm-dialog', 'close', () => { const resolve = confirmResolver; confirmResolver = null; resolve?.(false); });
  listen('#complete-next', 'click', async () => { $('#complete-dialog').close(); await command('mode', { mode: completeMode === 'focus' ? 'short' : 'focus' }); await command('toggle'); navigate('home'); });
  listen('#plan-date', 'change', () => { plansSignature = ''; renderPlans(); });
  listen('#add-plan-form', 'submit', event => { event.preventDefault(); return guarded(async () => { const title = $('#new-plan-title').value.trim(); if (!title) throw Error('先给这件事起个名字吧。'); await command('save-plan', { title, day: $('#plan-date').value || state.today }); $('#new-plan-title').value = ''; $('#new-plan-title').focus(); }); });
  listen('#plan-list', 'click', event => guarded(async () => {
    const button = event.target.closest('button[data-action]'), row = button?.closest('.plan-row'); if (!row) return;
    const p = state.plans.find(p => p.id === row.dataset.id); if (!p) return;
    switch (button.dataset.action) {
      case 'toggle': await command('toggle-plan', { id: p.id }); break;
      case 'focus': await startPlan(p.id); break;
      case 'edit': editPlanId = p.id; $('#edit-title').value = p.title; $('#edit-date').value = p.day; $('#edit-plan-dialog').showModal(); break;
      case 'delete': if (await ask('移除这条计划？', '计划会从列表中移除，为它投入过的专注时间和名称仍会保留在历史记录中。', '移除计划')) await command('delete-plan', { id: p.id }); break;
    }
  }));
  listen('#edit-plan-form', 'submit', async event => { event.preventDefault(); if (!event.target.reportValidity()) return; await command('save-plan', { id: editPlanId, title: $('#edit-title').value.trim(), day: $('#edit-date').value }); $('#edit-plan-dialog').close(); toast('计划已调整。'); });
  listen('#stats-year', 'change', event => { selectedYear = Number(event.target.value); renderData(); });
  listen('#heatmap', 'click', event => { const day = event.target.closest('[data-day]')?.dataset.day; if (day) selectDay(day); });
  listen('#month-calendar', 'click', event => { const day = event.target.closest('[data-day]')?.dataset.day; if (day) selectDay(day); });
  listen('#month-prev', 'click', () => { const d = new Date(monthYear, monthIndex - 1, 1, 12); monthYear = d.getFullYear(); monthIndex = d.getMonth(); renderMonth(); });
  listen('#month-next', 'click', () => { const d = new Date(monthYear, monthIndex + 1, 1, 12); monthYear = d.getFullYear(); monthIndex = d.getMonth(); renderMonth(); });
  listen('#month-today', 'click', () => selectDay(state.today));
  listen('#test-notification', 'click', async () => { await command('test-notification'); toast('测试通知已发送；若未出现，请检查 Windows 通知设置。'); });
  listen('#export-backup', 'click', () => guarded(async () => { const result = await command('export'); if (result) toast(result); }));
  listen('#import-backup', 'click', () => guarded(async () => { const result = await command('import'); if (result) { plansSignature = ''; heatSignature = ''; monthSignature = ''; renderData(); refreshDetails(); toast(result); } }));
  listen('#open-data-folder', 'click', () => command('open-data'));
  document.addEventListener('keydown', event => {
    if (event.code !== 'Space' || event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || !state || currentPage !== 'home' || $('dialog[open]') || event.target.closest('input,button,a,textarea,select,[contenteditable=true]')) return;
    event.preventDefault(); guarded(() => command('toggle')).catch(e => toast(e.message));
  });
  window.desktop.onUpdate(receive); window.desktop.onEvent(appEvent);
  window.desktop.snapshot().then(snapshot => { receive(snapshot); if (snapshot.timer.status === 'paused' && ['restart', 'exit', 'sleep', 'shutdown'].includes(snapshot.timer.pauseReason)) toast('已恢复上次进度。关闭和睡眠期间未计入，点击继续即可。'); unlockAudio(); }).catch(e => toast(`无法读取本地数据：${e.message}`));
})();
