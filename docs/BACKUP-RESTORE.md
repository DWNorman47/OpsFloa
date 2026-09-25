# Backup & restore (Neon Postgres)

How OpsFloa's data is protected, how to get it back, and how to prove that works.
Branches: **main** (prod), **stage**, **dev** — all in one Neon project.

> Nothing in here runs by itself. Every command below is run by a human, on purpose,
> against a URL they chose. Commands that WRITE are marked **(writes)**.

---

## 1. What protects us today

| Layer | What it covers | Where |
|---|---|---|
| **Neon point-in-time restore (PITR)** | Any moment inside the project's *restore window* (history retention), every branch | Neon Console |
| **Manual encrypted `pg_dump`** | A copy *outside* Neon (survives a deleted project / account problem) | `.github/workflows/backup-prod-db.yml` — manual, opt-in |
| Stage copy of prod | **Not a backup** — nightly, scrubbed (no emails/phones/tokens), and wiped on a failed run | `.github/workflows/sync-staging-db.yml` |

PITR is the first line: it's fast and exact. The `pg_dump` copy is for the day Neon itself
is the problem.

---

## 2. Neon PITR retention (the restore window)

**Check it:** Neon Console → your project → **Settings → Instant restore** (older consoles
call it *History retention* / *Restore window*). It shows the window, e.g. "1 day".

**Raise it:** same page → drag/select a longer window → Save. The maximum depends on the
plan (roughly: Free = hours, Launch = up to 7 days, Scale = up to 30 days — check the
current plan page). Longer windows cost a little more storage (Neon keeps the WAL).

Via the API (same thing, scriptable):

```bash
# read
curl -s -H "Authorization: Bearer $NEON_API_KEY" \
  https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID | jq '.project.history_retention_seconds'
# set 7 days  (writes — project setting only, no data)
curl -s -X PATCH -H "Authorization: Bearer $NEON_API_KEY" -H "Content-Type: application/json" \
  -d '{"project":{"history_retention_seconds":604800}}' \
  https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID
```

**Recommendation:** at least **7 days** for prod. A payroll mistake is often noticed only at
the next pay run (a week later); a 1-day window would already have lost the good state.

---

## 3. Restore a branch to a timestamp (the incident procedure)

Use this when data was damaged (bad migration, bad script, bulk delete) and you know roughly
*when*. It never overwrites anything until the last step, and that step is atomic.

### 3.1 Pick the moment
Find the last good time (UTC). Useful sources: Render deploy log, the `audit_log` table,
`schema_migrations.applied_at`, Sentry. Pick a time **just before** the damage.

### 3.2 Create a branch from that moment (read-only for the damaged branch)
Neon Console → **Branches → Create branch**
- Parent: the damaged branch (e.g. `main` or `dev`)
- **Include data up to: Specific date and time** → your UTC timestamp
- Name: `restore-<branch>-<yyyymmdd-hhmm>`

(CLI equivalent: `neonctl branches create --project-id $NEON_PROJECT_ID --name restore-dev-20260924-1500 --parent dev@2026-09-24T15:00:00Z` — check `neonctl branches create --help` for the exact
point-in-time syntax of your CLI version.)

Copy the new branch's connection string → `RESTORE_URL`. Open it in the SQL Editor and
confirm the data really is the good state (count rows in the table that was damaged).

### 3.3 Dump the restore branch
```bash
pg_dump "$RESTORE_URL" --no-owner --no-acl --format=custom --file=restore.pgc
pg_restore --list restore.pgc | grep -c "TABLE DATA"   # sanity: non-zero
```

### 3.4 Snapshot the damaged target first
Even a damaged DB may hold rows written *after* the incident that you'll want back.
```bash
pg_dump "$TARGET_URL" --no-owner --no-acl --format=custom --file=before-restore.pgc
```
(Or create another Neon branch of the target "as of now" — cheaper and instant.)

