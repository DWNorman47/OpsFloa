// Booking module enums + pure helper functions. Lockstep with
// migration 0113. See `docs/db-enums.md`.

const APPOINTMENT_STATUSES = Object.freeze([
  'booked', 'confirmed', 'completed', 'cancelled', 'no_show', 'rescheduled',
]);

// Statuses that occupy a slot — they prevent another appointment from
// being booked over them. Cancelled / no_show / rescheduled don't block
// because the time is genuinely free again.
const APPOINTMENT_BLOCKING_STATUSES = Object.freeze(['booked', 'confirmed']);

const APPOINTMENT_LOCATION_KINDS = Object.freeze([
  'phone', 'video', 'onsite', 'office', 'other',
]);

const APPOINTMENT_CANCEL_ACTORS = Object.freeze([
  'client', 'admin', 'assignee',
]);

const APPOINTMENT_AUDIT_ACTIONS = Object.freeze([
  'booked', 'confirmed', 'cancelled', 'rescheduled', 'completed', 'no_show',
]);

const APPOINTMENT_AUDIT_ACTOR_KINDS = Object.freeze([
  'client', 'admin', 'assignee', 'system',
]);

// Slugify a free-text appointment-type name to a URL-safe slug. Used
// by the auto-slug path on create.
function slugify(name) {
  return (name || '')
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// Return true iff two time ranges overlap. Ranges are inclusive of start,
// exclusive of end. Values can be Date objects or epoch-ms numbers.
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  const as = aStart instanceof Date ? aStart.getTime() : aStart;
  const ae = aEnd   instanceof Date ? aEnd.getTime()   : aEnd;
  const bs = bStart instanceof Date ? bStart.getTime() : bStart;
  const be = bEnd   instanceof Date ? bEnd.getTime()   : bEnd;
  return as < be && bs < ae;
}

module.exports = {
  APPOINTMENT_STATUSES,
  APPOINTMENT_BLOCKING_STATUSES,
  APPOINTMENT_LOCATION_KINDS,
  APPOINTMENT_CANCEL_ACTORS,
  APPOINTMENT_AUDIT_ACTIONS,
  APPOINTMENT_AUDIT_ACTOR_KINDS,
  slugify,
  rangesOverlap,
};
