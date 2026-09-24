/**
 * Shape / size validation for Plan Room documents written by clients and then
 * served to OTHER users: live co-edit ops + doc settings (routes/liveSessions.js)
 * and company-shared takeoffs (routes/takeoffs.js).
 *
 * The data is otherwise opaque to the server, but it is rendered by teammates'
 * browsers, so we reject anything a legit client could never have produced:
 * oversized payloads, non-finite / non-numeric values in numeric slots, overlong
 * strings, absurd nesting. The Plan Room client (tool-apps/planroom/app.js)
 * escapes on render and normalizes on load too — this is the server-side layer.
 *
 * Numeric slots accept a finite number, a numeric string ("12.5" — legacy / input
 * values), '' or null. Everything else in a numeric slot is rejected.
 *
 * Every validator returns null when OK, or a short reason string.
 */

const LIMITS = {
  docBytes: 24 * 1024 * 1024,   // a whole shared takeoff's `data` JSON
  sessionDocBytes: 2 * 1024 * 1024, // live-session doc settings blob
  opsBytes: 24 * 1024 * 1024,   // one POST /op's ops array
  markupBytes: 8 * 1024 * 1024, // one markup (auto-traced contours carry many points)
  ops: 20000,                   // ops per POST /op
  markups: 50000,               // markups per doc / session
  pts: 200000,                  // points per ring
  holes: 2000,                  // hole rings per markup
  id: 128,
  shortStr: 64,                 // kind / surface / etype / itype / color
  text: 20000,                  // note text
  str: 20000,                   // any other string
  keys: 10000,                  // keys per object (scales/scaleBars are keyed by page)
  depth: 12,
};

const NUMERIC_STR = /^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i;
const isPlain = v => !!v && typeof v === 'object' && !Array.isArray(v);
const isNumLike = v =>
  v === null || v === undefined || v === '' ||
  (typeof v === 'number' && Number.isFinite(v)) ||
  (typeof v === 'string' && v.length <= 40 && NUMERIC_STR.test(v) && Number.isFinite(Number(v)));

// Generic walk: finite numbers only, bounded strings / keys / depth.
function checkDeep(v, depth = 0, maxStr = LIMITS.str) {
  if (depth > LIMITS.depth) return 'too deeply nested';
  if (v === null || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? null : 'non-finite number';
  if (typeof v === 'string') return v.length > maxStr ? 'string too long' : null;
  if (Array.isArray(v)) {
    for (const x of v) { const e = checkDeep(x, depth + 1, maxStr); if (e) return e; }
    return null;
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length > LIMITS.keys) return 'too many keys';
    for (const k of keys) {
      if (k.length > 200) return 'key too long';
      const e = checkDeep(v[k], depth + 1, maxStr);
      if (e) return e;
    }
    return null;
  }
  return 'unsupported value';
}

function checkPt(p) {
  if (!isPlain(p)) return 'bad point';
  if (typeof p.x !== 'number' && typeof p.x !== 'string') return 'bad point';
  if (typeof p.y !== 'number' && typeof p.y !== 'string') return 'bad point';
  if (!isNumLike(p.x) || !isNumLike(p.y) || p.x === '' || p.y === '') return 'bad point';
  return null;
}
function checkRing(r, name) {
  if (!Array.isArray(r)) return `${name} must be an array`;
  if (r.length > LIMITS.pts) return `${name} has too many points`;
  for (const p of r) { const e = checkPt(p); if (e) return `${name}: ${e}`; }
  return null;
}

const MK_NUM = ['page', 'elev', 'width', 'pitch', 'fontSize', 'height', 'sides', 'created', 'modified'];
const MK_SHORT = ['kind', 'surface', 'etype', 'itype', 'color'];

