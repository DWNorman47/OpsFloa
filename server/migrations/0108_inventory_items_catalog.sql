-- Extend inventory_items so the same table powers the estimate-line
-- catalog picker. is_stocked=false rows are pure catalog entries
-- (no qty tracking, no inventory adjustments on PO receive). The
-- estimate creator pulls from both stocked AND catalog items.
--
-- Existing rows default to is_stocked=true (unchanged behaviour).

ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS is_stocked              BOOLEAN     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS sell_price_cents        BIGINT      CHECK (sell_price_cents IS NULL OR sell_price_cents >= 0),
  ADD COLUMN IF NOT EXISTS default_markup_pct      DECIMAL(5,2) CHECK (default_markup_pct IS NULL OR (default_markup_pct >= 0 AND default_markup_pct <= 1000)),
  ADD COLUMN IF NOT EXISTS catalog_tags            TEXT[],
  ADD COLUMN IF NOT EXISTS default_estimate_category VARCHAR(20)
    CONSTRAINT chk_items_default_category CHECK (default_estimate_category IS NULL OR default_estimate_category IN
      ('labor','materials','equipment','subs','overhead','contingency','other'));

-- Partial indexes — most queries hit one or the other; full index would
-- be larger and serves nothing.
CREATE INDEX IF NOT EXISTS idx_items_catalog ON inventory_items (company_id) WHERE NOT is_stocked;
CREATE INDEX IF NOT EXISTS idx_items_tags    ON inventory_items USING gin (catalog_tags);
