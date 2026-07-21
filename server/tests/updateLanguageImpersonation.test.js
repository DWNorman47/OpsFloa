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

// Tokens omit `tv` so requireAuth skips the token_version lookup — this isolates
// the impersonation gate, which is independent of token versioning.
const normalToken = jwt.sign({ id: 42, role: 'worker', company_id: 'c1', username: 'ana' }, process.env.JWT_SECRET);
const impToken = jwt.sign({ id: 42, role: 'worker', company_id: 'c1', username: 'ana', imp: true }, process.env.JWT_SECRET);

beforeEach(() => { pool.query.mockReset(); });

describe('POST /auth/update-language', () => {
  test('a normal session persists the language to the profile', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1 });
    const res = await request(makeApp())
      .post('/api/auth/update-language')
      .set('Authorization', `Bearer ${normalToken}`)
      .send({ language: 'English' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, language: 'English', persisted: true });
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][0]).toMatch(/UPDATE users SET language/);
    expect(pool.query.mock.calls[0][1]).toEqual(['English', 42]);
  });

  test('an impersonation session does NOT write to the profile', async () => {
    const res = await request(makeApp())
      .post('/api/auth/update-language')
      .set('Authorization', `Bearer ${impToken}`)
      .send({ language: 'English' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, language: 'English', persisted: false });
    // The Spanish profile is left exactly as it was.
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('a blank language is still rejected under impersonation', async () => {
    const res = await request(makeApp())
      .post('/api/auth/update-language')
      .set('Authorization', `Bearer ${impToken}`)
      .send({ language: '   ' });
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
