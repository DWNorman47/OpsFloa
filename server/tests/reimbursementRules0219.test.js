/**
 * routes/reimbursements — review fixes (0219):
 *   - admin routes need manage_reimbursements and respect worker_access_ids
 *   - status machine: pending→approved|rejected, rejected→pending, approved→pending
 *     only when not in QuickBooks and not in a locked period / finalized payroll run
 *   - a worker may delete only a pending expense that was never pushed to QuickBooks
 *   - receipts: allow-listed types only, company-scoped keys (r2.uploadReceiptBase64)
 */
process.env.R2_PUBLIC_URL = 'https://cdn.example.com';

let mockCurrentUser;
jest.mock('../middleware/auth', () => ({
  requireAuth:  (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireAdmin: (req, res, next) => {
    req.user = mockCurrentUser;
    if (!['admin', 'super_admin'].includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
    next();
  },
}));
jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../services/qbo', () => ({ createPurchase: jest.fn() }));
jest.mock('../storage', () => ({
  checkStorageLimit: jest.fn(async () => ({ allowed: true })),
  incrementStorage: jest.fn(async () => {}),
  decrementStorage: jest.fn(async () => {}),
}));
jest.mock('./../routes/admin', () => ({
  getAdvancedSettings: jest.fn(async () => ({ mileage_rate: { rate: 0.5 }, reimbursement_categories: { defaults: [], suppressed: [], custom: [] } })),
  ADVANCED_DEFAULTS: {},
}));
const mockSend = jest.fn(async () => ({}));
jest.mock('@aws-sdk/client-s3', () => {
  const cmd = (name) => function (input) { this.name = name; this.input = input; };
  return {
    S3Client: function () { this.send = (...a) => mockSend(...a); },
    PutObjectCommand: cmd('Put'), DeleteObjectCommand: cmd('Delete'), HeadObjectCommand: cmd('Head'),
    GetObjectCommand: cmd('Get'), ListObjectsV2Command: cmd('List'),
  };
});
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const r2 = require('../r2');
const router = require('../routes/reimbursements');

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  // index.js mounts this router behind requireAuth
  app.use((req, _res, next) => { req.log = { error: () => {} }; req.user = mockCurrentUser; next(); });
  app.use('/api/reimbursements', router);
  return app;
}
const ADMIN = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'Boss' };
const WORKER = { id: 5, company_id: 'co-1', role: 'worker', full_name: 'Wendy' };

let calls;
function route(handlers) {
  calls = [];
  pool.query.mockImplementation(async (sql, params) => {
    calls.push({ sql, params });
    for (const [re, fn] of handlers) if (re.test(sql)) return fn(sql, params);
    return { rowCount: 0, rows: [] };
  });
}
const sqlCalls = re => calls.filter(c => re.test(c.sql));
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

beforeEach(() => { pool.query.mockReset(); mockSend.mockClear(); mockCurrentUser = ADMIN; });

