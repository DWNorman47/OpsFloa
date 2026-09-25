/**
 * QuickBooks contractor bills — double-billing holes found in the review of
 * 703adaf4 (ported from the reviewer's scratch proofs). Each test pins what the
 * 0214 code got wrong:
 *
 *  1. Reconcile DELETED a pending outbox row when its replay failed for an
 *     unrelated reason (not connected, expired auth, 4xx) — but the first send may
 *     have created the bill, so a later push billed it again. Now a pending row is
 *     never dropped on a replay failure: the worker stays blocked until the replay
 *     succeeds or an admin resolves it (POST /bill-outbox/:id/resolve).
 *  2. Two concurrent pushes (or a credit "record" during a push) billed the same
 *     entry twice → a per-company lock; the second caller gets 409.
 *  3. A later bill could hash to an earlier POSTED bill's Intuit requestid →
 *     Intuit returned the old bill and the new money was ledgered as billed.
 *  4. The cutover flag read qbo_synced_at, which other flows overwrite → frozen
 *     column time_entries.qbo_pre_ledger_bill (0218).
 *  5. Held credits / reversals only applied when a later push covered that date.
 *  6. A TotalAmt mismatch deleted the outbox row though a bill existed.
 *  7. A contractor with only leave in range got no bill.
 *  8. PAYROLL_WORKERS_SQL used the CURRENT rate for admins.
 *  9. GET /bill-credits shows pay but didn't require view_worker_wages.
 */

const mockUser = { id: 1, company_id: 'company-uuid-1', full_name: 'Test Admin', role: 'admin' };
jest.mock('../middleware/auth', () => ({
  requireAuth:  (req, _res, next) => { req.user = mockUser; next(); },
  requireAdmin: (req, _res, next) => { req.user = mockUser; next(); },
  requirePerm: (key) => { const fn = (_req, _res, next) => next(); fn.__permissionKey = key; return fn; },
}));
jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../services/qbo', () => {
  const actual = jest.requireActual('../services/qbo');
  return {
    timeActivityHours: actual.timeActivityHours,
    createBill: jest.fn(), createJournalEntry: jest.fn(), pushTimeActivity: jest.fn(),
  };
});
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const pool = require('../db');
const qbo = require('../services/qbo');
const { logAudit } = require('../auditLog');
const qboRoute = require('../routes/qbo');
const { PAYROLL_WORKERS_SQL } = require('../utils/payStatement');

function makeApp() { const app = express(); app.use(express.json()); app.use('/api/qbo', qboRoute); return app; }

const WORKER = {
  full_name: 'Alex Rivera', qbo_vendor_id: 'V-1', hourly_rate: '20.00', rate_type: 'hourly',
  worker_type: 'contractor', overtime_rule: null, role_id: null, guaranteed_weekly_hours: 0,
};
const timeRow = (over = {}) => ({
  id: 100, user_id: 10, project_id: 200, work_date: '2026-09-07', start_time: '08:00:00', end_time: '16:00:00',
  notes: '', qbo_bill_id: null, qbo_activity_id: null, wage_type: 'regular', break_minutes: 0, mileage: 0, overtime_hours_override: null,
  ...WORKER,
  qbo_class_id: null, qbo_customer_id: 'CUST-1', project_name: 'Main St', prevailing_wage_rate: null,
  pre_ledger_bill: false, ...over,
});
const OT_OFF = [{ key: 'overtime_rule', value: 'none' }];
const clone = x => JSON.parse(JSON.stringify(x));
const approved = r => !r.status || r.status === 'approved';

function makeWorld(over = {}) {
  return {
    settings: OT_OFF, timeRows: [], leaveRequests: [], ledger: [], pushes: [], reimb: [], rateRows: [],
    users: [], qboBills: new Map(), failOn: null, locks: new Set(), noSeq: false, sql: [], ...over,
  };
}

/**
 * In-memory Postgres + QuickBooks (Intuit dedupes on requestid). `world`
 * persists across pushes. The advisory lock is per company and lives for the
 * lock client's transaction.
 */
