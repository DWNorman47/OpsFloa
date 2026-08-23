/**
 * Tests for the bonus_seats field on PATCH /superadmin/companies/:id — the
 * complimentary-seat grant. Verifies auth gating, integer validation, and that
 * a valid value writes bonus_seats.
 */

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
// requireAuth's tv-token check reads token_version + active; it is call index 0.
const authRow = { rows: [{ token_version: 0, active: true }] };
const adminToken = jwt.sign(
  { id: 2, role: 'admin', company_id: 'c1', username: 'boss' },
  process.env.JWT_SECRET
);

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/superadmin', require('../routes/superadmin'));
  return app;
}

const COMPANY_ID = '9fccf20b-8150-4e35-8e62-01d3c341628a';

beforeEach(() => {
  pool.query.mockReset();
});

describe('PATCH /superadmin/companies/:id bonus_seats', () => {
  test('rejects a non-superadmin caller', async () => {
    const res = await request(makeApp())
      .patch(`/api/superadmin/companies/${COMPANY_ID}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ bonus_seats: 5 });
    expect([401, 403]).toContain(res.status);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('400 on a negative value', async () => {
    pool.query.mockResolvedValueOnce(authRow); // requireAuth
    const res = await request(makeApp())
      .patch(`/api/superadmin/companies/${COMPANY_ID}`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ bonus_seats: -1 });
    expect(res.status).toBe(400);
    expect(pool.query).toHaveBeenCalledTimes(1); // only the auth check — no route write
  });

  test('400 on a non-integer value', async () => {
    pool.query.mockResolvedValueOnce(authRow); // requireAuth
    const res = await request(makeApp())
      .patch(`/api/superadmin/companies/${COMPANY_ID}`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ bonus_seats: 3.5 });
    expect(res.status).toBe(400);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('writes bonus_seats on a valid value', async () => {
    pool.query.mockResolvedValueOnce(authRow); // requireAuth
    pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: COMPANY_ID, name: 'Acme', bonus_seats: 5 }],
    });
    const res = await request(makeApp())
      .patch(`/api/superadmin/companies/${COMPANY_ID}`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ bonus_seats: 5 });
    expect(res.status).toBe(200);
    expect(res.body.bonus_seats).toBe(5);

    const [sql, params] = pool.query.mock.calls[1];
    expect(sql).toMatch(/bonus_seats = \$1/);
    expect(sql).toMatch(/RETURNING[\s\S]*bonus_seats/);
    expect(params).toEqual([5, COMPANY_ID]);
  });
});
