-- Bid workflow M1 — bid due date + reminder dedup on estimates.
-- bid_due_at = when the bid must be SUBMITTED (distinct from valid_until, which
-- is how long our own quote stays good). bid_reminder_sent_at dedups the
-- "due soon" reminder; it's cleared when bid_due_at changes (see routes).
-- Idempotent.
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS bid_due_at TIMESTAMPTZ;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS bid_reminder_sent_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_estimates_bid_due
  ON estimates (company_id, bid_due_at) WHERE bid_due_at IS NOT NULL;
