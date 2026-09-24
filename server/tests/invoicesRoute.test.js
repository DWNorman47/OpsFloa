/**
 * Lifecycle + tenant gates on /api/invoices, and the money-critical bit: a
 * recorded payment derives status draft→partial→paid off Σ payments vs total.
 * Mirrors estimatesRoute.test.js — the pool is mocked and driven with sequenced
 * responses, so these pin the contract without a live DB.
 */

let mockCurrentUser;

jest.mock('../middleware/auth', () => ({
  requireAuth:  (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireAdmin: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requirePlan:  () => (req, _res, next) => { req.user = mockCurrentUser; next(); },
}));
jest.mock('../middleware/commercialAccess', () => ({
  requireCommercialAccess: (req, _res, next) => next(),
}));

jest.mock('../db', () => {
  const queryMock = jest.fn();
  const fakeClient = { query: (...args) => queryMock(...args), release: jest.fn() };
  return { query: queryMock, connect: jest.fn().mockResolvedValue(fakeClient) };
});

jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../email', () => ({ sendEmail: jest.fn().mockResolvedValue({ ok: true }) }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const invoicesRoute = require('../routes/invoices');

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/invoices', invoicesRoute);
  app.use('/api/public/invoices', invoicesRoute.publicRouter);
  return app;
}

function setUser({ id = 1, company_id = 'co-1', role = 'admin' } = {}) {
  mockCurrentUser = { id, company_id, role, full_name: 'Test Admin' };
}

beforeEach(() => {
  pool.query.mockReset();
  setUser();
});

