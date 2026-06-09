const {
  APPOINTMENT_STATUSES,
  APPOINTMENT_BLOCKING_STATUSES,
  APPOINTMENT_LOCATION_KINDS,
  APPOINTMENT_CANCEL_ACTORS,
  APPOINTMENT_AUDIT_ACTIONS,
  APPOINTMENT_AUDIT_ACTOR_KINDS,
  slugify,
  rangesOverlap,
} = require('../constants/bookingEnums');

describe('APPOINTMENT_STATUSES', () => {
  test('matches the migration 0113 CHECK constraint', () => {
    expect([...APPOINTMENT_STATUSES].sort()).toEqual(
      ['booked', 'cancelled', 'completed', 'confirmed', 'no_show', 'rescheduled']
    );
  });
  test('is frozen', () => {
    expect(Object.isFrozen(APPOINTMENT_STATUSES)).toBe(true);
  });
});

describe('APPOINTMENT_BLOCKING_STATUSES', () => {
  test('contains booked + confirmed only (the slot-occupying states)', () => {
    expect([...APPOINTMENT_BLOCKING_STATUSES].sort()).toEqual(['booked', 'confirmed']);
  });
  test('every value is a valid appointment status', () => {
    for (const s of APPOINTMENT_BLOCKING_STATUSES) {
      expect(APPOINTMENT_STATUSES).toContain(s);
    }
  });
  test('explicitly excludes cancelled / no_show / rescheduled', () => {
    expect(APPOINTMENT_BLOCKING_STATUSES).not.toContain('cancelled');
    expect(APPOINTMENT_BLOCKING_STATUSES).not.toContain('no_show');
    expect(APPOINTMENT_BLOCKING_STATUSES).not.toContain('rescheduled');
  });
});

describe('APPOINTMENT_LOCATION_KINDS', () => {
  test('matches the migration 0113 CHECK constraint', () => {
    expect([...APPOINTMENT_LOCATION_KINDS].sort()).toEqual(
      ['office', 'onsite', 'other', 'phone', 'video']
    );
  });
});

describe('APPOINTMENT_CANCEL_ACTORS', () => {
  test('matches the migration 0113 CHECK constraint', () => {
    expect([...APPOINTMENT_CANCEL_ACTORS].sort()).toEqual(['admin', 'assignee', 'client']);
  });
});

describe('APPOINTMENT_AUDIT_ACTIONS', () => {
  test('matches the migration 0113 CHECK constraint', () => {
    expect([...APPOINTMENT_AUDIT_ACTIONS].sort()).toEqual(
      ['booked', 'cancelled', 'completed', 'confirmed', 'no_show', 'rescheduled']
    );
  });
});

describe('APPOINTMENT_AUDIT_ACTOR_KINDS', () => {
  test('matches the migration 0113 CHECK constraint and adds system', () => {
    expect([...APPOINTMENT_AUDIT_ACTOR_KINDS].sort()).toEqual(
      ['admin', 'assignee', 'client', 'system']
    );
  });
});

describe('slugify', () => {
  test('converts a sentence to a URL-safe slug', () => {
    expect(slugify('Site Visit (1 hour)')).toBe('site-visit-1-hour');
  });
  test('lowercases and strips leading/trailing dashes', () => {
    expect(slugify('  PHONE Consult  ')).toBe('phone-consult');
  });
  test('collapses runs of non-alphanumeric characters', () => {
    expect(slugify('A — B === C')).toBe('a-b-c');
  });
  test('handles empty / null / undefined input', () => {
    expect(slugify('')).toBe('');
    expect(slugify(null)).toBe('');
    expect(slugify(undefined)).toBe('');
  });
  test('caps length at 60 characters', () => {
    const longName = 'x'.repeat(120);
    expect(slugify(longName).length).toBe(60);
  });
});

describe('rangesOverlap', () => {
  test('two ranges that touch at endpoints do NOT overlap (inclusive-start, exclusive-end)', () => {
    expect(rangesOverlap(0, 100, 100, 200)).toBe(false);
    expect(rangesOverlap(100, 200, 0, 100)).toBe(false);
  });
  test('two ranges that share even one ms in the middle DO overlap', () => {
    expect(rangesOverlap(0, 100, 99, 200)).toBe(true);
    expect(rangesOverlap(99, 200, 0, 100)).toBe(true);
  });
  test('one range entirely contains the other → overlap', () => {
    expect(rangesOverlap(0, 200, 50, 150)).toBe(true);
    expect(rangesOverlap(50, 150, 0, 200)).toBe(true);
  });
  test('completely disjoint ranges → no overlap', () => {
    expect(rangesOverlap(0, 100, 200, 300)).toBe(false);
    expect(rangesOverlap(200, 300, 0, 100)).toBe(false);
  });
  test('accepts Date objects on either side', () => {
    const t0 = new Date('2026-06-01T09:00:00Z');
    const t1 = new Date('2026-06-01T10:00:00Z');
    const t2 = new Date('2026-06-01T09:30:00Z');
    const t3 = new Date('2026-06-01T10:30:00Z');
    expect(rangesOverlap(t0, t1, t2, t3)).toBe(true);
  });
});
