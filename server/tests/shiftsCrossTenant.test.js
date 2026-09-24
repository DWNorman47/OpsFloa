/**
 * POST/PATCH /admin/shifts must not store another tenant's project_id (the
 * project_name join would then leak that tenant's project name via /admin and
 * /mine), and every project join is scoped to the shift's company.
 */
let mockUser;
jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = mockUser; next(); },
  requireAdmin: (req, _res, next) => { req.user = mockUser; next(); },
}));
jest.mock('../push', () => ({ sendPushToUser: jest.fn(), sendPushToCompanyAdmins: jest.fn() }));
jest.mock('../routes/inbox', () => ({ createInboxItem: jest.fn(), createInboxItemBatch: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const shifts = require('../routes/shifts');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error() {} }; next(); });
  app.use('/api/shifts', shifts);
  return app;
}

// projects: id 10 belongs to company 7 (ours), id 99 to company 8
function installDb() {
  pool.query.mockImplementation(async (sql, params = []) => {
    if (/SELECT id FROM users WHERE id = \$1 AND company_id/.test(sql)) return { rowCount: 1, rows: [{ id: params[0] }] };
    if (/SELECT 1 FROM projects WHERE id = \$1 AND company_id = \$2/.test(sql)) {
      const ok = (String(params[0]) === '10' && String(params[1]) === '7') || (String(params[0]) === '99' && String(params[1]) === '8');
      return { rowCount: ok ? 1 : 0, rows: ok ? [{}] : [] };
    }
    if (/INSERT INTO shifts/.test(sql)) return { rowCount: 1, rows: [{ id: 1, user_id: 3, shift_date: '2026-10-01', start_time: '07:00:00', end_time: '15:00:00', project_name: null, worker_name: 'W' }] };
    if (/UPDATE shifts SET project_id/.test(sql)) return { rowCount: 1, rows: [{ id: 1 }] };
    if (/FROM shifts s/.test(sql)) return { rowCount: 1, rows: [{ id: 1, user_id: 3, shift_date: '2026-10-01', start_time: '07:00:00', end_time: '15:00:00', worker_name: 'W' }] };
    return { rowCount: 0, rows: [] };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { id: 1, company_id: 7, role: 'admin', full_name: 'Admin' };
  installDb();
});

const body = extra => ({ user_id: 3, shift_date: '2026-10-01', start_time: '07:00', end_time: '15:00', ...extra });
const wrote = re => pool.query.mock.calls.some(([sql]) => re.test(sql));

test('POST rejects another company\'s project_id and writes nothing', async () => {
  const res = await request(makeApp()).post('/api/shifts/admin').send(body({ project_id: 99 }));
  expect(res.status).toBe(400);
  expect(wrote(/INSERT INTO shifts/)).toBe(false);
});

test('POST accepts own project_id and no project', async () => {
  expect((await request(makeApp()).post('/api/shifts/admin').send(body({ project_id: 10 }))).status).toBe(201);
  expect((await request(makeApp()).post('/api/shifts/admin').send(body({}))).status).toBe(201);
});

test('PATCH rejects another company\'s project_id and writes nothing', async () => {
  const res = await request(makeApp()).patch('/api/shifts/admin/1').send(body({ project_id: 99 }));
  expect(res.status).toBe(400);
  expect(wrote(/UPDATE shifts/)).toBe(false);
});

test('PATCH accepts own project_id', async () => {
  const res = await request(makeApp()).patch('/api/shifts/admin/1').send(body({ project_id: 10 }));
  expect(res.status).toBe(200);
});

test('every project_name join is scoped to the shift company (GET /admin, GET /mine)', async () => {
  await request(makeApp()).get('/api/shifts/admin');
  pool.query.mockImplementationOnce(async () => ({ rows: [{ plan: 'business', subscription_status: 'active' }] }));
  await request(makeApp()).get('/api/shifts/mine');
  const joins = pool.query.mock.calls.map(([sql]) => sql).filter(sql => /LEFT JOIN projects p/.test(sql));
  expect(joins.length).toBeGreaterThanOrEqual(2);
  for (const sql of joins) expect(sql).toMatch(/LEFT JOIN projects p ON s\.project_id = p\.id AND p\.company_id = s\.company_id/);
});
