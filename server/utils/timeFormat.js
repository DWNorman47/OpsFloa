/**
 * Wall-clock + instant conversion helpers.
 *
 * The app is mid-migration from wall-clock TIME storage to TIMESTAMPTZ
 * instant storage:
 *   - Old columns: time_entries.start_time / end_time (TIME), work_date (DATE)
 *   - New columns: time_entries.start_ts / end_ts (TIMESTAMPTZ)
 *
 * During Phase 2 every write site populates both representations, derived
 * from the same wall-clock + IANA timezone via the helpers below. After
 * Phase 3 reader cutover, the old columns can be dropped.
 *
 * The TZ used for a write site comes from one of three places, in order:
 *   1. A client-supplied field (best — the client knew its own clock).
 *   2. A stored timezone (e.g. active_clock.timezone, users.timezone).
 *   3. UTC fallback (only when nothing else is available; usually wrong).
 */

/**
 * Return "HH:MM:SS" wall-clock time for `date` interpreted in `timezone`.
 *
 * @param {Date}   date
 * @param {string} [timezone]  IANA tz (e.g. 'America/New_York'). Falls back
 *                             to the server's UTC clock when undefined/invalid.
 * @returns {string}
 */
function wallClockInTZ(date, timezone) {
  if (!(date instanceof Date) || isNaN(date)) date = new Date();
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    const parts = fmt.formatToParts(date).reduce((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value;
      return acc;
    }, {});
    // Intl can return "24" for hour at midnight in en-US; coerce to "00"
    const hh = parts.hour === '24' ? '00' : (parts.hour || '00');
    return `${hh}:${parts.minute || '00'}:${parts.second || '00'}`;
  } catch {
    // Bad timezone string — fall through to UTC components
    const pad = n => String(n).padStart(2, '0');
    return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  }
}

/**
 * Return "YYYY-MM-DD" calendar date for `date` interpreted in `timezone`.
 *
 * @param {Date}   date
 * @param {string} [timezone]
 * @returns {string}
 */
function wallDateInTZ(date, timezone) {
  if (!(date instanceof Date) || isNaN(date)) date = new Date();
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
    return fmt.format(date); // en-CA already gives "YYYY-MM-DD"
  } catch {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  }
}

/**
 * Validate a client-supplied "HH:MM[:SS]" string. Returns it (with seconds
 * appended if missing) on success, null on failure. Use to gate a fallback:
 *
 *   const t = validLocalTime(req.body.local_time)
 *           ?? wallClockInTZ(new Date(), worker.timezone);
 */
function validLocalTime(s) {
  if (typeof s !== 'string') return null;
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(s)) return null;
  return s.length === 5 ? `${s}:00` : s;
}

/**
 * Validate a client-supplied "YYYY-MM-DD" string. Returns it on success,
 * null on failure.
 */
function validLocalDate(s) {
  if (typeof s !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  // Calendar-validity check — '2026-02-31' would pass the regex.
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return s;
}

/**
 * Convert a wall-clock (date, time, IANA tz) to a UTC instant Date.
 *
 *   instantFromLocal('2026-04-27', '08:00:00', 'America/New_York')
 *     → Date representing 12:00:00 UTC on 2026-04-27
 *
 * Used at write sites to populate the new TIMESTAMPTZ columns alongside
 * the legacy wall-clock columns.
 *
 * @param {string} workDate     "YYYY-MM-DD"
 * @param {string} localTime    "HH:MM[:SS]"
 * @param {string} [timezone]   IANA tz; defaults to UTC
 * @returns {Date|null}         null if any input is invalid
 */
function instantFromLocal(workDate, localTime, timezone) {
  const date = validLocalDate(workDate);
  const time = validLocalTime(localTime);
  if (!date || !time) return null;
  const tz = timezone || 'UTC';
  const [y, m, d]    = date.split('-').map(Number);
  const [hh, mm, ss] = time.split(':').map(Number);
  const wantUTC = Date.UTC(y, m - 1, d, hh, mm, ss);

  // Strategy: ask Intl what wall-clock our candidate instant has in the
  // target TZ, compute the diff vs the wall-clock we want, shift by that
  // diff. One iteration is enough for non-DST days; near a DST transition
  // the second iteration converges (the first pass uses the offset on
  // the wrong side of the boundary, the second uses the correct one).
  function diffToTarget(candidateMs) {
    let parts;
    try {
      parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
      }).formatToParts(new Date(candidateMs));
    } catch {
      return null; // bad TZ
    }
    const lookup = {};
    parts.forEach(p => { if (p.type !== 'literal') lookup[p.type] = p.value; });
    const gotUTC = Date.UTC(
      parseInt(lookup.year),
      parseInt(lookup.month) - 1,
      parseInt(lookup.day),
      parseInt(lookup.hour === '24' ? '00' : lookup.hour),
      parseInt(lookup.minute),
      parseInt(lookup.second),
    );
    return wantUTC - gotUTC;
  }

  let candidate = wantUTC;
  for (let i = 0; i < 2; i++) {
    const diff = diffToTarget(candidate);
    if (diff === null) return new Date(wantUTC); // bad TZ — best-effort UTC
    if (diff === 0) break;
    candidate += diff;
  }
  return new Date(candidate);
}

