-- Daily Checklist — a per-project checklist that recurs each working day. Distinct from
-- punchlist_items (the persistent issue/punch tracker). See docs/plans/daily-checklist.md.
--
-- Three tables:
--   daily_checklist_recurring_items — the project's standing "every day" template
--   daily_checklists                — one row per prepared-or-worked day (a lifecycle)
--   daily_checklist_items           — the checkable items on a given day
--
-- Status/type columns are fixed-value → CHECK-enforced here (see
-- server/constants/dailyChecklistEnums.js, docs/db-enums.md). Phase 1 uses the adhoc
-- start + recurring template + rollover; the scheduling columns (schedule_type/
-- scheduled_date/ordinal_target/queue_order) land now so Phase 2 needs no schema change.

CREATE TABLE IF NOT EXISTS daily_checklist_recurring_items (
  id          SERIAL PRIMARY KEY,
  company_id  UUID    NOT NULL REFERENCES companies(id),
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  text        TEXT    NOT NULL,
  order_index INTEGER NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dc_recurring_project ON daily_checklist_recurring_items (project_id, order_index);

CREATE TABLE IF NOT EXISTS daily_checklists (
  id             SERIAL PRIMARY KEY,
  company_id     UUID    NOT NULL REFERENCES companies(id),
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status         VARCHAR(20) NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'paused', 'active', 'completed', 'canceled')),
  schedule_type  VARCHAR(20) NOT NULL DEFAULT 'adhoc'
                   CHECK (schedule_type IN ('calendar', 'ordinal', 'adhoc')),
  scheduled_date DATE,               -- calendar target (schedule_type = calendar)
  ordinal_target INTEGER,            -- Nth worked day (schedule_type = ordinal)
  queue_order    INTEGER,            -- reorderable position while pending; null once active/done
  work_date      DATE,              -- actual worked date, set on start
  day_number     INTEGER,           -- ordinal assigned on start (spent only by worked days)
  name           VARCHAR(200),
  notes          TEXT,
  started_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  started_at     TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dc_project_status ON daily_checklists (project_id, status);
-- At most one ACTIVE day per project.
CREATE UNIQUE INDEX IF NOT EXISTS uq_dc_one_active_per_project
  ON daily_checklists (project_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS daily_checklist_items (
  id                SERIAL PRIMARY KEY,
  daily_checklist_id INTEGER NOT NULL REFERENCES daily_checklists(id) ON DELETE CASCADE,
  text              TEXT    NOT NULL,
  checked           BOOLEAN NOT NULL DEFAULT FALSE,
  order_index       INTEGER NOT NULL DEFAULT 0,
  source            VARCHAR(20) NOT NULL DEFAULT 'manual'
                      CHECK (source IN ('recurring', 'scheduled', 'manual', 'rollover')),
  checked_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  checked_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dc_items_day ON daily_checklist_items (daily_checklist_id, order_index);
