-- Optimistic-concurrency columns → TIMESTAMPTZ (daily_reports, punchlist_items, rfis).
--
-- routes/dailyReports.js, punchlist.js and rfis.js PATCH compare the client's `updated_at`
-- (an ISO instant) against the row's `updated_at` as `$n::timestamptz`. The column was a
-- TIMESTAMP WITHOUT TIME ZONE, so that comparison depended on two unrelated clocks:
--   * node-postgres parses a TIMESTAMP as *Node-local* wall time (process TZ), and
--   * Postgres casts the TIMESTAMP to timestamptz using the *session* TimeZone.
-- Any mismatch (Node on a non-UTC TZ, or a DB/role TimeZone change) turned every edit into a
-- spurious 409 "conflict". TIMESTAMPTZ values are absolute instants: the driver returns an
-- ISO instant and the comparison is time-zone independent.
--
-- Conversion: every writer sets updated_at = NOW() (or the DEFAULT NOW()) under the app's
-- sessions, which run at the Neon/Postgres default TimeZone of UTC — so the stored wall-clock
-- values are UTC. `AT TIME ZONE 'UTC'` reinterprets them as UTC instants, keeping each row's
-- exact instant (and ms precision) unchanged.
--
-- Guarded per column so a re-run (or a DB where the column is already timestamptz) is a no-op
-- rather than a second, shifting conversion.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['daily_reports', 'punchlist_items', 'rfis'] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = t
         AND column_name = 'updated_at' AND data_type = 'timestamp without time zone'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE %L',
        t, 'UTC');
      EXECUTE format('ALTER TABLE %I ALTER COLUMN updated_at SET DEFAULT NOW()', t);
    END IF;
  END LOOP;
END $$;
