-- Submittals — material/equipment specs sent to architect/owner for
-- approval BEFORE installation. Compliance feature; independent of
-- the money flow.

CREATE TABLE IF NOT EXISTS submittals (
  id                   SERIAL PRIMARY KEY,
  company_id           UUID         NOT NULL,
  project_id           INTEGER      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- "SUB-A-001" etc.; uniqueness only at (project_id, number, revision).
  submittal_number     VARCHAR(50)  NOT NULL,
  spec_section         VARCHAR(20),
  title                VARCHAR(255) NOT NULL,
  description          TEXT,
  status               VARCHAR(20)  NOT NULL DEFAULT 'draft'
    CONSTRAINT chk_sub_status CHECK (status IN
      ('draft','pending_internal','sent_to_reviewer','approved','approved_as_noted','revise_resubmit','rejected','closed','void')),
  -- People in the loop
  responsible_user_id  INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  responsible_sub_id   INTEGER      REFERENCES subcontractors(id) ON DELETE SET NULL,
  reviewer_name        VARCHAR(255),
  reviewer_email       VARCHAR(255),
  reviewer_org         VARCHAR(255),
  -- Tracking
  required_by          DATE,
  sent_to_reviewer_at  TIMESTAMPTZ,
  reviewer_responded_at TIMESTAMPTZ,
  reviewer_stamp       VARCHAR(40),
  revision             INTEGER     NOT NULL DEFAULT 0,
  superseded_by_id     INTEGER     REFERENCES submittals(id) ON DELETE SET NULL,
  notes                TEXT,
  created_by           INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_submittal_number UNIQUE (company_id, project_id, submittal_number, revision)
);
CREATE INDEX IF NOT EXISTS idx_sub_project_status ON submittals (project_id, status);
CREATE INDEX IF NOT EXISTS idx_sub_required_by    ON submittals (project_id, required_by)
  WHERE status NOT IN ('approved','approved_as_noted','closed','void');
CREATE INDEX IF NOT EXISTS idx_sub_company        ON submittals (company_id);

CREATE TABLE IF NOT EXISTS submittal_documents (
  id            SERIAL PRIMARY KEY,
  submittal_id  INTEGER NOT NULL REFERENCES submittals(id) ON DELETE CASCADE,
  kind          VARCHAR(20) NOT NULL
    CONSTRAINT chk_subdocs_kind CHECK (kind IN ('submission','stamped_return','spec','reference','other')),
  name          VARCHAR(255) NOT NULL,
  url           TEXT         NOT NULL,
  size_bytes    BIGINT,
  uploaded_by   INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_submittal_docs_sub ON submittal_documents (submittal_id);

CREATE TABLE IF NOT EXISTS submittal_audit (
  id            SERIAL PRIMARY KEY,
  submittal_id  INTEGER     NOT NULL REFERENCES submittals(id) ON DELETE CASCADE,
  action        VARCHAR(20) NOT NULL
    CONSTRAINT chk_submittal_audit_action CHECK (action IN
      ('created','sent_internal','sent_reviewer','stamp_received','revised','closed','voided','document_added','document_removed')),
  actor_user_id INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  details       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_submittal_audit_sub ON submittal_audit (submittal_id, created_at);
