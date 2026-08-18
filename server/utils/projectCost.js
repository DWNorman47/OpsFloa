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

// Actual equipment usage cost for a project: logged hours × the machine's
// HOURLY operating rate. Only hourly operating rates are costed — the hours
// log records hours, so an hourly rate multiplies cleanly (no assumed
// hours-per-day). Returns integer cents. 0 on environments where 0179 hasn't
// added operating_rate.
async function equipmentUsageCents(projectId) {
  if (!(await tableExists('equipment_hours'))) return 0;
  try {
    const r = await pool.query(
      `SELECT COALESCE(SUM(h.hours * e.operating_rate), 0)::numeric AS dollars
         FROM equipment_hours h
         JOIN equipment_items e ON e.id = h.equipment_id
        WHERE h.project_id = $1
          AND e.operating_rate IS NOT NULL
          AND e.operating_unit = 'hour'`,
      [projectId]
    );
    const cents = Math.round(parseFloat(r.rows[0].dollars) * 100);
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

function sumMap(map) {
  let total = 0;
  for (const v of map.values()) total += v;
  return total;
}

module.exports = { tableExists, equipmentUsageCents, manualExpensesByStatus, sumMap };