function validateMarkup(m) {
  if (!isPlain(m)) return 'markup must be an object';
  const idOk = (typeof m.id === 'string' && m.id.length > 0 && m.id.length <= LIMITS.id) ||
    (typeof m.id === 'number' && Number.isFinite(m.id));
  if (!idOk) return 'bad markup id';
  for (const k of MK_NUM) if (k in m && !isNumLike(m[k])) return `markup.${k} must be a number`;
  for (const k of MK_SHORT) {
    if (m[k] == null) continue;
    if (typeof m[k] !== 'string' || m[k].length > LIMITS.shortStr) return `bad markup.${k}`;
  }
  if (m.text != null && (typeof m.text !== 'string' || m.text.length > LIMITS.text)) return 'bad markup.text';
  if (m.pts != null) { const e = checkRing(m.pts, 'pts'); if (e) return e; }
  if (m.outer != null) { const e = checkRing(m.outer, 'outer'); if (e) return e; }
  if (m.holes != null) {
    if (!Array.isArray(m.holes) || m.holes.length > LIMITS.holes) return 'bad markup.holes';
    for (const h of m.holes) { const e = checkRing(h, 'hole'); if (e) return e; }
  }
  if (m.cfg != null && !isPlain(m.cfg)) return 'markup.cfg must be an object';
  return checkDeep(m);
}

function validateMarkups(arr) {
  if (!Array.isArray(arr)) return 'markups must be an array';
  if (arr.length > LIMITS.markups) return 'too many markups';
  for (const m of arr) { const e = validateMarkup(m); if (e) return e; }
  return null;
}

// Numeric settings each trade panel keeps (mirror of the client's default*()).
const SETTINGS_NUM = {
  earthwork: ['existingPage', 'proposedPage', 'gridFt', 'shrink', 'swell', 'truckCap', 'interval'],
  drywall: ['wallHeight', 'sheetSF', 'waste', 'coverage', 'coats'],
  flooring: ['waste', 'thinsetCov'],
  framing: ['spacing', 'height', 'topPlates', 'sheathWaste'],
  esc: ['entranceDepth', 'stoneDensity', 'seedRate', 'mulchRate', 'blanketWaste', 'riprapDepth'],
  striping: ['coverage4in', 'beadRate', 'coats'],
  siding: ['waste', 'insulWaste', 'battCoverage'],
  demo: ['swell', 'truckCap', 'thickAsphalt', 'thickConcrete', 'thickSidewalk', 'thickGravel'],
  fence: ['holeDia', 'holeDepth', 'bagCF'],
  landscape: ['mulchDepth', 'rockDepth', 'bedDepth', 'rockDensity', 'sodWaste', 'seedRate'],
};

function checkNumMap(obj, name) {
  if (obj == null) return null;
  if (!isPlain(obj)) return `${name} must be an object`;
  const keys = Object.keys(obj);
  if (keys.length > LIMITS.keys) return `${name} too large`;
  for (const k of keys) if (!isNumLike(obj[k])) return `${name} values must be numbers`;
  return null;
}

