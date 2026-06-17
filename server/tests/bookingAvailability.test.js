// Tests for the pure availability algorithm. Hand-built fixtures
// rather than DB-driven so each rule (windows / shifts / time-off /
// existing appts / round-robin) can be exercised in isolation.

const {
  buildCandidateSlots,
  slotInsideAnyWindow,
  shiftBlocks,
  timeOffBlocks,
  existingAppointmentBlocks,
  userCanTakeSlot,
  candidatesForSlot,
  pickRoundRobinWinner,
} = require('../utils/bookingAvailability');

// Helper to build a Date at a specific UTC time on a specific date.
function utc(dateStr, timeStr) {
  return new Date(`${dateStr}T${timeStr}Z`);
}

// ── Slot construction ─────────────────────────────────────────────────────────

describe('buildCandidateSlots', () => {
  const APT_TYPE = {
    advance_notice_hrs: 24,
    max_advance_days: 7,
    slot_interval_min: 60,
  };

  test('first slot is at-or-after now+advance_notice', () => {
    const now = utc('2026-06-09', '10:00:00');
    const slots = buildCandidateSlots({ now, appointmentType: APT_TYPE });
    expect(slots[0].getTime()).toBeGreaterThanOrEqual(now.getTime() + 24 * 3600 * 1000);
  });

  test('all slots are within max_advance_days', () => {
    const now = utc('2026-06-09', '10:00:00');
    const max = now.getTime() + 7 * 86400 * 1000;
    const slots = buildCandidateSlots({ now, appointmentType: APT_TYPE });
    for (const s of slots) {
      expect(s.getTime()).toBeLessThanOrEqual(max);
    }
  });

  test('slots are stepped at the slot interval', () => {
    const now = utc('2026-06-09', '10:00:00');
    const slots = buildCandidateSlots({ now, appointmentType: APT_TYPE });
    for (let i = 1; i < slots.length; i++) {
      const diff = slots[i].getTime() - slots[i - 1].getTime();
      expect(diff).toBe(60 * 60 * 1000);
    }
  });

  test('first slot snaps to the next interval boundary', () => {
    const now = utc('2026-06-09', '10:13:00');
    const slots = buildCandidateSlots({
      now,
      appointmentType: { advance_notice_hrs: 0, max_advance_days: 1, slot_interval_min: 30 },
    });
    // First slot should be 10:30 (not 10:13)
    expect(slots[0].getUTCMinutes()).toBe(30);
  });
});

// ── Window matching ─────────────────────────────────────────────────────────

describe('slotInsideAnyWindow', () => {
  // Monday 2026-06-08, weekday = 1
  const slotStart = utc('2026-06-08', '14:00:00');
  const slotEnd   = utc('2026-06-08', '14:30:00');

  test('slot inside a matching weekday window → true', () => {
    expect(slotInsideAnyWindow({
      slotStart, slotEnd,
      windows: [{ weekday: 1, start_minutes: 9 * 60, end_minutes: 17 * 60, active: true }],
    })).toBe(true);
  });

  test('slot before window opens → false', () => {
    expect(slotInsideAnyWindow({
      slotStart, slotEnd,
      windows: [{ weekday: 1, start_minutes: 15 * 60, end_minutes: 17 * 60, active: true }],
    })).toBe(false);
  });

  test('slot extending past window close → false', () => {
    expect(slotInsideAnyWindow({
      slotStart, slotEnd,
      windows: [{ weekday: 1, start_minutes: 9 * 60, end_minutes: 14 * 60 + 15, active: true }],
    })).toBe(false);
  });

  test('window on a DIFFERENT weekday is ignored', () => {
    // Monday slot but window only set for Tuesday
    expect(slotInsideAnyWindow({
      slotStart, slotEnd,
      windows: [{ weekday: 2, start_minutes: 9 * 60, end_minutes: 17 * 60, active: true }],
    })).toBe(false);
  });

  test('inactive window is ignored even if it would match', () => {
    expect(slotInsideAnyWindow({
      slotStart, slotEnd,
      windows: [{ weekday: 1, start_minutes: 9 * 60, end_minutes: 17 * 60, active: false }],
    })).toBe(false);
  });

  test('empty window list → never inside any window', () => {
    expect(slotInsideAnyWindow({ slotStart, slotEnd, windows: [] })).toBe(false);
  });
});

// ── Shift compatibility (the M2M shift_type × appointment_type matrix) ─────