/**
 * Convert a TIMESTAMPTZ instant back to wall-clock components in the
 * given timezone. Inverse of `instantFromLocal`.
 *
 *   localFromInstant(new Date('2026-04-27T12:00:00Z'), 'America/New_York')
 *     → { date: '2026-04-27', time: '08:00:00' }
 *
 * @param {Date}   ts
 * @param {string} [timezone]
 * @returns {{ date: string, time: string }}
 */
function localFromInstant(ts, timezone) {
  return {
    date: wallDateInTZ(ts, timezone),
    time: wallClockInTZ(ts, timezone),
  };
}

/**
 * Elapsed minutes between two TIMESTAMPTZ instants, optionally minus a
 * break. Replaces the wall-clock string subtraction in payCalculations
 * once Phase 3 reader cutover lands. Always correct across DST and
 * cross-TZ shifts because it's just instant arithmetic.
 *
 * @param {Date|string} startTs
 * @param {Date|string} endTs
 * @param {number}      [breakMinutes=0]
 * @returns {number}    elapsed minutes; never negative
 */
function elapsedMinutes(startTs, endTs, breakMinutes = 0) {
  const s = startTs instanceof Date ? startTs : new Date(startTs);
  const e = endTs   instanceof Date ? endTs   : new Date(endTs);
  if (isNaN(s) || isNaN(e)) return 0;
  const diff = (e.getTime() - s.getTime()) / 60000;
  return Math.max(0, diff - (Number(breakMinutes) || 0));
}

/**
 * Convenience wrapper for the dual-write Phase 2 pattern: given a wall-clock
 * row (work_date, start_time, end_time) and the TZ those times were entered
 * in, return the matching TIMESTAMPTZ pair. Handles midnight-crossing
 * (end_time < start_time) by bumping end_ts to the next day.
 *
 * Used at every INSERT/UPDATE site for time_entries and shifts so the new
 * start_ts / end_ts columns stay in sync with the legacy TIME columns.
 *
 * @returns {{ start_ts: Date|null, end_ts: Date|null }}
 */
function entryInstants(workDate, startTime, endTime, timezone) {
  const start_ts = instantFromLocal(workDate, startTime, timezone);
  let end_ts     = instantFromLocal(workDate, endTime, timezone);
  if (start_ts && end_ts && end_ts.getTime() <= start_ts.getTime()) {
    // Midnight-crossing shift (e.g. 23:00–01:00). Bump end_ts forward a day.
    end_ts = new Date(end_ts.getTime() + 86400000);
  }
  return { start_ts, end_ts };
}

/**
 * Wall-clock hours between two "HH:MM[:SS]" strings, wrapping a single midnight
 * (end < start → +24h). Mirrors payCalculations.hoursWorked — this is what the pay
 * engine currently derives a shift's duration from, and it CANNOT exceed 24h.
 */
function wallHours(startTime, endTime) {
  let ms = new Date(`1970-01-01T${endTime}`) - new Date(`1970-01-01T${startTime}`);
  if (ms < 0) ms += 86400000;
  return ms / 3600000;
}

/**
 * True when a shift's real instant span (start_ts→end_ts) exceeds the wall-clock
 * duration the pay engine will compute (>= 1h difference). That gap only opens when
 * the shift crosses a day boundary — a forgotten / multi-day clock-out — so the
 * stored TIME columns silently truncate it (e.g. a 49h shift reads as 1h). Used to
 * flag the entry for admin review until the pay reader is cut over to the instants.
 * Needs both instants; returns false if either is missing or unparseable.
 */
function isTruncatedLongShift(startTs, endTs, startTime, endTime) {
  if (startTs == null || endTs == null) return false;
  const s = startTs instanceof Date ? startTs : new Date(startTs);
  const e = endTs instanceof Date ? endTs : new Date(endTs);
  if (isNaN(s) || isNaN(e)) return false;
  if (!startTime || !endTime) return false;
  const realH = (e.getTime() - s.getTime()) / 3600000;
  if (!(realH > 0)) return false;
  return realH - wallHours(startTime, endTime) >= 1;
}

module.exports = {
  wallClockInTZ,
  wallDateInTZ,
  validLocalTime,
  validLocalDate,
  instantFromLocal,
  localFromInstant,
  elapsedMinutes,
  entryInstants,
  isTruncatedLongShift,
};
