-- Project Daily, redesigned: seed each day's checklist from whole Checklist Builder
-- templates (checklist-by-checklist), scoped to all-or-many projects x all-or-many team
-- types, shared or individual per assignment. Supersedes the 0172 per-scope hand-typed
-- recurring rows; the legacy per-project recurring template (the day-form carryover)
-- returns to its original project-scoped, all-types shape.

-- 1) Undo the 0172 scope/mode columns on the hand-typed recurring template — that
--    dimension now lives on assignments. Drop any rows the interim tab created
--    (default-project or type-scoped) so only day-form project rows remain.
DELETE FROM daily_checklist_recurring_items WHERE role_id IS NOT NULL OR project_id IS NULL;
ALTER TABLE daily_checklist_recurring_items DROP COLUMN IF EXISTS role_id;
ALTER TABLE daily_checklist_recurring_items DROP COLUMN IF EXISTS mode;
ALTER TABLE daily_checklist_recurring_items ALTER COLUMN project_id SET NOT NULL;

-- 2) Day items carry a role SET (NULL/empty = all types), not a single role — an
--    assignment can target several team types and still be one shared row.
ALTER TABLE daily_checklist_items DROP COLUMN IF EXISTS role_id;
ALTER TABLE daily_checklist_items ADD COLUMN IF NOT EXISTS role_ids INTEGER[];

-- 3) Assignments — the Project Daily model. Which Checklist Builder template seeds
--    which projects/types, and whether it's shared or individual.
CREATE TABLE IF NOT EXISTS daily_checklist_assignments (
  id          SERIAL PRIMARY KEY,
  company_id  UUID    NOT NULL REFERENCES companies(id),
  template_id INTEGER NOT NULL REFERENCES safety_checklist_templates(id) ON DELETE CASCADE,
  project_ids INTEGER[],  -- NULL/empty = all projects
  role_ids    INTEGER[],  -- NULL/empty = all team-member-types
  mode        VARCHAR(10) NOT NULL DEFAULT 'shared' CHECK (mode IN ('shared', 'individual')),
  order_index INTEGER NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dc_assignments_company ON daily_checklist_assignments (company_id, order_index);
