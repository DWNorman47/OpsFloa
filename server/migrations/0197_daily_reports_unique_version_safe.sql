-- Converge the daily_reports "one per (company, project-or-none, date)" unique index to a
-- version-safe form on servers that already applied the earlier 0194 (which created it as a
-- PostgreSQL-15-only `NULLS NOT DISTINCT` index). Replace it with the same COALESCE expression
-- index 0194 now creates on fresh installs, so every server ends on the identical index that
-- the POST upsert's `ON CONFLICT (company_id, COALESCE(project_id, 0), report_date)` names.
--
-- Idempotent: on a fresh install (0194 already made the expression index) this is a no-op
-- recreate. Safe on data: the existing unique already forbade duplicate NULL-project rows, so
-- rebuilding the index cannot fail on a duplicate.
DROP INDEX IF EXISTS uq_daily_reports_company_project_date;
CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_reports_company_project_date
  ON daily_reports (company_id, COALESCE(project_id, 0), report_date);
