-- Manual project expenses: fuel, dump fees, equipment rentals, permits,
-- one-off costs that don't have a better tracker (time_entries, inventory
-- POs, sub POs). Phase 3 of project money flow.

CREATE TABLE IF NOT EXISTS project_expenses (
  id              SERIAL PRIMARY KEY,
  company_id      UUID         NOT NULL,
  project_id      INTEGER      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category        VARCHAR(20)  NOT NULL
    CONSTRAINT chk_pe_category CHECK (category IN
      ('labor','materials','equipment','subs','overhead','contingency','other')),
  description     TEXT         NOT NULL,
  amount_cents    BIGINT       NOT NULL CHECK (amount_cents >= 0),
  tax_pct         DECIMAL(5,2) NOT NULL DEFAULT 0 CHECK (tax_pct >= 0),
  tax_cents       BIGINT       NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  vendor          VARCHAR(255),
  paid_date       DATE,                     -- NULL = incurred but not yet paid
  receipt_url     TEXT,
  notes           TEXT,
  created_by      INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pe_company_project ON project_expenses (company_id, project_id);
CREATE INDEX IF NOT EXISTS idx_pe_paid_date ON project_expenses (project_id, paid_date)
  WHERE paid_date IS NOT NULL;
