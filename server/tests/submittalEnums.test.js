const {
  SUBMITTAL_STATUSES,
  SUBMITTAL_STAMPS,
  SUBMITTAL_CLOSED_STATUSES,
  SUBMITTAL_DOC_KINDS,
  SUBMITTAL_AUDIT_ACTIONS,
} = require('../constants/submittalEnums');

describe('SUBMITTAL_STATUSES', () => {
  test('matches the migration 0110 CHECK constraint', () => {
    expect([...SUBMITTAL_STATUSES].sort()).toEqual(
      ['approved', 'approved_as_noted', 'closed', 'draft',
       'pending_internal', 'rejected', 'revise_resubmit', 'sent_to_reviewer', 'void']
    );
  });
  test('is frozen', () => {
    expect(Object.isFrozen(SUBMITTAL_STATUSES)).toBe(true);
  });
});

describe('SUBMITTAL_STAMPS', () => {
  test('is the four reviewer outcomes', () => {
    expect([...SUBMITTAL_STAMPS].sort()).toEqual(
      ['approved', 'approved_as_noted', 'rejected', 'revise_resubmit']
    );
  });
  test('every stamp is also a valid status (stamp → status transition)', () => {
    for (const stamp of SUBMITTAL_STAMPS) {
      expect(SUBMITTAL_STATUSES).toContain(stamp);
    }
  });
});

describe('SUBMITTAL_CLOSED_STATUSES', () => {
  test('is a subset of SUBMITTAL_STATUSES', () => {
    for (const s of SUBMITTAL_CLOSED_STATUSES) {
      expect(SUBMITTAL_STATUSES).toContain(s);
    }
  });
  test('does NOT include revise_resubmit or rejected (those can still revise)', () => {
    expect(SUBMITTAL_CLOSED_STATUSES).not.toContain('revise_resubmit');
    expect(SUBMITTAL_CLOSED_STATUSES).not.toContain('rejected');
  });
});

describe('SUBMITTAL_DOC_KINDS', () => {
  test('matches the migration 0110 CHECK constraint', () => {
    expect([...SUBMITTAL_DOC_KINDS].sort()).toEqual(
      ['other', 'reference', 'spec', 'stamped_return', 'submission']
    );
  });
  test('includes both submission and stamped_return (the side-by-side rendering pair)', () => {
    expect(SUBMITTAL_DOC_KINDS).toContain('submission');
    expect(SUBMITTAL_DOC_KINDS).toContain('stamped_return');
  });
});

describe('SUBMITTAL_AUDIT_ACTIONS', () => {
  test('matches the migration 0110 CHECK constraint', () => {
    expect([...SUBMITTAL_AUDIT_ACTIONS].sort()).toEqual(
      ['closed', 'created', 'document_added', 'document_removed', 'revised',
       'sent_internal', 'sent_reviewer', 'stamp_received', 'voided']
    );
  });
});
