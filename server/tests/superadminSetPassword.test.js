/**
 * Tests for POST /superadmin/users/:id/set-password — the superadmin direct
 * password-set handler. Verifies auth gating, 404, password validation, and
 * that the happy path hashes the password, forces a session logout
 * (token_version bump), and clears the must-change / reset-token flags.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-unit-tests-only';

jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));
// Auditing is best-effort and writes via pool; stub it so it doesn't perturb
// the pool.query call sequence we assert on.
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));

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

const USER_ID = 42;
const USER_ROW = { id: USER_ID, username: 'jdoe', full_name: 'Jane Doe', company_id: 'c1', role: 'admin' };

beforeEach(() => {
  pool.query.mockReset();
});

describe('POST /superadmin/users/:id/set-password', () => {
  test('rejects a non-superadmin caller', async () => {
    const res = await request(makeApp())
      .post(`/api/superadmin/users/${USER_ID}/set-password`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ password: 'brandNewPass9' });
    expect([401, 403]).toContain(res.status);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('404 when the user does not exist', async () => {
    pool.query.mockResolvedValueOnce(authRow); // requireAuth
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp())
      .post(`/api/superadmin/users/${USER_ID}/set-password`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ password: 'brandNewPass9' });
    expect(res.status).toBe(404);
    // auth + the lookup ran — no UPDATE.
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  test('400 when the password is too short', async () => {
    pool.query.mockResolvedValueOnce(authRow); // requireAuth
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [USER_ROW] });
    const res = await request(makeApp())
      .post(`/api/superadmin/users/${USER_ID}/set-password`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 8/i);
    expect(pool.query).toHaveBeenCalledTimes(2); // auth + lookup only, no UPDATE
  });

  test('400 when the password contains the username', async () => {
    pool.query.mockResolvedValueOnce(authRow); // requireAuth
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [USER_ROW] });
    const res = await request(makeApp())
      .post(`/api/superadmin/users/${USER_ID}/set-password`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ password: 'xxJDOExx99' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/username/i);
  });

  test('happy path: hashes, logs out sessions, clears must-change + reset token', async () => {
    pool.query
      .mockResolvedValueOnce(authRow)                          // requireAuth
      .mockResolvedValueOnce({ rowCount: 1, rows: [USER_ROW] }) // lookup
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });        // UPDATE
    const res = await request(makeApp())
      .post(`/api/superadmin/users/${USER_ID}/set-password`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ password: 'brandNewPass9' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.user).toEqual({ id: USER_ID, username: 'jdoe', full_name: 'Jane Doe' });

    const [updateSql, updateParams] = pool.query.mock.calls[2];
    expect(updateSql).toMatch(/UPDATE users/);
    expect(updateSql).toMatch(/token_version = COALESCE\(token_version, 0\) \+ 1/);
    expect(updateSql).toMatch(/must_change_password = false/);
    expect(updateSql).toMatch(/reset_token = NULL/);
    // First param is the bcrypt hash of the new password, not the plaintext.
    expect(updateParams[0]).toMatch(/^\$2[aby]\$/);
    expect(updateParams[0]).not.toContain('brandNewPass9');
    expect(updateParams[1]).toBe(USER_ID);
  });
});
