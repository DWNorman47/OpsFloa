-- Give each estimate line a COST basis distinct from its PRICE. Today
-- estimate_lines.unit_cost_cents is really the client-facing price (what the
-- bid shows); this adds the per-unit cost (what it costs you), so an estimate
-- can show cost / price / margin and the converted project budget can be seeded
-- from real COST instead of price. Nullable: existing lines (price only) keep
-- behaving exactly as before — the budget falls back to price where cost is
-- null. Idempotent.

ALTER TABLE estimate_lines
  ADD COLUMN IF NOT EXISTS cost_cents BIGINT
    CHECK (cost_cents IS NULL OR cost_cents >= 0);
