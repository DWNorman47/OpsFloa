# Owner follow-ups

Things **David** needs to do or decide, collected from the 2026-09-24 review passes.
Check items off (or delete them) as they're done. Engineering-only parked work lives in
`docs/BACKLOG.md`; this file is for actions that need the owner.

## Do soon
- [ ] **Reset the Neon `neondb_owner` password.** It was pasted in a chat on 2026-09-24
      (dev and dev-back share it). Neon → Roles → `neondb_owner` → Reset password, then
      update `DATABASE_URL` in `server/.env`, the **dev** service on Render, and any GitHub
      secrets that point at dev (e.g. the daily demo refresh workflow).
- [ ] **Set `MFA_ENCRYPTION_KEY` on Render (prod, stage, dev).** Without it the server now
      refuses to turn on 2FA rather than store TOTP secrets unencrypted. Existing 2FA users
      keep working. Use a long random value; never change it once set (existing secrets
      would become unreadable).
- [ ] **Confirm `APP_URL` is set on every Render service running `NODE_ENV=production`**
      (prod, stage, dev). As of 2026-09-24 the server refuses to boot without it (it used to
      mail out broken `undefined/...` links instead).
- [ ] *(Optional)* `TRIAL_CLIENT_EMAIL_DAILY_CAP` on Render — trial companies may send at most
      this many client-facing emails per day (default 50).
- [ ] **URGENT — set `DISABLE_BACKGROUND_JOBS=true` on the stage Render service** (do NOT
      set it on prod). Stage receives a nightly copy of PRODUCTION data; with jobs running it
      can email real customers (trial-expiry etc.) and, if it shares prod's R2 bucket, its
      media-retention job can delete production files. Also keeps the stage Neon branch idle.
- [ ] **Check stage's R2 settings** (`R2_PUBLIC_URL`, bucket name/credentials on the stage Render
      service) are a SEPARATE bucket from production's.

- [ ] **Set the repo variable `STAGING_DB_HOST`** (GitHub → Settings → Secrets and variables →
      Actions → *Variables*) to the stage Neon host, e.g. `ep-xxx.us-east-2.aws.neon.tech`
      (the `-pooler` part is optional). Until it is set, the nightly **prod → stage sync fails
      on purpose before touching anything** (new guard). The sync now also scrubs personal
      data and secrets and makes stage send no email — see `docs/BACKUP-RESTORE.md` §6.
- [ ] *(Optional)* **`STAGING_PASSWORD_HASH` secret** — a bcrypt hash of a stage-only password.
      Every stage account then signs in with that password. Without it no stage account can
      sign in (prod password hashes are no longer copied to stage).
