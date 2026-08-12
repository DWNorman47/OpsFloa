# OpsFloa — Work Log

What Claude reported back to David after each task, kept so it survives the chat
scrolling away. **Newest first.**

**What belongs here:** what shipped (with commit refs), the *non-obvious things
found along the way*, judgment calls made on David's behalf that he may want to
overrule, and anything waiting on him.

**What does NOT belong here** (so this stays scannable rather than becoming a
second copy of everything):
- Code-level rationale → the commit message.
- Parked bugs / ideas / todos → `docs/BACKLOG.md`.
- Per-feature design + milestones → `docs/plans/*.md`.
- Fixed-value column rules → `docs/db-enums.md`.

Cross-reference those rather than restating them. The unique value here is the
**findings** and the **calls** — the things that otherwise only ever existed in
a chat window.

Conventions: `YYYY-MM-DD`, newest first. ⚠️ marks something David should decide
or act on. Commit hashes are on `dev` unless noted.

---

## 2026-08-01 — AI Jump Start earthwork: contour geometry extraction (iteration 1)

The spot grades on David's grading sheets are vector/SHX line-work, not text —
confirmed by the diagnostic: the drawing's text layer held the contour integers
303–337 and the notes/title block, but not one of the ~40 FS/TG decimal spots. So
spot extraction can't work on these sheets. David chose to go after the **contours**
instead — the better earthwork input anyway, and the lines ARE vector geometry with
text elevation labels.

- `extractPdfPolylines` (pure, unit-tested): walks pdf.js `getOperatorList()` with a
  CTM stack (save/restore/transform/constructPath) and returns every polyline in
  base-px page space. Béziers approximated by endpoints.
- `runContourExtract` (dirt trade): keeps sheet-spanning polylines as candidate
  contours, labels each from the nearest integer text (305, 312…), places them as
  `contour` markups on the current surface; also grabs any text spot grades. Loose
  classification on purpose — capped at 800, diagnosed to the console
  (polylines/candidates/labeled), framed to the user as a first pass to eyeball and prune.

ITERATION 1 — untestable here (needs the browser + the real PDF). The geometry math
IS unit-tested (transform composition, save/restore, rectangle, curve endpoint), but
whether the length filter cleanly separates contours from buildings/dimensions/the
vector spot-text is unknown until David runs it. Expect to tune the filter next.
Cache-bust v=85. pdf.js is 3.11.174 (exposes OPS + getOperatorList).

## 2026-08-01 — AI Jump Start: deterministic earthwork spot import; button gated to vector PDFs

Follow-up to the trade-aware rework. David ran the AI earthwork pass on a real
grading sheet and got ~40 spot-elevation dots that were meaningless — different
elevation *types* (FF floor, TG grate, FL flowline, FS grade) lumped together, all on
one surface, no cut/fill, some misread. The realization: the tool was **photographing
a vector PDF that already contains the exact data.** pdf.js is loaded, the doc wrapper
keeps `raw` (the live PDF), and `renderPage()` was flattening it to a PNG for the
vision model — throwing away selectable text at exact coordinates.

- **Earthwork now reads the PDF text layer, not a picture** (`planroom/app.js`
  `parseEarthworkSpots` + `runEarthworkExtract`). `page.getTextContent()` → every spot
  grade with its exact position; `viewport.convertToViewportPoint` maps it into the
  markup space; placed as `espot` markups. Deterministic — no server, no AI, no
  metering, instant.
- **Classifies from the drawing's own conventions** — `(parens)`/`EG` = existing,
  `FS`/`FG`/`GB`/`TP` = proposed; `TG`/`FL`/`FF`/`LIP`… = structure/floor → reported
  but NOT placed (not ground grades). Requires a disposition signal, so bearings/
  dimensions/slopes ("185.00", "1.0%", "100.14'", "FF = 312.50") are never mistaken for
  grades; untagged numbers are ignored, not guessed.
- **Button gated to capability**: hidden by default; JS reveals it only on a page with
  a real text layer (vector PDF). Scans/raster → no button (David's call: better
  nothing than noise). Cache-bust v=83. Other trades still use the vision pass on
  vector PDFs.

Why this answers "why can you read it but the tool can't": comprehension was never the
gap — precise coordinate *emission* is (weak for every vision model, me included). For
a vector PDF you don't need the model to localize; the coordinates are in the file, so
read them.

Tests: `earthworkSpots.test.js` (tag/paren classification, structure-skip, bearing/dim
exclusion, dedup, junk-safe) via the lift pattern. Server 1303 green; client build green.

Limits: vector PDFs only. Cut/fill still needs both surfaces + contours — this seeds
exact spot grades; contour vectorization (`getOperatorList`) is a possible next step.
The earthwork path is now exact, so it carries no live-API caveat.

## 2026-08-01 — AI Jump Start: trade-aware + a real earthwork pass; re-enabled

David flagged that Jump Start, run in the Earthwork (cut/fill) trade on an
existing-conditions sheet, came back as a tree count + a landscape blob — useless.
Root cause: the button was **trade-blind**. The client sent only the page image; the
server ran one static, generic "counts + rough regions + labels" prompt for every
trade — and that prompt explicitly forbids contours/precise geometry, i.e. the
essence of cut/fill. So it did a generic scan and mirrored the sheet's own callouts.
(The button had been `hidden` since it first disappointed.)

Reworked end to end:
- **Trade-aware prompting** (`server/routes/jumpstart.js`): the client now sends
  `state.trade`; the server validates it and appends a per-trade focus block so the
  model targets that trade's quantities (roofing planes, striping stalls, landscape
  counts, …) instead of a generic scan. Also tightened the base rules — keep opposite
  dispositions in separate groups (no more "removed/protected" in one bucket), don't
  double-represent an item as both a count and a region.
- **Earthwork honesty** (M2): a new `earthwork` verdict — existing vs proposed
  contours, `cutFillComputable` (forced false unless a proposed surface was actually
  seen), and a reason. On an existing-conditions sheet the summary now leads with
  "cut/fill can't be computed from this sheet — run me on the grading/proposed sheet"
  instead of drawing a blob.
- **Real dirt pass** (M3): in the dirt trade the model reads **spot elevations**
  (value + best-guess existing/proposed surface) → placed as `espot` markups, and a
  limits-of-disturbance region → an `ebound` boundary — both feed the manual cut/fill
  flow. It does NOT trace contour polylines (unreliable on a raster) or invent
  clearing blobs.
- **Re-enabled the button** — removed `hidden` in `planroom/index.html`; cache-bust → v=82.

Tests: extended `jumpstartParse.test.js` (spots + the proposed-required verdict) and
`jumpstartToMarkups.test.js` (spots→espot, limits→ebound, non-dirt stays qarea).
Server 1294 green; client build green.

⚠️ **Reading quality is empirical and unverified here** — no vision-API key in this
environment, so I could only test the plumbing and placement, not whether the model
actually reads spot elevations / classifies surfaces well. That needs a real run on
dev against a grading sheet; expect to tune the dirt prompt after seeing output.
Contour-tracing → cut/fill *volumes* from a raster remains out of scope.

## 2026-07-31 — Security & correctness audit — fixed everything

Broad audit of the whole server, then fixed all confirmed findings. No schema
changes (no migration), so `docs/db-enums.md` is untouched. Server: 1287 tests
green (101 suites). Client: eslint clean, 288 tests, build OK. (Both suites flake
under back-to-back runs on this box — jest worker `VirtualAlloc`/`spawn` OOM and
esbuild "service was stopped"; both pass cleanly with `--maxWorkers=2` / vitest
`--no-file-parallelism`. Not code failures.)

**Tenant isolation / IDOR**
- `timeEntries /:id/messages` (GET+POST): scoped the entry lookup to owner-or-admin
  — a worker could read/post on a coworker's entry thread by enumerating the id.
- `catalog/*`: added `requireCommercialAccess` — supplier cost / sell price / markup
  were readable by any authenticated worker.
- `booking /appointments`: non-admins are now scoped to their own assigned rows;
  the full list leaked every client's name/email/phone/notes to any worker.
- **Cross-tenant `project_id` on write** — validate belongs-to-company on
  incidents, reimbursements (both POSTs), safetyChecklists, safetyTalks (POST+PATCH),
  subReports (POST+PATCH), rfis (POST+PATCH), and admin `/clock-in`. Clock-in was the
  real bug: a foreign `project_id` baked that project's `wage_type` into the entry
  (corrupting pay). The rest only leaked a foreign project **name** via an unscoped
  JOIN. **Judgment:** skipped `inspections` — its `project_id` is UUID while
  `projects.id` is INTEGER, so the JOIN never matches (no leak) and the int-keyed
  helper would throw on a UUID.

**Correctness**
- **RFI numbering**: admin `POST /projects/:id/rfis` numbered **per-project** but the
  unique constraint is **per-company** (`uq_rfis_company_number`), so every 2nd+
  project's first RFI (number 1) collided → 500. Switched to a company-wide atomic
  inline subquery, matching the schema and the sibling `POST /rfis`. **Judgment:**
  fixed the code, not the constraint — company-wide is the intended model (the unique
  index, the constraint, and `rfis.js` all agree); loosening the constraint would let
  the two create paths mint duplicate numbers.
- **Daily reports**: POST's `ON CONFLICT DO UPDATE` let a worker silently overwrite a
  coworker's report for the same project+date (PATCH enforced ownership, POST didn't)
  → added an owner guard. PATCH deleted+reinserted all sub-tables unconditionally, so a
  status-only PATCH wiped manpower/equipment/materials → now only touches a sub-table
  when its array is actually sent. Both covered by new tests.
- **OT alert week bucket** (`clock.js`, both switch + clock-out paths): used
  `DATE_TRUNC('week')` (always Monday), ignoring company `week_start` — misfired the
  weekly-OT *alert* for non-Monday weeks. Now buckets by `week_start` like the pay
  engine. (Alert only; pay was already correct.)
- **Shift push/inbox dates** (`shifts.js`): interpolated a node-pg `Date` raw →
  "Thu Jul 30 2026 00:00:00 GMT…" in one spot and "Thu Jul 30" (no year) in three
  others. Added `fmtShiftDate` → `YYYY-MM-DD` from local parts (TZ-safe). Verified
  node-pg returns DATE as a Date object here (no `setTypeParser`).
- **Email injection** (`auth.js` 417/527): `full_name` interpolated unescaped into two
  confirmation emails — wrapped in the `escapeHtml` the rest of the file already uses.

**AuthZ / permission tiers** (custom admin roles could bypass granular perms)
- QBO mutation/action routes now require `manage_integrations` (only `/push-payroll`
  did); read-only lookup GETs left as-is.
- Project budget/expense **writes** now require `manage_projects`
  (`requireProjectFinancialWrite`) — the old gate accepted view-only `view_projects`.
- Company chat gated on `view_company_chat` / `send_company_chat` (was `requireAuth`
  only, ignoring those perms).
- Worker wages: `/workers` list nulls `hourly_rate` for admins without
  `view_worker_wages`; `/workers/:id/entries` (full pay statement) now requires it.

**Resilience / idempotency**
- **QBO double-send**: threaded Intuit's `requestid` idempotency key through
  `createBill`/`createPurchase`/`pushTimeActivity`/`createInvoice` (deterministic per
  source row/range), so a double-click dedupes at Intuit. **Judgment:** chose this over
  an advisory lock — the lock needs `pool.connect` (not in the route-test mocks) and
  would break the strict `pool.query` call-count assertions, and can't be verified
  without a real DB. `requestid` mirrors the existing `push-payroll` pattern and is
  test-assertable.
- **QBO token-refresh race**: concurrent refreshes both send the rotating refresh
  token; the first invalidates it, the second's `invalid_grant` then **disconnected the
  company**. Added a per-company in-flight-promise coalescer (single-process guard —
  matches the Render deployment; multi-instance would need a DB lock).
- **Cron jobs**: per-company `try/catch` in equipmentMaintenance / inactiveWorkers /
  scheduledReports so one company's error can't abort the batch — and, more importantly,
  can't escape to `runJob`, whose whole-job retry re-alerts every company already
  processed this run.

### Backed out (my mistake)
- I briefly gated `/api/office` + `/api/recordings` on `requirePlanToolsAddon` to
  match `/api/jumpstart`/`takeoffs`/`live`, assuming they were the same class of
  feature. They aren't: `requirePlanToolsAddon` only unlocks on
  `addon_takeoff`/`addon_planroom`/`addon_roof` (the **Plan Room / takeoff family**).
  jumpstart belongs there (it's a first-draft *takeoff*); the Office AI tools and
  meeting recordings don't — gating them there would force a Takeoff-add-on purchase to
  use an unrelated summarizer. **Reverted** — they stay `requirePlan('business')` +
  aiGate metering, as before. David caught it.

### Filed, not forgotten
- Equipment-maintenance alert still **re-fires daily** while an item stays overdue
  (no send-once-until-serviced stamp — that needs a schema column; the per-company
  try/catch fix here only stops the retry-resend). Filed in BACKLOG as a decision.

## 2026-07-29 - Commercial access and export safety pass

- Closed worker-readable API gaps across estimates, invoices, change orders, sub-POs,
  project financials, portfolio/WIP reporting, subcontractors, submittals, closeout, and
  lien waivers. Server gates now match the admin/module permissions presented by the UI;
  the previously unauthenticated estimate plan-PDF read is protected as well.
- Split project financial access from portfolio reporting access so project admins retain
  their project financial tab while company-wide profit/WIP data requires reporting access.
- Preserved settings-only Sales access after the Projects consolidation, hid project/work
  tabs from Sales-only users, and made Work Orders hash navigation survive reloads.
- Added tenant ownership validation for submittal assignees and relationship validation for
  lien-waiver POs, payments, subcontractors, invoices, and projects. Draft waiver date edits
  now use the same strict date and range checks as creation.
- Replaced browser-local CSV encoders with one formula-injection-safe encoder across payroll,
  worker/project reports, schedules, haul tickets, billing, and inventory exports. WIP export
  now uses the authenticated API client and surfaces HTTP failures instead of downloading an
  error response as a CSV.

Verification: all 159 migrations passed static and replay/idempotency lint; 1,244
server tests and 275 client tests passed; server/client ESLint and the production/PWA
build passed. Server production dependencies audit clean. Client audit retains the two
documented high React Router RSC/server-action findings; those modes are not used by
this browser-only app, and the available forced downgrade is not a compatible fix.

---

## 2026-07-29 - Inventory, invoice, and offline integrity pass

- Required inventory visibility on inventory reads and worker stock transactions, while
  preserving cost visibility for inventory managers. Added company/item/location/project
  validation across stock movements, bins, item UOMs, locations, and purchase orders;
  issue transactions now validate and decrement the selected source bin.
- Serialized PO numbering and receiving, added company-scoped PO-number uniqueness, and
  made cycle-count submission one locked transaction so invalid/final submissions cannot
  consume assignments or partially change count state.
- Replaced the dashboard's independent payroll math with the canonical server pay-statement
  engine for the displayed week, including approved entries, role/project rates, guarantees,
  leave, premiums, and reimbursements. Free-plan period limits are enforced server-side.
- Escaped invoice and inventory-label print content and restricted embedded signatures to
  raster image data URLs.
- Scoped IndexedDB caches and count queues by company/user, resumed queued counts on an
  already-online mount, preserved submissions on auth/transient failures, and bound service
  worker replay/clearing to the account that originally queued each request.
- Added focused route and client regression coverage for the new permission, tenant,
  transaction, canonical-pay, and offline-account boundaries.

Verification: all 159 migrations passed static and replay/idempotency lint; 1,228
server tests and 266 client tests passed; server/client ESLint and the production/PWA
build passed. Server production dependencies audit clean. Client audit retains the two
documented high React Router RSC/server-action findings; those modes are not used by
this browser-only app, and the suggested forced downgrade reintroduces other advisories.

---

## 2026-07-29 - Second-pass app and payroll repairs

- Fixed the punch-list PATCH route's missing `project_id` binding and added route-level
  tenant/reference regression coverage.
- Serialized payroll paid/void mutations with row locks and transactions, and made the
  client payroll run/history/certified-report views ignore stale responses. Finalization
  now uses the exact period and ruleset that produced the displayed register.
- Rebuilt QuickBooks payroll posting on the canonical payroll engine, protected it with
  payroll/wage permissions and a bounded date range, and added a stable Intuit request ID
  so retries cannot duplicate a journal entry.
- Split WH-347 output by worker classification while preserving week-wide overtime,
  corrected displayed OT/classification details, kept signatures current after signing,
  and escaped dynamic print-window content in pay stubs and certified payroll.
- Protected wage-bearing payroll reads, blocked legacy permission edits for role-managed
  workers, constrained conflict-protected settings saves to one document, validated real
  schedule dates, and bounded expensive payroll/report ranges.
- Added server ESLint enforcement plus focused transaction, race, authorization,
  classification, date-range, print-escaping, and QuickBooks regression tests.

Verification: all 158 migrations passed static and replay/idempotency lint; 1,220 server
tests and 263 client tests passed; server/client ESLint and the production/PWA build
passed. Server production dependencies audit clean. Client audit retains two high
findings for React Router server-action/RSC behavior; OpsFloa is browser-only, and the
older React-18-compatible Router release reintroduces a larger set of redirect/SSR
advisories, while Router 8 requires React 19.

---

## 2026-07-28 — App repair and payroll hardening

- Closed cross-company reference holes on equipment, field reports, punch lists, and
  daily reports; also fixed the daily-report missing-target transaction rollback and
  aligned legacy permission resolution.
- Hardened payroll periods and finalization: strict date validation, ruleset-scoped
  period choices/runs, zero-check suppression, a per-company finalize lock, and
  overlapping worker-period rejection. Migration `0158` records the ruleset on payroll
  runs and makes finalized-run uniqueness ruleset-aware.
- Reconciled WH-347 calculations with payroll: all-project reports use each project's
  prevailing rate, displayed OT/prevailing rates derive from actual costs, daily-rate
  workers no longer receive hourly night differential, and line-item OT now reconciles
  when a minimum-daily floor crosses the threshold.
- Tightened payroll authorization: read-only reports, certified payroll, payroll
  mutation, signatures, fringes, and SSN operations now use their dedicated permissions;
  clients hide controls users cannot execute.
- Made payroll settings resistant to stale concurrent saves and normalized deterministic
  IDs for legacy id-less deductions and role scopes.
- Updated the client build/test toolchain for Vite 8 and retained React Router 7 because
  the patched Router 8 line requires React 19 while the current PDF, mapping, and charting
  dependencies support React 18. The remaining client audit advisory applies to Router
  server actions/RSC, which this browser-only Vite app does not use.

Verification: migration lint/replay passed for 158 migrations; 1,206 server tests and
260 client tests passed; ESLint and the production/PWA build passed. Server production
dependency audit is clean.

---

## 2026-07-31 — Billing: in-app plan change (starter ↔ business), no second subscription

Follow-up to the double-subscription guard: give subscribed companies real in-app upgrade/
downgrade buttons that modify the EXISTING subscription instead of creating a parallel one
(and instead of just erroring / sending them to the Stripe portal).

- **`POST /stripe/change-plan { plan }`** (`stripe.js`): retrieves the live subscription and,
  in ONE atomic `subscriptions.update`, swaps the base-plan price on the existing base item,
  keeps every add-on (listed by id so it can't be dropped whether Stripe merges or replaces
  the item set), and adds/updates/removes the per-worker seat item. Keeps the billing interval
  (annual stays annual). Business seats = `max(0, activeWorkers − 15)` computed server-side
  (authoritative, not a client estimate). Prorated (`create_prorations`). Guards: no live sub →
  400; already on the target plan → 400; add-ons-only sub (no base) → 400; **downgrade to
  Starter refused if active workers exceed Starter's cap** (10 + bonus_seats). DB `plan`
  reflected immediately; the `customer.subscription.updated` webhook re-confirms plan + MRR.
- **Client** (`BillingPanel.jsx`): for an already-active company the Starter/Business cards now
  read "Switch to X" and call `changePlan()` (confirm dialog → POST /change-plan → refresh
  status) instead of `/checkout`. Trial/free companies still checkout as before; downgrade-to-
  Free stays a portal cancel (unchanged). `billingSwitchToPlan` / `billingChangePlanConfirm` /
  `billingChangePlanFailed` EN+ES.
- **Tests:** `stripeChangePlanRoute.test.js` (10) — upgrade adds the right seat overage +
  preserves the add-on, ≤15 workers adds no seat item, downgrade removes the seat item +
  preserves the add-on, downgrade blocked over cap (and bonus seats raise it), annual uses
  annual prices, already-on-plan / no-sub / add-ons-only / bad-plan all rejected without a
  Stripe write. Suite green (server 1285).

## 2026-07-31 — Billing: prevent accidental double subscription / double add-on

A customer bought their subscription twice → refund + lost Stripe fees. Root cause found in
`server/routes/stripe.js`: **`POST /stripe/checkout` had NO guard** — it minted a fresh Stripe
subscription every call. So a company that was already subscribed (clicked Subscribe again, or
clicked a *different* plan — the client's plan buttons hit /checkout, not a plan-change flow)
got a SECOND parallel subscription that billed alongside the first.

- **The fix:** a `liveSubscription()` helper retrieves the company's Stripe subscription and
  returns it only if genuinely live (active/trialing/past_due/unpaid) — **verified against
  Stripe, not the DB flag**, so a webhook lag can't let a duplicate through and a stale id for
  a canceled sub doesn't wrongly block a re-subscribe. `/checkout` now 409s (`has_subscription`)
  when a live subscription exists, directing the admin to Manage billing to change plan / add-ons.
- **`/checkout-addon`** already blocked a second subscription via the DB flag but only for
  `active`/`past_due` — added `trial` so a company with a pre-purchased *trialing* base plan
  can't create a second sub through the add-on door either.
- **Add-ons** were already double-safe: `/addon` is idempotent (skips an add-on already on the
  sub), `/checkout` and `/checkout-addon` de-dupe line items, and both add-on paths require /
  route to the single existing subscription.
- **Client** (`BillingPanel.jsx`): the buttons already disable during an in-flight redirect;
  added a function-level `if (redirecting) return` guard on `checkout`/`checkoutAddons` so a
  fast double-click can't open two checkout sessions.
- **Tests:** new `stripeCheckoutRoute.test.js` — live sub → 409, trialing → 409, canceled/
  missing id → allowed, fresh company → allowed (no Stripe call). Suite green (server 1275).

Note: an already-subscribed company clicking a *different* plan now gets the 409 "manage from
Billing" message rather than a second subscription. If you want in-app plan *changes* (vs the
Stripe portal), that's a separate follow-up — the portal already changes the existing sub safely.

## 2026-07-31 — Role management: split managing roles vs ADMIN roles

David: create/edit/delete roles and create/edit/delete ADMIN roles should be distinct —
Owner gets both, Admin gets the first by default.

`manage_roles` was a single Owner-only permission. Split it:
- **`manage_roles`** = create/edit/delete NON-admin (worker-tier) roles → now in
  ADMIN_PERMISSIONS (Admin + Owner).
- **`manage_admin_roles`** = create/edit/delete ADMIN-tier roles (parent_role 'admin':
  the built-in Admin/Owner + any custom admin role) → Owner only.

- **permissions.js:** new catalog entry; `manage_roles` moved to ADMIN_PERMISSIONS,
  `manage_admin_roles` added to OWNER_PERMISSIONS. Migration `0162` grants the new defaults
  to existing companies' built-in Admin/Owner (custom roles snapshot at creation, by design).
- **Routes** (`POST/PATCH/DELETE /admin/roles`): keep the `manage_roles` base gate, and
  additionally require `manage_admin_roles` when the target role's `parent_role === 'admin'`.
  Used `getUserPermissions` (already computed for the escalation guard, and the resolver the
  route tests mock) rather than a second `hasPerm` DB round-trip. Added `parent_role` to the
  PATCH lookup so the tier is known.
- **Client** (`ManageRoles.jsx`): the "+ New admin role" button is hidden without
  `manage_admin_roles`, and expanding an admin-tier role renders read-only (inputs/checkboxes
  disabled, Save/Delete replaced with "Only an Owner can create or edit admin roles"). Admins
  keep full create/edit/delete on worker-tier roles. `mrolesAdminLocked` EN/ES.
- **Tests:** permission-default tests updated to the new split (manage_roles is Admin-tier;
  manage_admin_roles is the Owner-only one); route tests for the tier gate on
  create/edit/delete + a manage_roles admin still creating a worker-tier role. Suite green
  (server 1269, client 288).

## 2026-07-31 — New Team Member Type: "Unpaid" (excluded from all pay)

David: "Team Member Type should include Unpaid." Confirmed (via a question) that it means
EXCLUDE FROM PAY — an unpaid member is still tracked (time clock, scheduling, hours reports)
but earns nothing and appears on no pay surface.

`worker_type` was purely categorical (QBO routing + display); it never touched the pay
engine. Added `'unpaid'` as a 5th value and wired the exclusion:

- **Foundation:** `'unpaid'` in `USER_WORKER_TYPES` (userEnums.js); migration `0161` extends
  the `0071` CHECK; replaced 4 hardcoded `VALID_WORKER_TYPES` arrays (admin.js ×3, qbo.js)
  with the shared constant; `docs/db-enums.md` updated; UI option + `mwTypeUnpaid` (EN/ES).
- **Central fail-safe:** `buildPayStatement` (the one statement all four pay surfaces + the
  payroll run render) forces every wage RATE to 0 and drops guarantee/leave/deductions/
  per-project prevailing for an unpaid worker → all pay math yields $0 while **hours are
  still computed** (dual-use: the Team Member Report keeps its hours, the invoice shows
  "hours worked, $0"). Reimbursements (expense repayment ≠ wages) are left intact. Gated on
  the flag directly — a `|| 45` fallback was turning a zeroed prevailing rate back to $45
  (caught by a test). `worker_type` added to the 3 single-worker pay SELECTs so the guard fires.
- **List-level exclusion** so unpaid workers don't even render a $0 row: overtime report,
  `computePayrollRun`, payroll CSV, certified payroll (WH-347), scheduled pay email, the
  payroll-periods role probe, and the QBO payroll journal.
- **QBO time sync** skips unpaid labor (auto-sync on approve, /qbo/push, gatherBillData
  vendor bills, retry-error) — they earn nothing to sync.
- **Tests:** unpaid worker → all wage costs/totals 0, hours still tracked, reimbursement
  still repaid, prevailing also $0; plus a guard-against-over-zeroing (a paid worker with
  the same inputs still earns). Suite green (server 1261, client 288).

## 2026-07-30 — Reviewed "Fix critical staging workflows" pull + restored SW clients.claim()

Reviewed David's commit e1b73d8d (payroll UI finalize-confirm + void-disabled-when-paid,
workOrders tenant-ref validation, timeEntries date-range bounds, SW prompt-to-update rewrite,
migration 0160). Suite green. Most of it is good — the payroll UI changes complete the
void-when-paid + finalize-safety UX flagged in earlier passes, and workOrders now validates
project/client/assignee ownership (same cross-tenant gap fixed for invoices/estimates).

**Fixed one regression:** the SW rewrite to prompt-to-update (good — kills the auto-skipWaiting
update loop) also dropped `clients.claim()` on activate. Without it a freshly-registered worker
doesn't control the already-loaded page until the next reload, so on a device's FIRST session
(or right after an error-recovery hard reset) the offline fetch handler that queues clock/
time-entry POSTs never runs — an offline punch in that window is lost instead of queued. Re-added
`self.clients.claim()` on activate; safe because skipWaiting stays message-gated, so it can't
force a waiting worker to activate early or reintroduce the loop.

Left as-is (acceptable given the deliberate prompt-to-update design): the stale-bundle crash
recovery net (`bundleVersionMismatch`) is now mostly dead for the update case; and a reload
clicked in the brief window before the new worker registers wastes one reload (self-corrects).

## 2026-07-29 — Plan Room: fix the 40-page-document slowdown

Report: loading a ~40-page set slows the Plan Room "far too much." Traced every
page-count-scaling path (main render, thumbnail rail, page picker, vector index, autosave
are all already lazy/bounded). Found and fixed three offenders in
`client/public/tool-apps/planroom/app.js`:

