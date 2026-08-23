-- Estimate line types so a bid can carry add/deduct alternates and allowances,
-- not just base scope. base + allowance count toward the bid total; alternate +
-- optional are priced but shown separately (excluded from the base total and
-- from the converted project budget). Default 'base' — existing lines unchanged.
-- Idempotent.

ALTER TABLE estimate_lines
  ADD COLUMN IF NOT EXISTS line_type VARCHAR(12) NOT NULL DEFAULT 'base';

ALTER TABLE estimate_lines DROP CONSTRAINT IF EXISTS chk_estimate_lines_type;
ALTER TABLE estimate_lines ADD  CONSTRAINT chk_estimate_lines_type
  CHECK (line_type IN ('base', 'allowance', 'alternate', 'optional'));
