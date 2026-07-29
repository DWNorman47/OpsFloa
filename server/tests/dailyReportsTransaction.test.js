let mockCurrentUser;

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireAdmin: (req, _res, next) => { req.user = mockCurrentUser; next(); },
}));
jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const dailyReports = require('../routes/dailyReports');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error: jest.fn() }; next(); });
  app.use('/api/daily-reports', dailyReports);
  return app;
}

beforeEach(() => {
  pool.query.mockReset();
  pool.connect.mockReset();
  mockCurrentUser = { id: 7, company_id: 'co-1', role: 'worker' };
});

test('rolls back before releasing the client when an update target is missing', async () => {
  const client = {
    query: jest.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({}),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValueOnce(client);

  const res = await request(makeApp())
    .patch('/api/daily-reports/999')
    .send({ work_performed: 'nothing' });

  expect(res.status).toBe(404);
  expect(client.query.mock.calls.map(call => call[0])).toEqual([
    'BEGIN',
    'SELECT * FROM daily_reports WHERE id=$1 AND company_id=$2',
    'ROLLBACK',
  ]);
  expect(client.release).toHaveBeenCalledTimes(1);
});
