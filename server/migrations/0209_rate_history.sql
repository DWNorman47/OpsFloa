-- Effective-dated pay rates (worker rate + rate type, project prevailing rate,
-- company default rate).
--
-- Before this, every pay surface priced entries from the CURRENT
-- users.hourly_rate / users.rate_type / projects.prevailing_wage_rate /
-- settings.default_hourly_rate, so a raise today silently re-priced last year's
-- pay stubs, re-run payroll CSVs, finished-job P&L and QBO re-pushes.
--
-- Resolution rule (server/utils/rateHistory.js): the rate for an entry is the
-- history row with the greatest effective_date <= entry.work_date. The old
-- columns stay as the CURRENT-rate cache (= the row in effect today, company
-- time zone), refreshed on every history write and by a daily job for
-- future-dated rows.
--
-- Backfill: one row per existing worker / project-with-a-prevailing-rate /
-- company-with-a-default-rate, holding the CURRENT value at effective_date
-- '1900-01-01' — so pay for all existing history is unchanged by this migration.
-- Idempotent (ON CONFLICT DO NOTHING).

CREATE TABLE IF NOT EXISTS worker_rate_history (
  id             SERIAL PRIMARY KEY,
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- NULL / 0 = no personal rate → the company default in effect that day.
  hourly_rate    NUMERIC(10,2),
  rate_type      VARCHAR(20) NOT NULL DEFAULT 'hourly',
  effective_date DATE NOT NULL,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note           TEXT,
  CONSTRAINT chk_worker_rate_history_rate_type CHECK (rate_type IN ('hourly', 'daily')),
  CONSTRAINT chk_worker_rate_history_rate_nonneg CHECK (hourly_rate IS NULL OR hourly_rate >= 0),
  CONSTRAINT uq_worker_rate_history_user_date UNIQUE (user_id, effective_date)
);
CREATE INDEX IF NOT EXISTS idx_worker_rate_history_user_date
  ON worker_rate_history (user_id, effective_date);
CREATE INDEX IF NOT EXISTS idx_worker_rate_history_company
  ON worker_rate_history (company_id);

CREATE TABLE IF NOT EXISTS project_prevailing_rate_history (
  id             SERIAL PRIMARY KEY,
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- NULL = the project has no prevailing rate of its own from this date
  -- (prevailing entries fall back to the company prevailing_wage_rate setting).
  rate           NUMERIC(10,2),
  effective_date DATE NOT NULL,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note           TEXT,
  CONSTRAINT chk_project_prevailing_rate_history_nonneg CHECK (rate IS NULL OR rate >= 0),
  CONSTRAINT uq_project_prevailing_rate_history_project_date UNIQUE (project_id, effective_date)
);
CREATE INDEX IF NOT EXISTS idx_project_prevailing_rate_history_project_date
  ON project_prevailing_rate_history (project_id, effective_date);
CREATE INDEX IF NOT EXISTS idx_project_prevailing_rate_history_company
  ON project_prevailing_rate_history (company_id);

CREATE TABLE IF NOT EXISTS company_default_rate_history (
  id             SERIAL PRIMARY KEY,
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  rate           NUMERIC(10,2) NOT NULL,
  effective_date DATE NOT NULL,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note           TEXT,
  CONSTRAINT chk_company_default_rate_history_nonneg CHECK (rate >= 0),
  CONSTRAINT uq_company_default_rate_history_company_date UNIQUE (company_id, effective_date)
);
-- The UNIQUE (company_id, effective_date) constraint's index serves the lookup.

-- ── Backfill: CURRENT values as the rate in effect since forever ────────────
INSERT INTO worker_rate_history (company_id, user_id, hourly_rate, rate_type, effective_date, note)
SELECT u.company_id, u.id, CASE WHEN u.hourly_rate < 0 THEN 0 ELSE u.hourly_rate END,
       CASE WHEN u.rate_type IN ('hourly', 'daily') THEN u.rate_type ELSE 'hourly' END,
       DATE '1900-01-01', 'Backfilled from the rate on file when rate history was introduced'
  FROM users u
 WHERE u.company_id IS NOT NULL
ON CONFLICT (user_id, effective_date) DO NOTHING;

INSERT INTO project_prevailing_rate_history (company_id, project_id, rate, effective_date, note)
SELECT p.company_id, p.id, CASE WHEN p.prevailing_wage_rate < 0 THEN 0 ELSE p.prevailing_wage_rate END,
       DATE '1900-01-01', 'Backfilled from the rate on file when rate history was introduced'
  FROM projects p
 WHERE p.company_id IS NOT NULL
   AND p.prevailing_wage_rate IS NOT NULL
ON CONFLICT (project_id, effective_date) DO NOTHING;

INSERT INTO company_default_rate_history (company_id, rate, effective_date, note)
SELECT s.company_id, s.value::numeric,
       DATE '1900-01-01', 'Backfilled from the rate on file when rate history was introduced'
  FROM settings s
 WHERE s.key = 'default_hourly_rate'
   AND s.value ~ '^\s*[0-9]+(\.[0-9]+)?\s*$'
ON CONFLICT (company_id, effective_date) DO NOTHING;
