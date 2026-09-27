'use strict';

// ================= state & helpers =================

const state = { token: null, user: null, meta: null };
let pageCleanup = [];

const LABELS = {
  status: {
    new: 'New', in_progress: 'In progress', pending_client: 'Pending client',
    pending_microsoft: 'Pending Microsoft', resolved: 'Resolved', closed: 'Closed', cancelled: 'Cancelled',
  },
  statusClass: {
    new: 'info', in_progress: 'accent', pending_client: 'warn', pending_microsoft: 'warn',
    resolved: 'ok', closed: '', cancelled: '',
  },
  type: { incident: 'Incident', request: 'Service request', change: 'Change', problem: 'Problem' },
  role: { admin: 'Administrator', engineer: 'Engineer', client: 'Client' },
  sla: { met: 'Met', breached: 'Breached', running: 'On track', at_risk: 'At risk', paused: 'Paused' },
  slaClass: { met: 'ok', breached: 'bad', running: 'info', at_risk: 'warn', paused: '' },
  days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  field: {
    created: 'Created', title: 'Title', type: 'Type', priority: 'Priority', status: 'Status',
    category: 'Category', assignee_id: 'Assignee', ms_case: 'Microsoft case',
  },
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = () => $('#view');

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const isStaff = () => state.user && state.user.role !== 'client';
const isAdmin = () => state.user && state.user.role === 'admin';
const offsetMs = () => (state.meta?.settings?.business_hours?.offset || 0) * 60000;

const store = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* storage unavailable */ } },
};

function fmtDate(ms, withTime = true) {
  if (!ms) return '—';
  const d = new Date(Number(ms) + offsetMs());
  const p = (n) => String(n).padStart(2, '0');
  const s = `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
  return withTime ? `${s} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` : s;
}

function fmtDay(iso) {
  const [y, m, d] = String(iso).split('-');
  return `${d}/${m}/${y}`;
}

function fmtDuration(min) {
  min = Math.round(Number(min) || 0);
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
}

// Value suitable for the duration input field: "1h30", "2h", "45m"
function durationInput(min) {
  min = Math.round(Number(min) || 0);
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}

const fmtHours = (min) => `${(Math.round((Number(min) || 0) / 6) / 10).toLocaleString('en-US')} h`;

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtRelative(ms) {
  const diff = Number(ms) - Date.now();
  const abs = Math.abs(diff) / 60000;
  let s;
  if (abs < 60) s = `${Math.round(abs)} min`;
  else if (abs < 60 * 48) s = `${Math.round(abs / 6) / 10} h`;
  else s = `${Math.round(abs / 1440)} d`;
  return diff >= 0 ? `in ${s}` : `${s} ago`;
}

// "1h30", "1.5", "1,5h", "90", "90m", "45 min" -> minutes
function parseDuration(input) {
  const s = String(input || '').trim().toLowerCase().replace(',', '.');
  if (!s) return NaN;
  let m = s.match(/^(\d+(?:\.\d+)?)\s*h\s*(\d+)?\s*(?:m|min)?$/);
  if (m) return Math.round(Number(m[1]) * 60 + Number(m[2] || 0));
  m = s.match(/^(\d+)\s*(?:m|min|mn)$/);
  if (m) return Number(m[1]);
  m = s.match(/^\d+(?:\.\d+)?$/);
  if (m) return Number(s) <= 12 ? Math.round(Number(s) * 60) : Math.round(Number(s));
  return NaN;
}

function todayLocal() {
  return new Date(Date.now() + offsetMs()).toISOString().slice(0, 10);
}

function currentMonth() {
  return todayLocal().slice(0, 7);
}

function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${bad ? ' bad' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), 3200);
}

const badge = (text, cls = '') => `<span class="badge ${cls}">${esc(text)}</span>`;
const statusBadge = (s) => badge(LABELS.status[s] || s, LABELS.statusClass[s]);
const prioBadge = (p) => `<span class="prio ${esc(p)}">${esc(p)}</span>`;
const slaBadge = (s) => (s ? badge(LABELS.sla[s] || s, LABELS.slaClass[s]) : '');
const ticketNo = (id) => `${state.meta?.settings?.ticket_prefix || 'TCK'}-${String(id).padStart(5, '0')}`;

function csvDownload(filename, header, rows) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = '﻿' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ================= API =================

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method || 'GET',
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && path !== '/login') {
    logout(false);
    throw new Error('Session expired, please sign in again');
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || `Error ${res.status}`);
  return data;
}

async function fetchBlob(path) {
  const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${state.token}` } });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  return res.blob();
}

async function download(path, filename) {
  try {
    const blob = await fetchBlob(path);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (ex) {
    toast(ex.message, true);
  }
}

async function uploadFile(ticketId, file) {
  const max = (state.meta.max_upload_mb || 20) * 1024 * 1024;
  if (file.size > max) throw new Error(`${file.name}: file too large (max ${state.meta.max_upload_mb} MB)`);
  const res = await fetch(`/api/tickets/${ticketId}/attachments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${state.token}`,
      'Content-Type': 'application/octet-stream',
      'X-Filename': encodeURIComponent(file.name || 'screenshot.png'),
      'X-Mime': file.type || 'application/octet-stream',
    },
    body: file,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Upload failed (${res.status})`);
  }
}

// ================= modal =================

function openModal(html, onSubmit) {
  const card = $('#modal-card');
  card.innerHTML = html;
  $('#modal').classList.remove('hidden');
  const form = $('form', card);
  $$('[data-close]', card).forEach((b) => b.addEventListener('click', closeModal));
  if (form && onSubmit) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('.error', form);
      if (err) err.textContent = '';
      const btn = $('button[type=submit]', form);
      if (btn) btn.disabled = true;
      try {
        await onSubmit(Object.fromEntries(new FormData(form)), form);
      } catch (ex) {
        if (err) err.textContent = ex.message; else toast(ex.message, true);
      } finally {
        if (btn) btn.disabled = false;
      }
    });
    const first = $('input:not([type=hidden]), textarea, select', form);
    if (first) first.focus();
  }
}

function closeModal() {
  $('#modal').classList.add('hidden');
  $('#modal-card').innerHTML = '';
}

const modalOpen = () => !$('#modal').classList.contains('hidden');

$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// ================= session =================

async function boot() {
  state.token = store.get('ora_token');
  if (!state.token) return showLogin();
  try {
    state.user = await api('/me');
    state.meta = await api('/meta');
    showApp();
  } catch {
    showLogin();
  }
}

function showLogin() {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
}

function showApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#me-name').textContent = state.user.name;
  $('#me-role').textContent = LABELS.role[state.user.role];
  $$('[data-staff]').forEach((a) => a.classList.toggle('hidden', !isStaff()));
  $$('[data-admin]').forEach((a) => a.classList.toggle('hidden', !isAdmin()));
  updateTimerPill();
  route();
}

function logout(callApi = true) {
  if (callApi && state.token) api('/logout', { method: 'POST' }).catch(() => {});
  store.remove('ora_token');
  state.token = null;
  state.user = null;
  showLogin();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  $('#login-error').textContent = '';
  try {
    const r = await api('/login', { method: 'POST', body: f });
    state.token = r.token;
    store.set('ora_token', r.token);
    state.user = r.user;
    state.meta = await api('/meta');
    e.target.reset();
    showApp();
  } catch (ex) {
    $('#login-error').textContent = ex.message;
  }
});

$('#btn-logout').addEventListener('click', () => logout());

$('#btn-password').addEventListener('click', () => {
  openModal(`
    <h2>Change my password</h2>
    <form class="form-grid">
      <label class="full">Current password<input type="password" name="current" required autocomplete="current-password"></label>
      <label class="full">New password (min. 8 characters)<input type="password" name="next" minlength="8" required autocomplete="new-password"></label>
      <div class="error full"></div>
      <div class="foot full"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div>
    </form>`, async (data) => {
    await api('/me/password', { method: 'POST', body: data });
    closeModal();
    toast('Password changed');
  });
});

// ================= work timer =================
// One running timer per browser, kept in localStorage so it survives reloads.

const getTimer = () => store.get('ora_timer');

function updateTimerPill() {
  const pill = $('#timer-pill');
  const t = getTimer();
  if (!t || !isStaff()) { pill.classList.add('hidden'); return; }
  pill.classList.remove('hidden');
  pill.href = `#/tickets/${t.ticketId}`;
  pill.title = t.title || '';
  pill.textContent = `${t.number}  ${fmtClock(Date.now() - t.start)}`;
  const btn = $('#timer-btn');
  if (btn && btn.dataset.ticket === String(t.ticketId)) btn.textContent = `■ Stop ${fmtClock(Date.now() - t.start)}`;
}
setInterval(updateTimerPill, 1000);

function startTimer(ticket) {
  const running = getTimer();
  if (running) {
    toast(`A timer is already running on ${running.number}. Stop it first.`, true);
    return false;
  }
  store.set('ora_timer', { ticketId: ticket.id, number: ticket.number, title: ticket.title, start: Date.now() });
  updateTimerPill();
  return true;
}

function stopTimer(done) {
  const t = getTimer();
  if (!t) return;
  const minutes = Math.max(1, Math.ceil((Date.now() - t.start) / 60000));
  timeModal({ ticket_id: t.ticketId, minutes, work_date: todayLocal() }, () => {
    store.remove('ora_timer');
    updateTimerPill();
    done && done();
  }, 'Stop timer — log time');
}

// ================= router =================

const routes = {
  dashboard: renderDashboard,
  tickets: renderTickets,
  time: renderTime,
  reports: renderReports,
  settings: renderSettings,
};

async function route() {
  if (!state.user) return;
  pageCleanup.forEach((fn) => fn());
  pageCleanup = [];
  const [, name = 'dashboard', id] = location.hash.split('/');
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
  const fn = name === 'tickets' && id ? () => renderTicket(id) : routes[name] || renderDashboard;
  view().innerHTML = '<p class="muted">Loading…</p>';
  try {
    await fn();
  } catch (ex) {
    view().innerHTML = `<div class="alert bad">${esc(ex.message)}</div>`;
  }
}

window.addEventListener('hashchange', route);

async function refreshMeta() {
  state.meta = await api('/meta');
}

// ================= charts =================

function barList(obj, fmt = (v) => v, limit = 10) {
  const entries = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).slice(0, limit);
  if (!entries.length) return '<p class="muted">No data</p>';
  const max = Math.max(...entries.map((e) => e[1])) || 1;
  return `<div class="bars">${entries.map(([k, v]) => `
    <div class="bar-row"><span class="name" title="${esc(k)}">${esc(LABELS.type[k] || LABELS.status[k] || k)}</span>
    <span class="track"><span style="width:${(v / max) * 100}%"></span></span><span class="v">${esc(fmt(v))}</span></div>`).join('')}</div>`;
}

