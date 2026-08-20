# OpsFloa — Backlog & Leftovers

A single parking lot for everything that isn't being worked on right now, so it's
easy to scan and pick what to address next. Claude keeps this current: as items
come up they get filed under the matching section; when you decide to tackle one,
point at it (or the whole section).

Conventions: each item is a one-line summary + optional detail, with the date it
was filed (YYYY-MM-DD). "→ memory: name" points at a related saved memory note
that holds the exhaustive detail.

---

## 🐞 Bugs — can't be addressed until they recur
*Not raised again unless they actually reappear.*

- **Stale project list (sitework takeoff).** The local project list briefly showed
  5 already-deleted projects instead of the current set, then corrected itself on
  reload; not reproducible from the code. Watch for a recurrence on a single,
  freshly-loaded tab, and capture what's on screen. (2026-07-10)

## 🔧 Bugs — set aside for later

- **Cycle-count set-to-counted subsumes movements during the apply window (design note).**
  (2026-08-19, after FIXING the TOCTOU) Completion now SETS on-hand to the counted physical
  under a row lock (`setStockAbsolute`) instead of adding a snapshot-based delta, so a
  movement while the count was open can no longer double-count. Residual: a movement between
  when the counter entered the count and when an admin completes it is subsumed into the count
  (the physical count is treated as authoritative as of completion) — standard WMS behavior,
  but if precise, freeze counted items or complete promptly. A stricter model would capture
  system-on-hand at count-entry and apply only the discovered shrinkage.

- **Inventory adjustment transactions discard their sign in the ledger.** (2026-08-19)
  The main txn POST and cycle-count adjust insert `quantity = Math.abs(...)` while
  applying the SIGNED delta to stock (`inventory.js` ~926/951/1489/1569). So a −5 and a
  +5 adjustment are stored identically (`type=adjust, quantity=5`); the
  `inventory_transactions` ledger can't be replayed to rebuild stock and the history/audit
  view is misleading (breaks "everything traceable"). Cycle-count adjust rows also omit
  `unit_cost`, so valuation adjustments carry no cost basis. Grand totals aren't wrong
  today (issues are always positive; valuation reads the stock table), but ledger
  integrity is broken. Fix: store the signed quantity (and a unit_cost) on adjust rows.

- **Issues/transfers can drive stock arbitrarily negative and bill fictional material
  to a job.** (2026-08-19) `inventory.js` applies negative deltas unconditionally; a
  post-commit read only returns `warning:'stock_negative'` — the txn still commits. A
  worker can issue 1,000 units a location never held → stock deeply negative, a valued
  `issue` txn is written, and `projectCost.materialsCents` charges the project for
  material that doesn't exist. Decide: block negative issues (vs warn), at least on the
  received/issued-basis money path. (Policy call — some shops allow backorder/negative.)

- **Leave + worked on the SAME day — verify no double-pay.** (2026-08-05) Reported as
  "sick/vacation aren't working"; David suspects it was a test where a sick day was
  entered for a day the employee *also* clocked in. The pay engine appends synthetic
  leave rows (sick/vacation) after computing worked gross (`payStatement.js`), so a
  worker with 8h worked + an approved 8h sick day on one date could total 16h paid.
  Confirm the intended behavior (does an approved leave day suppress/limit worked pay
  that day, or stack?) and add a guard if needed. Set aside 2026-08-05 pending a real
  repro. Related, found while tracing: (1) all-time views with no date range silently
  drop leave (`paidHours.js:157/186` return 0 when from/to null while worked hours still
  show); (2) `type IN ('sick','vacation')` (`paidHours.js:162/191`, `payStatement.js:412`)
  never pays approved **Personal/Other** PTO — product decision; (3) daily/salary workers
  misprice leave (`sickHours * rate` uses the daily rate).

- **WH-347 PDF / Statement of Compliance — mostly fixed 2026-07-28; two items remain.**
  Fixed: (a) the PDF now renders the signed `compliance_text` snapshot (falls back to the
  server `default_compliance_text` template when unsigned); (c) regular vs prevailing print as
  separate rows at their own rates; (d) the OT row shows the OT rate (base × multiplier); (f)
  re-signing snapshots the replaced signature into the audit log (`certified_payroll.signature_replaced`,
  full signer/signature/compliance/date); (g) POST /signatures verifies project ownership; (h)
  cert date renders in UTC (stable for every viewer); (i) sign-modal buttons are bilingual.
  **Still open:** (b) gross still includes night/OT premium without an itemized line — this is
  inherent to the WH-347 S/O format (gross = weekly total), left as-is deliberately; flag if a
  reviewer wants it itemized. (e) Fringes still print as one combined $/hr with no cash-vs-
  approved-plan (4a/4b/4c) election — needs a data-model decision on where that election lives
  (per-company? per-project? per-fringe) before it can be built. `CertifiedPayrollPDF.jsx`,
  `certifiedPayroll.js`. (2026-07-28)
- **Certified payroll: single prevailing rate + flat OT on premium configs**
  (`admin.js` WH-347 route). One `prevRate` for all prevailing hours (no
  per-classification rate table), and premium OT configs still price
  OT flat (`otBandsCost` at `otMult`) rather than the full band math on the
  prevailing base. Per-project prevailing rates in all-projects mode and the daily-rate
  night-differential mismatch were fixed 2026-07-29; classification-level prevailing
  rates remain a data-model gap. (`overtime_hours_override` is honored.) (2026-07-28)
- **Server error strings aren't bilingual** (systemic, not payroll-specific). Server
  routes return English `error` messages (e.g. the payroll conflict 409s:
  `already_finalized`, `has_paid_checks`, "Run is voided"); the client toasts/render
  them verbatim, so a Spanish-locale user sees English on any 4xx. `i18n.test` only
  checks parity of keys that exist, so it can't catch a never-keyed server string. Fix
  pattern: return a machine `code` (the payroll 409s already do) and have the client map
  known codes to bilingual `t.*` messages. Worth doing app-wide, not one-off. (2026-07-28)
- **Supplemental / partial-worker payroll runs need explicit semantics.** Migration
  `0158` scopes finalized-run idempotency by ruleset, so different schedules can safely
  use the same date span. The app still intentionally finalizes a whole ruleset period
  at once and rejects overlapping worker/date checks. A future off-cycle correction or
  partial-worker flow needs its own run type and adjustment/reversal rules rather than
  bypassing the overlap guard. (2026-07-28)
- **Ruleset total cap trims deduction lines pro-rata on the stub** (`paycheckRun.js`
  `computeRuleNet`). When a ruleset `cap`/min-net floor trims the total, the itemized
  lines are scaled proportionally across ALL lines so they foot (net + total are
  always correct). That means a mandatory line (garnishment, child support) shows as
  *reduced* on the stub instead of the discretionary lines being trimmed first —
  which line a cap legally attaches to is a policy question. If it matters, add a
  per-line priority so caps trim discretionary lines before mandatory ones. Stub
  display only. (2026-07-28)

- **Project merge doesn't move financial records** (`admin.js`
  `POST /projects/:id/merge-into/:target_id`). The re-point list only covers
  operational tables (time entries, reports, RFIs, …), not the financial /
  audit-followup ledgers — change orders, subcontract POs, submittals, closeouts,
  expenses, budgets, lien waivers (all `project_id` FK **RESTRICT**) or invoices /
  estimates (**SET NULL**). So merging a source with any of those would 500 on the
  final `DELETE FROM projects` (RESTRICT) or silently orphan the money (SET NULL).
  **Guarded 2026-07-25:** the endpoint now pre-checks and returns a clean 409
  instead of 500ing / orphaning. **Still TODO:** actually *support* merging those —
  non-trivial because `project_closeouts` / `project_budget_categories` are unique
  per project, so it needs real merge semantics (combine vs. keep-target), not just
  a re-point. The hardcoded re-point list is also inherently fragile (this is how
  it went stale); a schema-driven "re-point every table with a project_id FK" would
  be more durable. (Found during the invoice review; same FK class as the superadmin
  wipe bug that was fixed.)

