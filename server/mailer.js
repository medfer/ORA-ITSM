// Email delivery through Microsoft Graph (Office 365 mailbox), sent in the background.
// Uses an Entra ID app registration with the Mail.Send application permission
// (client credentials flow). No external dependency.

const { db, getSettings, getSecret } = require('./db');

const DEFAULT_MAIL = {
  enabled: false,
  sender: '',
  tenant_id: '',
  client_id: '',
  staff_email: '',
  app_url: '',
  events: {
    client_ticket_created: true,
    client_status_changed: true,
    client_staff_reply: true,
    client_allowance: false,
    staff_new_ticket: true,
    staff_assigned: true,
    staff_client_reply: true,
    staff_sla: true,
    staff_allowance: true,
    copy_self: false,
  },
};

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function mailConfig(raw = getSettings().mail) {
  const cfg = { ...DEFAULT_MAIL, ...(raw || {}) };
  cfg.events = { ...DEFAULT_MAIL.events, ...((raw && raw.events) || {}) };
  cfg.sender = String(cfg.sender || '').trim();
  cfg.tenant_id = String(cfg.tenant_id || '').trim();
  cfg.client_id = String(cfg.client_id || '').trim();
  cfg.staff_email = String(cfg.staff_email || '').trim();
  cfg.app_url = String(cfg.app_url || '').trim().replace(/\/+$/, '');
  return cfg;
}

function configProblem(cfg, secret) {
  if (!EMAIL.test(cfg.sender)) return 'Sender mailbox is missing or invalid';
  if (!GUID.test(cfg.tenant_id)) return 'Directory (tenant) ID must be a GUID';
  if (!GUID.test(cfg.client_id)) return 'Application (client) ID must be a GUID';
  if (!secret) return 'Client secret is missing';
  return null;
}

// ---------- Microsoft Graph transport ----------

let tokenCache = { key: '', token: '', exp: 0 };

async function graphToken(cfg, secret) {
  const key = `${cfg.tenant_id}|${cfg.client_id}|${secret.slice(0, 4)}`;
  if (tokenCache.key === key && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const res = await fetch(`https://login.microsoftonline.com/${cfg.tenant_id}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.client_id,
      client_secret: secret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Microsoft sign-in failed: ${(data.error_description || data.error || res.status).toString().split(/\r?\n/)[0]}`);
  }
  tokenCache = { key, token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return data.access_token;
}

async function graphTransport({ cfg, secret, to, subject, html }) {
  const token = await graphToken(cfg, secret);
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.sender)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'HTML', content: html },
        toRecipients: to.map((address) => ({ emailAddress: { address } })),
      },
      saveToSentItems: true,
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`Graph sendMail failed (${res.status}): ${data.error?.message || data.error?.code || 'unknown error'}`);
  }
}

let transport = graphTransport;

// ---------- queue & log ----------

const queue = [];
let running = false;

function logEmail(msg, status, error) {
  db.prepare(`INSERT INTO email_log (created_at, event, ticket_id, recipients, subject, status, error)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(Date.now(), msg.event, msg.ticketId || null, msg.to.join(', '), msg.subject, status, error || null);
  db.prepare('DELETE FROM email_log WHERE id NOT IN (SELECT id FROM email_log ORDER BY id DESC LIMIT 500)').run();
}

async function processQueue() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const msg = queue.shift();
      const cfg = mailConfig();
      const secret = getSecret('mail_client_secret');
      let error = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await transport({ cfg, secret, to: msg.to, subject: msg.subject, html: msg.html });
          error = null;
          break;
        } catch (e) {
          error = e.message;
          if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 2000));
        }
      }
      if (error) console.error(`[ora-itsm] Email to ${msg.to.join(', ')} failed: ${error}`);
      logEmail(msg, error ? 'failed' : 'sent', error);
    }
  } finally {
    running = false;
  }
}

function logSkipped(event, ticketId, subject, reason) {
  logEmail({ event, ticketId, to: [], subject }, 'skipped', reason);
}

// Queue an email; returns immediately. Invalid/duplicate recipients are dropped.
function enqueue({ event, ticketId, to, subject, html }) {
  const recipients = [...new Set((to || []).map((e) => String(e || '').trim().toLowerCase()).filter((e) => EMAIL.test(e)))];
  if (!recipients.length) return false;
  queue.push({ event, ticketId, to: recipients, subject, html });
  setImmediate(processQueue);
  return true;
}

// Sends immediately and reports the error (used by the "send test email" button)
async function sendNow({ to, subject, html, cfg = mailConfig(), secret = getSecret('mail_client_secret') }) {
  const problem = configProblem(cfg, secret);
  if (problem) throw new Error(problem);
  const msg = { event: 'test', to: [String(to).trim()], subject, html };
  try {
    await transport({ cfg, secret, to: msg.to, subject, html });
    logEmail(msg, 'sent');
  } catch (e) {
    logEmail(msg, 'failed', e.message);
    throw e;
  }
}

async function flush() {
  while (queue.length || running) await new Promise((r) => setTimeout(r, 10));
}

module.exports = {
  DEFAULT_MAIL,
  mailConfig,
  configProblem,
  enqueue,
  logSkipped,
  sendNow,
  // tests only
  _setTransport(fn) { transport = fn || graphTransport; },
  _flush: flush,
};
