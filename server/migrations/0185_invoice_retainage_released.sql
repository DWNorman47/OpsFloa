-- Track retainage that has been RELEASED (billed back) per invoice, distinct
-- from retainage_held_cents (what the client withheld). Releasing draws down
-- outstanding = held − released without corrupting the original invoice's
-- record. The close-out "Retainage released" item auto-completes when a
-- project's outstanding retainage hits 0. Idempotent.

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS retainage_released_cents BIGINT NOT NULL DEFAULT 0;
