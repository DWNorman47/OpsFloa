const { buildPayStatement } = require('./utils/payStatement');

const everyDay = (hours, extra = {}) => ({ type: 'min_daily', hours, when: { kind: 'every_day' }, ...extra });
const E = (work_date, start, end, opts = {}) => ({
  id: `e-${work_date}-${start}`, work_date, start_time: start, end_time: end,
  wage_type: 'regular', break_minutes: 0, project_id: null, mileage: 0, ...opts,
});

const settings = {
  overtime_threshold: 8, overtime_multiplier: 1.5, week_start: 1,
  prevailing_wage_rate: 45, default_hourly_rate: 0, regular_shift_hours: 8,
  sick_pay_pct: 100, vacation_pay_pct: 100, overtime_rate_method: 'rate_when_worked',
};
const worker = { id: 1, hourly_rate: 20, overtime_rule: 'daily', guaranteed_weekly_hours: 40, role_id: null };

// Rule: min_daily 10, requiresClockin false (also grants empty days), period gate.
const otConfig = { minDailyRules: [everyDay(10, { requiresClockin: false, activeWindow: 'period' })], minDailyHours: 0 };

// Mon worked 9h (floor top-up 1), Tue+Wed empty (guaranteed 10 each). sick 4h.
const entries = [E('2026-07-06', '08:00', '17:00')]; // Mon 9h
const leave = { sick: 4, vacation: 0 };

const st = buildPayStatement({
  worker, entries, reimbursements: [], leave, deductions: [],
  otConfig, projectRateMap: {}, settings, from: '2026-07-06', to: '2026-07-08', explain: true,
});

console.log('=== HOURS ===');
console.log(JSON.stringify(st.hours, null, 0));
console.log('=== COST ===');
console.log(JSON.stringify(st.cost, null, 0));
console.log('=== TOTALS ===');
console.log(JSON.stringify(st.totals, null, 0));

console.log('\n=== (a) gross reconciles to cost lines; entries NOT summed into gross ===');
const c = st.cost;
const sumCostLines = c.regular + c.overtime + c.prevailing + c.night + c.sick + c.vacation + c.guarantee;
console.log('sum of cost lines', sumCostLines, 'grossWages', st.totals.grossWages, 'match?', Math.abs(sumCostLines - st.totals.grossWages) < 1e-9);

// Simulate "synthetic entries NOT emitted": recompute a gross by summing ONLY real
// entry-derived costs would be wrong; the point is gross is independent of entries.
// Prove: sum of the synthetic rows' own `cost` fields (guarantee+sick+vac) already
// equals the matching cost lines -> they mirror, not add.
const synth = st.entries.filter(e => e.synthetic);
const synthWithCost = synth.filter(e => e.cost != null);
const synthCostSum = synthWithCost.reduce((s, e) => s + e.cost, 0);
console.log('synthetic rows w/cost:', synthWithCost.map(e => ({ kind: e.kind, hours: e.hours, cost: e.cost })));
console.log('their cost sum', synthCostSum, '= guarantee+sick+vac cost lines', c.guarantee + c.sick + c.vacation, 'match?', Math.abs(synthCostSum - (c.guarantee + c.sick + c.vacation)) < 1e-9);

console.log('\n=== (a) floor rows are INSIDE hours.regular (no cost, not added to gross) ===');
const floorRows = synth.filter(e => e.kind === 'min_daily' || e.kind === 'guarantee');
console.log('floor rows:', floorRows.map(e => ({ kind: e.kind, date: e.work_date, hours: e.hours, cost: e.cost })));
const workedRegularPortion = 8; // Mon 9h -> band reg 8 (1h is OT)
const floorHoursSum = floorRows.reduce((s, e) => s + e.hours, 0);
console.log('worked reg (8) + floor rows (', floorHoursSum, ') =', 8 + floorHoursSum, ' vs hours.regular', st.hours.regular);
console.log('floor rows carry cost?', floorRows.every(e => e.cost == null) ? 'NO (correct)' : 'YES (BUG)');

console.log('\n=== (d) weekly guarantee fed totalHours incl. daily-guarantee hours ===');
console.log('hours.total', st.hours.total, '(= regular+ot+prevailing)');
console.log('guaranteeMin', st.hours.guaranteeMin, 'guaranteeShortfall', st.hours.guaranteeShortfall);
console.log('EXPECT: shortfall = max(0, 40 - (total 30 + sick 4 + vac 0)) = 6');

console.log('\n=== (e) sort order of outEntries ===');
console.log(st.entries.map(e => ({ date: String(e.work_date), start: e.start_time, kind: e.kind || (e.synthetic ? 'synth' : 'real') })));

console.log('\n=== control: SAME inputs but leave=0, guarantee removed -> gross still = cost lines ===');
const st2 = buildPayStatement({
  worker: { ...worker, guaranteed_weekly_hours: 0 }, entries, reimbursements: [], leave: { sick: 0, vacation: 0 },
  deductions: [], otConfig, projectRateMap: {}, settings, from: '2026-07-06', to: '2026-07-08', explain: false,
});
const c2 = st2.cost;
console.log('st2 hours.regular', st2.hours.regular, 'gross', st2.totals.grossWages, 'sumlines', c2.regular + c2.overtime + c2.prevailing + c2.night + c2.sick + c2.vacation + c2.guarantee);
console.log('st2 synthetic floor rows still present (display) but no guarantee/leave rows:', st2.entries.filter(e => e.synthetic).map(e => e.kind));
