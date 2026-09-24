// Estimate expiry: an empty company_timezone setting resolves through the same company
// time-zone chain the pay code uses (companyTimezone), not UTC; and /convert no longer
// re-checks valid_until — expiry is enforced at ACCEPT time only.
let mockCurrentUser;
jest.mock('../middleware/auth', () => ({
  requireAuth:  (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireAdmin: (req, _res, next) => { req.user = mockCurrentUser; next(); },
}));
jest.mock('../middleware/commercialAccess', () => ({ requireCommercialAccess: (_req, _res, next) => next() }));
jest.mock('../db', () => {
  const q = jest.fn();
  return { query: q, connect: jest.fn().mockResolvedValue({ query: (...a) => q(...a), release: jest.fn() }) };
});
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../utils/rateHistoryStore', () => ({ companyTimezone: jest.fn(async () => 'Pacific/Pago_Pago') }));

const express = require('express');
const request = require('supertest');
const pool    = require('../db');
const { companyTimezone } = require('../utils/rateHistoryStore');
const estimatesRoute = require('../routes/estimates');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error: () => {}, warn: () => {} }; next(); });
  app.use('/api/estimates', estimatesRoute);
  app.use('/api/public/estimates', estimatesRoute.publicRouter);
  return app;
}

beforeEach(() => {
  pool.query.mockReset();
  mockCurrentUser = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'A' };
  // 05:00 UTC on 09-24 = still 09-23 in Pago Pago (UTC-11).
  jest.useFakeTimers({ now: new Date('2026-09-24T05:00:00Z'), doNotFake: [
    'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate',
    'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
});
afterEach(() => jest.useRealTimers());

test('public accept on the last valid local day succeeds when company_timezone is empty', async () => {
  pool.query
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({ rowCount: 1, rows: [{
      id: 42, company_id: 'co-1', status: 'sent', estimate_number: 'EST-1',
      valid_until_ymd: '2026-09-23', company_timezone: '',
    }] })
    .mockResolvedValue({ rowCount: 1, rows: [] });
  const res = await request(makeApp()).post('/api/public/estimates/accept/tok')
    .send({ typed_name: 'Jane', authorized: true });
  expect(companyTimezone).toHaveBeenCalledWith('co-1', expect.anything());
  expect(res.status).toBe(200);
  expect(pool.query.mock.calls.some(c => /SET status='expired'/.test(c[0]))).toBe(false);
});

test('convert of an estimate accepted before expiry is not blocked by valid_until', async () => {
  pool.query.mockImplementation(async (sql) => {
    if (/FROM estimates e WHERE e.id = \$1 AND e.company_id = \$2 FOR UPDATE/.test(sql)) {
      return { rowCount: 1, rows: [{ id: 42, company_id: 'co-1', status: 'accepted', estimate_number: 'EST-1',
        project_name: 'X', client_id: null, project_address: null, converted_project_id: null,
        valid_until_ymd: '2020-01-15', company_timezone: 'UTC' }] };
    }
    if (/INSERT INTO projects/.test(sql)) return { rowCount: 1, rows: [{ id: 900, name: 'X' }] };
    return { rowCount: 1, rows: [] };
  });
  const res = await request(makeApp()).post('/api/estimates/42/convert');
  expect(res.body.error || '').not.toMatch(/expired/i);
  expect(pool.query.mock.calls.some(c => /INSERT INTO projects/.test(c[0]))).toBe(true);
});
