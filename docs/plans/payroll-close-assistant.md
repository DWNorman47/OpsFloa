# Payroll Close Assistant

## Status

Planned. This document is the implementation contract for a later session. It does
not authorize changes to payroll calculations, accounting rules, or production data.

## Goal

Turn the existing payroll-related screens into one guided close workflow that tells
an administrator whether a pay period is ready, links every problem to the place it
can be fixed, previews the resulting checks, and finalizes an auditable snapshot.

The assistant should answer four questions without requiring the administrator to
remember OpsFloa's internal sequence:

1. Is all payable activity for this run reviewed?
2. Are worker roles, rates, schedules, and deductions configured well enough to pay?
3. What changed, and what will each worker receive?
4. Has the result been finalized, exported, delivered, and marked paid?

## Why This Is Worth Building

OpsFloa already has the hard pieces:

- Time-entry review in `client/src/components/ApprovalQueue.jsx`.
- Company-wide date locks in `client/src/components/ManagePayPeriods.jsx`.
- Leave review in `client/src/components/AdminTimeOff.jsx`.
- Expense review in `client/src/components/ReimbursementsAdmin.jsx`.
- Pay-period generation and payroll calculation in
  `server/utils/paycheckRun.js` and `server/utils/payStatement.js`.
- Payroll preview/finalization in `client/src/components/PayrollRun.jsx` and
  `server/routes/admin.js`.
- Finalized-run history and printable stubs in `PayrollHistory` / `PayStub`.
- QuickBooks time, contractor-bill, and payroll-journal flows in
  `server/routes/qbo.js`.

The weakness is orchestration. These live on different tabs, and the app currently
assumes the operator knows which screens to visit and in what order. The assistant is
primarily a workflow and safety feature, not a new pay engine.

## Product Decisions

These decisions are part of this plan and should not be reopened during routine
implementation unless the underlying architecture has changed.

1. The assistant lives at the top of the existing **Payroll** tab. It does not add a
   new top-level module.
2. The existing paycheck-rules schedule remains the source of period/ruleset choices.
   A custom date range remains available behind an explicit "Custom range" action.
3. Readiness is calculated on the server. The client never decides that payroll is
   safe to finalize.
4. Finalization always recomputes readiness. A stale green browser screen cannot
   authorize a run after data changes.
5. True blockers cannot be overridden. Warnings may be acknowledged with a note and
   are stored in the finalized run's audit snapshot.
6. The assistant never silently edits, approves, rejects, fills, or deletes records.
   It sends the administrator to a filtered correction view.
7. Existing payroll math remains authoritative. The assistant calls the shared pay
   services; it does not reproduce calculations in SQL or React.
8. Finalizing a ruleset does not automatically create a company-wide `pay_periods`
   lock. Different rulesets can cover overlapping dates, and a global lock could
   freeze workers whose payroll is not finished.
9. Finalized payroll remains an immutable snapshot. Corrections require voiding the
   run, fixing source data, and finalizing again.
10. QuickBooks and CSV are downstream delivery choices. Lack of a QuickBooks
    connection does not block payroll finalization.

## Terminology

- **Run window:** The pay-date window selected in the UI (`from`, `to`).
- **Covered work dates:** The union of the actual `period_start` / `period_end` spans
  generated for checks in the run. These can differ from the run window because of
  arrears and grouped deductions.
- **Readiness check:** One server-computed condition with a stable code and severity.
- **Blocker:** A condition that can change who is paid or the amount paid, or prevents
  a valid calculation. Finalization is refused.
- **Warning:** A suspicious or exceptional condition whose data is already valid.
  Finalization is allowed only after explicit acknowledgement.
- **Information:** Context that helps the reviewer but requires no acknowledgement.
- **Finalized run:** The immutable `payroll_runs` and `payroll_run_checks` snapshot.
- **Source lock:** A `pay_periods` date lock. This is separate from finalization.

## User Experience

### Entry State

The Payroll tab opens to the latest closed, unfinalized scheduled period. If every
recent period has been finalized, it opens the newest completed run and offers the
next available period.

The header contains:

