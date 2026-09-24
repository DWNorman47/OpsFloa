/**
 * Takeoff plan docs are company-scoped in R2 (takeoffs/<company_id>/...).
 *  - /upload-url issues keys under the caller's company folder.
 *  - POST / rejects a pdfUrl not issued to this company (other tenant, other
 *    folder, traversal / encoded dot segments).
 *  - DELETE /:id deletes the R2 object only when it's under the company folder.
 *  - GET /:id/pdf proxies only the company folder or a legacy flat takeoffs/ key.
 */
process.env.R2_PUBLIC_URL = 'https://cdn.example.com';

let mockUser;
jest.mock('../db', () => ({ query: jest.fn() }));
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
const { uploadBase64, deleteByUrl, getBytesByUrl, getPresignedUploadUrl } = require('../r2');
const takeoffs = require('../routes/takeoffs');

const B = 'https://cdn.example.com';
const OWN = `${B}/takeoffs/7/abc.pdf`;
const OTHER = `${B}/takeoffs/8/abc.pdf`;
const LEGACY = `${B}/takeoffs/0b7c.pdf`;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = mockUser; req.log = { error: () => {} }; next(); });
  app.use('/api/takeoffs', takeoffs);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { id: 1, company_id: 7, full_name: 'Admin Amy', role: 'admin' };
  pool.query.mockImplementation(async (sql) => {
    if (/INSERT INTO takeoff_projects/.test(sql)) return { rows: [{ id: 5, version: 1 }] };
    return { rows: [] };
  });
});

test('/upload-url issues a key under takeoffs/<company_id>', async () => {
  getPresignedUploadUrl.mockResolvedValue({ uploadUrl: 'u', publicUrl: OWN, key: 'takeoffs/7/abc.pdf' });
  const res = await request(makeApp()).post('/api/takeoffs/upload-url').send({ ext: 'pdf' });
  expect(res.status).toBe(200);
  expect(getPresignedUploadUrl).toHaveBeenCalledWith('takeoffs/7', 'pdf', 'application/pdf');
});

test('POST accepts a pdfUrl issued to this company', async () => {
  const res = await request(makeApp()).post('/api/takeoffs').send({ name: 'T', pdfUrl: OWN });
  expect(res.status).toBe(200);
  const insert = pool.query.mock.calls.find(([sql]) => /INSERT INTO takeoff_projects/.test(sql));
  expect(insert[1][3]).toBe(OWN);
});

test.each([
  ['another tenant', OTHER],
  ['legacy flat key (owner unprovable)', LEGACY],
  ['another folder', `${B}/public-profiles/victim.jpg`],
  ['traversal', `${B}/takeoffs/7/../8/abc.pdf`],
  ['encoded traversal', `${B}/takeoffs/7/%2e%2e/8/abc.pdf`],
  ['foreign host', 'https://evil.example.com/takeoffs/7/abc.pdf'],
])('POST rejects pdfUrl: %s', async (_label, url) => {
  const res = await request(makeApp()).post('/api/takeoffs').send({ name: 'T', pdfUrl: url });
  expect(res.status).toBe(400);
  expect(pool.query).not.toHaveBeenCalled();
});

test('POST base64 fallback uploads into the company folder', async () => {
  uploadBase64.mockResolvedValue({ url: OWN, sizeBytes: 3 });
  const res = await request(makeApp()).post('/api/takeoffs').send({ name: 'T', pdfBase64: 'aGk=' });
  expect(res.status).toBe(200);
  expect(uploadBase64.mock.calls[0][1]).toBe('takeoffs/7');
});

function rowFor(url) {
  pool.query.mockImplementation(async (sql) => {
    if (/SELECT created_by, pdf_url/.test(sql)) return { rows: [{ created_by: 1, pdf_url: url }] };
    if (/SELECT pdf_url, pdf_name/.test(sql)) return { rows: [{ pdf_url: url, pdf_name: 'p.pdf' }] };
    return { rows: [] };
  });
}

test('DELETE removes the R2 object when it is in the company folder', async () => {
  rowFor(OWN);
  const res = await request(makeApp()).delete('/api/takeoffs/5');
  expect(res.status).toBe(200);
  expect(deleteByUrl).toHaveBeenCalledWith(OWN);
});

test.each([OTHER, LEGACY, `${B}/public-profiles/victim.jpg`])('DELETE never deletes an object outside the company folder (%s)', async (url) => {
  rowFor(url);
  const res = await request(makeApp()).delete('/api/takeoffs/5');
  expect(res.status).toBe(200);
  expect(deleteByUrl).not.toHaveBeenCalled();
});

test('GET /:id/pdf proxies the company doc and a legacy flat doc', async () => {
  getBytesByUrl.mockResolvedValue(Buffer.from('hi'));
  rowFor(OWN);
  expect((await request(makeApp()).get('/api/takeoffs/5/pdf')).status).toBe(200);
  rowFor(LEGACY);
  expect((await request(makeApp()).get('/api/takeoffs/5/pdf')).status).toBe(200);
  expect(getBytesByUrl).toHaveBeenCalledTimes(2);
});

test.each([OTHER, `${B}/public-profiles/victim.jpg`, `${B}/estimates/plan.pdf`])('GET /:id/pdf refuses to proxy %s', async (url) => {
  getBytesByUrl.mockResolvedValue(Buffer.from('secret'));
  rowFor(url);
  const res = await request(makeApp()).get('/api/takeoffs/5/pdf');
  expect(res.status).toBe(404);
  expect(getBytesByUrl).not.toHaveBeenCalled();
});