// Monthly hours bar chart with the contract allowance line
function hoursChart(trend, contractMin) {
  const W = 640, H = 220, padL = 36, padB = 26, padT = 14;
  const max = Math.max(contractMin, ...trend.map((t) => t.billable_minutes), 60) * 1.1;
  const bw = (W - padL - 10) / trend.length;
  const y = (v) => H - padB - (v / max) * (H - padB - padT);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round((max / 60) * f));
  const bars = trend.map((t, i) => {
    const x = padL + i * bw + bw * 0.18;
    const over = contractMin && t.billable_minutes > contractMin;
    const [yy, mm] = t.month.split('-');
    return `<rect x="${x}" y="${y(t.billable_minutes)}" width="${bw * 0.64}" height="${Math.max(0, H - padB - y(t.billable_minutes))}"
        rx="3" fill="${over ? '#dc2626' : 'var(--accent)'}"><title>${monthLabel(t.month)}: ${fmtHours(t.billable_minutes)}</title></rect>
      <text x="${x + bw * 0.32}" y="${H - 8}" text-anchor="middle">${mm}/${yy.slice(2)}</text>`;
  }).join('');
  const grid = ticks.map((h) => `<line x1="${padL}" x2="${W - 10}" y1="${y(h * 60)}" y2="${y(h * 60)}" stroke="var(--border)"/>
    <text x="${padL - 6}" y="${y(h * 60) + 4}" text-anchor="end">${h}</text>`).join('');
  const line = contractMin ? `<line x1="${padL}" x2="${W - 10}" y1="${y(contractMin)}" y2="${y(contractMin)}" stroke="#f59e0b" stroke-width="2" stroke-dasharray="6 4"/>
    <text x="${W - 12}" y="${y(contractMin) - 6}" text-anchor="end" style="fill:#d97706;font-weight:600">Allowance ${contractMin / 60} h</text>` : '';
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Billable hours per month">${grid}${bars}${line}</svg></div>`;
}

function meter(used, total, threshold = 80) {
  const pct = total ? (used / total) * 100 : 0;
  const cls = pct >= 100 ? 'bad' : pct >= threshold ? 'warn' : '';
  return `<div class="meter ${cls}"><span style="width:${Math.min(100, pct)}%"></span></div>`;
}

const pctTxt = (v) => (v == null ? '—' : `${v.toLocaleString('en-US')} %`);
const pctCls = (v) => (v == null ? '' : v >= 95 ? 'ok' : v >= 80 ? 'warn' : 'bad');

// ================= dashboard =================

