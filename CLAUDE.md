# OpsFloa — Claude Instructions

## Branching Rules
- **Always work on the `dev` branch.** Never commit or push directly to `main`.
- All changes go to `dev` first. Merges to `main` are done by the user via pull request.
- Before starting any work, ensure you are on the `dev` branch.

## Project
- App name: OpsFloa (Operations Flow Assistant)
- Domain: opsfloa.com (production), dev.opsfloa.com (development)
- Frontend: Vite + React, deployed on Vercel
- Backend: Node.js + Express, deployed on Render
- Database: PostgreSQL (Neon)
- **Deploys from `dev`:** the client (Vercel) deploys **automatically** on every
  push, so dev.opsfloa.com picks up client changes within ~a minute. The server
  (Render) usually auto-deploys but **not always** — a *backend* fix may not be
  live even after a green push, so if server behavior isn't reflected, a manual
  Render deploy may be needed. (Migrations run on server boot: `npm start` =
  `node migrate.js && node index.js`.)

## Fixed-value DB columns
- **`docs/db-enums.md` is the single source of truth** for every column
  that holds a fixed set of values (statuses, types, roles, kinds, etc).
- **Always read it before** writing or reviewing code that validates a
  fixed-value field, decides what value to write, or adds a new such
  column.
- **Always update it in the same change** when you add a new
  fixed-value column, change the allowed values, or change the DB
  enforcement state. The doc going stale defeats its whole purpose.
- New fixed-value columns should ideally land with both a shared
  constant in `server/constants/` AND a CHECK constraint or PG ENUM at
  the DB level. App-level validation alone is bypassable by raw SQL,
  webhooks, migrations, and future endpoints — the doc explains why.

## Working on this repo
- **Map first.** `docs/MAP.md` is the codebase jump-table — where subsystems live,
  hash-tab navigation, the pay engine, conventions. Check it before a broad grep;
  keep it current when something moves.
- **Verify before committing.** `npm run verify` (root) — server `jest`, then client
  `eslint` + `vitest` (incl. i18n EN/ES parity) + `vite build`. Runs without a DB.
- **Commit + push.** Commit when asked; push immediately after every commit.
- **Worklog.** After a task, append a short report to `docs/WORKLOG.md` — findings
  and judgment calls, not a second git log. Parked bugs/ideas → `docs/BACKLOG.md`;
  feature designs → `docs/plans/*.md`.

## Pay math (money-critical)
- All four pay surfaces — worker invoice, overtime report, payroll CSV, pay stubs —
  render **one** statement from `server/utils/payStatement.js` (`buildPayStatement`
  is the pure assembler; `workerStatement` / `companyStatements` /
  `workerPeriodStatements` are the loaders). Change pay logic **there**, not in the
  routes — the routes are renderers. The rule/OT engine lives in `hoursRules.js`,
  `payCalculations.js`, `paidHours.js`, `deductions.js`.

## Frozen: the sitework tool
- `client/public/tool-apps/sitework/` is a **live, frozen** tool — never edit it.
  Plan Room ports its logic by **copying** into `tool-apps/shared/` or `planroom/`.
  Confirm `git status --porcelain client/public/tool-apps/sitework/` is empty at
  every Plan Room commit. Touch sitework only with explicit per-case authorization.

## Plan Room & migrations & i18n
- **Plan Room:** editing `tool-apps/planroom/app.js` or `styles.css`? Bump the
  `?v=N` query on **both** references in `planroom/index.html` (cache-bust).
- **Migrations:** schema changes go in **numbered** files
  `server/migrations/NNNN_*.sql` — never ad-hoc SQL. They run on server boot.
- **i18n:** every user-facing string is bilingual — add EN **and** ES keys in
  `client/src/i18n.js`; `src/i18n.test.js` enforces parity.