function install(world) {
  let nextPushId = 1;
  const handle = async (sql, params = []) => {
    const s = String(sql);
    world.sql.push(s);
    if (world.failOn && world.failOn.test(s)) throw new Error('connection reset');
    if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(s.trim())) return { rows: [] };
    if (/qbo_labor_item_id/.test(s)) return { rows: [
      { key: 'qbo_expense_account_id', value: 'ACCT-42' }, { key: 'qbo_labor_item_id', value: 'ITEM-LABOR' }, { key: 'qbo_bill_terms_days', value: '0' }] };
    if (/SELECT qbo_realm_id FROM companies/.test(s)) return { rows: [{ qbo_realm_id: 'realm-1' }] };
    if (/^SELECT key, value FROM settings WHERE company_id = \$1$/.test(s.trim())) return { rows: world.settings };
    if (/FROM time_entries te/.test(s) && /qbo_vendor_id/.test(s)) {
      return { rows: clone(world.timeRows.filter(r => approved(r) && (!params[1] || r.work_date >= params[1]) && (!params[2] || r.work_date <= params[2]))) };
    }
    if (/FROM users u/.test(s) && /qbo_vendor_id IS NOT NULL/.test(s)) {
      // Contractors with approved leave in the span, or active with a weekly guarantee.
      const [, f, t] = params;
      return { rows: clone(world.users.filter(u => u.guaranteed_weekly_hours > 0
        || world.leaveRequests.some(r => (r.user_id || 10) === u.user_id && r.start_date <= t && r.end_date >= f))) };
    }
    if (/FROM reimbursements r/.test(s)) return { rows: clone(world.reimb) };
    if (/FROM time_off_requests/.test(s)) return { rows: world.leaveRequests.map(r => ({ user_id: 10, hours: null, ...r })) };
    if (/FROM shifts/.test(s)) return { rows: [] };
    if (/FROM worker_rate_history/.test(s)) return { rows: world.rateRows };
    if (/UPDATE time_entries SET qbo_bill_id/.test(s)) {
      const [billId, ids] = params;
      const claimOnlyUnbilled = /qbo_bill_id IS NULL/.test(s) && params[2] !== true;
      let n = 0;
      world.timeRows.forEach(r => { if (ids.includes(r.id) && (!claimOnlyUnbilled || !r.qbo_bill_id)) { r.qbo_bill_id = billId; n++; } });
      return { rows: [], rowCount: n };
    }
    if (/UPDATE reimbursements SET qbo_bill_id/.test(s)) {
      const [billId, ids] = params;
      world.reimb.forEach(r => { if (ids.includes(r.id)) r.qbo_bill_id = billId; });
      return { rows: [], rowCount: ids.length };
    }
    if (/INSERT INTO qbo_bill_range_pay/.test(s)) {
      const [, uids, kinds, dates, amounts, hours, billIds, statuses, credits] = params;
      uids.forEach((uid, i) => {
        const row = { user_id: uid, kind: kinds[i], pay_date: dates[i], amount_cents: amounts[i], hours: hours[i],
          qbo_bill_id: billIds[i], status: statuses[i], credit_cents: credits[i] };
        const hit = world.ledger.find(l => l.user_id === uid && l.kind === kinds[i] && l.pay_date === dates[i]);
        if (hit) Object.assign(hit, row, { qbo_bill_id: billIds[i] || hit.qbo_bill_id }); else world.ledger.push(row);
      });
      return { rows: [], rowCount: uids.length };
    }
    if (/UPDATE qbo_bill_range_pay/.test(s) && /credit_cents = 0/.test(s)) {
      const [, uid] = params;
      const rows = world.ledger.filter(l => l.user_id === uid && Number(l.credit_cents || 0) !== 0);
      const out = rows.map(l => ({ kind: l.kind, pay_date: l.pay_date, credit_cents: l.credit_cents }));
      rows.forEach(l => { l.amount_cents = Number(l.amount_cents) + Number(l.credit_cents); l.credit_cents = 0; });
      return { rows: out, rowCount: rows.length };
    }
    if (/FROM qbo_bill_range_pay/.test(s)) {
      // `orphan`: a billed worked day with no approved entry left.
      return { rows: clone(world.ledger).map(l => ({
        ...l,
        orphan: l.kind === 'worked' && Number(l.amount_cents) !== 0
          && !world.timeRows.some(r => r.user_id === l.user_id && r.work_date === l.pay_date && approved(r)),
      })) };
    }
    if (/INSERT INTO qbo_bill_pushes/.test(s)) {
      const [, userId, requestId, bill, totalC, teIds, rIds, ledger, , force] = params;
      let row = world.pushes.find(p => p.request_id === requestId);
      if (!row) {
        row = { id: nextPushId++, user_id: userId, request_id: requestId, status: 'pending', bill: JSON.parse(bill), total_cents: totalC,
          time_entry_ids: teIds, reimbursement_ids: rIds, ledger: JSON.parse(ledger), qbo_bill_id: null, force: !!force };
        world.pushes.push(row);
      }
      return { rows: [{ id: row.id, status: row.status, user_id: row.user_id }], rowCount: 1 };
    }
    if (/SELECT user_id, COUNT\(\*\)/.test(s) && /FROM qbo_bill_pushes/.test(s)) {
      if (world.noSeq) return { rows: [] };
      const counts = new Map();
      world.pushes.filter(p => p.status === 'posted').forEach(p => counts.set(p.user_id, (counts.get(p.user_id) || 0) + 1));
      return { rows: [...counts].map(([user_id, n]) => ({ user_id, n })) };
    }
    if (/^SELECT[\s\S]*FROM qbo_bill_pushes[\s\S]*WHERE id = \$1/.test(s.trim())) {
      const [id, companyId] = params;
      return { rows: clone(world.pushes.filter(p => p.id === Number(id) && companyId === mockUser.company_id)) };
    }
    if (/^SELECT[\s\S]*FROM qbo_bill_pushes/.test(s.trim())) {
      return { rows: clone(world.pushes.filter(p => p.status === 'pending' || p.status === 'mismatch')) };
    }
    if (/UPDATE qbo_bill_pushes/.test(s) && /'mismatch'/.test(s) && !/'posted'/.test(s)) {
      const [billId, , requestId] = params;
      world.pushes.filter(p => p.request_id === requestId && p.status === 'pending').forEach(p => { p.status = 'mismatch'; p.qbo_bill_id = billId; });
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE qbo_bill_pushes/.test(s) && /'discarded'/.test(s)) {
      const [id] = params;
      const hit = world.pushes.filter(p => p.id === Number(id) && (p.status === 'pending' || p.status === 'mismatch'));
      hit.forEach(p => { p.status = 'discarded'; });
      return { rows: [], rowCount: hit.length };
    }
    if (/UPDATE qbo_bill_pushes/.test(s) && /'posted'/.test(s)) {
      const [billId, , requestId] = params;
      world.pushes.filter(p => p.request_id === requestId).forEach(p => { p.status = 'posted'; p.qbo_bill_id = billId; });
      return { rows: [], rowCount: 1 };
    }
    if (/DELETE FROM qbo_bill_pushes/.test(s)) {
      const [, requestId] = params;
      world.pushes = world.pushes.filter(p => !(p.request_id === requestId && p.status === 'pending'));
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  pool.query.mockReset();
  pool.query.mockImplementation(handle);
  pool.connect.mockReset();
  pool.connect.mockImplementation(async () => {
    let snap = null;
    let held = null; // the advisory lock this client's transaction holds
    const endTx = () => { if (held) { world.locks.delete(held); held = null; } };
    return {
      query: async (sql, params) => {
        const t = String(sql).trim();
        if (/pg_try_advisory_xact_lock/.test(t)) {
          const key = JSON.stringify(params);
          if (world.locks.has(key)) return { rows: [{ locked: false }] };
          world.locks.add(key); held = key;
          return { rows: [{ locked: true }] };
        }
        if (t === 'BEGIN') { snap = clone({ timeRows: world.timeRows, ledger: world.ledger, pushes: world.pushes, reimb: world.reimb }); return { rows: [] }; }
        if (t === 'ROLLBACK') { endTx(); Object.assign(world, snap); return { rows: [] }; }
        if (t === 'COMMIT') { endTx(); return { rows: [] }; }
        return handle(sql, params);
      },
      release: () => { endTx(); },
    };
  });
  qbo.createBill.mockReset();
  qbo.createBill.mockImplementation(async (_c, b) => {
    if (world.qboFail) { const e = world.qboFail; world.qboFail = null; throw e; }
    if (world.qboBills.has(b.requestId)) return world.qboBills.get(b.requestId);
    const bill = { Id: `B-${world.qboBills.size + 1}`, TotalAmt: lineTotal(b.lines) };
    world.qboBills.set(b.requestId, bill);
    return bill;
  });
  return world;
}

const lineTotal = lines => Math.round(lines.reduce((s, l) => s + (l.amount != null ? l.amount : l.qty * l.unitPrice), 0) * 100) / 100;
const push = body => request(makeApp()).post('/api/qbo/push-bills').send(body);
const resolve = (id, body) => request(makeApp()).post(`/api/qbo/bill-outbox/${id}/resolve`).send(body);
const lastBill = () => qbo.createBill.mock.calls[qbo.createBill.mock.calls.length - 1][1];
const billedTotal = world => Math.round([...world.qboBills.values()].reduce((s, b) => s + b.TotalAmt, 0) * 100) / 100;
const WEEK1 = { from: '2026-09-01', to: '2026-09-07' };
const WEEK2 = { from: '2026-09-08', to: '2026-09-14' };
const lostResponse = world => async (_c, b) => {
  // The request reached Intuit and created the bill; the response was lost.
  world.qboBills.set(b.requestId, { Id: 'B-1', TotalAmt: lineTotal(b.lines) });
  throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
};

beforeEach(() => { logAudit.mockClear(); });

describe('1 — a pending bill is never dropped on a failed replay', () => {
  test.each([
    ['not connected', () => new Error('QuickBooks not connected')],
    ['401 expired auth', () => Object.assign(new Error('Unauthorized'), { response: { status: 401 } })],
    ['400 vendor inactive', () => Object.assign(new Error('Bad request'), { response: { status: 400, data: { Fault: { Error: [{ Detail: 'Vendor inactive' }] } } } })],
  ])('replay fails (%s) → row kept, worker blocked, no second bill later', async (_name, mkErr) => {
    const world = install(makeWorld({ timeRows: [timeRow({ id: 1, work_date: '2026-09-01' })] }));
    qbo.createBill.mockImplementationOnce(lostResponse(world));
    await push(WEEK1);
    expect(world.pushes[0].status).toBe('pending');

    const impl = qbo.createBill.getMockImplementation();
    qbo.createBill.mockImplementation(async () => { throw mkErr(); });
    const r2 = await push(WEEK1);
    qbo.createBill.mockImplementation(impl);
    expect(r2.status).toBe(200);
    expect(world.pushes).toEqual([expect.objectContaining({ status: 'pending' })]); // was: deleted
    expect(r2.body.pushed).toEqual([]);
    expect(r2.body.skipped).toEqual([expect.objectContaining({ user_id: 10, outbox_id: world.pushes[0].id })]);

    // Reconnected; a late entry was approved meanwhile.
    world.timeRows.push(timeRow({ id: 2, work_date: '2026-09-02' }));
    const r3 = await push(WEEK1);
    expect(r3.body.reconciled).toEqual([expect.objectContaining({ user_id: 10, bill_id: 'B-1' })]);
    expect(billedTotal(world)).toBe(320); // was 480: day 1 billed twice
  });

  test('the bill carries its request id in PrivateNote + DocNumber (findable in QuickBooks)', async () => {
    install(makeWorld({ timeRows: [timeRow({ id: 1, work_date: '2026-09-01' })] }));
    await push(WEEK1);
    const b = lastBill();
    expect(b.memo).toContain(b.requestId);
    expect(b.docNumber).toMatch(/^OF-[a-f0-9]{18}$/);
    expect(b.requestId).toContain(b.docNumber.slice(3));
  });

  test('admin resolve "discard" (no bill in QuickBooks) unblocks the worker; the content bills under a NEW request id', async () => {
    const world = install(makeWorld({ timeRows: [timeRow({ id: 1, work_date: '2026-09-01' })] }));
    qbo.createBill.mockImplementationOnce(async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); });
    await push(WEEK1);
    const row = world.pushes[0];
    const res = await resolve(row.id, { action: 'discard' });
    expect(res.status).toBe(200);
    expect(world.pushes[0].status).toBe('discarded');
    expect(logAudit).toHaveBeenCalledWith(mockUser.company_id, mockUser.id, mockUser.full_name, 'qbo.bill_outbox_resolved', 'qbo_bill_push', row.id, null, expect.objectContaining({ action: 'discard' }));
    const r2 = await push(WEEK1);
    expect(r2.body.pushed).toHaveLength(1);
    expect(lastBill().requestId).not.toBe(row.request_id);
    expect(billedTotal(world)).toBe(160);
  });

  test('admin resolve "confirm" records the bill the admin found in QuickBooks — nothing bills twice', async () => {
    const world = install(makeWorld({ timeRows: [timeRow({ id: 1, work_date: '2026-09-01' })] }));
    qbo.createBill.mockImplementationOnce(lostResponse(world));
    await push(WEEK1);
    const row = world.pushes[0];
    expect((await resolve(row.id, { action: 'confirm' })).status).toBe(400); // qbo_bill_id required
    const res = await resolve(row.id, { action: 'confirm', qbo_bill_id: 'B-1' });
    expect(res.status).toBe(200);
    expect(world.pushes[0]).toMatchObject({ status: 'posted', qbo_bill_id: 'B-1' });
    expect(world.timeRows[0].qbo_bill_id).toBe('B-1');
    expect(world.ledger.find(l => l.kind === 'worked')).toMatchObject({ amount_cents: 16000 });
    const r2 = await push(WEEK1);
    expect(r2.body.pushed).toEqual([]);
    expect(billedTotal(world)).toBe(160);
    // Already resolved → 409; unknown / other company's id → 404; bad action → 400.
    expect((await resolve(row.id, { action: 'discard' })).status).toBe(409);
    expect((await resolve(999, { action: 'discard' })).status).toBe(404);
    expect((await resolve(row.id, { action: 'nope' })).status).toBe(400);
  });

  test('a first-send definite rejection still drops the row (nothing reached QuickBooks)', async () => {
    const world = install(makeWorld({ timeRows: [timeRow({ id: 1, work_date: '2026-09-01' })] }));
    world.qboFail = Object.assign(new Error('Bad request'), { response: { status: 400, data: { Fault: { Error: [{ Detail: 'Vendor inactive' }] } } } });
    await push(WEEK1);
    expect(world.pushes).toEqual([]);
    expect((await push(WEEK1)).body.pushed).toHaveLength(1);
  });
});

