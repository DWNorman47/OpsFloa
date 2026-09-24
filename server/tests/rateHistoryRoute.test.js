/**
 * Rate-history API + the existing rate-editing endpoints (worker PATCH, project
 * PATCH, settings PATCH) writing history instead of the raw columns, the
 * current-rate cache refresh, locked-pay-period confirmation, validation and
 * permissions. A small in-memory fake stands in for Postgres.
 */
let mockUser;
let mockPerms;
const allow = key => !mockPerms || mockPerms.includes(key);

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = mockUser; next(); },
  requireAdmin: (req, _res, next) => { req.user = mockUser; next(); },
  requirePermission: () => (req, _res, next) => { req.user = mockUser; next(); },
  requirePerm: (key) => (req, res, next) => {
    req.user = mockUser;
    if (!allow(key)) return res.status(403).json({ error: 'Insufficient permissions', required: key });
    next();
  },
  hasPerm: async (_req, key) => allow(key),
  requirePlan: () => (req, _res, next) => { req.user = mockUser; next(); },
  requireProAddon: (req, _res, next) => { req.user = mockUser; next(); },
  requireCertifiedPayrollAddon: (req, _res, next) => { req.user = mockUser; next(); },
  hasAdminPermission: () => true,
  requireSuperAdmin: (req, _res, next) => { req.user = mockUser; next(); },
}));
jest.mock('../permissions', () => ({
  ...jest.requireActual('../permissions'),
  hasPerm: async (_req, key) => !mockPerms || mockPerms.includes(key),
}));
jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../push', () => ({ sendPushToUser: jest.fn(), sendPushToAllWorkers: jest.fn() }));
jest.mock('../email', () => ({ sendEmail: jest.fn() }));
jest.mock('../services/qbo', () => ({}));
jest.mock('../routes/inbox', () => ({ createInboxItem: jest.fn(), createInboxItemBatch: jest.fn() }));
jest.mock('../r2', () => ({ getPresignedUploadUrl: jest.fn() }));

const express = require('express');
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const pool = require('../db');
const { logAudit } = require('../auditLog');
const { wallDateInTZ } = require('../utils/timeFormat');
const store = require('../utils/rateHistoryStore');

const CO = 'co-1';
const TZ = 'America/Phoenix';
const TODAY = wallDateInTZ(new Date(), TZ);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

// ── In-memory fake of the tables these routes touch ──────────────────────────
let db;
function resetDb() {
  db = {
    users: [
      { id: 5, company_id: CO, full_name: 'Alex Rivera', hourly_rate: '20.00', rate_type: 'hourly', updated_at: new Date('2026-01-01') },
      { id: 6, company_id: CO, full_name: 'Sam Lee', hourly_rate: null, rate_type: 'hourly', updated_at: new Date('2026-01-01') },
      { id: 1, company_id: CO, full_name: 'Test Admin', hourly_rate: null, rate_type: 'hourly' },
    ],
    projects: [{ id: 30, company_id: CO, name: 'Main St', prevailing_wage_rate: '45.00', updated_at: new Date('2026-01-01') }],
    settings: [
      { company_id: CO, key: 'company_timezone', value: TZ },
      { company_id: CO, key: 'default_hourly_rate', value: '30' },
    ],
    pay_periods: [],
    worker_rate_history: [{ id: 1, company_id: CO, user_id: 5, hourly_rate: '20.00', rate_type: 'hourly', effective_date: '1900-01-01', note: 'Backfilled', created_by: null }],
    project_prevailing_rate_history: [{ id: 1, company_id: CO, project_id: 30, rate: '45.00', effective_date: '1900-01-01', note: null, created_by: null }],
    company_default_rate_history: [{ id: 1, company_id: CO, rate: '30.00', effective_date: '1900-01-01', note: null, created_by: null }],
    company_prevailing_rate_history: [],
    seq: 100,
  };
}
const HIST = { worker_rate_history: 'user_id', project_prevailing_rate_history: 'project_id', company_default_rate_history: 'company_id', company_prevailing_rate_history: 'company_id' };
const rowsRes = rows => ({ rows, rowCount: rows.length });