describe('shiftBlocks', () => {
  const slotStart = utc('2026-06-08', '10:00:00');
  const slotEnd   = utc('2026-06-08', '11:00:00');

  test('no overlapping shifts → not blocked', () => {
    expect(shiftBlocks({
      slotStart, slotEnd,
      shifts: [{ start: utc('2026-06-08', '14:00:00'), end: utc('2026-06-08', '18:00:00'), shift_type_id: 5 }],
      allowedShiftTypeIds: [],
      untypedBlocks: true,
    })).toBe(false);
  });

  test('overlapping shift with shift_type IN allowlist → not blocked', () => {
    expect(shiftBlocks({
      slotStart, slotEnd,
      shifts: [{ start: utc('2026-06-08', '09:00:00'), end: utc('2026-06-08', '12:00:00'), shift_type_id: 5 }],
      allowedShiftTypeIds: [5],
      untypedBlocks: true,
    })).toBe(false);
  });

  test('overlapping shift with shift_type NOT in allowlist → blocked', () => {
    expect(shiftBlocks({
      slotStart, slotEnd,
      shifts: [{ start: utc('2026-06-08', '09:00:00'), end: utc('2026-06-08', '12:00:00'), shift_type_id: 7 }],
      allowedShiftTypeIds: [5],
      untypedBlocks: true,
    })).toBe(true);
  });

  test('untyped shift (shift_type_id null) blocks when untypedBlocks=true (default)', () => {
    expect(shiftBlocks({
      slotStart, slotEnd,
      shifts: [{ start: utc('2026-06-08', '09:00:00'), end: utc('2026-06-08', '12:00:00'), shift_type_id: null }],
      allowedShiftTypeIds: [],
      untypedBlocks: true,
    })).toBe(true);
  });

  test('untyped shift does NOT block when untypedBlocks=false', () => {
    expect(shiftBlocks({
      slotStart, slotEnd,
      shifts: [{ start: utc('2026-06-08', '09:00:00'), end: utc('2026-06-08', '12:00:00'), shift_type_id: null }],
      allowedShiftTypeIds: [],
      untypedBlocks: false,
    })).toBe(false);
  });

  test('multiple overlapping shifts: ANY incompatible one blocks', () => {
    expect(shiftBlocks({
      slotStart, slotEnd,
      shifts: [
        { start: utc('2026-06-08', '09:00:00'), end: utc('2026-06-08', '12:00:00'), shift_type_id: 5 },
        { start: utc('2026-06-08', '10:30:00'), end: utc('2026-06-08', '11:30:00'), shift_type_id: 7 },
      ],
      allowedShiftTypeIds: [5],
      untypedBlocks: true,
    })).toBe(true);
  });
});

// ── Time off + existing appointments ─────────────────────────────────────────

describe('timeOffBlocks', () => {
  test('approved time-off overlapping the slot blocks', () => {
    expect(timeOffBlocks({
      slotStart: utc('2026-06-08', '10:00:00'),
      slotEnd:   utc('2026-06-08', '11:00:00'),
      timeOff: [{ start: utc('2026-06-08', '09:00:00'), end: utc('2026-06-09', '00:00:00') }],
    })).toBe(true);
  });
  test('time-off on a different day does not block', () => {
    expect(timeOffBlocks({
      slotStart: utc('2026-06-08', '10:00:00'),
      slotEnd:   utc('2026-06-08', '11:00:00'),
      timeOff: [{ start: utc('2026-06-09', '00:00:00'), end: utc('2026-06-10', '00:00:00') }],
    })).toBe(false);
  });
});

describe('existingAppointmentBlocks', () => {
  test('booked appointment overlapping slot ± buffers blocks', () => {
    expect(existingAppointmentBlocks({
      slotStart: utc('2026-06-08', '10:00:00'),
      slotEnd:   utc('2026-06-08', '10:30:00'),
      appointments: [{ start: utc('2026-06-08', '10:15:00'), end: utc('2026-06-08', '10:45:00'), status: 'booked' }],
      bufferBeforeMin: 0, bufferAfterMin: 0,
    })).toBe(true);
  });

  test('cancelled appointment does NOT block (slot is free again)', () => {
    expect(existingAppointmentBlocks({
      slotStart: utc('2026-06-08', '10:00:00'),
      slotEnd:   utc('2026-06-08', '10:30:00'),
      appointments: [{ start: utc('2026-06-08', '10:15:00'), end: utc('2026-06-08', '10:45:00'), status: 'cancelled' }],
      bufferBeforeMin: 0, bufferAfterMin: 0,
    })).toBe(false);
  });

  test('appointment ending at slot start does NOT block when buffers are 0', () => {
    expect(existingAppointmentBlocks({
      slotStart: utc('2026-06-08', '10:00:00'),
      slotEnd:   utc('2026-06-08', '10:30:00'),
      appointments: [{ start: utc('2026-06-08', '09:30:00'), end: utc('2026-06-08', '10:00:00'), status: 'booked' }],
      bufferBeforeMin: 0, bufferAfterMin: 0,
    })).toBe(false);
  });

  test('appointment ending at slot start DOES block when there is a buffer_before (the prior appt\'s after-buffer eats into slot)', () => {
    expect(existingAppointmentBlocks({
      slotStart: utc('2026-06-08', '10:00:00'),
      slotEnd:   utc('2026-06-08', '10:30:00'),
      appointments: [{ start: utc('2026-06-08', '09:30:00'), end: utc('2026-06-08', '10:00:00'), status: 'booked' }],
      bufferBeforeMin: 0, bufferAfterMin: 15,  // prior appt expanded to end at 10:15
    })).toBe(true);
  });
});