describe('2 — one bill push per company at a time', () => {
  test('two concurrent pushes with different ranges: one runs, the other gets 409; the entry bills once', async () => {
    const world = install(makeWorld({ timeRows: [timeRow({ id: 1, work_date: '2026-09-01' })] }));
    const impl = qbo.createBill.getMockImplementation();
    qbo.createBill.mockImplementation(async (c, b) => { await new Promise(r => setTimeout(r, 50)); return impl(c, b); });
    const qimpl = pool.query.getMockImplementation();
    pool.query.mockImplementation(async (sql, p) => { if (/FROM time_entries te/.test(String(sql))) await new Promise(r => setTimeout(r, 40)); return qimpl(sql, p); });
    const [a, b] = await Promise.all([push({ from: '2026-09-01', to: '2026-09-07' }), push({ from: '2026-08-31', to: '2026-09-13' })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a, b].find(r => r.status === 409).body.error).toMatch(/already running/);
    expect(billedTotal(world)).toBe(160); // was 320
    expect(world.locks.size).toBe(0); // released
    expect((await push(WEEK1)).status).toBe(200);
  });

  test('recording a bill credit while a push runs → 409', async () => {
    install(makeWorld({ timeRows: [timeRow({ id: 1, work_date: '2026-09-01' })] }));
    const impl = qbo.createBill.getMockImplementation();
    let release;
    qbo.createBill.mockImplementation(async (c, b) => { await new Promise(r => { release = r; }); return impl(c, b); });
    const running = push(WEEK1).then(r => r); // supertest starts on then()
    await new Promise(r => setTimeout(r, 30));
    const rec = await request(makeApp()).post('/api/qbo/bill-credits/record').send({ user_id: 10 });
    expect(rec.status).toBe(409);
    release();
    expect((await running).status).toBe(200);
  });

  test('stamping claims only entries no other bill has claimed', async () => {
    const world = install(makeWorld({ timeRows: [timeRow({ id: 1, work_date: '2026-09-01' })] }));
    await push(WEEK1);
    const stamp = world.sql.find(s => /UPDATE time_entries SET qbo_bill_id/.test(s));
    expect(stamp).toMatch(/qbo_bill_id IS NULL/);
  });
});

