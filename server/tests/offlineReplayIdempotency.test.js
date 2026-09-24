/**
 * Offline-replay idempotency: the client's service worker stamps queueable POSTs with an
 * Idempotency-Key header (and time entries also carry a body client_id). A replay of a POST whose
 * original was saved (response lost) must return the EXISTING row with 200 — never a second
 * INSERT. Requests without a key behave exactly as before.
 */

let mockUser;
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = mockUser; next(); },
  requireAdmin: (req, _res, next) => { req.user = mockUser; next(); },
}));
jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../failureLog', () => ({ logFailure: jest.fn() }));
jest.mock('../email', () => ({ sendEmail: jest.fn() }));
jest.mock('../routes/inbox', () => ({ createInboxItem: jest.fn() }));
jest.mock('../push', () => ({ sendPushToUser: jest.fn(), sendPushToCompanyAdmins: jest.fn() }));
jest.mock('../permissions', () => ({ requirePerm: () => (_req, _res, next) => next() }));
jest.mock('../utils/projectCost', () => ({ projectFrozen: jest.fn(async () => false) }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const { sendPushToCompanyAdmins } = require('../push');
const { readIdempotencyKey } = require('../utils/idempotencyKey');

function makeApp(path, router) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error: () => {} }; next(); });
  app.use(path, router);
  return app;
}

const KEY = '3f1c2b9a-8d7e-4f60-a1b2-c3d4e5f60718';

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockReset();
  mockUser = { id: 7, company_id: 'co-1', full_name: 'Worker Seven', role: 'worker' };
});

describe('readIdempotencyKey', () => {
  const fakeReq = (body, header) => ({ body, get: (h) => (h.toLowerCase() === 'idempotency-key' ? header : undefined) });

  test('body field wins over the header', () => {
    expect(readIdempotencyKey(fakeReq({ client_id: 'body-key' }, KEY), { bodyField: 'client_id', maxLen: 36 })).toBe('body-key');
  });
  test('falls back to the Idempotency-Key header', () => {
    expect(readIdempotencyKey(fakeReq({}, KEY), { bodyField: 'client_id', maxLen: 36 })).toBe(KEY);
  });
  test('rejects oversize / junk header values; null when nothing sent', () => {
    expect(readIdempotencyKey(fakeReq({}, 'x'.repeat(65)), {})).toBeNull();
    expect(readIdempotencyKey(fakeReq({}, 'bad key; drop'), {})).toBeNull();
    expect(readIdempotencyKey(fakeReq({}, undefined), {})).toBeNull();
  });
});

describe('POST /time-entries', () => {
  const timeEntries = require('../routes/timeEntries');
  const body = { project_id: 3, work_date: '2026-09-20', start_time: '07:00', end_time: '15:00' };

  test('replay with a header key that already produced an entry returns it (200), no INSERT', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (/SELECT \* FROM time_entries WHERE user_id = \$1 AND client_id = \$2/.test(sql)) return { rowCount: 1, rows: [{ id: 55, client_id: KEY }] };
      if (/INSERT INTO time_entries/.test(sql)) throw new Error('should not INSERT on a replay');
      return { rowCount: 0, rows: [] };
    });
    const res = await request(makeApp('/api/time-entries', timeEntries))
      .post('/api/time-entries').set('Idempotency-Key', KEY).send(body);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(55);
    const dedupCall = pool.query.mock.calls.find(c => /client_id = \$2/.test(c[0]));
    expect(dedupCall[1]).toEqual([7, KEY]);
  });

  test('body client_id is used as the key (existing app contract) and stored on INSERT', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (/SELECT \* FROM time_entries WHERE user_id/.test(sql)) return { rowCount: 0, rows: [] };
      if (/FROM companies/.test(sql)) return { rows: [{ plan: 'business', subscription_status: 'active' }] };
      if (/SELECT wage_type FROM projects/.test(sql)) return { rowCount: 1, rows: [{ wage_type: 'regular' }] };
      if (/INSERT INTO time_entries/.test(sql)) return { rowCount: 1, rows: [{ id: 56 }] };
      return { rowCount: 0, rows: [] };
    });
    const res = await request(makeApp('/api/time-entries', timeEntries))
      .post('/api/time-entries').set('Idempotency-Key', KEY).send({ ...body, client_id: 'form-key' });
    expect(res.status).toBe(201);
    const insert = pool.query.mock.calls.find(c => /INSERT INTO time_entries/.test(c[0]));
    expect(insert[1][13]).toBe('form-key');
  });

  test('lost race on ON CONFLICT returns the winning row with 200', async () => {
    let dedupCalls = 0;
    pool.query.mockImplementation(async (sql) => {
      if (/SELECT \* FROM time_entries WHERE user_id/.test(sql)) {
        dedupCalls++;
        return dedupCalls === 1 ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ id: 57 }] };
      }
      if (/FROM companies/.test(sql)) return { rows: [{ plan: 'business', subscription_status: 'active' }] };
      if (/SELECT wage_type FROM projects/.test(sql)) return { rowCount: 1, rows: [{ wage_type: 'regular' }] };
      if (/INSERT INTO time_entries/.test(sql)) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    });
    const res = await request(makeApp('/api/time-entries', timeEntries))
      .post('/api/time-entries').set('Idempotency-Key', KEY).send(body);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(57);
  });

  test('no key → no dedup query, INSERT with a NULL client_id (unchanged behavior)', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (/FROM companies/.test(sql)) return { rows: [{ plan: 'business', subscription_status: 'active' }] };
      if (/SELECT wage_type FROM projects/.test(sql)) return { rowCount: 1, rows: [{ wage_type: 'regular' }] };
      if (/INSERT INTO time_entries/.test(sql)) return { rowCount: 1, rows: [{ id: 58 }] };
      return { rowCount: 0, rows: [] };
    });
    const res = await request(makeApp('/api/time-entries', timeEntries)).post('/api/time-entries').send(body);
    expect(res.status).toBe(201);
    expect(pool.query.mock.calls.some(c => /client_id = \$2/.test(c[0]))).toBe(false);
    const insert = pool.query.mock.calls.find(c => /INSERT INTO time_entries/.test(c[0]));
    expect(insert[1][13]).toBeNull();
  });
});

