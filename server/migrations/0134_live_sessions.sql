-- Ephemeral live collaboration sessions for the plan tools (Plan Room et al).
-- A host "goes live" on a local project; teammates join and co-edit in real
-- time over an SSE channel with REST ops. The server keeps a rolling snapshot
-- of the doc state here so a session survives host disconnects and server
-- restarts (bounded to the last few seconds). Rows are transient — an idle
-- sweeper marks them ended. company_id is UUID with no FK (staging convention).
-- `tool` and `status` are fixed-value (see docs/db-enums.md + liveSessionEnums).
-- Idempotent.

CREATE TABLE IF NOT EXISTS live_sessions (
  id               BIGSERIAL PRIMARY KEY,
  company_id       UUID NOT NULL,
  tool             TEXT NOT NULL DEFAULT 'planroom',
  host_user_id     INTEGER,                              -- users(id)
  name             TEXT,
  pdf_url          TEXT,                                 -- R2 URL of the plan doc
  pdf_name         TEXT,
  state            JSONB NOT NULL DEFAULT '{}'::jsonb,   -- rolling doc snapshot
  status           TEXT NOT NULL DEFAULT 'active',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at         TIMESTAMPTZ,
  CONSTRAINT chk_live_sessions_tool   CHECK (tool IN ('planroom', 'sitework', 'roofing')),
  CONSTRAINT chk_live_sessions_status CHECK (status IN ('active', 'ended'))
);

CREATE INDEX IF NOT EXISTS idx_live_sessions_company_status ON live_sessions(company_id, status);
