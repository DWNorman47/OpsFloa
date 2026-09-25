/**
 * QuickBooks money bugs — each pinned with the dollar figure it used to get wrong.
 *
 *  1. Contractor bills ignored break_minutes: 07:00–15:30 with a 30-min break at
 *     $30 billed 8.5h = $255 instead of 8h = $240.
 *  2. Bills priced every hour at the worker's hourly rate — prevailing-wage and
 *     daily-rate workers were billed wrong. Bills now come from the pay engine.
 *  3. The OT premium line posted overtimeHours × rate × (multiplier − 1) instead of
 *     the computed premium: a 14h day with tiers 8h@1.5× / 12h@2× at $30 posted
 *     $90 instead of $120.
 *  4. Bill idempotency key was company|vendor|from|to — re-pushing the range after
 *     a late approval got the ORIGINAL bill back from Intuit's dedupe and stamped
 *     the new entries with it (never billed).
 *  5. Payroll JE key was company|from|to — a corrected re-push silently no-op'd and
 *     an overlapping range double-posted.
 *  6. Force re-push of time activities reused ops-ta-<id> (Intuit returned the old one).
 */

let mockUser = { id: 1, company_id: 'company-uuid-1', full_name: 'Test Admin', role: 'admin' };
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
    // Pure helpers stay real (the rounding helper is what the routes must use).
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
  work_date: '2026-04-01', start_time: '08:00:00', end_time: '16:00:00',
  notes: '', qbo_bill_id: null, qbo_activity_id: null,
  wage_type: 'regular', break_minutes: 0, mileage: 0, overtime_hours_override: null,
  full_name: 'Alex Rivera', qbo_vendor_id: 'V-1', hourly_rate: '30.00', rate_type: 'hourly',
  worker_type: 'contractor', overtime_rule: null, role_id: null, guaranteed_weekly_hours: 0,
  qbo_class_id: null, qbo_customer_id: 'CUST-1', project_name: 'Main St', prevailing_wage_rate: null,
  ...over,
});

const OT_OFF = [{ key: 'overtime_rule', value: 'none' }];
const TIERED = [
  { key: 'overtime_rule', value: 'daily' },
  { key: 'overtime_threshold', value: '8' },
  { key: 'overtime_multiplier', value: '1.5' },
  { key: 'hours_rules', value: JSON.stringify({ enabled: true, rules: [
    { id: 't1', type: 'ot_tier', when: { kind: 'every_day' }, basis: 'day', afterHours: 8, mult: 1.5 },
    { id: 't2', type: 'ot_tier', when: { kind: 'every_day' }, basis: 'day', afterHours: 12, mult: 2 },
  ] }) },
];

// SQL-dispatching fake DB — independent of query order.
function installDb({ settings = OT_OFF, timeRows = [], reimbRows = [], journals = [] } = {}) {
  const writes = [];
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
    if (/FROM time_entries te/.test(s)) return { rows: timeRows.map(r => ({ ...r })) };
    if (/FROM reimbursements r/.test(s)) return { rows: reimbRows };
    if (/FROM qbo_payroll_journals/.test(s)) {
      const [, from, to] = params;
      return { rows: journals.filter(j => j.period_from <= to && j.period_to >= from) };
    }
    if (/INSERT INTO qbo_payroll_journals/.test(s)) {
      writes.push({ sql: s, params });
      journals.push({ period_from: params[1], period_to: params[2], amount_cents: params[3], qbo_entry_id: params[5] });
      return { rows: [], rowCount: 1 };
    }
    if (/^\s*UPDATE/.test(s)) { writes.push({ sql: s, params }); return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  });
  return writes;
}

const lineTotal = lines => Math.round(lines.reduce((s, l) => s + (l.amount != null ? l.amount : l.qty * l.unitPrice), 0) * 100) / 100;

beforeEach(() => {
  qbo.createBill.mockReset();
  qbo.createJournalEntry.mockReset();
  qbo.pushTimeActivity.mockReset();
  companyStatements.mockReset();
});

