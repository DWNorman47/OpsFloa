import { describe, test, expect } from 'vitest';
import { dateOnlyStr, fmtHours, formatDateOnly, localDateStr, formatCurrency, currencySymbol, formatInTz } from './utils';

describe('date-only values', () => {
  test('strips the time from a serialized database DATE', () => {
    expect(dateOnlyStr('2026-07-30T00:00:00.000Z')).toBe('2026-07-30');
  });

  test('formats a serialized database DATE without a timezone day shift', () => {
    expect(formatDateOnly(
      '2026-07-30T00:00:00.000Z',
      'en-US',
      { month: 'short', day: 'numeric', year: 'numeric' },
    )).toBe('Jul 30, 2026');
  });
});

describe('fmtHours', () => {
  test('whole hours', () => {
    expect(fmtHours(8)).toBe('8h');
  });

  test('minutes only (less than 1 hour)', () => {
    expect(fmtHours(0.5)).toBe('30m');
  });

  test('hours and minutes', () => {
    expect(fmtHours(1.5)).toBe('1h 30m');
  });

  test('zero', () => {
    expect(fmtHours(0)).toBe('0m');
  });

  test('null/undefined treated as 0', () => {
    expect(fmtHours(null)).toBe('0m');
    expect(fmtHours(undefined)).toBe('0m');
  });

  test('rounds fractional minutes', () => {
    expect(fmtHours(0.25)).toBe('15m');
  });

  test('large value', () => {
    expect(fmtHours(40)).toBe('40h');
  });

  test('1h 45m', () => {
    expect(fmtHours(1.75)).toBe('1h 45m');
  });
});

describe('localDateStr', () => {
  test('returns YYYY-MM-DD format', () => {
    expect(localDateStr(new Date('2025-06-15T12:00:00'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('Jan 1 formats correctly', () => {
    expect(localDateStr(new Date(2025, 0, 1))).toBe('2025-01-01');
  });

  test('Dec 31 formats correctly', () => {
    expect(localDateStr(new Date(2025, 11, 31))).toBe('2025-12-31');
  });

  test('defaults to today without argument', () => {
    expect(localDateStr()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('uses local timezone — result starts with correct year-month', () => {
    expect(localDateStr(new Date(2025, 5, 15))).toMatch(/^2025-06/);
  });
});

describe('formatCurrency', () => {
  test('USD — includes $ and comma-grouped value', () => {
    const r = formatCurrency(1234.5, 'USD');
    expect(r).toContain('1,234.50');
    expect(r).toContain('$');
  });

  test('USD — zero returns 0.00', () => {
    expect(formatCurrency(0, 'USD')).toContain('0.00');
  });

  test('USD — whole numbers get two decimals', () => {
    expect(formatCurrency(5, 'USD')).toContain('5.00');
  });

  test('USD — negative value includes 50.00', () => {
    expect(formatCurrency(-50, 'USD')).toContain('50.00');
  });

  test('EUR — contains €', () => {
    expect(formatCurrency(100, 'EUR')).toContain('€');
  });

  test('GBP — contains £', () => {
    expect(formatCurrency(100, 'GBP')).toContain('£');
  });

  test('CAD — returns non-empty string', () => {
    expect(formatCurrency(100, 'CAD').length).toBeGreaterThan(0);
  });

  test('MXN — returns non-empty string', () => {
    expect(formatCurrency(100, 'MXN').length).toBeGreaterThan(0);
  });

  test('unknown currency — does not throw', () => {
    const r = formatCurrency(10, 'XYZ');
    expect(typeof r).toBe('string');
    expect(r.length).toBeGreaterThan(0);
  });

  test('defaults to USD when no currency provided', () => {
    expect(formatCurrency(10)).toContain('$');
  });
});

describe('currencySymbol', () => {
  test('USD → $', () => {
    expect(currencySymbol('USD')).toBe('$');
  });

  test('EUR → €', () => {
    expect(currencySymbol('EUR')).toBe('€');
  });

  test('GBP → £', () => {
    expect(currencySymbol('GBP')).toBe('£');
  });

  test('CAD — returns a string', () => {
    expect(typeof currencySymbol('CAD')).toBe('string');
  });

  test('MXN — returns a string', () => {
    expect(typeof currencySymbol('MXN')).toBe('string');
  });

  test('defaults to USD symbol when no arg provided', () => {
    const s = currencySymbol();
    expect(typeof s).toBe('string');
    expect(s.length).toBeGreaterThan(0);
  });

  test('unknown code — returns string fallback', () => {
    expect(typeof currencySymbol('ZZZ')).toBe('string');
  });
});

describe('formatInTz', () => {
  test('returns non-empty string for valid timezone', () => {
    expect(formatInTz('2025-06-15T14:30:00Z', 'America/New_York').length).toBeGreaterThan(0);
  });

  test('works without timezone argument', () => {
    expect(formatInTz('2025-06-15T14:30:00Z').length).toBeGreaterThan(0);
  });

  test('invalid timezone falls back gracefully', () => {
    expect(formatInTz('2025-06-15T14:30:00Z', 'Not/ATimezone').length).toBeGreaterThan(0);
  });

  test('custom opts: date includes year', () => {
    const r = formatInTz('2025-06-15T14:30:00Z', 'UTC', { year: 'numeric', month: 'long', day: 'numeric' });
    expect(r).toContain('2025');
  });
});
