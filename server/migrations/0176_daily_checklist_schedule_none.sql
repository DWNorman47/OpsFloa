-- Project Daily: a checklist can also be left on NO particular day — assigned to the
-- project but not seeded onto any day by schedule (a neutral/parked state). Adds 'none'
-- to the schedule enum and makes it the default resting state. 'none' matches no day at
-- assembly, so such checklists don't appear until given an every/ordinal/date schedule.
ALTER TABLE daily_checklist_assignments
  DROP CONSTRAINT IF EXISTS daily_checklist_assignments_schedule_type_check;
ALTER TABLE daily_checklist_assignments
  ADD CONSTRAINT daily_checklist_assignments_schedule_type_check
  CHECK (schedule_type IN ('none', 'every', 'ordinal', 'date'));
ALTER TABLE daily_checklist_assignments ALTER COLUMN schedule_type SET DEFAULT 'none';
