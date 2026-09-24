-- One live (non-void) invoice per source estimate. POST /invoices/from-estimate
-- now locks the estimate row and 409s when a non-void invoice already carries its
-- source_estimate_id; this partial unique index is the DB backstop (raw SQL, a
-- future endpoint, a lock-free path). Voiding the invoice frees the estimate to
-- be reissued, so the "void + reissue" correction flow still works.
--
-- Existing data may already hold duplicates (the bug this closes). We never
-- auto-void money documents in a migration, so if any duplicates exist the index
-- is SKIPPED with a WARNING instead of failing the boot — the app-level check
-- still prevents new ones. Resolve by voiding the extras, then create the index
-- by hand (same statement) or in a follow-up migration.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM invoices
     WHERE source_estimate_id IS NOT NULL AND status <> 'void'
     GROUP BY source_estimate_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE WARNING '0213: duplicate live invoices per source_estimate_id exist; uq_invoices_source_estimate_live NOT created — void the duplicates and create it manually';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_source_estimate_live
      ON invoices (source_estimate_id)
      WHERE source_estimate_id IS NOT NULL AND status <> 'void';
  END IF;
END $$;
