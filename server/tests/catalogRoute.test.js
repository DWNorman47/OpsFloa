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
jest.mock('../db', () => ({ query: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool    = require('../db');
const catalogRoute = require('../routes/catalog');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', catalogRoute);
  return app;
}

beforeEach(() => {
  pool.query.mockReset();
  mockCurrentUser = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'Admin' };
});

describe('GET /api/catalog/items', () => {
  test('scopes to caller company and returns the rows', async () => {
    pool.query.mockResolvedValueOnce({ rows: [
      { id: 1, name: '2x4 Stud', is_stocked: true, sell_price_cents: 420 },
      { id: 2, name: 'Drywall 5/8"', is_stocked: false, sell_price_cents: 1850 },
    ] });
    const res = await request(makeApp()).get('/api/catalog/items');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    const call = pool.query.mock.calls[0];
    expect(call[1][0]).toBe('co-1');
  });

  test('tag filter is applied via ANY(catalog_tags)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await request(makeApp()).get('/api/catalog/items').query({ tag: 'drywall' });
    const call = pool.query.mock.calls[0];
    expect(call[0]).toMatch(/= ANY\(catalog_tags\)/);
    expect(call[1]).toContain('drywall');
  });
});

describe('GET /api/catalog/items/:id/estimate-line', () => {
  test('404 when item not in caller company', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp()).get('/api/catalog/items/9/estimate-line');
    expect(res.status).toBe(404);
  });

  test('uses sell_price_cents directly when present', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{
      id: 9, name: '2x4', unit: 'ea', unit_cost: '3.50',
      sell_price_cents: 500, default_markup_pct: 25,
      default_estimate_category: 'materials',
    }] });
    const res = await request(makeApp()).get('/api/catalog/items/9/estimate-line');
    expect(res.status).toBe(200);
    expect(res.body.unit_cost_cents).toBe(500);       // price (sell)
    expect(res.body.cost_cents).toBe(350);            // cost basis (supplier cost $3.50)
    expect(res.body.category).toBe('materials');
    expect(res.body.source_item_id).toBe(9);
  });

  test('falls back to default_markup_pct over unit_cost when no sell_price_cents', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{
      id: 9, name: 'Brick', unit: 'ea', unit_cost: '0.80',
      sell_price_cents: null, default_markup_pct: 25,  // 25% markup on $0.80 = $1.00
      default_estimate_category: null,                  // will default to 'materials'
    }] });
    const res = await request(makeApp()).get('/api/catalog/items/9/estimate-line');
    expect(res.status).toBe(200);
    expect(res.body.unit_cost_cents).toBe(100);  // round(80 * 1.25) = 100
    expect(res.body.category).toBe('materials');
  });

  test('falls back to plain unit_cost when no sell_price, no markup, no company default', async () => {
    // 1) item SELECT   2) company markups setting (none set → null)
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{
      id: 9, name: 'Tape', unit: 'roll', unit_cost: '4.50',
      sell_price_cents: null, default_markup_pct: null,
      default_estimate_category: 'other',
    }] });
    pool.query.mockResolvedValueOnce({ rows: [] });  // no estimate_default_markups row
    const res = await request(makeApp()).get('/api/catalog/items/9/estimate-line');
    expect(res.status).toBe(200);
    expect(res.body.unit_cost_cents).toBe(450);
    expect(res.body.category).toBe('other');
  });

  test('applies the company default markup for the category when the item has none', async () => {
    // Item has cost but no sell price and no own markup; company sets materials=25%.
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{
      id: 9, name: 'Conduit', unit: 'ft', unit_cost: '2.00',
      sell_price_cents: null, default_markup_pct: null,
      default_estimate_category: 'materials',
    }] });
    pool.query.mockResolvedValueOnce({ rows: [{ value: JSON.stringify({ materials: 25, subs: 10 }) }] });
    const res = await request(makeApp()).get('/api/catalog/items/9/estimate-line');
    expect(res.status).toBe(200);
    expect(res.body.unit_cost_cents).toBe(250);  // round(200 * 1.25)
    expect(res.body.category).toBe('materials');
  });
});

