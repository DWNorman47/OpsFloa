-- Haul tickets — per-job truck-load log (export haul-off / import). A haul
-- ticket has its own lifecycle (logged as trucks leave); it does NOT require a
-- daily_reports row. Feeds the estimate-vs-actual reconciliation (takeoff
-- add-on). company_id is UUID with no FK (staging companies.id may still be
-- INTEGER); project_id / created_by FK to their INTEGER-keyed tables.
-- Idempotent.

CREATE TABLE IF NOT EXISTS haul_tickets (
  id          SERIAL PRIMARY KEY,
  company_id  UUID NOT NULL,
  project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  ticket_date DATE NOT NULL,
  ticket_no   TEXT,
  hauler      TEXT,
  material    TEXT,
  qty         NUMERIC NOT NULL DEFAULT 0,
  unit        TEXT NOT NULL DEFAULT 'CY',
  direction   TEXT NOT NULL DEFAULT 'export',
  notes       TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_haul_tickets_unit CHECK (unit IN ('CY','tons','loads')),
  CONSTRAINT chk_haul_tickets_direction CHECK (direction IN ('export','import'))
);

CREATE INDEX IF NOT EXISTS idx_haul_tickets_company_project ON haul_tickets(company_id, project_id);
CREATE INDEX IF NOT EXISTS idx_haul_tickets_company_date ON haul_tickets(company_id, ticket_date);

-- Grant the new manage_haul_tickets permission to the built-in roles. It is a
-- worker-tier permission (field crews log their own hauls; admins/owners too).
-- Custom roles snapshot at creation and do NOT auto-gain new permissions, by
-- design. Idempotent via ON CONFLICT.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'manage_haul_tickets'
FROM roles r
WHERE r.is_builtin = true AND r.name IN ('Worker', 'Admin', 'Owner')
ON CONFLICT DO NOTHING;
