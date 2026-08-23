/**
 * POST /stripe/change-plan — switch the base plan (starter <-> business) on the
 * EXISTING subscription. Money path: it must (1) NEVER create a second subscription,
 * (2) swap the base price + add/remove the per-worker seat item, (3) PRESERVE every
 * add-on, (4) keep the billing interval, and (5) refuse a downgrade that would blow
 * Starter's worker cap.
 */

const mockSubRetrieve = jest.fn();
const mockSubUpdate = jest.fn();
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({
  subscriptions: { retrieve: mockSubRetrieve, update: mockSubUpdate },
})));

let mockUser;
jest.mock('../middleware/auth', () => ({
  requireAdmin: (req, _res, next) => { req.user = mockUser; next(); },
  requirePerm:  () => (req, _res, next) => { req.user = mockUser; next(); },
}));
jest.mock('../db', () => ({ query: jest.fn() }));

process.env.STRIPE_SECRET_KEY = 'sk_test';
process.env.STRIPE_PRICE_STARTER = 'price_starter_m';
process.env.STRIPE_PRICE_STARTER_ANNUAL = 'price_starter_y';
process.env.STRIPE_PRICE_BUSINESS_BASE = 'price_biz_base_m';
process.env.STRIPE_PRICE_BUSINESS_BASE_ANNUAL = 'price_biz_base_y';
process.env.STRIPE_PRICE_BUSINESS_WORKER = 'price_biz_worker_m';
process.env.STRIPE_PRICE_BUSINESS_WORKER_ANNUAL = 'price_biz_worker_y';
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

// A live subscription. `items` is [{ id, priceId, interval }].
function sub(items, status = 'active') {
  return { id: 'sub_1', status, items: { data: items.map(i => ({ id: i.id, price: { id: i.priceId, recurring: { interval: i.interval || 'month' } } })) } };
}
function companyRow(over = {}) {
  return { stripe_subscription_id: 'sub_1', bonus_seats: 0, worker_count: '5', ...over };
}
const post = (body) => request(app()).post('/api/stripe/change-plan').send(body);

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { id: 1, company_id: 'co-1', role: 'admin' };
  mockSubUpdate.mockResolvedValue({});
  pool.query.mockResolvedValue({ rows: [{}] }); // default (the UPDATE companies … call)
});

