/**
 * QuickBooks OAuth account-linking CSRF + permission gates.
 *
 * Before: `state` was unsigned base64 {company_id, nonce} and the unauthenticated
 * callback exchanged the code and linked whatever QuickBooks company approved it
 * to company_id. An attacker admin could send their authorize URL to a victim,
 * who approved it → the VICTIM's QuickBooks got linked to the attacker's company.
 *
 * Now: state is HMAC-signed and bound to {company, user, nonce, issued_at}; the
 * unauthenticated callback only verifies the signature and hands the code to the
 * SPA; the SPA POSTs it back with its Bearer token and the server redeems it only
 * for the SAME user + company that started the flow, within 15 min, once.
 */

let mockUser;
jest.mock('../middleware/auth', () => {
  const pass = (req, _res, next) => { req.user = mockUser; next(); };
  return {
    requireAuth: pass,
    requireAdmin: pass,
    requirePerm: (key) => { const fn = (_req, _res, next) => next(); fn.__permissionKey = key; return fn; },
  };
});
jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../services/encryption', () => ({ encrypt: x => `enc:${x}`, decrypt: x => x }));
jest.mock('../services/qbo', () => ({
  getAuthUrl: jest.fn(state => `https://appcenter.intuit.com/connect/oauth2?state=${encodeURIComponent(state)}`),
  exchangeCode: jest.fn(),
  createVendor: jest.fn(),
  timeActivityHours: jest.fn(() => []),
}));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));

process.env.JWT_SECRET = 'test-secret';
process.env.APP_URL = 'https://app.example.com';
process.env.QBO_CLIENT_ID = 'cid';
process.env.QBO_REDIRECT_URI = 'https://api.example.com/api/qbo/callback';

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const qbo = require('../services/qbo');
const qboRoute = require('../routes/qbo');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.get('/api/qbo/callback', qboRoute.oauthCallback); // unauthenticated, as in index.js
  app.use('/api/qbo', qboRoute);
  return app;
}

const ADMIN_A = { id: 1, company_id: 'company-A', full_name: 'Attacker', role: 'admin' };
const ADMIN_A2 = { id: 2, company_id: 'company-A', full_name: 'Other admin', role: 'admin' };
const VICTIM = { id: 9, company_id: 'company-V', full_name: 'Victim', role: 'admin' };

let stored; // company_id → nonce
beforeEach(() => {
  stored = {};
  pool.query.mockReset();
  qbo.exchangeCode.mockReset();
  qbo.exchangeCode.mockResolvedValue({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
  pool.query.mockImplementation(async (sql, params = []) => {
    if (/SET qbo_oauth_nonce = \$1/.test(sql)) { stored[params[1]] = params[0]; return { rowCount: 1, rows: [] }; }
    if (/SET qbo_oauth_nonce = NULL/.test(sql) && /RETURNING/.test(sql)) {
      const [companyId, nonce] = params;
      if (stored[companyId] && stored[companyId] === nonce) { delete stored[companyId]; return { rowCount: 1, rows: [{ id: companyId }] }; }
      return { rowCount: 0, rows: [] };
    }
    return { rowCount: 1, rows: [] };
  });
});

async function startFlow(user) {
  mockUser = user;
  const res = await request(makeApp()).get('/api/qbo/connect');
  expect(res.status).toBe(200);
  return new URL(res.body.url).searchParams.get('state');
}
const tokenWrites = () => pool.query.mock.calls.filter(c => /qbo_access_token = \$2/.test(c[0]));

describe('OAuth callback no longer links an account on its own', () => {
  test('callback verifies state and redirects the code to the SPA without exchanging it', async () => {
    const state = await startFlow(ADMIN_A);
    const res = await request(makeApp()).get('/api/qbo/callback').query({ code: 'C', state, realmId: 'R' });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.location);
    expect(loc.origin).toBe('https://app.example.com');
    expect(loc.pathname).toBe('/administration');
    expect(loc.searchParams.get('qbo_code')).toBe('C');
    expect(loc.searchParams.get('qbo_realm')).toBe('R');
    expect(loc.hash).toBe('#integrations');
    expect(qbo.exchangeCode).not.toHaveBeenCalled();
    expect(tokenWrites()).toHaveLength(0);
  });

  test('a forged (unsigned, old-format) state is rejected at the callback', async () => {
    const forged = Buffer.from(JSON.stringify({ company_id: 'company-A', nonce: 'x' })).toString('base64');
    const res = await request(makeApp()).get('/api/qbo/callback').query({ code: 'C', state: forged, realmId: 'R' });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.location).searchParams.get('qbo_error')).toBe('invalid_state');
  });
});

