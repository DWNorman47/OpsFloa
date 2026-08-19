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

// Native invoice (owner-side AR) lifecycle. See migration 0149. 'partial'/'paid'
// are derived from recorded payments; 'void' cancels. Distinct from the estimate
// set (an invoice is billed, not quoted) and from project_invoices' payment_status
// (which is a QBO-mirror field, not a lifecycle).
const INVOICE_STATUSES = Object.freeze([
  'draft', 'sent', 'partial', 'paid', 'void',
]);

// Once sent (a document of record) or money has moved, lines are frozen — a
// correction voids and reissues, mirroring ESTIMATE_FROZEN_STATUSES. Only 'draft'
// is editable.
const INVOICE_FROZEN_STATUSES = Object.freeze([
  'sent', 'partial', 'paid', 'void',
]);

// How a recorded payment came in (invoice_payments.method).
const INVOICE_PAYMENT_METHODS = Object.freeze([
  'check', 'card', 'cash', 'ach', 'other',
]);

// Audit trail values for invoice_audit.action (reuses the actor_kind set).
const INVOICE_AUDIT_ACTIONS = Object.freeze([
  'created', 'sent', 'payment', 'voided',
]);

// project_expenses.status lifecycle. 'planned' = a forecast cost (rolls into the
// COMMITTED bucket of the spend/P&L rollup); 'actual' = incurred (SPENT). See
// migration 0180. Default 'actual' keeps existing rows counting as spent.
const PROJECT_EXPENSE_STATUSES = Object.freeze(['planned', 'actual']);
const PROJECT_EXPENSE_STATUS_DEFAULT = 'actual';

// How a company recognizes MATERIALS cost on a project (settings.materials_cost_basis):
//   'issued'   — cost = inventory issued to the job (warehouse → job flow). Default.
//   'received' — cost = value received on the job's POs (buy-to-jobsite flow).
// Open POs count as committed in both; only the SPENT source switches, so a
// company never double-counts. See server/utils/projectCost.js.
const MATERIALS_COST_BASES = Object.freeze(['issued', 'received']);
const MATERIALS_COST_BASIS_DEFAULT = 'issued';

// estimate_lines.line_type. base + allowance count toward the bid total (and the
// converted budget); alternate + optional are priced but shown separately.
const ESTIMATE_LINE_TYPES = Object.freeze(['base', 'allowance', 'alternate', 'optional']);
// The types included in the bid total / budget seed.
const ESTIMATE_LINE_TYPES_IN_TOTAL = Object.freeze(['base', 'allowance']);

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
    // alternate / optional lines are priced but shown separately — they don't
    // count toward the base bid total. Missing type → 'base' (legacy lines).
    if (l.line_type && !ESTIMATE_LINE_TYPES_IN_TOTAL.includes(l.line_type)) return sum;
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

// Invoice header math. Simpler than an estimate: an invoice bills line items +
// tax; there is no overhead/margin/contingency cascade (those are cost/estimate
// concepts, already baked into a from-estimate invoice's lines). `retainage_held`
// is the portion the client withholds until closeout — computed off the total,
// tracked so the closeout retainage-release check has a real number to read.
function computeInvoiceTotals({ lines = [], tax_pct = 0, retainage_pct = 0 }) {
  const subtotal = lines.reduce((sum, l) => {
    const lineTotal = Number.isFinite(l.total_cents) ? Math.round(l.total_cents) : 0;
    return sum + Math.max(0, lineTotal);
  }, 0);
  const tax = Math.round(subtotal * (tax_pct / 100));
  const total = subtotal + tax;
  const retainage_held = Math.round(total * (retainage_pct / 100));
  return { subtotal, tax, total, retainage_held };
}

module.exports = {
  ESTIMATE_STATUSES,
  ESTIMATE_FROZEN_STATUSES,
  MONEY_CATEGORIES,
  ESTIMATE_AUDIT_ACTIONS,
  ESTIMATE_AUDIT_ACTOR_KINDS,
  CHANGE_ORDER_STATUSES,
  CHANGE_ORDER_FROZEN_STATUSES,
  INVOICE_STATUSES,
  INVOICE_FROZEN_STATUSES,
  INVOICE_PAYMENT_METHODS,
  INVOICE_AUDIT_ACTIONS,
  PROJECT_EXPENSE_STATUSES,
  PROJECT_EXPENSE_STATUS_DEFAULT,
  MATERIALS_COST_BASES,
  MATERIALS_COST_BASIS_DEFAULT,
  ESTIMATE_LINE_TYPES,
  ESTIMATE_LINE_TYPES_IN_TOTAL,
  computeEstimateTotals,
  computeLineTotal,
  computeInvoiceTotals,
};