- Ruleset selector when the company has multiple applicable rulesets.
- Scheduled pay period selector.
- Pay date and covered work-date summary.
- State badge: `Needs attention`, `Ready to review`, `Ready to finalize`, `Finalized`,
  or `Paid`.
- `Refresh` icon button with last-calculated time.
- `Custom range` action, visually secondary.

Changing the ruleset or period invalidates all locally acknowledged warnings and
loads a new readiness result.

### Step 1: Prepare

Show a compact checklist grouped by ownership rather than by database table:

#### Time

- Open shifts that overlap covered work dates.
- Pending time entries for workers included by the selected ruleset.
- Pending entries trapped inside an existing source lock.
- Entry-level exceptions: long shift, late captured punch, missing required
  checklist, manual overtime override, or other review flags already stored by the
  app.
- Rejected entries in the period, shown as a warning rather than a blocker.

The action opens Approvals with `from`, `to`, `worker`, and optional `issue` filters.
The filter values must be represented in the URL so Back returns to the assistant.

#### Leave and Expenses

- Pending time-off requests overlapping the covered work dates for included workers.
- Pending reimbursements dated inside the covered work dates for included workers.
- Approved leave and approved reimbursements are informational totals, not problems.

Actions open the existing Time Off or Expenses tab with matching date/status filters.

#### Pay Setup

- Worker has no role.
- Worker matches zero paycheck rulesets.
- Worker matches more than one paycheck ruleset.
- Missing or invalid rate needed by the calculation.
- Incomplete paycheck schedule or generated period outside the configured schedule.
- Invalid deduction configuration.
- Negative net pay or another calculation invariant violation.
- No payable workers/checks.

Actions deep-link to the relevant worker, role, rate-history, or Workspace setting.

#### Prior Runs and Locks

- Existing non-void finalized run overlaps any incoming worker/date span.
- Existing company-wide source lock contains unresolved pending entries.
- Existing finalized checks and their statuses.

The action opens the prior finalized run or the source-lock list.

### Step 2: Review

This step uses the existing payroll calculation response and adds a review summary:

- Number of checks and workers.
- Gross, deductions, reimbursements, and net totals.
- Regular, overtime, prevailing, leave, and premium hours.
- Worker rows expandable to the existing printable stub.
- A delta column against the most recent comparable finalized check for that worker.
- Clear labels for `New worker`, `No comparable run`, and `Unchanged`.
- A `Show changes only` toggle.
- CSV download remains available but is labeled **Preview CSV** until finalization.

The comparison is advisory. A changed amount is not itself an error. The server
returns the previous check id/run id and amount deltas; the browser does not attempt
to choose a comparable period.

### Step 3: Finalize

The confirmation panel summarizes:

- Ruleset and pay date.
- Covered work dates.
- Worker/check count.
- Gross, deduction, reimbursement, and net totals.
- Warning acknowledgements and optional administrator note.
- The statement that the run becomes an immutable snapshot and corrections require
  voiding it.

The primary command is `Finalize payroll`. The button is disabled while blockers
exist. Warnings require a checkbox per warning category and one optional note field.

On success, replace the live preview with the saved finalized run returned by the
server. Do not make a second live calculation and present it as the saved result.

### Step 4: Deliver and Complete

After finalization, show downstream actions in one unframed section:

- Download final CSV.
- Print all stubs or open one worker's printable stub.
- QuickBooks payroll journal, when configured and authorized.
- Contractor bill workflow, where applicable, with outbox status surfaced.
- Mark all or selected checks paid.
- Void run, behind the existing restrictions and confirmation.

Each action gets a durable status where the existing system already has one. Do not
invent a success status based only on a button click. QuickBooks results come from its
ledger/outbox; paid status comes from `payroll_run_checks`.

### Source Locking

The current `pay_periods` lock is company-wide, while a payroll run is scoped by
ruleset and worker. Therefore:

- The MVP shows whether covered dates are source-locked but does not auto-lock them.
- After finalization, show `Lock source dates` only when a server preflight proves
  every payable worker affected by that date range is covered by a non-void finalized
  run and no unresolved pending entry exists in the range.
