-- Lien waivers — conditional/unconditional waivers signed in either
-- direction (from sub → us, or from us → owner). Used to release
-- retainage. v1 ships data model + lifecycle; PDF generation is a
-- separate follow-up.

CREATE TABLE IF NOT EXISTS lien_waivers (
  id                SERIAL PRIMARY KEY,
  company_id        UUID         NOT NULL,
  project_id        INTEGER      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  direction         VARCHAR(20)  NOT NULL
    CONSTRAINT chk_lw_direction CHECK (direction IN ('from_sub', 'from_us')),
  -- Sub PO direction
  subcontract_po_id INTEGER      REFERENCES subcontract_pos(id) ON DELETE SET NULL,
  sub_payment_id    INTEGER      REFERENCES subcontract_po_payments(id) ON DELETE SET NULL,
  subcontractor_id  INTEGER      REFERENCES subcontractors(id) ON DELETE SET NULL,
  -- Our direction
  invoice_id        INTEGER      REFERENCES project_invoices(id) ON DELETE SET NULL,
  -- Form data
  waiver_type       VARCHAR(30)  NOT NULL
    CONSTRAINT chk_lw_type CHECK (waiver_type IN
      ('conditional_progress','unconditional_progress','conditional_final','unconditional_final')),
  amount_cents      BIGINT       NOT NULL CHECK (amount_cents >= 0),
  through_date      DATE         NOT NULL,
  state             VARCHAR(2),                                -- US state for form selection (CA / TX / FL / NY / generic)
  -- Signature capture
  signer_name       VARCHAR(255) NOT NULL,
  signer_title      VARCHAR(120),
  signer_company    VARCHAR(255) NOT NULL,
  signed_at         TIMESTAMPTZ,
  signed_ip         INET,
  signature_method  VARCHAR(20)
    CONSTRAINT chk_lw_sig_method CHECK (signature_method IS NULL OR signature_method IN
      ('typed','drawn','wet_signed_upload','docusign')),
  signature_data    TEXT,
  -- Lifecycle
  status            VARCHAR(20)  NOT NULL DEFAULT 'draft'
    CONSTRAINT chk_lw_status CHECK (status IN ('draft','sent','signed','received','superseded','void')),
  -- Tokenized public signing link (raw token in email, sha256 here)
  sign_token_hash   VARCHAR(64),
  pdf_url           TEXT,
  notes             TEXT,
  created_by        INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- If this waiver was superseded by a corrected/revised one.
  superseded_by_id  INTEGER      REFERENCES lien_waivers(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_lw_project        ON lien_waivers (project_id);
CREATE INDEX IF NOT EXISTS idx_lw_company        ON lien_waivers (company_id);
CREATE INDEX IF NOT EXISTS idx_lw_sub_po         ON lien_waivers (subcontract_po_id) WHERE direction = 'from_sub';
CREATE INDEX IF NOT EXISTS idx_lw_invoice        ON lien_waivers (invoice_id)         WHERE direction = 'from_us';
CREATE INDEX IF NOT EXISTS idx_lw_status         ON lien_waivers (company_id, status);
CREATE INDEX IF NOT EXISTS idx_lw_sign_token     ON lien_waivers (sign_token_hash)
  WHERE sign_token_hash IS NOT NULL;

-- Uploaded scans (wet-signed, DocuSign envelope, etc.) attached to a waiver.
CREATE TABLE IF NOT EXISTS lien_waiver_documents (
  id           SERIAL PRIMARY KEY,
  waiver_id    INTEGER     NOT NULL REFERENCES lien_waivers(id) ON DELETE CASCADE,
  name         VARCHAR(255) NOT NULL,
  url          TEXT         NOT NULL,
  size_bytes   BIGINT,
  uploaded_by  INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lw_docs_waiver ON lien_waiver_documents (waiver_id);

-- subcontract_po_payments grows two flags so the closeout auto-status
-- for "sub lien waivers received" has data to read.
ALTER TABLE subcontract_po_payments
  ADD COLUMN IF NOT EXISTS waiver_required BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS waiver_received BOOLEAN NOT NULL DEFAULT false;
