/**
 * Fixed-value enums for the equipment tracking feature (Inventory → Equipment).
 * See `docs/db-enums.md` for the full registry.
 *
 * status: lifecycle of an asset. `available` ⇄ `checked_out` is driven by
 * custody rows (equipment_checkouts); `maintenance` by service records;
 * `retired` is a terminal state (distinct from the `active=false` soft-delete).
 */

const EQUIPMENT_STATUSES = Object.freeze(['available', 'checked_out', 'maintenance', 'retired']);
const EQUIPMENT_STATUS_DEFAULT = 'available';

// Nullable category on an asset (heavy machinery, vehicle, hand tool, …).
const EQUIPMENT_KINDS = Object.freeze(['heavy', 'vehicle', 'trailer', 'power_tool', 'hand_tool', 'safety', 'other']);

// equipment_maintenance_logs.kind
const EQUIPMENT_MAINTENANCE_KINDS = Object.freeze(['service', 'repair', 'inspection', 'other']);
const EQUIPMENT_MAINTENANCE_KIND_DEFAULT = 'service';

// equipment_items.rental_rate_unit
const RENTAL_RATE_UNITS = Object.freeze(['day', 'week', 'month']);

module.exports = {
  EQUIPMENT_STATUSES,
  EQUIPMENT_STATUS_DEFAULT,
  EQUIPMENT_KINDS,
  EQUIPMENT_MAINTENANCE_KINDS,
  EQUIPMENT_MAINTENANCE_KIND_DEFAULT,
  RENTAL_RATE_UNITS,
};
