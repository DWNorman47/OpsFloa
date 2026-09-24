// GET /superadmin/companies must not join users × time_entries (row explosion: every user
// row multiplied by every entry row, then COUNT DISTINCT). Counts come from per-company
// LATERAL subqueries instead.
process.env.JWT_SECRET = 'test-jwt-secret-for-unit-tests-only';
jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const pool = require('../db');

const superAdminToken = jwt.sign(
  { id: 1, role: 'super_admin', company_id: null, username: 'root', tv: 0 },
  process.env.JWT_SECRET
);
const authRow = { rows: [{ token_version: 0, active: true }] };

function makeApp() {
  const app = express();
  app.use('/api/superadmin', require('../routes/superadmin'));
  return app;
}
beforeEach(() => pool.query.mockReset());

test('companies list uses per-company subqueries, no users×time_entries join', async () => {
  pool.query.mockResolvedValueOnce(authRow).mockResolvedValueOnce({ rows: [{ id: 'c1', worker_count: 3 }] });
  const res = await request(makeApp()).get('/api/superadmin/companies').set('Authorization', `Bearer ${superAdminToken}`);
  expect(res.status).toBe(200);
  expect(res.body).toEqual([{ id: 'c1', worker_count: 3 }]);
  const sql = pool.query.mock.calls[1][0];
  expect(sql).not.toMatch(/LEFT JOIN users u ON u\.company_id = c\.id/);
  expect(sql).not.toMatch(/LEFT JOIN time_entries te ON te\.company_id = c\.id/);
  expect(sql).toMatch(/LATERAL/);
  expect(sql).not.toMatch(/GROUP BY c\.id/);
  for (const col of ['worker_count', 'admin_count', 'entry_count', 'last_entry_at', 'affiliate_name']) {
    expect(sql).toMatch(new RegExp(col));
  }
});
