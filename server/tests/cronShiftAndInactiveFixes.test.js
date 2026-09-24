/**
 * Cron fixes:
 *  - shift reminders target the COMPANY-LOCAL tomorrow and claim rows before pushing
 *  - booking reminder emails format the time in a named zone
 *  - inactive-worker alerts parse notification_inactive_days per company (a bad value in
 *    one company must not stop alerts for all of them)
 */

jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../push', () => ({ sendPushToUser: jest.fn().mockResolvedValue(), sendPushToCompanyAdmins: jest.fn().mockResolvedValue() }));
jest.mock('../routes/inbox', () => ({ createInboxItemBatch: jest.fn() }));
jest.mock('../services/demoClockRollover', () => ({ rolloverStaleDemoClocks: jest.fn() }));
jest.mock('../utils/projectHourLimits', () => ({ reconcileStaleHourLimits: jest.fn() }));
jest.mock('../email', () => ({ sendEmail: jest.fn().mockResolvedValue() }));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('node-cron', () => ({ schedule: jest.fn() }));

const pool = require('../db');
const { sendPushToUser, sendPushToCompanyAdmins } = require('../push');
const { sendEmail } = require('../email');
const cron = require('../cron');

let order;
beforeEach(() => {
  pool.query.mockReset();
  sendPushToUser.mockClear();
  sendPushToCompanyAdmins.mockClear();
  sendEmail.mockClear();
  order = [];
  sendPushToUser.mockImplementation(async () => { order.push('push'); });
});
afterEach(() => { jest.useRealTimers(); });

describe('sendShiftReminders', () => {
  test('LA company at 7 PM local (02:00 UTC next day) reminds for LOCAL tomorrow, claiming first', async () => {
    jest.useFakeTimers({ now: new Date('2030-09-27T02:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
    // Local LA time: Thu 2030-09-26 19:00 → local tomorrow = 2030-09-27 (UTC "tomorrow" is 09-28).
    const shiftSqls = [];
    pool.query.mockImplementation(async (sql, params) => {
      if (/SELECT DISTINCT company_id FROM shifts/.test(sql)) return { rows: [{ company_id: 'co-la' }] };
      if (/FROM settings/.test(sql)) return { rows: [{ key: 'company_timezone', value: 'America/Los_Angeles' }, { key: 'shift_reminder_hour', value: '19' }] };
      if (/shifts/.test(sql)) {
        shiftSqls.push({ sql, params });
        if (/UPDATE shifts/.test(sql)) order.push('claim');
        return { rows: [{ id: 1, user_id: 9, start_time: '07:00:00', project_name: 'Job' }] };
      }
      return { rows: [] };
    });
    await cron.sendShiftReminders();
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    const claim = shiftSqls.find(s => /UPDATE shifts/.test(s.sql));
    expect(claim).toBeTruthy();
    expect(claim.sql).toMatch(/RETURNING/);
    expect(claim.params).toEqual(['co-la', '2030-09-27']);
    expect(shiftSqls.some(s => /CURRENT_DATE \+ 1/.test(s.sql) && /s\.company_id = \$1/.test(s.sql))).toBe(false);
    expect(order).toEqual(['claim', 'push']); // claimed BEFORE sending
  });
});

describe('sendBookingReminders', () => {
  test('client 24h reminder shows the company-local time with zone', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (/reminder_client_24h_at IS NULL\s+AND a\.scheduled_at BETWEEN/.test(sql)) return { rows: [{ id: 1 }] };
      if (/UPDATE appointments\s+SET reminder_client_24h_at = NOW\(\)/.test(sql)) return { rowCount: 1, rows: [{ id: 1 }] };
      if (/FROM appointments a\s+JOIN appointment_types t/.test(sql) && /company_name/.test(sql)) {
        return { rows: [{ id: 1, client_email: 'c@x.com', client_name: 'Jane', scheduled_at: '2030-09-26T16:00:00Z',
          duration_minutes: 60, type_name: 'Visit', assignee_name: 'Lee', company_name: 'Acme',
          company_timezone: 'America/Los_Angeles', assignee_timezone: null }] };
      }
      return { rows: [] };
    });
    await cron.sendBookingReminders();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][2]).toMatch(/9:00\sAM PDT/);
  });
});

describe('inactive worker alerts', () => {
  const { checkInactiveWorkers, parseInactiveDays } = require('../jobs/inactiveWorkers');

  test('parseInactiveDays', () => {
    expect(parseInactiveDays(null)).toBe(3);
    expect(parseInactiveDays('')).toBe(3);
    expect(parseInactiveDays('5')).toBe(5);
    expect(parseInactiveDays('5.0')).toBe(5);
    expect(parseInactiveDays('3.5')).toBeNull();
    expect(parseInactiveDays('0')).toBeNull();
    expect(parseInactiveDays('abc')).toBeNull();
  });

  test('a bad value in one company does not stop alerts for the others', async () => {
    const inactiveCalls = [];
    pool.query.mockImplementation(async (sql, params) => {
      if (/FROM companies c/.test(sql)) {
        // A real DB would throw on value::int for '3.5' — refuse any SQL that casts.
        if (/value::int/.test(sql)) throw new Error('invalid input syntax for type integer: "3.5"');
        return { rows: [
          { id: 'bad', name: 'Bad Co', inactive_days_raw: '3.5', feature_inactive_alerts: '1' },
          { id: 'good', name: 'Good Co', inactive_days_raw: '5', feature_inactive_alerts: '1' },
        ] };
      }
      if (/HAVING MAX\(te\.work_date\)/.test(sql)) {
        inactiveCalls.push(params);
        return { rowCount: 1, rows: [{ id: 1, full_name: 'Sam', last_entry_date: null }] };
      }
      return { rowCount: 0, rows: [] };
    });
    await checkInactiveWorkers();
    expect(inactiveCalls).toEqual([['good', 5]]);
    expect(sendPushToCompanyAdmins).toHaveBeenCalledTimes(1);
    expect(sendPushToCompanyAdmins.mock.calls[0][0]).toBe('good');
  });
});
