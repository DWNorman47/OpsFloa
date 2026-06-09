# DB Enum Reference

Single source of truth for every database column that holds a fixed
set of values. **Consult this file every time you write or review code
that validates against a fixed list, and update it whenever you add or
change one.**

For each column we record:
- Allowed values
- DB enforcement state — `enforced` means a CHECK constraint or PG ENUM
  rejects bad values at write time no matter the path; `app-only` means
  a bypass write (raw SQL, migration, Stripe webhook, future endpoint,
  manual `psql`) can corrupt the row.
- Where validation lives in code.
- A short note on stakes.

> **History.** First populated 2026-04-30 after the
> `projects.status='active'` bug. Revised same day after a full-codebase
> audit revealed (a) migration 0071 had quietly enforced many columns
> I'd marked app-only, and (b) three CHECK constraints had drifted from
> the route code (daily_reports / field_reports / incident_reports
> `.status`) — fixed in migration 0100. Migration 0101 added CHECK
> constraints to most of the remaining app-only columns and centralised
> the canonical lists in `server/constants/`.

## Quick rules when touching a fixed-value field

1. **Look it up here first.** If the column isn't listed, grep the
   codebase for hardcoded lists (`VALID_*`, `].includes(`,
   `<option value=`) and add an entry.
2. **Use one shared constant in code**, not a literal in every file.
   Server: `server/constants/<name>.js` exporting both the array and a
   `Default`. Client: import the same constant when feasible.
3. **Add a CHECK constraint** if the column doesn't have one. The
   constraint is the unbypassable backstop — application validators
   only protect paths that remember to call them. (See `0249ac4` for
   the cost of skipping this.)
4. **When extending an enum**, drop and re-add the CHECK in the same
   migration — don't expect 0071-style historical constraints to
   silently accept the new value. (See `0100` for an example.)
5. **Update this file in the same PR** so the registry doesn't drift.

---

## High-stakes columns (payroll, billing, security, auth)

| Table.column | Allowed values | DB enforcement | App validation | Stakes |
|---|---|---|---|---|
| `companies.subscription_status` | `trial`, `active`, `past_due`, `canceled`, `trial_expired`, `exempt` | **enforced** (CHECK in `0103`) | `server/constants/companyEnums.js`, `server/routes/superadmin.js`, `server/routes/stripe.js` (via `mapStripeStatus`) | Billing gate. Stripe webhook now translates its enum (`trialing`, `incomplete`, `unpaid`, `paused`, etc.) onto the app set via `mapStripeStatus()` before writing — unknown values fall back to `past_due` so they're surfaced as "needs admin attention" rather than silently coerced to `active`. |
| `companies.plan` | `free`, `starter`, `business` (nullable) | **enforced** (CHECK in `0103`) | `server/constants/companyEnums.js`, `server/routes/superadmin.js`, `server/routes/stripe.js` (`planFromPrice`) | Feature gating (worker limits, storage caps, plan-gated features). NULL allowed for trial/free companies pre-subscription. |
| `users.role` | `worker`, `admin`, `super_admin` | **app-only** | `server/permissions.js`, scattered checks | Auth boundary. Permission system is allow-list, so a bad value can't escalate — but it can lock a user out of every module. |
| `users.role_id` (FK) | references `roles.id` | enforced (FK) | n/a | The new permission system. FK is the constraint. |
| `time_entries.status` | `pending`, `approved`, `rejected` | **enforced** (CHECK) | scattered UPDATEs in `server/routes/admin.js` | Approval workflow + payroll inclusion. |
| `time_entries.clock_source` | `worker`, `admin`, `log_entry` | **enforced** (CHECK in `0071`) | scattered INSERTs | Audit trail; the constraint blocks any unknown source from being recorded. |
| `active_clock.clock_source` | `worker`, `admin` | **enforced** (CHECK in `0071`) | `server/routes/clock.js`, `server/routes/admin.js` clock-in paths | Same idea; tighter set because admin/worker are the only callers that create active_clock rows. |
| `projects.wage_type` | `regular`, `prevailing` | **enforced** (CHECK) | `server/routes/admin.js:1684` | Payroll calculation. `time_entries.wage_type` inherits this. |
| `users.rate_type` | `hourly`, `daily` | **enforced** (CHECK in `0101`) | `server/constants/userEnums.js`, `server/routes/admin.js:1331` | Daily-rate pay calc + `day_mark_mode` gate. |
| `users.overtime_rule` (per-user) | `daily`, `weekly`, `none` | **enforced** (CHECK in `0101`) | `server/constants/userEnums.js`, `server/routes/admin.js:1214` | Overtime calculation. |
| `users.worker_type` | `employee`, `contractor`, `subcontractor`, `owner` | **enforced** (CHECK in `0071`) | `server/routes/admin.js:1217` | Display + report filtering on worker profile. |
| `reimbursements.status` | `pending`, `approved`, `rejected` | **enforced** (CHECK in `0071`) | `server/routes/reimbursements.js` | Financial workflow. |
| `settings.value` (key=`overtime_rule`) | `daily`, `weekly` | **app-only** | `server/routes/admin.js` PATCH validation | Company-wide overtime calc. |
| `settings.value` (key=`invoice_signature`) | `none`, `optional`, `required` | **app-only** | `server/routes/admin.js` PATCH validation | Whether workers must sign invoices before exporting. |

