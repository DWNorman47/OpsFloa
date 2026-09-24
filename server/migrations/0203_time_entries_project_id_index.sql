-- time_entries had no index on project_id, so every per-project labor query
-- (project spend, P&L, WIP, close-out snapshot, hour limits) filtering only on
-- te.project_id was a full table scan. Plain (not CONCURRENTLY): the table is
-- modest, and migrate.js's 10s lock_timeout fails the deploy rather than
-- stalling traffic if a long transaction holds the table.
CREATE INDEX IF NOT EXISTS idx_time_entries_project_id ON time_entries (project_id);