- ~~**The hours-rules engine reaches 4 of the 10 paths that turn hours into
  money**~~ **RESOLVED (money-of-record) 2026-07-25.** Every path that produces a
  number a company acts on now runs through the shared engine: the four worker-pay
  surfaces (invoice, overtime report, payroll CSV, pay stubs) render one
  `buildPayStatement` (`server/utils/payStatement.js`); `qbo.js`,
  `jobs/scheduledReports.js`, `projectReports.js` and project metrics (`admin.js`,
  via `computePaid` with the worker's own OT rule — the hardcoded `'daily'` is
  gone) use `paidHours`/the engine; `projectSpend.js` is retired. So turning on a
  policy no longer makes the invoice, payroll and QuickBooks disagree. **Remaining
  (low-stakes, display-only):** `WorkerSummary.jsx` (a worker's own dashboard
  glance) and `Tests.jsx` (QA harness) still compute pay independently — not the
  money of record; fold onto a server number if they ever drift.
- **Stale CSP hash blocks the inline auth-guard script on stage**
  (`client/public/tool-apps/sitework/index.html:9`). The Content-Security-Policy
  is set by the frontend host (Vercel), not the Express server, and it isn't
  blocking sharing. Fix = update/replace the `script-src` hash (or use a nonce)
  in the host config. (2026-07-10)
- **Stage QA — open-findings batch** (2026-06-29/30 pass; full detail in
  `docs/stage-qa-findings.md` → "Open Findings"). Re-verify which remain open —
  some may already be fixed on dev. Themes:
  - Tabbed pages ignore hash-only navigation until reload (Time Clock subtabs,
    Financial Reports P&L/WIP) + missing old→new hash aliases.
  - Demo Operations data stale/bloated (old "still clocked in" alerts, ~3050 hrs,
    105 pending approvals, overdue equipment) → demo refresh should prune, not
    just insert.
  - Guide/help search misses common phrasing ("time off", "PTO", "inventory count").
  - Empty demo states: Booking setup (types/users) and Field Work > Media.
  - Slow initial loads (Time Clock / Inventory / Team) that look stuck.
  - A11y: tab/shell controls lack accessible names; invalid public links mix
    "Not Found / Unauthorized" wording. (filed 2026-07-11)
- ~~**Tool-apps still print `$` regardless of the company currency**~~
  **RESOLVED (Plan Room) 2026-07-25.** `SettingsContext` now writes a
  `tc_currency` localStorage key (mirroring the `tc_addons` bridge), and the
  shared `engine-ui.money()` reads it and formats in the company currency via a
  locale map (mirror of `client/src/utils.js`), USD fallback. Plan Room bid tables
  now respect the currency. **Sitework's own `money()` copy is intentionally left
  on `$`** (off-limits); it'll diverge until the sitework port, which is accepted.
- ~~**Newer takeoff kinds skip the `NEEDS_SCALE` guard**~~ **RESOLVED
  2026-07-25.** `froom`/`ftrans`/`fwall`/`fsheath` added to `NEEDS_SCALE` — they
  now block + nudge to 📏 on an uncalibrated sheet instead of silently returning 0.
- ~~**`fopening` missing from `POINT_KINDS`**~~ **RESOLVED 2026-07-25.** Added, so
  it behaves like its twin `dopening` (single click, no rubber-band).
- **Closeout is broken for companies without QuickBooks, in both directions.**
  `project_invoices` is a **QBO mirror** — only `server/routes/qbo.js` ever
  writes it — so a company without QBO connected has **zero rows**. Both
  invoice-backed auto-status items in `computeAutoStatus()`
  (`server/routes/closeout.js:181-201`) then misread that emptiness:
  - `final_invoice` counts *paid* invoices → 0 → stays `in_progress` forever.
    Since `final_complete` requires every required item done
    (`closeout.js:370-383`), **those projects can never be closed out.**
  - `retainage_release` sums `balance` → `SUM` over zero rows is **0** → `0 === 0`
    → reports **`done`**. It cheerfully certifies retainage released on a project
    with no invoices at all. A false negative blocks; a false positive lies.
  Fix needs the architectural call first: does owner-side billing get a native
  invoice concept, or is QBO a hard dependency? Both items should at minimum
  distinguish "no invoices exist" from "invoices exist and are settled". See
  `docs/plans/gc-tools.md` → Decision 2. (2026-07-16)
- **Closeout transition gate reads stored status, not computed** — and its
  comment says otherwise. `server/routes/closeout.js:361` reads *"Evaluate items
  with auto-source via the same compute path"*, but the loop below tests
  `item.status` (the stored column) rather than calling `computeAutoStatus()`.
  So a punchlist that is genuinely clear can still block
  `substantially_complete` when the stored row is stale. Also `const byCat` on
  the line above is assigned and never read — dead. (2026-07-16)

- **Money-flow bug-hunt leftovers — pre-existing, low-frequency or risky to change.**
  (2026-08-19) Surfaced during the 3-agent bug hunt after the estimate→closeout
  build-out; consciously left un-fixed (the 10 clear defects that pass found were
  fixed same day). Each is a real-but-minor issue:
  - **ManageRates "Save section" saves EVERY section's edits.** `saveSection(section)`
    (`client/src/components/ManageRates.jsx:263`) PATCHes the whole ~90-field settings
    payload regardless of which button was clicked; `section` only drives the checkmark.
    Editing Labor Burden then clicking a different section's Save still commits the
    burden change. No corruption (server validates), but surprising. Fix: send only the
    fields owned by `section`. (Blast radius grew when `labor_burden_pct` /
    `materials_cost_basis` were added to that payload.)
  - **Estimate & CO numbers minted without an advisory lock.** `estimates.js` (~:270,340)
    and `changeOrders.js` (~:204) do `MAX(number)+1` inside the INSERT with no
    `pg_advisory_xact_lock` (invoices.js DOES lock). `estimate_number`/`co_number` are
    UNIQUE, so two concurrent creates / a double-click collide → loser hits an
    unhandled 23505 → 500. No corruption; rare 500. Fix: same per-company advisory lock.
  - **P&L / WIP swallow labor/materials/equipment errors to $0.** `projectReports.js`
    `spendTotals` wraps the labor query in `try/catch {}` (and projectCost helpers return
    0 on any exception), so a *genuine* DB error makes P&L silently show $0 cost / inflated
    profit — while the Spend tab (`projectSpend.js:64`, unwrapped) 500s on the same error.
    The catches intentionally guard partial-migration envs; narrowing them (check
    `tableExists`/error-code, let real errors propagate) is the fix but risks that guard.
  - **Estimate header PATCH re-checks frozen status OUTSIDE its lock (TOCTOU).**
    `estimates.js` (~:403) reads status on the pool before BEGIN with no `FOR UPDATE`,
    unlike PUT /lines / send / convert. A PATCH changing `margin_pct` can interleave with
    a concurrent send and silently change the totals of an already-sent estimate. Fix:
    move the `SELECT status … FOR UPDATE` + frozen check inside the TX.
  - **Minor:** `MoneyInput` reverts unparseable text (`"15.5.5"`) on blur with no cue;
    catalog item PATCH doesn't guard `is_stocked` (DELETE does); `labor_burden_pct` may
    reject an explicit 0 (leave-unset = same effect); `purchase_orders.status` enum is
    validated inline in `inventory.js` but missing from `docs/db-enums.md`.

## 🧭 Design flaws — raised, set aside for later