// ── GET /invoices ─────────────────────────────────────────────────────────────
describe('GET /api/invoices', () => {
  test('rejects an invalid status filter (must be in the enum)', async () => {
    const res = await request(makeApp()).get('/api/invoices').query({ status: 'bogus' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid status');
  });

  test('paginates with company scoping', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // COUNT
      .mockResolvedValueOnce({ rows: [] });              // SELECT
    const res = await request(makeApp()).get('/api/invoices').query({ page: 1, limit: 25 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ items: [], total: 0, page: 1 });
  });
});

// ── POST /invoices — create from scratch ──────────────────────────────────────
describe('POST /api/invoices', () => {
  test('rejects with 400 when client_name_snapshot missing', async () => {
    const res = await request(makeApp()).post('/api/invoices').send({ project_name: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/client_name_snapshot/);
  });

  test('rejects with 400 on an out-of-range tax_pct', async () => {
    const res = await request(makeApp())
      .post('/api/invoices')
      .send({ client_name_snapshot: 'Acme', tax_pct: 150 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tax_pct/);
  });

  test('rejects a client_id that belongs to another company (tenant isolation)', async () => {
    setUser();
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // clients ownership check fails
    const res = await request(makeApp())
      .post('/api/invoices')
      .send({ client_name_snapshot: 'Acme', client_id: 55, tax_pct: 0, retainage_pct: 0, lines: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid client_id');
  });
});

// ── PATCH /invoices/:id — frozen once sent ────────────────────────────────────
describe('PATCH /api/invoices/:id', () => {
  // PATCH now locks the row and re-checks frozen inside the tx (BEGIN → SELECT
  // FOR UPDATE → ROLLBACK on the guard paths).
  test('404 when the invoice is in another company', async () => {
    pool.query
      .mockResolvedValueOnce(undefined)                 // BEGIN
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce(undefined);                // ROLLBACK
    const res = await request(makeApp()).patch('/api/invoices/42').send({ client_name_snapshot: 'Y' });
    expect(res.status).toBe(404);
  });

  test('409 when the invoice is sent (frozen)', async () => {
    pool.query
      .mockResolvedValueOnce(undefined)                                  // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'sent' }] }) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce(undefined);                                 // ROLLBACK
    const res = await request(makeApp()).patch('/api/invoices/42').send({ client_name_snapshot: 'Y' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/frozen/i);
  });
});

// ── PUT /invoices/:id/lines ───────────────────────────────────────────────────
describe('PUT /api/invoices/:id/lines', () => {
  test('rejects when lines is not an array', async () => {
    const res = await request(makeApp()).put('/api/invoices/42/lines').send({ lines: 'nope' });
    expect(res.status).toBe(400);
  });

  test('rejects with 400 on an unknown category', async () => {
    const res = await request(makeApp())
      .put('/api/invoices/42/lines')
      .send({ lines: [{ category: 'banana', description: 'd', qty: 1, unit_cost_cents: 100 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid line/i);
  });

  test('409 when the invoice is frozen', async () => {
    pool.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'paid' }] }) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce(undefined); // ROLLBACK
    const res = await request(makeApp())
      .put('/api/invoices/42/lines')
      .send({ lines: [{ category: 'labor', description: 'Framing', qty: 1, unit_cost_cents: 1000 }] });
    expect(res.status).toBe(409);
  });
});

// ── POST /invoices/:id/send — only from draft ─────────────────────────────────
describe('POST /api/invoices/:id/send', () => {
  test('404 when the invoice is in another company', async () => {
    pool.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce(undefined);
    const res = await request(makeApp()).post('/api/invoices/42/send');
    expect(res.status).toBe(404);
  });

  test('409 when not in draft', async () => {
    pool.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 42, status: 'sent', invoice_number: 'INV-2026-0001' }] })
      .mockResolvedValueOnce(undefined);
    const res = await request(makeApp()).post('/api/invoices/42/send');
    expect(res.status).toBe(409);
  });

  test('emails the client a /i/ link on a successful send', async () => {
    const { sendEmail } = require('../email');
    sendEmail.mockClear();
    pool.query
      .mockResolvedValueOnce(undefined)                                                                   // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 42, status: 'draft', invoice_number: 'INV-2026-0001' }] }) // FOR UPDATE
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ tax_pct: '0', retainage_pct: '0' }] })               // recomputeTotals: head
      .mockResolvedValueOnce({ rows: [{ total_cents: '100000' }] })                                       // recomputeTotals: lines
      .mockResolvedValueOnce(undefined)                                                                   // recomputeTotals: UPDATE
      .mockResolvedValueOnce(undefined)                                                                   // UPDATE status='sent'
      .mockResolvedValueOnce(undefined)                                                                   // COMMIT
      .mockResolvedValueOnce(undefined)                                                                   // recordAudit INSERT
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 42, invoice_number: 'INV-2026-0001', client_email: 'client@acme.com', client_name_snapshot: 'Acme', total_cents: '100000' }] }) // loadInvoiceFull: head
      .mockResolvedValueOnce({ rows: [] })                                                                // loadInvoiceFull: lines
      .mockResolvedValueOnce({ rows: [] })                                                                // loadInvoiceFull: payments
      .mockResolvedValueOnce({ rows: [{ company_name: 'Contractor Co', currency: 'USD', sender_email: 'admin@contractor.com' }] }); // company + currency + sender
    const res = await request(makeApp()).post('/api/invoices/42/send');
    expect(res.status).toBe(200);
    expect(res.body.email).toMatchObject({ sent: true, to: 'client@acme.com' });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [to, subject, html, , opts] = sendEmail.mock.calls[0];
    expect(to).toBe('client@acme.com');
    expect(subject).toMatch(/INV-2026-0001/);
    expect(html).toMatch(/\/i\/[0-9a-f]{64}/); // the public link carries the raw token
    // From shows the contractor, replies go to the sender — not OpsFloa.
    expect(opts).toMatchObject({ fromName: 'Contractor Co', replyTo: 'admin@contractor.com' });
  });
});

// ── POST /invoices/:id/payments — the money-critical status derivation ─────────
describe('POST /api/invoices/:id/payments', () => {
  test('rejects a non-positive amount with 400', async () => {
    const res = await request(makeApp()).post('/api/invoices/42/payments').send({ amount_cents: 0 });
    expect(res.status).toBe(400);
  });

  test('409 when the invoice is still a draft', async () => {
    pool.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 42, status: 'draft', invoice_number: 'INV-2026-0001' }] })
      .mockResolvedValueOnce(undefined); // ROLLBACK
    const res = await request(makeApp()).post('/api/invoices/42/payments').send({ amount_cents: 5000 });
    expect(res.status).toBe(409);
  });

  // Drive a sent invoice (total 100,000¢) through a payment and assert the
  // status the handler wrote. paidSum controls partial vs paid.
  function drivePayment(paidSum, total = 100000) {
    pool.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 42, status: 'sent', invoice_number: 'INV-2026-0001' }] }) // FOR UPDATE
      .mockResolvedValueOnce(undefined) // INSERT payment
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ total_cents: String(total), status: 'sent' }] }) // applyPaymentStatus: head
      .mockResolvedValueOnce({ rows: [{ paid: String(paidSum) }] }) // applyPaymentStatus: SUM
      .mockResolvedValueOnce(undefined) // applyPaymentStatus: UPDATE status
      .mockResolvedValueOnce(undefined) // COMMIT
      .mockResolvedValueOnce(undefined) // recordAudit INSERT
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 42, total_cents: String(total) }] }) // loadInvoiceFull head
      .mockResolvedValueOnce({ rows: [] }) // loadInvoiceFull lines
      .mockResolvedValueOnce({ rows: [] }); // loadInvoiceFull payments
  }

  function statusWritten() {
    const call = pool.query.mock.calls.find(c => /UPDATE invoices SET status = \$1/.test(c[0]));
    return call && call[1][0];
  }

  test('a partial payment sets status = partial', async () => {
    drivePayment(40000); // 40k of 100k
    const res = await request(makeApp()).post('/api/invoices/42/payments').send({ amount_cents: 40000, method: 'check' });
    expect(res.status).toBe(201);
    expect(statusWritten()).toBe('partial');
  });

  test('a full payment sets status = paid', async () => {
    drivePayment(100000); // paid in full
    const res = await request(makeApp()).post('/api/invoices/42/payments').send({ amount_cents: 100000, method: 'ach' });
    expect(res.status).toBe(201);
    expect(statusWritten()).toBe('paid');
  });
});

