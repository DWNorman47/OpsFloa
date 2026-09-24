/**
 * Live sessions: the client-supplied pdfUrl must be issued to the caller's company
 * (takeoffs/<company_id>/ from /upload-url, or live-sessions/<company_id>/ from the
 * base64 fallback), and GET /:id/pdf never proxies another tenant's object.
 */
process.env.R2_PUBLIC_URL = 'https://cdn.example.com';

let mockUser;
jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../jobs/liveSessionSweep', () => ({ noteLiveSessionActive: jest.fn() }));
jest.mock('../r2', () => {
  const actual = jest.requireActual('../r2');
  return {
    keyBelongsTo: actual.keyBelongsTo,
    safeKeyFromPublicUrl: actual.safeKeyFromPublicUrl,
    keyFromPublicUrl: actual.keyFromPublicUrl,
    uploadBase64: jest.fn(),
    deleteByUrl: jest.fn(() => Promise.resolve()),
    getBytesByUrl: jest.fn(),
    getPresignedUploadUrl: jest.fn(),
  };
});

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const { uploadBase64, getBytesByUrl } = require('../r2');
const { router, rooms } = require('../routes/liveSessions');

const B = 'https://cdn.example.com';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = mockUser; req.log = { error: () => {} }; next(); });
  app.use('/api/live-sessions', router);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  rooms.clear();
  mockUser = { id: 1, company_id: 7, full_name: 'Host', role: 'member' };
  pool.query.mockImplementation(async (sql) => {
    if (/INSERT INTO live_sessions/.test(sql)) return { rows: [{ id: 42 }] };
    return { rows: [] };
  });
});

afterAll(() => rooms.clear());

test.each([
  `${B}/takeoffs/7/abc.pdf`,
  `${B}/live-sessions/7/abc.pdf`,
])('POST accepts a company-issued pdfUrl (%s)', async (url) => {
  const res = await request(makeApp()).post('/api/live-sessions').send({ name: 'L', pdfUrl: url });
  expect(res.status).toBe(200);
});

test.each([
  `${B}/takeoffs/8/abc.pdf`,
  `${B}/takeoffs/legacy.pdf`,
  `${B}/public-profiles/victim.jpg`,
  `${B}/takeoffs/7/../8/abc.pdf`,
  `${B}/takeoffs/7/%2E%2E/8/abc.pdf`,
])('POST rejects pdfUrl %s', async (url) => {
  const res = await request(makeApp()).post('/api/live-sessions').send({ name: 'L', pdfUrl: url });
  expect(res.status).toBe(400);
  expect(pool.query).not.toHaveBeenCalled();
});

test('base64 fallback uploads into live-sessions/<company_id>', async () => {
  uploadBase64.mockResolvedValue({ url: `${B}/live-sessions/7/x.pdf`, sizeBytes: 2 });
  const res = await request(makeApp()).post('/api/live-sessions').send({ name: 'L', pdfBase64: 'aGk=' });
  expect(res.status).toBe(200);
  expect(uploadBase64.mock.calls[0][1]).toBe('live-sessions/7');
});

function seedRoom(pdfUrl) {
  rooms.set('42', {
    id: '42', companyId: '7', tool: 'planroom',
    meta: { name: 'L', pdfUrl, pdfName: 'p.pdf', hostUserId: 1 },
    clients: new Map(), objects: new Map(), doc: {}, dirty: false, snapTimer: null,
  });
}

test.each([
  `${B}/takeoffs/7/abc.pdf`,
  `${B}/live-sessions/7/abc.pdf`,
  `${B}/takeoffs/legacy.pdf`,
  `${B}/live-sessions/legacy.pdf`,
])('GET /:id/pdf proxies %s', async (url) => {
  getBytesByUrl.mockResolvedValue(Buffer.from('hi'));
  seedRoom(url);
  const res = await request(makeApp()).get('/api/live-sessions/42/pdf');
  expect(res.status).toBe(200);
});

test.each([
  `${B}/takeoffs/8/abc.pdf`,
  `${B}/live-sessions/8/abc.pdf`,
  `${B}/public-profiles/victim.jpg`,
])('GET /:id/pdf refuses to proxy %s', async (url) => {
  getBytesByUrl.mockResolvedValue(Buffer.from('secret'));
  seedRoom(url);
  const res = await request(makeApp()).get('/api/live-sessions/42/pdf');
  expect(res.status).toBe(404);
  expect(getBytesByUrl).not.toHaveBeenCalled();
});