- [ ] **Move the DB secrets into GitHub Environments** (can't be done from the repo): create
      `production` (PROD_DATABASE_URL, BACKUP_* — main only, you as required reviewer) and
      `staging` (STAGING_DATABASE_URL, STAGING_PASSWORD_HASH — main only). Today any workflow
      on any branch can read PROD_DATABASE_URL. Steps: `docs/BACKUP-RESTORE.md` §7.
- [ ] **Neon restore window:** check Settings → Instant restore on the Neon project and raise it
      to at least 7 days for prod (`docs/BACKUP-RESTORE.md` §2).
- [ ] *(Optional)* **Off-Neon backups:** add `BACKUP_PASSPHRASE` (+ optional `BACKUP_S3_*`) and
      run *Backup Production DB (manual)* from Actions once; it is manual-only until you decide
      where dumps live. Then do the restore drill (`docs/BACKUP-RESTORE.md` §5).
- [ ] **Branch protection:** CI job names changed (now "Server verify (ESLint + Jest)",
      "Migrations lint", "Client verify (ESLint + Vitest + Vite build)"). If `main`/`dev`
      require status checks, re-select these names or merges will wait forever on the old ones.
- [ ] **`TRIAL_LIMIT_PER_IP` on Render:** if it is set to `5` there, change it to `10` (or
      unset it) — the new default for a shared IPv4 address is 10 per 30 days; IPv6 /56 stays 5
      (`TRIAL_LIMIT_PER_IPV6_SUBNET`).

## Decisions pending
- [ ] **Invoice markup visibility.** An invoice created from an estimate now carries
      Overhead / Margin / Contingency as separate lines so its total matches the estimate.
      That shows the markup to the client (the public estimate page hides it). Alternative:
      spread the markup across the work lines. Tell Claude which you want.

- [ ] **Brand-name blocklist for company names?** Client emails now go out as
      "<Company> via OpsFloa" and trial companies are capped per day, but nothing stops a
      trial company named e.g. "PayPal Billing". Decide whether to block well-known brand
      names at sign-up.

- [ ] **QuickBooks contractor bills — billing model.** Incremental any-range billing keeps
      producing edge cases (patched 2026-09-24). Recommended: bill each contractor once per
      LOCKED pay period, with later changes as separate adjustment bills. Decide later.
      Known gap under the current model: an already-billed entry later moved to another
      date can end up billed nowhere.
- [ ] **Free plan.** The site advertises a $0 Free plan but no path leads to it. Either make it
      real (expired trials drop to Free, ≤3 workers) or remove it from the site. Decide later.

- [ ] **Free plan.** Deferred (your call). Until you decide, the Free card's button on Billing
      says **"Contact us"** (opens an email to info@opsfloa.com) — it used to do nothing.

## Decisions made (for reference)
- 2026-09-24 — **Company names stay globally unique** (login uses the company name).
- 2026-09-24 — **Browser extension (`extension/`) is out of scope** for reviews and fixes.
- 2026-09-24 — **Dated pay rates:** effective-dated history for worker, project prevailing,
  company default and company prevailing rates; backdating allowed; backdating into a
  locked pay period warns and requires confirmation.
- 2026-09-24 — **Backdated raise after QuickBooks billing:** the next bill charges the
  difference for already-billed days (worked hours and leave/guarantee alike).
- 2026-09-24 — **Client-facing email sender:** "<Company> via OpsFloa". (Not chosen: holding
  client emails until a trial company confirms its email — trial companies get a daily cap
  on client-facing emails instead.)
- 2026-09-24 — **Query timeout:** keep the 30 s statement timeout as a role default (0204).

## Scheduled
- [ ] **~2026-10-01: review CSP reports in Sentry** (Security / CSP reports). A tightened
      `Content-Security-Policy-Report-Only` is live; if the reports are clean (or only show
      hosts to allow), switch it to the enforced policy. The super-admin Mail page may report
      external images — keeping `img-src https:` there is fine.
- [ ] **2026-10-31: Plan Room legacy stream token sunset** — automatic, nothing to do.
      Cached old Plan Rooms stop being able to use the full-JWT stream URL after this date.

## Test on dev before merging `dev` → `main`
- [ ] Payroll CSV for a semimonthly/monthly period where a week straddles the boundary —
      those weeks now include their overtime (totals change).
- [ ] QuickBooks **sandbox**: connect (the final step now happens in the app), push time,
      push a contractor bill, push a payroll journal. **Confirm QuickBooks accepts a bill with
      a negative adjustment line** (guarantee true-ups can produce one).
- [ ] Plan Room live session on two devices: both see edits; plan PDF loads.
- [ ] Change Password with a wrong current password → stays logged in.
- [ ] Give a test worker a **backdated raise** → their pay stub splits at the right date.
- [ ] Backdate a rate into a **locked pay period** → warning + confirm appears.
- [ ] Clock out on a phone → confirm step shows project / hours minus break / mileage.
- [ ] Offline on a phone: clock in, submit a field report with photos, come back online →
      everything syncs, nothing duplicated.
- [ ] Create an invoice from an estimate → total matches the estimate.
- [ ] Deactivate a test company in Super Admin → its users are signed out with a message.
- [ ] **Plan Room + PDF Tools with a real plan set** — pdf.js was upgraded to 4.10.38 (security
      fix); pages rendering could not be verified in the headless preview.
- [ ] Daily report: a worker's first Submit shows as Submitted and an admin can approve it.
- [ ] Equipment: check out and return an asset (return now names its checkout).
- [ ] Work order: edit one while a tech marks it complete elsewhere → you get a conflict
      message, not a silent overwrite; scheduled times show in local time.
- [ ] QuickBooks bill credits: if a bill would go negative, the credit is held —
      `GET /api/qbo/bill-credits` lists them, `POST /api/qbo/bill-credits/record {user_id}`
      marks one recorded after you enter the vendor credit in QuickBooks (no UI yet).

- [ ] Sign up a new company → confirmation email link → lands on the sign-in page with company +
      username filled in and a green "Email confirmed" banner → after signing in you are on
      Administration with the setup questionnaire open.
- [ ] Log out and back in on a phone that had notifications on → a chat message still pushes
      (no need to visit Account). Two quick messages in one thread → one push now, then one
      "2 new messages · …" push ~30 s later.
- [ ] A trial company that has hit its daily client-email cap sends an invoice/estimate → yellow
      toast says it was NOT emailed (not "sent").
- [ ] Expired-trial admin logs in → lands on Administration → **Billing**; the Free card button
      says "Contact us" and opens an email.
- [ ] Dashboard onboarding checklist: links open Team / Projects / Company Settings; "Looks right"
      ticks the rate and time-zone steps.

- [ ] QuickBooks sandbox, round 5 additions: bills now carry a bill number (`OF-…`) and
      `ref <requestId>` in the memo — check QuickBooks doesn't warn about duplicate bill numbers.
      Open/stuck bills: `GET /api/qbo/bill-outbox` lists them, `POST /api/qbo/bill-outbox/:id/resolve`
      with `{action:'confirm', qbo_bill_id}` or `{action:'discard'}` (no UI yet).
- [ ] Lock a pay period, then as a worker clock out into it → the entry is saved as pending with
      a warning; an admin can't approve it until the period is unlocked.
- [ ] Certified payroll (WH-347) for one project where a worker also worked another project that
      week → overtime counts all projects; deductions + net wages columns appear; sign it, edit an
      entry → "data changed since signed".
- [ ] Time off: request overlapping days → refused; revoke an approved request; Fri–Mon vacation
      pays only Fri + Mon.
- [ ] Log out and back in on a phone → push notifications still arrive.

## Behaviour changes to know about (2026-09-24, round 5)
- Leave no longer pays weekends / non-working days; balances and allowances count working days
  only; overlapping leave requests are refused; approving past the annual allowance needs a
  confirm.
- "Toward worker" rounding snaps to the schedule only within the grace window (Honduras preset:
  leaving at 11:00 now pays 4h, not 9h). Auto-break applies once per worker-day.
- Admins need `approve_entries` for time-off approvals and `manage_reimbursements` for expenses
  (403 otherwise); scoped admins only see their workers. Pay-period lock/unlock needs
  `manage_pay_periods`.
- Locked pay periods block every time edit/approve/reject path (409). A worker clocking out into
  a locked period still gets the entry saved (pending, flagged).
- Contractors with a weekly guarantee and no hours in the range are now billed the guarantee.
- The new safe stage sync only takes effect after merging to `main` (GitHub runs scheduled
  workflows from the default branch) — until then the OLD unscrubbed nightly copy keeps running.

## Behaviour changes to know about (2026-09-24, round 4)
- Weekly guarantee is computed per company week (a pay period shorter than a week no longer
  earns a full week's guarantee); stubs, payroll and QuickBooks now agree.
- Payroll CSV / overtime report / QuickBooks payroll list only people with approved time or
  leave in the range (plus active workers with a guarantee); owners and unpaid never.
- Only admins can delete incident reports.
- A backdated raise after QuickBooks billing is billed as a difference on the next bill.

## Growth notes (no action yet)
- `PG_POOL_MAX` (default 10) can be raised to 20 on Render any time — cheap headroom.
- Around 30–50 companies: move to a bigger Render instance; watch its CPU/memory and
  Neon's compute graph.
- Before running **more than one server instance**: background jobs must run on one
  instance only (or behind DB locks), and Plan Room live sessions need cross-instance
  messaging. Scope this as a project when needed.

## Known leftovers (only if you want them done)
- Files uploaded before 2026-09-24 use old flat R2 keys, so they can't be tied to a
  company; fully closing that needs a small ownership table.
- Safety-talk / field-report uploads now reject unusual file types (e.g. `.dwg`).
- Partial moves between bins at the same inventory location are refused (needs the bin in
  the stock key to support).
- The 7th-consecutive-day OT premium can still be split by a pay-period boundary.
- QuickBooks payroll journals posted before 2026-09-24 aren't in the new ledger, so an
  overlapping range against them can't be detected.
- 3 moderate npm advisories (via `intuit-oauth`) have no fix available.
- Invoice/estimate/booking email *subjects* still carry unescaped names (CR/LF is stripped,
  so no header injection); booking's client confirmation doesn't use the "via OpsFloa"
  sender or the trial cap yet.
