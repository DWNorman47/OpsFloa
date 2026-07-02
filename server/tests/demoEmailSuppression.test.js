// Regression tests for the demo-tenant email suppression (security finding:
// the public demo login must not be usable as a SendGrid spam relay).

const mockSend = jest.fn().mockResolvedValue({ data: { id: 'test' }, error: null });
jest.mock('resend', () => ({ Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockSend } })) }));
jest.mock('../db', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));

// Control the demo context per-test by mocking getStore().
const mockGetStore = jest.fn();
jest.mock('../demoMode', () => ({ getStore: mockGetStore }));

// Force "real" send mode so the only thing stopping a send is the demo guard.
process.env.NODE_ENV = 'production';
process.env.RESEND_API_KEY = 're_test';

const { sendEmail } = require('../email');

beforeEach(() => {
  mockSend.mockClear();
  mockGetStore.mockReset();
});

describe('sendEmail demo suppression', () => {
  test('suppresses the send and flags the request when acting company is demo', async () => {
    const store = { isDemo: true, emailSuppressed: false };
    mockGetStore.mockReturnValue(store);

    const result = await sendEmail('client@example.com', 'Estimate', '<p>hi</p>');

    expect(mockSend).not.toHaveBeenCalled();          // no real email left the building
    expect(store.emailSuppressed).toBe(true);          // request flagged → client popup
    expect(result).toEqual({ suppressed: 'demo' });
  });

  test('sends normally when the acting company is NOT demo', async () => {
    mockGetStore.mockReturnValue({ isDemo: false, emailSuppressed: false });

    await sendEmail('client@example.com', 'Estimate', '<p>hi</p>');

    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test('sends normally outside any request context (cron / no ALS store)', async () => {
    mockGetStore.mockReturnValue(undefined);

    await sendEmail('client@example.com', 'Estimate', '<p>hi</p>');

    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test('no recipient is a no-op regardless of demo state', async () => {
    mockGetStore.mockReturnValue({ isDemo: true, emailSuppressed: false });
    const result = await sendEmail('', 'x', 'y');
    expect(mockSend).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: 'no_recipient' });
  });

  test('returns { ok: false } when the provider rejects the send', async () => {
    mockGetStore.mockReturnValue(undefined);
    mockSend.mockResolvedValueOnce({ data: null, error: { message: 'domain not verified' } });
    const result = await sendEmail('client@example.com', 'x', '<p>y</p>');
    expect(result).toEqual({ ok: false, error: { message: 'domain not verified' } });
  });
});
