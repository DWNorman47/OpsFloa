/**
 * Integration tests for the QBO contractor Bill push route.
 *
 * Mocks the DB pool, the QBO service, and the auth middleware so tests are
 * self-contained (no DB, no network). Verifies:
 *   - preview groups by vendor, sums labor + reimbursements correctly
 *   - push refuses when required settings aren't configured
 *   - push refuses when QBO isn't connected
 *   - push creates one Bill per vendor and marks source rows
 */

// Mock auth middleware — inline the user shape (jest.mock factories are hoisted
// above any test-file-scope bindings, so they can't reference helpers)
jest.mock('../middleware/auth', () => {
  const user = { id: 1, company_id: 'company-uuid-1', full_name: 'Test Admin', role: 'admin' };
  return {
    requireAuth:  (req, _res, next) => { req.user = user; next(); },
    requireAdmin: (req, _res, next) => { req.user = user; next(); },
  };
});

jest.mock('../db', () => ({ query: jest.fn() }));

jest.mock('../services/qbo', () => ({
  createBill: jest.fn(),
  getAuthUrl: jest.fn(), exchangeCode: jest.fn(), refreshAccessToken: jest.fn(),
  getCompanyInfo: jest.fn(), listEmployees: jest.fn(), listCustomers: jest.fn(),
  listVendors: jest.fn(), listItems: jest.fn(), listAccounts: jest.fn(),
  listClasses: jest.fn(), createInvoice: jest.fn(), getInvoice: jest.fn(),
  createPurchase: jest.fn(), createCustomer: jest.fn(), createVendor: jest.fn(),
  createJournalEntry: jest.fn(), deleteTimeActivity: jest.fn(),
  pushTimeActivity: jest.fn(),
}));

jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool    = require('../db');
const qbo     = require('../services/qbo');
const qboRoute = require('../routes/qbo');

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/qbo', qboRoute);
  return app;
}

// ───────────────────────────────────────────────────────────────────────────
// Test fixtures
// ───────────────────────────────────────────────────────────────────────────

function timeRow(overrides = {}) {
  return {
    id: 100, user_id: 10, project_id: 200,
    work_date: '2026-04-01', start_time: '08:00:00', end_time: '16:00:00',
    notes: 'framed east wall',
    qbo_bill_id: null, qbo_activity_id: null,
    wage_type: 'regular', break_minutes: 0,
    full_name: 'Alex Rivera', qbo_vendor_id: 'V-1', hourly_rate: '45.00',
    worker_type: 'contractor', overtime_rule: null, // let company default drive; tests override when they want per-user OT
    qbo_class_id: 'C-9', qbo_customer_id: 'CUST-1', project_name: 'Main St Build',
    ...overrides,
  };
}

// Mock response for the overtime settings query. Default: OT OFF so existing
// tests don't need to account for any premium dollars.
function otOff() {
  return { rows: [{ key: 'overtime_rule', value: 'none' }] };
}
function otDaily({ threshold = 8, multiplier = 1.5 } = {}) {
  return {
    rows: [
      { key: 'overtime_rule', value: 'daily' },
      { key: 'overtime_threshold', value: String(threshold) },
      { key: 'overtime_multiplier', value: String(multiplier) },
    ],
  };
}

