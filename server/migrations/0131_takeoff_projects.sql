-- Company-shared takeoff projects for the sitework takeoff tool. One
-- authoritative row per takeoff; teammates open / edit / save it one at a time
-- (async, not real-time). `version` is optimistic-concurrency: a save carrying
-- a stale version is rejected (409) so it can't silently overwrite a teammate.
-- company_id is UUID with no FK (staging companies.id may still be INTEGER).
-- Idempotent.

CREATE TABLE IF NOT EXISTS takeoff_projects (
  id         BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL,
  name       TEXT NOT NULL DEFAULT 'Takeoff',
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,  -- projectData() JSON (no PDF bytes)
  pdf_url    TEXT,                                 -- R2 public URL of the plan PDF
  pdf_name   TEXT,
  created_by INTEGER,                              -- users(id)
  updated_by INTEGER,                              -- users(id)
  version    INTEGER NOT NULL DEFAULT 1,           -- bumped on each save (concurrency)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_takeoff_projects_company ON takeoff_projects(company_id);
