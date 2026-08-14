-- Project Daily: the project dimension is a single scope, not a set — an assignment
-- applies to ALL projects (project_id NULL) or ONE project. (Roles stay a set: all,
-- one, or several.) Collapse the 0173 project_ids[] array into a single project_id.
ALTER TABLE daily_checklist_assignments
  ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE;

-- Carry existing rows over: a set becomes its first project; NULL/empty stays all-projects.
UPDATE daily_checklist_assignments
   SET project_id = project_ids[1]
 WHERE project_ids IS NOT NULL AND array_length(project_ids, 1) >= 1;

ALTER TABLE daily_checklist_assignments DROP COLUMN IF EXISTS project_ids;

CREATE INDEX IF NOT EXISTS idx_dc_assignments_scope
  ON daily_checklist_assignments (company_id, project_id, order_index);