describe('POST /punchlist', () => {
  const punchlist = require('../routes/punchlist');

  test('replay returns the existing item (200) without a second INSERT or push', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (/SELECT id FROM punchlist_items WHERE company_id = \$1 AND client_request_id = \$2/.test(sql)) return { rowCount: 1, rows: [{ id: 9 }] };
      if (/FROM punchlist_items pi/.test(sql)) return { rows: [{ id: 9, title: 'Patch drywall' }] };
      if (/INSERT INTO punchlist_items/.test(sql)) throw new Error('should not INSERT on a replay');
      return { rowCount: 1, rows: [{}] };
    });
    const res = await request(makeApp('/api/punchlist', punchlist))
      .post('/api/punchlist').set('Idempotency-Key', KEY).send({ project_id: 3, title: 'Patch drywall' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(9);
  });

  test('first request stores the key on INSERT', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (/SELECT id FROM punchlist_items WHERE company_id/.test(sql)) return { rowCount: 0, rows: [] };
      if (/INSERT INTO punchlist_items/.test(sql)) return { rowCount: 1, rows: [{ id: 10 }] };
      if (/FROM punchlist_items pi/.test(sql)) return { rows: [{ id: 10, title: 'Patch drywall' }] };
      return { rowCount: 1, rows: [{}] };
    });
    const res = await request(makeApp('/api/punchlist', punchlist))
      .post('/api/punchlist').set('Idempotency-Key', KEY).send({ project_id: 3, title: 'Patch drywall' });
    expect(res.status).toBe(201);
    const insert = pool.query.mock.calls.find(c => /INSERT INTO punchlist_items/.test(c[0]));
    expect(insert[0]).toMatch(/ON CONFLICT \(company_id, client_request_id\) WHERE client_request_id IS NOT NULL DO NOTHING/);
    expect(insert[1][9]).toBe(KEY);
  });
});

describe('POST /incidents', () => {
  const incidents = require('../routes/incidents');
  const body = { incident_date: '2026-09-20', type: 'near_miss', description: 'Ladder slipped' };

  test('replay returns the existing report (200), no INSERT, no admin push', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (/SELECT id FROM incident_reports WHERE company_id = \$1 AND client_request_id = \$2/.test(sql)) return { rowCount: 1, rows: [{ id: 4 }] };
      if (/WHERE i\.id = \$1/.test(sql)) return { rows: [{ id: 4, type: 'near_miss' }] };
      if (/INSERT INTO incident_reports/.test(sql)) throw new Error('should not INSERT on a replay');
      return { rowCount: 0, rows: [] };
    });
    const res = await request(makeApp('/api/incidents', incidents))
      .post('/api/incidents').set('Idempotency-Key', KEY).send(body);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(4);
    expect(sendPushToCompanyAdmins).not.toHaveBeenCalled();
  });

  test('no key → plain INSERT with NULL client_request_id', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (/INSERT INTO incident_reports/.test(sql)) return { rowCount: 1, rows: [{ id: 5 }] };
      if (/WHERE i\.id = \$1/.test(sql)) return { rows: [{ id: 5 }] };
      return { rowCount: 0, rows: [] };
    });
    const res = await request(makeApp('/api/incidents', incidents)).post('/api/incidents').send(body);
    expect(res.status).toBe(201);
    expect(pool.query.mock.calls.some(c => /client_request_id = \$2/.test(c[0]))).toBe(false);
    const insert = pool.query.mock.calls.find(c => /INSERT INTO incident_reports/.test(c[0]));
    expect(insert[1][13]).toBeNull();
  });
});
