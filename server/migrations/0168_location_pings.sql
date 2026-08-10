-- Breadcrumb location history: one row per recorded GPS ping while a worker is
-- clocked in. Written by POST /api/clock/location (in addition to the single
-- "last known" point on active_clock, which is still overwritten each ping and
-- wiped on clock-out). This table is the durable path — a shift's trail is the
-- pings for that user between the entry's start_ts and end_ts.
--
-- Deliberately minimal and used ONLY for location tracking. No FK to
-- time_entries (the entry doesn't exist yet mid-shift); pings are tied to a
-- shift by user_id + recorded_at range at read time. Writes are throttled
-- server-side (~30s/user) so a movement-driven watchPosition can't flood it.

CREATE TABLE IF NOT EXISTS location_pings (
  id          BIGSERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lat         DECIMAL(10,7) NOT NULL,
  lng         DECIMAL(10,7) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Read path: a worker's pings over a time window (path for a shift / date range).
CREATE INDEX IF NOT EXISTS idx_location_pings_user_time
  ON location_pings (user_id, recorded_at);

-- Company-scoped retention sweeps.
CREATE INDEX IF NOT EXISTS idx_location_pings_company_time
  ON location_pings (company_id, recorded_at);
