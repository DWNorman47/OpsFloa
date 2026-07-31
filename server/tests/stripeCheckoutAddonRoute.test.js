/**
 * POST /stripe/checkout-addon — buy a single add-on with no base plan.
 *
 * The hotfix that lets a company buy Plan Room / Takeoff standalone. This is a
 * money path, so the guards are pinned: only the two sellable add-ons, a real
 * price must be configured, and a company that already has a live subscription
 * is sent to the one-click /addon instead of getting a second subscription.
 */

const mockSessionCreate = jest.fn();
const mockCustomerCreate = jest.fn();
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({
  checkout: { sessions: { create: mockSessionCreate } },
  customers: { create: mockCustomerCreate },
})));

let mockUser;
jest.mock('../middleware/auth', () => ({
  requireAdmin:  (req, _res, next) => { req.user = mockUser; next(); },
  requirePerm:   () => (req, _res, next) => { req.user = mockUser; next(); },
}));
jest.mock('../db', () => ({ query: jest.fn() }));

process.env.STRIPE_SECRET_KEY = 'sk_test';
process.env.STRIPE_PRICE_PLANROOM = 'price_planroom_m';
process.env.STRIPE_PRICE_PLANROOM_ANNUAL = 'price_planroom_y';
process.env.STRIPE_PRICE_TAKEOFF = 'price_takeoff_m';
process.env.STRIPE_PRICE_TAKEOFF_ANNUAL = 'price_takeoff_y';
process.env.STRIPE_PRICE_STORM = 'price_storm_m';
process.env.STRIPE_PRICE_ROOF = 'price_roof_m';
process.env.STRIPE_PRICE_ROOF_ANNUAL = 'price_roof_y';
process.env.APP_URL = 'https://app.test';

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const stripeRoute = require('../routes/stripe');

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.log = { error: jest.fn(), warn: jest.fn(), info: jest.fn() }; next(); });
  a.use('/api/stripe', stripeRoute);
  return a;
}

// A free company with a Stripe customer already but no subscription, and no
// Plan Room (so Takeoff-alone is the blocked case unless stated otherwise).
function companyRow(over = {}) {
  return {
    id: 'co-1', name: 'Acme', email: 'a@acme.test',
    stripe_customer_id: 'cus_1', stripe_subscription_id: null,
    subscription_status: 'free', trial_ends_at: null, addon_planroom: false, ...over,
  };
}

function post(body) {
  return request(app()).post('/api/stripe/checkout-addon').send(body);
}

beforeEach(() => {
  mockUser = { id: 1, company_id: 'co-1', role: 'admin' };
  pool.query.mockReset();
  mockSessionCreate.mockReset().mockResolvedValue({ url: 'https://checkout.test/session' });
  mockCustomerCreate.mockReset();
});

