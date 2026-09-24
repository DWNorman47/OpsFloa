/**
 * POST /stripe/checkout — the base-plan subscription checkout.
 *
 * Money path. The critical guard: a company that already has a LIVE Stripe
 * subscription must NOT be able to create a second, parallel subscription (the
 * accidental double-purchase that costs a refund). The guard is verified against
 * Stripe (not just the DB flag) so a stale/canceled id doesn't wrongly block and
 * a webhook lag can't let a duplicate through.
 */

const mockSessionCreate = jest.fn();
const mockCustomerCreate = jest.fn();
const mockSubRetrieve = jest.fn();
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({
  checkout: { sessions: { create: mockSessionCreate } },
  customers: { create: mockCustomerCreate },
  subscriptions: { retrieve: mockSubRetrieve },
})));

let mockUser;
jest.mock('../middleware/auth', () => ({
  requireAdmin: (req, _res, next) => { req.user = mockUser; next(); },
  requirePerm:  () => (req, _res, next) => { req.user = mockUser; next(); },
}));
jest.mock('../db', () => ({ query: jest.fn() }));

process.env.STRIPE_SECRET_KEY = 'sk_test';
process.env.APP_URL = 'https://app.test';
// Configured prices: the route maps plan/interval/add-on NAMES onto these and
// never trusts a client-supplied price id or seat count.
process.env.STRIPE_PRICE_STARTER = 'price_starter';
process.env.STRIPE_PRICE_STARTER_ANNUAL = 'price_starter_y';
process.env.STRIPE_PRICE_BUSINESS_BASE = 'price_biz_m';
process.env.STRIPE_PRICE_BUSINESS_BASE_ANNUAL = 'price_biz_y';
process.env.STRIPE_PRICE_BUSINESS_WORKER = 'price_worker_m';
process.env.STRIPE_PRICE_BUSINESS_WORKER_ANNUAL = 'price_worker_y';
process.env.STRIPE_PRICE_QBO = 'price_qbo_m';
process.env.STRIPE_PRICE_QBO_ANNUAL = 'price_qbo_y';
process.env.STRIPE_PRICE_PLANROOM = 'price_pr_m';
process.env.STRIPE_PRICE_PLANROOM_ANNUAL = 'price_pr_y';

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

function companyRow(over = {}) {
  return {
    id: 'co-1', email: 'admin@test.com', name: 'Acme',
    stripe_customer_id: 'cus_1', stripe_subscription_id: null,
    subscription_status: 'free', trial_ends_at: null,
    addon_planroom: false, addon_takeoff: false, ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { id: 1, company_id: 'co-1', role: 'admin' };
  mockSessionCreate.mockResolvedValue({ url: 'https://checkout.stripe/session' });
});

