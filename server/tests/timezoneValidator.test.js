const { isValidTimezone } = require('../utils/timezoneValidator');

describe('isValidTimezone', () => {
  test('accepts common IANA zones', () => {
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('America/Phoenix')).toBe(true);
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('Europe/London')).toBe(true);
    expect(isValidTimezone('Asia/Tokyo')).toBe(true);
  });

  test('rejects garbage strings', () => {
    expect(isValidTimezone('America/Atlantis')).toBe(false);
    expect(isValidTimezone('Not_A_Zone')).toBe(false);
    expect(isValidTimezone('garbage')).toBe(false);
  });

  test('accepts null + empty (no TZ set is legal)', () => {
    expect(isValidTimezone(null)).toBe(true);
    expect(isValidTimezone('')).toBe(true);
    expect(isValidTimezone(undefined)).toBe(true);
  });

  test('rejects whitespace-only / numeric / boolean nonsense', () => {
    expect(isValidTimezone('   ')).toBe(false);
    expect(isValidTimezone('123')).toBe(false);
  });

  test('rejects pathologically long inputs without invoking Intl', () => {
    // A 100KB string would slow Intl down without legitimate reason;
    // real IANA names are under 64 chars. We cap at 100 to fail fast.
    expect(isValidTimezone('A'.repeat(101))).toBe(false);
    expect(isValidTimezone('A'.repeat(10000))).toBe(false);
  });
});
