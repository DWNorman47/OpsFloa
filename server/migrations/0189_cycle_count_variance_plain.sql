-- Make inventory_cycle_count_lines.variance a plain, app-written column.
--
-- 0039 defined it as `GENERATED ALWAYS AS (counted_qty - expected_qty) STORED`,
-- but 0051 added UOM tracking with the explicit intent that variance be stored in
-- stock-UOM units, and the app now writes a UOM-converted variance directly
-- (`UPDATE inventory_cycle_count_lines SET ... variance=$N`). Postgres rejects any
-- non-DEFAULT assignment to a GENERATED ALWAYS column, so on any DB built purely
-- from the numbered migrations every cycle-count line write 500s (the generated
-- expression is also UOM-blind, so it would disagree with the app even if writable).
--
-- DROP EXPRESSION converts the stored-generated column to a normal column, keeping
-- the values already computed. IF EXISTS makes this a safe no-op on a database whose
-- variance column was already made plain out-of-band.
ALTER TABLE inventory_cycle_count_lines
  ALTER COLUMN variance DROP EXPRESSION IF EXISTS;