describe('contractor bills come from the pay engine', () => {
  test('break minutes are deducted: 07:00–15:30, 30-min break, $30 → $240 (was $255)', async () => {
    installDb({ timeRows: [timeRow({ start_time: '07:00:00', end_time: '15:30:00', break_minutes: 30 })] });
    qbo.createBill.mockResolvedValueOnce({ Id: 'B-1' });
    const res = await request(makeApp()).post('/api/qbo/push-bills').send({ from: '2026-04-01', to: '2026-04-07' });
    expect(res.status).toBe(200);
    const { lines } = qbo.createBill.mock.calls[0][1];
    expect(lines[0]).toMatchObject({ qty: 8, unitPrice: 30 });
    expect(lineTotal(lines)).toBe(240);
  });

  test('preview shows the same break-net amount', async () => {
    installDb({ timeRows: [timeRow({ start_time: '07:00:00', end_time: '15:30:00', break_minutes: 30 })] });
    const res = await request(makeApp()).post('/api/qbo/push-bills-preview').send({ from: '2026-04-01', to: '2026-04-07' });
    expect(res.status).toBe(200);
    expect(res.body.groups[0].hours).toBeCloseTo(8);
    expect(res.body.groups[0].total).toBe(240);
  });

  test('tiered OT premium is the computed premium: 14h, 8h@1.5× / 12h@2×, $30 → $120 (was $90)', async () => {
    installDb({ settings: TIERED, timeRows: [timeRow({ start_time: '05:00:00', end_time: '19:00:00' })] });
    qbo.createBill.mockResolvedValueOnce({ Id: 'B-1' });
    const res = await request(makeApp()).post('/api/qbo/push-bills').send({ from: '2026-04-01', to: '2026-04-07' });
    expect(res.status).toBe(200);
    const { lines } = qbo.createBill.mock.calls[0][1];
    const ot = lines.find(l => /Overtime premium/.test(l.description));
    expect(ot.amount).toBe(120);
    // Bill = pay: 8×30 + 4×45 + 2×60 = 540
    expect(lineTotal(lines)).toBe(540);
  });

  test('prevailing entries bill at the project prevailing rate', async () => {
    installDb({ timeRows: [timeRow({ wage_type: 'prevailing', prevailing_wage_rate: '55.00' })] });
    qbo.createBill.mockResolvedValueOnce({ Id: 'B-1' });
    await request(makeApp()).post('/api/qbo/push-bills').send({ from: '2026-04-01', to: '2026-04-07' });
    const { lines } = qbo.createBill.mock.calls[0][1];
    expect(lines[0]).toMatchObject({ qty: 8, unitPrice: 55 });
    expect(lineTotal(lines)).toBe(440);
  });

  test('daily-rate workers bill their daily rate, not hours × daily rate', async () => {
    installDb({ timeRows: [
      timeRow({ id: 1, rate_type: 'daily', hourly_rate: '240.00' }),
      timeRow({ id: 2, rate_type: 'daily', hourly_rate: '240.00', work_date: '2026-04-02' }),
    ] });
    qbo.createBill.mockResolvedValueOnce({ Id: 'B-1' });
    await request(makeApp()).post('/api/qbo/push-bills').send({ from: '2026-04-01', to: '2026-04-07' });
    const { lines } = qbo.createBill.mock.calls[0][1];
    expect(lineTotal(lines)).toBe(480); // 2 days × $240 (was 16h × $240 = $3,840)
  });
});

