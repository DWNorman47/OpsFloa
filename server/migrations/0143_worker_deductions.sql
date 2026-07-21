-- Per-worker payroll deductions (loans, advances, garnishments, or a
-- worker-specific social-security / tax line). These are ADDITIONAL to the
-- company-wide deduction list stored in the `deductions` settings key; a pay
-- stub applies the company list first, then these.
--
-- `kind` mirrors the company list: 'percent' (of gross wages) or 'fixed' (a flat
-- amount per pay period). `cap_amount` optionally caps a percent deduction.
--
-- company_id is UUID with no FK (staging companies.id may still be INTEGER — same
-- posture as haul_tickets/0137). user_id FKs the INTEGER-keyed users table.
-- Idempotent.

CREATE TABLE IF NOT EXISTS worker_deductions (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id  UUID    NOT NULL,
  name        VARCHAR(120) NOT NULL,
  kind        VARCHAR(20)  NOT NULL DEFAULT 'percent',
  value       NUMERIC(12,4) NOT NULL DEFAULT 0,
  cap_amount  NUMERIC(12,2),
  active      BOOLEAN NOT NULL DEFAULT true,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_worker_deductions_kind CHECK (kind IN ('percent','fixed'))
);

CREATE INDEX IF NOT EXISTS idx_worker_deductions_company ON worker_deductions(company_id);
CREATE INDEX IF NOT EXISTS idx_worker_deductions_user    ON worker_deductions(user_id);