describe('3 — a later bill never reuses an earlier posted bill\'s request id', () => {
  const setup = over => install(makeWorld({
    ledger: [{ user_id: 10, kind: 'worked', pay_date: '2026-09-01', amount_cents: 16000, status: 'billed', credit_cents: 0 }],
    timeRows: [timeRow({ id: 1, work_date: '2026-09-01', qbo_bill_id: 'B-0' })],
    leaveRequests: [{ type: 'sick', start_date: '2026-09-03', end_date: '2026-09-03' }],
    ...over,
  }));
  const run = async (world) => {
    await push(WEEK1); // X: sick +160
    world.leaveRequests = [];
    world.reimb = [{ id: 7, user_id: 10, project_id: 200, expense_date: '2026-09-02', amount: '200.00', description: 'fuel', category: 'fuel', qbo_bill_id: null, qbo_purchase_id: null, full_name: 'Alex Rivera', qbo_vendor_id: 'V-1' }];
    await push(WEEK1); // Y: reimb 200 − sick 160
    world.leaveRequests = [{ type: 'sick', start_date: '2026-09-03', end_date: '2026-09-03' }];
    return push(WEEK1); // Z: sick +160 again — same content as X
  };

  test('sick → revoked → re-approved: 3 bills, QuickBooks holds what is owed ($360, was $200)', async () => {
    const world = setup();
    const rz = await run(world);
    const ids = qbo.createBill.mock.calls.map(c => c[1].requestId);
    expect(new Set(ids).size).toBe(3);
    expect(rz.body.pushed).toHaveLength(1);
    expect(billedTotal(world)).toBe(360);
  });

  test('even without the sequence, an upsert hitting a posted row mints a new id', async () => {
    const world = setup({ noSeq: true });
    await run(world);
    const ids = qbo.createBill.mock.calls.map(c => c[1].requestId);
    expect(new Set(ids).size).toBe(3);
    expect(billedTotal(world)).toBe(360);
  });
});

