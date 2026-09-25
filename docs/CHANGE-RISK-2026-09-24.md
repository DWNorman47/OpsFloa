# Change risk inventory — review/fix session of 2026-09-24/25

Everything changed on `dev` between `3eccb982` and `2878cd08` (32 commits, 351 files, ~29k lines added),
plus actions taken outside the code. For each area: what changed, and what could be wrong — whether
or not a bug is currently known. **Use this as the test plan before merging `dev` → `main`.**

Risk: 🔴 high (money, data loss, lockout, security) · 🟠 medium · 🟡 low.

## 0. Cross-cutting — read first

- 🔴 **All route SQL was only tested against a mocked database.** ~2,700 tests pass, but they fake
  the DB. A wrong column name, type mismatch or bad join in any query written today only shows up
  when that screen/endpoint is used for real. Only the *migrations* have run on a real Postgres
  (local throwaway + dev boot).
- 🔴 **No UI change was checked in a real browser.** Every screen edit below is unverified visually
  and on phones.
- 🟠 **Tests were written by the same helper that wrote each fix**, so they share its assumptions.
- 🟠 **Spanish text (~200 new keys) was machine-written** and not reviewed by a native speaker.
- 🟠 **Several files were edited by multiple helpers at once** (`server/routes/admin.js`,
  `client/src/i18n.js`, `server/schema.sql`, `server/routes/invoices.js`). Whole-file rewrites of
  `admin.js` happened twice mid-session; helpers re-checked their edits, but a lost edit is possible.
- 🟡 Line endings changed (CRLF↔LF) on many files; harmless to behaviour, noisy in diffs.

## 1. Actions outside the code

- 🔴 **Dev database was damaged and restored.** A lint script re-ran migrations 0001–0173 on the Neon
  dev branch; dev was then replaced with a `pg_restore --clean --no-owner --no-acl` of the 09:20 MST
  snapshot (`dev-back`). Could be wrong: any dev data written 09:20–~10:10 MST is gone; object
  ownership/grants were not restored (all owned by `neondb_owner` now); anything not in the dump
  (e.g. role-level settings) was untouched.
- 🟠 **Neon password exposed in chat** (`neondb_owner`, dev + dev-back). Not yet rotated.
- 🟠 **Migration 0204 sets role defaults on `neondb_owner`:** `statement_timeout=30s`,
  `idle_in_transaction_session_timeout=60s` (applied on dev; prod/stage on merge). Could break: any
  script, psql session, report, export or job that runs one statement > 30 s or holds a transaction
  idle > 60 s (the QuickBooks bill push now holds a transaction across Intuit calls — see §4).
  `pg_dump` sets its own timeout to 0, so backups/sync should be fine.

## 2. Infrastructure, CI, deploy

- 🔴 **`APP_URL` is now required in production** — the server refuses to boot without it (dev booted
  fine; prod/stage unverified).
- 🔴 **Stage sync workflow rewritten** (`.github/workflows/sync-staging-db.yml`): host guard, scrub,
  verify, drop-schema-on-failure. Fails until `vars.STAGING_DB_HOST` is set. The scrub SQL was run
  once on a small local sample only — on real prod data it could fail (stage left empty), miss a
  column, or run long. Only takes effect after merge to `main`.
- 🟠 **CI (`test.yml`) now runs full `npm run verify`**; job names changed (branch-protection required
  checks must be re-selected). Actions pinned to SHAs. Could be slower or hit the known-flaky
  smoke tests.
- 🟠 **`backup-prod-db.yml` (new, manual only)** — never run.
- 🟠 **Migration runner rewritten** (`server/migrate.js`): one transaction per file, advisory lock,
  `lock_timeout 10s`, connects to Neon's direct (non-pooler) host with fallback. Could break: a deploy
  fails if a migration can't get a table lock within 10 s on a busy table; direct-host derivation
  could pick the wrong host. Old migrations 0089/0091/0096/0098 were edited (marker line only).
- 🟠 **DB pool** (`server/db.js`): timeouts only on direct connections; `pool.queryLong` for long jobs.
- 🟠 **`express-async-errors` + graceful shutdown** (`server/index.js`): async errors now become 500s;
  SIGTERM drains for up to 25 s. Could change error responses some clients relied on.
- 🟠 **`/api` router mounting consolidated** (`server/index.js`): all Business-plan routers in one mount
  that must stay last. A future route added below it will 403 for lower plans (a test guards this).
- 🟠 **Vercel (`client/vercel.json`)**: CSP Report-Only added (reports to Sentry), `/assets/*` immutable
  1-year cache, missing assets now 404, `Permissions-Policy` (geolocation/camera/microphone = self).
  Could break: a feature needing another browser permission; stale clients after a rollback.
