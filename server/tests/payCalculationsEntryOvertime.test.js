/**
 * annotateEntryOvertime — per-entry OT allocation for report line items.
 * The load-bearing invariant: the sum of per-entry `overtime_hours` must equal
 * computeOT(...).overtimeHours for the same inputs, so a report's line-item OT
 * column always reconciles with its summary total. Also checks the chronological
 * fill (earliest hours are regular, later hours are OT) and edge cases.
 */

const { computeOT, annotateEntryOvertime } = require('../utils/payCalculations');

function e(work_date, start_time, end_time, extra = {}) {
  return { wage_type: 'regular', break_minutes: 0, work_date, start_time, end_time, ...extra };
}
const sumOt = entries => entries.reduce((s, x) => s + (x.overtime_hours || 0), 0);

describe('annotateEntryOvertime — reconciles with computeOT.overtimeHours', () => {
  const cases = {
    'daily, single 10h day (2h OT)': [e('2026-01-05', '08:00', '18:00')],
    'daily, single 8h day (no OT)': [e('2026-01-05', '08:00', '16:00')],
    'daily, two entries same day 6h+5h (3h OT past 8)': [
      e('2026-01-05', '06:00', '12:00'), e('2026-01-05', '13:00', '18:00'),
    ],
    'daily, across days': [
      e('2026-01-05', '07:00', '17:00'), e('2026-01-06', '08:00', '14:00'), e('2026-01-07', '06:00', '20:00'),
    ],
    'weekly, 45h week (5h OT past 40)': [
      e('2026-01-05', '08:00', '17:00'), e('2026-01-06', '08:00', '17:00'), e('2026-01-07', '08:00', '17:00'),
      e('2026-01-08', '08:00', '17:00'), e('2026-01-09', '08:00', '18:00'),
    ],
    'prevailing entries are never OT': [
      e('2026-01-05', '06:00', '20:00', { wage_type: 'prevailing' }), e('2026-01-05', '06:00', '18:00'),
    ],
    'per-entry override': [
      e('2026-01-05', '08:00', '13:00', { overtime_hours_override: 2 }), e('2026-01-06', '08:00', '18:00'),
    ],
  };

  for (const [name, mk] of Object.entries(cases)) {
    test(`${name} (daily)`, () => {
      const entries = mk.map(x => ({ ...x }));
      annotateEntryOvertime(entries, 'daily', 8, 1);
      const { overtimeHours } = computeOT(mk.map(x => ({ ...x })), 'daily', 8, 1);
      expect(sumOt(entries)).toBeCloseTo(overtimeHours, 6);
    });
    test(`${name} (weekly)`, () => {
      const entries = mk.map(x => ({ ...x }));
      annotateEntryOvertime(entries, 'weekly', 40, 1);
      const { overtimeHours } = computeOT(mk.map(x => ({ ...x })), 'weekly', 40, 1);
      expect(sumOt(entries)).toBeCloseTo(overtimeHours, 6);
    });
  }
});

describe('annotateEntryOvertime — allocation details', () => {
  test('chronological fill: first entry fills regular, later entry carries the OT', () => {
    const entries = [e('2026-01-05', '06:00', '12:00'), e('2026-01-05', '13:00', '18:00')]; // 6h then 5h = 11h, 3h OT
    annotateEntryOvertime(entries, 'daily', 8, 1);
    expect(entries[0].overtime_hours).toBeCloseTo(0);  // first 6h all regular
    expect(entries[1].overtime_hours).toBeCloseTo(3);  // 2h regular + 3h OT
  });

  test('prevailing entry gets 0 even when long', () => {
    const entries = [e('2026-01-05', '06:00', '20:00', { wage_type: 'prevailing' })];
    annotateEntryOvertime(entries, 'daily', 8, 1);
    expect(entries[0].overtime_hours).toBe(0);
  });

  test("rule 'none' → no OT on any entry", () => {
    const entries = [e('2026-01-05', '06:00', '20:00')];
    annotateEntryOvertime(entries, 'none', 8, 1);
    expect(entries[0].overtime_hours).toBe(0);
  });

  test('override is clamped to the entry total and taken as the OT portion', () => {
    const entries = [e('2026-01-05', '08:00', '13:00', { overtime_hours_override: 99 })]; // 5h total
    annotateEntryOvertime(entries, 'daily', 8, 1);
    expect(entries[0].overtime_hours).toBeCloseTo(5); // clamped to total
  });

  test('minimum-daily floor does not erase overtime already earned by worked hours', () => {
    const entries = [e('2026-01-05', '08:00', '17:00')]; // 9h worked, floor 10h, daily OT after 8h
    const cfg = { minDailyHours: 10, minDailyRules: [], tierRules: [], windowRules: [] };
    annotateEntryOvertime(entries, 'daily', 8, 1, cfg);
    const summary = computeOT([e('2026-01-05', '08:00', '17:00')], 'daily', 8, 1, cfg);
    expect(entries[0].overtime_hours).toBe(1);
    expect(sumOt(entries)).toBe(summary.overtimeHours);
  });
});

describe('annotateEntryOvertime — overtime_reason (traceability)', () => {
  test('over-threshold OT names the daily/weekly rule', () => {
    const daily = [e('2026-01-05', '08:00', '18:00')]; // 10h, 2h over daily-8
    annotateEntryOvertime(daily, 'daily', 8, 1);
    expect(daily[0].overtime_reason).toBe('daily');

    const weekly = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09']
      .map(d => e(d, '08:00', '17:00')); // 5×9 = 45h, 5h over weekly-40
    annotateEntryOvertime(weekly, 'weekly', 40, 1);
    expect(weekly.some(x => x.overtime_reason === 'weekly')).toBe(true);
  });

  test('a manual override is tagged "override", not the daily rule (the Leo Martinez case)', () => {
    // 08:00–17:00 with a 30-min break = 8.5h paid; override sets the whole shift as OT.
    const entries = [e('2026-01-05', '08:00', '17:00', { break_minutes: 30, overtime_hours_override: 8.5 })];
    annotateEntryOvertime(entries, 'daily', 8, 1);
    expect(entries[0].overtime_hours).toBeCloseTo(8.5);
    expect(entries[0].overtime_reason).toBe('override'); // NOT 'daily'
  });

  test('rest day and 7th consecutive day are tagged', () => {
    const rest = [e('2026-01-04', '08:00', '14:00')]; // 2026-01-04 is a Sunday
    annotateEntryOvertime(rest, 'daily', 8, 1, { restDay: { mult: 2, days: [0] } });
    expect(rest[0].overtime_reason).toBe('rest_day');

    const week = ['2026-01-05','2026-01-06','2026-01-07','2026-01-08','2026-01-09','2026-01-10','2026-01-11']
      .map(d => e(d, '08:00', '12:00')); // Mon–Sun, all 7 days
    annotateEntryOvertime(week, 'daily', 8, 1, { seventhDay: { enabled: true, firstHoursThreshold: 8, firstMult: 1.5, afterMult: 2 } });
    expect(week.some(x => x.overtime_reason === 'seventh_day')).toBe(true);
  });

  test('no OT → no reason', () => {
    const entries = [e('2026-01-05', '08:00', '16:00')]; // exactly 8h
    annotateEntryOvertime(entries, 'daily', 8, 1);
    expect(entries[0].overtime_reason).toBeNull();
  });
});