describe('4 — the cutover flag is a frozen column', () => {
  test('gatherBillData reads time_entries.qbo_pre_ledger_bill, not qbo_synced_at', async () => {
    install(makeWorld({ timeRows: [timeRow({ id: 1, work_date: '2026-09-01' })] }));
    await push(WEEK1);
    const sql = pool.query.mock.calls.map(c => String(c[0])).find(s => /FROM time_entries te/.test(s) && /qbo_vendor_id/.test(s));
    expect(sql).toMatch(/te\.qbo_pre_ledger_bill\s+AS pre_ledger_bill/);
    expect(sql).not.toMatch(/qbo_synced_at/);
  });

  test('0218 adds the column and freezes it from the 0211 cutover (NOW() when 0211 has no applied_at)', () => {
    const dir = path.join(__dirname, '..', 'migrations');
    const file = fs.readdirSync(dir).find(f => /^0218_/.test(f));
    expect(file).toBeTruthy();
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS qbo_pre_ledger_bill BOOLEAN NOT NULL DEFAULT false/);
    expect(sql).toMatch(/0211_qbo_bill_range_pay\.sql/);
    expect(sql).toMatch(/SELECT applied_at FROM schema_migrations/);
    expect(sql).toMatch(/COALESCE\(cutover, NOW\(\)\)/);
    // Guarded so a raw apply on a fresh DB (lintMigrations, CI) doesn't fail.
    expect(sql).toMatch(/to_regclass\('schema_migrations'\) IS NOT NULL/);
    expect(sql).toMatch(/qbo_bill_id IS NOT NULL/);
    // Nothing in the app writes the flag.
    const routes = fs.readdirSync(path.join(__dirname, '..', 'routes')).map(f => fs.readFileSync(path.join(__dirname, '..', 'routes', f), 'utf8'));
    expect(routes.some(src => /qbo_pre_ledger_bill\s*=/.test(src))).toBe(false);
  });
});

