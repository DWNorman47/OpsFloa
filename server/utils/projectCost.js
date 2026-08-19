// Shared project-cost helpers so the spend snapshot (routes/projectSpend.js)
// and the P&L / WIP rollup (routes/projectReports.js) read costs identically.
// Both used to inline their own copies; two money numbers that must agree
// belong to one function.

const pool = require('../db');

// Has a table been created in this DB? Short-circuits reads against modules
// whose migrations haven't run yet on a given environment.
async function tableExists(name) {
  try {
    const r = await pool.query(
      'SELECT 1 FROM information_schema.tables WHERE table_name = $1 LIMIT 1',
      [name]
    );
    return r.rowCount > 0;
  } catch {
    return false;
  }
}

// Actual equipment usage cost for a project, from the hours log × each machine's
// operating rate. Hourly rates multiply logged hours; day/week/month rates use
// DISTINCT log-dates as days-used (each logged day = a day of use), converting
// weeks≈days/7 and months≈days/30. Returns integer cents. 0 on environments
// where 0179 hasn't added operating_rate.
async function equipmentUsageCents(projectId) {
  if (!(await tableExists('equipment_hours'))) return 0;
  try {
    const r = await pool.query(
      `SELECT e.operating_unit AS unit,
              e.operating_rate::numeric AS rate,
              COALESCE(SUM(h.hours), 0)::numeric AS hours,
              COUNT(DISTINCT h.log_date)::int AS days
         FROM equipment_hours h
         JOIN equipment_items e ON e.id = h.equipment_id
        WHERE h.project_id = $1 AND e.operating_rate IS NOT NULL
        GROUP BY e.id, e.operating_unit, e.operating_rate`,
      [projectId]
    );
    let dollars = 0;
    for (const row of r.rows) {
      const rate = parseFloat(row.rate) || 0;
      const hours = parseFloat(row.hours) || 0;
      const days = parseInt(row.days, 10) || 0;
      switch (row.unit) {
        case 'day':   dollars += days * rate; break;
        case 'week':  dollars += (days / 7) * rate; break;
        case 'month': dollars += (days / 30) * rate; break;
        case 'hour':
        default:      dollars += hours * rate; break;  // null unit → hourly
      }
    }
    const cents = Math.round(dollars * 100);
    return Number.isFinite(cents) ? cents : 0;
  } catch {
    return 0;  // operating_rate column absent (pre-0179)
  }
}

// Manual project_expenses split by lifecycle status → per-category cents Maps.
// `planned` rows are a forecast (COMMITTED bucket); everything else is SPENT.
// Returns { spent: Map<category,cents>, committed: Map<category,cents> }.
async function manualExpensesByStatus(projectId) {
  const spent = new Map();
  const committed = new Map();
  try {
    const r = await pool.query(
      `SELECT category, COALESCE(status, 'actual') AS status,
              COALESCE(SUM(amount_cents + tax_cents), 0)::bigint AS cents
         FROM project_expenses
        WHERE project_id = $1
        GROUP BY category, COALESCE(status, 'actual')`,
      [projectId]
    );
    for (const row of r.rows) {
      const target = row.status === 'planned' ? committed : spent;
      target.set(row.category, (target.get(row.category) || 0) + parseInt(row.cents, 10));
    }
  } catch {
    // `status` column absent (pre-0180) — fall back to all-actual so the
    // rollup still returns sensible spent numbers.
    try {
      const r = await pool.query(
        `SELECT category, COALESCE(SUM(amount_cents + tax_cents), 0)::bigint AS cents
           FROM project_expenses WHERE project_id = $1 GROUP BY category`,
        [projectId]
      );
      for (const row of r.rows) spent.set(row.category, parseInt(row.cents, 10));
    } catch { /* table truly absent */ }
  }
  return { spent, committed };
}

// Materials cost for a project, split spent vs committed. Returns integer cents.
//   committed — unreceived value of OPEN project POs (both bases)
//   spent     — depends on the company's materials_cost_basis:
//               'issued'   (default): inventory ISSUED to the project
//               'received'         : value RECEIVED on the project's POs
// One basis at a time, so a company never double-counts. Each source is guarded
// so a partial/absent schema contributes 0.
async function materialsCents(projectId, basis = 'issued') {
  let spent = 0;
  let committed = 0;
  const dollarsToCents = d => { const c = Math.round(parseFloat(d) * 100); return Number.isFinite(c) ? c : 0; };

  const hasPOs = await tableExists('purchase_orders');
  if (hasPOs) {
    try {
      const r = await pool.query(
        `SELECT COALESCE(SUM((pol.qty_ordered - pol.qty_received) * pol.unit_cost), 0)::numeric AS dollars
           FROM purchase_order_lines pol
           JOIN purchase_orders po ON po.id = pol.po_id
          WHERE po.project_id = $1
            AND po.status IN ('submitted', 'partial')
            AND pol.unit_cost IS NOT NULL`,
        [projectId]
      );
      committed = Math.max(0, dollarsToCents(r.rows[0].dollars));
    } catch { /* project_id column absent (pre-0181) */ }
  }

  if (basis === 'received') {
    // Cost = material received against the job's POs (buy-to-jobsite flow).
    if (hasPOs) {
      try {
        const r = await pool.query(
          `SELECT COALESCE(SUM(pol.qty_received * pol.unit_cost), 0)::numeric AS dollars
             FROM purchase_order_lines pol
             JOIN purchase_orders po ON po.id = pol.po_id
            WHERE po.project_id = $1 AND pol.unit_cost IS NOT NULL`,
          [projectId]
        );
        spent = dollarsToCents(r.rows[0].dollars);
      } catch { /* project_id column absent (pre-0181) */ }
    }
  } else {
    // Default 'issued': cost = inventory issued to the project (warehouse flow).
    if (await tableExists('inventory_transactions')) {
      try {
        const r = await pool.query(
          `SELECT COALESCE(SUM(quantity * unit_cost), 0)::numeric AS dollars
             FROM inventory_transactions
            WHERE project_id = $1 AND type = 'issue' AND unit_cost IS NOT NULL`,
          [projectId]
        );
        spent = dollarsToCents(r.rows[0].dollars);
      } catch { /* shape differs */ }
    }
  }
  return { spent, committed };
}

// Is the project's close-out frozen (final_complete / closed)? Cost mutations
// on a frozen job would silently drift its locked final number, so callers
// block them. Returns false if closeout tables/columns aren't present.
async function projectFrozen(projectId) {
  try {
    const r = await pool.query(
      `SELECT 1 FROM project_closeouts
        WHERE project_id = $1 AND status IN ('final_complete', 'closed') LIMIT 1`,
      [projectId]
    );
    return r.rowCount > 0;
  } catch { return false; }
}

function sumMap(map) {
  let total = 0;
  for (const v of map.values()) total += v;
  return total;
}

module.exports = { tableExists, equipmentUsageCents, manualExpensesByStatus, materialsCents, projectFrozen, sumMap };
