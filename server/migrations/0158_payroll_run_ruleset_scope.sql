-- A company may run disjoint worker groups under different paycheck rulesets
-- whose covered dates happen to match. Scope run idempotency to the ruleset;
-- per-worker/date overlap protection in the finalize transaction remains the
-- guard against paying the same worker's work twice.

ALTER TABLE payroll_runs
  ADD COLUMN IF NOT EXISTS ruleset_id VARCHAR(40);

DROP INDEX IF EXISTS idx_payroll_runs_unique_period;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_runs_unique_period_ruleset
  ON payroll_runs (company_id, period_from, period_to, COALESCE(ruleset_id, ''))
  WHERE status <> 'void';
