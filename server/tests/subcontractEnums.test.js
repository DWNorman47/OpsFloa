const {
  SUBCONTRACTOR_DOC_TYPES,
  SUBCONTRACT_PO_STATUSES,
  SUBCONTRACT_PO_OPEN_STATUSES,
  nextStatusAfterPayment,
} = require('../constants/subcontractEnums');

describe('SUBCONTRACTOR_DOC_TYPES', () => {
  test('matches the migration 0107 CHECK constraint', () => {
    expect([...SUBCONTRACTOR_DOC_TYPES].sort())
      .toEqual(['coi', 'contract', 'license', 'other', 'w9']);
  });
  test('is frozen', () => {
    expect(Object.isFrozen(SUBCONTRACTOR_DOC_TYPES)).toBe(true);
  });
});

describe('SUBCONTRACT_PO_STATUSES', () => {
  test('matches the migration 0107 CHECK constraint', () => {
    expect([...SUBCONTRACT_PO_STATUSES].sort())
      .toEqual(['cancelled', 'complete', 'draft', 'issued', 'partial']);
  });
});

describe('SUBCONTRACT_PO_OPEN_STATUSES (drives the committed bucket)', () => {
  test('contains exactly issued and partial', () => {
    expect([...SUBCONTRACT_PO_OPEN_STATUSES].sort()).toEqual(['issued', 'partial']);
  });
  test('every value is a valid PO status', () => {
    for (const s of SUBCONTRACT_PO_OPEN_STATUSES) {
      expect(SUBCONTRACT_PO_STATUSES).toContain(s);
    }
  });
});

describe('nextStatusAfterPayment', () => {
  test('issued + first payment less than total → partial', () => {
    expect(nextStatusAfterPayment({
      currentStatus: 'issued',
      paidCentsAfter: 5000,
      amountCents: 10000,
    })).toBe('partial');
  });

  test('issued + first payment covers full amount → complete', () => {
    expect(nextStatusAfterPayment({
      currentStatus: 'issued',
      paidCentsAfter: 10000,
      amountCents: 10000,
    })).toBe('complete');
  });

  test('partial + later payment that closes out → complete', () => {
    expect(nextStatusAfterPayment({
      currentStatus: 'partial',
      paidCentsAfter: 10000,
      amountCents: 10000,
    })).toBe('complete');
  });

  test('partial + small payment that still leaves balance → still partial', () => {
    expect(nextStatusAfterPayment({
      currentStatus: 'partial',
      paidCentsAfter: 6000,
      amountCents: 10000,
    })).toBe('partial');
  });

  test('cancelled never auto-transitions even with payments', () => {
    expect(nextStatusAfterPayment({
      currentStatus: 'cancelled',
      paidCentsAfter: 10000,
      amountCents: 10000,
    })).toBe('cancelled');
  });

  test('complete stays complete (deletions handled separately)', () => {
    expect(nextStatusAfterPayment({
      currentStatus: 'complete',
      paidCentsAfter: 10000,
      amountCents: 10000,
    })).toBe('complete');
  });

  test('issued + zero-cent payment stays issued (no-op)', () => {
    expect(nextStatusAfterPayment({
      currentStatus: 'issued',
      paidCentsAfter: 0,
      amountCents: 10000,
    })).toBe('issued');
  });

  test('paidCentsAfter overshoots amount → complete (edge case for partial refund / amount edit)', () => {
    expect(nextStatusAfterPayment({
      currentStatus: 'partial',
      paidCentsAfter: 15000,
      amountCents: 10000,
    })).toBe('complete');
  });
});
