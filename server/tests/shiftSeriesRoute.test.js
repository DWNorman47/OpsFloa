let mockUser;

jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));
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
const { sendPushToUser } = require('../push');
const { createInboxItem } = require('../routes/inbox');
const { logAudit } = require('../auditLog');
const shifts = require('../routes/shifts');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error() {} }; next(); });
  app.use('/api/shifts', shifts);
  return app;
}

function seriesBody(overrides = {}) {
  return {
    user_id: 12,
    project_id: 31,
    dates: ['2026-10-02', '2026-10-09', '2026-10-16'],
    start_time: '08:00',
    end_time: '16:30',
    notes: 'Bring PPE',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { id: 7, company_id: 'company-1', role: 'admin', full_name: 'Admin User' };
});

test('creates a bounded recurring series atomically and notifies once', async () => {
  const client = {
    query: jest.fn(async (sql, params = []) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      if (/SELECT id, full_name FROM users/.test(sql)) return { rowCount: 1, rows: [{ id: 12, full_name: 'Nora Bennett' }] };
      if (/SELECT 1 FROM projects/.test(sql)) return { rowCount: 1, rows: [{}] };
      if (/WITH inserted AS/.test(sql)) {
        return {
          rowCount: 3,
          rows: params[3].map((date, index) => ({
            id: 40 + index,
            user_id: 12,
            shift_date: date,
            start_time: '08:00:00',
            end_time: '16:30:00',
            worker_name: 'Nora Bennett',
            project_name: 'Mesa Drainage',
          })),
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValue(client);

  const response = await request(makeApp()).post('/api/shifts/admin/series').send(seriesBody());

  expect(response.status).toBe(201);
  expect(response.body).toEqual(expect.objectContaining({ count: 3, items: expect.any(Array), recurrence_group_id: expect.any(String) }));
  expect(response.body.recurrence_group_id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining(['BEGIN', 'COMMIT']));
  expect(client.query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(false);
  const insertCall = client.query.mock.calls.find(([sql]) => /WITH inserted AS/.test(sql));
  expect(insertCall[1]).toEqual([
    'company-1', 12, 31, ['2026-10-02', '2026-10-09', '2026-10-16'],
    '08:00', '16:30', 'Bring PPE', response.body.recurrence_group_id,
  ]);
  expect(sendPushToUser).toHaveBeenCalledTimes(1);
  expect(createInboxItem).toHaveBeenCalledTimes(1);
  expect(logAudit).toHaveBeenCalledWith(
    'company-1', 7, 'Admin User', 'shift.series_created', 'shift', response.body.recurrence_group_id, 'Nora Bennett',
    expect.objectContaining({ count: 3, first_date: '2026-10-02', last_date: '2026-10-16' })
  );
  expect(client.release).toHaveBeenCalledTimes(1);
});

test('rolls back the entire recurring series when insertion fails', async () => {
  const client = {
    query: jest.fn(async sql => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (/SELECT id, full_name FROM users/.test(sql)) return { rowCount: 1, rows: [{ id: 12, full_name: 'Nora Bennett' }] };
      if (/SELECT 1 FROM projects/.test(sql)) return { rowCount: 1, rows: [{}] };
      if (/WITH inserted AS/.test(sql)) throw new Error('insert failed');
      throw new Error(`Unexpected SQL: ${sql}`);
    }),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValue(client);

  const response = await request(makeApp()).post('/api/shifts/admin/series').send(seriesBody());

  expect(response.status).toBe(500);
  expect(client.query.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
  expect(sendPushToUser).not.toHaveBeenCalled();
  expect(createInboxItem).not.toHaveBeenCalled();
  expect(client.release).toHaveBeenCalledTimes(1);
});

test('rejects malformed series input before opening a transaction', async () => {
  const invalidBodies = [
    seriesBody({ dates: ['2026-10-02'] }),
    seriesBody({ dates: ['2026-10-02', '2026-10-02'] }),
    seriesBody({ dates: ['2026-10-09', '2026-10-02'] }),
    seriesBody({ dates: ['2026-02-30', '2026-03-09'] }),
    seriesBody({ start_time: '8:00' }),
    seriesBody({ end_time: '08:00' }),
    seriesBody({ user_id: '12' }),
    seriesBody({ notes: 7 }),
  ];

  for (const body of invalidBodies) {
    const response = await request(makeApp()).post('/api/shifts/admin/series').send(body);
    expect(response.status).toBe(400);
  }
  expect(pool.connect).not.toHaveBeenCalled();
});

test('rejects a malformed recurrence group before cancellation SQL', async () => {
  const response = await request(makeApp()).delete('/api/shifts/admin/series/not-a-uuid');
  expect(response.status).toBe(400);
  expect(pool.query).not.toHaveBeenCalled();
});
