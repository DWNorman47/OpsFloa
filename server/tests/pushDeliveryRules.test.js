/**
 * push.js delivery rules: every send path skips inactive users, the chat fan-out to admins is
 * scoped to the worker, bursts to the same recipient + thread tag are coalesced, and
 * POST /push/subscribe takes an endpoint over from any other user on the same browser.
 */
process.env.VAPID_PUBLIC_KEY = 'pub';
process.env.VAPID_PRIVATE_KEY = 'priv';

let mockUser;
jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('web-push', () => ({ setVapidDetails: jest.fn(), sendNotification: jest.fn(), generateVAPIDKeys: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = mockUser; next(); },
}));

const express = require('express');
const request = require('supertest');
const webpush = require('web-push');
const pool = require('../db');
const { sendPushToUser, sendPushToCompanyAdmins, _resetCoalesce } = require('../push');
const pushRouter = require('../routes/push');

const EP = 'https://fcm.googleapis.com/fcm/send/abc';
const sub = (id, userId) => ({ id, user_id: userId, endpoint: `${EP}${id}`, p256dh: 'k', auth: 'a' });

beforeEach(() => {
  jest.clearAllMocks();
  _resetCoalesce();
  webpush.sendNotification.mockResolvedValue({});
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

test('sendPushToUser only selects subscriptions of an ACTIVE user', async () => {
  await sendPushToUser(5, { title: 't' });
  expect(pool.query.mock.calls[0][0]).toMatch(/u\.active = true/);
});

test('admin fan-out passes the worker id for the scope filter', async () => {
  await sendPushToCompanyAdmins('co', { title: 't' }, { workerId: 10 });
  const [sql, params] = pool.query.mock.calls[0];
  expect(sql).toMatch(/worker_access_ids/);
  expect(params).toEqual(['co', 10]);
  await sendPushToCompanyAdmins('co', { title: 't' });
  expect(pool.query.mock.calls[1][1]).toEqual(['co', null]);
});

test('a burst to the same recipient + tag is coalesced; other threads still go out', async () => {
  pool.query.mockResolvedValue({ rows: [sub(1, 5)], rowCount: 1 });
  await sendPushToUser(5, { title: 'a', tag: 'dm-7' });
  await sendPushToUser(5, { title: 'b', tag: 'dm-7' });
  expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
  await sendPushToUser(5, { title: 'c', tag: 'dm-8' });
  expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
  // untagged pushes (shift reminders etc.) are never coalesced
  await sendPushToUser(5, { title: 'd' });
  await sendPushToUser(5, { title: 'e' });
  expect(webpush.sendNotification).toHaveBeenCalledTimes(4);
});

test('subscribe removes other users\' rows for the same endpoint in the same statement', async () => {
  mockUser = { id: 5, company_id: 7 };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error() {} }; next(); });
  app.use('/api/push', pushRouter);
  const res = await request(app).post('/api/push/subscribe').send({ endpoint: EP, p256dh: 'k', auth: 'a' });
  expect(res.status).toBe(200);
  expect(pool.query).toHaveBeenCalledTimes(1);
  const [sql, params] = pool.query.mock.calls[0];
  expect(sql).toMatch(/DELETE FROM push_subscriptions WHERE endpoint = \$3 AND user_id <> \$1/);
  expect(params.slice(0, 3)).toEqual([5, 7, EP]);
});
