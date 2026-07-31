-- Native invoices (owner-side AR). OpsFloa's own invoice concept so a company
-- WITHOUT QuickBooks can invoice, record payment, and close out a project.
-- QuickBooks becomes an optional sync layer — the old `project_invoices` QBO
-- mirror is unified into this in a later phase. Mirrors the estimates model
-- (0104): header + child lines + payments + audit; cents/BIGINT money with
-- projectMoneyEnums.js-backed CHECK constraints.

CREATE TABLE IF NOT EXISTS invoices (
  id                   SERIAL PRIMARY KEY,
  company_id           UUID         NOT NULL,
  project_id           INTEGER      REFERENCES projects(id) ON DELETE SET NULL,
  client_id            INTEGER      REFERENCES clients(id) ON DELETE SET NULL,
  invoice_number       VARCHAR(50)  NOT NULL,
  -- Snapshot of client info at create/send time so renamed/deleted clients
  -- don't silently rewrite a sent invoice.
  client_name_snapshot VARCHAR(255) NOT NULL,
  client_email         VARCHAR(255),
  project_name         VARCHAR(255),
  project_address      TEXT,
  status               VARCHAR(20)  NOT NULL DEFAULT 'draft'
    CONSTRAINT chk_invoices_status CHECK (status IN
      ('draft','sent','partial','paid','void')),
  -- Money. Cents non-negative; percentages 0+. 'overdue' is DERIVED from due_date,
  -- never stored. partial/paid derive from recorded invoice_payments.
  subtotal_cents       BIGINT       NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  tax_pct              DECIMAL(5,2) NOT NULL DEFAULT 0 CHECK (tax_pct >= 0),
  tax_cents            BIGINT       NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents          BIGINT       NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  -- Owner-side retainage withheld until closeout (had no home in the schema).
  retainage_pct        DECIMAL(5,2) NOT NULL DEFAULT 0 CHECK (retainage_pct >= 0),
  retainage_held_cents BIGINT       NOT NULL DEFAULT 0 CHECK (retainage_held_cents >= 0),
  -- Lifecycle
  issue_date           DATE,
  due_date             DATE,
  sent_at              TIMESTAMPTZ,
  -- Tokenized public view/pay page (raw token in the link; sha256 stored) — like estimates.
  response_token_hash  VARCHAR(64),
  -- Provenance + optional source estimate (from-estimate creation path).
  source               VARCHAR(20)  NOT NULL DEFAULT 'scratch'
    CONSTRAINT chk_invoices_source CHECK (source IN ('scratch','estimate','project')),
  source_estimate_id   INTEGER      REFERENCES estimates(id) ON DELETE SET NULL,
  -- Set when synced to QuickBooks (optional layer); the native row is the truth.
  qbo_invoice_id       VARCHAR(50),
  notes                TEXT,
  terms                TEXT,
  created_by           INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_invoices_number UNIQUE (company_id, invoice_number)
);
CREATE INDEX IF NOT EXISTS idx_invoices_company_status ON invoices (company_id, status);
CREATE INDEX IF NOT EXISTS idx_invoices_project ON invoices (project_id);
CREATE INDEX IF NOT EXISTS idx_invoices_client ON invoices (client_id);
CREATE INDEX IF NOT EXISTS idx_invoices_response_token ON invoices (response_token_hash)
  WHERE response_token_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS invoice_lines (
  id              SERIAL PRIMARY KEY,
  invoice_id      INTEGER       NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  category        VARCHAR(20)   NOT NULL
    CONSTRAINT chk_invoice_lines_category CHECK (category IN
      ('labor','materials','equipment','subs','overhead','contingency','other')),
  sort_order      INTEGER       NOT NULL DEFAULT 0,
  description     TEXT          NOT NULL,
  qty             DECIMAL(12,4) NOT NULL DEFAULT 1 CHECK (qty >= 0),
  unit            VARCHAR(20),
  unit_cost_cents BIGINT        NOT NULL DEFAULT 0 CHECK (unit_cost_cents >= 0),
  -- Rounded at the line; the header sums the rounded values (matches the PDF).
  total_cents     BIGINT        NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  notes           TEXT
);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON invoice_lines (invoice_id, sort_order);

CREATE TABLE IF NOT EXISTS invoice_payments (
  id            SERIAL PRIMARY KEY,
  invoice_id    INTEGER     NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  company_id    UUID        NOT NULL,
  amount_cents  BIGINT      NOT NULL CHECK (amount_cents > 0),
  paid_date     DATE        NOT NULL DEFAULT CURRENT_DATE,
  method        VARCHAR(10) NOT NULL DEFAULT 'other'
    CONSTRAINT chk_invoice_payments_method CHECK (method IN
      ('check','card','cash','ach','other')),
  reference     VARCHAR(120),
  notes         TEXT,
  created_by    INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice ON invoice_payments (invoice_id, paid_date);

CREATE TABLE IF NOT EXISTS invoice_audit (
  id            SERIAL PRIMARY KEY,
  invoice_id    INTEGER     NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  action        VARCHAR(20) NOT NULL
    CONSTRAINT chk_invoice_audit_action CHECK (action IN
      ('created','sent','payment','voided')),
  actor_kind    VARCHAR(10) NOT NULL
    CONSTRAINT chk_invoice_audit_actor_kind CHECK (actor_kind IN
      ('admin','client','system')),
  actor_user_id INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  actor_ip      INET,
  details       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_invoice_audit_invoice ON invoice_audit (invoice_id, created_at);
