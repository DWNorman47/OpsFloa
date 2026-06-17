-- Change orders — incremental scope changes on an existing project.
-- Shape mirrors estimates (line items per MONEY_CATEGORIES + header
-- markup math) but each accepted CO ADDS to the project's existing
-- budget_categories rather than creating a new project.

CREATE TABLE IF NOT EXISTS change_orders (
  id                   SERIAL PRIMARY KEY,
  company_id           UUID         NOT NULL,
  project_id           INTEGER      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- CO numbers reset per project (CO-001, CO-002, ...).
  co_number            VARCHAR(50)  NOT NULL,
  description          TEXT         NOT NULL,
  status               VARCHAR(20)  NOT NULL DEFAULT 'draft'
    CONSTRAINT chk_co_status CHECK (status IN ('draft','sent','accepted','declined','withdrawn')),
  -- Money math — same layered system as estimates.
  subtotal_cents       BIGINT       NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  overhead_pct         DECIMAL(5,2) NOT NULL DEFAULT 0 CHECK (overhead_pct >= 0),
  margin_pct           DECIMAL(5,2) NOT NULL DEFAULT 0 CHECK (margin_pct >= 0),
  tax_pct              DECIMAL(5,2) NOT NULL DEFAULT 0 CHECK (tax_pct >= 0),
  total_cents          BIGINT       NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  -- Tokenized accept/decline + e-sign capture (mirrors estimates).
  sent_at              TIMESTAMPTZ,
  responded_at         TIMESTAMPTZ,
  response_token_hash  VARCHAR(64),
  accepted_signer_name VARCHAR(255),
  accepted_signer_ip   INET,
  -- Once accepted, this fires once and writes to project_budget_categories.
  -- Idempotency flag prevents a re-fire from double-bumping the budget.
  budget_applied_at    TIMESTAMPTZ,
  notes                TEXT,
  created_by           INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_co_project_number UNIQUE (project_id, co_number)
);
CREATE INDEX IF NOT EXISTS idx_co_company_status  ON change_orders (company_id, status);
CREATE INDEX IF NOT EXISTS idx_co_project         ON change_orders (project_id);
CREATE INDEX IF NOT EXISTS idx_co_response_token  ON change_orders (response_token_hash)
  WHERE response_token_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS change_order_lines (
  id              SERIAL PRIMARY KEY,
  change_order_id INTEGER       NOT NULL REFERENCES change_orders(id) ON DELETE CASCADE,
  category        VARCHAR(20)   NOT NULL
    CONSTRAINT chk_co_lines_category CHECK (category IN
      ('labor','materials','equipment','subs','overhead','contingency','other')),
  sort_order      INTEGER       NOT NULL DEFAULT 0,
  description     TEXT          NOT NULL,
  qty             DECIMAL(12,4) NOT NULL DEFAULT 1 CHECK (qty >= 0),
  unit            VARCHAR(20),
  unit_cost_cents BIGINT        NOT NULL DEFAULT 0 CHECK (unit_cost_cents >= 0),
  total_cents     BIGINT        NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  notes           TEXT
);
CREATE INDEX IF NOT EXISTS idx_co_lines_co ON change_order_lines (change_order_id, sort_order);
