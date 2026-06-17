-- Estimates module — Phase 1 of estimates-and-project-money-flow.
-- Pre-work line-item quote, sent to a prospect. On accept, converts
-- to a project and seeds project_budget_categories (Phase 2, not in
-- this migration).

CREATE TABLE IF NOT EXISTS estimates (
  id                   SERIAL PRIMARY KEY,
  company_id           UUID         NOT NULL,
  estimate_number      VARCHAR(50)  NOT NULL,
  client_id            INTEGER      REFERENCES clients(id) ON DELETE SET NULL,
  -- Snapshot of client name at send-time so renamed/deleted clients don't
  -- silently rewrite history.
  client_name_snapshot VARCHAR(255) NOT NULL,
  client_email         VARCHAR(255),
  project_address      TEXT,
  project_name         VARCHAR(255) NOT NULL,
  scope_summary        TEXT,
  status               VARCHAR(20)  NOT NULL DEFAULT 'draft'
    CONSTRAINT chk_estimates_status CHECK (status IN
      ('draft','sent','accepted','declined','expired','withdrawn')),
  -- Money math. All percentages 0-100. All cents are non-negative.
  subtotal_cents       BIGINT       NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  overhead_pct         DECIMAL(5,2) NOT NULL DEFAULT 0 CHECK (overhead_pct >= 0),
  margin_pct           DECIMAL(5,2) NOT NULL DEFAULT 0 CHECK (margin_pct >= 0),
  contingency_pct      DECIMAL(5,2) NOT NULL DEFAULT 0 CHECK (contingency_pct >= 0),
  tax_pct              DECIMAL(5,2) NOT NULL DEFAULT 0 CHECK (tax_pct >= 0),
  total_cents          BIGINT       NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  -- Lifecycle
  valid_until          DATE,
  sent_at              TIMESTAMPTZ,
  responded_at         TIMESTAMPTZ,
  -- Convert-to-project link (Phase 2 reads this)
  converted_project_id INTEGER      REFERENCES projects(id) ON DELETE SET NULL,
  -- Tokenized accept/decline (raw token in email link; sha256 here)
  response_token_hash  VARCHAR(64),
  -- E-signature capture (Phase 1.7)
  accepted_signer_name VARCHAR(255),
  accepted_signer_ip   INET,
  notes                TEXT,
  exclusions           TEXT,
  terms                TEXT,
  created_by           INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_estimates_number UNIQUE (company_id, estimate_number)
);
CREATE INDEX IF NOT EXISTS idx_estimates_company_status ON estimates (company_id, status);
CREATE INDEX IF NOT EXISTS idx_estimates_client ON estimates (client_id);
CREATE INDEX IF NOT EXISTS idx_estimates_response_token ON estimates (response_token_hash)
  WHERE response_token_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS estimate_lines (
  id              SERIAL PRIMARY KEY,
  estimate_id     INTEGER       NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  category        VARCHAR(20)   NOT NULL
    CONSTRAINT chk_estimate_lines_category CHECK (category IN
      ('labor','materials','equipment','subs','overhead','contingency','other')),
  sort_order      INTEGER       NOT NULL DEFAULT 0,
  description     TEXT          NOT NULL,
  qty             DECIMAL(12,4) NOT NULL DEFAULT 1 CHECK (qty >= 0),
  unit            VARCHAR(20),
  unit_cost_cents BIGINT        NOT NULL DEFAULT 0 CHECK (unit_cost_cents >= 0),
  -- total_cents is computed line-level (round at the line, then header sums
  -- the rounded values — matches what GCs do by hand).
  total_cents     BIGINT        NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  notes           TEXT
);
CREATE INDEX IF NOT EXISTS idx_estimate_lines_estimate ON estimate_lines (estimate_id, sort_order);

CREATE TABLE IF NOT EXISTS estimate_audit (
  id            SERIAL PRIMARY KEY,
  estimate_id   INTEGER     NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  action        VARCHAR(20) NOT NULL
    CONSTRAINT chk_estimate_audit_action CHECK (action IN
      ('created','sent','accepted','declined','expired','withdrawn','converted')),
  actor_kind    VARCHAR(10) NOT NULL
    CONSTRAINT chk_estimate_audit_actor_kind CHECK (actor_kind IN
      ('admin','client','system')),
  actor_user_id INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  actor_ip      INET,
  details       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_estimate_audit_estimate ON estimate_audit (estimate_id, created_at);
