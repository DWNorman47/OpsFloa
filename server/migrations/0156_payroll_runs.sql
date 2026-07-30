-- Finalized payroll runs. The Payroll tab computes a run live; "Finalize" snapshots
-- it into these tables so it stops recomputing (a locked record of what was paid),
-- and each check can then be marked paid. Money in CENTS. `detail` JSONB holds the
-- stub snapshot (hours, cost, deduction lines, exempt, combined gross) so a finalized
-- stub renders exactly as it was, independent of later config/time-entry edits.
-- Status columns are fixed-value → CHECK constraints (see server/constants/payrollEnums.js).

CREATE TABLE IF NOT EXISTS payroll_runs (
  id              SERIAL PRIMARY KEY,
  company_id      UUID    NOT NULL,
  period_from     DATE    NOT NULL,
  period_to       DATE    NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'finalized' CHECK (status IN ('finalized', 'void')),
  check_count     INTEGER NOT NULL DEFAULT 0,
  gross_cents     BIGINT  NOT NULL DEFAULT 0,
  deduction_cents BIGINT  NOT NULL DEFAULT 0,
  net_cents       BIGINT  NOT NULL DEFAULT 0,
  created_by      INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_company ON payroll_runs (company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS payroll_run_checks (
  id              SERIAL PRIMARY KEY,
  run_id          INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  company_id      UUID    NOT NULL,
  user_id         INTEGER,
  worker_name     VARCHAR(200),
  role_name       VARCHAR(120),
  ruleset_name    VARCHAR(120),
  pay_date        DATE,
  period_start    DATE,
  period_end      DATE,
  gross_cents     BIGINT  NOT NULL DEFAULT 0,
  deduction_cents BIGINT  NOT NULL DEFAULT 0,
  net_cents       BIGINT  NOT NULL DEFAULT 0,
  detail          JSONB,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
  paid_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_payroll_run_checks_run ON payroll_run_checks (run_id);