- If that proof cannot be made, explain which ruleset/workers are unfinished and keep
  the action disabled.
- A later design may add ruleset- or worker-scoped source locks. Do not extend
  `pay_periods` ad hoc during the MVP.

## Readiness Rules

### Blockers

Use stable machine codes. At minimum:

| Code | Condition | Correction destination |
|---|---|---|
| `active_clock` | An included worker has an open shift overlapping the covered dates | Live / Approvals |
| `pending_time` | Ended payable time remains pending | Approvals |
| `pending_locked_time` | Pending time is inside a source lock | Pay-period locks |
| `pending_leave` | Pending leave overlaps covered dates | Time Off |
| `pending_reimbursement` | Pending reimbursement is dated in covered dates | Expenses |
| `worker_no_role` | Included worker has no role | Team member settings |
| `ruleset_missing` | Worker role matches no ruleset | Paycheck Rules |
| `ruleset_ambiguous` | Worker role matches multiple rulesets | Paycheck Rules |
| `rate_missing` | Calculation lacks a required dated rate | Worker/project rates |
| `schedule_invalid` | Ruleset cannot generate a valid check/period | Paycheck Rules |
| `deduction_invalid` | Deduction configuration cannot be applied | Deductions |
| `negative_net` | A check calculates below zero | Paycheck Rules / deductions |
| `overlapping_finalized_run` | A non-void check already covers a worker/date span | Payroll history |
| `no_checks` | The selected run produces no checks | Period/ruleset selector |

Only blockers relevant to workers/checks selected by this ruleset should block this
run. Problems belonging solely to another ruleset should be summarized separately as
information.

### Warnings Requiring Acknowledgement

| Code | Condition |
|---|---|
| `long_shift_reviewed` | Approved entry still carries `long_shift_flagged` |
| `late_punch_reviewed` | Approved entry has late clock-in/out capture minutes |
| `required_checklist_missing` | Approved entry records an unmet required checklist |
| `manual_overtime_override` | Approved entry carries an overtime override |
| `rejected_time_present` | Rejected time exists in the covered dates |
| `rate_changed_in_period` | A dated rate changes inside a worker's covered period |
| `large_check_delta` | Gross or net differs materially from the comparable prior check |
| `zero_hour_guarantee` | A guarantee creates pay for a worker with no worked hours |

For `large_check_delta`, start with a deliberately simple threshold: absolute change
of at least $250 and percentage change of at least 25 percent. Put both numbers in one
server constant and test the boundary. This warning must not imply the amount is wrong.

### Information

- Approved entry count and hours.
- Approved leave hours/value.
- Approved reimbursements/value.
- Workers excluded because they are owner, unpaid, inactive, or have no payable
  activity under the existing worker-set rules.
- Existing source locks.
- QuickBooks connection state.
- Previous comparable run details.

## Server Design

### Shared Service

Create `server/services/payrollClose.js` with narrow exported functions:

```js
resolvePayrollCloseWindow(companyId, from, to, rulesetId)
computePayrollReadiness(companyId, window, computedRun)
findComparableChecks(companyId, computedRun)
buildPayrollClose(companyId, from, to, rulesetId)
assertPayrollReady(closeResult, acknowledgements)
buildReadinessSnapshot(closeResult, acknowledgements, note, actor)
```

`buildPayrollClose` calls the existing shared payroll computation once, derives the
actual covered worker/date spans from its rows, and then runs readiness queries. It
must not reimplement `computePayrollRun`, `companyStatements`, overtime, rate history,
leave valuation, deductions, or reimbursements.

Batch the readiness queries. Do not run one query per worker or per check. The target
is a bounded number of database round trips regardless of company size.

### Read Endpoint

Add:

`GET /api/admin/payroll-close?from=YYYY-MM-DD&to=YYYY-MM-DD&ruleset_id=...`

Use the same gates as the current payroll preview:

- `requireAdmin`
- `requirePerm('view_reports')`
- `requirePerm('view_worker_wages')`
- `requireCertifiedPayrollAddon`

Suggested response:

