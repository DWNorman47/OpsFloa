-- Project Daily setup — recurring daily-checklist items gain scope + mode, and days
-- carry them per item so each worker sees only their team-member-type's items (plus
-- all-types defaults), and "individual" items track a private per-person check state.
--
--   recurring.project_id NULL = company default (applies to every project)
--   recurring.role_id    NULL = applies to every team-member-type
--   recurring.mode 'shared'     = one shared row; everyone matching sees+checks the same state
--                  'individual' = each matching person gets their own private check state
--
-- Existing rows keep project_id set + role_id NULL + mode 'shared', which is exactly
-- their current meaning (project-specific, all-types, shared).

-- Project scope: allow NULL (= default / all projects).
ALTER TABLE daily_checklist_recurring_items ALTER COLUMN project_id DROP NOT NULL;

-- Team-member-type scope (roles.id is INTEGER; NULL = all types).
ALTER TABLE daily_checklist_recurring_items
  ADD COLUMN IF NOT EXISTS role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE;

-- Shared vs individual (fixed-value → see server/constants/dailyChecklistEnums.js).
ALTER TABLE daily_checklist_recurring_items
  ADD COLUMN IF NOT EXISTS mode VARCHAR(10) NOT NULL DEFAULT 'shared'
    CHECK (mode IN ('shared', 'individual'));

-- Carry the type scope + mode onto each assembled day item.
-- role_id ON DELETE SET NULL: if a type is deleted, its past items become all-types.
ALTER TABLE daily_checklist_items
  ADD COLUMN IF NOT EXISTS role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL;
ALTER TABLE daily_checklist_items
  ADD COLUMN IF NOT EXISTS mode VARCHAR(10) NOT NULL DEFAULT 'shared'
    CHECK (mode IN ('shared', 'individual'));

-- Private per-person check state for individual items. Shared items use the item row's
-- own checked/value/checked_by; individual items use one row here per (item, user).
CREATE TABLE IF NOT EXISTS daily_checklist_item_user_state (
  id         SERIAL PRIMARY KEY,
  item_id    INTEGER NOT NULL REFERENCES daily_checklist_items(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  checked    BOOLEAN NOT NULL DEFAULT FALSE,
  value      TEXT,
  checked_at TIMESTAMPTZ,
  UNIQUE (item_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_dc_item_user_state ON daily_checklist_item_user_state (item_id, user_id);

CREATE INDEX IF NOT EXISTS idx_dc_recurring_scope
  ON daily_checklist_recurring_items (company_id, project_id, role_id, order_index);