describe('range-level pay (weekly guarantee) is billed once', () => {
  const week = { from: '2026-04-06', to: '2026-04-12' }; // Mon–Sun
  // The 0211 ledger (qbo_bill_range_pay) persisted across the two pushes.
  function withLedger(ledger) {
    const base = pool.query.getMockImplementation();
    pool.query.mockImplementation(async (sql, params) => {
      const s = String(sql);
      if (/FROM qbo_bill_range_pay/.test(s)) return { rows: ledger.map(r => ({ ...r })) };
      if (/INSERT INTO qbo_bill_range_pay/.test(s)) {
        const [, uids, kinds, dates, amounts, hours] = params;
        uids.forEach((uid, i) => {
          const hit = ledger.find(l => l.user_id === uid && l.kind === kinds[i] && l.pay_date === dates[i]);
          if (hit) Object.assign(hit, { amount_cents: amounts[i], hours: hours[i] });
          else ledger.push({ user_id: uid, kind: kinds[i], pay_date: dates[i], amount_cents: amounts[i], hours: hours[i] });
        });
        return { rows: [], rowCount: uids.length };
      }
      return base(sql, params);
    });
  }
  test('first bill includes the guarantee top-up; a follow-up bill trues it up instead of billing it again', async () => {
    const ledger = [];
    installDb({ timeRows: [timeRow({ id: 1, work_date: '2026-04-06', guaranteed_weekly_hours: 40 })] });
    withLedger(ledger);
    qbo.createBill.mockResolvedValueOnce({ Id: 'B-1' });
    await request(makeApp()).post('/api/qbo/push-bills').send(week);
    const first = qbo.createBill.mock.calls[0][1].lines;
    expect(first.find(l => /guaranteed-hours/.test(l.description)).amount).toBe(960); // 32h × $30
    expect(lineTotal(first)).toBe(1200);
    // (the ledger also holds the day's worked pay — kind 'worked', 0214)
    expect(ledger.filter(l => l.kind === 'weekly_guarantee')).toEqual([expect.objectContaining({ kind: 'weekly_guarantee', pay_date: '2026-04-06', amount_cents: 96000 })]);

    installDb({ timeRows: [
      timeRow({ id: 1, work_date: '2026-04-06', guaranteed_weekly_hours: 40, qbo_bill_id: 'B-1' }),
      timeRow({ id: 2, work_date: '2026-04-07', guaranteed_weekly_hours: 40 }),
    ] });
    withLedger(ledger);
    qbo.createBill.mockResolvedValueOnce({ Id: 'B-2' });
    await request(makeApp()).post('/api/qbo/push-bills').send(week);
    const second = qbo.createBill.mock.calls[1][1].lines;
    // 16h worked is still a 40h week: the new 8h ($240) replaces 8h of the
    // guarantee already billed (−$240) — the worker is billed $1,200 total, not
    // $1,440 (old code billed the new day on top of the full top-up).
    expect(second.find(l => /guaranteed-hours/.test(l.description)).amount).toBe(-240);
    expect(lineTotal(second)).toBe(0);
    expect(ledger.find(l => l.kind === 'weekly_guarantee').amount_cents).toBe(72000);
  });
});

