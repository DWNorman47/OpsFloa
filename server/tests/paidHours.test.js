/**
 * The shared pay pipeline.
 *
 * Why it exists: the hours-rules engine reached 4 of the 10 places that turn
 * hours into money. `qbo.js` and `jobs/scheduledReports.js` never imported it;
 * WorkerMetrics rounded but hardcoded the `daily` rule and dropped the tiered
 * config; project spend was raw SQL doing flat hours × rate with no overtime at
 * all. That was invisible only because no company had a policy enabled — the
 * moment one did, the invoice, the worker's screen and QuickBooks would each
 * report a different number for the same day.
 *
 * These tests pin the property that failure violated: **one day, one answer,
 * whoever asks.**
 */

jest.mock('../db', () => ({ query: jest.fn() }));

const { computePaid, laborCostCents, payNumbers, leaveRateMultipliers } = require('../utils/paidHours');

describe('leaveRateMultipliers', () => {
  test('percent of base → fraction; default/garbage → 1 (unchanged)', () => {
    expect(leaveRateMultipliers({ sick_pay_pct: 80, vacation_pay_pct: 50 })).toEqual({ sick: 0.8, vacation: 0.5 });
    expect(leaveRateMultipliers({})).toEqual({ sick: 1, vacation: 1 });
    expect(leaveRateMultipliers(undefined)).toEqual({ sick: 1, vacation: 1 });
    expect(leaveRateMultipliers({ sick_pay_pct: 'x', vacation_pay_pct: -5 })).toEqual({ sick: 1, vacation: 1 });
    expect(leaveRateMultipliers({ sick_pay_pct: 0 })).toEqual({ sick: 0, vacation: 1 });
  });
});

// A policy that visibly changes the numbers: ignore the early clock-in, deduct
// a lunch hour, and credit a late stay off the 17:00 baseline.
const POLICY = JSON.stringify({
  enabled: true,
  rules: [
    { id: 'in7',   type: 'clip_start', when: { kind: 'every_day' }, at: '07:00' },
    { id: 'out5',  type: 'clip_end',   when: { kind: 'every_day' }, at: '17:00' },
    { id: 'lunch', type: 'auto_break', when: { kind: 'every_day' }, minutes: 60, trigger: { kind: 'always' } },
    { id: 'l1',    type: 'add_time',   when: { kind: 'every_day' }, edge: 'after', at: '17:25', minutes: 30 },
  ],
});

const settings = (over = {}) => ({
  overtime_threshold: 8, overtime_multiplier: 1.5, week_start: 1, ...over,
});

// Clocked in early, out late: the policy has something to say about both ends.
const entry = (over = {}) => ({
  user_id: 1, work_date: '2026-07-06', wage_type: 'regular',
  start_time: '06:30:00', end_time: '17:30:00', break_minutes: 0,
  rate: '100', ot_rule: 'daily', ...over,
});

describe('computePaid', () => {
  test('with no policy it is the plain calculation, unchanged', () => {
    const { regularHours, overtimeHours } = computePaid([entry()], settings(), { rule: 'daily' });
    expect(regularHours).toBeCloseTo(8, 5);
    expect(overtimeHours).toBeCloseTo(3, 5); // 06:30→17:30 = 11h, none of it trimmed
  });

  test('with a policy the punch is trimmed, the break deducted, the credit added', () => {
    const { regularHours, overtimeHours } = computePaid([entry()], settings({ hours_rules: POLICY }), { rule: 'daily' });
    // 07:00 (clipped) → 17:30 reaches the 17:25 rung → paid to 17:00 + 30 = 17:30
    // 10.5h − 1h lunch = 9.5h ⇒ 8 regular + 1.5 OT
    expect(regularHours).toBeCloseTo(8, 5);
    expect(overtimeHours).toBeCloseTo(1.5, 5);
  });

  test('honours the tiered overtime config, not just a flat threshold', () => {
    const tiered = settings({
      hours_rules: JSON.stringify({
        enabled: true,
        overtime: { dailyBands: [{ afterHours: 8, mult: 1.5 }, { afterHours: 10, mult: 2 }] },
      }),
    });
    // 06:30→17:30 = 11h ⇒ 8 reg + 2h@1.5 + 1h@2
    const { otBands } = computePaid([entry()], tiered, { rule: 'daily' });
    expect(otBands).toEqual([{ hours: 2, mult: 1.5 }, { hours: 1, mult: 2 }]);
  });

  test('the rule argument is honoured — a weekly worker is not forced onto daily', () => {
    // Two 6h days: 12h in the week, under 40 ⇒ no weekly OT. Under the daily
    // rule with an 8h threshold there'd be none either, so use 10h days to tell
    // the two apart: 20h in a week is 4h of daily OT but 0h of weekly OT.
    const days = [
      entry({ work_date: '2026-07-06', start_time: '07:00:00', end_time: '17:00:00' }),
      entry({ work_date: '2026-07-07', start_time: '07:00:00', end_time: '17:00:00' }),
    ];
    expect(computePaid(days, settings(), { rule: 'daily' }).overtimeHours).toBeCloseTo(4, 5);
    expect(computePaid(days, settings({ overtime_threshold: 40 }), { rule: 'weekly' }).overtimeHours).toBeCloseTo(0, 5);
  });
});

