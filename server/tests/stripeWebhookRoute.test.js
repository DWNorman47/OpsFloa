/**
 * POST /stripe/webhook — the subscription-lifecycle handler.
 *
 * Money path, so the review-batch-3 hardening is pinned here:
 *   - company_id is read from the SUBSCRIPTION's metadata when the checkout
 *     session carries none (older sessions), so activation stores the sub id;
 *   - the base plan is found by scanning ALL items, not items[0] (Stripe does
 *     not order them), so a business sub isn't mis-read as 'free';
 *   - lifecycle writes carry the last_stripe_event_at ordering watermark;
 *   - invoice.payment_failed only flips a live-ish company to past_due;
 *   - a handler failure returns 500 so Stripe retries (no silent drop).
 */

const mockConstructEvent = jest.fn();
const mockSubRetrieve = jest.fn();
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({
  webhooks: { constructEvent: mockConstructEvent },
  subscriptions: { retrieve: mockSubRetrieve },
})));
jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../email', () => ({ sendEmail: jest.fn(() => Promise.resolve()) }));

process.env.STRIPE_SECRET_KEY = 'sk_test';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
process.env.STRIPE_PRICE_BUSINESS_BASE = 'price_biz_base_m';
process.env.STRIPE_PRICE_BUSINESS_WORKER = 'price_worker_m';
process.env.STRIPE_PRICE_STARTER = 'price_starter_m';
process.env.STRIPE_PRICE_QBO = 'price_qbo_m';
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

function send(event) {
  mockConstructEvent.mockReturnValue(event);
  return request(app()).post('/api/stripe/webhook').set('stripe-signature', 'sig').send({});
}

// The one UPDATE companies ... call the handler made (SQL + params).
function updateCall() {
  const call = pool.query.mock.calls.find(c => /UPDATE companies/.test(c[0]));
  return call ? { sql: call[0], params: call[1] } : null;
}

beforeEach(() => {
  pool.query.mockReset().mockResolvedValue({ rows: [], rowCount: 1 });
  mockConstructEvent.mockReset();
  mockSubRetrieve.mockReset();
});

describe('signature verification', () => {
  test('a bad signature is 400 and never touches the DB', async () => {
    mockConstructEvent.mockImplementation(() => { throw new Error('bad sig'); });
    const res = await request(app()).post('/api/stripe/webhook').set('stripe-signature', 'x').send({});
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('checkout.session.completed', () => {
  test('reads company_id from the subscription when the session has none, and stores the sub id', async () => {
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_1',
      metadata: { company_id: 'co-1' },
      status: 'active',
      items: { data: [
        { price: { id: 'price_worker_m', unit_amount: 200, recurring: { interval: 'month' } } },
        { price: { id: 'price_biz_base_m', unit_amount: 3500, recurring: { interval: 'month' } } },
      ] },
    });
    const res = await send({
      id: 'evt_1', type: 'checkout.session.completed', created: 1000,
      data: { object: { subscription: 'sub_1', metadata: {} } }, // session metadata EMPTY
    });
    expect(res.status).toBe(200);
    const { sql, params } = updateCall();
    expect(sql).toMatch(/stripe_subscription_id/);
    expect(sql).toMatch(/last_stripe_event_at/);              // ordering watermark present
    expect(params).toContain('sub_1');
    expect(params).toContain('co-1');
    expect(params).toContain(1000);                            // event.created watermark
    expect(params).toContain('business');                     // plan found by scanning all items, not items[0]
  });

  test('a session with no subscription is a no-op', async () => {
    const res = await send({
      id: 'evt_2', type: 'checkout.session.completed', created: 1,
      data: { object: { subscription: null, metadata: { company_id: 'co-1' } } },
    });
    expect(res.status).toBe(200);
    expect(updateCall()).toBeNull();
  });
});

describe('customer.subscription.updated', () => {
  test('writes the mapped status + the sub id + the watermark', async () => {
    const res = await send({
      id: 'evt_3', type: 'customer.subscription.updated', created: 2000,
      data: { object: {
        id: 'sub_9', metadata: { company_id: 'co-1' }, status: 'past_due',
        items: { data: [ { price: { id: 'price_starter_m', unit_amount: 2000, recurring: { interval: 'month' } } } ] },
      } },
    });
    expect(res.status).toBe(200);
    const { sql, params } = updateCall();
    expect(sql).toMatch(/last_stripe_event_at/);
    expect(params).toContain('past_due');   // mapStripeStatus('past_due')
    expect(params).toContain('starter');
    expect(params).toContain('sub_9');      // sub id re-asserted so it's never left unset
    expect(params).toContain(2000);
  });

  test('never downgrades a superadmin-comped (exempt) company', async () => {
    await send({
      id: 'evt_3b', type: 'customer.subscription.updated', created: 2001,
      data: { object: { id: 'sub_9', metadata: { company_id: 'co-1' }, status: 'canceled', items: { data: [] } } },
    });
    expect(updateCall().sql).toMatch(/subscription_status <> 'exempt'/);
  });
});

describe('customer.subscription.deleted', () => {
  test('cancels, but never an exempt company', async () => {
    const res = await send({
      id: 'evt_4', type: 'customer.subscription.deleted', created: 3000,
      data: { object: { id: 'sub_9', metadata: { company_id: 'co-1' } } },
    });
    expect(res.status).toBe(200);
    const { sql, params } = updateCall();
    expect(params).toContain('canceled');
    expect(sql).toMatch(/subscription_status <> 'exempt'/);
  });
});

describe('invoice.payment_failed', () => {
  test('only flips a live-ish company to past_due (guarded WHERE)', async () => {
    mockSubRetrieve.mockResolvedValue({ metadata: { company_id: 'co-1' } });
    const res = await send({
      id: 'evt_4', type: 'invoice.payment_failed', created: 3000,
      data: { object: { subscription: 'sub_1', amount_due: 3500 } },
    });
    expect(res.status).toBe(200);
    const { sql } = updateCall();
    expect(sql).toMatch(/subscription_status IN \('active','trial','past_due'\)/);
  });
});

describe('fail-open protection', () => {
  test('a DB failure returns 500 so Stripe retries', async () => {
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_1', metadata: { company_id: 'co-1' }, status: 'active',
      items: { data: [ { price: { id: 'price_biz_base_m', unit_amount: 3500, recurring: { interval: 'month' } } } ] },
    });
    pool.query.mockRejectedValue(new Error('neon is down'));
    const res = await send({
      id: 'evt_5', type: 'checkout.session.completed', created: 5000,
      data: { object: { subscription: 'sub_1', metadata: { company_id: 'co-1' } } },
    });
    expect(res.status).toBe(500);
  });
});

