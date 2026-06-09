// Lien waiver enums + lifecycle helpers. Lockstep with migration 0112.

const LIEN_WAIVER_DIRECTIONS = Object.freeze(['from_sub', 'from_us']);

const LIEN_WAIVER_TYPES = Object.freeze([
  'conditional_progress',
  'unconditional_progress',
  'conditional_final',
  'unconditional_final',
]);

const LIEN_WAIVER_STATUSES = Object.freeze([
  'draft', 'sent', 'signed', 'received', 'superseded', 'void',
]);

const LIEN_WAIVER_SIGNATURE_METHODS = Object.freeze([
  'typed', 'drawn', 'wet_signed_upload', 'docusign',
]);

// Statuses that represent "we have a real signed waiver in hand" for
// downstream consumers (closeout auto-status, retainage release gates).
const LIEN_WAIVER_FINAL_STATUSES = Object.freeze(['signed', 'received']);

// Map a conditional waiver type to its unconditional counterpart.
// Used by the "convert conditional → unconditional" flow once payment
// is actually confirmed.
function unconditionalFor(type) {
  switch (type) {
    case 'conditional_progress': return 'unconditional_progress';
    case 'conditional_final':    return 'unconditional_final';
    default: return null;  // already unconditional or unknown
  }
}

module.exports = {
  LIEN_WAIVER_DIRECTIONS,
  LIEN_WAIVER_TYPES,
  LIEN_WAIVER_STATUSES,
  LIEN_WAIVER_SIGNATURE_METHODS,
  LIEN_WAIVER_FINAL_STATUSES,
  unconditionalFor,
};