describe('bill idempotency keys', () => {
  test('re-pushing the range after a late approval gets a NEW request id', async () => {
    installDb({ timeRows: [timeRow({ id: 1 })] });
    qbo.createBill.mockResolvedValueOnce({ Id: 'B-1', TotalAmt: 240 });
    await request(makeApp()).post('/api/qbo/push-bills').send({ from: '2026-04-01', to: '2026-04-07' });
    const key1 = qbo.createBill.mock.calls[0][1].requestId;

    installDb({ timeRows: [timeRow({ id: 1, qbo_bill_id: 'B-1' }), timeRow({ id: 2, work_date: '2026-04-02' })] });
    qbo.createBill.mockResolvedValueOnce({ Id: 'B-2', TotalAmt: 240 });
    await request(makeApp()).post('/api/qbo/push-bills').send({ from: '2026-04-01', to: '2026-04-07' });
    const key2 = qbo.createBill.mock.calls[1][1].requestId;
    expect(key1).toMatch(/^ops-bill-[a-f0-9]{32}$/);
    expect(key2).toMatch(/^ops-bill-[a-f0-9]{32}$/);
    expect(key2).not.toBe(key1);
  });

  test('a double-submit of the same content keeps the same key', async () => {
    installDb({ timeRows: [timeRow({ id: 1 })] });
    qbo.createBill.mockResolvedValue({ Id: 'B-1', TotalAmt: 240 });
    await request(makeApp()).post('/api/qbo/push-bills').send({ from: '2026-04-01', to: '2026-04-07' });
    installDb({ timeRows: [timeRow({ id: 1 })] });
    await request(makeApp()).post('/api/qbo/push-bills').send({ from: '2026-04-01', to: '2026-04-07' });
    expect(qbo.createBill.mock.calls[1][1].requestId).toBe(qbo.createBill.mock.calls[0][1].requestId);
  });

  test('force re-push carries a versioned key (not undefined, not the original)', async () => {
    installDb({ timeRows: [timeRow({ id: 1 })] });
    qbo.createBill.mockResolvedValueOnce({ Id: 'B-1', TotalAmt: 240 });
    await request(makeApp()).post('/api/qbo/push-bills').send({ from: '2026-04-01', to: '2026-04-07' });
    installDb({ timeRows: [timeRow({ id: 1, qbo_bill_id: 'B-1' })] });
    qbo.createBill.mockResolvedValueOnce({ Id: 'B-9', TotalAmt: 240 });
    await request(makeApp()).post('/api/qbo/push-bills').send({ from: '2026-04-01', to: '2026-04-07', force: true });
    const [a, b] = qbo.createBill.mock.calls.map(c => c[1].requestId);
    expect(b).toMatch(/^ops-bill-[a-f0-9]{32}$/);
    expect(b).not.toBe(a);
  });

  test('a returned bill whose total does not match is NOT stamped onto the entries', async () => {
    const writes = installDb({ timeRows: [timeRow({ id: 2 })] });
    qbo.createBill.mockResolvedValueOnce({ Id: 'B-OLD', TotalAmt: 999 });
    const res = await request(makeApp()).post('/api/qbo/push-bills').send({ from: '2026-04-01', to: '2026-04-07' });
    expect(res.body.pushed).toEqual([]);
    expect(res.body.skipped).toHaveLength(1);
    expect(writes.filter(w => /UPDATE (time_entries|reimbursements) SET qbo_bill_id/.test(w.sql))).toHaveLength(0);
    // The bill EXISTS in QuickBooks: its outbox row is kept as 'mismatch' (with the
    // returned id) for an admin to resolve — not deleted (0218).
    expect(pool.query.mock.calls.some(c => /DELETE FROM qbo_bill_pushes/.test(String(c[0])))).toBe(false);
    expect(writes.find(w => /status = 'mismatch'/.test(w.sql)).params[0]).toBe('B-OLD');
  });
});

describe('time activity force re-push', () => {
  test('force uses a versioned request id; normal push keeps ops-ta-<id>', async () => {
    installDb({ timeRows: [timeRow({ id: 100, qbo_activity_id: 'TA-5', qbo_employee_id: null })] });
    qbo.pushTimeActivity.mockResolvedValue({ Id: 'TA-6' });
    await request(makeApp()).post('/api/qbo/push').send({ from: '2026-04-01', to: '2026-04-07', force: true });
    installDb({ timeRows: [timeRow({ id: 101 })] });
    await request(makeApp()).post('/api/qbo/push').send({ from: '2026-04-01', to: '2026-04-07' });
    const [forced, normal] = qbo.pushTimeActivity.mock.calls.map(c => c[1].requestId);
    expect(normal).toBe('ops-ta-101');
    expect(forced).toMatch(/^ops-ta-100-v[a-f0-9]+$/);
    expect(forced.length).toBeLessThanOrEqual(50);
  });

  test('pushed hours are net of break and use the rounded punch', async () => {
    installDb({
      settings: [{ key: 'hours_rules', value: JSON.stringify({ enabled: true, rules: [
        { id: 'r1', type: 'round', when: { kind: 'every_day' }, edge: 'both', reference: 'clock', direction: 'nearest', intervalMin: 15 },
      ] }) }],
      timeRows: [timeRow({ id: 7, start_time: '07:08:00', end_time: '15:37:00', break_minutes: 30 })],
    });
    qbo.pushTimeActivity.mockResolvedValue({ Id: 'TA-1' });
    await request(makeApp()).post('/api/qbo/push').send({ from: '2026-04-01', to: '2026-04-07' });
    // 07:15–15:30 = 8.25h − 0.5h break = 7.75h
    expect(qbo.pushTimeActivity.mock.calls[0][1]).toMatchObject({ hours: 7.75, workDate: '2026-04-01' });
  });
});

