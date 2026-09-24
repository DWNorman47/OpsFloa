const { resolveClientClockTime, LATE_THRESHOLD_MIN } = require('../utils/clientClockTime');

const NOW = new Date('2026-09-24T15:00:00Z');
const minsAgo = (m) => new Date(NOW.getTime() - m * 60000).toISOString();

describe('resolveClientClockTime', () => {
  test('missing or garbage time falls back to now, unflagged', () => {
    for (const raw of [undefined, null, '', 'not-a-date']) {
      expect(resolveClientClockTime(raw, NOW)).toEqual({ ts: NOW, lateMinutes: null });
    }
  });

  test('a press a few seconds / minutes ago (GPS wait) is kept and not flagged', () => {
    const r = resolveClientClockTime(minsAgo(3), NOW);
    expect(r.ts.toISOString()).toBe(minsAgo(3));
    expect(r.lateMinutes).toBeNull();
  });

  test(`exactly ${LATE_THRESHOLD_MIN} minutes is still on time`, () => {
    expect(resolveClientClockTime(minsAgo(LATE_THRESHOLD_MIN), NOW).lateMinutes).toBeNull();
  });

  test('a backdated / offline clock-in is kept but flagged with the lag', () => {
    const r = resolveClientClockTime(minsAgo(600), NOW); // "clocked in" 10h ago
    expect(r.ts.toISOString()).toBe(minsAgo(600));
    expect(r.lateMinutes).toBe(600);
  });

  test('a future time is clamped to now', () => {
    const future = new Date(NOW.getTime() + 60 * 60000).toISOString();
    expect(resolveClientClockTime(future, NOW)).toEqual({ ts: NOW, lateMinutes: null });
  });

  test('small clock skew into the future is tolerated as-is', () => {
    const skew = new Date(NOW.getTime() + 60000).toISOString();
    const r = resolveClientClockTime(skew, NOW);
    expect(r.ts.toISOString()).toBe(skew);
    expect(r.lateMinutes).toBeNull();
  });
});