describe('5 — held credits and reversals net on the next bill, whatever its range', () => {
  test('a held credit nets against the next bill for a NON-overlapping range', async () => {
    const world = install(makeWorld({
      ledger: [
        { user_id: 10, kind: 'sick', pay_date: '2026-09-03', amount_cents: 16000, status: 'billed', credit_cents: 0 },
        { user_id: 10, kind: 'worked', pay_date: '2026-09-01', amount_cents: 16000, status: 'billed', credit_cents: 0 },
      ],
      timeRows: [timeRow({ id: 1, work_date: '2026-09-01', qbo_bill_id: 'B-1' })],
    }));
    const r1 = await push(WEEK1); // sick revoked → −160 held
    expect(r1.body.credits_held).toEqual([expect.objectContaining({ amount: -160 })]);
    world.timeRows.push(timeRow({ id: 3, work_date: '2026-09-09', start_time: '07:00:00', end_time: '17:00:00' })); // $200 next week
    await push(WEEK2);
    const lines = lastBill().lines;
    expect(lineTotal(lines)).toBe(40); // was 200
    expect(lines.find(l => /credit applied/i.test(l.description))).toMatchObject({ amount: -160 });
    expect(world.ledger.find(l => l.kind === 'sick')).toMatchObject({ amount_cents: 0, credit_cents: 0 });
    // Applied once only.
    world.timeRows.push(timeRow({ id: 4, work_date: '2026-09-10' }));
    await push(WEEK2);
    expect(lineTotal(lastBill().lines)).toBe(160);
  });

  test('billed pay on a day outside the range whose entry was rejected is credited on the next bill', async () => {
    const world = install(makeWorld({
      ledger: [{ user_id: 10, kind: 'worked', pay_date: '2026-09-01', amount_cents: 16000, status: 'billed', credit_cents: 0 }],
      timeRows: [
        timeRow({ id: 1, work_date: '2026-09-01', qbo_bill_id: 'B-1', status: 'rejected' }),
        timeRow({ id: 3, work_date: '2026-09-09', start_time: '07:00:00', end_time: '17:00:00' }), // $200
      ],
    }));
    await push(WEEK2);
    expect(lineTotal(lastBill().lines)).toBe(40); // was 200
    expect(world.ledger.find(l => l.pay_date === '2026-09-01')).toMatchObject({ amount_cents: 0, credit_cents: 0 });
  });

  test('a reversal bigger than the next bill is held (carried), not lost', async () => {
    const world = install(makeWorld({
      ledger: [{ user_id: 10, kind: 'worked', pay_date: '2026-09-01', amount_cents: 16000, status: 'billed', credit_cents: 0 }],
      timeRows: [
        timeRow({ id: 1, work_date: '2026-09-01', qbo_bill_id: 'B-1', status: 'rejected' }),
        timeRow({ id: 3, work_date: '2026-09-09', start_time: '08:00:00', end_time: '12:00:00' }), // $80
      ],
    }));
    const r = await push(WEEK2);
    expect(lineTotal(lastBill().lines)).toBe(80);
    expect(r.body.credits_held).toEqual([expect.objectContaining({ amount: -160 })]);
    expect(world.ledger.find(l => l.pay_date === '2026-09-01')).toMatchObject({ amount_cents: 16000, credit_cents: -16000 });
  });
});

