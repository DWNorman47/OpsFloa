-- Flag entries whose real span (start_ts→end_ts) exceeds the wall-clock duration the
-- pay engine derives from start_time/end_time — i.e. a forgotten / multi-day clock-out
-- that the legacy TIME columns silently truncate (a 49h shift reads as ~1h). The pay
-- reader still uses the wall-clock columns (Phase-3 cutover pending), so until then this
-- surfaces the anomaly in the approval queue so an admin doesn't approve a mis-valued
-- entry. Set at clock-out / offline-recover; NULL/false everywhere else.
ALTER TABLE time_entries
  ADD COLUMN IF NOT EXISTS long_shift_flagged BOOLEAN NOT NULL DEFAULT false;
