-- Effective-dated COMPANY prevailing-wage fallback (follow-up to 0209).
--
-- A prevailing entry on a project with no prevailing rate of its own is paid the
-- company `prevailing_wage_rate` setting. 0209 dated worker / project / default
-- rates but not this one, so changing the setting re-priced every past prevailing
-- hour on every pay surface (a $45 → $60 change turned a paid $360 day into $480).
--
-- Resolution (server/utils/rateHistory.js companyPrevailingRateOn): the row with
-- the greatest effective_date <= work_date; no rows → the setting (old behaviour).
-- settings.prevailing_wage_rate stays as the CURRENT-rate cache (row in effect
-- today, company time zone), refreshed on every write + by the daily cache job.
--
-- Backfill: the CURRENT setting as the rate since forever (1900-01-01), so pay for
-- existing history is unchanged by this migration. Idempotent.

CREATE TABLE IF NOT EXISTS company_prevailing_rate_history (
  id             SERIAL PRIMARY KEY,
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  rate           NUMERIC(10,2) NOT NULL,
  effective_date DATE NOT NULL,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note           TEXT,
  CONSTRAINT chk_company_prevailing_rate_history_nonneg CHECK (rate >= 0),
  CONSTRAINT uq_company_prevailing_rate_history_company_date UNIQUE (company_id, effective_date)
);
-- The UNIQUE (company_id, effective_date) constraint's index serves the lookup.

INSERT INTO company_prevailing_rate_history (company_id, rate, effective_date, note)
SELECT s.company_id, s.value::numeric,
       DATE '1900-01-01', 'Backfilled from the rate on file when rate history was introduced'
  FROM settings s
 WHERE s.key = 'prevailing_wage_rate'
   AND s.value ~ '^\s*[0-9]+(\.[0-9]+)?\s*$'
ON CONFLICT (company_id, effective_date) DO NOTHING;
