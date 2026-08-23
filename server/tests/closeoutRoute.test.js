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

  test('409 when transitioning to final_complete with a required manual item pending', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 42, name: 'Test' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{
        id: 99, project_id: 42, status: 'substantially_complete',
        substantial_completion_date: '2026-05-01', final_completion_date: null,
      }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [                        // required items
        { category: 'as_builts', status: 'pending', auto_source: null },  // manual, not done
      ] });
    const res = await request(makeApp())
      .post('/api/projects/42/closeout/transition')
      .send({ to_status: 'final_complete' });
    expect(res.status).toBe(409);
  });

  // The bug this phase fixes: an auto item is never persisted past 'pending', so
  // a gate that read the stored status blocked final_complete for EVERY company.
  // The gate now computes the effective status; an unpaid final invoice blocks.
  test('409 to final_complete when the auto final_invoice item is not paid (computed, not stored)', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 42, name: 'Test' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{
        id: 99, project_id: 42, status: 'substantially_complete',
        substantial_completion_date: '2026-05-01', final_completion_date: null,
      }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [
        { category: 'final_invoice', status: 'pending', auto_source: 'invoices' },
      ] })
      .mockResolvedValueOnce({ rows: [{ done: '0' }] }); // computeAutoStatus: no paid invoice
    const res = await request(makeApp())
      .post('/api/projects/42/closeout/transition')
      .send({ to_status: 'final_complete' });
    expect(res.status).toBe(409);
  });

  // Compute-on-read makes substantial reachable: punchlist has no open items, so
  // its auto status computes 'done' even though the stored row is still 'pending'.
  test('substantially_complete succeeds when punchlist auto-computes done', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 42, name: 'Test' }] })       // project
      .mockResolvedValueOnce({ rowCount: 1, rows: [{                                  // closeout
        id: 99, project_id: 42, status: 'in_progress',
        substantial_completion_date: null, final_completion_date: null,
      }] })
      .mockResolvedValueOnce({ rowCount: 2, rows: [                                   // gate items
        { category: 'punchlist',        status: 'pending', auto_source: 'punchlist' },
        { category: 'final_inspection', status: 'done',    auto_source: null },
      ] })
      .mockResolvedValueOnce({ rows: [{ open_count: '0', total: '5' }] })             // punchlist compute → done
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 99, status: 'substantially_complete' }] }); // UPDATE
    const res = await request(makeApp())
      .post('/api/projects/42/closeout/transition')
      .send({ to_status: 'substantially_complete' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('substantially_complete');
  });
});

// The auto-status source repoint (project_invoices → native invoices), exercised
// through the GET read path where auto items are computed.
describe('closeout auto-status from native invoices', () => {
  function getWithSingleItem(item, computeRows) {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 42, name: 'Test' }] })          // project
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 99, project_id: 42 }] })         // closeout
      .mockResolvedValueOnce({ rowCount: 1, rows: [item] })                               // items
      .mockResolvedValueOnce({ rows: computeRows });                                       // computeAutoStatus
    return request(makeApp()).get('/api/projects/42/closeout');
  }

  test('final_invoice is done when a native invoice is paid', async () => {
    const res = await getWithSingleItem(
      { id: 1, category: 'final_invoice', status: 'pending', auto_source: 'invoices' },
      [{ done: '1' }]
    );
    expect(res.status).toBe(200);
    expect(res.body.items[0].status).toBe('done');
  });

  test('retainage_release is NOT falsely done when there are zero invoices', async () => {
    const res = await getWithSingleItem(
      { id: 1, category: 'retainage_release', status: 'pending', auto_source: 'invoices' },
      [{ n: '0', outstanding: '0' }]  // no invoices → must not report done
    );
    expect(res.status).toBe(200);
    expect(res.body.items[0].status).toBe('in_progress');
  });

  test('retainage_release is done when invoices exist and hold no retainage', async () => {
    const res = await getWithSingleItem(
      { id: 1, category: 'retainage_release', status: 'pending', auto_source: 'invoices' },
      [{ n: '2', outstanding: '0' }]  // invoices exist, nothing outstanding
    );
    expect(res.status).toBe(200);
    expect(res.body.items[0].status).toBe('done');
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

  // The escape hatch: an auto item CAN be manually waived (overrides the compute).
  test('an auto_source item can be manually waived', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7, project_id: 42, closeout_id: 99, status: 'pending', auto_source: 'invoices' }] }) // ownership check
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7, status: 'waived' }] }); // UPDATE ... RETURNING *
    const res = await request(makeApp())
      .patch('/api/closeout-items/7')
      .send({ status: 'waived' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('waived');
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
