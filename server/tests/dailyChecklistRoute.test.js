/**
 * Daily Checklist route — the Phase 1 logic that isn't just CRUD:
 *   - start assembles recurring items + rolled-over unchecked items, deduped by text
 *   - start is idempotent (a second start returns the live day, inserts nothing)
 *   - complete only closes an active day
 *   - checking an item stamps checked_by/checked_at; a non-active day is rejected
 * Permission middleware is stubbed here (its wiring is covered by the enum/permissions
 * layer); these tests exercise the handler logic.
 */

jest.mock('../permissions', () => ({ requirePerm: () => (_req, _res, next) => next() }));
jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const route = require('../routes/dailyChecklist');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 5, company_id: 'co-1' }; req.log = { error: () => {} }; next(); });
  app.use('/api/daily-checklist', route);
  return app;
}

beforeEach(() => { pool.query.mockReset(); pool.connect.mockReset(); });

describe('POST /projects/:id/start', () => {
  test('assembles recurring + rolled-over unchecked items, deduped by text', async () => {
    const inserted = [];
    const client = {
      query: jest.fn(async (sql, params) => {
        if (/SELECT 1 FROM projects/.test(sql)) return { rowCount: 1, rows: [{ n: 1 }] };
        if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return {};
        if (/status = 'active'/.test(sql)) return { rows: [] };                          // none active yet
        if (/MAX\(day_number\)/.test(sql)) return { rows: [{ n: 3 }] };                   // this is worked day 3
        if (/INSERT INTO daily_checklists/.test(sql)) return { rows: [{ id: 99, project_id: 7, day_number: 3, status: 'active' }] };
        if (/FROM daily_checklist_recurring_items/.test(sql)) return { rows: [{ text: 'Check fire extinguisher' }, { text: 'Sweep site' }] };
        if (/status = 'completed' ORDER BY/.test(sql)) return { rows: [{ id: 50 }] };     // previous completed day
        if (/checked = false/.test(sql)) return { rows: [{ text: 'Sweep site' }, { text: 'Fix rail on level 2' }] }; // 'Sweep site' dups recurring
        if (/INSERT INTO daily_checklist_items/.test(sql)) { inserted.push({ text: params[1], source: params[3] }); return { rows: [] }; }
        if (/SELECT id, text, checked/.test(sql)) return { rows: inserted.map((it, i) => ({ id: i + 1, ...it, checked: false, order_index: i })) };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    pool.connect.mockResolvedValue(client);

    const res = await request(makeApp()).post('/api/daily-checklist/projects/7/start').send({ work_date: '2026-08-05' });

    expect(res.status).toBe(201);
    expect(res.body.started).toBe(true);
    // recurring both kept; rollover 'Sweep site' deduped away; 'Fix rail' carried
    expect(inserted).toEqual([
      { text: 'Check fire extinguisher', source: 'recurring' },
      { text: 'Sweep site', source: 'recurring' },
      { text: 'Fix rail on level 2', source: 'rollover' },
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('is idempotent — a day already active returns it and inserts nothing', async () => {
    const client = {
      query: jest.fn(async (sql) => {
        if (/SELECT 1 FROM projects/.test(sql)) return { rowCount: 1, rows: [{}] };
        if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return {};
        if (/status = 'active'/.test(sql)) return { rows: [{ id: 42, status: 'active', day_number: 2 }] };
        if (/SELECT id, text, checked/.test(sql)) return { rows: [] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    pool.connect.mockResolvedValue(client);

    const res = await request(makeApp()).post('/api/daily-checklist/projects/7/start').send({});

    expect(res.status).toBe(200);
    expect(res.body.started).toBe(false);
    expect(res.body.day.id).toBe(42);
    const sqls = client.query.mock.calls.map(c => c[0]).join('\n');
    expect(sqls).not.toMatch(/INSERT INTO daily_checklists/);
  });

  test('404 when the project is not in the company', async () => {
    const client = { query: jest.fn(async () => ({ rowCount: 0, rows: [] })), release: jest.fn() };
    pool.connect.mockResolvedValue(client);
    const res = await request(makeApp()).post('/api/daily-checklist/projects/999/start').send({});
    expect(res.status).toBe(404);
    expect(client.release).toHaveBeenCalled();
  });
});

describe('POST /days/:id/complete', () => {
  test('closes an active day', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 42, status: 'completed' }] });
    const res = await request(makeApp()).post('/api/daily-checklist/days/42/complete').send({});
    expect(res.status).toBe(200);
    expect(res.body.day.status).toBe('completed');
  });

  test('409 when the day is not active (already completed)', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })                        // UPDATE matched nothing
      .mockResolvedValueOnce({ rows: [{ id: 42, status: 'completed' }] });     // loadDay → exists but not active
    const res = await request(makeApp()).post('/api/daily-checklist/days/42/complete').send({});
    expect(res.status).toBe(409);
  });
});

describe('PATCH /days/:id/items/:itemId', () => {
  test('checking an item stamps checked_by + checked_at', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 42, company_id: 'co-1', status: 'active' }] }) // loadDay
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 3, checked: true }] });           // UPDATE
    const res = await request(makeApp()).patch('/api/daily-checklist/days/42/items/3').send({ checked: true });
    expect(res.status).toBe(200);
    const [sql, vals] = pool.query.mock.calls[1];
    expect(sql).toMatch(/checked_by = \$/);
    expect(sql).toMatch(/checked_at = now\(\)/);
    expect(vals).toContain(5); // req.user.id stamped as checked_by
  });

  test('rejects edits to a non-active day', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 42, company_id: 'co-1', status: 'completed' }] });
    const res = await request(makeApp()).patch('/api/daily-checklist/days/42/items/3').send({ checked: true });
    expect(res.status).toBe(409);
  });
});