async function renderDashboard() {
  const d = await api('/dashboard');
  const s = state.meta.settings;
  const pct = d.contract_minutes ? Math.round((d.used_minutes / d.contract_minutes) * 100) : 0;
  const threshold = Number(s.alert_threshold_pct) || 80;
  let alert = '';
  if (d.contract_minutes && d.used_minutes > d.contract_minutes) {
    alert = `<div class="alert bad">Allowance exceeded: ${fmtHours(d.used_minutes)} used out of ${fmtHours(d.contract_minutes)} (+${fmtHours(d.used_minutes - d.contract_minutes)} overage).</div>`;
  } else if (pct >= threshold) {
    alert = `<div class="alert warn">Warning: ${pct}% of the monthly allowance used. ${fmtHours(d.contract_minutes - d.used_minutes)} remaining.</div>`;
  } else if (d.contract_minutes && d.projected_minutes > d.contract_minutes) {
    alert = `<div class="alert warn">At the current pace, about ${fmtHours(d.projected_minutes)} will be used this month (allowance ${fmtHours(d.contract_minutes)}).</div>`;
  }

  const ticketRows = (list, empty = 'No tickets') => list.length ? `<div class="table-wrap"><table><tbody>${list.map((t) => `
    <tr class="clickable" data-id="${t.id}"><td class="nowrap">${prioBadge(t.priority)} <b>${esc(t.number)}</b></td>
    <td>${esc(t.title)}</td><td>${statusBadge(t.status)}</td>
    <td class="nowrap">${slaBadge(t.sla_resolution === 'breached' || t.sla_resolution === 'at_risk' ? t.sla_resolution : t.sla_response)}</td></tr>`).join('')}</tbody></table></div>`
    : `<p class="muted">${esc(empty)}</p>`;

  view().innerHTML = `
    <div class="page-head"><div><h1>Dashboard</h1><div class="muted">${esc(s.contract_name)} — ${esc(monthLabel(d.month))}</div></div>
      <div class="actions"><button class="btn primary" id="new-ticket">+ New ticket</button></div></div>
    ${alert}
    <div class="grid cols-4">
      <div class="card stat"><div class="label">Hours used</div>
        <div class="value">${fmtHours(d.used_minutes)} <span class="muted small">/ ${fmtHours(d.contract_minutes)}</span></div>
        ${meter(d.used_minutes, d.contract_minutes, threshold)}
        <div class="sub">${pct}% · ${fmtHours(Math.max(0, d.contract_minutes - d.used_minutes))} left · projected ${fmtHours(d.projected_minutes)}</div></div>
      <div class="card stat"><div class="label">Open tickets</div><div class="value">${d.open_count}</div>
        <div class="sub">${Object.entries(d.by_priority).map(([p, n]) => `${p}: ${n}`).join(' · ')} · unassigned: ${d.unassigned}</div></div>
      <div class="card stat"><div class="label">This month</div><div class="value">${d.created} <span class="muted small">created</span></div>
        <div class="sub">${d.resolved} resolved · SLA resolution ${pctTxt(d.sla_resolution_pct)} · response ${pctTxt(d.sla_response_pct)}</div></div>
      <div class="card stat"><div class="label">SLA alerts</div>
        <div class="value" style="color:${d.breached.length ? 'var(--bad)' : 'inherit'}">${d.breached.length} <span class="muted small">breached</span></div>
        <div class="sub">${d.at_risk.length} at risk</div></div>
    </div>
    <div class="grid cols-2" style="margin-top:16px">
      <div class="card"><h2>Breached / at-risk SLA</h2>${ticketRows([...d.breached, ...d.at_risk], 'Nothing at risk — well done')}</div>
      ${isStaff() ? `<div class="card"><h2>My open tickets</h2>${ticketRows(d.mine, 'No tickets assigned to you')}</div>` : ''}
      <div class="card"><h2>Billable hours — last 6 months</h2>${hoursChart(d.trend, d.contract_minutes)}</div>
      <div class="card"><h2>Open tickets by status</h2>${barList(d.by_status)}</div>
      <div class="card span-2"><h2>Recent activity</h2>${ticketRows(d.recent)}</div>
    </div>
    <p class="muted small">Auto-refreshes every minute.</p>`;
  $('#new-ticket').addEventListener('click', () => newTicketModal());
  $$('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/tickets/${tr.dataset.id}`; }));

  const timer = setInterval(() => {
    if (!modalOpen() && document.visibilityState === 'visible') renderDashboard().catch(() => {});
  }, 60000);
  pageCleanup.push(() => clearInterval(timer));
}

// ================= tickets =================

const ticketFilters = { status: 'open', priority: '', assignee: '', type: '', q: '' };
const ticketSort = { key: null, dir: 1 };

function options(list, selected, withEmpty) {
  return (withEmpty ? `<option value="">${esc(withEmpty)}</option>` : '') +
    list.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(selected ?? '') ? ' selected' : ''}>${esc(l)}</option>`).join('');
}

const statusOptions = () => state.meta.statuses.map((s) => [s, LABELS.status[s]]);
const typeOptions = () => state.meta.types.map((t) => [t, LABELS.type[t]]);
const prioOptions = () => state.meta.policies.map((p) => [p.priority, `${p.priority} — ${p.name}`]);
const staffOptions = () => state.meta.users.filter((u) => u.role !== 'client').map((u) => [u.id, u.name]);
const categoryOptions = () => (state.meta.settings.categories || []).map((c) => [c, c]);

const TICKET_COLUMNS = [
  { key: 'id', label: 'No.', val: (t) => t.id },
  { key: 'title', label: 'Title', val: (t) => t.title.toLowerCase() },
  { key: 'type', label: 'Type', val: (t) => t.type },
  { key: 'status', label: 'Status', val: (t) => state.meta.statuses.indexOf(t.status) },
  { key: 'assignee', label: 'Assignee', val: (t) => (t.assignee_name || '~').toLowerCase() },
  { key: 'sla_response', label: 'Response SLA', val: (t) => t.sla_response },
  { key: 'sla_resolution', label: 'Resolution SLA', val: (t) => t.sla_resolution },
  { key: 'due', label: 'Due', val: (t) => (t.resolved_at ? Infinity : t.effective_resolution_due) },
  { key: 'time', label: 'Time', val: (t) => t.time_minutes, num: true },
  { key: 'created', label: 'Created', val: (t) => t.created_at },
];

async function renderTickets() {
  const f = ticketFilters;
  let rows = [];
  view().innerHTML = `
    <div class="page-head"><h1>Tickets</h1><div class="actions">
      <button class="btn" id="export-csv">Export CSV</button>
      <button class="btn primary" id="new-ticket">+ New ticket</button></div></div>
    <div class="card">
      <div class="filters">
        <input type="search" id="f-q" placeholder="Search (title, number, MS case, requester)…" value="${esc(f.q)}">
        <select id="f-status">${options([['open', 'Open'], ['', 'All'], ...statusOptions()], f.status)}</select>
        <select id="f-priority">${options(prioOptions(), f.priority, 'All priorities')}</select>
        <select id="f-type">${options(typeOptions(), f.type, 'All types')}</select>
        ${isStaff() ? `<select id="f-assignee">${options([['me', 'My tickets'], ['none', 'Unassigned'], ...staffOptions()], f.assignee, 'All engineers')}</select>` : ''}
      </div>
      <div id="ticket-list"></div>
    </div>`;
  $('#new-ticket').addEventListener('click', () => newTicketModal());

  const draw = () => {
    const sorted = [...rows];
    if (ticketSort.key) {
      const col = TICKET_COLUMNS.find((c) => c.key === ticketSort.key);
      sorted.sort((a, b) => {
        const va = col.val(a), vb = col.val(b);
        return (va > vb ? 1 : va < vb ? -1 : 0) * ticketSort.dir;
      });
    }
    $('#ticket-list').innerHTML = sorted.length ? `<div class="table-wrap"><table>
      <thead><tr>${TICKET_COLUMNS.map((c) => `<th class="sortable${c.num ? ' num' : ''}${ticketSort.key === c.key ? (ticketSort.dir > 0 ? ' sorted-asc' : ' sorted-desc') : ''}" data-sort="${c.key}">${c.label}</th>`).join('')}</tr></thead>
      <tbody>${sorted.map((t) => `<tr class="clickable" data-id="${t.id}">
        <td class="nowrap">${prioBadge(t.priority)} <b>${esc(t.number)}</b></td>
        <td>${esc(t.title)}${t.attachment_count ? ` <span class="muted small" title="Attachments">📎${t.attachment_count}</span>` : ''}${t.category ? `<div class="muted small">${esc(t.category)}</div>` : ''}</td>
        <td class="nowrap">${esc(LABELS.type[t.type])}</td>
        <td>${statusBadge(t.status)}</td>
        <td class="nowrap">${esc(t.assignee_name || '—')}</td>
        <td>${slaBadge(t.sla_response)}</td>
        <td>${slaBadge(t.sla_resolution)}</td>
        <td class="nowrap small">${t.resolved_at ? '—' : `${fmtDate(t.effective_resolution_due)}<div class="muted">${fmtRelative(t.effective_resolution_due)}</div>`}</td>
        <td class="num nowrap">${fmtDuration(t.time_minutes)}</td>
        <td class="nowrap small">${fmtDate(t.created_at)}</td></tr>`).join('')}</tbody></table></div>
      <p class="muted small">${sorted.length} ticket(s) · click a column header to sort</p>` : '<p class="muted">No tickets match the filters.</p>';
    $$('#ticket-list tr[data-id]').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/tickets/${tr.dataset.id}`; }));
    $$('#ticket-list th[data-sort]').forEach((th) => th.addEventListener('click', () => {
      if (ticketSort.key === th.dataset.sort) ticketSort.dir *= -1;
      else { ticketSort.key = th.dataset.sort; ticketSort.dir = 1; }
      draw();
    }));
  };

  const reload = async () => {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== '')).toString();
    rows = await api(`/tickets?${qs}`);
    draw();
  };
  const bind = (id, key) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', () => {
      f[key] = el.value;
      clearTimeout(bind.t);
      bind.t = setTimeout(reload, el.tagName === 'INPUT' ? 250 : 0);
    });
  };
  bind('#f-q', 'q'); bind('#f-status', 'status'); bind('#f-priority', 'priority'); bind('#f-type', 'type'); bind('#f-assignee', 'assignee');

  $('#export-csv').addEventListener('click', () => {
    csvDownload(`ora-tickets-${todayLocal()}.csv`,
      ['Number', 'Title', 'Type', 'Priority', 'Status', 'Category', 'Requester', 'Assignee', 'Microsoft case',
        'Created', 'Resolved', 'Response SLA', 'Resolution SLA', 'Hours'],
      rows.map((t) => [t.number, t.title, LABELS.type[t.type], t.priority, LABELS.status[t.status], t.category,
        t.requester_name, t.assignee_name || '', t.ms_case, fmtDate(t.created_at), t.resolved_at ? fmtDate(t.resolved_at) : '',
        LABELS.sla[t.sla_response] || '', LABELS.sla[t.sla_resolution] || '', (t.time_minutes / 60).toFixed(2)]));
  });
  await reload();
}

