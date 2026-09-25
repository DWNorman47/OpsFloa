-- Certified payroll (WH-347) signature integrity.
--
-- 1. report_hash — SHA-256 (hex) of the canonical report JSON the signer certified,
--    computed server-side at signing (routes/certifiedPayroll.js → admin.js
--    buildCertifiedPayrollReport). GET /admin/certified-payroll recomputes it and
--    reports `signature.data_changed` when the hours/pay under a signature moved.
--    NULL for signatures made before this migration (shown as "unknown").
--
-- 2. project_name — snapshot of the project's name at signing (a legal record should
--    read the same even if the project is renamed).
--
-- 3. One all-projects signature per (company, week). The table's
--    UNIQUE (company_id, project_id, week_ending) never matches when project_id IS
--    NULL (NULLs are distinct), so every re-sign of an all-projects report INSERTED a
--    new row instead of replacing it. A partial unique index fixes that (version-safe;
--    NULLS NOT DISTINCT would need PG 15 — see 0197). Existing duplicates are NOT
--    deleted (they are signed legal records): all but the newest per (company, week)
--    are stamped superseded_at, and the index only covers current rows.
--
-- 4. project_id FK: ON DELETE SET NULL turned a project's signature into what looks
--    like an ALL-projects signature (and would now collide with the partial index).
--    A signed WH-347 must keep its project → ON DELETE RESTRICT. Projects are archived
--    (active = false), not deleted, in normal use; the project merge refuses a source
--    with signatures, and company deletion removes signatures before projects.

ALTER TABLE certified_payroll_signatures ADD COLUMN IF NOT EXISTS report_hash   CHAR(64);
ALTER TABLE certified_payroll_signatures ADD COLUMN IF NOT EXISTS project_name  VARCHAR(255);
ALTER TABLE certified_payroll_signatures ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

UPDATE certified_payroll_signatures s
   SET project_name = p.name
  FROM projects p
 WHERE p.id = s.project_id AND s.project_name IS NULL;

UPDATE certified_payroll_signatures a
   SET superseded_at = NOW()
 WHERE a.project_id IS NULL
   AND a.superseded_at IS NULL
   AND EXISTS (
     SELECT 1 FROM certified_payroll_signatures b
      WHERE b.company_id = a.company_id
        AND b.week_ending = a.week_ending
        AND b.project_id IS NULL
        AND b.superseded_at IS NULL
        AND (b.signed_at, b.id) > (a.signed_at, a.id)
   );

CREATE UNIQUE INDEX IF NOT EXISTS uq_cp_signatures_all_projects
  ON certified_payroll_signatures (company_id, week_ending)
  WHERE project_id IS NULL AND superseded_at IS NULL;

ALTER TABLE certified_payroll_signatures
  DROP CONSTRAINT IF EXISTS certified_payroll_signatures_project_id_fkey;
ALTER TABLE certified_payroll_signatures
  ADD CONSTRAINT certified_payroll_signatures_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT;
