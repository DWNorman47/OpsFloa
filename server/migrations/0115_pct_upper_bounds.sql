-- Round-2 audit follow-up. The H7 fix in 0114 bounded
-- project_expenses.tax_pct above by 100, but the same hazard remained
-- on 7 other percentage columns on the estimates and change_orders
-- tables. Raw SQL or a seeder could write 1000% and silently overflow
-- the computed *_cents totals. This migration finishes the job by
-- replacing every `CHECK (x >= 0)` with `CHECK (x >= 0 AND x <= 100)`
-- on the affected columns.
--
-- Each block first normalises any out-of-range rows (clamp to 100) so
-- the new constraint can be added. Production should never have these
-- but the safe-by-default pattern from 0103/0101 applies here too.

-- ── estimates ───────────────────────────────────────────────────────────────
ALTER TABLE estimates
  DROP CONSTRAINT IF EXISTS estimates_overhead_pct_check,
  DROP CONSTRAINT IF EXISTS estimates_margin_pct_check,
  DROP CONSTRAINT IF EXISTS estimates_contingency_pct_check,
  DROP CONSTRAINT IF EXISTS estimates_tax_pct_check,
  DROP CONSTRAINT IF EXISTS chk_estimates_overhead_pct,
  DROP CONSTRAINT IF EXISTS chk_estimates_margin_pct,
  DROP CONSTRAINT IF EXISTS chk_estimates_contingency_pct,
  DROP CONSTRAINT IF EXISTS chk_estimates_tax_pct;

UPDATE estimates SET
  overhead_pct    = LEAST(overhead_pct,    100),
  margin_pct      = LEAST(margin_pct,      100),
  contingency_pct = LEAST(contingency_pct, 100),
  tax_pct         = LEAST(tax_pct,         100)
WHERE overhead_pct    > 100
   OR margin_pct      > 100
   OR contingency_pct > 100
   OR tax_pct         > 100;

ALTER TABLE estimates
  ADD CONSTRAINT chk_estimates_overhead_pct
    CHECK (overhead_pct    >= 0 AND overhead_pct    <= 100),
  ADD CONSTRAINT chk_estimates_margin_pct
    CHECK (margin_pct      >= 0 AND margin_pct      <= 100),
  ADD CONSTRAINT chk_estimates_contingency_pct
    CHECK (contingency_pct >= 0 AND contingency_pct <= 100),
  ADD CONSTRAINT chk_estimates_tax_pct
    CHECK (tax_pct         >= 0 AND tax_pct         <= 100);

-- ── change_orders ──────────────────────────────────────────────────────────
ALTER TABLE change_orders
  DROP CONSTRAINT IF EXISTS change_orders_overhead_pct_check,
  DROP CONSTRAINT IF EXISTS change_orders_margin_pct_check,
  DROP CONSTRAINT IF EXISTS change_orders_tax_pct_check,
  DROP CONSTRAINT IF EXISTS chk_change_orders_overhead_pct,
  DROP CONSTRAINT IF EXISTS chk_change_orders_margin_pct,
  DROP CONSTRAINT IF EXISTS chk_change_orders_tax_pct;

UPDATE change_orders SET
  overhead_pct = LEAST(overhead_pct, 100),
  margin_pct   = LEAST(margin_pct,   100),
  tax_pct      = LEAST(tax_pct,      100)
WHERE overhead_pct > 100
   OR margin_pct   > 100
   OR tax_pct      > 100;

ALTER TABLE change_orders
  ADD CONSTRAINT chk_change_orders_overhead_pct
    CHECK (overhead_pct >= 0 AND overhead_pct <= 100),
  ADD CONSTRAINT chk_change_orders_margin_pct
    CHECK (margin_pct   >= 0 AND margin_pct   <= 100),
  ADD CONSTRAINT chk_change_orders_tax_pct
    CHECK (tax_pct      >= 0 AND tax_pct      <= 100);

-- The route-layer parsePct() validator in
-- server/routes/{estimates,changeOrders}.js already enforces the same
-- bound at the JS edge; this migration is defense-in-depth for raw SQL
-- and any future endpoint that might bypass parsePct().