describe('r2 receipt helpers', () => {
  test.each([
    ['image/jpeg', true], ['image/png', true], ['image/webp', true], ['image/heic', true], ['image/heif', true], ['application/pdf', true],
    ['text/html', false], ['image/svg+xml', false], ['application/javascript', false], ['image/gif', false],
  ])('%s allowed=%s', (mime, ok) => {
    expect(r2.isAllowedReceiptDataUrl(`data:${mime};base64,AAAA`)).toBe(ok);
  });

  test('non-data URLs are not receipts', () => {
    expect(r2.isAllowedReceiptDataUrl('https://evil.example/x.png')).toBe(false);
  });

  test('keys are receipts/<companyId>/<uuid>.<ext>, ext from the allow-list', async () => {
    const out = await r2.uploadReceiptBase64('data:application/pdf;base64,JVBERi0=', '6f1c2d3e-aaaa-bbbb-cccc-000000000001');
    expect(out.key).toMatch(/^receipts\/6f1c2d3e-aaaa-bbbb-cccc-000000000001\/[0-9a-f-]{36}\.pdf$/);
    expect(out.url).toBe(`https://cdn.example.com/${out.key}`);
    expect(mockSend.mock.calls[0][0].input).toMatchObject({ Key: out.key, ContentType: 'application/pdf' });
  });

  test('a disallowed type throws a 400-style error without uploading', async () => {
    await expect(r2.uploadReceiptBase64('data:text/html;base64,PGI+', 'co-1')).rejects.toMatchObject({ status: 400, code: 'receipt_type_not_allowed' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('legacy flat receipt URLs still resolve to a key (readable / deletable)', () => {
    expect(r2.keyFromPublicUrl('https://cdn.example.com/receipts/abc.jpg')).toBe('receipts/abc.jpg');
  });
});

describe('receipt uploads through the routes', () => {
  test('worker submit with an HTML "receipt" → 400, nothing stored', async () => {
    mockCurrentUser = WORKER;
    route([]);
    const res = await request(makeApp()).post('/api/reimbursements').send({ expense_date: '2026-09-01', amount: 10, receipt: 'data:text/html;base64,PGI+' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('receipt_type_not_allowed');
    expect(mockSend).not.toHaveBeenCalled();
    expect(sqlCalls(/INSERT/)).toHaveLength(0);
  });

  test('worker submit with a PNG → stored under the company prefix', async () => {
    mockCurrentUser = WORKER;
    route([[/INSERT INTO reimbursements/, (_s, p) => ({ rows: [{ id: 'r1', receipt_url: p[6] }] })]]);
    const res = await request(makeApp()).post('/api/reimbursements').send({ expense_date: '2026-09-01', amount: 10, receipt: PNG });
    expect(res.status).toBe(201);
    expect(res.body.receipt_url).toMatch(/^https:\/\/cdn\.example\.com\/receipts\/co-1\/[0-9a-f-]{36}\.png$/);
  });

  test('admin submit rejects a disallowed receipt too', async () => {
    route([]);
    const res = await request(makeApp()).post('/api/reimbursements/admin').send({ user_id: 5, expense_date: '2026-09-01', amount: 10, receipt: 'data:image/svg+xml;base64,PHN2Zz4=' });
    expect(res.status).toBe(400);
  });
});

describe('worker DELETE', () => {
  test('only pending and never after a QuickBooks push', async () => {
    mockCurrentUser = WORKER;
    route([[/DELETE FROM reimbursements/, () => ({ rows: [] })]]);
    const res = await request(makeApp()).delete('/api/reimbursements/r1');
    expect(res.status).toBe(404);
    const sql = sqlCalls(/DELETE FROM reimbursements/)[0].sql;
    expect(sql).toMatch(/status = 'pending'/);
    expect(sql).toMatch(/qbo_purchase_id IS NULL AND qbo_bill_id IS NULL/);
  });
});

describe('admin permissions + scope', () => {
  test('an admin role without manage_reimbursements → 403 on every admin route', async () => {
    mockCurrentUser = { ...ADMIN, role_id: 12 };
    route([[/FROM role_permissions/, () => ({ rows: [{ permission: 'approve_entries' }] })]]);
    for (const [m, p] of [['get', '/api/reimbursements/admin'], ['post', '/api/reimbursements/admin'], ['patch', '/api/reimbursements/admin/r1']]) {
      const res = await request(makeApp())[m](p).send({ status: 'approved' });
      expect(res.status).toBe(403);
      expect(res.body.required).toBe('manage_reimbursements');
    }
    expect(sqlCalls(/reimbursements/)).toHaveLength(0);
  });

  test('the admin list is scoped to worker_access_ids', async () => {
    mockCurrentUser = { ...ADMIN, worker_access_ids: [5] };
    route([[/FROM reimbursements r/, () => ({ rows: [] })]]);
    await request(makeApp()).get('/api/reimbursements/admin');
    const q = sqlCalls(/FROM reimbursements r/)[0];
    expect(q.sql).toMatch(/r\.user_id = ANY\(\$2::int\[\]\)/);
    expect(q.params).toEqual(['co-1', [5]]);
  });

  test('a partial admin cannot approve / create for a worker outside scope', async () => {
    mockCurrentUser = { ...ADMIN, worker_access_ids: [2] };
    route([[/SELECT updated_at, status/, () => ({ rows: [{ status: 'pending', user_id: 5, expense_date: '2026-09-01' }] })]]);
    const a = await request(makeApp()).patch('/api/reimbursements/admin/r1').send({ status: 'approved' });
    expect(a.status).toBe(403);
    const b = await request(makeApp()).post('/api/reimbursements/admin').send({ user_id: 5, expense_date: '2026-09-01', amount: 3 });
    expect(b.status).toBe(403);
    expect(sqlCalls(/UPDATE|INSERT/)).toHaveLength(0);
  });
});

describe('admin status machine', () => {
  const cur = (over) => ({ updated_at: new Date('2026-09-01T00:00:00Z'), status: 'pending', user_id: 5, expense_date: '2026-09-01', qbo_purchase_id: null, qbo_bill_id: null, ...over });
  const setup = (row, { settled = false } = {}) => route([
    [/SELECT updated_at, status/, () => ({ rows: [row] })],
    [/FROM pay_periods/, () => ({ rows: settled ? [{ kind: settled }] : [] })],
    [/UPDATE reimbursements/, (_s, p) => ({ rows: [{ id: 'r1', status: p[0], user_id: 5, amount: '10.00' }] })],
  ]);
  const patch = (status) => request(makeApp()).patch('/api/reimbursements/admin/r1').send({ status });

  test.each([
    ['pending', 'approved'], ['pending', 'rejected'], ['rejected', 'pending'], ['approved', 'pending'], ['approved', 'approved'],
  ])('%s → %s allowed', async (from, to) => {
    setup(cur({ status: from }));
    const res = await patch(to);
    expect(res.status).toBe(200);
    const upd = sqlCalls(/UPDATE reimbursements/)[0];
    expect(upd.sql).toMatch(/AND status = \$5/);
    expect(upd.params[4]).toBe(from);
  });

  test.each([['approved', 'rejected'], ['rejected', 'approved']])('%s → %s refused (409 invalid_transition)', async (from, to) => {
    setup(cur({ status: from }));
    const res = await patch(to);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('invalid_transition');
    expect(sqlCalls(/UPDATE reimbursements/)).toHaveLength(0);
  });

  test.each([['qbo_purchase_id'], ['qbo_bill_id']])('approved → pending refused once %s is set', async (col) => {
    setup(cur({ status: 'approved', [col]: '123' }));
    const res = await patch('pending');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('in_quickbooks');
  });

  test('approved → pending refused in a locked period / finalized payroll run', async () => {
    setup(cur({ status: 'approved' }), { settled: 'payroll_run' });
    const res = await patch('pending');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'period_locked', reason: 'payroll_run' });
    const q = sqlCalls(/FROM pay_periods/)[0];
    expect(q.sql).toMatch(/payroll_runs/);
    expect(q.sql).toMatch(/r\.status = 'finalized'/);
    expect(q.params).toEqual(['co-1', 5, '2026-09-01']);
  });

  test('a lost race (status changed underneath) → 409', async () => {
    route([
      [/SELECT updated_at, status/, () => ({ rows: [cur({ status: 'pending' })] })],
      [/UPDATE reimbursements/, () => ({ rows: [] })],
    ]);
    const res = await patch('approved');
    expect(res.status).toBe(409);
  });
});