- 🟡 `server/backfill-storage.js` deleted. `SETUP.md`, `docs/BACKUP-RESTORE.md` new/rewritten.

## 3. Pay engine — 🔴 highest risk

Files: `server/utils/payStatement.js`, `paidHours.js`, `payCalculations.js`, `rateAwareOvertime.js`,
`hoursRules.js`, `rateHistory.js`, `rateHistoryStore.js`, `timeFormat.js`; routes that render pay.
**Every pay stub, payroll CSV, overtime report, invoice, job cost and QuickBooks amount flows through
these.**

- 🔴 **Per-worker overtime threshold** — stored threshold only applies when the worker's rule matches
  the company's. Totals change for workers with their own rule.
- 🔴 **Weekly OT across pay-period boundaries** — full weeks are loaded and OT attributed by date.
  Semimonthly/monthly totals change.
- 🔴 **Daylight-saving correction** — shift length adjusted by the timezone offset change (0 without
  `start_ts`/`end_ts`/timezone, or spans > 26 h); night/window premiums count the repeated/skipped hour.
- 🔴 **Effective-dated rates** (worker incl. hourly/daily type, project prevailing, company default,
  company prevailing — 0209/0210): every entry priced at the rate on its work date; backfilled with
  current rates at 1900-01-01; cache columns refreshed hourly; first dated change seeds a baseline.
  Could be wrong: resolver edge cases, cache drift, a raise dated wrong, locked-period warning
  reach (widened to whole weeks).
- 🔴 **Weighted-average OT with daily-rate days** converted to hourly equivalents.
- 🔴 **Weekly guarantee now per company week** — a period shorter than a week no longer earns a full
  week; straddling weeks paid by the period holding the week's last day.
- 🔴 **Leave**: sick/vacation priced separately; full-day default only on working days (derived from
  standard hours, else Mon–Fri — could be wrong for 6-day companies); per-day cap; rounded once per
  range then spread.
- 🔴 **Rounding "toward worker"** snaps to schedule only within grace; overnight schedule end moves to
  next day. **Auto-break** computed per worker-day and allocated to one entry.
- 🔴 **Job cost** (`laborCostCents`) now runs the full engine per worker; daily-rate days shared
  across projects split by hours (approved rows only). P&L/WIP/T&M numbers change.
- 🟠 **Payroll worker set** shared by payroll CSV, OT report, QuickBooks journal: only people with
  approved time/leave in range (plus active guaranteed workers); owners/unpaid never; admins by dated
  rate. Active workers with no activity disappear from the CSV.
- 🟠 **Worker-hours export** rebuilt on `companyStatements` (it likely showed 0 hours before).
- 🟠 `computeDailyPayCosts` honours `week_start`; OT alerts and weekly payroll email use each worker's rule.

## 4. QuickBooks — 🔴 high risk, most-patched area

Files: `server/routes/qbo.js`, `server/services/qbo.js`, `client/src/components/QuickBooks.jsx`;
migrations 0207, 0211, 0214, 0218.

- 🔴 **Connect flow changed** — callback now redirects to the app, which completes the link with the
  logged-in user's token; state expires in 15 min.
- 🔴 **Contractor bills** priced by the pay engine, incremental "whole week minus already billed",
  range-pay ledger, staged outbox, frozen cutover flag, held credits, "credit applied" and negative
  adjustment lines, `OF-` bill numbers, per-company transaction lock during a push.
  Known gaps: an already-billed entry moved to another date can be billed nowhere; reversals for a
  worker with no later activity are never billed. **Unverified: QuickBooks accepting negative lines
  and the bill-number format.** A long push holds a DB transaction open across Intuit calls (idle
  timeout raised to 30 min inside it) and one pool connection for its duration.
- 🔴 **Payroll journal ledger** — same total = no-op, corrected total posts the difference, overlapping
  ranges refused; journals posted before 2026-09-24 aren't in the ledger.
- 🟠 Time push sends only approved entries; request ids versioned on force; minutes rounding;
  auto-push on approve uses rounded hours.
- 🟠 New endpoints with no UI: `/qbo/bill-credits`, `/qbo/bill-credits/record`, `/qbo/bill-outbox`,
  `/qbo/bill-outbox/:id/resolve`.

## 5. Clock & time entries

Files: `server/routes/clock.js`, `timeEntries.js`, `admin.js` (entry routes), `utils/clientClockTime.js`,
`utils/payPeriodLock.js`; migrations 0200, 0215.

- 🔴 **Client-supplied times**: clock-in/out tap instants accepted, future clamped, > 10 min lag
  flagged (late clock-in / late clock-out badges); > 16 h spans flagged long-shift.
