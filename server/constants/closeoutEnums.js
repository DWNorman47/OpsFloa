// Single source of truth for closeout status / item status / category
// enums. Lockstep with migration 0111.

const CLOSEOUT_STATUSES = Object.freeze([
  'open', 'in_progress', 'substantially_complete', 'final_complete',
  'closed', 'reopened',
]);

// What "substantially_complete" means concretely depends on what items
// the company has marked as required for that gate (see below).
const CLOSEOUT_TERMINAL_STATUSES = Object.freeze(['closed']);

const CLOSEOUT_ITEM_STATUSES = Object.freeze([
  'pending', 'in_progress', 'done', 'waived', 'n_a',
]);

const CLOSEOUT_ITEM_DONE_STATUSES = Object.freeze(['done', 'waived', 'n_a']);

const CLOSEOUT_ITEM_CATEGORIES = Object.freeze([
  'punchlist',
  'as_builts',
  'warranty',
  'o_and_m',
  'lien_waivers_subs',
  'lien_waiver_to_owner',
  'final_invoice',
  'retainage_release',
  'certificate_substantial',
  'final_inspection',
  'custom',
]);

// The default 10-item checklist seeded for every company on first use.
// `auto_source` is set on items that should be auto-computed from other
// modules' state — admins can't manually toggle those.
const DEFAULT_CHECKLIST = Object.freeze([
  { category: 'punchlist',               title: 'Punchlist 100% complete',          auto_source: 'punchlist',     sort_order: 10, required: true },
  { category: 'final_inspection',        title: 'Final inspection passed',          auto_source: null,            sort_order: 20, required: true },
  { category: 'certificate_substantial', title: 'Certificate of substantial completion', auto_source: null,       sort_order: 30, required: true },
  { category: 'as_builts',               title: 'As-built drawings delivered',      auto_source: null,            sort_order: 40, required: true },
  { category: 'o_and_m',                 title: 'O&M manuals delivered',            auto_source: null,            sort_order: 50, required: true },
  { category: 'warranty',                title: 'Warranty documents delivered',     auto_source: null,            sort_order: 60, required: true },
  { category: 'lien_waivers_subs',       title: 'Lien waivers from all subs',       auto_source: 'lien_waivers',  sort_order: 70, required: true },
  { category: 'lien_waiver_to_owner',    title: 'Final lien waiver to owner',       auto_source: 'lien_waivers',  sort_order: 80, required: true },
  { category: 'final_invoice',           title: 'Final invoice paid',               auto_source: 'invoices',      sort_order: 90, required: true },
  { category: 'retainage_release',       title: 'Retainage released',               auto_source: 'invoices',      sort_order: 100, required: true },
]);

module.exports = {
  CLOSEOUT_STATUSES,
  CLOSEOUT_TERMINAL_STATUSES,
  CLOSEOUT_ITEM_STATUSES,
  CLOSEOUT_ITEM_DONE_STATUSES,
  CLOSEOUT_ITEM_CATEGORIES,
  DEFAULT_CHECKLIST,
};