// ── Round-robin assignment ──────────────────────────────────────────────────

describe('pickRoundRobinWinner', () => {
  test('returns null on empty candidate list', () => {
    expect(pickRoundRobinWinner([])).toBeNull();
    expect(pickRoundRobinWinner(null)).toBeNull();
  });

  test('user who has never been booked (lastCompletedAt=null) wins over ever-booked', () => {
    const winner = pickRoundRobinWinner([
      { id: 1, full_name: 'Alpha', lastCompletedAt: utc('2026-06-01', '12:00:00') },
      { id: 2, full_name: 'Beta',  lastCompletedAt: null },
    ]);
    expect(winner.id).toBe(2);
  });

  test('among ever-booked, oldest lastCompletedAt wins (longest gap)', () => {
    const winner = pickRoundRobinWinner([
      { id: 1, full_name: 'Alpha', lastCompletedAt: utc('2026-06-08', '12:00:00') },
      { id: 2, full_name: 'Beta',  lastCompletedAt: utc('2026-06-01', '12:00:00') },
    ]);
    expect(winner.id).toBe(2);
  });

  test('alphabetical tiebreaker on equal lastCompletedAt', () => {
    const t = utc('2026-06-01', '12:00:00');
    const winner = pickRoundRobinWinner([
      { id: 1, full_name: 'Zephyr',  lastCompletedAt: t },
      { id: 2, full_name: 'Alphonse', lastCompletedAt: t },
    ]);
    expect(winner.id).toBe(2);
  });

  test('alphabetical tiebreaker among never-booked too', () => {
    const winner = pickRoundRobinWinner([
      { id: 1, full_name: 'Zephyr',  lastCompletedAt: null },
      { id: 2, full_name: 'Alphonse', lastCompletedAt: null },
    ]);
    expect(winner.id).toBe(2);
  });

  test('single candidate → that candidate', () => {
    const winner = pickRoundRobinWinner([{ id: 1, full_name: 'Solo', lastCompletedAt: null }]);
    expect(winner.id).toBe(1);
  });
});

// ── Integration: candidatesForSlot ──────────────────────────────────────────

describe('candidatesForSlot (the full per-slot per-user filter)', () => {
  const APT_TYPE = {
    duration_minutes: 60,
    buffer_before_min: 0,
    buffer_after_min: 0,
  };
  const slotStart = utc('2026-06-08', '10:00:00');

  test('returns only bookable users whose windows / shifts / time-off / appointments allow', () => {
    const users = [
      // Bookable, Mon 9-5 window, no shifts, no time-off, no appts
      { id: 1, bookable: true, full_name: 'Bookable Alice',
        bookable_windows: [{ weekday: 1, start_minutes: 9*60, end_minutes: 17*60, active: true }],
        shifts: [], time_off: [], appointments: [] },
      // Bookable but no Mon window
      { id: 2, bookable: true, full_name: 'Window Mismatch Bob',
        bookable_windows: [{ weekday: 2, start_minutes: 9*60, end_minutes: 17*60, active: true }],
        shifts: [], time_off: [], appointments: [] },
      // Not bookable
      { id: 3, bookable: false, full_name: 'Not Bookable Carol',
        bookable_windows: [], shifts: [], time_off: [], appointments: [] },
      // Bookable, has time-off covering the slot
      { id: 4, bookable: true, full_name: 'On Vacation Dan',
        bookable_windows: [{ weekday: 1, start_minutes: 9*60, end_minutes: 17*60, active: true }],
        shifts: [],
        time_off: [{ start: utc('2026-06-08', '09:00:00'), end: utc('2026-06-08', '17:00:00') }],
        appointments: [] },
    ];
    const result = candidatesForSlot({
      slotStart,
      durationMinutes: 60,
      users,
      appointmentType: APT_TYPE,
      allowedShiftTypeIds: [],
      untypedBlocks: true,
    });
    expect(result.map(u => u.id)).toEqual([1]);
  });
});
