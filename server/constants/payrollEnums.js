/**
 * Fixed-value columns for a FINALIZED payroll run (a snapshot the admin locks so it
 * stops recomputing live) and its per-check records. See docs/db-enums.md and
 * migration 0156. Enforced by CHECK constraints at the DB level.
 */
const PAYROLL_RUN_STATUSES = ['finalized', 'void'];
const PAYROLL_CHECK_STATUSES = ['pending', 'paid'];

module.exports = { PAYROLL_RUN_STATUSES, PAYROLL_CHECK_STATUSES };
