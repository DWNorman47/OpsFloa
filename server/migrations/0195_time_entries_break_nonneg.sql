-- break_minutes is subtracted from paid hours on every pay surface. A NEGATIVE
-- break would ADD paid hours (subtracting a negative) — a clean overpay vector
-- reachable via any write path that doesn't clamp (raw SQL, webhooks, future
-- endpoints). The pay reader now clamps break at 0 as a backstop, but this makes
-- the invariant hold at the DB level so bad data can never be stored.
--
-- NOT VALID: enforce every new/updated row without scanning legacy rows on boot
-- (there should be none negative, but this keeps the migration non-blocking).
-- Guarded so it's re-runnable and coexists with schema.sql declaring the same constraint
-- (Postgres has no ADD CONSTRAINT IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_entries_break_minutes_nonneg') THEN
    ALTER TABLE time_entries
      ADD CONSTRAINT time_entries_break_minutes_nonneg
      CHECK (break_minutes IS NULL OR break_minutes >= 0) NOT VALID;
  END IF;
END $$;
