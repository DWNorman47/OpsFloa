// The portfolio views (pnl-summary / WIP / WIP CSV) load every project's money
// with one batched GROUP BY query per source instead of ~14 queries per project.
// Pin batched == per-project on an in-memory fake DB that answers both shapes
// (`= $1` single project, `= ANY($1)` batched) from the same rows.
jest.mock('../db', () => ({ query: jest.fn() }));
// Not batched (still called per project by both paths) — deterministic stubs.
jest.mock('../utils/projectCost', () => ({
  equipmentUsageCents: jest.fn(async id => Number(id) * 1000),
  manualExpensesByStatus: jest.fn(async id => ({
    spent: new Map([['misc', Number(id) * 300]]),
    committed: new Map([['misc', Number(id) * 70]]),
  })),
  materialsCents: jest.fn(async id => ({ spent: Number(id) * 11, committed: Number(id) * 5 })),
  sumMap: m => [...m.values()].reduce((a, b) => a + b, 0),
}));

const pool = require('../db');
const { _internals } = require('../routes/projectReports');
const { loadPortfolioFinancials, contractValueCents, spendTotals, invoiceTotals, budgetTotalCents } = _internals;

const COMPANY = 'co-1';
const db = {
  projects: [
    { id: 1, contract_value_cents: null },
    { id: 2, contract_value_cents: '5000000' },   // explicit contract wins
    { id: 3, contract_value_cents: null },         // no estimate → falls back to budget
    { id: 4, contract_value_cents: null },         // nothing at all
  ],
  estimates: [
    { converted_project_id: 1, status: 'accepted', total_cents: '1000000', responded_at: 1 },
    { converted_project_id: 1, status: 'accepted', total_cents: '1200000', responded_at: 5 }, // latest wins
    { converted_project_id: 1, status: 'declined', total_cents: '9999999', responded_at: 9 },
    { converted_project_id: 2, status: 'accepted', total_cents: '7777777', responded_at: 3 },
  ],
  change_orders: [
    { project_id: 1, status: 'accepted', total_cents: '50000' },
    { project_id: 1, status: 'pending', total_cents: '999' },
    { project_id: 2, status: 'accepted', total_cents: '25000' },
    { project_id: 3, status: 'accepted', total_cents: '12345' }, // ignored: no base contract
  ],
  budget: [
    { project_id: 1, budget_cents: '800000' }, { project_id: 1, budget_cents: '100000' },
    { project_id: 3, budget_cents: '400000' },
  ],
  invoices: [
    { id: 10, project_id: 1, company_id: COMPANY, status: 'sent', total_cents: '300000', rh: 3000, rr: 1000 },
    { id: 11, project_id: 1, company_id: COMPANY, status: 'draft', total_cents: '999999', rh: 0, rr: 0 },
    { id: 12, project_id: 1, company_id: COMPANY, status: 'void', total_cents: '888888', rh: 0, rr: 0 },
    { id: 13, project_id: 2, company_id: COMPANY, status: 'paid', total_cents: '200000', rh: 0, rr: 0 },
    { id: 14, project_id: 2, company_id: 'other', status: 'paid', total_cents: '777', rh: 0, rr: 0 },
  ],
  payments: [
    { invoice_id: 10, amount_cents: '100000' },
    { invoice_id: 11, amount_cents: '5000' },   // draft still counts toward collected (non-void)
    { invoice_id: 12, amount_cents: '7000' },   // void excluded
    { invoice_id: 13, amount_cents: '200000' },
  ],
  labor: [
    // Worker 7 has 45h on project 1 alone → weekly OT inside the project.
    ...['2026-04-06', '2026-04-07', '2026-04-08', '2026-04-09', '2026-04-10'].map(d => (
      { project_id: 1, user_id: 7, work_date: d, start_time: '07:00:00', end_time: '16:00:00', break_minutes: 0, wage_type: 'regular', overtime_hours_override: null, rate: '30', ot_rule: 'weekly', rate_type: 'hourly', worker_type: 'employee', role_id: null, prevailing_rate: null }
    )),
    { project_id: 2, user_id: 7, work_date: '2026-04-11', start_time: '08:00:00', end_time: '12:00:00', break_minutes: 0, wage_type: 'regular', overtime_hours_override: null, rate: '30', ot_rule: 'weekly', rate_type: 'hourly', worker_type: 'employee', role_id: null, prevailing_rate: null },
    { project_id: 2, user_id: 8, work_date: '2026-04-06', start_time: '22:00:00', end_time: '06:00:00', break_minutes: 30, wage_type: 'regular', overtime_hours_override: null, rate: '42.5', ot_rule: 'none', rate_type: 'hourly', worker_type: 'employee', role_id: null, prevailing_rate: null },
  ],
  subPos: [
    { id: 100, project_id: 1, status: 'issued', amount_cents: '500000' },
    { id: 101, project_id: 1, status: 'closed', amount_cents: '100000' },
    { id: 102, project_id: 3, status: 'partial', amount_cents: '60000' },
  ],
  subPayments: [
    { po_id: 100, amount_cents: '200000' },
    { po_id: 101, amount_cents: '100000' },
    { po_id: 102, amount_cents: '10000' },
  ],
};

