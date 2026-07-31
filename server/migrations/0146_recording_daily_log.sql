-- Jobsite daily log for a recording (the "voice memo → daily log" tool).
--
-- Same shape and rationale as minutes (0140): a recording is turned into a
-- structured field log, stored 1:1 on the recording so it survives a reload and
-- regenerating replaces rather than appends. A recording can hold BOTH minutes
-- and a daily log — a meeting yields minutes, a jobsite walkthrough yields a
-- daily log — so these are separate columns, not a reuse of minutes_md.

ALTER TABLE recordings ADD COLUMN IF NOT EXISTS daily_log_md TEXT;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS daily_log_at TIMESTAMPTZ;