- **Billing LOW (from the 2026-08-19 billing audit).** (a) Seat-cap check is a TOCTOU race:
  `checkWorkerLimit` does a COUNT then the caller INSERTs with no lock/transaction, so two
  simultaneous create/invite requests at seat−1 both pass → bounded +1 overage (matters only
  where seats are billed). (b) `/stripe/addon` sets the `addon_*` flag immediately after
  `subscriptionItems.create`, which only schedules a prorated charge — the entitlement isn't
  payment-confirmed; combined with (c) feature gates granting full access during `past_due`/
  `unpaid` (only `canceled`/`trial_expired` deny), a company keeps add-ons through a failed
  payment until Stripe fires `subscription.deleted`. (c) is a reasonable dunning grace window
  but worth a conscious decision. Webhook replay itself is safe (absolute-value writes + an
  `event.created` watermark).

- **Money input overflow / uncapped free-text (LOW, from the 2026-08-19 injection audit).**
  Invoice/estimate line `qty × unit_cost_cents` (`computeLineTotal`) has no ceiling, so values
  near 1e15 can exceed `Number.MAX_SAFE_INTEGER` (precision loss) or BIGINT (INSERT 500) —
  trusted-author only. Several free-text fields (invoice notes/terms/project_address, invoice-
  line notes, payment notes) are written with no length cap while sibling fields are capped —
  storage bloat, inconsistent. Consider a shared max-length + a sane per-line total ceiling.

- **Security LOW / hardening (from the 2026-08-19 audit; no exploit path or admin-only).**
  (a) `shifts.js` admin shift create/edit stores `project_id` from the body with no
  in-company check (unlike clock.js/reimbursements.js) — a single-field cross-company
  `project_name` leak to an admin who guesses an id. (b) `liveSessions.js` SSE stream
  skips the `requirePlanToolsAddon` gate the REST routes carry (entitlement bypass;
  company isolation intact). (c) `push.js` `/push/generate-vapid-keys` is unauthenticated
  (self-disables once keys are set — remove post-setup). (d) `estimates.js`/`invoices.js`
  store the raw share token in plaintext alongside its hash (change orders / lien waivers
  store hash only). (e) `estimates.js` PATCH does its frozen/company check with a plain
  SELECT, not `FOR UPDATE`, so a total-changing edit can race a concurrent `/send`.

- **Labor-bill paths show wages to a manage_integrations admin without view_worker_wages.**
  (2026-08-19) `push-bills-preview` (now gated with manage_integrations) and `push-bills`
  both surface per-worker labor dollars but require only `manage_integrations`, not
  `view_worker_wages` (unlike `push-payroll`). Decide whether the bill paths should also
  require wage visibility. (`server/routes/qbo.js`.)

- **Dashboard/KPI "this week / this month" boundaries computed in UTC.** (2026-08-19)
  `weekRange(new Date())` and `CURRENT_DATE`/`date_trunc('month', CURRENT_DATE)` on the
  UTC server make "hours this week", "active workers this week/month", the OT-this-week
  counter, and the pay-period picker flip ~5h early for west-of-UTC companies (the window
  between local-afternoon and local-midnight). Stored pay data is TZ-correct; only these
  live read-time boundaries drift. (`admin.js` /kpis + summary, `timeEntries.js`,
  `shifts.js`, `weekBounds.js`.) The persisted clock-in fixes landed 2026-08-19.

- **Inventory standard-cost notes.** (2026-08-19) Receipts never update
  `inventory_items.unit_cost` (standard-cost model — on-hand value can diverge from actual
  purchase cost; no moving-average maintenance). Over-receipt is silently truncated to the
  remaining qty (a real over-shipment is dropped with no error). Returns/reversals aren't
  modeled, so material issued-then-returned leaves project cost permanently inflated.

- **Deductive (credit) change orders can't be modeled.** (2026-08-19) `changeOrders.js`
  rejects negative qty/unit_cost lines and clamps line totals to ≥0, and `contractValueCents`
  only ever ADDS accepted CO totals while `applyAcceptedCoToBudget` only increments budget.
  So a scope-reduction / credit CO (a normal construction event) has no representation —
  worse, forcing it in as a positive line RAISES the contract and budget the wrong way.
  Needs a signed-CO path (allow negative totals; contract/budget follow the sign).

- **Closeout freeze guards only 2 of ~6 cost sources.** (2026-08-19) `projectFrozen` is
  enforced on project_expenses and time entries, but NOT on change-order accept, subcontract
  payments, inventory issues / PO receipts, or equipment-hours logging. The locked snapshot
  (`final_financials`) is immutable and safe, but the *live* P&L a user compares against the
  lock keeps moving after closeout if any of those unguarded costs are added on a closed job.
  Consider extending `projectFrozen` to CO-accept + the other cost mutations.

- **Hand-set `contract_value_cents` still has accepted COs added on top.** (2026-08-19)
  `contractValueCents` takes the override as base then ALSO adds accepted CO totals, so an
  admin who set the override to the current all-in contract (mentally including an accepted
  CO) gets it double-counted. Decide whether the override is pre- or post-CO and document it.

- **Labor burden double-applies if an estimator enters an already-burdened cost.** (2026-08-19)
  Budget seeding multiplies labor by (1 + burden%) on convert and CO-accept, correct for a raw
  wage but inflating by ~burden² if the entered `cost_cents` already includes burden. Undetectable
  from data — a UI note ("enter raw wage cost") or a per-line "already burdened" flag would help.

- **Equipment cost can be double-entered (manual expense + logged hours).** (2026-08-19)
  Equipment spend = manual project_expenses tagged equipment PLUS equipmentUsageCents (hours ×
  rate); nothing dedupes a manual equipment expense against logged hours for the same machine
  (`project_expenses.equipment_id` exists but is unused). By-design today; worth a guard/warning.

- **Invoicing minors (AR modeling choices).** (2026-08-19) From the invoicing audit, all
  low-harm: overpayment is uncapped so `collected_cents` can exceed `billed_cents` with no
  flag; voiding an invoice leaves its `invoice_payments` rows in place (money silently drops
  out of every rollup with only an audit line); the public invoice view shows a total that
  includes unreleased retainage with no "retainage withheld / due now" breakdown; a $0-total
  invoice can never reach `paid`. Confirm each is the intended model. (`server/routes/invoices.js`.)

- **WH-347 prices a daily-rate worker on an hourly-equivalent basis.** (2026-08-19,
  FIXED the ~8× overpay same day) The certified-payroll `computeWorker` now costs a
  daily-rate worker at daily ÷ regular_shift_hours (an hours-based document needs an
  hourly rate). This equals the daily-rate pay stub (days × daily rate) only when the
  worker's daily hours = the standard shift; a 10h day on an 8h standard would show
  10 × (daily/8) on the WH-347 vs 1 day on the stub. Acceptable for the form, but if a
  daily-rate worker ever appears on certified payroll with off-standard days, decide
  whether the WH-347 should instead mirror the stub's days × daily total. (`admin.js`
  computeWorker.) → memory: [[project_payroll_review_decisions]]

