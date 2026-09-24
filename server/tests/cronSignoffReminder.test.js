// Friday sign-off reminders: the once-per-day guard is a persisted, atomic
// claim (companies.signoff_reminder_sent_on) — a restart on a Friday must not
// re-push every worker.
jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../push', () => ({ sendPushToUser: jest.fn().mockResolvedValue(), sendPushToCompanyAdmins: jest.fn().mockResolvedValue() }));
jest.mock('../routes/inbox', () => ({ createInboxItemBatch: jest.fn() }));
jest.mock('../services/demoClockRollover', () => ({ rolloverStaleDemoClocks: jest.fn() }));
jest.mock('../utils/projectHourLimits', () => ({ reconcileStaleHourLimits: jest.fn() }));

const pool = require('../db');
const { sendPushToUser } = require('../push');
const { sendSignoffReminders, getDateInTimezone } = require('../cron');

// Fake DB: one company with one unsigned worker; the claim UPDATE succeeds only
// if the stored date differs (mirrors the SQL's IS DISTINCT FROM).
function installDb(state) {
  pool.query.mockImplementation(async (sql, params) => {
    if (/SELECT DISTINCT company_id FROM time_entries/.test(sql)) return { rows: [{ company_id: 7 }] };
    if (/FROM settings/.test(sql)) return { rows: [{ key: 'company_timezone', value: 'UTC' }] };
    if (/UPDATE companies SET signoff_reminder_sent_on/.test(sql)) {
      if (state.sentOn === params[1]) return { rowCount: 0, rows: [] };
      state.sentOn = params[1];
      return { rowCount: 1, rows: [{ id: 7 }] };
    }
    if (/SELECT DISTINCT user_id FROM time_entries/.test(sql)) return { rows: [{ user_id: 42 }] };
    return { rows: [], rowCount: 0 };
  });
}

describe('sendSignoffReminders', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-09-25T15:00:00Z')); // a Friday, 3pm UTC
    pool.query.mockReset();
    sendPushToUser.mockClear();
  });
  afterEach(() => jest.useRealTimers());

  test('sends once, and a second run the same Friday (e.g. after a restart) does not re-push', async () => {
    const state = { sentOn: null };
    installDb(state);
    await sendSignoffReminders();
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    expect(state.sentOn).toBe('2026-09-25');

    // Fresh process memory is irrelevant now — the claim lives in the DB.
    await sendSignoffReminders();
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
  });

  test('the claim uses the company-local date', () => {
    expect(getDateInTimezone('America/Los_Angeles')).toBe('2026-09-25');
    jest.setSystemTime(new Date('2026-09-26T03:00:00Z')); // Sat UTC, still Fri in LA
    expect(getDateInTimezone('America/Los_Angeles')).toBe('2026-09-25');
    expect(getDateInTimezone('UTC')).toBe('2026-09-26');
  });

  test('does not send on a non-Friday', async () => {
    jest.setSystemTime(new Date('2026-09-24T15:00:00Z')); // Thursday
    installDb({ sentOn: null });
    await sendSignoffReminders();
    expect(sendPushToUser).not.toHaveBeenCalled();
  });
});
