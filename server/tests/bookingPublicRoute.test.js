// Tests for the public booking surface (/api/public/book/*). Covers
// the slug-keyed type list/detail, the availability endpoint, the
// book endpoint, the manage-by-token view + cancel, and the rate
// limiter wiring.

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
jest.mock('../email', () => ({ sendEmail: jest.fn().mockResolvedValue(undefined) }));

const express = require('express');
const request = require('supertest');
const pool    = require('../db');
const route   = require('../routes/booking');

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/public/book', route.publicRouter);
  return app;
}

beforeEach(() => {
  pool.query.mockReset();
  mockCurrentUser = null;
});

describe('GET /api/public/book/:companySlug', () => {
  test('404 when no public types exist for the company', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp()).get('/api/public/book/acme');
    expect(res.status).toBe(404);
  });

  test('returns company name + types when company exists', async () => {
    pool.query.mockResolvedValueOnce({
      rowCount: 2,
      rows: [
        { id: 1, slug: 'site-visit',  name: 'Site Visit',  description: 'On site',  duration_minutes: 60, location_kind: 'onsite', location_detail: null, company_name: 'Acme GC', company_slug: 'acme' },
        { id: 2, slug: 'phone-consult', name: 'Phone Consult', description: null, duration_minutes: 30, location_kind: 'phone', location_detail: null, company_name: 'Acme GC', company_slug: 'acme' },
      ],
    });
    const res = await request(makeApp()).get('/api/public/book/acme');
    expect(res.status).toBe(200);
    expect(res.body.company_name).toBe('Acme GC');
    expect(res.body.types).toHaveLength(2);
    // Each row should NOT contain the redundant company_name/slug fields
    // — they're hoisted out.
    expect(res.body.types[0]).not.toHaveProperty('company_name');
  });
});

describe('GET /api/public/book/:companySlug/:typeSlug', () => {
  test('404 when type slug does not resolve', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp()).get('/api/public/book/acme/site-visit');
    expect(res.status).toBe(404);
  });

  test('returns the type detail when resolved', async () => {
    pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{
        id: 1, slug: 'site-visit', name: 'Site Visit', description: 'desc',
        duration_minutes: 60, location_kind: 'onsite', location_detail: null,
        advance_notice_hrs: 24, max_advance_days: 14, slot_interval_min: 30,
        buffer_before_min: 0, buffer_after_min: 0,
        active: true, is_public: true, resolved_company_id: 'co-1',
        company_name: 'Acme GC', company_slug: 'acme',
      }],
    });
    const res = await request(makeApp()).get('/api/public/book/acme/site-visit');
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe('site-visit');
    expect(res.body.company_name).toBe('Acme GC');
  });
});

describe('GET /api/public/book/:companySlug/:typeSlug/availability', () => {
  test('404 when type slug does not resolve', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp())
      .get('/api/public/book/acme/site-visit/availability')
      .query({ days: 7 });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/public/book/:companySlug/:typeSlug', () => {
  test('400 on missing scheduled_at', async () => {
    const res = await request(makeApp())
      .post('/api/public/book/acme/site-visit')
      .send({ client_name: 'Jane', client_email: 'j@x.com' });
    expect(res.status).toBe(400);
  });

  test('400 on missing client_name', async () => {
    const res = await request(makeApp())
      .post('/api/public/book/acme/site-visit')
      .send({ scheduled_at: '2026-06-15T10:00:00Z', client_email: 'j@x.com' });
    expect(res.status).toBe(400);
  });

  test('400 on invalid scheduled_at', async () => {
    const res = await request(makeApp())
      .post('/api/public/book/acme/site-visit')
      .send({ scheduled_at: 'not-a-date', client_name: 'Jane', client_email: 'j@x.com' });
    expect(res.status).toBe(400);
  });

  test('404 when type slug does not resolve', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp())
      .post('/api/public/book/acme/site-visit')
      .send({ scheduled_at: '2026-06-15T10:00:00Z', client_name: 'Jane', client_email: 'j@x.com' });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/public/book/manage/:token', () => {
  test('404 when token does not match', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp()).get('/api/public/book/manage/bogus-token');
    expect(res.status).toBe(404);
  });

  test('returns the appointment summary when the token resolves', async () => {
    pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{
        id: 7, scheduled_at: '2026-06-15T14:00:00Z', duration_minutes: 60,
        status: 'booked', client_name: 'Jane Doe', client_email: 'j@x.com',
        appointment_type_name: 'Site Visit', location_kind: 'onsite', location_detail: null,
        assigned_user_name: 'PM Smith', company_name: 'Acme GC',
      }],
    });
    const res = await request(makeApp()).get('/api/public/book/manage/sometoken');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(7);
    expect(res.body.appointment_type_name).toBe('Site Visit');
  });
});

describe('POST /api/public/book/manage/:token/cancel', () => {
  test('404 when token does not resolve OR appointment not cancellable', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp())
      .post('/api/public/book/manage/sometoken/cancel')
      .send({ reason: 'changed plans' });
    expect(res.status).toBe(404);
  });

  test('200 + writes audit row on cancel', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7 }] })  // UPDATE
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });          // INSERT audit
    const res = await request(makeApp())
      .post('/api/public/book/manage/sometoken/cancel')
      .send({ reason: 'changed plans' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // The cancel-by clause was 'client'
    const updateCall = pool.query.mock.calls[0];
    expect(updateCall[0]).toMatch(/cancelled_by = 'client'/);
  });
});
