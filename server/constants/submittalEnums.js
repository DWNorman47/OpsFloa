// Single source of truth for submittal status / stamp / doc kind /
// audit action enums. Lockstep with migration 0110.

const SUBMITTAL_STATUSES = Object.freeze([
  'draft',
  'pending_internal',
  'sent_to_reviewer',
  'approved',
  'approved_as_noted',
  'revise_resubmit',
  'rejected',
  'closed',
  'void',
]);

// Stamps the reviewer can apply via POST /submittals/:id/stamp.
// Maps 1:1 to one of the terminal-ish review statuses.
const SUBMITTAL_STAMPS = Object.freeze([
  'approved',
  'approved_as_noted',
  'revise_resubmit',
  'rejected',
]);

// "Terminal" in the sense that ongoing tracking should stop until a
// revision is created. revise_resubmit and rejected still flow back
// in via a new submittal row (revision+1).
const SUBMITTAL_CLOSED_STATUSES = Object.freeze([
  'approved', 'approved_as_noted', 'closed', 'void',
]);

const SUBMITTAL_DOC_KINDS = Object.freeze([
  'submission', 'stamped_return', 'spec', 'reference', 'other',
]);

const SUBMITTAL_AUDIT_ACTIONS = Object.freeze([
  'created', 'sent_internal', 'sent_reviewer', 'stamp_received',
  'revised', 'closed', 'voided', 'document_added', 'document_removed',
]);

module.exports = {
  SUBMITTAL_STATUSES,
  SUBMITTAL_STAMPS,
  SUBMITTAL_CLOSED_STATUSES,
  SUBMITTAL_DOC_KINDS,
  SUBMITTAL_AUDIT_ACTIONS,
};
