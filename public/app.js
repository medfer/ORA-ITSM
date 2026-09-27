'use strict';

// ================= état & utilitaires =================

const state = { token: null, user: null, meta: null };

const LABELS = {
  status: {
    new: 'Nouveau', in_progress: 'En cours', pending_client: 'Attente client',
    pending_microsoft: 'Attente Microsoft', resolved: 'Résolu', closed: 'Clôturé', cancelled: 'Annulé',
  },
  statusClass: {
    new: 'info', in_progress: 'accent', pending_client: 'warn', pending_microsoft: 'warn',
    resolved: 'ok', closed: '', cancelled: '',
  },
  type: { incident: 'Incident', request: 'Demande de service', change: 'Changement', problem: 'Problème' },
  role: { admin: 'Administrateur', engineer: 'Ingénieur', client: 'Client' },
  sla: { met: 'Respecté', breached: 'Dépassé', running: 'Dans les délais', at_risk: 'À risque', paused: 'En pause' },
  slaClass: { met: 'ok', breached: 'bad', running: 'info', at_risk: 'warn', paused: '' },
  days: ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'],
  field: {
    created: 'Création', title: 'Titre', type: 'Type', priority: 'Priorité', status: 'Statut',
    category: 'Catégorie', assignee_id: 'Assigné', ms_case: 'Cas Microsoft',
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

const fmtHours = (min) => `${(Math.round((Number(min) || 0) / 6) / 10).toLocaleString('fr-FR')} h`;

function fmtRelative(ms) {
  const diff = Number(ms) - Date.now();
  const abs = Math.abs(diff) / 60000;
  let s;
  if (abs < 60) s = `${Math.round(abs)} min`;
  else if (abs < 60 * 48) s = `${Math.round(abs / 6) / 10} h`;
  else s = `${Math.round(abs / 1440)} j`;
  return diff >= 0 ? `dans ${s}` : `il y a ${s}`;
}

// "1h30", "1,5", "1.5h", "90", "90m", "45 min" -> minutes
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
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
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
    throw new Error('Session expirée, veuillez vous reconnecter');
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || `Erreur ${res.status}`);
  return data;
}

async function download(path, filename) {
  const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${state.token}` } });
  if (!res.ok) return toast('Téléchargement impossible', true);
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ================= modale =================

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
    const first = $('input, textarea, select', form);
    if (first) first.focus();
  }
}

function closeModal() {
  $('#modal').classList.add('hidden');
  $('#modal-card').innerHTML = '';
}

$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// ================= session =================

async function boot() {
  state.token = localStorage.getItem('ora_token');
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
  route();
}

function logout(callApi = true) {
  if (callApi && state.token) api('/logout', { method: 'POST' }).catch(() => {});
  localStorage.removeItem('ora_token');
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
    localStorage.setItem('ora_token', r.token);
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
    <h2>Changer mon mot de passe</h2>
    <form class="form-grid">
      <label class="full">Mot de passe actuel<input type="password" name="current" required autocomplete="current-password"></label>
      <label class="full">Nouveau mot de passe (8 caractères min.)<input type="password" name="next" minlength="8" required autocomplete="new-password"></label>
      <div class="error full"></div>
      <div class="foot full"><button type="button" class="btn" data-close>Annuler</button><button class="btn primary" type="submit">Enregistrer</button></div>
    </form>`, async (data) => {
    await api('/me/password', { method: 'POST', body: data });
    closeModal();
    toast('Mot de passe modifié');
  });
});

// ================= routeur =================

const routes = {
  dashboard: renderDashboard,
  tickets: renderTickets,
  time: renderTime,
  reports: renderReports,
  settings: renderSettings,
};

async function route() {
  if (!state.user) return;
  const [, name = 'dashboard', id] = location.hash.split('/');
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
  const fn = name === 'tickets' && id ? () => renderTicket(id) : routes[name] || renderDashboard;
  view().innerHTML = '<p class="muted">Chargement…</p>';
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

// ================= graphiques =================

function barList(obj, fmt = (v) => v, limit = 10) {
  const entries = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).slice(0, limit);
  if (!entries.length) return '<p class="muted">Aucune donnée</p>';
  const max = Math.max(...entries.map((e) => e[1])) || 1;
  return `<div class="bars">${entries.map(([k, v]) => `
    <div class="bar-row"><span class="name" title="${esc(k)}">${esc(LABELS.type[k] || LABELS.status[k] || k)}</span>
    <span class="track"><span style="width:${(v / max) * 100}%"></span></span><span class="v">${esc(fmt(v))}</span></div>`).join('')}</div>`;
}

// Histogramme des heures mensuelles avec ligne du forfait contractuel
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
        rx="3" fill="${over ? '#dc2626' : 'var(--accent)'}"><title>${monthLabel(t.month)} : ${fmtHours(t.billable_minutes)}</title></rect>
      <text x="${x + bw * 0.32}" y="${H - 8}" text-anchor="middle">${mm}/${yy.slice(2)}</text>`;
  }).join('');
  const grid = ticks.map((h) => `<line x1="${padL}" x2="${W - 10}" y1="${y(h * 60)}" y2="${y(h * 60)}" stroke="var(--border)"/>
    <text x="${padL - 6}" y="${y(h * 60) + 4}" text-anchor="end">${h}</text>`).join('');
  const line = contractMin ? `<line x1="${padL}" x2="${W - 10}" y1="${y(contractMin)}" y2="${y(contractMin)}" stroke="#f59e0b" stroke-width="2" stroke-dasharray="6 4"/>
    <text x="${W - 12}" y="${y(contractMin) - 6}" text-anchor="end" style="fill:#d97706;font-weight:600">Forfait ${contractMin / 60} h</text>` : '';
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Heures consommées par mois">${grid}${bars}${line}</svg></div>`;
}