describe('the add-on allowlist', () => {
  test.each([
    ['qbo', 'not sellable standalone — needs a plan'],
    ['storm', 'not for sale at all'],
    ['bogus', 'unknown'],
    [undefined, 'missing'],
  ])('rejects %s (%s)', async (addon) => {
    const res = await post({ addon });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Unknown add-on');
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  test('accepts planroom', async () => {
    pool.query.mockResolvedValue({ rows: [companyRow()] });
    const res = await post({ addon: 'planroom' });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://checkout.test/session');
  });
  // Takeoff on its own is covered by the "requires Plan Room" block below —
  // it's only accepted alongside Plan Room or when Plan Room is already owned.
});

describe('happy path', () => {
  test('single add-on → subscription with exactly that one line item', async () => {
    pool.query.mockResolvedValue({ rows: [companyRow()] });
    await post({ addon: 'planroom' });

    const arg = mockSessionCreate.mock.calls[0][0];
    expect(arg.mode).toBe('subscription');
    expect(arg.line_items).toEqual([{ price: 'price_planroom_m', quantity: 1 }]);
    expect(arg.customer).toBe('cus_1');
    expect(arg.subscription_data.metadata.company_id).toBe('co-1');
  });

  test('both add-ons → ONE subscription with two line items, not two subscriptions', async () => {
    pool.query.mockResolvedValue({ rows: [companyRow()] });
    await post({ addons: ['planroom', 'takeoff'] });

    expect(mockSessionCreate).toHaveBeenCalledTimes(1);
    expect(mockSessionCreate.mock.calls[0][0].line_items).toEqual([
      { price: 'price_planroom_m', quantity: 1 },
      { price: 'price_takeoff_m', quantity: 1 },
    ]);
  });

  test('non-sellable picks are dropped from the array, sellable ones kept', async () => {
    pool.query.mockResolvedValue({ rows: [companyRow()] });
    await post({ addons: ['qbo', 'storm', 'planroom'] });
    expect(mockSessionCreate.mock.calls[0][0].line_items).toEqual([{ price: 'price_planroom_m', quantity: 1 }]);
  });

  test('an array of only non-sellable add-ons is rejected', async () => {
    const res = await post({ addons: ['qbo', 'storm'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Unknown add-on');
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  test('annual uses the annual price', async () => {
    // Owns Plan Room, so Takeoff-alone is allowed — isolates the annual pick.
    pool.query.mockResolvedValue({ rows: [companyRow({ addon_planroom: true })] });
    await post({ addon: 'takeoff', annual: true });
    expect(mockSessionCreate.mock.calls[0][0].line_items).toEqual([{ price: 'price_takeoff_y', quantity: 1 }]);
  });

  test('creates a Stripe customer first when the company has none', async () => {
    pool.query.mockImplementation((sql) => {
      if (/FROM companies c JOIN users/.test(sql)) return Promise.resolve({ rows: [companyRow({ stripe_customer_id: null })] });
      return Promise.resolve({ rows: [] }); // the UPDATE stripe_customer_id
    });
    mockCustomerCreate.mockResolvedValue({ id: 'cus_new' });

    const res = await post({ addon: 'planroom' });
    expect(res.status).toBe(200);
    expect(mockCustomerCreate).toHaveBeenCalledTimes(1);
    expect(mockSessionCreate.mock.calls[0][0].customer).toBe('cus_new');
  });

  test('a trialing company pre-buys without being charged until trial end', async () => {
    const future = new Date(Date.now() + 7 * 86400000).toISOString();
    pool.query.mockResolvedValue({ rows: [companyRow({ subscription_status: 'trial', trial_ends_at: future })] });
    await post({ addon: 'planroom' });
    expect(mockSessionCreate.mock.calls[0][0].subscription_data.trial_end).toEqual(expect.any(Number));
  });
});

describe('Takeoff requires Plan Room', () => {
  test('Takeoff alone, Plan Room not owned → rejected', async () => {
    pool.query.mockResolvedValue({ rows: [companyRow()] }); // addon_planroom: false
    const res = await post({ addons: ['takeoff'] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('planroom_required');
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  test('Takeoff + Plan Room together → allowed, one subscription', async () => {
    pool.query.mockResolvedValue({ rows: [companyRow()] });
    const res = await post({ addons: ['takeoff', 'planroom'] });
    expect(res.status).toBe(200);
    expect(mockSessionCreate.mock.calls[0][0].line_items).toEqual([
      { price: 'price_takeoff_m', quantity: 1 },
      { price: 'price_planroom_m', quantity: 1 },
    ]);
  });

  test('Takeoff alone but Plan Room already owned → allowed', async () => {
    pool.query.mockResolvedValue({ rows: [companyRow({ addon_planroom: true })] });
    const res = await post({ addons: ['takeoff'] });
    expect(res.status).toBe(200);
    expect(mockSessionCreate.mock.calls[0][0].line_items).toEqual([{ price: 'price_takeoff_m', quantity: 1 }]);
  });
});

// Roof Measurement is standalone-sellable (unlike Storm) but rides on Plan Room —
// the standalone roof door is Plan Room + Roof.
describe('Roof Measurement requires Plan Room', () => {
  test('Roof alone, Plan Room not owned → rejected', async () => {
    pool.query.mockResolvedValue({ rows: [companyRow()] }); // addon_planroom: false
    const res = await post({ addons: ['roof'] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('planroom_required');
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  test('Roof + Plan Room together → allowed, one subscription with both items', async () => {
    pool.query.mockResolvedValue({ rows: [companyRow()] });
    const res = await post({ addons: ['roof', 'planroom'] });
    expect(res.status).toBe(200);
    expect(mockSessionCreate.mock.calls[0][0].line_items).toEqual([
      { price: 'price_roof_m', quantity: 1 },
      { price: 'price_planroom_m', quantity: 1 },
    ]);
  });

  test('Roof alone but Plan Room already owned → allowed', async () => {
    pool.query.mockResolvedValue({ rows: [companyRow({ addon_planroom: true })] });
    const res = await post({ addon: 'roof' });
    expect(res.status).toBe(200);
    expect(mockSessionCreate.mock.calls[0][0].line_items).toEqual([{ price: 'price_roof_m', quantity: 1 }]);
  });

  test('annual uses the annual roof price', async () => {
    pool.query.mockResolvedValue({ rows: [companyRow({ addon_planroom: true })] });
    await post({ addon: 'roof', annual: true });
    expect(mockSessionCreate.mock.calls[0][0].line_items).toEqual([{ price: 'price_roof_y', quantity: 1 }]);
  });
});

describe('guards', () => {
  test('a live subscription is routed to /addon, not a second subscription', async () => {
    pool.query.mockResolvedValue({ rows: [companyRow({ stripe_subscription_id: 'sub_1', subscription_status: 'active' })] });
    const res = await post({ addon: 'planroom' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('has_subscription');
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  test('a stale sub id from a CANCELED sub does not block a fresh standalone buy', async () => {
    pool.query.mockResolvedValue({ rows: [companyRow({ stripe_subscription_id: 'sub_old', subscription_status: 'canceled' })] });
    const res = await post({ addon: 'planroom' });
    expect(res.status).toBe(200);
  });

  test('unconfigured price → clear 400, no Stripe call', async () => {
    const saved = process.env.STRIPE_PRICE_PLANROOM;
    delete process.env.STRIPE_PRICE_PLANROOM;
    try {
      const res = await post({ addon: 'planroom' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Add-on price is not configured.');
      expect(mockSessionCreate).not.toHaveBeenCalled();
    } finally {
      process.env.STRIPE_PRICE_PLANROOM = saved;
    }
  });
});
