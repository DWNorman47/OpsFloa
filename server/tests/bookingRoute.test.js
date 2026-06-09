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
jest.mock('../db', () => {
  const q = jest.fn();
  return { query: q, connect: jest.fn().mockResolvedValue({ query: (...a) => q(...a), release: jest.fn() }) };
});
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool    = require('../db');
const route   = require('../routes/booking');

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', route);
  return app;
}

beforeEach(() => {
  pool.query.mockReset();
  mockCurrentUser = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'Admin' };
});

// ── Shift types ────────────────────────────────────────────────────────────

describe('POST /api/shift-types', () => {
  test('400 on missing name', async () => {
    const res = await request(makeApp()).post('/api/shift-types').send({});
    expect(res.status).toBe(400);
  });

  test('409 on duplicate name (PG unique violation)', async () => {
    const err = new Error('duplicate'); err.code = '23505';
    pool.query.mockRejectedValueOnce(err);
    const res = await request(makeApp())
      .post('/api/shift-types')
      .send({ name: 'Office hours' });
    expect(res.status).toBe(409);
  });

  test('201 on success scopes company_id from req.user', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 5, name: 'Office hours' }] });
    const res = await request(makeApp())
      .post('/api/shift-types')
      .send({ name: 'Office hours', color: '#1a56db' });
    expect(res.status).toBe(201);
    const call = pool.query.mock.calls[0];
    expect(call[1][0]).toBe('co-1');
    expect(call[1][2]).toBe('#1a56db');
  });

  test('rejects malformed color (must be #hex6)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 5, name: 'X' }] });
    const res = await request(makeApp())
      .post('/api/shift-types')
      .send({ name: 'X', color: 'red' });
    expect(res.status).toBe(201);  // still succeeds (malformed color is sanitised to null)
    const call = pool.query.mock.calls[0];
    expect(call[1][2]).toBeNull();
  });
});

// ── Appointment types ──────────────────────────────────────────────────────

describe('POST /api/appointment-types', () => {
  test('400 on missing name', async () => {
    const res = await request(makeApp()).post('/api/appointment-types').send({ duration_minutes: 60 });
    expect(res.status).toBe(400);
  });

  test('400 on duration_minutes < 15', async () => {
    const res = await request(makeApp())
      .post('/api/appointment-types')
      .send({ name: 'X', duration_minutes: 10 });
    expect(res.status).toBe(400);
  });

  test('400 on invalid location_kind', async () => {
    const res = await request(makeApp())
      .post('/api/appointment-types')
      .send({ name: 'X', duration_minutes: 30, location_kind: 'banana' });
    expect(res.status).toBe(400);
  });

  test('auto-slugs the name when slug not provided', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 9, slug: 'site-visit-1-hour', name: 'Site Visit (1 hour)' }] });
    const res = await request(makeApp())
      .post('/api/appointment-types')
      .send({ name: 'Site Visit (1 hour)', duration_minutes: 60 });
    expect(res.status).toBe(201);
    const call = pool.query.mock.calls[0];
    // params: [company_id, slug, name, ...]
    expect(call[1][1]).toBe('site-visit-1-hour');
  });

  test('409 on slug uniqueness violation', async () => {
    const err = new Error('duplicate'); err.code = '23505';
    pool.query.mockRejectedValueOnce(err);
    const res = await request(makeApp())
      .post('/api/appointment-types')
      .send({ name: 'X', duration_minutes: 30 });
    expect(res.status).toBe(409);
  });
});

describe('PUT /api/appointment-types/:id/users', () => {
  test('400 on user_ids not an array', async () => {
    const res = await request(makeApp())
      .put('/api/appointment-types/9/users')
      .send({ user_ids: 'nope' });
    expect(res.status).toBe(400);
  });

  test('404 when appointment type not in caller company', async () => {
    pool.query
      .mockResolvedValueOnce(undefined)                                        // BEGIN
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })                        // SELECT … FOR UPDATE
      .mockResolvedValueOnce(undefined);                                       // ROLLBACK
    const res = await request(makeApp())
      .put('/api/appointment-types/9/users')
      .send({ user_ids: [1, 2] });
    expect(res.status).toBe(404);
  });

  test('400 when a user_id is from a different company', async () => {
    pool.query
      .mockResolvedValueOnce(undefined)                                        // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 9 }] })                // appointment_types FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ n: 1 }] })                              // user existence check returns 1
      .mockResolvedValueOnce(undefined);                                       // ROLLBACK
    const res = await request(makeApp())
      .put('/api/appointment-types/9/users')
      .send({ user_ids: [10, 20] });  // submitted 2 user_ids, only 1 came back from check
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/user_ids/);
  });
});

