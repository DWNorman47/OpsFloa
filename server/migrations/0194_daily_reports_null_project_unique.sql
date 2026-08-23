-- Make the daily_reports one-per-(company, project, date) uniqueness hold for the
-- "No project" (project_id NULL) case too. The old UNIQUE (company_id, project_id,
-- report_date) treats NULLs as DISTINCT, so multiple NULL-project reports for the same
-- company+date could accumulate (and the POST upsert's ON CONFLICT never matched them).
--
-- 1) Dedupe existing NULL-project duplicates: keep the most-recently-updated row per
--    (company, date); delete the rest (their manpower/equipment/photo sub-rows cascade).
DELETE FROM daily_reports d
 USING daily_reports keep
 WHERE d.id <> keep.id
   AND d.company_id = keep.company_id
   AND d.project_id IS NULL AND keep.project_id IS NULL
   AND d.report_date = keep.report_date
   AND (d.updated_at < keep.updated_at
        OR (d.updated_at = keep.updated_at AND d.id < keep.id));

-- 2) Replace the NULLS-DISTINCT unique with one that treats a NULL project_id as a single
--    value, so the upsert's ON CONFLICT fires for "No project" reports too.
ALTER TABLE daily_reports DROP CONSTRAINT IF EXISTS daily_reports_company_id_project_id_report_date_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_reports_company_project_date
  ON daily_reports (company_id, project_id, report_date) NULLS NOT DISTINCT;