## Medium-stakes columns (workflow / business logic)

| Table.column | Allowed values | DB enforcement | App validation | Stakes |
|---|---|---|---|---|
| `projects.status` | `planning`, `in_progress`, `on_hold`, `completed` | **enforced** (CHECK in `0101`) | `server/constants/projectEnums.js`, `server/routes/admin.js:1679` | Project tracking dashboards. Caused the `0249ac4` bug — column is nullable, so the CHECK is `IS NULL OR ...`. |
| `daily_reports.status` | `draft`, `submitted`, `reviewed` | **enforced** (CHECK in `0100`, was wrong in `0071`) | `server/routes/dailyReports.js:199` | Daily-report workflow + edit lock. `0071` had `approved` instead; `0100` corrects to `reviewed`. |
| `field_reports.status` | `draft`, `submitted`, `reviewed` | **enforced** (CHECK in `0100`, was missing `draft` in `0071`) | `server/routes/fieldReports.js:30` | Field-report workflow + edit lock. |
| `incident_reports.status` | `open`, `under_review`, `closed` | **enforced** (CHECK in `0100`, was missing `under_review` in `0071`) | `server/routes/incidents.js:8` | Incident workflow. |
| `incident_reports.type` | `near_miss`, `first_aid`, `recordable`, `lost_time`, `property_damage`, `other` | **enforced** (CHECK in `0101`) | `server/constants/incidentEnums.js`, `server/routes/incidents.js` | Safety / OSHA-style metrics. |
| `punchlist_items.status` | `open`, `in_progress`, `resolved`, `verified` | **enforced** (CHECK in `0101`) | `server/constants/punchlistEnums.js`, `server/routes/punchlist.js` | Punchlist filtering + closure tracking. |
| `punchlist_items.priority` | `low`, `normal`, `high`, `urgent` | **enforced** (CHECK in `0101`) | `server/constants/punchlistEnums.js`, `server/routes/punchlist.js` | Priority filter dropdown. |
| `rfis.status` | `open`, `answered`, `closed` | **enforced** (CHECK in `0071`) | `server/routes/rfis.js:80` | RFI workflow + reply gating. |
| `inspections.status` | `pass`, `fail`, `pending` | **enforced** (CHECK) | `server/routes/inspections.js:102` | Inspection results. |
| `service_requests.status` | `new`, `in_review`, `converted`, `declined`, `spam` | **enforced** (CHECK in `0101`) | `server/constants/serviceRequestEnums.js`, `server/routes/serviceRequests.js` | Public-intake triage. |
| `time_off_requests.status` | `pending`, `approved`, `denied` | **enforced** (CHECK in `0071`) | `server/routes/timeOff.js:101,159` | PTO approval workflow. |
| `time_off_requests.type` | `vacation`, `sick`, `personal`, `other` | **enforced** (CHECK in `0071`) | `server/routes/timeOff.js:9` | PTO categorization for reports. |
| `qbo_sync_errors.entity_type` | `time_entry`, `reimbursement` | **enforced** (CHECK in `0071`) | `server/services/qbo.js` (writes only) | Discriminator for the QBO error log. |
| `project_invoices.payment_status` | `unknown`, `paid`, `partial`, `unpaid` | **enforced** (CHECK in `0071`) | (verify route) | Invoice payment tracking. |
| `estimates.status` | `draft`, `sent`, `accepted`, `declined`, `expired`, `withdrawn` | **enforced** (CHECK in `0104`) | `server/constants/projectMoneyEnums.js`, `server/routes/estimates.js` | Pre-work quote lifecycle. Sent/accepted/declined/expired are frozen — edits must duplicate to a new estimate. |
| `estimate_lines.category` | `labor`, `materials`, `equipment`, `subs`, `overhead`, `contingency`, `other` | **enforced** (CHECK in `0104`) | `server/constants/projectMoneyEnums.js` (`MONEY_CATEGORIES`) | The shared category vocabulary that runs through estimate → budget → spend → P&L. Same seven values reused on `project_budget_categories.category`, `change_order_lines.category`, `project_expenses.category` (forthcoming). Keep them in lockstep. |
| `project_budget_categories.category` | (same 7 values) | **enforced** (CHECK in `0105`) | `server/constants/projectMoneyEnums.js` (`MONEY_CATEGORIES`), `server/routes/projectBudget.js`, `server/routes/estimates.js` (convert) | Phase 2 of project money flow. One row per category per project. Backfill in 0105 puts existing `projects.budget_dollars` into the `labor` bucket. `projects.budget_dollars` stays populated in lockstep with the sum for one release while reads migrate, then drops in a later migration. |
| `project_expenses.category` | (same 7 values) | **enforced** (CHECK in `0106`) | `server/constants/projectMoneyEnums.js` (`MONEY_CATEGORIES`), `server/routes/projectSpend.js` | Phase 3 of project money flow. Free-form spend lines (fuel, dump fees, equipment rentals, permits) that don't have a better module-specific tracker. Rolled up by `GET /projects/:id/spend` into the matching bucket on the budget bar. |
| `subcontract_pos.status` | `draft`, `issued`, `partial`, `complete`, `cancelled` | **enforced** (CHECK in `0107`) | `server/constants/subcontractEnums.js`, `server/routes/subcontractors.js` | Sub PO lifecycle. Issued/partial → spend-rollup "committed" bucket; partial/complete adds to "spent". Payment writes auto-transition issued → partial → complete via `nextStatusAfterPayment()` inside the payment TX. |
| `subcontractor_documents.doc_type` | `coi`, `w9`, `license`, `contract`, `other` | **enforced** (CHECK in `0107`) | `server/constants/subcontractEnums.js`, `server/routes/subcontractors.js` | COI / W-9 / license tracking for compliance. Matches the pattern from `client_documents`. |
| `change_orders.status` | `draft`, `sent`, `accepted`, `declined`, `withdrawn` | **enforced** (CHECK in `0109`) | `server/constants/projectMoneyEnums.js` (`CHANGE_ORDER_STATUSES`), `server/routes/changeOrders.js` | Mid-project scope adjustments. Narrower lifecycle than estimates: no `expired` (COs don't time out) and no `converted` (CO never creates a new project; on accept it bumps the existing project's budget categories). `budget_applied_at` column on the row is the idempotency flag so a re-fire can't double-bump. |
| `change_order_lines.category` | (same 7 values) | **enforced** (CHECK in `0109`) | `server/constants/projectMoneyEnums.js` (`MONEY_CATEGORIES`), `server/routes/changeOrders.js` | Shared category vocabulary again — accepting a CO sums these by category and increments the matching `project_budget_categories.budget_cents` rows. |
| `inventory_items.default_estimate_category` | (same 7 values, nullable) | **enforced** (CHECK in `0108`) | `server/constants/projectMoneyEnums.js`, `server/routes/catalog.js` | Per-item hint for the estimate-line picker — selecting a catalog item pre-fills the line's category. Defaults to `materials` at fill time if null. |
| `submittals.status` | `draft`, `pending_internal`, `sent_to_reviewer`, `approved`, `approved_as_noted`, `revise_resubmit`, `rejected`, `closed`, `void` | **enforced** (CHECK in `0110`) | `server/constants/submittalEnums.js`, `server/routes/submittals.js` | Submittal lifecycle: draft → pending_internal → sent_to_reviewer → one of four stamps. `approved_as_noted` = approved with redline corrections. Revisions create a new row with `superseded_by_id` on the old row pointing forward. |
| `submittal_documents.kind` | `submission`, `stamped_return`, `spec`, `reference`, `other` | **enforced** (CHECK in `0110`) | `server/constants/submittalEnums.js`, `server/routes/submittals.js` | Distinguishes the original submission from the stamped return so UI can show side-by-side comparison. |
| `submittal_audit.action` | `created`, `sent_internal`, `sent_reviewer`, `stamp_received`, `revised`, `closed`, `voided`, `document_added`, `document_removed` | **enforced** (CHECK in `0110`) | `server/constants/submittalEnums.js`, `server/routes/submittals.js` | Module-specific audit (separate from the global audit_log so the trail survives even if the module is later dropped). |
| `estimate_audit.action` | `created`, `sent`, `accepted`, `declined`, `expired`, `withdrawn`, `converted` | **enforced** (CHECK in `0104`) | `server/constants/projectMoneyEnums.js`, `server/routes/estimates.js` | Audit trail. Public client actions (accept/decline) write rows with `actor_kind='client'`; cron-driven (expire) write `'system'`. |
| `estimate_audit.actor_kind` | `admin`, `client`, `system` | **enforced** (CHECK in `0104`) | `server/constants/projectMoneyEnums.js`, `server/routes/estimates.js` | Distinguishes a public token-keyed action (no `actor_user_id`) from a logged-in admin or a background job. |