function newTicketModal() {
  const staffFields = isStaff() ? `
      <label>Requester<input name="requester_name"></label>
      <label>Requester email<input name="requester_email" type="email"></label>
      <label>Assign to<select name="assignee_id">${options(staffOptions(), state.user.role === 'engineer' ? state.user.id : '', 'Unassigned')}</select></label>
      <label>Microsoft case no.<input name="ms_case" placeholder="e.g. 2609270040001234"></label>
      <label class="full">Opening date (if logged after the fact)<input name="created_at" type="datetime-local"></label>` : '';
  openModal(`
    <h2>New ticket</h2>
    <form class="form-grid">
      <label class="full">Title<input name="title" required maxlength="200"></label>
      <label>Type<select name="type">${options(typeOptions(), 'incident')}</select></label>
      <label>Priority<select name="priority">${options(prioOptions(), 'P3')}</select></label>
      <label class="full">Category<select name="category">${options(categoryOptions(), '', '—')}</select></label>
      ${staffFields}
      <label class="full">Description<textarea name="description" rows="6" placeholder="Symptoms, business impact, affected users, error messages…"></textarea></label>
      <label class="full">Attachments (screenshots, logs)<input type="file" name="files" multiple></label>
      <div class="error full"></div>
      <div class="foot full"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Create ticket</button></div>
    </form>`, async (data, form) => {
    const files = [...$('input[type=file]', form).files];
    delete data.files;
    if (data.created_at) {
      // datetime-local is entered in the client's time zone
      data.created_at = Date.parse(`${data.created_at}:00Z`) - offsetMs();
    } else delete data.created_at;
    const r = await api('/tickets', { method: 'POST', body: data });
    for (const file of files) {
      try { await uploadFile(r.id, file); } catch (ex) { toast(ex.message, true); }
    }
    closeModal();
    toast(`Ticket ${r.number} created`);
    location.hash = `#/tickets/${r.id}`;
  });
}

