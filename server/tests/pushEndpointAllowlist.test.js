/**
 * Web-push endpoints are URLs the server POSTs to, so POST /push/subscribe must only
 * store https endpoints on real browser push services (blind-SSRF guard), and the
 * sender re-checks stored rows so a bad legacy row never triggers a request.
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
const { isAllowedPushEndpoint, sendPushToUser } = require('../push');
const pushRouter = require('../routes/push');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error() {} }; next(); });
  app.use('/api/push', pushRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { id: 5, company_id: 7 };
  pool.query.mockResolvedValue({ rows: [], rowCount: 1 });
});

const GOOD = [
  'https://fcm.googleapis.com/fcm/send/abc:APA91b',
  'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
  'https://wns2-by3p.notify.windows.com/w/?token=BQYAAA',
  'https://web.push.apple.com/QGxyz',
  'https://api.push.apple.com/3/device/abc',
];
const BAD = [
  'http://fcm.googleapis.com/fcm/send/abc',             // not https
  'https://169.254.169.254/latest/meta-data/',           // metadata IP
  'https://localhost/x',
  'https://internal.example.com/hook',
  'https://fcm.googleapis.com.evil.com/x',               // suffix trick
  'https://evilpush.services.mozilla.com.attacker.io/x',
  'https://push.services.mozilla.com/x',                 // bare suffix without subdomain label isn't a real host
  'https://fcm.googleapis.com:8443/x',                   // odd port
  'https://user:pw@fcm.googleapis.com/x',
  'file:///etc/passwd',
  'not a url',
];

test.each(GOOD)('allows %s', url => expect(isAllowedPushEndpoint(url)).toBe(true));
test.each(BAD)('rejects %s', url => expect(isAllowedPushEndpoint(url)).toBe(false));

test('POST /subscribe stores an allowed endpoint', async () => {
  const res = await request(makeApp()).post('/api/push/subscribe').send({ endpoint: GOOD[0], p256dh: 'k', auth: 'a' });
  expect(res.status).toBe(200);
  expect(pool.query).toHaveBeenCalledTimes(1);
});

test('POST /subscribe rejects an arbitrary endpoint without touching the DB', async () => {
  const res = await request(makeApp()).post('/api/push/subscribe').send({ endpoint: 'https://internal.example.com/hook', p256dh: 'k', auth: 'a' });
  expect(res.status).toBe(400);
  expect(pool.query).not.toHaveBeenCalled();
});

test('sender skips and prunes a stored disallowed endpoint, still sends to good ones', async () => {
  pool.query.mockImplementation(async (sql) => {
    if (/SELECT \* FROM push_subscriptions/.test(sql)) {
      return { rows: [
        { id: 1, user_id: 5, endpoint: 'https://10.0.0.5/admin', p256dh: 'k', auth: 'a' },
        { id: 2, user_id: 5, endpoint: GOOD[0], p256dh: 'k', auth: 'a' },
      ] };
    }
    return { rows: [], rowCount: 1 };
  });
  webpush.sendNotification.mockResolvedValue({});
  await sendPushToUser(5, { title: 't' });
  expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
  expect(webpush.sendNotification.mock.calls[0][0].endpoint).toBe(GOOD[0]);
  expect(pool.query.mock.calls.some(([sql, p]) => /DELETE FROM push_subscriptions/.test(sql) && p[0] === 1)).toBe(true);
});