async function fakeQuery(sql, p = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  let m;
  if (/FROM settings WHERE company_id = \$1 AND key = 'company_timezone'/.test(s)) {
    return rowsRes(db.settings.filter(r => r.company_id === p[0] && r.key === 'company_timezone'));
  }
  if ((m = s.match(/^SELECT value FROM settings WHERE company_id = \$1 AND key = '(default_hourly_rate|prevailing_wage_rate)'$/))) {
    return rowsRes(db.settings.filter(r => r.company_id === p[0] && r.key === m[1]));
  }
  if (/^SELECT key, value FROM settings WHERE company_id = \$1$/.test(s)) {
    return rowsRes(db.settings.filter(r => r.company_id === p[0]).map(r => ({ key: r.key, value: r.value })));
  }
  if ((m = s.match(/FROM (worker_rate_history|project_prevailing_rate_history|company_default_rate_history|company_prevailing_rate_history) h LEFT JOIN users/))) {
    const t = m[1];
    return rowsRes(db[t].filter(r => r.company_id === p[0] && (HIST[t] === 'company_id' || String(r[HIST[t]]) === String(p[1])))
      .sort((a, b) => a.effective_date.localeCompare(b.effective_date) || a.id - b.id)
      .map(r => ({ ...r, rate: t === 'worker_rate_history' ? r.hourly_rate : r.rate, created_by_name: null, created_at: new Date() })));
  }
  if ((m = s.match(/^INSERT INTO (worker_rate_history|project_prevailing_rate_history|company_default_rate_history|company_prevailing_rate_history)/))) {
    const t = m[1];
    let row;
    if (t === 'worker_rate_history') row = { company_id: p[0], user_id: Number(p[1]), hourly_rate: p[2] == null ? null : String(p[2]), rate_type: p[3], effective_date: p[4], note: /'Initial rate'/.test(s) ? 'Initial rate' : p[5], created_by: /'Initial rate'/.test(s) ? p[5] : p[6] };
    else if (t === 'project_prevailing_rate_history') row = { company_id: p[0], project_id: Number(p[1]), rate: p[2] == null ? null : String(p[2]), effective_date: p[3], note: p[4], created_by: p[5] };
    else row = { company_id: p[0], rate: String(p[1]), effective_date: p[2], note: p[3], created_by: p[4] };
    const key = HIST[t];
    const existing = db[t].find(r => String(r[key]) === String(row[key]) && r.effective_date === row.effective_date);
    if (existing) {
      if (/DO NOTHING/.test(s)) return rowsRes([]);
      Object.assign(existing, row);
      return rowsRes([{ id: existing.id }]);
    }
    row.id = ++db.seq;
    db[t].push(row);
    return rowsRes([{ id: row.id }]);
  }
  if ((m = s.match(/^DELETE FROM (worker_rate_history|project_prevailing_rate_history|company_default_rate_history|company_prevailing_rate_history) h WHERE h.id = \$(\d)/))) {
    const t = m[1], id = p[Number(m[2]) - 1];
    const before = db[t].length;
    db[t] = db[t].filter(r => !(r.id === id && r.company_id === p[0]));
    return { rows: [], rowCount: before - db[t].length };
  }
  if (/^UPDATE users SET hourly_rate = \$1, rate_type = \$2 WHERE id = \$3 AND company_id = \$4$/.test(s)) {
    const u = db.users.find(x => String(x.id) === String(p[2]) && x.company_id === p[3]);
    if (u) { u.hourly_rate = p[0] == null ? null : String(p[0]); u.rate_type = p[1]; }
    return { rows: [], rowCount: u ? 1 : 0 };
  }
  if (/^UPDATE projects SET prevailing_wage_rate = \$1 WHERE id = \$2 AND company_id = \$3$/.test(s)) {
    const pr = db.projects.find(x => String(x.id) === String(p[1]) && x.company_id === p[2]);
    if (pr) pr.prevailing_wage_rate = p[0] == null ? null : String(p[0]);
    return { rows: [], rowCount: pr ? 1 : 0 };
  }
  if ((m = s.match(/^INSERT INTO settings \(company_id, key, value\) VALUES \(\$1, '(default_hourly_rate|prevailing_wage_rate)', \$2\)/))) {
    const key = m[1];
    const r = db.settings.find(x => x.company_id === p[0] && x.key === key);
    if (r) r.value = p[1]; else db.settings.push({ company_id: p[0], key, value: p[1] });
    return rowsRes([]);
  }
  if (/^INSERT INTO settings \(company_id, key, value\) VALUES \(\$1, \$2, \$3\) ON CONFLICT/.test(s)) {
    const r = db.settings.find(x => x.company_id === p[0] && x.key === p[1]);
    if (r) r.value = String(p[2]); else db.settings.push({ company_id: p[0], key: p[1], value: String(p[2]) });
    return rowsRes([]);
  }
  if (/FROM pay_periods WHERE company_id = \$1 AND period_end >= \$2::date/.test(s)) {
    return rowsRes(db.pay_periods.filter(x => x.company_id === p[0] && x.period_end >= p[1]));
  }
  if (/^SELECT id, full_name FROM users WHERE id = \$1 AND company_id = \$2$/.test(s)) {
    return rowsRes(db.users.filter(x => String(x.id) === String(p[0]) && x.company_id === p[1]).map(x => ({ id: x.id, full_name: x.full_name })));
  }
  if (/^SELECT hourly_rate, rate_type FROM users WHERE id = \$1 AND company_id = \$2$/.test(s)) {
    return rowsRes(db.users.filter(x => String(x.id) === String(p[0]) && x.company_id === p[1]));
  }
  if (/^SELECT id, name FROM projects WHERE id = \$1 AND company_id = \$2$/.test(s)) {
    return rowsRes(db.projects.filter(x => String(x.id) === String(p[0]) && x.company_id === p[1]));
  }
  if (/^SELECT prevailing_wage_rate FROM projects WHERE id = \$1 AND company_id = \$2$/.test(s)) {
    return rowsRes(db.projects.filter(x => String(x.id) === String(p[0]) && x.company_id === p[1]));
  }
  if (/^UPDATE users SET .* RETURNING id, username/.test(s)) {
    const u = db.users.find(x => String(x.id) === String(p[p.length - 2]) && x.company_id === p[p.length - 1]);
    return u ? rowsRes([{ ...u }]) : rowsRes([]);
  }
  if (/^UPDATE projects SET .* RETURNING \*/.test(s)) {
    const pr = db.projects.find(x => String(x.id) === String(p[p.length - 2]) && x.company_id === p[p.length - 1]);
    return pr ? rowsRes([{ ...pr }]) : rowsRes([]);
  }
  return rowsRes([]);
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', require('../routes/rateHistory'));
  app.use('/api/admin', require('../routes/admin'));
  return app;
}
let app;
beforeAll(() => { app = makeApp(); });
beforeEach(() => {
  resetDb();
  pool.query.mockReset();
  pool.query.mockImplementation(fakeQuery);
  logAudit.mockClear();
  mockPerms = null;
  mockUser = { id: 1, company_id: CO, role: 'admin', full_name: 'Test Admin' };
});

