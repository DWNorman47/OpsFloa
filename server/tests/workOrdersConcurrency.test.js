// PATCH /work-orders/:id: partial update (only fields sent), optimistic updated_at check in
// the UPDATE WHERE → 409 with the fresh row, so a manager's stale save can't revert a tech's
// completion.
let mockCurrentUser;
jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../permissions', () => ({
  hasPerm: jest.fn().mockResolvedValue(true),
  requirePerm: () => (req, _res, next) => next(),
}));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const workOrders = require('../routes/workOrders');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = mockCurrentUser; next(); });
  app.use('/api/work-orders', workOrders);
  return app;
}
beforeEach(() => {
  pool.query.mockReset();
  mockCurrentUser = { id: 1, company_id: 'co-1', role: 'admin' };
});

const TS = '2026-09-20T15:00:00.000Z';

test('only the sent fields are written (status untouched when not sent)', async () => {
  pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 3, priority: 'high', status: 'completed' }] });
  const res = await request(makeApp()).patch('/api/work-orders/3').send({ priority: 'high', updated_at: TS });
  expect(res.status).toBe(200);
  const [sql, params] = pool.query.mock.calls[0];
  expect(sql).toMatch(/priority=\$/);
  expect(sql).not.toMatch(/status=\$/);
  expect(sql).not.toMatch(/title=\$/);
  expect(sql).toMatch(/date_trunc\('milliseconds', updated_at\)/);
  expect(params).toContain('high');
  expect(params).toContain(TS);
});

test('409 with the fresh row when updated_at is stale', async () => {
  pool.query
    .mockResolvedValueOnce({ rowCount: 0, rows: [] })                                         // guarded UPDATE
    .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 3, status: 'completed', updated_at: 'x' }] }); // fresh
  const res = await request(makeApp()).patch('/api/work-orders/3').send({ status: 'scheduled', updated_at: TS });
  expect(res.status).toBe(409);
  expect(res.body.current).toMatchObject({ id: 3, status: 'completed' });
});

test('404 when the row does not exist', async () => {
  pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] }).mockResolvedValueOnce({ rowCount: 0, rows: [] });
  const res = await request(makeApp()).patch('/api/work-orders/3').send({ title: 'x', updated_at: TS });
  expect(res.status).toBe(404);
});

test('status change in a partial update stamps/clears completed_at', async () => {
  pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 3 }] });
  await request(makeApp()).patch('/api/work-orders/3').send({ status: 'completed' });
  expect(pool.query.mock.calls[0][0]).toMatch(/completed_at = CASE/);
});

test('400 on a blank title or invalid status when sent; 400 on a bad updated_at', async () => {
  expect((await request(makeApp()).patch('/api/work-orders/3').send({ title: '  ' })).status).toBe(400);
  expect((await request(makeApp()).patch('/api/work-orders/3').send({ status: 'bogus' })).status).toBe(400);
  expect((await request(makeApp()).patch('/api/work-orders/3').send({ title: 'x', updated_at: 'nope' })).status).toBe(400);
  expect(pool.query).not.toHaveBeenCalled();
});

test('400 when nothing to update', async () => {
  expect((await request(makeApp()).patch('/api/work-orders/3').send({ updated_at: TS })).status).toBe(400);
});
