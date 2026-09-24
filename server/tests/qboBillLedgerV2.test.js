/**
 * QuickBooks contractor bills — ledger v2 (migration 0214). Each test pins the
 * dollar figure the 0211 code got wrong (adapted from the 2026-09-24 review's
 * scratch proofs):
 *
 *  1. Cutover: the 0211 range-pay ledger started EMPTY, so re-pushing a range
 *     billed before it existed billed its leave / guarantee / floors a second
 *     time ($320 instead of $160). Now range pay on days in a week billed before
 *     0211 is lazily seeded as a 'baseline' (already billed at the amount computed
 *     then); leave on a week that was never billed still bills.
 *  2. A failed DB write after createBill left the ledger unwritten and the rows
 *     unstamped → the next push billed everything again. Now every bill goes
 *     through an outbox row (qbo_bill_pushes) written before createBill; a row
 *     left pending is replayed with the SAME Intuit requestid (Intuit returns the
 *     existing bill) and finalized — never billed twice.
 *  3. A negative net skipped the whole bill (new entries + reimbursements too) and
 *     the credit was never recorded. Now the positive items bill, the negative
 *     adjustment is held as a carried-forward credit, and an admin can mark a
 *     manual vendor credit as recorded.
 *  4. Owner decision: after a backdated raise the NEXT bill charges the difference
 *     for already-billed days — worked hours (ledgered per day, kind 'worked') and
 *     range pay alike.
 *  5. The weekly guarantee comes from the engine's per-week numbers (stub == bill).
 *  6. Leave is cents-rounded like the stub (one rounding over the range, not per day).
 *  7. A daily-rate day shared with a later project is re-split by hours.
 */

const mockUser = { id: 1, company_id: 'company-uuid-1', full_name: 'Test Admin', role: 'admin' };
jest.mock('../middleware/auth', () => ({
  requireAuth:  (req, _res, next) => { req.user = mockUser; next(); },
  requireAdmin: (req, _res, next) => { req.user = mockUser; next(); },
  requirePerm: () => (_req, _res, next) => next(),
}));
jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../services/qbo', () => {
  const actual = jest.requireActual('../services/qbo');
  return {
    timeActivityHours: actual.timeActivityHours,
    createBill: jest.fn(), createJournalEntry: jest.fn(), pushTimeActivity: jest.fn(),
  };
});
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const qbo = require('../services/qbo');
const qboRoute = require('../routes/qbo');
const { buildPayStatement } = require('../utils/payStatement');
const { computeLeaveHours } = require('../utils/payCalculations');

function makeApp() { const app = express(); app.use(express.json()); app.use('/api/qbo', qboRoute); return app; }

const timeRow = (over = {}) => ({
  id: 100, user_id: 10, project_id: 200, work_date: '2026-09-07', start_time: '08:00:00', end_time: '16:00:00',
  notes: '', qbo_bill_id: null, qbo_activity_id: null, wage_type: 'regular', break_minutes: 0, mileage: 0, overtime_hours_override: null,
  full_name: 'Alex Rivera', qbo_vendor_id: 'V-1', hourly_rate: '20.00', rate_type: 'hourly',
  worker_type: 'contractor', overtime_rule: null, role_id: null, guaranteed_weekly_hours: 0,
  qbo_class_id: null, qbo_customer_id: 'CUST-1', project_name: 'Main St', prevailing_wage_rate: null,
  pre_ledger_bill: false, ...over,
});
const OT_OFF = [{ key: 'overtime_rule', value: 'none' }];
const clone = x => JSON.parse(JSON.stringify(x));

/**
 * A small in-memory QuickBooks + Postgres. `world` persists across pushes:
 * time rows (stamped by the route), the range-pay ledger, the bill outbox, and
 * the bills QuickBooks holds (keyed by Intuit requestid — Intuit's dedupe).
 */
function makeWorld(over = {}) {
  return {
    settings: OT_OFF, timeRows: [], leaveRequests: [], ledger: [], pushes: [], reimb: [], rateRows: [],
    qboBills: new Map(), failOn: null, ...over,
  };
}

