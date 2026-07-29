const { computeOT, annotateEntryOvertime } = require('./utils/payCalculations');
const everyDay = (hours) => ({ type: 'min_daily', hours, when: { kind: 'every_day' } });
const E = (work_date, start, end) => ({ work_date, start_time: start, end_time: end, wage_type: 'regular', break_minutes: 0 });

// minD 10 > threshold 8, worked 9h. computeOT bands worked hrs first -> 1h OT.
const otConfig = { minDailyRules: [everyDay(10)], minDailyHours: 0 };
const entries = [E('2026-07-06', '08:00', '17:00')];

const ot = computeOT(entries.map(e => ({ ...e })), 'daily', 8, 1, otConfig, null);
const ann = entries.map(e => ({ ...e }));
annotateEntryOvertime(ann, 'daily', 8, 1, otConfig);
const perEntryOtSum = ann.reduce((s, e) => s + (e.overtime_hours || 0), 0);

console.log('computeOT.overtimeHours =', ot.overtimeHours);
console.log('sum(annotateEntryOvertime per-entry OT) =', perEntryOtSum);
console.log('RECONCILE?', ot.overtimeHours === perEntryOtSum ? 'yes' : 'NO — line-item OT != summary OT');
console.log('(gross uses computeOT/otBands, so gross itself is unaffected; this is the line-item display column)');
