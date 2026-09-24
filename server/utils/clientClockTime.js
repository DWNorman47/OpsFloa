// Resolve a client-claimed punch instant (clock_in_time on /clock/in, /switch,
// and the lost-clock-out recovery path).
//
// The client captures the instant at the button press — before the GPS wait,
// and before an offline-queued punch finally reaches us — so we keep honouring
// it: an offline clock-in must be paid from when the worker actually tapped.
// But nothing stopped a worker sending any time at all, and the result looked
// like an ordinary punch. So:
//   - a missing / unparseable time falls back to `now`;
//   - a time in the future (beyond clock-skew slack) is clamped to `now`;
//   - a time more than LATE_THRESHOLD_MIN old is still accepted, but the lag is
//     returned as lateMinutes so it's stored on the shift and approvers see a
//     "late clock-in" badge. Forgotten clock-ins belong in a manual time entry
//     (clock_source 'log_entry'), which is already badged for review.

const FUTURE_SLACK_MS = 2 * 60 * 1000;
const LATE_THRESHOLD_MIN = 10;

function resolveClientClockTime(raw, now = new Date()) {
  const parsed = raw ? new Date(raw) : null;
  if (!parsed || isNaN(parsed)) return { ts: now, lateMinutes: null };
  if (parsed.getTime() > now.getTime() + FUTURE_SLACK_MS) return { ts: now, lateMinutes: null };
  const lagMin = Math.floor((now.getTime() - parsed.getTime()) / 60000);
  return { ts: parsed, lateMinutes: lagMin > LATE_THRESHOLD_MIN ? lagMin : null };
}

module.exports = { resolveClientClockTime, LATE_THRESHOLD_MIN };
