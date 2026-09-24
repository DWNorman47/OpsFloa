/**
 * Company chat (routes/chat.js) + direct messages (routes/directMessages.js):
 *  - partial admins (worker_access_ids) only list / read / post their workers' threads,
 *    and the worker→admins push is scoped to that worker
 *  - threads return the NEWEST page (DESC LIMIT, reversed) with a `before` cursor
 *  - messaging_blocked is enforced for company chat
 *  - the retention prune never runs with < 1 day
 *  - admin unread comes from server read markers
 */
let mockUser;
jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../push', () => ({ sendPushToUser: jest.fn(), sendPushToCompanyAdmins: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = mockUser; next(); },
  requirePerm: () => (_req, _res, next) => next(),
}));
jest.mock('../middleware/rateLimitKey', () => ({ userOrIpKey: () => 'k' }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const push = require('../push');
const chatRouter = require('../routes/chat');
const dmRouter = require('../routes/directMessages');
const { chatRetentionDays } = require('../utils/chatRetention');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/chat', chatRouter);
  app.use('/api/dm', dmRouter);
  return app;
}

const ADMIN = { id: 1, company_id: 'co', role: 'admin', full_name: 'Ada', worker_access_ids: null };
const SCOPED = { ...ADMIN, id: 2, worker_access_ids: [10] };
const WORKER = { id: 10, company_id: 'co', role: 'worker', full_name: 'Wes' };

let handler;
beforeEach(() => {
  jest.clearAllMocks();
  handler = () => ({ rows: [], rowCount: 0 });
  pool.query.mockImplementation(async (sql, params) => handler(sql, params));
});
const calls = (re) => pool.query.mock.calls.filter(([sql]) => re.test(sql));

describe('worker scope for partial admins', () => {
  test('list passes the scope ids to SQL', async () => {
    mockUser = SCOPED;
    const res = await request(makeApp()).get('/api/chat');
    expect(res.status).toBe(200);
    const [sql, params] = calls(/DISTINCT ON \(m\.worker_id\)/)[0];
    expect(sql).toMatch(/worker_id = ANY\(\$3::int\[\]\)/);
    expect(params[2]).toEqual([10]);
  });

  test('unrestricted admin → no scope filter (null)', async () => {
    mockUser = ADMIN;
    await request(makeApp()).get('/api/chat');
    expect(calls(/DISTINCT ON/)[0][1][2]).toBeNull();
  });

  test('reading an out-of-scope worker thread is 403 without touching the DB', async () => {
    mockUser = SCOPED;
    const res = await request(makeApp()).get('/api/chat?worker_id=11');
    expect(res.status).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('posting to an out-of-scope worker is 403', async () => {
    mockUser = SCOPED;
    const res = await request(makeApp()).post('/api/chat').send({ worker_id: 11, body: 'hi' });
    expect(res.status).toBe(403);
    expect(calls(/INSERT INTO company_chat /)).toHaveLength(0);
  });

  test('worker message pushes admins scoped to that worker, tagged per thread', async () => {
    mockUser = WORKER;
    handler = (sql) => (/INSERT INTO company_chat /.test(sql)
      ? { rows: [{ id: 5, sender_id: 10, worker_id: 10, body: 'hi', created_at: 'now' }], rowCount: 1 }
      : { rows: [], rowCount: 0 });
    const res = await request(makeApp()).post('/api/chat').send({ body: 'hi' });
    expect(res.status).toBe(201);
    const [companyId, payload, opts] = push.sendPushToCompanyAdmins.mock.calls[0];
    expect(companyId).toBe('co');
    expect(payload.tag).toBe('chat-10');
    expect(opts).toEqual({ workerId: 10 });
  });
});

describe('newest page + before cursor', () => {
  test('thread query is DESC LIMIT and the response is ascending', async () => {
    mockUser = WORKER;
    handler = (sql) => (/FROM company_chat m\s+JOIN users u ON m\.sender_id/.test(sql)
      ? { rows: [{ id: 9 }, { id: 8 }, { id: 7 }], rowCount: 3 }
      : { rows: [], rowCount: 0 });
    const res = await request(makeApp()).get('/api/chat?before=10');
    expect(res.body.map(m => m.id)).toEqual([7, 8, 9]);
    const [sql, params] = calls(/ORDER BY m\.id DESC/)[0];
    expect(sql).toMatch(/LIMIT 100/);
    expect(params[2]).toBe(10);
  });

  test('a bad cursor is a 400', async () => {
    mockUser = WORKER;
    expect((await request(makeApp()).get('/api/chat?before=abc')).status).toBe(400);
  });

  test('admin newest-page fetch sets the server read marker; paging back does not', async () => {
    mockUser = ADMIN;
    handler = (sql) => (/SELECT id FROM users/.test(sql) ? { rows: [{ id: 10 }], rowCount: 1 } : { rows: [], rowCount: 0 });
    await request(makeApp()).get('/api/chat?worker_id=10');
    expect(calls(/INSERT INTO company_chat_reads/)).toHaveLength(1);
    pool.query.mockClear();
    await request(makeApp()).get('/api/chat?worker_id=10&before=50');
    expect(calls(/INSERT INTO company_chat_reads/)).toHaveLength(0);
  });

  test('admin list unread counts only the worker\'s messages past the marker', async () => {
    mockUser = ADMIN;
    await request(makeApp()).get('/api/chat');
    const [sql] = calls(/DISTINCT ON/)[0];
    expect(sql).toMatch(/c\.sender_id = c\.worker_id/);
    expect(sql).toMatch(/c\.id > COALESCE\(r\.last_read_id, 0\)/);
    expect(sql).toMatch(/last_sender_role/);
  });

  test('DM conversation: newest page ascending + has_more; paging back leaves read_at alone', async () => {
    mockUser = WORKER;
    const rows = Array.from({ length: 201 }, (_, i) => ({ id: 500 - i }));
    handler = (sql) => {
      if (/SELECT id, full_name, role FROM users/.test(sql)) return { rows: [{ id: 3, full_name: 'X', role: 'admin' }], rowCount: 1 };
      if (/FROM direct_messages m JOIN users/.test(sql)) return { rows, rowCount: rows.length };
      return { rows: [], rowCount: 0 };
    };
    const res = await request(makeApp()).get('/api/dm/3?before=501');
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(200);
    expect(res.body.messages[0].id).toBeLessThan(res.body.messages[199].id);
    expect(res.body.has_more).toBe(true);
    expect(calls(/UPDATE direct_messages SET read_at/)).toHaveLength(0);
  });
});

describe('messaging_blocked + retention', () => {
  test('a muted user cannot post to company chat', async () => {
    mockUser = WORKER;
    handler = (sql) => (/SELECT messaging_blocked FROM users/.test(sql) ? { rows: [{ messaging_blocked: true }], rowCount: 1 } : { rows: [], rowCount: 0 });
    const res = await request(makeApp()).post('/api/chat').send({ body: 'hi' });
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('muted');
    expect(calls(/INSERT INTO company_chat /)).toHaveLength(0);
  });

  test('a stored retention of 0 prunes with 1 day, never 0', async () => {
    mockUser = WORKER;
    handler = (sql) => {
      if (/INSERT INTO company_chat /.test(sql)) return { rows: [{ id: 5 }], rowCount: 1 };
      if (/key = 'chat_retention_days'/.test(sql)) return { rows: [{ value: '0' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    await request(makeApp()).post('/api/chat').send({ body: 'hi' });
    expect(calls(/DELETE FROM company_chat/)[0][1][1]).toBe(1);
  });

  test('chatRetentionDays clamps to whole days 1..90', () => {
    expect(chatRetentionDays('0')).toBe(1);
    expect(chatRetentionDays(-5)).toBe(1);
    expect(chatRetentionDays('2.7')).toBe(2);
    expect(chatRetentionDays(500)).toBe(90);
    expect(chatRetentionDays(undefined)).toBe(3);
    expect(chatRetentionDays('abc')).toBe(3);
  });
});
