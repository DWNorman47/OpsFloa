// Pure-function booking availability algorithm. Separated from the
// route layer so it can be unit-tested with hand-built fixtures
// instead of requiring a real DB.
//
// The route layer's responsibility is to load the inputs (candidates,
// shifts, time-off, existing appointments) and pass them in; this
// module decides who is bookable and picks the round-robin winner.

const { rangesOverlap, APPOINTMENT_BLOCKING_STATUSES } = require('../constants/bookingEnums');

// ── Slot construction ───────────────────────────────────────────────────────

// Returns an array of candidate slot start instants (Date objects)
// stepping at `slot_interval_min` from (now + advance_notice_hrs) to
// (now + max_advance_days). All times in UTC; the caller is
// responsible for converting to the assignee's display TZ later.
function buildCandidateSlots({ now = new Date(), appointmentType }) {
  const startMs = now.getTime() + appointmentType.advance_notice_hrs * 3_600_000;
  const endMs   = now.getTime() + appointmentType.max_advance_days * 86_400_000;
  const stepMs  = appointmentType.slot_interval_min * 60_000;
  const out = [];
  // Snap to the next interval boundary at-or-after startMs.
  const first = startMs + (stepMs - (startMs % stepMs)) % stepMs;
  for (let t = first; t <= endMs; t += stepMs) {
    out.push(new Date(t));
  }
  return out;
}

// ── Per-user filter ─────────────────────────────────────────────────────────

// Does the slot (start, end) fit entirely inside ANY active bookable
// window the user has for the slot's weekday? Slot weekday is computed
// from the slot's start instant in UTC; callers wanting TZ-correct
// matching should pass times that have already been TZ-adjusted.
function slotInsideAnyWindow({ slotStart, slotEnd, windows }) {
  const wd = slotStart.getUTCDay();
  const startMinutes = slotStart.getUTCHours() * 60 + slotStart.getUTCMinutes();
  const endMinutes   = slotEnd.getUTCHours()   * 60 + slotEnd.getUTCMinutes();
  // Slot crossing midnight: the end_minutes < start_minutes case. We
  // refuse to book across midnight in v1; the slot interval is 15+ min
  // so the chance of needing this is low.
  if (endMinutes <= startMinutes) return false;
  for (const w of windows) {
    if (!w.active) continue;
    if (w.weekday !== wd) continue;
    const ws = w.start_minutes;
    const we = w.end_minutes;
    if (startMinutes >= ws && endMinutes <= we) return true;
  }
  return false;
}

// Is any of the user's overlapping shifts incompatible with the
// appointment type? An "untyped" shift (shift_type_id null) blocks
// when booking_untyped_shifts_block is true.
function shiftBlocks({ slotStart, slotEnd, shifts, allowedShiftTypeIds, untypedBlocks }) {
  for (const shift of shifts) {
    if (!rangesOverlap(slotStart, slotEnd, shift.start, shift.end)) continue;
    if (shift.shift_type_id == null) {
      if (untypedBlocks) return true;
      continue;
    }
    if (!allowedShiftTypeIds.includes(shift.shift_type_id)) return true;
  }
  return false;
}

function timeOffBlocks({ slotStart, slotEnd, timeOff }) {
  for (const t of timeOff) {
    if (rangesOverlap(slotStart, slotEnd, t.start, t.end)) return true;
  }
  return false;
}

function existingAppointmentBlocks({ slotStart, slotEnd, appointments, bufferBeforeMin, bufferAfterMin }) {
  const bufBefore = bufferBeforeMin * 60_000;
  const bufAfter  = bufferAfterMin  * 60_000;
  for (const a of appointments) {
    if (!APPOINTMENT_BLOCKING_STATUSES.includes(a.status)) continue;
    // Expand the existing appointment by buffers on both sides.
    const aStart = new Date(a.start.getTime() - bufBefore);
    const aEnd   = new Date(a.end.getTime()   + bufAfter);
    if (rangesOverlap(slotStart, slotEnd, aStart, aEnd)) return true;
  }
  return false;
}

// Decide whether one user can take a particular slot. All blocking
// rules are evaluated independently; if any fires, the user can't
// take the slot.
function userCanTakeSlot({ slotStart, slotEnd, user, settings }) {
  if (!user.bookable) return false;
  if (!slotInsideAnyWindow({
    slotStart, slotEnd, windows: user.bookable_windows || [],
  })) return false;
  if (shiftBlocks({
    slotStart, slotEnd,
    shifts: user.shifts || [],
    allowedShiftTypeIds: settings.allowed_shift_type_ids,
    untypedBlocks: settings.booking_untyped_shifts_block,
  })) return false;
  if (timeOffBlocks({
    slotStart, slotEnd, timeOff: user.time_off || [],
  })) return false;
  if (existingAppointmentBlocks({
    slotStart, slotEnd,
    appointments: user.appointments || [],
    bufferBeforeMin: settings.buffer_before_min,
    bufferAfterMin: settings.buffer_after_min,
  })) return false;
  return true;
}

// ── Slot availability across the pool ────────────────────────────────────────

// Given a slot + a pool of users (each carrying their windows / shifts /
// time-off / appointments) + the appointment type settings, returns the
// list of users (objects) who can take this slot.
function candidatesForSlot({ slotStart, durationMinutes, users, appointmentType, allowedShiftTypeIds, untypedBlocks }) {
  const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60_000);
  const settings = {
    buffer_before_min:             appointmentType.buffer_before_min,
    buffer_after_min:              appointmentType.buffer_after_min,
    allowed_shift_type_ids:        allowedShiftTypeIds,
    booking_untyped_shifts_block:  untypedBlocks,
  };
  return users.filter(u => userCanTakeSlot({ slotStart, slotEnd, user: u, settings }));
}

// ── Round-robin assignment ─────────────────────────────────────────────────

// Pick the candidate with the longest gap since their last completed
// appointment. NULLS FIRST — a user who has never been booked goes to
// the front. Alphabetical tiebreaker (full_name ASC) for determinism.
//
// Counter is provided as `lastCompletedAt` on each user (Date or null).
// Caller is responsible for loading this once per booking request.
function pickRoundRobinWinner(candidates) {
  if (!candidates || candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    const aNever = a.lastCompletedAt == null;
    const bNever = b.lastCompletedAt == null;
    // NULLS FIRST: never-booked users come ahead of ever-booked users.
    if (aNever && !bNever) return -1;
    if (!aNever && bNever) return 1;
    if (!aNever && !bNever) {
      const dt = a.lastCompletedAt.getTime() - b.lastCompletedAt.getTime();
      if (dt !== 0) return dt;
    }
    // Alphabetical tiebreaker.
    return (a.full_name || '').localeCompare(b.full_name || '');
  })[0];
}

module.exports = {
  buildCandidateSlots,
  slotInsideAnyWindow,
  shiftBlocks,
  timeOffBlocks,
  existingAppointmentBlocks,
  userCanTakeSlot,
  candidatesForSlot,
  pickRoundRobinWinner,
};
