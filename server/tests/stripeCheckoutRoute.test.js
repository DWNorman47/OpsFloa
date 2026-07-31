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
