/**
 * Booking correctness:
 *  - approved time off blocks the worker's LOCAL calendar day (not a UTC day)
 *  - the final double-booking check loads every appointment the buffer rule can hit
 *    (query padded by max(buffer_before, buffer_after) on both sides)
 *  - booking emails show the time in an explicit zone with its abbreviation
 */

jest.mock('../middleware/auth', () => ({
  requireAuth:  (req, _res, next) => next(),
  requireAdmin: (req, _res, next) => next(),
}));
jest.mock('../db', () => {
  const q = jest.fn();
  return { query: q, connect: jest.fn().mockResolvedValue({ query: (...a) => q(...a), release: jest.fn() }) };
});
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../email', () => ({ sendEmail: jest.fn().mockResolvedValue(undefined) }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const { sendEmail } = require('../email');
const route = require('../routes/booking');
const { timeOffRange } = require('../utils/bookingAvailability');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/public/book', route.publicRouter);
  return app;
}

// Thu 2030-09-26 / Fri 2030-09-27 — Pacific Daylight Time (UTC−7).
const LA = 'America/Los_Angeles';

function installDb({ user, windows, timeOff = [], existing = [], at = {} }) {
  const apt = {
    id: 1, name: 'Site Visit', resolved_company_id: 'co-1', company_name: 'Acme',
    active: true, advance_notice_hrs: 0, duration_minutes: 60,
    buffer_before_min: 0, buffer_after_min: 0, location_kind: 'onsite', ...at,
  };
  pool.query.mockImplementation(async (sql, params) => {
    if (/FROM appointment_types at\s+JOIN companies/.test(sql)) return { rowCount: 1, rows: [apt] };
    if (/FROM appointment_type_users|FROM appointment_type_shift_types/.test(sql)) return { rowCount: 0, rows: [] };
    if (/FROM users WHERE company_id = \$1 AND bookable = true/.test(sql)) return { rowCount: 1, rows: [user] };
    if (/FROM bookable_windows/.test(sql)) return { rowCount: windows.length, rows: windows.map(w => ({ user_id: user.id, active: true, ...w })) };
    if (/FROM shifts/.test(sql)) return { rowCount: 0, rows: [] };
    if (/FROM time_off_requests/.test(sql)) return { rowCount: timeOff.length, rows: timeOff };
    if (/MAX\(completed_at\)/.test(sql)) return { rowCount: 0, rows: [] };
    if (/FROM appointments\s+WHERE assigned_user_id = ANY/.test(sql)) {
      // Emulate the SQL window: end > $3 AND start < $4.
      const lo = new Date(params[2]).getTime();
      const hi = new Date(params[3]).getTime();
      const rows = existing.filter(a => new Date(a.end).getTime() > lo && new Date(a.start).getTime() < hi)
        .map(a => ({ user_id: user.id, status: 'booked', ...a }));
      return { rowCount: rows.length, rows };
    }
    if (/INSERT INTO appointments/.test(sql)) return { rowCount: 1, rows: [{ id: 77 }] };
    if (/FROM companies WHERE id/.test(sql)) return { rowCount: 1, rows: [{ name: 'Acme' }] };
    if (/FROM users u WHERE u\.id|FROM users WHERE id/.test(sql)) return { rowCount: 1, rows: [{ email: 'lee@x.com', timezone: user.timezone }] };
    return { rowCount: 0, rows: [] };
  });
}

const book = scheduled_at => request(makeApp()).post('/api/public/book/acme/site-visit')
  .send({ scheduled_at, client_name: 'Jane', client_email: 'jane@x.com' });

beforeEach(() => { pool.query.mockReset(); sendEmail.mockClear(); });

