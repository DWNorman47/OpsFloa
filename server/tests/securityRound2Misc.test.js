/**
 * Security round 2 — small pieces:
 *   - utils/appUrl: one APP_URL resolver (trailing slash trimmed, consistent dev
 *     fallback, loud failure in production when unset);
 *   - jobs/stripeEventsCleanup: prunes the webhook de-dupe ledger past 90 days;
 *   - jobs/expireTrials + routes/timeOff: user data in email HTML is escaped and
 *     the subject can't carry a CR/LF.
 */

let mockCurrentUser;
jest.mock('../middleware/auth', () => ({
  requireAuth:  (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireAdmin: (req, _res, next) => { req.user = mockCurrentUser; next(); },
}));
jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../email', () => ({ sendEmail: jest.fn().mockResolvedValue({ ok: true }) }));
jest.mock('../push', () => ({ sendPushToUser: jest.fn(), sendPushToCompanyAdmins: jest.fn() }));
jest.mock('../routes/inbox', () => ({ createInboxItem: jest.fn(), createInboxItemBatch: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('node-cron', () => ({ schedule: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const { sendEmail } = require('../email');

const flush = () => new Promise(r => setImmediate(() => setImmediate(r)));

beforeEach(() => {
  pool.query.mockReset();
  sendEmail.mockClear();
});

describe('utils/appUrl', () => {
  const env = { NODE_ENV: process.env.NODE_ENV, APP_URL: process.env.APP_URL };
  afterEach(() => {
    process.env.NODE_ENV = env.NODE_ENV;
    if (env.APP_URL === undefined) delete process.env.APP_URL; else process.env.APP_URL = env.APP_URL;
  });
  const load = () => { let m; jest.isolateModules(() => { m = require('../utils/appUrl'); }); return m; };

  test('uses APP_URL with the trailing slash trimmed', () => {
    process.env.APP_URL = 'https://dev.opsfloa.com/';
    expect(load().getAppUrl()).toBe('https://dev.opsfloa.com');
  });

  test('dev/test without APP_URL → the one consistent fallback (not app.opsfloa.com)', () => {
    delete process.env.APP_URL;
    process.env.NODE_ENV = 'test';
    expect(load().getAppUrl()).toBe('https://opsfloa.com');
  });

  test('production without APP_URL fails loudly at load (boot)', () => {
    delete process.env.APP_URL;
    process.env.NODE_ENV = 'production';
    expect(() => load()).toThrow(/APP_URL/);
  });
});

describe('jobs/stripeEventsCleanup', () => {
  test('deletes ledger rows older than 90 days, scheduled daily via runJob', async () => {
    const cron = require('node-cron');
    const job = require('../jobs/stripeEventsCleanup');
    pool.query.mockResolvedValue({ rowCount: 3 });
    await job.cleanupStripeEvents();
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM stripe_webhook_events WHERE received_at < NOW\(\) - \(\$1 \|\| ' days'\)::INTERVAL/);
    expect(params).toEqual(['90']);
    job.startStripeEventsCleanupJob();
    expect(cron.schedule).toHaveBeenCalledWith('45 3 * * *', expect.any(Function));
  });

  test('registered from startCron (production-only, behind DISABLE_BACKGROUND_JOBS in index.js)', () => {
    const fs = require('fs');
    const path = require('path');
    const cronSrc = fs.readFileSync(path.join(__dirname, '..', 'cron.js'), 'utf8');
    const start = cronSrc.indexOf('function startCron()');
    const prodGate = cronSrc.indexOf("process.env.NODE_ENV !== 'production'", start);
    const reg = cronSrc.indexOf('startStripeEventsCleanupJob()', start);
    expect(prodGate).toBeGreaterThan(start);
    expect(reg).toBeGreaterThan(prodGate);
    const idx = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const gate = idx.indexOf("process.env.DISABLE_BACKGROUND_JOBS === 'true'");
    expect(idx.indexOf('startCron()')).toBeGreaterThan(idx.indexOf('} else {', gate));
  });
});

describe('jobs/expireTrials email', () => {
  test('escapes the admin + company names and strips CR/LF from the subject', async () => {
    const { expireTrials } = require('../jobs/expireTrials');
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'co-1', name: 'Evil <img src=x>\r\nBcc: v@x.co' }] })
      .mockResolvedValueOnce({ rows: [{ id: 2, email: 'a@x.co', full_name: '<b>Bob</b>' }] });
    await expireTrials();
    const [, subject, html] = sendEmail.mock.calls[0];
    expect(subject).not.toMatch(/[\r\n]/);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>Bob</b>');
    expect(html).toContain('&lt;b&gt;Bob&lt;/b&gt;');
  });
});

describe('routes/timeOff emails', () => {
  function app() {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { req.log = { error: () => {} }; next(); });
    a.use('/time-off', require('../routes/timeOff'));
    return a;
  }
  beforeEach(() => { mockCurrentUser = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'Boss' }; });

  test.each([['approve'], ['deny']])('%s: worker name + review note escaped', async (action) => {
    pool.query.mockImplementation(async (sql) => {
      if (/UPDATE time_off_requests/.test(sql)) return { rowCount: 1, rows: [{ id: 9, user_id: 5, start_date: '2026-10-01', end_date: '2026-10-02' }] };
      if (/SELECT email, full_name FROM users/.test(sql)) return { rows: [{ email: 'w@x.co', full_name: 'Wendy <script>' }] };
      return { rowCount: 0, rows: [] };
    });
    const res = await request(app()).patch(`/time-off/9/${action}`).send({ review_note: '<a href="http://evil">click</a>' });
    expect(res.status).toBe(200);
    await flush();
    const html = sendEmail.mock.calls[0][2];
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<a href');
    expect(html).toContain('Wendy &lt;script&gt;');
    expect(html).toContain('&lt;a href=');
  });
});
