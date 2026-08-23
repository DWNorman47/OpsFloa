-- Project scheduler: the planned work-calendar for a project — which calendar dates are
-- worked. The Nth worked date (chronologically) is Day N, so the Project Daily calendar
-- can label each date with its Day number and show which checklists (every-day / Day-N /
-- date-pinned) land on it. This is the foundation for the broader scheduler — future
-- planner elements (equipment rentals, phase starts) hang off the same dates.
CREATE TABLE IF NOT EXISTS project_work_days (
  id          SERIAL PRIMARY KEY,
  company_id  UUID    NOT NULL REFERENCES companies(id),
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  work_date   DATE    NOT NULL,
  note        TEXT,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, work_date)
);
CREATE INDEX IF NOT EXISTS idx_project_work_days ON project_work_days (company_id, project_id, work_date);
