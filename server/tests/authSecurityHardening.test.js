/**
 * Auth hardening (security review):
 *   - company deactivation blocks login (after a correct password)
 *   - a locked account answers with the same generic 401 as a bad password
 *     (a distinct 423 confirmed the account existed)
 *   - MFA: per-user failure lock, replay guard (last accepted TOTP step), and
 *     failed_login_attempts only reset once the second factor succeeds
 *   - /mfa/disable needs a TOTP code as well as the password
 *   - MFA enrollment refused in production without MFA_ENCRYPTION_KEY
 *   - /resend-confirmation is rate limited
 *   - trial abuse: IPv6 compared at /56, per-email / per-domain limit
 *   - forgot-password without a company name → a link for EVERY tenant account
 *   - reset-password clears the password lockout
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-unit-tests-only';
process.env.APP_URL = 'https://app.test';

let mockCurrentUser;

jest.mock('../middleware/auth', () => ({
  ...jest.requireActual('../middleware/auth'),
  requireAuth: (req, _res, next) => { req.user = mockCurrentUser; next(); },
}));
jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../email', () => ({ sendEmail: jest.fn().mockResolvedValue({ ok: true }) }));
jest.mock('../permissions', () => ({
  seedBuiltinRoles: jest.fn(),
  getUserPermissions: jest.fn().mockResolvedValue(new Set()),
  hasPerm: jest.fn(), requirePerm: jest.fn(),
}));
jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('hashed-pw'),
  compare: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const pool = require('../db');
const bcrypt = require('bcryptjs');
const { sendEmail } = require('../email');

// A fresh router per test group so the module-level rate limiters start empty.
function makeApp() {
  let router;
  jest.isolateModules(() => { router = require('../routes/auth'); });
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/auth', router);
  return app;
}

const SECRET = speakeasy.generateSecret({ length: 20 }).base32;
const codeAt = (offsetSteps = 0) => speakeasy.totp({ secret: SECRET, encoding: 'base32', time: Math.floor(Date.now() / 1000) + offsetSteps * 30 });
const currentStep = () => Math.floor(Date.now() / 1000 / 30);

beforeEach(() => {
  pool.query.mockReset();
  bcrypt.compare.mockReset();
  sendEmail.mockClear();
  mockCurrentUser = { id: 5, company_id: 'co-1', username: 'jdoe', role: 'admin', tv: 0 };
});

// ── login ──────────────────────────────────────────────────────────────────
describe('POST /auth/login', () => {
  const body = { company_name: 'Acme', username: 'jdoe', password: 'pw-123456' };

  test('a locked account gets the same generic 401 as a wrong password (no 423)', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'co-1', active: true }] })
      .mockResolvedValueOnce({ rows: [{ id: 5, locked_until: new Date(Date.now() + 600000), password_hash: 'h' }] })
      .mockResolvedValue({ rows: [] }); // login_failures insert
    bcrypt.compare.mockResolvedValue(false);
    const res = await request(makeApp()).post('/api/auth/login').send(body);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid credentials' });
    // Lock stays in force: the password was never actually checked against the user's hash.
    expect(bcrypt.compare).not.toHaveBeenCalledWith('pw-123456', 'h');
  });

  test('deactivated company: correct password → 403 company_inactive, no session', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'co-1', active: false }] })
      .mockResolvedValueOnce({ rows: [{ id: 5, password_hash: 'h', email_confirmed: true }] })
      .mockResolvedValue({ rows: [] });
    bcrypt.compare.mockResolvedValue(true);
    const res = await request(makeApp()).post('/api/auth/login').send(body);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('company_inactive');
    expect(res.body.token).toBeUndefined();
  });

  test('deactivated company: wrong password still 401 (inactive state not revealed)', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'co-1', active: false }] })
      .mockResolvedValueOnce({ rows: [{ id: 5, password_hash: 'h', failed_login_attempts: 0 }] })
      .mockResolvedValue({ rows: [] });
    bcrypt.compare.mockResolvedValue(false);
    const res = await request(makeApp()).post('/api/auth/login').send(body);
    expect(res.status).toBe(401);
  });

  test('MFA user: right password does NOT reset failed_login_attempts (waits for the code)', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'co-1', active: true }] })
      .mockResolvedValueOnce({ rows: [{ id: 5, password_hash: 'h', email_confirmed: true, mfa_enabled: true, welcomed_at: new Date(), failed_login_attempts: 4 }] })
      .mockResolvedValue({ rows: [] });
    bcrypt.compare.mockResolvedValue(true);
    const res = await request(makeApp()).post('/api/auth/login').send(body);
    expect(res.status).toBe(200);
    expect(res.body.mfa_required).toBe(true);
    expect(pool.query.mock.calls.some(([sql]) => /failed_login_attempts = 0/.test(sql))).toBe(false);
  });

  test('non-MFA user: right password resets the counter', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'co-1', active: true }] })
      .mockResolvedValueOnce({ rows: [{ id: 5, password_hash: 'h', email_confirmed: true, must_change_password: true, welcomed_at: new Date() }] })
      .mockResolvedValue({ rows: [] });
    bcrypt.compare.mockResolvedValue(true);
    const res = await request(makeApp()).post('/api/auth/login').send(body);
    expect(res.status).toBe(200);
    expect(pool.query.mock.calls.some(([sql]) => /failed_login_attempts = 0/.test(sql))).toBe(true);
  });
});

// ── MFA confirm ────────────────────────────────────────────────────────────
describe('POST /auth/mfa/confirm', () => {
  const mfaToken = () => jwt.sign({ id: 5, mfa_pending: true }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const userRow = (extra = {}) => ({ id: 5, username: 'jdoe', role: 'admin', company_id: 'co-1', company_name: 'Acme', company_active: true, mfa_secret: SECRET, mfa_failed_attempts: 0, ...extra });

  test('wrong code → 401 and the per-user failure counter/lock UPDATE runs', async () => {
    pool.query.mockResolvedValueOnce({ rows: [userRow()] }).mockResolvedValue({ rows: [], rowCount: 1 });
    const res = await request(makeApp()).post('/api/auth/mfa/confirm').send({ mfa_token: mfaToken(), code: '000000' === codeAt() ? '111111' : '000000' });
    expect(res.status).toBe(401);
    const upd = pool.query.mock.calls.find(([sql]) => /mfa_failed_attempts = COALESCE\(mfa_failed_attempts, 0\) \+ 1/.test(sql));
    expect(upd).toBeTruthy();
    expect(upd[1]).toEqual([5, 5, '15']);
  });

  test('locked second factor → 429 mfa_locked even with a valid code', async () => {
    pool.query.mockResolvedValueOnce({ rows: [userRow({ mfa_locked_until: new Date(Date.now() + 60000) })] });
    const res = await request(makeApp()).post('/api/auth/mfa/confirm').send({ mfa_token: mfaToken(), code: codeAt() });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('mfa_locked');
  });

  test('valid code → token; records the step and only now clears both counters', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [userRow()] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })      // accept UPDATE
      .mockResolvedValue({ rows: [] });                       // buildSessionUser etc.
    const res = await request(makeApp()).post('/api/auth/mfa/confirm').send({ mfa_token: mfaToken(), code: codeAt() });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    const [sql, params] = pool.query.mock.calls[1];
    expect(sql).toMatch(/mfa_last_used_step = \$2/);
    expect(sql).toMatch(/failed_login_attempts = 0/);
    expect(sql).toMatch(/mfa_last_used_step IS NULL OR mfa_last_used_step < \$2/);
    expect(Math.abs(params[1] - currentStep())).toBeLessThanOrEqual(1);
  });

  test('replay: a code whose step was already accepted is refused', async () => {
    pool.query.mockResolvedValueOnce({ rows: [userRow({ mfa_last_used_step: currentStep() + 1 })] }).mockResolvedValue({ rows: [], rowCount: 1 });
    const res = await request(makeApp()).post('/api/auth/mfa/confirm').send({ mfa_token: mfaToken(), code: codeAt() });
    expect(res.status).toBe(401);
    expect(res.body.token).toBeUndefined();
  });

  test('replay race: accept UPDATE matching 0 rows → 401', async () => {
    pool.query.mockResolvedValueOnce({ rows: [userRow()] }).mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(makeApp()).post('/api/auth/mfa/confirm').send({ mfa_token: mfaToken(), code: codeAt() });
    expect(res.status).toBe(401);
  });

  test('deactivated company → 403 even with a valid code', async () => {
    pool.query.mockResolvedValueOnce({ rows: [userRow({ company_active: false })] });
    const res = await request(makeApp()).post('/api/auth/mfa/confirm').send({ mfa_token: mfaToken(), code: codeAt() });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('company_inactive');
  });

  test('rate limited per mfa_token user id (not just per IP)', async () => {
    const app = makeApp();
    pool.query.mockResolvedValue({ rows: [userRow({ mfa_last_used_step: currentStep() + 5 })], rowCount: 1 });
    const token = mfaToken();
    let last;
    for (let i = 0; i < 11; i++) {
      last = await request(app).post('/api/auth/mfa/confirm').set('X-Forwarded-For', `10.0.0.${i}`).send({ mfa_token: token, code: '123456' });
    }
    expect(last.status).toBe(429);
  });
});

// ── MFA disable / setup ────────────────────────────────────────────────────
describe('POST /auth/mfa/disable', () => {
  test('password alone is no longer enough when MFA is on', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ password_hash: 'h', mfa_enabled: true, mfa_secret: SECRET }] });
    bcrypt.compare.mockResolvedValue(true);
    const res = await request(makeApp()).post('/api/auth/mfa/disable').send({ password: 'pw' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('mfa_code_required');
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('wrong code → 401, MFA stays on', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ password_hash: 'h', mfa_enabled: true, mfa_secret: SECRET }] });
    bcrypt.compare.mockResolvedValue(true);
    const bad = codeAt() === '000000' ? '111111' : '000000';
    const res = await request(makeApp()).post('/api/auth/mfa/disable').send({ password: 'pw', code: bad });
    expect(res.status).toBe(401);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('password + valid code → disabled', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ password_hash: 'h', mfa_enabled: true, mfa_secret: SECRET }] }).mockResolvedValue({ rows: [] });
    bcrypt.compare.mockResolvedValue(true);
    const res = await request(makeApp()).post('/api/auth/mfa/disable').send({ password: 'pw', code: codeAt() });
    expect(res.status).toBe(200);
    expect(res.body.disabled).toBe(true);
  });
});

describe('MFA enrollment in production without MFA_ENCRYPTION_KEY', () => {
  const env = { NODE_ENV: process.env.NODE_ENV, KEY: process.env.MFA_ENCRYPTION_KEY };
  afterEach(() => {
    process.env.NODE_ENV = env.NODE_ENV;
    if (env.KEY === undefined) delete process.env.MFA_ENCRYPTION_KEY; else process.env.MFA_ENCRYPTION_KEY = env.KEY;
  });

  test('/mfa/setup and /mfa/enable refuse (503) instead of storing a plaintext seed', async () => {
    delete process.env.MFA_ENCRYPTION_KEY;
    process.env.NODE_ENV = 'production';
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const app = makeApp();
    const a = await request(app).get('/api/auth/mfa/setup');
    const b = await request(app).post('/api/auth/mfa/enable').send({ code: '123456' });
    spy.mockRestore();
    expect(a.status).toBe(503);
    expect(b.status).toBe(503);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

// ── resend-confirmation limiter ────────────────────────────────────────────
describe('POST /auth/resend-confirmation', () => {
  test('is rate limited (authLimiter: 10/hour)', async () => {
    const app = makeApp();
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    let last;
    for (let i = 0; i < 11; i++) last = await request(app).post('/api/auth/resend-confirmation').send({ email: 'a@b.co' });
    expect(last.status).toBe(429);
  });
});

// ── register: trial abuse ──────────────────────────────────────────────────
describe('POST /auth/register — trial abuse limits', () => {
  const reg = (email) => ({
    company_name: 'NewCo', full_name: 'Ann Lee', username: 'annlee', email,
    password: 'Correct-Horse-9', accepted_terms: true,
  });

  test('IPv6: prior registrations are counted across the whole /56', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ count: '5', company_names: [] }] });
    const res = await request(makeApp()).post('/api/auth/register')
      .set('X-Forwarded-For', '2001:db8:abcd:12ff:1:2:3:4').send(reg('ann@corp.example'));
    expect(res.status).toBe(429);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/registration_ip::inet <<= \$1::cidr/);
    expect(params).toEqual(['2001:db8:abcd:1200::/56']);
  });

  test('IPv4 keeps the exact-address comparison', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ count: '5', company_names: [] }] });
    await request(makeApp()).post('/api/auth/register').set('X-Forwarded-For', '203.0.113.9').send(reg('ann@corp.example'));
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/registration_ip = \$1/);
    expect(params).toEqual(['203.0.113.9']);
  });

  test('corporate domain: limited per domain', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ count: '0', company_names: [] }] })
      .mockResolvedValueOnce({ rows: [{ count: '3' }] });
    const res = await request(makeApp()).post('/api/auth/register').set('X-Forwarded-For', '203.0.113.10').send(reg('Ann@Corp.Example'));
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('trial_limit');
    const [sql, params] = pool.query.mock.calls[1];
    expect(sql).toMatch(/split_part\(LOWER\(u\.email\), '@', 2\) = \$1/);
    expect(params).toEqual(['corp.example']);
  });

  test('free-mail: limited per exact (normalized) address, not per domain', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ count: '0', company_names: [] }] })
      .mockResolvedValueOnce({ rows: [{ count: '2' }] });
    const res = await request(makeApp()).post('/api/auth/register').set('X-Forwarded-For', '203.0.113.11').send(reg('A.nn+trial7@gmail.com'));
    expect(res.status).toBe(429);
    const [sql, params] = pool.query.mock.calls[1];
    expect(sql).toMatch(/regexp_replace/);
    expect(params).toEqual(['ann@gmail.com']);
  });
});

// ── forgot / reset password ────────────────────────────────────────────────
describe('POST /auth/forgot-password without a company', () => {
  test('an address used in several tenants gets a link for EACH account (escaped)', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 2, rows: [
        { id: 1, username: 'ann', full_name: 'Ann', company_name: 'Acme <b>' },
        { id: 2, username: 'ann2', full_name: 'Ann', company_name: 'Beta' },
      ] })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    const res = await request(makeApp()).post('/api/auth/forgot-password').send({ email: 'ann@x.co' });
    expect(res.status).toBe(200);
    await new Promise(r => setImmediate(r));
    const updates = pool.query.mock.calls.filter(([sql]) => /SET reset_token = \$1/.test(sql));
    expect(updates.map(c => c[1][2])).toEqual([1, 2]);
    expect(updates[0][1][0]).not.toBe(updates[1][1][0]); // distinct token per account
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const html = sendEmail.mock.calls[0][2];
    expect(html).toContain('Acme &lt;b&gt;');
    expect(html).toContain('Beta');
    expect((html.match(/reset-password\?token=/g) || []).length).toBe(2);
    expect(pool.query.mock.calls[0][0]).not.toMatch(/LIMIT 1\b/);
  });
});

describe('POST /auth/reset-password', () => {
  test('clears the password lockout along with the new password', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 9, username: 'jdoe' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const res = await request(makeApp()).post('/api/auth/reset-password').send({ token: 't', password: 'correct-horse-battery-staple' });
    expect(res.status).toBe(200);
    expect(pool.query.mock.calls[1][0]).toMatch(/failed_login_attempts = 0, locked_until = NULL/);
  });
});
