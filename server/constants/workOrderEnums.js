/**
 * Fixed-value enums for the `work_orders` table (Work module).
 *
 * Import from here instead of redeclaring the arrays. Keep in sync with the
 * CHECK constraints in migration 0127 and with docs/db-enums.md.
 */

const WORK_ORDER_STATUSES = Object.freeze(['open', 'scheduled', 'in_progress', 'completed', 'canceled']);
const WORK_ORDER_STATUS_DEFAULT = 'open';

const WORK_ORDER_PRIORITIES = Object.freeze(['low', 'normal', 'high', 'urgent']);
const WORK_ORDER_PRIORITY_DEFAULT = 'normal';

module.exports = {
  WORK_ORDER_STATUSES,
  WORK_ORDER_STATUS_DEFAULT,
  WORK_ORDER_PRIORITIES,
  WORK_ORDER_PRIORITY_DEFAULT,
};
