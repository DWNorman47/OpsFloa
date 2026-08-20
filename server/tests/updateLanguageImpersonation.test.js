/**
 * POST /auth/update-language must NOT write to the profile during a super-admin
 * "Login as" session. The impersonation JWT carries `imp: true`; the route then
 * echoes success (so the client still flips its own display) but skips the
 * UPDATE, leaving the impersonated user's saved language untouched.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-unit-tests-only';

jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../email', () => ({ sendEmail: jest.fn(() => Promise.resolve()) }));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const pool = require('../db');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  return app;
}

// The normal token omits `tv` so requireAuth skips the token_version lookup —
// this isolates the impersonation gate. The imp tokens DO hit the DB now:
// requireAuth re-checks the impersonated user is active and (when imp_by is
// present) that the super-admin who started the session is still active +
// super_admin. `didUpdateLanguage()` isolates the route's own write from that
// auth-check query.
const normalToken = jwt.sign({ id: 42, role: 'worker', company_id: 'c1', username: 'ana', tv: 0 }, process.env.JWT_SECRET);
// requireAuth's normal-session check (tv token) reads token_version + active.
const authOkNormal = { rows: [{ token_version: 0, active: true }] };
const impToken = jwt.sign({ id: 42, role: 'worker', company_id: 'c1', username: 'ana', imp: true }, process.env.JWT_SECRET);
const impByToken = jwt.sign({ id: 42, role: 'worker', company_id: 'c1', username: 'ana', imp: true, imp_by: 7 }, process.env.JWT_SECRET);

// requireAuth's impersonation active-check returns these three columns.
const authOk = { rows: [{ target_active: true, imp_active: true, imp_role: 'super_admin' }] };
const didUpdateLanguage = () => pool.query.mock.calls.some(c => /UPDATE users SET language/.test(c[0]));

beforeEach(() => { pool.query.mockReset(); });

describe('POST /auth/update-language', () => {
  test('a normal session persists the language to the profile', async () => {
    pool.query.mockResolvedValueOnce(authOkNormal);   // requireAuth tv check
    pool.query.mockResolvedValueOnce({ rowCount: 1 }); // the language UPDATE
    const res = await request(makeApp())
      .post('/api/auth/update-language')
      .set('Authorization', `Bearer ${normalToken}`)
      .send({ language: 'English' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, language: 'English', persisted: true });
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[1][0]).toMatch(/UPDATE users SET language/);
    expect(pool.query.mock.calls[1][1]).toEqual(['English', 42]);
  });

  test('an impersonation session does NOT write to the profile', async () => {
    pool.query.mockResolvedValue(authOk); // only the requireAuth active-check runs
    const res = await request(makeApp())
      .post('/api/auth/update-language')
      .set('Authorization', `Bearer ${impToken}`)
      .send({ language: 'English' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, language: 'English', persisted: false });
    // The Spanish profile is left exactly as it was — no UPDATE.
    expect(didUpdateLanguage()).toBe(false);
  });

  test('a blank language is still rejected under impersonation', async () => {
    pool.query.mockResolvedValue(authOk);
    const res = await request(makeApp())
      .post('/api/auth/update-language')
      .set('Authorization', `Bearer ${impToken}`)
      .send({ language: '   ' });
    expect(res.status).toBe(400);
    expect(didUpdateLanguage()).toBe(false);
  });

  test('rejects the session when the impersonated user has been deactivated', async () => {
    pool.query.mockResolvedValue({ rows: [{ target_active: false, imp_active: true, imp_role: 'super_admin' }] });
    const res = await request(makeApp())
      .post('/api/auth/update-language')
      .set('Authorization', `Bearer ${impByToken}`)
      .send({ language: 'English' });
    expect(res.status).toBe(401);
    expect(didUpdateLanguage()).toBe(false);
  });

  test('rejects the session when the super-admin who started it is deactivated', async () => {
    pool.query.mockResolvedValue({ rows: [{ target_active: true, imp_active: false, imp_role: 'super_admin' }] });
    const res = await request(makeApp())
      .post('/api/auth/update-language')
      .set('Authorization', `Bearer ${impByToken}`)
      .send({ language: 'English' });
    expect(res.status).toBe(401);
    expect(didUpdateLanguage()).toBe(false);
  });

  test('rejects the session when the super-admin has been demoted', async () => {
    pool.query.mockResolvedValue({ rows: [{ target_active: true, imp_active: true, imp_role: 'admin' }] });
    const res = await request(makeApp())
      .post('/api/auth/update-language')
      .set('Authorization', `Bearer ${impByToken}`)
      .send({ language: 'English' });
    expect(res.status).toBe(401);
    expect(didUpdateLanguage()).toBe(false);
  });
});