describe('POST /callback/complete binds the flow to the initiating user', () => {
  test('the initiating admin completes the link', async () => {
    const state = await startFlow(ADMIN_A);
    mockUser = ADMIN_A;
    const res = await request(makeApp()).post('/api/qbo/callback/complete').send({ code: 'C', state, realmId: 'R' });
    expect(res.status).toBe(200);
    expect(qbo.exchangeCode).toHaveBeenCalledWith('C');
    const w = tokenWrites();
    expect(w).toHaveLength(1);
    expect(w[0][1]).toEqual(expect.arrayContaining(['enc:R', 'enc:at', 'enc:rt', 'company-A']));
  });

  test('the CSRF scenario: a victim of another company approving the attacker URL links nothing', async () => {
    const state = await startFlow(ADMIN_A);
    mockUser = VICTIM;
    const res = await request(makeApp()).post('/api/qbo/callback/complete').send({ code: 'C', state, realmId: 'R' });
    expect(res.status).toBe(403);
    expect(qbo.exchangeCode).not.toHaveBeenCalled();
    expect(tokenWrites()).toHaveLength(0);
  });

  test('a different admin of the same company cannot redeem someone else\'s flow', async () => {
    const state = await startFlow(ADMIN_A);
    mockUser = ADMIN_A2;
    const res = await request(makeApp()).post('/api/qbo/callback/complete').send({ code: 'C', state, realmId: 'R' });
    expect(res.status).toBe(403);
    expect(qbo.exchangeCode).not.toHaveBeenCalled();
  });

  test('a tampered state is rejected', async () => {
    const state = await startFlow(ADMIN_A);
    const [body, sig] = state.split('.');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    payload.c = 'company-V';
    const tampered = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;
    mockUser = VICTIM;
    const res = await request(makeApp()).post('/api/qbo/callback/complete').send({ code: 'C', state: tampered, realmId: 'R' });
    expect(res.status).toBe(400);
    expect(qbo.exchangeCode).not.toHaveBeenCalled();
  });

  test('an expired state (>15 min) is rejected', async () => {
    const t0 = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(t0);
    const state = await startFlow(ADMIN_A);
    spy.mockReturnValue(t0 + 16 * 60 * 1000);
    mockUser = ADMIN_A;
    const res = await request(makeApp()).post('/api/qbo/callback/complete').send({ code: 'C', state, realmId: 'R' });
    spy.mockRestore();
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('qbo_state_expired');
    expect(qbo.exchangeCode).not.toHaveBeenCalled();
  });

  test('a state is single-use (replay rejected)', async () => {
    const state = await startFlow(ADMIN_A);
    mockUser = ADMIN_A;
    await request(makeApp()).post('/api/qbo/callback/complete').send({ code: 'C', state, realmId: 'R' });
    const res = await request(makeApp()).post('/api/qbo/callback/complete').send({ code: 'C2', state, realmId: 'R' });
    expect(res.status).toBe(400);
    expect(qbo.exchangeCode).toHaveBeenCalledTimes(1);
  });
});

describe('permission gates', () => {
  const permsFor = (method, path) => {
    const layer = qboRoute.stack.find(l => l.route && l.route.path === path && l.route.methods[method]);
    return layer.route.stack.map(s => s.handle.__permissionKey).filter(Boolean);
  };
  test.each([
    ['post', '/retry-error/:id'],
    ['post', '/workers/create-vendor'],
    ['post', '/callback/complete'],
    ['get', '/connect'],
  ])('%s %s requires manage_integrations', (method, path) => {
    expect(permsFor(method, path)).toContain('manage_integrations');
  });
});