### 3.5 Restore into the target — one transaction (writes)
Stop writers first: pause the Render service (or set it to maintenance) for that environment,
so nothing writes mid-restore.
```bash
pg_restore --dbname "$TARGET_URL" --no-owner --no-acl \
  --clean --if-exists --single-transaction --exit-on-error restore.pgc
```
`--single-transaction` + `--exit-on-error`: either the whole restore lands or none of it does —
never a half-restored database.

**Partial restore** (only some rows / one table — usually what you want when the rest of the
DB has good writes since the incident): don't `--clean` everything. Keep the `restore-*`
branch and copy just the affected rows across, e.g. with `\copy` to CSV:
```bash
psql "$RESTORE_URL" -c "\copy (SELECT * FROM time_entries WHERE company_id = '<id>' AND work_date >= '2026-09-01') TO 'rows.csv' CSV HEADER"
# (writes) — inside one transaction: delete the damaged rows, load the good ones
psql "$TARGET_URL" -v ON_ERROR_STOP=1 --single-transaction \
  -c "DELETE FROM time_entries WHERE company_id = '<id>' AND work_date >= '2026-09-01'" \
  -c "\copy time_entries FROM 'rows.csv' CSV HEADER"
```
Mind foreign keys (restore parents before children) and sequences
(`SELECT setval(...)` if you inserted explicit ids above the current value).

### 3.6 Verify
```sql
-- run on BOTH restore branch and target; the numbers must match
SELECT (SELECT COUNT(*) FROM companies) companies, (SELECT COUNT(*) FROM users) users,
       (SELECT COUNT(*) FROM time_entries) entries, (SELECT COUNT(*) FROM invoices) invoices,
       (SELECT MAX(filename) FROM schema_migrations) last_migration;
```
Then: start the server, log in, open a pay stub / invoice / time clock for a known company.
Check `schema_migrations`: if the restore point predates a migration, the server re-applies it
on boot (`npm start` runs `migrate.js`) — make sure that's what you want.

### 3.7 Clean up
Delete the `restore-*` branch once you're sure (it costs storage). Delete the local `.pgc`
files — **they contain every customer's data** (`shred`/secure-delete them).

---

## 4. Off-Neon copy: the manual backup workflow

`.github/workflows/backup-prod-db.yml` — **workflow_dispatch only** (no schedule), reads prod,
writes nothing to any DB.

1. `pg_dump` prod (custom format), sanity-checks it lists `users` data.
2. Encrypts it with `gpg --symmetric --cipher-algo AES256` using the `BACKUP_PASSPHRASE` secret.
   The unencrypted dump never leaves the runner.