describe('payroll journal entries', () => {
  const worker = { id: 10, full_name: 'A', invoice_name: null, hourly_rate: 20, rate_type: 'hourly', overtime_rule: null, role_id: null, guaranteed_weekly_hours: 0 };
  const body = { from: '2026-04-01', to: '2026-04-07', debit_account_id: 'D', credit_account_id: 'C' };
  function db(journals) {
    const writes = installDb({ journals });
    const base = pool.query.getMockImplementation();
    pool.query.mockImplementation(async (sql, params) => {
      if (/FROM users/.test(sql)) return { rows: [worker] };
      return base(sql, params);
    });
    return writes;
  }

  test('first push posts the gross and records it', async () => {
    const journals = [];
    db(journals);
    companyStatements.mockResolvedValueOnce(new Map([[10, { totals: { grossWages: 950 } }]]));
    qbo.createJournalEntry.mockResolvedValueOnce({ Id: 'JE-1', TotalAmt: 950 });
    const res = await request(makeApp()).post('/api/qbo/push-payroll').send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ entry_id: 'JE-1', amount: 950 });
    expect(journals).toHaveLength(1);
    expect(journals[0].amount_cents).toBe(95000);
  });

  test('a corrected re-push of the same range posts the DIFFERENCE (was a silent no-op)', async () => {
    const journals = [{ period_from: '2026-04-01', period_to: '2026-04-07', amount_cents: 95000, qbo_entry_id: 'JE-1' }];
    db(journals);
    companyStatements.mockResolvedValueOnce(new Map([[10, { totals: { grossWages: 1000 } }]]));
    qbo.createJournalEntry.mockResolvedValueOnce({ Id: 'JE-2', TotalAmt: 50 });
    const res = await request(makeApp()).post('/api/qbo/push-payroll').send(body);
    expect(res.status).toBe(200);
    const call = qbo.createJournalEntry.mock.calls[0][1];
    expect(call.amount).toBe(50);
    expect(call.debitAccountId).toBe('D');
    expect(res.body).toMatchObject({ adjustment: true, amount: 50, payroll_total: 1000 });
  });

  test('a lower corrected total reverses the difference (debit/credit swapped)', async () => {
    const journals = [{ period_from: '2026-04-01', period_to: '2026-04-07', amount_cents: 95000, qbo_entry_id: 'JE-1' }];
    db(journals);
    companyStatements.mockResolvedValueOnce(new Map([[10, { totals: { grossWages: 900 } }]]));
    qbo.createJournalEntry.mockResolvedValueOnce({ Id: 'JE-3', TotalAmt: 50 });
    await request(makeApp()).post('/api/qbo/push-payroll').send(body);
    const call = qbo.createJournalEntry.mock.calls[0][1];
    expect(call).toMatchObject({ amount: 50, debitAccountId: 'C', creditAccountId: 'D' });
  });

  test('an unchanged re-push posts nothing and says so', async () => {
    db([{ period_from: '2026-04-01', period_to: '2026-04-07', amount_cents: 95000, qbo_entry_id: 'JE-1' }]);
    companyStatements.mockResolvedValueOnce(new Map([[10, { totals: { grossWages: 950 } }]]));
    const res = await request(makeApp()).post('/api/qbo/push-payroll').send(body);
    expect(res.status).toBe(200);
    expect(res.body.already_posted).toBe(true);
    expect(qbo.createJournalEntry).not.toHaveBeenCalled();
  });

  test('an overlapping (different) range is refused instead of double-posting', async () => {
    db([{ period_from: '2026-04-05', period_to: '2026-04-11', amount_cents: 50000, qbo_entry_id: 'JE-1' }]);
    companyStatements.mockResolvedValueOnce(new Map([[10, { totals: { grossWages: 950 } }]]));
    const res = await request(makeApp()).post('/api/qbo/push-payroll').send(body);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('overlapping_payroll_journal');
    expect(qbo.createJournalEntry).not.toHaveBeenCalled();
  });
});
