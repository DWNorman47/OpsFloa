/**
 * POST /equipment/:id/return must close ONLY the checkout the client referenced (checkout_id),
 * 409 when that checkout is already closed, dedupe an offline replay via Idempotency-Key, and
 * upload the return photo only after the checks pass (no orphaned R2 objects).
 */
let mockUser;
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = mockUser; next(); },
  requireAdmin: (req, _res, next) => { req.user = mockUser; next(); },
}));
jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../r2', () => ({ uploadBase64: jest.fn(async () => ({ url: 'https://r2/photo.jpg' })) }));
jest.mock('../utils/projectCost', () => ({ projectFrozen: jest.fn(async () => false) }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const { uploadBase64 } = require('../r2');
const equipment = require('../routes/equipment');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error: () => {} }; next(); });
  app.use('/api/equipment', equipment);
  return app;
}
const KEY = 'ret-key-1';
const PHOTO = 'data:image/png;base64,AAAA';

let client;
beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockReset();
  pool.connect.mockReset();
  mockUser = { id: 7, company_id: 'co-1', full_name: 'W', role: 'worker' };
  client = { query: jest.fn(async (sql) => {
    if (/UPDATE equipment_checkouts/.test(sql)) return { rowCount: 1, rows: [{ id: 11, returned_at: 'now' }] };
    return { rowCount: 1, rows: [] };
  }), release: jest.fn() };
  pool.connect.mockResolvedValue(client);
});

test('400 when checkout_id is missing and the caller has no single open checkout', async () => {
  pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // back-compat lookup finds nothing
  const res = await request(makeApp()).post('/api/equipment/3/return').send({});
  expect(res.status).toBe(400);
  expect(res.body.code).toBe('checkout_id_required');
  expect(uploadBase64).not.toHaveBeenCalled();
});

test('400 when the back-compat lookup is ambiguous (two open checkouts)', async () => {
  pool.query.mockResolvedValueOnce({ rowCount: 2, rows: [{ id: 11 }, { id: 12 }] });
  const res = await request(makeApp()).post('/api/equipment/3/return').send({});
  expect(res.status).toBe(400);
});

test("old-client return without checkout_id closes the caller's own single open checkout", async () => {
  pool.query
    .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 11 }] }) // back-compat lookup
    .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 11, asset_id: 3, returned_at: null, return_request_id: null }] });
  const res = await request(makeApp()).post('/api/equipment/3/return').send({});
  expect(res.status).toBe(200);
  expect(pool.query.mock.calls[0][0]).toMatch(/user_id=\$3 OR checked_out_by=\$3/);
  const upd = client.query.mock.calls.find(c => /UPDATE equipment_checkouts/.test(c[0]));
  expect(upd[1][0]).toBe(11);
});

test('closes only the referenced checkout (UPDATE keyed by checkout id)', async () => {
  pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 11, asset_id: 3, returned_at: null, return_request_id: null }] });
  const res = await request(makeApp()).post('/api/equipment/3/return')
    .set('Idempotency-Key', KEY).send({ checkout_id: 11, return_photo: PHOTO });
  expect(res.status).toBe(200);
  const upd = client.query.mock.calls.find(c => /UPDATE equipment_checkouts/.test(c[0]));
  expect(upd[0]).toMatch(/WHERE id=\$1/);
  expect(upd[0]).toMatch(/returned_at IS NULL/);
  expect(upd[1][0]).toBe(11);
  expect(upd[1]).toContain(KEY);
  expect(uploadBase64).toHaveBeenCalledTimes(1);
});

test('409 (and no photo upload) when the referenced checkout is already closed by someone else', async () => {
  pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 11, asset_id: 3, returned_at: '2026-01-01', return_request_id: 'other' }] });
  const res = await request(makeApp()).post('/api/equipment/3/return')
    .set('Idempotency-Key', KEY).send({ checkout_id: 11, return_photo: PHOTO });
  expect(res.status).toBe(409);
  expect(res.body.code).toBe('already_returned');
  expect(uploadBase64).not.toHaveBeenCalled();
  expect(pool.connect).not.toHaveBeenCalled();
});

test('offline replay of a return that already went through → 200 with the row, no upload', async () => {
  pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 11, asset_id: 3, returned_at: '2026-01-01', return_request_id: KEY }] });
  const res = await request(makeApp()).post('/api/equipment/3/return')
    .set('Idempotency-Key', KEY).send({ checkout_id: 11, return_photo: PHOTO });
  expect(res.status).toBe(200);
  expect(res.body.id).toBe(11);
  expect(uploadBase64).not.toHaveBeenCalled();
});

test('404 when the checkout does not belong to this asset/company', async () => {
  pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
  const res = await request(makeApp()).post('/api/equipment/3/return').send({ checkout_id: 99, return_photo: PHOTO });
  expect(res.status).toBe(404);
  expect(uploadBase64).not.toHaveBeenCalled();
});

test('409 when the checkout closes concurrently between the check and the UPDATE', async () => {
  pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 11, asset_id: 3, returned_at: null }] });
  client.query = jest.fn(async (sql) => (/UPDATE equipment_checkouts/.test(sql) ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [] }));
  const res = await request(makeApp()).post('/api/equipment/3/return').send({ checkout_id: 11 });
  expect(res.status).toBe(409);
  expect(res.body.code).toBe('already_returned');
  expect(client.query.mock.calls.map(c => c[0])).toContain('ROLLBACK');
});