## Cosmetic / UI columns

| Table.column | Allowed values | DB enforcement | App validation | Stakes |
|---|---|---|---|---|
| `users.language` | `English`, `Spanish` | **enforced** (CHECK in `0101`) | `server/constants/userEnums.js`, `server/routes/admin.js:1045` | Default UI language. Note values are full names, not ISO codes — keep in sync with the top-level keys in `client/src/i18n.js`. |
| `inbox.type` | open-ended (see note) | **app-only** | scattered `createInboxItem` calls — no central list | Drives notification icon / routing. New types added casually; treating it as a closed enum would require a refactor first. |
| `inventory_items.locations[].type` | `warehouse`, `job_site`, `truck`, `other` | **app-only** (JSON column) | `server/constants/inventoryEnums.js`, `server/routes/inventory.js:534` | JSON-shaped column; CHECKs on JSON contents are awkward. App-side constant lives in inventoryEnums.js. |
| `inventory_cycle_counts.count_type` | `cycle`, `full`, `audit`, `reconcile` | **enforced** (CHECK in `0101`) | `server/constants/inventoryEnums.js`, `server/routes/inventory.js:924` | Inventory audit type. (Note: the column name is `count_type`, not `type` — the doc had this wrong before `0101`.) |

### `inbox.type` — the unfinished one

