-- Work orders (Work module): the dispatch/service atom that sits beside Projects.
--
-- A work order is a single, self-contained job with its own lifecycle — created,
-- scheduled, assigned, done, (optionally) billed. It either stands alone (a
-- service call, no project) or attaches to a project (project_id set) for
-- warranty callbacks and T&M extras that aren't part of the contracted scope.
-- Projects hold tasks; work orders are the schedulable/billable unit.
--
-- Complements service_requests (public inbound intake): a request can convert to
-- a work order OR a project.

CREATE TABLE IF NOT EXISTS work_orders (
  id            SERIAL       PRIMARY KEY,
  company_id    UUID         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id    INTEGER      REFERENCES projects(id) ON DELETE SET NULL,  -- NULL = standalone service call
  client_id     INTEGER      REFERENCES clients(id)  ON DELETE SET NULL,
  title         VARCHAR(255) NOT NULL,
  address       TEXT,
  status        VARCHAR(20)  NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'scheduled', 'in_progress', 'completed', 'canceled')),
  priority      VARCHAR(10)  NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  assigned_to   INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  scheduled_at  TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  description   TEXT,
  amount        NUMERIC(12,2),
  created_by    INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  active        BOOLEAN      NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_work_orders_company_status ON work_orders(company_id, status);
CREATE INDEX IF NOT EXISTS idx_work_orders_project  ON work_orders(project_id)  WHERE project_id  IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_work_orders_assigned ON work_orders(assigned_to) WHERE assigned_to IS NOT NULL;
