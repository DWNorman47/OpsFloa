-- Project visibility priority: controls whether a project shows in workers' pickers and in
-- what order. high → listed first, low → last, hidden → not shown in workers' Time Clock
-- dropdown (admins still see it in the project list to manage it). Existing rows default to
-- normal (unchanged behavior).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS priority VARCHAR(10) NOT NULL DEFAULT 'normal'
  CHECK (priority IN ('high', 'normal', 'low', 'hidden'));
