-- Per-project worker hour limits. A project can cap how many hours a single
-- worker logs on it per day and/or per week, in one of two modes:
--   warn — soft: the worker/admin are warned when the limit is crossed
--   hard — the shift is stopped, or switched to the overflow project, at the
--          exact instant the limit is reached (deterministic limit-time; applied
--          lazily whenever the active clock is observed)
-- See server/constants/projectEnums.js (HOUR_LIMIT_MODES), server/utils/
-- projectHourLimits.js, and docs/db-enums.md.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS hour_limit_mode VARCHAR(10) NOT NULL DEFAULT 'off'
    CHECK (hour_limit_mode IN ('off', 'warn', 'hard'));

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS daily_hour_limit NUMERIC(10,2)
    CHECK (daily_hour_limit IS NULL OR daily_hour_limit >= 0);

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS weekly_hour_limit NUMERIC(10,2)
    CHECK (weekly_hour_limit IS NULL OR weekly_hour_limit >= 0);

-- The project a worker is auto-switched to when a hard limit is hit. Nullable
-- (no overflow → auto clock-out at the limit). SET NULL if that project is
-- deleted so the cap silently degrades to clock-out rather than dangling.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS hour_limit_overflow_project_id INTEGER
    REFERENCES projects(id) ON DELETE SET NULL;
