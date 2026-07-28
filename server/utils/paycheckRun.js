/**
 * Paycheck run — turn Paycheck Rules + deductions into a per-worker net for a pay
 * period. Pure logic (no DB); the route feeds it gross from the pay-statement
 * engine and the loaded rulesets/deductions.
 *
 * Assignment is by ROLE. The tie-breaker (David's call): a worker whose role maps
 * to ZERO or MORE THAN ONE ruleset is a SETUP ERROR the admin must fix — never a
 * silent guess.
 *
 * Money here is in DOLLARS (matching the pay statement + server/utils/deductions.js);
 * the ruleset stores cents, so its thresholds are divided by 100 on the way in.
 *
 * NOTE — single-check scope: this computes ONE paycheck's net. A ruleset's
 * combineGroup (sum a pair/month of checks BEFORE the exempt, deduct on one of
 * them) needs generated pay periods and is the next increment; here the exempt is
 * applied to the period's own gross.
 */

const { computeDeductions } = require('./deductions');

const round2 = v => Math.round((Number(v) || 0) * 100) / 100;

/**
 * The single ruleset that applies to `roleId`.
 *   - no rulesets configured at all → { ruleset: null } (no ruleset math; just deductions)
 *   - worker has no role → { error: 'no_role' }
 *   - role matches no ruleset → { error: 'no_ruleset' }
 *   - role matches >1 ruleset → { error: 'multiple_rulesets', matches: [names] }
 *   - exactly one → { ruleset }
 */
function resolveRuleset(rulesets, roleId) {
  const list = Array.isArray(rulesets) ? rulesets : [];
  if (list.length === 0) return { ruleset: null };
  if (roleId == null) return { error: 'no_role' };
  const matches = list.filter(r => Array.isArray(r.roles) && r.roles.includes(roleId));
  if (matches.length === 0) return { error: 'no_ruleset' };
  if (matches.length > 1) return { error: 'multiple_rulesets', matches: matches.map(m => m.name || m.id) };
  return { ruleset: matches[0] };
}

/**
 * Company/role-scoped deductions that apply to a worker of `roleId`. A deduction
 * with empty roleIds is company-wide; otherwise it applies only to its roles.
 * (Per-worker rows stack on top — the caller concatenates them.)
 */
function deductionsForRole(companyDeductions, roleId) {
  return (companyDeductions || []).filter(d => {
    const scope = Array.isArray(d.roleIds) ? d.roleIds : [];
    return scope.length === 0 || (roleId != null && scope.includes(roleId));
  });
}

/**
 * Apply a ruleset's deduction MATH to one paycheck (dollars):
 *   base = max(0, baseGross − exempt) → deductions computed on base → ruleset cap →
 *   min-net floor (deductions never push THIS check's net below minNet).
 * `baseGross` is the amount the exempt+deductions are figured on; it defaults to the
 * check's own gross, but for a combined group it's the group's total (so the exempt
 * is subtracted once across the pair/month). The net is always this check's gross −
 * the computed deductions. A null ruleset means no ruleset math (exempt 0, no cap/floor).
 */
function computeRuleNet(gross, deductions, ruleset, baseGross) {
  const ded = (ruleset && ruleset.deductions) || {};
  const g = Math.max(0, round2(gross));
  const bg = Math.max(0, round2(baseGross == null ? g : baseGross));
  const exempt = Math.max(0, (ded.exemptAmountCents || 0) / 100);
  const base = Math.max(0, round2(bg - exempt));

  const { lines, total } = computeDeductions(base, deductions);
  let dedTotal = total;

  const cap = ded.cap || {};
  if (cap.type === 'amount' && cap.valueCents > 0) dedTotal = Math.min(dedTotal, cap.valueCents / 100);
  else if (cap.type === 'percent' && cap.valuePct > 0) dedTotal = Math.min(dedTotal, round2(base * (cap.valuePct / 100)));

  const minNet = Math.max(0, (ded.minNetCents || 0) / 100);
  if (g - dedTotal < minNet) dedTotal = Math.max(0, round2(g - minNet));

  dedTotal = round2(dedTotal);
  return { gross: g, exempt, base, lines, deductionTotal: dedTotal, net: round2(g - dedTotal) };
}

/**
 * Compute net for a worker's checks over a set of GROUPED periods (each carries
 * `gross`, `groupKey`, `deductionsApply`). Deductions land only on the flagged check
 * of each group, figured on the group's COMBINED gross minus the exempt (David's
 * "combine the two checks, subtract 11,000, deduct from that"). Other checks in the
 * group net to their own gross. Returns the periods with { deductionTotal, net, base }.
 */
function applyGroupDeductions(periods, deductions, ruleset) {
  const combined = {};
  for (const p of periods) combined[p.groupKey] = round2((combined[p.groupKey] || 0) + (p.gross || 0));
  return periods.map(p => {
    if (p.deductionsApply) {
      const c = computeRuleNet(p.gross || 0, deductions, ruleset, combined[p.groupKey]);
      return { ...p, deductionTotal: c.deductionTotal, net: c.net, base: c.base };
    }
    return { ...p, deductionTotal: 0, net: round2(p.gross || 0), base: 0 };
  });
}

module.exports = { resolveRuleset, deductionsForRole, computeRuleNet, applyGroupDeductions };
