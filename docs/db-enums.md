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
| `recordings.status` | `uploaded`, `processing`, `completed`, `failed` | **enforced** (CHECK in `0123`) | `server/constants/recordingEnums.js`, `server/routes/recordings.js`, `server/jobs/transcriptionPoller.js` | Voice-transcription lifecycle (Tools module). `uploaded` → `processing` on successful AssemblyAI submit; the poller flips to `completed`/`failed` and is guarded by `AND status = 'processing'` so a stale poll can't clobber a retry. `failed` is retryable. |
| `recordings.media_kind` | `audio`, `video` | **enforced** (CHECK in `0124`) | `server/constants/recordingEnums.js`, `server/routes/recordings.js`, `server/jobs/transcriptionPoller.js` | Derived from the upload content type at claim time. `video` files are staged in R2 only for AssemblyAI to fetch — the poller deletes them and refunds storage after the transcript is stored, stamping `media_deleted_at` (the claim guard against double delete/refund vs the DELETE route). `audio` files are kept for in-transcript playback. |
| `equipment_items.status` | `available`, `checked_out`, `maintenance`, `retired` | **enforced** (CHECK in `0125`) | `server/constants/equipmentEnums.js`, `server/routes/equipment.js` | Asset custody state (Inventory → Equipment). A cache of the open-checkout truth: `available ⇄ checked_out` is flipped inside the same TX as the `equipment_checkouts` insert/return (the partial unique index `idx_equipment_checkout_open` is the real backstop). `retired` is a terminal state distinct from the `active=false` soft-delete. |
| `equipment_items.kind` | `heavy`, `vehicle`, `trailer`, `power_tool`, `hand_tool`, `safety`, `other` (nullable) | **enforced** (CHECK in `0125`) | `server/constants/equipmentEnums.js`, `server/routes/equipment.js` | Category for filtering/labeling an asset. Nullable, so CHECK is `IS NULL OR ...`. |
| `equipment_items.rental_rate_unit` | `day`, `week`, `month` (nullable) | **enforced** (CHECK in `0125`) | `server/constants/equipmentEnums.js`, `server/routes/equipment.js` | The billing period for a rental's `rental_rate`. Only meaningful when `is_rental=true`. |
| `equipment_maintenance_logs.kind` | `service`, `repair`, `inspection`, `other` | **enforced** (CHECK in `0125`) | `server/constants/equipmentEnums.js`, `server/routes/equipment.js` | Type of a discrete maintenance record (distinct from the `equipment_hours` usage log). |

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

- `hours_rules` (JSON policy document, default `''`) — the configurable
  work-hour / pay rules engine (grace/rounding, tiered OT, premiums). Stored
  as a JSON string; `''` means no policy → the engine is a pure no-op, so
  existing companies are unaffected until they opt in. **Not enum-constrained
  at the DB level** (it's a config document, same posture as the JSON
  `inventory_items.locations[]` column). Validated on write only for shape
  (must parse as a JSON object) and size (≤ 8 KB) in the `PATCH /admin/settings`
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

### Module visibility flags (`module_*`, boolean, in `FEATURE_KEYS`)

Admin-controlled module toggles: `module_timeclock`, `module_team` (Directory),
`module_projects`, `module_field`, `module_inventory`, `module_analytics`
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

`users.active`, `users.day_mark_mode`, `users.mfa_enabled`,
`projects.active`, `time_entries.locked`, `shifts.cant_make_it`,
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