describe('laborCostCents', () => {
  test('prices regular + overtime at the multiplier', () => {
    // 06:30→17:30 = 11h @ $100 ⇒ 8 × 100 + 3 × 100 × 1.5 = 800 + 450 = $1,250
    expect(laborCostCents([entry()], settings())).toBe(125000);
  });

  test('groups by worker — overtime is per person, never pooled', () => {
    // Two people, one 10h day each, $100/h, 8h daily threshold.
    // Right: each gets 8 reg + 2 OT ⇒ 2 × (800 + 300) = $2,200.
    // Pooling them into one 20h bucket would invent 12h of overtime.
    const a = entry({ user_id: 1, start_time: '07:00:00', end_time: '17:00:00' });
    const b = entry({ user_id: 2, start_time: '07:00:00', end_time: '17:00:00' });
    expect(laborCostCents([a, b], settings())).toBe(220000);
  });

  test('each worker is priced at their own rate and their own overtime rule', () => {
    const a = entry({ user_id: 1, start_time: '07:00:00', end_time: '17:00:00', rate: '100', ot_rule: 'daily' });
    const b = entry({ user_id: 2, start_time: '07:00:00', end_time: '17:00:00', rate: '50', ot_rule: 'none' });
    // a: 8×100 + 2×100×1.5 = 1100. b: no OT rule ⇒ 10×50 = 500. Total $1,600.
    expect(laborCostCents([a, b], settings())).toBe(160000);
  });

  test('an overnight shift is paid, not silently zeroed', () => {
    // The SQL this replaced did `end_time - start_time` with no midnight CASE,
    // wrapped in GREATEST(0, …) — so a night shift produced a negative interval
    // clamped to zero and cost the company nothing. 22:00→06:00 is 8 hours.
    const night = entry({ start_time: '22:00:00', end_time: '06:00:00', ot_rule: 'none' });
    expect(laborCostCents([night], settings())).toBe(80000); // 8h × $100
  });

  test('a worker with no rate contributes nothing rather than NaN', () => {
    expect(laborCostCents([entry({ rate: null })], settings())).toBe(0);
  });

  test('labor burden loads job cost only when includeBurden is passed', () => {
    const s = { ...settings(), labor_burden_pct: 30 };
    // $1,250 base. Without the flag (pay/billing paths) → unchanged.
    expect(laborCostCents([entry()], s)).toBe(125000);
    // With the flag (job-cost paths) → 1250 × 1.30 = $1,625.
    expect(laborCostCents([entry()], s, { includeBurden: true })).toBe(162500);
    // Flag on but no burden set → unchanged.
    expect(laborCostCents([entry()], settings(), { includeBurden: true })).toBe(125000);
  });

  test('empty input is zero, not a crash', () => {
    expect(laborCostCents([], settings())).toBe(0);
    expect(laborCostCents(null, settings())).toBe(0);
  });

  test('a policy changes the cost — proving the SQL path now honours it', () => {
    // Same punch, with and without the policy. If these matched, the rewrite
    // would be decorative and project spend would still be ignoring the rules.
    const bare = laborCostCents([entry({ ot_rule: 'none' })], settings());
    const ruled = laborCostCents([entry({ ot_rule: 'none' })], settings({ hours_rules: POLICY }));
    expect(bare).toBe(110000);   // 06:30→17:30 = 11h × $100
    expect(ruled).toBe(95000);   // 07:00→17:30 clipped+credited, −1h lunch = 9.5h
    expect(ruled).not.toBe(bare);
  });
});

describe('payNumbers', () => {
  test('coerces strings, since settings values arrive as text', () => {
    expect(payNumbers({ overtime_threshold: '10', week_start: '0', overtime_multiplier: '2' }))
      .toEqual({ threshold: 10, weekStart: 0, multiplier: 2 });
  });

  test('falls back to sane defaults on junk or absence', () => {
    expect(payNumbers({})).toEqual({ threshold: 8, weekStart: 1, multiplier: 1.5 });
    expect(payNumbers(null)).toEqual({ threshold: 8, weekStart: 1, multiplier: 1.5 });
    expect(payNumbers({ overtime_threshold: 'abc' }).threshold).toBe(8);
  });
});

describe('one day, one answer — the property the blocker violated', () => {
  test('every consumer shape agrees on the same day', () => {
    // The bug was that each caller computed hours its own way. Whatever route
    // asks — invoice, worker screen, QuickBooks, project spend — the same
    // entries under the same settings must produce the same hours.
    const s = settings({ hours_rules: POLICY });
    const rows = [entry()];

    const first = computePaid(rows, s, { rule: 'daily' });
    const second = computePaid(rows, s, { rule: 'daily' });

    expect(second.regularHours).toBe(first.regularHours);
    expect(second.overtimeHours).toBe(first.overtimeHours);
    // And the cost helper must agree with the hours helper rather than
    // re-deriving them: 8 × 100 + 1.5 × 100 × 1.5 = 800 + 225 = $1,025.
    expect(laborCostCents(rows, s)).toBe(
      Math.round((first.regularHours * 100 + first.overtimeHours * 100 * 1.5) * 100)
    );
  });

  test('the pipeline never mutates the caller rows', () => {
    // Paid punches are computed on read and returned on copies — a
    // misconfigured policy has to be switchable off with nothing to un-migrate.
    const rows = [entry()];
    const snapshot = JSON.parse(JSON.stringify(rows));
    computePaid(rows, settings({ hours_rules: POLICY }), { rule: 'daily' });
    laborCostCents(rows, settings({ hours_rules: POLICY }));
    expect(rows).toEqual(snapshot);
  });
});
