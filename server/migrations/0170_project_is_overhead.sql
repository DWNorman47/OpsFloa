-- Mark a project as an overhead / non-job code (Shop, Travel, PTO, Yard, Bench…)
-- rather than a real job site. Admin-set. Screens that auto-default to the
-- worker's clocked-in project (Daily Checklist, Work Notes, new Daily Report,
-- Haul log) skip the default when the clocked-in project is overhead — you don't
-- want a daily report defaulting to "Travel". See client/src/pages/FieldPage.jsx.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS is_overhead BOOLEAN NOT NULL DEFAULT false;
