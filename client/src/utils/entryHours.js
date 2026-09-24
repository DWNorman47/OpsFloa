// Net hours of one time entry — the client mirror of the server's pay engine
// definition (server/utils/payCalculations.js entryDuration), so a screen that
// totals hours itself agrees with what the invoice / pay stub pays.
//
//   wall-clock span of start_time→end_time (wraps one midnight)
//   + DST correction: -(offset(end_ts) - offset(start_ts)) in the entry's IANA
//     `timezone` — +1h over a US fall-back night, −1h over spring-forward, 0 when
//     start_ts / end_ts / timezone are missing or the span isn't a single shift
//   − break (clamped at 0), clamped at 0.
//
// When the server already computed the entry's paid hours (`paid_hours`, stamped
// by the pay statement), that number wins — never re-derive what the server priced.

const MAX_SPAN_MS = 26 * 3600000;
const fmtCache = new Map();

function formatter(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return null;
  if (fmtCache.has(tz)) return fmtCache.get(tz);
  let f = null;
  try {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch { f = null; }
  fmtCache.set(tz, f);
  return f;
}

/** UTC offset in minutes of IANA `tz` at instant `ms` (Chicago CDT → -300), or null. */
export function offsetMinutes(ms, tz) {
  const f = formatter(tz);
  if (!f || !Number.isFinite(ms)) return null;
  const p = {};
  for (const x of f.formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = x.value;
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60000);
}

const toMs = v => (v == null || v === '' ? NaN : v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v));

/** Hours to add to the wall-clock span for a DST change inside the shift (±1, usually 0). */
export function dstAdjustHours(e) {
  if (!e || e.start_ts == null || e.end_ts == null || !e.timezone) return 0;
  const s = toMs(e.start_ts), en = toMs(e.end_ts);
  if (!Number.isFinite(s) || !Number.isFinite(en) || !(en > s) || en - s > MAX_SPAN_MS) return 0;
  const o1 = offsetMinutes(s, e.timezone), o2 = offsetMinutes(en, e.timezone);
  if (o1 == null || o2 == null) return 0;
  return -(o2 - o1) / 60;
}

/** Wall-clock hours between "HH:MM[:SS]" strings, wrapping one midnight. */
export function wallHours(start, end) {
  let ms = new Date(`1970-01-01T${end}`) - new Date(`1970-01-01T${start}`);
  if (ms < 0) ms += 86400000;
  return ms / 3600000;
}

/** Net paid hours of an entry: server `paid_hours` if present, else the same rule locally. */
export function entryNetHours(e) {
  if (!e) return 0;
  const server = e.paid_hours != null ? Number(e.paid_hours) : NaN;
  if (Number.isFinite(server)) return server;
  if (!e.start_time || !e.end_time) return 0;
  const h = wallHours(e.start_time, e.end_time) + dstAdjustHours(e) - Math.max(0, Number(e.break_minutes) || 0) / 60;
  return Number.isFinite(h) ? Math.max(0, h) : 0;
}
