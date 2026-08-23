const {
  wallClockInTZ,
  wallDateInTZ,
  validLocalTime,
  validLocalDate,
  instantFromLocal,
  localFromInstant,
  elapsedMinutes,
  isTruncatedLongShift,
} = require('../utils/timeFormat');

describe('validLocalTime', () => {
  test('accepts HH:MM and appends :00', () => {
    expect(validLocalTime('08:30')).toBe('08:30:00');
  });
  test('accepts HH:MM:SS unchanged', () => {
    expect(validLocalTime('08:30:45')).toBe('08:30:45');
  });
  test('rejects bad shapes', () => {
    expect(validLocalTime('8:30')).toBeNull();
    expect(validLocalTime('08:30:45.5')).toBeNull();
    expect(validLocalTime('')).toBeNull();
    expect(validLocalTime(null)).toBeNull();
    expect(validLocalTime(undefined)).toBeNull();
    expect(validLocalTime(800)).toBeNull();
  });
});

describe('validLocalDate', () => {
  test('accepts YYYY-MM-DD', () => {
    expect(validLocalDate('2026-04-27')).toBe('2026-04-27');
  });
  test('rejects calendar-impossible dates', () => {
    expect(validLocalDate('2026-02-31')).toBeNull();
    expect(validLocalDate('2026-13-01')).toBeNull();
  });
  test('rejects bad shapes', () => {
    expect(validLocalDate('4/27/2026')).toBeNull();
    expect(validLocalDate('2026-4-27')).toBeNull();
    expect(validLocalDate('')).toBeNull();
    expect(validLocalDate(null)).toBeNull();
  });
});

describe('wallClockInTZ', () => {
  test('renders a UTC instant in the requested TZ', () => {
    // 2026-04-27 12:00:00 UTC = 08:00:00 in America/New_York (EDT)
    const d = new Date('2026-04-27T12:00:00Z');
    expect(wallClockInTZ(d, 'America/New_York')).toBe('08:00:00');
  });
  test('falls back to UTC for invalid TZ', () => {
    const d = new Date('2026-04-27T12:00:00Z');
    // Intl throws on garbage TZ — helper returns UTC components
    expect(wallClockInTZ(d, 'Not/A_Zone')).toBe('12:00:00');
  });
  test('handles midnight without printing "24:00:00"', () => {
    const d = new Date('2026-04-27T00:00:00Z');
    expect(wallClockInTZ(d, 'UTC')).toBe('00:00:00');
  });
});

describe('wallDateInTZ', () => {
  test('renders a UTC instant in the requested TZ', () => {
    // 2026-04-27 02:00:00 UTC = 2026-04-26 22:00 in America/New_York (EDT)
    const d = new Date('2026-04-27T02:00:00Z');
    expect(wallDateInTZ(d, 'America/New_York')).toBe('2026-04-26');
  });
});

describe('instantFromLocal', () => {
  test('round-trips through localFromInstant for a normal day', () => {
    const inst = instantFromLocal('2026-04-27', '08:00:00', 'America/New_York');
    expect(inst).toBeInstanceOf(Date);
    expect(localFromInstant(inst, 'America/New_York')).toEqual({
      date: '2026-04-27',
      time: '08:00:00',
    });
  });

  test('round-trips for UTC', () => {
    const inst = instantFromLocal('2026-04-27', '14:30:00', 'UTC');
    expect(inst.toISOString()).toBe('2026-04-27T14:30:00.000Z');
  });

  test('round-trips for a TZ east of UTC', () => {
    // 09:00 in Tokyo on 2026-04-27 = 00:00 UTC same day
    const inst = instantFromLocal('2026-04-27', '09:00:00', 'Asia/Tokyo');
    expect(inst.toISOString()).toBe('2026-04-27T00:00:00.000Z');
    expect(localFromInstant(inst, 'Asia/Tokyo')).toEqual({
      date: '2026-04-27',
      time: '09:00:00',
    });
  });

  test('round-trips across the DST spring-forward boundary', () => {
    // 2026-03-08 is the US spring-forward day. 03:30 AM exists (post-jump)
    // and round-trips cleanly. (02:30 AM doesn't exist that day; we don't
    // assert behavior for it because both Date.UTC + Intl can disagree
    // on which side of the gap to land.)
    const inst = instantFromLocal('2026-03-08', '03:30:00', 'America/New_York');
    expect(localFromInstant(inst, 'America/New_York')).toEqual({
      date: '2026-03-08',
      time: '03:30:00',
    });
  });

  test('round-trips across the DST fall-back boundary', () => {
    // 2026-11-01 is the US fall-back day. 01:30 AM exists twice; helper
    // resolves to one of them and round-trips back to the same wall-clock.
    const inst = instantFromLocal('2026-11-01', '01:30:00', 'America/New_York');
    expect(localFromInstant(inst, 'America/New_York')).toEqual({
      date: '2026-11-01',
      time: '01:30:00',
    });
  });

  test('returns null for bad inputs', () => {
    expect(instantFromLocal('not-a-date', '08:00:00', 'UTC')).toBeNull();
    expect(instantFromLocal('2026-04-27', 'not-a-time', 'UTC')).toBeNull();
  });
});