const sum = (rows, f) => rows.reduce((a, r) => a + Number(f(r)), 0);
const groupRows = (ids, fn) => ids.map(id => ({ id, ...fn(id) })).filter(r => r.keep !== false);

// Answer a query for a set of project ids; `batched` controls row shape.
function fakeQuery(sql, params) {
  const batched = Array.isArray(params[0]);
  const ids = (batched ? params[0] : [params[0]]).map(Number);
  const one = rows => ({ rows, rowCount: rows.length });
  const shape = (rows, key = 'project_id') => (batched ? rows : rows.map(({ [key]: _k, ...r }) => r));

  if (/FROM projects WHERE id/.test(sql)) {
    const rows = db.projects.filter(p => ids.includes(p.id)).map(p => ({ id: p.id, contract_value_cents: p.contract_value_cents }));
    return one(rows);
  }
  if (/FROM estimates/.test(sql)) {
    const rows = [];
    for (const id of ids) {
      const best = db.estimates.filter(e => e.converted_project_id === id && e.status === 'accepted')
        .sort((a, b) => b.responded_at - a.responded_at)[0];
      if (best) rows.push({ project_id: id, total_cents: best.total_cents });
    }
    return one(shape(rows));
  }
  if (/FROM change_orders/.test(sql)) {
    const rows = groupRows(ids, id => {
      const m = db.change_orders.filter(c => c.project_id === id && c.status === 'accepted');
      return { keep: batched ? m.length > 0 : true, sum: String(sum(m, c => c.total_cents)) };
    }).map(({ id, sum: s }) => ({ project_id: id, sum: s }));
    return one(shape(rows));
  }
  if (/FROM project_budget_categories/.test(sql)) {
    const rows = groupRows(ids, id => {
      const m = db.budget.filter(b => b.project_id === id);
      return { keep: batched ? m.length > 0 : true, sum: String(sum(m, b => b.budget_cents)) };
    }).map(({ id, sum: s }) => ({ project_id: id, sum: s }));
    return one(shape(rows));
  }
  if (/FROM time_entries te/.test(sql)) {
    return one(db.labor.filter(r => ids.includes(r.project_id)).map(r => ({ ...r })));
  }
  if (/FROM subcontract_po_payments p/.test(sql) && /JOIN subcontract_pos po/.test(sql)) {
    const rows = groupRows(ids, id => {
      const poIds = db.subPos.filter(po => po.project_id === id).map(po => po.id);
      const m = db.subPayments.filter(p => poIds.includes(p.po_id));
      return { keep: batched ? m.length > 0 : true, cents: String(sum(m, p => p.amount_cents)) };
    }).map(({ id, cents }) => ({ project_id: id, cents }));
    return one(shape(rows));
  }
  if (/FROM subcontract_pos po/.test(sql) && /LATERAL/.test(sql)) {
    const rows = groupRows(ids, id => {
      const m = db.subPos.filter(po => po.project_id === id && ['issued', 'partial'].includes(po.status));
      const open = sum(m, po => Number(po.amount_cents) - sum(db.subPayments.filter(p => p.po_id === po.id), p => p.amount_cents));
      return { keep: batched ? m.length > 0 : true, cents: String(open) };
    }).map(({ id, cents }) => ({ project_id: id, cents }));
    return one(shape(rows));
  }
  if (/FROM invoice_payments p/.test(sql) && batched) {
    const company = params[1];
    const rows = groupRows(ids, id => {
      const inv = db.invoices.filter(i => i.project_id === id && i.company_id === company && i.status !== 'void').map(i => i.id);
      const m = db.payments.filter(p => inv.includes(p.invoice_id));
      return { keep: m.length > 0, collected_cents: String(sum(m, p => p.amount_cents)) };
    }).map(({ id, collected_cents }) => ({ project_id: id, collected_cents }));
    return one(rows);
  }
  if (/FROM invoices i\b/.test(sql)) {
    const company = params[1];
    const rows = groupRows(ids, id => {
      const m = db.invoices.filter(i => i.project_id === id && i.company_id === company && !['void', 'draft'].includes(i.status));
      const row = {
        keep: batched ? m.length > 0 : true,
        billed_cents: String(sum(m, i => i.total_cents)),
        retainage_outstanding_cents: String(sum(m, i => i.rh - i.rr)),
      };
      if (!batched) {
        const inv = db.invoices.filter(i => i.project_id === id && i.company_id === company && i.status !== 'void').map(i => i.id);
        row.collected_cents = String(sum(db.payments.filter(p => inv.includes(p.invoice_id)), p => p.amount_cents));
      }
      return row;
    }).map(({ id, keep: _k, ...r }) => ({ project_id: id, ...r }));
    return one(shape(rows));
  }
  throw new Error('unexpected SQL in fake: ' + sql.slice(0, 80));
}