```jsonc
{
  "generated_at": "2026-09-25T20:15:00.000Z",
  "readiness_hash": "sha256...",
  "state": "blocked", // blocked | warning | ready
  "selection": {
    "ruleset_id": "pr_123",
    "ruleset_name": "Biweekly",
    "run_from": "2026-09-25",
    "run_to": "2026-09-25",
    "covered_from": "2026-09-07",
    "covered_to": "2026-09-20",
    "pay_dates": ["2026-09-25"]
  },
  "summary": {
    "workers": 14,
    "checks": 14,
    "gross": 28450.22,
    "deductions": 4210.11,
    "reimbursements": 315.40,
    "net": 24555.51
  },
  "checks": [
    {
      "code": "pending_time",
      "severity": "blocker",
      "count": 3,
      "worker_ids": [12, 18],
      "entry_ids": [501, 502, 510],
      "action": { "tab": "approvals", "filters": { "from": "...", "to": "..." } }
    }
  ],
  "payroll": { "rows": [], "errors": [], "notices": [] },
  "comparisons": []
}
```

Never include hidden wage data when the caller lacks `view_worker_wages`; the route is
already denied in that case. Do not return unrestricted worker lists or records outside
the selected ruleset's run.

### Readiness Hash

Compute a deterministic SHA-256 over the fields that affect authorization to finalize:

- Company id.
- Ruleset id and selected run window.
- Covered worker/date spans.
- Payroll row totals and calculation/setup error codes.
- Readiness check codes, severities, entity ids, and source `updated_at`/version values.

Sort arrays and object keys before hashing. Exclude display text, translated strings,
generated timestamps, and comparison-only information.

The hash is an optimistic-concurrency aid, not the final safety boundary. Finalization
still recomputes all data.

### Finalize Endpoint

Keep the current URL for compatibility:

`POST /api/admin/payroll-run/finalize`

Extend the body:

```jsonc
{
  "from": "2026-09-25",
  "to": "2026-09-25",
  "ruleset_id": "pr_123",
  "readiness_hash": "sha256...",
  "acknowledged_warning_codes": ["large_check_delta"],
  "acknowledgement_note": "Reviewed raise for J. Lee"
}
```

Required sequence:

1. Validate input and permissions.
2. Build payroll close/readiness from current source data.
3. Return `409 payroll_readiness_changed` if the submitted hash differs. Include the
   fresh summary/checks so the client can refresh without another request.
4. Return `409 payroll_not_ready` when blockers remain.
5. Return `409 payroll_warnings_unacknowledged` when warning codes are missing.
6. Begin the existing finalization transaction and advisory lock.
7. Recheck finalized-run overlap inside the transaction.
8. Insert `payroll_runs`, `payroll_run_checks`, and the readiness snapshot.
9. Commit, write the existing audit event, and return the saved run with checks.

Do not trust client-supplied warning text, amounts, worker ids, or entity ids. The
client sends only stable warning codes, a bounded note, and the readiness hash.

### Correction Deep Links

Add URL-backed filters to existing screens instead of building duplicate editors:

- `/timeclock#wf-approvals` plus search parameters for date, worker, and issue.
- `/timeclock#wf-timeoff` plus date/status.
- `/timeclock#wf-expenses` plus date/status.
- `/administration#team` plus worker id.
- `/administration#workspace` plus settings section.

React Router hash/query handling must preserve both parts. Back navigation should
restore the Payroll tab, selection, and scroll position without requiring global
mutable state.

## Data Model

Add columns to `payroll_runs` in the next available migration number at build time:

```sql
ALTER TABLE payroll_runs
  ADD COLUMN IF NOT EXISTS readiness_hash VARCHAR(64),
  ADD COLUMN IF NOT EXISTS readiness_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS acknowledgement_note VARCHAR(1000);
```

`readiness_snapshot` stores:

- Schema version.
- Generated/finalized timestamp.
- Stable blocker/warning/information codes and counts.
- Acknowledged warning codes.
- Covered work-date bounds.
- Summary totals in integer cents/minutes where possible.
- Actor user id.

Do not store full source records, GPS coordinates, receipt contents, or duplicated pay
stub detail in this JSON. The immutable check details already live in
`payroll_run_checks.detail`.

