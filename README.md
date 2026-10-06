# ORA ITSM

Lightweight ITSM tool for the **ORA Microsoft support contract** (through Black Star Iraq, **40 hours / month** allowance):
incident and request management, **SLA** tracking, **time tracking** and **monthly reporting**.

- Frontend: plain HTML / CSS / JavaScript, no framework (`public/`)
- Backend: Node.js 22+ and Express (`server/`)
- Database: **SQLite** (built-in `node:sqlite` module, nothing to install or compile) — a single file
- Deployment: run with Node.js on Windows/Linux, or with **Docker**

## Where is the database?

Everything is stored in **one file**: `ora-itsm.db`, plus an `uploads/` folder for attachments.

| How you run it | Location |
|---|---|
| Windows / `npm start` | `data\ora-itsm.db` inside the project folder (e.g. `Downloads\ORA-ITSM-...\data\ora-itsm.db`) |
| Docker | `/data/ora-itsm.db` inside the `ora-data` Docker volume |
| Custom | set the `DATA_DIR` environment variable |

The exact path is printed in the console at startup and shown in **Settings → Database & backup**.
You can open the file with [DB Browser for SQLite](https://sqlitebrowser.org/) to look at the tables
(stop the app first if you want to edit data by hand).

## Features

| Module | Details |
|---|---|
| Tickets | Incident, service request, change, problem · priorities P1–P4 · Microsoft categories (M365, Exchange, Teams, Entra ID, Intune, Azure…) · Microsoft case number · assignment · full change history · sortable list and CSV export |
| Attachments | Screenshots and log files on every ticket: drag & drop, file picker, or **paste a screenshot with Ctrl+V** · image thumbnails and preview |
| SLA | First-response and resolution targets per priority · 24/7 or business hours (default Sun–Thu 08:00–16:00, UTC+3) · clock **paused** while "Pending client" · Met / At risk (75%) / Breached |
| Time tracking | **Start/stop timer** on a ticket (survives page reloads) or manual entry · per ticket or non-ticket work (meetings, reviews) · billable or not · accepts `1h30`, `45m`, `1.5` |
| Allowance | Live hours used vs 40 h · alert at 80% (configurable) · end-of-month projection · overage |
| Reports | Printable / PDF monthly report (hours, SLA by priority, tickets by category/type, average resolution time, work log, signature block) · CSV exports · 12-month trend |
| Dashboard | Allowance gauge, SLA alerts, my open tickets, tickets by status, auto-refresh every minute |
| Administration | Contract, business hours, SLA policies, users · **one-click database backup download** |
| Roles | **Administrator** (everything), **Engineer** (tickets, time, reports), **Client** (opens and follows tickets, never sees internal notes or per-engineer hours) |
| Email notifications | Office 365 mailbox via Microsoft Graph: ticket received, status changes, replies, assignment, SLA alerts, allowance alerts — per-event and per-user switches, delivery log |
| Sign-in | **Microsoft Entra ID single sign-on** (SPA, PKCE; single or multi-tenant with a role per tenant) and/or email + password |
| Interface | Modern layout, light / dark / system theme, global search (`/`), quick filters, responsive mobile menu |
| Security | Hashed passwords (scrypt), server-side ID token verification, login brute-force protection, session tokens, security headers |

## Run on Windows (no Docker)

1. Install **Node.js 22 LTS or later** from https://nodejs.org
2. Download the project (GitHub → **Code → Download ZIP**) and unzip it
3. Double-click **`start-windows.bat`**
   (or in PowerShell inside the folder: `npm install` then `npm start`)
4. Open http://localhost:8080 — keep the black window open while you use the app

First login: `admin@ora-itsm.local` / `ChangeMe!2026` — change it right away (**Password** link, bottom left).
To choose another initial account, create a `.env` file (see `.env.example`) **before the first start**.

## Run on a server with Docker

```bash
git clone -b claude/loving-bardeen-ltstxx https://github.com/medfer/ora-itsm.git
cd ora-itsm
cp .env.example .env        # set ADMIN_EMAIL and ADMIN_PASSWORD
docker compose up -d --build
```

Open `http://<server-ip>:8080`.

Useful commands:

| Action | Command |
|---|---|
| Logs | `docker compose logs -f` |
| Stop | `docker compose down` (data is kept in the volume) |
| Update | `git pull && docker compose up -d --build` |
| Backup | `./scripts/backup.sh /srv/backups/ora-itsm` (keeps the last 30) |

### Publish on the Internet with a domain and HTTPS

You need: a server with a fixed public IP, a domain name, and ports **80** and **443** open.
The SSL certificate is **free** (Let's Encrypt) and obtained / renewed automatically by [Caddy](https://caddyserver.com).

**1. Domain (DNS)** — at your domain registrar, create an **A record**:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `itsm` | `<your fixed IP>` | 3600 |

→ `itsm.your-domain.com` points to the server. Check with `nslookup itsm.your-domain.com`.

**2. Firewall / router** — allow TCP **80** and **443** inbound to the server
(if the server is behind a router, forward ports 80 and 443 to its local IP). Do **not** expose port 8080.

**3a. Linux server with Docker (recommended)**

```bash
git clone -b claude/loving-bardeen-ltstxx https://github.com/medfer/ora-itsm.git /opt/ora-itsm
cd /opt/ora-itsm
cp .env.example .env
nano .env        # set DOMAIN, ACME_EMAIL, ADMIN_EMAIL, ADMIN_PASSWORD
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f caddy   # wait for "certificate obtained successfully"
```

Open `https://itsm.your-domain.com`. Updates: `git pull && docker compose -f docker-compose.prod.yml up -d --build`.

**3b. Windows Server / Azure Windows VM (without Docker)** — one script does everything

1. Install **Node.js 22 LTS** (https://nodejs.org) and **Git** (https://git-scm.com/download/win) on the server.
2. Open **PowerShell as administrator** and run:

```powershell
git clone -b claude/loving-bardeen-ltstxx https://github.com/medfer/ora-itsm.git C:\ora-itsm
powershell -ExecutionPolicy Bypass -File C:\ora-itsm\deploy\windows\install.ps1 -Domain ora-itsm.duckdns.org -Email you@example.com
```

The script installs dependencies, downloads Caddy to `C:\caddy`, writes and validates the Caddyfile, opens ports 80/443
in Windows Firewall, creates the scheduled tasks below (via `tasks.ps1`), then checks that `https://<domain>` answers.
Optional: `-BackupDir D:\Backups\ora-itsm -BackupTime 01:30 -KeepBackups 60`.

#### Automatic start, watchdog and backups (scheduled tasks)

All tasks run as **SYSTEM**, whether or not someone is signed in to the server:

| Task | When | What it does |
|---|---|---|
| `ORA-ITSM` | at Windows startup (+30 s) | supervisor `run-app.ps1`: runs Node.js, writes its output to `logs\app-*.log`, **restarts it within seconds if it crashes** (longer pauses if it crashes in a loop) |
| `ORA-ITSM-Caddy` | at Windows startup | HTTPS reverse proxy (log: `C:\caddy\caddy.log`) |
| `ORA-ITSM-Watchdog` | every 5 minutes | starts the application / Caddy if they are not running, restarts the application if `/api/health` does not answer (`logs\watchdog.log`) |
| `ORA-ITSM-Backup` | every day at 02:00 | hot backup of the database **and attachments** to `backups\`, keeps the last 30 (`logs\backup.log`) |

Manage them with `tasks.ps1` (PowerShell as administrator):

```powershell
$t = 'C:\ora-itsm\deploy\windows\tasks.ps1'
powershell -ExecutionPolicy Bypass -File $t -Action Status     # state of each task + health check
powershell -ExecutionPolicy Bypass -File $t -Action Restart
powershell -ExecutionPolicy Bypass -File $t -Action Stop       # stays stopped (even after a reboot) until -Action Start
powershell -ExecutionPolicy Bypass -File $t -Action Start
powershell -ExecutionPolicy Bypass -File $t -Action Install -BackupDir D:\Backups\ora-itsm -BackupTime 01:30 -KeepBackups 60
powershell -ExecutionPolicy Bypass -File $t -Action Remove     # removes the tasks, keeps data, logs and backups
```

`-Action Install` only (re)creates the tasks — useful when the app already runs without HTTPS (e.g. behind another proxy)
or to change the backup schedule. Add `-NoWatchdog` or `-NoBackup` to skip those tasks.
Backup by hand: `powershell -ExecutionPolicy Bypass -File C:\ora-itsm\deploy\windows\backup.ps1 [-Destination D:\Backups] [-Keep 30]`.

> Keep the backups on **another disk or server** (`-BackupDir`): a copy on the same disk does not survive a disk failure.

**Upgrading from an installation made before these tasks existed:** run `update.ps1`, then once
`tasks.ps1 -Action Install` (with your backup options) to switch to the supervisor, watchdog and backup tasks.

Update later with: `powershell -ExecutionPolicy Bypass -File C:\ora-itsm\deploy\windows\update.ps1`
(backs up the database to `backups\pre-update-*.db` first; add `-RefreshTasks` to re-create the tasks after the update).

To move existing data from another PC: `tasks.ps1 -Action Stop`, copy your `data` folder into `C:\ora-itsm\data`, then `tasks.ps1 -Action Start`.

**Before giving access to the client:** change the admin password, create the user accounts, and schedule backups.

## Email notifications (Office 365)

ORA ITSM sends notifications from an Office 365 mailbox (e.g. `Med@carthagecloudsolutions.com`) through
**Microsoft Graph** (SMTP basic authentication is retired by Microsoft). Emails are sent in the background,
retried 3 times, and listed in **Settings → Email notifications → Recent emails**.

| Event | Recipient |
|---|---|
| Ticket received | client (account email / requester email) |
| Status change (in progress, pending client, pending Microsoft, resolved with resolution text, closed) | client |
| Public reply from the team (internal notes are never emailed) | client |
| New ticket | team address, or all engineers and admins |
| Ticket assigned | the engineer |
| Client reply | the assigned engineer (or the team) |
| SLA at risk / breached (checked every 5 minutes, sent once) | assignee + admins |
| Monthly allowance threshold / 100% used (once per month) | admins, and clients if enabled |

Each event can be turned on or off; each user can turn their own emails off (user menu → *Email notifications*),
and an admin can do it per user in **Settings → Users**.

### Setup (once)

1. **entra.microsoft.com → App registrations → New registration**: name `ORA ITSM Mail`, single tenant, no redirect URI.
2. **API permissions → Add a permission → Microsoft Graph → Application permissions → `Mail.Send`**, then **Grant admin consent**.
3. **Certificates & secrets → New client secret** (e.g. 24 months) — copy the **Value** right away.
4. In ORA ITSM, **Settings → Email notifications**: sender mailbox, tenant ID, client ID, client secret → **Save**, then **Send test**.

The client secret is stored server-side only and is never sent to browsers. Put a reminder to renew it before it expires.

**Recommended — limit the app to the sender mailbox only.** `Mail.Send` granted in Entra allows sending as any mailbox of the tenant.
To scope it to one mailbox, use Exchange Online *RBAC for Applications* instead of the Entra permission
(remove `Mail.Send` from *API permissions* after this):

```powershell
Connect-ExchangeOnline
# Object ID of the Enterprise application (Entra -> Enterprise applications -> ORA ITSM Mail -> Object ID)
New-ServicePrincipal -AppId <client-id> -ObjectId <enterprise-app-object-id> -DisplayName "ORA ITSM Mail"
New-ManagementScope -Name "ORA ITSM sender" -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'Med@carthagecloudsolutions.com'"
New-ManagementRoleAssignment -App <client-id> -Role "Application Mail.Send" -CustomResourceScope "ORA ITSM sender"
```

## Sign in with Microsoft (Entra ID SSO)

ORA ITSM supports single sign-on with **Microsoft Entra ID** as a **single-page application**
(authorization code flow with PKCE — no client secret is stored anywhere). The browser signs the user in with
Microsoft, then the server verifies the ID token signature (Microsoft public keys), audience, issuer, tenant,
expiry and nonce before opening an ORA ITSM session.

**Requirement:** Microsoft only accepts `https://` redirect URIs (except `http://localhost`), so publish the app behind HTTPS first (see HTTPS above).

### 1. Register the application in Entra ID

1. [Entra admin center](https://entra.microsoft.com) → **Identity → Applications → App registrations → New registration**
2. Name: `ORA ITSM`
3. Supported account types:
   - *Accounts in this organizational directory only* — only one company signs in, or
   - *Accounts in any organizational directory (multitenant)* — **Black Star engineers and ORA users from their own tenants**
4. Redirect URI: platform **Single-page application (SPA)**, value = the app address with a trailing slash, e.g. `https://itsm.your-domain.com/`
   (the exact value is shown with a copy button in **Settings → Microsoft Entra ID sign-in**)
5. Register, then copy the **Application (client) ID** and **Directory (tenant) ID** from the Overview page.

No client secret, certificate or API permission is needed (`openid profile email` are granted by default).
Optional: **Enterprise applications → ORA ITSM → Properties → Assignment required = Yes**, then assign the users/groups allowed in.

For a multitenant app, an administrator of the ORA tenant must consent once (the first ORA user sign-in shows the consent prompt, or use
`https://login.microsoftonline.com/<ORA-tenant-id>/adminconsent?client_id=<client-id>`).

### 2. Configure ORA ITSM

**Settings → Microsoft Entra ID sign-in (SSO)**:

| Field | Value |
|---|---|
| Application (client) ID | from the app registration |
| Directory (tenant) ID | your tenant GUID (single tenant), or `organizations` (multitenant) |
| Allowed tenants and their role | one per line, e.g. `<blackstar-tenant-id>=engineer` and `<ora-tenant-id>=client`. Users from other tenants are refused. |
| Create accounts automatically | new users get the tenant's role (or the default role) on first sign-in |
| Also allow password sign-in | untick to force Microsoft sign-in; administrators keep password access (break-glass) |

Existing accounts are matched by email on the first Microsoft sign-in, then linked to the Entra object ID.
An administrator can unlink a Microsoft account from **Settings → Users → Edit**.

## Forgotten password / "incorrect password"

`ADMIN_EMAIL` and `ADMIN_PASSWORD` are only used when the database is **created**; changing them later has no effect.
To reset a password (stop the app first on Windows):

```bash
node server/reset-password.js --list                                   # list accounts
node server/reset-password.js admin@ora-itsm.local "NewPassword2026"   # reset (or create) an admin

# with Docker:
docker compose exec ora-itsm node server/reset-password.js admin@ora-itsm.local 'NewPassword2026'
```

## Create accounts from the command line

Accounts are normally created in **Settings → Users**. From a terminal (stop the app first on Windows):

```bash
node server/add-user.js it@ora.iq "OraClient!2026" client "ORA IT Team"
node server/add-user.js engineer@blackstar.iq "Engineer!2026" engineer "Engineer Name"

# with Docker:
docker compose exec ora-itsm node server/add-user.js it@ora.iq 'OraClient!2026' client 'ORA IT Team'
```

## Backup & restore

- **From the app:** Settings → Database & backup → **Download backup** (consistent copy even while running).
- **Scheduled (Windows):** the `ORA-ITSM-Backup` task (see above).
- **Command line (any OS, app running or not):** `node --env-file-if-exists=.env server/backup.js <folder> --keep 30`
  copies the database (`ora-itsm-<date>.db`) and attachments (`ora-itsm-<date>-uploads`), and deletes older ones
  (`--db-only` to skip attachments). On Linux, schedule it with cron.
- **Restore:** stop the app, replace `ora-itsm.db` with the backup file (delete any `ora-itsm.db-wal` / `-shm` files next to it), start again.
- Attachments are regular files in the `uploads/` folder next to the database: copy that folder as well.

## Calculation rules

- **First response**: first move out of "New", or first public reply from an engineer.
- **Resolution**: move to "Resolved", "Closed" or "Cancelled". Reopening a ticket clears the resolution date.
- **SLA pause**: time spent in "Pending client" extends the resolution due date. "Pending Microsoft" does not pause (provider commitment).
- **Allowance**: only *billable* entries count against the 40 h; the month is taken from the work date.
- **Monthly SLA compliance**: response = tickets created in the month whose first response is met or breached; resolution = tickets resolved in the month.

## Default SLA (editable in Settings)

| Priority | First response | Resolution | Calendar |
|---|---|---|---|
| P1 Critical | 30 min | 4 h | 24/7 |
| P2 High | 1 h | 8 h | business hours |
| P3 Medium | 4 h | 24 h (3 business days) | business hours |
| P4 Low | 8 h | 40 h (5 business days) | business hours |

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `DATA_DIR` | `./data` (`/data` in Docker) | database and attachments folder |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@ora-itsm.local` / `ChangeMe!2026` | first admin account (first start only) |
| `MAX_UPLOAD_MB` | `20` | maximum attachment size |

## Development

```bash
npm install
npm run dev     # restarts on file changes
npm test        # SLA + API tests
```

```
server/index.js           REST API (auth, tickets, attachments, time, reports, settings, backup)
server/db.js              SQLite schema, default settings, initial admin account
server/sla.js             due-date calculation (business hours, pause)
server/sso.js             Microsoft Entra ID token verification
server/mailer.js          Office 365 email delivery (Microsoft Graph), queue and log
server/notify.js          notification rules and email templates
server/reset-password.js  command-line password reset
server/backup.js          command-line hot backup with rotation
deploy/windows/           Windows Server: install, update, scheduled tasks (tasks.ps1), supervisor, watchdog, backup
public/                   web interface (index.html, app.js, style.css)
test/                     node:test tests
start-windows.bat         Windows launcher
Dockerfile, docker-compose.yml, scripts/backup.sh
```
