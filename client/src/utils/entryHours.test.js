import { describe, test, expect } from 'vitest';
import { entryNetHours, dstAdjustHours, offsetMinutes } from './entryHours';

// Mirrors server/tests/payDst.test.js: the client's own hour totals must agree
// with what the pay engine pays across a DST change.
const CHI = 'America/Chicago';
const fallBack = {
  start_time: '22:00:00', end_time: '06:00:00', break_minutes: 0, timezone: CHI,
  start_ts: '2026-11-01T03:00:00.000Z', end_ts: '2026-11-01T12:00:00.000Z', // 22:00 CDT → 06:00 CST
};
const springFwd = {
  start_time: '22:00:00', end_time: '06:00:00', break_minutes: 0, timezone: CHI,
  start_ts: '2026-03-08T04:00:00.000Z', end_ts: '2026-03-08T11:00:00.000Z', // 22:00 CST → 06:00 CDT
};

describe('entryNetHours', () => {
  test('offsets from Intl', () => {
    expect(offsetMinutes(Date.parse('2026-11-01T06:30:00Z'), CHI)).toBe(-300);
    expect(offsetMinutes(Date.parse('2026-11-01T07:30:00Z'), CHI)).toBe(-360);
  });
  test('fall-back = 9h, spring-forward = 7h', () => {
    expect(dstAdjustHours(fallBack)).toBe(1);
    expect(entryNetHours(fallBack)).toBe(9);
    expect(entryNetHours(springFwd)).toBe(7);
  });
  test('no timezone / no instants → plain wall-clock (8h)', () => {
    expect(entryNetHours({ ...fallBack, timezone: null })).toBe(8);
    expect(entryNetHours({ ...fallBack, start_ts: null })).toBe(8);
    expect(entryNetHours({ start_time: '22:00:00', end_time: '06:00:00', break_minutes: 30 })).toBe(7.5);
  });
  test('server paid_hours wins', () => {
    expect(entryNetHours({ ...fallBack, paid_hours: 8.75 })).toBe(8.75);
  });
  test('never negative; missing times → 0', () => {
    expect(entryNetHours({ start_time: '08:00:00', end_time: '09:00:00', break_minutes: 120 })).toBe(0);
    expect(entryNetHours({ start_time: null, end_time: null })).toBe(0);
  });
});