describe('6 — a TotalAmt mismatch keeps the outbox row (the bill exists)', () => {
  test('on replay: row → mismatch with the returned bill id, surfaced; confirm resolves it', async () => {
    const world = install(makeWorld({ timeRows: [timeRow({ id: 1, work_date: '2026-09-01' })] }));
    qbo.createBill.mockImplementationOnce(async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); });
    await push(WEEK1);
    const rid = world.pushes[0].request_id;
    world.qboBills.set(rid, { Id: 'B-9', TotalAmt: 159.99 });
    const r = await push(WEEK1);
    expect(world.pushes[0]).toMatchObject({ status: 'mismatch', qbo_bill_id: 'B-9' });
    expect(r.body.skipped[0]).toMatchObject({ user_id: 10, outbox_id: world.pushes[0].id });
    expect(r.body.skipped[0].reason).toMatch(/B-9/);
    const again = await push(WEEK1); // still blocked, not re-sent
    expect(again.body.pushed).toEqual([]);
    expect(qbo.createBill).toHaveBeenCalledTimes(2);
    expect((await resolve(world.pushes[0].id, { action: 'confirm', qbo_bill_id: 'B-9' })).status).toBe(200);
    expect(world.timeRows[0].qbo_bill_id).toBe('B-9');
    expect((await push(WEEK1)).body.pushed).toEqual([]);
  });

  test('on first send: the row is kept as mismatch, not deleted', async () => {
    const world = install(makeWorld({ timeRows: [timeRow({ id: 1, work_date: '2026-09-01' })] }));
    qbo.createBill.mockImplementationOnce(async () => ({ Id: 'B-OLD', TotalAmt: 999 }));
    const r = await push(WEEK1);
    expect(world.pushes).toEqual([expect.objectContaining({ status: 'mismatch', qbo_bill_id: 'B-OLD' })]);
    expect(r.body.skipped[0]).toMatchObject({ outbox_id: world.pushes[0].id });
    expect(world.timeRows[0].qbo_bill_id).toBe(null);
  });

  test('GET /bill-outbox lists unresolved rows', async () => {
    const world = install(makeWorld({ timeRows: [timeRow({ id: 1, work_date: '2026-09-01' })] }));
    qbo.createBill.mockImplementationOnce(async () => ({ Id: 'B-OLD', TotalAmt: 999 }));
    await push(WEEK1);
    const r = await request(makeApp()).get('/api/qbo/bill-outbox');
    expect(r.status).toBe(200);
    expect(r.body).toEqual([expect.objectContaining({ id: world.pushes[0].id, status: 'mismatch', qbo_bill_id: 'B-OLD', total: 160 })]);
  });
});