- **QBO "push-payroll" journal: no overlap guard + books gross to both sides.** (2026-08-19)
  `POST /api/qbo/push-payroll` (`server/routes/qbo.js`) journals total gross labor for a
  work-date range. Two gaps: (1) idempotency is only `sha256(companyId|from|to)`, so two
  *overlapping* ranges (Aug 1–15 then Aug 1–31) post two journal entries and double-book
  the overlap in the GL — unlike payroll-run/finalize, which has an overlap probe. (2) It
  debits AND credits the same GROSS on a work-date window, so it ignores deductions
  (credit overstated vs the register's net) and uses a different window basis than the
  pay-date-keyed register, so the journal won't tie to the finalized run. Decide what the
  journal should represent (gross labor accrual vs net + withholding liabilities) and add
  the same overlap/duplicate guard finalize has. Lower-severity siblings: the grouped-
  deduction generate window (±45d) can miss the partner of a *monthly* `by:'pair'` group;
  month-group keying uses the shifted pay-date month for weekly/biweekly (no `groupMonth`).
  Found 2026-08-19 pay-engine pass. → memory: [[project_payroll_review_decisions]]

- **Grouped-ruleset amount cap is applied PER CHECK, so a pair can deduct up to 2× the cap.**
  (2026-08-19) `applyDeductions` caps each check's combined per-check+grouped total against
  the ruleset cap independently; for a `by:'pair'` grouping the two checks are each capped,
  so the group can withhold up to twice the cap. Stub and admin run agree (both use
  `applyDeductions`), so it's self-consistent — but confirm per-check-cap is the intended
  semantics for a *grouped* cap, vs one cap across the group. (`server/utils/paycheckRun.js`.)

- **DST overnight shift is paid the wall-clock span, not real hours.** (2026-08-19) Every
  pay path reads `start_time`/`end_time` (bare TIME) and computes wall-clock hours, so a
  23:00→07:00 shift is always 8.00h even on a fall-back night (9 real hours → 1h underpay)
  or spring-forward (7 real → 1h overpay). The instant-based `elapsedMinutes` would give the
  true figure but `start_ts`/`end_ts` are write-only (no pay reader consumes them). Consistent
  across surfaces and pending the Phase-3 timestamp-reader cutover, but a real DST-zone
  over/under-pay. Also affects the night-differential window.

- **Weekly-guarantee week count coarsely rounds non-7-day periods.** (2026-08-19)
  `computeGuaranteeShortfall` uses `weeks = max(1, round(days/7))`, so a 30-day month → 4
  weeks (a 40h/wk guarantee tops up to only 160h for a ~4.33-week month) and a 10-day range
  → 1 week. Ties into the still-owed pay-rule-window work. → memory: [[project_pay_rule_windows]]

- **Preview surfaces report a "Net Pay" that ignores ruleset cap / min-net.** (2026-08-19)
  The worker invoice, overtime report, and payroll CSV price deductions through
  `payStubTotals` (gross − per-check deductions, clamped ≥0) — no exempt, no cap, no
  min-net floor, and grouped deductions deferred. So their "Net" is a fourth distinct
  number from the payroll run's net. Partly by design (a date-range preview can't
  resolve pay-period groups), but the cap/min-net omission on the *per-check* portion
  is a real inconsistency with `applyDeductions` (which now caps the combined total),
  and the CSV doesn't surface `deferred_deductions` so a reader can't tell groups were
  omitted. Decide: label these as "preview / pre-deduction" nets, or make them run the
  full per-check cap/min-net. (`server/utils/payStatement.js` previewDeductionSplit +
  payStubTotals.) Found 2026-08-19 pay-engine pass. → memory: [[project_payroll_review_decisions]]

- **A grouped deduction can't exceed one check's take-home room (min-net truncation).**
  (2026-08-19) In `applyDeductions`/`computeRuleNet` the min-net floor uses the flagged
  check's OWN gross, while a grouped deduction is figured on the group's combined gross
  minus exempt. If the group's deduction is large relative to the single check it lands
  on, `g − dedTotal < minNet` fires and silently trims the grouped deduction to
  `g − minNet` — under-withholding the group's intended total, with no spill to the
  other check(s) in the group. Consistent between the two functions (not a divergence),
  so low urgency, but a real ceiling worth a design decision: should a group's deduction
  be allowed to spill across its checks? (`server/utils/paycheckRun.js`.)

- **Should the minimum-daily floor appear on the WH-347 at all?** Certified Payroll now
  includes worked-day min-daily floor hours in the regular total AND the day columns (they
  reconcile as of 2026-07-28). But a min-daily floor is *reporting-time* pay, not hours
  worked on the project — arguably it shouldn't be on a WH-347's hours-worked columns. Left
  as-is (matches the pay stub's gross), but a prevailing-wage compliance call worth
  confirming before relying on it. (2026-07-28)
- ~~**Payroll run keys on "pay date in window", users think "work period".**~~ **Resolved
  2026-07-28.** The tab now leads with a pay-period **dropdown** (not a raw
  range), and each check's period comes from a selectable `periodBasis` (work_week /
  prior_cycle / on_payday, default work_week) so the period aligns to the work week and
  pays in arrears. The custom range + `notices` remain for edge cases. Multiple schedules
  are now listed and computed per ruleset, so one cadence cannot pull a partial group
  from another.
- **"Included workers" (15) is duplicated between client and Stripe.** The Business
  base price bundles 15 seats; the client hardcodes `INCLUDED_WORKERS = 15` in
  `BillingPanel.jsx` to compute the per-worker overage sent to checkout. If the
  Stripe base ever bundles a different count, the constant silently drifts and we
  over/undercharge (this exact drift caused the 2026-07-28 overcharge bug). Fix:
  surface `included_workers` in the `/stripe/plans` payload so there's one source of
  truth and the server can also sanity-check the quantity. (2026-07-28)
- ~~**Company-share conflict model is fork-only.**~~ **RESOLVED 2026-07-14.** The
  conflict dialog is now 3-way (Keep both / Overwrite theirs / Cancel), and a
  **manual, admin-releasable lock** (migration 0138) lets a user reserve a shared
  takeoff so teammates can't save over it (reads/copy still work). Holder or any
  admin unlocks. See shipped log.
- **No dedupe when copying a shared takeoff twice.** "Copy to my projects" makes a
  fresh local project each time, so copying the same cloud takeoff twice yields two
  local projects both linked to it. Minor; could reuse the already-linked local
  project instead. (2026-07-11)
- **Rate-aware overtime (prevailing / multi-rate / international).** → **spec:
  `docs/plans/rate-aware-overtime.md`** (broadened from the WH-347-only
  `certified-payroll-ot.md`). David's goal: one adaptable engine for any use case
  (Oregon excavator mixing prevailing + civilian jobs in a day, Kentucky call
  center, Honduras elevator co) with no jurisdiction hardcoded. The one real gap is
  multi-rate hours never earning OT; fix is rate-aware "rate-when-worked" pricing,
  engine-wide, with a plain-English scenario matrix as the spec + a cross-surface
  reconcile invariant. Method note: rate-when-worked (generalizes worldwide);
  weighted-average is a future US toggle. Audited 2026-07-26 and the scope got
  *clearer and bigger*: the WH-347 report (`GET /admin/certified-payroll`,
  `admin.js:3454`) computes **no overtime at all** — regular *and* prevailing — it
  bucket-sums raw hours and grosses `hours × rate` flat, bypassing
  `buildPayStatement`. So any >40h week on a compliance form is understated. The
  audit *resolved* the decision I was worried about: the stored rate is **base-only
  with fringe modeled separately** (`worker_fringes`), so "OT on the base rate,
  fringe paid straight" needs **no schema change**. Remaining decisions collapse to
  "reuse the company's existing OT config for the threshold" and "route the report
  through `annotateEntryOvertime` for a per-day ST/OT split." **Config-driven, not a
  50-state ruleset** — the engine's OT config is company+role only (no
  per-project/classification), so it's a **two-phase** build: P1 route through the
  shared engine (broad by construction), P2 a per-project OT override for jobs whose
  wage determination differs from the company rule. Gate is now an **archetype test
  matrix** (federal / CA-daily / no-state-law) + reconcile-to-`buildPayStatement`,
  not one customer's form. Inline break-clamp bug fixed 2026-07-26. (Found review
  batch 6; audited + broadened on request.)
- ~~**Raw `localStorage`/`sessionStorage` still used in feature components.**~~
  **RESOLVED 2026-07-20.** Swept 72 calls across 23 post-login files onto
  `safeSession`/`safeLocal`; `debugBundle` reads storage inside its try now. Every
  remaining raw access is inside an existing try/catch (openTool, pdfError,
  ErrorBoundary, useFormPersist, the tc_addons effect, api.js bootstrap) — all
  crash-safe. No unguarded `window.*Storage` access remains in `client/src`.