1. **Sheet manager rendered ALL N thumbnails eagerly, and re-rendered every one on each
   reorder/remove click** (`renderSheetMgr`). Unlike the page picker, it had no
   IntersectionObserver — opening "Manage sheets" on a 40-page set fired 40 concurrent pdf.js
   page renders, and every ▲/▼/✕ click tore the list down and re-rendered all 40. Now
   lazy (render a row's thumbnail when it scrolls into view) + a per-open canvas cache so
   reorders reuse thumbnails instead of re-rendering. Also count markups-per-page once per
   rebuild instead of once per row.
2. **`paint()` filtered the entire `state.markups` array every animation frame** — O(all
   markups) per frame during pan/zoom, which bites a large multi-sheet takeoff. Added a
   per-page cache (`currentPageMarkups`) invalidated by a rev counter bumped in the
   `markupsChanged` funnel (+ array-ref/length guards); `markupShown` stays in the loop
   since layer toggles change it live. Per-frame cost is now O(current-page markups).
3. **Redundant full-file buffer copy on open** (`openFromBytes`) — `keep = buf.slice(0)`
   was allocated even on the reopen/finalize paths (`persist:false`) that never use it, a
   wasted full-file allocation on a big set. Now copied only when persisting.

Bumped the planroom cache-bust to `?v=80` (app.js + styles.css, per house rule). Static
tool-app assets have no automated coverage — syntax-checked (acorn) + reviewed; worth a
browser spot-check (open a multi-page doc → Manage Sheets → reorder is snappy, markups still
draw). `client/dist` is gitignored (build output), so only `public/` changed.

## 2026-07-29 — Reviewed the pulled "hardening" commits + fixed 3 issues

Pulled two large commits from another contributor ("Harden payroll workflows and tenant
references", "Harden commercial and data integrity workflows" — 106 files). Reviewed with
4 parallel agents. Mostly solid — the inventory rewrite is properly transactional, migration
0159 de-dups before its unique index, the new client utils are correct, the access-control
middleware is a clean tightening, and the new `ruleset_id` payroll scoping actually **closes**
the multi-schedule grouping-overlap I'd backlogged. Found + fixed three real problems:

- **Silent unpaid worker (money).** The new per-ruleset scoping (`computePayrollRun`) skipped
  any worker not in the selected ruleset's roles *before* the setup-error check — so a worker
  whose role maps to **no** ruleset (or a null role) was silently dropped from every run with
  no error, where before it raised `no_ruleset`/`no_role` and blocked finalize. Reordered:
  resolve the ruleset first (setup errors always surface + block), then scope out only workers
  who resolve cleanly to a *different* ruleset. Restores the "never a silent guess" invariant.
- **Cross-tenant FK on invoices + estimates.** The same slice hardened change-orders/subs/
  lien-waivers to validate body FK ownership but **missed** invoices and estimates — a
  company-A admin could POST/PATCH with company-B's `client_id`/`project_id` and leak the
  foreign client's data. Added `clientBelongsToCompany` to `tenantRefs` and validated
  `project_id`/`client_id` on invoice create+update and `client_id` on estimate create+update
  (null allowed). The from-estimate/from-project paths derive from company-scoped sources, so
  they're covered transitively.
- **Lien-waiver regression.** The `invoice_id` check was tightened to require an exact project
  match, which broke linking a **null-project** (from-scratch) invoice. Relaxed to allow a
  null-project invoice (company-wide) while still rejecting a cross-company or different-project
  one. Pinned with a test; the different-project rejection test still holds.

Tests added: invoice client_id rejection, lien-waiver null-project accept. `npm install` in
server was needed — the pulled commit added eslint to the server verify script. Full suite
green (server 1246, client 275, eslint + build).

## 2026-07-28 — Fixed the flagged WH-347 + deductions issues

David gave the go-ahead on the compliance-document items I'd parked for his call. Fixed
+ verified (server 1183, client 256, build ok).

**WH-347 PDF / signatures:**
- The PDF now prints the **signed `compliance_text` snapshot** (the exact wording attested
  to), falling back to a server-provided `default_compliance_text` template when unsigned —
  instead of hardcoded clauses (whose clause 3 was truncated). One source of truth.
- **Regular and prevailing hours print as separate rows** at their own rates (was one merged
  straight-time row at a single rate, hiding the split); the **OT row now shows the OT rate**
  (base × multiplier) instead of a blank cell. GROSS stays the weekly total on the first row.
- **Re-signing preserves history**: before overwriting, the prior signer/signature/compliance/
  date is snapshotted into the audit log (`certified_payroll.signature_replaced`) — the
  original certified artifact is now recoverable.
- POST /signatures **verifies the project belongs to the company** (was missing, unlike the
  read paths); the certification **date renders in UTC** (was viewer-local → off-by-one near a
  day boundary); sign-modal buttons are **bilingual** (`cps*` keys).

**Deductions:**
- The legacy stub path (`payStubTotals`, no min-net floor) now **caps total deductions at
  gross** and re-allocates the itemized lines (integer-cent largest-remainder) so **net can't
  go negative** when multiple deductions sum past 100%. Reimbursements still pay on top.
- `newDeduction` ids are now **unique within the list** (collision would have over-deducted a
  scope:'selected' pick).

**Left in BACKLOG (need a decision, not a bug):** WH-347 fringe cash-vs-approved-plan
(4a/4b/4c) election needs a data model; night/OT premium stays folded into gross (inherent to
the S/O form); company-deduction saves are still last-write-wins (needs optimistic concurrency
on the generic /settings PATCH).

## 2026-07-28 — Sixth review pass — deductions editors + WH-347 PDF/signature

Aimed at the last un-reviewed surfaces: the deductions editors and the WH-347 PDF +
signature flow. Batch-6 re-audited **clean**. Fixed the money-critical deductions gap;
the WH-347 findings are compliance-document decisions parked for David (see below).

**Money-critical — a percent deduction had no ≤100% bound.** A 150% typo (or a fixed
amount switched to Percent, carrying its value over) drove net pay **negative** on the
legacy stub path (no min-net floor there). Clamped percent to ≤100 in the shared
normalizer (`deductions.js` — the one chokepoint every deduction passes through), added
`max="100"` on the client input, and pinned it with a test.

**Deductions saved silently dropped bad rows while showing "Saved".** A row with a name
but no value (or vice-versa) was filtered out by `toPolicy`, yet the UI confirmed success —
so the admin thought a deduction existed when it didn't. Now the save is blocked with a
specific error (which row, why); added `dedErr*` EN/ES keys.

**WH-347 PDF + signature → BACKLOG (flagged for David, not changed).** This is a signed
federal form, so I did not alter it unilaterally. Real items to decide on: the PDF prints
**hardcoded** compliance clauses instead of the `compliance_text` that was actually signed
(and the hardcoded clause 3 is truncated); night/OT premium in gross isn't itemized
(inherent to the S/O format, but confirm); regular+prevailing merged into one row hides the
split; re-signing **overwrites** the prior signature (original artifact unrecoverable); cert
date renders in viewer-local time (off-by-one near a UTC boundary); sign-modal buttons are
English-only. Full list in BACKLOG. SSN handling, signature week/project scoping, and
tenancy on the read paths all checked **clean**.

**Also parked:** deductions can still sum to >100% on the floor-less legacy path; company
deduction saves are last-write-wins (dead `version` field); Math.random id collision (~1e-7).

## 2026-07-28 — Fifth review pass — client UX + certified payroll

Pointed this pass at the two surfaces the prior four barely touched: the client payroll
UI and the certified-payroll (WH-347) surface. The batch-5 fixes re-audited **clean**.
Certified payroll — genuinely under-reviewed — was where the real issues were. Fixed +
verified (server 1180, client 256, build ok).

**WH-347 ignored manual OT overrides (money-of-record on a legal doc).** The report's
entries SELECT omitted `te.overtime_hours_override`, so a manually-set OT figure was
dropped and OT recomputed automatically — the certified document then disagreed with the
invoice/pay stub (which all honor the override via the shared engine). Added the column.

**Certified-payroll on-screen + print understated gross.** The table/print rendered
reg/prevailing/OT cost lines but no night-premium line, so the visible costs didn't sum to
`gross_pay` (which the PDF shows correctly, night premium included). Added a night line to
both so they foot.

**SSN last-4 lookup wasn't company-scoped.** `loadSsnLast4` selected by id only; safe today
(callers pass company-scoped ids) but a latent cross-tenant PII path. Added `company_id`.

**WH-347 week window was timezone-fragile.** `weekStart` was derived via local `Date` +
`toISOString` while `week_end` is used verbatim — on a non-UTC host that makes the 7-day
window 8 days. Made it UTC throughout. (Latent — Render is UTC — but removed.)

**Double toast** on the payroll register: finalize/run render the error inline AND the
global 4xx interceptor toasted it. Passed `{ suppressToast: true }` per api.js's own
documented pattern.

**Parked → BACKLOG:** per-project prevailing rate in all-projects WH-347 mode (single-
project is correct; the pay statement already has the project rate map); server error
strings aren't bilingual (systemic — a Spanish user sees English 4xx text; fix is to map
machine `code`s to `t.*` app-wide). The min-daily OT day-column reconciliation an agent
re-flagged is the same already-parked per-entry-OT-under-foot item.

**Read:** the batch-5 audit returning clean while the certified-payroll trace found five
real issues confirms the pattern — point fresh eyes at un-reviewed surfaces, not the same diff.

## 2026-07-28 — Fourth review pass — whole-path trace found new issues

This pass widened the lens (the diff-focused passes were converging): one agent on
the batch-4 diff, one tracing a worker's dollars across ALL surfaces end-to-end, one
modelling the finalize→paid→void lifecycle as a state machine. That found **five real
issues no diff-review would catch** — all fixed + verified (server 1180; client 256; build ok).

**Void could silently double-pay (most severe).** `/void` never checked for already-paid
checks, and the unique index excludes void rows — so an admin could void a *paid* run,
re-finalize the same period, and pay everyone a second time, with the original
disbursement hidden under `status='void'`. Void now refuses (409) when any check is paid,
and the UPDATE re-checks atomically (`NOT EXISTS paid`) so a check can't be paid mid-void.

**`/paid` was check-then-act (TOCTOU).** The run-status SELECT and the paid UPDATE were
separate queries; a concurrent void between them stamped paid on a voided run. The UPDATE
now re-checks run status atomically via an `EXISTS` guard.

**Worker stub disagreed with the finalized/paid net (traceability break).** The stub
recomputes grouping over a rolling 120-day window; a pair straddling that edge lost its
earlier member, so the visible check deducted on its OWN gross instead of the pair's —
e.g. stub showed net $1600 for a check the company paid $1200. The stub now generates a
padded window (180d back) so boundary groups are complete, then drops the padding from the
displayed stubs. Verified the boundary check now matches the run ($1200).

**Semimonthly/monthly still array-paired.** The batch-4 anchor-stable `seq` covered only
weekly/biweekly; calendar schedules still paired by array index, so the admin run and the
stub could pair a 15th/30th differently. Gave semimonthly (`y*24+(m-1)*2+idx`) and monthly
(`y*12+(m-1)`) an absolute `seq` too — pairing is now window-independent for every frequency,
and a semimonthly month's two checks always pair (deduct on the 30th).

**Printed pay stub omitted the guarantee line.** `printStub` added regular/OT/prevailing/
night/sick/vacation but not the weekly-guarantee top-up (the on-screen stub shows it), so a
printed stub with a guarantee didn't foot to its own gross. Added the line.

**Parked → BACKLOG:** finalize's `(company, period_from, period_to)` key would false-409 a
supplemental / partial-worker run for the same span (not a built flow yet).

## 2026-07-28 — Third (large) review pass — audit of the batch-3 fixes

Reviewed the just-committed grouped-deduction fixes (`05c7c0d`) with 5 parallel
agents. The rewrite held up (no new severe money miscalc in the single-ruleset path),
but four confirmed issues were worth fixing now. All fixed + verified; suite green
(server **1179**, +8 new tests; client 256; build ok).

**Worker stub could disagree with the finalized paycheck (pair grouping).** Pair
grouping keyed off array position, so the admin run (group window), the worker's
rolling 120-day stub, and the period dropdown (`firstWork−45d`) could pair the *same*
check differently → a different net on one surface. Fixed at the root: `generatePeriods`
now stamps an **absolute, window-independent `seq`** on weekly/biweekly checks, and
`groupPeriods` pairs by `floor(seq/2)` instead of array index. Verified the same check
pairs identically across two different windows. This also retires the parked
"offered pair boundaries depend on the window" caveat — pairing is now anchored to the
schedule.

**Deduction-line reconciliation had two edge bugs.** The cent-footing block I added in
batch 3 used a float guard (`abs(rawSum−dedTotal) >= 0.01`) that *skipped* genuine
1-cent trims, and dumped the whole rounding residual on the last line, which could go
**negative** with many sub-cent lines. Rewrote it in integer cents with largest-remainder
allocation: every line stays within `[0, its own raw]`, and the lines always foot to the
capped total. Pinned with tests (incl. the exact negative-line and skipped-cent cases).

**Finalize idempotency was check-then-act with no DB guard.** The SELECT-before-INSERT
races: two concurrent finalizes both see zero rows and both insert duplicate runs.
Added a partial unique index `(company_id, period_from, period_to) WHERE status<>'void'`
(migration `0157`, which first voids any pre-existing dupes so boot can't fail), and the
route now catches the `23505` violation as a clean 409. The SELECT stays as the friendly
fast path.

**Added tests for the money logic** that batch 3 left unpinned: `groupOpts`,
`combineGroup:false`, line reconciliation, anchor-stable pairing, and the `week_start=0`
(Sunday) work_week normalization.

**Parked → BACKLOG (money correct; policy/rare):** multi-ruleset group-window overlap
(+ the dropdown dedup cosmetic); ruleset caps trim deduction lines pro-rata on the stub
(garnishment shows reduced — a which-line-does-a-cap-attach-to policy call); WH-347
daily-rate + night_diff on the already-as-if-hourly path.

## 2026-07-28 — Second (large) review pass — grouped-deduction engine hardened

A 5-agent audit of the whole session's pay/deduction work surfaced a cluster of
money bugs in the grouped-deduction + payroll-run path. Fixed nine; the fixes are
verified by targeted harnesses and the full suite (server 1171 / client 256, green).

**Severe — the dropdown never combined grouped deductions.** Selecting a pay period
ran `from = to = payDate` (a single-day window), so a grouped ruleset only ever saw
*one* check per group — the exempt (David's "combine the pair, minus $11,000") was
applied to **every** check instead of once per group. Fix: `/payroll-periods` now
offers one entry **per group** carrying the group's whole pay-date window, and the
run spans that window. Because the window contains exactly the group's checks, the
run re-groups them identically (so pair grouping is anchor-stable *for the run*
without needing a schema change). Verified end-to-end: a biweekly pair now deducts
10% of (16000 − 11000) = **$500 once**, on the 2nd check only.

**High — grouped config read at the wrong nesting.** `groupBy`/`applyOn` live under
`deductions.group.{by,applyOn}` but the callers passed `ruleset.deductions` straight
to `groupPeriods`, which reads them flat — so **every** grouped ruleset silently fell
back to pair/second (month + first/last never took). Added `groupOpts()` to flatten
nested→flat; wired both callers (admin run + worker stub).

**High — night differential missing from certified-payroll gross.** WH-347 `gross_pay`
summed regular+prevailing+overtime but not the night premium, understating pay for any
worker with a `night_diff` rule. Now adds `nightPremiumCost` (same source as the pay
statement) on the premium-OT path.

**Medium/low, also fixed:** `combineGroup:false` was ignored (now each flagged check
figures on its own gross when combining is off); snapshot deduction *lines* were the
raw pre-cap amounts while the total was capped, so a stub's itemization didn't foot —
now scaled to the actual deducted total; finalize wasn't idempotent (double-submit
made duplicate runs) — now 409s on an existing non-void run for the same period;
`/paid` could mark a **voided** run paid and re-stamp already-paid checks — now blocked
+ `status='pending'` guarded; ruleset deduction **scope** (`selected` + picked ids) was
normalized but never read, so a restricted ruleset still applied every deduction — now
filters the company deductions (worker rows always apply) on both the admin run and the
worker stub; overnight entries showed **0h** in Team Member Report + its CSV (the span
helpers didn't wrap past midnight like `netHours`) — now wrapped.

**Parked → BACKLOG (money is correct; these are refinements/edge):** multi-ruleset
group windows can overlap when two schedules differ (clean for one ruleset); offered
pair boundaries aren't anchored to the biweekly `anchorDate`; WH-347 still uses a single
prevailing rate + flat OT on premium configs.

## 2026-07-28 — Review pass on the synthetic-entry work (2 audits) + fixes

Audited the session's pay-engine changes with two parallel review agents.

**Found + fixed — legacy pay stub crashed (severe).** `PayStubView` (the worker stub
for companies WITHOUT the Advanced/Certified Payroll add-on — the common case) mapped
statement `entries` with no `synthetic` guard, so a period with paid leave / weekly-
guarantee / floor / no-clock-in guarantee gave a synthetic row with null clock times
and `fmtTime(null).split()` threw, blanking the stub. Money was never wrong (totals come
from the summary). Added the same guard `BillPDF`/`WorkerMetrics` already had.

**Found + fixed — Certified Payroll day columns didn't foot to the regular total** when a
worked-day min-daily floor applied (my earlier premium-OT fix set `regular_total = rh`,
which includes the floor, but the day cells were summed from entries only). Now attributes
`computeOT`'s `floorDetail` to the day columns so they reconcile.

**Verified clean:** no double-count anywhere — the payroll run, overtime report, and
payroll CSV read only aggregate totals, never `.entries`; gross/net provably identical
with or without the synthetic rows; `floorDetail` captures the floor hours exactly (no
double-add across worked-day floor vs no-clock-in guarantee; multiple rules resolve to one
Math.max). Only two client renderers ever get statement entries and both guard synthetics.

**Parked (pre-existing, narrow) → BACKLOG:** per-entry OT column can under-foot summary OT
when a min-daily floor exceeds the OT threshold; and the open compliance question of
whether a min-daily floor belongs on a WH-347 at all.

**Process note:** a `git add -A` in the stub-fix commit swept 3 temporary review-harness
files into the repo — removed them in a follow-up. Be surgical with `git add` when agent
scratch files may be in the tree.

## 2026-07-28 — Rule-generated hours are now real entry rows (min-daily / no-clock-in guarantee)

**David (sharpened the rule):** *"Every time hours are added, they need to be added to
time entries first. Period."* → [[feedback_traceability]].

**The bug he hit:** a worker's report showed **Regular 12h** from a single 8h Friday
entry. Root cause (after two wrong turns — it was never a deploy issue): the company's
**"Sat — guarantee at least 4 paid hours (even without a clock-in)"** rule. Alex worked
Friday, so the engine granted **4h for Saturday with no clock-in** and added them
straight into Regular (`computeOT`: `autoReg += floor`) — **no Saturday entry existed
at all**, so 4 paid hours were completely invisible. Reproduced exactly: `regular 12,
total 12.25, cost $396`.

**Fix — materialize them as entries.** `computeOT` now returns `floorDetail` (per-day
rule-generated hours: min-daily floor top-ups + no-clock-in guarantees). `buildPayStatement`
turns each into a **synthetic entry row** (`{synthetic, kind, work_date, hours, explain}`)
appended to the statement's `entries`, sorted by date. So the Saturday 4h shows as its
own row ("Guaranteed hours (no clock-in)"), expandable to the rule. Rendered everywhere
that lists entries: Team Member Report, bill PDF, CSV. **No pay changes** — the hours
were always in `regularHours`; gross/net identical. When no floor rules apply, zero
synthetic entries (behavior unchanged; all 1171 tests green).

**Unified (same session, "the word"):** the weekly `guaranteeShortfall` and sick/
vacation leave are now synthetic entries too — `buildPayStatement` emits a
`weekly_guarantee` entry (dated period-end) and one `sick`/`vacation` entry each
(hours + cost, the leave one expandable to the per-day `LeaveDetail`). Removed their
summary-derived rows from the report + the duplicate CSV/PDF blocks. So **every** paid
hour — worked, floor, no-clock-in guarantee, weekly guarantee, leave — is now an entry
row; the summary only rolls up cost. Verified end-to-end: worked+floor+guarantee+sick+
vacation → 5 entry rows, gross reconciles exactly ($1444 in the harness), unchanged.

## 2026-07-28 — Guarantee top-up is now a traceable Time-Entries row (not a summary total)

**David (standing rule, reinforced):** everything in Team Member Reports must be
traceable — any "why is this amount X?" answerable from there, no hours folded into a
summary total without a matching clickable entry. Saved as [[feedback_traceability]].

The weekly-hours **guarantee top-up** was showing only as a PAY SUMMARY line (and on a
stale cached client, folded into "Regular 12h"). Now it's a row in **TIME ENTRIES**:
`Weekly-hours guarantee top-up · $<cost>` … `<hours>`, expandable to the rule
("Guaranteed {min}h over {weeks} wk; worked {worked} — topped up {short} × {rate} =
{cost}") + a "View setting →" link to the worker's guarantee config. Removed the
guarantee line from PAY SUMMARY so the summary never adds hours without a traceable
source; Total Hours/Cost still reconcile. CSV export gets the same top-up row.

Server already keeps `hours.regular` (worked) and `hours.guaranteeShortfall` separate,
so Regular was never actually inflated in current code — the folded "12h" was the old
cached client. Client-only change (`WorkerMetrics.jsx` + i18n).

**Follow-ups done same day** (David: "Sure"):
- **Leave (sick/vacation)** now render as traceable Time-Entries rows too (hours · cost,
  expandable to the per-day `LeaveDetail`), removed from the PAY SUMMARY. CSV export
  includes them.
- **Bill PDF** (`BillPDF.jsx`): guarantee top-up + sick/vacation are now itemized as
  rows in the entry table (hours), and their **hours** lines are removed from the
  summary — the pay breakdown stays in the totals (a bill needs its cost itemization).
  Regular in the PDF was already worked-only (never folded).
Night differential stays a summary cost line on purpose — it's a premium on hours
already counted (worked), so it adds cost, not hours.

## 2026-07-28 — Certified Payroll dropped overtime under premium OT policies

**David:** Certified Payroll and a worker's Team Member Report disagreed for the same
week — and the report's total (12h15m) didn't match its one visible entry (8h45m).

Traced both engines (subagent). Findings:

- **8h45m vs 8h15m is not a bug.** Both pay paths subtract the 30-min break once →
  8.25h worked. The entry row just displays raw elapsed (8h45m); the pay math uses 8.25h.
- **The 12h15m is a `guaranteed_weekly_hours` top-up** (~4h) on top of 8.25h worked.
  The server keeps it separate (`hours.regular` vs `hours.guaranteeShortfall`) and the
  **current** Team Member UI already shows it as its own "Minimum guarantee" line
  ([WorkerMetrics.jsx:368]). The screenshot showing it folded into "Regular 12h" is a
  **stale cached client** — nothing to fix server-side; a hard refresh shows the split.
- **Real bug — Certified Payroll's `computeWorker` dropped overtime entirely** whenever
  the company's `hours_rules` isn't a "simple" OT config (`hasSimpleOtConfig` false →
  tiers / rest-day / night / min-daily). Its premium branch summed flat hours with
  **zero OT**, so the WH-347 understated OT hours and gross (Alex: $264 instead of $268;
  0 OT instead of 15m). Every other surface (pay statement, project bill) runs the real
  OT engine.

**Fix:** the premium branch now uses the same engine as the project bill /
buildPayStatement — `computeOT` + `annotateEntryOvertime` + `otBandsCost` on the
regular entries (prevailing stays flat), bucketing the per-entry OT into the day
columns. So the WH-347 shows the same regular/OT split and gross the rest of payroll
does. (Only affected companies with a premium hours-rules policy; simple/absent configs
already went through `splitRateAware` and were correct.)

## 2026-07-28 — Certified Payroll counted unapproved hours (inconsistent with all other pay)

**David:** the Certified Payroll report showed Marcus Chen 8h 15m / $297 for the
week, but his Team Member Report for the same range showed "No entries."

**Root cause:** every pay surface — worker reports, invoices, payroll run, pay stubs
(`workerStatement`/`companyStatements`) — filters `time_entries.status = 'approved'`,
and new entries are created **pending**. The `GET /admin/certified-payroll` query was
the **only** one with no status filter, so it counted pending (unapproved) hours that
appear nowhere else. Marcus's entry was pending → on the WH-347, not on his report.

**Fix:** added `te.status = 'approved'` to the certified-payroll query. A signed
WH-347 certifies hours actually paid; it should never include unvetted hours, and it
now matches the rest of payroll. Practical effect on the demo (all-pending entries):
certified payroll now reads empty until entries are approved — which is correct and
consistent with the worker report, instead of the two silently disagreeing.

## 2026-07-28 — Payroll run: selectable pay-period basis (fix "period ends on payday")

**David:** for an every-other-Thursday payday (Jul 16), the period showed Fri Jul 3 –
Thu Jul 16 — he didn't think a check should pay *through* its own payday. Right: the
biweekly engine defined the period as the 14 days **ending on** the payday, with no
notion of a processing lag or work-week alignment. He wanted all three real-world
models selectable, defaulting to the work-week one.

Added `schedule.periodBasis` to the ruleset (weekly/biweekly; semimonthly/monthly are
calendar spans and ignore it):
- **`work_week`** (new default) — full work week(s) ending on the last work-week-end
  **before** payday, using the company `week_start`. Jul 16 → **Jun 29 – Jul 12**.
  Aligns pay periods with the same week boundary overtime already uses; pays in arrears.
- **`prior_cycle`** — the previous completed cycle. Jul 16 → Jun 19 – Jul 2.
- **`on_payday`** — the old behavior (period ends on payday).

Engine work in `server/utils/payPeriods.js`: a `periodBounds(payday, span, basis,
weekStart)` helper the frequencies share, `weekStart` threaded from settings through
every `generatePeriods` caller (admin run, period list, notice probe, worker stubs).

**Two correctness things fixed along the way:**
- **Inclusion is now by the ACTUAL (weekend-shifted) pay date**, not the raw payday.
  This is what makes the dropdown's single-pay-date window (`from=to=payDate`) isolate
  exactly one check even under a weekend shift and arrears basis. The run resolves each
  check's real period from the schedule, so the window is just a pay-date bracket.
- **Finalize now records the real pay-period span** (min/max of the checks' periods),
  not the query window — otherwise an arrears run would store a one-day "period."

Default flips existing biweekly rulesets to `work_week`, so numbers shift to the
correct two weeks — intended. `docs/db-enums.md` updated; +3 payPeriods tests
(work_week, prior_cycle, shifted-inclusion). Editor gets a "Pay period covers" dropdown.

## 2026-07-28 — Payroll run: pay-period dropdown replaces the raw date range

**David's point:** if payroll has set periods, why ask for an arbitrary date range?
Right — the range was the wrong control and the source of the pay-date-in-window
confusion from earlier today.

**What shipped:** the Payroll tab now leads with a **Pay period** dropdown built from
the ruleset schedule(s), newest first, and auto-selects + loads the latest on open.
New `GET /admin/payroll-periods` derives the real periods server-side (only place that
knows the schedule math), unions across rulesets, dedupes by pay date + period, caps
at 60, no future periods. Picking one sets the range to that period and runs. A
"Use a custom date range instead" toggle keeps the old two-date inputs for the cases
that need them (grouped deductions spanning a month, odd reconciliations); companies
with no rulesets fall straight to the range.

**Also fixed a mislabel the screenshot exposed:** workers on an *unnamed* ruleset
showed "No ruleset" — identical to the genuinely-null case. Rows now carry
`has_ruleset`, so an unnamed-but-real ruleset reads "Unnamed ruleset". (Nudge: name
your rulesets — the dropdown/label lean on it.)

**Caveat I made a call on:** with multiple *different* pay schedules there's no single
global period list. I union them into one dropdown labeled by date — clean for the
common single-schedule shop, and for multi-schedule the earlier `notices` explain any
worker whose schedule has no check in the picked period. If multi-schedule becomes
common, the next step is scoping the dropdown per schedule. Parked in BACKLOG next to
the pay-date-vs-work-period note.

## 2026-07-28 — Payroll run "no workers with pay" was a misdiagnosis

**Symptom (David):** ran payroll for a period workers clearly worked, got "No
workers with pay in this period."

**Root cause:** the run resolves each worker's ruleset, then asks the ruleset's
*schedule* for the paychecks whose **pay date** lands in [from, to]. When that set is
empty, no rows — and the message blamed "no pay" when the real cause is the
schedule. Two ways a ready worker yields zero periods:
- **Incomplete schedule** → the ruleset *never* issues a check. Biggest trap: a
  **biweekly ruleset with no anchor date** (`payPeriods.biweekly` returns [] without
  one), and biweekly is the *default* frequency, so a half-configured ruleset is
  silently inert. Same for semimonthly with no pay days.
- **Pay date outside the range** → e.g. a monthly/month-end pay date past a `to` of
  the 28th. The work is in-window but the *paycheck* isn't.

**Fix — make the run explain itself.** `computePayrollRun` now returns a `notices[]`:
for each ruleset that resolved workers but issued nothing, it probes a wide (±400d)
window to tell the two cases apart and tags `schedule_incomplete` vs `out_of_range`.
The Payroll tab renders an amber panel naming the ruleset and what to do (fix the
schedule vs widen the dates) instead of the flat "no pay." Also added an inline
"set an anchor date" warning in the Paycheck Rules editor so a biweekly ruleset
can't look configured while being inert.

**Judgment call / finding:** the run is keyed on **pay date in window**, but the
inputs read "PERIOD FROM/TO" and users think in *work* period. That mismatch is the
real UX sharp edge (the footnote about "cover whole groups" was papering over it).
I kept the pay-date model (David's design — grouped deductions need real pay dates)
but the notices now make the mismatch legible. If it keeps biting, the deeper
options are: (a) resolve periods by work overlap instead of pay-date containment, or
(b) auto-suggest a range that snaps to whole pay groups. Parked as a design note.

## 2026-07-28 — Billing bug: Business checkout overcharged for extra workers ⚠️

**Symptom (David):** buying Business with extra members shows the right price in
the app but a higher one on Stripe. Example: 28 team members → app says $610/yr,
Stripe checkout said **$910/yr**.

**Root cause:** `client/src/components/BillingPanel.jsx` sent the per-worker Stripe
line item a quantity of `workerCount` (the *full* team size, 28) instead of the
overage beyond the 15 included in the base plan (28 − 15 = **13**). The base price
already bundles 15 seats, so Stripe billed 15 twice: base ($350, incl. 15) + 28
extra × $20 = $910. Correct is base + 13 × $20 = $610. The *display* math was right
all along (it used `businessOverage`); only the two checkout calls used the raw
count. The server (`/stripe/checkout`) just passes `worker_count` through as the
quantity — its contract is "extras only", which the client was violating.

**Fix:** both checkout call sites now send `businessOverage` (= max(0, workerCount
− INCLUDED_WORKERS)). Hoisted `INCLUDED_WORKERS = 15` to module scope with a comment
tying it to the seats built into `STRIPE_PRICE_BUSINESS_BASE`, and moved the
`businessOverage` computation up next to the state so the earlier `subscribeSelectedPlan`
handler shares the one value (no duplicated formula, no use-before-declare).

⚠️ **Remediation — check existing subs.** Anyone who bought Business-with-extras
through this flow *before* today was overcharged (billed for total workers, not
extras). Worth auditing Stripe for business subscriptions where the Additional
Worker quantity equals total team size instead of team−15, and correcting/crediting.

⚠️ **Note:** `INCLUDED_WORKERS = 15` is a client constant that must stay in lockstep
with whatever seat count is baked into the Stripe base price. If that base ever
changes, this constant has to change with it — the server has no notion of "included
workers" to cross-check against. Candidate to move into the `/stripe/plans` payload
later so there's one source of truth. Parked in BACKLOG.

## 2026-07-27 — Payroll run: CSV export + finalize/record a run

The Payroll tab could compute a run live but couldn't *do* anything with it. Two
pieces, bundled:

- **CSV export** — a "Download CSV" button on the live register writes one row per
  check (pay date, worker, role, ruleset, period, regular/OT/prevailing hrs,
  gross/deductions/net) for a payroll processor. Client-only, no server round-trip.
- **Finalize/record** — "Finalize run" snapshots the live register into two new
  tables (`payroll_runs` + `payroll_run_checks`, migration `0156`, money in CENTS).
  A finalized run *stops recomputing* — it's a locked record of what was paid, so a
  later time-entry or rule edit doesn't retroactively change a run you already cut
  checks for. Each check carries a `detail` JSONB stub snapshot so its pay stub
  renders exactly as finalized. New **Finalized runs** panel below the register:
  expand a run → checks, mark one/all paid, or void the whole run.

Findings / calls:

- **Refactored, didn't duplicate.** The live `GET /payroll-run` handler became a
  pure `computePayrollRun(companyId, from, to)` helper; the GET route and the new
  `POST /payroll-run/finalize` both call it, so the finalize snapshot is *exactly*
  what the register showed — no second code path to drift.
- **Finalize refuses on setup errors.** If any worker still has the 0-or-many
  ruleset flag, finalize 400s with `code:'setup_errors'` rather than recording a
  partial/guessed run — same never-guess rule as the live register.
- **Gate reuse.** All routes sit behind `requireCertifiedPayrollAddon` (which is the
  Advanced Payroll gate post-`0155`) — no new middleware, so no test-mock churn.
- **No new tests.** The routes are thin DB wrappers over the already-tested
  `computePayrollRun`; the two status columns are CHECK-constrained (`0156` +
  `docs/db-enums.md`). Verify stays green at 1168 server / 256 client. ⚠️ If you want
  belt-and-suspenders coverage on the finalize→paid→void lifecycle, that's a good
  follow-up but needs the DB-mock harness the other admin route tests use.

## 2026-07-26 — Rate-aware overtime: the WH-347 / certified payroll (increment 4)

The compliance form now shows real overtime. End-to-end:

- **Server** (`GET /admin/certified-payroll`): collects each worker's rounded
  entries and runs them through `splitRateAware` (gated on `hasSimpleOtConfig`;
  premium configs keep the flat fallback) for a per-day **straight/overtime split**
  by wage type, OT-aware costs, and an OT-aware `gross_pay`. Response gained
  `ot_days`, `overtime_total`, `regular_cost`/`prevailing_cost`/`overtime_cost`,
  `overtime_multiplier`. Added `u.overtime_rule` to the query.
- **Client** `CertifiedPayroll.jsx`: on-screen table + the print view now render a
  combined **Overtime** row and read the server-computed costs instead of
  recomputing `hours × rate` flat.
- **`CertifiedPayrollPDF.jsx`**: the WH-347 "O" sub-row (previously left blank with
  a TODO) is populated with the per-day OT hours + OT total; the "S" row shows
  straight-time and the full gross; the rate column shows the prevailing rate when
  the worker has prevailing hours.
- **i18n**: `overtime` key added (EN "Overtime" / ES "Horas Extra"); parity test green.

Full `npm run verify` green (server 1113 + client eslint/vitest/i18n/build). No
bespoke certified-payroll route test — the math is the already-tested
`splitRateAware`; the endpoint just buckets it.

Remaining from the plan: the client-side **WorkerSummary "estimated pay"** preview
(labeled an estimate; lowest priority), the cosmetic OT-multiplier **labels** on
BillPDF/ProjectBillPDF, and a **settings toggle** for `overtime_rate_method`.

---

## 2026-07-26 — Rate-aware overtime: consolidate project-bill + qbo (increment 3)

Closed the two server-money engines the audit flagged as diverging from the new
`buildPayStatement`. Extracted `splitRateAware` (calculator + the regular/overtime/
prevailing bucket split) so the math isn't written three times; refactored
`buildPayStatement` onto it (equivalent, suite green).

- **Project bill** (`GET /projects/:id/bill`): each worker's hours (regular +
  prevailing at the project rate) go through the shared engine now, gated on
  `hasSimpleOtConfig`. The project total agrees with the worker invoice.
- **qbo `computeGroupOvertime`**: all worked hours (incl. prevailing) count toward
  the OT threshold, so a prevailing-heavy week earns the OT premium in the QBO
  push. QBO bills labor flat at the worker rate (it doesn't apply prevailing
  *rates* — separate pre-existing gap), so OT is priced at that rate. Tiered
  configs keep the `otBands` path. 1113 pass.

**Stopped at a checkpoint before the WH-347.** Certified payroll is not a drop-in
like the other two — its client (`CertifiedPayroll.jsx`/`CertifiedPayrollPDF.jsx`)
recomputes cost flat and renders the compliance grid, so it needs server compute
**plus** the per-day O/S rows + PDF + EN/ES i18n. Deferred as its own focused piece
rather than rush a legal form (spec: `certified-payroll-ot.md`). The client
`WorkerSummary` estimate is the other remaining item (lowest priority). Both are
tracked in `rate-aware-overtime.md` build-order step 3.

---

## 2026-07-26 — Rate-aware overtime: wired into buildPayStatement (increment 2)

The calculator now drives real pay. `buildPayStatement` routes through
`rateAwarePay` when the config is plain single-multiplier OT and the worker is
hourly (`hasSimpleOtConfig` gate); premium configs (tiers/rest-day/7th-day/window/
night) and daily-rate workers keep the existing per-band path untouched.

- **Prevailing/multi-rate hours now earn OT** on the four surfaces that read the
  shared statement — worker invoice, payroll CSV, pay stub, overtime report — for
  free (they read `cost.*`, confirmed by a consumer audit).
- **No regression:** regular-only and prevailing-under-threshold are byte-identical
  (whole suite green). The ONE test that changed is the intended fix — 10h
  prevailing @ $50 now reads 8h ST ($400) + 2h OT ($150) instead of 10h flat
  ($500). Added the excavator scenario-A reconcile test at the statement level
  ($420). 1113 pass.
- The three cost buckets always sum to the calculator's total (`overtime` absorbs
  all OT pay incl. any blended premium), so gross reconciles by construction.

⚠️ **Known dev-only gap (tracked):** a consumer audit found **4 duplicate engines**
that never went through `buildPayStatement` and still pay prevailing flat, so they
now disagree with the invoice: the project-bill route (`admin.js` ~1710), `qbo.js`
`computeGroupOvertime` (~796), certified-payroll/WH-347 (`admin.js` ~3457), and the
client-side *estimate* `WorkerSummary.jsx:108`. Consolidating those onto the shared
statement is the next increment (build-order step 3 in the plan). Nothing hits a
real paycheck until David merges to prod.

---

## 2026-07-27 — Payroll: worker self-service stub rewired to the ruleset engine

The worker's own pay stub (Account page) now uses the **same engine** as the admin
run when the company has Advanced Payroll and the worker's role maps to exactly one
ruleset: `/time-entries/pay-stubs` generates the worker's pay periods from their
ruleset (last ~120 days), prices each via `workerStatement`, and runs the group
combine → exempt → deduct math — returning `{mode:'ruleset', stubs:[…]}` (per check),
which `PayStubView` renders with the shared `PayStub` component. Everything else
(no add-on, no/ambiguous ruleset) falls through to the **unchanged legacy**
company-pay-period stub (still a bare array), so nothing regresses. Worker and admin
now see identical numbers. 1168 pass.

## 2026-07-27 — Payroll: pay stubs from the run (itemized, printable)

Turned the register from net figures into actual **pay stubs**. `applyGroupDeductions`
now returns the itemized `lines` + `exempt`/`combinedGross`; the run endpoint keeps
each period's full statement so every check row carries its **hours/cost breakdown**
+ **itemized deduction lines**. New reusable `PayStub.jsx` renders one stub —
earnings (regular/OT/prevailing/night/leave), gross, each deduction line (with a "on
the group total − exempt" note when combined), net — plus a clean **print** window.
In the Payroll tab, each register row now **expands to its stub**. Bilingual. 1168 pass.

## 2026-07-27 — Payroll: pay-period generation + multi-check combining (the $11k case)

The run now does the real thing — David's signature case computes exactly.
`server/utils/payPeriods.js` (pure, UTC-deterministic, 10 tests) turns a ruleset's
**schedule** into the paychecks it issues in a window: weekly, **biweekly from an
anchor** (every other Thursday), **semimonthly** (15th & 30th, "30" clamping to the
last day of short months), monthly ("last"), with a **weekend shift**. `groupPeriods`
groups them (pair / calendar month) and flags which check the deductions land on
(first/second/last).

The run endpoint (`/admin/payroll-run`) now: resolves each worker's ruleset from
role (0/>1 still a flagged setup error), **generates their pay periods** in [from,to],
fetches gross **per period** (one `companyStatements` per distinct range), then
`applyGroupDeductions` (paycheckRun.js) **combines each group's gross, subtracts the
exempt ONCE, and deducts on the flagged check** — `computeRuleNet` grew a `baseGross`
arg so the deduction base is the group total while the net comes off each check's own
gross. Register is one row per (worker, check), sorted by pay date; `PayrollRun.jsx`
gained Pay-date + Period columns. New tests pin the combine ("two $6k checks, $11k
exempt, deduct on the 2nd → 10% of $1,000 on check 2"). 1168 pass.

## 2026-07-27 — PDF toolkit: add images as pages + choose the download name

- **Images → pages.** The file picker + drop now accept **JPG/PNG**; each image
  becomes a one-page source that flows through the same grid (thumbnail, reorder,
  rotate, delete, extract, full-size view) as PDF pages. `buildPdf` embeds images via
  pdf-lib `embedJpg/embedPng`, sized to the picture, with a **canvas re-encode
  fallback** for a mislabeled/unusual format. Sources are now tagged `kind: 'pdf' |
  'image'`; the thumbnail, viewer, and build paths branch on it.
- **Choose the output name.** A filename box in the toolbar (seeded from the source
  name / "combined", never clobbering a typed value) drives both Download and Extract;
  `outName()` sanitizes it and appends `.pdf`.

Self-contained in the tool-app (app.js + index.html); no `?v` (SW precache revisions
it). 1156 pass.

## 2026-07-27 — PDF toolkit: export no longer crashes on odd PDFs + full-size viewer

**Bug** ("expected instance of e, but got undefined" on download/export): traced to
pdf-lib. The clean-PDF path is fine (verified in node against the actual
`pdf-lib.min.js`), so it's PDF-specific — a page that pdf.js renders but pdf-lib's
object copier can't copy (dangling ref / protection) hit an internal instance
assertion and sank the whole export. Fix: `buildPdf` now copies each page in its own
try/catch and, when a page can't be copied, **falls back to rasterizing it via pdf.js**
(the renderer that already drew the thumbnail) and embedding the image — so the
download always succeeds. Loads with `throwOnInvalidObject:false`; a missing source or
truly unusable page is counted, and the toast reports exactly what happened
("Saved … N couldn't be copied and were saved as images"). No more cryptic crash.

**Feature:** click any page thumbnail to open it **full size** in an overlay (pdf.js
rendered to fit the viewport, honoring the page's rotation; click-away / ✕ / Esc to
close). Self-contained in `app.js` (no index.html/CSS change). pdftools isn't on the
`?v` scheme — the SW precache revisions it and the update-check banner prompts a
reload. 1156 pass.

The pay engine's first run. `server/utils/paycheckRun.js` (pure, 12 tests) +
`GET /admin/payroll-run` + `PayrollRun.jsx` (the centerpiece of the Payroll tab):
pick a period, and each worker's Paycheck ruleset is resolved **from their role**.

- **Tie-breaker (David's call):** a role that matches **zero or more than one**
  ruleset — or a worker with **no role** — is a **flagged setup error**, listed
  prominently ("N workers need setup…") and excluded from the register. Never a
  silent guess. (`resolveRuleset` → `{ruleset}` | `{error}`.)
- **Money math:** gross comes from the existing pay-statement engine
  (`companyStatements`); deductions = company-wide + the worker's **role-scoped** +
  their **personal** rows, run through the ruleset's **exempt → deduct → cap →
  min-net** (`computeRuleNet`, in dollars to match the statement engine; ruleset
  cents ÷ 100 on the way in). Register shows gross · deductions · net + totals.
- Gated on Advanced Payroll (via the `requireCertifiedPayrollAddon` alias — same
  gate, already in every test mock, so no churn).

**Scope (stated in the UI):** computes the selected period as ONE check. A ruleset's
`combineGroup` (sum a pair/month of checks before the exempt, deduct on one) needs
generated pay periods from the schedule — the next increment. 1156 pass.

Each Role Rules section covered exactly one role (a single `<select>`). Made it
cover **multiple roles**: `roleRules[].roleId` (single) → `roleIds` (array), with a
chip multi-select mirroring Paycheck Rules / role deductions. Roles claimed by
another section render disabled (a role stays in at most one section so its
effective rule list is unambiguous); the builder title joins the selected role
names. Legacy single `roleId` is still accepted and folded into `roleIds`
everywhere (server `parseRoleRules` + `effectiveRulesForRole`, client
`policyToForm`/`formToPolicy`), so existing saved policies round-trip untouched;
`effectiveRulesForRole` now matches `roleIds.includes(workerRoleId)`. Renamed the
picker label Role → Roles, added a "used elsewhere" tooltip (EN+ES). Updated the
role-rules tests (output is `roleIds`; added multi-role parse + match cases) and
the db-enums note. 1144 pass.

The link that turns Paycheck Rules into an actual payroll run is **role**, per
David. Two pieces (config/storage; the pay engine that consumes them is still later):

- **Rulesets select the roles they apply to.** Each ruleset carries `roles: []`
  (role ids). Builder: a chip multi-select of the company's roles (fetched from
  `GET /admin/roles`, same as HoursRules), and the summary line now leads with the
  role names (or "No roles"). A worker will get their ruleset from their role.
- **Role deductions in Payroll Deductions.** Each deduction carries an optional
  `roleIds: []` — **empty = all employees** (the original company-wide behavior),
  non-empty = only workers in those roles. `DeductionListEditor` grew an opt-in
  "Applies to" chip row (All employees / roles), enabled by a new `roles` prop —
  omitted in the per-worker context (those are already worker-scoped). `normalize
  Deduction` now preserves `roleIds` (de-duped, primitives only); the per-worker PUT
  route maps fixed fields so the unused `roleIds` is harmlessly ignored there.

Both normalizers keep the fields as-is (role ids may be int or uuid), de-dupe, and
cap the array. EN+ES i18n; db-enums updated for both shapes; tests pin the role
normalization on rulesets + deductions. 1142 pass.

Packaged the advanced payroll stuff behind a paid add-on, **Advanced Payroll**, per
David's call. Free (base plan) in Reports: the hours register (regular/OT/prevailing)
+ timesheet export — **moved the OT report + export back to Reports** (undoing that
part of the previous Payroll-tab commit). Paid (Advanced Payroll): the Payroll tab
(WH-347 / certified payroll), and the Paycheck Rules settings section. Certified
payroll is **folded in** — WH-347 was its own superadmin-only add-on; no one had
purchased it, so it collapses into Advanced Payroll.

Entitlement plumbing (`addon_advanced_payroll`, the "N places"):
- Migration 0155: new boolean column, backfilled from `addon_certified_payroll`.
- `auth.js buildSessionUser`: SELECT + surface it on the session user.
- `middleware/auth.js`: `requireCertifiedPayrollAddon` now OR-gates on
  `addon_advanced_payroll || addon_certified_payroll` (kept the export name so the
  ~25 test mocks + route refs don't churn; added a `requireAdvancedPayrollAddon`
  alias). Error code → `advanced_payroll_required`.
- `usePlan()`: `hasAdvancedPayroll`; `hasCertifiedPayroll` now aliases it (certified
  is a capability of advanced), so existing cp_* gates keep working.
- Superadmin: PATCH plumbing + list SELECTs + the toggle relabeled "Advanced
  Payroll add-on" (writes the new flag).
- `UpgradePrompt` learns `advanced_payroll`; Payroll tab shows it when off; Paycheck
  Rules section shows an upsell when off. EN+ES i18n.

Fixed a latent bug along the way: the WH-347 panel gated on `hasQbo` (wrong) — now
`hasAdvancedPayroll`. Superadmin-toggleable now; **Stripe self-serve is a follow-up**
(model on takeoff). Paycheck Rules save is client-gated for now (inert without the
engine). 1140 pass, i18n parity, build clean.

Added a **Payroll** tab to Time Clock ▸ Workforce (`WorkforcePanel` in
AdminDashboard.jsx), between Reports and Time Off, gated on the same `view_reports`
permission. Rather than invent new surfaces, it collects the three payroll tools
that were buried as collapsible sections inside the Reports tab and **moves** them
here (no duplication): the **Overtime / payroll register** (per-worker hours + net
pay), **Certified Payroll** (WH-347), and the **Payroll export** (CSV for the
payroll processor). Reports now stays focused on worker + project analytics.

Kept the existing plan gates (OT/export → Starter, certified payroll → QBO) and the
collapsible-section pattern + localStorage keys, so nothing regresses. Relabeled the
certified-payroll section header from "Payroll" → **"Certified Payroll"**
(`certifiedPayrollLabel`) so it doesn't clash with the tab name. Added a short intro
line with a link to Administration ▸ Workspace (where Paycheck Rules + Deductions
live). New i18n: `tabPayroll`, `payrollTabIntro`, `payrollTabConfigure`,
`certifiedPayrollLabel` (EN+ES, parity green). 1140 pass.

Built a **Paycheck Rules** section (Administration ▸ Workspace, beside Hours & Rules
/ Deductions), modeled on the Deductions/Hours-rules pattern. Admins build named
**rulesets**; each has a pay **schedule** (weekly / biweekly / semi-monthly /
monthly — with pay weekday + anchor date for biweekly, two days-of-month for
semi-monthly, day-of-month/last for monthly, and a weekend-shift) and a
**deductions** block (timing every/grouped; group by pair or calendar month; apply
to first/second/last check; combine the group; an **exempt amount** subtracted
before deducting; an optional cap by amount or percent; a min-net floor; scope
all/selected deductions). David's two examples drop out as **presets**: "Every other
Thursday" (biweekly, grouped by pair, apply second, combine, exempt $11k) and "15th
& 30th" (semi-monthly, grouped by month, apply last, combine, exempt $11k).

Scope this phase = builder + storage only. Assigning rulesets to employee types and
the actual pay-engine math are explicitly **later** (documented in
`docs/plans/paycheck-rules.md`).

Pieces: `server/constants/paycheckRuleEnums.js` (frozen enum sets +
`normalizePaycheckRules` that clamps every field on read, never throws — same
posture as `hoursRules.parsePolicy`); new `paycheck_rules` string setting
(settingsDefaults `STRING_KEYS`/defaults, the duplicate PATCH allowlist in
`admin.js`, and a shape+size validation block — the two-allowlist gotcha the
architecture map flagged); `PaycheckRulesSettings.jsx` (list + add/duplicate/delete,
per-ruleset editor with conditional fields, plain-English summary, presets, dollar
inputs ↔ cents); mounted in AdministrationPage under the existing `manage_settings`
gate; EN+ES i18n (`pcr*`, parity test green); `docs/db-enums.md` row for every
fixed-value field. Normalizer tests pin the clamping. 1140 pass.

The real reason the takeoff fixes "weren't there": the installed PWA tool window
kept running the old build. Confirmed the cause — the built SW precache manifest
includes `tool-apps/planroom/{app.js,index.html}` (0.43 MiB app.js, well under the
5 MiB cap), so the root service worker serves the tool FROM precache. An open tool
window has no update signal (the main app has UpdatePrompt via version.json polling;
the static tool-apps had nothing), so after a deploy it silently stayed on the old
version until a manual hard-refresh.

Added `tool-apps/shared/update-check.js` (loaded by planroom/index.html; reusable by
the other tool-apps). Because the tool is served from the precache, the SW lifecycle
is the accurate signal: it nudges `registration.update()` on load / every 10 min /
on focus, and when a newer worker takes control (`controllerchange`, guarded against
the first-install case) shows a dismissible "A new version is available — Reload"
banner. The reload loads the freshly-precached build (sw.js is served max-age=0, so
new workers propagate; skipWaiting + clients.claim make the new precache active).

Bootstrap caveat: existing installs still on the old index.html don't reference the
new script yet, so they need ONE manual refresh to land on this version; every
deploy after that prompts automatically. Verified the built sw.js precaches the new
script. 1131 pass.

Follow-up: wired the same script into `pdftools/index.html` too (also precached —
same staleness gap), so every tool-app now surfaces the reload prompt.

---

## 2026-07-27 — Takeoff: click the start point to close a LINE into a loop

David couldn't join the ends of a line takeoff and wondered if closing only got
built for areas. It hadn't only been built for areas — a `qline` is a reshapeable
open poly, and closing a line into a loop was already possible via **Shift+Enter**
while drawing or the **Select ▸ Edit ▸ Join** op after. But the *natural* gesture —
clicking the start point to close, the way every polygon tool works — was blocked:
`tryDraftJoin` had `if (k <= 0 …) return`, silently ignoring a click on the start
vertex. Areas felt different only because they finish as closed polygons on
double-click; lines finish open, so the missing start-click left no obvious closer.

Allowed `tryDraftJoin` to close to the start (k===0, ≥3 points) — clicking the
first point now closes any drawing polyline (line or area) into a loop. Also
reworded the line-drawing hint to say so. The `qlineLenFt` perimeter includes the
closing segment, as expected for a loop. Cache-bust v78→v79.

---

## 2026-07-27 — Terms gate re-prompting every load: stale cached user

The EULA/Privacy clickwrap kept re-appearing after accepting. Server side is
correct — `/accept-terms` writes a `legal_acceptances` row (user_id + LEGAL_VERSION)
and `buildSessionUser` gates `needs_terms` on it, so login and `/auth/me` reflect a
saved acceptance. The bug was client-side: `AuthContext.updateUser` mutated only
React state and never wrote the merged user back to the `tc_user` cache. So
`TermsGate`'s `updateUser({needs_terms:false})` cleared the flag in memory but the
cache still held `needs_terms:true` — and the bootstrap paths that read the cache
instead of a live `/auth/me` (offline, or an `/auth/me` timeout/failure — common for
a PWA where `navigator.onLine` is unreliable) resurrected the gate on the next load.

Fix: `updateUser` now persists the merged user to the active token store
(sessionStorage for impersonation tabs, else localStorage). Once accepted, the
cache agrees with the DB, so no bootstrap path re-shows the gate. Online `/auth/me`
stays authoritative — the fix doesn't mask a real server state, it just stops the
stale cache from overriding an accepted one. Test pins that a cleared `needs_terms`
is written to `tc_user`. The intended "ask once per account, saved in the DB, unless
the version bumps" behavior now actually holds.

---

## 2026-07-27 — Takeoff: `deduct` no longer carries to the next area

Drawing an area takeoff and checking "deduct" (mark the shape a void) made the NEXT
new area default to deduct too. Cause: the whole cfg — including `deduct` — is
stashed in `lastAreaCfg` and used to pre-fill the next area (a real convenience for
label/mode/color). `deduct` is a per-shape property, not a default, so it shouldn't
ride along. Added `rememberAreaCfg(cfg)` (strips `deduct` before storing) and routed
all four `lastAreaCfg =` sites through it. The shape's own stored cfg keeps its real
deduct; editing an existing shape still pre-fills from that shape's cfg, so its
deduct state is preserved there. Bumped planroom cache-bust v77→v78.

---

## 2026-07-27 — Username uniqueness: global → per-company (the real multi-tenant fix)

Chased down the demo-seed "skipped 8 workers due to username collision with another
company" warning. It was NOT colliding with real customers — those names are
demo-only. The data settled it: exactly one "Demo Operations" tenant (the nightly
public demo) and a SEPARATE exempt tenant "OpsFloa Demo Workspace" that already
holds all 8 worker usernames. They collided purely because `users.username` carried
a GLOBAL `UNIQUE` (schema.sql: `username VARCHAR(100) UNIQUE`), even though the app
is per-company everywhere else — login is `WHERE (username|email)=$1 AND
company_id=$3`, and every conflict check scopes by company_id. So the DB constraint
was stricter than the tenancy model: two companies couldn't both have a
"leo.martinez", or even both have an "Admin". **No data leaked** — full isolation
on company_id holds — but one tenant's username choices silently constrained
another's, and the demo seed was the visible casualty.

Fixed at the root — migration **0154**: drop the global constraint (resolved by
SHAPE via pg_constraint, not by hard-coded name, so it's environment-agnostic) and
add `UNIQUE (company_id, username)`. Existing rows are already globally unique, so
none violate the per-company index — no cleanup. Updated the two spots that assumed
global uniqueness:
- `admin.js` worker-edit conflict check — added `company_id` (a name used only in
  another tenant must not block this one).
- Seed: `ensureDemoAdmin` scoped to the company + dropped its cross-company throw;
  removed the worker-loop global pre-check/skip that was the *actual* cause of the
  missing crew. (That pre-check existed because the seed runs in ONE transaction —
  a failed INSERT can't be caught mid-transaction — so they pre-checked instead.
  Per-company uniqueness makes the whole dance unnecessary.)

Audited every username touchpoint: all others key on id / invite_token /
reset_token or already include company_id. Test: worker-edit conflict check is
company-scoped. 1131 pass; migration static-lint passes (fresh-apply needs a DB → CI).

Rollout: the dev server deploy applies 0154 to the dev DB; the nightly seed (runs
from `main`) then seeds the full crew once dev→main is merged. Touches prod's user
model on the next main deploy — strictly a LOOSENING (per-company vs global), and no
existing row violates it.

---

## 2026-07-27 — Fix demo-seed crash: RFI upsert key didn't match the unique index

CI "Seed Demo Operations" failed on `duplicate key value violates unique constraint
"idx_rfis_company_number"`. Root cause: `upsertBy` does SELECT-by-key → INSERT-if-
missing, and the RFI call keyed on `(company_id, project_id, rfi_number)` while the
index is only `(company_id, rfi_number)`. The seed reuses the DB across runs (the
"wipe" step clears storage, not rows), so when a reseed shifts `projectByIndex(i)`
to a different project, the SELECT misses the stale RFI and the INSERT collides on
the index. Fixed by keying on exactly the constraint columns and moving `project_id`
into the updated values — now idempotent regardless of the project mapping.

Audited the sibling numbered tables (estimates / subcontract_pos / change_orders /
submittals) against their real constraints — all aligned; RFIs were the only
desync. (`ensureBy` merges key+values on insert, so project_id still lands on the
create path.)

Not fixed (separate, non-fatal): the "skipped 8 demo users due to username
collision with another company" warning — those demo usernames already exist under
another company and global username uniqueness blocks reuse. The seed degrades
gracefully (warns, continues); it did NOT cause the exit-1. Left for a decision on
whether to namespace demo usernames or clear the colliding accounts.

---

## 2026-07-26 — Traceability: close the last two gaps (OT multiplier + night everywhere)

Followed the night-differential breakout by closing the two follow-ups it left.

**Gap 1 — the multiplier each OT hour was paid at.** The overtime line showed a
lump sum + a *reason* (rest-day / override / tier), but never the rate. Added
`hours.overtimeBands` to the statement — OT hours grouped by the multiplier they
earned (`[{mult, hours}]`, highest first), from `ot.otBands` on the per-band path
and a single `otMult` band on the rate-aware path. The worker-invoice line now
expands to "2h at 2×, 3h at 1.5×", so a 2× rest-day or a tiered band (or the manual
2× override in the Leo bill) is visible instead of folded into one figure.

**Gap 2 — night differential across the other engines.** Two things, one of them a
real bug:
- **project-bill route** folded night into overtime AND summed buckets for its
  total — broke it into its own `night_cost` bucket (added to the total), matching
  the worker invoice.
- **QBO billing OMITTED night entirely** (total = labor + OT premium + reimb, no
  night term) — a *latent underpayment*: a night-shift company's QuickBooks bill was
  short by the night premium on every push. `computeGroupOvertime` now returns
  `nightHours`/`nightPremium`; the preview total includes it and the push emits a
  dedicated "Night differential premium" line. Tests pin both.

Display: night now shows on the invoice PDF, project-bill PDF, pay stub, and — as a
*conditional* column that only appears when someone earned it (rare premium, don't
clutter the dense table) — the overtime report and the QBO bill preview.

New tests: OT bands (simple + rest-day 2×), QBO night premium (preview + push).
1130 pass. Every dollar on the pay report now traces to a visible, itemized cause;
no engine folds or drops a factor.

---

## 2026-07-26 — Traceability audit: break out the hidden night differential

Audited every term in the gross-pay formula against what the report actually
shows. Result: rate, OT multiplier, threshold/rule, prevailing rate, sick/vacation
%, guarantee, deductions, reimbursements are ALL surfaced (Inputs Used +
expandable per-line traces), and OT reason + logged break were just added. **One
factor was completely hidden: the night-shift differential** — `buildPayStatement`
folded `nightPremiumCost` straight into `overtimeCostRaw`, so it had no line, no
trace, and wasn't in Inputs Used. A company with a night premium couldn't see it.

Broke it out as its own factor (gross total unchanged — the premium just moved out
of the overtime bucket into its own):
- `payStatement.js`: `cost.night` + `hours.night`; `settingsUsed.night_differential`
  (window + %). Overtime cost no longer includes the night premium.
- Flatteners (worker invoice + OT report) carry `night_hours`/`night_cost`; totals
  already use `grossWages` so nothing regresses (night = 0 for everyone without the
  rule).
- Client: a "Night differential" summary line with an expandable trace ("{n}h in
  the 22:00–05:00 night window, paid at +25%"), an Inputs-Used row, the invoice PDF
  line, i18n EN+ES.

Tests pin the breakout (premium out of overtime, gross unchanged). 1125 pass.

Still partial (documented, low priority): premium OT lines show the *reason*
(rest-day / 7th-day / tier / window) but not the specific multiplier applied; and
the project-bill / qbo engines still fold night into overtime (a cross-surface
consistency follow-up — their totals are correct, just not broken out). Night diff
display on the pay stub / project-bill PDF / OT-report views is also a follow-up
(their totals include it via grossWages).

---

## 2026-07-26 — Traceability: surface the entry's own break in the trace

David spotted a 30-min break he didn't set. Root cause = **demo data**: the seed
stamps `break_minutes: i % 2 === 0 ? 30 : 0` on alternating entries
(`seed-demo-data.js:1303`), stored on the entry. Not a bug in the engine — but the
trace **never showed it**: `roundEntriesForPay` only emits an `auto_break` item
when a *rule* changes the break (`hoursRules.js:1230`); an entry's own logged break
silently cut paid hours with no explanation. (The engine takes `max(rule break,
logged break)`, so a real 60-min auto_break rule would raise it to 60 — if such a
rule is actually in the saved `hours_rules` policy and fires.)

Fix: the pay statement now pushes a `break_logged` explain item for any entry whose
break wasn't rule-adjusted (`raw_break_minutes` unset), rendered as "{n} min break
— recorded on the time entry" (`reportTrace.js`, i18n EN+ES). So the break is
visible and traceable instead of a phantom deduction. Tests pin it. 1123 pass.

---

## 2026-07-26 — Overtime explanations now say WHY (traceability)

Found via David eyeballing a demo bill: an entry showed "8.5h overtime — over 8h
daily" but the 8.5h was a **manual override**, not the daily rule (which on a 9h
day yields ~1h). The pay statement pushed a blanket `{code:'overtime', threshold,
rule}` for ANY overtime, so it mislabeled override, rest-day, 7th-day, tier and
window OT all as "over Nh daily" — an untraceable, misleading trail on a money
document.

Added per-entry **`overtime_reason`** through the engine (additive — no change to
the hours math):
- `annotateEntryOvertime` tags each OT-attribution path: `override`, `rest_day`,
  `seventh_day`, `window`, or `daily`/`weekly` (over-threshold).
- The rate-aware path threads the reason through `rateAwarePay`'s `perEntry` (from
  the annotated clones) → `buildPayStatement` stamps `e.overtime_reason`.
- The explain item now carries `reason`; the WH-347/report trace (`reportTrace.js`)
  renders it: "manually set on this entry", "worked on a rest day", "7th
  consecutive day worked", "premium time window", or "over Nh daily/weekly". The
  summary rollup uses an honest `{n}h overtime` instead of claiming a single rule.
- i18n: 5 new `trOvertime*` keys EN+ES.

Tests pin the attribution (override ≠ daily, rest-day, 7th-day, no-OT→no-reason),
including the exact Leo Martinez case. 1121 pass.

---

## 2026-07-26 — Two follow-ups from the review notes

**⚠️ Behavior change — "Allow overtime = off" now actually stops overtime pay.**
`feature_overtime` was a pay-engine no-op (it only drove alerts + which tiles
show), so a company that turned overtime OFF still had OT computed and paid.
Added `otRuleFromSettings(settings, workerRule)` to `paidHours.js` (off →
resolves the rule to `'none'`, which the engine already supports) and routed
EVERY pay/labor-cost surface through it: `buildPayStatement` (invoice/CSV/stub/OT
report), `laborCostCents`, project-bill, project metrics, the hours-export report,
certified-payroll, qbo `computeGroupOvertime`, and the client WorkerSummary
estimate. Default is ON, so only companies that explicitly disabled it change —
and for them, straight-time-only is now consistent with the already-supported
per-worker `overtime_rule='none'`. **David should confirm this semantic at merge**
(the alternative reading — "just hide the OT UI, still pay OT per law" — is why it
was flagged as a product call). Pinned with a `buildPayStatement` test.

**Removed the stale overtime math from the dev QA page.** `client/src/pages/
Tests.jsx` carried its own copy of the OLD `computeOT`/`computeDailyPayCosts` and
~90 lines of test cases pinning the retired regular-only algorithm — testing dead
code (the client now uses `rateAwareSplit`, the real math is server-side + fully
covered). Deleted the copies + their four test blocks (kept the still-valid
`hoursWorked` test). 1017 → 882 lines. Full verify green (1117 pass).

---

## 2026-07-26 — Rate-aware overtime: review sweep (5 agents) + fixes

Ran a 5-agent adversarial review over the whole rate-aware overtime feature
(calculator core, buildPayStatement integration, the 3 consolidated engines, the
client, the settings plumbing). Verified every finding against the code before
touching anything. Two HIGH bugs, both money:

1. **`hasSimpleOtConfig` flattened fixed-slot tiered OT** (found independently by
   3 agents). `otConfigFromSettings` emits tiers in TWO shapes — custom `ot_tier`
   rules (`tierRules`) AND fixed-slot `dailyBands`/`weeklyBands` (un-migrated from
   stored policies). The gate only checked the former, so a company with e.g. a
   California `8h@1.5× / 12h@2×` policy stored as bands routed through the flat
   rate-aware path and lost the 2× tier — silent underpay across ALL surfaces
   (invoice, CSV, stubs, project bill, QBO, WH-347). Fixed: gate on the bands too
   (any → per-band engine). Added `hasSimpleOtConfig` unit tests (the path was
   entirely uncovered).
2. **`companyStatements` had no `ORDER BY`.** The rate-aware engine attributes OT
   to the chronologically-later hours and prices each at its own rate, so gross is
   order-dependent — but the company-wide loader (overtime report + payroll CSV)
   fed entries in raw DB order while the invoice/stub loaders order chronologically.
   Same worker → different gross on different surfaces, nondeterministically. Fixed
   with the matching `ORDER BY`.

Plus three lower ones: **NaN prevailing rate** on the WH-347 when a company has no
prevailing rate set (`parseFloat(undefined) ?? 45` stays NaN → NaN gross); the
**qbo** bill query missing `ORDER BY` (latent — benign only because QBO prices at a
flat rate); and the **WorkerSummary** weekly estimate ignoring `week_start`. All
fixed. Also added defensive `parseFloat(threshold)||8` coalesces.

Verified-clean (no action): regular-only regression = byte-identical; night
differential correctly routes to the per-band path; splitRateAware reconciles by
construction; no surface re-derives OT cost the old way; QBO premium formula
correct; certified-payroll response is a superset. 1116 pass.

---

## 2026-07-26 — Rate-aware overtime: the money core (increment 1 of the build)

Approved the plan (`docs/plans/rate-aware-overtime.md`) + David's ask to make the
blended method a per-company choice. Built the **isolated, tested money core**
first — before wiring it into any paycheck — because OT math can't be eyeballed and
the scenario tests ARE the accuracy guarantee.

- **`server/utils/rateAwareOvertime.js`** — pure calculator. All of a worker's hours
  count toward ONE threshold regardless of wage_type (the fix for multi-rate work);
  reuses `annotateEntryOvertime` (via a uniform-wage_type clone) for the chronological
  OT-hour attribution, then prices per-entry. Two methods: `rate_when_worked`
  (default — each OT hour at the rate it earned) and `weighted_average` (FLSA blend,
  opt-in). **Scope v1: plain single-multiplier OT** — `hasSimpleOtConfig()` gates
  out tiers/rest-day/7th-day/window premiums (they need per-band attribution) so the
  integration layer keeps those on the existing path until that lands.
- **Setting `overtime_rate_method`** (default `rate_when_worked`) — constant
  `payEnums.js`, settingsDefaults, admin PATCH validation, db-enums row.
- **`rateAwareOvertime.test.js`** — the scenario matrix A–F as executable
  expected-pay: excavator prevailing-then-civilian $420 / civilian-then-prevailing
  $435 (order matters), Kentucky call center $855, Honduras 1.25× L.925, pure
  prevailing week $2,340, break-clamp $0, weighted-average mixed week $1,900, and the
  single-rate invariant (both methods agree). All pass.

**Not yet wired into pay** — the calculator is standalone. Next increments (todo):
integrate into `buildPayStatement` with the cross-surface reconcile invariant + the
no-regression guarantee, then route the WH-347 report through it. Nothing changes a
real paycheck until those land and David merges. 1112 pass.

---

## 2026-07-26 — Certified-payroll / prevailing-OT audit (+ break clamp)

Audited the WH-347 path to figure out how to close the prevailing-OT gap without
guessing money math. Finding was bigger than the BACKLOG note: `GET
/admin/certified-payroll` (`admin.js:3454`) computes **no overtime at all** — it
bucket-sums raw hours and grosses `hours × rate` flat, and it **bypasses
`buildPayStatement`** (hand-rolled, which is why it drifted). So the compliance
report understates OT for *everyone*, not just prevailing workers.

The audit *resolved* the hard question, though: the stored rate is **base-only,
fringe modeled separately** (`worker_fringes`, per-category per-hour) — exactly the
WH-347 model, so "OT on base, fringe straight" needs no schema change. The other
decisions collapse to "reuse the company's existing OT config" + "route through
`annotateEntryOvertime` for a per-day ST/OT split."

Wrote the full plan → `docs/plans/certified-payroll-ot.md`; updated the BACKLOG
item to point at it. **Still gated** on David matching one real WH-347 before the
pay-math change. Shipped now: the inline **break-clamp** fix on this endpoint
(`admin.js:3515`, its own copy of the Batch-6 bug — negative hours on a compliance
doc). 1103 pass.

---

## 2026-07-26 — "Go for all of it" batch 7: cleanup sweep

Five lower-severity hygiene/correctness fixes closing out the review:

1. **Unescaped ILIKE search** in the estimate + change-order list endpoints — a
   literal `%` or `_` in the query acted as a wildcard. Now escaped with the same
   `replace(/([\\%_])/g, '\\$1')` invoices.js already used.
2. **Internal token hashes leaked in authed payloads.** `co.*` / `lw.*` / `a.*`
   (and several `RETURNING *`) carried `response_token_hash` / `sign_token_hash` /
   `manage_token_hash` into list + detail + send responses. Stripped at each
   return point (a shared `stripToken` in lienWaivers; destructure elsewhere),
   matching how estimates/invoices already scrub theirs. Low severity (SHA-256,
   same-company admin) but it's internal token material.
3. **Unbounded signer name** on the public accept/sign routes (`typed_name`) —
   capped to 255 chars, since it's unauthenticated free text.
4. **Night differential mis-rated.** `nightPremiumCost` applied the baseRate
   premium to EVERY entry, including `prevailing` hours (which carry their own
   rate) and leave. Now scoped to `wage_type='regular'` — the only hours priced
   at baseRate.
5. **Project-doc delete ordering.** `DELETE /projects/:id/documents/:docId`
   deleted the R2 blob BEFORE the DB row, so a failed row delete left a record
   pointing at a missing file. Flipped to DB-first, best-effort-blob-second —
   matching the client-documents delete (a failed blob delete now only orphans a
   file the R2 lifecycle reaps).

Tests: prevailing-gets-no-night-premium case added. Server suite: 1103 pass.

**All seven review batches now shipped.** (batches 1–7, dev)

---

## 2026-07-26 — "Go for all of it" batch 6: pay-engine semantics (money-critical)

Four verified fixes in `payCalculations.js` / `payStatement.js`, plus one gap
filed rather than guessed:

1. **Guarantee double-paid leave.** The weekly-hours guarantee shortfall was
   computed from worked hours only (`regular + OT + prevailing`), ignoring paid
   leave. A worker guaranteed 40h who worked 30h and took 10h sick got 30 + 10
   sick + **10 guarantee** = 50h paid. Leave now counts toward the guarantee base
   (`+ sick + vacation`), so covered-to-40 → no shortfall.
2. **Partial leave double-counted across pay periods.** A partial time-off request
   (single logged `hours` + a date range) is fetched by any period it overlaps, so
   a request straddling a period boundary was paid IN FULL in both. Now anchored
   to the period containing its `start_date` — counted exactly once.
3. **`min_daily > threshold` erased worked overtime.** When the reporting-time
   floor exceeded the OT threshold, a short-of-floor day dumped the whole floor
   into regular and skipped banding (worked 9h with floor 10 / threshold 8 → 10
   reg / 0 OT). Now the worked hours are banded first (OT preserved) and the
   shortfall tops up as regular. Identical for the usual floor ≤ threshold.
4. **Break > shift → negative pay.** `entryDuration` (and the prevailing loop)
   returned `shiftHours − breakHours` unclamped, so dirty data (break longer than
   the shift) subtracted from paid hours and pay. Clamped at 0.

Filed to BACKLOG (not fixed): **prevailing-wage hours never accrue overtime** —
a real Davis-Bacon compliance gap, but fixing it right needs product/legal
decisions (OT threshold basis, 1.5× *which* rate, fringe treatment, mixed-day
interaction). Guessing would produce confidently-wrong paychecks, worse than the
known gap — so it needs David's spec first.

Tests: guarantee-with-leave, partial-straddle (×2), floor-above-threshold, and
break-clamp cases added; the old test that *pinned* the negative-hours quirk was
flipped to assert the clamp. Server suite: 1102 pass.

---

## 2026-07-26 — "Go for all of it" batch 5: public-route + impersonation hardening

Four tenant/abuse-surface fixes:

1. **Fired super-admin kept live impersonation.** Impersonation ("Login as")
   tokens carry no `tv`, so requireAuth's active-check skipped them entirely — a
   super-admin deactivated or demoted mid-session (4h token) kept full access to
   the impersonated company, and a target user offboarded mid-session kept theirs.
   Added `imp_by` (the super-admin's id) to the token and an `else if
   (payload.imp)` branch in `middleware/auth.js` that re-checks, every request,
   that the target is active AND the impersonator is still active + super_admin.
2. **Public token routers had no rate limit.** The estimate/change-order/
   invoice/lien-waiver public routers (view + accept/decline/sign) ran
   unthrottled — only booking was limited. Added a shared
   `middleware/publicLimiters.js` (`publicReadLimiter` 60/min router-wide,
   `publicWriteLimiter` 20/hr on the mutations), mirroring booking's shape.
3. **Decline was a TOCTOU.** Estimate + change-order `decline` did a plain
   SELECT-then-UPDATE with no lock; the CO variant's UPDATE had no `status` guard
   at all, so a decline racing an accept left the CO 'declined' with the project
   budget already bumped. Both now `BEGIN` + `SELECT … FOR UPDATE` + re-check +
   guarded UPDATE + `COMMIT`, matching their accept flows.
4. **Cross-tenant project on a booking.** The authenticated admin book route
   inserted `project_id` straight from the body — an admin of company A could
   attach company B's project id. Now validated against `projects WHERE id = $1
   AND company_id = $2` before insert.

Tests: 3 new impersonation-guard cases (target/super-admin deactivated, super-admin
demoted → 401) + happy-path decline cases pinning the `FOR UPDATE`. Server suite:
1097 pass.

---

## 2026-07-26 — "Go for all of it" batch 4: clock-in/out races

Two concurrency bugs on `routes/clock.js`, both money/data-integrity:

- **Double clock-out → duplicate time entry (double pay).** `/out` read
  `active_clock` with a plain unlocked SELECT *outside* the transaction, then in a
  separate tx inserted the time entry + deleted the row. Two near-simultaneous
  `/out` calls (double-tap, retry) both read the row and both inserted an entry.
  Added a `SELECT 1 … FOR UPDATE` re-check at the top of the tx (mirroring what
  `/switch` already did): the lock serializes the pair and the loser finds the row
  gone and aborts with no entry. One shift → one entry.
- **Re-clock-in silently erased the shift.** `/in` used `ON CONFLICT (user_id) DO
  UPDATE`, so a worker already clocked into Project A who re-tapped (stale UI,
  second device, offline replay) had their original clock-in *overwritten* — start
  time and project gone, the morning's hours vanished with no entry. Changed to
  `DO NOTHING` and, on conflict, return the untouched existing clock-in
  (`already_clocked_in: true`, 200). Idempotent for double-taps/offline-replay,
  preserves the shift; changing projects mid-shift stays `/switch`'s job. Verified
  the client surfaces this as a normal clocked-in state (it reads `r.data` on any
  2xx and refreshes `/clock/status`).

No new clock-route test harness — clock.js routes have none, and `/in`'s pre-INSERT
validation chain makes a bespoke one disproportionate; the fixes are standard PG
semantics verified against the client contract. Server suite: 1091 pass.

---

## 2026-07-26 — "Go for all of it" batch 3: the Stripe subscription webhook

Five real hardening fixes on `routes/stripe.js` (a sixth flagged item —
incomplete/paused status mapping — was already handled by `mapStripeStatus`):

1. **Activation stored no subscription id.** `checkout.session.completed` read
   `session.metadata.company_id`, but checkout only set `subscription_data.metadata`
   (→ the *subscription*, not the session), so the session's metadata was empty and
   the `if (companyId && …)` guard fell through — `companies.stripe_subscription_id`
   never got written (it's the ONLY writer). That silently broke `/addon`, `/portal`,
   and the superadmin delete guard. Fixed both ways: checkout now sets top-level
   `metadata` on the session too, and the handler falls back to the retrieved
   **subscription's** metadata for sessions already in flight. `subscription.updated`
   now also (re)asserts the sub id so it can't be left unset.
2. **Plan read from `items[0]`.** Stripe doesn't order subscription items, so a
   business sub whose per-worker seat or an add-on sorted first was mis-mapped to
   `plan='free'` → the paying company loses access. New `planFromItems()` scans all
   items for the first real base plan.
3. **Out-of-order events.** New `last_stripe_event_at` watermark (migration 0153):
   the three lifecycle writes fold `AND (… IS NULL OR … <= event.created)` into
   their WHERE, so a stale `updated`/`deleted` (Stripe retries up to 3 days, no
   ordering guarantee) can't resurrect a canceled company.
4. **`payment_failed` could resurrect.** The past_due write was unconditional; now
   guarded to `subscription_status IN ('active','trial','past_due')` so it won't
   un-cancel or un-exempt a company.
5. **Fail-open webhook.** The handler caught every error and still returned 200 —
   a transient Neon blip dropped the state change forever. Now returns **500** so
   Stripe retries (Sentry still fires for genuinely deterministic failures).

New `stripeWebhookRoute.test.js` (6 tests) pins all five. Server suite: 1091 pass.

---

## 2026-07-26 — "Go for all of it" batch 2: delete paths vs the booking FKs

The company-wipe and the demo-workspace reset kept **two hand-maintained delete
lists**, and they'd drifted. The full wipe (superadmin) had the 0114 RESTRICT
sub-ledgers but **not the booking tables** (0113); the demo reset had an even
shorter list. Since the demo seed now creates `appointments`, and
`appointments.assigned_user_id` / `.appointment_type_id` are both `ON DELETE
RESTRICT`, the demo reset's `DELETE FROM users` would 500 on the next reset — and
the full wipe would 500 on any company that ever booked an appointment.

Fixed at the altitude of the drift: **extracted one `purgeCompanyRows(client, id)`**
and pointed both the wipe route and `deleteDemoWorkspace` at it, so the list can't
diverge again. Folded in:
- **Booking (0113):** `appointments` (cascades `appointment_audit`) →
  `appointment_types` (cascades the two join tables) → `shift_types` →
  `bookable_windows`, all before `users`.
- **`roles` / `role_permissions`** — these were in the demo list but **missing
  from the full wipe** (it relied on `companies` cascade); now explicit in both,
  after `users` (users.role_id → roles).
- **Export endpoint** (`GET /companies/:id/export`) list synced: added the booking
  tables, `invoices`, `estimates`, and the project sub-ledgers it had also drifted
  past — churned-customer exports were silently incomplete.

Test: `superadminDelete.test.js` gained the booking tables + a booking-ordering
assertion (appointments before users AND appointment_types) and the roles-after-
users check. Server suite: 1085 pass. (One cross-suite flake in
`updateLanguageImpersonation` under load — passes isolated and on re-run; unrelated
to this change.)

---

## 2026-07-26 — "Go for all of it" batch 1: the work_date-as-Date class of bug

Second review's headline finding, verified and fixed. **Root cause:** node-postgres
returns a `DATE` column as a JS `Date` (local midnight), never a `'YYYY-MM-DD'`
string — and `db.js` has no `setTypeParser` override. The pay/rules engine keyed
off the day via `String(work_date).substring(0,10)`, which on a `Date` yields
`"Sat Jul 26"` — the weekday parse then rejects it, so **every date-scoped rule
silently no-op'd on the four pay surfaces** (worker invoice, OT report, payroll CSV,
pay stubs) while the admin report — which loads `to_char(...)` — computed them
correctly. A live surface divergence on money: the exact failure the pay pipeline
was consolidated to prevent.

Fixed at both ends so it can't regress by either route:
- **Loaders cast at the source** — `payStatement.js` (all three loaders) and
  `paidHours.js` `LABOR_ENTRY_COLUMNS` now `SELECT to_char(te.work_date,
  'YYYY-MM-DD') AS work_date`, so the engine's inputs are strings.
- **The engine is now `Date`-robust regardless of caller** — added a shared
  `ymd()` (exported from `hoursRules.js`) that normalizes both shapes; routed it
  through `roundEntriesFromSettings` (locally, *not* mutating the caller's row —
  `admin.js`/`qbo.js` still hold their `Date`s) and the four `computeOT` internal
  date keys. `weekBucketKey` was already `Date`-safe.
- **Regression test that feeds a real `Date`** (`payCalculationsPremiums.test.js`)
  — the existing tests all passed string dates, which is exactly why this slipped
  through. The new case fails without the fix.

Also swept the same bug class out of two display paths:
- **copy-last-week** (`timeEntries.js`) did `.toString().substring(0,10)` → `new
  Date("Sat Jul 26T00:00:00")` = Invalid Date → it would insert `work_date="Invalid
  Date"` → 500. Now `toLocaleDateString('en-CA')`.
- **Approve/reject notifications** (`admin.js`, 5 spots) rendered `"Sat Jul 26"`
  in the worker's email/push/inbox. Now `ymd()`.

Server suite: 1085 pass (was 1083 + 2 new). Batches 2–7 (delete paths, Stripe
webhook, clock races, public-route hardening, pay semantics, misc cleanup) still
queued from the same review.

---

## 2026-07-25 — Follow-through: delete/merge paths vs the 0114 RESTRICT FKs

Chased the `0114` CASCADE→RESTRICT project-FK change through the *other* delete
paths, after fixing the superadmin wipe:

- **Demo-workspace reset — verified SAFE.** `deleteDemoWorkspace` also does
  `DELETE FROM projects`, but its seeder (`createDemoWorkspace`) never creates any
  RESTRICT sub-ledger tables, so nothing can block it. No fix needed.
- **Project merge — found + guarded a real bug.** `admin.js`
  `POST /projects/:id/merge-into/:target_id` re-points only 12 operational tables
  then hard-deletes the source, so a source with financial records (change orders /
  POs / submittals / closeouts / expenses / budgets / lien waivers = RESTRICT, or
  invoices / estimates = SET NULL) would **500 on the delete or silently orphan the
  money**. Added a pre-check that returns a clean **409** instead. Full
  financial-aware merge (needs real merge semantics for the per-project unique
  closeout/budget rows) is filed in `docs/BACKLOG.md`.

Verify green (82 / 1083). ⚠️ The merge endpoint has no tests (pre-existing gap);
the guard is a simple defensive pre-check.

## 2026-07-25 — Review follow-up: superadmin wipe fix + cleanup pass ("all of it")

- **Superadmin company-wipe (pre-existing bug).** `DELETE FROM projects` is
  RESTRICTed by **seven** sub-ledger FKs — `subcontract_pos` (0107) plus the six
  the `0114` audit-followup migration flipped CASCADE→RESTRICT (`lien_waivers`,
  `change_orders`, `submittals`, `project_closeouts`, `project_expenses`,
  `project_budget_categories`). None were deleted first, so wiping any company
  with any of that data 500'd, leaving it un-deletable. Added the deletes in
  FK-safe order (`subcontract_pos` before `subcontractors`; all before projects;
  each parent CASCADEs its children) + `estimates` for orphan cleanup. Test
  asserts both presence and the ordering.
- **Server cleanups:** `createInvoice` advisory lock (no number-collision 500 on
  concurrent create); from-project skips $0 expense lines; the list search escapes
  ILIKE `%`/`_`; void locks its row (`FOR UPDATE`); `invoiceTotals` + the QBO list
  scope by `company_id` / exclude void; `0150` also populates `client_id` +
  `project_name` on migrated QBO rows.
- **Client cleanups:** the invoice-list load ignores superseded responses (the
  filter/page race); line items keyed by a stable `_k` so deleting a row no longer
  resets an adjacent money field; `SourcePicker` matches visible fields (not
  `JSON.stringify`); dropped a dead param.

Verify green (82 / 1083).

## 2026-07-25 — Full review + fixes (Tier 1 bugs + unambiguous Tier 2)

Ran a 5-way parallel review over the session's invoice / QBO / Stripe / sitework /
email work; verified findings against the code, fixed the confirmed bugs + clear
could-breaks.

**🔴 real bugs**
- **Migration `0150` would ABORT the deploy on a negative QBO amount** (credit
  memo) — negative `*_cents` violates the `≥ 0` CHECKs. Clamped to
  `GREATEST(0, …)` so such a row lands as $0. **Edited `0150` in place** — the only
  option, since a later migration can't rescue one that aborts first; dev applied
  it as a 0-row no-op, so no divergence.
- **Two subscription webhooks called `sendEmail({…})`** (object) against the
  positional fn → the payment-failed + trial-ending admin emails silently never
  sent. Fixed to positional. *(pre-existing)*
- **Invoice send email rendered a garbled due date** (`String(Date)` → "Mon Jul
  20") → `toISOString().slice(0,10)`.
- **`InvoiceFormLoader`: a failed edit-load showed a blank "New invoice" form** →
  saving created a duplicate. Now shows an error + back (`invErrLoad`).

**🟠 could-break**
- **Closeout: added the real escape hatch** — an auto item can now be manually
  waived/N-A'd, overriding the compute-on-read. Before, `final_complete` was
  unreachable for anyone billing via QBO/cash/outside OpsFloa, despite a comment
  falsely claiming a waive existed.
- **QBO:** `check-payment` no longer resurrects a voided invoice (`status<>'void'`);
  `POST /invoices` scopes `project_id` + the client-name snapshot to the caller's
  company (was a small cross-tenant leak I'd introduced).
- **Invoices:** `PATCH` locks + re-checks frozen inside its tx (was a TOCTOU vs a
  concurrent send); `VARCHAR(255)` header fields capped; payments reject fractional
  `amount_cents` / malformed `paid_date` with 400 not 500.
- **Client:** "Balance" column sorts by balance (was amount-paid); a stale/unknown
  Tools hash (e.g. `#sitework`) falls back to Plan Room, not a blank page; PDF
  retainage shown as "held" (no misleading minus), matching the web.

Tests +1 (closeout waive), PATCH tests updated. Verify green (82 / 1083).

⚠️ **Left as-is, flagged:** a **pre-existing superadmin company-wipe bug** —
`subcontract_pos` `RESTRICT`s `DELETE FROM projects`, so wiping any company that
made a sub-PO 500s. Real but out of this scope. Plus lower-priority cleanup
(client-side sort spans only the current page, concurrent-create number race,
`invoiceTotals`/AR `company_id` defense-in-depth, etc.).

## 2026-07-25 — Invoice online pay, Phase 1: Stripe Connect onboarding

Foundation for clients paying invoices online, with money landing in the
**company's own** Stripe (Connect, **no platform fee** — David's calls). Full plan:
`docs/plans/invoice-online-pay.md`.

- **Migration `0152`** — `companies.stripe_connect_account_id` +
  `stripe_connect_charges_enabled` (cached flag). We store only the
  connected-account id, never the company's keys. Distinct from
  `stripe_customer_id`/`stripe_subscription_id` (OpsFloa's *own* billing).
- **`routes/stripe.js`** — `POST /stripe/connect/onboard` (create/reuse a Standard
  connected account → hosted onboarding link) + `GET /stripe/connect/status`
  (retrieve → `charges_enabled`, cached on the row). Reuses `getStripe()` +
  `manage_billing` perm.

Verify green (82 / 1082). Next: Phase 2 (public "Pay now" → Checkout on the
connected account). ⚠️ David's Stripe dashboard, when we reach Phase 2–3: enable
**Connect**, and add a **Connect webhook** endpoint + signing secret.

## 2026-07-25 — Invoices: stable share link + email From = the contractor

Two fixes from David's questions on the send-email:

- **Stable share token.** `POST /:id/send` now STORES the raw token (migration
  `0151` adds `invoices.response_token`, mirroring estimates), and `POST /:id/link`
  returns that SAME token instead of rotating. Before, "Copy link" minted a fresh
  token — which would have **broken the `/i/<token>` link just emailed** to the
  client. `loadInvoiceFull` strips the raw token from the general payload.
- **Email From / Reply-To.** The send email now shows the **company name** as the
  From display-name (the address stays on OpsFloa's verified domain — Resend
  requires the sending domain be verified, so it can't literally be the
  contractor's address) and sets **Reply-To to the sending admin**, so the client
  sees the contractor and replies reach them, not `info@opsfloa.com`. `sendEmail`
  gained an optional `{ fromName, replyTo }` param (backward-compatible).

Verify green (82 suites / 1082); migration `0151` validated by CI lint.

## 2026-07-25 — Invoices: email the client on send

Wired the invoice **Send** flow to actually email the client a link to the public
`/i/:token` page (before: the admin copied the link by hand — same gap estimates
still have).

- **`routes/invoices.js` `POST /:id/send`** — after committing `'sent'`, if the
  invoice has a `client_email` it sends a house-style email (greeting + amount /
  balance due + a "View invoice" button → `${APP_URL}/i/<token>`) through the
  shared `sendEmail` (Resend). **Best-effort:** the invoice is already committed,
  so a delivery failure/skip never 500s — the response carries an
  `email: { sent, to, reason }` status and the admin still gets the copyable link.
- **Client** — the send toast now reads "emailed to <client>" when it went out,
  else the existing "sent" (copy the link). New `invToastEmailed` key (EN + ES).
- Reuses existing infra: `sendEmail`'s guards (demo/bounce/dev-redirect/no-key),
  `utils/htmlEscape`, `APP_URL`. **No PDF attached** — the public page is the
  canonical view; server-side PDF render is a bigger lift, deferred.
- Test: +1 in `invoicesRoute.test.js` (mocks `../email`, asserts the client gets
  a `/i/<token>` link on success). Verify green (82 suites / 1082).

⚠️ Real delivery needs `RESEND_API_KEY` + verified `EMAIL_FROM` + `NODE_ENV=production`
(see [[project_email_resend]]); non-prod redirects to `EMAIL_REDIRECT_TO`. The
remaining deferred invoice item is **online payment** on the public page.

## 2026-07-25 — Sitework: all live references removed

Purged sitework from the running codebase (David: "leave sitework in the past").

- **`ToolsPage.jsx`** — removed the `SITEWORK_TOOL_URL` const, the `SHOW_SITEWORK`
  flag, `hasTakeoff`/`showSitework`, the `#excavation → sitework` `resolveTab`
  mapping, the hidden-tab redirect effect, the tab entry, and the whole render
  block. (The tab was already gated off; this deletes the dead code.)
- **Governing docs** — dropped the "Frozen: the sitework tool" section in
  `CLAUDE.md`; updated `MAP.md` (the `sitework/` entry → notes it's archived) and
  the `db-enums.md` `live_sessions.tool` note.
- **Stale comments** — `index.js`, `middleware/auth.js`, `routes/takeoffs.js`,
  `routes/stripe.js`, `api.js`, and a test header no longer name the retired tool.

Verify green (82 suites / 1081). **Intentionally KEPT** (calling these out so they
don't read as misses):
- the **Calculators "Sitework" category** (asphalt/base/grade) — a civil-work
  category, *not* the tool; renaming it would be wrong.
- the **`live_sessions.tool` = `'sitework'`** enum value — vestigial but lockstep
  with the CHECK; dropping it means a migration for a never-used reserved value,
  not worth it (documented in `db-enums.md`).
- **historical/lineage/roadmap** mentions in `docs/plans/*`, `tool-apps/shared`
  provenance comments + `PARITY.md`, and the WORKLOG — that's sitework's past.

**Final state:** David then deleted the `sitework-archived/` box too, so sitework
is entirely gone from the repo. Recoverable only from git history — commit
`e859f05` ("Box sitework…") holds the full tool + test + README
(`git checkout e859f05 -- sitework-archived/`).

## 2026-07-25 — Sitework tool boxed into one removable folder

David wants the standalone Sitework Takeoff tool out of the project but
recoverable. Consolidated **everything sitework** into a single root folder
`sitework-archived/` via `git mv` (moved, not copied — it's the sole copy now):
- `client/public/tool-apps/sitework/` (the 5-file tool, ~1.7 MB)
- `server/tests/siteworkToPlanRoom.test.js` (the one test that *reads*
  `sitework/app.js` — it had to move too or `verify` breaks)
- `README.md` runbook (what it is, what does/doesn't depend on it, remove +
  restore steps).

Mirrors repo paths inside the box, so restore = `cp -r sitework-archived/{client,server} .`.
Verify green afterwards: server jest **82 suites / 1081 tests** (−1 suite, −14
tests = exactly the moved sitework test); client build OK.

**Findings / calls:** Plan Room + `tool-apps/shared/` are independent copies
(`PARITY.md`), so they were untouched and keep working. `ToolsPage.jsx` still has
**inert** sitework refs (all behind `SHOW_SITEWORK = false`) — they don't break
build/runtime, so I left them and documented the optional cleanup + the restore
path in the box README rather than editing the shared file. The final *removal*
(deleting/taking out `sitework-archived/`) is David's to do. First attempt was a
copy-alongside-live (wrong — deleting the box left the tool wired in); redone as a
move so the one folder truly is the removal unit.

## 2026-07-25 — Native invoices, Phase 5: QuickBooks unified onto native (mirror retired)

QBO is now a **sync layer on the native `invoices` table** — one invoice table,
no more dual-source AR. Migration `0150` + rewired every `project_invoices`
reader/writer.

- **`0150_unify_invoices.sql`** (atomic — the whole file is one implicit tx):
  copies each QBO-mirror row into `invoices` (`source='qbo'`, carries
  `qbo_invoice_id` + new `qbo_doc_number`; dollars→cents), gives each a summary
  line, **reconstructs the paid portion as an `invoice_payment`** (so native
  balance + AR "collected" stay right), then **repoints `lien_waivers.invoice_id`**
  off `project_invoices(id)` onto `invoices(id)` (drop FK → remap ids via a temp
  `migrated_pi_id` → add FK). Number scheme `QBO-IMP-<pi.id>` so it can't collide
  with qbo.js's `QBO-<qboId>`.
- **`qbo.js`** rewired: push creates a native invoice (+line) instead of the
  mirror; the project-invoices list reads native mapped back to the QBO-panel
  shape (so the existing Projects UI is unchanged); check-payment updates the
  native row's status + re-syncs the imported payment (idempotent delete-insert).
- **Readers repointed to native:** `projectReports` AR rollup (billed = Σ
  `total_cents`, collected = Σ `invoice_payments`), `lienWaivers` ownership check,
  `closeout` `final_invoice` (dropped the Phase-3 mirror bridge), `superadmin`
  wipe now clears `invoices` (children cascade).
- ⚠️ **Judgment call — `project_invoices` kept DORMANT, not dropped.** Rather than
  `DROP TABLE` on production financial data in the same change, the mirror is left
  in place as a rollback backup (no code touches it but the superadmin wipe). The
  physical drop is a filed one-liner (`docs/BACKLOG.md`) once this is verified in
  prod. QBO isn't connected on dev, so the data-copy is a schema-only no-op on dev.

Verify: full server suite **1095 green** (projectReports + superadminDelete tests
updated to native). ⚠️ The migration's data path only exercises on a DB with real
QBO-mirror rows — **CI migration-lint validates the SQL against the built schema**;
smoke-test on a QBO-connected company after prod merge (push → check-payment → AR).

## 2026-07-25 — Native invoices, Phase 4: client UI (the module is now usable)

Built the admin UI + client-facing page, cloned from the estimates surface.
A company can now create → send → get paid → close out entirely in-app.

- **`InvoicesPanel`** (`pages/InvoicesPage.jsx`) mounts as a new **Invoices tab**
  in the Projects module (next to Estimates, same `canSeeSales` gate). List with
  status badges + balance column, the cents line-item editor (`MoneyInput`/
  `useCents`), draft edit, and a detail view with send / copy-link / **record
  payment** / void + a payments ledger. All money via `useCents`/`useCurrency`
  (no hardcoded `$`).
- **Three create sources** surfaced in one "New" menu: Blank, From an accepted
  estimate (searchable picker → `from-estimate`), From project time & expenses
  (picker → `from-project`).
- **`InvoicePDF.jsx`** cloned from EstimatePDF (simpler math: subtotal → tax →
  total, retainage, amount paid / balance due), reusing the `pdf*` i18n keys.
- **Public `/i/:token`** view page (`PublicInvoicePage.jsx`, view-only — online
  pay deferred) + route in `App.jsx` + token redaction pattern already added
  server-side.
- **i18n:** ~110 `inv*` keys added to **both** `moduleEn` and `moduleEs`
  (`i18nModules.js`); category labels reuse the `estCat*` keys. Parity test green.

Verify: client eslint clean, vitest 255 green (incl. i18n parity), production
build OK; sitework untouched.

⚠️ Not yet wired: the invoice link isn't emailed (admin copies it, same as
estimates today); online payment on the public page is deferred. Phase 5 (QBO
unification) is still open and stageable.

## 2026-07-25 — Native invoices, Phase 3: closeout unblocked (three bugs)

Fixed `server/routes/closeout.js`. These were the reason non-QBO projects
couldn't close out (the whole motivation for native invoices).

- **`final_invoice` false negative.** Read `project_invoices` (the QBO mirror),
  empty for non-QBO companies → stuck `in_progress` forever. Now counts a paid
  **native** invoice *or* a paid QBO-mirror row (so QBO companies don't regress
  before Phase 5 folds the mirror in). Zero invoices → `in_progress`, not a
  permanent block — the item's manual-waive is the escape hatch.
- **`retainage_release` false positive.** `SUM(project_invoices.balance)` over
  **zero rows** is 0 → reported `done` for every non-QBO project. Now: done only
  when native invoices **exist** and their `retainage_held_cents` sums to 0;
  zero invoices → `in_progress`.
- **Transition gate read stale status → `final_complete` unreachable for
  EVERYONE.** Auto items are never persisted past `'pending'` (computed on
  read), but both gates (`substantially_complete`, `final_complete`) checked the
  *stored* status — so an auto item always looked pending and 409'd. Both gates
  now compute the effective status (new `effectiveItemStatus` helper) before
  deciding. Dropped the dead `byCat` and the comment that claimed the compute
  already happened.

Tests: +5 in `closeoutRoute.test.js` (compute-on-read reaches substantial;
unpaid auto invoice blocks final_complete; native-invoice repoint; retainage
zero-rows no longer false-done). Full server suite 1095 green.

## 2026-07-25 — Native invoices, Phase 2: server route + payment lifecycle

Built `server/routes/invoices.js` (mounted authed + token-public in `index.js`,
`business`-plan gated like estimates), cloning the estimates route. See
`docs/plans/` (mossy-launching-mist) for the phase map.

- **Three creation sources, as decided.** From scratch (`POST /invoices`),
  `POST /invoices/from-estimate/:id` (copies an **accepted** estimate's lines;
  409 otherwise), and `POST /invoices/from-project/:id` (T&M prefill: one Labor
  line valued by the pay engine's `laborCostCents` over the project's *approved*
  entries, plus a line per `project_expenses` row — editable before send).
- **Payment lifecycle.** `POST /:id/payments` records full/partial payments into
  `invoice_payments`, then derives status off Σpayments vs total:
  draft→partial→paid; `POST /:id/void` cancels; both blocked appropriately (no
  payment on draft/void). Money-critical derivation is unit-pinned in
  `tests/invoicesRoute.test.js` (18 tests, mocked pool like estimates).
- ⚠️ **Judgment call — no stored raw share token.** Unlike estimates (which
  stores the raw token for stable re-retrieval), invoices store only the hash.
  `/send` returns the raw token once; `POST /:id/link` **rotates** the link
  (mints a new token, so a previously-shared URL stops working). Chosen to avoid
  a second migration on the just-shipped 0149 and to not persist raw tokens. If
  you want estimate-style stable links, it needs a `response_token` column.
- **Found while wiring:** `retainage_pct`/`retainage_held_cents` are owner-side
  retainage with no prior home in the schema — carried through
  `computeInvoiceTotals` so Phase 3's closeout `retainage_release` check has a
  real number to read.

Next: Phase 3 (closeout fixes — the three bugs), then Phase 4 (client UI).

## 2026-07-25 — Backlog cleanup: Plan Room bugs + tool-app currency

Cleared three backlog items and confirmed a fourth obsolete.

- **Tool-app currency ($ hardcoded).** `SettingsContext` writes a `tc_currency`
  localStorage key; the shared `engine-ui.money()` reads it and formats in the
  company currency (locale map mirrors `client/src/utils.js`), USD fallback. Plan
  Room bid tables now respect a non-USD company. **Sitework's own `money()` copy
  is left on `$`** (off-limits) — accepted divergence until the sitework port.
- **`fopening` → `POINT_KINDS`** — single-click dot kind now behaves like its twin
  `dopening` instead of rubber-banding + needing two clicks.
- **`froom`/`ftrans`/`fwall`/`fsheath` → `NEEDS_SCALE`** — flooring/framing kinds
  now block on an uncalibrated sheet (📏 nudge) instead of silently tracing to a
  0 bid.
- **"Hours engine reaches only 4/10 money paths" — marked RESOLVED (money-of-
  record).** Verified the flagged server paths now use the engine (qbo, scheduled
  reports, project reports/metrics, plus the four pay surfaces on
  `buildPayStatement`); only two client display-mirrors (`WorkerSummary.jsx`,
  `Tests.jsx`) remain as low-stakes estimates.

Plan Room `?v` 75→76 (engine-ui import 1→2). Client verify green; sitework clean.

---

## 2026-07-25 — One pay engine behind the pay surfaces (phases A–D)

**Done (3 commits).** The four pay surfaces re-orchestrated the hours→money chain
by hand; the full cost-assembly (prevailing, guarantee, leave $, deductions, net)
lived inline in the invoice route only and had drifted. New
`server/utils/payStatement.js` is now the single assembler:
- `buildPayStatement(inputs)` — **pure** (no DB): hours→costs→prevailing→guarantee
  →leave $→deductions→gross/net, cents-rounded so lines reconcile to totals.
- `workerStatement` (one worker) + `companyStatements` (whole company, batched,
  no N+1) feed it. `computeGuaranteeShortfall` lifted out of admin.js into
  `payCalculations.js` (shared).
- Phase B: the **invoice** now flattens a statement into its existing `summary`
  shape (BillPDF/Team Member Report untouched). Phase C: the **overtime report**
  and **payroll CSV** render `companyStatements`.

**Two decided behavior changes** (locked with David):
1. **Prevailing → per-project** (project rate, company fallback) everywhere; the
   invoice moved to match the payroll surfaces. Same worker now costs the same on
   every screen.
2. **Payroll views gained guarantee + net pay**: Total Pay now includes any
   guarantee top-up (unchanged when there's no guarantee); new Min-Guarantee and
   Net Pay (gross − deductions, reimbursements excluded) columns on the report
   table + CSV.

**Latent drift the merge resolved** (all converged onto the invoice's discipline):
report/CSV had a magic `|| 30` rate floor and a `|| 8` threshold floor the invoice
lacked; costs now cents-rounded before summing everywhere.

**Verify:** new `payStatement.test.js` pins reconciliation + per-project prevailing
+ leave % + guarantee + deductions→net + determinism; server 1068, client 255,
i18n parity, build all green.

**Phase D done — pay stubs now priced by the engine.** New `workerPeriodStatements`
fetches the worker's whole span once and prices each pay period via
`buildPayStatement` (no per-period re-query); the pay-stubs route drops its
hand-built settings subset for full `loadSettings`, so it can finally price money.
`PayStubView.jsx` renders server money instead of recomputing it — the old
client-side formula ignored per-project prevailing, OT tiers, night premium, leave
and deductions, so a tiered-OT company saw a different number on the stub than on
the invoice. The stub now also shows sick/vacation pay + deductions + net pay.
⚠️ **Worker-visible:** stub dollar amounts may shift (to the correct, engine
number) — most visibly for companies on tiered OT, per-project prevailing, or with
deductions. All four surfaces now derive from one `buildPayStatement`.

---

## 2026-07-24 — Team Member Reports redesign: interactive, explain-why lines

**Done** (3 commits). Rebuilt Time Clock ▸ Reports ▸ Team Member Reports so a
number is never a mystery: pick a member, generate a period, and click any line
to see exactly which rules and settings produced it.

**Shape.** Members are now compact rows (not cards), one detail panel open at a
time (selection lifted to AdminDashboard). The panel has From/To + preset chips
(**This week · Last week · Last two weeks · Last month**), the **Add Deductions**
and **Add Entries** buttons up top, the generated lines in the middle, and
**preview / CSV / PDF at the bottom**. Weeks are Sun–Sat (matches the app's
default range).

**The explain trace** (the real work — 3 phases):
1. *Engine* (`hoursRules.js`): an opt-in trace. `roundEntriesForPay(ctx.explain)`
   + `applyRules(trace)` record, per entry, only what fired — rounding (from→to +
   which round rule), clip (boundary + rule ids), add/remove-time (the **actual**
   signed paid-minute movement on that line, so a +30 rule that nets +5 says +5),
   auto-break (minutes added). **Invariant, tested:** paid start/end/break are
   byte-identical with explain on vs off; every other pay caller is untouched.
2. *Endpoint* (`?explain=1`): appends per-entry overtime + prevailing notes, a
   `settings_used` block (rate, OT rule/threshold/mult, role, prevailing, Regular
   Shift, sick/vac %, guarantee), and `leave_detail` (per-day sick/vac valuation:
   schedule / rule+id / default / partial). All gated on the flag.
3. *Client*: each entry line expands to plain-English trace; the pay-summary
   lines (OT, sick, vacation, guarantee, deductions) and an "Inputs used" panel
   expand too. Rule text reuses the builder's `describeRule`; every item links to
   where it's set — **Administration ▸ Workspace** for rules/company standards,
   **Team** for a member's pay settings (open-the-screen, no deep-highlight, per
   your pick).

**Judgment calls:** the trace shows the paid-minute effect *on the line* (not the
raw rule credit) so the effect always matches the number; the rule's own
definition still shows via `describeRule`. Deep-link highlighting was deliberately
skipped. Links do a normal route nav (no reload thanks to react-router).

**Perf:** you asked — no measurable hit. The trace is computed only for a single
member on a click (`explain=1`); invoices, payroll, QBO, the worker screen, and
scheduled reports never request it and run exactly as before.

**Verify:** server 1061 + client 255 (+ i18n parity) + builds green; sitework
clean. New `hoursRulesExplain` suite pins the on==off invariant.

---

## 2026-07-24 — Leave pay rate (separate sick/vacation %) + hide presets once rules exist

**Two follow-ups.**

**1. Configurable leave pay rate.** You picked **separate sick % and vacation %**
of base. Two new Company Standards settings — `sick_pay_pct` / `vacation_pay_pct`,
**default 100** (so every existing company is unchanged). Sick/vacation *hours*
are unaffected; only the *pay* scales: `hours × rate × pct/100`. Applied through
one shared helper (`paidHours.leaveRateMultipliers`) at all three cost surfaces
(worker invoice, payroll/overtime-report, worker-hours CSV). Pay-stubs endpoint
is hours-only (no dollar lines) so it needed no change. The invoice PDF's "Sick
Pay (…/hr)" label now shows the **effective** rate (base × pct), carried as
`sick_rate`/`vacation_rate` in the summary, so an 80% line doesn't misreport the
per-hour figure. Negative percents clamp to 0 (never a credit).

**2. Presets hidden once rules exist.** The Honduras/US/California/Off preset
buttons **overwrite** the Standard Rules — a stray tap would wipe a configured
policy. They now show only when the rule list is empty (`form.rules` and
`form.roleRules` both empty); build any rule and they disappear, reappear if you
clear back to none. Role sections were already preserved across a preset apply;
this just removes the foot-gun entirely once there's something to protect.

**Verify:** 1049 server tests (new `leaveRateMultipliers` unit cases) + i18n
parity + client build green; sitework clean.

---

## 2026-07-24 — Time Off Value: schedule-driven, partial days, sick + vacation

**Done.** Reworked the sick-pay feature (below) into a general **paid-leave**
engine covering **sick AND vacation**, valued **schedule-first**, with **partial
days**. Sick and vacation each show as **their own line** (hours + pay) on the
invoice PDF. Supersedes the "Sick Day Value" entry below — same `sick_value` rule
type id (kept, to avoid churning saved policies), now surfaced as **"Time Off
Value"**.

**How a full leave day is valued now (precedence):** the worker's **scheduled
shift hours** that day → the **Time Off Value rule** for that weekday → the
company **Regular Shift** default (new setting, defaults 8). This is the fix
David asked for: *"scheduled 4 hours and calls out sick → they only get four."*
The schedule wins over the rule.

**Partial days:** new nullable **`hours`** column on `time_off_requests`
(migration `0148`; NULL = full day, N = pay exactly N). Worker enters it on a
single-day sick/vacation request; admin card + worker card show `2 h` instead of
the day count.

**Rule now carries `applies`** (`sick` | `vacation` | `both`, default both) — a
dropdown on the rule. So "Mon = 9h sick, but vacation = 8h" is expressible. The
engine filters the weekday fallback by the request's leave type.

**Centralized valuation** in `paidHours.computeWorkerLeave` (single worker) /
`computeCompanyLeave` (whole company, 2 queries) → both call
`payCalculations.computeLeaveHours(requests, shiftsByDate, rules, regularShift,
from, to)` returning `{ sick, vacation }`. Replaced the old
`sickHoursForPeriod`/`loadSickByUser` helpers everywhere. All **4 pay surfaces**
now carry sick **and** vacation (worker invoice, pay-stubs, payroll data,
worker-hours CSV — CSV gained Vacation Hrs / Vacation Pay columns).

**Judgment calls (overrule me):**
- Kept the internal rule type id `sick_value` rather than renaming to
  `time_off_value` — a rename would need a policy migration for any saved rule
  and touches the contract test; the label is decoupled and reads "Time Off
  Value" everywhere. If you'd rather the id match, say so.
- **Fixed a latent edit bug** while in there: editing a saved `min_daily` or
  `sick_value` rule showed the *default* hours, not the saved value (the engine
  stores `hours`, the input binds `minHours`/`sickHours`). Now mapped back on
  edit. Pre-existing since those rules landed; unrelated to leave but one line.
- Leave still pays at **base rate**, its own category, never feeds OT or project
  labor. `total_hours` stays worked-only (sick/vacation/guarantee shown as
  separate lines that sum into the displayed total).

**Verify:** 1048 server tests + i18n parity + client build green; sitework clean.
New `applies`/partial/schedule-precedence cases in the `sickValue` suite.

---

## 2026-07-24 — Pay Rules: Sick Day Value (approved sick time-off, paid by weekday)

**Done.** New **`sick_value`** rule type: an approved sick day is now paid a
per-weekday number of hours (e.g. Mon+Thu = 9h, Fri = 8h = two rules), as **its
own "Sick" line**. **The big thing this bridges:** sick time-off was recorded but
**never touched pay** — approved `sick` requests were just dated ranges. Now the
pay pipeline reads them and values them.

**Design (locked with David up front):** *source* = approved `sick` time-off
requests (reuse the PTO system — nothing new to enter); *representation* = a
separate Sick line, not folded into regular hours.

**Engine:** `sickRulesFromSettings` / `sickRulesByRoleFactory` (role-aware) pull
the `sick_value` rules; `sickHoursForPeriod(requests, rules, from, to)` expands the
approved ranges into days (clipped to the period, de-duped so overlaps don't
double-count) and values each by the matching rule (max if several; **no rule for a
day → 0, i.e. unpaid**). Paid at **base rate**, its own category — never worked
hours, never feeds OT.

**Wired at the 4 worker-pay surfaces**, each adding `sick_hours`/`sick_cost` and
folding sick pay into gross (so it flows to net/deductions): worker invoice (the
money stub), worker pay-stubs (a **sick-only period now shows a stub** — the empty
guard was relaxed), the payroll data endpoint, and the worker-hours CSV (new Sick
Hrs / Sick Pay columns). **NOT** the project bill / project labor cost — a sick day
isn't project labor. `total_hours` stays worked-only, mirroring how the weekly
guarantee is treated.

**UI:** `sick_value` in the rule-type dropdown + an hours editor, using the shared
weekday `when` selector; summary + EN/ES strings. New `sickValue` test suite; the
builder-contract type list updated. 305 pay/hours tests + i18n parity green.

---

## 2026-07-24 — Time Clock: a clocked-in supervisor lands on Workforce

**Done.** On a **plain** landing at `/timeclock` (no `#tab` / `#wf-` link), a user
who is **clocked in** and holds **both** the personal clock and Workforce now opens
straight into the **Workforce** group instead of their own clock — a supervisor
who's already punched in usually comes back to watch their crew, not to re-clock
themselves.

**Approach (revised, `cd1af3f` → this):** first pass decided the default *after*
`/clock/status` resolved, which flashed the personal view then flipped it. Reworked
per David to a **cached clocked-in flag** (`tc_clocked_in` in localStorage): the
Dashboard keeps it in sync with the clock state, and the Personal/Workforce default
is read from it **synchronously at mount** (`landingGroup()`), so there's no flash.
Start on the personal clock at login; once clocked in, later Time Clock visits open
Workforce; cleared on **clock-out** (self-heals a stale flag when the status
reloads) and on **logout** (fresh login starts personal). An explicit `#tab`/`#wf-`
link or a manual toggle is never overridden, and `effectiveGroup` still guards
anyone who can't see Workforce.

---

## 2026-07-24 — Hours & Rules: Minimum Daily Hours can pay without a clock-in

**Done.** A `min_daily` rule now has a **"Requires clock-in"** checkbox. Default ON
= today's behaviour (reporting-time pay — a floor only on days actually worked).
Turn it OFF and the minimum is **guaranteed on the rule's applicable days even with
no clock-in** ("guaranteed hours").

**The gate David asked for** (his refinement of the scope question): when clock-in
isn't required, a second control — **the worker must have clocked in "that week"
vs. "anywhere in the pay period"** — decides whether an empty day is paid. A window
with *zero* activity is never paid, so a fully-absent worker/week/period earns
nothing. It only fills *empty* days; worked days are unchanged.

**Engine** (`payCalculations.computeOT`): takes an optional pay-period `range`.
After the normal per-day bucketing, it walks the applicable days in the range with
no worked bucket and, if the week/period gate passes, adds the floor as **regular
hours** (same as the existing short-day floor — no OT). No `range`, or
requiresClockin=true → byte-identical to before. Threaded through `computePaid`.

**Wired the range at the four worker-pay-for-period sites** so the stub and the
payroll can't disagree: worker pay-stubs, worker invoice, payroll export, and
worker-hours export. **NOT** the project bill / project metrics / `laborCostCents`
/ QBO paths — a no-clock-in guaranteed day isn't attributable to a project, and
those read project cost or OT only. Extra guard for free: the export queries are
`u.active = true`, so terminated workers can't collect the guarantee.

**Judgment call — no line item for the empty days.** Guaranteed no-clock-in hours
fold into the summary *regular hours* with no per-day line (there's no entry to
show), exactly like the existing floor already tops a short day beyond its punch. A
labelled "guaranteed hours" line on the stub is a nice follow-up for clarity, not
correctness.

Verified: 320 server tests (new `minDailyNoClockin` suite + all pay/hours suites
green — backward compat), i18n parity (7), client build, sitework clean.

**Follow-up — two more qualifying gates.** The no-clock-in dropdown now also offers
**"every weekday that week"** and **"every other day that week"**: an empty day D
is guaranteed only if the worker clocked in on the OTHER days of D's week — every
weekday (Mon–Fri) except D, or every day except D (e.g. guarantee Sunday only if
Mon–Sat were all worked). These are per-day gates in `computeOT` (`weekDaysOf`);
they're hidden in the builder when the rule applies **Every Day** (only sensible
for specific days), and `formToRule` coerces the value away if that happens. 324
server tests (+4 gate cases) green.

---

## 2026-07-23 — Storm + Roof: opened for purchase through billing

**Done.** Flipped both `STORM_SELLABLE` and `ROOF_SELLABLE` to **true** in
`BillingPanel.jsx` — both add-ons now appear in billing for purchase. Also closed
the two gaps that "sellable" exposed:

- **Storm→Takeoff dependency** (Storm is dead without Takeoff, so selling it alone
  is a broken purchase). Added the guard everywhere Takeoff→Plan Room already had
  one: server `/checkout` + `/addon` (`code: 'takeoff_required'`), the manage-list
  "needs Takeoff" gate + message, and the Storm checkbox now pulls Takeoff (+ Plan
  Room) in. Dependency chain is now enforced end to end: Plan Room ← Takeoff ←
  Storm, and Plan Room ← Roof.
- **Roof standalone buy** — roof is now in the "buy without a plan" flow (a roof
  card before the buy-alone button, added to `picks`, its checkbox pulls Plan Room
  in), so the two-door "Plan Room + Roof" standalone door actually completes a
  purchase, not just the one-click add for existing subscribers.

⚠️ **Two things still gate real go-live — David is turning sale ON knowing both:**
1. **Stripe price IDs must be set** or the buy cards stay hidden (they're gated on
   `plans?.x?.monthly_price_id`): `STRIPE_PRICE_ROOF` (David is renaming from
   `_ROOFING`) and `STRIPE_PRICE_STORM`, each + `_ANNUAL`, pointing at the real $40
   / $20 prices. Roof also needs **migration 0147** run on stage/prod.
2. **Neither add-on's math is verified.** These flags were the "don't sell until the
   math is checked on a real one" gate (Storm's utility/excavation math; Roof's
   scale-from-aerial + report). Turning them on sells unverified output — flagged;
   David's call. Set either flag back to `false` to pull it without losing owned
   companies' management.

Verified: stripe/auth tests (45), client build, sitework clean.

---

## 2026-07-23 — Roof Measurement: billing plumbing + two-door standalone sale (staged off)

**Done.** Made `addon_roof` a real, sellable add-on — a faithful clone of
`addon_storm` — plus the "two-door" UX so it can be bought standalone (without
Takeoff). **Staged behind `ROOF_SELLABLE = false`**, so it's a one-flag flip once
the math's verified. Price **$40/mo** (decided earlier). Design of record:
`docs/plans/roof-measurement.md`.

**Backend (mirrors storm end-to-end):**
- Migration **0147** — `addon_roof` boolean on `companies`. ⚠️ **run on stage/prod.**
- `buildSessionUser` selects + returns `addon_roof` (→ `tc_addons`, which the
  tool-app already read).
- Stripe (`routes/stripe.js`): `ADDON_PRICES.roof`, `/plans` + `/status` include
  roof, `/checkout` + `/checkout-addon` accept it, and **all three webhook
  handlers** map `STRIPE_PRICE_ROOF[_ANNUAL]` → `addon_roof`. Roof is in
  `STANDALONE_ADDONS` (sellable without a base plan, unlike storm) but **requires
  Plan Room** — enforced in all three checkout paths, like Takeoff.
- `requirePlanToolsAddon` also passes on `addon_roof`, so a roof owner can save via
  `/api/takeoffs`.
- SuperAdmin PATCH + list + a toggle row; `.env.example` + 4 new stripe test cases.

**Two-door tool-app UX** (Plan Room `?v 72 → 73`):
- Re-gated the roof draw tools `tb-takeoff` → **`roofwork`** (`has-roofwork` =
  takeoff **or** roof), so a roof-only owner (no takeoff) can trace.
- **Door A** — a `📐 Roof Measurement` button (`.roof-door`) that shows only for a
  roof owner **without** takeoff; a takeoff owner reaches roof via the trade
  dropdown (Door B) and never sees the button. For a roof-only owner, the takeoff
  chrome is already auto-hidden (it's `tb-takeoff`).
- **`?roofsolo=1` dev override** — since exempt/trial read *both* flags true, Door A
  wouldn't show for David; this forces the roof-only view (hides takeoff chrome) so
  he can preview it. `?roofsolo=0` clears it.

**Judgment call — naming:** the Stripe env is **`STRIPE_PRICE_ROOF`** (matches
`addon_roof` and the `STRIPE_PRICE_<x>`→`addon_<x>` pattern of every other add-on).
David had made `STRIPE_PRICE_ROOFING` first; we agreed `_ROOF` is the consistent
name, so he's renaming the env var.

⚠️ **To flip it on:** (1) point `STRIPE_PRICE_ROOF` (+ `_ANNUAL`) at the real $40
Stripe price; (2) run migration 0147 on stage/prod; (3) verify the math on a real
roof; (4) set `ROOF_SELLABLE = true` in `BillingPanel.jsx`. All verified green:
stripe addon tests (22), auth/superadmin (27), client build, `node --check`,
sitework clean.

---

## 2026-07-23 — Roof Measurement mode in Plan Room (EagleView-style report) — MVP prototype

**Done (prototype).** A new **Roof Measurement** mode inside Plan Room — trace a
roof on an aerial, get a branded measurement report (squares, per-facet pitch &
area, edges by type, penetrations, waste). The EagleView/Hover play; incumbents
charge **$20–100 per report**. Plan + full design: `docs/plans/roof-measurement.md`.

**The big finding that made this small:** Plan Room's roofing trade pack *already*
contains the entire roof engine — `slopeFactor`/`hipValleyFactor`/`edgeFactor`/
`planeSquares`/`edgeFt`, `roofingTotals()`, per-facet pitch, the plane/edge/item
draw tools, edge types (eave/rake/ridge/hip/valley) and penetrations. Scale-from-
image and image ingest already work too. So this was **not a new engine** — it's a
new *deliverable* (the report) + new *packaging* (its own add-on) on top of
geometry that already ships. Built the way Storm/Utility was: a mode gated by an
add-on flag, not a forked tool-app.

**What shipped:**
- **`roof` add-on gate** (mirrors `storm`): `AuthContext` writes `roof:
  !!user.addon_roof` into `tc_addons`; `hasRoofAddon()` + `ROOF_ON` + a `has-roof`
  body class; `roof-only` CSS. Until a backend `addon_roof` + Stripe price exist,
  it shows for **exempt/trial only** — build-hidden, like `STORM_SELLABLE`.
- **`roofmeas` mode** registered additively across the ~10 hard-coded per-trade
  spots (TRADE_TOOLS, PANEL_IDS, TRADE_PANEL, setTrade class+hint, syncPanelButtons,
  the trade dropdown, CSS). It **reuses the roofing draw tools verbatim** — the
  `.tr-roof` CSS now shows in `trade-roofmeas` too — so zero new draw code.
- **The report:** `renderRoofReport()` + a printable, branded one-pager
  (`printing-report`, reusing the letterhead/branding machinery). Total roof area
  (w/ waste), base area, per-facet table (plan SF · pitch · squares), edges LF by
  type, penetrations, uncalibrated-sheet warning. Live-refreshes via
  `markupsChanged()`.
- Plan Room `?v=70 → 71` (both tags).

**Judgment calls:**
- Reused the roofing trade's tools rather than giving `roofmeas` its own toolbar,
  so the mode currently inherits the **`has-takeoff` gate** — i.e. today it needs
  the Takeoff layer too. Fine for the prototype (exempt users see everything);
  decoupling for a truly standalone roof add-on is deferred (in the plan).
- Every mode-registration edit is **additive** (a new line beside each existing
  trade case, never a change to one) — those lists have "drifted" before, so this
  keeps existing trades byte-identical. Verified `node --check`, client build,
  sitework clean, 11 original trades untouched.

⚠️ **Go/no-go before productizing** (in the plan): prove **scale-from-aerial
accuracy** and the **report** on a real roof.

**Follow-up (`<pending>`) — per-edge pitch fixed (the multi-pitch gap):** each roof
edge now carries its own `pitch` — rake/hip/valley prompt for it at draw time
(default = main pitch, Enter keeps it); eave/ridge/flashing lie flat and don't ask.
`edgeFt` uses `m.pitch`, falling back to the global `state.roofPitch` for edges
saved before the change, so **multi-pitch roofs are now correct and old projects are
byte-identical**. This also improves the existing roofing-takeoff bids (same
`edgeFt`). Plan Room `?v 71 → 72`.

⚠️ **To sell it:** backend `addon_roof` column + Stripe price + a `BillingPanel`
entry + a sellable-gate (mirror Storm's `STORM_SELLABLE`). None of that exists yet.

---

## 2026-07-23 — Two new trade tools: Voice-memo → Daily Log, and Bilingual Crew Cards

**Done.** Asked "what other tools would trades find handy?", shortlisted the
un-built ones into the roadmap, and built the top two. Both reuse existing
infrastructure — no new engines.

**1. Voice memo → Daily Log** (a second output on a recording, like Minutes):
- `POST /recordings/:id/daily-log` — clones the Minutes route with a jobsite
  prompt (Summary / Work completed / Crew / Materials & deliveries / Equipment /
  **Delays, issues & blockers** / Weather / Safety / Action items). Same strict
  grounding as Minutes (transcript-only, keep speaker labels, don't invent).
- Stored on the recording: `daily_log_md` / `daily_log_at` (**migration 0146**),
  same 1:1 rationale as minutes (0140). A recording can hold both.
- UI: "Make daily log" button beside "Turn into minutes" in `TranscriptionTool`,
  green result box, persists across reload. Transcription tab retitled "Voice
  transcription, minutes & daily logs" so trades find it.
- **Judgment call:** built as a sibling action on a recording, not a separate
  upload pipeline — Minutes already set that precedent and duplicating the
  R2/AssemblyAI flow would've been wasteful. A full per-project daily-log *ledger*
  (dated history, not just generation) is a bigger feature, parked.

**2. Bilingual Crew Cards** (new **Crew Cards** tab):
- English task notes → clean Spanish (or bilingual) task card. `POST /office/
  crew-card` (`CREW_CARD_SYSTEM`) + `CrewCardTool.jsx`, same text-in/markdown-out
  shape as the Summarizer.
- **Default is bilingual** (Spanish + English in parens) on purpose: it lets the
  foreman verify the translation against their own words — that trust is why
  they'll use it instead of guessing. Toggle to Spanish-only for the printout.

Both inherit the existing gating for free: Business plan + `module_tools` on, and
the shared **300 AI-requests/month** meter (`runAi`). Model is Haiku (same as the
other office tools). Client build + server `node --check` green; sitework clean.

⚠️ **Migration 0146 must run on stage/prod** before the daily-log button works
there (the generate call writes `daily_log_md`; until the column exists it 502s —
transcription/minutes are unaffected).

⚠️ **Neither prompt has seen real input.** The daily-log prompt has never run on a
real jobsite memo, and **the crew-card Spanish has not been checked by a native
speaker** — worth one real pass each before leaning on them. (Same caveat that's
open on the Red-Flag Scanner and Meeting Minutes prompts.)

**Roadmap:** both moved to "Already built"; **Snap-a-receipt job costing** (OCR →
expense line) is now the top un-built trade tool, with Photo→punch-list, SOW
generator, portable cost book, and the MEP trade-engineering calcs behind it.

---

## 2026-07-23 — Legal footer on the sign-in / sign-up pages + single-source entity name

**Done.** Groundwork for forming a business entity (LLC). Two things:

- **`LegalFooter`** on the Login and Register pages: `Terms of Use (EULA) · Privacy
  Policy` links + a `© <year> OpsFloa` line. Surfaces the legal docs on the public
  entry pages (good hygiene), independent of any entity decision. Reuses the
  existing `registerAgreeEula` / `registerAgreePrivacy` i18n keys — no new strings.
- **`client/src/legal.js` → `LEGAL_ENTITY`** — the entity name now lives in **one
  place** (currently `'OpsFloa'`). When the business is registered, changing that
  one constant updates the footer everywhere.

**Judgment call — did NOT touch the EULA/Privacy body.** David said "go ahead" on
wiring the entity name into the docs, but he hasn't registered a name yet. I won't
invent a legal entity name and drop it into a legal document, so the doc-body swap
(`OpsFloa` → the registered name in the EULA/Privacy intro + contact lines) is a
one-line edit **waiting on the real name**. The footer is the part that's safe now.

**Context (advice given, not code):** David is US-based; the Honduras angle is a
*customer*, not a foreign operation, so this is a plain US-LLC decision, not a
cross-border one. Reminded him the EULA names **Texas** governing law — if he
forms/lives elsewhere, that clause should match his state. Not a lawyer; not advice.

---

## 2026-07-22 — Signup: real clickwrap acceptance (Terms + Privacy) with an audit trail

**Done.** `f397e6b`. In response to a "what do I need for legal cover?" question:
the EULA + Privacy pages were real, substantive docs (dated 2025-03-21, Texas
governing law, warranty disclaimer, liability cap) — but **nobody was recorded as
having agreed to them**, so acceptance couldn't be proven. Now:

- Register form has a **required** "I agree to the Terms of Use (EULA) and Privacy
  Policy" checkbox (links to `/eula` + `/privacy`); Create is disabled until ticked.
- `POST /auth/register` **enforces** `accepted_terms === true` server-side and
  **records** it (new `legal_acceptances` table, migration 0145: user_id,
  company_id, version, context, ip, accepted_at) in the same transaction as the
  account, stamping `LEGAL_VERSION` (`'2025-03-21'`) + the registration IP.

**What this does NOT cover — flagged for a lawyer, out of scope for code:**
- The **payroll/tax liability** disclaimer is the biggest gap. OpsFloa computes
  hours/OT/deductions across HN + US; the EULA has a generic "as is" but no
  explicit "not a payroll provider / tax advisor; you're responsible for pay
  accuracy & compliance." That's document language a lawyer should add.
- Privacy Policy should list **sub-processors** (Stripe, Intuit, Resend,
  Cloudflare, Neon) and address **employee geolocation** consent.
- **Worker invite** acceptance (only the owner accepts today), business entity /
  E&O insurance — all still open, none are code changes I can make blind.

⚠️ **Migration 0145 must run on stage/prod** before register / the gate work there
(both insert into `legal_acceptances`). The `needs_terms` check is wrapped so a
missing table can't block login, but the gate won't function until the table exists.

**Follow-up (`3ca6309`) — re-prompt gate + doc improvements (the "all of it" pass):**
- **Re-prompt gate:** `GET /auth/me` returns `needs_terms` (no acceptance row for
  the current `LEGAL_VERSION`; super-admins exempt; wrapped so a missing table
  never locks login out). New `POST /auth/accept-terms` records it. Client
  `TermsGate` is a blocking modal in `App` — **existing accounts and invited
  workers** must accept on next login (they have no acceptance row, so the gate
  catches them automatically; no backfill needed).
- **Privacy Policy:** named sub-processor list (Stripe, Intuit, Resend, Cloudflare,
  Neon, Vercel/Render) + an employee-location section.
- **EULA:** new "Customer Responsibilities; No Payroll, Tax, or Legal Advice"
  section — the payroll-liability gap I flagged, as a **plain-English draft for a
  lawyer to finalize** (I am not one).
- Bumped `LEGAL_VERSION` + both doc dates to `2026-07-22` so the accepted version
  matches the revised content. When the lawyer revises further, bump both again →
  the gate re-prompts everyone for the finalized version.

Still open (not code): worker-invite flow doesn't *separately* capture acceptance
(the login gate covers workers instead), business entity / E&O insurance, and a
real lawyer review of all the above language.

## 2026-07-21 — Plan Room: Join op → connect / extend / weld / pan

**Done.** Plan Room `v64 → v65` (plus `v63` fix: the side panel now re-renders on
page change, so a refresh no longer needs a checkbox toggle to show the page's
markups).

Reworked the **Join** edit-op into a fluid endpoint interaction on open lines:
click a loose end to **connect** (ring + rubber-band); then a plain click on empty
space **lays a point** (extends that end), a plain click on another loose end
**welds** them (or closes the loop); hold-drag on empty space / another shape
**pans**. Enter / double-click / Esc finish. The click-vs-drag decision is deferred
to pointerup (reusing the pan drag mode), which is what lets a drag pan without
laying a point.

**Follow-up (`v68`/`v69`): context-aware cursor.** The pointer now signals what a
click will do — a **draggable point** shows a compact custom 4-arrow move glyph
(so it reads smaller/different from the shape **body**, which uses the system
`move`), `pointer` over a clickable/weld target, `copy` to add a point,
`crosshair` to place/cut/remove, `grab` on empty. Computed each pointermove (cheap
checks first, all-markup hit test only when hovering elsewhere); gated to
select+points so draw tools keep the crosshair.

**Follow-up (`v67`): Shift+Enter closes the loop + finishes.** Welds the current
end to the shape's other end (a closed loop) and finishes — the closing
counterpart to plain Enter. Works in an extend session and while drafting; needs
≥3 points, else it just finishes.

**Follow-up (`v66`): tap-to-join in the Move op too.** A motionless quick tap on a
loose end connects (green ring); a second motionless tap on a matching end welds
them (close a loop / merge two lines). Any movement, or a press held > 300ms, is a
normal vertex Move — dragging still repositions the point. Since the join tap has
no movement the point is untouched, so the weld is one clean undo step. (This is
the "tap, no drag" variant the Join op's click-to-weld doesn't cover.)

**Judgment calls (couldn't runtime-test a tool-app UI, so worth a real click-through):**
- Scoped the *first* interaction (extend/pan) to the **Join edit-op**; the Move op
  gets only the lightweight tap-to-join. Dragging an endpoint in Move still
  reshapes as before.
- In Move, you **connect with the first tap** (the user's spec presupposed being
  "connected" but didn't say how) — select a line, tap one end, tap the other.
- **Finish** = Enter / double-click / Esc (matches the drawing convention); each
  laid point is its own undo step. There's no separate "cancel and discard the
  whole extension" — Esc just stops, and Ctrl-Z peels points back.
- Weld keeps the existing rule: the two lines must be the **same type**.
- The old two-click Join (`handleJoin`) is superseded; left in place, now unused.

## 2026-07-21 — Plan Room: earthwork side menu — visibility eyes + all-pages toggle

**Done.** Plan Room `v61 → v62`. Two additions to the dirt/earthwork side menu:

- **Eye icon on every header + subheader** (Contours, Takeoffs, and each type/
  material subgroup) that toggles whether that group draws **on the plan**. White
  eye = shown, dark gray = hidden. Hooks the existing `markupShown` via a new
  `dirtHidden` set keyed the same way as the panel groups (`shapeVisKeys`), so
  hiding "Gravel areas" or "Existing contours" declutters the canvas without
  deleting anything. The eye stops propagation so clicking it doesn't also fold
  the header it sits in.
- **"Show markups from all pages" checkbox** above the lists. Off (default) = only
  the current page's shapes, as before; on = every page's, each off-page row
  tagged `· p<N>`. It's a **list** filter only — the plan still draws the current
  page (this is the replacement for the scrapped "red eye / cross-page" idea).

**Scrapped from the original ask:** the red/cross-page eye state — the checkbox
covers that need for the list instead.

**Edge case handled:** if you hid a subgroup while 2+ types existed, then deleted
the others (making it flat, so its subheader disappears), the hidden key would
otherwise be stuck with no eye to undo it — the flat branch now clears that key so
the section eye stays authoritative.

**Call:** visibility is keyed by group, not by page, so hiding "Gravel areas"
hides them on whatever page you're viewing (they're the same group). And the
alignment **Ghost** overlay still shows the other sheet's contours even when
hidden — it's a deliberate alignment-preview, left as-is. Say the word if either
should change.

planroom files only (sitework untouched); `node --check` clean. No automated test
for the tool-app UI — worth a manual pass: toggle an eye and confirm the group
vanishes from the plan; check the all-pages box and confirm off-page shapes list
with a `· p<N>` tag.

## 2026-07-21 — Tools: retired the Sitework Takeoff tab (hidden, not deleted)

**Done.** `ecf816b`. Plan Room replaces the Sitework Takeoff tool, so its tab +
card are now hidden in Tools via a single `SHOW_SITEWORK = false` flag in
`ToolsPage.jsx`. Hidden for **everyone**, including companies that own the Takeoff
add-on; legacy `#sitework` / `#excavation` deep links fall through to Plan Room on
the existing redirect.

**Reversible by design, and nothing deleted:** flip `SHOW_SITEWORK` to `true` to
bring the tab back (still add-on-gated), and the `/tool-apps/sitework/` files are
untouched. ⚠️ One caveat: this hides it from the Tools **menu**, but the static
tool still answers at its direct URL (`/tool-apps/sitework/index.html`) if someone
has it bookmarked — deleting it later is what closes that off. Didn't touch the
Takeoff **add-on** billing/entitlement or the `Sitework` calculator group (asphalt
/ aggregate / slope) in Calculators — those are separate.

## 2026-07-21 — Plan Room: earthwork side menu — current page only, grouped/collapsible

**Done.** Plan Room `v59 → v60`. The dirt/earthwork side menu's shape lists
(Contours + Takeoffs) now (1) show only shapes **on the current page** — the
contour list was surface-scoped but pulled every page; takeoffs weren't filtered
at all — and (2) organize shapes into **collapsible per-type/color subgroups**,
each with its own ▾/▸ header, swatch, and count.

**Calls I made on the grouping:**
- **Contours / Spots / Pads** group by *type* (a contour's color is its elevation,
  so the swatch stays per-row; grouping by color there would fragment into one
  group per elevation).
- **Takeoffs** group by *type + material/color* — so gravel areas and asphalt
  areas (different colors) are separate collapsible groups, each keeping its Σ
  subtotal. This is the "/color" half of the request where color actually maps to
  a material.
- Groups default **expanded**; a `Set` of collapsed keys remembers folds for the
  session (not persisted to the file — cheap, and avoids schema churn).
- **Follow-up (`v60 → v61`):** when a section resolves to a single type/material
  group, the subheader is dropped and the rows render flat — no more "Contours (N)"
  echoing "Existing contours (N)" right above it. Subheaders only appear once
  there are 2+ groups to organize.

Gotcha handled: storm-pipe labels contain a double-quote (`18" hdpe`), which would
break a `data-` attribute — group keys are URI-encoded in the DOM and decoded on
click.

Client-only, planroom files only (`git status` clean on `sitework/`). `node
--check` passes; there's no automated test for the tool-app UI, so this wants a
quick manual look: open a multi-page set, confirm the menu only lists the current
page's shapes and that each type/material subheader folds.

## 2026-07-21 — Pay stubs: deductions (gross → net), Social Security & anything else

**Shipped.** Server `e29027a`, client `a814fcc`. Employees' pay output can now
show deductions and a **Net Pay** figure. There was **nothing** for this before —
every pay surface was gross-only (`hours × rate`), and the one `cp_compute_
deductions` toggle was a dead experimental stub.

**What I built, and the call behind it.** You picked a **configurable %/fixed
list**, not an auto tax engine — so a deduction is just a name + either a percent
of gross wages (optional cap) or a flat amount. That's deliberately **not** a tax
calculator: it applies the rates you enter, your accountant reconciles the exact
figures. It's the right call for a shop in Honduras (IHSS/RAP as flat %, plus
whatever else) and it's why that old auto-deductions toggle was never finished —
real bracket math is a payroll-processor job.

Two sources, both live:
- **Company-wide list** — Administration → Company Settings → **Payroll
  Deductions**. Applies to everyone. Stored as a JSON setting exactly like the
  hours-rules policy; empty = no deductions, so nothing changes for a company that
  never touches it.
- **Per-employee extras** — on each worker's card in Team (the same place you
  generate their bill), a **Deductions** section for loans, advances, garnishments.
  New `worker_deductions` table (migration **0143**), applied on top of the
  company list.

The per-worker **pay PDF** (the "Employee Time Invoice" you already download per
worker) now reads **Gross Wages → each deduction (−) → reimbursements (+) → Net
Pay** whenever deductions exist. Reimbursements are added back to net, not
deducted from — they're expense repayments, not wages. Currency follows the
company setting, so a Honduras stub prints "L" with no extra work.

**Judgment calls worth knowing:**
- **It lives on the existing per-worker pay PDF**, not a brand-new document — you
  said "put it wherever you like," and that PDF was already the de-facto pay stub.
- **Per-worker deductions are additive** (extras on top of the company list). True
  per-worker *exemption* from a company deduction isn't in v1 — say the word if a
  worker needs to be carved out of, say, the company SS line.
- The worker's **on-screen** pay view (`PayStubView`) still shows gross only — I
  focused on the printable stub you asked for. Adding net there is a fast follow
  if you want it.

⚠️ **Migration 0143 must run on stage/prod before this works there** — the
per-worker table. (Given the earlier stage hiccup, worth a glance that the
nightly migrate ran clean.) The company-wide list works off settings alone and
needs no table.

⚠️ **Not yet run through a real payslip.** The gross→net math is unit-tested
(11 cases: percent/cap/fixed, per-worker merge, net = gross − deductions +
reimbursements, empty = no-op). Full server suite **1016 green**, client build +
i18n parity + smoke green. Before it promotes, generate one real stub with a
couple of deductions and confirm the net matches by hand.

## 2026-07-21 — Hours & Rules: time-window multiplier (weekend-premium schedules)

**Shipped.** `320174e`. New rule type **Time-window multiplier** (`window_mult`):
hours worked inside a day-of-week + clock-time window are paid at a set multiple
of base *regardless of the overtime threshold*. Your example is now buildable as
three rules — Sat 05:00→19:00 @1.25×, Sat 19:00→Sun 05:00 @1.5×, Sun 05:00→Mon
05:00 @2× — and is the first test in the suite. Windows wrap past midnight (end ≤
start → next day; end = start → a full 24h), so a single rule spans two calendar
days.

**The call that shapes the money — I picked "governing," not "stacking."** These
multipliers **replace** the normal OT for the covered hours: a weekend hour is
priced *exactly* at the window rate, and those hours are **carved out of the
daily/weekly OT calc** — they don't count toward the 8h/40h threshold and they
don't get an OT multiplier layered on top. That's what makes "Saturday is 1.25×"
mean 1.25×, full stop, even on a 10-hour Saturday. The alternative reading —
"pay whatever OT they'd normally get, *plus* the window premium on top" — would
make that same hour 1.25× only when it isn't also OT, and more when it is. I went
with governing because your numbers are a complete schedule, not a bonus. **If
you actually wanted stacking, say so — it's a different calculation.**

Two smaller things worth knowing:
- **Window hours show up in the "overtime hours" column**, because they ride the
  same premium-band machinery as rest-day / 7th-day pay. They're premium hours,
  not regular — just labeled OT on reports.
- **Overlap → highest multiplier wins that minute; a break never inflates
  premium hours** (the covered total is capped at the paid duration). And
  `window_mult` is independent of rest-day / 7th-day / minimum-daily rules — if a
  day is somehow covered by both, it gets split rather than double-counted. Odd
  to configure both on one day; documented, not blocked.

No window rules configured → the engine is byte-identical to before (proven; the
long-break negative-hours quirk still pins). Full suite **1005 green**, client
build + i18n parity + smoke green. `docs/db-enums.md` documents the type.

⚠️ **Not yet run through a real invoice.** The math is unit-tested against your
schedule, but before this promotes past dev I'd generate one real weekend bill
and eyeball that the premium lands where expected.

## 2026-07-21 — Hours & Rules: per-role rules (Standard Rules + Role Rules)

**Shipped.** Two commits: `9638ff1` (engine + UI + i18n), `0195879` (pay-site
sweep). "Rules" is now **Standard Rules**; a new **Role Rules** section lets you
give any role its own rule list, with a per-role checkbox to **add on top of**
the Standard Rules or **replace** them (default: add on top — your call from the
chat). Roles without a section keep the Standard Rules. A policy with no role
rules is byte-identical to before (proven by test).

**The subtle part was that pay config was never actually per-worker.** Overtime
config was resolved **once per request** for the whole company, and the `ctx`
plumbing that could carry per-worker data was **dead in production** (only tests
ever populated it). So this wasn't "add a field" — it was standing up
`workerRoleById` + a memoized `otConfigByRole(role_id)` at **14 separate money
paths** (worker invoice, project bill, project metrics, OT report, payroll
export, worker-hours export, certified payroll, 4 QuickBooks paths, pay-stubs,
the weekly email; project spend/WIP inherit it through the shared labor query).
The risk that matters: **a missed site silently pays that role by the Standard
Rules.** Mitigated by funneling every site through the same three helpers and
keeping the no-role code path unchanged — but it's why this went out as its own
reviewable commit.

**Judgment call worth knowing about:** three of the paths — QuickBooks time push,
the QBO payroll journal, and certified payroll (and the lean worker-hours CSV) —
**only round hours; they don't compute tiered OT at all today**, by their own
existing design. I threaded role into their *rounding* (so a role's clip/break/
add-time rules apply) but **did not** newly teach them tiered/role OT. That keeps
them consistent with how they already treat the *company* OT config (they ignore
it too). If you'd expect a role's OT tiers to reach a QuickBooks push or a
certified-payroll form, say so — that's a deliberate line I drew, not an
oversight.

Size cap on the `hours_rules` setting raised 8 KB → 40 KB (role lists multiply
it). `docs/db-enums.md` updated (roleRules shape + cap). Full server suite **992
green**, client build + i18n parity + smoke green.

⚠️ **Not yet exercised with a real role override end-to-end.** The math is
unit-tested, but before this promotes past dev I'd spot-check one real pay path
(e.g. a project bill) for a worker in a role that overrides OT, to confirm the
number changes where expected and nowhere else.

## 2026-07-16 — Email bounce suppression: reconnected, and made reversible

**Fixed.** `458d920`. Resend bounce webhook + two ways to undo a suppression + a
banner so it's visible at all.

**Correction to how I reported this to you:** I called it a fresh find. Half of
it wasn't. My own note from **2026-07-02** — the day of the Resend migration —
read *"Follow-up not yet done: sendgridEvents.js is now inert; wire Resend
webhooks to restore bounce tracking."* **It sat for 14 days** while the app kept
mailing dead addresses. Nothing resurfaced it, because a follow-up recorded only
in a private note has no owner and no date — it isn't tracked, it's just
remembered. That's what `docs/BACKLOG.md` is for, and it should have gone there
on 2026-07-02. It has now.

The note also only caught half. It knew the webhook was inert. It did **not**
know that nothing ever cleared the flag — the half that strands real people.

**The bug was two bugs pointing opposite ways.** `email.js` skips any recipient
whose `users.email_bounced_at` is set — sensible, that's how you avoid burning
sender reputation on dead addresses.

1. **The column's only writer was a SendGrid webhook, and email moved to
   Resend.** So it took no new data. Every bounce since the migration went
   unrecorded and the app kept mailing addresses it had already been told were
   dead. The route didn't break — it just never heard from anyone again, and
   nothing was watching for silence.
2. **Nothing anywhere cleared the column.** Three references existed repo-wide:
   the read, the write, the migration. **So anyone flagged during the SendGrid
   era was suppressed forever** — no invite, no password reset, no notification,
   no symptom an admin could see. Their mail simply stopped. A worker whose
   mailbox was full for one afternoon in the SendGrid era is, today, still
   unreachable and there was no way to fix it short of editing the database.

The second is the one that actually hurts people, and it's the one that reads as
a smaller bug.

**Found — the migration promised the visibility and it was never built.**
`0075_email_bounce_tracking.sql` says its *"primary use is visibility: admins can
see which worker emails are broken."* The columns were never returned by any
endpoint or rendered by any component. That's why this was invisible for months:
the feature that would have surfaced it was the half nobody finished.

**Calls made:**
- **Only a `Permanent` bounce suppresses.** Resend also reports `Transient` (full
  mailbox, greylisting) and `Undetermined`. Treating those as fatal would silence
  a real person because their mail server had a bad afternoon — and, before the
  clear paths, would have done it permanently. Asserted in the tests.
- **`services/emailSuppression.js` now owns every read and write of the column.**
  The read and the write living in separate files that knew nothing about each
  other is precisely how the matching rule drifted out of sync for months. One
  owner, one rule: by address, case-insensitive (`users.email` is UNIQUE, so an
  address is exactly one row).
- **Changing the address clears the flag; an unrelated edit doesn't.** The
  obvious fix for a bounce is to correct the typo, and that silently didn't work
  — the flag rode along and the new address was skipped too. But the worker PATCH
  carries the whole form, so clearing whenever `email !== undefined` would lift
  every suppression the moment someone edited a pay rate. It clears only on an
  actual change, via a `CASE ... IS DISTINCT FROM` against the pre-update row.
- **Kept `/api/sendgrid-events`, marked deprecated.** It can't be proven dead
  from the repo, and it isn't mine to delete on a guess. It now shares the same
  marking helper. Delete once Render confirms nothing posts to it.
- **Verified the signature check against the real SDK rather than stubbing it.**
  Worth it: `resend.webhooks.verify()` takes its own `{id, timestamp, signature}`
  object, **not** the `Headers` global its type name implies. Getting that wrong
  fails closed — every bounce silently rejected, which is the exact bug being
  fixed here, wearing a different hat. The tests sign real payloads and cover
  tampering and replay.

⚠️ **Not done until you set `RESEND_WEBHOOK_SECRET`.** Create the webhook in
Resend → Webhooks → `https://<server>/api/resend-events`, events `email.bounced`
+ `email.complained`, then paste the signing secret into Render. Until then the
route 503s: the code is live but deaf.

⚠️ **Worth checking:** whether any prod rows have `email_bounced_at` set. Anyone
who does has been unreachable this entire time, and the Retry button now frees
them.

---

## 2026-07-16 — GC: COI / document expiry tracker

**Shipped.** `9ee0a2f`. Sub documents now alert before they lapse (30 days) and
again, louder, once they have. Daily job + a banner on the Subs page.

**Found — the data was already there and doing nothing.**
`subcontractor_documents.expires_on` has existed since migration `0107`. It
appeared in exactly four places: the migration, the destructure, the INSERT, and
one label on the sub's own page. **No index, no query, no cron.** Every
customer's COI expiry dates have been collected and never read — a sub's
insurance lapsed silently and you found out when something went wrong. The
tracker isn't new capability so much as making collected data do its job.

**Found — I shipped a route-shadowing bug and caught it.** `/subcontractors/
compliance` was declared *after* `/subcontractors/:id`. Express matches in
declaration order, so `:id` swallowed it and tried to load a subcontractor whose
id was the string `'compliance'` — a Postgres error on an INTEGER column, a
**500 not a 404**, and invisible until someone opened the page. Moved above
`:id`, commented so it can't drift back, and pinned with a test asserting `:id`
never sees it.

**Found — `db-enums.md`'s inbox-type list had drifted.** It was missing
`equipment_rental_due` and `bid_due`, both already in use. Verified by grepping
every `createInboxItem` call site. Exactly the drift that doc predicts for an
unconstrained column.

**Call made — it warns, it doesn't block.** An expired COI does **not** stop a PO
being issued to that sub. Blocking is arguably the real value ("he can't be on
site") but it's a hard gate on a flow that already works. ⚠️ Your call.

---

## 2026-07-16 — Meeting minutes from a recording

**Shipped.** `d8b8553`. A "Turn into minutes" button on a finished transcript →
Summary / Decisions / Action items with owners / Open questions, saved on the
recording. Migration `0140`.

**The point: it connects two things that already existed but had never been
introduced.** Transcription (diarized, with editable speaker names) and the
Claude backend. You could already do this by hand — copy the transcript, paste
into the Summarizer. **And that paste is exactly what breaks it.** The transcript
*knows* Mike said it; flattening to text throws that away and the model guesses.
Building the prompt server-side from the utterances + speaker names is the whole
edge: "**Mike:** order rebar — by Monday" instead of a vague bullet.

**Calls made:**
- **Un-named speakers fall back to "Speaker A"** (David's suggestion — it was
  already the behaviour, but his question surfaced that blank-but-present names
  weren't handled, and made me tell the prompt to *keep* those labels rather than
  invent a name. A wrong name on an action item is worse than no name.)
- **Extracted the AI meter to `services/aiGate.js`.** It was private to
  officeTools, but the monthly quota is per *company* across every AI feature —
  a second copy would mean two counters disagreeing about one limit.
- **This is the first AI output OpsFloa persists.** The office tools are
  deliberately paste-in-read-out. Minutes are different in kind: a recap you
  can't find next week isn't minutes. The recording already stores its transcript
  anyway.
- **No usage badge on the Transcription tool** — transcription runs on
  AssemblyAI, not the AI budget, so a badge there would imply transcribing burns
  AI calls. The minutes panel states the cost at the point of decision instead.

⚠️ **Untested against a real meeting.** The prompt's quality is unknown until one
runs through it. Needs `ANTHROPIC_API_KEY`.

---

## 2026-07-16 — GC tools: planned, not built

**Why nothing shipped.** "GC tools" is a heading in the roadmap brainstorm, not a
feature — **~30 ideas across 7 categories**. So: surveyed the codebase, wrote
`docs/plans/gc-tools.md`. `c2e6a42`

**Found — three of the six "standouts" are already substantially built.** Lien
waivers (~90%: both directions, public sign flow, PDF), the closeout checklist
(fully built; the *assembler* isn't), and budget-vs-actual. The roadmap still
lists them as to-build — nobody updated it after building them. **Planning without
surveying would have wasted real work.**

**Found — closeout is broken for non-QBO companies, in both directions.**
`project_invoices` is a QuickBooks *mirror*: only `routes/qbo.js` writes it, so a
company without QBO has zero rows. Two checklist items read it —
`final_invoice` counts *paid* invoices → 0 → stuck at `in_progress` forever, so
**those projects can never be closed out**; `retainage_release` sums `balance` →
`SUM` over zero rows is **0** → `0 === 0` → reports **done**, certifying retainage
released on a project with no invoices. **A false negative that blocks and a false
positive that lies.** Filed — it needs the invoice decision first.

**Found — the closeout assembler has nothing to assemble.**
`project_closeout_items` has no document columns at all, despite `0111`'s header
claiming items are "checked off with notes + attached doc". So "as-builts
delivered" is a checkbox with no as-built behind it. Item-level document storage
is prerequisite work, not part of the assembler.

**Fixed in passing:** deleting a recording whose media was already swept threw a
`ReferenceError` **after** the row was deleted — a 500 and no audit row. Two lines.

**Recommendation in the plan — GC is probably not a module.** `module_sales` and
`module_subs` were backfilled by `0118`, never wired, and `db-enums` records them
as orphaned. **The codebase already ran this experiment**: both became tabs. If
GC is monetized it's `addon_gc`, not `module_gc`.

---

## 2026-07-16 — Calculators hub

**Shipped.** `72b4e74`. 12 field calculators, one tab — concrete (slab/footing/
column/wall), rebar grid, asphalt, base, slope, rafter, stairs with IRC checks,
board feet, paint, tile+thinset+grout, ft-in ↔ decimal, area/volume. Pure
client-side: no network, no AI, nothing to meter or gate. Works offline. This was
the roadmap's own idea ("a shared Calculators hub instead of a tab per calc").

**Found — a real float bug, caught by the tests.** `Math.ceil` over a float
product rounds up on **drift**, not quantity: `200 SF × 1.1 waste` is
`220.00000000000003`, so it ordered **221 tiles for an exact 220-tile job** — on
the most ordinary input the tool has. Every bag / tile / pail / riser count was a
`ceil` of a float, so all of them were exposed. Fixed via `ceilQty()`, locked by a
regression test.

**Call made — the math is data, not components.** `calculators.js` is a plain
`.js` file with no React import, so it's testable without rendering; the UI just
renders whatever it's given. Adding a calculator is one array entry. That
separation is the only reason the 40-test suite exists — including totality checks
that **no** calculator returns NaN/Infinity for empty, garbage, zero or negative
input. A field tool that prints "NaN CY" is worse than no tool.

---

## 2026-07-16 — Marketing doc rewrite + Contract Red-Flag Scanner

**Found — the marketing doc understated the product by 8 of its 11 trades.**
`OpsFloa_Features.txt` still described Takeoff as Earthwork + Roofing + Drywall;
it was written the day before Framing, Flooring, ESC, Striping, Siding, Demo,
Fence and Landscape all landed. Rewrote it around the real pitch — a GC takes off
the whole building, a site contractor takes off the whole site, nobody buys a
second seat — split THE SITE / THE BUILDING so a reader finds their trade fast,
and put the $60 add-on next to the $1,500–4,000/seat/yr the incumbents charge for
usually one trade. Also documents Storm/Utility, which the doc had never
mentioned. `e629cc0`

⚠️ **Pricing is now a live question.** $60/mo was set when Takeoff was 3 trades.
It's 11. Left as-is (land-grab pricing is defensible and raising later beats
lowering), but it should be a decision rather than an oversight.

**Shipped — Contract Red-Flag Scanner** (`8ed2520`), one of the two ad standouts
in the roadmap. Upload a subcontract → the terms that carry real money, worst
first, each with the clause quoted and the edit to negotiate.

**The prompt is the product.** It *names* the clauses that cost subs money —
pay-if-paid, notice windows, no-damage-for-delay, LDs, broad-form indemnity,
retainage release, termination for convenience, open-ended scope, written-CO
requirements, backcharges, one-way consequential waivers, venue/fee-shifting —
rather than asking for "anything concerning" and hoping. Grounding mirrors the
Doc Q&A prompt: quote the document, never invent. **A hallucinated clause is
worse than a miss** — someone would go negotiate over language that isn't in
their contract.

**Built on the existing engine, not beside it.** `/office/extract` is reused
unchanged (unmetered, no API key needed), and the new route goes through the same
`runAi()` wrapper as `/ask` — so auth, the business-plan gate, the monthly meter,
refund-on-failure and the 503/429/502 contract all came free. No migration, no
env var, no client gating. It draws on the same 300/month per-company AI budget.

**Calls made:**
- **Scanning is a separate click from upload.** The ad line is "upload it and
  we read it", but scanning spends a metered call — the doc bar lets you confirm
  you grabbed the right file first. One extra click beats burning quota on a
  misclick.
- **A truncated read says so loudly.** The server clips at 120k chars; a scanner
  that quietly reviewed half a contract and reported it clean would be worse than
  no scanner, so the clipped case gets a warning banner, not a footnote.

**Found — two things fixed in passing.** DocQA and Summarizer had *byte-identical*
markdown renderers; the scanner would have made three, so it's extracted to
`aiMarkdown.jsx` (Summarizer's heading margin normalises 14px → 12px). And
DocQA's drop zone claimed **"the file stays in your browser"** — it doesn't, the
bytes are POSTed to `/office/extract`. What's true is that nothing is *stored*,
so it says that now. That's a privacy claim, so it shouldn't have been loose.

---

## 2026-07-16 — Landscape & Irrigation trade pack (L1–L3, complete)

**Shipped.** The **11th** trade — `landscape` (🌳) — and the **last of the
takeoff-siblings list** in `project_tool_roadmap`. Four tools: ▢ areas → SF by
type → CY / SY / tons / lbs · ❋ plants → EA by type · ≀ irrigation runs → LF ·
⊛ heads, valves, controller, backflow → EA.
`cbd3f57` · plan: `docs/plans/landscape-irrigation-pack.md`

**Call made — this pack bids in the material's own unit, unlike the last four.**
Striping, demo and fencing all bid an installed $/unit with materials as a
panel-only cost basis, because those trades quote that way and billing the
material again would double-charge. **Landscape doesn't work like that**: mulch is
bought and sold by the **CY**, rock by the **ton**, sod by the **SY** — quoting
mulch per SF would be the unnatural choice. So here the materials math *is* the
bid, and there's no double-count exposure because each area type yields exactly
one line in exactly one unit (asserted). Seed is the exception — seeding is quoted
per SF, so it bids by SF with the lbs shown as the buying number.

**Call made — depths are per type.** A 3″ mulch bed and a 6″ soil-prep bed on the
same plan are normal, so one shared depth would be wrong on any real job. The test
asserts the bed lands at exactly 2× the mulch CY.

**Verified** against the real functions lifted out of app.js: 1,000 SF mulch @ 3″
= 9.26 CY · 1,000 SF rock @ 3″/100 lb/ft³ = 12.5 tons · 900 SF sod @ 5% waste =
105 SY · 5,000 SF seed @ 5 lb/1000 SF = 25 lb with the bid qty staying 5,000 SF ·
each type one line in its own unit · rolled-up SF flows into the CY · plants and
heads roll up at their own rates · no phantom lines · empty `state.landscape`
still computes. 51/51 kinds registered in `hitMarkup`, `MK_LABEL`, `MK_ICON`.

**Correction — I'd been miscounting the trades.** I called this the 12th; it's the
**11th**. Roofing(1) Earthwork(2) Drywall(3) Flooring(4) Framing(5) ESC(6)
Striping(7) Siding(8) Demo(9) Fence(10) Landscape(11) — verified against
`TRADE_TOOLS` and the `#tradeSel` dropdown, both of which say 11. The off-by-one
started at siding and rode along through demo, fence and landscape. The plan docs
and this log are corrected; **the commit messages for siding / demo / fence /
landscape still say 9th / 10th / 11th / 12th** and can't be rewritten now that
they're pushed — the docs are the source of truth on the count.

⚠️ **Needs David:** hard-refresh — cache-bust **v41**.

---

## 2026-07-16 — Fencing & Guardrail trade pack (F1–F3, complete)

**Shipped.** The **10th** trade — `fence` (🚧), in the $60 Takeoff add-on, no own
SKU. Another trade riding the same site plan that already gets an Earthwork / ESC
/ Demo takeoff. Tools: ⌗ runs → LF + posts by type (8 types) · ⊓ gates &
guardrail end treatments → EA, plus a post-concrete cost basis.
`e815bc9` · plan: `docs/plans/fencing-guardrail-pack.md`

**Call made — posts count per run, and this is the entire pack.** Every run needs
a post at **both** ends, so it's ⌈LF ÷ spacing⌉ + 1 evaluated **per run**.
Summing the LF first and computing once is the obvious shortcut and it's wrong:
two 50-ft runs at 10 ft are 6 + 6 = **12** posts, not ⌈100/10⌉+1 = **11**. The
error compounds — a 20-run job comes out **19 posts short**, plus their concrete,
and nothing about the number would look wrong. The test asserts 12 and explicitly
fails on 11.

**Call made — spacing belongs to the fence type, not the project.** Chain link
runs at 10 ft, vinyl privacy at 6, W-beam guardrail at 6.25 (the standard). A
single project-wide spacing setting would be wrong on every mixed job.

**Pattern worth naming — the installed-price trap, now the third time.** `$/LF`
for fence already includes posts, rails, fabric and concrete, so the post count
and its concrete are a **panel cost basis and never bid lines**. Same call as the
striping pack's paint gallons and demo's haul-inside-the-unit-price. All three
are now *asserted* in tests rather than just commented, so a later change can't
quietly re-introduce a double-charge. Gates genuinely are quoted on top of the
LF, so those do bid.

**Verified** against the real functions lifted out of app.js: 12 posts not 11 ·
20 × 50 ft = 120 posts · vinyl at 6 ft = 18 posts and $42/LF not chain link's $18
· guardrail at 6.25 ft = 17 posts · 12 holes at 10″ × 30″ = 1.36 CF each → 0.61
CY → 37 bags · empty `state.fence` defaults hold · a zero-length run yields no
posts. 47/47 kinds registered in `hitMarkup`, `MK_LABEL`, `MK_ICON`.

⚠️ **Needs David:** hard-refresh — superseded by **v41** (landscape pack).

---

## 2026-07-16 — Demolition trade pack (D1–D3, complete)

**Shipped.** The **9th** trade — `demo` (💥), in the $60 Takeoff add-on, no own
SKU. Finishes the sitework suite: a site contractor now takes off demo, cut/fill
and the ESC plan for one job in one tool, same buyer and same plan set. Three
tools: ▣ areas → SF by type → debris CY, tons, truck loads · ⌁ linear removals →
LF by type · ⊠ items & structures → EA by type.
`1731a20` (D1) · `a0f2aa2` (D2–D3) · plan: `docs/plans/demolition-pack.md`

**Call made — buildings and pavement convert completely differently, and this is
the whole pack.** A **building is mostly air**: footprint × height is nonsense —
a 1,000 SF house is not 444 CY of debris, it's the walls, roof and floor. So
buildings use an empirical **CY per SF of footprint** (wood ≈ .25, masonry ≈ .45,
steel ≈ .20 — steel lowest because the frame goes to scrap, not the pile), with
bulking already in the factor. **Pavement is solid**: thickness → in-place CY →
*then* swelled, because broken concrete and asphalt bulk ~40–60% once ripped.
Three consequences worth knowing:
- Hauling the **un-swelled** volume under-books trucks — 92.6 vs 138.9 CY on the
  test job, four fewer loads.
- Swell must **not** touch buildings, or the bulking double-counts. The test
  asserts building CY is identical at 0% and 100% swell.
- **Tons come off the in-place volume, not the swelled one** — swell moves air,
  not weight.

**Call made — removals and items don't feed the CY pile.** Linear removals and
item removals are quoted with haul *inside* the unit price, so they're excluded
from the debris CY and the load count; counting them would bill the same hauling
twice. The test asserts CY and loads are unchanged by adding 500 LF of curb and
10 trees, so a later change can't quietly reintroduce it.

**Call made — `truckCap` is demo's own setting**, not `state.earthwork.truckCap`.
Same trucks in real life, but coupling them would mean editing the earthwork
setting silently re-prices the demo bid. ⚠️ Overrule this if you'd rather have
one number for the job.

**Verified** against the real functions lifted out of app.js, including the edges
that ship silently wrong: `truckCap: 0` yields finite loads, not `Infinity`;
empty `state.demo` falls back to the documented defaults; concrete uses its own
6" not asphalt's 3"; same-type areas roll up. 45/45 kinds registered in
`hitMarkup`, `MK_LABEL`, `MK_ICON`.

⚠️ **Needs David:** hard-refresh — superseded by **v40** (fencing pack).

---

## 2026-07-16 — Siding, Gutters & Insulation trade pack (Si1–Si3, complete)

**Shipped.** The **8th** trade — `siding` (▥), in the $60 Takeoff add-on, no own
SKU. Completes the residential shell: with Framing → **Siding** → Roofing →
Drywall → Flooring, a builder takes off the whole house in one tool. Also reaches
the roofing buyer, since roofers sell gutters. Four tools: ▥ elevations → gross
SF by material (7 materials), ⊡ openings → deduct SF + trim EA, ⌐ gutters →
LF by type, ▩ insulation → SF by R-value → bags.
`0a86f9f` (Si1) · `53f23ff` (Si2–Si3) · plan: `docs/plans/siding-gutters-insulation-pack.md`

**Call made — the net-area trap.** Gross elevation area over-bids every house; on
some elevations the wall is mostly glass. So `swall` traces gross and `sopening`
deducts, and the bid uses **net**. The panel shows **gross / deduct / net side by
side** rather than silently folding the deduction in — the deduct is the number
most likely to be wrong, so it should be inspectable. Openings still bill a trim
& wrap EA on top: an opening removes SF but *costs* money, because cutting siding
around one is more work per foot than the field.

**Call made — how the deduct splits across materials.** Openings aren't attached
to a wall, so the deduction is apportioned by each material's share of gross.
That's **exact** on a single-material job (the common case) and an honest
approximation on a mixed one. Flagging it because it's a real modelling choice,
not a fact: the alternative is making the user assign each opening to a wall,
which is more clicking for a rounding difference. Asserted that the per-material
nets sum back to the total.

**Call made — only batts convert to bags.** Blown and spray foam are bid straight
by SF, so a bag count there would be a meaningless number that looks
authoritative. Batts get bags at the coverage setting; the others don't.

**Verified** against the real functions lifted out of app.js (same method as ESC
and Striping). The worked example: 1,200 SF − 4 windows − 1 door = **1,119 net**
→ 1,230.9 SF at 10% waste → 11.19 squares. Plus the edges that would ship
silently wrong: over-deduction **floors net at 0** with no negative bid
quantities; openings traced before any wall don't divide by zero; mixed materials
split 50/50 and sum back; 1,760 SF R-13 @ 5% = 1,848 SF = **21 bags**; and the
one that matters most with three kinds sharing a totals loop — **gutters and
insulation never leak into the wall area** (gross stays 1,200 with 880 SF of
insulation traced).

**Structural.** 42/42 kinds registered in `hitMarkup`, `MK_LABEL`, `MK_ICON`;
`swall`/`sinsul` in `NEEDS_SCALE` + `CLOSED_KINDS`, `sopening` in `POINT_KINDS`.

⚠️ **Needs David:** hard-refresh — superseded by **v39** (demolition pack).

---

## 2026-07-16 — Parking-lot Striping & Signage trade pack (S1–S3, complete)

**Shipped.** New `striping` trade (🅿) in Plan Room, in the $60 Takeoff add-on,
no own SKU. Pairs with the asphalt paving area takeoff already in Earthwork — the
same site plan that gets a paving takeoff gets a striping plan. Three tools:
⊞ stalls → EA by type with a **separate ADA tally**, ≡ painted runs → LF by type
(4"/6"/8" line, 12" crosswalk, 24" stop bar, hatching), ◆ markings & signs → EA
by type (arrow, ONLY legend, ADA symbol, sign, wheel stop, bollard). Plus a
paint/bead cost basis in the panel.
`47ddf6a` (S1) · `4a70108` (S2–S3) · plan: `docs/plans/striping-signage-pack.md`

**Call made — the double-count trap, designed around rather than papered over.**
Striping is bid **per stall** (the stall price includes painting its own lines)
**or** per LF, not both — so counting a stall *and* tracing its lines charges the
paint twice. So `sstall` counts stalls priced per stall, and `sstripe` is only for
the runs that **aren't** stall lines (stop bars, crosswalks, lane lines,
hatching). The panel says this in bold, because it's the one thing a new user
would get wrong. Same reasoning kept the S3 paint gallons **out of the bid** —
the $/LF and $/EA are installed prices that already include paint. The test now
*asserts* paint never reaches the bid, so a later change can't quietly
reintroduce the double-charge.

**Call made — paint is width-weighted, not raw LF.** A 24" stop bar eats **6×**
the paint of a 4" line per foot, so `stripingPaint()` converts everything to
"4-inch-equivalent LF" before dividing by coverage. Summing raw LF would have
under-counted paint badly on any lot with stop bars or crosswalks — and it would
have looked perfectly reasonable in the panel.

**Verified** the same way as ESC — `stripingTotals`/`stripingPaint`/
`stripingBidLines` lifted **verbatim out of app.js** and run against stubbed
state, not re-implemented in the test. 320 LF of 4" = exactly 1.0 gal · 320 LF of
24" = 6.0 gal · 12" crosswalk = 3× · mixed widths sum to 380 4"-equivalent LF ·
2 coats doubles · 40 standard + 2 ADA + 1 van = 43 stalls / ADA tally 3 · stop bar
prices at its own $2.25 not the 4" rate · ADA stall at $45 not $5 · untraced types
emit no phantom $0 lines · empty `state.striping` still computes.

**Structural.** Registered without repeating the older packs' bugs: `sstripe` in
`NEEDS_SCALE`, `sstall`/`smark` in `POINT_KINDS`, and all three in `hitMarkup`.
Re-audited after: **38/38** kinds present in `hitMarkup`, `MK_LABEL` and
`MK_ICON`.

⚠️ **Needs David:** hard-refresh — superseded by **v37** (siding pack).

---

## 2026-07-16 — Erosion & Sediment Control trade pack (E1–E3, complete)

**Shipped.** New `esc` trade (🌱) in Plan Room, in the $60 Takeoff add-on, no own
SKU. Same buyer and same plan set as the Earthwork flagship — every grading
permit carries an ESC/SWPPP sheet. Three tools: 〰 control runs → LF by type
(7 BMP types), ⊘ point BMPs → EA by type (5 types), ▧ stabilized areas → SF →
stone tons / SY / seed lb + mulch tons. Everything prices into `$ Bid`;
double-click any markup to change its type.
`c1bf94e` (E1) · `022c040` (E2) · `d3234a8` (E3) · plan: `docs/plans/erosion-sediment-control-pack.md`

**Found — flooring & framing markups were completely unselectable.** `e786e0e`.
`hitMarkup()` resolves *both* the select tool and the double-click handler, and
its switch has **no `default:`** — an unlisted kind silently can't be clicked at
all. Seven kinds were never registered: `froom`, `ftrans`, `fwall`, `fopening`,
`fsheath` (the **entire flooring and framing packs**), `dheight`, and `escline`.
So every *"double-click a room to change its material"* / *"double-click a wall
to change its size"* — documented as shipped in the plan docs and promised in the
tooltips — **did nothing**, and those markups couldn't be selected, moved, or
deleted either; only undo removed them. Fixed all seven by geometry; audited
`MK_KINDS` against the switch afterwards → 33/33 hit-testable. Only surfaced
because ESC would have shipped with the same dead double-click.

**Found — the panel close-lists had drifted.** Each of the seven panel toggles
hard-coded its own list of "the others to close", and they'd fallen out of sync
as packs were added: `btnRoof` predates flooring/framing, so **opening Roof left
Framing open**. Replaced all seven with `closeOtherPanels(keepId)` over one
`PANEL_IDS` list. Also fixed CSS the flooring/framing packs missed —
`#floorPanel`/`#framPanel` were never in the panel width rules, so they sized to
content instead of the shared 268px.

**How the math was verified** (David asked for this on Storm, so it was done
properly here): `escTotals`/`escMaterials`/`escBidLines` were lifted **verbatim
out of app.js** and run against stubbed state — *not* re-implemented in the test,
which would only re-derive the same mistakes. 5,000 SF entrance @ 6"/105 lb/ft³ →
131.25 tons / $4,593.75 · 10,000 SF blanket @ 10% → 1,222.2 SY · 43,560 SF →
exactly 1.00 acre → 200 lb seed + 2 ton mulch · 500 SF riprap @ 12" → 26.25 tons ·
rollups hold · empty `state.esc` still lands on 131.25 tons (defaults are real).
`escMaterials()` is shared by the bid and the panel so the two can't drift.

**Calls made.** Three deliberate deviations so ESC didn't inherit the older packs'
bugs: `escline`/`escarea` **are** in `NEEDS_SCALE` (an uncalibrated sheet refuses
the tool instead of silently measuring 0); `escitem` **is** in `POINT_KINDS` (one
click per BMP, not two); rate inputs render only for the area types actually
traced, so an empty panel isn't six numeric fields of noise. The older packs'
equivalents are filed in `BACKLOG.md` rather than fixed in-place.

⚠️ **Needs David:** hard-refresh — superseded by **v35** (striping pack).

---

## 2026-07-16 — Currency: full sweep (a customer's Lempiras showed as dollars)

**The report:** a customer set their profile to Honduran Lempira and amounts came
up as dollars.

**Root cause — not what it looked like.** The currency was always saved
correctly, HNL was always supported, and `settings.currency === 'HNL'` always
reached the browser. The bug was that **only ~10 of ~25 money-render sites ever
read it**. Three separate failure modes: hand-rolled `Intl` pinned to
`currency:'USD'`; literal `` `$${v}` `` concatenation; and a shared
`formatMoney()` whose `currency` option defaulted to USD and which **not one of
its five callers ever passed**. Its own header said it existed so "every page
renders the same way" — the consolidation happened, currency was never wired
through.

**Shipped** (6 commits, `136cbf9` → `7c6d788`): a `useCurrency()` /
`useCents()` / `useMoney()` hook trio off the existing `SettingsContext`, then
every site — the 5 `formatMoney` pages, all 5 PDFs, Inventory, Catalog, Financial
Reports, Dashboard, PayStub, Reimbursements, the 3 public client-facing pages
(currency added to the server payload — they're unauthenticated and can't read
`/api/settings`), and the 2 server-rendered emails (`server/currency.js` is new;
the server had no money formatter at all). Verified at each step: client lint,
212 client tests, 695 server tests, build.

**Found — a near-miss that would have shipped looking fixed but reading wrong.**
Intl takes the currency symbol from the **locale**, not the currency code:
`en-US` + `HNL` → **"HNL 1,234.50"**, `es-HN` + `HNL` → **"L 1,234.50"**.
`formatMoney` pinned `locale:'en-US'`, so binding its currency *alone* would have
produced "HNL 1,234.50" everywhere while the already-correct pages showed
"L 1,234.50". Caught by actually running Intl both ways; fixed at the root with
`localeForCurrency()` so both formatters agree.

**Found — the real scope was ~22 sites, not the ~15 the audit reported.**
Re-grepping after each batch kept surfacing misses: Reimbursements ×2,
PayStubView, InventoryItems/Stock/PurchaseOrders, ManageProjects — plus hardcoded
`$` on **mileage rates**, which keep 4dp and so use `currencySymbol()`
(`formatCurrency` would round $0.6700/mi → $0.67/mi).

**Calls made** — overrule any of these if wrong:
- **`BillingPanel`'s `$20/mo` left hardcoded** — OpsFloa's own subscription bills
  in USD regardless of the customer's currency.
- **`server/currency.js` duplicates the client's locale map** — the two bundles
  can't share a module; commented as a deliberate mirror on both sides.
- **A module-level "active currency" global was rejected** even though it'd be a
  far smaller diff: settings load async, and mutating a module variable doesn't
  re-render a page that already painted, so early renders would keep their dollar
  signs.
- **`docs/db-enums.md`**: added the missing `currency` row and documented the
  sharp edge — the PATCH check is only `/^[A-Z]{3}$/`, so it validates **shape,
  not membership**; `XYZ` saves fine and renders as a bare code. Adding a currency
  means touching **three** places (dropdown + both locale maps). Also dropped the
  stale `label_work` entry.

**Not touched:** the Plan Room / sitework tool-apps still hardcode `'$'` —
sandboxed static HTML with no `SettingsContext` access. Filed in `BACKLOG.md`
with the likely fix (the `tc_addons` localStorage bridge).

---

## 2026-07-16 — Currency: production hotfix (bill PDF)

**Shipped to production** via `hotfix/billpdf-currency` → PR #214 (`66c47aa`).
David asked to ship just this one fix ahead of the sweep.

**The bug:** two mistakes compounding in `BillPDF.jsx`. `fmtMoney` hardcoded
`` `$${v.toFixed(2)}` ``, **and** the component never destructured the `currency`
prop that `WorkerMetrics` had always passed it — so the value was silently
discarded. Net effect: the **screen showed `L 1,234.50` and the PDF printed from
that same screen showed `$1234.50`**. Its sibling `ProjectBillPDF` had it right;
the two had diverged.

**Call made — cut from `main`, not `dev`.** `dev` was **100 commits ahead**, so
merging it would have shipped the entire Plan Room / storm / trade-pack backlog
alongside a one-line fix. The hotfix branch changed exactly one file.
Verified before shipping: eslint, 212 tests, build, and confirmed `BillPDF` is
the file's only component so removing the module-level `fmtMoney` was safe.

**Note:** `gh` CLI isn't installed on this machine, so PRs have to be opened by
hand from the URL git prints on push.

---

## 2026-07-16 — `main` ↔ `dev` had diverged both ways

**Found while preparing the currency sweep.** `dev` was 100 commits ahead of
`main`, but `main` also had ~632 lines `dev` had never received (via `stage`
merges). Back-merged `main` → `dev` (`00898ac`); they're now in sync
(`main not in dev: 0`).

**The conflict resolution was the opposite of the obvious one.** One conflict —
`BillPDF.jsx`. The assumption was that `main` had a `settings`/`workLabel`
feature `dev` was missing. **Wrong:** the merge base already had it, and **`dev`
deliberately removed it** (`e16d6cf`, *"Remove the dynamic work/project label —
hardcode 'Project' everywhere"*), repo-wide. Taking main's side — the reflexive
move — would have silently resurrected `label_work` in the bill PDF after David
had retired it. Kept main's currency fix **and** dev's removal.

⚠️ **Worth knowing:** `dev` still carries 100+ commits unmerged to `main`
(Plan Room, storm, all the trade packs). That's a large release when it goes.

---

## 2026-07-16 — Plan Room toolbar + earthwork panel

**Shipped.** Sheet strip got a "Sheets" header + ✕ close, with a floating ❐ to
reopen (`8ec5f32`). Page-nav + Fit kept as one unit that wraps only when it must
(`7747353`). Toolbar broken into flowing units — undo/redo, the Contour+Area
dropdowns, List/Layers, and the trade/Bid/Export actions each stay together but
wrap independently (`b414bee`). Earthwork panel got its own ✕ + a floating ⛰
reopen button in the canvas's top-right, and the toolbar **Dirt button was
removed** as redundant — the panel already auto-opens on entering the trade
(`8e7b41e`).

**Found — "it didn't seem to take" was a stale cached stylesheet.** The toolbar
is CSS-driven and `styles.css` is cache-busted by `?v=N`; the browser was holding
the old file, so a structural fix looked like a no-op. Worth remembering: **any
Plan Room CSS/JS change needs a version bump *and* a hard refresh**, or it will
look like the change didn't work.

**Call reversed by David:** group-separation spacing was added so the toolbar
units read as distinct groups, then removed at his request — uniform gaps, groups
only separate when the row wraps (`05fe3f1` → `73e78ee`).

---

## 2026-07-17 — Plan Room: elegant dirt markups, no mid-edit "?", movable draft points, draft undo/redo

**Shipped** (`app.js`/`index.html`, cache-bust → **v44**). Four asks off a
screenshot where the boundary (`ebound`) looked crisp but the other earthwork
markups looked heavy.

- **Root of "why isn't it elegant like the boundary":** `ebound` drew with a
  **screen-constant** thin dashed stroke (`lineWidth = 2/zoom`, dash `[12/z,7/z]`),
  so it stays 2px on screen at any zoom. The rest used pen-width (`m.width`, world
  px) that balloons as you zoom in. Pulled the boundary recipe into one helper,
  `dirtOutline(ctx, m, col, {closed, dash, fillAlpha})`, and routed **contour,
  espot, epad, qarea, qline** (and `ebound` itself) through it. Spot elevation is
  now a screen-constant bullseye; contour keeps its existing=dashed / proposed=solid
  semantic, just thin. Fills dialed back to subtle (`0.10–0.18`). **Left qcount
  alone** — it shares one `drawMarkup` case with 11 other point kinds across
  every trade, so making it elegant means splitting that case; deferred as its
  own small task rather than touching a dozen unrelated markers.
- **The "?" clutter:** it's the elevation placeholder from `elevLabel` — a
  contour/pad/spot shows `?` until you type the elevation. Now suppressed while
  **placing** (draft preview, via a `previewing` flag) or **editing** (the markup
  is selected). It returns on a settled, *unselected* markup as a "still needs
  elevation" flag — which is the one time it's actually useful.
- **Movable points while placing a line:** during a click-built draft you can now
  grab any already-placed vertex and drag it (forgiving zoom-aware grab radius);
  vertices render as ring handles so they read as grabbable. Point-count kinds
  (mcount/qcount/…) opt out — each click there is its own marker.
- **Draft point ops in undo/redo:** while a draft is open, Ctrl+Z / Ctrl+Y (and
  the toolbar buttons) step through the draft's **own** point history — add, move,
  Backspace-remove — instead of the committed-markup stack, so you can't
  accidentally unwind a finished markup mid-draw. On commit it collapses to the
  usual single main-stack undo entry.

**Judgment calls:** scoped the elegance pass to the dirt/earthwork + quantity
family (the tool the screenshot was taken in) rather than sweeping all ~45 markup
kinds — annotation tools (arrow/rect/cloud) are *meant* to be bold pen strokes the
user sizes. Canvas render + pointer code has no test harness here, so verified by
reading + `node --check`; the two app.js-lifting jest suites still pass. Worth a
real click-through on stage: grab-a-vertex-mid-draw and Ctrl+Z during a polygon.

---

## 2026-07-17 — Plan Room: hide AI Jump Start, show Company on first open

**Shipped** (`index.html`, cache-bust → **v45**).

- **AI Jump Start button hidden for now** — added `hidden` to `#btnJumpStart`
  rather than deleting it, so its click wiring (`app.js:4177`) still binds and
  it's a one-attribute re-enable when we want it back. All the server/vision
  plumbing stays in place, just no entry point.
- **Company (☁) button now shows before a project is open.** It carried
  `needs-doc`, so first-run showed only 📁 Projects — a brand-new user couldn't
  reach the company library to **copy a set a teammate shared**. Dropped
  `needs-doc`; the library list and copy flow don't need an open doc, and
  "Share current project" already guards the empty case ("Nothing to share yet —
  open a plan set first"). Live Co-Edit keeps `needs-doc` (it does need a doc).

---

## 2026-07-17 — Plan Room: contour elevations keep their precision

**Shipped** (`app.js`, cache-bust → **v46**). Same class of bug as the earlier
scale fix (207.9 → 208): a contour/pad/spot elevation of **197.85 displayed as
197.9** because every elevation label forced a single decimal
(`fmt(m.elev, …? 0 : 1)`).

- The **input** was never the problem — `askNumber` is `step="any"` + `parseFloat`,
  so 197.85 was stored intact; the loss was purely on display.
- Added `elevStr(v)` (mirrors `scaleFeetStr`): shows the value as entered, 3 dp of
  headroom, trailing zeros trimmed, float noise rounded off. Routed all three
  elevation renders through it — the canvas label (`elevLabel`), the markup-list /
  measure text (`measureValue`), and the earthwork panel's contour list.
- Lift-test `server/tests/planroomElevFormat.test.js` guards it (197.85, 812,
  812.5, 812.125, below-datum, float noise).

---

## 2026-07-17 — Live Co-Edit: start-without-R2-CORS fallback (investigation paused)

**Shipped one resilience fix; investigation paused mid-stream at David's request.**

- **Going live no longer hard-depends on R2 bucket CORS.** `uploadDocToR2` does a
  direct browser→R2 presigned PUT, which throws if the bucket has no CORS for a
  browser PUT — and unlike shared takeoffs, the live-session create had **no
  base64 fallback**, so a CORS gap meant no session could start at all. Now
  `goLive` tries the presigned PUT and, on failure, hands the PDF up as base64;
  the server (`liveSessions` POST, new `pdfBase64` branch → `uploadBase64`) stores
  it. Added a `/api/live` 64 MB body cap (matches `/api/takeoffs`) so the base64
  body isn't rejected by the 20 MB global. Joiners already read the PDF via base64,
  so live now works with or without R2 CORS. Safe either way — the fallback only
  fires when the fast path fails. Cache-bust → **v47**.

**Investigation state (for when we resume).** David's clarified symptom: a host
starts a session, teammates **see** it in ☁ Company, but clicking to join
"starts a session for them — doesn't look like the same session." Ruled out:
response compression (none), CORS origin allow-list (frontend origins are
listed), multi-instance room-sharing (no scaling config → single Render
instance, so the in-memory `rooms` map should be shared). Leading hypotheses,
untested: **(a)** teammates click the ✨ Live Co-Edit toolbar button (which always
*starts* a new session) instead of ☁ Company → "Join live", spawning a parallel
room — the button has no join affordance; **(b)** the join connects but the
live-bar roster/state gives no visible proof, so a working session *looks*
separate; **(c)** a silent SSE failure on the cross-origin EventSource leaves the
joiner with only a static local copy. Next step when resumed: make the connection
state visible + offer "join the running session" when one exists before starting a
new one. Also noted but not applied: the shared `doc` includes `page`, so any
participant's page-flip yanks everyone (bidirectional) — a separate bug.

---

## 2026-07-17 — Plan Room: side-menu section for area/line/count takeoffs

**Shipped** (`app.js`, cache-bust → **v48**). Root of David's "proposed areas
don't show anywhere / should they not be contours?": he was doing a **surfacing
takeoff** (paving areas by type) with the **▨ Area takeoff** tool. Those areas
*do* render on the sheet, but the Earthwork panel only had a **Contours** section
(the cut/fill grade surface) — there was **no list for the takeoff quantities**,
so they looked missing. Area/line/count takeoffs (`qarea`/`qline`/`qcount`) carry
no existing/proposed surface by design; they're bid quantities, not grade.

- New collapsible **Takeoffs (N)** section in the earthwork panel, between
  Contours and Earthwork. Groups items by type (**Areas / Lines / Counts**), each
  row = color swatch + the item's measured value (e.g. "▨ Concrete · 1,704 SF") +
  ✎ reconfigure + ✕ delete; click a row to select & jump to it. Empty-state hint
  explains these price into the **$ Bid** and are separate from the cut/fill
  contours.
- `reconfigureTakeoff(m)` re-opens the same area/line/count config form used when
  drawing (and when double-clicking on the canvas); applied as one undo step.
  Reuses the generic `selectContourById`/`deleteContourById`.

Did **not** add per-material SF subtotals yet (mixing area modes/units + deducts
makes a single total misleading) — offered as a follow-up. Also reverted an
earlier exploratory change (dual existing+proposed surface sections) at David's
request: the page/side-menu still follow the surface toggle.

---

## 2026-07-17 — Plan Room: hollow deduct areas + per-material takeoff subtotals

**Shipped** (`app.js`, cache-bust → **v49**).

- **Deduct areas draw hollow** — a `qarea` with `cfg.deduct` now renders outline-only
  (fillAlpha 0) instead of a heavier fill, so it reads as a hole cut out of the
  filled additive areas around it. Additive areas keep their subtle 0.12 fill.
- **Per-material subtotals in the Takeoffs section** — `takeoffSubtotals(kind, items)`
  rolls each group up by material/type: **Areas** net out deducts within the same
  material+unit (uses `computeAreaResult().quantity/unit`, matching the per-item
  labels), **Lines** sum length (+trench CY) per pipe/line type, **Counts** sum
  items per type. Rendered as `Σ <material> · <total>` rows under each group. So a
  surfacing job now shows total SF per pavement type once materials are assigned
  (all-default areas roll into one "Σ Area" line).

The broader "global toggle to turn off all colored fills (Layers)" David floated
earlier is still open — not built; the deduct-hollow change covered the immediate
need.

---

## 2026-07-17 — Plan Room: Layers → "Shape fills" toggle (outline-only mode)

**Shipped** (`app.js` + `index.html`, cache-bust → **v50**). New **Shape fills**
checkbox in the ◫ Layers menu (default on) — uncheck it and every filled area
shape draws outline-only, no colored inside. Follows the same pattern as the
existing "Value labels" toggle: a `layers.fills` flag checked at draw time.

Gated fill sites: `dirtOutline` (qarea / pad / boundary), the shared area case
(measure area + froom/fsheath/escarea/swall/sinsul/dmarea/lsarea), roof `plane`,
and `dceiling`. Strokes/labels always stay — only the translucent interior is
dropped. Left **un**gated on purpose: the highlighter (an annotation with no
outline — hide it via the Annotations layer) and the ghost-sheet overlay.

---

## 2026-07-17 — Live Co-Edit: join-aware button, backup poll, visible status, page fix

**Shipped** (`app.js`, cache-bust → **v51**) — the resume of the "join lands in a
separate session" investigation. Four changes, targeting all three standing
hypotheses at once so the next test is conclusive:

1. **✨ button is join-aware.** Clicking Live Co-Edit with no active session now
   first checks for a session already running for the company and offers **Join it
   / Start a separate one** (via `askChoice`). The old button *always* started a
   new room, so a teammate who clicked it spun up a parallel session — the most
   likely "we're not in the same session." Joining otherwise lived buried in
   ☁ Company.
2. **REST backup poll.** The SSE stream is a cross-origin `EventSource` (Vercel →
   Render); if a proxy buffers/blocks it the joiner silently gets no pushes. New
   `livePollTick`/`livePollPull` pull `GET /live/:id` every 4 s **only while the
   stream isn't delivering** (`!session.connected`), flushing local edits first,
   so co-edit stays in sync even with a dead stream. ~free when SSE is healthy.
3. **Visible connection status.** Live bar now shows 🟢 Live / 🟡 Live · backup
   sync / 🔴 Reconnecting… (`refreshLiveStatus`, driven by `session.connected` +
   `syncedAt`). Turns a silent failure into a visible one — and tells us on the
   next test whether SSE is actually the culprit.
4. **Push retry + page fix.** `sessionPush` now commits its `lastSync`/`docHash`
   baseline **only on a confirmed push**, so an edit made during a blip re-pushes
   instead of being lost (and then clobbered by the poll). And `applySessionDoc`
   no longer applies `d.page` — participants scroll independently; the join still
   lands you on the host's page once. (Bidirectional page-yank was a real bug and
   would have been amplified by the poll.)

Base64 start fallback from the earlier session is already in (v47). Still not
built: cursor/presence beyond the name roster.

---

## 2026-07-17 — Live Co-Edit: "End for all" actually closes it now

**Shipped** (`liveSessions.js` server + `app.js` client, cache-bust → **v52**).

- **Root cause of "End for all doesn't close it":** the end handler's host check
  was `room.meta.hostUserId !== req.user.id` with **no `String()` cast** (the
  company check right above it *does* cast). For a room rehydrated from the DB
  after any Render restart/deploy, `hostUserId` is the DB type and `req.user.id`
  is the JWT type — bare `!==` 403s the **real host**, and the client swallowed
  the failure, so the session stayed `active` and joinable. Fixed to
  `String(...) !== String(...)`.
- **Client no longer swallows the failure:** `endOrLeave` checks `res.ok`; if the
  close didn't confirm, it says so ("may still be open — reopen ☁ Company and hit
  End"). Refreshes the company list after ending.
- **End from the list:** `GET /live` now returns `can_end` (host or admin), and
  live rows in ☁ Company show an **End** button — so a lingering/abandoned session
  (host closed their tab; the sweep only reaps after 2 h idle) can be closed
  straight from the list. `endSessionFromList` tears down the local session too if
  you're in it.
- **Joining an ended session** (`404`) now says "That session has already ended"
  and refreshes the list instead of a raw HTTP error.

Note: abandoned-session sweep is still 2 h (`liveSessionSweep`, `*/15`); the End
button is the manual remedy rather than making the sweep more aggressive.

---

## 2026-07-19 — Reports: per-day Overtime column, admin-toggleable (default on)

**Shipped** (server + client). New company setting **`report_daily_ot_column`**
(default ON) controls whether the daily line items on reports carry an Overtime
column. Toggle lives in **Administration Workspace → Company Settings → Overtime**
(only shown when overtime is enabled — the column is meaningless otherwise).

- **Setting:** added to `FEATURE_KEYS` + `SETTINGS_DEFAULTS` (`true`). A brand-new
  key with no stored rows, so it defaults ON for every company with **no backfill
  migration**, and the existing `/admin/settings` PATCH allowlist picks it up via
  `FEATURE_KEYS` automatically.
- **Per-entry OT:** the reports listed *total* hours per line but split reg/OT
  only in the summary. New `annotateEntryOvertime()` in `payCalculations.js`
  mirrors `computeOT`'s day/week bucketing and fills regular chronologically, so
  **the line-item OT column always sums to the summary OT** (override / rest-day /
  7th-day / min-daily / prevailing all handled). Lift-tested against `computeOT`
  across daily/weekly/override/prevailing — 18 assertions. The two data endpoints
  (`GET /admin/workers/:id/entries`, project bill) annotate their entries.
- **Reports wired:** `BillPDF` (Employee Time Invoice) + `ProjectBillPDF` (Project
  Bill) render the OT column gated on the setting × overtime-enabled; the
  WorkerMetrics **CSV export** got the column too, for consistency. i18n:
  `ratesOTColumn`/`Desc` + `pdfOvertimeCol` (EN/ES, parity test green).

**Judgment calls:** scoped "reports" to the two bill/invoice PDFs with daily line
items (+ the CSV) — deliberately did **not** touch `CertifiedPayrollPDF` (a
regulated WH-347 layout). Setting is a `settings` key/value row, not a fixed-value
DB column, so `docs/db-enums.md` doesn't apply. Verified: client build, 161 server
tests (admin+pay+settings), i18n parity.

---

## 2026-07-19 — Hours & Rules: edit an existing rule (was add/delete only)

**Shipped** (client). The rule list in `HoursRuleBuilder` only had a delete (×)
per row — to change a rule you had to delete and rebuild it. Added an **Edit**
button per row that loads the rule back into the draft editor; the save button
then reads **Save changes** and commits in place (replace-by-id) instead of
appending a copy.

- A stored rule only carries the fields its type uses, so `edit()` merges it onto
  a `blankRule()` (filling the rest, keeping its id + `when`/`trigger`). `commit()`
  now replaces when the id exists, appends otherwise — one path for both flows.
- Row Edit/Delete buttons hide while a draft is open (no editing/deleting
  mid-draft). No engine change — `coerceDraft` is reused verbatim, so the
  builder↔engine contract test still passes (124 hours-rules tests green).
- i18n `hrEdit` / `hrSaveRule` (EN/ES, parity green). Also: report OT column now
  uses normal text color, not red (per feedback).

---

## 2026-07-19 — Hours & Rules: clearer Add-Time labels + schedule fallback

**Shipped** (server + client). David couldn't read the Add-Time controls, and the
rule was blocked without a Start/End Time rule. Fixed both.

- **Labels** (i18n EN/ES): "How often" → **"Add it once, or repeatedly?"** (options
  *Once, at a set time* / *Repeatedly (a ladder)*); "Measured from" first option
  "The start/end time rule" → **"Their pay schedule"**; hint reworded.
- **Schedule fallback (behavior).** Add/Remove Time with base=schedule no longer
  *requires* a Start/End Time rule. The engine already fell back to the worker's
  scheduled hours (`resolveExpected`: shift → worker → company standard hours) —
  the block was purely `validatePolicy`, which is now a no-op. So a bare
  "add 30 min past 5:25" measures from the **scheduled end**. **Safety:** with no
  Start/End rule AND no schedule for the day, the rule is now a **no-op** (was a
  flat add onto the raw punch — the 5:51→6:51 nonsense David flagged). Below-rung
  late punches clip to the scheduled end, same as an End-Time-rule baseline.
- **UI de-blocked:** the red "needs a baseline" error → a soft FYI hint, Save no
  longer disabled, Add/Remove Time type options no longer disabled, top banner
  reworded to informational.
- Tests: updated `hoursRulesList` (no-op, not punch-add) + the builder contract
  (allowed + measures-from-schedule + no-op); 141 hours/pay tests green, 274
  admin+hours+pay green, i18n parity green.

**Note for David:** for a scheduleless day the rule intentionally does nothing —
workers need scheduled hours (company/worker standard hours or a shift), or a
Start/End Time rule, for "add time" to actually apply.

---

## 2026-07-19 — Hours & Rules: migrate fixed slots into custom rules — Phase 1 (Punch Rounding)

**In progress** (David chose the full phased migration of the baked-in sections —
rounding, tiered OT, premiums — into the custom-rule builder). Phase 1 shipped:
**Punch Rounding is now a when-scoped custom rule.**

- **Engine** (`hoursRules.js`): new `round` rule type `{edge:in|out|both,
  reference, direction, intervalMin, graceMin}` + `when`. In `roundEntriesForPay`
  the per-edge rounding config is resolved from matching `round` rules (later wins)
  and falls back to the global `policy.rounding` — so existing policies are
  byte-identical, and a `round` rule can target one edge / certain days, incl.
  `direction:'off'` to *turn rounding off* on some days. The rounding math
  (`roundEdge`) is untouched.
- **Builder**: `round` type with edge / how-to-round (nearest, worker-favor,
  company-favor, off) / interval / grace / measure-against (Schedule Time vs wall
  clock); plain-English summary; coerce. i18n EN/ES (~26 keys).
- **Tests**: `hoursRulesRound.test.js` (both edges, edge-scoped, off-override,
  backward-compat, parse/defaults) + contract type-parity updated. 133
  hours-rules tests green, client build + i18n parity green.

**Phase 2 shipped — tiered Overtime as when-scoped rules** (the deep one, in the
`computeOT` cost engine). New `ot_tier` rule `{basis:day|week, afterHours, mult}` +
`when`. `computeOT` reformulated: bands resolved **per bucket** (a date-scoped
ot_tier rule sets that day's tiers; else the fixed-slot config) and OT accumulated
by multiplier instead of a fixed band array. **Behavior-preserving** — all 95
payCalculations tests pass unchanged; the reformulation only diverges when an
ot_tier rule exists. `annotateEntryOvertime` resolves its boundary per bucket too,
so the report OT column still reconciles. `otConfigFromSettings` carries the
tierRules; `payCalculations` imports `ruleMatchesDate` (one-way, no cycle).
Builder: `ot_tier` type (basis / after-hours / multiplier) + summary + coerce;
i18n EN/ES. `hoursRulesOtTier.test.js` (single/tiered/CA-style, Saturday-scoped,
parse, report reconciliation, backward-compat). 234 pay/hours + 38 admin tests
green; client build + i18n parity green.

**Phase 3 shipped — premiums as custom rules.** Four new rule types:
`rest_day {mult}` (whole day OT on the days `when` selects), `min_daily {hours}`
(reporting-time floor), `seventh_day {firstHours, firstMult, afterMult}`, and
`night_diff {fromHour, toHour, pct}`. Design kept the OT accumulator untouched
for safety: rest_day / seventh_day / night_diff **feed the existing otConfig**
(`otConfigFromSettings` overrides the fixed slots when a rule is present, incl.
`daysFromWhen` to turn a rest_day's weekday `when` into rest days), so
`computeOT` + `nightPremiumCost` are unchanged; only **min_daily** got a small
per-bucket resolve (`minDailyForBucket`, autoReg-only, no OT-band restructuring)
so its `when` scopes per day. Builder reuses the fixed-slot field labels; new
type/summary/hint keys EN/ES. `hoursRulesPremiumRules.test.js` (rest-day Sat @2×,
scoped min-daily floor, 7-day OT, night-diff pricing, parse, no-op). 240 pay/hours
+ 38 admin tests green; client build + i18n parity green.

**Phase 4 shipped — fixed slots retired; rules are the single source of truth.**
- `migrateFixedSlots(raw)` + `hasFixedSlots()` convert a legacy policy's fixed-slot
  config (rounding / OT bands + 7th-day / premiums) into the equivalent rules and
  clear the slots. **Proven** by `hoursRulesMigrate.test.js`: same entries →
  identical rounding, regular/OT hours, and OT cost.
- **Wiring:** `GET /admin/settings` migrates `hours_rules` in the response
  (display-only) so the builder shows rules; the stored value the pay engine reads
  is untouched until the admin re-saves, and the equivalents are identical either
  way — so no big-bang data migration, no un-migrated policy breaks.
- **UI:** removed the Rounding / Overtime-tiers / Premiums fixed-slot sections
  (and the now-dead `EdgeEditor` + band helpers). Kept Standard Hours,
  Transparency, presets, and the rule builder.
- **Presets** (Honduras / US quarter / California) now emit the matching custom
  rules instead of filling slots (`hoursRulesPresets.test.js` proves California ≡
  old fixed-slot California + every preset rule parses). Round-rule summary now
  shows grace + reference (schedule vs clock).

**Done.** The whole Hours & Rules policy — rounding, overtime, premiums — is now
one `when`-scoped rule list, backward-compatible (no rules → normal pay + OT;
legacy configs migrate on load, identical pay). 286 admin/hours/pay tests + i18n
parity + client build green across the four phases.

---

## 2026-07-19 — Hours & Rules: schedule-relative trigger for Add/Remove Time

David asked, in the Add-Time builder: add a step asking whether the trigger is a
*set time* or the *end of schedule* — so "+30 at :25 past quitting time" fires no
matter what hour a worker actually finishes (variable shifts, not just a fixed
5:25).

**The gap it closes.** The trigger (`at`/`from`) was a fixed wall-clock time; it
only makes sense when everyone quits at the same hour. `base` ("Added to") already
adapts where the credit *lands*, but nothing adapted where the trigger *fires*.

- **New rule field `anchor`** on add_time/remove_time (`RULE_ANCHORS =
  ['clock','schedule']`, default `clock`). `schedule` measures the trigger as an
  **offset** (`offsetMin`) off the scheduled edge instead of a clock time. It is
  independent of `base` — trigger anchor vs. credit landing are orthogonal.
- **Engine:** `ruleCredit(rule, punchMin, anchorBase)` gained a 3rd arg — the
  resolved baseline (`baseEnd` for 'after', `baseStart` for 'before'), which is the
  End Time rule if one is set, else the worker's own scheduled end. So the anchor is
  the *same* baseline the credit already lands on. No schedule to resolve → the rule
  no-ops (0), exactly like a schedule-*based* credit with no baseline. Clock anchor
  is byte-for-byte unchanged.
- **Builder:** a "Set time, or relative to their shift?" select between Mode and the
  threshold; when *schedule*, the time picker swaps for a "Minutes past scheduled
  end" number + a hint. Summaries read "…once 25 min past their scheduled end".
- **Judgment call:** the anchor follows the resolved baseline (End Time rule ⇒
  scheduled end), not raw `expected` — so a company End Time rule and a per-worker
  schedule both behave the way the admin already expects for the credit side.

New `hoursRulesAnchor.test.js` proves it adapts (17:00 shift fires 17:25, a 14:00
shift fires 14:25 from the *same* rule), the ladder mode, offset 0, no-schedule
no-op, End-Time-rule override, and clock-anchor regression. **276 server
hours/pay tests + i18n parity + client build green.** No DB column (lives in the
`hours_rules` JSON), so no `db-enums.md` change.

---

## 2026-07-19 — Hours & Rules: additive stacking for set-time rules

David: "if I set 5:25 → +30 and 5:50 → +60, does it end in an hour or 90 minutes?"
Today it's an hour — `edgeCredit` (was `bestCredit`) takes the largest rung that
fired, never the sum. He wanted the *option* to stack.

- **New per-rule flag `stack`** on add_time/remove_time (default absent = false).
  `false` = **replacing**: largest fired rule wins (unchanged, so 60). `true` =
  **additive**: that rule's minutes pile on top. Formula:
  `max(replacing rules) + sum(additive rules)` — mark both and the pair pays 90.
- **Only 'at' rules** get the toggle (an 'every' ladder is already cumulative on
  its own). Shown as an "If two set-time rules both apply" select right under
  "Added to"; `coerceDraft` only writes `stack:true` for 'at' rules, and only
  when true, so nothing else changes shape.
- **Backward compatible by construction:** default preserves the max-wins math —
  every existing policy and all 282 tests unchanged. The flag round-trips only
  when true (absent stays absent, verified).

New `hoursRulesStack.test.js` covers both-additive (90), mixed (90), replacing
(60), the single-rule case (agree), and round-trip. **282 server hours/pay tests
+ i18n parity + client build green.** No DB column (hours_rules JSON), no
db-enums change.

---

## 2026-07-20 — Hours & Rules: weekday selector starts on Monday

David asked to move Sunday to the end of the "Select days" buttons. Reordering
`WEEKDAY_KEYS` would have been a trap — its **index is the stored day value**
(Sunday=0, the engine's numbering), so shuffling it silently remaps every saved
rule. Instead added a display-only `WEEKDAY_DISPLAY_ORDER = [1,2,3,4,5,6,0]` that
the day buttons, the nth-weekday dropdown, and the summary iterate; the values
they carry are unchanged. The summary now sorts/contracts by display rank too, so
Sat+Sun reads "Sat, Sun" and Fri–Sun contracts to a clean "Fri–Sun". Client build
green; no server/i18n change (labels already existed).

Also: David reported the stage migration failure self-resolved — it was the
nightly job briefly holding things up, not the `users`-PK issue I'd diagnosed (see
prior entry; that diagnosis stands if it recurs).

---

## 2026-07-20 — Hours & Rules: "Schedule Time" → "Schedule/Pay Time"

David wanted the "Added to" pay-basis option to carry a "pay" framing. Flagged
that plain **"Pay Time"** is the worse of his two ideas — "Punch Time" also drives
pay, so "Pay Time vs Punch Time" blurs the only real distinction (scheduled end vs
actual punch) — and went with his fallback **"Schedule/Pay Time"**, which keeps the
accurate meaning. Renamed the term in all four user-facing spots: the dropdown
option (`hrBaseSchedule`), the rule summary token (`hrSumOnBaseline`), the hint
(`hrBaseScheduleHint`), and the glossary (`hrGlossary`), EN + ES. Left the round
rule's own "Scheduled time" vocabulary alone, and lowercased `hrRoundHint`'s stray
"Schedule Time" → "their scheduled time" so it no longer reads as the same term.
i18n-only; parity + build green. Trivial to swap to plain "Pay Time" if he changes
his mind.

---

## 2026-07-20 — Impersonation: language switch is view-only

David: while impersonating ("Login as") a Spanish user, switching the header
language to English was overwriting *their* saved profile language. Fixed so the
switch is view-only during impersonation.

- The impersonation JWT (`superadmin.js`) now carries an explicit **`imp: true`**
  claim. Previously nothing distinguished an impersonation token except the
  absent `tv` claim, which is too implicit to gate on.
- `POST /auth/update-language` (`auth.js`) short-circuits when `req.user.imp`:
  it echoes `{ success, language, persisted:false }` so the client still flips
  its own display, but skips the `UPDATE users SET language`. The target's
  preference is untouched.
- **Judgment call:** kept it to the one self-serve endpoint the header switcher
  hits. The Team-management "edit user" endpoints that set language are a
  deliberate profile edit, not a view toggle, so they're left alone.
- **Known limit:** the English view is in-memory for the session — a full reload
  re-reads the token and reverts to the profile's Spanish. That's consistent with
  "not saved"; can make it session-sticky (sessionStorage override) if wanted.

New `updateLanguageImpersonation.test.js` (normal persists, impersonation skips,
blank still 400). Full server suite green (975).

---

## 2026-07-20 — Login crash: SecurityError reading sessionStorage

A user hit the global error boundary at `/login` — `SecurityError: Failed to read
the 'sessionStorage' property from 'Window': access denied` — then it worked on a
later retry. Cause: in storage-blocked browser states (cookies/storage off,
partitioned/in-app-webview, strict privacy) the storage **property getter itself
throws**, and we read it unguarded during bootstrap, so the whole app white-screened
to the boundary. Not related to the impersonation change (that was server-only).

- New `client/src/utils/safeStorage.js` — `safeSession` / `safeLocal` wrappers:
  reads return null, writes/removes are best-effort no-ops, and even accessing
  `window[kind]` is inside try. The app degrades to "no persisted session" instead
  of crashing.
- Routed every **bootstrap / auth / API** path through it: `api.js` (request-
  interceptor token read + 401 cleanup), `AuthContext` (mount read + all
  login/logout token writes), `App.jsx` (the module-load impersonation IIFE — a
  throw there white-screens before React even mounts), `OfflineContext` (SW auth
  reply). ErrorBoundary, openTool, pdfError, tc_addons were already try-guarded.
- **Scope call:** fixed the paths that run on every page (incl. login). ~140 raw
  accesses remain in post-login feature components — filed in BACKLOG (boundary-
  caught, lower urgency) rather than sweeping 146 sites in one risky pass.

New `safeStorage.test.js` (getter-denied → null / no-op, normal path still works).
Client build + i18n parity green.

---

## 2026-07-20 — SecurityError hardening: finish the safeStorage rollout

Followed the login-crash fix through the rest of the app (David: "go for it").
Every unguarded `localStorage`/`sessionStorage` access in a post-login page could
still trip the global error boundary in a storage-blocked browser.

- Swept **72 calls across 23 files** onto `safeSession`/`safeLocal` via a codemod
  that only rewrites `(session|local)Storage.(get|set|remove)Item(` (negative
  lookbehind so `window.localStorage` and comments are never touched) and inserts
  an import for exactly the symbols each file uses.
- `debugBundle.js`: `readStorage` now takes a kind and reads `window[kind]` inside
  its try — the property access was previously evaluated as the call argument,
  outside the guard.
- **Deliberately left raw** (all already inside try/catch, so crash-safe): `openTool`,
  `pdfError`, `ErrorBoundary`, `useFormPersist` (its setItem catch intentionally
  reports quota/SecurityError to Sentry — routing it through the swallowing helper
  would kill that signal), the `tc_addons` effect, and `api.js`'s `tc_api_base`
  bootstrap line.
- Verified: no unguarded `window.*Storage` access remains in `client/src`; client
  build + `safeStorage`/i18n tests green. BACKLOG item marked resolved.

---

## 2026-07-20 — Plan Room: edit-mode reshape toolbar (feature Phase 1 of 3)

Big multi-phase Plan Room feature (plan: `plans/mossy-launching-mist.md`, approved).
Phase 1 shipped in two committable slices:
- **1a** — an "Edit" dropdown appears next to Select whenever a reshapeable markup
  is selected (`body.pr-editing`, driven from the render loop). Move/Add/Remove/Cut
  become explicit click modes reusing `insertVertexAt`/`deleteVertexAt`/`cutAtEdge`;
  Alt-click shortcuts still work. Fresh selection resets to Move.
- **1b** — Join: two-click endpoint weld. Close one open line's ends into a loop, or
  merge two same-type lines (inverse of Cut). Green ring on the first pick.

**Judgment call / open item:** the spec's *active-endpoint* Join ("connected to the
last point waiting for the next → one click to an existing vertex, finishes the
shape") is a **drawing-flow** interaction distinct from edit mode — not built. Phase
1 implements the edit-mode "click two points to join" case. Confirm if the
draw-time close-to-vertex variant is wanted.

**Phase 2 (shipped)** — Mode dropdown (Points/Box/Circle); in Box/Circle the op
dropdown swaps to a region-op. Box = drag a rect, Circle = click center then radius
(live preview). Delete Points removes captured vertices (floored at the min; whole
capture deletes the shape). New `drag.mode='marquee-box'`, `circleRegion`/`boxRegion`,
`applyRegionOp`.

**Phase 3 (shipped)** — Delete Area cuts a **keyhole hole** in a closed area. `m.pts`
stays the single ring every consumer reads (area shoelace nets `outer − Σholes` for
free, fill renders the hole empty under nonzero winding, hit-test + earthwork gate off
the same `pointInPolygon`); `m.outer`/`m.holes` metadata added only for a holes-aware
`areaPerimeterFt` (routed the qarea bid/edge-form + config-reopen sites through it —
shared `engine-measure.js` untouched). **Winding is load-bearing** — `orientOpposite`
forces the hole opposite the outer; a standalone test confirms 9600 (100×100 − 20×20)
for both windings, 9500 for two holes, perimeter 480 vs raw-keyhole 593, hole points
excluded from hit-test. Holed shapes expose no vertex handles and skip point-ops (would
corrupt the keyhole); whole-shape move keeps `m.outer`/`m.holes` in sync; undo removes a
hole. **v1 limit:** the region must sit fully inside the outline — edge-crossing
*notches* (general polygon difference / Greiner–Hormann) are deferred with a clear
message.

Static tool-app, no test harness — `node --check` each slice; `?v` 52→55 across the
five commits (1a/1b/2/3). Sitework verified clean at every commit. To verify: load a
PDF, set scale, trace an area, Select → Edit dropdown appears; exercise the point ops,
then Box/Circle marquee → Delete Points / Delete Area; check the SF read-out + undo.

**Follow-up shipped 2026-07-20:** holed shapes are now fully editable (was a v1
shortcut). Reshape routes to `m.outer`/`m.holes` rings and rebuilds the keyhole —
`editRings`/`handleRef`/`nearestEdgeInRings`/`insertHandle`/`deleteHandle`; Move/
Add/Remove (dropdown + Alt-click) and marquee Delete Points all work per-ring;
`normalizeHoles` reverts to a plain ring when the last hole goes. `?v` →56.

**Draw-time Join (shipped 2026-07-20):** click (not drag) an earlier vertex of the
live trace to close the shape to it, keeping all points (`tryDraftJoin`).

**Edge-crossing Delete-Area notches (shipped 2026-07-20 — via a vendored library):**
Hand-rolling a clean polygon difference was a dead end — I built three versions
(Greiner–Hormann boundary-walk, convex decomposition, decomposition+edge-merge) and
**test-first caught that every one silently returns the wrong area on degenerate
cases** common in real drawings (a box flush against an area edge; any circle, whose
many-edged seams never merge). A silently-wrong quantity in a bid tool is the one
thing not to ship. So, with David's OK, I vendored **`polygon-clipping` v0.15.7**
(Martinez–Rueda, MIT) — `npm i --no-save` → esbuild-bundled to a self-contained ESM
at `tool-apps/shared/polygon-clipping.js` (splaytree + robust-predicates inlined;
the two `process.env` refs are `typeof`-guarded, browser-safe). Imported **only** by
`planroom/app.js` (shared engine + sitework untouched, no package.json change, not in
the Vite bundle). `cutHole` now calls `polygonClipping.difference` and maps the
multipolygon result to the model: inside → keyhole hole, crossing → notch, slice →
split into clones, contained → delete. **Verified both layers standalone:** the
library nails all degenerate cases (collinear/flush edges, identical polys, circles),
and the app's mapping glue nets correct SF for notch/hole/slice/2nd-hole-in-holed/
remove. `?v` →59.

To update the lib: see the header in `polygon-clipping.js`.

---

## 2026-07-21 — Company logo on reports

Companies can now upload a logo that renders at the top-left of report PDFs.

- **DB:** migration `0142_company_logo.sql` — `companies.logo_url TEXT` (nullable
  URL, not a fixed-value column → no db-enums entry).
- **Server (`admin.js`):** `GET /admin/company` (+ the profile PATCH `RETURNING`)
  now include `logo_url`; new `POST /admin/company/logo` (base64 → `uploadBase64`
  → `company-logos/` on R2, replaces + best-effort deletes the old file, ~2 MB cap,
  audited) and `DELETE /admin/company/logo`.
- **Client:** logo upload / preview / replace / remove in the company card
  (`AdministrationPage`). New shared `CompanyLogoPdf` (renders nothing when unset;
  react-pdf loads the R2 URL directly, same as report photos). Wired into the five
  views with a company header: `BillPDF`, `ProjectBillPDF`, `EstimatePDF`,
  `ChangeOrderPDF`, and the on-screen `PayStubView` (HTML `<img>`). The logo rides
  in on the `companyInfo` prop every one already receives, so no caller plumbing.
- **Judgment call / scope:** covered the docs that already carry a `companyInfo`
  header (invoices, estimates, change orders, pay stubs). Daily/incident/certified-
  payroll PDFs don't currently receive `companyInfo`, so adding the logo there would
  mean plumbing it through — left for a follow-up if David wants those too.

975 server tests + i18n parity + client build green. Sitework untouched.

*Everything here is blocked on a decision or an action of yours, not on more code.*

### The big one

⚠️ **133 commits sit on `dev` and have never gone to production.** That's
six trade packs, the storm module, the currency sweep, four new tools and the AI
gate. **None of it has been through stage**, and the trade packs were verified by
unit-testing the *math*, not by driving the UI with a real plan set. It is a very
large release. Everything below matters less than getting this out.
(The bill-PDF currency hotfix is the one exception — merged to `main` 2026-07-16.)

### Decisions only you can make

**These live in `docs/BACKLOG.md` → "Open questions / decisions for you", with the
full context. That doc is the one to actually work from — this is just the
headline.** (Keeping two full copies is how the roadmap went stale in the first
place, so there's one copy and a pointer.)

1. ⚠️ **Native invoices, or QuickBooks forever?** — the biggest call on the board.
   Blocks sub pay-apps, and is already breaking closeout today.
2. ⚠️ **Do you want GC customers at all?** — deepening the 11-trade contractor
   product instead is a legitimate, cheaper answer.
3. ⚠️ **Is $60/mo still right for Takeoff?** — priced at 3 trades; it does 11.
4. ⚠️ **Should an expired COI block, or just warn?** — it warns today.
5. ⚠️ **Closeout deliverable: PDF or ZIP?** — moot until closeout items can hold
   documents at all.

### Verification you owe

⚠️ **Storm/Utility is built but unsellable.** `STORM_SELLABLE=false` in
`BillingPanel.jsx` hides every buy path until the utility math is hand-verified.
To sell: verify → flip to `true` → set `STRIPE_PRICE_STORM` to **$20** in Stripe.
(The approach used from the ESC pack onward — lifting the real functions out of
app.js and running them against stubbed state — would work here.) See
`docs/plans/storm-utility-pack.md`.

⚠️ **Roofing math** still wants a hand-verification pass.

⚠️ **Sitework ↔ Plan Room parity test** still outstanding.

⚠️ **The Red-Flag Scanner and Meeting Minutes prompts have never seen real
input.** Both are wired and verified structurally; their *output quality* is
unknown until you run a real subcontract and a real meeting through them. Both
need `ANTHROPIC_API_KEY`.

### Filed, not forgotten

⚠️ **Five open items in `docs/BACKLOG.md`** — the two closeout/QBO bugs above,
tool-apps still hardcoding `'$'`, flooring/framing missing from `NEEDS_SCALE`,
and `fopening` missing from `POINT_KINDS`.

---

## Daily Checklist — Phase 1 (per-project daily checklist)

New Field-module feature: a per-project checklist that recurs each working day.
Designed with David over several turns (`docs/plans/daily-checklist.md`) — the load-
bearing idea is **ordinal worked-days**: Day 1 = the first day worked onsite, gaps
allowed, and ordinal numbers are **spent only by days actually worked** (a scheduled
no-show never burns "Day 3"). Generation is **lazy** — a day materializes when it's
started, never pre-generated. Two follow-ons deferred: reference-pulled safety
checklists (needs an asset registry) and per-day portioning of the general punchlist.

**Phase 1 shipped** (the daily loop; the day-manager scheduling is Phase 2):
- **Schema** (`0163`): `daily_checklist_recurring_items`, `daily_checklists` (full
  lifecycle + scheduling columns so Phase 2 needs no migration), `daily_checklist_items`.
  CHECK-enforced enums mirrored in `constants/dailyChecklistEnums.js` + `db-enums.md`;
  partial unique index = one active day per project.
- **Route** (`routes/dailyChecklist.js`): recurring template GET/PUT, idempotent
  start-a-day (adhoc; assigns the ordinal `day_number` from prior worked days and
  assembles recurring items + **unchecked rollover from the last completed day, deduped
  by normalized text**), active-day view, history, item add/check/edit/delete, complete.
- **Permissions** (`0164` backfill): `start_day` + `check_items` worker-tier,
  `manage_recurring` + `complete_day` admin-tier.
- **Client**: `DailyChecklist.jsx` in the Field › Daily group — start the day, check
  items (rollover items badged "carried over"), add manual items, complete; managers get
  an inline recurring-template editor. EN + ES.

**Judgment calls:** rollover is computed **at next start** from the last completed day
(not pushed at complete time) since the next day is lazy; a start that races another
returns the winner (23505 → re-select). Verified: 1345 server tests + client
eslint/i18n/build green.

**Phase 2 (not started):** the day manager — calendar/ordinal day-plans, the reorderable
pending queue, pause/reschedule, ordinal-vs-calendar conflict prompt, optional clock-in
auto-start.

---

## Daily Checklist — Phase 2 (the day manager)

Built the scheduling half of the Daily Checklist (`docs/plans/daily-checklist.md`). Both
phases are now shipped.

- **Prepare days ahead**: a manager creates pending day-plans on a **calendar date** or a
  **work-day number** (ordinal), each with its own items. New perm
  `daily_checklist_schedule_days` (admin-tier, migration `0165`).
- **The queue**: pending + paused plans in a reorderable queue; overdue calendar plans are
  lazily flipped to **paused** (no cron). Reschedule / edit-items / delete inline.
- **Queue-aware start**: resumes a calendar plan dated today → an ordinal plan for this day
  number → the top of the queue → else a fresh adhoc day, sliding the resumed plan onto
  today with the next ordinal number and appending recurring + rollover (deduped) on top.
- **Conflict prompt**: when a calendar plan and an ordinal plan both claim the same day and
  differ, start returns `409 { conflict }` with each option's items; the UI offers
  use-either / **merge** (merge unions them and retires the loser).
- **Optional clock-in trigger**: `daily_checklist_clockin_autostart` (default off). When on,
  the first clock-in on a project auto-starts the day — best-effort, in the clock-in's
  post-response block, so it never delays/fails the clock-in.

**Design note:** the shared start logic (assembly, overdue-pause, precedence) lives in
`utils/dailyChecklistCore.js`, imported by both the route and the clock-in hook, so the
manual and automatic paths can't drift. The auto-start path deliberately has no conflict
prompt (a trigger can't ask) — calendar-today wins.

**Verified:** 1354 server tests (added core + route Phase-2 cases) + client
eslint/i18n/build green.

---

## PWA blank-screen recovery (boot watchdog)

Symptom: the PWA often opened to a blank white screen that "does nothing". Diagnosis
(full SW/boot audit): the SW caching is actually solid (atomic precache of index.html +
entry chunks, cleanupOutdatedCaches, message-gated skipWaiting, layered chunk-error
auto-reload, root + per-section ErrorBoundaries). The one uncovered path: if the **root
entry bundle** fails to load/execute — classic case a stale HTTP-cached index.html after a
deploy pointing at purged /assets chunk hashes — React never mounts, so none of that
recovery installs (it all ships *inside* the failed bundle), and index.html has already
hidden its static fallback the instant JS ran → permanent blank.

Fixes (client-only):
- **`client/public/bootwatch.js`** — a plain external script (runs even when the module
  bundle 404s/throws; CSP-allowed via 'self', no inline hash). If React hasn't mounted
  after 12s (detected by the #prehydrate fallback node still present), it reloads once to
  fetch a fresh shell; if a reload already ran and it's still blank, it reveals the static
  landing page (with a Log in link) instead of white. Referenced from `index.html` before
  the module script.
- **`client/vercel.json`** — `Cache-Control: public, max-age=0, must-revalidate` on the SPA
  shell (negative-lookahead source excluding immutable /assets and the sw.js/manifest.json
  blocks), so an HTTP-cached index.html can't outlive a deploy and the watchdog's reload
  actually gets a fresh, consistent shell.

Deeper options left for later (noted, not done): a Workbox NavigationRoute/navigateFallback
so offline deep-links get the cached shell; auto (not just banner) reload on version
mismatch.

## Cron: production-only background jobs (Neon compute)

Investigated the Neon compute bill. Confirmed it's **Neon (DB), not Vercel** —
Vercel is a static SPA with 0 functions. Two drivers: the nightly
`sync-staging-db` full drop/restore (biggest single burst, why staging leads),
and `server/cron.js` background jobs — chiefly `sendBookingReminders` on a
**15-min** interval (others hourly) — which repeatedly wake each backend's Neon
branch before it can auto-suspend.

Full job inventory: `sendBookingReminders` (15 min), `sendShiftReminders` /
`sendSignoffReminders` / `expireOldTrials` / `maintainActiveClocks` (hourly),
all in `server/cron.js`; a per-connection SSE heartbeat in `liveSessions.js`
(no DB); the GH Actions `sync-staging-db` (daily 4 AM).

Fix: gated `startCron()` to `NODE_ENV === 'production'`. Staging/dev
(`NODE_ENV=development`) are test envs that don't need reminders/trial-expiry/
clock-sweeps, so their DBs can now stay suspended when idle. Left the staging
sync untouched (David needs it). Compute savings realize once staging + prod
backends redeploy.

## Per-project hour limits (hard cap / soft warn)

New feature: a project can cap how many hours one worker logs on it per day
and/or week. Admin chooses the mode per project (warn | hard), sets a daily
and/or weekly limit, and — for hard — an optional overflow project to switch
the worker into at the cap. Per-project only for now; the engine already takes
caps off the project row so a per-worker-per-project override slots in later.

Judgment calls:
- **Deterministic limit-time + lazy reconcile** (David's framing). Rather than a
  frequent server sweep or a fragile client timer, the limit instant is computed
  from clock-in + prior hours + cap, and applied AS OF that instant whenever the
  active clock is observed (worker /clock/status, admin /admin/active-clocks,
  hourly prod cron backstop). Recorded hours never overshoot regardless of
  whether any app was open. Same posture as sweepStaleActiveClock. This also means
  the "auto-switch to secondary" IS a normal /switch timestamped at the limit —
  no bespoke entry-splitting.
- **Loop guard:** reconcile only switches into a project with spare capacity, and
  each hop's clock-in strictly advances toward now, so mutual-overflow configs
  (A→B→A) terminate instead of ping-ponging.
- **Hours count all wage types** (a prevailing hour still counts against the cap),
  unlike the OT alert which is regular-only.
- **Running-shift limit uses gross elapsed** (breaks aren't known until clock-out);
  documented as a known minor imprecision.
- Warn-mode admin alert fires at clock-out only when THIS shift crossed the cap
  (reuses the overtime-alert "prev<limit && total>=limit" edge so it fires once).
- Client live banner reuses the existing per-second timer + a fire-once ref keyed
  on (project, limit_ts); the server stays authoritative (client just refetches).

Files: migration 0167, server/utils/projectHourLimits.js (+23 unit tests),
clock.js (/in + /switch gates, /status reconcile, warn alert), admin.js
(/active-clocks reconcile + project CRUD + validation), cron.js backstop,
ManageProjects.jsx + ClockInOut.jsx + i18n. `npm run verify` green.

## Approval Queue: collapsible sections + entry detail + location history

Four asks on the Approval Queue:
1. Pending approvals wrapped in a collapsible section, defaults OPEN each load
   (`showPending` state, not persisted).
2. Approved section always renders; open+empty shows a hint to change the dates.
3. Clicking an approved row → details popup (ModalShell): approver+time, clock
   source, notes, clock-in/out coords as text, QB sync; "View on map" seeds and
   opens Location history for that worker/day.
4. Page-level "Location history" popup with its own worker + date pickers → map
   of clock-in/out points + list.

Key findings / judgment calls:
- **Data reality:** only two points persist per entry (`time_entries
  .clock_in_lat/lng`, `clock_out_lat/lng`). `active_clock.current_lat/lng` is
  live-only and wiped on clock-out; there is NO breadcrumb/path table. So
  "location history" today = start+end per entry. Full-path tracking (David:
  "not ready") is out of scope; left a code comment where a `<Polyline>` per
  shift would drop in, and the /worker-locations endpoint is shaped to extend.
- Had to **un-gate the date-range picker** (was `entries.length > 0`) — with zero
  pending entries it vanished, but the approved empty-state tells users to change
  "the dates above," so it must always show.
- Entry-detail popup is **details-only, no map** (David's choice) — the map lives
  in Location history, reachable via the popup's "View on map".
- Location history is **self-contained** (own worker + date pickers, own
  /admin/workers fetch) so it works without first setting the page filters.
- Reused the file's existing Leaflet primitives (clockInIcon/clockOutIcon/
  FitBounds) and the repo's ModalShell (this file had no modal before).

server: new `GET /admin/worker-locations?user_id&from&to` (coord-bearing entries,
any status, access-scoped, LIMIT 500); `/entries/recently-approved` enriched with
location + approver/source fields. New test adminWorkerLocationsRoute.test.js.
`npm run verify` green (1389 server tests).

## Location tracking: breadcrumb pings table

Started persisting GPS pings. `POST /api/clock/location` now INSERTs into a new
`location_pings` table (migration 0168) on top of the existing active_clock
"last known point" overwrite. This is the durable path — the earlier design only
kept clock-in/out points; the live point was wiped on clock-out.

Design/judgment:
- Table used ONLY for location tracking: id, company_id, user_id, lat/lng,
  recorded_at. No FK to time_entries (no entry exists mid-shift) — a shift's
  trail = that user's pings between the entry's start_ts/end_ts.
- **Throttled ~1 row/30s per user** via an INSERT ... WHERE NOT EXISTS(recent
  ping) guard. The client uses watchPosition (fires on movement), so without a
  throttle the table would flood — and this tenant is cost-sensitive (Neon).
  30s still gives fine path resolution (~960 rows/worker/8h max).
- Fire-and-forget after the response; never delays the clock ping.
- No auto-retention sweep yet — deliberately left the data intact; retention
  (e.g. delete pings older than N days in the prod cron) is an easy follow-up if
  growth matters.

Storage only, per the ask. Drawing the per-shift polyline in the Location
history map (from these pings) is the clear next step — the /worker-locations
endpoint + map are already shaped for it.

## Location tracking: 10-min floor + path drawing

Completed the breadcrumb feature.

- **10-minute floor (client, ClockInOut):** while clocked in, a per-minute check
  forces a getCurrentPosition when it's been >10 min since the last ping, so a
  stationary worker still gets a point every 10 min. Any real ping (movement,
  visibility, reconnect) resets the floor via `lastPingRef`. Skipped when
  `navigator.onLine === false`; a `window 'online'` handler forces a fresh ping +
  reset on reconnect (the "reset if ping when offline and back on" ask). Server
  still throttles writes to 1/min, so the floor is a floor, not extra volume.
- **Draw path:** `/admin/worker-locations` now returns `{ entries, pings }`.
  Entries carry `start_ts/end_ts` and now also include shifts that have pings but
  no clock-in/out coords (EXISTS on location_pings in the shift window). The
  Location history map draws a blue `<Polyline>` per shift from the pings between
  its start/end, keeping the green/red clock-in/out markers; the list shows a
  per-shift point count; FitBounds frames the whole path.
- Note: history accrues from when pings started recording — past shifts show only
  their clock-in/out points (no path). Retention sweep still deferred.

## Location: stationary-ping setting + ping retention

- **Company setting `location_ping_while_stationary`** (FEATURE_KEYS, default
  FALSE). Toggle in Company Settings under Geolocation (only shows when
  geolocation is on). OFF = only movement-driven pings; ON = the 10-min stationary
  floor runs. Wired: settingsDefaults (key + default), ManageRates (init/reset/
  save/toggle), Dashboard passes `pingWhileStationary` to ClockInOut, which gates
  the floor + reconnect ping on it. PATCH allowlist already covers FEATURE_KEYS.
  i18n mrFeatPingStationary(+Desc) EN/ES.
- **Retention:** prod cron backstop (maintainActiveClocks) now
  `DELETE FROM location_pings WHERE recorded_at < NOW() - INTERVAL '3 months'`.
  Runs hourly in prod (crons are prod-only), keeping the breadcrumb table bounded.

## Direct messages + messaging scope setting + block system

Added 1:1 direct messaging (`/api/dm`, `direct_messages` table) alongside the
existing shared worker↔admins `company_chat` thread — the "Admins" recipient is
kept; specific-person DMs are new. Governed by company setting
`worker_messaging_scope` (off | admins_only [default] | everyone). Admins can
always message any active same-company user; scope only gates workers. Block
system in Directory ▸ Team Members: per-user mute (`users.messaging_blocked`) +
per-person block list (`users.messaging_blocked_user_ids INTEGER[]`), edited via
`PATCH /admin/workers/:id/messaging`.

Enforcement is centralized in `server/utils/messaging.js canMessage()` (scope,
mute, per-person block, same-company/active/self), reused by the send route and
the contacts list. 9 unit/route tests.

Judgment calls / gotchas:
- **Caught + fixed a deploy-blocker in 0168**: `location_pings.company_id` was
  INTEGER but `companies.id` is **UUID** — the FK would fail at migrate time (and
  the runtime insert passes a UUID). A bad-FK CREATE TABLE fails atomically so it
  never applied; fixed the file in place (separate commit) and used UUID for 0169.
- Kept the collective "Admins" thread (company_chat) and layered DMs on top, per
  David — no migration of existing chats. Worker Messages screen: a recipient
  picker ("🏢 Admins" + people from /dm/contacts); admin picker gains a DM group
  (other admins + anyone who's DM'd them) so worker→specific-admin DMs are visible
  without reworking the Workforce chat.
- DMs notify via push only (no inbox item) to match company_chat + avoid inbox
  clutter; unread is server-authoritative (contacts.unread), folded into
  MessagesBell. Pruned by chat_retention_days like company_chat.
- Per-person block is directional (X's list) via INTEGER[] mirroring
  worker_access_ids — no join table.

`npm run verify` green (1401 server tests).

### Follow-up: scope enum → two toggles
Per David, "workers can message individual admins" should itself be a company
option. That made the 3-way `worker_messaging_scope` enum redundant, so it was
replaced with two boolean FEATURE_KEYS (both default OFF): `worker_dm_admins`
and `worker_dm_workers`. Default = a worker has only the shared "Admins" thread.
`canMessage()` takes `{ dmAdmins, dmWorkers }`; Company Settings shows two
toggles. Retired `server/constants/messagingEnums.js` + its db-enums row.

## Field screens default to the clocked-in project (+ overhead/non-job flag)

Daily Checklist, Work Notes (FieldDayLog), new Daily Report, and Haul log now
default their project picker to the worker's clocked-in project. Precedence:
URL `?project=` > clocked-in real job > each screen's prior default.

- **Overhead flag:** new `projects.is_overhead` boolean (migration 0170), admin-set
  via a toggle on the ProjectsPage edit form. Marks non-job codes (Shop, Travel,
  PTO) so auto-defaulting skips them — you don't want a daily report defaulting to
  "Travel". David picked an explicit flag over name-guessing (fragile) or
  no-job-number inference (implicit/wrong).
- **Resolution in FieldPage** (all four are its tabs): fetch `/clock/status` once,
  find the clocked-in project in the loaded list, and only treat it as the default
  if it's active and `!is_overhead`. Passed down as `defaultProjectId`. Used an
  **`undefined` sentinel** (vs null) so "clock status still loading" is
  distinguishable from "not clocked into a real job" — screens wait rather than
  finalizing their fallback early (the async-default race).
- Each screen applies the default once, after the URL param, guarded so it never
  overrides a manual pick.

Note: caught earlier that companies.id is UUID (fixed 0168 in a prior commit); all
new `company_id` FKs use UUID. `npm run verify` green (1401 tests).

### Extended to the rest of the sensible field tabs
Seeded the new-record project on the remaining worker-facing project-scoped create
forms: Punchlist, Incident Reports, Inspections (new only), Safety Checklists, Sub
Reports. Skipped PhotoGallery (browse-only) and Safety Talks / RFIs (admin-only
create — admins aren't clocked in, so the default never applies). Only create-form
project fields seeded via the form initializer; browse filters untouched.

## Field: one shared "active project" across all tabs (one model, many interfaces)

David's refinement of the shared-selector idea (he disliked a header/banner mock):
keep each tab's own project selector UI, but back them all with ONE shared value
in FieldPage. Pick a project on any tab → every other tab opens on it.

- FieldPage owns `activeProject` ('' = All/none). Seed order: clocked-in real job
  (skip overhead) → last-used (localStorage `field_active_project`) → none.
  `undefined` until seeded; tab content shows a loader until then. Passed to every
  project-scoped tab as `activeProject` + `onProjectChange`.
- Each tab binds its browse filter (or primary project) to the shared value: init
  from it, a sync effect follows changes, and its selector's onChange writes back.
  Create-form defaults read the shared value too. Supersedes the per-tab clocked-in
  defaults from earlier (same seed, now shared + persisted).
- Daily Checklist keeps `?project=` deep-link precedence and pushes it into the
  shared value so other tabs follow.
- Gotcha fixed: don't gate seeding on `projects.length` — a company with zero
  projects would otherwise hang on the tab loader forever.

Reversible by design (FieldPage state + per-tab bindings). Bound 12 tabs;
`npm run verify` green (1401 tests).

### Company settings for the two Field behaviors
Two boolean FEATURE_KEYS (Company Settings ▸ Field, both default ON):
- `field_shared_project` — the shared active-project. Off = FieldPage passes no
  `onProjectChange` (projectChange=undefined), so tabs keep the seeded default but
  don't sync across tabs (back to independent).
- `field_show_overhead_projects` — off filters `is_overhead` projects out of the
  Field project lists (`fieldProjects`) and out of last-used seeding.
Wired: settingsDefaults, ManageRates (two toggles under module_field),
FieldPage (derive + apply), i18n EN/ES.

## "Open in Google Maps" links

Reusable `utils/maps.js` `googleMapsUrl({lat,lng,address})` (coords win, else
address; Maps URL scheme, opens app on mobile) + `<MapLink>` component (new tab,
rel=noopener, stopPropagation for clickable rows; `showIcon`/`iconOnly` variants).
useT is safe on public pages (all routes are under AuthProvider). Placed on all
four surfaces David picked: recorded clock coords (ApprovalQueue location history
+ entry detail), project/job-site address (ProjectsPage, falls back to geofence
coords), live worker location (LiveWorkers tag → link), and client/booking
addresses (ManageClients + PublicBookingPage on-site/office confirmation).
i18n openInMaps/mapsShort EN/ES.

## Pay: overtime_wage_priority (draw OT from regular hours first)

Money-critical. On a mixed regular+prevailing day/week over the OT threshold, the
engine assigns OT chronologically (later hours = OT) — so a worker doing 3h reg
then 6h prevailing got the OT on a prevailing hour. New opt-in company setting
`overtime_wage_priority`: `chronological` (default, unchanged) | `regular_first`
(prevailing hours fill straight time first → OT drawn from regular first → 6 PW /
2 reg / 1 reg OT).

- Only affects the simple/rate-aware OT path (the only one that unifies wage types
  under one threshold). Premium OT configs keep prevailing flat (unchanged).
- Mechanism: `annotateEntryOvertime` gains an optional `wagePriority`; when
  `regular_first` it stable-sorts each daily/weekly bucket prevailing-origin-first
  before the straight/OT fill. rateAwareOvertime clones carry `orig_wage_type`
  (they're all `wage_type:'regular'` for threshold math) and thread the flag;
  payStatement + both admin.js splitRateAware sites (worker pay + WH-347) read the
  setting so every surface agrees. Default `chronological` = no reorder = identical
  to today (proven: all pre-existing pay tests green).
- Spillover handled: if regular hours < the OT amount, the excess still lands on
  prevailing. Reconciles by construction (splitRateAware buckets sum to total).
- Tests: rateAwareOvertime.test.js (scenario, inverse of Test B, spillover,
  pure-PW-unchanged, weekly) + payStatement.test.js (setting flows through).
  `npm run verify` green (1409 server tests).

Compliance note surfaced in the UI help: jurisdiction-sensitive; opt-in.

## Approval Queue: Recently Rejected section

Mirror of the Approved section. `GET /admin/entries/recently-rejected` (24h default
or ?from&to date range — no payroll-finalization filter since rejected entries
aren't in payroll; returns `approval_note` as the rejection reason + rejecter).
`PATCH /admin/entries/:id/unreject` restores rejected→pending. Client: a collapsible
"Recently rejected / Rejected in range" section driven by the same top date picker
(the [dateFrom,dateTo] effect now refetches both lists); rows show the reason, open
the shared detail popup (rejection-aware: "Rejected by" + Reason, QuickBooks row
hidden), and have a Restore button. i18n EN/ES; adminRecentRejectedRoute.test.js
(4 tests). `npm run verify` green (1413).

## 2026-08-12 — Configurable external map provider for all pin/location links
Generalized the "open in Google Maps" links into a company setting. New
`map_provider` string enum (google/apple/osm/waze/bing, default google):
`server/constants/mapEnums.js` (source of truth), settingsDefaults STRING_KEYS +
default, admin.js PATCH enum guard, docs/db-enums.md row. `client/utils/maps.js`
now has `mapUrl(loc, provider)` (coords win, else address search; per-provider URL
schemes) + `MAP_PROVIDER_NAMES`; `googleMapsUrl` kept as a thin wrapper.
`useMapProvider()` in SettingsContext (falls back to 'google' outside the provider
tree / on public pages, so links never break). MapLink reads the provider from
context and defaults its visible label to the provider name — so every existing
pin popup and location tag (ApprovalQueue, LiveWorkers) respects the setting with
no per-callsite change. Added the previously-missing MapLink inside LiveWorkers'
marker popups. `openInMaps` i18n made provider-agnostic ("Open in maps"). Provider
`<select>` added to Company Settings under the geolocation section (gated on
feature_geolocation). Only two client files use Leaflet markers, so "every leaflet
map" was a bounded surface. `npm run verify` green.

## 2026-08-12 — Approvals: compact rows + icon actions
Pending approval rows were tall and busy. Made them compact by default with a
per-row expand chevron (▸/▾, `expandedIds` Set state). Collapsed shows only the
summary line + icon-only Accept (✓) / Reject (✕) + the chevron; expanding reveals
the location "View location" map, the comments thread button, and the Edit/Split
buttons. Accept/Reject keep title + aria-label for a11y (icons only visually).
Also removed the two clock-in/clock-out MapLink pin links that sat next to "View
location" — redundant now that the inline map's marker popups link out via the
company map provider, and they looked awkward. i18n aqExpandRow/aqCollapseRow
EN/ES. `npm run verify` green.

## 2026-08-12 — Approvals mobile: action buttons on the top line
Follow-up to the compact rows. On mobile the row was stacking vertically
(checkbox → details → buttons). Reworked the `.approval-row` mobile rule to a
wrapping flex row and used flex `order` to put the checkbox + action buttons on
the top line (buttons pushed right with `margin-left:auto`), with the details
(`.approval-main`) and any open edit/split/reject form (`.approval-form`) wrapping
full-width below. Added hook classes approval-check/-main/-actions/-form; actions
now `flex-wrap` + right-justify so the expanded set (Edit/Split/✓/✕/▾) reflows on
narrow screens. Desktop layout untouched. `npm run verify` green.

## 2026-08-12 — Approvals: Edit/Split beside the comment button
Moved the Edit and Split buttons out of the right-side action cluster into a
small `expandTools` toolbar next to the Comments button (all revealed together on
expand). The action cluster (both desktop and the mobile top-right) is now just
Accept/Reject/expand icons. `npm run verify` green.

## 2026-08-12 — Approvals mobile: 3-column row with stacked actions
Reworked the mobile `.approval-row` again per the mockup: three columns —
checkbox | details (`.approval-main`, flex:1) | actions. Actions stack vertically
with `flex-direction: column-reverse` so the DOM order (approve, reject, expand)
renders top→bottom as expand / reject / approve, right-aligned. Forms still wrap
full-width below (order 3, basis 100%). CSS-only; verify green.

## 2026-08-12 — Approvals mobile: fix column wrap
The 3-column mobile layout wrapped the actions below the details because flex line-
breaking sizes `.approval-main` by its content width first. Changed it to
`flex: 1 1 0%` so all three columns (checkbox | details | actions) stay on one line
and details grows to fill. Forms still wrap full-width below.

## 2026-08-12 — Approvals: accept-over-reject + bottom expand bar
Per request: mobile action column now accept on top / reject below (plain
`column`, was `column-reverse`). Dropped the small expand chevron from the action
cluster; added a full-width thin "Show details ▾" button at the bottom of the card
(`.approval-expand`, order 4, basis 100%) that only expands — no collapse control,
and it's hidden once expanded (and while a reject form is open). Works on desktop
too (wraps to its own bottom line). `npm run verify` green.

## 2026-08-12 — Approvals: expand bar becomes the card footer
Made the "Show details" button *be* the bottom of the card: full-bleed via
`width: calc(100% + 32px)` + `margin: 10px -16px -12px -16px` to cancel the card's
12x16 padding, `border-top` divider, bottom corners rounded 7px, thin 3px padding /
11px text. Dropped the mobile `width:100%`/`flex-basis:100%` override (was fighting
the calc); the calc width already exceeds 100% so it wraps to its own line.
`npm run verify` green.

## 2026-08-12 — Approvals: slimmer footer + row spacing
Trimmed the expand footer bar to `padding: 1px 3px` (thinner) and added
`marginBottom: 10` to `.approval-row` for a little gap between entries. Build green.

## 2026-08-12 — Approvals: footer height + tools order
Expand tools now stack: an Edit/Split row on top, Comments below
(`expandTools` → column, new `expandToolsTop` row). Shortened the "Show details"
footer band by switching `.row` from `gap:12` to `columnGap:12` (kills the extra
wrap-line row-gap above the footer) and trimming the bar's top margin 10→4. Build green.