describe('POST /stripe/change-plan', () => {
  test('upgrade starter → business adds a per-worker item for the overage and PRESERVES the add-on', async () => {
    pool.query.mockResolvedValueOnce({ rows: [companyRow({ worker_count: '20' })] }); // 20 workers → overage 5
    mockSubRetrieve.mockResolvedValue(sub([
      { id: 'si_base', priceId: 'price_starter_m' },
      { id: 'si_qbo', priceId: 'price_qbo_m' }, // an add-on — must survive
    ]));

    const res = await post({ plan: 'business' });

    expect(res.status).toBe(200);
    expect(res.body.plan).toBe('business');
    const [subId, args] = mockSubUpdate.mock.calls[0];
    expect(subId).toBe('sub_1');
    expect(args.proration_behavior).toBe('create_prorations');
    // base swapped to business, add-on preserved, new worker item qty = 20 - 15 = 5
    expect(args.items).toContainEqual({ id: 'si_base', price: 'price_biz_base_m' });
    expect(args.items).toContainEqual({ id: 'si_qbo' });
    expect(args.items).toContainEqual({ price: 'price_biz_worker_m', quantity: 5 });
    // DB reflects the new plan
    expect(pool.query).toHaveBeenLastCalledWith(expect.stringContaining('UPDATE companies SET plan'), ['business', 5, 'co-1']); // paid_worker_seats = 20 − 15

  });

  test('upgrade with <= 15 workers adds NO per-worker item', async () => {
    pool.query.mockResolvedValueOnce({ rows: [companyRow({ worker_count: '12' })] });
    mockSubRetrieve.mockResolvedValue(sub([{ id: 'si_base', priceId: 'price_starter_m' }]));

    const res = await post({ plan: 'business' });

    expect(res.status).toBe(200);
    const args = mockSubUpdate.mock.calls[0][1];
    expect(args.items).toEqual([{ id: 'si_base', price: 'price_biz_base_m' }]); // just the base swap
  });

  test('downgrade business → starter removes the per-worker item and PRESERVES the add-on', async () => {
    pool.query.mockResolvedValueOnce({ rows: [companyRow({ worker_count: '8' })] });
    mockSubRetrieve.mockResolvedValue(sub([
      { id: 'si_base', priceId: 'price_biz_base_m' },
      { id: 'si_worker', priceId: 'price_biz_worker_m' },
      { id: 'si_planroom', priceId: 'price_planroom_m' },
    ]));

    const res = await post({ plan: 'starter' });

    expect(res.status).toBe(200);
    const args = mockSubUpdate.mock.calls[0][1];
    expect(args.items).toContainEqual({ id: 'si_base', price: 'price_starter_m' });
    expect(args.items).toContainEqual({ id: 'si_worker', deleted: true });
    expect(args.items).toContainEqual({ id: 'si_planroom' }); // add-on survives
  });

  test('downgrade is BLOCKED when the company exceeds Starter\'s worker cap', async () => {
    pool.query.mockResolvedValueOnce({ rows: [companyRow({ worker_count: '20', bonus_seats: 0 })] }); // cap 10
    mockSubRetrieve.mockResolvedValue(sub([
      { id: 'si_base', priceId: 'price_biz_base_m' },
      { id: 'si_worker', priceId: 'price_biz_worker_m' },
    ]));

    const res = await post({ plan: 'starter' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('worker_limit');
    expect(mockSubUpdate).not.toHaveBeenCalled();
  });

  test('bonus seats raise the Starter cap for the downgrade check', async () => {
    pool.query.mockResolvedValueOnce({ rows: [companyRow({ worker_count: '13', bonus_seats: 5 })] }); // cap 10+5=15 ≥ 13
    mockSubRetrieve.mockResolvedValue(sub([
      { id: 'si_base', priceId: 'price_biz_base_m' },
      { id: 'si_worker', priceId: 'price_biz_worker_m' },
    ]));

    const res = await post({ plan: 'starter' });
    expect(res.status).toBe(200);
  });

  test('annual subscription uses ANNUAL prices for the swap', async () => {
    pool.query.mockResolvedValueOnce({ rows: [companyRow({ worker_count: '20' })] });
    mockSubRetrieve.mockResolvedValue(sub([{ id: 'si_base', priceId: 'price_starter_y', interval: 'year' }]));

    const res = await post({ plan: 'business' });

    expect(res.status).toBe(200);
    const args = mockSubUpdate.mock.calls[0][1];
    expect(args.items).toContainEqual({ id: 'si_base', price: 'price_biz_base_y' });
    expect(args.items).toContainEqual({ price: 'price_biz_worker_y', quantity: 5 });
  });

  test('already on the target plan → 400, no Stripe write', async () => {
    pool.query.mockResolvedValueOnce({ rows: [companyRow()] });
    mockSubRetrieve.mockResolvedValue(sub([{ id: 'si_base', priceId: 'price_biz_base_m' }]));

    const res = await post({ plan: 'business' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('already_on_plan');
    expect(mockSubUpdate).not.toHaveBeenCalled();
  });

  test('no subscription → 400', async () => {
    pool.query.mockResolvedValueOnce({ rows: [companyRow({ stripe_subscription_id: null })] });
    const res = await post({ plan: 'business' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('no_subscription');
    expect(mockSubRetrieve).not.toHaveBeenCalled();
  });

  test('add-ons-only subscription (no base plan) → 400', async () => {
    pool.query.mockResolvedValueOnce({ rows: [companyRow()] });
    mockSubRetrieve.mockResolvedValue(sub([{ id: 'si_planroom', priceId: 'price_planroom_m' }]));
    const res = await post({ plan: 'business' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('no_base_plan');
    expect(mockSubUpdate).not.toHaveBeenCalled();
  });

  test('invalid plan → 400', async () => {
    const res = await post({ plan: 'enterprise' });
    expect(res.status).toBe(400);
  });
});
