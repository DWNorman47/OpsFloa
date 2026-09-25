/**
 * services/qbo.js unit tests (network + DB mocked).
 *  - pushTimeActivity must never send Minutes=60 (7.9958h used to become 7h 60m).
 *  - timeActivityHours: the hours every TimeActivity path pushes (manual push,
 *    retry, auto-push on approval) are the ROUNDED, break-net paid hours.
 */

jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));
jest.mock('../services/encryption', () => ({ encrypt: x => x, decrypt: x => x }));
jest.mock('../email', () => ({ sendEmail: jest.fn() }));

const axios = require('axios');
const pool = require('../db');
const qbo = require('../services/qbo');

beforeEach(() => {
  pool.query.mockReset();
  axios.post.mockReset();
  pool.query.mockImplementation(async (sql) => {
    if (/qbo_access_token/.test(sql)) return { rows: [{ qbo_access_token: 'tok', qbo_token_expires_at: new Date(Date.now() + 3600e3) }] };
    if (/qbo_realm_id/.test(sql)) return { rows: [{ qbo_realm_id: 'realm-1' }] };
    return { rows: [] };
  });
  axios.post.mockResolvedValue({ headers: {}, data: { TimeActivity: { Id: 'TA-1' } } });
});

describe('pushTimeActivity hours/minutes split', () => {
  const sent = async (hours) => {
    await qbo.pushTimeActivity('c1', { employeeId: 'E1', customerId: 'C1', workDate: '2026-04-01', hours });
    return axios.post.mock.calls[axios.post.mock.calls.length - 1][1];
  };

  test('7.9958h → 8h 0m (was 7h 60m)', async () => {
    expect(await sent(7.9958)).toMatchObject({ Hours: 8, Minutes: 0 });
  });
  test('7.75h → 7h 45m', async () => {
    expect(await sent(7.75)).toMatchObject({ Hours: 7, Minutes: 45 });
  });
  test('0.999h → 1h 0m', async () => {
    expect(await sent(0.999)).toMatchObject({ Hours: 1, Minutes: 0 });
  });
});

describe('createBill exact line amounts', () => {
  beforeEach(() => axios.post.mockResolvedValue({ headers: {}, data: { Bill: { Id: 'B-1' } } }));
  const post = async (line) => {
    await qbo.createBill('c1', { vendorId: 'V', lines: [{ type: 'item', itemId: 'I', description: 'x', ...line }] });
    return axios.post.mock.calls[axios.post.mock.calls.length - 1][1].Line[0];
  };

  test('qty × 2-dp price reproduces the amount → posted as qty × price', async () => {
    const l = await post({ qty: 6, unitPrice: 20, amount: 120 });
    expect(l).toMatchObject({ Amount: 120, ItemBasedExpenseLineDetail: { Qty: 6, UnitPrice: 20 } });
  });

  test('otherwise posted as 1 × exact amount with the hours kept in the text', async () => {
    // 7h59m at $30 = $239.50 exactly; 7.98 × any 2-dp price can't make $239.50.
    const l = await post({ qty: 7 + 59 / 60, unitPrice: 30, amount: 239.5 });
    expect(l).toMatchObject({ Amount: 239.5, ItemBasedExpenseLineDetail: { Qty: 1, UnitPrice: 239.5 } });
    expect(l.Description).toMatch(/7\.98 h/);
  });

  test('lines without an amount keep the old qty × price behaviour', async () => {
    const l = await post({ qty: 8, unitPrice: 45 });
    expect(l).toMatchObject({ Amount: 360, ItemBasedExpenseLineDetail: { Qty: 8, UnitPrice: 45 } });
  });

  test('DocNumber + PrivateNote carry the request id so an unconfirmed bill can be found', async () => {
    await qbo.createBill('c1', { vendorId: 'V', memo: 'OpsFloa bill · ref ops-bill-abc', docNumber: 'OF-0123456789abcdef01XYZ', requestId: 'ops-bill-abc',
      lines: [{ type: 'item', itemId: 'I', qty: 1, unitPrice: 1 }] });
    const body = axios.post.mock.calls[axios.post.mock.calls.length - 1][1];
    expect(body.DocNumber).toBe('OF-0123456789abcdef01'); // QuickBooks caps DocNumber at 21
    expect(body.PrivateNote).toContain('ops-bill-abc');
  });
});

describe('timeActivityHours', () => {
  const ROUND15 = { hours_rules: JSON.stringify({ enabled: true, rules: [
    { id: 'r1', type: 'round', when: { kind: 'every_day' }, edge: 'both', reference: 'clock', direction: 'nearest', intervalMin: 15 },
  ] }) };

  test('uses the rounded punch, net of break', () => {
    const e = { id: 1, user_id: 5, work_date: '2026-04-01', wage_type: 'regular', start_time: '07:08:00', end_time: '15:37:00', break_minutes: 30 };
    const [r] = qbo.timeActivityHours([e], ROUND15, { 5: null });
    // raw: 8.4833h − 0.5 = 7.9833h; rounded 07:15–15:30 = 8.25h − 0.5 = 7.75h
    expect(r.hours).toBeCloseTo(7.75, 6);
    expect(r.workDate).toBe('2026-04-01');
  });

  test('a pg Date work_date becomes the local YYYY-MM-DD (not a UTC-shifted day)', () => {
    const e = { id: 1, user_id: 5, work_date: new Date(2026, 3, 1), wage_type: 'regular', start_time: '08:00:00', end_time: '16:00:00', break_minutes: 0 };
    const [r] = qbo.timeActivityHours([e], {}, {});
    expect(r.workDate).toBe('2026-04-01');
    expect(r.hours).toBeCloseTo(8, 6);
  });

  test('a break longer than the shift clamps at 0', () => {
    const e = { id: 1, user_id: 5, work_date: '2026-04-01', wage_type: 'regular', start_time: '22:00:00', end_time: '02:00:00', break_minutes: 600 };
    expect(qbo.timeActivityHours([e], {}, {})[0].hours).toBe(0);
  });
});

describe('disconnect email escapes the admin name', () => {
  test('a full_name carrying HTML is escaped in the notification body', async () => {
    const { sendEmail } = require('../email');
    sendEmail.mockReset();
    pool.query.mockImplementation(async (sql) => {
      if (/qbo_access_token, qbo_token_expires_at/.test(sql)) return { rows: [{ qbo_access_token: 'tok', qbo_token_expires_at: new Date(Date.now() + 3600e3) }] };
      if (/qbo_realm_id/.test(sql)) return { rows: [{ qbo_realm_id: 'realm-1' }] };
      if (/notify_qbo_disconnect/.test(sql)) return { rows: [{ value: '1' }] };
      if (/FROM users/.test(sql)) return { rows: [{ email: 'a@x.test', full_name: '<img src=x onerror=alert(1)>' }] };
      return { rows: [] };
    });
    axios.get.mockRejectedValueOnce(Object.assign(new Error('401'), { response: { status: 401 } }));
    await expect(qbo.listCustomers('c1')).rejects.toMatchObject({ code: 'qbo_auth_expired' });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const html = sendEmail.mock.calls[0][2];
    expect(html).not.toMatch(/<img/);
    expect(html).toMatch(/&lt;img/);
  });
});
