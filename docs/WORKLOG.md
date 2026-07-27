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