- 🔴 **`/out` builds from the locked row; `/switch` uses one instant** for both segments.
- 🔴 **Pay-period locks on every write path** (409 `period_locked`); clock-out into a locked period is
  saved as pending + flagged; bulk approve skips locked entries; reject only pending; `/times`
  refuses approved entries. Could block a legitimate admin workflow you rely on.
- 🟠 **Mark-day date must be within one day of today** — could block an admin back-filling older days.
- 🟠 `GET /time-entries` defaults to 90 days (`?all=1` for all); worker dashboard loads 90 days and
  fetches more on demand.
- 🟠 Copy-last-week: skips locked/closed, copies every entry of a day, saved as manual entries.
- 🟠 Worker DELETE follows the same 7-day/edit-toggle rule as PATCH.

## 6. Offline queue & service worker — 🔴 hard to test

Files: `client/src/sw.js`, `offlineQueuePolicy.js`, `contexts/OfflineContext.jsx`, `api.js`;
server dedupe in many routes; migrations 0201, 0205, 0217.

- 🔴 **Replay policy rewritten**: keep on 5xx/429/401/408 and company-deactivated, drop on other 4xx;
  backoff; stuck cap (10 failures / 7 days); per-user lanes; field reports on their own lane;
  size-scaled timeouts capped at 4 min; attempts recorded before upload; 4 min 20 s pass budget.
  Could go wrong: items that never sync and never report, clock punches replayed out of order, a
  4xx dropping something that should have been kept.
- 🔴 **Idempotency keys** on every queued POST; server dedupe on time entries, field reports,
  punchlist, incidents, safety talks, equipment (checkout/return/hours/maintenance), RFIs, sub
  reports, inspections. A route without dedupe duplicates on replay.
- 🟠 Queue items from the old service worker format; shared-phone behaviour (per-user counts,
  "another user's items" notice, 401 quiet mode); Clear queue now scoped + confirm.
- 🟠 Equipment returns from old clients fall back to "caller's single open checkout".

## 7. Client app shell

- 🔴 **Language loading split** (`i18n.js` → `i18n.en.js`/`i18n.es.js` via `?locale` imports,
  `main.jsx` boot wait, `useT` subscription, `ErrorBoundary` fallback). Could break: blank/English
  flash, a component that doesn't re-render after a language switch, a Vite upgrade breaking the
  `?locale` trick.
- 🔴 **`api.js`**: 401 handling decides "session dead vs wrong password" by the server's error
  *text* (brittle if a message changes); 20 s default timeout with a slow-URL regex (an endpoint not
  in the list times out); `company_inactive` sign-out; error-code → bilingual message mapping.
- 🟠 **Bundle splitting** (`vite.config.js` codeSplitting groups) — vendor chunk layout changed.
- 🟠 **Update prompt** won't auto-reload while a form is dirty (dirty-form registry).
- 🟠 **Push**: logout unsubscribes the device; every session start re-subscribes if permission is
  granted; per-device "turned off" flag.
- 🟠 New UI: clock-out confirm step, timesheet entries as buttons + stacked layout < 480 px, late
  badges, rate history lists, locked-period confirms, chat "Load older", bulk-delete failure list,
  onboarding checklist, confirm-email → prefilled login.

## 8. Security & accounts

- 🔴 **Deactivated companies** refused at login and on every request; users signed out.
- 🔴 **Role changes**: `assign_roles` required, "outranks" test (ignores basic worker permissions),
  last-Owner guard, Owner/super-admin email protected, old address notified.
- 🔴 **2FA**: per-user lockout after 5 codes (resets after expiry), token-verified rate limit, no code
  replay, disable needs a code, **enabling refused without `MFA_ENCRYPTION_KEY`**.
- 🔴 **Stripe**: checkout builds prices server-side, seats from live worker count, webhooks
  de-duplicated with `processed_at`, exempt companies never downgraded, watermark on payment events.
  Could break real billing if a price env var mapping is off.
- 🟠 Login/enumeration: locked accounts get the generic 401; reset clears lockout; forgot-password
  with multiple accounts sends one email with several links; invites store hashed tokens; resend works.
- 🟠 Trial limits: per /56 IPv6, per email/domain, IPv4 10 per 30 days; neutral messages.
- 🟠 Impersonation: `req.ip` logged, deleted targets rejected, real worker scoping.
- 🟠 Plan Room live stream: one-time tickets (legacy full-token URL until 2026-10-31), per-user slots,
  5-minute re-checks; plan PDF streamed.
- 🟠 Push endpoints allowlisted (FCM, Mozilla, WNS, Apple).
- 🟠 **R2 file ownership**: company-prefixed keys for new uploads; ownership checks on delete/read for
  profile photos, takeoff/live PDFs, field reports, safety talks, receipts; legacy flat keys still
  readable. Could refuse a legitimate old file or new upload path.
