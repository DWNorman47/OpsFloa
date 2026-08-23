-- Link a purchase order to a project so upcoming material buys show as a
-- COMMITTED cost on that job (the unreceived value of open POs). Actual
-- material cost already flows from inventory_transactions issued to a project
-- (type='issue', project_id, unit_cost) — this adds the forward-commitment
-- side. Nullable; existing POs are unaffected. Idempotent.

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_po_project ON purchase_orders (project_id) WHERE project_id IS NOT NULL;