async function renderTicket(id) {
  const { ticket: t, comments, time, history, attachments } = await api(`/tickets/${id}`);
  const staff = isStaff();
  const users = Object.fromEntries(state.meta.users.map((u) => [String(u.id), u.name]));
  const histValue = (field, v) => {
    if (v == null || v === '') return '—';
    if (field === 'status') return LABELS.status[v] || v;
    if (field === 'type') return LABELS.type[v] || v;
    if (field === 'assignee_id') return users[v] || `#${v}`;
    return v;
  };
  const policy = state.meta.policies.find((p) => p.priority === t.priority);
  const timer = getTimer();
  const timerHere = timer && timer.ticketId === t.id;
  const isImage = (a) => /^image\/(png|jpe?g|gif|webp)$/.test(a.mime);
  const canDelete = (a) => isAdmin() || (staff && a.user_id === state.user.id);

  view().innerHTML = `
    <div class="page-head">
      <div><a href="#/tickets" class="small">← Tickets</a>
        <h1>${prioBadge(t.priority)} ${esc(t.number)} — ${esc(t.title)}</h1>
        <div class="muted small">Opened ${fmtDate(t.created_at)} by ${esc(t.created_by_name || '—')} · ${esc(LABELS.type[t.type])}${t.category ? ` · ${esc(t.category)}` : ''}</div></div>
      <div class="actions">${statusBadge(t.status)}
        ${staff ? `<button class="btn${timerHere ? ' running' : ''}" id="timer-btn" data-ticket="${t.id}">${timerHere ? `■ Stop ${fmtClock(Date.now() - timer.start)}` : '▶ Start timer'}</button>
          <button class="btn" id="edit-ticket">Edit</button><button class="btn primary" id="add-time">+ Log time</button>` : ''}
        ${isAdmin() ? '<button class="btn danger" id="del-ticket">Delete</button>' : ''}</div>
    </div>
    <div class="ticket-layout">
      <div class="grid">
        <div class="card"><h2>Description</h2><div class="pre">${esc(t.description) || '<span class="muted">No description</span>'}</div>
          ${t.resolution ? `<h3 style="margin-top:16px">Resolution</h3><div class="pre">${esc(t.resolution)}</div>` : ''}</div>
        <div class="card">
          <div class="tabs" id="tabs">
            <button data-tab="comments" class="active">Conversation (${comments.length})</button>
            <button data-tab="files">Attachments (${attachments.length})</button>
            ${staff ? `<button data-tab="time">Time (${time.length})</button><button data-tab="history">History</button>` : ''}
          </div>
          <div data-panel="comments">
            <div class="timeline">${comments.map((c) => `
              <div class="comment ${c.internal ? 'internal' : ''}"><div class="head"><span><b>${esc(c.user_name || '—')}</b>${c.internal ? ' · internal note' : ''}</span><span>${fmtDate(c.created_at)}</span></div>
              <div class="pre">${esc(c.body)}</div></div>`).join('') || '<p class="muted">No messages yet.</p>'}</div>
            <form id="comment-form" style="margin-top:14px" class="grid">
              <textarea name="body" placeholder="Add a reply or a note…" required></textarea>
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
                ${staff ? '<label class="check"><input type="checkbox" name="internal"> Internal note (hidden from client)</label>' : '<span></span>'}
                <button class="btn primary" type="submit">Send</button></div>
            </form>
          </div>
          <div data-panel="files" class="hidden">
            <div class="attachments">${attachments.map((a) => `
              <div class="attachment">
                ${isImage(a) ? `<img data-thumb="${a.id}" alt="">` : `<span class="file-icon">${esc((a.filename.split('.').pop() || 'file').slice(0, 5))}</span>`}
                <div class="info"><div class="name" title="${esc(a.filename)}">${esc(a.filename)}</div>
                  <div class="muted small">${fmtBytes(a.size)} · ${esc(a.user_name || '—')} · ${fmtDate(a.created_at)}</div></div>
                <button class="btn sm" data-download="${a.id}">Download</button>
                ${canDelete(a) ? `<button class="btn sm danger" data-del-file="${a.id}">✕</button>` : ''}
              </div>`).join('') || '<p class="muted">No attachments.</p>'}</div>
            <div class="dropzone" id="dropzone">Drop files here, click to choose, or paste a screenshot (Ctrl+V) — max ${state.meta.max_upload_mb} MB
              <input type="file" id="file-input" multiple hidden></div>
          </div>
          ${staff ? `<div data-panel="time" class="hidden">
            ${time.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Engineer</th><th>Description</th><th class="num">Duration</th><th>Billable</th><th></th></tr></thead><tbody>
            ${time.map((e) => `<tr><td class="nowrap">${fmtDay(e.work_date)}</td><td>${esc(e.user_name)}</td><td class="pre">${esc(e.description)}</td>
              <td class="num nowrap">${fmtDuration(e.minutes)}</td><td>${e.billable ? 'Yes' : 'No'}</td>
              <td class="nowrap">${isAdmin() || e.user_id === state.user.id ? `<button class="link small" data-edit-time="${e.id}">Edit</button>` : ''}</td></tr>`).join('')}
            </tbody></table></div>` : '<p class="muted">No time logged.</p>'}
          </div>
          <div data-panel="history" class="hidden"><div class="table-wrap"><table><tbody>
            ${history.map((h) => `<tr><td class="nowrap small">${fmtDate(h.created_at)}</td><td>${esc(h.user_name || '—')}</td>
              <td>${esc(LABELS.field[h.field] || h.field)}</td>
              <td>${h.field === 'created' ? '' : `${esc(histValue(h.field, h.old_value))} → <b>${esc(histValue(h.field, h.new_value))}</b>`}</td></tr>`).join('')}
          </tbody></table></div></div>` : ''}
        </div>
      </div>
      <div class="grid">
        <div class="card"><h2>SLA — ${esc(t.priority)} ${esc(policy?.name || '')}</h2>
          <div class="sla-box">
            <div class="sla-item"><div><b>First response</b><div class="muted small">Due ${fmtDate(t.response_due)}${t.first_response_at ? `<br>Responded ${fmtDate(t.first_response_at)}` : `<br>${fmtRelative(t.response_due)}`}</div></div>${slaBadge(t.sla_response)}</div>
            <div class="sla-item"><div><b>Resolution</b><div class="muted small">Due ${fmtDate(t.effective_resolution_due)}${t.resolved_at ? `<br>Resolved ${fmtDate(t.resolved_at)}` : `<br>${fmtRelative(t.effective_resolution_due)}`}</div></div>${slaBadge(t.sla_resolution)}</div>
            <div class="muted small">${policy ? `Targets: response ${fmtDuration(policy.response_min)}, resolution ${fmtDuration(policy.resolution_min)} (${policy.business_hours ? 'business hours' : '24/7'})` : ''}
            ${t.paused_minutes ? `<br>Total paused time: ${fmtDuration(t.paused_minutes)}` : ''}</div>
          </div></div>
        <div class="card"><h2>Details</h2><dl class="kv">
          <dt>Status</dt><dd>${statusBadge(t.status)}</dd>
          <dt>Priority</dt><dd>${prioBadge(t.priority)} ${esc(policy?.name || '')}</dd>
          <dt>Assignee</dt><dd>${esc(t.assignee_name || '—')}</dd>
          <dt>Requester</dt><dd>${esc(t.requester_name || '—')}${t.requester_email ? `<div class="small"><a href="mailto:${esc(t.requester_email)}">${esc(t.requester_email)}</a></div>` : ''}</dd>
          <dt>Microsoft case</dt><dd>${esc(t.ms_case || '—')}</dd>
          <dt>Time spent</dt><dd><b>${fmtDuration(t.time_minutes)}</b></dd>
          <dt>Updated</dt><dd>${fmtDate(t.updated_at)}</dd>
          ${t.closed_at ? `<dt>Closed</dt><dd>${fmtDate(t.closed_at)}</dd>` : ''}
        </dl>
        ${staff ? `<div style="margin-top:14px"><label>Change status<select id="quick-status">${options(statusOptions(), t.status)}</select></label></div>` : ''}
        </div>
      </div>
    </div>`;

  const reload = () => renderTicket(t.id);

  const showTab = (name) => {
    $$('#tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
    $$('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
    renderTicket.tab = name;
  };
  $$('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  if (renderTicket.lastId === t.id && renderTicket.tab && $(`#tabs [data-tab="${renderTicket.tab}"]`)) showTab(renderTicket.tab);
  renderTicket.lastId = t.id;

  $('#comment-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api(`/tickets/${t.id}/comments`, { method: 'POST', body: { body: f.get('body'), internal: !!f.get('internal') } });
      toast('Message added');
      reload();
    } catch (ex) { toast(ex.message, true); }
  });

  // ---- attachments ----
  const objectUrls = [];
  pageCleanup.push(() => objectUrls.forEach((u) => URL.revokeObjectURL(u)));
  $$('img[data-thumb]').forEach(async (img) => {
    try {
      const url = URL.createObjectURL(await fetchBlob(`/attachments/${img.dataset.thumb}?inline=1`));
      objectUrls.push(url);
      img.src = url;
      img.addEventListener('click', () => openModal(`<div class="lightbox"><img src="${url}" alt=""></div>
        <div class="foot"><button class="btn" data-close>Close</button></div>`));
    } catch { /* thumbnail unavailable */ }
  });
  $$('[data-download]').forEach((b) => b.addEventListener('click', () => {
    const a = attachments.find((x) => String(x.id) === b.dataset.download);
    download(`/attachments/${a.id}`, a.filename);
  }));
  $$('[data-del-file]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this attachment?')) return;
    try { await api(`/attachments/${b.dataset.delFile}`, { method: 'DELETE' }); toast('Attachment deleted'); reload(); } catch (ex) { toast(ex.message, true); }
  }));
  const uploadAll = async (files) => {
    if (!files.length) return;
    let ok = 0;
    for (const file of files) {
      try { await uploadFile(t.id, file); ok++; } catch (ex) { toast(ex.message, true); }
    }
    if (ok) { toast(`${ok} file(s) uploaded`); renderTicket.tab = 'files'; reload(); }
  };
  const dz = $('#dropzone');
  const input = $('#file-input');
  dz.addEventListener('click', () => input.click());
  input.addEventListener('change', () => uploadAll([...input.files]));
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); uploadAll([...e.dataTransfer.files]); });
  const onPaste = (e) => {
    if (modalOpen()) return;
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    uploadAll(files.map((f) => (f.name && f.name !== 'image.png' ? f : new File([f], `screenshot-${stamp}.png`, { type: f.type }))));
  };
  document.addEventListener('paste', onPaste);
  pageCleanup.push(() => document.removeEventListener('paste', onPaste));

  if (!staff) return;

  $('#quick-status').addEventListener('change', async (e) => {
    const status = e.target.value;
    if (['resolved', 'closed'].includes(status) && !t.resolution) {
      e.target.value = t.status;
      return editTicketModal(t, { status });
    }
    try {
      await api(`/tickets/${t.id}`, { method: 'PATCH', body: { status } });
      toast(`Status: ${LABELS.status[status]}`);
      reload();
    } catch (ex) { toast(ex.message, true); }
  });
  $('#timer-btn').addEventListener('click', (e) => {
    if (getTimer()?.ticketId === t.id) {
      stopTimer(reload);
    } else if (startTimer(t)) {
      e.target.classList.add('running');
      updateTimerPill();
    }
  });
  $('#edit-ticket').addEventListener('click', () => editTicketModal(t));
  $('#add-time').addEventListener('click', () => timeModal({ ticket_id: t.id }, reload));
  $$('[data-edit-time]').forEach((b) => b.addEventListener('click', () => {
    const entry = time.find((e) => String(e.id) === b.dataset.editTime);
    timeModal(entry, reload);
  }));
  const del = $('#del-ticket');
  if (del) del.addEventListener('click', async () => {
    if (!confirm(`Permanently delete ${t.number}? Linked time entries are kept without a ticket; attachments are deleted.`)) return;
    await api(`/tickets/${t.id}`, { method: 'DELETE' });
    toast('Ticket deleted');
    location.hash = '#/tickets';
  });
}

