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
| `users.worker_type` | `employee`, `contractor`, `subcontractor`, `owner`, `unpaid` | **enforced** (CHECK in `0071`, `unpaid` added in `0161`) | `server/constants/userEnums.js` (`USER_WORKER_TYPES`) | Display + report filtering + QBO routing (contractor/subcontractor → 1099 Vendor). **`unpaid`** = tracked but earns nothing: excluded from every pay surface via the `buildPayStatement` guard + list filters (payroll run, pay stubs, worker invoices, OT report, payroll CSV, certified payroll, scheduled pay email, QBO time sync). |
| `worker_deductions.kind` | `percent`, `fixed` | **enforced** (CHECK `chk_worker_deductions_kind` in `0143`) | `server/constants/deductionEnums.js` (`DEDUCTION_KINDS`), `server/utils/deductions.js`, `server/routes/admin.js` (PUT `/workers/:id/deductions`) | Per-worker pay-stub deduction lines (loans, garnishments, worker-specific tax). `percent` = % of gross wages (optional `cap_amount`); `fixed` = flat amount. Same vocabulary as the company-wide `deductions` settings JSON. Applied on the per-worker pay stub → net pay. |
| `reimbursements.status` | `pending`, `approved`, `rejected` | **enforced** (CHECK in `0071`) | `server/routes/reimbursements.js` | Financial workflow. |
| `payroll_runs.status` | `finalized`, `void` | **enforced** (CHECK in `0156`) | `server/constants/payrollEnums.js` (`PAYROLL_RUN_STATUSES`), `server/routes/admin.js` (finalize / `/void`) | A finalized run is a locked snapshot of a live payroll run (Advanced Payroll). `void` retires it from the payable set while keeping the record. |
| `payroll_run_checks.status` | `pending`, `paid` | **enforced** (CHECK in `0156`) | `server/constants/payrollEnums.js` (`PAYROLL_CHECK_STATUSES`), `server/routes/admin.js` (`/paid`) | Per-check paid state inside a finalized run. `paid` stamps `paid_at`. |
| `settings.value` (key=`overtime_rule`) | `daily`, `weekly` | **app-only** | `server/routes/admin.js` PATCH validation | Company-wide overtime calc. |
| `settings.value` (key=`overtime_rate_method`) | `rate_when_worked`, `weighted_average` | **app-only** | `server/constants/payEnums.js` (`OVERTIME_RATE_METHODS`), `server/routes/admin.js` PATCH validation | How OT is priced when a worker earns >1 base rate in a period. `rate_when_worked` (default): each OT hour at the rate it earned. `weighted_average`: FLSA blended regular rate. Consumed by `server/utils/rateAwareOvertime.js`. |
| `settings.value` (key=`overtime_wage_priority`) | `chronological`, `regular_first` | **app-only** | `server/constants/payEnums.js` (`OVERTIME_WAGE_PRIORITIES`), `server/routes/admin.js` PATCH validation, `server/utils/payCalculations.js` (`annotateEntryOvertime`) | Which wage type absorbs OT on a mixed regular+prevailing day/week (simple/rate-aware OT path only). `chronological` (default) = later hours worked become OT regardless of wage type (today's behavior). `regular_first` = prevailing hours fill straight-time first, so OT is drawn from REGULAR hours first (prevailing stays whole). Opt-in, jurisdiction-sensitive. No-op on premium OT configs (prevailing stays flat there). |
| `settings.value` (key=`invoice_signature`) | `none`, `optional`, `required` | **app-only** | `server/routes/admin.js` PATCH validation | Whether workers must sign invoices before exporting. |
| `settings.value` (key=`estimate_default_markups`) | JSON map `{category: pct}`; keys ∈ the 7 money categories, values `0`–`1000` | **app-only** (JSON, shape+range validated on write) | `server/constants/projectMoneyEnums.js` (`MONEY_CATEGORIES`), `server/routes/admin.js` PATCH validation, `server/routes/catalog.js` (`companyDefaultMarkup`) | Company default markup % by estimate category. Applied by the catalog estimate-line resolver when an item has no explicit sell price and no item-level markup. Empty = no defaults (raw supplier cost flows through). Edited on the Material Catalog page. |
| `settings.value` (key=`map_provider`) | `google`, `apple`, `osm`, `waze`, `bing` | **app-only** | `server/constants/mapEnums.js` (`MAP_PROVIDERS`), `server/routes/admin.js` PATCH validation, `client/src/utils/maps.js` + `components/MapLink.jsx` | Which external map service the "open in maps" links (Leaflet marker popups + address/coordinate links) point at. Default `google`. Client reads it via `useMapProvider()` (SettingsContext). |
| `settings.value` (key=`currency`) | ISO 4217: `USD`, `CAD`, `EUR`, `GBP`, `MXN`, `HNL`, `GTQ`, `NIO`, `BZD`, `CRC`, `PAB` | **app-only** (shape only — see note) | `server/routes/admin.js:200` PATCH regex; dropdown `client/src/components/ManageRates.jsx`; locale maps `client/src/utils.js` + `server/currency.js` | Display currency for every money figure: app, PDFs, public client pages, report emails. |

> **`currency` is validated by shape, not membership.** The PATCH check is only
> `/^[A-Z]{3}$/`, so any 3-letter string is accepted. The list above is the set
> the **dropdown offers** and the locale maps know. An unmapped-but-well-formed
> code (e.g. `XYZ`) is stored happily and then falls back to the `en-US` locale,
> which renders the bare code (`XYZ 1,234.50`) instead of a symbol. Adding a
> currency means updating **three** places: the `ManageRates` dropdown,
> `CURRENCY_LOCALES` in `client/src/utils.js`, and the mirrored map in
> `server/currency.js`. Intl takes the symbol from the *locale*, not the
> currency code — `en-US` + `HNL` gives `HNL 1,234.50`, `es-HN` + `HNL` gives
> `L 1,234.50` — which is why the locale map exists at all.

## Medium-stakes columns (workflow / business logic)

| Table.column | Allowed values | DB enforcement | App validation | Stakes |
|---|---|---|---|---|
| `projects.status` | `planning`, `in_progress`, `on_hold`, `completed` | **enforced** (CHECK in `0101`) | `server/constants/projectEnums.js`, `server/routes/admin.js:1679` | Project tracking dashboards. Caused the `0249ac4` bug — column is nullable, so the CHECK is `IS NULL OR ...`. |
| `projects.priority` | `high`, `normal`, `low`, `hidden` | **enforced** (CHECK in `0178`) | `server/constants/projectEnums.js` (`PROJECT_PRIORITIES`), `server/routes/admin.js` (project update), `server/routes/projects.js` (worker list filter/order) | Visibility priority — whether a project shows in workers' pickers and in what order. `high` first, `low` last, `hidden` = excluded from the worker `/work` list (admins still see it in `/admin/projects` to manage). NOT NULL DEFAULT `normal`. Set from the project's Visibility section. |
| `projects.hour_limit_mode` | `off`, `warn`, `hard` | **enforced** (CHECK in `0167`) | `server/constants/projectEnums.js` (`HOUR_LIMIT_MODES`), `server/routes/admin.js` (project create/update), `server/utils/projectHourLimits.js` | Per-project worker hour cap. `off` = no limit (default). `warn` = worker/admin warned when the daily/weekly limit is crossed, nothing blocked. `hard` = shift stopped, or switched to `hour_limit_overflow_project_id`, at the exact limit instant (deterministic limit-time, applied lazily on `/clock/status` + `/admin/active-clocks`); a fresh clock-in past the limit is blocked/redirected. Companion columns `daily_hour_limit` / `weekly_hour_limit` (NUMERIC, ≥0, either/both) and `hour_limit_overflow_project_id` (FK projects, hard-mode only). NOT NULL DEFAULT `off`. |
| `work_orders.status` | `open`, `scheduled`, `in_progress`, `completed`, `canceled` | **enforced** (CHECK in `0127`) | `server/constants/workOrderEnums.js`, `server/routes/workOrders.js` | Work-order (dispatch/service) lifecycle. NOT NULL DEFAULT `open`, so plain `IN (...)` CHECK. Setting `completed` stamps `completed_at`. |
| `work_orders.priority` | `low`, `normal`, `high`, `urgent` | **enforced** (CHECK in `0127`) | `server/constants/workOrderEnums.js`, `server/routes/workOrders.js` | Work-order dispatch priority. NOT NULL DEFAULT `normal`. |
| `daily_reports.status` | `draft`, `submitted`, `reviewed` | **enforced** (CHECK in `0100`, was wrong in `0071`) | `server/routes/dailyReports.js:199` | Daily-report workflow + edit lock. `0071` had `approved` instead; `0100` corrects to `reviewed`. |
| `field_reports.status` | `draft`, `submitted`, `reviewed` | **enforced** (CHECK in `0100`, was missing `draft` in `0071`) | `server/routes/fieldReports.js:30` | Field-report workflow + edit lock. |
| `incident_reports.status` | `open`, `under_review`, `closed` | **enforced** (CHECK in `0100`, was missing `under_review` in `0071`) | `server/routes/incidents.js:8` | Incident workflow. |
| `incident_reports.type` | `near_miss`, `first_aid`, `recordable`, `lost_time`, `property_damage`, `other` | **enforced** (CHECK in `0101`) | `server/constants/incidentEnums.js`, `server/routes/incidents.js` | Safety / OSHA-style metrics. |
| `punchlist_items.status` | `open`, `in_progress`, `resolved`, `verified` | **enforced** (CHECK in `0101`) | `server/constants/punchlistEnums.js`, `server/routes/punchlist.js` | Punchlist filtering + closure tracking. |
| `punchlist_items.priority` | `low`, `normal`, `high`, `urgent` | **enforced** (CHECK in `0101`) | `server/constants/punchlistEnums.js`, `server/routes/punchlist.js` | Priority filter dropdown. |
| `daily_checklists.status` | `pending`, `paused`, `active`, `completed`, `canceled` | **enforced** (CHECK in `0163`) | `server/constants/dailyChecklistEnums.js`, `server/routes/dailyChecklist.js` | Daily-checklist day lifecycle. NOT NULL DEFAULT `pending`. Partial UNIQUE index enforces one `active` day per project. |
| `daily_checklists.schedule_type` | `calendar`, `ordinal`, `adhoc` | **enforced** (CHECK in `0163`) | `server/constants/dailyChecklistEnums.js`, `server/routes/dailyChecklist.js` | How a day was scheduled. NOT NULL DEFAULT `adhoc`. |
| `daily_checklist_items.source` | `recurring`, `scheduled`, `manual`, `rollover` | **enforced** (CHECK in `0163`) | `server/constants/dailyChecklistEnums.js`, `server/routes/dailyChecklist.js` | Where a day's item came from (drives rollover dedup + display). NOT NULL DEFAULT `manual`. |
| `daily_checklist_items.kind` | `check`, `text` | **enforced** (CHECK in `0166`) | `server/constants/dailyChecklistEnums.js`, `server/routes/dailyChecklist.js` | Checkbox vs free-text field. NOT NULL DEFAULT `check`. `check` uses `checked`, `text` uses `value`. |
| `daily_checklist_recurring_items.kind` | `check`, `text` | **enforced** (CHECK in `0166`) | `server/constants/dailyChecklistEnums.js`, `server/routes/dailyChecklist.js` | Same on the recurring template; copied onto each day's items. NOT NULL DEFAULT `check`. |
| `daily_checklist_assignments.mode` + `daily_checklist_items.mode` | `shared`, `individual` | **enforced** (CHECK in `0173`/`0172`) | `server/constants/dailyChecklistEnums.js` (`DAILY_CHECKLIST_ITEM_MODES`), `server/routes/dailyChecklist.js` | Project Daily. An assignment binds a Checklist Builder template to a project scope + team-role scope + this mode. `shared` = one row, everyone with a matching role shares the check state; `individual` = each matching person gets a private check state in `daily_checklist_item_user_state`. NOT NULL DEFAULT `shared`. Scope columns are FKs, not enums: `assignments.project_id` (NULL = all projects, else one project — single scope, `0174`), `assignments.role_ids` / `items.role_ids` INT[] (NULL/empty = all team types, else a set). *(0172 briefly put mode/role_id on `recurring_items`; `0173` moved to assignments; `0174` collapsed `project_ids[]` → single `project_id`.)* |
| `daily_checklist_assignments.schedule_type` | `none`, `every`, `ordinal`, `date` | **enforced** (CHECK in `0175`, widened in `0176`) | `server/constants/dailyChecklistEnums.js` (`DAILY_CHECKLIST_ASSIGNMENT_SCHEDULES`), `server/routes/dailyChecklist.js` | When a Project Daily checklist seeds a day. `none` = no particular day (assigned but not seeded — a parked state, DEFAULT since `0176`); `every` = every worked day; `ordinal` = only the Nth worked day (`ordinal_target`); `date` = only a specific `scheduled_date`. `none` matches no day at assembly. An ordinal + a date assignment that resolve to the same worked day both match at assembly → their items combine (deduped) into that day. Companion `carryover` bool (per assignment) sets whether its incomplete items roll to the next day; `daily_checklist_items.carryover` (DEFAULT true) records it per assembled item. |
| `rfis.status` | `open`, `answered`, `closed` | **enforced** (CHECK in `0071`) | `server/routes/rfis.js:80` | RFI workflow + reply gating. |
| `inspections.status` | `pass`, `fail`, `pending` | **enforced** (CHECK) | `server/routes/inspections.js:102` | Inspection results. |
| `service_requests.status` | `new`, `in_review`, `converted`, `declined`, `spam` | **enforced** (CHECK in `0101`) | `server/constants/serviceRequestEnums.js`, `server/routes/serviceRequests.js` | Public-intake triage. |
| `time_off_requests.status` | `pending`, `approved`, `denied` | **enforced** (CHECK in `0071`) | `server/routes/timeOff.js:101,159` | PTO approval workflow. |
| `time_off_requests.type` | `vacation`, `sick`, `personal`, `other` | **enforced** (CHECK in `0071`) | `server/routes/timeOff.js:9` | PTO categorization for reports. |
| `qbo_sync_errors.entity_type` | `time_entry`, `reimbursement` | **enforced** (CHECK in `0071`) | `server/services/qbo.js` (writes only) | Discriminator for the QBO error log. |
| `project_invoices.payment_status` | `unknown`, `paid`, `partial`, `unpaid` | **enforced** (CHECK in `0071`) | (verify route) | **DORMANT** — the QBO mirror was unified into native `invoices` in `0150` (rows copied, `lien_waivers` FK repointed). No code reads/writes `project_invoices` anymore; the table is kept as a rollback backup and dropped in a follow-up migration. QBO invoices now live in `invoices` (`source='qbo'`). |
| `estimates.status` | `draft`, `sent`, `accepted`, `declined`, `expired`, `withdrawn` | **enforced** (CHECK in `0104`) | `server/constants/projectMoneyEnums.js`, `server/routes/estimates.js` | Pre-work quote lifecycle. Sent/accepted/declined/expired are frozen — edits must duplicate to a new estimate. |
| `estimate_lines.category` | `labor`, `materials`, `equipment`, `subs`, `overhead`, `contingency`, `other` | **enforced** (CHECK in `0104`) | `server/constants/projectMoneyEnums.js` (`MONEY_CATEGORIES`) | The shared category vocabulary that runs through estimate → budget → spend → P&L. Same seven values reused on `project_budget_categories.category`, `change_order_lines.category`, `project_expenses.category` (forthcoming). Keep them in lockstep. |
| `project_budget_categories.category` | (same 7 values) | **enforced** (CHECK in `0105`) | `server/constants/projectMoneyEnums.js` (`MONEY_CATEGORIES`), `server/routes/projectBudget.js`, `server/routes/estimates.js` (convert) | Phase 2 of project money flow. One row per category per project. Backfill in 0105 puts existing `projects.budget_dollars` into the `labor` bucket. `projects.budget_dollars` stays populated in lockstep with the sum for one release while reads migrate, then drops in a later migration. |
| `project_expenses.category` | (same 7 values) | **enforced** (CHECK in `0106`) | `server/constants/projectMoneyEnums.js` (`MONEY_CATEGORIES`), `server/routes/projectSpend.js` | Phase 3 of project money flow. Free-form spend lines (fuel, dump fees, equipment rentals, permits) that don't have a better module-specific tracker. Rolled up by `GET /projects/:id/spend` into the matching bucket on the budget bar. |
| `subcontract_pos.status` | `draft`, `issued`, `partial`, `complete`, `cancelled` | **enforced** (CHECK in `0107`) | `server/constants/subcontractEnums.js`, `server/routes/subcontractors.js` | Sub PO lifecycle. Issued/partial → spend-rollup "committed" bucket; partial/complete adds to "spent". Payment writes auto-transition issued → partial → complete via `nextStatusAfterPayment()` inside the payment TX. |
| `subcontractor_documents.doc_type` | `coi`, `w9`, `license`, `contract`, `other` | **enforced** (CHECK in `0107`) | `server/constants/subcontractEnums.js`, `server/routes/subcontractors.js` | COI / W-9 / license tracking for compliance. Matches the pattern from `client_documents`. |
| `change_orders.status` | `draft`, `sent`, `accepted`, `declined`, `withdrawn` | **enforced** (CHECK in `0109`) | `server/constants/projectMoneyEnums.js` (`CHANGE_ORDER_STATUSES`), `server/routes/changeOrders.js` | Mid-project scope adjustments. Narrower lifecycle than estimates: no `expired` (COs don't time out) and no `converted` (CO never creates a new project; on accept it bumps the existing project's budget categories). `budget_applied_at` column on the row is the idempotency flag so a re-fire can't double-bump. |
| `change_order_lines.category` | (same 7 values) | **enforced** (CHECK in `0109`) | `server/constants/projectMoneyEnums.js` (`MONEY_CATEGORIES`), `server/routes/changeOrders.js` | Shared category vocabulary again — accepting a CO sums these by category and increments the matching `project_budget_categories.budget_cents` rows. |
| `inventory_items.default_estimate_category` | (same 7 values, nullable) | **enforced** (CHECK in `0108`) | `server/constants/projectMoneyEnums.js`, `server/routes/catalog.js` | Per-item hint for the estimate-line picker — selecting a catalog item pre-fills the line's category. Defaults to `materials` at fill time if null. |
| `invoices.status` | `draft`, `sent`, `partial`, `paid`, `void` | **enforced** (CHECK in `0149`) | `server/constants/projectMoneyEnums.js` (`INVOICE_STATUSES`), `server/routes/invoices.js` | Native owner-side invoice lifecycle. `partial`/`paid` derive from recorded `invoice_payments`; `void` cancels. Distinct from `project_invoices.payment_status` (a QBO-mirror field). Sent/partial/paid/void freeze line edits (`INVOICE_FROZEN_STATUSES`) — correct by voiding + reissuing. |
| `invoices.source` | `scratch`, `estimate`, `project`, `qbo` | **enforced** (CHECK in `0149`, widened in `0150`) | `server/constants/projectMoneyEnums.js`, `server/routes/invoices.js`, `server/routes/qbo.js` | Which creation path produced it — blank, copied from an accepted estimate, generated from project time + expenses, or synced from QuickBooks (`qbo`, carries `qbo_invoice_id`). |
| `invoice_lines.category` | (same 7 values) | **enforced** (CHECK in `0149`) | `server/constants/projectMoneyEnums.js` (`MONEY_CATEGORIES`) | The shared money-flow category vocabulary again — same seven as estimate/budget/CO/expense lines. |
| `invoice_payments.method` | `check`, `card`, `cash`, `ach`, `other` | **enforced** (CHECK in `0149`) | `server/constants/projectMoneyEnums.js` (`INVOICE_PAYMENT_METHODS`), `server/routes/invoices.js` | How a recorded payment came in. Payments sum to derive the invoice's partial/paid status + open balance. |
| `submittals.status` | `draft`, `pending_internal`, `sent_to_reviewer`, `approved`, `approved_as_noted`, `revise_resubmit`, `rejected`, `closed`, `void` | **enforced** (CHECK in `0110`) | `server/constants/submittalEnums.js`, `server/routes/submittals.js` | Submittal lifecycle: draft → pending_internal → sent_to_reviewer → one of four stamps. `approved_as_noted` = approved with redline corrections. Revisions create a new row with `superseded_by_id` on the old row pointing forward. |
| `submittal_documents.kind` | `submission`, `stamped_return`, `spec`, `reference`, `other` | **enforced** (CHECK in `0110`) | `server/constants/submittalEnums.js`, `server/routes/submittals.js` | Distinguishes the original submission from the stamped return so UI can show side-by-side comparison. |
| `submittal_audit.action` | `created`, `sent_internal`, `sent_reviewer`, `stamp_received`, `revised`, `closed`, `voided`, `document_added`, `document_removed` | **enforced** (CHECK in `0110`) | `server/constants/submittalEnums.js`, `server/routes/submittals.js` | Module-specific audit (separate from the global audit_log so the trail survives even if the module is later dropped). |
| `project_closeouts.status` | `open`, `in_progress`, `substantially_complete`, `final_complete`, `closed`, `reopened` | **enforced** (CHECK in `0111`) | `server/constants/closeoutEnums.js`, `server/routes/closeout.js` | Project closeout lifecycle. `substantially_complete` requires punchlist + final_inspection done; `final_complete` requires every required item done/waived/n_a. Sets the warranty clock at substantial completion. |
| `project_closeout_items.status` | `pending`, `in_progress`, `done`, `waived`, `n_a` | **enforced** (CHECK in `0111`) | `server/constants/closeoutEnums.js`, `server/routes/closeout.js` | Per-checklist-item status. Items with `auto_source` set are computed on read from other modules' state and cannot be toggled directly. |
| `project_closeout_items.category` + `closeout_checklist_template.category` | `punchlist`, `as_builts`, `warranty`, `o_and_m`, `lien_waivers_subs`, `lien_waiver_to_owner`, `final_invoice`, `retainage_release`, `certificate_substantial`, `final_inspection`, `custom` | **enforced** (CHECK in `0111`) | `server/constants/closeoutEnums.js` (`CLOSEOUT_ITEM_CATEGORIES` + `DEFAULT_CHECKLIST`), `server/routes/closeout.js` | Identifies what kind of step each item represents; `custom` covers company-specific additions. |
| `lien_waivers.direction` | `from_sub`, `from_us` | **enforced** (CHECK in `0112`) | `server/constants/lienWaiverEnums.js`, `server/routes/lienWaivers.js` | Distinguishes waivers we're collecting from subs (from_sub) vs. waivers we're issuing to the owner (from_us). |
| `lien_waivers.waiver_type` | `conditional_progress`, `unconditional_progress`, `conditional_final`, `unconditional_final` | **enforced** (CHECK in `0112`) | `server/constants/lienWaiverEnums.js`, `server/routes/lienWaivers.js` | Standard 4-quadrant taxonomy (conditional vs unconditional × progress vs final). `unconditionalFor()` maps conditional → unconditional for the convert flow. |
| `lien_waivers.status` | `draft`, `sent`, `signed`, `received`, `superseded`, `void` | **enforced** (CHECK in `0112`) | `server/constants/lienWaiverEnums.js`, `server/routes/lienWaivers.js` | Lifecycle: draft → sent (tokenized email to counterparty) → signed (typed/drawn/wet/docusign) → received (we have it in hand). The closeout module reads signed+received as "in-hand" status for the auto-status checklist items. |
| `lien_waivers.signature_method` | `typed`, `drawn`, `wet_signed_upload`, `docusign` (nullable) | **enforced** (CHECK in `0112`) | `server/constants/lienWaiverEnums.js`, `server/routes/lienWaivers.js` | How the signature was captured. Typed = typed-name + IP + timestamp; drawn = base64 signature pad; wet_signed_upload = scanned upload attached as a doc; docusign = envelope reference (future integration). |
| `appointments.status` | `booked`, `confirmed`, `completed`, `cancelled`, `no_show`, `rescheduled` | **enforced** (CHECK in `0113`) | `server/constants/bookingEnums.js`, `server/routes/booking.js`, `server/utils/bookingAvailability.js` | Booking lifecycle. `APPOINTMENT_BLOCKING_STATUSES` (booked + confirmed) is the subset that occupies a slot for the availability algorithm — cancelled / no_show / rescheduled free the slot for re-booking. |
| `appointments.cancelled_by` | `client`, `admin`, `assignee` (nullable) | **enforced** (CHECK in `0113`) | `server/constants/bookingEnums.js`, `server/routes/booking.js` | Records which actor cancelled the appointment; the public reschedule flow uses 'client', admin cancel uses 'admin', assignee self-cancel uses 'assignee'. |
| `appointment_types.location_kind` | `phone`, `video`, `onsite`, `office`, `other` | **enforced** (CHECK in `0113`) | `server/constants/bookingEnums.js`, `server/routes/booking.js` | Drives UI hinting (Zoom URL field for video, address field for onsite) on the public booking page. |
| `appointment_audit.action` | `booked`, `confirmed`, `cancelled`, `rescheduled`, `completed`, `no_show` | **enforced** (CHECK in `0113`) | `server/constants/bookingEnums.js`, `server/routes/booking.js` | Module-specific audit (separate from the global audit_log) so the booking history survives even if the module is later removed. |
| `appointment_audit.actor_kind` | `client`, `admin`, `assignee`, `system` | **enforced** (CHECK in `0113`) | `server/constants/bookingEnums.js`, `server/routes/booking.js` | Distinguishes public token-keyed client actions (no actor_user_id), admin actions (req.user.id), assignee actions (the bookable user themselves), and cron-driven system actions. |
| `estimates.send_email_status` + `change_orders.send_email_status` + `lien_waivers.send_email_status` | `pending`, `sent`, `failed` (nullable) | **enforced** (CHECK in `0114`) | `server/routes/{estimates,changeOrders,lienWaivers}.js` send handlers | Tracks whether the post-send confirmation email actually reached the recipient. `pending` is the just-claimed state set inside the same TX as the status flip; the email path patches to `sent` or `failed` after SendGrid responds. Lets admins spot booking/CO/waiver entities where the client never got the link. |
| `estimate_audit.action` | `created`, `sent`, `accepted`, `declined`, `expired`, `withdrawn`, `converted` | **enforced** (CHECK in `0104`) | `server/constants/projectMoneyEnums.js`, `server/routes/estimates.js` | Audit trail. Public client actions (accept/decline) write rows with `actor_kind='client'`; cron-driven (expire) write `'system'`. |
| `estimate_audit.actor_kind` | `admin`, `client`, `system` | **enforced** (CHECK in `0104`) | `server/constants/projectMoneyEnums.js`, `server/routes/estimates.js` | Distinguishes a public token-keyed action (no `actor_user_id`) from a logged-in admin or a background job. |
| `invoice_audit.action` | `created`, `sent`, `payment`, `voided` | **enforced** (CHECK in `0149`) | `server/constants/projectMoneyEnums.js` (`INVOICE_AUDIT_ACTIONS`), `server/routes/invoices.js` | Audit trail for native invoices. A public token-page payment writes `actor_kind='client'`. |
| `invoice_audit.actor_kind` | `admin`, `client`, `system` | **enforced** (CHECK in `0149`) | `server/constants/projectMoneyEnums.js`, `server/routes/invoices.js` | Same as `estimate_audit` — distinguishes a public token action from an admin or background job. |
| `recordings.status` | `uploaded`, `processing`, `completed`, `failed` | **enforced** (CHECK in `0123`) | `server/constants/recordingEnums.js`, `server/routes/recordings.js`, `server/jobs/transcriptionPoller.js` | Voice-transcription lifecycle (Tools module). `uploaded` → `processing` on successful AssemblyAI submit; the poller flips to `completed`/`failed` and is guarded by `AND status = 'processing'` so a stale poll can't clobber a retry. `failed` is retryable. |
| `recordings.media_kind` | `audio`, `video` | **enforced** (CHECK in `0124`) | `server/constants/recordingEnums.js`, `server/routes/recordings.js`, `server/jobs/transcriptionPoller.js` | Derived from the upload content type at claim time. `video` files are staged in R2 only for AssemblyAI to fetch — the poller deletes them and refunds storage after the transcript is stored, stamping `media_deleted_at` (the claim guard against double delete/refund vs the DELETE route). `audio` files are kept for in-transcript playback. |
| `equipment_items.status` | `available`, `checked_out`, `maintenance`, `retired` | **enforced** (CHECK in `0125`) | `server/constants/equipmentEnums.js`, `server/routes/equipment.js` | Asset custody state (Inventory → Equipment). A cache of the open-checkout truth: `available ⇄ checked_out` is flipped inside the same TX as the `equipment_checkouts` insert/return (the partial unique index `idx_equipment_checkout_open` is the real backstop). `retired` is a terminal state distinct from the `active=false` soft-delete. |
| `equipment_items.kind` | `heavy`, `vehicle`, `trailer`, `power_tool`, `hand_tool`, `safety`, `other` (nullable) | **enforced** (CHECK in `0125`) | `server/constants/equipmentEnums.js`, `server/routes/equipment.js` | Category for filtering/labeling an asset. Nullable, so CHECK is `IS NULL OR ...`. |
| `equipment_items.rental_rate_unit` | `hour`, `day`, `week`, `month` (nullable) | **enforced** (CHECK, widened in `0179`) | `server/constants/equipmentEnums.js` (`EQUIPMENT_RATE_UNITS`), `server/routes/equipment.js` | Billing period for a rental's `rental_rate` (rent-IN cost). `hour` added in `0179`. Meaningful when `is_rental=true`. |
| `equipment_items.rent_out_unit` | `hour`, `day`, `week`, `month` (nullable) | **enforced** (CHECK in `0179`) | `server/constants/equipmentEnums.js` (`EQUIPMENT_RATE_UNITS`), `server/routes/equipment.js` | Period for `rent_out_rate` — what you charge to rent the bare machine to others. |
| `equipment_items.operating_unit` | `hour`, `day`, `week`, `month` (nullable) | **enforced** (CHECK in `0179`) | `server/constants/equipmentEnums.js` (`EQUIPMENT_RATE_UNITS`), `server/routes/equipment.js` | Period for `operating_rate` — what you bill to use the machine on a job. Flows into estimate lines via `GET /equipment/:id/estimate-lines`. |
| `equipment_maintenance_logs.kind` | `service`, `repair`, `inspection`, `other` | **enforced** (CHECK in `0125`) | `server/constants/equipmentEnums.js`, `server/routes/equipment.js` | Type of a discrete maintenance record (distinct from the `equipment_hours` usage log). |
| `safety_checklist_templates.type` | `safety`, `quality`, `pretask`, `equipment`, `general` | **enforced** (CHECK in `0171`) | `server/constants/checklistEnums.js` (`CHECKLIST_TEMPLATE_TYPES`), `server/routes/safetyChecklists.js` | Category of a Checklist Builder template. NOT NULL DEFAULT `safety` (existing rows kept their original safety meaning), so plain `IN (...)` CHECK. Powers the Builder's type selector + Checklist Reports type filter. (Table name is still `safety_checklist_*` — the tool generalized without a rename; the separate Inspections tables are a later fold-in.) |
| `live_sessions.tool` | `planroom`, `sitework`, `roofing` | **enforced** (CHECK in `0134`) | `server/constants/liveSessionEnums.js`, `server/routes/liveSessions.js` | Which plan tool hosts an ephemeral live-collab session. The session layer syncs opaque JSON, so Plan Room ships first; `roofing` is reserved for the "go live on a takeoff" flip. `sitework` is **vestigial** — that standalone tool was retired and removed from the repo, so no new sitework sessions occur; the value is left in the CHECK to avoid a migration (harmless). |
| `live_sessions.status` | `active`, `ended` | **enforced** (CHECK in `0134`) | `server/constants/liveSessionEnums.js`, `server/routes/liveSessions.js` | Session lifecycle. `active` until the host ends it or the idle sweeper closes it; `ended` rows keep their final `state` snapshot for the host to reclaim. |
| `haul_tickets.unit` | `CY`, `tons`, `loads` | **enforced** (CHECK in `0137`) | `server/constants/haulEnums.js`, `server/routes/haulTickets.js` | How a haul load is measured (production/haul log). NOT NULL DEFAULT `CY`, so plain `IN (...)` CHECK. Reconciliation nets actuals by unit against the takeoff estimate. |
| `haul_tickets.direction` | `export`, `import` | **enforced** (CHECK in `0137`) | `server/constants/haulEnums.js`, `server/routes/haulTickets.js` | Haul-off leaving the site (`export`) vs material brought in (`import`). NOT NULL DEFAULT `export`. Lets estimate-vs-actual reconciliation net export against import. |

## Cosmetic / UI columns

| Table.column | Allowed values | DB enforcement | App validation | Stakes |
|---|---|---|---|---|
| `users.language` | `English`, `Spanish` | **enforced** (CHECK in `0101`) | `server/constants/userEnums.js`, `server/routes/admin.js:1045` | Default UI language. Note values are full names, not ISO codes — keep in sync with the top-level keys in `client/src/i18n.js`. |
| `clients.language` | `English`, `Spanish` | **enforced** (CHECK in `0116`) | `server/routes/admin.js` clients POST/PATCH (via `VALID_LANGUAGES`) | A client's preferred **document** language. Drives which language the estimate / change-order PDFs render in (`getT(client_language)` in EstimatesPage / ChangeOrdersPage), resolved live via the clients join in `loadEstimateFull` / `assertCoInCompany`. Same value set as `users.language`; NOT NULL DEFAULT `English`. |
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
`hour_limit_alert`, `service_request`, `low_stock`, `equipment_maintenance`,
`equipment_rental_due`, `bid_due`, `sub_doc_expiring`.

(The last three were already being written and were missing from this list —
which is the predicted cost of an unconstrained column: the doc drifts silently.
Verified 2026-07-16 by grepping every `createInboxItem*` call site.)

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

- `label_client`   (default `'Customer'`) — what the company calls a client.
- `label_worker`   (default `'Team Member'`) — what the company calls a worker.
- `label_field`    (default `'Field Work'`) — what the company calls the field-work module.

These are free-form display labels. Components read `settings.label_*`
at render time and fall back to the default if missing. Migration 0102
rewrote the old `label_work='Work'` rows to `'Project'` for companies
that had the previous default.

- `setup_questionnaire_completed_at` (ISO timestamp string) — set when
  an admin finishes (or dismisses) the first-run setup questionnaire.

- `hours_rules` (JSON policy document, default `''`) — the configurable
  work-hour / pay rules engine (grace/rounding, tiered OT, premiums). Stored
  as a JSON string; `''` means no policy → the engine is a pure no-op, so
  existing companies are unaffected until they opt in. **Not enum-constrained
  at the DB level** (it's a config document, same posture as the JSON
  `inventory_items.locations[]` column). Validated on write only for shape
  (must parse as a JSON object) and size (≤ 40 KB — raised from 8 KB when per-role rule lists
  landed) in the `PATCH /admin/settings`
  handler; the canonical schema + normalization live in
  `server/utils/hoursRules.js` (`parsePolicy`, which never throws and degrades
  any malformed field to a safe default). Sub-fields that are themselves
  fixed-value: `rounding.clockIn/clockOut.direction`
  (`against_worker`|`toward_worker`|`nearest`|`off`) and `.reference`
  (`schedule`|`clock`) — enforced app-side by `parsePolicy` (unknown values
  fall back to the default edge), not by a DB CHECK. Other sub-structures
  (numeric/free, validated by the pay calculator, not enum-constrained):
  `standardHours` (per-weekday `{start,end,unpaidBreakMin}`), `overtime`
  (`dailyBands`/`weeklyBands` = `[{afterHours,mult}]`, `seventhDay`), and
  `premiums` (`restDayMult`, `minDailyHours`,
  `nightDifferential {fromHour,toHour,pct}`). All consumed by
  `computeOT` / `otConfigFromSettings`; each defaults to a no-op when absent.

  **`rules[]` — the open-ended half (M4).** Everything above is fixed-slot: one
  clock-in edge, one clock-out edge, a closed vocabulary. `rules` is a list a
  company writes freely — the numbers in it are the company's, not ours. Each
  entry is `{id, type, when, ...params}`. Fixed-value sub-fields, all **enforced
  app-side** by `parseRules` in `server/utils/hoursRules.js`:

  | Field | Allowed values |
  |---|---|
  | `rules[].type` | `clip_start` \| `clip_end` \| `add_time` \| `remove_time` \| `auto_break` \| `round` \| `ot_tier` \| `rest_day` \| `min_daily` \| `seventh_day` \| `night_diff` \| `window_mult` |
  | `rules[].when.kind` | `every_day` \| `weekdays` \| `month_days` \| `month_weekdays` \| `nth_days` \| `months` \| `nth_months` \| `month_weeks` \| `nth_weeks` |
  | `rules[].edge` (add/remove) | `before` \| `after` |
  | `rules[].base` (add/remove) | `schedule` (default) \| `punch` |
  | `rules[].mode` (add/remove) | `at` (default) \| `every` |
  | `rules[].trigger.kind` (auto_break) | `always` \| `after_hours` |
  | `rules[].behavior` (clip_start) | `ignore` \| `prevent` \| `auto` |
  | `rules[].behavior` (clip_end) | `ignore` \| `auto` |

  **`window_mult` — a governing time-of-day multiplier.** Unlike `night_diff`
  (an additive %), a `window_mult` rule pays hours worked inside a day-of-week +
  clock-time window at `mult`× base, carved out of (and overriding) the normal
  daily/weekly OT — a weekend-premium schedule, e.g. Sat 05:00→19:00 @1.25×,
  Sat 19:00→Sun 05:00 @1.5×, Sun 05:00→Mon 05:00 @2×. Fields: `when` (anchors the
  window's START day), `from`/`to` (`HH:MM` from the builder, stored to minutes by
  `parseRule`; `to ≤ from` wraps past midnight, `from == to` = a full 24h), and
  `mult` (> 0). Overlapping windows: highest mult per minute; total capped at the
  entry's paid duration. Resolved in `payCalculations.windowHoursForEntry` /
  `computeOT`, wired via `otConfigFromSettings`'s `windowRules`.

  ⚠️ **Only `behavior: 'ignore'` is enforced** (default). It's pure pay math —
  don't pay time outside the boundary. `prevent` (block the clock-in) and `auto`
  (clock the worker in/out) are **parsed and stored but not yet acted on**: they
  belong to the live clock, not the pay transform. `parseRules` keeps them (they
  don't drop the rule) so the field is ready when that milestone lands, the same
  way `premiums: {}` was carried before it was live. `'prevent'` on a `clip_end`
  falls back to `ignore` — you can't prevent a clock-out.

  ⚠️ **`add_time` adds PAID time, not clock time.** The credit lands on the
  **scheduled** end (`base: 'schedule'`, the default); the punch only decides
  which rung was reached. With a 5:00pm scheduled end and rungs "at 5:25 → +30",
  "at 5:51 → +60": 5:24 pays to 5:00, 5:25 → 5:30, 5:50 → 5:30, 5:51 → 6:00.
  Adding to the *punch* instead (`base: 'punch'` — available, not the default)
  makes 5:51 pay to 6:51, which pays a worker more for clocking out later inside
  the same rung, i.e. the exact thing a rung exists to prevent.
  **Rungs do not accumulate** — each names the TOTAL credit at that point, so
  the largest rung reached wins. Leaving *early* is never a ladder case: the
  schedule base only engages when the punch is past the scheduled end, or a
  short day would be paid to 5:00.

  ⚠️ **`parseRules` DROPS a malformed rule rather than repairing it** — the
  opposite of the fall-back-to-default posture used everywhere else in
  `parsePolicy`, and deliberately so. A default edge that isn't what you meant
  rounds a punch slightly wrong; a half-understood *rule* that still fires bills
  a wrong number and nobody notices. A dropped rule is visibly absent. Constants
  are exported as `RULE_TYPES` / `RULE_WHEN_KINDS` / `RULE_EDGES` /
  `BREAK_TRIGGERS` — **a new value must be added there, not just handled**, or
  `parseRules` silently discards every rule using it.

  Numeric sub-fields (range-checked, not enum): `when.days` (0-6 for `weekdays`,
  1-31 for `month_days`/`nth_months`), `when.months` (1-12),
  `when.patterns[].week` (1-5, or **-1 = "the last one"** — not a fixed nth,
  since a month has four or five of any given weekday; works for **any** day,
  not just Friday), `when.patterns[].weekday` (0-6),
  `when.weeks` (1-5 or -1=last, for `month_weeks` — weeks are 7-day blocks from
  day 1, **not** calendar weeks), `at`/`from` (HH:MM),
  `minutes` (>0), `everyMin` (>0), `trigger.hours` (>0).
  `nth_days` needs `{start:'YYYY-MM-DD', every:1-3650}`; `nth_months` needs
  `{start:'YYYY-MM', every:1-120, days?:[1-31]}`; `nth_weeks` needs
  `{start:'YYYY-MM-DD', every:1-520}` and counts 7-day blocks from the anchor
  (anchor at a pay-week start + `every:2` = biweekly). **An nth pattern without an
  anchor is dropped** — "every 3rd day" isn't a rule until you say which day was
  the first — and never fires before its anchor.

  **Stage order is a property of the engine, not authorable**: clip → adjust →
  break → classify. Rules are a set; the pipeline is a sequence, and two orders
  give two different invoices, so an admin can't get it wrong. Adjust before
  classify means **added time counts toward the overtime threshold** (a 9.5h day
  + 0.5h credit = 2h OT under an 8h threshold, not 1.5h OT + 0.5h regular).
  `auto_break` sets `time_entries.break_minutes` to
  `max(total expected, total logged)` — **never the sum**, because the logged
  value is already deducted everywhere downstream.

  **`roleRules[]` — per-role overrides.** `rules[]` above is the *standard* list,
  applied to every worker. `roleRules` attaches an independent rule list to one or
  more worker **roles** (`users.role_id`): `[{roleIds:[<int>…], addToStandard:<bool>,
  rules:[…same rule shape…]}]`. A section can cover **multiple roles**; the legacy
  single `roleId:<int>` is still accepted and folded into `roleIds`. A worker's
  effective list is `addToStandard ? standard.concat(role.rules) : role.rules`; a
  worker whose `role_id` is in no section (or is null, or points at a deleted role)
  uses the standard list. Absent/empty → today's behavior exactly. Normalized by
  `parseRoleRules` (coerces ids to ints, de-dupes, drops entries with no valid id;
  `addToStandard` defaults true; each list runs through `parseRules`). A role
  belongs to at most one section (the builder disables an already-claimed role). The effective list feeds
  BOTH the rounding transform and the OT config, so a role's `ot_tier`/premium
  rules take effect — resolved per worker via `effectiveRulesForRole` /
  `otConfigByRoleFactory` and carried to every pay site by threading each
  worker's `role_id` (see `paidHours.computePaid`'s `roleId`). Not
  DB-enum-constrained (nested JSON, same posture as `rules[]`).

- `deductions` (JSON list, default `''`) — company-wide payroll deductions for
  the per-worker **pay stub** (gross wages → net). Shape `{ items: [{ id, name,
  kind, value, cap, roleIds }] }` (a bare array is also accepted). `roleIds` is an
  optional array of role ids the deduction is scoped to — **empty/absent = all
  employees** (the original company-wide behavior); non-empty = only workers in
  those roles ("role deductions"). `kind` is `percent` (of
  gross wages, optional `cap` = max amount per period) or `fixed` (flat amount) —
  same vocabulary as the `worker_deductions.kind` column above. `''`/empty = no
  deductions, so the stub stays gross-only for companies that never configure it.
  Validated on write for **shape (JSON object/array) + size (≤ 20 KB)** in PATCH
  `/admin/settings`; canonical normalization is `server/utils/deductions.js`
  (`parseCompanyDeductions`, which never throws and drops malformed items). The
  per-worker `worker_deductions` rows stack ON TOP of this list. Deductions apply
  to gross **wages** only — reimbursements are added back to net, not deducted
  from. Consumed by `GET /admin/workers/:id/entries` (→ `payStubTotals`) and the
  pay-stub PDF. **Not** a tax engine: it applies configured rates, it does not
  compute statutory brackets/ceilings.

- `paycheck_rules` (JSON policy, default `''`) — named **paycheck rulesets** (pay
  schedule + how/when deductions apply), built in Administration ▸ Workspace ▸
  Paycheck Rules. Shape `{ version, rulesets: [{ id, name, roles, schedule,
  deductions, notes }] }`; money in **cents**. `roles` is the array of role ids the
  ruleset applies to (a worker gets their ruleset from their role; empty = unassigned). Every fixed-value field lives inside the JSON
  (not a DB column, same posture as `hours_rules`), with the allowed sets frozen in
  `server/constants/paycheckRuleEnums.js` and clamped on read by
  `normalizePaycheckRules` (never throws):
  `schedule.frequency` = `weekly` \| `biweekly` \| `semimonthly` \| `monthly`;
  `schedule.periodBasis` = `work_week` \| `prior_cycle` \| `on_payday` (weekly/biweekly
  only — how the period a check covers relates to its pay date; default `work_week`,
  which uses `week_start` to align to the work week; see `server/utils/payPeriods.js`);
  `schedule.weekendShift` = `none` \| `before` \| `after`;
  `deductions.timing` = `every` \| `grouped`;
  `deductions.group.by` = `pair` \| `month`;
  `deductions.group.applyOn` = `first` \| `second` \| `last`;
  `deductions.cap.type` = `none` \| `amount` \| `percent`;
  `deductions.scope` = `all` \| `selected`.
  Validated on write for **shape (JSON object) + size (≤ 60 KB)** in PATCH
  `/admin/settings`. `''`/empty = none configured, so existing companies are
  unaffected. **Not yet consumed** — assigning rulesets to employee types and the
  pay-engine math land later (see `docs/plans/paycheck-rules.md`).

### Module visibility flags (`module_*`, boolean, in `FEATURE_KEYS`)

Admin-controlled module toggles: `module_timeclock`, `module_team` (Directory),
`module_work` (Work — Projects/Work Orders; renamed from `module_projects` in `0128`), `module_field`, `module_inventory`, `module_analytics`
(Reports → Performance tab), and `module_financial_reports` (Reports → P&L +
WIP tabs). The app switcher (`client/src/components/AppSwitcher.jsx`) hides an
app when its `module_*` flag is `false`.

Note: Sales (Estimates/Change Orders) and Subcontractors are NOT their own
module flags — they're tabs of Projects / Directory and follow those modules.
Migration 0118 once backfilled `module_sales`/`module_subs` rows; those are now
orphaned and unread (kept only as historical data).

## Boolean-flag columns

These are fixed-value but Postgres enforces them via the `BOOLEAN` type.
Listed for completeness so they're not flagged as gaps:

`users.active`, `users.day_mark_mode`, `users.mfa_enabled`, `users.messaging_blocked`
(global mute — the user can't send DMs; per-person blocks live in the
`users.messaging_blocked_user_ids INTEGER[]` list, not a fixed-value column),
`projects.active`, `projects.is_overhead` (overhead/non-job code — Shop, Travel,
PTO; screens skip auto-defaulting to the clocked-in project when it's overhead),
`time_entries.locked`, `shifts.cant_make_it`,
`companies.is_exempt`, `companies.is_demo` (CHECK-free BOOLEAN, `0117`;
marks demo/test tenants — suppresses real email, caps R2 at 200 MB,
wiped nightly), etc.

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
