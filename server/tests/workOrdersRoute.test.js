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

describe('POST /api/work-orders', () => {
  test('creates a standalone work order with only a title', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 12, title: 'Service call' }] });

    const res = await request(makeApp())
      .post('/api/work-orders')
      .send({ title: 'Service call' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 12, title: 'Service call' });
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('rejects a project outside the company', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const res = await request(makeApp())
      .post('/api/work-orders')
      .send({ title: 'Service call', project_id: 99 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Project not found.');
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('rejects invalid foreign keys and negative amounts before querying', async () => {
    const badReference = await request(makeApp())
      .post('/api/work-orders')
      .send({ title: 'Service call', assigned_to: 'not-an-id' });
    const badAmount = await request(makeApp())
      .post('/api/work-orders')
      .send({ title: 'Service call', amount: -1 });

    expect(badReference.status).toBe(400);
    expect(badAmount.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