describe('security review hardening', () => {
  const bizSub = (status = 'active') => ({
    id: 'sub_1', metadata: { company_id: 'co-1' }, status,
    items: { data: [{ price: { id: 'price_biz_base_m', unit_amount: 3500, recurring: { interval: 'month' } } }] },
  });

  test('checkout.session.completed writes the MAPPED subscription status and never downgrades exempt', async () => {
    mockSubRetrieve.mockResolvedValue(bizSub('trialing'));
    const res = await send({
      id: 'evt_10', type: 'checkout.session.completed', created: 6000,
      data: { object: { subscription: 'sub_1', metadata: { company_id: 'co-1' } } },
    });
    expect(res.status).toBe(200);
    const { sql, params } = updateCall();
    expect(params).toContain('trial');                // mapStripeStatus('trialing'), not a hard-coded 'active'
    expect(params).not.toContain('active');
    expect(sql).toMatch(/CASE WHEN subscription_status = 'exempt' THEN 'exempt' ELSE \$2 END/);
  });

  test('a repeat delivery of the same event id is a 200 no-op', async () => {
    pool.query.mockImplementation((sql) => Promise.resolve(
      /INSERT INTO stripe_webhook_events/.test(sql) ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 1 }
    ));
    mockSubRetrieve.mockResolvedValue(bizSub());
    const res = await send({
      id: 'evt_dup', type: 'checkout.session.completed', created: 7000,
      data: { object: { subscription: 'sub_1', metadata: { company_id: 'co-1' } } },
    });
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
    expect(updateCall()).toBeNull();
    expect(mockSubRetrieve).not.toHaveBeenCalled();
  });

  test('the event id is claimed before processing, and released when processing fails (so the retry applies)', async () => {
    pool.query.mockImplementation((sql) => {
      if (/INSERT INTO stripe_webhook_events/.test(sql)) return Promise.resolve({ rows: [], rowCount: 1 });
      if (/UPDATE companies/.test(sql)) return Promise.reject(new Error('neon is down'));
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    mockSubRetrieve.mockResolvedValue(bizSub());
    const res = await send({
      id: 'evt_fail', type: 'checkout.session.completed', created: 8000,
      data: { object: { subscription: 'sub_1', metadata: { company_id: 'co-1' } } },
    });
    expect(res.status).toBe(500);
    const sqls = pool.query.mock.calls.map(c => c[0]);
    expect(sqls[0]).toMatch(/INSERT INTO stripe_webhook_events/);
    const del = pool.query.mock.calls.find(c => /DELETE FROM stripe_webhook_events/.test(c[0]));
    expect(del[1]).toEqual(['evt_fail']);
  });

  test('invoice.payment_failed / payment_succeeded respect the last_stripe_event_at watermark', async () => {
    mockSubRetrieve.mockResolvedValue({ metadata: { company_id: 'co-1' } });
    await send({ id: 'evt_pf', type: 'invoice.payment_failed', created: 9000, data: { object: { subscription: 'sub_1' } } });
    let { sql, params } = updateCall();
    expect(sql).toMatch(/last_stripe_event_at IS NULL OR last_stripe_event_at <= \$2/);
    expect(params).toEqual(['co-1', 9000]);

    pool.query.mockClear();
    await send({ id: 'evt_ps', type: 'invoice.payment_succeeded', created: 9100, data: { object: { subscription: 'sub_1' } } });
    ({ sql, params } = updateCall());
    expect(sql).toMatch(/last_stripe_event_at IS NULL OR last_stripe_event_at <= \$2/);
    expect(params).toEqual(['co-1', 9100]);
  });

  test('payment_failed email escapes the company + admin names', async () => {
    const { sendEmail } = require('../email');
    sendEmail.mockClear();
    mockSubRetrieve.mockResolvedValue({ metadata: { company_id: 'co-1' } });
    pool.query.mockImplementation((sql) => {
      if (/SELECT name FROM companies/.test(sql)) return Promise.resolve({ rows: [{ name: 'Acme <img src=x>' }] });
      if (/SELECT email, full_name FROM users/.test(sql)) return Promise.resolve({ rows: [{ email: 'a@x.co', full_name: '<b>Al</b>' }] });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    await send({ id: 'evt_pf2', type: 'invoice.payment_failed', created: 9200, data: { object: { subscription: 'sub_1', amount_due: 100 } } });
    const html = sendEmail.mock.calls[0][2];
    expect(html).toContain('Acme &lt;img src=x&gt;');
    expect(html).toContain('&lt;b&gt;Al&lt;/b&gt;');
    expect(html).not.toContain('<img');
  });
});
