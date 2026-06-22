// Single source of truth for the fixed-value columns that run through
// the project money flow (estimates → categorized budget → change
// orders). Keep these frozen and IN LOCKSTEP with the CHECK constraints
// they back. Adding a value here requires the matching migration; the
// reverse is also true. See docs/db-enums.md for the registry.

// Estimate header status lifecycle. See migration 0104.
const ESTIMATE_STATUSES = Object.freeze([
  'draft',
  'sent',
  'accepted',
  'declined',
  'expired',
  'withdrawn',
]);

// Statuses that mean the estimate is no longer editable. Phase 1 reads
// this in the PATCH handler to decide whether to 409.
const ESTIMATE_FROZEN_STATUSES = Object.freeze([
  'sent', 'accepted', 'declined', 'expired',
]);

// The seven money-flow categories that thread through estimates, budget
// categories, change orders, project P&L, and WIP. The order is the
// reading order on the estimate PDF (and the budget bar). Treat it as
// stable; clients sort by it.
const MONEY_CATEGORIES = Object.freeze([
  'labor',
  'materials',
  'equipment',
  'subs',
  'overhead',
  'contingency',
  'other',
]);

// Audit trail values for estimate_audit.action.
const ESTIMATE_AUDIT_ACTIONS = Object.freeze([
  'created', 'sent', 'accepted', 'declined', 'expired', 'withdrawn', 'converted',
]);

// Change-order lifecycle. Narrower than estimates — no 'expired'
// (COs don't time out; they wait on the client) and no 'converted'
// (a CO never creates a new project; it amends an existing one).
const CHANGE_ORDER_STATUSES = Object.freeze([
  'draft', 'sent', 'accepted', 'declined', 'withdrawn',
]);

// CO statuses frozen against edits (mirrors ESTIMATE_FROZEN_STATUSES).
const CHANGE_ORDER_FROZEN_STATUSES = Object.freeze([
  'sent', 'accepted', 'declined',
]);

// Who/what wrote an audit row. 'client' is reserved for token-keyed
// public actions; 'system' for cron-driven (e.g. expiry).
const ESTIMATE_AUDIT_ACTOR_KINDS = Object.freeze([
  'admin', 'client', 'system',
]);

// Header money math. Order matters — overhead is on subtotal, margin
// is on subtotal+overhead, contingency is on the post-margin amount,
// tax is the last layer. All rounded at each step to keep the math
// agreeing with a calculator on a desk.
function computeEstimateTotals({
  lines = [],
  overhead_pct = 0,
  margin_pct = 0,
  contingency_pct = 0,
  tax_pct = 0,
}) {
  const subtotal = lines.reduce((sum, l) => {
    // Defensive: any line that isn't fully numeric counts as zero so a
    // malformed POST can't poison the total.
    const lineTotal = Number.isFinite(l.total_cents) ? Math.round(l.total_cents) : 0;
    return sum + Math.max(0, lineTotal);
  }, 0);
  const overhead    = Math.round(subtotal * (overhead_pct    / 100));
  const marginBase  = subtotal + overhead;
  const margin      = Math.round(marginBase * (margin_pct    / 100));
  const preCont     = marginBase + margin;
  const contingency = Math.round(preCont * (contingency_pct / 100));
  const preTax      = preCont + contingency;
  const tax         = Math.round(preTax * (tax_pct          / 100));
  const total       = preTax + tax;
  return { subtotal, overhead, margin, contingency, tax, total };
}

// Per-line total. Round at the line level — see the estimates plan for
// why (matches what humans do on paper, prevents weird "$0.01 off"
// reports when the math disagrees with the PDF).
function computeLineTotal({ qty, unit_cost_cents }) {
  const q = Number.isFinite(qty) ? qty : 0;
  const u = Number.isFinite(unit_cost_cents) ? unit_cost_cents : 0;
  if (q < 0 || u < 0) return 0;
  return Math.round(q * u);
}

module.exports = {
  ESTIMATE_STATUSES,
  ESTIMATE_FROZEN_STATUSES,
  MONEY_CATEGORIES,
  ESTIMATE_AUDIT_ACTIONS,
  ESTIMATE_AUDIT_ACTOR_KINDS,
  CHANGE_ORDER_STATUSES,
  CHANGE_ORDER_FROZEN_STATUSES,
  computeEstimateTotals,
  computeLineTotal,
};
