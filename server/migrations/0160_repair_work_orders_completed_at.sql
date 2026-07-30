-- Repair databases where work_orders predates the completed_at column.
-- An already-recorded CREATE TABLE migration will not run again.
ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
