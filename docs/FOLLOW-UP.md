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
- [ ] **(If not already done) set `DISABLE_BACKGROUND_JOBS=true` on the stage Render
      service** — from the Neon cost notes (`docs/claude-memory/project_neon_compute.md`);
      keeps the stage DB branch idle. Do NOT set it on prod.

## Decisions pending
- [ ] **Invoice markup visibility.** An invoice created from an estimate now carries
      Overhead / Margin / Contingency as separate lines so its total matches the estimate.
      That shows the markup to the client (the public estimate page hides it). Alternative:
      spread the markup across the work lines. Tell Claude which you want.

- [ ] **Brand-name blocklist for company names?** Client emails now go out as
      "<Company> via OpsFloa" and trial companies are capped per day, but nothing stops a
      trial company named e.g. "PayPal Billing". Decide whether to block well-known brand
      names at sign-up.

## Decisions made (for reference)
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
