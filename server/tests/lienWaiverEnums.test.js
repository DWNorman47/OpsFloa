const {
  LIEN_WAIVER_DIRECTIONS,
  LIEN_WAIVER_TYPES,
  LIEN_WAIVER_STATUSES,
  LIEN_WAIVER_SIGNATURE_METHODS,
  LIEN_WAIVER_FINAL_STATUSES,
  unconditionalFor,
} = require('../constants/lienWaiverEnums');

describe('Lien waiver enum lists', () => {
  test('directions match migration 0112', () => {
    expect([...LIEN_WAIVER_DIRECTIONS].sort()).toEqual(['from_sub', 'from_us']);
  });
  test('types match migration 0112', () => {
    expect([...LIEN_WAIVER_TYPES].sort()).toEqual([
      'conditional_final', 'conditional_progress',
      'unconditional_final', 'unconditional_progress',
    ]);
  });
  test('statuses match migration 0112', () => {
    expect([...LIEN_WAIVER_STATUSES].sort()).toEqual([
      'draft', 'received', 'sent', 'signed', 'superseded', 'void',
    ]);
  });
  test('signature methods match migration 0112', () => {
    expect([...LIEN_WAIVER_SIGNATURE_METHODS].sort()).toEqual([
      'docusign', 'drawn', 'typed', 'wet_signed_upload',
    ]);
  });
});

describe('LIEN_WAIVER_FINAL_STATUSES', () => {
  test('contains only signed and received (the in-hand statuses)', () => {
    expect([...LIEN_WAIVER_FINAL_STATUSES].sort()).toEqual(['received', 'signed']);
  });
});

describe('unconditionalFor', () => {
  test('conditional_progress → unconditional_progress', () => {
    expect(unconditionalFor('conditional_progress')).toBe('unconditional_progress');
  });
  test('conditional_final → unconditional_final', () => {
    expect(unconditionalFor('conditional_final')).toBe('unconditional_final');
  });
  test('unconditional types return null (already there)', () => {
    expect(unconditionalFor('unconditional_progress')).toBeNull();
    expect(unconditionalFor('unconditional_final')).toBeNull();
  });
  test('unknown type returns null', () => {
    expect(unconditionalFor('garbage')).toBeNull();
  });
});
