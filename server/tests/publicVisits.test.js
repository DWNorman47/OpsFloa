process.env.JWT_SECRET = 'test-jwt-secret-for-unit-tests-only';
jest.mock('../db', () => ({ query: jest.fn() }));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const pool = require('../db');

const id = 'd04b1046-9b6d-47e2-8d03-d1d7702790f2';
const token = jwt.sign({ id: 1, role: 'super_admin', company_id: null, tv: 0 }, process.env.JWT_SECRET);

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/public-visits', require('../routes/publicVisits'));
  app.use('/api/superadmin', require('../routes/superadmin'));
  return app;
}

beforeEach(() => { pool.query.mockReset(); pool.query.mockResolvedValue({ rows: [] }); });

test('stores a coarse source without the referrer path, IP, or raw user agent', async () => {
  const res = await request(makeApp()).post('/api/public-visits').send({
    session_id: id, action: 'visit', landing_path: '/', referrer: 'https://search.example.com/private?q=name',
    utm_source: 'search', utm_medium: 'cpc', utm_campaign: 'summer', device: 'mobile',
  });
  expect(res.status).toBe(204);
  const [sql, params] = pool.query.mock.calls[0];
  expect(sql).toMatch(/ON CONFLICT/);
  expect(params).toEqual([id, '/', 'search.example.com', 'search', 'cpc', 'summer', 'mobile']);
  expect(JSON.stringify(params)).not.toMatch(/private|name|127\.0\.0\.1/);
});

test('rejects invalid visits and ignores automated browsers', async () => {
  expect((await request(makeApp()).post('/api/public-visits').send({ session_id: 'bad', action: 'visit' })).status).toBe(400);
  expect((await request(makeApp()).post('/api/public-visits').send({ session_id: id, action: 'visit', landing_path: '/login' })).status).toBe(400);
  expect((await request(makeApp()).post('/api/public-visits').set('User-Agent', 'Googlebot').send({ session_id: id, action: 'visit', landing_path: '/' })).status).toBe(204);
  expect(pool.query).not.toHaveBeenCalled();
});

test('exclusion deletes only the matching, non-converted visit', async () => {
  const res = await request(makeApp()).post('/api/public-visits/exclude').send({ session_id: id });
  expect(res.status).toBe(204);
  expect(pool.query).toHaveBeenCalledWith('DELETE FROM public_visits WHERE session_id = $1 AND registered = false', [id]);
});

test('a sign-up keeps the visit and flags it registered (conversion is measurable)', async () => {
  const res = await request(makeApp()).post('/api/public-visits').send({ session_id: id, action: 'registered' });
  expect(res.status).toBe(204);
  const [sql, params] = pool.query.mock.calls[0];
  expect(sql).toMatch(/^UPDATE public_visits SET .*registered = true WHERE session_id = \$1$/);
  expect(params).toEqual([id]);
});

test('only super admins can read the prospect list', async () => {
  const app = makeApp();
  expect((await request(app).get('/api/superadmin/public-visits')).status).toBe(401);
  pool.query.mockResolvedValueOnce({ rows: [{ active: true, token_version: 0 }] });
  pool.query.mockResolvedValueOnce({ rows: [{ first_seen: '2026-09-13', total: '1' }] });
  const res = await request(app).get('/api/superadmin/public-visits?days=30').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ total: 1, visits: [{ first_seen: '2026-09-13' }] });
  expect(pool.query.mock.calls[1][1]).toEqual([30]);
});