Backfill is unnecessary. Older runs display `Readiness snapshot unavailable` and
continue to work.

Update:

- `server/schema.sql`.
- `docs/db-enums.md` only if a new fixed-value column is introduced. JSON property
  strings do not require database enum documentation.
- Company export/delete registry if it enumerates payroll-run columns explicitly.

## Client Design

### Components

Create:

- `PayrollCloseAssistant.jsx` - state owner and four-step layout.
- `PayrollReadinessList.jsx` - grouped checks and action links.
- `PayrollReviewTable.jsx` - current rows, deltas, filters, and stub expansion.
- `PayrollFinalizePanel.jsx` - acknowledgements and final confirmation.
- `PayrollDeliveryPanel.jsx` - finalized outputs and durable statuses.

Reuse:

- `PayStub` for expanded and printable check detail.
- Existing CSV utility.
- `PayrollHistory` for past runs, with an optional callback to open one run in the
  assistant.
- Existing inline `ErrorBoundary`, skeleton, toast, and permission hooks.

Once the assistant reaches feature parity, retire the old live UI inside
`PayrollRun.jsx` or turn it into a thin compatibility wrapper. Do not maintain two
independent payroll-run screens.

### State and Refresh

- Selection is stored in URL parameters so refresh/back navigation is predictable.
- Abort or sequence-guard stale requests when selection changes.
- The page does not poll continuously. Refresh on tab focus after five minutes, after
  returning from a correction screen, and on explicit Refresh.
- Any mutation that can affect payroll invalidates the displayed readiness result.
- If the API returns `payroll_readiness_changed`, replace the screen with the fresh
  result and announce the change accessibly.

### Responsive Behavior

- Desktop: readiness list and period summary may use two columns; review table remains
  horizontally scrollable.
- Mobile: one column, fixed action footer only during final confirmation, worker rows
  collapse into label/value pairs, and no text may be clipped inside status controls.
- Use icons for refresh, print, download, and expand/collapse, with tooltips and
  accessible names.
- Avoid nested cards. Use one primary work surface with bordered rows and full-width
  status bands.

### Language and Accessibility

- Add English and Spanish strings together and retain the i18n parity test.
- Check codes stay server-side constants; the client maps codes to translated labels.
- Every severity has text and iconography, not color alone.
- Status updates use `role="status"`; blockers use a concise `role="alert"` only when
  newly introduced by an action.
- Step navigation, expandable workers, acknowledgement controls, and finalization are
  keyboard operable.

## Permissions

No new permission is required for the MVP.

- View readiness/preview: `view_reports` and `view_worker_wages`.
- Finalize, mark paid, void, and source-lock actions: `manage_pay_periods`.
- Correction links can be shown to everyone who can view the problem, but the linked
  screen enforces its own action permission (`approve_entries`,
  `manage_reimbursements`, `manage_settings`, and so on).

When the viewer cannot correct an item, the row should say which permission or role is
needed rather than hiding the blocker.

## Audit and Observability

Extend the existing audit log events:

- `payroll.readiness_viewed` is intentionally not logged; reads would be noise.
- `payroll.finalized` adds readiness hash, warning codes, and acknowledgement note.
- `payroll.source_locked` records the run ids used to prove full coverage.
- Existing `payroll.voided` and paid events remain authoritative.

Add structured server logs for:

- Readiness calculation duration and query count.
- Blocker/warning counts by code, without worker names or pay amounts.
- Hash mismatch on finalization.
- Failed source-lock coverage preflight.

Capture unexpected failures in Sentry through the existing middleware. Do not send
wages, deductions, names, or pay-stub contents as Sentry context.

## Performance Targets

- Readiness plus preview: under two seconds for a company with 500 workers and a
  biweekly period on the normal production database tier.
- Bounded database queries, no per-worker SQL loop.
- Response should omit source record bodies and remain comfortably below 1 MB for 500
  workers.
- Finalization remains transactionally serialized per company using the existing
  advisory lock.

## Testing Plan

### Pure Unit Tests