function meter(used, total, threshold = 80) {
  const pct = total ? (used / total) * 100 : 0;
  const cls = pct >= 100 ? 'bad' : pct >= threshold ? 'warn' : '';
  return `<div class="meter ${cls}"><span style="width:${Math.min(100, pct)}%"></span></div>`;
}

// ================= tableau de bord =================

async function renderDashboard() {
  const d = await api('/dashboard');
  const s = state.meta.settings;
  const pct = d.contract_minutes ? Math.round((d.used_minutes / d.contract_minutes) * 100) : 0;
  const threshold = Number(s.alert_threshold_pct) || 80;
  let alert = '';
  if (d.contract_minutes && d.used_minutes > d.contract_minutes) {
    alert = `<div class="alert bad">Forfait dépassé : ${fmtHours(d.used_minutes)} consommées sur ${fmtHours(d.contract_minutes)} (+${fmtHours(d.used_minutes - d.contract_minutes)} hors forfait).</div>`;
  } else if (pct >= threshold) {
    alert = `<div class="alert warn">Attention : ${pct} % du forfait mensuel consommé. Il reste ${fmtHours(d.contract_minutes - d.used_minutes)}.</div>`;
  }

  const ticketRows = (list) => list.length ? `<div class="table-wrap"><table><tbody>${list.map((t) => `
    <tr class="clickable" data-id="${t.id}"><td class="nowrap">${prioBadge(t.priority)} <b>${esc(t.number)}</b></td>
    <td>${esc(t.title)}</td><td>${statusBadge(t.status)}</td>
    <td class="nowrap">${slaBadge(t.sla_resolution === 'breached' || t.sla_resolution === 'at_risk' ? t.sla_resolution : t.sla_response)}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">Aucun ticket</p>';

  view().innerHTML = `
    <div class="page-head"><div><h1>Tableau de bord</h1><div class="muted">${esc(s.contract_name)} — ${esc(monthLabel(d.month))}</div></div>
      <div class="actions"><button class="btn primary" id="new-ticket">+ Nouveau ticket</button></div></div>
    ${alert}
    <div class="grid cols-4">
      <div class="card stat"><div class="label">Heures consommées</div>
        <div class="value">${fmtHours(d.used_minutes)} <span class="muted small">/ ${fmtHours(d.contract_minutes)}</span></div>
        ${meter(d.used_minutes, d.contract_minutes, threshold)}
        <div class="sub">${pct} % · reste ${fmtHours(Math.max(0, d.contract_minutes - d.used_minutes))}</div></div>
      <div class="card stat"><div class="label">Tickets ouverts</div><div class="value">${d.open_count}</div>
        <div class="sub">${Object.entries(d.by_priority).map(([p, n]) => `${p}: ${n}`).join(' · ')} · non assignés : ${d.unassigned}</div></div>
      <div class="card stat"><div class="label">Ce mois-ci</div><div class="value">${d.created} <span class="muted small">créés</span></div>
        <div class="sub">${d.resolved} résolus</div></div>
      <div class="card stat"><div class="label">Alertes SLA</div>
        <div class="value" style="color:${d.breached.length ? 'var(--bad)' : 'inherit'}">${d.breached.length} <span class="muted small">dépassés</span></div>
        <div class="sub">${d.at_risk.length} à risque</div></div>
    </div>
    <div class="grid cols-2" style="margin-top:16px">
      <div class="card"><h2>SLA dépassés / à risque</h2>${ticketRows([...d.breached, ...d.at_risk.filter((t) => !d.breached.includes(t))])}</div>
      <div class="card"><h2>Heures facturables — 6 derniers mois</h2>${hoursChart(d.trend, d.contract_minutes)}</div>
      <div class="card span-2"><h2>Activité récente</h2>${ticketRows(d.recent)}</div>
    </div>`;
  $('#new-ticket').addEventListener('click', () => newTicketModal());
  $$('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/tickets/${tr.dataset.id}`; }));
}

// ================= tickets =================

const ticketFilters = { status: 'open', priority: '', assignee: '', type: '', q: '' };

function options(list, selected, withEmpty) {
  return (withEmpty ? `<option value="">${esc(withEmpty)}</option>` : '') +
    list.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(selected ?? '') ? ' selected' : ''}>${esc(l)}</option>`).join('');
}

const statusOptions = () => state.meta.statuses.map((s) => [s, LABELS.status[s]]);
const typeOptions = () => state.meta.types.map((t) => [t, LABELS.type[t]]);
const prioOptions = () => state.meta.policies.map((p) => [p.priority, `${p.priority} — ${p.name}`]);
const staffOptions = () => state.meta.users.filter((u) => u.role !== 'client').map((u) => [u.id, u.name]);
const categoryOptions = () => (state.meta.settings.categories || []).map((c) => [c, c]);

async function renderTickets() {
  const f = ticketFilters;
  view().innerHTML = `
    <div class="page-head"><h1>Tickets</h1><div class="actions"><button class="btn primary" id="new-ticket">+ Nouveau ticket</button></div></div>
    <div class="card">
      <div class="filters">
        <input type="search" id="f-q" placeholder="Rechercher (titre, n°, cas MS, demandeur)…" value="${esc(f.q)}">
        <select id="f-status">${options([['open', 'Ouverts'], ['', 'Tous'], ...statusOptions()], f.status)}</select>
        <select id="f-priority">${options(prioOptions(), f.priority, 'Toutes priorités')}</select>
        <select id="f-type">${options(typeOptions(), f.type, 'Tous types')}</select>
        ${isStaff() ? `<select id="f-assignee">${options([['me', 'Mes tickets'], ['none', 'Non assignés'], ...staffOptions()], f.assignee, 'Tous intervenants')}</select>` : ''}
      </div>
      <div id="ticket-list"></div>
    </div>`;
  $('#new-ticket').addEventListener('click', () => newTicketModal());
  const reload = async () => {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== '')).toString();
    const rows = await api(`/tickets?${qs}`);
    $('#ticket-list').innerHTML = rows.length ? `<div class="table-wrap"><table>
      <thead><tr><th>N°</th><th>Titre</th><th>Type</th><th>Statut</th><th>Assigné</th><th>SLA réponse</th><th>SLA résolution</th><th>Échéance</th><th class="num">Temps</th><th>Créé</th></tr></thead>
      <tbody>${rows.map((t) => `<tr class="clickable" data-id="${t.id}">
        <td class="nowrap">${prioBadge(t.priority)} <b>${esc(t.number)}</b></td>
        <td>${esc(t.title)}${t.category ? `<div class="muted small">${esc(t.category)}</div>` : ''}</td>
        <td class="nowrap">${esc(LABELS.type[t.type])}</td>
        <td>${statusBadge(t.status)}</td>
        <td class="nowrap">${esc(t.assignee_name || '—')}</td>
        <td>${slaBadge(t.sla_response)}</td>
        <td>${slaBadge(t.sla_resolution)}</td>
        <td class="nowrap small">${t.resolved_at ? '—' : `${fmtDate(t.effective_resolution_due)}<div class="muted">${fmtRelative(t.effective_resolution_due)}</div>`}</td>
        <td class="num nowrap">${fmtDuration(t.time_minutes)}</td>
        <td class="nowrap small">${fmtDate(t.created_at)}</td></tr>`).join('')}</tbody></table></div>
      <p class="muted small">${rows.length} ticket(s)</p>` : '<p class="muted">Aucun ticket ne correspond aux filtres.</p>';
    $$('#ticket-list tr[data-id]').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/tickets/${tr.dataset.id}`; }));
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
  await reload();
}

