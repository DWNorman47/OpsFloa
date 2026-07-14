/**
 * Fixed-value enums for the `haul_tickets` table (production/haul log).
 * See `docs/db-enums.md` for the full registry.
 *
 * `unit`      = how the load is measured. CY (bank/loose cubic yards), tons
 *               (scale ticket weight), or loads (whole truckloads).
 * `direction` = export (haul-off leaving the site) vs import (material brought
 *               in). Lets reconciliation net export against import correctly.
 */

const HAUL_UNITS = Object.freeze(['CY', 'tons', 'loads']);
const HAUL_UNIT_DEFAULT = 'CY';

const HAUL_DIRECTIONS = Object.freeze(['export', 'import']);
const HAUL_DIRECTION_DEFAULT = 'export';

module.exports = {
  HAUL_UNITS,
  HAUL_UNIT_DEFAULT,
  HAUL_DIRECTIONS,
  HAUL_DIRECTION_DEFAULT,
};