## ❓ Open questions / decisions for you
*Blocked on your call before anyone builds.*

- **Business seat cap — ENFORCED 2026-08-20 (hard cap, your call).** Business is now capped at
  15 included + purchased per-worker seats (`companies.paid_worker_seats`, migration 0190) +
  bonus_seats; create/invite/restore all block past it, like Free/Starter. `paid_worker_seats` is
  synced from Stripe by the billing webhook + change-plan. Two follow-ups worth knowing: (a) an
  EXISTING Business subscription reads `paid_worker_seats = NULL` until its next webhook/change-
  plan, and NULL = grace (unlimited) — so enforcement kicks in lazily; if you want it immediate,
  backfill `paid_worker_seats` from Stripe for current Business subs. (b) The seat-cap TOCTOU
  (below) now matters slightly more since the cap is real. Was: [billing-model decision].

- **Company-wide `overtime_rule` is ignored when a worker's own rule is null.**
  (2026-08-19) The pay engine resolves OT rule via `otRuleFromSettings(settings,
  worker.overtime_rule)` = `workerRule || 'daily'` — it never falls back to the
  COMPANY `overtime_rule` setting. So a company set to *weekly* whose worker rows have
  a null `overtime_rule` would silently get *daily* OT. Likely a non-issue if every
  worker row is always seeded with a rule, but worth confirming: should a null worker
  rule inherit the company setting instead of hardcoding 'daily'? (`server/utils/
  paidHours.js:52`.) Found during the 2026-08-19 pay-engine review.

- **Partial leave + no-clock-in guarantee on the same day.** (2026-08-19) The new
  fix (guarantee-fill skips any day already paid as leave) treats a *partial* leave
  day (e.g. 4h sick, no clock-in) as fully covered — it grants no guarantee top-up.
  Defensible (avoids double-pay) but a policy call: should a 4h partial-leave day with
  an 8h no-clock-in guarantee pay 4h leave + 4h guarantee, or just the 4h leave?
  Currently: just the leave. (`computeOT` guarantee gate, `payCalculations.js`.)

- **Grouped+selected ruleset now applies NON-selected deductions per paycheck.**
  (2026-08-13) When building per-deduction timing (some deductions per paycheck, some
  monthly), the payroll run's `timing:'grouped' + scope:'selected'` was reinterpreted:
  the SELECTED company deductions are the grouped/monthly ones (e.g. RAP), and the REST
  of the role's company deductions now come out EVERY paycheck (e.g. Seguro Social).
  Previously the non-selected ones were **dropped from the run entirely.** This is what
  David wanted for the Honduras setup, but it's a behavior change: if any ruleset ever
  used "Only selected" to *exclude* a role deduction, that deduction now applies per
  paycheck instead of not at all. David unsure whether that's a problem. Decision owed:
  keep the implicit "selected = grouped, rest = per-check" rule, OR add an explicit
  per-deduction timing toggle (per-check / monthly / off) so exclusion stays possible.
  Code: `applyDeductions` in `server/utils/paycheckRun.js` + the split in
  `computePayrollRun` (`server/routes/admin.js`). → memory: [[project_payroll_review_decisions]]

- **Equipment-maintenance alert re-fires daily.** (2026-07-31) While an item stays
  past its maintenance interval, the 8am job re-sends the same push + inbox alert every
  day. The audit fixed the *retry-resend* (per-company try/catch so a mid-batch error
  no longer makes `runJob` re-alert everyone), but send-once-until-serviced needs a
  dedup stamp — e.g. an `equipment_items.maintenance_alerted_at` column, reset when
  hours reset or maintenance is logged. Migration + logic; is a daily reminder actually
  undesirable, or fine as a nag?

- **Presigned R2 upload** — pull the trigger now, or stay on the 64 MB base64
  bandaid until plans actually exceed the ceiling? (see Improvements) (2026-07-10)
- **Wall Dig button** — hidden "for now" in the takeoff tool; bring it back, remove
  it, or leave it hidden? (2026-07-10)

- ~~**Native invoices, or QuickBooks forever?**~~ **DECIDED 2026-07-25 — native
  invoices; QuickBooks is an optional extra, never a dependency.** OpsFloa gets its
  own invoice / accounts-receivable concept so a company that never connects
  QuickBooks can still invoice, record payment, and close out. QBO stays a **sync
  layer on top** — the mirror is fine, it just can't be the *source of truth*.
  This unblocks the two closeout bugs above (read OpsFloa's own invoices instead of
  an empty QBO mirror), sub pay-applications, and invoicing straight off a service
  work order. **Next:** scope the native-invoice build (data model → create / track
  / mark paid → how the existing QBO mirror coexists) before any other money-category
  work. See `docs/plans/gc-tools.md`. → memory: project_native_invoices_decision.
- **Do you want GC customers at all?** Everything OpsFloa does today assumes a
  contractor who **self-performs**. A GC coordinates *other people* — different
  buyer, different anxiety, the one who pays Procore ($10k+/yr). Worth entering
  only *deliberately*: a half-built GC story is worse than none. The alternative —
  keep deepening the trade product that now has **11 takeoff trades** — is a
  legitimate and cheaper answer. Two of the six GC standouts shipped 2026-07-16
  (COI tracker, OAC minutes) because both were nearly free on existing pipelines;
  the rest are real builds. See `docs/plans/gc-tools.md`. (2026-07-16)
- **Is $60/mo still right for Takeoff?** It was priced when Takeoff did **3
  trades**. It now does **11** (roofing, dirt, drywall/paint, flooring, framing,
  ESC, striping, siding, demo, fencing, landscape). Dedicated takeoff software
  runs $1,500–4,000/seat/yr and usually covers *one* trade. Left alone on purpose
  — land-grab pricing is defensible, and raising later beats lowering — but it
  should be a decision rather than an oversight. (2026-07-16)
- **Should an expired COI block, or just warn?** It currently **warns**: the
  tracker alerts at 30 days and again on expiry, but nothing stops a PO being
  issued to a sub whose insurance has lapsed. Blocking is arguably the whole value
  ("he can't be on site"), but it's a hard gate on a flow that already works, so
  it wasn't added unasked. (2026-07-16)
- **Is the closeout deliverable a PDF or a ZIP?** ZIP is cheaper and arguably more
  useful (as-builts are big CAD files); `archiver` is already a server dep. Note
  this is downstream of a prerequisite: `project_closeout_items` has **no document
  columns**, so there is currently nothing to assemble. (2026-07-16)

## ✨ Ideas — improvements

- **Project Daily — two follow-ups from the 2026-08-13 build.** (1) *Clock-in
  prompt gap:* the post-clock-in "start your day" prompt flags a project as startable
  only from its *per-project recurring* template — a project seeded purely by a
  **Project Daily assignment** (all-projects or a project set) won't appear yet (the
  day still assembles the assignment when started manually). (2) *Admin/reporting view
  of individual items:* on the shared day view an admin sees an individual item with
  their *own* (usually empty) state; there's no per-person completion breakdown yet — a
  Checklist-Reports-style per-person view is the natural home. Both in
  `server/routes/dailyChecklist.js` / `ProjectDailySetup.jsx`.

- **Haul log: print layout + a specific-takeoff picker.** A print-friendly haul
  ticket report (CSV already ships); optionally let a job point at a specific
  takeoff for reconciliation instead of "most recent converted estimate."
  Deferred M3 items in `docs/plans/production-log.md`. (2026-07-13)
- **Presigned direct-to-R2 upload for shared-takeoff PDFs.** Replaces the current
  64 MB base64-through-the-API approach; removes the ~48 MB ceiling and cuts server
  memory. Caveats: needs R2 bucket CORS + orphaned-object cleanup.
  → memory: project_takeoff_pdf_storage. (2026-07-10) **Note:** scheduled as M4
  of the Plan Room plan (`docs/plans/plan-viewer-markup.md`) — full-size plan
  sets (50–200 MB) need it for library share and go-live, so building that tool
  delivers this improvement along the way.

