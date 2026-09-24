/**
 * Plan Room doc validation (utils/planDocValidate.js) + its wiring into the live
 * co-edit routes (POST /live, POST /live/:id/op) and shared takeoffs (POST/PUT).
 * Legit client payloads (shaped like tool-apps/planroom/app.js builds them) pass;
 * crafted values in numeric slots, oversized batches and bad op shapes get a 400
 * and are never applied / relayed / stored.
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
    getObjectStreamByUrl: jest.fn(),
    getPresignedUploadUrl: jest.fn(),
  };
});

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const V = require('../utils/planDocValidate');
const { router: liveRouter, rooms } = require('../routes/liveSessions');
const takeoffs = require('../routes/takeoffs');

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '64mb' }));
  app.use((req, _res, next) => { req.user = mockUser; req.log = { error: () => {} }; next(); });
  app.use('/api/live', liveRouter);
  app.use('/api/takeoffs', takeoffs);
  return app;
}

// Shaped like the client's markups / sessionDoc() / projectData().
const mk = (over = {}) => ({
  id: 'k3f9a', page: 2, kind: 'qarea', color: '#e0533f', width: 3, created: 1727000000000,
  pts: [{ x: 10.5, y: 20 }, { x: 30, y: 40 }, { x: 5, y: 60 }],
  cfg: { label: 'Gravel <base>', mode: 'volume', thickness: '4', deduct: false, color: '#aabbcc' },
  ...over,
});
const doc = (over = {}) => ({
  scales: { 1: 0.05, 2: 0.1 }, scaleBars: { 1: { a: { x: 1, y: 2 }, b: { x: 3, y: 2 }, feet: 20 } },
  page: 1, roofPitch: 6, roofWaste: 12, roofPrices: { shingles: 110 }, roofOP: 15,
  earthwork: { existingPage: null, proposedPage: 2, align: { a: 1, b: 0, e: 0, f: 0 }, gridFt: 5, shrink: 15, swell: 25, truckCap: 12, interval: 1, result: { cutCY: 10, fillCY: 4, areaFt2: 900, gridFt: 5 } },
  drywall: { wallHeight: 9, sheetSF: 32, waste: 10, coverage: 375, coats: 2, finish: 'L4', texture: 'none', insul: 'none' },
  flooring: { waste: 10, underlay: 'none', tileSize: '12x12', groutJoint: '3/16', thinsetCov: 95 },
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  rooms.clear();
  mockUser = { id: 1, company_id: 7, full_name: 'Host', role: 'member' };
  pool.query.mockImplementation(async (sql) => {
    if (/INSERT INTO live_sessions/.test(sql)) return { rows: [{ id: 42 }] };
    if (/INSERT INTO takeoff_projects/.test(sql)) return { rows: [{ id: 5, version: 1 }] };
    if (/SELECT t.version/.test(sql)) return { rows: [{ version: 3, locked_by: null }] };
    if (/UPDATE takeoff_projects/.test(sql)) return { rows: [{ version: 4 }] };
    return { rows: [] };
  });
});
afterEach(() => { for (const r of rooms.values()) if (r.snapTimer) { clearTimeout(r.snapTimer); r.snapTimer = null; } });
afterAll(() => rooms.clear());

describe('validators', () => {
  test('legit markups / docs pass', () => {
    expect(V.validateMarkup(mk())).toBeNull();
    expect(V.validateMarkup(mk({ kind: 'contour', elev: null, surface: 'existing' }))).toBeNull();
    expect(V.validateMarkup(mk({ outer: [{ x: 0, y: 0 }], holes: [[{ x: 1, y: 1 }]], text: 'note & <stuff>' }))).toBeNull();
    expect(V.validateMarkup(mk({ pitch: '6' }))).toBeNull(); // numeric string tolerated
    expect(V.validateDocSettings(doc())).toBeNull();
    expect(V.validateTakeoffData({ app: 'plan-room', version: 1, markups: [mk()], ...doc(), trade: 'dirt', bidMeta: { project: 'X' } })).toBeNull();
  });

  test.each([
    ['page is markup', mk({ page: '<img src=x onerror=alert(1)>' })],
    ['elev is html', mk({ elev: '"><svg onload=1>' })],
    ['point x is html', mk({ pts: [{ x: '<b>', y: 1 }] })],
    ['point is not an object', mk({ pts: [5] })],
    ['color too long', mk({ color: 'x'.repeat(65) })],
    ['kind not a string', mk({ kind: { a: 1 } })],
    ['cfg not an object', mk({ cfg: 'nope' })],
    ['missing id', mk({ id: '' })],
    ['non-finite number', mk({ width: Infinity })],
    ['huge text', mk({ text: 'a'.repeat(20001) })],
  ])('rejects markup: %s', (_n, m) => {
    expect(V.validateMarkup(m)).toEqual(expect.any(String));
  });

  test.each([
    ['sheetSF html', doc({ drywall: { sheetSF: '<img src=x>' } })],
    ['scale value html', doc({ scales: { 1: '<svg>' } })],
    ['roof price html', doc({ roofPrices: { shingles: '"><x>' } })],
    ['roofPitch object', doc({ roofPitch: { a: 1 } })],
    ['earthwork page html', doc({ earthwork: { existingPage: '<x>' } })],
    ['earthwork result html', doc({ earthwork: { result: { cutCY: '<x>' } } })],
    ['trade settings not object', doc({ fence: 'x' })],
    ['too deep', doc({ extra: JSON.parse('['.repeat(20) + ']'.repeat(20)) })],
  ])('rejects doc: %s', (_n, d) => {
    expect(V.validateDocSettings(d)).toEqual(expect.any(String));
  });

  test('op shape + caps', () => {
    expect(V.validateOps([{ t: 'up', id: 'k3f9a', o: mk(), ts: 1 }, { t: 'del', id: 'zz', ts: 2 }])).toBeNull();
    expect(V.validateOps([{ t: 'nuke', id: 'a' }])).toMatch(/op type/);
    expect(V.validateOps([{ t: 'up', id: 'other', o: mk() }])).toMatch(/mismatch/);
    expect(V.validateOps([{ t: 'up', id: 'k3f9a', o: mk(), ts: 'soon' }])).toMatch(/ts/);
    expect(V.validateOps(new Array(V.LIMITS.ops + 1).fill({ t: 'del', id: 'a' }))).toMatch(/too many/);
    expect(V.validateOps('x')).toMatch(/array/);
  });

  test('non plan-room takeoff data gets only the generic bounds', () => {
    expect(V.validateTakeoffData({ app: 'excavation-bid-calculator', rows: [{ qty: '12 cy' }] })).toBeNull();
    expect(V.validateTakeoffData('str')).toMatch(/object/);
  });
});

describe('live session routes', () => {
  async function startRoom(app) {
    const res = await request(app).post('/api/live').send({ name: 'L', objects: [mk()], doc: doc() });
    expect(res.status).toBe(200);
    return res.body.id;
  }

  test('POST / rejects a malformed markup and never inserts', async () => {
    const res = await request(makeApp()).post('/api/live').send({ name: 'L', objects: [mk({ page: '<x>' })] });
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('legit op batch applies; malformed batch is rejected whole', async () => {
    const app = makeApp();
    const id = await startRoom(app);
    const ok = await request(app).post(`/api/live/${id}/op`).send({
      clientId: 'c1', ops: [{ t: 'up', id: 'n1', o: mk({ id: 'n1' }), ts: Date.now() }], doc: doc({ roofOP: 20 }), docTs: Date.now(),
    });
    expect(ok.status).toBe(200);
    const room = rooms.get(String(id));
    expect(room.objects.has('n1')).toBe(true);
    expect(room.doc.roofOP).toBe(20);

    const bad = await request(app).post(`/api/live/${id}/op`).send({
      clientId: 'c1',
      ops: [{ t: 'up', id: 'n2', o: mk({ id: 'n2' }), ts: Date.now() }, { t: 'up', id: 'n3', o: mk({ id: 'n3', page: '<img src=x>' }), ts: Date.now() }],
    });
    expect(bad.status).toBe(400);
    expect(room.objects.has('n2')).toBe(false);
    expect(room.objects.has('n3')).toBe(false);

    const badDoc = await request(app).post(`/api/live/${id}/op`).send({ clientId: 'c1', ops: [], doc: { drywall: { sheetSF: '<b>' } } });
    expect(badDoc.status).toBe(400);
    expect(room.doc.drywall.sheetSF).toBe(32);
  });
});

describe('takeoff routes', () => {
  const data = (over = {}) => ({ app: 'plan-room', version: 1, markups: [mk()], ...doc(), ...over });

  test('POST stores a legit plan-room doc', async () => {
    const res = await request(makeApp()).post('/api/takeoffs').send({ name: 'T', data: data() });
    expect(res.status).toBe(200);
  });

  test('POST rejects a crafted plan-room doc without storing', async () => {
    const res = await request(makeApp()).post('/api/takeoffs').send({ name: 'T', data: data({ markups: [mk({ elev: '<svg onload=1>' })] }) });
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('PUT validates data; name-only saves still pass', async () => {
    const app = makeApp();
    const bad = await request(app).put('/api/takeoffs/5').send({ data: data({ roofPrices: { x: '<b>' } }), version: 3 });
    expect(bad.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
    const ok = await request(app).put('/api/takeoffs/5').send({ name: 'Renamed', version: 3 });
    expect(ok.status).toBe(200);
    const good = await request(app).put('/api/takeoffs/5').send({ data: data(), version: 3 });
    expect(good.status).toBe(200);
  });
});
