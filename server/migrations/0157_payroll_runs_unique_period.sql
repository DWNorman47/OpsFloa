-- Prevent duplicate finalized payroll runs for the same period (idempotent finalize).
-- The route guards with a SELECT-before-INSERT, but that races under concurrency: two
-- admins (or a double-submit) both spend time in the live compute, both open a
-- transaction, both see zero rows under READ COMMITTED, and both insert. A partial
-- unique index is the real guard; the route now catches its violation (23505) as a
-- clean 409 instead of silently creating a duplicate run + duplicate checks.

-- Resolve any duplicates that slipped in before this guard: keep the earliest finalized
-- run per (company, period), void the rest. Voided runs are excluded from pay and
-- reporting, so this doesn't change what anyone was actually paid — and without it the
-- unique index below couldn't be created (boot would fail).
UPDATE payroll_runs pr SET status = 'void'
  WHERE status <> 'void'
    AND EXISTS (
      SELECT 1 FROM payroll_runs older
       WHERE older.company_id  = pr.company_id
         AND older.period_from = pr.period_from
         AND older.period_to   = pr.period_to
         AND older.status <> 'void'
         AND older.id < pr.id
    );

CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_runs_unique_period
  ON payroll_runs (company_id, period_from, period_to)
  WHERE status <> 'void';