- Severity classification for every readiness code.
- Readiness hash is stable across object/row ordering.
- Display-only changes do not alter the hash.
- Source version/entity changes do alter the hash.
- Comparable-check selection for weekly, biweekly, semimonthly, and monthly schedules.
- Delta threshold boundaries.
- Covered-date union for grouped checks and arrears schedules.

### Server Route/Service Tests

- Permission and add-on gates.
- Company isolation on every source query.
- Ruleset scoping: another ruleset's pending items do not block this run.
- Active clock, pending time, pending leave, pending reimbursement, missing role,
  ambiguous ruleset, missing rate, negative net, no checks, and overlap blockers.
- Each warning category and acknowledgement behavior.
- Hash mismatch after an entry changes between preview and finalize.
- Concurrent finalize attempts: one succeeds, one returns 409.
- Finalize stores exactly the previewed calculation and readiness snapshot.
- A failed insert rolls back the run, checks, and snapshot.
- Older finalized runs with null hash/empty snapshot still load.
- Source-lock preflight refuses partial ruleset coverage.
- Source-lock preflight succeeds only with every affected worker covered and no
  unresolved pending time.

Use a real scratch Postgres integration test for the readiness SQL and finalization
transaction. Mocked pool tests alone are insufficient for joins, date casts, arrays,
JSON, and advisory-lock behavior.

### Client Tests

- Latest unfinalized period auto-selects.
- Changing period cancels/ignores stale responses.
- Blockers disable finalization and correction links preserve filters.
- Warnings require acknowledgement and clear when selection changes.
- Hash-change response refreshes the screen instead of finalizing stale data.
- Finalized response uses saved rows, not a second live preview.
- Back from Approvals restores the selected run.
- Permission-limited viewer sees the blocker and the required-permission explanation.
- Mobile layout does not hide amounts/actions.
- English/Spanish key parity.

### Browser Workflows

Run these on dev with Demo Operations:

1. Clean weekly period: review, finalize, print a stub, mark paid.
2. Pending entry: assistant blocks, Approvals link is correctly filtered, approving
   it makes the run ready after return.
3. Open shift crossing midnight at period end.
4. Pending leave and pending reimbursement that would change net pay.
5. Worker missing a role; worker matching two rulesets.
6. Backdated rate change inside the period and a large check delta.
7. Two administrators preview together; one edits/finalizes before the other.
8. Two rulesets with overlapping work dates; finalizing one must not lock the other.
9. Void a finalized run, correct source data, and finalize replacement.
10. QuickBooks-connected company: journal action reports its durable ledger result.
11. Phone viewport and keyboard-only desktop pass.

### Regression Gates

- Full server Jest and ESLint.
- Full client Vitest, ESLint, and production Vite build.
- Migration lint against a disposable Postgres database.
- Existing payroll calculation golden tests unchanged unless an intentional math bug
  is separately approved.
- Existing CSV and printable stub totals match the finalized snapshot.

## Delivery Phases

### Phase 0: Safety Extraction

1. Inventory every source mutation that can change finalized pay: time, leave,
   reimbursement, rates, rulesets, deductions, and worker role/type.
2. Confirm each path either refuses changes covered by a non-void finalized run or
   explicitly requires voiding the run first.
3. Move any duplicated finalized-run checks into one shared helper before adding new
   UI.
4. Add real-Postgres coverage for current finalization and overlap rules.

Exit criterion: finalized pay cannot be silently changed through any supported write
path.

### Phase 1: Readiness Service and API

1. Extract/reuse the payroll computation as one service call.
2. Implement covered-span resolution and batched readiness queries.
3. Implement stable codes, severity, source actions, comparisons, and hash.
4. Add `GET /admin/payroll-close` with full route/service tests.
5. Do not enforce readiness in finalization yet.

Exit criterion: API correctly describes Demo Operations scenarios and matches the
existing payroll preview totals.

### Phase 2: Assistant UI

1. Add the selection header, Prepare checklist, Review table, and correction links.
2. Preserve old finalize behavior behind the current endpoint while the new UI is
   tested.
3. Add responsive and bilingual client tests.
4. Run the full Demo Operations browser workflow.