const workerHist = uid => db.worker_rate_history.filter(r => r.user_id === uid).sort((a, b) => a.effective_date.localeCompare(b.effective_date));

describe('worker rate history API', () => {
  test('GET lists history + the current cache + company-local today', async () => {
    const res = await request(app).get('/api/admin/workers/5/rate-history');
    expect(res.status).toBe(200);
    expect(res.body.today).toBe(TODAY);
    expect(res.body.current).toEqual({ rate: 20, rate_type: 'hourly' });
    expect(res.body.history).toHaveLength(1);
    expect(res.body.history[0]).toMatchObject({ rate: 20, rate_type: 'hourly', effective_date: '1900-01-01', initial: true });
  });

  test('add a raise from today → history row + cache refreshed + audit-logged', async () => {
    const res = await request(app).post('/api/admin/workers/5/rate-history').send({ rate: 22, note: 'Annual raise' });
    expect(res.status).toBe(201);
    expect(workerHist(5).map(r => [r.effective_date, r.hourly_rate])).toEqual([['1900-01-01', '20.00'], [TODAY, '22']]);
    expect(db.users.find(u => u.id === 5).hourly_rate).toBe('22');
    expect(res.body.current).toEqual({ rate: 22, rate_type: 'hourly' });
    expect(logAudit).toHaveBeenCalledWith(CO, 1, 'Test Admin', 'worker.rate_history.added', 'worker', 5, 'Alex Rivera',
      expect.objectContaining({ rate: 22, effective_date: TODAY, note: 'Annual raise', previous: expect.objectContaining({ rate: 20 }) }));
  });

  test('a FUTURE-dated change is stored but the cache keeps today\'s rate', async () => {
    const future = addDays(TODAY, 10);
    const res = await request(app).post('/api/admin/workers/5/rate-history').send({ rate: 25, effective_date: future });
    expect(res.status).toBe(201);
    expect(db.users.find(u => u.id === 5).hourly_rate).toBe('20');
    expect(workerHist(5).map(r => r.effective_date)).toEqual(['1900-01-01', future]);
    // The day it takes effect, a cache refresh flips it (what the hourly job does).
    await store.refreshCache('worker', CO, 5, future);
    expect(db.users.find(u => u.id === 5).hourly_rate).toBe('25');
  });

  test('rate_type switch: omitted type keeps the one in effect; explicit daily is stored', async () => {
    await request(app).post('/api/admin/workers/5/rate-history').send({ rate: 21 }).expect(201);
    expect(workerHist(5)[1].rate_type).toBe('hourly');
    await request(app).post('/api/admin/workers/5/rate-history').send({ rate: 200, rate_type: 'daily', effective_date: TODAY }).expect(201);
    expect(workerHist(5)[1]).toMatchObject({ hourly_rate: '200', rate_type: 'daily' }); // same date → replaced (edit)
    expect(db.users.find(u => u.id === 5).rate_type).toBe('daily');
  });

  test.each([
    [{ rate: -1 }, /non-negative/],
    [{ rate: 'abc' }, /non-negative/],
    [{ rate: 20, effective_date: '2026-02-30' }, /valid YYYY-MM-DD/],
    [{ rate: 20, effective_date: 'yesterday' }, /valid YYYY-MM-DD/],
    [{ rate: 20, rate_type: 'weekly' }, /rate_type must be one of/],
  ])('validation: %j → 400', async (body, msg) => {
    const res = await request(app).post('/api/admin/workers/5/rate-history').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(msg);
    expect(workerHist(5)).toHaveLength(1);
  });

  test('a worker with no history gets the current cache snapshotted as the 1900 baseline first', async () => {
    const res = await request(app).post('/api/admin/workers/6/rate-history').send({ rate: 28, effective_date: TODAY });
    expect(res.status).toBe(201);
    expect(workerHist(6).map(r => [r.effective_date, r.hourly_rate])).toEqual([['1900-01-01', null], [TODAY, '28']]);
  });

  test('backdated into a LOCKED pay period → 409 with the periods; confirm_locked saves', async () => {
    db.pay_periods.push({ id: 7, company_id: CO, period_start: '2026-06-01', period_end: '2026-06-14', label: 'Jun 1–14' });
    db.pay_periods.push({ id: 8, company_id: CO, period_start: '2026-06-15', period_end: '2026-06-28', label: null });
    const res = await request(app).post('/api/admin/workers/5/rate-history').send({ rate: 22, effective_date: '2026-06-10' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('locked_periods');
    expect(res.body.locked_count).toBe(2);
    expect(res.body.locked_periods.map(p => p.id)).toEqual([7, 8]);
    expect(workerHist(5)).toHaveLength(1); // nothing saved
    const ok = await request(app).post('/api/admin/workers/5/rate-history').send({ rate: 22, effective_date: '2026-06-10', confirm_locked: true });
    expect(ok.status).toBe(201);
    expect(ok.body.locked_periods).toHaveLength(2);
    expect(logAudit.mock.calls.find(c => c[3] === 'worker.rate_history.added')[7]).toMatchObject({ backdated: true, locked_periods_affected: 2 });
  });

  test('backdating that stops before the next change only counts the periods it reaches', async () => {
    db.worker_rate_history.push({ id: 2, company_id: CO, user_id: 5, hourly_rate: '24.00', rate_type: 'hourly', effective_date: '2026-06-15' });
    db.pay_periods.push({ id: 7, company_id: CO, period_start: '2026-06-01', period_end: '2026-06-07' });
    db.pay_periods.push({ id: 8, company_id: CO, period_start: '2026-06-22', period_end: '2026-06-28' });
    const res = await request(app).post('/api/admin/workers/5/rate-history').send({ rate: 22, effective_date: '2026-06-03' });
    expect(res.status).toBe(409);
    expect(res.body.locked_periods.map(p => p.id)).toEqual([7]); // 06-03 → 06-14 only
  });

  test('backdating into an UNLOCKED past period needs no confirmation', async () => {
    const res = await request(app).post('/api/admin/workers/5/rate-history').send({ rate: 22, effective_date: addDays(TODAY, -40) });
    expect(res.status).toBe(201);
    expect(db.users.find(u => u.id === 5).hourly_rate).toBe('22');
  });

  test('delete: the last remaining row is refused', async () => {
    const res = await request(app).delete('/api/admin/workers/5/rate-history/1');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('last_rate_row');
  });

  test('delete a mistaken change → cache falls back to the previous rate', async () => {
    await request(app).post('/api/admin/workers/5/rate-history').send({ rate: 99 }).expect(201);
    const bad = workerHist(5)[1];
    const res = await request(app).delete(`/api/admin/workers/5/rate-history/${bad.id}`);
    expect(res.status).toBe(200);
    expect(workerHist(5)).toHaveLength(1);
    expect(db.users.find(u => u.id === 5).hourly_rate).toBe('20');
    expect(logAudit.mock.calls.some(c => c[3] === 'worker.rate_history.deleted')).toBe(true);
  });

  test('delete of a row reaching a locked period needs confirm_locked', async () => {
    db.worker_rate_history.push({ id: 2, company_id: CO, user_id: 5, hourly_rate: '24.00', rate_type: 'hourly', effective_date: '2026-06-01' });
    db.pay_periods.push({ id: 7, company_id: CO, period_start: '2026-06-01', period_end: '2026-06-14' });
    expect((await request(app).delete('/api/admin/workers/5/rate-history/2')).status).toBe(409);
    expect((await request(app).delete('/api/admin/workers/5/rate-history/2?confirm_locked=true')).status).toBe(200);
  });

  test('unknown row → 404; other company\'s worker → 404', async () => {
    expect((await request(app).delete('/api/admin/workers/5/rate-history/555')).status).toBe(404);
    expect((await request(app).get('/api/admin/workers/999/rate-history')).status).toBe(404);
  });
});

describe('permissions — same as editing the rate today', () => {
  test('worker history needs manage_workers', async () => {
    mockPerms = ['view_worker_wages'];
    expect((await request(app).post('/api/admin/workers/5/rate-history').send({ rate: 22 })).status).toBe(403);
    expect((await request(app).delete('/api/admin/workers/5/rate-history/1')).status).toBe(403);
    expect(workerHist(5)).toHaveLength(1);
  });
  test('reading a worker\'s rates also needs view_worker_wages', async () => {
    mockPerms = ['manage_workers'];
    expect((await request(app).get('/api/admin/workers/5/rate-history')).status).toBe(403);
  });
  test('a worker-scoped admin can\'t touch a worker outside their scope', async () => {
    mockUser = { ...mockUser, worker_access_ids: [6] };
    expect((await request(app).post('/api/admin/workers/5/rate-history').send({ rate: 22 })).status).toBe(403);
  });
  test('project history needs manage_projects; company default needs manage_settings', async () => {
    mockPerms = ['manage_workers'];
    expect((await request(app).post('/api/admin/projects/30/prevailing-rate-history').send({ rate: 50 })).status).toBe(403);
    expect((await request(app).post('/api/admin/company/default-rate-history').send({ rate: 35 })).status).toBe(403);
  });
});

describe('project prevailing + company default history', () => {
  test('prevailing change mid-job; NULL = no project rate is allowed', async () => {
    const d = addDays(TODAY, -3);
    expect((await request(app).post('/api/admin/projects/30/prevailing-rate-history').send({ rate: 52.5, effective_date: d })).status).toBe(201);
    expect(db.projects[0].prevailing_wage_rate).toBe('52.5');
    expect((await request(app).post('/api/admin/projects/30/prevailing-rate-history').send({ rate: null })).status).toBe(201);
    expect(db.projects[0].prevailing_wage_rate).toBeNull();
    expect(logAudit.mock.calls.filter(c => c[3] === 'project.prevailing_rate_history.added')).toHaveLength(2);
  });
  test('company default: must be > 0; a change refreshes the setting', async () => {
    expect((await request(app).post('/api/admin/company/default-rate-history').send({ rate: 0 })).status).toBe(400);
    const res = await request(app).post('/api/admin/company/default-rate-history').send({ rate: 35 });
    expect(res.status).toBe(201);
    expect(db.settings.find(s => s.key === 'default_hourly_rate').value).toBe('35');
    expect(db.company_default_rate_history.map(r => r.effective_date)).toEqual(['1900-01-01', TODAY]);
  });
});

describe('existing endpoints write history instead of the raw column', () => {
  test('PATCH /workers/:id with a new rate → dated history from today, not retroactive', async () => {
    const res = await request(app).patch('/api/admin/workers/5').send({ hourly_rate: 23, rate_type: 'hourly', full_name: 'Alex Rivera' });
    expect(res.status).toBe(200);
    expect(workerHist(5).map(r => [r.effective_date, r.hourly_rate])).toEqual([['1900-01-01', '20.00'], [TODAY, '23']]);
    expect(db.users.find(u => u.id === 5).hourly_rate).toBe('23');
    // The UPDATE users statement no longer sets hourly_rate directly.
    const upd = pool.query.mock.calls.map(c => c[0]).find(q => /^\s*UPDATE users SET/.test(q) && /RETURNING id, username/.test(q));
    expect(upd).not.toMatch(/hourly_rate = \$/);
    expect(upd).not.toMatch(/rate_type = \$/);
  });

  test('PATCH /workers/:id re-sending the SAME rate records nothing', async () => {
    const res = await request(app).patch('/api/admin/workers/5').send({ hourly_rate: 20, rate_type: 'hourly', full_name: 'Alex Rivera' });
    expect(res.status).toBe(200);
    expect(workerHist(5)).toHaveLength(1);
  });

  test('PATCH /workers/:id backdated into a locked period → 409 until confirmed', async () => {
    db.pay_periods.push({ id: 7, company_id: CO, period_start: '2026-06-01', period_end: '2026-06-14' });
    const res = await request(app).patch('/api/admin/workers/5').send({ hourly_rate: 23, rate_effective_date: '2026-06-01' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('locked_periods');
    const ok = await request(app).patch('/api/admin/workers/5').send({ hourly_rate: 23, rate_effective_date: '2026-06-01', confirm_locked: true });
    expect(ok.status).toBe(200);
    expect(workerHist(5).map(r => r.effective_date)).toEqual(['1900-01-01', '2026-06-01']);
  });

  test('PATCH /projects/:id prevailing rate → dated history; the column is only the cache', async () => {
    const res = await request(app).patch('/api/admin/projects/30').send({ prevailing_wage_rate: 50 });
    expect(res.status).toBe(200);
    expect(db.project_prevailing_rate_history.map(r => [r.effective_date, r.rate])).toEqual([['1900-01-01', '45.00'], [TODAY, '50']]);
    expect(db.projects[0].prevailing_wage_rate).toBe('50');
    const upd = pool.query.mock.calls.map(c => c[0]).find(q => /^\s*UPDATE projects SET/.test(q) && /RETURNING \*/.test(q));
    expect(upd).not.toMatch(/prevailing_wage_rate = \$/);
  });

  test('PATCH /settings default_hourly_rate → dated history; backdate into locked needs confirm', async () => {
    const res = await request(app).patch('/api/admin/settings').send({ default_hourly_rate: 32 });
    expect(res.status).toBe(200);
    expect(db.company_default_rate_history.map(r => [r.effective_date, r.rate])).toEqual([['1900-01-01', '30.00'], [TODAY, '32']]);
    expect(db.settings.find(s => s.key === 'default_hourly_rate').value).toBe('32');

    db.pay_periods.push({ id: 7, company_id: CO, period_start: '2026-06-01', period_end: '2026-06-14' });
    const locked = await request(app).patch('/api/admin/settings').send({ default_hourly_rate: 33, default_rate_effective_date: '2026-06-01', overtime_multiplier: 2 });
    expect(locked.status).toBe(409);
    // Nothing from that request was written (checked BEFORE the settings loop).
    expect(db.settings.find(s => s.key === 'overtime_multiplier')).toBeUndefined();
    const ok = await request(app).patch('/api/admin/settings').send({ default_hourly_rate: 33, default_rate_effective_date: '2026-06-01', confirm_locked: true });
    expect(ok.status).toBe(200);
    expect(db.company_default_rate_history.map(r => r.effective_date).sort()).toEqual(['1900-01-01', '2026-06-01', TODAY]);
  });
});

describe('company prevailing fallback history (0210)', () => {
  beforeEach(() => { db.settings.push({ company_id: CO, key: 'prevailing_wage_rate', value: '45' }); });

  test('PATCH /settings prevailing_wage_rate → dated history from today (1900 baseline first), setting = cache', async () => {
    const res = await request(app).patch('/api/admin/settings').send({ prevailing_wage_rate: 60 });
    expect(res.status).toBe(200);
    expect(db.company_prevailing_rate_history.map(r => [r.effective_date, r.rate])).toEqual([['1900-01-01', '45'], [TODAY, '60']]);
    expect(db.settings.find(s => s.key === 'prevailing_wage_rate').value).toBe('60');
    expect(logAudit.mock.calls.some(c => c[3] === 'settings.prevailing_rate_history.added')).toBe(true);
  });

  test('re-sending the SAME prevailing rate records nothing', async () => {
    const res = await request(app).patch('/api/admin/settings').send({ prevailing_wage_rate: 45, overtime_multiplier: 1.5 });
    expect(res.status).toBe(200);
    expect(db.company_prevailing_rate_history).toHaveLength(0);
  });

  test('backdated into a locked period → 409 until confirmed; nothing written first', async () => {
    db.pay_periods.push({ id: 7, company_id: CO, period_start: '2026-06-01', period_end: '2026-06-14' });
    const locked = await request(app).patch('/api/admin/settings').send({ prevailing_wage_rate: 50, prevailing_rate_effective_date: '2026-06-01', overtime_multiplier: 2 });
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('locked_periods');
    expect(db.settings.find(s => s.key === 'overtime_multiplier')).toBeUndefined();
    expect(db.company_prevailing_rate_history).toHaveLength(0);
    const ok = await request(app).patch('/api/admin/settings').send({ prevailing_wage_rate: 50, prevailing_rate_effective_date: '2026-06-01', confirm_locked: true });
    expect(ok.status).toBe(200);
    expect(db.company_prevailing_rate_history.map(r => r.effective_date)).toEqual(['1900-01-01', '2026-06-01']);
  });

  test('API: GET / POST / DELETE /company/prevailing-rate-history (0 allowed, needs manage_settings)', async () => {
    const add = await request(app).post('/api/admin/company/prevailing-rate-history').send({ rate: 0, effective_date: addDays(TODAY, -2) });
    expect(add.status).toBe(201);
    expect(db.settings.find(s => s.key === 'prevailing_wage_rate').value).toBe('0');
    const list = await request(app).get('/api/admin/company/prevailing-rate-history');
    expect(list.status).toBe(200);
    expect(list.body.history.map(r => r.rate)).toEqual([45, 0]);
    const del = await request(app).delete(`/api/admin/company/prevailing-rate-history/${list.body.history[1].id}`);
    expect(del.status).toBe(200);
    expect(db.settings.find(s => s.key === 'prevailing_wage_rate').value).toBe('45');
    mockPerms = ['manage_workers'];
    expect((await request(app).get('/api/admin/company/prevailing-rate-history')).status).toBe(403);
  });
});

describe('daily cache refresh job', () => {
  test('gated by DISABLE_BACKGROUND_JOBS like the other jobs', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const gate = src.indexOf("process.env.DISABLE_BACKGROUND_JOBS === 'true'");
    const start = src.indexOf('startRateCacheRefreshJob()');
    const elseAt = src.indexOf('} else {', gate);
    expect(gate).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(elseAt);
  });

  test('refreshAllCaches: per company local today, set-based, only differing rows', async () => {
    pool.query.mockReset();
    pool.query
      .mockResolvedValueOnce({ rows: [{ company_id: CO, tz: TZ }] })
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 }); // company prevailing (0210)
    const out = await store.refreshAllCaches();
    expect(out).toEqual({ companies: 1, updated: 4 });
    const calls = pool.query.mock.calls;
    expect(calls[0][0]).toMatch(/effective_date > DATE '1900-01-01'/); // only companies with real dated changes
    for (const [q, params] of calls.slice(1)) {
      expect(params).toEqual([CO, TODAY]);
      expect(q).toMatch(/effective_date <= \$2::date/);
      expect(q).toMatch(/IS DISTINCT FROM/); // idempotent: untouched when already current
    }
  });
});

describe('project bill (GET /projects/:id/entries) prices through the engine at dated rates', () => {
  test('a raise after the billed week does not re-price it; a mid-week raise splits it', async () => {
    const entry = d => ({ id: Number(d.slice(-2)), user_id: 5, project_id: 30, work_date: d, wage_type: 'regular', start_time: '08:00:00', end_time: '16:00:00', break_minutes: 0, hourly_rate: '26.00', rate_type: 'hourly', overtime_rule: null, role_id: null, worker_type: 'employee', status: 'approved' });
    pool.query.mockReset();
    pool.query.mockImplementation(async (sql) => {
      if (/SELECT \* FROM projects WHERE id = \$1/.test(sql)) return rowsRes([{ id: 30, name: 'Main St', prevailing_wage_rate: null }]);
      if (/FROM time_entries te\s+JOIN users u/.test(sql)) return rowsRes(['2026-07-06', '2026-07-07', '2026-07-08'].map(entry));
      if (/FROM worker_rate_history/.test(sql)) return rowsRes([
        { user_id: 5, hourly_rate: '20', rate_type: 'hourly', effective_date: '1900-01-01' },
        { user_id: 5, hourly_rate: '22', rate_type: 'hourly', effective_date: '2026-07-08' },
        { user_id: 5, hourly_rate: '26', rate_type: 'hourly', effective_date: '2026-09-01' }, // today's raise (the cache says 26)
      ]);
      return rowsRes([]);
    });
    const res = await request(app).get('/api/admin/projects/30/entries?from=2026-07-06&to=2026-07-12');
    expect(res.status).toBe(200);
    expect(res.body.summary.regular_cost).toBe(8 * 20 + 8 * 20 + 8 * 22);
    expect(res.body.summary.total_cost).toBe(496);
  });
});
