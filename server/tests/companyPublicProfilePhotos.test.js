/**
 * Company public profile photos (Bug: cross-tenant R2 delete + storage-quota bypass).
 *  - A non-data photo url is kept only if it is already on this company's saved
 *    profile; any other url (e.g. another company's public photo) is dropped.
 *  - size_bytes always comes from the saved record / the upload, never the client.
 *  - Removing a photo deletes + refunds it only when it's ours (saved AND under
 *    public-profiles/).
 *  - The error path deletes only objects uploaded by this request.
 */
process.env.R2_PUBLIC_URL = 'https://cdn.example.com';

let mockUser;
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = mockUser; next(); },
  requirePerm: () => (_req, _res, next) => next(),
}));
jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn(() => Promise.resolve()) }));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../storage', () => ({
  checkStorageLimit: jest.fn(() => Promise.resolve({ allowed: true, used: 0, limit: 1e9 })),
  incrementStorage: jest.fn(() => Promise.resolve()),
  decrementStorage: jest.fn(() => Promise.resolve()),
}));
jest.mock('../r2', () => {
  const actual = jest.requireActual('../r2');
  return {
    keyBelongsTo: actual.keyBelongsTo,
    safeKeyFromPublicUrl: actual.safeKeyFromPublicUrl,
    uploadBase64: jest.fn(),
    deleteByUrl: jest.fn(() => Promise.resolve()),
  };
});

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const { uploadBase64, deleteByUrl } = require('../r2');
const { incrementStorage, decrementStorage } = require('../storage');
const profiles = require('../routes/companyPublicProfiles');

const OWN = 'https://cdn.example.com/public-profiles/own-1.jpg';
const OWN2 = 'https://cdn.example.com/public-profiles/own-2.jpg';
const VICTIM = 'https://cdn.example.com/public-profiles/victim.jpg';
const NEW_UP = 'https://cdn.example.com/public-profiles/new-upload.png';
const DATA = 'data:image/png;base64,aGVsbG8=';

let savedPhotos;    // photos currently on the company's profile row
let insertedPhotos; // photos the route tried to save
let failInsert;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/company-profile', profiles);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { id: 1, company_id: 7, full_name: 'Admin Amy', role: 'admin' };
  savedPhotos = [];
  insertedPhotos = null;
  failInsert = false;
  uploadBase64.mockResolvedValue({ url: NEW_UP, sizeBytes: 5000 });
  pool.query.mockImplementation(async (sql, params) => {
    if (/FROM companies c\s+LEFT JOIN company_public_profiles/.test(sql)) {
      return { rows: [{ company_id: 7, company_name: 'Acme', slug: 'acme', photos: savedPhotos, is_public: false }] };
    }
    if (/INSERT INTO company_public_profiles/.test(sql)) {
      if (failInsert) throw new Error('db down');
      insertedPhotos = JSON.parse(params[11]);
      return { rows: [{ company_id: 7, photos: insertedPhotos }] };
    }
    return { rows: [] };
  });
});

const patch = (photos) => request(makeApp()).patch('/api/company-profile').send({ short_description: 'x', photos });

test('a foreign url is dropped: not saved, never deleted, no storage change', async () => {
  const res = await patch([{ url: VICTIM, size_bytes: 999999999 }]);
  expect(res.status).toBe(200);
  expect(insertedPhotos).toEqual([]);
  expect(deleteByUrl).not.toHaveBeenCalled();
  expect(decrementStorage).not.toHaveBeenCalled();
});

test('the full exploit (inject victim url, then remove it) never deletes the victim file', async () => {
  await patch([{ url: VICTIM, size_bytes: 999999999 }]);
  savedPhotos = insertedPhotos; // whatever got saved is now "existing"
  await patch([]);
  expect(deleteByUrl).not.toHaveBeenCalledWith(VICTIM);
  expect(decrementStorage).not.toHaveBeenCalled();
});

test('kept existing photo uses the saved size, ignoring client size_bytes', async () => {
  savedPhotos = [{ url: OWN, size_bytes: 1234, caption: '' }];
  await patch([{ url: OWN, size_bytes: 999999999, caption: 'hi' }]);
  expect(insertedPhotos).toEqual([{ url: OWN, caption: 'hi', alt: '', size_bytes: 1234 }]);
  expect(deleteByUrl).not.toHaveBeenCalled();
});

test('duplicate entries of the same url are collapsed', async () => {
  savedPhotos = [{ url: OWN, size_bytes: 1234 }];
  await patch([{ url: OWN }, { url: OWN }]);
  expect(insertedPhotos).toHaveLength(1);
});

test('removing an owned photo deletes it and refunds its SAVED size', async () => {
  savedPhotos = [{ url: OWN, size_bytes: 1234 }, { url: OWN2, size_bytes: 50 }];
  await patch([{ url: OWN2 }]);
  expect(deleteByUrl).toHaveBeenCalledTimes(1);
  expect(deleteByUrl).toHaveBeenCalledWith(OWN);
  expect(decrementStorage).toHaveBeenCalledWith(7, 1234);
});

test('a legacy foreign url on the saved profile is dropped on removal but NOT deleted', async () => {
  // e.g. saved before this fix: an arbitrary https url, or one outside public-profiles/
  const OUTSIDE = 'https://cdn.example.com/takeoffs/8/plan.pdf';
  const EXTERNAL = 'https://elsewhere.example.org/pic.jpg';
  savedPhotos = [{ url: OUTSIDE, size_bytes: 10 }, { url: EXTERNAL, size_bytes: 10 }];
  await patch([]);
  expect(deleteByUrl).not.toHaveBeenCalled();
  expect(decrementStorage).not.toHaveBeenCalled();
});

test('new data-url upload is counted from the upload size, not the client', async () => {
  await patch([{ url: DATA, size_bytes: 1 }]);
  expect(uploadBase64).toHaveBeenCalledWith(DATA, 'public-profiles');
  expect(incrementStorage).toHaveBeenCalledWith(7, 5000);
  expect(insertedPhotos).toEqual([{ url: NEW_UP, caption: '', alt: '', size_bytes: 5000 }]);
});

test('error path deletes only uploads from this request, never existing/foreign urls', async () => {
  savedPhotos = [{ url: OWN, size_bytes: 1234 }];
  failInsert = true;
  const res = await patch([{ url: OWN }, { url: VICTIM }, { url: DATA }]);
  expect(res.status).toBe(500);
  expect(deleteByUrl).toHaveBeenCalledTimes(1);
  expect(deleteByUrl).toHaveBeenCalledWith(NEW_UP);
  expect(decrementStorage).toHaveBeenCalledWith(7, 5000);
});

test('an upload failing part-way rolls back the earlier upload without a refund', async () => {
  uploadBase64
    .mockResolvedValueOnce({ url: NEW_UP, sizeBytes: 5000 })
    .mockRejectedValueOnce(new Error('r2 down'));
  const res = await patch([{ url: DATA }, { url: DATA }]);
  expect(res.status).toBe(500);
  expect(deleteByUrl).toHaveBeenCalledWith(NEW_UP);
  expect(incrementStorage).not.toHaveBeenCalled();
  expect(decrementStorage).not.toHaveBeenCalled();
});