describe('assemblies', () => {
  test('POST rejects a missing name', async () => {
    const res = await request(makeApp()).post('/api/catalog/assemblies').send({ items: [] });
    expect(res.status).toBe(400);
  });

  test('GET /assemblies/:id/estimate-lines expands members with member qty', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 3, name: 'Bath rough-in' }] })  // assembly
      .mockResolvedValueOnce({ rows: [
        { id: 1, name: 'PVC pipe', unit: 'ft', unit_cost: '2.00', sell_price_cents: 400, default_markup_pct: null, default_estimate_category: 'materials', member_qty: '10' },
        { id: 2, name: 'Elbow', unit: 'ea', unit_cost: '0.50', sell_price_cents: null, default_markup_pct: 100, default_estimate_category: 'materials', member_qty: '4' },
      ] });
    const res = await request(makeApp()).get('/api/catalog/assemblies/3/estimate-lines');
    expect(res.status).toBe(200);
    expect(res.body.lines).toHaveLength(2);
    expect(res.body.lines[0]).toMatchObject({ description: 'PVC pipe', unit_cost_cents: 400, cost_cents: 200, qty: 10 });
    expect(res.body.lines[1]).toMatchObject({ description: 'Elbow', unit_cost_cents: 100, qty: 4 });  // 50c × 2.0
  });

  test('GET /assemblies/:id/estimate-lines 404 when not in company', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp()).get('/api/catalog/assemblies/9/estimate-lines');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/catalog/items', () => {
  test('creates a catalog-only row and returns it', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 42, name: 'Rebar #4', is_stocked: false, sell_price_cents: 780 }] });
    const res = await request(makeApp()).post('/api/catalog/items').send({
      name: 'Rebar #4', unit: 'ft', sell_price_cents: 780, default_estimate_category: 'materials',
      catalog_tags: ['concrete', 'concrete', ' '],  // deduped + trimmed
    });
    expect(res.status).toBe(201);
    expect(res.body.item.id).toBe(42);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO inventory_items/);
    expect(sql).toMatch(/is_stocked/);
    expect(params[0]).toBe('co-1');           // company scope
    expect(params).toContainEqual(['concrete']);  // tags deduped to one
  });

  test('rejects a missing name', async () => {
    const res = await request(makeApp()).post('/api/catalog/items').send({ unit: 'ea' });
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('rejects an invalid category', async () => {
    const res = await request(makeApp()).post('/api/catalog/items').send({ name: 'X', default_estimate_category: 'bogus' });
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('maps a duplicate SKU to 409', async () => {
    pool.query.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    const res = await request(makeApp()).post('/api/catalog/items').send({ name: 'X', sku: 'DUP' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('duplicate_sku');
  });
});

describe('PATCH /api/catalog/items/:id', () => {
  test('updates only the provided fields, scoped to company', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 5, name: 'Y', sell_price_cents: 900 }] });
    const res = await request(makeApp()).patch('/api/catalog/items/5').send({ sell_price_cents: 900 });
    expect(res.status).toBe(200);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE inventory_items SET sell_price_cents = \$1/);
    expect(sql).toMatch(/company_id = \$3/);
    expect(params[params.length - 1]).toBe('co-1');
  });

  test('404 when nothing matched', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp()).patch('/api/catalog/items/5').send({ name: 'Z' });
    expect(res.status).toBe(404);
  });

  test('400 when no updatable fields are sent', async () => {
    const res = await request(makeApp()).patch('/api/catalog/items/5').send({});
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/catalog/items/:id', () => {
  test('deletes a catalog-only row', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ is_stocked: false }] });  // lookup
    pool.query.mockResolvedValueOnce({ rowCount: 1 });                                  // delete
    const res = await request(makeApp()).delete('/api/catalog/items/5');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('refuses to delete a stocked inventory item', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ is_stocked: true }] });
    const res = await request(makeApp()).delete('/api/catalog/items/5');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('is_stocked');
    expect(pool.query).toHaveBeenCalledTimes(1);  // never reached the DELETE
  });
});

describe('POST /api/catalog/items/bulk', () => {
  function mockClient() {
    const client = { query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }), release: jest.fn() };
    pool.connect = jest.fn().mockResolvedValue(client);
    return client;
  }

  test('inserts new rows and updates existing by SKU', async () => {
    const client = mockClient();
    // BEGIN, [row1: UPDATE→0 then INSERT], [row2: UPDATE→1], COMMIT
    client.query
      .mockResolvedValueOnce({})                       // BEGIN
      .mockResolvedValueOnce({ rowCount: 0 })          // row1 UPDATE (no match)
      .mockResolvedValueOnce({ rowCount: 1 })          // row1 INSERT
      .mockResolvedValueOnce({ rowCount: 1 })          // row2 UPDATE (matched existing SKU)
      .mockResolvedValueOnce({});                      // COMMIT
    const res = await request(makeApp()).post('/api/catalog/items/bulk').send({
      items: [
        { name: 'New Item', sku: 'NEW-1', sell_price_cents: 100 },
        { name: 'Existing', sku: 'OLD-1', unit_cost: 3 },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 1, updated: 1 });
    expect(res.body.errors).toHaveLength(0);
    expect(client.release).toHaveBeenCalled();
  });

  test('collects per-row validation errors without aborting the import', async () => {
    const client = mockClient();
    client.query
      .mockResolvedValueOnce({})                       // BEGIN
      .mockResolvedValueOnce({ rowCount: 1 })          // good row INSERT (no sku → straight insert)
      .mockResolvedValueOnce({});                      // COMMIT
    const res = await request(makeApp()).post('/api/catalog/items/bulk').send({
      items: [
        { name: 'Good', sell_price_cents: 500 },
        { name: '' },  // invalid — no name
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    expect(res.body.errors).toEqual([{ row: 2, error: 'name is required' }]);
  });

  test('rejects a non-array body', async () => {
    const res = await request(makeApp()).post('/api/catalog/items/bulk').send({ items: 'nope' });
    expect(res.status).toBe(400);
  });
});
