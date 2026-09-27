// Email notifications for ticket events. Every function only queues emails and never throws,
// so a mail problem can never break the action that triggered it.

const { db, getSettings } = require('./db');
const mailer = require('./mailer');

const STATUS = {
  new: 'New', in_progress: 'In progress', pending_client: 'Pending client',
  pending_microsoft: 'Pending Microsoft', resolved: 'Resolved', closed: 'Closed', cancelled: 'Cancelled',
};
const CLIENT_STATUS_TEXT = {
  in_progress: 'An engineer is now working on your request.',
  pending_client: 'We need some information from you to continue. Please reply to the ticket.',
  pending_microsoft: 'Your request has been escalated to Microsoft support. We will keep you informed.',
  resolved: 'Your request has been resolved. If the problem persists, simply reply to the ticket and we will reopen it.',
  closed: 'Your request is now closed. Thank you.',
  cancelled: 'Your request has been cancelled.',
};

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function number(t, settings) {
  return `${settings.ticket_prefix || 'TCK'}-${String(t.id).padStart(5, '0')}`;
}

function fmtDate(ms, settings) {
  if (!ms) return '—';
  const d = new Date(Number(ms) + (settings.business_hours?.offset || 0) * 60000);
  const p = (n) => String(n).padStart(2, '0');
  const off = (settings.business_hours?.offset || 0) / 60;
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} (UTC${off >= 0 ? '+' : ''}${off})`;
}

// ---------- recipients ----------

const activeUser = db.prepare('SELECT id, name, email, role, notify FROM users WHERE id = ? AND active = 1');
const optedOut = (email) => !!db.prepare('SELECT 1 FROM users WHERE email = ? AND notify = 0').get(String(email || ''));

function userEmail(id) {
  const u = id ? activeUser.get(id) : null;
  return u && u.notify ? [u.email] : [];
}

function clientRecipients(t) {
  const list = [];
  if (t.requester_email) list.push(t.requester_email);
  const creator = t.created_by ? activeUser.get(t.created_by) : null;
  if (creator && creator.role === 'client') list.push(creator.email);
  return list.filter((e) => !optedOut(e));
}

function staffRecipients(cfg) {
  if (cfg.staff_email) return cfg.staff_email.split(/[;,\s]+/).filter(Boolean);
  return db.prepare("SELECT email FROM users WHERE active = 1 AND notify = 1 AND role IN ('admin','engineer')").all().map((u) => u.email);
}

function adminRecipients() {
  return db.prepare("SELECT email FROM users WHERE active = 1 AND notify = 1 AND role = 'admin'").all().map((u) => u.email);
}

const without = (list, actor) => list.filter((e) => !actor || e.toLowerCase() !== String(actor.email || '').toLowerCase());

// ---------- template ----------

function layout(settings, cfg, { heading, intro, ticket, rows = [], quote, quoteLabel, tone = '#0f6cbd' }) {
  const link = ticket && cfg.app_url ? `${cfg.app_url}/#/tickets/${ticket.id}` : cfg.app_url;
  const table = rows.length ? `<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px">
    ${rows.map(([k, v]) => `<tr><td style="padding:6px 0;color:#69758c;width:150px;vertical-align:top">${esc(k)}</td><td style="padding:6px 0;color:#16213a">${v}</td></tr>`).join('')}
  </table>` : '';
  const quoteHtml = quote ? `<div style="margin:16px 0;padding:12px 14px;background:#f5f7fb;border-left:3px solid ${tone};border-radius:4px;font-size:14px;color:#16213a;white-space:pre-wrap">${quoteLabel ? `<div style="font-size:12px;color:#69758c;margin-bottom:6px">${esc(quoteLabel)}</div>` : ''}${esc(quote)}</div>` : '';
  const button = link ? `<p style="margin:22px 0 6px"><a href="${esc(link)}" style="display:inline-block;background:${tone};color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600;font-size:14px">${ticket ? 'View ticket' : 'Open ORA ITSM'}</a></p>` : '';
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f5f7fb;font-family:'Segoe UI',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7fb;padding:24px 12px"><tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e3e8f0">
      <tr><td style="background:#0c1a33;padding:16px 24px;color:#ffffff;font-size:16px;font-weight:700">ORA ITSM <span style="font-weight:400;color:#9fb6d8;font-size:13px">&nbsp;·&nbsp;${esc(settings.contract_name)}</span></td></tr>
      <tr><td style="height:4px;background:${tone}"></td></tr>
      <tr><td style="padding:24px">
        <h1 style="margin:0 0 10px;font-size:19px;color:#16213a">${esc(heading)}</h1>
        <p style="margin:0;font-size:14px;line-height:1.55;color:#3b4760">${intro}</p>
        ${table}${quoteHtml}${button}
      </td></tr>
      <tr><td style="padding:14px 24px;background:#f9fafc;border-top:1px solid #e3e8f0;font-size:12px;color:#69758c">
        ${esc(settings.company_name)} — support for ${esc(settings.client_name)}. This is an automatic message; please reply in ORA ITSM rather than to this email.
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
}

