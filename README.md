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
| Security | Hashed passwords (scrypt), login brute-force protection, session tokens, security headers |

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

### HTTPS (recommended)

Put a reverse proxy in front, e.g. Caddy (automatic Let's Encrypt certificate):

```
itsm.your-domain.com {
    reverse_proxy 127.0.0.1:8080
}
```

and restrict the port in `docker-compose.yml` to `"127.0.0.1:8080:8080"`.

## Forgotten password / "incorrect password"

`ADMIN_EMAIL` and `ADMIN_PASSWORD` are only used when the database is **created**; changing them later has no effect.
To reset a password (stop the app first on Windows):

```bash
node server/reset-password.js --list                                   # list accounts
node server/reset-password.js admin@ora-itsm.local "NewPassword2026"   # reset (or create) an admin

# with Docker:
docker compose exec ora-itsm node server/reset-password.js admin@ora-itsm.local 'NewPassword2026'
```

## Backup & restore

- **From the app:** Settings → Database & backup → **Download backup** (consistent copy even while running).
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
server/reset-password.js  command-line password reset
public/                   web interface (index.html, app.js, style.css)
test/                     node:test tests
start-windows.bat         Windows launcher
Dockerfile, docker-compose.yml, scripts/backup.sh
```