`inbox.type` is the most-written, least-constrained enum-like column in
the codebase. Every `createInboxItem(...)` and `createInboxItemBatch(...)`
call uses a free-form string. Currently observed values across the
server (probably incomplete):

`approval`, `rejection`, `comment`, `announcement`, `inactive_workers`,
`stale_active_clock`, `timeoff_request`, `timeoff_approved`,
`timeoff_denied`, `shift_assigned`, `shift_updated`, `shift_cancelled`,
`shift_cantmake`, `signoff`, `location_denied`, `overtime_alert`,
`service_request`, `low_stock`, `equipment_maintenance`.

Before constraining: collect the canonical list into
`server/constants/inboxTypes.js`, route every existing call through it,
THEN add a CHECK constraint that matches.

## Settings keys (`settings.key` allow-list)

`settings.key` is itself an enum-like column — only known keys should be
written. The allow-list lives in `server/settingsDefaults.js`:

- `FEATURE_KEYS` — boolean flags (`feature_*`, `module_*`).
- `STRING_KEYS` — string-valued settings.
- Everything else is treated as numeric.

No DB CHECK on `settings.key`. PATCH `/admin/settings` validates against
the allowlist; raw INSERTs would not. Update `settingsDefaults.js`
**and** the PATCH `numericKeys` / `stringKeys` arrays in
`server/routes/admin.js` **and** this file when adding a new key. (We
got bit twice by this: `shift_reminder_hour`, `pto_annual_days`,
`cycle_count_audit_pct`, and `cycle_count_reconcile_threshold` sat in
`ADMIN_SETTINGS_DEFAULTS` without being in the PATCH allowlist until the
2026-04-30 audit; they're now wired through.)

### Recently-added string settings (no DB CHECK; free-form)

- `label_work`     (default `'Project'`) — what the company calls a project / job / engagement.
- `label_client`   (default `'Customer'`) — what the company calls a client.
- `label_worker`   (default `'Team Member'`) — what the company calls a worker.
- `label_field`    (default `'Field Work'`) — what the company calls the field-work module.

These are free-form display labels. Components read `settings.label_*`
at render time and fall back to the default if missing. Migration 0102
rewrote the old `label_work='Work'` rows to `'Project'` for companies
that had the previous default.

- `setup_questionnaire_completed_at` (ISO timestamp string) — set when
  an admin finishes (or dismisses) the first-run setup questionnaire.

## Boolean-flag columns

These are fixed-value but Postgres enforces them via the `BOOLEAN` type.
Listed for completeness so they're not flagged as gaps:

`users.active`, `users.day_mark_mode`, `users.mfa_enabled`,
`projects.active`, `time_entries.locked`, `shifts.cant_make_it`,
`companies.is_exempt`, etc.

---

## Open follow-ups

Two columns remain on app-only protection, each blocked by a
non-trivial precondition:

1. **`inbox.type`.** The doc lists ~19 distinct values seen across the
   server, written via `createInboxItem(...)` calls scattered through
   every route file. Centralise the call sites (single
   `createInboxItem(type, ...)` wrapper that imports a constants
   array) BEFORE adding a CHECK — otherwise every new feature breaks
   the constraint.

2. **`inventory_items.locations[].type`.** JSON-shaped column. PG can
   constrain JSON contents but it's brittle. Lower urgency given the
   small set and infrequent writes.

Other structural follow-ups:

- The client side has its own copies of some enum lists
  (`client/src/pages/ProjectsPage.jsx` has `VALID_PROJECT_STATUSES`,
  dropdowns hardcode option values). Consider exposing a
  `/admin/enums` endpoint or a generated client constants file so the
  client stays in sync without manual duplication.
- Some columns the registry references rely on a single literal write
  site rather than a validation array (e.g. `clock_source` is set per
  call). Those were verified manually during the audit but a future
  refactor could route them through the constants too.
