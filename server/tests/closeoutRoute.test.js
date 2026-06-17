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
const route   = require('../routes/closeout');

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

describe('GET /api/projects/:id/closeout', () => {
  test('404 when project not in caller company', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp()).get('/api/projects/42/closeout');
    expect(res.status).toBe(404);
  });

  test('returns null closeout when not yet opened', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 42, name: 'Test' }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });  // no closeout row
    const res = await request(makeApp()).get('/api/projects/42/closeout');
    expect(res.status).toBe(200);
    expect(res.body.closeout).toBeNull();
    expect(res.body.items).toEqual([]);
  });
});

describe('POST /api/projects/:id/closeout/transition', () => {
  test('400 on unknown to_status', async () => {
    const res = await request(makeApp())
      .post('/api/projects/42/closeout/transition')
      .send({ to_status: 'banana' });
    expect(res.status).toBe(400);
  });

  test('404 when closeout not opened', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 42, name: 'Test' }] })  // project
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });                          // closeout
    const res = await request(makeApp())
      .post('/api/projects/42/closeout/transition')
      .send({ to_status: 'substantially_complete' });
    expect(res.status).toBe(404);
  });

  test('409 when transitioning to substantially_complete with punchlist not done', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 42, name: 'Test' }] })            // project
      .mockResolvedValueOnce({ rowCount: 1, rows: [{                                      // closeout
        id: 99, project_id: 42, status: 'in_progress',
        substantial_completion_date: null, final_completion_date: null,
      }] })
      .mockResolvedValueOnce({ rowCount: 2, rows: [                                       // items
        { category: 'punchlist',        status: 'in_progress' },
        { category: 'final_inspection', status: 'done' },
      ] });
    const res = await request(makeApp())
      .post('/api/projects/42/closeout/transition')
      .send({ to_status: 'substantially_complete' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/punchlist/);
  });

  test('409 when transitioning to final_complete with required items pending', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 42, name: 'Test' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{
        id: 99, project_id: 42, status: 'substantially_complete',
        substantial_completion_date: '2026-05-01', final_completion_date: null,
      }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ missing: '3' }] });  // 3 required items still pending
    const res = await request(makeApp())
      .post('/api/projects/42/closeout/transition')
      .send({ to_status: 'final_complete' });
    expect(res.status).toBe(409);
  });
});

describe('PATCH /api/closeout-items/:id', () => {
  test('404 when item not in caller company', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp())
      .patch('/api/closeout-items/7')
      .send({ status: 'done' });
    expect(res.status).toBe(404);
  });

  test('409 when attempting to toggle an auto_source item', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{
      id: 7, project_id: 42, closeout_id: 99,
      status: 'pending', auto_source: 'punchlist',
    }] });
    const res = await request(makeApp())
      .patch('/api/closeout-items/7')
      .send({ status: 'done' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/auto-computed/i);
  });

  test('400 on invalid status', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{
      id: 7, project_id: 42, closeout_id: 99,
      status: 'pending', auto_source: null,
    }] });
    const res = await request(makeApp())
      .patch('/api/closeout-items/7')
      .send({ status: 'banana' });
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/closeout-template', () => {
  test('400 on items not an array', async () => {
    const res = await request(makeApp())
      .put('/api/closeout-template')
      .send({ items: 'nope' });
    expect(res.status).toBe(400);
  });

  test('400 on invalid category in an item', async () => {
    const res = await request(makeApp())
      .put('/api/closeout-template')
      .send({ items: [{ category: 'banana', title: 'X' }] });
    expect(res.status).toBe(400);
  });

  test('400 on missing title', async () => {
    const res = await request(makeApp())
      .put('/api/closeout-template')
      .send({ items: [{ category: 'punchlist', title: '   ' }] });
    expect(res.status).toBe(400);
  });
});