- 🟠 **Upload type allowlists** (field reports, safety talks, receipts, submittals…) — rejects
  unusual files such as `.dwg`.
- 🟠 **Email**: `<Company> via OpsFloa` sender, trial daily cap (counter on `companies`), stage
  suppress flag, never to `*.invalid`, escaped names, CR/LF stripped from subjects, `getAppUrl()`.
- 🟡 CSP Report-Only (can't block anything).

## 9. Company data

- 🔴 **One registry drives company delete, demo-workspace reset and export**
  (`server/utils/companyData.js`): savepoints, FK retry, secret scrubbing in exports. A wrong
  order/missing table could make delete or demo reset fail or leave data; exports changed shape.
- 🟠 0212: `haul_tickets.created_by` FK → `ON DELETE SET NULL`; 0208 cleared cross-company shift
  project links (data changed).

## 10. Estimates, invoices, change orders, lien waivers

- 🔴 **Invoice from estimate** now = base/allowance lines + Overhead/Margin/Contingency lines (markup
  visible to clients — decision pending); one live invoice per estimate (0213 skips its index if
  duplicates already exist).
- 🟠 Estimate expiry in company time zone; convert no longer re-checks expiry; withdraw/accept and
  change-order withdraw guarded (409s where they used to succeed).
- 🟠 Lien waiver void resets "waiver received"; convert only from signed/received.

## 11. Inventory & booking

- 🔴 **Inventory unit conversions**: default-unit issues and worker cycle counts now convert;
  valuation, low-stock and alerts computed in base units — **reported values/quantities change**.
- 🟠 Partial same-location bin moves refused; PO status transition map (some edits now 409); archive
  blocked while any stock row is non-zero; PO email dates/names.
- 🟠 **Booking**: time off on the worker's local day, buffers padded on both sides (fewer available
  slots), email times with named zones.

## 12. Field modules

- 🟠 Daily reports: status saved on create, reviewed lock, atomic conflict check.
- 🟠 Equipment return by checkout id (0217). Safety talks locked after sign-off. Submittal revise
  guard. RFI numbering locks (both paths). Closeout dates company-local. Incident delete admin-only.
- 🟠 **Work orders**: conflict check + scheduled times now converted properly — **existing work
  orders saved the old way may display at a different time.**
- 🟠 **0222 converted `updated_at` on daily_reports / punchlist_items / rfis to TIMESTAMPTZ assuming
  stored values were UTC.**

## 13. Chat, DMs, notifications

- 🟠 Scoped admins only see/post to their workers; newest messages first page + "Load older";
  muted workers blocked; retention 1–90 days.
- 🟠 **Server-side read markers (0216)** — unread counts start fresh after deploy (threads may all show
  unread, or none).
- 🟠 **Push coalescing** is in-memory (lost on restart; wouldn't work across multiple instances);
  trailing "N new messages" push after 30 s.

## 14. Reports & background jobs

- 🟠 Analytics hours now subtract breaks and skip rejected entries (**numbers drop**); project metrics
  only active projects; super-admin company list rewritten; dashboard polls `/admin/pending-count`.
- 🟠 P&L/WIP batched queries + new `time_entries(project_id)` index (0203).
- 🟠 Jobs: Friday reminders claimed per company/day (0202); shift reminders use company-local
  tomorrow and claim before sending (a crash loses that batch); inactive-worker alerts parse per
  company; Stripe event cleanup (daily); rate cache refresh (hourly); booking email zones;
  IMAP mailbox retry/timeout changes; `/admin/broadcast` responds before pushing.

## 15. Plan Room & PDF Tools

- 🔴 **pdf.js 3.11.174 → 4.10.38** via an ES-module loader — **page rendering not verified** in a real
  browser.
- 🟠 Escaping everywhere (`esc()`) — could show `&amp;`-style text if something was already escaped;
  load-time normalisation could coerce a legitimately non-numeric field.
- 🟠 Server validation caps on live ops / session docs / takeoffs — could reject a very large real plan.
- 🟠 Live sync batching; a rejected batch now **replaces the user's unsynced local edits** with the
  server copy.
- 🟡 Login guard moved to `shared/auth-guard.js`; cache-bust versions bumped.

## 16. Signup & onboarding

- 🟠 `welcomed_at` only on a real session; confirm-email returns company/username → prefilled login →
  setup questionnaire; expired trials → Billing; Free plan button now "Contact us"; onboarding
  checklist links/flags; per-route canonical; public visits keep a `registered` flag (0221).

## 17. Docs

`CLAUDE.md`, `docs/FOLLOW-UP.md`, `docs/WORKLOG.md`, `docs/MAP.md`, `docs/db-enums.md`, `SETUP.md`,
`docs/BACKUP-RESTORE.md`, this file. No runtime effect.