function editTicketModal(t, preset = {}) {
  const v = { ...t, ...preset };
  openModal(`
    <h2>Edit ${esc(t.number)}</h2>
    <form class="form-grid">
      <label class="full">Title<input name="title" required value="${esc(v.title)}"></label>
      <label>Type<select name="type">${options(typeOptions(), v.type)}</select></label>
      <label>Priority<select name="priority">${options(prioOptions(), v.priority)}</select></label>
      <label>Status<select name="status">${options(statusOptions(), v.status)}</select></label>
      <label>Assignee<select name="assignee_id">${options(staffOptions(), v.assignee_id, 'Unassigned')}</select></label>
      <label>Category<select name="category">${options([...new Set([...(state.meta.settings.categories || []), v.category].filter(Boolean))].map((c) => [c, c]), v.category, '—')}</select></label>
      <label>Microsoft case no.<input name="ms_case" value="${esc(v.ms_case)}"></label>
      <label>Requester<input name="requester_name" value="${esc(v.requester_name)}"></label>
      <label>Requester email<input name="requester_email" type="email" value="${esc(v.requester_email)}"></label>
      <label class="full">Description<textarea name="description" rows="5">${esc(v.description)}</textarea></label>
      <label class="full">Resolution / root cause<textarea name="resolution" rows="4" placeholder="Recommended before resolving or closing">${esc(v.resolution)}</textarea></label>
      <div class="error full"></div>
      <div class="foot full"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div>
    </form>`, async (data) => {
    await api(`/tickets/${t.id}`, { method: 'PATCH', body: data });
    closeModal();
    toast('Ticket updated');
    renderTicket(t.id);
  });
}

// ================= time tracking =================

function timeModal(entry = {}, done, heading) {
  const editing = !!entry.id;
  openModal(`
    <h2>${esc(heading || (editing ? 'Edit time entry' : 'Log time'))}</h2>
    <form class="form-grid">
      ${!editing ? `<label class="full">Ticket (number, or leave empty for non-ticket work: meetings, monthly review…)
        <input name="ticket_id" value="${entry.ticket_id ? esc(ticketNo(entry.ticket_id)) : ''}" placeholder="${esc(ticketNo(12))} or 12"></label>` : ''}
      <label>Date<input name="work_date" type="date" required value="${esc(entry.work_date || todayLocal())}"></label>
      <label>Duration (e.g. 1h30, 45m, 1.5)<input name="duration" required value="${entry.minutes ? esc(durationInput(entry.minutes)) : ''}"></label>
      <label class="full">Work description<textarea name="description" rows="3" required>${esc(entry.description || '')}</textarea></label>
      <label class="check full"><input type="checkbox" name="billable" ${entry.billable === 0 ? '' : 'checked'}> Billable (counts against the monthly allowance)</label>
      <div class="error full"></div>
      <div class="foot full">${editing ? '<button type="button" class="btn danger" id="del-time" style="margin-right:auto">Delete</button>' : ''}
        <button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div>
    </form>`, async (data) => {
    const minutes = parseDuration(data.duration);
    if (!(minutes > 0)) throw new Error('Invalid duration (e.g. 1h30, 45m, 1.5)');
    const body = { work_date: data.work_date, minutes, description: data.description, billable: !!data.billable };
    if (editing) {
      await api(`/time/${entry.id}`, { method: 'PATCH', body });
    } else {
      const m = String(data.ticket_id || '').match(/(\d+)\s*$/);
      if (m) body.ticket_id = Number(m[1]);
      await api('/time', { method: 'POST', body });
    }
    closeModal();
    toast(`${fmtDuration(minutes)} logged`);
    done && done();
  });
  const del = $('#del-time');
  if (del) del.addEventListener('click', async () => {
    if (!confirm('Delete this time entry?')) return;
    await api(`/time/${entry.id}`, { method: 'DELETE' });
    closeModal();
    toast('Time entry deleted');
    done && done();
  });
}

let timeMonth = null;

