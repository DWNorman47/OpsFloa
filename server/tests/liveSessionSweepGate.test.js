/**
 * The live-session sweep only queries the DB while sessions are active, and disarms
 * (stops querying) once none remain — so an idle server lets Neon suspend, and it can't
 * poll forever (abandoned sessions get ended, which empties the set and disarms).
 */

jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../jobs/runJob', () => ({ runJob: (_name, fn) => fn() }));
jest.mock('../routes/liveSessions', () => ({ rooms: new Map() })); // no connected clients

const pool = require('../db');
const { sweepIdleSessions, noteLiveSessionActive, isSweepArmed } = require('../jobs/liveSessionSweep');

beforeEach(() => { pool.query.mockReset(); });

test('disarms (and does a single query) when no sessions are active', async () => {
  noteLiveSessionActive(); // arm it
  expect(isSweepArmed()).toBe(true);
  pool.query.mockResolvedValueOnce({ rows: [] }); // SELECT active → none

  await sweepIdleSessions();

  expect(isSweepArmed()).toBe(false);          // disarmed → cron will skip the DB next time
  expect(pool.query).toHaveBeenCalledTimes(1); // only the "any active?" query, no UPDATE
});

test('stays armed and does not end a still-fresh active session', async () => {
  noteLiveSessionActive();
  pool.query.mockResolvedValueOnce({ rows: [{ id: 1, last_activity_at: new Date().toISOString() }] });

  await sweepIdleSessions();

  expect(isSweepArmed()).toBe(true);           // a live session keeps it armed
  expect(pool.query).toHaveBeenCalledTimes(1); // fresh → not ended, no UPDATE
});
