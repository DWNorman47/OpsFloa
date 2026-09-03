/**
 * Ends abandoned live-collaboration sessions. A session is swept when it has
 * had no activity for IDLE_MS AND no participants currently connected to this
 * instance — its final state snapshot stays on the row for the host to reclaim.
 * (Rooms with connected clients are skipped even if idle, so a long look-only
 * session isn't yanked out from under viewers.)
 */

const cron = require('node-cron');
const pool = require('../db');
const { runJob } = require('./runJob');
const { rooms } = require('../routes/liveSessions');

const IDLE_MS = 2 * 60 * 60 * 1000; // 2 hours

// The sweep only queries the DB while at least one live session is (or was) active, so
// an idle server makes zero scheduled queries and Neon can suspend. Creating a session
// arms it (noteLiveSessionActive); the sweep disarms itself only when NO active sessions
// remain — so overlapping sessions keep it armed until the last one ends. Armed at boot
// to catch any session left active before a restart. Self-terminating: abandoned sessions
// get ended here (2h idle), which eventually empties the set and disarms.
let sweepArmed = true;

/** Called when a live session is created — (re)arms the sweep. */
function noteLiveSessionActive() {
  sweepArmed = true;
}

async function sweepIdleSessions() {
  const { rows } = await pool.query(`SELECT id, last_activity_at FROM live_sessions WHERE status = 'active'`);
  if (rows.length === 0) { sweepArmed = false; return; } // nothing active → disarm, DB idles
  const cutoff = Date.now() - IDLE_MS;
  const toEnd = [];
  for (const r of rows) {
    const room = rooms.get(String(r.id));
    if (room && room.clients.size > 0) continue;                        // people are here
    if (new Date(r.last_activity_at).getTime() > cutoff) continue;      // still fresh
    toEnd.push(String(r.id));
  }
  for (const id of toEnd) {
    await pool.query(`UPDATE live_sessions SET status = 'ended', ended_at = now() WHERE id = $1 AND status = 'active'`, [id]);
    const room = rooms.get(id);
    if (room) {
      for (const c of room.clients.values()) { try { c.res.end(); } catch (_) {} }
      rooms.delete(id);
    }
  }
  if (toEnd.length) console.log(`liveSessionSweep: ended ${toEnd.length} idle session(s)`);
}

function startLiveSessionSweepJob() {
  cron.schedule('*/15 * * * *', () => {
    if (!sweepArmed) return; // no known active sessions → no DB query, Neon can idle
    return runJob('liveSessionSweep', sweepIdleSessions);
  });
}

module.exports = { startLiveSessionSweepJob, noteLiveSessionActive, sweepIdleSessions, isSweepArmed: () => sweepArmed };
