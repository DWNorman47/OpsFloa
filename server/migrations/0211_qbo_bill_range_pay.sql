-- Ledger of range-level pay billed to contractors on QuickBooks Bills
-- (POST /api/qbo/push-bills). Paid leave, the weekly-hours guarantee and
-- min-daily floor top-ups aren't tied to one time entry, so the entry's
-- qbo_bill_id can't say whether they were billed. Before this, they were billed
-- only on the "first bill for a worker+range" heuristic: Sep 1–15 then Sep 1–30
-- never billed Sep 16–30 leave/guarantee, and Sep 1–7 then Sep 3–14 billed the
-- Sep 3–7 leave twice. One row per company + worker + kind + date (the week's
-- start date for weekly_guarantee) holds the amount billed so far; each bill
-- posts current − billed and upserts the new amount.
-- kind values: server/constants/qboEnums.js (QBO_BILL_RANGE_PAY_KINDS), docs/db-enums.md.
CREATE TABLE IF NOT EXISTS qbo_bill_range_pay (
  id            SERIAL PRIMARY KEY,
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  pay_date      DATE NOT NULL,
  amount_cents  BIGINT NOT NULL,
  hours         NUMERIC(10, 2) NOT NULL DEFAULT 0,
  qbo_bill_id   TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_qbo_bill_range_pay_kind CHECK (kind IN ('daily_floor', 'weekly_guarantee', 'sick', 'vacation')),
  CONSTRAINT uq_qbo_bill_range_pay UNIQUE (company_id, user_id, kind, pay_date)
);

CREATE INDEX IF NOT EXISTS idx_qbo_bill_range_pay_company_date
  ON qbo_bill_range_pay (company_id, pay_date);