describe('PUT /api/appointment-types/:id/shift-types', () => {
  test('400 on shift_type_ids not an array', async () => {
    const res = await request(makeApp())
      .put('/api/appointment-types/9/shift-types')
      .send({ shift_type_ids: 'nope' });
    expect(res.status).toBe(400);
  });

  test('400 when a shift_type_id is from a different company', async () => {
    pool.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 9 }] })
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })  // 0 of 2 found
      .mockResolvedValueOnce(undefined);
    const res = await request(makeApp())
      .put('/api/appointment-types/9/shift-types')
      .send({ shift_type_ids: [1, 2] });
    expect(res.status).toBe(400);
  });
});

// ── Per-user booking config ────────────────────────────────────────────────

describe('PUT /api/users/:id/booking', () => {
  test('404 when user not in caller company', async () => {
    pool.query
      .mockResolvedValueOnce(undefined)                                        // BEGIN
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })                        // user lookup FOR UPDATE
      .mockResolvedValueOnce(undefined);                                       // ROLLBACK
    const res = await request(makeApp())
      .put('/api/users/9/booking')
      .send({ bookable: true });
    expect(res.status).toBe(404);
  });

  test('400 on invalid weekday in a window', async () => {
    pool.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 9 }] })
      .mockResolvedValueOnce(undefined);
    const res = await request(makeApp())
      .put('/api/users/9/booking')
      .send({ windows: [{ weekday: 7, start_time: '09:00', end_time: '17:00' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/weekday/);
  });

  test('400 when end_time <= start_time', async () => {
    pool.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 9 }] })
      .mockResolvedValueOnce(undefined);
    const res = await request(makeApp())
      .put('/api/users/9/booking')
      .send({ windows: [{ weekday: 1, start_time: '17:00', end_time: '09:00' }] });
    expect(res.status).toBe(400);
  });
});

// ── Availability ───────────────────────────────────────────────────────────

describe('GET /api/appointment-types/:id/availability', () => {
  test('404 when appointment type not in caller company', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp()).get('/api/appointment-types/9/availability');
    expect(res.status).toBe(404);
  });

  test('409 when appointment type is inactive', async () => {
    pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 9, active: false, duration_minutes: 60, advance_notice_hrs: 24, max_advance_days: 14, slot_interval_min: 30, buffer_before_min: 0, buffer_after_min: 0 }],
    });
    const res = await request(makeApp()).get('/api/appointment-types/9/availability');
    expect(res.status).toBe(409);
  });
});

// ── Book ────────────────────────────────────────────────────────────────────

describe('POST /api/appointment-types/:id/book', () => {
  test('400 on missing scheduled_at', async () => {
    const res = await request(makeApp())
      .post('/api/appointment-types/9/book')
      .send({ client_name: 'Jane', client_email: 'j@x.com' });
    expect(res.status).toBe(400);
  });

  test('400 on missing client_name', async () => {
    const res = await request(makeApp())
      .post('/api/appointment-types/9/book')
      .send({ scheduled_at: '2026-06-15T10:00:00Z', client_email: 'j@x.com' });
    expect(res.status).toBe(400);
  });

  test('400 on invalid scheduled_at', async () => {
    const res = await request(makeApp())
      .post('/api/appointment-types/9/book')
      .send({ scheduled_at: 'not-a-date', client_name: 'Jane', client_email: 'j@x.com' });
    expect(res.status).toBe(400);
  });

  test('404 when appointment type not in caller company', async () => {
    pool.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce(undefined);
    const res = await request(makeApp())
      .post('/api/appointment-types/9/book')
      .send({ scheduled_at: '2026-06-15T10:00:00Z', client_name: 'Jane', client_email: 'j@x.com' });
    expect(res.status).toBe(404);
  });
});

// ── List + cancel ──────────────────────────────────────────────────────────

describe('GET /api/appointments', () => {
  test('400 on invalid status filter', async () => {
    const res = await request(makeApp()).get('/api/appointments').query({ status: 'banana' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/appointments/:id/cancel', () => {
  test('404 when appointment not found / not cancellable', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp()).post('/api/appointments/7/cancel').send({});
    expect(res.status).toBe(404);
  });
});
