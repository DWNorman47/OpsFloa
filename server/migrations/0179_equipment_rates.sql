-- Equipment economics: give each machine a full rate model so a machine's
-- cost lives in ONE place (the asset) and can flow into estimates.
--
--   rental_rate         — what you PAY to rent one in (vendor cost). Existed
--                         from 0125 (day/week/month); now also allows 'hour'.
--   rent_out_rate       — what you CHARGE to rent the bare machine out to others.
--   mobilization_cost   — flat charge to bring it to site and back (round trip).
--   operating_rate      — what you bill to USE it on a job (per hour or day).
--
-- All money is DECIMAL(12,2) dollars, matching the existing purchase_cost /
-- rental_rate on this table. The estimate integration converts to cents.
-- Idempotent (IF NOT EXISTS / DROP+ADD).

-- Allow hourly rent-in rates (previously day/week/month only).
ALTER TABLE equipment_items DROP CONSTRAINT IF EXISTS chk_equipment_items_rate_unit;
ALTER TABLE equipment_items ADD  CONSTRAINT chk_equipment_items_rate_unit
  CHECK (rental_rate_unit IS NULL OR rental_rate_unit IN ('hour','day','week','month'));

ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS rent_out_rate     DECIMAL(12,2);
ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS rent_out_unit     VARCHAR(10);
ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS mobilization_cost DECIMAL(12,2);
ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS operating_rate    DECIMAL(12,2);
ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS operating_unit    VARCHAR(10);

ALTER TABLE equipment_items DROP CONSTRAINT IF EXISTS chk_equipment_items_rent_out_unit;
ALTER TABLE equipment_items ADD  CONSTRAINT chk_equipment_items_rent_out_unit
  CHECK (rent_out_unit IS NULL OR rent_out_unit IN ('hour','day','week','month'));
ALTER TABLE equipment_items DROP CONSTRAINT IF EXISTS chk_equipment_items_operating_unit;
ALTER TABLE equipment_items ADD  CONSTRAINT chk_equipment_items_operating_unit
  CHECK (operating_unit IS NULL OR operating_unit IN ('hour','day','week','month'));
