// PATCH /safety-talks/:id must refuse substantive edits (title/content/date/quiz) once any
// worker has signed off (409) — they attested to the original content. Non-substantive
// fields (given_by, project) stay editable.
let mockUser;
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = mockUser; next(); },
}));
jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../push', () => ({ sendPushToAllWorkers: jest.fn() }));
jest.mock('../utils/tenantRefs', () => ({ projectBelongsToCompany: jest.fn(async () => true) }));
jest.mock('../storage', () => ({}));
jest.mock('../r2', () => ({ safeKeyFromPublicUrl: jest.fn(), keyBelongsTo: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const safetyTalks = require('../routes/safetyTalks');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error: () => {} }; next(); });
  app.use('/api/safety-talks', safetyTalks);
  return app;
}

const CURRENT = { id: 4, title: 'Ladders', content: 'Three points', talk_date_text: '2026-09-01', pass_threshold: 80, signoff_count: '2' };
let client;
function setup(current = CURRENT) {
  client = { query: jest.fn(async (sql) => {
    if (/FOR UPDATE/.test(sql)) return current ? { rowCount: 1, rows: [current] } : { rowCount: 0, rows: [] };
    if (/UPDATE safety_talks/.test(sql)) return { rowCount: 1, rows: [{ id: 4 }] };
    return { rowCount: 0, rows: [] };
  }), release: jest.fn() };
  pool.connect.mockResolvedValue(client);
  pool.query.mockResolvedValue({ rowCount: 1, rows: [{ id: 4 }] });
}

beforeEach(() => {
  pool.query.mockReset(); pool.connect.mockReset();
  mockUser = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'A' };
});

test.each([
  [{ title: 'New title' }],
  [{ content: 'changed' }],
  [{ talk_date: '2026-09-02' }],
  [{ pass_threshold: 50 }],
  [{ questions: [] }],
])('409 on substantive edit %j after sign-offs', async (body) => {
  setup();
  const res = await request(makeApp()).patch('/api/safety-talks/4').send(body);
  expect(res.status).toBe(409);
  expect(client.query.mock.calls.some(c => /UPDATE safety_talks/.test(c[0]))).toBe(false);
  expect(client.query.mock.calls.map(c => c[0])).toContain('ROLLBACK');
});

test('non-substantive edit (given_by) still allowed after sign-offs', async () => {
  setup();
  const res = await request(makeApp()).patch('/api/safety-talks/4').send({ given_by: 'Foreman Joe' });
  expect(res.status).toBe(200);
  expect(client.query.mock.calls.some(c => /UPDATE safety_talks/.test(c[0]))).toBe(true);
});

test('re-sending unchanged substantive values is not treated as an edit', async () => {
  setup();
  const res = await request(makeApp()).patch('/api/safety-talks/4')
    .send({ title: 'Ladders', content: 'Three points', talk_date: '2026-09-01', given_by: 'X' });
  expect(res.status).toBe(200);
});

test('substantive edit allowed with no sign-offs', async () => {
  setup({ ...CURRENT, signoff_count: '0' });
  const res = await request(makeApp()).patch('/api/safety-talks/4').send({ title: 'New title' });
  expect(res.status).toBe(200);
});

test('404 when the talk does not exist', async () => {
  setup(null);
  const res = await request(makeApp()).patch('/api/safety-talks/4').send({ title: 'x' });
  expect(res.status).toBe(404);
});
