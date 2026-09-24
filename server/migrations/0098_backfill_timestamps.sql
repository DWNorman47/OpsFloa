-- migrate:no-transaction (manages its own BEGIN/COMMIT)
-- TIMESTAMPTZ migration — Phase 1 backfill.
--
-- Populates the new start_ts / end_ts columns on time_entries and shifts,
-- and seeds users.timezone, from the existing wall-clock + timezone fields.
--
-- Backfill order matters:
--   1. users.timezone — derived from the most recent timezone the user
--      actually clocked in with, falling back to company_timezone, then UTC.
--      Done first so step 3 can read it.
--   2. time_entries.start_ts / end_ts — built from work_date + start/end_time
--      AT TIME ZONE (entry.timezone || company_timezone || most-frequent
--      entry tz for the company || UTC). Midnight-crossing entries
--      (end_time < start_time) get end_ts bumped by 1 day.
--   3. shifts.start_ts / end_ts — same idea but uses the assigned user's
--      timezone (now populated by step 1).
--
-- Wrapped in a single transaction so a partial run can't leave half the
-- rows in the new representation while half stay in the old.
--
-- Reports: a RAISE NOTICE block at the end prints per-company counts of
-- which fallback level was used for time_entries, so the deploy log
-- surfaces companies whose entries fell to the most-common-tz heuristic
-- or to pure UTC. Spot-check those before trusting the cutover.

BEGIN;

-- ── Step 1: users.timezone ──────────────────────────────────────────────────

UPDATE users u
SET timezone = COALESCE(
  -- Most-recent timezone the user clocked in with
  (SELECT ac.timezone FROM active_clock ac
    WHERE ac.user_id = u.id AND ac.timezone IS NOT NULL
    ORDER BY ac.clock_in_time DESC LIMIT 1),
  -- Most-recent timezone seen on any of the user's entries
  (SELECT te.timezone FROM time_entries te
    WHERE te.user_id = u.id AND te.timezone IS NOT NULL
    ORDER BY te.work_date DESC LIMIT 1),
  -- Company default
  (SELECT s.value FROM settings s
    WHERE s.company_id = u.company_id
      AND s.key = 'company_timezone'
      AND s.value IS NOT NULL AND s.value <> ''),
  'UTC'
)
WHERE u.timezone IS NULL;

-- ── Step 2: time_entries.start_ts / end_ts ──────────────────────────────────
-- The fallback chain is the entry's own timezone, then the company setting,
-- then the most-frequent entry timezone for that company, then UTC.

WITH per_company_default_tz AS (
  SELECT company_id, timezone,
         ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY COUNT(*) DESC) AS rn
  FROM time_entries
  WHERE timezone IS NOT NULL
  GROUP BY company_id, timezone
),
co_setting_tz AS (
  SELECT company_id, value AS company_timezone
  FROM settings
  WHERE key = 'company_timezone' AND value IS NOT NULL AND value <> ''
)
UPDATE time_entries te
SET
  start_ts = (te.work_date::text || ' ' || te.start_time::text)::timestamp
             AT TIME ZONE COALESCE(
               te.timezone,
               (SELECT company_timezone FROM co_setting_tz cs WHERE cs.company_id = te.company_id),
               (SELECT pcd.timezone FROM per_company_default_tz pcd WHERE pcd.company_id = te.company_id AND pcd.rn = 1),
               'UTC'
             ),
  end_ts   = ((te.work_date::text || ' ' || te.end_time::text)::timestamp
              + CASE WHEN te.end_time < te.start_time THEN INTERVAL '1 day' ELSE INTERVAL '0' END)
             AT TIME ZONE COALESCE(
               te.timezone,
               (SELECT company_timezone FROM co_setting_tz cs WHERE cs.company_id = te.company_id),
               (SELECT pcd.timezone FROM per_company_default_tz pcd WHERE pcd.company_id = te.company_id AND pcd.rn = 1),
               'UTC'
             )
WHERE te.start_ts IS NULL AND te.start_time IS NOT NULL AND te.end_time IS NOT NULL;

-- ── Step 3: shifts.start_ts / end_ts ────────────────────────────────────────
-- Shifts have no per-row timezone, so we use the user's timezone (just
-- backfilled in step 1), then the company setting, then UTC. Same midnight-
-- crossing handling as time_entries.

WITH co_setting_tz AS (
  SELECT company_id, value AS company_timezone
  FROM settings
  WHERE key = 'company_timezone' AND value IS NOT NULL AND value <> ''
)
UPDATE shifts s
SET
  start_ts = (s.shift_date::text || ' ' || s.start_time::text)::timestamp
             AT TIME ZONE COALESCE(
               (SELECT u.timezone FROM users u WHERE u.id = s.user_id),
               (SELECT cs.company_timezone FROM co_setting_tz cs WHERE cs.company_id = s.company_id),
               'UTC'
             ),
  end_ts   = ((s.shift_date::text || ' ' || s.end_time::text)::timestamp
              + CASE WHEN s.end_time < s.start_time THEN INTERVAL '1 day' ELSE INTERVAL '0' END)
             AT TIME ZONE COALESCE(
               (SELECT u.timezone FROM users u WHERE u.id = s.user_id),
               (SELECT cs.company_timezone FROM co_setting_tz cs WHERE cs.company_id = s.company_id),
               'UTC'
             )
WHERE s.start_ts IS NULL AND s.start_time IS NOT NULL AND s.end_time IS NOT NULL;

-- ── Step 4: deploy-log report ───────────────────────────────────────────────
-- Print per-company counts of which fallback level was used so anyone
-- reviewing the deploy log can spot companies that fell to the
-- most-common-tz heuristic or pure UTC and verify them by hand.

DO $$
DECLARE
  r RECORD;
BEGIN
  RAISE NOTICE 'TIMESTAMPTZ backfill — per-company tz source breakdown:';
  RAISE NOTICE 'company_id | name | with_entry_tz | via_company_tz | via_fallback_or_utc';
  FOR r IN
    SELECT c.id, c.name,
      COUNT(*) FILTER (WHERE te.timezone IS NOT NULL) AS with_entry_tz,
      COUNT(*) FILTER (WHERE te.timezone IS NULL AND s.value IS NOT NULL AND s.value <> '') AS via_company_tz,
      COUNT(*) FILTER (WHERE te.timezone IS NULL AND (s.value IS NULL OR s.value = '')) AS via_fallback_or_utc
    FROM companies c
    JOIN time_entries te ON te.company_id = c.id
    LEFT JOIN settings s ON s.company_id = c.id AND s.key = 'company_timezone'
    GROUP BY c.id, c.name
    HAVING COUNT(*) FILTER (WHERE te.timezone IS NULL AND (s.value IS NULL OR s.value = '')) > 0
    ORDER BY via_fallback_or_utc DESC
  LOOP
    RAISE NOTICE '%  | %  | %  | %  | %',
      r.id, r.name, r.with_entry_tz, r.via_company_tz, r.via_fallback_or_utc;
  END LOOP;
END $$;

COMMIT;
