-- Give change-order lines the same COST basis as estimate lines (0183), so an
-- accepted CO bumps the project budget by real cost — not the client-facing
-- sell price. Before this, base budget was cost but CO additions were sell,
-- producing a mixed-basis budget and skewed variance the moment a CO applied.
-- Nullable: existing CO lines fall back to price, unchanged. Idempotent.

ALTER TABLE change_order_lines
  ADD COLUMN IF NOT EXISTS cost_cents BIGINT
    CHECK (cost_cents IS NULL OR cost_cents >= 0);