function reimbRow(overrides = {}) {
  return {
    id: 500, user_id: 10, project_id: 200,
    expense_date: '2026-04-02', amount: '25.50',
    description: 'fuel', category: 'Fuel',
    qbo_bill_id: null, qbo_purchase_id: null,
    full_name: 'Alex Rivera', qbo_vendor_id: 'V-1',
    qbo_class_id: 'C-9', qbo_customer_id: 'CUST-1', project_name: 'Main St Build',
    ...overrides,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────────────

describe('POST /api/qbo/push-bills-preview', () => {
  beforeEach(() => {
    pool.query.mockReset();
    qbo.createBill.mockReset();
  });

  test('groups time + reimbursements per vendor and sums labor correctly', async () => {
    pool.query
      .mockResolvedValueOnce(otOff())   // settings — the route loads these first now
      .mockResolvedValueOnce({ rows: [timeRow({ id: 1 }), timeRow({ id: 2, start_time: '09:00:00', end_time: '12:30:00' })] })
      .mockResolvedValueOnce({ rows: [reimbRow()] });

    const res = await request(makeApp())
      .post('/api/qbo/push-bills-preview')
      .send({ from: '2026-04-01', to: '2026-04-30' });

    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    const g = res.body.groups[0];
    expect(g.full_name).toBe('Alex Rivera');
    expect(g.time_entries).toBe(2);
    expect(g.hours).toBeCloseTo(8 + 3.5, 5);
    expect(g.labor_amount).toBeCloseTo(11.5 * 45, 2);
    expect(g.reimbursements).toBe(1);
    expect(g.reimb_amount).toBeCloseTo(25.5, 2);
    expect(g.total).toBeCloseTo(11.5 * 45 + 25.5, 2);
    expect(g.time_entry_rows).toHaveLength(2);
    expect(g.reimbursement_rows).toHaveLength(1);
  });

  test('excludes already-pushed rows unless force is set', async () => {
    pool.query
      .mockResolvedValueOnce(otOff())   // settings — the route loads these first now
      .mockResolvedValueOnce({ rows: [timeRow({ id: 1, qbo_bill_id: 'BILL-1' }), timeRow({ id: 2 })] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(makeApp())
      .post('/api/qbo/push-bills-preview')
      .send({ from: '2026-04-01', to: '2026-04-30' });

    expect(res.body.groups[0].time_entries).toBe(1);
  });

  test('includes already-pushed rows when force=true', async () => {
    pool.query
      .mockResolvedValueOnce(otOff())   // settings — the route loads these first now
      .mockResolvedValueOnce({ rows: [timeRow({ id: 1, qbo_bill_id: 'BILL-1' }), timeRow({ id: 2 })] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(makeApp())
      .post('/api/qbo/push-bills-preview')
      .send({ from: '2026-04-01', to: '2026-04-30', force: true });

    expect(res.body.groups[0].time_entries).toBe(2);
  });

  test('returns empty groups array when nothing matches', async () => {
    pool.query
      .mockResolvedValueOnce(otOff())   // settings — the route loads these first now
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(makeApp())
      .post('/api/qbo/push-bills-preview')
      .send({ from: '2026-04-01', to: '2026-04-30' });

    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual([]);
  });

  test('adds overtime premium when a day crosses the daily threshold', async () => {
    // One 10h shift with daily threshold 8 and 1.5× multiplier:
    //   2h OT × $45 × 0.5 = $45 premium on top of 10h × $45 = $450 base.
    pool.query
      .mockResolvedValueOnce(otDaily({ threshold: 8, multiplier: 1.5 }))   // settings — the route loads these first now
      .mockResolvedValueOnce({ rows: [timeRow({ id: 1, start_time: '08:00:00', end_time: '18:00:00' })] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(makeApp())
      .post('/api/qbo/push-bills-preview')
      .send({ from: '2026-04-01', to: '2026-04-30' });

    expect(res.status).toBe(200);
    const g = res.body.groups[0];
    expect(g.hours).toBeCloseTo(10);
    expect(g.labor_amount).toBeCloseTo(10 * 45);
    expect(g.overtime_hours).toBeCloseTo(2);
    expect(g.overtime_premium).toBeCloseTo(2 * 45 * 0.5);
    expect(g.total).toBeCloseTo(10 * 45 + 2 * 45 * 0.5);
  });

  test('no overtime premium when rule is none', async () => {
    pool.query
      .mockResolvedValueOnce(otOff())   // settings — the route loads these first now
      .mockResolvedValueOnce({ rows: [timeRow({ start_time: '08:00:00', end_time: '20:00:00' })] }) // 12h
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(makeApp())
      .post('/api/qbo/push-bills-preview')
      .send({ from: '2026-04-01', to: '2026-04-30' });

    const g = res.body.groups[0];
    expect(g.overtime_hours).toBe(0);
    expect(g.overtime_premium).toBe(0);
    expect(g.total).toBeCloseTo(12 * 45);
  });
});

describe('POST /api/qbo/push-bills', () => {
  beforeEach(() => {
    pool.query.mockReset();
    qbo.createBill.mockReset();
  });

  function mockSettings({ laborItem = 'ITEM-LABOR', expenseAcct = 'ACCT-42', terms = 0 } = {}) {
    return {
      rows: [
        { key: 'qbo_expense_account_id', value: expenseAcct || '' },
        { key: 'qbo_labor_item_id',      value: laborItem  || '' },
        { key: 'qbo_bill_terms_days',    value: String(terms) },
      ],
    };
  }

  test('400 when labor item not configured', async () => {
    pool.query.mockResolvedValueOnce(mockSettings({ laborItem: '' }));

    const res = await request(makeApp())
      .post('/api/qbo/push-bills')
      .send({ from: '2026-04-01', to: '2026-04-30' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Labor Service Item/);
  });

  test('400 when expense account not configured AND any reimbursements in range', async () => {
    pool.query
      .mockResolvedValueOnce(mockSettings({ expenseAcct: '' }))
      .mockResolvedValueOnce({ rows: [{ qbo_realm_id: 'realm-1' }] })
      .mockResolvedValueOnce(otOff())   // settings — the route loads these first now
      .mockResolvedValueOnce({ rows: [timeRow()] })
      .mockResolvedValueOnce({ rows: [reimbRow()] })  // has a reimb → requires expense acct;

    const res = await request(makeApp())
      .post('/api/qbo/push-bills')
      .send({ from: '2026-04-01', to: '2026-04-30' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Reimbursement Expense Account/);
  });

  test('push succeeds with no expense account when there are no reimbursements', async () => {
    pool.query
      .mockResolvedValueOnce(mockSettings({ expenseAcct: '' }))  // no expense acct
      .mockResolvedValueOnce({ rows: [{ qbo_realm_id: 'realm-1' }] })
      .mockResolvedValueOnce(otOff())   // settings — the route loads these first now
      .mockResolvedValueOnce({ rows: [timeRow()] })
      .mockResolvedValueOnce({ rows: [] })                        // no reimbs
      .mockResolvedValueOnce({ rowCount: 1 });

    qbo.createBill.mockResolvedValueOnce({ Id: 'BILL-NO-REIMB' });

    const res = await request(makeApp())
      .post('/api/qbo/push-bills')
      .send({ from: '2026-04-01', to: '2026-04-30' });

    expect(res.status).toBe(200);
    expect(res.body.pushed).toHaveLength(1);
  });

  test('400 when QBO not connected', async () => {
    pool.query
      .mockResolvedValueOnce(mockSettings())
      .mockResolvedValueOnce({ rows: [{ qbo_realm_id: null }] });

    const res = await request(makeApp())
      .post('/api/qbo/push-bills')
      .send({ from: '2026-04-01', to: '2026-04-30' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/QuickBooks not connected/);
  });

  test('creates one Bill per vendor and marks source rows', async () => {
    pool.query
      .mockResolvedValueOnce(mockSettings({ terms: 15 }))
      .mockResolvedValueOnce({ rows: [{ qbo_realm_id: 'realm-1' }] })
      .mockResolvedValueOnce(otOff())   // settings — the route loads these first now
      .mockResolvedValueOnce({ rows: [timeRow()] })
      .mockResolvedValueOnce({ rows: [reimbRow()] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });

    qbo.createBill.mockResolvedValueOnce({ Id: 'BILL-999' });

    const res = await request(makeApp())
      .post('/api/qbo/push-bills')
      .send({ from: '2026-04-01', to: '2026-04-30' });

    expect(res.status).toBe(200);
    expect(res.body.pushed).toHaveLength(1);
    expect(res.body.pushed[0]).toMatchObject({
      user_id: 10, full_name: 'Alex Rivera', bill_id: 'BILL-999',
      time_entries: 1, reimbursements: 1,
    });
    expect(res.body.skipped).toEqual([]);
    expect(qbo.createBill).toHaveBeenCalledTimes(1);
    const call = qbo.createBill.mock.calls[0][1];
    expect(call.vendorId).toBe('V-1');
    expect(call.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(call.lines).toHaveLength(2);
    expect(call.lines[0]).toMatchObject({ type: 'item',    itemId: 'ITEM-LABOR', qty: 8, unitPrice: 45 });
    expect(call.lines[1]).toMatchObject({ type: 'account', accountId: 'ACCT-42', amount: 25.5 });
  });

  test('skips a vendor when QBO createBill throws, does not mark rows', async () => {
    pool.query
      .mockResolvedValueOnce(mockSettings())
      .mockResolvedValueOnce({ rows: [{ qbo_realm_id: 'realm-1' }] })
      .mockResolvedValueOnce(otOff())   // settings — the route loads these first now
      .mockResolvedValueOnce({ rows: [timeRow()] })
      .mockResolvedValueOnce({ rows: [] });

    qbo.createBill.mockRejectedValueOnce(new Error('QBO validation failed: Item inactive'));

    const res = await request(makeApp())
      .post('/api/qbo/push-bills')
      .send({ from: '2026-04-01', to: '2026-04-30' });

    expect(res.status).toBe(200);
    expect(res.body.pushed).toEqual([]);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].reason).toMatch(/Item inactive/);
    // 5 reads (settings, realm, time, reimb, ot), 0 updates = 5 total
    expect(pool.query).toHaveBeenCalledTimes(5);
  });

  test('pushes an overtime premium line for OT hours', async () => {
    // 10h day, threshold 8, multiplier 1.5 → 2h OT premium at 0.5 × base.
    pool.query
      .mockResolvedValueOnce(mockSettings())
      .mockResolvedValueOnce({ rows: [{ qbo_realm_id: 'realm-1' }] })
      .mockResolvedValueOnce(otDaily({ threshold: 8, multiplier: 1.5 }))   // settings — the route loads these first now
      .mockResolvedValueOnce({ rows: [timeRow({ start_time: '08:00:00', end_time: '18:00:00' })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1 });

    qbo.createBill.mockResolvedValueOnce({ Id: 'BILL-OT-1' });

    const res = await request(makeApp())
      .post('/api/qbo/push-bills')
      .send({ from: '2026-04-01', to: '2026-04-30' });

    expect(res.status).toBe(200);
    const call = qbo.createBill.mock.calls[0][1];
    // 1 labor line for the entry + 1 OT premium line
    expect(call.lines).toHaveLength(2);
    expect(call.lines[0]).toMatchObject({ type: 'item', qty: 10, unitPrice: 45 });
    expect(call.lines[1]).toMatchObject({ type: 'item', qty: 2 });
    expect(call.lines[1].unitPrice).toBeCloseTo(45 * 0.5);
    expect(call.lines[1].description).toMatch(/Overtime premium/);
  });
});
