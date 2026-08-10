/**
 * Direct-message permission rules (server/utils/messaging.js canMessage) and the
 * POST /api/dm/:id enforcement path.
 */

const { canMessage } = require('../utils/messaging');

const admin = (over = {}) => ({ id: 1, company_id: 'co-1', role: 'admin', active: true, ...over });
const worker = (over = {}) => ({ id: 2, company_id: 'co-1', role: 'worker', active: true, ...over });

const BOTH = { dmAdmins: true, dmWorkers: true };
describe('canMessage', () => {
  test('admin may message any active same-company user regardless of flags', () => {
    expect(canMessage(admin(), worker({ id: 9 }), {}).ok).toBe(true);
    expect(canMessage(admin(), admin({ id: 8 }), {}).ok).toBe(true);
  });
  test('worker → admin gated by dmAdmins', () => {
    expect(canMessage(worker(), admin({ id: 9 }), { dmAdmins: true }).ok).toBe(true);
    expect(canMessage(worker(), admin({ id: 9 }), { dmAdmins: false })).toMatchObject({ ok: false, reason: 'dm_admins_off' });
  });
  test('worker → worker gated by dmWorkers', () => {
    expect(canMessage(worker(), worker({ id: 9 }), { dmWorkers: true }).ok).toBe(true);
    expect(canMessage(worker(), worker({ id: 9 }), { dmWorkers: false })).toMatchObject({ ok: false, reason: 'dm_workers_off' });
  });
  test('default (no flags) = a worker can DM no one (only the shared Admins thread)', () => {
    expect(canMessage(worker(), admin({ id: 9 }), {}).ok).toBe(false);
    expect(canMessage(worker(), worker({ id: 9 }), {}).ok).toBe(false);
  });
  test('a muted sender cannot message anyone', () => {
    expect(canMessage(worker({ messaging_blocked: true }), admin({ id: 9 }), BOTH)).toMatchObject({ ok: false, reason: 'muted' });
  });
  test('per-person block: recipient on the sender block list is denied', () => {
    const s = worker({ messaging_blocked_user_ids: [9, 10] });
    expect(canMessage(s, admin({ id: 9 }), BOTH)).toMatchObject({ ok: false, reason: 'blocked' });
    expect(canMessage(s, admin({ id: 11 }), BOTH).ok).toBe(true);
  });
  test('cross-company, self, and inactive recipients are denied', () => {
    expect(canMessage(worker(), worker({ id: 9, company_id: 'co-2' }), BOTH)).toMatchObject({ ok: false, reason: 'cross_company' });
    expect(canMessage(worker({ id: 5 }), worker({ id: 5 }), BOTH)).toMatchObject({ ok: false, reason: 'self' });
    expect(canMessage(worker(), worker({ id: 9, active: false }), BOTH)).toMatchObject({ ok: false, reason: 'inactive' });
  });
});

// ── POST /api/dm/:id ────────────────────────────────────────────────────────
let mockUser;
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = mockUser; next(); },
  requirePerm: () => (_req, _res, next) => next(),
}));
jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../logger', () => { const n = () => {}; const l = { info: n, warn: n, error: n, debug: n }; l.child = () => l; return l; });
jest.mock('../push', () => ({ sendPushToUser: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const dmRoute = require('../routes/directMessages');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/dm', dmRoute);
  return app;
}

beforeEach(() => { pool.query.mockReset(); mockUser = { id: 5, company_id: 'co-1', role: 'worker', full_name: 'Wanda' }; });

test('POST /api/dm/:id 403 when a worker messages a coworker with worker_dm_workers off', async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [{ id: 5, company_id: 'co-1', role: 'worker', active: true, messaging_blocked: false, messaging_blocked_user_ids: null }] }) // me
    .mockResolvedValueOnce({ rows: [{ id: 9, company_id: 'co-1', role: 'worker', active: true }] }) // recipient
    .mockResolvedValueOnce({ rows: [] }); // flags (both off)
  const res = await request(makeApp()).post('/api/dm/9').send({ body: 'hey' });
  expect(res.status).toBe(403);
  expect(res.body.reason).toBe('dm_workers_off');
  expect(pool.query.mock.calls.some(c => /INSERT INTO direct_messages/.test(c[0]))).toBe(false);
});

test('POST /api/dm/:id 201 when worker_dm_workers is on', async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [{ id: 5, company_id: 'co-1', role: 'worker', active: true, messaging_blocked: false, messaging_blocked_user_ids: null }] }) // me
    .mockResolvedValueOnce({ rows: [{ id: 9, company_id: 'co-1', role: 'worker', active: true }] }) // recipient
    .mockResolvedValueOnce({ rows: [{ key: 'worker_dm_workers', value: '1' }] }) // flags
    .mockResolvedValueOnce({ rows: [{ id: 1, sender_id: 5, recipient_id: 9, body: 'hey', created_at: '2026-08-09T00:00:00Z', read_at: null }] }) // insert
    .mockResolvedValueOnce({ rows: [{ value: '3' }] }) // retention setting
    .mockResolvedValueOnce({}); // prune delete
  const res = await request(makeApp()).post('/api/dm/9').send({ body: 'hey' });
  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({ id: 1, recipient_id: 9, sender_name: 'Wanda' });
});
