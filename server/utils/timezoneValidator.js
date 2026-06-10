// Validate an IANA timezone string by asking the runtime if it can be
// used. Invalid values throw inside Intl.DateTimeFormat's constructor;
// we catch and return false. Used at user PUT time on /users/:id/booking
// and /me/booking so a typo like "America/Atlantis" surfaces as a 400
// rather than silently leaving the user's `timezone` set to garbage —
// which the availability algorithm would then silently fall back to UTC
// for, producing booked appointments at the wrong wall-clock time.
function isValidTimezone(tz) {
  if (tz == null || tz === '') return true; // NULL/empty is allowed (no TZ set)
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: String(tz) });
    return true;
  } catch {
    return false;
  }
}

module.exports = { isValidTimezone };
