-- QuickBooks contractor-bill ledger, v2 (POST /api/qbo/push-bills). Builds on 0211.
--
-- 1. qbo_bill_range_pay.kind gains 'worked': the worked pay (straight time, OT,
--    prevailing, night) billed per worker + DAY. A backdated raise (or any re-cost
--    of an already-billed day) is billed as current − ledgered on the next bill,
--    the same way range-level pay (leave / guarantee / floors) already is.
-- 2. status: 'billed' (on a QuickBooks bill) or 'baseline' — a lazily-seeded row
--    for pay billed BEFORE the ledger existed (entries stamped with a qbo_bill_id
--    before 0211 was applied): the first bill that meets such a day records the
--    amount computed at that moment as already billed instead of billing it again.
-- 3. credit_cents (<= 0): a negative adjustment held back because the worker's
--    next bill netted negative. The ledger keeps the old amount, so the credit is
--    carried forward and nets against the next positive bill — or an admin marks
--    a manual QuickBooks vendor credit as recorded (POST /api/qbo/bill-credits/record),
--    which applies it to amount_cents.
-- 4. qbo_bill_pushes: an outbox row per bill, written BEFORE createBill with the
--    Intuit requestid + the bill payload + the entry / reimbursement ids + the
--    ledger rows it carries; 'posted' once the stamps + ledger commit in one
--    transaction. A row left 'pending' (network error, or the DB write after the
--    bill failed) is replayed with the SAME requestid on the next push — Intuit
--    returns the existing bill instead of creating a second one — and finalized.
-- Fixed values: server/constants/qboEnums.js, docs/db-enums.md.

ALTER TABLE qbo_bill_range_pay DROP CONSTRAINT IF EXISTS chk_qbo_bill_range_pay_kind;
ALTER TABLE qbo_bill_range_pay ADD CONSTRAINT chk_qbo_bill_range_pay_kind
  CHECK (kind IN ('worked', 'daily_floor', 'weekly_guarantee', 'sick', 'vacation'));

ALTER TABLE qbo_bill_range_pay ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'billed';
ALTER TABLE qbo_bill_range_pay DROP CONSTRAINT IF EXISTS chk_qbo_bill_range_pay_status;
ALTER TABLE qbo_bill_range_pay ADD CONSTRAINT chk_qbo_bill_range_pay_status
  CHECK (status IN ('billed', 'baseline'));

ALTER TABLE qbo_bill_range_pay ADD COLUMN IF NOT EXISTS credit_cents BIGINT NOT NULL DEFAULT 0;
ALTER TABLE qbo_bill_range_pay DROP CONSTRAINT IF EXISTS chk_qbo_bill_range_pay_credit;
ALTER TABLE qbo_bill_range_pay ADD CONSTRAINT chk_qbo_bill_range_pay_credit CHECK (credit_cents <= 0);

CREATE INDEX IF NOT EXISTS idx_qbo_bill_range_pay_credit
  ON qbo_bill_range_pay (company_id, user_id) WHERE credit_cents <> 0;

CREATE TABLE IF NOT EXISTS qbo_bill_pushes (
  id                 SERIAL PRIMARY KEY,
  company_id         UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id         TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',
  bill               JSONB NOT NULL,
  total_cents        BIGINT NOT NULL,
  time_entry_ids     INTEGER[] NOT NULL DEFAULT '{}',
  reimbursement_ids  INTEGER[] NOT NULL DEFAULT '{}',
  ledger             JSONB NOT NULL DEFAULT '[]'::jsonb,
  qbo_bill_id        TEXT,
  created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_qbo_bill_pushes_status CHECK (status IN ('pending', 'posted')),
  CONSTRAINT uq_qbo_bill_pushes_request UNIQUE (company_id, request_id)
);

CREATE INDEX IF NOT EXISTS idx_qbo_bill_pushes_pending
  ON qbo_bill_pushes (company_id) WHERE status = 'pending';
