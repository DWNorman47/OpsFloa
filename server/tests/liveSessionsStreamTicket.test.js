/**
 * Live-session SSE auth. The stream is mounted BEFORE requireAuth (EventSource can't
 * send a Bearer header), so it must do its own auth — via a short-lived, single-use
 * ticket minted by the gated POST /:id/stream-ticket — and re-run the same live
 * checks as requireAuth (active / token_version) plus the plan-tools add-on gate.
 * Client slots are namespaced by user so a co-worker can't evict another's stream.
 */
process.env.JWT_SECRET = 'test-jwt-secret-for-unit-tests-only';

let mockUser;
jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../jobs/liveSessionSweep', () => ({ noteLiveSessionActive: jest.fn() }));
jest.mock('../r2', () => {
  const actual = jest.requireActual('../r2');
  return {
    keyBelongsTo: actual.keyBelongsTo, safeKeyFromPublicUrl: actual.safeKeyFromPublicUrl,
    keyFromPublicUrl: actual.keyFromPublicUrl, uploadBase64: jest.fn(),
    getObjectStreamByUrl: jest.fn(), getPresignedUploadUrl: jest.fn(), deleteByUrl: jest.fn(),
  };
});

const http = require('http');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const live = require('../routes/liveSessions');
const { router, streamHandler, rooms, flushAll } = live;

// DB state the mocked pool serves
let users;      // id -> { token_version, active, full_name }
let company;    // plan/add-on row for company 7
function installDb() {
  pool.query.mockImplementation(async (sql, params = []) => {
    if (/FROM users u\s+LEFT JOIN companies/.test(sql)) {
      const u = users[params[0]];
      if (!u) return { rows: [] };
      return { rows: [{ token_version: u.token_version, active: u.active, _company_id: company ? 7 : null, ...(company || {}) }] };
    }
    if (/SELECT full_name FROM users/.test(sql)) return { rows: users[params[0]] ? [{ full_name: users[params[0]].full_name }] : [] };
    if (/SELECT \* FROM live_sessions/.test(sql)) return { rows: [] };
    if (/UPDATE live_sessions SET state/.test(sql)) return { rows: [], rowCount: 1 };
    return { rows: [] };
  });
}

function seedRoom(id = '42', companyId = '7') {
  rooms.set(id, {
    id, companyId, tool: 'planroom',
    meta: { name: 'L', pdfUrl: null, pdfName: null, hostUserId: 1 },
    clients: new Map(), objects: new Map(), doc: {}, dirty: false, snapTimer: null,
  });
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.get('/api/live/:id/stream', streamHandler);
  app.use('/api/live', (req, _res, next) => { req.user = mockUser; req.log = { error() {}, warn() {} }; next(); }, router);
  return app;
}

let server, port;
beforeAll(done => { server = http.createServer(makeApp()).listen(0, () => { port = server.address().port; done(); }); });
afterAll(done => { rooms.clear(); server.close(done); });

beforeEach(() => {
  jest.clearAllMocks();
  rooms.clear();
  users = {
    1: { token_version: 3, active: true, full_name: 'Host' },
    2: { token_version: 0, active: true, full_name: 'Coworker' },
  };
  company = { plan: 'business', subscription_status: 'active', addon_planroom: true, addon_takeoff: false, addon_roof: false };
  mockUser = { id: 1, company_id: 7, role: 'member', tv: 3 };
  installDb();
  seedRoom();
});

// Open the stream; resolve { status, first } where first is the first SSE data message.
function openStream(query) {
  return new Promise((resolve, reject) => {
    const req = http.get({ port, path: `/api/live/42/stream?${query}` }, res => {
      if (res.statusCode !== 200) { res.resume(); return resolve({ status: res.statusCode, close() {} }); }
      let buf = '';
      res.on('data', d => {
        buf += d;
        const m = buf.match(/data: (.*)\n\n/);
        if (m) resolve({ status: 200, first: JSON.parse(m[1]), close: () => req.destroy() });
      });
    });
    req.on('error', reject);
  });
}
const settle = () => new Promise(r => setTimeout(r, 30));

async function mintTicket(clientId = 'c1', sessionId = '42') {
  const res = await request(server).post(`/api/live/${sessionId}/stream-ticket`).send({ clientId });
  return res;
}

test('ticket → stream opens, sends init, and registers a user-namespaced slot', async () => {
  const t = await mintTicket('c1');
  expect(t.status).toBe(200);
  const s = await openStream('ticket=' + encodeURIComponent(t.body.ticket));
  expect(s.status).toBe(200);
  expect(s.first.type).toBe('init');
  expect([...rooms.get('42').clients.keys()]).toEqual(['1:c1']);
  s.close(); await settle();
  expect(rooms.get('42').clients.size).toBe(0);
});

test('a ticket is single-use (replay → 401)', async () => {
  const t = await mintTicket();
  const a = await openStream('ticket=' + encodeURIComponent(t.body.ticket));
  expect(a.status).toBe(200);
  const b = await openStream('ticket=' + encodeURIComponent(t.body.ticket));
  expect(b.status).toBe(401);
  a.close(); await settle();
});

