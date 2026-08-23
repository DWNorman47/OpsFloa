-- Give project expenses a planned/actual lifecycle so a cost can be forecast
-- before it's incurred. `planned` rows roll into the COMMITTED bucket of the
-- spend/P&L rollup (like an issued-but-unpaid sub PO); `actual` rows are SPENT.
-- Default 'actual' so every existing row keeps counting as spent (no behavior
-- change on backfill). Also link an expense to an equipment asset so a planned
-- rental can be traced to the machine it's for. Idempotent.

ALTER TABLE project_expenses
  ADD COLUMN IF NOT EXISTS status       VARCHAR(10) NOT NULL DEFAULT 'actual',
  ADD COLUMN IF NOT EXISTS equipment_id INTEGER REFERENCES equipment_items(id) ON DELETE SET NULL;

ALTER TABLE project_expenses DROP CONSTRAINT IF EXISTS chk_project_expenses_status;
ALTER TABLE project_expenses ADD  CONSTRAINT chk_project_expenses_status
  CHECK (status IN ('planned', 'actual'));

CREATE INDEX IF NOT EXISTS idx_pe_project_status ON project_expenses (project_id, status);
