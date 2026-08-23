let mockCurrentUser;
jest.mock('../middleware/auth', () => ({
  requireAuth:  (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireAdmin: (req, _res, next) => { req.user = mockCurrentUser; next(); },
}));
jest.mock('../middleware/commercialAccess', () => ({
  requireCommercialAccess: (req, _res, next) => { req.user = mockCurrentUser; next(); },
}));
jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../r2', () => ({ uploadBase64: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const equipmentRoute = require('../routes/equipment');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error: () => {} }; next(); });
  app.use('/api/equipment', equipmentRoute);
  return app;
}

beforeEach(() => {
  pool.query.mockReset();
  mockCurrentUser = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'Admin' };
});

describe('POST /api/equipment (rate fields)', () => {
  test('persists the new rate columns', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 7, name: 'Excavator' }] });
    const res = await request(makeApp()).post('/api/equipment').send({
      name: 'Excavator',
      rent_out_rate: 400, rent_out_unit: 'day',
      mobilization_cost: 250,
      operating_rate: 120, operating_unit: 'hour',
    });
    expect(res.status).toBe(201);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/rent_out_rate/);
    expect(sql).toMatch(/mobilization_cost/);
    expect(sql).toMatch(/operating_rate/);
    expect(params).toEqual(expect.arrayContaining([400, 'day', 250, 120, 'hour']));
  });

  test('rejects an invalid operating_unit', async () => {
    const res = await request(makeApp()).post('/api/equipment').send({ name: 'X', operating_unit: 'fortnight' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/operating_unit/);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('rejects a negative rate', async () => {
    const res = await request(makeApp()).post('/api/equipment').send({ name: 'X', operating_rate: -5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/operating_rate/);
  });

  test('allows an hourly rent-in rate unit', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 8, name: 'Pump' }] });
    const res = await request(makeApp()).post('/api/equipment').send({
      name: 'Pump', is_rental: true, rental_rate: 15, rental_rate_unit: 'hour',
    });
    expect(res.status).toBe(201);
  });
});

describe('PATCH /api/equipment/:id (partial update)', () => {
  test('editing only the name does NOT wipe rate columns', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ updated_at: '2026-08-18T00:00:00Z', rental_return_due: null }] })  // cur
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 5, name: 'Renamed' }] });                          // update
    const res = await request(makeApp()).patch('/api/equipment/5').send({ name: 'Renamed' });
    expect(res.status).toBe(200);
    const [sql] = pool.query.mock.calls[1];
    expect(sql).toMatch(/name=\$1/);
    expect(sql).not.toMatch(/operating_rate/);
    expect(sql).not.toMatch(/rental_rate/);
  });

  test('updates rate columns when they are supplied', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ updated_at: '2026-08-18T00:00:00Z', rental_return_due: null }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 5 }] });
    const res = await request(makeApp()).patch('/api/equipment/5').send({ operating_rate: 90, operating_unit: 'hour' });
    expect(res.status).toBe(200);
    const [sql, params] = pool.query.mock.calls[1];
    expect(sql).toMatch(/operating_rate=\$1/);
    expect(sql).toMatch(/operating_unit=\$2/);
    expect(params.slice(0, 2)).toEqual([90, 'hour']);
  });

  test('400 when no updatable fields are provided', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ updated_at: '2026-08-18T00:00:00Z', rental_return_due: null }] });
    const res = await request(makeApp()).patch('/api/equipment/5').send({ foo: 'bar' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/equipment/:id/estimate-lines', () => {
  test('returns mobilization + operating lines in cents', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{
      id: 7, name: 'Excavator',
      mobilization_cost: '250.00', operating_rate: '120.00', operating_unit: 'hour',
      rent_out_rate: null, rent_out_unit: null,
    }] });
    const res = await request(makeApp()).get('/api/equipment/7/estimate-lines');
    expect(res.status).toBe(200);
    expect(res.body.lines).toEqual([
      { part: 'mobilization', category: 'equipment', qty: 1, unit: 'trip', unit_cost_cents: 25000 },
      { part: 'operating', category: 'equipment', qty: 1, unit: 'hour', unit_cost_cents: 12000 },
    ]);
  });

  test('falls back to rent-out rate when no on-job rates', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{
      id: 7, name: 'Scaffold', mobilization_cost: null, operating_rate: null, operating_unit: null,
      rent_out_rate: '75.50', rent_out_unit: 'week',
    }] });
    const res = await request(makeApp()).get('/api/equipment/7/estimate-lines');
    expect(res.body.lines).toEqual([
      { part: 'rental', category: 'equipment', qty: 1, unit: 'week', unit_cost_cents: 7550 },
    ]);
  });

  test('always returns at least one line', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{
      id: 7, name: 'Ladder', mobilization_cost: null, operating_rate: null,
      operating_unit: null, rent_out_rate: null, rent_out_unit: null,
    }] });
    const res = await request(makeApp()).get('/api/equipment/7/estimate-lines');
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0]).toMatchObject({ part: 'base', unit_cost_cents: 0 });
  });

  test('404 when the asset is not in the caller company', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp()).get('/api/equipment/9/estimate-lines');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/equipment/:id/hours — hours validation', () => {
  test('rejects negative hours before any DB write (was booking a negative cost credit)', async () => {
    const res = await request(makeApp()).post('/api/equipment/7/hours').send({ log_date: '2026-08-20', hours: -100, project_id: 3 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/between 0 and 24/);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('rejects hours over 24', async () => {
    const res = await request(makeApp()).post('/api/equipment/7/hours').send({ log_date: '2026-08-20', hours: 9999, project_id: 3 });
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('rejects a non-numeric hours value', async () => {
    const res = await request(makeApp()).post('/api/equipment/7/hours').send({ log_date: '2026-08-20', hours: 'lots', project_id: 3 });
    expect(res.status).toBe(400);
  });
});
