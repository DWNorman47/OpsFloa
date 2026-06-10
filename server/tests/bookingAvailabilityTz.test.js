// Targeted tests for the TZ-aware window matching fix (H3).
//
// Before the fix, slotInsideAnyWindow used getUTCDay/getUTCHours, so a
// user setting "Mon 9-5" in Pacific TZ would match against 9-5 UTC slots
// — a 4 PM UTC Monday slot (= 8 AM PT) would silently become bookable.
// After the fix, the matcher converts the slot instant into the user's
// `timezone` before extracting weekday + minutes.

const { slotInsideAnyWindow } = require('../utils/bookingAvailability');

function utc(dateStr, timeStr) {
  return new Date(`${dateStr}T${timeStr}Z`);
}

describe('slotInsideAnyWindow — TZ awareness', () => {
  // Monday 2026-06-08 (UTC weekday 1).
  // In Pacific time (UTC-7 in summer), the slot 16:00-17:00 UTC is
  // 09:00-10:00 PT. A Pacific user's "Mon 9-5" window should ACCEPT
  // this slot — and was already accepting it pre-fix because the UTC
  // weekday happens to also be Monday.
  test('Pacific user with Mon 9-5 window accepts 9-10 AM PT (16-17 UTC)', () => {
    expect(slotInsideAnyWindow({
      slotStart: utc('2026-06-08', '16:00:00'),
      slotEnd:   utc('2026-06-08', '17:00:00'),
      windows:   [{ weekday: 1, start_minutes: 9 * 60, end_minutes: 17 * 60, active: true }],
      timezone:  'America/Los_Angeles',
    })).toBe(true);
  });

  // The flipped case: Pacific user's window is Mon 9-5 (local). The slot
  // 23:00-23:30 UTC Sun is 16:00-16:30 PT Sun. Pre-fix this matched
  // weekday=0 (Sun UTC) — but the user's window is weekday=1 (Mon local),
  // so it correctly DOESN'T match. Same result either way.
  test('Pacific user with Mon 9-5 window rejects 4 PM PT Sunday slot', () => {
    expect(slotInsideAnyWindow({
      slotStart: utc('2026-06-07', '23:00:00'),  // Sun 23 UTC = Sun 16 PT
      slotEnd:   utc('2026-06-07', '23:30:00'),
      windows:   [{ weekday: 1, start_minutes: 9 * 60, end_minutes: 17 * 60, active: true }],
      timezone:  'America/Los_Angeles',
    })).toBe(false);
  });

  // The bug-trigger case: a slot at 04:00-04:30 UTC Monday. In UTC
  // weekday=1, 4 AM. In Pacific time it's Sunday 9 PM. Pre-fix matched
  // a Mon 9-5 window because UTC weekday was Mon and 4 < 9. Post-fix
  // converts to PT first, sees Sun 9 PM, NOT in the Mon 9-5 window.
  test('Pacific user — 4 AM UTC Monday is actually 9 PM Sunday PT, REJECTED', () => {
    expect(slotInsideAnyWindow({
      slotStart: utc('2026-06-08', '04:00:00'),
      slotEnd:   utc('2026-06-08', '04:30:00'),
      windows:   [{ weekday: 1, start_minutes: 9 * 60, end_minutes: 17 * 60, active: true }],
      timezone:  'America/Los_Angeles',
    })).toBe(false);
  });

  // Symmetric: Eastern user with same Mon 9-5 window. Slot 16:00 UTC
  // Monday is 12:00 noon ET, well inside Mon 9-5.
  test('Eastern user — noon ET Monday accepted', () => {
    expect(slotInsideAnyWindow({
      slotStart: utc('2026-06-08', '16:00:00'),
      slotEnd:   utc('2026-06-08', '17:00:00'),
      windows:   [{ weekday: 1, start_minutes: 9 * 60, end_minutes: 17 * 60, active: true }],
      timezone:  'America/New_York',
    })).toBe(true);
  });

  // The Pacific user at slot 03:00-04:00 UTC Tuesday: that's Mon 8-9 PM
  // PT. Not in Mon 9-5.
  test('Pacific user — 8 PM PT Monday rejected (slot 03 UTC Tue → Mon 20 PT)', () => {
    expect(slotInsideAnyWindow({
      slotStart: utc('2026-06-09', '03:00:00'),
      slotEnd:   utc('2026-06-09', '04:00:00'),
      windows:   [{ weekday: 1, start_minutes: 9 * 60, end_minutes: 17 * 60, active: true }],
      timezone:  'America/Los_Angeles',
    })).toBe(false);
  });

  // No timezone supplied → falls back to UTC (backward-compat).
  test('null timezone falls back to UTC matching', () => {
    expect(slotInsideAnyWindow({
      slotStart: utc('2026-06-08', '14:00:00'),
      slotEnd:   utc('2026-06-08', '14:30:00'),
      windows:   [{ weekday: 1, start_minutes: 9 * 60, end_minutes: 17 * 60, active: true }],
      timezone:  null,
    })).toBe(true);
  });

  // Cross-midnight in user's local TZ is rejected.
  test('rejects slot that crosses midnight in user TZ', () => {
    // 06:00 UTC = 11 PM PT prior-day; 07:00 UTC = midnight PT.
    // Slot crosses midnight in PT.
    expect(slotInsideAnyWindow({
      slotStart: utc('2026-06-08', '06:30:00'),
      slotEnd:   utc('2026-06-08', '07:30:00'),
      windows:   [{ weekday: 0, start_minutes: 0, end_minutes: 24 * 60, active: true }],
      timezone:  'America/Los_Angeles',
    })).toBe(false);
  });
});
