-- Phase 2 of project money flow: replace projects.budget_dollars (a
-- single number) with per-category budget rows. The seven categories
-- match estimate_lines.category and will match change_order_lines.category,
-- project_expenses.category — the shared MONEY_CATEGORIES vocabulary in
-- server/constants/projectMoneyEnums.js.
--
-- Existing rows keep working: projects.budget_dollars stays populated as
-- the legacy total for one release while every read site migrates. The
-- backfill puts the existing total into the 'labor' bucket (most accurate
-- assumption — every existing project's budget today only tracks against
-- labor cost via the time-entry rollup).

CREATE TABLE IF NOT EXISTS project_budget_categories (
  id               SERIAL PRIMARY KEY,
  project_id       INTEGER     NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category         VARCHAR(20) NOT NULL
    CONSTRAINT chk_pbc_category CHECK (category IN
      ('labor','materials','equipment','subs','overhead','contingency','other')),
  budget_cents     BIGINT      NOT NULL DEFAULT 0 CHECK (budget_cents >= 0),
  -- Per-category alert watermark. NULL = inherit company default.
  budget_alert_pct SMALLINT    CHECK (budget_alert_pct IS NULL OR (budget_alert_pct > 0 AND budget_alert_pct <= 200)),
  notes            TEXT,
  CONSTRAINT uq_pbc_project_category UNIQUE (project_id, category)
);
CREATE INDEX IF NOT EXISTS idx_pbc_project ON project_budget_categories (project_id);

-- Backfill: every project with budget_dollars > 0 gets a single 'labor'
-- row. Run inside a single statement so partial application can't leave
-- some companies migrated and some not.
INSERT INTO project_budget_categories (project_id, category, budget_cents, budget_alert_pct)
SELECT id, 'labor', ROUND(budget_dollars * 100)::bigint, budget_alert_pct
  FROM projects
 WHERE budget_dollars IS NOT NULL AND budget_dollars > 0
ON CONFLICT (project_id, category) DO NOTHING;