function ticketRows(t, settings, extra = []) {
  return [
    ['Ticket', `<b>${esc(number(t, settings))}</b>`],
    ['Title', esc(t.title)],
    ['Priority', esc(t.priority)],
    ['Status', esc(STATUS[t.status] || t.status)],
    ...(t.category ? [['Category', esc(t.category)]] : []),
    ...extra,
  ];
}

function send(event, t, to, subject, body) {
  try {
    const settings = getSettings();
    const cfg = mailer.mailConfig(settings.mail);
    if (!cfg.enabled) return;
    mailer.enqueue({ event, ticketId: t?.id, to, subject: `[${t ? number(t, settings) : settings.client_name}] ${subject}`, html: layout(settings, cfg, { ...body, ticket: t }) });
  } catch (e) {
    console.error('[ora-itsm] notification error:', e.message);
  }
}

function enabled(event) {
  const cfg = mailer.mailConfig();
  return cfg.enabled && cfg.events[event] !== false ? cfg : null;
}

function loadTicket(id) {
  return db.prepare('SELECT t.*, a.name AS assignee_name FROM tickets t LEFT JOIN users a ON a.id = t.assignee_id WHERE t.id = ?').get(id);
}

// ---------- events ----------

function ticketCreated(ticketId, actor) {
  const t = loadTicket(ticketId);
  if (!t) return;
  const settings = getSettings();
  let cfg = enabled('client_ticket_created');
  if (cfg) {
    send('client_ticket_created', t, without(clientRecipients(t), actor.role === 'client' ? null : actor), `We received your request: ${t.title}`, {
      heading: 'Your request has been received',
      intro: `Thank you. Your request was registered as <b>${esc(number(t, settings))}</b>. Our team will respond before <b>${esc(fmtDate(t.response_due, settings))}</b>.`,
      rows: ticketRows(t, settings),
      quote: t.description, quoteLabel: 'Your description',
    });
  }
  cfg = enabled('staff_new_ticket');
  if (cfg) {
    send('staff_new_ticket', t, without(staffRecipients(cfg), actor), `New ${t.priority} ticket: ${t.title}`, {
      heading: `New ${t.priority} ticket`,
      intro: `<b>${esc(actor.name)}</b> opened a new ticket. First response due <b>${esc(fmtDate(t.response_due, settings))}</b>.`,
      rows: ticketRows(t, settings, [['Requester', esc(t.requester_name || actor.name)], ['Assignee', esc(t.assignee_name || 'Unassigned')]]),
      quote: t.description, quoteLabel: 'Description',
      tone: t.priority === 'P1' ? '#d13438' : t.priority === 'P2' ? '#e3761b' : '#0f6cbd',
    });
  }
  if (t.assignee_id && t.assignee_id !== actor.id) assigned(t, actor);
}

function assigned(t, actor) {
  if (!enabled('staff_assigned')) return;
  const settings = getSettings();
  send('staff_assigned', t, without(userEmail(t.assignee_id), actor), `Assigned to you: ${t.title}`, {
    heading: 'A ticket was assigned to you',
    intro: `<b>${esc(actor.name)}</b> assigned this ticket to you. Resolution due <b>${esc(fmtDate(t.resolution_due, settings))}</b>.`,
    rows: ticketRows(t, settings, [['Requester', esc(t.requester_name || '—')]]),
    quote: t.description, quoteLabel: 'Description',
  });
}

function ticketUpdated(ticketId, before, changed, actor) {
  const t = loadTicket(ticketId);
  if (!t) return;
  const settings = getSettings();
  if (changed.includes('assignee_id') && t.assignee_id && t.assignee_id !== actor.id) assigned(t, actor);
  if (changed.includes('status') && CLIENT_STATUS_TEXT[t.status] && enabled('client_status_changed')) {
    const done = ['resolved', 'closed'].includes(t.status);
    send('client_status_changed', t, clientRecipients(t), `${STATUS[t.status]}: ${t.title}`, {
      heading: `Your request is now “${STATUS[t.status]}”`,
      intro: esc(CLIENT_STATUS_TEXT[t.status]),
      rows: ticketRows(t, settings, [['Previous status', esc(STATUS[before.status] || before.status)]]),
      quote: done && t.resolution ? t.resolution : '', quoteLabel: 'Resolution',
      tone: done ? '#107c41' : t.status === 'pending_client' ? '#a15c00' : '#0f6cbd',
    });
  }
}