describe('elapsedMinutes', () => {
  test('subtracts simply', () => {
    const s = new Date('2026-04-27T08:00:00Z');
    const e = new Date('2026-04-27T12:30:00Z');
    expect(elapsedMinutes(s, e)).toBe(270);
  });

  test('subtracts the break', () => {
    const s = new Date('2026-04-27T08:00:00Z');
    const e = new Date('2026-04-27T17:00:00Z');
    expect(elapsedMinutes(s, e, 30)).toBe(540 - 30);
  });

  test('clamps to zero when end <= start', () => {
    const s = new Date('2026-04-27T12:00:00Z');
    const e = new Date('2026-04-27T08:00:00Z');
    expect(elapsedMinutes(s, e)).toBe(0);
  });

  test('handles cross-TZ shifts correctly', () => {
    // Worker clocked in at 08:00 Eastern in Florida, drove west, clocked out
    // at 17:00 Central in Mississippi. Wall-clock subtraction would give 9h,
    // actual elapsed is 10h. instantFromLocal preserves the truth.
    const start = instantFromLocal('2026-04-27', '08:00:00', 'America/New_York');
    const end   = instantFromLocal('2026-04-27', '17:00:00', 'America/Chicago');
    expect(elapsedMinutes(start, end)).toBe(10 * 60);
  });

  test('handles a midnight-crossing shift', () => {
    const start = instantFromLocal('2026-04-27', '23:00:00', 'America/New_York');
    const end   = instantFromLocal('2026-04-28', '01:30:00', 'America/New_York');
    expect(elapsedMinutes(start, end)).toBe(150);
  });

  test('returns 0 on invalid inputs', () => {
    expect(elapsedMinutes('not-a-date', new Date())).toBe(0);
    expect(elapsedMinutes(new Date(), 'not-a-date')).toBe(0);
  });
});

describe('isTruncatedLongShift', () => {
  test('flags a forgotten multi-day clock-out (49h span reads as 1h)', () => {
    const start = new Date('2026-04-27T08:00:00Z'); // Mon 08:00
    const end   = new Date('2026-04-29T09:00:00Z'); // Wed 09:00 (~49h)
    // wall-clock columns would store start_time 08:00 / end_time 09:00 → ~1h
    expect(isTruncatedLongShift(start, end, '08:00', '09:00')).toBe(true);
  });

  test('does NOT flag a normal same-day shift', () => {
    const start = new Date('2026-04-27T13:00:00Z'); // 08:00 local etc.
    const end   = new Date('2026-04-27T22:00:00Z'); // 9h later
    expect(isTruncatedLongShift(start, end, '08:00', '17:00')).toBe(false);
  });

  test('does NOT flag a representable overnight shift (20:00→14:00 = 18h)', () => {
    const start = new Date('2026-04-27T20:00:00Z');
    const end   = new Date('2026-04-28T14:00:00Z'); // 18h, wraps one midnight
    expect(isTruncatedLongShift(start, end, '20:00', '14:00')).toBe(false);
  });

  test('flags a multi-day overnight (20:00→14:00 but two days later = 42h)', () => {
    const start = new Date('2026-04-27T20:00:00Z');
    const end   = new Date('2026-04-29T14:00:00Z'); // 42h
    expect(isTruncatedLongShift(start, end, '20:00', '14:00')).toBe(true);
  });

  test('returns false when an instant is missing or unparseable', () => {
    expect(isTruncatedLongShift(null, new Date(), '08:00', '09:00')).toBe(false);
    expect(isTruncatedLongShift(new Date(), 'nope', '08:00', '09:00')).toBe(false);
    expect(isTruncatedLongShift(new Date('2026-04-27T08:00:00Z'), new Date('2026-04-29T09:00:00Z'), '', '')).toBe(false);
  });
});
