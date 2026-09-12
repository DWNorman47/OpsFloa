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
const adminToken = jwt.sign(
  { id: 2, role: 'admin', company_id: 'c1', username: 'boss' },
  process.env.JWT_SECRET
);
const authRow = { rows: [{ token_version: 0, active: true }] };

function makeApp() {
  const app = express();
  app.use('/api/superadmin', require('../routes/superadmin'));
  return app;
}

beforeEach(() => pool.query.mockReset());

describe('GET /superadmin/activation-funnel', () => {
  test('requires a super admin', async () => {
    const res = await request(makeApp())
      .get('/api/superadmin/activation-funnel')
      .set('Authorization', `Bearer ${adminToken}`);
    expect([401, 403]).toContain(res.status);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('rejects unsupported ranges before querying the funnel', async () => {
    pool.query.mockResolvedValueOnce(authRow);
    const res = await request(makeApp())
      .get('/api/superadmin/activation-funnel?days=999')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(res.status).toBe(400);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test.each([['', 30], ['?days=90', 90], ['?days=365', 365]])(
    'returns numeric aggregate counts for %s', async (query, days) => {
      pool.query.mockResolvedValueOnce(authRow);
      pool.query.mockResolvedValueOnce({ rows: [{
        signed_up: '8', confirmed: '7', project_created: '6', clocked_in: '4', approved_time: '2',
      }] });
      const res = await request(makeApp())
        .get(`/api/superadmin/activation-funnel${query}`)
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ days, counts: {
        signed_up: 8, confirmed: 7, project_created: 6, clocked_in: 4, approved_time: 2,
      } });
      const [sql, params] = pool.query.mock.calls[1];
      expect(params).toEqual([days]);
      expect(sql).toMatch(/c\.is_demo = false/);
      expect(sql).toMatch(/la\.context = 'signup'/);
      expect(sql).toMatch(/u\.email_confirmed = true/);
      expect(sql).toMatch(/clock_source IN \('worker', 'admin'\)/);
      expect(sql).toMatch(/te\.start_time <> te\.end_time/);
      expect(sql).toMatch(/te\.status = 'approved' AND te\.approved_at IS NOT NULL/);
      expect(sql).toMatch(/WHERE confirmed AND has_project AND has_clock_in AND has_approval/);
    }
  );
});