function newTicketModal() {
  const staffFields = isStaff() ? `
      <label>Demandeur<input name="requester_name"></label>
      <label>Email demandeur<input name="requester_email" type="email"></label>
      <label>Assigné à<select name="assignee_id">${options(staffOptions(), state.user.role === 'engineer' ? state.user.id : '', 'Non assigné')}</select></label>
      <label>N° cas Microsoft<input name="ms_case" placeholder="ex. 2609270040001234"></label>
      <label class="full">Date d'ouverture (si saisie a posteriori)<input name="created_at" type="datetime-local"></label>` : '';
  openModal(`
    <h2>Nouveau ticket</h2>
    <form class="form-grid">
      <label class="full">Titre<input name="title" required maxlength="200"></label>
      <label>Type<select name="type">${options(typeOptions(), 'incident')}</select></label>
      <label>Priorité<select name="priority">${options(prioOptions(), 'P3')}</select></label>
      <label class="full">Catégorie<select name="category">${options(categoryOptions(), '', '—')}</select></label>
      ${staffFields}
      <label class="full">Description<textarea name="description" rows="6" placeholder="Symptômes, impact, utilisateurs concernés, messages d'erreur…"></textarea></label>
      <div class="error full"></div>
      <div class="foot full"><button type="button" class="btn" data-close>Annuler</button><button class="btn primary" type="submit">Créer le ticket</button></div>
    </form>`, async (data) => {
    if (data.created_at) {
      // datetime-local est saisi dans le fuseau du client
      data.created_at = Date.parse(`${data.created_at}:00Z`) - offsetMs();
    } else delete data.created_at;
    const r = await api('/tickets', { method: 'POST', body: data });
    closeModal();
    toast(`Ticket ${r.number} créé`);
    location.hash = `#/tickets/${r.id}`;
  });
}

