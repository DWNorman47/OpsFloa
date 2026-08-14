-- Generalize safety checklists into a typed Checklist Builder: each template
-- carries a category so one builder covers safety / quality / pre-task /
-- equipment / general lists. Existing rows keep their original meaning (safety).
ALTER TABLE safety_checklist_templates
  ADD COLUMN IF NOT EXISTS type VARCHAR(30) NOT NULL DEFAULT 'safety';

ALTER TABLE safety_checklist_templates
  DROP CONSTRAINT IF EXISTS safety_checklist_templates_type_check;
ALTER TABLE safety_checklist_templates
  ADD CONSTRAINT safety_checklist_templates_type_check
  CHECK (type IN ('safety', 'quality', 'pretask', 'equipment', 'general'));
