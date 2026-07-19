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
});
