/**
 * Tests for the M3 premiums: rest-day multiplier, minimum-daily-hours floor,
 * and the night-shift differential. Rest-day and min-daily reclassify hours
 * inside computeOT (so they flow through otBands); night differential is an
 * additive cost premium.
 */

const { computeOT, nightHoursForEntry, nightPremiumCost } = require('../utils/payCalculations');

function entry(date, start, end, over = {}) {
  return { wage_type: 'regular', work_date: date, start_time: start, end_time: end, break_minutes: 0, ...over };
}
// Whole-hour helper: `hDay(date, hours)` → a 00:00-based entry of `hours` length.
function hDay(date, hours) {
  return entry(date, '00:00:00', `${String(hours).padStart(2, '0')}:00:00`);
}

const MON = '2026-07-06';
const SUN = '2026-07-05';

describe('rest-day premium', () => {
  const cfg = { restDay: { mult: 2, days: [0] } }; // Sunday is the rest day

  test('all hours on a rest day are paid at the premium, no regular', () => {
    const r = computeOT([hDay(SUN, 6)], 'daily', 8, 1, cfg);
    expect(r.regularHours).toBeCloseTo(0, 5);
    expect(r.overtimeHours).toBeCloseTo(6, 5);
    expect(r.otBands).toEqual([{ hours: 6, mult: 2 }]);
  });

  test('a normal weekday is unaffected', () => {
    const r = computeOT([hDay(MON, 8), hDay(SUN, 5)], 'daily', 8, 1, cfg);
    expect(r.regularHours).toBeCloseTo(8, 5);       // Monday
    expect(r.otBands).toEqual([{ hours: 5, mult: 2 }]); // Sunday
  });

  test('does not apply under the weekly rule', () => {
    const r = computeOT([hDay(SUN, 6)], 'weekly', 40, 1, cfg);
    expect(r.overtimeHours).toBeCloseTo(0, 5);
    expect(r.regularHours).toBeCloseTo(6, 5);
  });
});

describe('minimum daily hours (reporting-time floor)', () => {
  test('a short day is topped up to the floor as regular', () => {
    const r = computeOT([hDay(MON, 2)], 'daily', 8, 1, { minDailyHours: 4 });
    expect(r.regularHours).toBeCloseTo(4, 5);
    expect(r.overtimeHours).toBeCloseTo(0, 5);
  });
  test('a day at or above the floor is unaffected', () => {
    const r = computeOT([hDay(MON, 6)], 'daily', 8, 1, { minDailyHours: 4 });
    expect(r.regularHours).toBeCloseTo(6, 5);
  });
  test('the floor does not suppress overtime on a long day', () => {
    const r = computeOT([hDay(MON, 10)], 'daily', 8, 1, { minDailyHours: 4 });
    expect(r.regularHours).toBeCloseTo(8, 5);
    expect(r.overtimeHours).toBeCloseTo(2, 5);
  });

  test('a floor ABOVE the OT threshold still preserves worked overtime', () => {
    // minDaily 10 > threshold 8; worked 9 → 8 reg + 1 OT (worked), then topped up
    // 1h to the floor as regular = 9 reg / 1 OT. The old code paid 10 reg / 0 OT.
    const r = computeOT([hDay(MON, 9)], 'daily', 8, 1, { minDailyHours: 10 });
    expect(r.regularHours).toBeCloseTo(9, 5);
    expect(r.overtimeHours).toBeCloseTo(1, 5);
  });
});

describe('break longer than the shift', () => {
  test('a break exceeding the shift clamps the day to 0, not negative', () => {
    // 1h shift, 2h break → duration would be −1h; must not subtract from pay.
    const r = computeOT([entry(MON, '08:00:00', '09:00:00', { break_minutes: 120 })], 'daily', 8, 1, {});
    expect(r.regularHours).toBeCloseTo(0, 5);
    expect(r.overtimeHours).toBeCloseTo(0, 5);
  });
});

describe('work_date as a pg Date, not a string', () => {
  // A DATE column comes back from node-postgres as a JS Date at local midnight,
  // never a 'YYYY-MM-DD' string. Every date-scoped rule (rest day, OT tiers,
  // min-daily) keys off the weekday, so it must read a Date exactly like the
  // string form — String(aDate).substring(0,10) yields "Sun Jul 05", which the
  // weekday parse rejects, silently no-op'ing the rule on every pay surface.
  const dSun = new Date(2026, 6, 5); // Sun Jul 5 2026, local midnight
  const dMon = new Date(2026, 6, 6); // Mon Jul 6 2026
  const hDayD = (d, hours) => entry(d, '00:00:00', `${String(hours).padStart(2, '0')}:00:00`);

  test('rest-day premium fires for a Date work_date', () => {
    const r = computeOT([hDayD(dSun, 6)], 'daily', 8, 1, { restDay: { mult: 2, days: [0] } });
    expect(r.regularHours).toBeCloseTo(0, 5);
    expect(r.overtimeHours).toBeCloseTo(6, 5);
    expect(r.otBands).toEqual([{ hours: 6, mult: 2 }]);
  });

  test('a Date weekday is not treated as the Sunday rest day', () => {
    const r = computeOT([hDayD(dMon, 8)], 'daily', 8, 1, { restDay: { mult: 2, days: [0] } });
    expect(r.regularHours).toBeCloseTo(8, 5);
    expect(r.overtimeHours).toBeCloseTo(0, 5);
  });
});

describe('night-shift differential', () => {
  test('overnight shift overlaps the 19:00–05:00 window', () => {
    // 22:00–06:00 → night portion 22:00–05:00 = 7h.
    expect(nightHoursForEntry(entry(MON, '22:00:00', '06:00:00'), 19, 5)).toBeCloseTo(7, 5);
  });
  test('a daytime shift has no night hours', () => {
    expect(nightHoursForEntry(entry(MON, '08:00:00', '16:00:00'), 19, 5)).toBeCloseTo(0, 5);
  });
  test('an early-morning window (01:00–05:00) that does not wrap', () => {
    // 03:00–09:00 → night portion 03:00–05:00 = 2h.
    expect(nightHoursForEntry(entry(MON, '03:00:00', '09:00:00'), 1, 5)).toBeCloseTo(2, 5);
  });
  test('nightPremiumCost = night hours × rate × pct', () => {
    const entries = [entry(MON, '22:00:00', '06:00:00')]; // 7 night hours
    expect(nightPremiumCost(entries, { fromHour: 19, toHour: 5, pct: 25 }, 10)).toBeCloseTo(7 * 10 * 0.25, 5);
  });
  test('no config → zero premium', () => {
    expect(nightPremiumCost([entry(MON, '22:00:00', '06:00:00')], null, 10)).toBe(0);
  });
  test('prevailing hours get NO baseRate night premium (wrong rate)', () => {
    // Prevailing hours are priced at the prevailing rate elsewhere; a baseRate
    // night premium must not be layered on them.
    const prevailing = [entry(MON, '22:00:00', '06:00:00', { wage_type: 'prevailing' })];
    expect(nightPremiumCost(prevailing, { fromHour: 19, toHour: 5, pct: 25 }, 10)).toBe(0);
    // A regular entry in the same window still gets it.
    const regular = [entry(MON, '22:00:00', '06:00:00')];
    expect(nightPremiumCost(regular, { fromHour: 19, toHour: 5, pct: 25 }, 10)).toBeCloseTo(7 * 10 * 0.25, 5);
  });
});
