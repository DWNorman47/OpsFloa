# OpsFloa — Production & Haul Log (main app)

Status: **M1 + M2 SHIPPED** (2026-07-13; M1 `a7e3e84`, M2 `38df6e5`).
**Decisions (locked with user): lives as a Field-module tab; field crews can
self-log (worker permission).** Migration renumbered **0135 → 0137** (0135/0136
were taken by the bid-workflow plan). **User to-do: run migration 0137.** M3 is
optional polish. Brings the standalone sitework
tool's production log into the main OpsFloa app as a proper server-backed,
per-job, multi-user feature. Relocating this here (not into Plan Room) was a
deliberate call: it's **field/production tracking, not takeoff** — so it belongs
with the base operations, alongside daily reports and time.

## Key finding — most of this already exists
`daily_reports` (+ `daily_report_manpower`/`_equipment`/`_materials`) already
records per-project daily field production — weather, work performed, crew hours
— surfaced as the **"Daily" tab in the Field module** (`FieldPage.jsx`, route
`/field`), gated `requireAuth + requirePlan('business')` at
`server/index.js:230`. So the "daily reports" half of the sitework log is ~90%
built. **The genuinely new work is: (1) haul tickets, (2) the estimate-vs-actual
reconciliation.** Do NOT stand up a parallel daily-production table.

## Gating (the product decision — recommendation)
Two tiers, deliberately split:
- **The log itself = base ops, NOT the takeoff add-on.** Daily reports + haul
  tickets are universal to any field contractor and don't require a digital
  takeoff. Gate exactly like `daily_reports`: **`requirePlan('business')` at
  mount + a permission** (`requirePerm('manage_haul_tickets')` for writes;
  reads follow the daily-reports worker/admin narrowing). Optionally behind the
  existing `module_field` toggle so it shows only for companies using Field.
  Locking a base capability behind a specialized estimating add-on would
  contradict the operations-base + add-ons model and shrink its reach.
- **Estimate-vs-actual reconciliation = the takeoff add-on perk.** Comparing
  logged *actual* hauled quantities against the takeoff's *estimated* quantities
  (earthwork export CY, material tons/CY) genuinely needs takeoff data, so that
  view/endpoint is gated by **`requireTakeoffAddon`** (`middleware/auth.js:183`,
  `403 { code:'takeoff_required' }`). This is the honest upsell that earns the
  add-on without walling off the base log.

## Data model — migration `server/migrations/0135_haul_tickets.sql`
Next free number is **0135** (highest is `0134_live_sessions.sql`). Follow the
conventions in `0125`/`0131`/`0132`: idempotent, `company_id UUID` **no FK**
(some envs have INTEGER `companies.id`), `project_id INTEGER REFERENCES
projects(id) ON DELETE SET NULL`, `created_by INTEGER REFERENCES users(id)`,
named CHECK via DROP+ADD so re-runs pass, `CREATE INDEX IF NOT EXISTS`.

**New `haul_tickets`** (standalone — a haul ticket has its own lifecycle, logged
as trucks leave; it does NOT require a daily_report row):
- `id SERIAL PRIMARY KEY`
- `company_id UUID NOT NULL` (no FK — see note)
- `project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL`
- `ticket_date DATE NOT NULL`
- `ticket_no TEXT`, `hauler TEXT`, `material TEXT`
- `qty NUMERIC NOT NULL DEFAULT 0`
- `unit TEXT NOT NULL DEFAULT 'CY'` — CHECK `unit IN ('CY','tons','loads')`
- `direction TEXT DEFAULT 'export'` — CHECK `IN ('export','import')` (haul-off vs
  import; lets reconciliation net correctly). *New vs the sitework tool.*
- `notes TEXT`, `created_by INTEGER REFERENCES users(id)`,
  `created_at TIMESTAMPTZ DEFAULT now()`
- indexes on `(company_id, project_id)` and `(company_id, ticket_date)`

Daily reports need **no schema change** — reuse as-is.

## Constants & docs (project rule: fixed-value columns)
- `server/constants/haulEnums.js` — `HAUL_UNITS = ['CY','tons','loads']`,
  `HAUL_UNIT_DEFAULT`, `HAUL_DIRECTIONS = ['export','import']`,
  `HAUL_DIRECTION_DEFAULT` (frozen arrays, mirroring
  `server/constants/liveSessionEnums.js`).
- **`docs/db-enums.md`** — add a row per new fixed-value column
  (`haul_tickets.unit`, `haul_tickets.direction`), enforcement "enforced (CHECK
  in 0135)". Required in the same change per the doc's own rules.

## Server — `server/routes/haulTickets.js`
Mirror `routes/dailyReports.js` + `routes/equipment.js` idioms.
- Mount `app.use('/api/haul-tickets', requireAuth, requirePlan('business'),
  require('./routes/haulTickets'));` in `server/index.js` (next to
  `/api/daily-reports` at :230).
- `GET /` — company-scoped list, `?project_id=`, `?from=&to=` date range; worker
  sees own (`created_by = $n`), admin sees all (mirror `dailyReports.js:36`).