describe('POST /stripe/checkout — double-subscription guard', () => {
  test('blocks a second subscription when a LIVE one already exists', async () => {
    pool.query.mockResolvedValue({ rows: [companyRow({ stripe_subscription_id: 'sub_live' })] });
    mockSubRetrieve.mockResolvedValue({ id: 'sub_live', status: 'active' });

    const res = await request(app()).post('/api/stripe/checkout').send({ price_id: 'price_starter' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('has_subscription');
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  test('blocks when the existing subscription is TRIALING (a pre-purchased plan is still live)', async () => {
    pool.query.mockResolvedValue({ rows: [companyRow({ stripe_subscription_id: 'sub_trial' })] });
    mockSubRetrieve.mockResolvedValue({ id: 'sub_trial', status: 'trialing' });

    const res = await request(app()).post('/api/stripe/checkout').send({ price_id: 'price_starter' });

    expect(res.status).toBe(409);
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  test('allows subscribing again after the prior subscription was CANCELED (stale id)', async () => {
    pool.query.mockResolvedValue({ rows: [companyRow({ stripe_subscription_id: 'sub_old' })] });
    mockSubRetrieve.mockResolvedValue({ id: 'sub_old', status: 'canceled' });

    const res = await request(app()).post('/api/stripe/checkout').send({ price_id: 'price_starter' });

    expect(res.status).toBe(200);
    expect(res.body.url).toBeTruthy();
    expect(mockSessionCreate).toHaveBeenCalledTimes(1);
  });

  test('a stale id that no longer exists in Stripe does not block', async () => {
    pool.query.mockResolvedValue({ rows: [companyRow({ stripe_subscription_id: 'sub_gone' })] });
    mockSubRetrieve.mockRejectedValue(Object.assign(new Error('No such subscription'), { code: 'resource_missing' }));

    const res = await request(app()).post('/api/stripe/checkout').send({ price_id: 'price_starter' });

    expect(res.status).toBe(200);
    expect(mockSessionCreate).toHaveBeenCalledTimes(1);
  });

  test('a fresh company (no subscription) can subscribe — no Stripe lookup needed', async () => {
    pool.query.mockResolvedValue({ rows: [companyRow()] });

    const res = await request(app()).post('/api/stripe/checkout').send({ price_id: 'price_starter' });

    expect(res.status).toBe(200);
    expect(res.body.url).toBeTruthy();
    expect(mockSubRetrieve).not.toHaveBeenCalled();
    expect(mockSessionCreate).toHaveBeenCalledTimes(1);
  });

  test('400 when price_id is missing', async () => {
    const res = await request(app()).post('/api/stripe/checkout').send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /stripe/checkout — prices + seats are decided server-side', () => {
  // Routes the company lookup and the live worker count.
  function mockDb({ workers = 0, company = companyRow() } = {}) {
    pool.query.mockImplementation((sql) => {
      if (/FROM companies c JOIN users/.test(sql)) return Promise.resolve({ rows: [company] });
      if (/SELECT COUNT\(\*\) AS n FROM users/.test(sql)) return Promise.resolve({ rows: [{ n: String(workers) }] });
      return Promise.resolve({ rows: [] });
    });
  }
  const lineItems = () => mockSessionCreate.mock.calls[0][0].line_items;

  test('plan/interval/addons names map onto the configured prices', async () => {
    mockDb();
    const res = await request(app()).post('/api/stripe/checkout')
      .send({ plan: 'starter', interval: 'year', addons: ['qbo', 'planroom', 'bogus'] });
    expect(res.status).toBe(200);
    expect(lineItems()).toEqual([
      { price: 'price_starter_y', quantity: 1 },
      { price: 'price_qbo_y', quantity: 1 },
      { price: 'price_pr_y', quantity: 1 },
    ]);
  });

  test('client-supplied price ids / worker counts are ignored; Business seats come from the LIVE worker count', async () => {
    mockDb({ workers: 22 });
    const res = await request(app()).post('/api/stripe/checkout').send({
      plan: 'business', interval: 'month',
      worker_price_id: 'price_attacker', worker_count: 0,
      add_qbo: true, qbo_price_id: 'price_attacker_qbo',
    });
    expect(res.status).toBe(200);
    expect(lineItems()).toEqual([
      { price: 'price_biz_m', quantity: 1 },
      { price: 'price_worker_m', quantity: 7 },   // 22 active workers − 15 included
      { price: 'price_qbo_m', quantity: 1 },
    ]);
    expect(JSON.stringify(lineItems())).not.toMatch(/attacker/);
  });

  test('Business at or under the included 15 → no seat item', async () => {
    mockDb({ workers: 15 });
    await request(app()).post('/api/stripe/checkout').send({ plan: 'business' });
    expect(lineItems()).toEqual([{ price: 'price_biz_m', quantity: 1 }]);
  });

  test('legacy price_id is only a lookup key — an arbitrary price id is refused', async () => {
    mockDb();
    const res = await request(app()).post('/api/stripe/checkout').send({ price_id: 'price_1Cheap_OtherProduct' });
    expect(res.status).toBe(400);
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  test('legacy annual base price id resolves to the annual interval', async () => {
    mockDb();
    await request(app()).post('/api/stripe/checkout').send({ price_id: 'price_biz_y' });
    expect(lineItems()[0]).toEqual({ price: 'price_biz_y', quantity: 1 });
  });
});
