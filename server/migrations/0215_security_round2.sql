-- Security review round 2.
--
-- 1. stripe_webhook_events.processed_at — the de-dupe claim (0212) was committed
--    BEFORE the handler ran, so a crash mid-handler (process killed, deploy) left
--    a claim that made every Stripe retry a "duplicate" no-op: the event was lost.
--    Now processed_at is set only once the handler succeeds; a claim row with
--    processed_at NULL older than a few minutes is treated as abandoned and may be
--    re-claimed by a redelivery (routes/stripe.js). Existing rows were either
--    processed or released (deleted) under the old code, so backfill them as
--    processed. Pruned after 90 days by jobs/stripeEventsCleanup.js.
--
-- 2. time_entries.clock_out_late_minutes — like clock_in_late_minutes (0200) for
--    the clock-OUT instant: a client-claimed clock_out_time more than 10 minutes
--    before the server received it is still honoured (offline replays) but the
--    lag is stored so Approvals shows a "Late clock-out" badge — a shortened /
--    backdated clock-out can no longer pass as an ordinary punch.
--
-- 3. companies.client_email_count / client_email_count_day — per-company daily
--    counter for client-facing email (invoices, estimates) sent while the
--    company is in TRIAL; email.js refuses sends past TRIAL_CLIENT_EMAIL_DAILY_CAP
--    (default 50) to limit phishing abuse from throwaway trial accounts. The
--    counter resets whenever client_email_count_day is not today.

ALTER TABLE stripe_webhook_events ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;
UPDATE stripe_webhook_events SET processed_at = received_at WHERE processed_at IS NULL;

ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS clock_out_late_minutes INTEGER;

ALTER TABLE companies ADD COLUMN IF NOT EXISTS client_email_count     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS client_email_count_day DATE;