describe('7 — contractors with only leave / a guarantee in range still get a bill', () => {
  test('sick day, no time entries in range → $160 bill', async () => {
    const world = install(makeWorld({
      users: [{ user_id: 10, ...WORKER }],
      leaveRequests: [{ type: 'sick', start_date: '2026-09-09', end_date: '2026-09-09' }],
      timeRows: [timeRow({ id: 1, work_date: '2026-09-01', qbo_bill_id: 'B-1' })],
    }));
    const r = await push(WEEK2);
    expect(r.body.pushed).toHaveLength(1);
    expect(lineTotal(lastBill().lines)).toBe(160);
    expect(world.ledger.find(l => l.kind === 'sick')).toMatchObject({ pay_date: '2026-09-09', amount_cents: 16000 });
    expect((await push(WEEK2)).body.pushed).toEqual([]);
  });

  test('guaranteed 40h/week, no time in range → the week\'s guarantee bills', async () => {
    install(makeWorld({ users: [{ user_id: 10, ...WORKER, guaranteed_weekly_hours: 40 }] }));
    await push({ from: '2026-09-07', to: '2026-09-13' });
    expect(lineTotal(lastBill().lines)).toBe(800);
  });
});

describe('8 — payroll worker set: admins by the rate in effect during the range', () => {
  test('PAYROLL_WORKERS_SQL checks worker_rate_history, not the current rate', () => {
    const s = PAYROLL_WORKERS_SQL;
    expect(s).toMatch(/worker_rate_history/);
    expect(s).toMatch(/effective_date <= \$3::date/);
    expect(s).not.toMatch(/u\.role NOT IN \('admin', 'super_admin'\) OR COALESCE\(u\.hourly_rate, 0\) > 0\)/);
  });
});

describe('9 — permission gates', () => {
  const permsFor = (method, p) => {
    const layer = qboRoute.stack.find(l => l.route && l.route.path === p && l.route.methods[method]);
    return layer.route.stack.map(s => s.handle.__permissionKey).filter(Boolean);
  };
  test.each([
    ['get', '/bill-credits'],
    ['get', '/bill-outbox'],
    ['post', '/bill-outbox/:id/resolve'],
  ])('%s %s requires manage_integrations + view_worker_wages', (method, p) => {
    expect(permsFor(method, p)).toEqual(expect.arrayContaining(['manage_integrations', 'view_worker_wages']));
  });
});

describe('reviewer proof g — the weekly guarantee across pay-period boundaries (pins current, correct behaviour)', () => {
  const { buildPayStatement } = require('../utils/payStatement');
  // 6h Mon–Fri (30h) every week Aug 31 – Oct 2, guaranteed 40h/week at $20 → $200 top-up per week.
  const days = [];
  for (let d = new Date(Date.UTC(2026, 7, 31)); d <= new Date(Date.UTC(2026, 9, 4)); d.setUTCDate(d.getUTCDate() + 1)) {
    const w = d.getUTCDay(); if (w >= 1 && w <= 5) days.push(d.toISOString().slice(0, 10));
  }
  const rows = days.map((k, i) => ({ id: i + 1, user_id: 10, work_date: k, start_time: '08:00:00', end_time: '14:00:00', wage_type: 'regular', break_minutes: 0 }));
  const per = (from, to) => buildPayStatement({
    worker: { id: 10, hourly_rate: 20, rate_type: 'hourly', guaranteed_weekly_hours: 40 },
    entries: rows.filter(r => r.work_date >= from && r.work_date <= to).map(r => ({ ...r })),
    weekContextEntries: rows.filter(r => r.work_date < from || r.work_date > to).map(r => ({ ...r })),
    otConfig: null, settings: { overtime_rule: 'none', week_start: 1 }, from, to,
  });
  test.each([
    ['2026-09-01', '2026-09-15', 400, ['2026-08-31', '2026-09-07']],
    ['2026-09-16', '2026-09-30', 400, ['2026-09-14', '2026-09-21']],
    ['2026-09-02', '2026-09-08', 200, ['2026-08-31']],
    ['2026-09-09', '2026-09-15', 200, ['2026-09-07']],
  ])('%s – %s pays $%d: each week once, by the period holding its last day, counting out-of-period hours', (f, t, cost, weeks) => {
    const s = per(f, t);
    expect(s.cost.guarantee).toBe(cost);
    expect(s.hours.guaranteeByWeek.map(w => [w.weekStart, w.covered, w.shortfall])).toEqual(weeks.map(w => [w, 30, 10]));
  });
});
