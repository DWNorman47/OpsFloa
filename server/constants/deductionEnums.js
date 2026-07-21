/**
 * Fixed-value enums for payroll deductions (pay-stub gross → net).
 * See `docs/db-enums.md` for the full registry.
 *
 * `kind` = how the deduction amount is figured:
 *   'percent' — a percentage of the period's gross wages (optionally capped);
 *   'fixed'   — a flat currency amount per pay period.
 *
 * Used by both the company-wide list (the `deductions` settings JSON) and the
 * per-worker `worker_deductions` table, so they share one vocabulary.
 */

const DEDUCTION_KINDS = Object.freeze(['percent', 'fixed']);
const DEDUCTION_KIND_DEFAULT = 'percent';

module.exports = {
  DEDUCTION_KINDS,
  DEDUCTION_KIND_DEFAULT,
};
