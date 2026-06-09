// Single source of truth for subcontractor + sub PO + sub PO payment
// enum-like columns. Lockstep with the CHECK constraints in migration
// 0107. See docs/db-enums.md.

const SUBCONTRACTOR_DOC_TYPES = Object.freeze([
  'coi', 'w9', 'license', 'contract', 'other',
]);

// Sub PO status lifecycle:
//   draft -> issued -> partial -> complete
//                              \--> cancelled (from any of the above except complete)
const SUBCONTRACT_PO_STATUSES = Object.freeze([
  'draft', 'issued', 'partial', 'complete', 'cancelled',
]);

// Statuses whose dollars count toward the "committed" bucket of the
// project budget (unpaid commitment). Spent is always sum of payments.
const SUBCONTRACT_PO_OPEN_STATUSES = Object.freeze(['issued', 'partial']);

// Given a current status + the new total of payments + the PO's
// amount_cents, decide what the status should become. Cancelled never
// auto-transitions (cancellation is a manual decision); complete is
// reached when paid total ≥ amount_cents from any non-cancelled status.
// Used inside the payment write TX.
function nextStatusAfterPayment({ currentStatus, paidCentsAfter, amountCents }) {
  if (currentStatus === 'cancelled' || currentStatus === 'complete') {
    return currentStatus;
  }
  if (paidCentsAfter >= amountCents) return 'complete';
  if (paidCentsAfter > 0) return 'partial';
  return currentStatus;  // typically 'issued'; remain there on a zero-dollar payment (no-op)
}

module.exports = {
  SUBCONTRACTOR_DOC_TYPES,
  SUBCONTRACT_PO_STATUSES,
  SUBCONTRACT_PO_OPEN_STATUSES,
  nextStatusAfterPayment,
};
