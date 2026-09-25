-- QuickBooks contractor bills: double-billing guards (POST /api/qbo/push-bills).
-- Builds on 0211 + 0214.
--
-- 1. time_entries.qbo_pre_ledger_bill — the cutover flag, FROZEN. The bill code
--    used to derive "billed before the range-pay ledger existed" from
--    qbo_synced_at < (0211 applied_at) on every push, but qbo_synced_at is
--    rewritten by the time-activity push, auto-push on approve, unapprove and
--    reject cleanup, so the flag drifted and pay billed before the ledger could
--    be billed again. Computed ONCE here, from the 0211 cutover (this
--    migration's own NOW() when 0211 has no applied_at). Nothing writes it after.
-- 2. qbo_bill_pushes.status gains 'mismatch' (QuickBooks returned a bill whose
--    TotalAmt differs from the outbox row — the bill exists, so the row is kept
--    with its bill id and the worker stays blocked until an admin resolves it)
--    and 'discarded' (an admin confirmed no bill exists in QuickBooks —
--    POST /api/qbo/bill-outbox/:id/resolve {action:'discard'}). A pending row is
--    no longer deleted when its replay fails.
-- 3. qbo_bill_pushes.force — the push was a forced re-push (its entries were
--    already stamped); stamping otherwise only claims entries no bill holds.
-- Fixed values: server/constants/qboEnums.js, docs/db-enums.md.

ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS qbo_pre_ledger_bill BOOLEAN NOT NULL DEFAULT false;

-- schema_migrations exists on every real DB (migrate.js creates it), but not when the
-- migrations are applied raw (scripts/lintMigrations.js on a fresh DB) — look it up
-- dynamically so this file applies either way; without it the cutover is NOW().
DO $$
DECLARE cutover TIMESTAMPTZ;
BEGIN
  IF to_regclass('schema_migrations') IS NOT NULL THEN
    EXECUTE $q$SELECT applied_at FROM schema_migrations WHERE filename = '0211_qbo_bill_range_pay.sql'$q$
      INTO cutover;
  END IF;
  UPDATE time_entries
     SET qbo_pre_ledger_bill = true
   WHERE qbo_bill_id IS NOT NULL
     AND qbo_pre_ledger_bill = false
     AND (qbo_synced_at IS NULL OR qbo_synced_at < COALESCE(cutover, NOW()));
END $$;

ALTER TABLE qbo_bill_pushes ADD COLUMN IF NOT EXISTS force BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE qbo_bill_pushes DROP CONSTRAINT IF EXISTS chk_qbo_bill_pushes_status;
ALTER TABLE qbo_bill_pushes ADD CONSTRAINT chk_qbo_bill_pushes_status
  CHECK (status IN ('pending', 'posted', 'mismatch', 'discarded'));

DROP INDEX IF EXISTS idx_qbo_bill_pushes_pending;
CREATE INDEX IF NOT EXISTS idx_qbo_bill_pushes_open
  ON qbo_bill_pushes (company_id) WHERE status IN ('pending', 'mismatch');
