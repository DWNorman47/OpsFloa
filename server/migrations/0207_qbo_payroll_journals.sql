-- Ledger of payroll journal entries pushed to QuickBooks (POST /api/qbo/push-payroll).
-- Before this, the only duplicate protection was Intuit's requestid keyed on
-- company|from|to: a corrected re-push of the same range silently returned the
-- original JE (no correction posted) and an overlapping range posted the overlap
-- twice. With a local record per posting the route can post the DIFFERENCE for a
-- corrected range (amount_cents is signed: a negative row is a reversing
-- adjustment) and refuse an overlapping range. No fixed-value columns → not a
-- db-enums entry.
CREATE TABLE IF NOT EXISTS qbo_payroll_journals (
  id                SERIAL PRIMARY KEY,
  company_id        UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_from       DATE NOT NULL,
  period_to         DATE NOT NULL,
  amount_cents      BIGINT NOT NULL,
  request_id        TEXT NOT NULL,
  qbo_entry_id      TEXT,
  debit_account_id  TEXT,
  credit_account_id TEXT,
  created_by        INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT qbo_payroll_journals_range_chk CHECK (period_from <= period_to),
  CONSTRAINT uq_qbo_payroll_journals_request UNIQUE (company_id, request_id)
);

CREATE INDEX IF NOT EXISTS idx_qbo_payroll_journals_company_range
  ON qbo_payroll_journals (company_id, period_from, period_to);
