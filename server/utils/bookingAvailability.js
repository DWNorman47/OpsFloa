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

// Extract weekday + minute-of-day from an instant as seen IN A SPECIFIC
// TIMEZONE. Returns { weekday: 0..6, minutes: 0..1439 }. Falls back to
// UTC when timezone is null/invalid so legacy callers keep working.
function localWallClock(instant, timezone) {
  try {
    const tz = timezone || 'UTC';
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    });
    const parts = fmt.formatToParts(instant);
    const wdShort = parts.find(p => p.type === 'weekday')?.value;
    const hour    = parseInt(parts.find(p => p.type === 'hour')?.value, 10);
    const minute  = parseInt(parts.find(p => p.type === 'minute')?.value, 10);
    const wd = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(wdShort);
    // 24h hour part can come back as '24' for midnight in some locales.
    const safeHour = hour === 24 ? 0 : hour;
    return { weekday: wd, minutes: safeHour * 60 + (Number.isFinite(minute) ? minute : 0) };
  } catch {
    return {
      weekday: instant.getUTCDay(),
      minutes: instant.getUTCHours() * 60 + instant.getUTCMinutes(),
    };
  }
}

// Does the slot (start, end) fit entirely inside ANY active bookable
// window the user has for the slot's weekday? Weekday + minute-of-day
// are evaluated in the USER'S timezone — `windows[*].weekday` and
// `start_minutes/end_minutes` are stored as local-wall-clock values
// (admin/user UI presents in their local TZ), so matching them against
// UTC would silently book "Mon 9 PT" → 4 PM UTC Monday slot when it
// shouldn't.
function slotInsideAnyWindow({ slotStart, slotEnd, windows, timezone }) {
  const startLocal = localWallClock(slotStart, timezone);
  const endLocal   = localWallClock(slotEnd, timezone);
  // Slot crossing local midnight: refuse to book across midnight in v1.
  // Also refuse if the slot start and end land on different local
  // weekdays (a 7 PM PT → 4 AM PT next-day case).
  if (startLocal.weekday !== endLocal.weekday) return false;
  if (endLocal.minutes <= startLocal.minutes) return false;
  for (const w of windows) {
    if (!w.active) continue;
    if (w.weekday !== startLocal.weekday) continue;
    if (startLocal.minutes >= w.start_minutes && endLocal.minutes <= w.end_minutes) return true;
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
    slotStart, slotEnd,
    windows: user.bookable_windows || [],
    timezone: user.timezone,
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