test('a ticket for another session is rejected', async () => {
  seedRoom('43');
  const t = await mintTicket('c1', '43');
  expect(t.status).toBe(200);
  const s = await openStream('ticket=' + encodeURIComponent(t.body.ticket)); // path is /42/stream
  expect(s.status).toBe(401);
});

test('cannot mint a ticket for another company\'s session', async () => {
  seedRoom('42', '8');
  const t = await mintTicket();
  expect(t.status).toBe(404);
});

test('a user deactivated after minting cannot connect', async () => {
  const t = await mintTicket();
  users[1].active = false;
  const s = await openStream('ticket=' + encodeURIComponent(t.body.ticket));
  expect(s.status).toBe(401);
});

test('a password change (token_version bump) after minting blocks the connect', async () => {
  const t = await mintTicket();
  users[1].token_version = 4;
  const s = await openStream('ticket=' + encodeURIComponent(t.body.ticket));
  expect(s.status).toBe(401);
});

test('no plan-tools add-on → 403', async () => {
  const t = await mintTicket();
  company = { plan: 'business', subscription_status: 'active', addon_planroom: false, addon_takeoff: false, addon_roof: false };
  const s = await openStream('ticket=' + encodeURIComponent(t.body.ticket));
  expect(s.status).toBe(403);
});

test('expired ticket → 401', async () => {
  const real = Date.now;
  const t = await mintTicket();
  Date.now = () => real() + 2 * 60 * 1000;
  try {
    const s = await openStream('ticket=' + encodeURIComponent(t.body.ticket));
    expect(s.status).toBe(401);
  } finally { Date.now = real; }
});

test('a full session JWT is not accepted as a ticket, and a ticket is not a session token', async () => {
  const sessionJwt = jwt.sign({ id: 1, company_id: 7, tv: 3 }, process.env.JWT_SECRET);
  const s = await openStream('ticket=' + encodeURIComponent(sessionJwt));
  expect(s.status).toBe(401);

  const t = await mintTicket();
  const req = { headers: { authorization: 'Bearer ' + t.body.ticket } };
  const res = { status(c) { this.code = c; return this; }, json() { return this; } };
  const next = jest.fn();
  await requireAuth(req, res, next);
  expect(next).not.toHaveBeenCalled();
  expect(res.code).toBe(401);
});

test('a co-worker reusing the same client id gets their own slot (no eviction)', async () => {
  const a = await openStream('ticket=' + encodeURIComponent((await mintTicket('same')).body.ticket));
  mockUser = { id: 2, company_id: 7, role: 'member', tv: 0 };
  const b = await openStream('ticket=' + encodeURIComponent((await mintTicket('same')).body.ticket));
  expect(a.status).toBe(200); expect(b.status).toBe(200);
  expect([...rooms.get('42').clients.keys()].sort()).toEqual(['1:same', '2:same']);
  a.close(); b.close(); await settle();
});

describe('legacy ?token= (transition)', () => {
  test('accepted only when it passes the requireAuth checks', async () => {
    const good = jwt.sign({ id: 1, company_id: 7, tv: 3 }, process.env.JWT_SECRET);
    const s = await openStream('token=' + encodeURIComponent(good) + '&client=old');
    expect(s.status).toBe(200);
    expect([...rooms.get('42').clients.keys()]).toEqual(['1:old']);
    s.close(); await settle();
  });
  test('deactivated user → 401', async () => {
    users[1].active = false;
    const tok = jwt.sign({ id: 1, company_id: 7, tv: 3 }, process.env.JWT_SECRET);
    expect((await openStream('token=' + encodeURIComponent(tok))).status).toBe(401);
  });
  test('stale token_version → 401', async () => {
    const tok = jwt.sign({ id: 1, company_id: 7, tv: 2 }, process.env.JWT_SECRET);
    expect((await openStream('token=' + encodeURIComponent(tok))).status).toBe(401);
  });
  test('an MFA-pending / setup token (no tv, no imp) → 401', async () => {
    const tok = jwt.sign({ id: 1, company_id: 7, mfa_pending: true }, process.env.JWT_SECRET);
    expect((await openStream('token=' + encodeURIComponent(tok))).status).toBe(401);
  });
  test('no credentials → 401', async () => {
    expect((await openStream('client=x')).status).toBe(401);
  });
});

test('flushAll persists dirty rooms immediately and is exported on the module', async () => {
  expect(typeof live.flushAll).toBe('function');
  const room = rooms.get('42');
  room.dirty = true;
  room.snapTimer = setTimeout(() => {}, 60000);
  const n = await flushAll();
  expect(n).toBe(1);
  expect(room.dirty).toBe(false);
  expect(room.snapTimer).toBe(null);
  expect(pool.query.mock.calls.some(([sql]) => /UPDATE live_sessions SET state/.test(sql))).toBe(true);
});
