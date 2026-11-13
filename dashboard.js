/* CalGencha "Today" dashboard (menu page only).
   Read-only view of what is in this browser right now:
   - Habits due today (you can tick them here)
   - Bills that are overdue or due in the next 7 days
   - Gantt items that are late, in progress, or starting in the next 7 days
   It only reads the same storage keys the tools use, so nothing here needs a server. */
(function () {
  'use strict';
  var root = document.getElementById('today');
  if (!root) return;

  var K = { habits: 'habittracker.v1', spend: 'spendtracker.v1', gantt: 'barline.draft.v1' };
  var AHEAD = 7;      /* how many days ahead counts as "coming up" */
  var MAXROWS = 6;    /* rows per card before "+ N more" */

  /* ---------- small helpers ---------- */
  function pad(n) { return String(n).padStart(2, '0'); }
  function fmt(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parse(s) { var p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function dnum(s) { var p = s.split('-').map(Number); return Math.round(Date.UTC(p[0], p[1] - 1, p[2]) / 864e5); }
  function todayStr() { return fmt(new Date()); }
  function addMonths(m, n) { var p = m.split('-').map(Number), d = new Date(p[0], p[1] - 1 + n, 1); return d.getFullYear() + '-' + pad(d.getMonth() + 1); }
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/, MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/, HEX_RE = /^#[0-9a-fA-F]{6}$/;
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dayLabel(s) { return (+s.slice(8)) + ' ' + MON[+s.slice(5, 7) - 1]; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function inDays(n) { return n === 0 ? 'today' : n === 1 ? 'tomorrow' : 'in ' + n + ' days'; }
  function read(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }

  /* ---------- the three cards ---------- */
  function card(cls, title, summary, body, link, linkText) {
    return '<div class="tcard ' + cls + '"><div class="thead"><h3>' + title + '</h3><span class="tsum">' + summary + '</span></div>' + body +
      '<a class="tlink" href="' + link + '">' + linkText + '</a></div>';
  }
  function emptyCard(cls, title, msg, link, linkText) {
    return card(cls, title, '', '<p class="tempty">' + msg + '</p>', link, linkText);
  }

  function habitsCard(t) {
    var d = read(K.habits);
    if (!d || !Array.isArray(d.habits) || !d.habits.length) return emptyCard('violet', 'Habits', 'No habits yet.', 'HabitTracker.html', 'Add a habit');
    var dow = parse(t).getDay(), logs = d.logs && typeof d.logs === 'object' ? d.logs : {};
    var due = d.habits.filter(function (h) {
      if (!h || typeof h.name !== 'string') return false;
      var done = Array.isArray(logs[h.id]) && logs[h.id].indexOf(t) >= 0;
      return done || !Array.isArray(h.days) || h.days.indexOf(dow) >= 0;
    });
    var doneN = due.filter(function (h) { return Array.isArray(logs[h.id]) && logs[h.id].indexOf(t) >= 0; }).length;
    if (!due.length) return emptyCard('violet', 'Habits', 'Rest day. Nothing is scheduled today.', 'HabitTracker.html', 'Open Habit Tracker');
    var rows = due.map(function (h) {
      var done = Array.isArray(logs[h.id]) && logs[h.id].indexOf(t) >= 0;
      return '<li class="trow"><button type="button" class="tick" data-hid="' + esc(h.id) + '" aria-pressed="' + done + '" style="--c:' + (HEX_RE.test(h.color) ? h.color : '#7c3aed') + '" aria-label="' + esc(h.name) + ', done today">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></button><span class="tname' + (done ? ' dim' : '') + '">' + esc(h.name) + '</span></li>';
    }).join('');
    return card('violet', 'Habits', doneN + ' of ' + due.length + ' done', '<ul class="tlist">' + rows + '</ul>', 'HabitTracker.html', 'Open Habit Tracker');
  }

  function billsCard(t) {
    var S = read(K.spend);
    if (!S || !Array.isArray(S.recurring) || !S.recurring.length) return emptyCard('teal', 'Bills', 'No recurring bills yet.', 'SpendTracker.html', 'Add a bill');
    var spendings = Array.isArray(S.spendings) ? S.spendings : [], cm = t.slice(0, 7), tn = dnum(t), cur = (typeof S.currency === 'string' && S.currency) || 'RM';
    var months = [addMonths(cm, -1), cm, addMonths(cm, 1)], items = [], paidN = 0, dueN = 0;
    S.recurring.forEach(function (r) {
      if (!r || typeof r.name !== 'string') return;
      var every = [1, 2, 3, 6, 12].indexOf(+r.every) >= 0 ? +r.every : 1, day = Math.max(1, Math.min(31, Math.round(+r.day) || 1)), auto = r.auto === undefined ? true : !!r.auto;
      var start = MONTH_RE.test(r.start || '') ? r.start : (spendings.filter(function (x) { return x && x.rec === r.id; }).map(function (x) { return x.bm || String(x.date).slice(0, 7); }).sort()[0] || cm);
      var end = MONTH_RE.test(r.end || '') ? r.end : '';
      months.forEach(function (m) {
        var diff = (+m.slice(0, 4) - +start.slice(0, 4)) * 12 + (+m.slice(5) - +start.slice(5));
        if (m < start || (end && m > end) || diff % every !== 0) return;
        var last = new Date(+m.slice(0, 4), +m.slice(5), 0).getDate(), due = m + '-' + pad(Math.min(day, last));
        var paid = spendings.some(function (x) { return x && x.rec === r.id && (x.bm || String(x.date).slice(0, 7)) === m; });
        if (m === cm) { dueN++; if (paid) paidN++; }
        if (paid) return;
        var df = dnum(due) - tn;
        if (m === months[2] && df > AHEAD) return;
        if (df < 0 && m === months[0] && auto) return;
        if (df > AHEAD) return;
        items.push({ name: r.name, amount: +r.amount || 0, due: due, df: df, auto: auto });
      });
    });
    items.sort(function (a, b) { return a.df - b.df || a.name.localeCompare(b.name); });
    var over = items.filter(function (i) { return i.df < 0 && !i.auto; }).length;
    var summary = over ? '<span class="bad">' + plural(over, 'overdue bill') + '</span>' : (items.length ? plural(items.length, 'coming up') : (dueN ? 'All paid' : 'None this month'));
    var shown = items.slice(0, MAXROWS);
    var body = items.length ? '<ul class="tlist">' + shown.map(function (i) {
      var st = i.df < 0 ? (i.auto ? 'Autopay, due ' + dayLabel(i.due) : 'Overdue by ' + plural(-i.df, 'day')) : 'Due ' + inDays(i.df) + (i.auto ? ', autopay' : '');
      return '<li class="trow two"><span class="tname">' + esc(i.name) + '<small class="' + (i.df < 0 && !i.auto ? 'bad' : i.df <= 3 ? 'warn' : '') + '">' + esc(st) + '</small></span><b>' + esc(cur) + ' ' + i.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '</b></li>';
    }).join('') + '</ul>' + (items.length > shown.length ? '<p class="tmore">+ ' + (items.length - shown.length) + ' more</p>' : '')
      : '<p class="tempty">' + (dueN ? 'Everything due this month is paid (' + paidN + ' of ' + dueN + ').' : 'No bills due this month.') + '</p>';
    return card('teal', 'Bills', summary, body, 'SpendTracker.html', 'Open Spend Tracker');
  }

  function ganttCard(t) {
    var g = read(K.gantt);
    if (!g || !Array.isArray(g.tasks) || g.example) return emptyCard('blue', 'Gantt', 'No chart yet.', 'gancha.html', 'Start a chart');
    var people = {};
    (Array.isArray(g.persons) ? g.persons : []).forEach(function (p) { if (p && p.id) people[p.id] = String(p.name || '').split(' ')[0]; });
    var tn = dnum(t), items = [];
    g.tasks.forEach(function (x) {
      if (!x || typeof x !== 'object') return;
      var s = DATE_RE.test(x.start || '') ? x.start : '', e = DATE_RE.test(x.end || '') ? x.end : '';
      if (!s && !e) return;
      if (x.status === 'done' || +x.progress >= 100) return;
      var sn = s ? dnum(s) : null, en = e ? dnum(e) : null, who = (Array.isArray(x.assignees) ? x.assignees : []).map(function (id) { return people[id]; }).filter(Boolean);
      var kind, key, txt;
      if (en !== null && en < tn) { kind = 'late'; key = en; txt = 'Late by ' + plural(tn - en, 'day') + ' (ended ' + dayLabel(e) + ')'; }
      else if (sn !== null && sn > tn) { if (sn - tn > AHEAD) return; kind = 'soon'; key = sn + 1000; txt = 'Starts ' + inDays(sn - tn); }
      else { kind = 'now'; key = (en === null ? 9999 : en) + 500; txt = en === null ? 'In progress' : en === tn ? 'Ends today' : 'In progress, ends ' + inDays(en - tn); }
      items.push({ name: String(x.name || '').trim() || 'Untitled item', who: who.slice(0, 2).join(', ') + (who.length > 2 ? ' +' + (who.length - 2) : ''), kind: kind, key: key, txt: txt });
    });
    items.sort(function (a, b) { return a.key - b.key; });
    var late = items.filter(function (i) { return i.kind === 'late'; }).length;
    var title = typeof g.title === 'string' && g.title !== 'Untitled project' ? g.title : 'Gantt';
    var summary = late ? '<span class="bad">' + late + ' late</span>' : (items.length ? plural(items.length, 'item') : 'All clear');
    var shown = items.slice(0, MAXROWS);
    var body = items.length ? '<ul class="tlist">' + shown.map(function (i) {
      return '<li class="trow two"><span class="tname">' + esc(i.name) + '<small class="' + (i.kind === 'late' ? 'bad' : '') + '">' + esc(i.txt) + '</small></span>' + (i.who ? '<span class="twho">' + esc(i.who) + '</span>' : '') + '</li>';
    }).join('') + '</ul>' + (items.length > shown.length ? '<p class="tmore">+ ' + (items.length - shown.length) + ' more</p>' : '')
      : '<p class="tempty">Nothing is late, in progress, or starting in the next ' + AHEAD + ' days.</p>';
    return card('blue', esc(title), summary, body, 'gancha.html', 'Open Gantt Chart');
  }

  /* ---------- draw ---------- */
  var lastSig = '';
  function render(force) {
    var t = todayStr(), sig = t + '|' + [K.habits, K.spend, K.gantt].map(function (k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }).join('|');
    if (!force && sig === lastSig) return;
    lastSig = sig;
    var focusId = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.hid : null;
    var label = parse(t).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    root.innerHTML = '<div class="tbar"><h2>Today</h2><span class="tdate">' + esc(label) + '</span></div><div class="tgrid">' + habitsCard(t) + billsCard(t) + ganttCard(t) + '</div>';
    if (focusId) { var b = root.querySelector('[data-hid="' + focusId.replace(/"/g, '') + '"]'); if (b) b.focus(); }
  }

  root.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-hid]'); if (!b) return;
    var d = read(K.habits), id = b.dataset.hid, t = todayStr();
    if (!d || !Array.isArray(d.habits) || !d.habits.some(function (h) { return h.id === id; })) return;
    if (!d.logs || typeof d.logs !== 'object') d.logs = {};
    var l = Array.isArray(d.logs[id]) ? d.logs[id] : (d.logs[id] = []), i = l.indexOf(t);
    if (i >= 0) l.splice(i, 1); else { l.push(t); l.sort(); }
    try { localStorage.setItem(K.habits, JSON.stringify(d)); } catch (err) { return; }
    render();
  });

  function css() {
    var s = document.createElement('style');
    s.textContent =
      '#today{margin:0 0 28px}.tbar{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:4px 16px;margin-bottom:12px}.tdate{color:var(--muted);font-size:14px}' +
      '.tgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,270px),1fr));gap:16px}' +
      '.tcard{--a:var(--blue);display:flex;flex-direction:column;gap:10px;padding:16px;background:var(--surface);border:1px solid var(--line);border-top:4px solid var(--a);border-radius:14px;min-width:0}' +
      '.tcard.teal{--a:var(--teal)}.tcard.violet{--a:var(--violet)}' +
      '.thead{display:flex;align-items:baseline;justify-content:space-between;gap:8px}.thead h3{margin:0;font:700 16px/1.2 var(--font-display);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tsum{font-size:13px;color:var(--muted);white-space:nowrap}' +
      '.tlist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}.trow{display:flex;align-items:center;gap:12px;padding:8px 0;border-top:1px solid var(--line)}.trow:first-child{border-top:0}' +
      '.trow.two{align-items:flex-start;justify-content:space-between}.tname{flex:1;min-width:0;overflow-wrap:anywhere}.tname.dim{color:var(--muted);text-decoration:line-through}' +
      '.tname small{display:block;font-size:12.5px;color:var(--muted)}.tname small.bad,.bad{color:var(--over)}.tname small.warn{color:var(--over);opacity:.85}.trow b{white-space:nowrap;font-size:14px}.twho{font-size:12.5px;color:var(--muted);text-align:right}' +
      '.tick{flex:none;width:44px;height:44px;margin:-4px 0;border-radius:50%;border:2.5px solid var(--c);background:transparent;display:grid;place-items:center;padding:0;cursor:pointer}' +
      '.tick svg{width:22px;height:22px;stroke:#fff;fill:none;stroke-width:3;stroke-linecap:round;stroke-linejoin:round;opacity:0}.tick[aria-pressed=true]{background:var(--c)}.tick[aria-pressed=true] svg{opacity:1}' +
      '.tick:focus-visible,.tlink:focus-visible{outline:3px solid var(--a);outline-offset:2px}' +
      '.tempty,.tmore{margin:0;color:var(--muted);font-size:14px}.tlink{margin-top:auto;padding-top:6px;color:var(--ink);font-weight:600;font-size:14px;text-decoration:underline;text-decoration-color:var(--a);text-underline-offset:3px}';
    document.head.appendChild(s);
  }

  css(); render(true);
  window.addEventListener('storage', function () { render(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) render(); });
  if (window.CalGenchaProfile && CalGenchaProfile.onChange) CalGenchaProfile.onChange(function () { render(); });
})();
