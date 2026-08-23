-- Project Daily: a checklist assignment can carry through every day, or land on a
-- specific ordinal day (Nth worked day) or a specific calendar date. When an ordinal
-- assignment and a date assignment resolve to the same worked day, assembly gathers both
-- and dedups — the two checklists combine into that one day. Plus a per-checklist
-- carryover flag: whether its incomplete items roll forward to the next day.
ALTER TABLE daily_checklist_assignments
  ADD COLUMN IF NOT EXISTS schedule_type VARCHAR(10) NOT NULL DEFAULT 'every'
    CHECK (schedule_type IN ('every', 'ordinal', 'date'));
ALTER TABLE daily_checklist_assignments ADD COLUMN IF NOT EXISTS ordinal_target INTEGER;
ALTER TABLE daily_checklist_assignments ADD COLUMN IF NOT EXISTS scheduled_date DATE;
ALTER TABLE daily_checklist_assignments
  ADD COLUMN IF NOT EXISTS carryover BOOLEAN NOT NULL DEFAULT false;

-- Day items remember whether they should roll forward. Existing/manual/recurring items
-- keep today's behavior (they carry); assignment items set this from their assignment.
ALTER TABLE daily_checklist_items
  ADD COLUMN IF NOT EXISTS carryover BOOLEAN NOT NULL DEFAULT true;
