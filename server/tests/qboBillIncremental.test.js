/**
 * QuickBooks contractor bills pushed AFTER part of the range was already billed.
 * Each test pins the dollar figure the old code got wrong.
 *
 *  1. A re-push after late approvals dropped the already-billed in-range rows
 *     entirely (not even as week context), so:
 *       - weekly OT was lost: Mon–Fri 8h @ $20 billed $800, then a late Sat 8h
 *         billed $160 — it is all overtime, $240;
 *       - daily-rate days double-billed: a second entry on an already-billed day
 *         billed another full day rate.
 *  2. Range-level pay (paid leave, weekly guarantee, min-daily floors) was billed
 *     only on the "first bill for a worker+range" heuristic:
 *       - Sep 1–15 then Sep 1–30 never billed Sep 16–30 leave / guarantee;
 *       - Sep 1–7 (sick billed) then Sep 3–14 billed the Sep 3 sick day again.
 *     Now a ledger (qbo_bill_range_pay, 0211) records what was billed per
 *     worker + kind + date/week, and each bill posts only the difference.
 *  3. The payroll JE re-push loaded only active role='worker' users, so a
 *     corrected re-push after deactivating a worker reversed their wages.
 */

const mockUser = { id: 1, company_id: 'company-uuid-1', full_name: 'Test Admin', role: 'admin' };
jest.mock('../middleware/auth', () => ({
  requireAuth:  (req, _res, next) => { req.user = mockUser; next(); },
  requireAdmin: (req, _res, next) => { req.user = mockUser; next(); },
  requirePerm: () => (_req, _res, next) => next(),
}));
// connect(): the per-company bill lock (always granted here) and the transaction that
// records each bill (stamps + ledger + outbox); transaction control isn't sent to m.query.
jest.mock('../db', () => {
  const m = { query: jest.fn() };
  const tx = /^\s*(BEGIN|COMMIT|ROLLBACK|SET LOCAL)\b/;
  m.connect = jest.fn(async () => ({
    query: (sql, ...a) => (/pg_try_advisory_xact_lock/.test(String(sql)) ? Promise.resolve({ rows: [{ locked: true }] })
      : tx.test(String(sql)) ? Promise.resolve({ rows: [] }) : m.query(sql, ...a)),
    release: () => {},
  }));
  return m;
});
jest.mock('../services/qbo', () => {
  const actual = jest.requireActual('../services/qbo');
  return {
    timeActivityHours: actual.timeActivityHours,
    createBill: jest.fn(), createJournalEntry: jest.fn(), pushTimeActivity: jest.fn(),
    getAuthUrl: jest.fn(), exchangeCode: jest.fn(), refreshAccessToken: jest.fn(),
    getCompanyInfo: jest.fn(), listEmployees: jest.fn(), listCustomers: jest.fn(),
    listVendors: jest.fn(), listItems: jest.fn(), listAccounts: jest.fn(),
    listClasses: jest.fn(), createInvoice: jest.fn(), getInvoice: jest.fn(),
    createPurchase: jest.fn(), createCustomer: jest.fn(), createVendor: jest.fn(),
    deleteTimeActivity: jest.fn(),
  };
});
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../utils/payStatement', () => {
  const actual = jest.requireActual('../utils/payStatement');
  return { ...actual, companyStatements: jest.fn() };
});

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const qbo = require('../services/qbo');
const { companyStatements } = require('../utils/payStatement');
const qboRoute = require('../routes/qbo');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/qbo', qboRoute);
  return app;
}

const timeRow = (over = {}) => ({
  id: 100, user_id: 10, project_id: 200,
  work_date: '2026-09-07', start_time: '08:00:00', end_time: '16:00:00',
  notes: '', qbo_bill_id: null, qbo_activity_id: null,
  wage_type: 'regular', break_minutes: 0, mileage: 0, overtime_hours_override: null,
  full_name: 'Alex Rivera', qbo_vendor_id: 'V-1', hourly_rate: '20.00', rate_type: 'hourly',
  worker_type: 'contractor', overtime_rule: null, role_id: null, guaranteed_weekly_hours: 0,
  qbo_class_id: null, qbo_customer_id: 'CUST-1', project_name: 'Main St', prevailing_wage_rate: null,
  ...over,
});

const OT_OFF = [{ key: 'overtime_rule', value: 'none' }];
const WEEKLY = [
  { key: 'overtime_rule', value: 'weekly' },
  { key: 'overtime_threshold', value: '40' },
  { key: 'overtime_multiplier', value: '1.5' },
];

