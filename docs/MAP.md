# OpsFloa — Codebase Map

A jump-table for "where does X live." The app is big; check here before grepping.
Keep it current when a subsystem moves.

## Stack & where it runs
- **Client**: Vite + React → Vercel. `client/`
- **Server**: Node + Express → Render (`npm start` = `node migrate.js && node index.js`). `server/`
- **DB**: PostgreSQL (Neon). Migrations: `server/migrations/NNNN_*.sql` (numbered, run on boot).
- **Email** Resend · **Files** Cloudflare R2 · **Payments** Stripe · **Accounting** QuickBooks/Intuit.
- Branches: `dev` → dev.opsfloa.com (work here). `main` → opsfloa.com (PR only; never pushed directly).
- Deploys from `dev`: Vercel (client) **auto** on every push (~1 min); Render (server) usually-but-**not-always** — a backend change may need a manual Render deploy to show up. See `CLAUDE.md`.

## Navigation (hash-tab screens)
- **Administration** (`/administration`) — `AdministrationPage.jsx`, tabs via `#hash`.
  - `#workspace` → **Company Settings** (`ManageRates.jsx`, incl. Company Standards) + **Hours & Rules** (`HoursRulesSettings.jsx` + `HoursRuleBuilder.jsx`) + Deductions.
- **Team** (`/team`) — `TeamPage.jsx` → `ManageWorkers.jsx` (per-member pay settings: rate, OT rule, guarantee).
- **Workforce dashboard** — `AdminDashboard.jsx`, tabs use a `#wf-` hash prefix (`live/approvals/reports/timeoff/expenses/manage`). The **reports** tab hosts Team Member Reports (`WorkerMetrics.jsx` + `MemberReportRow.jsx`), the overtime report (`OvertimeReport.jsx`), payroll + exports.
- Worker's own **pay stubs** → `PayStubView.jsx` (on the account page).

## The pay pipeline (money-critical — one engine)
Everything that turns punches into money goes through **`server/utils/payStatement.js`**:
- `buildPayStatement(inputs)` — **pure** assembler: hours→costs→prevailing (per-project)
  →guarantee→leave$→deductions→gross/net, cents-rounded so lines reconcile to totals.
- Loaders that feed it (do the DB, then build): `workerStatement` (one worker),
  `companyStatements` (whole company, batched — no N+1), `workerPeriodStatements`
  (per pay period, fetch-once-per-span).

The four surfaces are now **renderers** of a statement — change pay logic in the
engine, not here:
| Surface | Route / file | Loader |
|---|---|---|
| Worker invoice | `admin.js` `GET /workers/:id/entries` → `BillPDF.jsx` | `workerStatement` |
| Overtime report | `admin.js` `GET /overtime-report` → `OvertimeReport.jsx` | `companyStatements` |
| Payroll CSV | `admin.js` `GET /payroll-export` | `companyStatements` |
| Pay stubs | `timeEntries.js` `GET /pay-stubs` → `PayStubView.jsx` | `workerPeriodStatements` |
`GET /export/worker-hours` (admin.js) is a lean hours-only export; it shares the OT
engine (`computeOT` + role tiered config) but not the full statement.

**Engine internals** (`server/utils/`): `hoursRules.js` (the policy: parse, rounding,
role rules, `roundEntriesFromSettings`, `otConfigFromSettings`, the rule builder's
`sick_value`/min_daily/etc.) · `payCalculations.js` (`computeOT`, `annotateEntryOvertime`,
`computeDailyPayCosts`, `otBandsCost`, `nightPremiumCost`, `computeLeaveHours`,
`computeGuaranteeShortfall`) · `paidHours.js` (`computePaid`, `computeWorker/CompanyLeave`,
`leaveRateMultipliers`, `loadSettings`) · `deductions.js` (`payStubTotals`).

## Settings
- Defaults + coercion: `server/settingsDefaults.js` (`SETTINGS_DEFAULTS`, `ADMIN_SETTINGS_DEFAULTS`, `applySettingsRows`). Stored in the `settings` key/value table per company.
- Read: `getSettings` (admin.js) / `loadSettings` (paidHours.js) — both apply defaults.
- Write allow-list: numeric keys in `admin.js` PATCH `/admin/settings`.
- **Fixed-value columns** (statuses/types/roles): `docs/db-enums.md` is the source of truth — read + update it when touching one.

## Tool-apps (`client/public/tool-apps/`)
- `planroom/` — **Plan Room / Takeoff** (`app.js` + `index.html`). Roofing, earthwork, roof-measurement, storm, siding, etc. **Bump `?v=N` on both files** when editing; it cache-busts.
- `shared/` — the Plan Room engine (view/store/doc/measure, polygon-clipping, pdf libs). Originally copied out of the standalone sitework takeoff, which is now retired/archived to `sitework-archived/` at the repo root.
- `pdftools/` — PDF utilities.

## Testing & verify
- **One-shot**: `npm run verify` (root) — server `jest`, then client `eslint` + `vitest` + `vite build`. Or `verify:server` / `verify:client`. Runs anywhere (no DB needed — jest mocks `../db`).
- Server tests: `cd server && npx jest [file]` (Jest; `jest.mock('../db')`).
- Client tests: `cd client && npx vitest run [file]` (Vitest; i18n EN/ES parity is `src/i18n.test.js`).
- **CI-only gates** (need services `verify` can't assume locally): `npm run lint:migrations` (applies migrations to a scratch Postgres) and `npm audit --omit=dev --audit-level=high` (new advisories move, so it's out of `verify`; transitive fixes go in `server/package.json` `overrides`).
- When touching Plan Room, also confirm `git status --porcelain client/public/tool-apps/sitework/` is empty.

## Conventions
- Work on `dev`; push after every commit; never touch `main`/stage without per-case OK.
- New fixed-value DB column → shared constant in `server/constants/` + a CHECK/ENUM + update `docs/db-enums.md`.
- Task reports → `docs/WORKLOG.md`. Parked bugs/ideas → `docs/BACKLOG.md`. Feature designs → `docs/plans/*.md`.