3. Uploads the encrypted file as a workflow artifact (retention you choose, default 14 days),
   and to a separate S3-compatible bucket if the `BACKUP_S3_*` secrets exist (use a
   **different** R2 bucket/account from the app's uploads bucket, with its own key).

Setup (owner): add `BACKUP_PASSPHRASE` (store it in your password manager too — without it
the backups are unreadable), optionally `BACKUP_S3_BUCKET` / `BACKUP_S3_ENDPOINT` /
`BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY`. Run it from Actions → *Backup
Production DB (manual)* → Run workflow. To make it periodic, add a `schedule:` (weekly is
plenty with a 7-day PITR window) — only after the storage + access decision is made.

Decrypt + inspect:
```bash
gpg --decrypt opsfloa-prod-<stamp>.pgc.gpg > prod.pgc
pg_restore --list prod.pgc | head
```

---

## 5. Restore drill (do it quarterly)

A backup you've never restored is a hope, not a backup. ~20 minutes:

1. Neon → create branch `drill-<yyyymmdd>` from **main** at "now − 1 hour" (PITR path).
2. Run the §3.6 counts on the drill branch and on main; they should be close (main has the
   last hour's writes).
3. Take the latest encrypted artifact from §4, decrypt, and restore it into a **new empty
   branch** (`drill-dump-<yyyymmdd>`, created with "no data"/schema-only or wiped first):
   `pg_restore --dbname "$DRILL_URL" --no-owner --no-acl --single-transaction --exit-on-error prod.pgc`
4. Counts again. Point a local server (`DATABASE_URL=$DRILL_URL`, `DISABLE_BACKGROUND_JOBS=true`,
   `EMAIL_MODE=suppress`, `NODE_ENV=development`) at it and log in.
5. Write the date, durations and any surprise in `docs/WORKLOG.md`. Delete both drill branches
   and the local files.

---

## 6. Stage sync (prod → stage) — what it does to the data

`.github/workflows/sync-staging-db.yml`, nightly + on demand:

- **Guard** — refuses to run unless the stage host differs from prod's and matches the repo
  variable `STAGING_DB_HOST` (exact host, or a glob like `ep-stage-*.neon.tech`; Neon's
  `-pooler` suffix is ignored). Unset variable → nothing is touched.
- **Scrub** (one transaction, right after the restore):
  - every user email → `user+<id>@example.invalid` (deterministic, unique; `.invalid` is an
    RFC 2606 reserved TLD and `server/email.js` never sends to it);
  - every text column named `*email`, `*phone`, `*mobile`, `*token`, `*token_hash`, `ip`,
    `ip_address`, `registration_ip`, `user_agent` in **any** table → NULL (or a throwaway
    value when NOT NULL) — clients, estimates, invoices, appointments, service requests,
    subcontractors, suppliers, affiliates, submittals, invite/reset/confirm tokens, public
    link token hashes, …;
  - MFA secrets + pending secrets NULL and MFA off; SSN digits NULL;
  - QuickBooks access/refresh tokens + realm, Stripe customer/subscription/Connect ids NULL;
  - `push_subscriptions`, `location_pings`, `login_failures`, `client_errors`,
    `stripe_webhook_events` emptied;
  - every `token_version` bumped (old sessions die);
  - `system_flags.email_mode = 'suppress'` → the stage server sends **no email at all**, even
    with `NODE_ENV=production`.
- **Passwords — decision:** every password hash is replaced. If the `STAGING_PASSWORD_HASH`
  secret is set (a bcrypt hash of a stage-only password, e.g. from
  `node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 10))" '<password>'`),
  every stage account logs in with that one password — handy for QA, and prod hashes never
  leave prod. If it's not set, no stage account can log in (the placeholder isn't a bcrypt
  hash, so nothing matches). Real prod hashes are never copied: a leaked stage DB can't be
  cracked for prod passwords.
- **Not scrubbed** (by design, so stage stays useful): names, addresses, notes, pay rates and
  amounts, uploaded file URLs, free-text/JSON fields (a client email typed into a note or an
  estimate snapshot JSON survives). Treat stage as confidential.
- **Verify** — counts that must be zero; any failure after the wipe **drops the stage schema**
  so a raw prod copy is never left behind.

---

## 7. Recommended (owner, in GitHub settings — can't be done from the repo)

- **GitHub Environments:** create `production` and `staging` environments
  (Settings → Environments). Move `PROD_DATABASE_URL`, `BACKUP_PASSPHRASE`, `BACKUP_S3_*` into
  `production`; `STAGING_DATABASE_URL` + `STAGING_PASSWORD_HASH` into `staging`. Restrict each
  to the `main` branch ("Deployment branches: selected") and add yourself as a **required
  reviewer** on `production`. Then add `environment: staging` to the sync job and
  `environment: production` (already present) to the backup job. Today any workflow on any
  branch can read the repo-level `PROD_DATABASE_URL`.
- Keep the Neon role used by GitHub **separate** from the app's role, and give the backup job a
  **read-only** role on prod (`pg_dump` needs only SELECT).
- Rotate `PROD_DATABASE_URL` / `STAGING_DATABASE_URL` whenever someone with access leaves.