// SQL-dispatching fake DB with a persistent range-pay ledger (the 0211 table).
function installDb({ settings = OT_OFF, timeRows = [], leaveRequests = [], ledger = [], users = [], journals = [] } = {}) {
  pool.query.mockReset();
  pool.query.mockImplementation(async (sql, params = []) => {
    const s = String(sql);
    if (/qbo_labor_item_id/.test(s)) {
      return { rows: [
        { key: 'qbo_expense_account_id', value: 'ACCT-42' },
        { key: 'qbo_labor_item_id', value: 'ITEM-LABOR' },
        { key: 'qbo_bill_terms_days', value: '0' },
      ] };
    }
    if (/SELECT qbo_realm_id FROM companies/.test(s)) return { rows: [{ qbo_realm_id: 'realm-1' }] };
    if (/^SELECT key, value FROM settings WHERE company_id = \$1$/.test(s.trim())) return { rows: settings };
    if (/FROM time_entries te/.test(s) && /qbo_vendor_id/.test(s)) return { rows: timeRows.map(r => ({ ...r })) };
    if (/FROM reimbursements r/.test(s)) return { rows: [] };
    if (/FROM users u/.test(s) && /qbo_vendor_id IS NOT NULL/.test(s)) return { rows: [] }; // leave/guarantee-only contractors
    if (/FROM time_off_requests/.test(s)) return { rows: leaveRequests.map(r => ({ user_id: 10, hours: null, ...r })) };
    if (/FROM shifts/.test(s)) return { rows: [] };
    if (/FROM qbo_bill_range_pay/.test(s)) return { rows: ledger.map(r => ({ ...r })) };
    if (/INSERT INTO qbo_bill_range_pay/.test(s)) {
      // $1 company, unnest($2 user_ids, $3 kinds, $4 dates, $5 amount_cents, $6 hours), $7 bill id
      const [, uids, kinds, dates, amounts] = params;
      uids.forEach((uid, i) => {
        const hit = ledger.find(l => l.user_id === uid && l.kind === kinds[i] && l.pay_date === dates[i]);
        if (hit) hit.amount_cents = amounts[i];
        else ledger.push({ user_id: uid, kind: kinds[i], pay_date: dates[i], amount_cents: amounts[i] });
      });
      return { rows: [], rowCount: uids.length };
    }
    if (/FROM users/.test(s)) return { rows: users };
    if (/FROM qbo_payroll_journals/.test(s)) {
      const [, from, to] = params;
      return { rows: journals.filter(j => j.period_from <= to && j.period_to >= from) };
    }
    if (/INSERT INTO qbo_payroll_journals/.test(s)) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  return { ledger };
}

const lineTotal = lines => Math.round(lines.reduce((s, l) => s + (l.amount != null ? l.amount : l.qty * l.unitPrice), 0) * 100) / 100;
const push = body => request(makeApp()).post('/api/qbo/push-bills').send(body);
const lastBill = () => qbo.createBill.mock.calls[qbo.createBill.mock.calls.length - 1][1];

beforeEach(() => {
  qbo.createBill.mockReset();
  qbo.createBill.mockImplementation(async (_c, b) => ({ Id: `B-${qbo.createBill.mock.calls.length}`, TotalAmt: lineTotal(b.lines) }));
  qbo.createJournalEntry.mockReset();
  companyStatements.mockReset();
});

describe('bug 1 — already-billed in-range rows are week/day context for the late rows', () => {
  const week = { from: '2026-09-07', to: '2026-09-13' }; // Mon–Sun

  test('late Saturday after Mon–Fri 40h billed bills $240 (all OT), not $160', async () => {
    const days = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'];
    installDb({ settings: WEEKLY, timeRows: [
      ...days.map((d, i) => timeRow({ id: i + 1, work_date: d, qbo_bill_id: 'B-0' })),
      timeRow({ id: 9, work_date: '2026-09-12' }),
    ] });
    const res = await push(week);
    expect(res.status).toBe(200);
    const { lines } = lastBill();
    expect(lineTotal(lines)).toBe(240);
    expect(lines.find(l => /Overtime premium/.test(l.description)).amount).toBe(80);
    expect(res.body.pushed[0]).toMatchObject({ time_entries: 1, total: 240 });
  });

  test('late Wednesday after Mon/Tue/Thu/Fri/Sat billed still carries the week\'s OT ($240)', async () => {
    const billed = ['2026-09-07', '2026-09-08', '2026-09-10', '2026-09-11', '2026-09-12'];
    installDb({ settings: WEEKLY, timeRows: [
      ...billed.map((d, i) => timeRow({ id: i + 1, work_date: d, qbo_bill_id: 'B-0' })),
      timeRow({ id: 9, work_date: '2026-09-09' }),
    ] });
    await push(week);
    expect(lineTotal(lastBill().lines)).toBe(240);
  });

  test('preview shows the same incremental amount', async () => {
    const days = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'];
    installDb({ settings: WEEKLY, timeRows: [
      ...days.map((d, i) => timeRow({ id: i + 1, work_date: d, qbo_bill_id: 'B-0' })),
      timeRow({ id: 9, work_date: '2026-09-12' }),
    ] });
    const res = await request(makeApp()).post('/api/qbo/push-bills-preview').send(week);
    expect(res.body.groups[0]).toMatchObject({ time_entries: 1, total: 240, overtime_premium: 80 });
  });

  test('daily-rate: a second entry on an already-billed day adds $0; a new day adds the day rate', async () => {
    const daily = { rate_type: 'daily', hourly_rate: '200.00' };
    installDb({ timeRows: [
      timeRow({ id: 1, work_date: '2026-09-07', start_time: '08:00:00', end_time: '12:00:00', qbo_bill_id: 'B-0', ...daily }),
      timeRow({ id: 2, work_date: '2026-09-07', start_time: '13:00:00', end_time: '17:00:00', ...daily }),
      timeRow({ id: 3, work_date: '2026-09-08', ...daily }),
    ] });
    await push(week);
    expect(lineTotal(lastBill().lines)).toBe(200); // was $400 (Sep 7 billed a second time)
  });
});

describe('bug 2 — range-level pay is tracked per date/week in a ledger', () => {
  test('leave: Sep 1–15 then Sep 1–30 bills the Sep 22 sick day (was never billed)', async () => {
    const leaveRequests = [
      { type: 'sick', start_date: '2026-09-03', end_date: '2026-09-03' },
      { type: 'sick', start_date: '2026-09-22', end_date: '2026-09-22' },
    ];
    const { ledger } = installDb({ leaveRequests, timeRows: [timeRow({ id: 1, work_date: '2026-09-02' })] });
    await push({ from: '2026-09-01', to: '2026-09-15' });
    let lines = lastBill().lines;
    expect(lines.filter(l => /sick/i.test(l.description)).map(l => l.amount)).toEqual([160]);
    expect(lineTotal(lines)).toBe(320);

    installDb({ leaveRequests, ledger, timeRows: [
      timeRow({ id: 1, work_date: '2026-09-02', qbo_bill_id: 'B-1' }),
      timeRow({ id: 2, work_date: '2026-09-23' }),
    ] });
    await push({ from: '2026-09-01', to: '2026-09-30' });
    lines = lastBill().lines;
    const sick = lines.filter(l => /sick/i.test(l.description));
    expect(sick.map(l => l.amount)).toEqual([160]);
    expect(sick[0].description).toMatch(/2026-09-22/);
    expect(sick[0].description).not.toMatch(/2026-09-03/);
    expect(lineTotal(lines)).toBe(320);
  });

  test('leave: Sep 1–7 (Sep 3 sick billed) then Sep 3–14 does not bill Sep 3 again', async () => {
    const leaveRequests = [{ type: 'sick', start_date: '2026-09-03', end_date: '2026-09-03' }];
    const { ledger } = installDb({ leaveRequests, timeRows: [timeRow({ id: 1, work_date: '2026-09-01' })] });
    await push({ from: '2026-09-01', to: '2026-09-07' });
    expect(lineTotal(lastBill().lines)).toBe(320);

    installDb({ leaveRequests, ledger, timeRows: [
      timeRow({ id: 1, work_date: '2026-09-01', qbo_bill_id: 'B-1' }),
      timeRow({ id: 2, work_date: '2026-09-09' }),
    ] });
    await push({ from: '2026-09-03', to: '2026-09-14' });
    const lines = lastBill().lines;
    expect(lines.some(l => /sick/i.test(l.description))).toBe(false);
    expect(lineTotal(lines)).toBe(160); // was $320 (Sep 3 sick billed twice)
  });

  test('weekly guarantee: Sep 1–15 then Sep 1–30 bills the later weeks\' guarantee (was never billed)', async () => {
    const g = { guaranteed_weekly_hours: 40 };
    const { ledger } = installDb({ timeRows: [
      timeRow({ id: 1, work_date: '2026-09-01', ...g }),
      timeRow({ id: 2, work_date: '2026-09-08', ...g }),
      timeRow({ id: 3, work_date: '2026-09-15', ...g }),
    ] });
    await push({ from: '2026-09-01', to: '2026-09-15' });
    let lines = lastBill().lines;
    // Weeks ending Sep 6 and Sep 13 fall in the range: 32h short each × $20.
    expect(lines.filter(l => /guaranteed-hours/.test(l.description)).map(l => l.amount)).toEqual([640, 640]);

    installDb({ ledger, timeRows: [
      timeRow({ id: 1, work_date: '2026-09-01', qbo_bill_id: 'B-1', ...g }),
      timeRow({ id: 2, work_date: '2026-09-08', qbo_bill_id: 'B-1', ...g }),
      timeRow({ id: 3, work_date: '2026-09-15', qbo_bill_id: 'B-1', ...g }),
      timeRow({ id: 4, work_date: '2026-09-22', ...g }),
    ] });
    await push({ from: '2026-09-01', to: '2026-09-30' });
    lines = lastBill().lines;
    // Weeks ending Sep 20 and Sep 27 are new; Sep 6 / Sep 13 were already billed.
    const gl = lines.filter(l => /guaranteed-hours/.test(l.description));
    expect(gl.map(l => l.amount)).toEqual([640, 640]);
    expect(gl.map(l => l.description).join(' ')).toMatch(/2026-09-14.*2026-09-21/);
    expect(lineTotal(lines)).toBe(160 + 1280);
  });

  test('a re-push with nothing new posts no bill', async () => {
    const leaveRequests = [{ type: 'sick', start_date: '2026-09-03', end_date: '2026-09-03' }];
    const { ledger } = installDb({ leaveRequests, timeRows: [timeRow({ id: 1, work_date: '2026-09-01' })] });
    await push({ from: '2026-09-01', to: '2026-09-07' });
    installDb({ leaveRequests, ledger, timeRows: [timeRow({ id: 1, work_date: '2026-09-01', qbo_bill_id: 'B-1' })] });
    const res = await push({ from: '2026-09-01', to: '2026-09-07' });
    expect(qbo.createBill).toHaveBeenCalledTimes(1);
    expect(res.body.pushed).toEqual([]);
  });

  test('a late-approved sick day in an already-billed range bills on its own', async () => {
    const { ledger } = installDb({ timeRows: [timeRow({ id: 1, work_date: '2026-09-01' })] });
    await push({ from: '2026-09-01', to: '2026-09-07' });
    installDb({ ledger, leaveRequests: [{ type: 'sick', start_date: '2026-09-03', end_date: '2026-09-03' }],
      timeRows: [timeRow({ id: 1, work_date: '2026-09-01', qbo_bill_id: 'B-1' })] });
    const res = await push({ from: '2026-09-01', to: '2026-09-07' });
    expect(res.body.pushed).toHaveLength(1);
    expect(lineTotal(lastBill().lines)).toBe(160);
  });
});

describe('bug 3 — payroll JE re-push counts deactivated workers', () => {
  test('a re-push after deactivating a worker does not reverse their wages', async () => {
    const worker = { id: 10, full_name: 'A', invoice_name: null, hourly_rate: 20, rate_type: 'hourly', overtime_rule: null, role_id: null, guaranteed_weekly_hours: 0 };
    installDb({ journals: [{ period_from: '2026-09-01', period_to: '2026-09-07', amount_cents: 95000, qbo_entry_id: 'JE-1' }] });
    const base = pool.query.getMockImplementation();
    pool.query.mockImplementation(async (sql, params) => {
      const s = String(sql);
      if (/FROM users/.test(s)) {
        // The worker is now inactive: only a query that loads everyone with
        // approved entries in the range (regardless of active/role) finds them.
        const byEntries = /time_entries/.test(s) && /approved/.test(s) && !/active = true AND worker_type/.test(s);
        return { rows: byEntries ? [worker] : [] };
      }
      return base(sql, params);
    });
    companyStatements.mockImplementation(async ({ workers }) => new Map(workers.map(w => [w.id, { totals: { grossWages: 950 } }])));
    const res = await request(makeApp()).post('/api/qbo/push-payroll')
      .send({ from: '2026-09-01', to: '2026-09-07', debit_account_id: 'D', credit_account_id: 'C' });
    expect(res.status).toBe(200);
    expect(res.body.already_posted).toBe(true); // was a −$950 reversing JE
    expect(qbo.createJournalEntry).not.toHaveBeenCalled();
  });
});
