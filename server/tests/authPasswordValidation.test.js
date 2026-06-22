/**
 * Pin the validatePassword(password, username) wiring on the three
 * "set a new password" flows that had drifted: /reset-password,
 * /accept-invite, /complete-setup. Commit 453248b restructured each
 * handler to fetch the user row FIRST so the "password can't contain
 * your username" rule can run. These tests assert:
 *
 *   1. Trivially-short passwords are still rejected (the length rule
 *      runs on the same call — if validatePassword were skipped or
 *      called without the password, this fails).
 *   2. A password containing the username is rejected — the regression
 *      this commit was patching.
 *   3. A valid password proceeds to bcrypt + UPDATE.
 *
 * No real bcrypt round (jest.mock keeps tests under a second).
 */

let mockCurrentUser;

jest.mock('../middleware/auth', () => ({
  requireAuth:                  (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireAdmin:                 (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requirePermission:            () => (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requirePerm:                  () => (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requirePlan:                  () => (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireProAddon:              (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireCertifiedPayrollAddon: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  hasAdminPermission:           () => true,
  requireSuperAdmin:            (req, _res, next) => { req.user = mockCurrentUser; next(); },
}));

jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../push', () => ({ sendPushToUser: jest.fn(), sendPushToAllWorkers: jest.fn() }));
jest.mock('../email', () => ({ sendEmail: jest.fn() }));
jest.mock('../permissions', () => ({
  seedBuiltinRoles: jest.fn(),
  getUserPermissions: jest.fn().mockResolvedValue(new Set()),
}));
jest.mock('@sendgrid/mail', () => ({ setApiKey: jest.fn(), send: jest.fn() }));
jest.mock('bcryptjs', () => ({
  hash:    jest.fn().mockResolvedValue('hashed-pw'),
  compare: jest.fn(),
}));
jest.mock('jsonwebtoken', () => ({
  sign:   jest.fn().mockReturnValue('signed.jwt.token'),
  verify: jest.fn(),
}));

const express   = require('express');
const request   = require('supertest');
const pool      = require('../db');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const authRoute = require('../routes/auth');

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/auth', authRoute);
  return app;
}

beforeEach(() => {
  pool.query.mockReset();
  bcrypt.hash.mockClear();
  jwt.sign.mockClear();
  jwt.verify.mockReset();
  mockCurrentUser = null;
});

// ───────────────────────────────────────────────────────────────────────────
// POST /auth/reset-password
// ───────────────────────────────────────────────────────────────────────────

describe('POST /auth/reset-password — validatePassword wiring', () => {
  test('rejects when password contains the username', async () => {
    // First query: load the user by reset token, returning their username.
    pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 9, username: 'jdoe' }],
    });

    const res = await request(makeApp())
      .post('/api/auth/reset-password')
      .send({ token: 'raw-reset-token', password: 'hello-jdoe-2026' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Password cannot contain your username');
    // The UPDATE must NOT have run — only the SELECT.
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(bcrypt.hash).not.toHaveBeenCalled();
  });

  test('rejects too-short password (length check still runs after fetch)', async () => {
    pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 9, username: 'jdoe' }],
    });

    const res = await request(makeApp())
      .post('/api/auth/reset-password')
      .send({ token: 'raw-reset-token', password: 'short' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Password must be at least 8 characters');
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(bcrypt.hash).not.toHaveBeenCalled();
  });

  test('accepts a valid password unrelated to the username', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 9, username: 'jdoe' }] })  // SELECT
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });                            // UPDATE

    const res = await request(makeApp())
      .post('/api/auth/reset-password')
      .send({ token: 'raw-reset-token', password: 'correct-horse-battery-staple' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(bcrypt.hash).toHaveBeenCalledWith('correct-horse-battery-staple', 10);
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  test('rejects with 400 when the reset token does not match a row', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const res = await request(makeApp())
      .post('/api/auth/reset-password')
      .send({ token: 'bogus', password: 'whatever-strong-pw' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Reset link is invalid or has expired');
    expect(bcrypt.hash).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// POST /auth/accept-invite
// ───────────────────────────────────────────────────────────────────────────

describe('POST /auth/accept-invite — validatePassword wiring', () => {
  test('rejects when password contains the username', async () => {
    pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 12, username: 'asmith', company_id: 'co-1', company_name: 'Acme' }],
    });

    const res = await request(makeApp())
      .post('/api/auth/accept-invite')
      .send({ token: 'raw-invite-token', password: 'pick-asmith-please' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Password cannot contain your username');
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(bcrypt.hash).not.toHaveBeenCalled();
  });

  test('accepts a valid password and returns username + company_name', async () => {
    pool.query
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 12, username: 'asmith', company_id: 'co-1', company_name: 'Acme' }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // UPDATE

    const res = await request(makeApp())
      .post('/api/auth/accept-invite')
      .send({ token: 'raw-invite-token', password: 'totally-fine-password' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, username: 'asmith', company_name: 'Acme' });
    expect(bcrypt.hash).toHaveBeenCalledWith('totally-fine-password', 10);
  });

  test('rejects with 400 when the invite token does not match', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const res = await request(makeApp())
      .post('/api/auth/accept-invite')
      .send({ token: 'bogus', password: 'totally-fine-password' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invite link is invalid or has expired');
    expect(bcrypt.hash).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// POST /auth/complete-setup
// ───────────────────────────────────────────────────────────────────────────

describe('POST /auth/complete-setup — validatePassword wiring', () => {
  test('rejects when password contains the username', async () => {
    jwt.verify.mockReturnValueOnce({ id: 7, setup_pending: true });
    pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 7, username: 'kowalski', company_id: 'co-1', company_name: 'Acme', token_version: 0 }],
    });

    const res = await request(makeApp())
      .post('/api/auth/complete-setup')
      .send({ setup_token: 'jwt-setup-token', new_password: 'go-kowalski-go' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Password cannot contain your username');
    // SELECT ran; UPDATE did not.
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(bcrypt.hash).not.toHaveBeenCalled();
  });

  test('rejects too-short password after fetch', async () => {
    jwt.verify.mockReturnValueOnce({ id: 7, setup_pending: true });
    pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 7, username: 'kowalski', company_id: 'co-1', company_name: 'Acme', token_version: 0 }],
    });

    const res = await request(makeApp())
      .post('/api/auth/complete-setup')
      .send({ setup_token: 'jwt-setup-token', new_password: 'tiny' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Password must be at least 8 characters');
    expect(bcrypt.hash).not.toHaveBeenCalled();
  });

  test('rejects with 400 when JWT verify throws (expired setup session)', async () => {
    jwt.verify.mockImplementationOnce(() => { throw new Error('expired'); });

    const res = await request(makeApp())
      .post('/api/auth/complete-setup')
      .send({ setup_token: 'expired-jwt', new_password: 'whatever-strong-pw' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Setup session expired. Please sign in again.');
    // No DB call before JWT verify succeeds.
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('rejects with 400 when setup_pending is false', async () => {
    jwt.verify.mockReturnValueOnce({ id: 7, setup_pending: false });

    const res = await request(makeApp())
      .post('/api/auth/complete-setup')
      .send({ setup_token: 'jwt-not-for-setup', new_password: 'whatever-strong-pw' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid setup token');
    expect(pool.query).not.toHaveBeenCalled();
  });
});