// The settings blob shared by a live session's `doc` and a takeoff's `data`
// (everything except the markups array).
function validateDocSettings(d) {
  if (!isPlain(d)) return 'doc must be an object';
  for (const k of ['page', 'roofPitch', 'roofWaste', 'roofOP']) if (k in d && !isNumLike(d[k])) return `${k} must be a number`;
  let e = checkNumMap(d.scales, 'scales') || checkNumMap(d.roofPrices, 'roofPrices');
  if (e) return e;
  if (d.scaleBars != null) {
    if (!isPlain(d.scaleBars)) return 'scaleBars must be an object';
    for (const b of Object.values(d.scaleBars)) {
      if (b == null) continue;
      if (!isPlain(b)) return 'bad scale bar';
      if (b.a != null && checkPt(b.a)) return 'bad scale bar';
      if (b.b != null && checkPt(b.b)) return 'bad scale bar';
      if (!isNumLike(b.feet)) return 'bad scale bar';
    }
  }
  for (const [sec, keys] of Object.entries(SETTINGS_NUM)) {
    const s = d[sec];
    if (s == null) continue;
    if (!isPlain(s)) return `${sec} must be an object`;
    for (const k of keys) if (k in s && !isNumLike(s[k])) return `${sec}.${k} must be a number`;
  }
  const ew = d.earthwork;
  if (isPlain(ew)) {
    if (ew.align != null) {
      if (!isPlain(ew.align)) return 'earthwork.align must be an object';
      for (const k of ['a', 'b', 'e', 'f']) if (k in ew.align && !isNumLike(ew.align[k])) return 'earthwork.align must be numbers';
    }
    if (ew.result != null) {
      if (!isPlain(ew.result)) return 'earthwork.result must be an object';
      for (const v of Object.values(ew.result)) if (!isNumLike(v)) return 'earthwork.result must be numbers';
    }
  }
  if (d.trade != null && (typeof d.trade !== 'string' || d.trade.length > LIMITS.shortStr)) return 'bad trade';
  if (d.bidMeta != null && !isPlain(d.bidMeta)) return 'bidMeta must be an object';
  // everything else (incl. keys this server doesn't know yet): generic bounds
  const rest = { ...d };
  delete rest.markups;
  return checkDeep(rest);
}

const jsonBytes = v => { try { return Buffer.byteLength(JSON.stringify(v) || ''); } catch { return Infinity; } };

// Live session: POST / body's objects + doc, and POST /:id/op body's ops + doc.
function validateSessionDoc(doc) {
  if (doc == null) return null;
  if (!isPlain(doc)) return 'doc must be an object';
  if (jsonBytes(doc) > LIMITS.sessionDocBytes) return 'doc too large';
  return validateDocSettings(doc);
}
function validateOps(ops) {
  if (ops == null) return null;
  if (!Array.isArray(ops)) return 'ops must be an array';
  if (ops.length > LIMITS.ops) return 'too many ops';
  if (jsonBytes(ops) > LIMITS.opsBytes) return 'ops too large';
  for (const op of ops) {
    if (!isPlain(op)) return 'op must be an object';
    if (op.t !== 'up' && op.t !== 'del') return 'bad op type';
    const idOk = (typeof op.id === 'string' && op.id.length > 0 && op.id.length <= LIMITS.id) ||
      (typeof op.id === 'number' && Number.isFinite(op.id));
    if (!idOk) return 'bad op id';
    if (op.ts != null && !(typeof op.ts === 'number' && Number.isFinite(op.ts))) return 'bad op ts';
    if (op.t === 'up') {
      if (!isPlain(op.o)) return 'op.o must be an object';
      if (String(op.o.id) !== String(op.id)) return 'op id mismatch';
      if (jsonBytes(op.o) > LIMITS.markupBytes) return 'markup too large';
      const e = validateMarkup(op.o);
      if (e) return e;
    }
  }
  return null;
}
function validateSessionObjects(objects) {
  if (objects == null) return null;
  if (jsonBytes(objects) > LIMITS.docBytes) return 'objects too large';
  return validateMarkups(objects);
}

// Shared takeoff `data`. Plan Room docs get the full shape check; any other
// app marker (legacy tools) only the generic size / depth / finite-number bounds.
function validateTakeoffData(data) {
  if (data == null) return null;
  if (!isPlain(data)) return 'data must be an object';
  if (jsonBytes(data) > LIMITS.docBytes) return 'data too large';
  if (data.app === 'plan-room') {
    if (data.markups != null) { const e = validateMarkups(data.markups); if (e) return e; }
    return validateDocSettings(data);
  }
  return checkDeep(data, 0, 4 * 1024 * 1024);
}

module.exports = {
  LIMITS,
  isNumLike,
  validateMarkup,
  validateMarkups,
  validateDocSettings,
  validateSessionDoc,
  validateSessionObjects,
  validateOps,
  validateTakeoffData,
};
