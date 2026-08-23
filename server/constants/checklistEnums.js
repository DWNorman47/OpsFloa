// Checklist template categories — power the Checklist Builder's "type" selector so
// one builder covers safety, quality, pre-task, equipment, and general lists
// (folding in the separate Inspections tool is a later phase).
//
// Fixed-value column: `safety_checklist_templates.type` (CHECK in migration 0171).
// Keep THIS list, the CHECK constraint, and docs/db-enums.md in sync.
const CHECKLIST_TEMPLATE_TYPES = ['safety', 'quality', 'pretask', 'equipment', 'general'];
const DEFAULT_CHECKLIST_TEMPLATE_TYPE = 'safety';

module.exports = { CHECKLIST_TEMPLATE_TYPES, DEFAULT_CHECKLIST_TEMPLATE_TYPE };
