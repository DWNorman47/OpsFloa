-- Daily Checklist items can be a checkbox (the default) or a text field the worker fills in.
-- `kind` distinguishes them; `value` holds a text item's entered text (checkboxes use
-- `checked`). The kind is authored on the template (recurring items + prepared-day plan
-- items) and copied onto each day's items when the day is assembled. See
-- server/constants/dailyChecklistEnums.js and docs/plans/daily-checklist.md.

ALTER TABLE daily_checklist_recurring_items
  ADD COLUMN IF NOT EXISTS kind VARCHAR(10) NOT NULL DEFAULT 'check' CHECK (kind IN ('check', 'text'));

ALTER TABLE daily_checklist_items
  ADD COLUMN IF NOT EXISTS kind VARCHAR(10) NOT NULL DEFAULT 'check' CHECK (kind IN ('check', 'text'));

ALTER TABLE daily_checklist_items
  ADD COLUMN IF NOT EXISTS value TEXT;