describe('time off is the worker\'s local day', () => {
  test('timeOffRange: LA Friday = Fri 00:00 PDT → Sat 00:00 PDT', () => {
    const r = timeOffRange('2030-09-27', '2030-09-27', LA);
    expect(r.start.toISOString()).toBe('2030-09-27T07:00:00.000Z');
    expect(r.end.toISOString()).toBe('2030-09-28T07:00:00.000Z');
  });

  // The route row carries the UTC-derived start/end the old SQL produced, so the old code
  // path (which read t.start/t.end) is exercised too.
  const fridayOff = [{
    user_id: 5, start_date: '2030-09-27', end_date: '2030-09-27', timezone: LA,
    start: '2030-09-27T00:00:00Z', end: '2030-09-28T00:00:00Z',
  }];
  const user = { id: 5, full_name: 'Lee', timezone: LA };

  test('Thursday 5:30 PM PT is bookable (Friday off must not start at Thu 5 PM PT)', async () => {
    installDb({ user, timeOff: fridayOff, windows: [{ weekday: 4, start_minutes: 17 * 60, end_minutes: 19 * 60 }] });
    const res = await book('2030-09-27T00:30:00Z'); // Thu 17:30 PDT
    expect(res.status).toBe(201);
  });

  test('Friday 6 PM PT is blocked (local Friday runs to midnight PT)', async () => {
    installDb({ user, timeOff: fridayOff, windows: [{ weekday: 5, start_minutes: 17 * 60, end_minutes: 20 * 60 }] });
    const res = await book('2030-09-28T01:00:00Z'); // Fri 18:00 PDT
    expect(res.status).toBe(409);
  });

  test('the time-off SQL widens the date filter and resolves a timezone', async () => {
    installDb({ user, timeOff: [], windows: [{ weekday: 4, start_minutes: 17 * 60, end_minutes: 19 * 60 }] });
    await book('2030-09-27T00:30:00Z');
    const sql = pool.query.mock.calls.map(c => c[0]).find(s => /FROM time_off_requests/.test(s));
    expect(sql).not.toMatch(/AT TIME ZONE 'UTC'/);
    expect(sql).toMatch(/company_timezone/);
    expect(sql).toMatch(/\$2::date - 1/);
    expect(sql).toMatch(/\$3::date \+ 1/);
  });
});

describe('final double-booking check honours buffer_after', () => {
  test('before=0, after=30: 8:30–9:30 exists → 9:45 is refused', async () => {
    installDb({
      user: { id: 5, full_name: 'Lee', timezone: 'UTC' },
      windows: [{ weekday: 1, start_minutes: 8 * 60, end_minutes: 12 * 60 }], // Mon
      existing: [{ start: '2030-09-23T08:30:00Z', end: '2030-09-23T09:30:00Z' }],
      at: { buffer_before_min: 0, buffer_after_min: 30 },
    });
    const res = await book('2030-09-23T09:45:00Z');
    expect(res.status).toBe(409);
  });

  test('…but 10:00 (after the buffer) is fine', async () => {
    installDb({
      user: { id: 5, full_name: 'Lee', timezone: 'UTC' },
      windows: [{ weekday: 1, start_minutes: 8 * 60, end_minutes: 12 * 60 }],
      existing: [{ start: '2030-09-23T08:30:00Z', end: '2030-09-23T09:30:00Z' }],
      at: { buffer_before_min: 0, buffer_after_min: 30 },
    });
    const res = await book('2030-09-23T10:00:00Z');
    expect(res.status).toBe(201);
  });
});

describe('booking emails format the time in a named zone', () => {
  test('client + assignee emails show "9:00 AM PDT", not UTC wall time', async () => {
    installDb({ user: { id: 5, full_name: 'Lee', timezone: LA }, windows: [] });
    await route.sendBookingEmails({
      apt: { name: 'Site Visit', location_kind: 'onsite' }, appointmentId: 77,
      slotStart: new Date('2030-09-26T16:00:00Z'), durationMinutes: 60,
      clientName: 'Jane', clientEmail: 'jane@x.com', assignee: { id: 5, full_name: 'Lee', timezone: LA },
      manageToken: 't', companyId: 'co-1',
    });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    for (const [, , html] of sendEmail.mock.calls) {
      expect(html).toMatch(/9:00\sAM PDT/);
      expect(html).not.toMatch(/4:00:00\sPM/);
    }
  });
});