## 🚀 Ideas — new features or tools

- **Standalone AI-tools SKU (Office AI + recordings).** (2026-07-31) Sell the Office
  AI tools (summarizer, doc Q&A, contract red-flag scanner, email drafter) and meeting
  recordings as their own add-on, buyable **without** Business or Plan Room. For now
  they stay tied to Business (`requirePlan('business')` on `/api/office` +
  `/api/recordings`). The path is clean when you want it: the AI quota is already flat
  (300/mo per company, plan-independent, `OFFICE_AI_MONTHLY_LIMIT`) and the Tools page
  shows on the per-company `module_tools` toggle, so a new SKU is just an `addon_ai`
  column + `requireAiToolsAddon` middleware + a Stripe price + a BillingPanel card —
  no metering rework. (Decided 2026-07-31: leave on Business for now, likely SKU later.)
- **Plan Room: Wall Dig takeoff (sitework pack Q4, deferred).** Retaining-wall /
  footing excavation — a trench swept along a traced line, net export vs. reused
  backfill after concrete + aggregate fill the hole; the ▚ Wall variant reads
  depth off contours (constant / to-subgrade / proposed−embedment). Deferred
  because the *dig* overlaps the Line trench takeoff and its concrete/agg are
  usually the concrete sub's scope, not the excavator's. **Full rebuildable spec
  (cross-section + wallComputeCore formulas + form fields + bid lines) lives in
  `docs/plans/planroom-sitework-pack.md` → "Q4 Wall dig — full spec"**, so it
  survives even if the standalone sitework tool is deleted first. (2026-07-12)
- **Tools-module roadmap (large idea backlog).** Full categorized list in memory.
  Headline categories: **takeoff siblings** (📐 same measure→bid engine — Roofing,
  Drywall/Paint, Flooring/Tile, Framing, Siding/Gutters, Erosion control,
  Demolition, Fencing, Striping, Landscape), **quick field calculators** (🧮
  concrete/rebar/asphalt/slope/converter…), **trade-engineering calcs**
  (electrical/plumbing/HVAC/structural), **money & bidding** (proposal generator,
  change-order builder, cost book, AIA pay apps), **AI doc/writing** (scope-of-work,
  RFI/submittal, red-flag scanner, translator), **AI-from-media** (voice-memo→tasks,
  photo→estimate, receipt OCR), **field/jobsite ops**, **GC tools** (bid leveling,
  COI tracker, OAC minutes, pay-app+lien-waiver, selection tracker, closeout
  assembler), and **"expensive-software replacements"** (Bluebeam-style plan
  viewer/markup, multi-trade takeoff, proposal/e-sign, roof measurement).
  **Called-out standouts:** Talk-to-Bid (voice walkthrough → priced bid), Contract
  Red-Flag Scanner, Instant Branded Proposal, Bilingual Crew Cards, Snap-a-Receipt
  job costing, Roofing takeoff, Bluebeam-style plan viewer.
  → memory: project_tool_roadmap. (filed 2026-07-11)
- **Service-call business model gaps (base app, not add-ons).** To serve
  HVAC/plumbing/electrical/service-call businesses, ranked by need:
  1. Work-order completion flow (line items, photos, signature, parts/labor) —
     everything hangs off this; SignatureModal/PhotoCapture already exist.
  2. In-app customer payments (card / deposit / pay-link).
  3. Flat-rate price book (good/better/best by task).
  4. Customer-site asset registry + service history.
  5. Recurring agreements / memberships / PM plans.
  6. Dispatch board for work orders (techs→jobs with arrival windows).
  7. Customer SMS + "on my way".
  8. Invoice from a work order.
  Critical money-loop path: 1 → 3 → 8 → 2. → memory: project_service_call_gaps.
  (filed 2026-07-11)
- **Storm/Utility takeoff deep module** (deferred paid add-on). Quick-win presets
  already shipped (pipe-size line presets + storm-structure count presets). The
  deep version adds: (1) pipe schedule (size/material → auto trench width + LF by
  diameter), (2) invert-driven per-segment trench depth from rim/invert + slope,
  (3) structure depth (a 12-ft manhole ≠ a 4-ft catch basin), (4) spoil-vs-import
  backfill netting. → memory: project_storm_utility_module. (2026-07-09)

## 📌 Planned / ready-to-build
*Scoped with a plan; just not started.*

- **Fold Inspections into the Checklist Builder (phase 2)** — the 2026-08-13 build
  turned the old *Safety Checklists* tool into a typed **Checklist Builder** +
  **Checklist Reports** (Manage group, admin-only); templates now carry a `type`
  (safety/quality/pretask/equipment/general) and answers key by stable item id.
  `inspection_templates` + `inspections` are a near-identical second builder that
  should collapse into this one: add an `inspection` type, migrate the two tables
  into `safety_checklist_*` (item types superset: add `pass_fail`, `number`;
  inspections also carry a pass/fail/pending roll-up + inspector/location to
  preserve), remap `results` (keyed by item id already) into `answers`, then retire
  the Inspections tab + `inspections.js` route + `InspectionChecklists.jsx`. This is
  the real de-duplication win; deferred because it's a live data migration.
- **Surface Safety-Checklist completion on the Daily Checklist** — crews already
  complete safety checklists **at clock-in** (`ClockInOut.jsx` posts a submission),
  and admins can record one from Checklist Reports. What's still missing is David's
  intent that completion also flow through the **Daily Checklist** tab with results
  showing there. Needs a way to attach a checklist template onto a project's daily
  checklist and record completions both surfaces read. `DailyChecklist.jsx` +
  `ChecklistManager.jsx` + `/safety-checklists` and `/daily-checklists` routes.

- **Drop the dormant `project_invoices` table** — migration `0150` unified the
  QBO mirror into native `invoices` (data copied, `lien_waivers` FK repointed,
  `qbo.js`/`projectReports`/`closeout`/`lienWaivers` all read native). The old
  table is left **dormant as a rollback backup** — no code reads/writes it except
  the superadmin company-wipe. Once verified in production (create a QBO invoice,
  check-payment, confirm AR + closeout read right), add a one-line migration
  `DROP TABLE project_invoices` and remove the dormant delete in `superadmin.js`
  + its `expectedTables` entry. Until then, `project_invoices` holds a duplicate
  copy of the pre-migration rows.

- **Plan Room platform (MASTER PLAN)** — `docs/plans/plan-viewer-markup.md`
  (2026-07-11, two tiers, **money-first sequencing**). **Base add-on ~$40/mo**
  (`addon_planroom`): viewer + markup + measure + company library +
  flatten/export, **visible-but-locked** in ToolsPage; on sale at M6.
  **Takeoff layer ~$60/mo** (reuses `addon_takeoff`, requires base, stacked
  billing): all trade packs + price library + bid engine — **roofing pack
  first at M7**. Live sessions (generic layer, local-first host "goes live",
  survives drops) follow at M8, off the revenue path. **Sitework port is
  unscheduled** ("when consolidation earns it") behind the user-confirmation
  gate; the standalone tool serves as the interim sitework pack. User actions:
  Stripe Plan Room prices; takeoff price decision at M7; R2 CORS at M4; the
  cutover confirmation.
- **Roofing trade pack** — `docs/plans/roofing-takeoff.md` (2026-07-11,
  restructured: no own SKU/app — ships inside Plan Room **M7**, ahead of the
  sitework port). Pitch → squares, roof lines/counts, materials math,
  aerial-image input for re-roofs, bid defaults. Auto-measure from address
  stays M-later.
