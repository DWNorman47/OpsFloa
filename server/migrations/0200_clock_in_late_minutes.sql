-- Minutes between the clock-in instant a worker's device claimed and when the
-- server first received it. The client sends clock_in_time (captured at the
-- button press, before the GPS wait) so offline-queued punches keep their real
-- time — but that also let a worker backdate a clock-in by any amount and have
-- it look like an ordinary punch. We still accept the claimed time; when it's
-- more than a few minutes old we record the lag here so approvers see a
-- "late clock-in" badge instead of a clean punch. NULL = on time (or created
-- by an admin / before this column existed). Copied active_clock → time_entries
-- when the shift closes.
ALTER TABLE active_clock ADD COLUMN IF NOT EXISTS clock_in_late_minutes INTEGER;
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS clock_in_late_minutes INTEGER;
