let mockCurrentUser;

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => {
    req.user = mockCurrentUser;
    next();
  },
}));
jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../push', () => ({
  sendPushToUser: jest.fn(),
  sendPushToCompanyAdmins: jest.fn(),
}));
jest.mock('../routes/inbox', () => ({
  createInboxItem: jest.fn(),
}));
jest.mock('../email', () => ({ sendEmail: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../failureLog', () => ({ logFailure: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const { sendPushToUser } = require('../push');
const { createInboxItem } = require('../routes/inbox');
const timeEntries = require('../routes/timeEntries');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.log = { error: jest.fn() };
    next();
  });
  app.use('/api/time-entries', timeEntries);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCurrentUser = {
    id: 7,
    company_id: 'co-1',
    full_name: 'Worker Seven',
    role: 'worker',
  };
});

test('entry list applies a validated date range to the worker query', async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [{ plan: 'business', subscription_status: 'active' }] })
    .mockResolvedValueOnce({ rows: [{ id: 12, work_date: '2026-07-29' }] });

  const res = await request(makeApp())
    .get('/api/time-entries?from=2026-07-27&to=2026-08-02');

  expect(res.status).toBe(200);
  expect(res.body).toHaveLength(1);
  expect(pool.query.mock.calls[1][0]).toContain('te.work_date BETWEEN $2 AND $3');
  expect(pool.query.mock.calls[1][1]).toEqual([7, '2026-07-27', '2026-08-02']);
});

test('entry list rejects incomplete or reversed date ranges before querying', async () => {
  const incomplete = await request(makeApp())
    .get('/api/time-entries?from=2026-07-27');
  const reversed = await request(makeApp())
    .get('/api/time-entries?from=2026-08-02&to=2026-07-27');

  expect(incomplete.status).toBe(400);
  expect(reversed.status).toBe(400);
  expect(pool.query).not.toHaveBeenCalled();
});

test('zero-entry sign-off does not notify an admin', async () => {
  pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

  const res = await request(makeApp())
    .post('/api/time-entries/sign-off')
    .send({ from: '2026-07-27', to: '2026-08-02' });

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ signed: 0 });
  expect(pool.query).toHaveBeenCalledTimes(1);
  expect(sendPushToUser).not.toHaveBeenCalled();
  expect(createInboxItem).not.toHaveBeenCalled();
});

test('successful sign-off notifies one active admin', async () => {
  pool.query
    .mockResolvedValueOnce({ rowCount: 2, rows: [{ id: 1 }, { id: 2 }] })
    .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 99 }] });

  const res = await request(makeApp())
    .post('/api/time-entries/sign-off')
    .send({ from: '2026-07-27', to: '2026-08-02' });

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ signed: 2 });
  expect(sendPushToUser).toHaveBeenCalledWith(
    99,
    expect.objectContaining({ body: '2 entries ready for review' })
  );
  expect(createInboxItem).toHaveBeenCalledTimes(1);
});