async function renderTime() {
  timeMonth = timeMonth || currentMonth();
  const rows = await api(`/time?month=${timeMonth}`);
  const s = state.meta.settings;
  const contract = (Number(s.contract_hours_month) || 0) * 60;
  const billable = rows.filter((e) => e.billable).reduce((a, e) => a + e.minutes, 0);
  const total = rows.reduce((a, e) => a + e.minutes, 0);
  const mine = rows.filter((e) => e.user_id === state.user.id).reduce((a, e) => a + e.minutes, 0);
  view().innerHTML = `
    <div class="page-head"><div><h1>Time tracking</h1><div class="muted">${esc(monthLabel(timeMonth))}</div></div>
      <div class="actions"><button class="btn" id="m-prev">‹</button><input type="month" id="m-pick" value="${timeMonth}" style="width:auto"><button class="btn" id="m-next">›</button>
      <button class="btn" id="export-csv">Export CSV</button>
      <button class="btn primary" id="add-time">+ Log time</button></div></div>
    <div class="grid cols-3">
      <div class="card stat"><div class="label">Billable / allowance</div><div class="value">${fmtHours(billable)} <span class="muted small">/ ${fmtHours(contract)}</span></div>
        ${meter(billable, contract, Number(s.alert_threshold_pct) || 80)}<div class="sub">${billable > contract ? `Overage: ${fmtHours(billable - contract)}` : `${fmtHours(contract - billable)} remaining`}</div></div>
      <div class="card stat"><div class="label">Total logged</div><div class="value">${fmtHours(total)}</div><div class="sub">non-billable: ${fmtHours(total - billable)}</div></div>
      <div class="card stat"><div class="label">My entries</div><div class="value">${fmtHours(mine)}</div><div class="sub">${rows.filter((e) => e.user_id === state.user.id).length} entr${rows.filter((e) => e.user_id === state.user.id).length === 1 ? 'y' : 'ies'}</div></div>
    </div>
    <div class="card" style="margin-top:16px">
      ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Ticket</th><th>Engineer</th><th>Description</th><th class="num">Duration</th><th>Billable</th><th></th></tr></thead><tbody>
      ${rows.map((e) => `<tr><td class="nowrap">${fmtDay(e.work_date)}</td>
        <td>${e.ticket_id ? `<a href="#/tickets/${e.ticket_id}"><b>${esc(e.ticket_number)}</b></a><div class="muted small">${esc(e.ticket_title || '')}</div>` : '<span class="muted">Non-ticket</span>'}</td>
        <td class="nowrap">${esc(e.user_name)}</td><td class="pre">${esc(e.description)}</td>
        <td class="num nowrap">${fmtDuration(e.minutes)}</td><td>${e.billable ? 'Yes' : badge('No')}</td>
        <td>${isAdmin() || e.user_id === state.user.id ? `<button class="link small" data-edit="${e.id}">Edit</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">No time logged this month.</p>'}
    </div>`;
  const go = (m) => { timeMonth = m; renderTime(); };
  $('#m-prev').addEventListener('click', () => go(shiftMonth(timeMonth, -1)));
  $('#m-next').addEventListener('click', () => go(shiftMonth(timeMonth, 1)));
  $('#m-pick').addEventListener('change', (e) => e.target.value && go(e.target.value));
  $('#add-time').addEventListener('click', () => timeModal({}, renderTime));
  $('#export-csv').addEventListener('click', () => download(`/reports/monthly.csv?kind=time&month=${timeMonth}`, `ora-time-${timeMonth}.csv`));
  $$('[data-edit]').forEach((b) => b.addEventListener('click', () => timeModal(rows.find((e) => String(e.id) === b.dataset.edit), renderTime)));
}

// ================= reports =================

let reportMonth = null;

async function renderReports() {
  reportMonth = reportMonth || currentMonth();
  const r = await api(`/reports/monthly?month=${reportMonth}`);
  const h = r.hours;
  const showUser = isStaff();

  view().innerHTML = `
    <div class="page-head no-print"><h1>Monthly report</h1>
      <div class="actions"><button class="btn" id="m-prev">‹</button><input type="month" id="m-pick" value="${reportMonth}" style="width:auto"><button class="btn" id="m-next">›</button>
        <button class="btn" id="csv-time">CSV time</button><button class="btn" id="csv-tickets">CSV tickets</button>
        <button class="btn primary" id="print">Print / PDF</button></div></div>

    <div class="report-head">
      <div><div class="muted small">${esc(r.settings.company_name)} → ${esc(r.settings.client_name)}</div>
        <h1>${esc(r.settings.contract_name)}</h1>
        <div>Activity report — <b>${esc(monthLabel(r.month))}</b></div></div>
      <div class="muted small right">Allowance: ${esc(r.settings.contract_hours_month)} h / month<br>Generated ${fmtDate(Date.now())}</div>
    </div>

    <div class="grid cols-4">
      <div class="card stat"><div class="label">Billable hours</div><div class="value">${fmtHours(h.billable_minutes)}</div>
        ${meter(h.billable_minutes, h.contract_minutes)}<div class="sub">${pctTxt(h.usage_pct)} of the ${fmtHours(h.contract_minutes)} allowance</div></div>
      <div class="card stat"><div class="label">${h.overage_minutes ? 'Overage' : 'Remaining balance'}</div>
        <div class="value" style="color:${h.overage_minutes ? 'var(--bad)' : 'var(--ok)'}">${fmtHours(h.overage_minutes || h.remaining_minutes)}</div>
        <div class="sub">Non-billable: ${fmtHours(h.non_billable_minutes)}</div></div>
      <div class="card stat"><div class="label">Tickets</div><div class="value">${r.tickets.created} <span class="muted small">created</span></div>
        <div class="sub">${r.tickets.resolved} resolved · ${r.tickets.open_end_of_month} open at month end${r.tickets.avg_resolution_minutes != null ? ` · avg. resolution ${fmtDuration(r.tickets.avg_resolution_minutes)}` : ''}</div></div>
      <div class="card stat"><div class="label">SLA compliance</div>
        <div class="value">${pctTxt(r.sla.resolution_pct)}</div>
        <div class="sub">Resolution (${r.sla.resolution_met}/${r.sla.resolution_total}) · Response ${pctTxt(r.sla.response_pct)} (${r.sla.response_met}/${r.sla.response_total})</div></div>
    </div>

    <div class="grid cols-2" style="margin-top:16px">
      <div class="card"><h2>SLA by priority</h2><div class="table-wrap"><table>
        <thead><tr><th>Priority</th><th class="num">Response</th><th class="num">Resolution</th></tr></thead><tbody>
        ${r.sla.by_priority.map((p) => `<tr><td>${prioBadge(p.priority)} ${esc(p.name)}</td>
          <td class="num">${p.response_total ? badge(pctTxt(p.response_pct), pctCls(p.response_pct)) : '—'} <span class="muted small">(${p.response_total})</span></td>
          <td class="num">${p.resolution_total ? badge(pctTxt(p.resolution_pct), pctCls(p.resolution_pct)) : '—'} <span class="muted small">(${p.resolution_total})</span></td></tr>`).join('')}
        </tbody></table></div></div>
      <div class="card"><h2>Hours trend (12 months)</h2>${hoursChart(r.trend, h.contract_minutes)}</div>
      <div class="card"><h2>Tickets by category</h2>${barList(r.tickets.by_category)}</div>
      <div class="card"><h2>Hours by category</h2>${barList(h.by_category, fmtHours)}</div>
      <div class="card"><h2>Tickets by type</h2>${barList(r.tickets.by_type)}</div>
      ${Object.keys(h.by_user).length ? `<div class="card"><h2>Hours by engineer</h2>${barList(h.by_user, fmtHours)}</div>`
        : `<div class="card"><h2>Tickets by priority</h2>${barList(r.tickets.by_priority)}</div>`}
    </div>

    <div class="card" style="margin-top:16px"><h2>Tickets handled during the period</h2>
      ${r.ticket_list.length ? `<div class="table-wrap"><table><thead><tr><th>No.</th><th>Title</th><th>Status</th><th>Opened</th><th>Resolved</th><th>Resp. SLA</th><th>Resol. SLA</th><th class="num">Hours (month)</th></tr></thead><tbody>
      ${r.ticket_list.map((t) => `<tr><td class="nowrap">${prioBadge(t.priority)} ${esc(t.number)}</td><td>${esc(t.title)}<div class="muted small">${esc(LABELS.type[t.type])}${t.category ? ` · ${esc(t.category)}` : ''}${t.ms_case ? ` · MS case ${esc(t.ms_case)}` : ''}</div></td>
        <td>${statusBadge(t.status)}</td><td class="nowrap small">${fmtDate(t.created_at, false)}</td><td class="nowrap small">${fmtDate(t.resolved_at, false)}</td>
        <td>${slaBadge(t.sla_response)}</td><td>${slaBadge(t.sla_resolution)}</td><td class="num">${fmtDuration(t.month_minutes)}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">No tickets for this period.</p>'}
    </div>

    <div class="card" style="margin-top:16px"><h2>Work log</h2>
      ${r.entries.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Ticket</th>${showUser ? '<th>Engineer</th>' : ''}<th>Description</th><th class="num">Duration</th><th>Billable</th></tr></thead><tbody>
      ${r.entries.map((e) => `<tr><td class="nowrap">${fmtDay(e.work_date)}</td><td class="nowrap">${e.ticket_number ? esc(e.ticket_number) : '<span class="muted">Non-ticket</span>'}</td>
        ${showUser ? `<td class="nowrap">${esc(e.user_name)}</td>` : ''}<td class="pre">${esc(e.description)}</td><td class="num nowrap">${fmtDuration(e.minutes)}</td><td>${e.billable ? 'Yes' : 'No'}</td></tr>`).join('')}
      <tr><td colspan="${showUser ? 4 : 3}" class="right"><b>Total billable</b></td><td class="num"><b>${fmtDuration(h.billable_minutes)}</b></td><td></td></tr>
      </tbody></table></div>` : '<p class="muted">No work logged.</p>'}
    </div>
    <p class="print-only muted small" style="margin-top:24px">Signed for ${esc(r.settings.company_name)}: ____________________ &nbsp;&nbsp;&nbsp; Approved for ${esc(r.settings.client_name)}: ____________________</p>`;

  const go = (m) => { reportMonth = m; renderReports(); };
  $('#m-prev').addEventListener('click', () => go(shiftMonth(reportMonth, -1)));
  $('#m-next').addEventListener('click', () => go(shiftMonth(reportMonth, 1)));
  $('#m-pick').addEventListener('change', (e) => e.target.value && go(e.target.value));
  $('#print').addEventListener('click', () => window.print());
  $('#csv-time').addEventListener('click', () => download(`/reports/monthly.csv?kind=time&month=${reportMonth}`, `ora-time-${reportMonth}.csv`));
  $('#csv-tickets').addEventListener('click', () => download(`/reports/monthly.csv?kind=tickets&month=${reportMonth}`, `ora-tickets-${reportMonth}.csv`));
}

// ================= settings =================

async function renderSettings() {
  if (!isAdmin()) throw new Error('Administrators only');
  await refreshMeta();
  const s = state.meta.settings;
  const bh = s.business_hours || {};
  const [users, sys] = await Promise.all([api('/users'), api('/admin/system')]);
  const offH = (Number(bh.offset) || 0) / 60;

  view().innerHTML = `
    <div class="page-head"><h1>Settings</h1></div>
    <div class="grid cols-2">
      <div class="card"><h2>Contract</h2>
        <form id="f-contract" class="form-grid">
          <label>Provider<input name="company_name" value="${esc(s.company_name)}"></label>
          <label>Client<input name="client_name" value="${esc(s.client_name)}"></label>
          <label class="full">Contract name<input name="contract_name" value="${esc(s.contract_name)}"></label>
          <label>Allowance (hours / month)<input name="contract_hours_month" type="number" min="0" step="0.5" value="${esc(s.contract_hours_month)}"></label>
          <label>Usage alert (%)<input name="alert_threshold_pct" type="number" min="1" max="100" value="${esc(s.alert_threshold_pct)}"></label>
          <label>Ticket prefix<input name="ticket_prefix" value="${esc(s.ticket_prefix)}" maxlength="10"></label>
          <label>Contract start<input name="contract_start" type="month" value="${esc(s.contract_start)}"></label>
          <label class="full">Categories (one per line)<textarea name="categories" rows="6">${esc((s.categories || []).join('\n'))}</textarea></label>
          <div class="foot full"><button class="btn primary" type="submit">Save</button></div>
        </form></div>

      <div class="card"><h2>Business hours</h2>
        <form id="f-bh" class="form-grid">
          <label>Opens<input name="start" type="time" value="${esc(bh.start)}"></label>
          <label>Closes<input name="end" type="time" value="${esc(bh.end)}"></label>
          <label class="full">Time zone (UTC offset in hours, Iraq = +3)<input name="offset" type="number" step="0.5" value="${offH}"></label>
          <div class="full"><div class="muted small" style="margin-bottom:6px">Working days</div>
            <div style="display:flex;gap:12px;flex-wrap:wrap">${LABELS.days.map((d, i) => `<label class="check"><input type="checkbox" name="day" value="${i}" ${(bh.days || []).includes(i) ? 'checked' : ''}> ${d}</label>`).join('')}</div></div>
          <div class="foot full"><button class="btn primary" type="submit">Save</button></div>
        </form>
        <h2 style="margin-top:22px">SLA policies</h2>
        <div class="table-wrap"><table><thead><tr><th>Prio.</th><th>Name</th><th>Response (min)</th><th>Resolution (min)</th><th>Bus. hours</th></tr></thead><tbody>
          ${state.meta.policies.map((p) => `<tr data-prio="${p.priority}"><td>${prioBadge(p.priority)}</td>
            <td><input name="name" value="${esc(p.name)}"></td>
            <td><input name="response_min" type="number" min="1" value="${p.response_min}"></td>
            <td><input name="resolution_min" type="number" min="1" value="${p.resolution_min}"></td>
            <td><input name="business_hours" type="checkbox" ${p.business_hours ? 'checked' : ''}></td></tr>`).join('')}
        </tbody></table></div>
        <label class="check" style="margin-top:10px"><input type="checkbox" id="sla-recalc" checked> Recalculate due dates of open tickets</label>
        <div class="foot" style="display:flex;justify-content:flex-end;margin-top:10px"><button class="btn primary" id="save-sla">Save SLA policies</button></div>
      </div>

      <div class="card span-2"><div class="page-head" style="margin-bottom:10px"><h2 style="margin:0">Users</h2><button class="btn primary" id="add-user">+ User</button></div>
        <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
        ${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(LABELS.role[u.role])}</td>
          <td>${u.active ? badge('Active', 'ok') : badge('Disabled')}</td><td><button class="link" data-user="${u.id}">Edit</button></td></tr>`).join('')}
        </tbody></table></div>
        <p class="muted small">Roles: <b>Administrator</b> (everything), <b>Engineer</b> (tickets, time, reports), <b>Client</b> (opens and follows their requests, sees reports without internal notes).</p>
      </div>

      <div class="card span-2"><div class="page-head" style="margin-bottom:10px"><h2 style="margin:0">Database &amp; backup</h2><button class="btn primary" id="backup">Download backup</button></div>
        <dl class="info-list">
          <dt>Database file</dt><dd><code>${esc(sys.db_file)}</code> (${fmtBytes(sys.db_bytes)})</dd>
          <dt>Attachments folder</dt><dd><code>${esc(sys.upload_dir)}</code> (${fmtBytes(sys.upload_bytes)})</dd>
          <dt>Records</dt><dd>${sys.counts.tickets} tickets · ${sys.counts.time_entries} time entries · ${sys.counts.users} users · ${sys.counts.attachments} attachments</dd>
          <dt>Server</dt><dd>${esc(sys.host)} · Node.js ${esc(sys.node)}</dd>
        </dl>
        <p class="muted small">The backup is a complete copy of the SQLite database (open it with “DB Browser for SQLite”). To restore: stop the application, replace the database file with the backup, and start again. Attachments are stored as files in the attachments folder — copy that folder too.</p>
      </div>
    </div>`;

  $('#f-contract').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    d.categories = d.categories.split('\n').map((c) => c.trim()).filter(Boolean);
    try {
      await api('/settings', { method: 'PUT', body: d });
      await refreshMeta();
      toast('Contract saved');
    } catch (ex) { toast(ex.message, true); }
  });

  $('#f-bh').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const business_hours = {
      start: f.get('start'), end: f.get('end'), offset: Math.round(Number(f.get('offset')) * 60),
      days: f.getAll('day').map(Number),
    };
    try {
      await api('/settings', { method: 'PUT', body: { business_hours } });
      await api('/sla/recalculate', { method: 'POST', body: {} });
      await refreshMeta();
      toast('Business hours saved, due dates recalculated');
    } catch (ex) { toast(ex.message, true); }
  });

  $('#save-sla').addEventListener('click', async () => {
    try {
      for (const tr of $$('tr[data-prio]')) {
        await api(`/sla/${tr.dataset.prio}`, {
          method: 'PUT',
          body: {
            name: $('[name=name]', tr).value,
            response_min: Number($('[name=response_min]', tr).value),
            resolution_min: Number($('[name=resolution_min]', tr).value),
            business_hours: $('[name=business_hours]', tr).checked,
          },
        });
      }
      if ($('#sla-recalc').checked) await api('/sla/recalculate', { method: 'POST', body: {} });
      await refreshMeta();
      toast('SLA policies saved');
    } catch (ex) { toast(ex.message, true); }
  });

  $('#backup').addEventListener('click', () => download('/admin/backup', `ora-itsm-backup-${todayLocal()}.db`));

  const userModal = (u) => openModal(`
    <h2>${u ? 'Edit user' : 'New user'}</h2>
    <form class="form-grid">
      <label>Name<input name="name" required value="${esc(u?.name || '')}"></label>
      <label>Email<input name="email" type="email" required value="${esc(u?.email || '')}"></label>
      <label>Role<select name="role">${options(Object.entries(LABELS.role), u?.role || 'engineer')}</select></label>
      <label>${u ? 'New password (leave empty to keep)' : 'Password'}<input name="password" type="password" minlength="8" ${u ? '' : 'required'} autocomplete="new-password"></label>
      ${u ? `<label class="check full"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> Account active</label>` : ''}
      <div class="error full"></div>
      <div class="foot full"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div>
    </form>`, async (data) => {
    if (u) {
      data.active = !!data.active;
      if (!data.password) delete data.password;
      await api(`/users/${u.id}`, { method: 'PATCH', body: data });
    } else {
      await api('/users', { method: 'POST', body: data });
    }
    closeModal();
    await refreshMeta();
    toast('User saved');
    renderSettings();
  });

  $('#add-user').addEventListener('click', () => userModal(null));
  $$('[data-user]').forEach((b) => b.addEventListener('click', () => userModal(users.find((u) => String(u.id) === b.dataset.user))));
}

boot();