// ── POST /invoices/:id/void ───────────────────────────────────────────────────
describe('POST /api/invoices/:id/void', () => {
  test('409 when already void', async () => {
    pool.query
      .mockResolvedValueOnce(undefined)                                                        // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'void', invoice_number: 'INV-2026-0001' }] }) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce(undefined);                                                       // ROLLBACK
    const res = await request(makeApp()).post('/api/invoices/42/void');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already void/i);
  });
});

// ── POST /invoices/from-estimate/:id — only from an accepted estimate ─────────
describe('POST /api/invoices/from-estimate/:id', () => {
  // SQL-dispatching fake: routes each statement by its text so the test pins
  // behaviour, not statement order. Inserted invoice lines are captured and fed
  // back to recomputeTotals, so the stored total is what the real math produces.
  function driveFromEstimate({ estimate, estimateLines, existingInvoice = null }) {
    const inserted = [];
    const stored = {};
    pool.query.mockImplementation(async (sql, params = []) => {
      if (/FROM estimates\b/.test(sql) && /company_id/.test(sql)) return estimate ? { rowCount: 1, rows: [estimate] } : { rowCount: 0, rows: [] };
      if (/^\s*SELECT/.test(sql) && /FROM invoices\b/.test(sql) && /source_estimate_id/.test(sql)) {
        return existingInvoice ? { rowCount: 1, rows: [existingInvoice] } : { rowCount: 0, rows: [] };
      }
      if (/FROM estimate_lines/.test(sql)) {
        const rows = /line_type IN/.test(sql)
          ? estimateLines.filter(l => ['base', 'allowance'].includes(l.line_type))
          : estimateLines;
        return { rowCount: rows.length, rows };
      }
      if (/INSERT INTO invoices/.test(sql)) return { rowCount: 1, rows: [{ id: 900, invoice_number: 'INV-2026-0001' }] };
      if (/INSERT INTO invoice_lines/.test(sql)) {
        inserted.push({ category: params[1], description: params[3], qty: params[4], unit_cost_cents: params[6], total_cents: params[7] });
        return { rowCount: 1, rows: [] };
      }
      if (/SELECT tax_pct, retainage_pct FROM invoices/.test(sql)) return { rowCount: 1, rows: [{ tax_pct: estimate.tax_pct, retainage_pct: '0' }] };
      if (/SELECT total_cents FROM invoice_lines/.test(sql)) return { rowCount: inserted.length, rows: inserted.map(l => ({ total_cents: String(l.total_cents) })) };
      if (/UPDATE invoices SET subtotal_cents/.test(sql)) { stored.subtotal = params[0]; stored.tax = params[1]; stored.total = params[2]; return { rowCount: 1, rows: [] }; }
      if (/FROM invoices i/.test(sql)) return { rowCount: 1, rows: [{ id: 900, total_cents: String(stored.total || 0) }] };
      return { rowCount: 0, rows: [] };
    });
    return { inserted, stored };
  }

  const acceptedEstimate = {
    id: 7, status: 'accepted', client_id: null, client_name_snapshot: 'Acme', client_email: null,
    project_name: 'Kitchen', project_address: null, converted_project_id: null,
    overhead_pct: '10', margin_pct: '15', contingency_pct: '0', tax_pct: '8',
  };
  const lines = [
    { category: 'labor', sort_order: 0, description: 'Base work', qty: '1', unit: null, unit_cost_cents: '1000000', total_cents: '1000000', notes: null, line_type: 'base' },
    { category: 'materials', sort_order: 1, description: 'Upgrade (optional)', qty: '1', unit: null, unit_cost_cents: '200000', total_cents: '200000', notes: null, line_type: 'optional' },
  ];

  test('409 when the estimate is not accepted', async () => {
    driveFromEstimate({ estimate: { ...acceptedEstimate, status: 'sent' }, estimateLines: lines });
    const res = await request(makeApp()).post('/api/invoices/from-estimate/7');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/accepted/i);
  });

  test('invoice total equals the estimate total: base lines + overhead/margin as lines, optional excluded', async () => {
    const { computeEstimateTotals } = require('../constants/projectMoneyEnums');
    const { inserted, stored } = driveFromEstimate({ estimate: acceptedEstimate, estimateLines: lines });
    const res = await request(makeApp()).post('/api/invoices/from-estimate/7');
    expect(res.status).toBe(201);
    // $10,000 base + 10% overhead ($1,000) + 15% margin on $11,000 ($1,650) = $12,650 pre-tax.
    expect(stored.subtotal).toBe(1265000);
    expect(inserted.some(l => /optional/i.test(l.description))).toBe(false);
    expect(inserted.map(l => l.total_cents)).toEqual([1000000, 100000, 165000]);
    const est = computeEstimateTotals({
      lines: lines.map(l => ({ total_cents: parseInt(l.total_cents, 10), line_type: l.line_type })),
      overhead_pct: 10, margin_pct: 15, contingency_pct: 0, tax_pct: 8,
    });
    expect(stored.tax).toBe(est.tax);
    expect(stored.total).toBe(est.total); // 1,366,200
  });

  test('locks the estimate row and 409s when a non-void invoice already exists for it', async () => {
    driveFromEstimate({ estimate: acceptedEstimate, estimateLines: lines, existingInvoice: { id: 55, invoice_number: 'INV-2026-0003' } });
    const res = await request(makeApp()).post('/api/invoices/from-estimate/7');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/INV-2026-0003/);
    const estSel = pool.query.mock.calls.find(c => /FROM estimates\b/.test(c[0]));
    expect(estSel[0]).toMatch(/FOR UPDATE/);
    const dupSel = pool.query.mock.calls.find(c => /^\s*SELECT/.test(c[0]) && /FROM invoices\b/.test(c[0]) && /source_estimate_id/.test(c[0]));
    expect(dupSel[0]).toMatch(/status\s*<>\s*'void'/);
    expect(pool.query.mock.calls.some(c => /INSERT INTO invoices/.test(c[0]))).toBe(false);
  });

  test('a unique-violation from the backstop index maps to 409, not 500', async () => {
    driveFromEstimate({ estimate: acceptedEstimate, estimateLines: lines });
    const base = pool.query.getMockImplementation();
    pool.query.mockImplementation(async (sql, params) => {
      if (/INSERT INTO invoices/.test(sql)) { const e = new Error('dup'); e.code = '23505'; e.constraint = 'uq_invoices_source_estimate_live'; throw e; }
      return base(sql, params);
    });
    const res = await request(makeApp()).post('/api/invoices/from-estimate/7');
    expect(res.status).toBe(409);
  });
});

describe('POST /api/invoices/retainage-release/:projectId', () => {
  test('404 when project not in caller company', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });   // project lookup
    const res = await request(makeApp()).post('/api/invoices/retainage-release/42');
    expect(res.status).toBe(404);
  });

  test('400 when the project holds no retainage', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 42 }] })   // project
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });            // UPDATE — nothing held
    const res = await request(makeApp()).post('/api/invoices/retainage-release/42');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/retainage/i);
  });

  test('marks held retainage released', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 42 }] })                             // project
      .mockResolvedValueOnce({ rowCount: 2, rows: [{ id: 5, newly_released: '1000' }, { id: 6, newly_released: '500' }] });  // UPDATE
    const res = await request(makeApp()).post('/api/invoices/retainage-release/42');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ released_cents: 1500, invoices: 2 });
  });
});

// ── Public view — token-keyed, no auth ────────────────────────────────────────
describe('GET /api/public/invoices/view/:token', () => {
  test('404 when no invoice matches the token hash', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp()).get('/api/public/invoices/view/bogus-token');
    expect(res.status).toBe(404);
  });
});