async function renderTicket(id) {
  const { ticket: t, comments, time, history } = await api(`/tickets/${id}`);
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

  view().innerHTML = `
    <div class="page-head">
      <div><a href="#/tickets" class="small">← Tickets</a>
        <h1>${prioBadge(t.priority)} ${esc(t.number)} — ${esc(t.title)}</h1>
        <div class="muted small">Ouvert le ${fmtDate(t.created_at)} par ${esc(t.created_by_name || '—')} · ${esc(LABELS.type[t.type])}${t.category ? ` · ${esc(t.category)}` : ''}</div></div>
      <div class="actions">${statusBadge(t.status)}
        ${staff ? '<button class="btn" id="edit-ticket">Modifier</button><button class="btn primary" id="add-time">+ Temps</button>' : ''}
        ${isAdmin() ? '<button class="btn danger" id="del-ticket">Supprimer</button>' : ''}</div>
    </div>
    <div class="ticket-layout">
      <div class="grid">
        <div class="card"><h2>Description</h2><div class="pre">${esc(t.description) || '<span class="muted">Aucune description</span>'}</div>
          ${t.resolution ? `<h3 style="margin-top:16px">Résolution</h3><div class="pre">${esc(t.resolution)}</div>` : ''}</div>
        <div class="card">
          <div class="tabs" id="tabs">
            <button data-tab="comments" class="active">Échanges (${comments.length})</button>
            ${staff ? `<button data-tab="time">Temps (${time.length})</button><button data-tab="history">Historique</button>` : ''}
          </div>
          <div data-panel="comments">
            <div class="timeline">${comments.map((c) => `
              <div class="comment ${c.internal ? 'internal' : ''}"><div class="head"><span><b>${esc(c.user_name || '—')}</b>${c.internal ? ' · note interne' : ''}</span><span>${fmtDate(c.created_at)}</span></div>
              <div class="pre">${esc(c.body)}</div></div>`).join('') || '<p class="muted">Aucun échange pour le moment.</p>'}</div>
            <form id="comment-form" style="margin-top:14px" class="grid">
              <textarea name="body" placeholder="Ajouter une réponse ou une note…" required></textarea>
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
                ${staff ? '<label class="check"><input type="checkbox" name="internal"> Note interne (invisible pour le client)</label>' : '<span></span>'}
                <button class="btn primary" type="submit">Envoyer</button></div>
            </form>
          </div>
          ${staff ? `<div data-panel="time" class="hidden">
            ${time.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Intervenant</th><th>Description</th><th class="num">Durée</th><th>Fact.</th><th></th></tr></thead><tbody>
            ${time.map((e) => `<tr><td class="nowrap">${fmtDay(e.work_date)}</td><td>${esc(e.user_name)}</td><td class="pre">${esc(e.description)}</td>
              <td class="num nowrap">${fmtDuration(e.minutes)}</td><td>${e.billable ? 'Oui' : 'Non'}</td>
              <td class="nowrap">${isAdmin() || e.user_id === state.user.id ? `<button class="link small" data-edit-time="${e.id}">Modifier</button>` : ''}</td></tr>`).join('')}
            </tbody></table></div>` : '<p class="muted">Aucun temps saisi.</p>'}
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
            <div class="sla-item"><div><b>Première réponse</b><div class="muted small">Échéance ${fmtDate(t.response_due)}${t.first_response_at ? `<br>Répondu le ${fmtDate(t.first_response_at)}` : `<br>${fmtRelative(t.response_due)}`}</div></div>${slaBadge(t.sla_response)}</div>
            <div class="sla-item"><div><b>Résolution</b><div class="muted small">Échéance ${fmtDate(t.effective_resolution_due)}${t.resolved_at ? `<br>Résolu le ${fmtDate(t.resolved_at)}` : `<br>${fmtRelative(t.effective_resolution_due)}`}</div></div>${slaBadge(t.sla_resolution)}</div>
            <div class="muted small">${policy ? `Objectifs : réponse ${fmtDuration(policy.response_min)}, résolution ${fmtDuration(policy.resolution_min)} (${policy.business_hours ? 'heures ouvrées' : '24/7'})` : ''}
            ${t.paused_minutes ? `<br>Temps en pause cumulé : ${fmtDuration(t.paused_minutes)}` : ''}</div>
          </div></div>
        <div class="card"><h2>Détails</h2><dl class="kv">
          <dt>Statut</dt><dd>${statusBadge(t.status)}</dd>
          <dt>Priorité</dt><dd>${prioBadge(t.priority)} ${esc(policy?.name || '')}</dd>
          <dt>Assigné à</dt><dd>${esc(t.assignee_name || '—')}</dd>
          <dt>Demandeur</dt><dd>${esc(t.requester_name || '—')}${t.requester_email ? `<div class="small"><a href="mailto:${esc(t.requester_email)}">${esc(t.requester_email)}</a></div>` : ''}</dd>
          <dt>Cas Microsoft</dt><dd>${esc(t.ms_case || '—')}</dd>
          <dt>Temps passé</dt><dd><b>${fmtDuration(t.time_minutes)}</b></dd>
          <dt>Mis à jour</dt><dd>${fmtDate(t.updated_at)}</dd>
          ${t.closed_at ? `<dt>Clôturé</dt><dd>${fmtDate(t.closed_at)}</dd>` : ''}
        </dl>
        ${staff ? `<div style="margin-top:14px"><label>Changer le statut<select id="quick-status">${options(statusOptions(), t.status)}</select></label></div>` : ''}
        </div>
      </div>
    </div>`;

  $$('#tabs button').forEach((b) => b.addEventListener('click', () => {
    $$('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
    $$('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== b.dataset.tab));
  }));

  $('#comment-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api(`/tickets/${t.id}/comments`, { method: 'POST', body: { body: f.get('body'), internal: !!f.get('internal') } });
      toast('Message ajouté');
      renderTicket(t.id);
    } catch (ex) { toast(ex.message, true); }
  });

  if (!staff) return;

  $('#quick-status').addEventListener('change', async (e) => {
    const status = e.target.value;
    if (['resolved', 'closed'].includes(status) && !t.resolution) {
      return editTicketModal(t, { status });
    }
    try {
      await api(`/tickets/${t.id}`, { method: 'PATCH', body: { status } });
      toast(`Statut : ${LABELS.status[status]}`);
      renderTicket(t.id);
    } catch (ex) { toast(ex.message, true); }
  });
  $('#edit-ticket').addEventListener('click', () => editTicketModal(t));
  $('#add-time').addEventListener('click', () => timeModal({ ticket_id: t.id }, () => renderTicket(t.id)));
  $$('[data-edit-time]').forEach((b) => b.addEventListener('click', () => {
    const entry = time.find((e) => String(e.id) === b.dataset.editTime);
    timeModal(entry, () => renderTicket(t.id));
  }));
  const del = $('#del-ticket');
  if (del) del.addEventListener('click', async () => {
    if (!confirm(`Supprimer définitivement ${t.number} ? Les saisies de temps liées seront conservées sans ticket.`)) return;
    await api(`/tickets/${t.id}`, { method: 'DELETE' });
    toast('Ticket supprimé');
    location.hash = '#/tickets';
  });
}

function editTicketModal(t, preset = {}) {
  const v = { ...t, ...preset };
  openModal(`
    <h2>Modifier ${esc(t.number)}</h2>
    <form class="form-grid">
      <label class="full">Titre<input name="title" required value="${esc(v.title)}"></label>
      <label>Type<select name="type">${options(typeOptions(), v.type)}</select></label>
      <label>Priorité<select name="priority">${options(prioOptions(), v.priority)}</select></label>
      <label>Statut<select name="status">${options(statusOptions(), v.status)}</select></label>
      <label>Assigné à<select name="assignee_id">${options(staffOptions(), v.assignee_id, 'Non assigné')}</select></label>
      <label>Catégorie<select name="category">${options([...new Set([...(state.meta.settings.categories || []), v.category].filter(Boolean))].map((c) => [c, c]), v.category, '—')}</select></label>
      <label>N° cas Microsoft<input name="ms_case" value="${esc(v.ms_case)}"></label>
      <label>Demandeur<input name="requester_name" value="${esc(v.requester_name)}"></label>
      <label>Email demandeur<input name="requester_email" type="email" value="${esc(v.requester_email)}"></label>
      <label class="full">Description<textarea name="description" rows="5">${esc(v.description)}</textarea></label>
      <label class="full">Résolution / cause racine<textarea name="resolution" rows="4" placeholder="Obligatoire recommandé pour résoudre ou clôturer">${esc(v.resolution)}</textarea></label>
      <div class="error full"></div>
      <div class="foot full"><button type="button" class="btn" data-close>Annuler</button><button class="btn primary" type="submit">Enregistrer</button></div>
    </form>`, async (data) => {
    await api(`/tickets/${t.id}`, { method: 'PATCH', body: data });
    closeModal();
    toast('Ticket mis à jour');
    renderTicket(t.id);
  });
}

// ================= temps passé =================

function timeModal(entry = {}, done) {
  const editing = !!entry.id;
  openModal(`
    <h2>${editing ? 'Modifier la saisie' : 'Saisir du temps'}</h2>
    <form class="form-grid">
      ${!editing ? `<label class="full">Ticket (n° ou vide pour une activité hors ticket : réunion, revue mensuelle…)
        <input name="ticket_id" value="${entry.ticket_id ? esc(ticketNo(entry.ticket_id)) : ''}" placeholder="${esc(ticketNo(12))} ou 12"></label>` : ''}
      <label>Date<input name="work_date" type="date" required value="${esc(entry.work_date || todayLocal())}"></label>
      <label>Durée (ex. 1h30, 45m, 1,5)<input name="duration" required value="${entry.minutes ? esc(fmtDuration(entry.minutes).replace(' h ', 'h').replace(' min', 'm').replace(' h', 'h')) : ''}"></label>
      <label class="full">Description du travail<textarea name="description" rows="3" required>${esc(entry.description || '')}</textarea></label>
      <label class="check full"><input type="checkbox" name="billable" ${entry.billable === 0 ? '' : 'checked'}> Facturable (décompté du forfait mensuel)</label>
      <div class="error full"></div>
      <div class="foot full">${editing ? '<button type="button" class="btn danger" id="del-time" style="margin-right:auto">Supprimer</button>' : ''}
        <button type="button" class="btn" data-close>Annuler</button><button class="btn primary" type="submit">Enregistrer</button></div>
    </form>`, async (data) => {
    const minutes = parseDuration(data.duration);
    if (!(minutes > 0)) throw new Error('Durée invalide (ex. 1h30, 45m, 1,5)');
    const body = { work_date: data.work_date, minutes, description: data.description, billable: !!data.billable };
    if (editing) {
      await api(`/time/${entry.id}`, { method: 'PATCH', body });
    } else {
      const m = String(data.ticket_id || '').match(/(\d+)\s*$/);
      if (m) body.ticket_id = Number(m[1]);
      await api('/time', { method: 'POST', body });
    }
    closeModal();
    toast(`${fmtDuration(minutes)} enregistré`);
    done && done();
  });
  const del = $('#del-time');
  if (del) del.addEventListener('click', async () => {
    if (!confirm('Supprimer cette saisie ?')) return;
    await api(`/time/${entry.id}`, { method: 'DELETE' });
    closeModal();
    toast('Saisie supprimée');
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
    <div class="page-head"><div><h1>Temps passé</h1><div class="muted">${esc(monthLabel(timeMonth))}</div></div>
      <div class="actions"><button class="btn" id="m-prev">‹</button><input type="month" id="m-pick" value="${timeMonth}" style="width:auto"><button class="btn" id="m-next">›</button>
      <button class="btn primary" id="add-time">+ Saisir du temps</button></div></div>
    <div class="grid cols-3">
      <div class="card stat"><div class="label">Facturable / forfait</div><div class="value">${fmtHours(billable)} <span class="muted small">/ ${fmtHours(contract)}</span></div>
        ${meter(billable, contract, Number(s.alert_threshold_pct) || 80)}<div class="sub">${billable > contract ? `Dépassement : ${fmtHours(billable - contract)}` : `Reste ${fmtHours(contract - billable)}`}</div></div>
      <div class="card stat"><div class="label">Total saisi</div><div class="value">${fmtHours(total)}</div><div class="sub">dont non facturable : ${fmtHours(total - billable)}</div></div>
      <div class="card stat"><div class="label">Mes saisies</div><div class="value">${fmtHours(mine)}</div><div class="sub">${rows.filter((e) => e.user_id === state.user.id).length} entrée(s)</div></div>
    </div>
    <div class="card" style="margin-top:16px">
      ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Ticket</th><th>Intervenant</th><th>Description</th><th class="num">Durée</th><th>Fact.</th><th></th></tr></thead><tbody>
      ${rows.map((e) => `<tr><td class="nowrap">${fmtDay(e.work_date)}</td>
        <td>${e.ticket_id ? `<a href="#/tickets/${e.ticket_id}"><b>${esc(e.ticket_number)}</b></a><div class="muted small">${esc(e.ticket_title || '')}</div>` : '<span class="muted">Hors ticket</span>'}</td>
        <td class="nowrap">${esc(e.user_name)}</td><td class="pre">${esc(e.description)}</td>
        <td class="num nowrap">${fmtDuration(e.minutes)}</td><td>${e.billable ? 'Oui' : badge('Non')}</td>
        <td>${isAdmin() || e.user_id === state.user.id ? `<button class="link small" data-edit="${e.id}">Modifier</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">Aucune saisie ce mois-ci.</p>'}
    </div>`;
  const go = (m) => { timeMonth = m; renderTime(); };
  $('#m-prev').addEventListener('click', () => go(shiftMonth(timeMonth, -1)));
  $('#m-next').addEventListener('click', () => go(shiftMonth(timeMonth, 1)));
  $('#m-pick').addEventListener('change', (e) => e.target.value && go(e.target.value));
  $('#add-time').addEventListener('click', () => timeModal({}, renderTime));
  $$('[data-edit]').forEach((b) => b.addEventListener('click', () => timeModal(rows.find((e) => String(e.id) === b.dataset.edit), renderTime)));
}

// ================= rapports =================

let reportMonth = null;

async function renderReports() {
  reportMonth = reportMonth || currentMonth();
  const r = await api(`/reports/monthly?month=${reportMonth}`);
  const h = r.hours;
  const pctTxt = (v) => (v == null ? '—' : `${v.toLocaleString('fr-FR')} %`);
  const pctCls = (v) => (v == null ? '' : v >= 95 ? 'ok' : v >= 80 ? 'warn' : 'bad');

  view().innerHTML = `
    <div class="page-head no-print"><h1>Rapport mensuel</h1>
      <div class="actions"><button class="btn" id="m-prev">‹</button><input type="month" id="m-pick" value="${reportMonth}" style="width:auto"><button class="btn" id="m-next">›</button>
        <button class="btn" id="csv-time">CSV temps</button><button class="btn" id="csv-tickets">CSV tickets</button>
        <button class="btn primary" id="print">Imprimer / PDF</button></div></div>

    <div class="report-head">
      <div><div class="muted small">${esc(r.settings.company_name)} → ${esc(r.settings.client_name)}</div>
        <h1>${esc(r.settings.contract_name)}</h1>
        <div>Rapport d'activité — <b>${esc(monthLabel(r.month))}</b></div></div>
      <div class="muted small right">Forfait : ${esc(r.settings.contract_hours_month)} h / mois<br>Édité le ${fmtDate(Date.now())}</div>
    </div>

    <div class="grid cols-4">
      <div class="card stat"><div class="label">Heures facturables</div><div class="value">${fmtHours(h.billable_minutes)}</div>
        ${meter(h.billable_minutes, h.contract_minutes)}<div class="sub">${pctTxt(h.usage_pct)} du forfait de ${fmtHours(h.contract_minutes)}</div></div>
      <div class="card stat"><div class="label">${h.overage_minutes ? 'Hors forfait' : 'Solde restant'}</div>
        <div class="value" style="color:${h.overage_minutes ? 'var(--bad)' : 'var(--ok)'}">${fmtHours(h.overage_minutes || h.remaining_minutes)}</div>
        <div class="sub">Non facturable : ${fmtHours(h.non_billable_minutes)}</div></div>
      <div class="card stat"><div class="label">Tickets</div><div class="value">${r.tickets.created} <span class="muted small">créés</span></div>
        <div class="sub">${r.tickets.resolved} résolus · ${r.tickets.open_end_of_month} ouverts en fin de mois</div></div>
      <div class="card stat"><div class="label">Conformité SLA</div>
        <div class="value">${pctTxt(r.sla.resolution_pct)}</div>
        <div class="sub">Résolution (${r.sla.resolution_met}/${r.sla.resolution_total}) · Réponse ${pctTxt(r.sla.response_pct)} (${r.sla.response_met}/${r.sla.response_total})</div></div>
    </div>

    <div class="grid cols-2" style="margin-top:16px">
      <div class="card"><h2>SLA par priorité</h2><div class="table-wrap"><table>
        <thead><tr><th>Priorité</th><th class="num">Réponse</th><th class="num">Résolution</th></tr></thead><tbody>
        ${r.sla.by_priority.map((p) => `<tr><td>${prioBadge(p.priority)} ${esc(p.name)}</td>
          <td class="num">${p.response_total ? badge(pctTxt(p.response_pct), pctCls(p.response_pct)) : '—'} <span class="muted small">(${p.response_total})</span></td>
          <td class="num">${p.resolution_total ? badge(pctTxt(p.resolution_pct), pctCls(p.resolution_pct)) : '—'} <span class="muted small">(${p.resolution_total})</span></td></tr>`).join('')}
        </tbody></table></div></div>
      <div class="card"><h2>Évolution des heures (12 mois)</h2>${hoursChart(r.trend, h.contract_minutes)}</div>
      <div class="card"><h2>Tickets par catégorie</h2>${barList(r.tickets.by_category)}</div>
      <div class="card"><h2>Heures par catégorie</h2>${barList(h.by_category, fmtHours)}</div>
      <div class="card"><h2>Tickets par type</h2>${barList(r.tickets.by_type)}</div>
      ${Object.keys(h.by_user).length ? `<div class="card"><h2>Heures par intervenant</h2>${barList(h.by_user, fmtHours)}</div>`
        : `<div class="card"><h2>Tickets par priorité</h2>${barList(r.tickets.by_priority)}</div>`}
    </div>

    <div class="card" style="margin-top:16px"><h2>Tickets traités sur la période</h2>
      ${r.ticket_list.length ? `<div class="table-wrap"><table><thead><tr><th>N°</th><th>Titre</th><th>Statut</th><th>Ouvert</th><th>Résolu</th><th>SLA rép.</th><th>SLA résol.</th><th class="num">Heures (mois)</th></tr></thead><tbody>
      ${r.ticket_list.map((t) => `<tr><td class="nowrap">${prioBadge(t.priority)} ${esc(t.number)}</td><td>${esc(t.title)}<div class="muted small">${esc(LABELS.type[t.type])}${t.category ? ` · ${esc(t.category)}` : ''}${t.ms_case ? ` · Cas MS ${esc(t.ms_case)}` : ''}</div></td>
        <td>${statusBadge(t.status)}</td><td class="nowrap small">${fmtDate(t.created_at, false)}</td><td class="nowrap small">${fmtDate(t.resolved_at, false)}</td>
        <td>${slaBadge(t.sla_response)}</td><td>${slaBadge(t.sla_resolution)}</td><td class="num">${fmtDuration(t.month_minutes)}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">Aucun ticket sur la période.</p>'}
    </div>

    <div class="card" style="margin-top:16px"><h2>Détail des interventions</h2>
      ${r.entries.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Ticket</th>${isStaff() ? '<th>Intervenant</th>' : ''}<th>Description</th><th class="num">Durée</th><th>Fact.</th></tr></thead><tbody>
      ${r.entries.map((e) => `<tr><td class="nowrap">${fmtDay(e.work_date)}</td><td class="nowrap">${e.ticket_number ? esc(e.ticket_number) : '<span class="muted">Hors ticket</span>'}</td>
        ${isStaff() ? `<td class="nowrap">${esc(e.user_name)}</td>` : ''}<td class="pre">${esc(e.description)}</td><td class="num nowrap">${fmtDuration(e.minutes)}</td><td>${e.billable ? 'Oui' : 'Non'}</td></tr>`).join('')}
      <tr><td colspan="${isStaff() ? 4 : 3}" class="right"><b>Total facturable</b></td><td class="num"><b>${fmtDuration(h.billable_minutes)}</b></td><td></td></tr>
      </tbody></table></div>` : '<p class="muted">Aucune intervention saisie.</p>'}
    </div>
    <p class="print-only muted small" style="margin-top:24px">Signature ${esc(r.settings.company_name)} : ____________________ &nbsp;&nbsp;&nbsp; Validation ${esc(r.settings.client_name)} : ____________________</p>`;

  const go = (m) => { reportMonth = m; renderReports(); };
  $('#m-prev').addEventListener('click', () => go(shiftMonth(reportMonth, -1)));
  $('#m-next').addEventListener('click', () => go(shiftMonth(reportMonth, 1)));
  $('#m-pick').addEventListener('change', (e) => e.target.value && go(e.target.value));
  $('#print').addEventListener('click', () => window.print());
  $('#csv-time').addEventListener('click', () => download(`/reports/monthly.csv?kind=time&month=${reportMonth}`, `ora-temps-${reportMonth}.csv`));
  $('#csv-tickets').addEventListener('click', () => download(`/reports/monthly.csv?kind=tickets&month=${reportMonth}`, `ora-tickets-${reportMonth}.csv`));
}

// ================= paramètres =================

async function renderSettings() {
  if (!isAdmin()) throw new Error('Réservé aux administrateurs');
  await refreshMeta();
  const s = state.meta.settings;
  const bh = s.business_hours || {};
  const users = await api('/users');
  const offH = (Number(bh.offset) || 0) / 60;

  view().innerHTML = `
    <div class="page-head"><h1>Paramètres</h1></div>
    <div class="grid cols-2">
      <div class="card"><h2>Contrat</h2>
        <form id="f-contract" class="form-grid">
          <label>Prestataire<input name="company_name" value="${esc(s.company_name)}"></label>
          <label>Client<input name="client_name" value="${esc(s.client_name)}"></label>
          <label class="full">Nom du contrat<input name="contract_name" value="${esc(s.contract_name)}"></label>
          <label>Forfait (heures / mois)<input name="contract_hours_month" type="number" min="0" step="0.5" value="${esc(s.contract_hours_month)}"></label>
          <label>Alerte consommation (%)<input name="alert_threshold_pct" type="number" min="1" max="100" value="${esc(s.alert_threshold_pct)}"></label>
          <label>Préfixe des tickets<input name="ticket_prefix" value="${esc(s.ticket_prefix)}" maxlength="10"></label>
          <label>Début du contrat<input name="contract_start" type="month" value="${esc(s.contract_start)}"></label>
          <label class="full">Catégories (une par ligne)<textarea name="categories" rows="6">${esc((s.categories || []).join('\n'))}</textarea></label>
          <div class="foot full"><button class="btn primary" type="submit">Enregistrer</button></div>
        </form></div>

      <div class="card"><h2>Heures ouvrées</h2>
        <form id="f-bh" class="form-grid">
          <label>Ouverture<input name="start" type="time" value="${esc(bh.start)}"></label>
          <label>Fermeture<input name="end" type="time" value="${esc(bh.end)}"></label>
          <label class="full">Fuseau (décalage UTC en heures, Irak = +3)<input name="offset" type="number" step="0.5" value="${offH}"></label>
          <div class="full"><div class="muted small" style="margin-bottom:6px">Jours ouvrés</div>
            <div style="display:flex;gap:12px;flex-wrap:wrap">${LABELS.days.map((d, i) => `<label class="check"><input type="checkbox" name="day" value="${i}" ${(bh.days || []).includes(i) ? 'checked' : ''}> ${d}</label>`).join('')}</div></div>
          <div class="foot full"><button class="btn primary" type="submit">Enregistrer</button></div>
        </form>
        <h2 style="margin-top:22px">Politiques SLA</h2>
        <div class="table-wrap"><table><thead><tr><th>Prio.</th><th>Nom</th><th>Réponse (min)</th><th>Résolution (min)</th><th>H. ouvrées</th></tr></thead><tbody>
          ${state.meta.policies.map((p) => `<tr data-prio="${p.priority}"><td>${prioBadge(p.priority)}</td>
            <td><input name="name" value="${esc(p.name)}"></td>
            <td><input name="response_min" type="number" min="1" value="${p.response_min}"></td>
            <td><input name="resolution_min" type="number" min="1" value="${p.resolution_min}"></td>
            <td><input name="business_hours" type="checkbox" ${p.business_hours ? 'checked' : ''}></td></tr>`).join('')}
        </tbody></table></div>
        <label class="check" style="margin-top:10px"><input type="checkbox" id="sla-recalc" checked> Recalculer les échéances des tickets ouverts</label>
        <div class="foot" style="display:flex;justify-content:flex-end;margin-top:10px"><button class="btn primary" id="save-sla">Enregistrer les SLA</button></div>
      </div>

      <div class="card span-2"><div class="page-head" style="margin-bottom:10px"><h2 style="margin:0">Utilisateurs</h2><button class="btn primary" id="add-user">+ Utilisateur</button></div>
        <div class="table-wrap"><table><thead><tr><th>Nom</th><th>Email</th><th>Rôle</th><th>État</th><th></th></tr></thead><tbody>
        ${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(LABELS.role[u.role])}</td>
          <td>${u.active ? badge('Actif', 'ok') : badge('Désactivé')}</td><td><button class="link" data-user="${u.id}">Modifier</button></td></tr>`).join('')}
        </tbody></table></div>
        <p class="muted small">Rôles : <b>Administrateur</b> (tout), <b>Ingénieur</b> (tickets, temps, rapports), <b>Client</b> (création et suivi de ses demandes, rapports sans notes internes).</p>
      </div>
    </div>`;

  $('#f-contract').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    d.categories = d.categories.split('\n').map((c) => c.trim()).filter(Boolean);
    try {
      await api('/settings', { method: 'PUT', body: d });
      await refreshMeta();
      toast('Contrat enregistré');
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
      toast('Heures ouvrées enregistrées, échéances recalculées');
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
      toast('Politiques SLA enregistrées');
    } catch (ex) { toast(ex.message, true); }
  });

  const userModal = (u) => openModal(`
    <h2>${u ? 'Modifier l\'utilisateur' : 'Nouvel utilisateur'}</h2>
    <form class="form-grid">
      <label>Nom<input name="name" required value="${esc(u?.name || '')}"></label>
      <label>Email<input name="email" type="email" required value="${esc(u?.email || '')}"></label>
      <label>Rôle<select name="role">${options(Object.entries(LABELS.role), u?.role || 'engineer')}</select></label>
      <label>${u ? 'Nouveau mot de passe (laisser vide)' : 'Mot de passe'}<input name="password" type="password" minlength="8" ${u ? '' : 'required'} autocomplete="new-password"></label>
      ${u ? `<label class="check full"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> Compte actif</label>` : ''}
      <div class="error full"></div>
      <div class="foot full"><button type="button" class="btn" data-close>Annuler</button><button class="btn primary" type="submit">Enregistrer</button></div>
    </form>`, async (data) => {
    if (u) {
      data.active = !!data.active;
      if (!data.password) delete data.password;
      await api(`/users/${u.id}`, { method: 'PATCH', body: data });
    } else {
      await api('/users', { method: 'POST', body: data });
    }
    closeModal();
    toast('Utilisateur enregistré');
    renderSettings();
  });

  $('#add-user').addEventListener('click', () => userModal(null));
  $$('[data-user]').forEach((b) => b.addEventListener('click', () => userModal(users.find((u) => String(u.id) === b.dataset.user))));
}

boot();
