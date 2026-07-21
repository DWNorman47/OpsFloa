/**
 * Payroll deductions for the per-worker pay stub (gross wages → net pay).
 *
 * Two sources, applied in order:
 *   1. the company-wide list — a JSON document in the `deductions` settings key,
 *      `{ items: [{ id, name, kind, value, cap }] }`, applied to every worker;
 *   2. per-worker rows in the `worker_deductions` table (loans, advances,
 *      garnishments, a worker-specific line), applied on top.
 *
 * Each deduction is either a `percent` of the period's gross WAGES (labor only —
 * reimbursements are expense repayments, not taxable wages, so they are added
 * back to net rather than deducted from) or a `fixed` currency amount per period.
 * A `percent` deduction may carry a `cap` (max amount per period, e.g. a social-
 * security ceiling).
 *
 * This does NOT compute real bracketed income tax or statutory ceilings — that is
 * a jurisdiction-specific payroll-processor job. It applies the rates an admin
 * configures, which their accountant reconciles. Empty config → no deductions, so
 * the stub is exactly the gross figure it was before this feature.
 */

const { DEDUCTION_KINDS } = require('../constants/deductionEnums');

/** Normalize one raw deduction (from JSON or a DB row) or null to drop it. */
function normalizeDeduction(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = DEDUCTION_KINDS.includes(raw.kind) ? raw.kind : null;
  const name = String(raw.name == null ? '' : raw.name).trim();
  const value = Number(raw.value);
  if (!kind || !name || !Number.isFinite(value) || value < 0) return null;
  const capRaw = raw.cap != null ? raw.cap : raw.cap_amount; // JSON uses `cap`, DB row uses `cap_amount`
  const cap = Number(capRaw);
  return {
    id: raw.id != null ? String(raw.id) : '',
    name: name.slice(0, 120),
    kind,
    value,
    cap: Number.isFinite(cap) && cap > 0 ? cap : null,
  };
}

/** The company-wide deduction list from the raw `deductions` settings value. */
function parseCompanyDeductions(raw) {
  if (!raw) return [];
  let obj;
  try { obj = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return []; }
  const items = Array.isArray(obj) ? obj : (obj && Array.isArray(obj.items) ? obj.items : []);
  return items.map(normalizeDeduction).filter(Boolean);
}

/** Per-worker DB rows → the same normalized shape (only the active ones). */
function normalizeWorkerDeductions(rows) {
  return (rows || [])
    .filter(r => r && r.active !== false)
    .map(r => normalizeDeduction({ id: `w${r.id}`, name: r.name, kind: r.kind, value: r.value, cap_amount: r.cap_amount }))
    .filter(Boolean);
}

/**
 * Compute deduction line items and their total for a gross-wage base.
 *
 * @param grossWages  the period's gross wage pay (labor only, not reimbursements)
 * @param deductions  normalized deduction list (company ++ per-worker)
 * @returns {{ lines: Array<{id,name,kind,value,amount}>, total:number }}
 *          amounts and total are rounded to cents.
 */
function computeDeductions(grossWages, deductions) {
  const gross = Number(grossWages) || 0;
  const lines = [];
  let totalCents = 0;
  for (const d of deductions || []) {
    let amount = d.kind === 'percent' ? gross * (d.value / 100) : d.value;
    if (d.kind === 'percent' && d.cap != null) amount = Math.min(amount, d.cap);
    const cents = Math.round((Number(amount) || 0) * 100);
    lines.push({ id: d.id, name: d.name, kind: d.kind, value: d.value, amount: cents / 100 });
    totalCents += cents;
  }
  return { lines, total: totalCents / 100 };
}

/**
 * The whole picture for a stub: gross wages in, deduction lines + net out.
 * Reimbursements are added back to net (they are not wages). Net can't be
 * computed below the reimbursement floor here — that's a payroll policy question,
 * so we simply report gross − deductions + reimbursements as-is.
 */
function payStubTotals(grossWages, reimbursements, deductions) {
  const gross = Math.round((Number(grossWages) || 0) * 100) / 100;
  const reimb = Math.round((Number(reimbursements) || 0) * 100) / 100;
  const { lines, total } = computeDeductions(gross, deductions);
  const net = Math.round((gross - total + reimb) * 100) / 100;
  return { gross_wages: gross, deductions: lines, deductions_total: total, reimbursement_total: reimb, net_pay: net };
}

module.exports = {
  normalizeDeduction,
  parseCompanyDeductions,
  normalizeWorkerDeductions,
  computeDeductions,
  payStubTotals,
};