function install(world) {
  const handle = async (sql, params = []) => {
    const s = String(sql);
    if (world.failOn && world.failOn.test(s)) throw new Error('connection reset');
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(s.trim())) return { rows: [] };
    if (/qbo_labor_item_id/.test(s)) return { rows: [
      { key: 'qbo_expense_account_id', value: 'ACCT-42' }, { key: 'qbo_labor_item_id', value: 'ITEM-LABOR' }, { key: 'qbo_bill_terms_days', value: '0' }] };
    if (/SELECT qbo_realm_id FROM companies/.test(s)) return { rows: [{ qbo_realm_id: 'realm-1' }] };
    if (/^SELECT key, value FROM settings WHERE company_id = \$1$/.test(s.trim())) return { rows: world.settings };
    if (/FROM time_entries te/.test(s) && /qbo_vendor_id/.test(s)) return { rows: clone(world.timeRows) };
    if (/FROM reimbursements r/.test(s)) return { rows: clone(world.reimb) };
    if (/FROM time_off_requests/.test(s)) return { rows: world.leaveRequests.map(r => ({ user_id: 10, hours: null, ...r })) };
    if (/FROM shifts/.test(s)) return { rows: [] };
    if (/FROM worker_rate_history/.test(s)) return { rows: world.rateRows };
    if (/UPDATE time_entries SET qbo_bill_id/.test(s)) {
      const [billId, ids] = params;
      world.timeRows.forEach(r => { if (ids.includes(r.id)) r.qbo_bill_id = billId; });
      return { rows: [], rowCount: ids.length };
    }
    if (/UPDATE reimbursements SET qbo_bill_id/.test(s)) {
      const [billId, ids] = params;
      world.reimb.forEach(r => { if (ids.includes(r.id)) r.qbo_bill_id = billId; });
      return { rows: [], rowCount: ids.length };
    }
    if (/INSERT INTO qbo_bill_range_pay/.test(s)) {
      const [, uids, kinds, dates, amounts, hours, billIds, statuses, credits] = params;
      uids.forEach((uid, i) => {
        const row = { user_id: uid, kind: kinds[i], pay_date: dates[i], amount_cents: amounts[i], hours: hours[i],
          qbo_bill_id: billIds[i], status: statuses[i], credit_cents: credits[i] };
        const hit = world.ledger.find(l => l.user_id === uid && l.kind === kinds[i] && l.pay_date === dates[i]);
        if (hit) Object.assign(hit, row, { qbo_bill_id: billIds[i] || hit.qbo_bill_id }); else world.ledger.push(row);
      });
      return { rows: [], rowCount: uids.length };
    }
    if (/UPDATE qbo_bill_range_pay/.test(s) && /credit_cents = 0/.test(s)) {
      const [, uid] = params;
      const rows = world.ledger.filter(l => l.user_id === uid && Number(l.credit_cents || 0) !== 0);
      const out = rows.map(l => ({ kind: l.kind, pay_date: l.pay_date, credit_cents: l.credit_cents }));
      rows.forEach(l => { l.amount_cents = Number(l.amount_cents) + Number(l.credit_cents); l.credit_cents = 0; });
      return { rows: out, rowCount: rows.length };
    }
    if (/FROM qbo_bill_range_pay/.test(s)) return { rows: clone(world.ledger) };
    if (/INSERT INTO qbo_bill_pushes/.test(s)) {
      const [, userId, requestId, bill, totalC, teIds, rIds, ledger] = params;
      if (!world.pushes.find(p => p.request_id === requestId)) {
        world.pushes.push({ user_id: userId, request_id: requestId, status: 'pending', bill: JSON.parse(bill), total_cents: totalC,
          time_entry_ids: teIds, reimbursement_ids: rIds, ledger: JSON.parse(ledger), qbo_bill_id: null });
      }
      return { rows: [], rowCount: 1 };
    }
    if (/^SELECT[\s\S]*FROM qbo_bill_pushes/.test(s.trim())) return { rows: clone(world.pushes.filter(p => p.status === 'pending')) };
    if (/UPDATE qbo_bill_pushes/.test(s)) {
      const [billId, , requestId] = params;
      world.pushes.filter(p => p.request_id === requestId).forEach(p => { p.status = 'posted'; p.qbo_bill_id = billId; });
      return { rows: [], rowCount: 1 };
    }
    if (/DELETE FROM qbo_bill_pushes/.test(s)) {
      const [, requestId] = params;
      world.pushes = world.pushes.filter(p => !(p.request_id === requestId && p.status === 'pending'));
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  pool.query.mockReset();
  pool.query.mockImplementation(handle);
  // A transaction: changes roll back on ROLLBACK.
  pool.connect.mockReset();
  pool.connect.mockImplementation(async () => {
    let snap = null;
    return {
      query: async (sql, params) => {
        const t = String(sql).trim();
        if (t === 'BEGIN') { snap = clone({ timeRows: world.timeRows, ledger: world.ledger, pushes: world.pushes, reimb: world.reimb }); return { rows: [] }; }
        if (t === 'ROLLBACK') { Object.assign(world, snap); return { rows: [] }; }
        return handle(sql, params);
      },
      release: () => {},
    };
  });
  // QuickBooks: a requestid it has seen returns the SAME bill (Intuit dedupe).
  qbo.createBill.mockReset();
  qbo.createBill.mockImplementation(async (_c, b) => {
    if (world.qboFail) { const e = world.qboFail; world.qboFail = null; throw e; }
    if (world.qboBills.has(b.requestId)) return world.qboBills.get(b.requestId);
    const bill = { Id: `B-${world.qboBills.size + 1}`, TotalAmt: lineTotal(b.lines) };
    world.qboBills.set(b.requestId, bill);
    return bill;
  });
  return world;
}

const lineTotal = lines => Math.round(lines.reduce((s, l) => s + (l.amount != null ? l.amount : l.qty * l.unitPrice), 0) * 100) / 100;
const push = body => request(makeApp()).post('/api/qbo/push-bills').send(body);
const lastBill = () => qbo.createBill.mock.calls[qbo.createBill.mock.calls.length - 1][1];
const billedTotal = world => [...world.qboBills.values()].reduce((s, b) => s + b.TotalAmt, 0);
const WEEK1 = { from: '2026-09-01', to: '2026-09-07' };

describe('1 — cutover: range pay billed before the ledger existed', () => {
  test('re-pushing a pre-ledger range does NOT bill its sick day again ($160, was $320)', async () => {
    const world = install(makeWorld({
      leaveRequests: [{ type: 'sick', start_date: '2026-09-03', end_date: '2026-09-03' }],
      timeRows: [
        timeRow({ id: 1, work_date: '2026-09-01', qbo_bill_id: 'B-0', pre_ledger_bill: true }),
        timeRow({ id: 2, work_date: '2026-09-02' }),
      ],
    }));
    await push(WEEK1);
    expect(lineTotal(lastBill().lines)).toBe(160);
    expect(lastBill().lines.some(l => /sick/i.test(l.description))).toBe(false);
    // Seeded as a baseline at the amount computed now — a later re-push stays stable.
    expect(world.ledger.find(l => l.kind === 'sick')).toMatchObject({ pay_date: '2026-09-03', amount_cents: 16000, status: 'baseline' });
    const again = await push(WEEK1);
    expect(again.body.pushed).toEqual([]);
  });

  test('a genuinely new leave day after cutover (a week never billed) still bills', async () => {
    install(makeWorld({
      leaveRequests: [
        { type: 'sick', start_date: '2026-09-03', end_date: '2026-09-03' }, // legacy-billed week → baseline
        { type: 'sick', start_date: '2026-09-10', end_date: '2026-09-10' }, // new week → bills
      ],
      timeRows: [
        timeRow({ id: 1, work_date: '2026-09-01', qbo_bill_id: 'B-0', pre_ledger_bill: true }),
        timeRow({ id: 2, work_date: '2026-09-09' }),
      ],
    }));
    await push({ from: '2026-08-31', to: '2026-09-13' });
    const lines = lastBill().lines;
    const sick = lines.filter(l => /sick/i.test(l.description));
    expect(sick.map(l => l.amount)).toEqual([160]);
    expect(sick[0].description).toMatch(/2026-09-10/);
    expect(lineTotal(lines)).toBe(320);
  });

  test('leave approved late in a week billed AFTER the ledger existed still bills', async () => {
    install(makeWorld({
      leaveRequests: [{ type: 'sick', start_date: '2026-09-03', end_date: '2026-09-03' }],
      timeRows: [timeRow({ id: 1, work_date: '2026-09-01', qbo_bill_id: 'B-7', pre_ledger_bill: false })],
    }));
    await push(WEEK1);
    expect(lineTotal(lastBill().lines)).toBe(160);
  });
});

describe('2 — a failure after createBill never double-bills', () => {
  const leaveRequests = [{ type: 'sick', start_date: '2026-09-03', end_date: '2026-09-03' }];

  test('ledger write fails after the bill exists → next push reconciles the same bill, bills nothing twice', async () => {
    const world = install(makeWorld({ leaveRequests, timeRows: [timeRow({ id: 1, work_date: '2026-09-01' })], failOn: /INSERT INTO qbo_bill_range_pay/ }));
    const r1 = await push(WEEK1);
    expect(r1.status).toBe(200);
    expect(billedTotal(world)).toBe(320);
    expect(r1.body.pushed).toEqual([]);
    expect(r1.body.skipped[0].reason).toMatch(/B-1.*next push/);
    expect(world.timeRows[0].qbo_bill_id).toBe(null); // rolled back with the ledger
    expect(world.pushes).toEqual([expect.objectContaining({ status: 'pending' })]);

    world.failOn = null;
    const r2 = await push(WEEK1);
    expect(r2.status).toBe(200);
    // The pending bill was replayed with its own requestid → Intuit returned B-1.
    expect(qbo.createBill.mock.calls[1][1].requestId).toBe(qbo.createBill.mock.calls[0][1].requestId);
    expect(world.qboBills.size).toBe(1);
    expect(billedTotal(world)).toBe(320); // was 480 (sick billed twice)
    expect(r2.body.reconciled).toEqual([expect.objectContaining({ user_id: 10, bill_id: 'B-1' })]);
    expect(world.timeRows[0].qbo_bill_id).toBe('B-1');
    expect(world.pushes[0].status).toBe('posted');
    expect(world.ledger.find(l => l.kind === 'sick')).toMatchObject({ amount_cents: 16000, status: 'billed' });
  });

  test('network error on createBill (outcome unknown) → pending, replayed next push; QuickBooks holds one bill', async () => {
    const world = install(makeWorld({ leaveRequests, timeRows: [timeRow({ id: 1, work_date: '2026-09-01' })] }));
    // The request reached Intuit and created the bill, but the response was lost.
    qbo.createBill.mockImplementationOnce(async (_c, b) => {
      world.qboBills.set(b.requestId, { Id: 'B-1', TotalAmt: lineTotal(b.lines) });
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    });
    const r1 = await push(WEEK1);
    expect(r1.body.skipped[0].reason).toMatch(/next push/);
    expect(world.pushes[0].status).toBe('pending');
    // A new late entry arrives before the next push — it bills on its own bill.
    world.timeRows.push(timeRow({ id: 2, work_date: '2026-09-02' }));
    const r2 = await push(WEEK1);
    expect(r2.body.reconciled).toHaveLength(1);
    expect(world.qboBills.size).toBe(2);
    expect(billedTotal(world)).toBe(320 + 160); // not 320 + 480
  });

  test('a 4xx rejection means no bill exists → the outbox row is dropped and nothing is blocked', async () => {
    const world = install(makeWorld({ timeRows: [timeRow({ id: 1, work_date: '2026-09-01' })] }));
    world.qboFail = Object.assign(new Error('Bad request'), { response: { status: 400, data: { Fault: { Error: [{ Detail: 'Vendor inactive' }] } } } });
    const r1 = await push(WEEK1);
    expect(r1.body.skipped[0].reason).toBe('Vendor inactive');
    expect(world.pushes).toEqual([]);
    const r2 = await push(WEEK1);
    expect(r2.body.pushed).toHaveLength(1);
    expect(billedTotal(world)).toBe(160);
  });
});

describe('3 — a negative net bills the positive items and holds the credit', () => {
  const setup = () => install(makeWorld({
    // Sick day billed ($160) on B-1, then revoked. A new 4h entry + a $50 reimbursement arrive.
    ledger: [
      { user_id: 10, kind: 'sick', pay_date: '2026-09-03', amount_cents: 16000, status: 'billed', credit_cents: 0 },
      { user_id: 10, kind: 'worked', pay_date: '2026-09-01', amount_cents: 16000, status: 'billed', credit_cents: 0 },
    ],
    timeRows: [
      timeRow({ id: 1, work_date: '2026-09-01', qbo_bill_id: 'B-1' }),
      timeRow({ id: 2, work_date: '2026-09-02', start_time: '08:00:00', end_time: '12:00:00' }),
    ],
    reimb: [{ id: 7, user_id: 10, project_id: 200, expense_date: '2026-09-02', amount: '50.00', description: 'fuel', category: 'fuel', qbo_bill_id: null, qbo_purchase_id: null, full_name: 'Alex Rivera', qbo_vendor_id: 'V-1' }],
  }));

  test('the $80 entry + $50 reimbursement bill; −$160 is held as a credit (was: nothing billed)', async () => {
    const world = setup();
    const res = await push(WEEK1);
    expect(res.body.pushed).toHaveLength(1);
    expect(lineTotal(lastBill().lines)).toBe(130);
    expect(res.body.credits_held).toEqual([expect.objectContaining({ user_id: 10, amount: -160 })]);
    const sick = world.ledger.find(l => l.kind === 'sick');
    expect(sick).toMatchObject({ amount_cents: 16000, credit_cents: -16000 });
  });

  test('the held credit nets against the next positive bill', async () => {
    const world = setup();
    await push(WEEK1);
    world.timeRows.push(timeRow({ id: 3, work_date: '2026-09-04', start_time: '07:00:00', end_time: '17:00:00' })); // $200
    await push(WEEK1);
    expect(lineTotal(lastBill().lines)).toBe(40); // 200 − 160
    expect(world.ledger.find(l => l.kind === 'sick')).toMatchObject({ amount_cents: 0, credit_cents: 0 });
  });

  test('an admin can mark a manual vendor credit as recorded — the ledger stops carrying it', async () => {
    const world = setup();
    await push(WEEK1);
    const list = await request(makeApp()).get('/api/qbo/bill-credits');
    expect(list.status).toBe(200);
    const rec = await request(makeApp()).post('/api/qbo/bill-credits/record').send({ user_id: 10 });
    expect(rec.status).toBe(200);
    expect(rec.body).toMatchObject({ user_id: 10, amount: -160 });
    expect(world.ledger.find(l => l.kind === 'sick')).toMatchObject({ amount_cents: 0, credit_cents: 0 });
    world.timeRows.push(timeRow({ id: 3, work_date: '2026-09-04', start_time: '07:00:00', end_time: '17:00:00' }));
    await push(WEEK1);
    expect(lineTotal(lastBill().lines)).toBe(200); // not netted a second time
  });
});

describe('4 — a backdated raise trues up already-billed days on the next bill', () => {
  const raise = [{ user_id: 10, hourly_rate: '25.00', rate_type: 'hourly', effective_date: '1900-01-01' }];

  test('Sep 1 billed at $20 → raise to $25 back to Sep 1 → next bill = +$40 for Sep 1 + $200 for Sep 2', async () => {
    const world = install(makeWorld({ timeRows: [timeRow({ id: 1, work_date: '2026-09-01' })] }));
    await push(WEEK1);
    expect(lineTotal(lastBill().lines)).toBe(160);
    world.rateRows = raise;
    world.timeRows.forEach(r => { r.hourly_rate = '25.00'; });
    world.timeRows.push(timeRow({ id: 2, work_date: '2026-09-02', hourly_rate: '25.00' }));
    await push(WEEK1);
    const lines = lastBill().lines;
    expect(lineTotal(lines)).toBe(240);
    const adj = lines.find(l => /2026-09-01/.test(l.description) && /adjustment/i.test(l.description));
    expect(adj).toMatchObject({ amount: 40, customerId: 'CUST-1' });
  });

  test('worked hours and range pay true up together (+$40 worked, +$40 sick, +$200 new day)', async () => {
    const world = install(makeWorld({
      leaveRequests: [{ type: 'sick', start_date: '2026-09-03', end_date: '2026-09-03' }],
      timeRows: [timeRow({ id: 1, work_date: '2026-09-01' })],
    }));
    await push(WEEK1);
    expect(lineTotal(lastBill().lines)).toBe(320);
    world.rateRows = raise;
    world.timeRows.forEach(r => { r.hourly_rate = '25.00'; });
    world.timeRows.push(timeRow({ id: 2, work_date: '2026-09-02', hourly_rate: '25.00' }));
    await push(WEEK1);
    expect(lineTotal(lastBill().lines)).toBe(280); // was 240 (worked day not trued up)
  });
});

describe('5/6 — the bill agrees with the stub', () => {
  test('weekly guarantee: 50h week + 30h week bills the same 10h the stub pays', async () => {
    const g = { guaranteed_weekly_hours: 40 };
    const w1 = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'];
    const w2 = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18'];
    const rows = [
      ...w1.map((d, i) => timeRow({ id: 1 + i, work_date: d, start_time: '07:00:00', end_time: '17:00:00', ...g })),
      ...w2.map((d, i) => timeRow({ id: 11 + i, work_date: d, start_time: '08:00:00', end_time: '14:00:00', ...g })),
    ];
    install(makeWorld({ timeRows: rows }));
    await push({ from: '2026-09-07', to: '2026-09-20' });
    const gl = lastBill().lines.filter(l => /guaranteed-hours/.test(l.description));
    const st = buildPayStatement({
      worker: { id: 10, hourly_rate: 20, rate_type: 'hourly', guaranteed_weekly_hours: 40 },
      entries: rows.map(r => ({ ...r })), otConfig: null, settings: { overtime_rule: 'none', week_start: 1 }, from: '2026-09-07', to: '2026-09-20',
    });
    expect(st.cost.guarantee).toBe(200); // was 0 pooled
    expect(gl.reduce((s, l) => s + l.amount, 0)).toBe(st.cost.guarantee);
  });

  test('leave cents: the bill\'s sick total equals the stub\'s (153.75, was 153.76)', async () => {
    const daily = { rate_type: 'daily', hourly_rate: '205.00' };
    const leaveRequests = [
      { type: 'sick', start_date: '2026-09-02', end_date: '2026-09-02', hours: '3' },
      { type: 'sick', start_date: '2026-09-03', end_date: '2026-09-03', hours: '3' },
    ];
    install(makeWorld({ leaveRequests, timeRows: [timeRow({ id: 1, work_date: '2026-09-01', ...daily })] }));
    await push(WEEK1);
    const sick = lastBill().lines.filter(l => /sick/i.test(l.description));
    const leave = computeLeaveHours(leaveRequests.map(r => ({ user_id: 10, ...r })), new Map(), [], 8, '2026-09-01', '2026-09-07');
    const st = buildPayStatement({
      worker: { id: 10, hourly_rate: 205, rate_type: 'daily', guaranteed_weekly_hours: 0 },
      entries: [timeRow({ id: 1, work_date: '2026-09-01', ...daily })], leave, otConfig: null,
      settings: { overtime_rule: 'none', regular_shift_hours: 8 }, from: '2026-09-01', to: '2026-09-07',
    });
    expect(st.cost.sick).toBe(153.75);
    expect(sick.reduce((s, l) => s + l.amount, 0)).toBe(153.75);
  });
});

describe('7 — a daily-rate day shared across projects is split by hours', () => {
  test('a later 4h on project B moves half the billed day from A to B (net $0)', async () => {
    const daily = { rate_type: 'daily', hourly_rate: '200.00' };
    install(makeWorld({ timeRows: [
      timeRow({ id: 1, work_date: '2026-09-01', start_time: '08:00:00', end_time: '12:00:00', qbo_bill_id: 'B-0', ...daily }),
      timeRow({ id: 2, work_date: '2026-09-01', start_time: '13:00:00', end_time: '17:00:00', project_id: 201, qbo_customer_id: 'CUST-2', project_name: 'Oak Ave', ...daily }),
    ] }));
    await push(WEEK1);
    const lines = lastBill().lines;
    expect(lineTotal(lines)).toBe(0);
    expect(lines.find(l => l.customerId === 'CUST-2').amount).toBe(100);
    expect(lines.find(l => l.customerId === 'CUST-1').amount).toBe(-100);
  });
});
