# OpsFloa — Setup Guide

## Prerequisites
- Node.js 18+ (CI uses 22)
- A PostgreSQL database (free options: [Neon](https://neon.tech), [Supabase](https://supabase.com), or local)

## 1. Configure the server

```bash
cd server
cp .env.example .env
```

Edit `.env` and set:
- `DATABASE_URL` — your PostgreSQL connection string
- `JWT_SECRET` — any long random string (e.g. run `openssl rand -hex 32`)
- For local work also: `NODE_ENV=development`, `EMAIL_MODE=suppress` (or `redirect` +
  `EMAIL_REDIRECT_TO=<you>`), `DISABLE_BACKGROUND_JOBS=true` if you don't need the cron jobs.

## 2. Create the database schema

Load the base schema once into an **empty** database, then let the numbered migrations run:

```bash
psql "$DATABASE_URL" -f schema.sql
npm install
node migrate.js        # also runs automatically on `npm start`
```

Or paste `server/schema.sql` into your database's SQL editor (Neon/Supabase both have one)
before running `node migrate.js`. Schema changes after that go in
`server/migrations/NNNN_*.sql` — never ad-hoc SQL.

## 3. Create your company and first admin

Easiest: start the server and the client (steps 4–5), open http://localhost:5173/register and
sign up. That creates the company, its Owner admin, and sends a confirmation email.

The same thing with curl (this is the real sign-up endpoint — it creates a **company** and its
first admin; there is no API for creating bare users, add team members from the app's Team page):

```bash
curl -X POST http://localhost:3001/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"company_name":"My Company","full_name":"Your Name","email":"you@example.com",
       "username":"admin","password":"<a strong password>","accepted_terms":true}'
# → 201 {"pending_confirmation":true,"email":"you@example.com"}
```

The account must confirm its email before it can sign in. Locally, with `EMAIL_MODE=suppress`
no email is sent — confirm it directly in your **local** database:

```sql
UPDATE users SET email_confirmed = true WHERE username = 'admin';
```

Then sign in at http://localhost:5173/login with the company name, username and password.
Projects, team members, rates and everything else are set up from the app.

## 4. Start the server

```bash
cd server && npm run dev      # http://localhost:3001
```

## 5. Start the client

```bash
cd client && npm install && npm run dev
```

Open http://localhost:5173

Local development notes:
- The service worker is off during `npm run dev` so Vite does not try to load the production `/sw.js` file. To test the PWA locally, set `VITE_ENABLE_SERVICE_WORKER=true`.
- Vercel Speed Insights is also off during local development. To test it locally, set `VITE_ENABLE_SPEED_INSIGHTS=true`.

## Verify before committing

```bash
npm run verify     # repo root: server eslint + jest, client eslint + vitest + vite build
```

CI (`.github/workflows/test.yml`) runs the same, plus the migrations lint on a throwaway
Postgres and `npm audit`.

## Demo data

The fictional company data used for visual testing lives in `server/scripts/seed-demo-data.js`.
Run it against a dev or stage database:

```bash
cd server
DEMO_COMPANY_NAME="Demo Operations" npm run seed:demo
```

On Windows PowerShell:

```powershell
cd server
$env:DEMO_COMPANY_NAME = "Demo Operations"
npm run seed:demo
```

Use the exact company name you want to fill. The script is idempotent: it creates the fictional
company if missing, reuses existing demo records where possible, and fills in missing clients,
projects, Field Work, Inventory, schedules, requests, and sample activity.

To make dev or stage fill automatically after deploy migrations, set these environment variables
on that environment:

```bash
DEMO_SEED_AUTO=true
DEMO_COMPANY_NAME=Demo Operations
DEMO_ADMIN_USERNAME=Admin
DEMO_ADMIN_PASSWORD=Admin123
```

`npm start` runs `node migrate.js && node index.js`, and `migrate.js` will run the demo seed after
schema migrations only when `DEMO_SEED_AUTO=true`. Leave `DEMO_SEED_AUTO=false` or unset on production.

## Deployment (how OpsFloa actually runs)

| Piece | Host | Notes |
|---|---|---|
| Client (Vite + React) | **Vercel** | Root `client/`, build `npm run build`, output `dist`. Set `VITE_API_URL` to the server URL. Auto-deploys on every push. |
| Server (Node + Express) | **Render** Web Service | Root `server/`, build `npm install`, start `npm start` (= `node migrate.js && node index.js` — migrations run on boot). Env vars in Render's dashboard (see `server/.env.example`). |
| Database | **Neon** Postgres | Branches `main` (prod), `stage`, `dev`. Backups / restore: `docs/BACKUP-RESTORE.md`. |

Branches: `dev` → dev.opsfloa.com; `main` → opsfloa.com (merged by PR only).

In production (`NODE_ENV=production`) the server refuses to boot without `APP_URL`, and email
always sends for real — except on a database whose `system_flags.email_mode` is `suppress`
(the scrubbed stage copy; see `docs/BACKUP-RESTORE.md` §6).
