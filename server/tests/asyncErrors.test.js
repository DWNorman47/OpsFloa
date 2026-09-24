// Express 4 ignores a rejected promise from an async handler — no response is
// ever sent and the client hangs. index.js loads `express-async-errors` so such
// rejections reach the final error handler (500). Guard both: the patch works,
// and index.js loads it before any router module is required.
require('express-async-errors');
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

function buildApp() {
  const app = express();
  const router = express.Router();
  // Mirrors the real failure: `await pool.connect()` before the handler's try.
  router.get('/boom', async () => {
    await Promise.reject(new Error('timeout exceeded when trying to connect'));
  });
  router.get('/bad', async () => {
    const e = new Error('nope'); e.status = 400; throw e;
  });
  router.get('/ok', async (req, res) => { res.json({ ok: true }); });
  app.use('/api', router);
  // Same shape as the final error handler in index.js.
  app.use((err, req, res, _next) => {
    if (res.headersSent) return;
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message || 'Bad request' });
    res.status(500).json({ error: 'Server error' });
  });
  return app;
}

describe('async handler rejections', () => {
  test('a rejected async route answers 500 instead of hanging', async () => {
    const res = await request(buildApp()).get('/api/boom').timeout(2000);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Server error' });
  });

  test('a 4xx error thrown from an async route keeps its status', async () => {
    const res = await request(buildApp()).get('/api/bad').timeout(2000);
    expect(res.status).toBe(400);
  });

  test('normal async routes are unaffected', async () => {
    const res = await request(buildApp()).get('/api/ok');
    expect(res.status).toBe(200);
  });

  test('index.js loads express-async-errors before any router', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const patchAt = src.indexOf("require('express-async-errors')");
    expect(patchAt).toBeGreaterThan(-1);
    expect(patchAt).toBeLessThan(src.indexOf("require('./routes/"));
    expect(patchAt).toBeLessThan(src.indexOf("require('./middleware/"));
  });
});
