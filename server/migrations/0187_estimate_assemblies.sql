-- Assemblies (kits): a saved, named bundle of catalog items with quantities,
-- inserted into an estimate in one click. Members reference inventory_items
-- (catalog), so prices stay current — the assembly stores the recipe, not a
-- price snapshot. Deleting a catalog item cascades its membership away.

CREATE TABLE IF NOT EXISTS estimate_assemblies (
  id          SERIAL PRIMARY KEY,
  company_id  UUID         NOT NULL,
  name        VARCHAR(255) NOT NULL,
  notes       TEXT,
  created_by  INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMP    NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_assemblies_company ON estimate_assemblies (company_id);

CREATE TABLE IF NOT EXISTS estimate_assembly_items (
  id           SERIAL PRIMARY KEY,
  assembly_id  INTEGER       NOT NULL REFERENCES estimate_assemblies(id) ON DELETE CASCADE,
  item_id      INTEGER       NOT NULL REFERENCES inventory_items(id)     ON DELETE CASCADE,
  qty          DECIMAL(12,4) NOT NULL DEFAULT 1 CHECK (qty >= 0),
  sort_order   INTEGER       NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_assembly_items_assembly ON estimate_assembly_items (assembly_id, sort_order);
