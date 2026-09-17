---
name: project_neon_compute
description: "Why Neon compute jumped to ~$80/mo and the fixes — root cause (always-on branches), the diagnostic method, what shipped, and the env var David still must set"
metadata: 
  node_type: memory
  type: project
  originSessionId: 85776767-90bb-4223-b040-db72b6b6edd9
  modified: 2026-09-03T21:23:30.890Z
---

The Neon "Compute" bill (David's, Sep 2026): free for months → ~$17 (Jul 17–31, a **partial
15-day** first paid period) → ~$76 + AZ tax (full Jul 31–Aug 31). **Pricing is flat
(~$0.106/CU-hr), no tier/overage** — so the bill scales linearly with CU-hours. It was NOT
Vercel (every Vercel meter was under free tier) and NOT the prod→stage sync.

**Root cause: two branches kept ACTIVE 24/7.** From Neon → Branches, compute split ~evenly:
`main` and `stage` each ~31 CU-hrs (Active), `dev` ~0.25 (Idle). Each active branch ≈ 12
CU-hrs/day ≈ ~$38/mo. Mechanism: David upgraded the **stage Render service to paid ($7)** so
it stays warm (fast loads); an always-on server runs ALL background jobs 24/7; those jobs
query the DB (the transcription poller every 20s, sweeps every 15m), so the stage Neon branch
**never scales to zero**. `main` is the same via the prod server's jobs (its Jul baseline).
`dev` has no always-on server → idle. So the Aug "doubling" = stage becoming a second
always-on branch; the Jul→Aug "4×" is really 2× (partial-month vs full-month invoice) × ~2×
(stage added).

**Diagnostic method (use this, don't flail across providers):**
1. Neon → **Billing/Invoices** for $ per line (compute vs storage; confirms flat rate).
2. Neon → **Branches** for per-branch CU-hrs + Active/Idle state (this is what cracked it).
3. `pg_stat_statements` in the SQL Editor (per branch) for which queries hit most.
Vercel compute for a static SPA is ~zero; don't chase it.

**Fixes shipped 2026-09-03 (dev):**
- `server/index.js`: ALL background-job startup gated behind `DISABLE_BACKGROUND_JOBS`
  (default ON, so prod is unchanged). `/api/health` skips its `SELECT 1` when that flag is set
  (use `/api/health/live` — always DB-free — for recurring liveness probes).
- `server/jobs/transcriptionPoller.js`: **bounded polling window** so it can't poll forever.
  `activeUntil` = now+45min, set by submit/retry (`scheduleEarlyPoll` → `notePendingTranscription`);
  the 20s cron no-ops (zero DB queries) once the window closes; a `processing` row stuck >30min
  is force-failed; boot opens one catch-up window. Test: `transcriptionPollerGate.test.js`.
- Prod continuous DB-touchers trimmed (2026-09-03) so `main` can idle overnight too:
  `/api/health` DB `SELECT 1` now only runs on `?deep=1` (recurring probes never wake the DB —
  so the Render health-check path no longer matters); booking reminders OFF by default
  (`ENABLE_BOOKING_REMINDERS=true` to restore — Online Booking unused); `liveSessionSweep`
  gated to an armed window (armed on session create, disarms when zero active remain).
- prod→stage sync (`.github/workflows/sync-staging-db.yml`) is back to **nightly** (`0 6 * * *`)
  as of 2026-09-03 — it's cheap (DB ~50MB → 1-2 min dump/restore that briefly wakes stage then
  lets it idle again, since stage's jobs are off). Was weekly for a while; the sync was never the
  real cost driver (the always-on branches were).
  (`refresh-demo-operations.yml` reseeds demo daily on dev/stage/prod — also cheap; dev accrues ~0.)

**STILL OWED by David (the code does nothing until this is set):**
- **Set `DISABLE_BACKGROUND_JOBS=true` on the STAGE Render service** (and any always-on dev
  service). Do NOT set it on prod. Optionally point stage's Render health-check path at
  `/api/health/live`.
- **Verify** on Neon → Branches: `stage` (and `main` when idle overnight) should flip
  Active→Idle and CU-hrs should flatten. If either stays Active while unused, something else
  is polling it — dig with `pg_stat_statements`.

**Deferred on purpose (David: "leave it for now"):** making the poller fully in-memory (zero
idle DB *reads* — it currently re-reads "who's processing?" from the DB each in-window tick),
and AssemblyAI **webhooks** (needs a public secured callback + a fallback poll; local dev has
no public URL — the original reason polling was chosen). The bounded window already lets Neon
idle, so these are optional polish. Related: [[project_infrastructure]], [[feedback_no_deploy_mentions]].
