// Optimistic-concurrency `updated_at` must not depend on the Node process time zone.
//
// daily_reports / punchlist_items / rfis PATCH compare the client's echoed updated_at against
// the row as `$n::timestamptz`. While the column was TIMESTAMP WITHOUT TIME ZONE, node-postgres
// parsed it as Node-LOCAL wall time, so on a non-UTC Node every echoed value was shifted by the
// UTC offset and every edit was a spurious 409. Migration 0222 makes the columns TIMESTAMPTZ.
let mockUser;
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = mockUser; next(); },
  requireAdmin: (req, _res, next) => { req.user = mockUser; next(); },
}));
jest.mock('../permissions', () => ({ requirePerm: () => (_req, _res, next) => next(), hasPerm: jest.fn(async () => true) }));
jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../push', () => ({ sendPushToUser: jest.fn(), sendPushToCompanyAdmins: jest.fn(), sendPushToAllWorkers: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../utils/tenantRefs', () => ({
  projectBelongsToCompany: jest.fn(async () => true),
  userBelongsToCompany: jest.fn(async () => true),
}));

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const express = require('express');
const request = require('supertest');
const pool = require('../db');

const MIGRATION = path.join(__dirname, '..', 'migrations', '0222_conflict_updated_at_timestamptz.sql');

describe('migration 0222', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  test('converts all three conflict columns to TIMESTAMPTZ, reading stored values as UTC', () => {
    for (const t of ['daily_reports', 'punchlist_items', 'rfis']) expect(sql).toContain(`'${t}'`);
    expect(sql).toMatch(/TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE %L/);
    expect(sql).toMatch(/'UTC'/);
  });
  test('is guarded so a re-run cannot shift already-converted values', () => {
    expect(sql).toMatch(/data_type = 'timestamp without time zone'/);
  });
});

// A child process is the only reliable way to run under a different TZ (Jest's process.env is
// a sandbox copy, and the tz cache is per-process).
describe('under a non-UTC Node time zone', () => {
  const script = `
    const types = require('pg').types;
    const { prepareValue } = require('pg/lib/utils');
    const tz = types.getTypeParser(1184)('2026-09-20 15:00:00.123+00');
    const naive = types.getTypeParser(1114)('2026-09-20 15:00:00.123');
    process.stdout.write(JSON.stringify({
      offset: new Date('2026-09-20T15:00:00Z').getTimezoneOffset(),
      tz: tz.toISOString(), naive: naive.toISOString(), prepared: prepareValue(tz),
    }));`;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, TZ: 'America/Chicago' },
  }).toString());

  test('the TZ override took effect', () => {
    expect(out.offset).not.toBe(0);
  });
  test('a TIMESTAMP (old column type) round-trips to the WRONG instant — the bug', () => {
    expect(out.naive).not.toBe('2026-09-20T15:00:00.123Z');
  });
  test('a TIMESTAMPTZ round-trips to the exact instant the client echoes back', () => {
    expect(out.tz).toBe('2026-09-20T15:00:00.123Z');
    // The fallback path (row's own Date passed as a param) serializes to the same instant.
    expect(new Date(out.prepared).toISOString()).toBe('2026-09-20T15:00:00.123Z');
  });
});

describe('routes compare the echoed instant, not a Node-local rendering', () => {
  const STORED = new Date('2026-09-20T15:00:00.123Z');
  function makeApp(p, router) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.log = { error: () => {} }; next(); });
    app.use(p, router);
    return app;
  }
  // Mimics the DB's `date_trunc('milliseconds', updated_at) = $n::timestamptz`.
  const sameInstant = v => v != null && new Date(v).getTime() === STORED.getTime();

  beforeEach(() => {
    pool.query.mockReset();
    mockUser = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'A' };
  });

  test('punchlist PATCH echoing the row updated_at applies (no spurious 409)', async () => {
    pool.query.mockImplementation(async (sql, params) => {
      if (/^\s*UPDATE punchlist_items/.test(sql)) return { rowCount: sameInstant(params[10]) ? 1 : 0, rows: [] };
      return { rowCount: 1, rows: [{ id: 12, status: 'open', updated_at: STORED }] };
    });
    const res = await request(makeApp('/api/punchlist', require('../routes/punchlist')))
      .patch('/api/punchlist/12').send({ title: 'x', updated_at: STORED.toISOString() });
    expect(res.status).toBe(200);
  });

  test('rfis PATCH echoing the row updated_at applies (no spurious 409)', async () => {
    pool.query.mockImplementation(async (sql, params) => {
      if (/^\s*UPDATE rfis/.test(sql)) return { rowCount: sameInstant(params[11]) ? 1 : 0, rows: [{ id: 5 }] };
      return { rowCount: 1, rows: [{ id: 5, status: 'open', updated_at: STORED }] };
    });
    const res = await request(makeApp('/api/rfis', require('../routes/rfis')))
      .patch('/api/rfis/5').send({ subject: 'x', updated_at: STORED.toISOString() });
    expect(res.status).toBe(200);
  });
});
