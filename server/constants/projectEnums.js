/**
 * Fixed-value enums for the `projects` table.
 *
 * Anyone validating, defaulting, or rendering one of these columns
 * should import from here instead of redeclaring the array. Keep this
 * file in sync with the CHECK constraints in migrations and with
 * `docs/db-enums.md`.
 */

const PROJECT_STATUSES = Object.freeze(['planning', 'in_progress', 'on_hold', 'completed']);
const PROJECT_STATUS_DEFAULT = 'in_progress';

const PROJECT_WAGE_TYPES = Object.freeze(['regular', 'prevailing']);
const PROJECT_WAGE_TYPE_DEFAULT = 'regular';

// Per-project worker hour-limit enforcement mode (see projects.hour_limit_mode).
//   off  — no limit (default)
//   warn — soft: worker/admin are warned when the daily/weekly limit is crossed,
//          nothing is blocked or auto-stopped
//   hard — the shift is stopped (or switched to the overflow project) at the exact
//          instant the limit is reached; a fresh clock-in past the limit is blocked
const HOUR_LIMIT_MODES = Object.freeze(['off', 'warn', 'hard']);
const HOUR_LIMIT_MODE_DEFAULT = 'off';

module.exports = {
  PROJECT_STATUSES,
  PROJECT_STATUS_DEFAULT,
  PROJECT_WAGE_TYPES,
  PROJECT_WAGE_TYPE_DEFAULT,
  HOUR_LIMIT_MODES,
  HOUR_LIMIT_MODE_DEFAULT,
};