- **Drywall & Paint trade pack** — **SHIPPED** (`docs/plans/drywall-paint-pack.md`).
  D1+D2+D3 built inside the Plan Room takeoff layer: wall runs (LF × height ×
  sides), ceilings, opening deducts, trim, board/mud/tape/paint math; **plus
  D3** — texture ($/SF), batt/sound insulation (single-face wall area), and
  ACT/drop-ceiling grid takeoff (tiles/tees/wall-angle/hangers, installed $/SF);
  **D4** — interior-elevation heights (↕ tool measures a named wall height off an
  elevation sheet → reusable library, applied as default or per run). **Pack is
  feature-complete.** No own SKU — included in the $60 takeoff layer.
- *(further trade packs to scope when wanted: see the tools roadmap —
  flooring/tile, framing, siding, fencing, striping, landscape…)*

## ✅ Things I need to do (David)

**Migrations:** *no manual step* — they auto-apply on every deploy (`migrate.js`
runs on server start, tracked in `schema_migrations`) and ride along to
stage/prod on those PRs. All shipped migrations through **0138** are already
applied on dev (verified 2026-07-14). *(Corrects earlier "run migrations X" notes.)*

**Bid workflow + Haul log (shipped to `dev`):**
- **Test both loops end-to-end:** (1) estimate → set due date → attach PDF →
  Take off in Plan Room → price in $ Bid → Send pricing → confirm lines + total
  land on the estimate; (2) log haul tickets on a job → totals/subtotals →
  (with the takeoff add-on, on a job that came from a converted bid) the
  estimate-vs-actual reconciliation card.
- **Reconciliation caveat:** the estimate-vs-actual card keys off the estimate's
  `converted_project_id`, so it only lights up once you **convert the winning bid
  into a job**. A haul job created directly (not from a converted estimate) shows
  "convert the winning bid to this job to compare." A hard takeoff↔job link
  (cross-device) is deferred — flag if you want it built.

**Plan Room — before the base tier can actually sell (M6 shipped):**
- ~~**Stripe (Plan Room $40)**~~ — **DONE** (2026-07-15). `STRIPE_PRICE_PLANROOM`
  (+`_ANNUAL`) set in Render → `addon_planroom`; billing card + checkout verified.
  `.env.example` documents the full add-on price set.
- ~~**R2 bucket CORS**~~ — **DONE** (2026-07-15). CORS policy applied to the
  plan-tools bucket (PUT + `content-type` from the app origins) so the ☁
  share-upload path works. Reads/copy-down never needed it (server-proxied).

**Plan Room — optional / later:**
- ~~**Orphan sweep**~~ — **DONE** (2026-07-15). `R2_ORPHAN_SWEEP=1` set in
  Render on the env whose DB owns the bucket. Cleans up abandoned presigned
  uploads nightly.
- **Smoke-test Plan Room end-to-end** on dev: open a plan set (PDF + an aerial
  image), mark up, calibrate + measure against a known dimension, share to the
  company + copy it down on another browser profile, export the flattened PDF,
  and confirm the locked card shows for a company without the add-on.

**Takeoff layer (M7 shipped — roofing pack):**
- ~~**Stripe (Takeoff $60)**~~ — **DONE** (2026-07-15). `STRIPE_PRICE_TAKEOFF`
  (+`_ANNUAL`) set to the new $60 price → `addon_takeoff`. Legacy takeoff price
  moved to `STRIPE_PRICE_SITEWORK` (inert — safe to delete; no legacy subs).
- **Verify the roofing math** against a hand calc (a plane's squares, a
  hip/valley pitch-corrected LF) before selling it.
- **Storm/Utility add-on — verify + flip to sell.** The whole module is built
  (`addon_storm`, `STRIPE_PRICE_STORM` wired, priced $20/mo as a light upsell) but **the purchase is hidden**
  (`STORM_SELLABLE=false` in `BillingPanel.jsx`). Hand-check the utility math —
  pipe-volume displacement, average-end-area CY on a sloped segment, native-vs-
  import net export — then set `STORM_SELLABLE=true` to open sales. Superadmin
  toggle turns it on for your own testing now. (`docs/plans/storm-utility-pack.md`)
- **Parity test (the S4 cutover gate):** dirt takeoff is now built in Plan Room
  (contours/spots/pads, two-sheet ⌖ alignment + ghost, cut/fill + heat overlay,
  bid lines). Run the SAME job in Plan Room and the standalone Sitework tool and
  compare cut/fill/export CY — only after you confirm they match does the
  standalone tool redirect (`docs/plans/planroom-sitework-pack.md` S4).

## 📖 Done / shipped log

- **Email bounce suppression — reconnected and made reversible** (2026-07-16).
  Found while re-surveying the app to fix a stale doc; filed and fixed the same
  day, so it never sat in the bug list long.
  - **What was wrong, twice over.** `email.js` skips any recipient whose
    `users.email_bounced_at` is set. The only writer was a **SendGrid** webhook,
    and email had moved to **Resend** — so the column took no new data and the
    app happily kept mailing addresses it had already been told were dead.
    Meanwhile **nothing anywhere cleared the column**: anyone flagged during the
    SendGrid era was suppressed permanently, invites and password resets
    included, with no symptom an admin could see.
  - **Fixed:** `POST /api/resend-events` (signature-verified via the Resend SDK,
    raw body, `email.bounced` + `email.complained`), and two ways back out — an
    address change now clears the flag, and there's an explicit "Retry email"
    action. The Subs/Team worker card shows a red banner when an address is
    suppressed, which is the visibility migration `0075` said it was for and
    never got.
  - **Judgment calls:** only a **Permanent** bounce suppresses — Resend also
    reports Transient (full mailbox) and Undetermined, and treating those as
    fatal is how a real person gets silenced for an afternoon's outage.
    `services/emailSuppression.js` now owns every read and write of the column,
    because the read and the write living in two files that didn't know about
    each other is what let this drift for months.
  - ⚠️ **Needs an action from you: set `RESEND_WEBHOOK_SECRET`.** Create the
    webhook in Resend → Webhooks pointed at
    `https://<server>/api/resend-events`, subscribed to `email.bounced` and
    `email.complained`, and paste its signing secret into the Render env. Until
    then the route 503s and nothing is recorded — the code is live but deaf.
  - ⚠️ **Worth checking:** whether any prod rows have `email_bounced_at` set
    from the SendGrid era. Those people have been unreachable this whole time
    and can now be freed with the Retry button.
  - **Left alone:** `/api/sendgrid-events` still exists, marked deprecated. It
    can't be proven dead from the repo (its secret isn't in `.env.example`, so
    it almost certainly 503s), and it isn't mine to delete on a guess. Remove it
    once you've confirmed nothing posts to it in Render.
*Landed on `dev`, newest first. (What happens past dev is handled outside this doc.)*

- **2026-07-14 — Plan Room $ Bid: estimate dropdown + send pricing.** A "🔗
  Estimate" dropdown in the $ Bid modal (from your draft estimates) links the
  takeoff and reveals the existing "Send pricing to estimate" button — no need
  to launch from the estimate anymore. Makes the "takeoff↔job hard link" idea
  unnecessary (see Improvements): pricing lands on the estimate, and
  reconciliation reads it server-side.

- **2026-07-14 — Plan Room share-conflict: 3-way dialog + manual lock.** Company
  library sharing: a stale save now offers **Keep both / Overwrite theirs /
  Cancel** (`askChoice` modal; overwrite sends `overwrite:true`, server bypasses
  the version check). Plus a **manual, admin-releasable lock** (migration
  **0138**: `locked_by`/`_name`/`_at` on `takeoff_projects`) — 🔒 reserve a
  takeoff so teammates' in-place saves are refused (423); reads + "Copy to my
  projects" always work. Holder **or any admin** unlocks (`POST /:id/lock`,
  `/:id/unlock`) — no heartbeat/TTL needed. Library shows a "🔒 by <name>" badge.
  A lock beats overwrite. Sitework tool unaffected (never locks). **Needs
  migration 0138 run.**
