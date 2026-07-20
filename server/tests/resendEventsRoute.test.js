/**
 * POST /api/resend-events — the bounce feed that tells the app to stop mailing
 * a dead address.
 *
 * Background: this route did not exist. The only writer of users.email_bounced_at
 * was a *SendGrid* webhook, and email had moved to Resend, so bounce tracking
 * silently took no new data for months. Nothing failed loudly — mail just kept
 * going to addresses known to be dead.
 *
 * These sign real payloads with the real secret rather than stubbing the
 * verifier, because "the signature check passes when it shouldn't" is precisely
 * the failure a stub would hide. The SDK's headers option is its own
 * {id,timestamp,signature} interface — NOT the fetch Headers global the type
 * name suggests — and getting that wrong fails closed and silently.
 */

const crypto = require('crypto');

jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const SECRET_B64 = Buffer.from('opsfloa-test-signing-key-0123456789').toString('base64');
process.env.RESEND_WEBHOOK_SECRET = `whsec_${SECRET_B64}`;
process.env.RESEND_API_KEY = 're_test_key';

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const router = require('../routes/resendEvents');

function app() {
  const a = express();
  // Must mirror index.js: raw body, or the signature can't be checked.
  a.use('/api/resend-events', express.raw({ type: 'application/json' }));
  a.use('/api/resend-events', router);
  return a;
}

// Standard Webhooks: sign `${id}.${timestamp}.${body}` with the base64-decoded
// secret, send as `v1,<sig>`.
function sign(body, id, timestamp) {
  const key = Buffer.from(SECRET_B64, 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return `v1,${sig}`;
}

function post(event, { tamper = false, staleSeconds = 0 } = {}) {
  const body = JSON.stringify(event);
  const id = 'msg_test_1';
  const timestamp = String(Math.floor(Date.now() / 1000) - staleSeconds);
  const signature = sign(tamper ? body + ' ' : body, id, timestamp);
  return request(app())
    .post('/api/resend-events')
    .set('content-type', 'application/json')
    .set('svix-id', id)
    .set('svix-timestamp', timestamp)
    .set('svix-signature', signature)
    .send(body);
}

const bounced = (over = {}) => ({
  type: 'email.bounced',
  created_at: '2026-07-16T10:00:00.000Z',
  data: {
    email_id: 'e1',
    from: 'OpsFloa <info@opsfloa.com>',
    to: ['gone@example.com'],
    subject: 'Your schedule',
    bounce: { type: 'Permanent', subType: 'General', message: 'mailbox does not exist' },
    ...over,
  },
});

beforeEach(() => {
  pool.query.mockReset();
  pool.query.mockResolvedValue({ rows: [{ id: 7, company_id: 'c1', email: 'gone@example.com' }], rowCount: 1 });
});

describe('signature verification', () => {
  test('a correctly signed permanent bounce suppresses the address', async () => {
    const res = await post(bounced());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: 1, marked: 1 });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/email_bounced_at = NOW\(\)/);
    expect(params[1]).toBe('gone@example.com');
  });

  test('rejects a tampered payload — a forged bounce could silence anyone', async () => {
    const res = await post(bounced(), { tamper: true });

    expect(res.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('rejects a replayed old event (timestamp outside tolerance)', async () => {
    const res = await post(bounced(), { staleSeconds: 60 * 60 });

    expect(res.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('rejects when the signature headers are missing entirely', async () => {
    const res = await request(app())
      .post('/api/resend-events')
      .set('content-type', 'application/json')
      .send(JSON.stringify(bounced()));

    expect(res.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('which events actually suppress', () => {
  test('a TRANSIENT bounce does NOT suppress — a full mailbox is not a dead one', async () => {
    const res = await post(bounced({ bounce: { type: 'Transient', subType: 'MailboxFull', message: 'over quota' } }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ignored: 'transient_bounce' });
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('an Undetermined bounce does NOT suppress', async () => {
    const res = await post(bounced({ bounce: { type: 'Undetermined', subType: '', message: '?' } }));

    expect(res.body).toEqual({ ignored: 'transient_bounce' });
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('a spam complaint suppresses — continuing to mail them hurts the sending domain', async () => {
    const res = await post({
      type: 'email.complained',
      created_at: '2026-07-16T10:00:00.000Z',
      data: { email_id: 'e2', from: 'x', to: ['annoyed@example.com'], subject: 's' },
    });

    expect(res.body).toEqual({ received: 1, marked: 1 });
    expect(pool.query.mock.calls[0][1][1]).toBe('annoyed@example.com');
  });

  test('delivery events are ignored without touching the database', async () => {
    const res = await post({
      type: 'email.delivered',
      created_at: '2026-07-16T10:00:00.000Z',
      data: { email_id: 'e3', from: 'x', to: ['fine@example.com'], subject: 's' },
    });

    expect(res.body).toEqual({ ignored: 'email.delivered' });
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('payload shape', () => {
  test('`to` is an array — every recipient on a multi-recipient bounce is flagged', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 1, company_id: 'c1', email: 'x' }], rowCount: 1 });
    const res = await post(bounced({ to: ['a@example.com', 'b@example.com'] }));

    expect(res.body).toEqual({ received: 2, marked: 2 });
    expect(pool.query.mock.calls.map(c => c[1][1])).toEqual(['a@example.com', 'b@example.com']);
  });

  test('an address matching no user is a normal no-op, not an error', async () => {
    // Clients and subcontractors get mail without being users.
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await post(bounced({ to: ['client@example.com'] }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: 1, marked: 0 });
  });

  test('a DB error on one recipient still returns 200 — a non-2xx makes Resend retry the batch', async () => {
    pool.query.mockRejectedValue(new Error('db down'));
    const res = await post(bounced());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: 1, marked: 0 });
  });
});
