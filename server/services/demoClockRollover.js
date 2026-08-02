const pool = require('../db');
const { wallClockInTZ, wallDateInTZ } = require('../utils/timeFormat');

const DEMO_CLOCK_ROLLOVER_HOURS = 23;
const DEMO_SHIFT_HOURS = 8;
const FRESH_CLOCK_SPACING_MINUTES = 15;

/**
 * Keep the seeded Demo Operations live clocks useful without allowing them to
 * accumulate multi-day shifts. Customer clocks remain under the normal stale
 * clock alert flow and are never finalized here.
 */
async function rolloverStaleDemoClocks({ db = pool, now = new Date() } = {}) {
  const client = await db.connect();
  const cutoff = new Date(now.getTime() - DEMO_CLOCK_ROLLOVER_HOURS * 60 * 60 * 1000);

  try {
    await client.query('BEGIN');
    const stale = await client.query(
      `SELECT ac.*, COALESCE(p.wage_type, 'regular') AS wage_type
         FROM active_clock ac
         JOIN companies c ON c.id = ac.company_id
         LEFT JOIN projects p ON p.id = ac.project_id
        WHERE c.is_demo = true
          AND c.subscription_status = 'exempt'
          AND ac.clock_in_time <= $1
        ORDER BY ac.clock_in_time, ac.id
        FOR UPDATE OF ac`,
      [cutoff]
    );

    for (let index = 0; index < stale.rows.length; index += 1) {
      const clock = stale.rows[index];
      const clockInTime = new Date(clock.clock_in_time);
      const clockOutTime = new Date(clockInTime.getTime() + DEMO_SHIFT_HOURS * 60 * 60 * 1000);
      const timezone = clock.timezone || 'UTC';

      await client.query(
        `INSERT INTO time_entries
           (company_id, user_id, project_id, work_date, start_time, end_time,
            start_ts, end_ts, wage_type, notes, clock_in_lat, clock_in_lng,
            break_minutes, mileage, timezone, clock_source, clocked_in_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 0, NULL, $13, $14, $15)`,
        [
          clock.company_id,
          clock.user_id,
          clock.project_id,
          wallDateInTZ(clockInTime, timezone),
          wallClockInTZ(clockInTime, timezone),
          wallClockInTZ(clockOutTime, timezone),
          clockInTime,
          clockOutTime,
          clock.wage_type,
          clock.notes || null,
          clock.clock_in_lat,
          clock.clock_in_lng,
          timezone,
          clock.clock_source || 'worker',
          clock.clocked_in_by || null,
        ]
      );

      const minutesAgo = FRESH_CLOCK_SPACING_MINUTES * ((index % 3) + 1);
      const freshClockIn = new Date(now.getTime() - minutesAgo * 60 * 1000);
      await client.query(
        `UPDATE active_clock
            SET clock_in_time = $1,
                work_date = $2,
                created_at = $1,
                location_updated_at = $1,
                stale_alert_sent_at = NULL
          WHERE id = $3`,
        [freshClockIn, wallDateInTZ(freshClockIn, timezone), clock.id]
      );
    }

    await client.query('COMMIT');
    return stale.rowCount;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  DEMO_CLOCK_ROLLOVER_HOURS,
  DEMO_SHIFT_HOURS,
  rolloverStaleDemoClocks,
};
