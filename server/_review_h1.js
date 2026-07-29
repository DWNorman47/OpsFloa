const { computeOT } = require('./utils/payCalculations');

const R = (label, v) => console.log(label, JSON.stringify(v));

// Helper: entry
const E = (work_date, start, end, opts = {}) => ({
  work_date, start_time: start, end_time: end, wage_type: 'regular',
  break_minutes: 0, ...opts,
});

const everyDay = (hours, extra = {}) => ({
  type: 'min_daily', hours, when: { kind: 'every_day' }, ...extra,
});

console.log('=== (b) worked-day floor top-up ===');
// minD 10, threshold 8, worked 9h => 9 reg-from-band? no: band[0].afterHours=8 => reg 8, ot 1; then floor top-up minD-h = 10-9 = 1 more reg. regular = 9, ot=1, floorDetail 1 (min_daily)
{
  const otConfig = { minDailyRules: [everyDay(10)], minDailyHours: 0 };
  const r = computeOT([E('2026-07-06', '08:00', '17:00')], 'daily', 8, 1, otConfig, null);
  R('result', r);
  const sumFloor = r.floorDetail.reduce((s, f) => s + f.hours, 0);
  console.log('regularHours', r.regularHours, 'overtimeHours', r.overtimeHours, 'floorHours', r.floorHours, 'sumFloor', sumFloor);
  console.log('EXPECT regular=9 (8 band + 1 floor), ot=1, floorHours=1');
}

console.log('\n=== (b) fractional floor rounding vs autoReg ===');
// worked 7h20m (7.3333) with break; minD 8 => add = 0.66667; floorDetail hours = 0.67 (rounded); autoReg gets 0.66667
{
  const otConfig = { minDailyRules: [everyDay(8)], minDailyHours: 0 };
  const e = E('2026-07-06', '08:00', '15:20'); // 7.3333h
  const r = computeOT([e], 'daily', 8, 1, otConfig, null);
  R('result', r);
  console.log('regularHours (raw)', r.regularHours, 'floorDetail hours (rounded)', r.floorDetail[0].hours);
  console.log('raw add would be', 8 - (7 + 20/60));
}

console.log('\n=== (b) multiple minDailyRules match one day => Math.max, single push ===');
{
  const otConfig = { minDailyRules: [everyDay(10), everyDay(12), everyDay(6)], minDailyHours: 0 };
  const r = computeOT([E('2026-07-06', '08:00', '12:00')], 'daily', 8, 1, otConfig, null); // worked 4h
  R('result', r);
  console.log('floorDetail length', r.floorDetail.length, 'floorHours', r.floorHours);
  console.log('EXPECT single entry hours = 12-4 = 8, regular = 4 + 8 = 12');
}

console.log('\n=== (b) worked-day floor AND no-clock-in guarantee cannot touch same day ===');
{
  // Rule requiresClockin false, hours 8, every_day, activeWindow period.
  const rule = everyDay(8, { requiresClockin: false, activeWindow: 'period' });
  const otConfig = { minDailyRules: [rule], minDailyHours: 0 };
  // Worked Mon 4h (floored to 8), Tue-Wed empty (guaranteed 8 each) within range
  const entries = [E('2026-07-06', '08:00', '12:00')]; // Mon 4h
  const r = computeOT(entries, 'daily', 8, 1, otConfig, { from: '2026-07-06', to: '2026-07-08' });
  R('result', r);
  console.log('floorDetail', JSON.stringify(r.floorDetail, null, 0));
  console.log('EXPECT: Mon min_daily 4 (8-4), Tue guarantee 8, Wed guarantee 8. No date appears twice.');
  const dates = r.floorDetail.map(f => f.date);
  console.log('unique dates?', new Set(dates).size === dates.length);
}

console.log('\n=== (c) rule = weekly => floorDetail empty ===');
{
  const otConfig = { minDailyRules: [everyDay(10)], minDailyHours: 0 };
  const r = computeOT([E('2026-07-06', '08:00', '12:00')], 'weekly', 40, 1, otConfig, { from: '2026-07-06', to: '2026-07-12' });
  console.log('floorDetail', JSON.stringify(r.floorDetail), 'floorHours', r.floorHours);
  console.log('EXPECT empty / 0');
}

console.log('\n=== (c) rule = none => floorDetail empty ===');
{
  const otConfig = { minDailyRules: [everyDay(10)], minDailyHours: 0 };
  const r = computeOT([E('2026-07-06', '08:00', '12:00')], 'none', 8, 1, otConfig, { from: '2026-07-06', to: '2026-07-12' });
  console.log('floorDetail', JSON.stringify(r.floorDetail), 'floorHours', r.floorHours);
  console.log('EXPECT empty / 0');
}

console.log('\n=== (f) reconcile: regularHours includes floor exactly ===');
{
  const otConfig = { minDailyRules: [everyDay(10)], minDailyHours: 0 };
  const r = computeOT([E('2026-07-06', '08:00', '17:00')], 'daily', 8, 1, otConfig, null); // 9h
  // regular should be band-reg (8) + floor (1) = 9. autoReg internal.
  console.log('regularHours', r.regularHours, 'floorHours', r.floorHours);
  console.log('band regular alone (min(9,8)=8) + floor(1) = 9 -> matches', r.regularHours === 9);
}

console.log('\n=== guarantee only (no worked day at all in period, requiresClockin false, period gate needs a worked day) ===');
{
  const rule = everyDay(8, { requiresClockin: false, activeWindow: 'period' });
  const otConfig = { minDailyRules: [rule], minDailyHours: 0 };
  const r = computeOT([], 'daily', 8, 1, otConfig, { from: '2026-07-06', to: '2026-07-08' });
  console.log('no worked day, period gate -> floorDetail', JSON.stringify(r.floorDetail));
  console.log('EXPECT empty (workedAnyInPeriod false)');
}
