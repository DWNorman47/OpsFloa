// Void resets the linked payment's waiver_received (in one TX) unless another signed/received
// waiver still covers it; convert-unconditional only from a signed/received conditional.
let mockCurrentUser;
jest.mock('../middleware/auth', () => ({
  requireAuth:  (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireAdmin: (req, _res, next) => { req.user = mockCurrentUser; next(); },
}));
jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool    = require('../db');
const route   = require('../routes/lienWaivers');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error: () => {} }; next(); });
  app.use('/api', route);
  return app;
}

let client;
beforeEach(() => {
  pool.query.mockReset();
  pool.connect.mockReset();
  mockCurrentUser = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'Admin' };
  client = { query: jest.fn(async (sql) => {
    if (/FOR UPDATE/.test(sql)) return { rowCount: 1, rows: [{ id: 5, status: 'received', sub_payment_id: 77 }] };
    return { rowCount: 1, rows: [] };
  }), release: jest.fn() };
  pool.connect.mockResolvedValue(client);
});

describe('POST /lien-waivers/:id/void', () => {
  test('voids and resets waiver_received in the same transaction, guarded by other in-hand waivers', async () => {
    const res = await request(makeApp()).post('/api/lien-waivers/5/void');
    expect(res.status).toBe(200);
    const sqls = client.query.mock.calls.map(c => c[0]);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls.some(s => /UPDATE lien_waivers SET status='void'/.test(s))).toBe(true);
    const reset = client.query.mock.calls.find(c => /waiver_received = false/.test(c[0]));
    expect(reset).toBeTruthy();
    expect(reset[0]).toMatch(/NOT EXISTS/);
    expect(reset[0]).toMatch(/status IN \('signed', 'received'\)/);
    expect(reset[1]).toEqual(expect.arrayContaining([77, 5]));
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
  });

  test('no payment link → no flag reset', async () => {
    client.query = jest.fn(async (sql) => (/FOR UPDATE/.test(sql)
      ? { rowCount: 1, rows: [{ id: 5, status: 'signed', sub_payment_id: null }] } : { rowCount: 1, rows: [] }));
    const res = await request(makeApp()).post('/api/lien-waivers/5/void');
    expect(res.status).toBe(200);
    expect(client.query.mock.calls.some(c => /waiver_received/.test(c[0]))).toBe(false);
  });

  test('409 when already void; 404 when missing', async () => {
    client.query = jest.fn(async (sql) => (/FOR UPDATE/.test(sql)
      ? { rowCount: 1, rows: [{ id: 5, status: 'void', sub_payment_id: 77 }] } : { rowCount: 1, rows: [] }));
    expect((await request(makeApp()).post('/api/lien-waivers/5/void')).status).toBe(409);
    client.query = jest.fn(async (sql) => (/FOR UPDATE/.test(sql) ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [] }));
    expect((await request(makeApp()).post('/api/lien-waivers/5/void')).status).toBe(404);
  });
});

describe('POST /lien-waivers/:id/convert-unconditional', () => {
  test.each(['draft', 'sent', 'void', 'superseded'])('409 from status %s', async (status) => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 5, waiver_type: 'conditional_progress', status }] });
    const res = await request(makeApp()).post('/api/lien-waivers/5/convert-unconditional');
    expect(res.status).toBe(409);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test.each(['signed', 'received'])('201 from status %s', async (status) => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 5, waiver_type: 'conditional_progress', status }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 6 }] });
    const res = await request(makeApp()).post('/api/lien-waivers/5/convert-unconditional');
    expect(res.status).toBe(201);
  });
});