beforeEach(() => {
  pool.query.mockReset();
  pool.query.mockImplementation(async (sql, params) => fakeQuery(sql, params));
});

describe('loadPortfolioFinancials', () => {
  const settings = { materials_cost_basis: 'issued' };
  const ids = [1, 2, 3, 4];

  test('batched figures equal the per-project helpers for every project', async () => {
    const batched = await loadPortfolioFinancials(ids, COMPANY, settings);
    for (const id of ids) {
      const [contractValue, spend, invoices, budgetTotal] = await Promise.all([
        contractValueCents(id), spendTotals(id, settings), invoiceTotals(id, COMPANY), budgetTotalCents(id),
      ]);
      expect(batched.get(String(id))).toEqual({ contractValue, spend, invoices, budgetTotal });
    }
  });

  test('sanity: the fixture exercises real money (not all zeros)', async () => {
    const b = await loadPortfolioFinancials(ids, COMPANY, settings);
    expect(b.get('1').contractValue).toBe(1200000 + 50000);
    expect(b.get('2').contractValue).toBe(5000000 + 25000);
    expect(b.get('3').contractValue).toBe(400000);
    expect(b.get('4').contractValue).toBe(0);
    expect(b.get('1').spend.by_source.labor).toBeGreaterThan(0);
    expect(b.get('2').spend.by_source.labor).toBeGreaterThan(0);
    expect(b.get('1').invoices).toEqual({ billed_cents: 300000, collected_cents: 105000, retainage_outstanding_cents: 2000 });
    expect(b.get('1').spend.by_source.subs_committed).toBe(300000);
  });

  test('issues a fixed number of queries regardless of project count', async () => {
    await loadPortfolioFinancials(ids, COMPANY, settings);
    expect(pool.query).toHaveBeenCalledTimes(9);
  });

  test('a failing source falls back the same way as the per-project helper', async () => {
    pool.query.mockImplementation(async (sql, params) => {
      if (/FROM invoices i\b/.test(sql) || /FROM time_entries te/.test(sql)) throw new Error('boom');
      return fakeQuery(sql, params);
    });
    const b = await loadPortfolioFinancials(ids, COMPANY, settings);
    for (const id of ids) {
      expect(b.get(String(id)).invoices).toEqual(await invoiceTotals(id, COMPANY));
      expect(b.get(String(id)).spend).toEqual(await spendTotals(id, settings));
    }
  });
});
