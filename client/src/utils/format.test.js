import { describe, test, expect } from 'vitest';
import { formatMoney, parseDollars, centsToDollarsField, formatDate, formatDateTime, formatTime } from './format';

describe('formatMoney', () => {
  test('renders whole-dollar by default (no cents noise on big numbers)', () => {
    expect(formatMoney(2850000)).toBe('$28,500');
  });
  test('renders cents when showCents=true (line-item displays)', () => {
    expect(formatMoney(1500, { showCents: true })).toBe('$15.00');
    expect(formatMoney(1533, { showCents: true })).toBe('$15.33');
  });
  test('handles null / undefined / NaN as $0', () => {
    expect(formatMoney(null)).toBe('$0');
    expect(formatMoney(undefined)).toBe('$0');
    expect(formatMoney('not-a-number')).toBe('$0');
  });
  test('handles string-typed cents (PG bigint comes back stringified)', () => {
    expect(formatMoney('250000')).toBe('$2,500');
  });
});

describe('parseDollars', () => {
  test('parses plain numbers', () => {
    expect(parseDollars('15')).toBe(1500);
    expect(parseDollars('15.5')).toBe(1550);
    expect(parseDollars('15.55')).toBe(1555);
  });
  test('parses with currency symbol and commas', () => {
    expect(parseDollars('$15.50')).toBe(1550);
    expect(parseDollars('$1,500.00')).toBe(150000);
    expect(parseDollars('  $15.50  ')).toBe(1550);
  });
  test('returns null on garbage', () => {
    expect(parseDollars('abc')).toBeNull();
    expect(parseDollars('15.5.5')).toBeNull();
    expect(parseDollars(null)).toBeNull();
    expect(parseDollars('')).toBeNull();
  });
  test('rounds half-cent inputs to nearest cent', () => {
    expect(parseDollars('15.501')).toBeNull(); // 3 decimals rejected
    // Only 0-2 decimals accepted
  });
});

describe('centsToDollarsField', () => {
  test('renders cents as dollar string for editing', () => {
    expect(centsToDollarsField(1500)).toBe('15.00');
    expect(centsToDollarsField(1599)).toBe('15.99');
    expect(centsToDollarsField(100000)).toBe('1000.00');
  });
  test('renders empty string for zero / nullish (so input is blank for placeholder)', () => {
    expect(centsToDollarsField(0)).toBe('');
    expect(centsToDollarsField(null)).toBe('');
    expect(centsToDollarsField(undefined)).toBe('');
    expect(centsToDollarsField('')).toBe('');
  });
  test('handles string-typed cents', () => {
    expect(centsToDollarsField('1500')).toBe('15.00');
  });
});

describe('formatDate', () => {
  test('renders ISO timestamp as short date', () => {
    // Date depends on machine TZ; this just sanity-checks shape, not exact text
    const result = formatDate('2026-06-15T14:30:00Z');
    expect(result).toMatch(/2026/);
    expect(result).toMatch(/Jun/);
  });
  test('returns empty string on falsy input', () => {
    expect(formatDate('')).toBe('');
    expect(formatDate(null)).toBe('');
    expect(formatDate(undefined)).toBe('');
  });
  test('returns empty on un-parseable string (not "Invalid Date")', () => {
    expect(formatDate('not-a-date')).toBe('');
  });
});

describe('formatDateTime', () => {
  test('includes time component', () => {
    const result = formatDateTime('2026-06-15T14:30:00Z');
    expect(result).toMatch(/2026/);
    expect(result).toMatch(/[AP]M|:\d{2}/);  // has AM/PM or HH:MM
  });
  test('empty on falsy input', () => {
    expect(formatDateTime(null)).toBe('');
  });
});

describe('formatTime', () => {
  test('renders just the time portion', () => {
    const result = formatTime('2026-06-15T14:30:00Z');
    expect(result).not.toMatch(/2026/);
    expect(result).toMatch(/[AP]M|:\d{2}/);
  });
});
