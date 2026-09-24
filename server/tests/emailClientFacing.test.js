/**
 * email.js — client-facing sender identity + trial abuse cap (security round 2):
 *   - a caller-supplied From name renders as "<Company> via OpsFloa" (quoted,
 *     header-breaking chars stripped, never doubled);
 *   - a CR/LF in any subject is flattened before it reaches the provider;
 *   - opts.clientCompanyId: a TRIAL company past TRIAL_CLIENT_EMAIL_DAILY_CAP
 *     sends nothing ({ skipped: 'trial_daily_cap' }); paying companies and a
 *     counter failure (fail-open) still send.
 */

const mockSend = jest.fn().mockResolvedValue({ data: { id: 'x' }, error: null });
jest.mock('resend', () => ({ Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockSend } })) }));
jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../demoMode', () => ({ getStore: () => undefined }));
jest.mock('../services/emailSuppression', () => ({ isSuppressed: jest.fn().mockResolvedValue(false) }));

process.env.NODE_ENV = 'production'; // "real" mode: the provider is called directly
process.env.RESEND_API_KEY = 're_test';
process.env.EMAIL_FROM = 'info@opsfloa.com';

const pool = require('../db');
const { sendEmail, fromHeader } = require('../email');

beforeEach(() => {
  mockSend.mockClear();
  pool.query.mockReset();
  delete process.env.TRIAL_CLIENT_EMAIL_DAILY_CAP;
});

describe('fromHeader', () => {
  test('"<Company> via OpsFloa" on the verified address', () => {
    expect(fromHeader('Acme Roofing')).toBe('"Acme Roofing via OpsFloa" <info@opsfloa.com>');
  });
  test('quotes / angle brackets / CRLF stripped, suffix not doubled', () => {
    expect(fromHeader('Evil" <ceo@bank.com>\r\nBcc: x')).toBe('"Evil ceo@bank.com Bcc: x via OpsFloa" <info@opsfloa.com>');
    expect(fromHeader('Acme via OpsFloa')).toBe('"Acme via OpsFloa" <info@opsfloa.com>');
  });
  test('no name → the plain OpsFloa sender', () => {
    expect(fromHeader(null)).toBe('OpsFloa <info@opsfloa.com>');
  });
});

describe('sendEmail', () => {
  test('flattens CR/LF in the subject', async () => {
    await sendEmail('a@b.co', 'Hello\r\nBcc: victim@x.co', '<p>x</p>');
    expect(mockSend.mock.calls[0][0].subject).toBe('Hello Bcc: victim@x.co');
  });

  test('client-facing send uses the "via OpsFloa" From', async () => {
    pool.query.mockResolvedValue({ rows: [] }); // not a trial company
    await sendEmail('client@x.co', 'Invoice', '<p>x</p>', undefined, { fromName: 'Acme', replyTo: 'me@acme.co', clientCompanyId: 'co-1' });
    const msg = mockSend.mock.calls[0][0];
    expect(msg.from).toBe('"Acme via OpsFloa" <info@opsfloa.com>');
    expect(msg.replyTo).toBe('me@acme.co');
  });

  test('trial company under the cap sends; over it is skipped', async () => {
    process.env.TRIAL_CLIENT_EMAIL_DAILY_CAP = '3';
    pool.query.mockResolvedValueOnce({ rows: [{ sent: 3 }] });
    expect((await sendEmail('c@x.co', 'Invoice', '<p/>', undefined, { clientCompanyId: 'co-1' })).ok).toBe(true);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE companies/);
    expect(sql).toMatch(/subscription_status = 'trial'/);
    expect(params).toEqual(['co-1']);

    pool.query.mockResolvedValueOnce({ rows: [{ sent: 4 }] });
    const r = await sendEmail('c@x.co', 'Invoice', '<p/>', undefined, { clientCompanyId: 'co-1' });
    expect(r).toEqual({ skipped: 'trial_daily_cap' });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test('default cap is 50', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ sent: 50 }] });
    expect((await sendEmail('c@x.co', 'I', '<p/>', undefined, { clientCompanyId: 'co-1' })).ok).toBe(true);
    pool.query.mockResolvedValueOnce({ rows: [{ sent: 51 }] });
    expect(await sendEmail('c@x.co', 'I', '<p/>', undefined, { clientCompanyId: 'co-1' })).toEqual({ skipped: 'trial_daily_cap' });
  });

  test('a counter failure fails OPEN (the invoice email still goes)', async () => {
    pool.query.mockRejectedValueOnce(new Error('db down'));
    expect((await sendEmail('c@x.co', 'I', '<p/>', undefined, { clientCompanyId: 'co-1' })).ok).toBe(true);
  });

  test('internal (non client-facing) sends never touch the counter', async () => {
    await sendEmail('admin@x.co', 'Alert', '<p/>');
    expect(pool.query).not.toHaveBeenCalled();
  });
});