- **2026-07-14 — Plan Room earthwork editing polish (batch).** Vertex editing on
  every polyline/polygon (drag points, Alt-click add/remove, Shift+Alt-click to
  cut/split a line — never orphaning a point); a sitework-style **contour list**
  in the ⛰ Dirt panel (edit elev / delete / select+jump / clear); the
  Existing↔Proposed **click-toggle** navigates + focuses one surface and hides
  the other's contours; general markups hide in earthwork mode; the **boundary
  shows on both sheets**; the trade panel auto-opens (gated on a loaded doc);
  clicking a contour drops into edit mode; panning keeps the selection; and an
  **editable on-canvas scale bar** (drag ends to recalibrate, drag middle to
  move, Alt-click to clear).

- **2026-07-13 — Removed the dynamic work/project label; "Project" is now
  hardcoded** (`e16d6cf`). Excised `workLabel` / `settings.label_work` /
  `labelSg(..,'work'|'project')` across ~50 client files and replaced with the
  literal Project/project/Projects/projects (the entity is just a Project now —
  explicit Projects + Work Orders tabs exist). Fixes the earlier "+ New Team
  Member" mislabel at its root (the missing `project` default that fell through
  to the worker label). Worker/client/field labels stay dynamic. Verified:
  production build (53 modules), vitest smoke + i18n parity (84 tests), eslint
  clean, sitework untouched. Closes the deferred "workLabel should no longer be
  a thing" item.

- **2026-07-13 — Production & Haul Log (main app), M1–M3.** Plan:
  `docs/plans/production-log.md`. The sitework tool's production log, rebuilt
  server-backed + per-job + multi-user in the **Field module → "Haul log" tab**.
  **Decisions (locked with David):** lives as a Field tab; **field crews can
  self-log** (`manage_haul_tickets`, a worker-default perm). **M1** (`a7e3e84`):
  migration **0137** (`haul_tickets` + seeds the perm into built-in roles) +
  `haulEnums`/db-enums; audited route (worker/admin narrowing, enum + project-
  ownership validation); add form, job + date filters, net-export totals by unit,
  delete, CSV. **M2** (`38df6e5`): `GET /haul-tickets/reconcile` (takeoff add-on,
  `usePlan().hasTakeoff`) — actuals vs the estimate converted to the job
  (`converted_project_id`; haul-off qty from `/haul|export|spoil/` lines);
  estimate-vs-actual card, variance over/under. **M3 polish** (`148a28e`): edit a
  ticket (row ✎ → reused form → PATCH); collapsible by-hauler/by-material
  subtotals. Daily-production half already existed (`daily_reports`), so only
  haul tickets + reconciliation were new. **Deferred:** takeoff↔job hard link
  (cross-device reconciliation — needs a data-model decision), a print layout,
  retiring the sitework local log.
- **2026-07-13 — Bid workflow: Estimate ⇄ Plan Room, M1–M4.** Plan:
  `docs/plans/bid-workflow-estimate-planroom.md`. Makes the **estimate the hub of
  a bid** — the win-the-bid loop David's wife runs (handed a PDF + a deadline →
  price it → send before the clock). **M1** (`f49f373`/`524ac95`): `bid_due_at` +
  `bid_reminder_sent_at` (migration **0135**); estimate form field, list "due
  soon/overdue" chip, hourly reminder cron (push + inbox, claim-then-send,
  re-armed on due-date change). **M2** (`019e849`): attach a plan PDF (migration
  **0136** `plan_pdf_url`/`_name`); `POST/DELETE /estimates/:id/plan-pdf` base64
  **through the server** to R2 — **no R2-CORS needed**; Plans card. **M3**
  (`c13d7db`): `GET /estimates/:id/plan-pdf` base64 proxy; **"📐 Take off in Plan
  Room"** button (gated on plan-attached + `addon_planroom`); Plan Room
  `?estimate=` find-or-create → `bootEstimate()`, `estimateId` round-trips through
  all load paths. **M4** (`4040252`): **"➤ Send pricing to estimate"** in $ Bid →
  `PUT /estimates/:id/lines` via `apiEstimate()`; keyword category heuristic; O&P
  rides as one `overhead` line so totals match; replace-with-confirm. Base tier =
  deadline + PDF; takeoff add-on = launch + pricing-back. **Caveats:** Plan Room
  projects are per-browser (link is per-device); O&P can double-count if the
  estimate also carries a margin %.
- **2026-07-13 — Plan Room: manage sheets (reorder / remove).** 🗂 Manage sheets
  (from 📁 Projects when a set has >1 sheet): reorder ▲▼ or remove ✕ sheets;
  Apply rebuilds the combined PDF (pdf-lib) and remaps every page reference —
  markups, per-sheet scales, earthwork existing/proposed assignments — so
  nothing lands on the wrong sheet; removing a sheet drops its markups.
- **2026-07-12 — Plan Room: combined-document projects (multi-PDF, page
  selection).** Opening plans moved into the 📁 Projects modal: pick a
  file → a thumbnail page-picker (check/uncheck sheets) → only the chosen
  sheets load. "Add more sheets" appends from other PDFs/images into one
  combined PDF (pdf-lib merges; images become pages; existing page numbers
  stay stable so markups/earthwork refs survive). Removed the topbar
  "Open Plans" + "Load"; progressive disclosure hides the whole toolbar
  except 📁 Project until a document is loaded; Projects modal is now the
  genesis hub (open/add plans, load saved file, ☁ company / join live). This
  resolves the multi-PDF-projects and doc-replacement-warning items (append,
  never silent-replace).

- **2026-07-11 — Plan Room product built end-to-end (M0–M8).** The two-tier
  plan-tools line: a shared engine copied out of the sitework monolith
  (`tool-apps/shared/`, sitework untouched); the **$40 base tier** — viewer
  (PDF + aerial image, density-aware render + zoom sharpening), 9 markup kinds +
  select/undo + list, measure (per-sheet scale → length/area/count), company
  library with presigned R2 upload, flatten-PDF + CSV export, and **live
  sessions** (SSE rooms + REST ops, presence, DB snapshots, idle sweep); the
  **$60 takeoff layer** — roofing pack (planes→squares, pitch-corrected edges,
  items, materials + priced bid), gated on the takeoff add-on with an upsell
  teaser; platform wiring (`addon_planroom` migration/Stripe/superadmin/billing,
  visible-but-locked ToolsPage). Migrations 0133–0134. **Unscheduled:** the
  sitework consolidation (still its own standalone tool, untouched).

- **2026-07-11 — Recategorized `manage_equipment` to the Inventory module.** Moved
  it Field → Inventory in the permission catalog (label "Equipment log" →
  "Equipment") and added it to `MODULE_PERMISSIONS.inventory` so a role holding only
  it can reach the Equipment group; kept in `field` too (no regression).

- **2026-07-10/11 — Company takeoff sharing fixed end-to-end.** The 500 that broke
  it entirely (`users.full_name`), the 413 on large plan PDFs (64 MB body limit +
  the error surfaced in the modal), and the bug where opening a shared takeoff
  overwrote a local project — now a "Copy to my projects" prompt (new vs overwrite,
  with an editable name).
- **2026-07-09/11 — Sitework takeoff topbar overhaul.** Six-section layout,
  responsive collapse to icons then wrapping, action-row packing fix, Bid/Log moved
  next to Calculate, help-modal close-X, Wall Dig hidden.
- **Earlier (prior session) — Equipment tracking → Inventory consolidation.** The
  full M1–M4 plan (`~/.claude/plans/mossy-launching-mist.md`) shipped: migration
  `0125_equipment_tracking.sql`, equipment enums, check-out/return + rentals +
  maintenance endpoints and cron, the Inventory **Equipment** group, and the Field
  `#equip` redirect. (verified 2026-07-11)
