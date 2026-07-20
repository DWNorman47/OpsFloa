-- Manual, admin-releasable lock on a shared takeoff. A user locks it to reserve
-- it ("I'm working on this"); the holder OR any admin can unlock. Enforced but
-- never a dead-end: while locked by someone else, in-place saves (PUT) are
-- refused, but reads and "copy to my projects" always work. No FK on locked_by
-- (staging users.id types vary — matches created_by in 0131). Idempotent.
ALTER TABLE takeoff_projects ADD COLUMN IF NOT EXISTS locked_by      INTEGER;
ALTER TABLE takeoff_projects ADD COLUMN IF NOT EXISTS locked_by_name TEXT;
ALTER TABLE takeoff_projects ADD COLUMN IF NOT EXISTS locked_at      TIMESTAMPTZ;
