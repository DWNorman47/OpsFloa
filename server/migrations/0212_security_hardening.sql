-- Security hardening (auth / billing / company purge review).
--
-- 1. MFA brute-force + replay protection on users:
--      mfa_failed_attempts  — consecutive wrong TOTP codes at /auth/mfa/confirm;
--                             reset only on a successful second factor.
--      mfa_locked_until     — set after too many wrong codes (the route locks
--                             the second factor for a cool-down window).
--      mfa_last_used_step   — the 30-second TOTP time-step of the last ACCEPTED
--                             code; a code at or before this step is refused, so
--                             an observed code can't be replayed inside its window.
--
-- 2. stripe_webhook_events — de-dupe table for Stripe webhook deliveries. Stripe
--    retries and can deliver the same event more than once; the handler inserts
--    the event id first and skips any id it has already processed (the row is
--    removed again if processing fails, so Stripe's retry is still applied).
--
-- 3. haul_tickets.created_by was created (0137) as a bare REFERENCES users(id)
--    (NO ACTION), so deleting a user who ever created a haul ticket — including
--    the whole-company purge — raised an FK violation. Every other created_by
--    column is ON DELETE SET NULL; match them.

ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_locked_until    TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_last_used_step  BIGINT;

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id    TEXT        PRIMARY KEY,
  event_type  TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_received_at ON stripe_webhook_events (received_at);

-- Drop whatever FK currently sits on haul_tickets.created_by (the 0137 default
-- name is haul_tickets_created_by_fkey, but look it up rather than assume), then
-- re-add it with ON DELETE SET NULL.
DO $$
DECLARE
  con RECORD;
BEGIN
  IF to_regclass('public.haul_tickets') IS NULL THEN
    RETURN;
  END IF;
  FOR con IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.conrelid = 'public.haul_tickets'::regclass
       AND c.contype = 'f'
       AND a.attname = 'created_by'
  LOOP
    EXECUTE format('ALTER TABLE haul_tickets DROP CONSTRAINT %I', con.conname);
  END LOOP;
  ALTER TABLE haul_tickets
    ADD CONSTRAINT haul_tickets_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
END $$;
