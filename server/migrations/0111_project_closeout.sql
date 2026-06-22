-- Project closeout — checklist orchestrating punchlist completion,
-- as-builts, warranty info, final lien waivers, final invoice, retainage
-- release. Most items are auto-status (computed from other modules' state);
-- a few are manual (admin checks them off with notes + attached doc).

CREATE TABLE IF NOT EXISTS project_closeouts (
  id                          SERIAL PRIMARY KEY,
  company_id                  UUID         NOT NULL,
  project_id                  INTEGER      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status                      VARCHAR(30)  NOT NULL DEFAULT 'open'
    CONSTRAINT chk_closeout_status CHECK (status IN
      ('open','in_progress','substantially_complete','final_complete','closed','reopened')),
  substantial_completion_date DATE,
  final_completion_date       DATE,
  warranty_start_date         DATE,        -- usually = substantial_completion_date
  warranty_months             INTEGER      DEFAULT 12 CHECK (warranty_months IS NULL OR warranty_months >= 0),
  notes                       TEXT,
  created_by                  INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  closed_at                   TIMESTAMPTZ,
  CONSTRAINT uq_closeout_project UNIQUE (project_id)
);
CREATE INDEX IF NOT EXISTS idx_closeout_company        ON project_closeouts (company_id);
CREATE INDEX IF NOT EXISTS idx_closeout_status         ON project_closeouts (company_id, status);
-- Supports the "warranties expiring" query, which filters by company_id over
-- closeouts that have a completion date + warranty term and computes the
-- warranty-end date at query time. The end date can't be indexed directly:
-- `date + interval` isn't IMMUTABLE, so an expression index on it is rejected
-- ("functions in index expression must be marked IMMUTABLE"). Index the raw
-- columns instead and let the planner compute the end date over the partial set.
CREATE INDEX IF NOT EXISTS idx_closeout_warranty_end   ON project_closeouts
  (company_id, substantial_completion_date, warranty_months)
  WHERE substantial_completion_date IS NOT NULL;

CREATE TABLE IF NOT EXISTS project_closeout_items (
  id            SERIAL PRIMARY KEY,
  closeout_id   INTEGER      NOT NULL REFERENCES project_closeouts(id) ON DELETE CASCADE,
  category      VARCHAR(30)  NOT NULL
    CONSTRAINT chk_closeout_item_category CHECK (category IN
      ('punchlist','as_builts','warranty','o_and_m','lien_waivers_subs','lien_waiver_to_owner',
       'final_invoice','retainage_release','certificate_substantial','final_inspection','custom')),
  title         VARCHAR(255) NOT NULL,
  description   TEXT,
  sort_order    INTEGER      NOT NULL DEFAULT 0,
  required      BOOLEAN      NOT NULL DEFAULT true,
  status        VARCHAR(20)  NOT NULL DEFAULT 'pending'
    CONSTRAINT chk_closeout_item_status CHECK (status IN
      ('pending','in_progress','done','waived','n_a')),
  -- 'auto_source' set → admin can't toggle status; computed on read.
  -- Valid sources: 'punchlist', 'lien_waivers', 'invoices', etc.
  auto_source   VARCHAR(40),
  completed_at  TIMESTAMPTZ,
  completed_by  INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  notes         TEXT
);
CREATE INDEX IF NOT EXISTS idx_closeout_items_closeout ON project_closeout_items (closeout_id, sort_order);

-- Per-company template that seeds checklist items when a closeout is
-- opened. Default template gets inserted on first read if missing.
CREATE TABLE IF NOT EXISTS closeout_checklist_template (
  id          SERIAL PRIMARY KEY,
  company_id  UUID         NOT NULL,
  category    VARCHAR(30)  NOT NULL
    CONSTRAINT chk_closeout_template_category CHECK (category IN
      ('punchlist','as_builts','warranty','o_and_m','lien_waivers_subs','lien_waiver_to_owner',
       'final_invoice','retainage_release','certificate_substantial','final_inspection','custom')),
  title       VARCHAR(255) NOT NULL,
  description TEXT,
  sort_order  INTEGER      NOT NULL DEFAULT 0,
  required    BOOLEAN      NOT NULL DEFAULT true,
  auto_source VARCHAR(40),
  active      BOOLEAN      NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS idx_closeout_template_company ON closeout_checklist_template (company_id) WHERE active;