function commentAdded(ticketId, comment, actor) {
  const t = loadTicket(ticketId);
  if (!t || comment.internal) return;
  const settings = getSettings();
  if (actor.role === 'client') {
    const cfg = enabled('staff_client_reply');
    if (!cfg) return;
    const to = t.assignee_id ? userEmail(t.assignee_id) : staffRecipients(cfg);
    send('staff_client_reply', t, without(to, actor), `Client replied: ${t.title}`, {
      heading: 'The client replied',
      intro: `<b>${esc(actor.name)}</b> added a message to this ticket.`,
      rows: ticketRows(t, settings),
      quote: comment.body, quoteLabel: `${actor.name} wrote`,
    });
  } else if (enabled('client_staff_reply')) {
    send('client_staff_reply', t, clientRecipients(t), `New reply: ${t.title}`, {
      heading: 'You have a new reply',
      intro: `<b>${esc(actor.name)}</b> from ${esc(settings.company_name)} replied to your request.`,
      rows: ticketRows(t, settings),
      quote: comment.body, quoteLabel: `${actor.name} wrote`,
    });
  }
}

// Returns true only the first time a key is seen (one alert per event)
function firstTime(key) {
  return db.prepare('INSERT OR IGNORE INTO notification_flags (key, created_at) VALUES (?, ?)').run(key, Date.now()).changes === 1;
}

// Called periodically with the open tickets decorated with their SLA state
function checkSla(tickets) {
  const cfg = enabled('staff_sla');
  if (!cfg) return;
  const settings = getSettings();
  for (const t of tickets) {
    for (const [kind, st, due] of [['response', t.sla_response, t.response_due], ['resolution', t.sla_resolution, t.effective_resolution_due]]) {
      if (st !== 'breached' && st !== 'at_risk') continue;
      if (!firstTime(`sla:${t.id}:${kind}:${st}:${t.priority}`)) continue;
      const breached = st === 'breached';
      const to = [...userEmail(t.assignee_id), ...adminRecipients()];
      send('staff_sla', t, to.length ? to : staffRecipients(cfg), `SLA ${breached ? 'BREACHED' : 'at risk'} (${kind}): ${t.title}`, {
        heading: `${kind === 'response' ? 'First-response' : 'Resolution'} SLA ${breached ? 'breached' : 'at risk'}`,
        intro: breached
          ? `The ${kind} target for this ${esc(t.priority)} ticket was due <b>${esc(fmtDate(due, settings))}</b> and has been missed.`
          : `More than 75% of the ${kind} time is used. Due <b>${esc(fmtDate(due, settings))}</b>.`,
        rows: ticketRows(t, settings, [['Assignee', esc(t.assignee_name || 'Unassigned')]]),
        tone: breached ? '#c42b1c' : '#a15c00',
      });
    }
  }
}

// Called after time entries change: alert once per month when a usage threshold is crossed
function checkAllowance(month, usedMinutes) {
  const settings = getSettings();
  const contract = (Number(settings.contract_hours_month) || 0) * 60;
  if (!contract) return;
  const pct = (usedMinutes / contract) * 100;
  const thresholds = [...new Set([Number(settings.alert_threshold_pct) || 80, 100])].sort((a, b) => a - b);
  for (const th of thresholds) {
    if (pct < th || !firstTime(`allowance:${month}:${th}`)) continue;
    const over = th >= 100;
    const hours = (m) => `${Math.round(m / 6) / 10} h`;
    const body = {
      heading: over ? 'Monthly allowance fully used' : `${th}% of the monthly allowance used`,
      intro: over
        ? `The ${esc(settings.contract_hours_month)} h included this month have been used. Further billable work will be counted as additional hours.`
        : `${esc(hours(usedMinutes))} of the ${esc(settings.contract_hours_month)} h monthly allowance have been used.`,
      rows: [['Month', esc(month)], ['Used', `<b>${esc(hours(usedMinutes))}</b> (${Math.round(pct)}%)`], ['Allowance', `${esc(settings.contract_hours_month)} h`],
        ['Remaining', esc(hours(Math.max(0, contract - usedMinutes)))]],
      tone: over ? '#c42b1c' : '#a15c00',
    };
    const staffCfg = enabled('staff_allowance');
    if (staffCfg) send('staff_allowance', null, adminRecipients(), body.heading, body);
    if (enabled('client_allowance')) {
      const clients = db.prepare("SELECT email FROM users WHERE active = 1 AND notify = 1 AND role = 'client'").all().map((u) => u.email);
      send('client_allowance', null, clients, body.heading, body);
    }
  }
}

const safe = (fn) => (...args) => { try { fn(...args); } catch (e) { console.error('[ora-itsm] notification error:', e.message); } };

module.exports = {
  ticketCreated: safe(ticketCreated),
  ticketUpdated: safe(ticketUpdated),
  commentAdded: safe(commentAdded),
  checkSla: safe(checkSla),
  checkAllowance: safe(checkAllowance),
  layout,
};
