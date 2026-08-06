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

// ── Phase 2: the day manager ──────────────────────────────────────────────────

describe('POST /projects/:id/start — queue resume + conflict', () => {
  test('409 conflict when a calendar plan and an ordinal plan both claim the day', async () => {
    const client = {
      query: jest.fn(async (sql, params) => {
        if (/SELECT 1 FROM projects/.test(sql)) return { rowCount: 1, rows: [{}] };
        if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return {};
        if (/status = 'active'/.test(sql)) return { rows: [] };
        if (/MAX\(day_number\)/.test(sql)) return { rows: [{ n: 2 }] };
        if (/schedule_type = 'calendar'/.test(sql)) return { rows: [{ id: 10, name: 'Prep tower crane' }] };
        if (/schedule_type = 'ordinal'/.test(sql)) return { rows: [{ id: 20, name: 'Day 2 pour' }] };
        if (/FROM daily_checklist_items WHERE daily_checklist_id = \$1 ORDER BY/.test(sql))
          return { rows: [{ id: params[0], text: `item-${params[0]}`, checked: false, order_index: 0, source: 'scheduled' }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    pool.connect.mockResolvedValue(client);

    const res = await request(makeApp()).post('/api/daily-checklist/projects/7/start').send({ work_date: '2026-08-05' });

    expect(res.status).toBe(409);
    expect(res.body.conflict).toBe(true);
    expect(res.body.calendar.id).toBe(10);
    expect(res.body.ordinal.id).toBe(20);
    // No day was activated — a conflict rolls back.
    expect(client.query.mock.calls.map(c => c[0]).join('\n')).not.toMatch(/UPDATE daily_checklists SET status = 'active'/);
  });

  test('resumes the top of the queue and dedups recurring against the plan\'s items', async () => {
    const inserted = [];
    const client = {
      query: jest.fn(async (sql, params) => {
        if (/SELECT 1 FROM projects/.test(sql)) return { rowCount: 1, rows: [{}] };
        if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return {};
        if (/SELECT \* FROM daily_checklists WHERE company_id = \$1 AND project_id = \$2 AND status = 'active'/.test(sql)) return { rows: [] };
        if (/MAX\(day_number\)/.test(sql)) return { rows: [{ n: 1 }] };
        if (/schedule_type = 'calendar'/.test(sql)) return { rows: [] };
        if (/schedule_type = 'ordinal'/.test(sql)) return { rows: [] };
        if (/status IN \('pending','paused'\) ORDER BY queue_order/.test(sql)) return { rows: [{ id: 30, status: 'pending' }] }; // top of queue
        if (/UPDATE daily_checklists SET status = 'active'/.test(sql)) return { rows: [{ id: 30, status: 'active', day_number: 1 }] };
        if (/SELECT text, order_index FROM daily_checklist_items/.test(sql)) return { rows: [{ text: 'Prepared A', order_index: 0 }] }; // plan's item
        if (/FROM daily_checklist_recurring_items/.test(sql)) return { rows: [{ text: 'Prepared A' }, { text: 'Recurring B' }] };
        if (/status = 'completed' ORDER BY/.test(sql)) return { rows: [] };
        if (/INSERT INTO daily_checklist_items/.test(sql)) { inserted.push({ text: params[1], source: params[3] }); return { rows: [] }; }
        if (/SELECT id, text, checked/.test(sql)) return { rows: [] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    pool.connect.mockResolvedValue(client);

    const res = await request(makeApp()).post('/api/daily-checklist/projects/7/start').send({ work_date: '2026-08-05' });

    expect(res.status).toBe(201);
    expect(res.body.started).toBe(true);
    // 'Prepared A' already on the plan → not re-added; only 'Recurring B' appended.
    expect(inserted).toEqual([{ text: 'Recurring B', source: 'recurring' }]);
  });
});

describe('day-plan management', () => {
  test('POST /projects/:id/days creates a pending calendar plan with items', async () => {
    const client = {
      query: jest.fn(async (sql) => {
        if (/SELECT 1 FROM projects/.test(sql)) return { rowCount: 1, rows: [{}] };
        if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return {};
        if (/MAX\(queue_order\)/.test(sql)) return { rows: [{ n: 1 }] };
        if (/INSERT INTO daily_checklists/.test(sql)) return { rows: [{ id: 77, status: 'pending', schedule_type: 'calendar' }] };
        if (/SELECT id, text, checked/.test(sql)) return { rows: [{ id: 1, text: 'Inspect forms', source: 'scheduled' }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    pool.connect.mockResolvedValue(client);

    const res = await request(makeApp())
      .post('/api/daily-checklist/projects/7/days')
      .send({ schedule_type: 'calendar', scheduled_date: '2026-09-01', items: [{ text: 'Inspect forms' }] });

    expect(res.status).toBe(201);
    expect(res.body.day.id).toBe(77);
  });

  test('POST /days rejects a calendar plan with no date', async () => {
    const res = await request(makeApp())
      .post('/api/daily-checklist/projects/7/days')
      .send({ schedule_type: 'calendar' });
    expect(res.status).toBe(400);
  });

  test('preparing a plan that targets the active day merges its items into that day', async () => {
    const inserted = [];
    const client = {
      query: jest.fn(async (sql, params) => {
        if (/SELECT 1 FROM projects/.test(sql)) return { rowCount: 1, rows: [{}] };
        if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return {};
        if (/status = 'active'/.test(sql) && /day_number/.test(sql)) return { rows: [{ id: 77, work_date: '2026-08-05', day_number: 2 }] };
        if (/SELECT text, order_index FROM daily_checklist_items/.test(sql)) return { rows: [{ text: 'Existing', order_index: 0 }] };
        if (/INSERT INTO daily_checklist_items/.test(sql)) { inserted.push(params[1]); return { rows: [] }; }
        if (/SELECT id, text, checked/.test(sql)) return { rows: [] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    pool.connect.mockResolvedValue(client);

    const res = await request(makeApp())
      .post('/api/daily-checklist/projects/7/days')
      .send({ schedule_type: 'ordinal', ordinal_target: 2, items: [{ text: 'Existing' }, { text: 'New task' }] });

    expect(res.status).toBe(200);
    expect(res.body.merged_into_active).toBe(77);
    expect(inserted).toEqual(['New task']); // 'Existing' deduped against the active day
    // No pending plan was created — the items went onto the running day.
    expect(client.query.mock.calls.map(c => c[0]).join('\n')).not.toMatch(/INSERT INTO daily_checklists/);
  });

  test('POST /days/:id/cancel cancels an active day', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 42, status: 'canceled' }] });
    const res = await request(makeApp()).post('/api/daily-checklist/days/42/cancel').send({});
    expect(res.status).toBe(200);
    expect(res.body.day.status).toBe('canceled');
  });

  test('cancel 409s when the day is not active', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 42, status: 'completed' }] });
    const res = await request(makeApp()).post('/api/daily-checklist/days/42/cancel').send({});
    expect(res.status).toBe(409);
  });

  test('reorder writes queue_order in array order', async () => {
    const client = {
      query: jest.fn(async (sql) => {
        if (/SELECT 1 FROM projects/.test(sql)) return { rowCount: 1, rows: [{}] };
        if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return {};
        return { rowCount: 1, rows: [] };
      }),
      release: jest.fn(),
    };
    pool.connect.mockResolvedValue(client);

    const res = await request(makeApp()).post('/api/daily-checklist/projects/7/queue/reorder').send({ order: [30, 10, 20] });
    expect(res.status).toBe(200);
    const updates = client.query.mock.calls.filter(c => /UPDATE daily_checklists SET queue_order/.test(c[0]));
    expect(updates.map(c => [c[1][0], c[1][1]])).toEqual([[0, 30], [1, 10], [2, 20]]); // (queue_order, dayId)
  });
});
