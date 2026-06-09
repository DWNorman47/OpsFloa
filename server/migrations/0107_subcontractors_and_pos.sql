-- Subcontractors directory + subcontract POs + PO payments.
-- The spend rollup endpoint (Phase 3) already has hooks for these tables;
-- once 0107 is applied, those hooks light up and the 'subs' bucket on
-- the project budget bar starts reflecting real data.

-- Subs are a separate entity from clients (companies we BILL) and
-- inventory_suppliers (vendors we BUY ITEMS FROM). Subs are companies
-- we PAY FOR SCOPE OF WORK on projects.
CREATE TABLE IF NOT EXISTS subcontractors (
  id              SERIAL PRIMARY KEY,
  company_id      UUID         NOT NULL,
  name            VARCHAR(255) NOT NULL,
  contact_name    VARCHAR(255),
  contact_email   VARCHAR(255),
  contact_phone   VARCHAR(50),
  license_number  VARCHAR(100),
  scope_specialty VARCHAR(255),
  notes           TEXT,
  archived        BOOLEAN      NOT NULL DEFAULT false,
  created_by      INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_subs_company           ON subcontractors (company_id);
CREATE INDEX IF NOT EXISTS idx_subs_company_archived  ON subcontractors (company_id, archived);

-- COI / W-9 / license / contract / other documents for each sub.
-- Same shape as client_documents.
CREATE TABLE IF NOT EXISTS subcontractor_documents (
  id                SERIAL PRIMARY KEY,
  subcontractor_id  INTEGER     NOT NULL REFERENCES subcontractors(id) ON DELETE CASCADE,
  doc_type          VARCHAR(20) NOT NULL
    CONSTRAINT chk_subdocs_doc_type CHECK (doc_type IN ('coi', 'w9', 'license', 'contract', 'other')),
  name              VARCHAR(255) NOT NULL,
  url               TEXT         NOT NULL,
  size_bytes        BIGINT,
  expires_on        DATE,
  uploaded_by       INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_subdocs_sub ON subcontractor_documents (subcontractor_id);

-- Subcontract POs. Tied to a project (RESTRICT delete — losing a PO
-- because a project was deleted would lose budget commitment history)
-- and a sub (same).
CREATE TABLE IF NOT EXISTS subcontract_pos (
  id                SERIAL PRIMARY KEY,
  company_id        UUID         NOT NULL,
  po_number         VARCHAR(50)  NOT NULL,  -- 'SP-2026-0042'
  project_id        INTEGER      NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  subcontractor_id  INTEGER      NOT NULL REFERENCES subcontractors(id) ON DELETE RESTRICT,
  status            VARCHAR(20)  NOT NULL DEFAULT 'draft'
    CONSTRAINT chk_spo_status CHECK (status IN ('draft','issued','partial','complete','cancelled')),
  amount_cents      BIGINT       NOT NULL CHECK (amount_cents >= 0),
  scope_of_work     TEXT         NOT NULL,
  retainage_pct     DECIMAL(5,2) NOT NULL DEFAULT 0 CHECK (retainage_pct >= 0 AND retainage_pct <= 100),
  notes             TEXT,
  created_by        INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  issued_at         TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  cancelled_at      TIMESTAMPTZ,
  CONSTRAINT uq_spo_number UNIQUE (company_id, po_number)
);
CREATE INDEX IF NOT EXISTS idx_spo_company         ON subcontract_pos (company_id);
CREATE INDEX IF NOT EXISTS idx_spo_project         ON subcontract_pos (project_id);
CREATE INDEX IF NOT EXISTS idx_spo_sub             ON subcontract_pos (subcontractor_id);
CREATE INDEX IF NOT EXISTS idx_spo_company_status  ON subcontract_pos (company_id, status);

-- Draws / payments against a sub PO. The spend rollup sums these per
-- project; PO status auto-transitions issued → partial → complete as
-- the payments accumulate.
CREATE TABLE IF NOT EXISTS subcontract_po_payments (
  id            SERIAL PRIMARY KEY,
  po_id         INTEGER     NOT NULL REFERENCES subcontract_pos(id) ON DELETE CASCADE,
  amount_cents  BIGINT      NOT NULL CHECK (amount_cents >= 0),
  paid_date     DATE        NOT NULL,
  invoice_ref   VARCHAR(100),
  notes         TEXT,
  created_by    INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_spo_payments_po ON subcontract_po_payments (po_id);