Exit criterion: administrators can find and fix every surfaced issue without manually
hunting across tabs.

### Phase 3: Enforced Finalization and Audit Snapshot

1. Apply the migration for readiness hash/snapshot/note.
2. Extend finalization to recompute readiness and enforce blockers/warnings/hash.
3. Return the saved run/checks and switch the UI to the saved result.
4. Add audit and structured timing logs.
5. Verify concurrency and rollback on real Postgres.

Exit criterion: stale or blocked payroll cannot be finalized through either the UI or
a direct API request.

### Phase 4: Delivery and Safe Source Lock

1. Consolidate CSV, print, paid status, and QuickBooks actions under finalized runs.
2. Surface QBO outbox/ledger status rather than optimistic button state.
3. Implement the all-workers/all-rulesets source-lock preflight.
4. Offer source locking only when the proof succeeds.

Exit criterion: a completed run has a clear, durable delivery and payment state, and
locking cannot freeze an unfinished ruleset.

### Phase 5: Release and Cleanup

1. Keep the old PayrollRun UI available behind a temporary feature flag during dev
   and stage validation.
2. Compare old/new preview totals for the same periods and log mismatches without pay
   details.
3. Test the full matrix on dev, then stage only after explicit authorization.
4. Remove the old UI path after two successful payroll cycles or explicit owner
   approval.
5. Update the user guide, contextual help, and changelog.

## Rollout and Recovery

- Add company setting `feature_payroll_close_assistant`, default false during dev.
- No production enablement is implied by implementing this plan.
- The migration is additive and backward compatible.
- Turning the flag off restores the old payroll UI; finalized snapshots remain valid.
- If readiness queries fail, show an error and refuse finalization through the new UI.
  Do not fall back to assuming ready.
- Keep the existing finalize endpoint response compatible until all clients using the
  old shape have been retired.

## Acceptance Criteria

The feature is complete only when all are true:

- A scheduled period opens with one understandable readiness state.
- Every blocker shows count, reason, and a working correction destination.
- Another ruleset's unresolved work cannot incorrectly block or become locked by this
  run.
- Payroll preview totals are produced by the existing shared pay engine.
- Warnings are explicit, acknowledged, and preserved in the finalized audit snapshot.
- Changing source data after preview prevents stale finalization.
- Finalization is concurrency-safe and immutable until voided.
- The finalized screen offers final CSV, printable stubs, paid state, and applicable
  QuickBooks actions.
- No pay amount, worker, or source record crosses company boundaries.
- English and Spanish experiences are complete.
- Desktop, phone, keyboard, and screen-reader status behavior are verified.
- Unit, route, real-Postgres, build, and browser workflows pass.

## Explicit Non-Goals

- Replacing an external payroll processor or filing payroll taxes.
- Direct deposit.
- Automatically approving time, leave, or expenses.
- Changing overtime, premium, leave, guarantee, rate, or deduction math.
- Building a new QuickBooks billing model.
- Ruleset-scoped source locks in the MVP.
- Predictive anomaly detection or AI explanations of payroll.

## Implementation Checklist

- [ ] Re-read `docs/CHANGE-RISK-2026-09-24.md` and current payroll follow-ups.
- [ ] Verify the next migration number; do not rely on numbers in this plan.
- [ ] Complete Phase 0 mutation inventory and protection tests.
- [ ] Add `server/services/payrollClose.js` and pure helpers.
- [ ] Add real-Postgres readiness/finalization tests.
- [ ] Add `GET /api/admin/payroll-close`.
- [ ] Build the assistant components and URL-backed correction filters.
- [ ] Add English/Spanish strings and parity tests.
- [ ] Add additive payroll-run audit columns.
- [ ] Enforce readiness/hash/acknowledgements during finalization.
- [ ] Consolidate finalized delivery actions.
- [ ] Add safe source-lock preflight.
- [ ] Run focused and full automated verification.
- [ ] Test all browser workflows on dev with Demo Operations.
- [ ] Update help, user guide, changelog, and change-risk inventory.
- [ ] Commit and push each coherent phase to `dev` only.
- [ ] Do not push or deploy to stage or production without David's explicit request.