- `POST /` (`requirePerm('manage_haul_tickets')`) — validate `unit`/`direction`
  against `haulEnums`; insert; `logAudit(companyId, req.user.id,
  req.user.full_name, 'haul_ticket.created', 'haul_ticket', id, ticket_no, {...})`.
- `PATCH /:id`, `DELETE /:id` — company-scoped, admin-or-owner, audited.
- Error shape `catch (err){ req.log.error({err},'route error');
  res.status(500).json({error:'Server error'}); }`.

## Reconciliation (takeoff add-on) — `GET /api/haul-tickets/reconcile?project_id=`
Gated `requireTakeoffAddon`. Sums haul_tickets actuals by unit/direction for the
job and returns them alongside the linked takeoff's estimate (from the
`takeoffs`/takeoff-projects data, `0131_takeoff_projects.sql`) → estimated vs
actual vs variance %. MVP can match a project's most-recent takeoff; a later
enhancement links a specific takeoff id to the job.

## Permissions — `server/permissions.js`
Add `manage_haul_tickets` to `PERMISSIONS[]` under `group: 'field'` (next to
`submit_field_reports`, `:65-70`); include in `ADMIN_PERMISSIONS` (and
`WORKER_PERMISSIONS` if field crews log their own hauls). Migration to insert it
into existing `role_permissions` (per the header note at `permissions.js:24-27`).
Client mirror already reads `user.permissions` via `usePerm.js`.

## Client — Field module
- `client/src/pages/FieldPage.jsx`: add a **`haul` tab** (`FIELD_TABS` :13, hash
  alias :14-30, lazy component :41-49) rendering
  `client/src/components/HaulTickets.jsx`; group it with the Daily tab in
  `fieldGroups`. Gate its visibility on the perm/plan like the other tabs.
- `HaulTickets.jsx`: project dropdown + date + add row (ticket#, hauler,
  material, qty, unit, direction, notes), list table with delete, date-range
  filter, running totals by unit; CSV/print (reuse the daily-reports/bid print
  pattern). Match `components/DailyReports.jsx` styling + `ops-*` classes.
- Reconciliation panel (only if `usePlan().hasTakeoff`): estimate-vs-actual card
  calling `/api/haul-tickets/reconcile`.
- **i18n:** every new string added to BOTH the English (~`i18n.js:21`) and
  Spanish (~`:3955`) blocks — `i18n.test.js` fails the build on any mismatch or
  empty value.

## Domain reference (from the standalone sitework tool, in case it's deleted)
- **Haul ticket:** `{ date, ticket_no, hauler/truck, material, qty, unit
  (CY|tons|loads), notes }`. Summary = totals by unit; feeds the truck-load count
  and export reconciliation.
- **Daily report:** `{ date, weather, crew (count), hours, work performed }` —
  already the app's `daily_reports`.
- Stored in the tool as `production = { tickets: [], days: [] }`
  (`normalizeProduction`).

## Milestones (each to `dev`, push after each)
- **M1 — haul tickets end-to-end: DONE (`a7e3e84`).** Migration **0137** (table +
  seeds `manage_haul_tickets` into built-in roles) + `haulEnums.js` + db-enums
  rows; `routes/haulTickets.js` (list with worker/admin narrowing + filters;
  create/patch/delete, audited, enum-validated, project-ownership checked, perm-
  gated); `manage_haul_tickets` in the catalog + Worker default (cascades to
  Admin/Owner); Field module **Haul log** tab (workers + admins) +
  `HaulTickets.jsx` (add form, project + date-range filters, net-export totals by
  unit, delete, CSV); EN/ES i18n. **Needs migration 0137 run.**
- **M2 — reconciliation (takeoff add-on): DONE (`38df6e5`).** `GET
  /haul-tickets/reconcile?project_id=` gated `requireTakeoffAddon` — actuals
  (net export by unit) vs the estimate converted to the job
  (`converted_project_id`), haul-off quantity from lines matching
  `/haul|export|spoil|off-haul/`. `usePlan().hasTakeoff` added. Estimate-vs-actual
  card in the Haul tab (single job + add-on only), names the matched estimate,
  variance over/under. EN/ES i18n.
- **M3 (optional) — polish:** link a specific takeoff id to a job; CSV/print;
  per-hauler/-material subtotals; retire the standalone tool's local-only log.

## Verification
Migration idempotent (re-run clean); enum rejection unit-tested; company scoping
+ worker/admin narrowing; `logAudit` rows written; a `starter` company gets 403
(plan gate); a `business` company WITHOUT the takeoff add-on can log tickets but
gets `takeoff_required` from `/reconcile`; i18n parity test green; add a haul
ticket → totals + reconciliation variance match a hand calc.

## Open questions for the user — RESOLVED (2026-07-13)
- **Home:** ✅ **Field-module tab** with a project dropdown (matches
  daily_reports). Shipped as the "Haul log" tab in M1.
- **Worker self-logging:** ✅ **Yes — field crews can add haul tickets**
  (`manage_haul_tickets` is a worker-default permission). Reconciliation stays
  admin/add-on gated.
