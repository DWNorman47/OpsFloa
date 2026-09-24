/**
 * Ephemeral live-collaboration sessions for the plan tools.
 *
 * A host "goes live" on a local project; teammates join and co-edit in real
 * time. Transport: Server-Sent Events for server→client push (real-time, no
 * ws dependency, robust through Render's proxy), REST POST for client→server
 * ops. REST is the source of truth; the SSE stream is a live-notification
 * layer — if it drops, the tool degrades to REST + refetch on reconnect.
 *
 * Sync model: markups are opaque objects keyed by id, last-writer-wins by a
 * client timestamp; the doc settings blob is LWW too. The server holds each
 * room in memory and snapshots to live_sessions.state every few seconds, so a
 * session survives host disconnects and a server restart (bounded to seconds).
 *
 * Mounting (see index.js): the REST router mounts behind requireAuth +
 * requirePlanToolsAddon; the SSE stream mounts separately (before requireAuth)
 * because EventSource can't set an Authorization header. It authenticates with a
 * short-lived, single-use STREAM TICKET minted by the gated
 * POST /:id/stream-ticket — never the full session JWT (which would land in
 * request logs and outlive a deactivation). See streamHandler.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const router = require('express').Router();
const pool = require('../db');
const { getObjectStreamByUrl, uploadBase64, keyBelongsTo, safeKeyFromPublicUrl } = require('../r2');
const { takeoffFolder, pdfUrlBelongsToCompany: takeoffPdfBelongsToCompany } = require('./takeoffs');
const { LIVE_SESSION_TOOLS, LIVE_SESSION_TOOL_DEFAULT } = require('../constants/liveSessionEnums');
const { checkSessionClaims, planToolsAllowed } = require('../middleware/auth');
const { validateOps, validateSessionDoc, validateSessionObjects } = require('../utils/planDocValidate');

const rooms = new Map();        // sessionId(string) -> Room
const SNAPSHOT_MS = 4000;       // coalesce DB snapshots
const HEARTBEAT_MS = 20000;     // SSE keep-alive ping
const isAdmin = req => req.user.role === 'admin' || req.user.role === 'super_admin';

/* ------------------------------ stream tickets ------------------------------ */

// A ticket is a JWT signed with a key DERIVED from JWT_SECRET (so no other
// jwt.verify in the app — requireAuth, setup/MFA — can ever accept one) plus a
// distinct audience, lives 60s, and is single-use (jti burned on first connect).
// It binds: user, company, session id, token version / impersonation claims (re-
// checked live on connect), and the SSE client id — namespaced by user server-side
// so a co-worker can't claim another participant's slot.
const TICKET_AUD = 'live-stream';
const TICKET_TTL_S = 60;
const ticketKey = () => crypto.createHmac('sha256', String(process.env.JWT_SECRET || '')).update('opsfloa:live-stream-ticket:v1').digest();
const usedTickets = new Map();  // jti -> expiry(ms); in-memory single-use guard
function burnTicket(jti, expMs) {
  const now = Date.now();
  for (const [k, e] of usedTickets) if (e < now) usedTickets.delete(k);
  if (usedTickets.has(jti)) return false;
  usedTickets.set(jti, expMs);
  return true;
}
// Client-chosen id (only used to skip echoing a client's own ops back to it),
// sanitized and bound to the authenticated user so ids can't collide across users.
const safeClientId = raw => String(raw || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64);
const clientKey = (userId, raw) => `${userId}:${safeClientId(raw) || crypto.randomBytes(8).toString('hex')}`;

// Transition: until this date, the stream still accepts an old-style `?token=<session
// JWT>` (a cached pre-ticket Plan Room), but ONLY after the same live checks as
// requireAuth (tv/active/impersonation) + the plan-tools add-on, and it logs a warning.
// After it, only tickets are accepted. Delete the legacy branch once past.
const LEGACY_STREAM_TOKEN_SUNSET = Date.parse('2026-10-31T00:00:00Z');

function mintStreamTicket(user, sessionId, rawClientId) {
  const claims = {
    uid: user.id, cid: user.company_id, sid: String(sessionId),
    cl: clientKey(user.id, rawClientId),
    jti: crypto.randomBytes(12).toString('hex'),
  };
  // Carry the revocation-relevant claims under non-session names, re-checked on connect.
  if (user.tv != null) claims.ttv = user.tv;
  if (user.imp) { claims.timp = true; if (user.imp_by != null) claims.timp_by = user.imp_by; }
  return jwt.sign(claims, ticketKey(), { audience: TICKET_AUD, expiresIn: TICKET_TTL_S, algorithm: 'HS256' });
}

// Plan-doc storage for sessions. A presigned upload comes from the takeoffs
// /upload-url (so it lives under takeoffs/<company_id>/); the base64 fallback is
// stored under live-sessions/<company_id>/. A client-supplied pdfUrl must be one
// issued to the caller's company — otherwise GET /:id/pdf would proxy another
// tenant's object.
function liveSessionFolder(companyId) {
  return `live-sessions/${takeoffFolder(companyId).slice('takeoffs/'.length)}`;
}
function sessionPdfUrlAllowed(url, companyId) {
  return takeoffPdfBelongsToCompany(url, companyId) || keyBelongsTo(String(url || ''), liveSessionFolder(companyId));
}
// Rows from before the per-company folders hold a flat `takeoffs/<uuid>.<ext>` or
// `live-sessions/<uuid>.<ext>` key; keep those readable, but nothing else.
function isLegacySessionPdfUrl(url) {
  const key = safeKeyFromPublicUrl(String(url || ''));
  return !!key && /^(takeoffs|live-sessions)\/[^/]+$/.test(key);
}

/* ------------------------------ room helpers ------------------------------ */

const liveEntries = room => [...room.objects.values()].filter(v => v.data && !v.deleted);
function dbState(room) {
  return { objects: liveEntries(room).map(v => ({ o: v.data, ts: v.ts })), doc: room.doc };
}
function clientObjects(room) { return liveEntries(room).map(v => v.data); }

async function snapshot(room) {
  room.dirty = false;
  try {
    await pool.query(
      `UPDATE live_sessions SET state = $1, last_activity_at = now() WHERE id = $2 AND status = 'active'`,
      [JSON.stringify(dbState(room)), room.id]);
  } catch (_) { /* transient — next tick retries */ }
}
function markDirty(room) {
  room.dirty = true;
  if (!room.snapTimer) {
    room.snapTimer = setTimeout(() => { room.snapTimer = null; if (room.dirty) snapshot(room); }, SNAPSHOT_MS);
  }
}

function sseWrite(res, payload) {
  try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (_) {}
}
function broadcast(room, payload, exceptClientId) {
  for (const [cid, c] of room.clients) if (cid !== exceptClientId) sseWrite(c.res, payload);
}
function roster(room) {
  const seen = new Map();
  for (const c of room.clients.values()) if (!seen.has(c.userId)) seen.set(c.userId, c.name);
  return [...seen.entries()].map(([userId, name]) => ({ userId, name }));
}
function broadcastPresence(room) {
  broadcast(room, { type: 'presence', roster: roster(room), count: room.clients.size });
}

// Rehydrate a room from its DB row (memory miss / after a restart).
async function loadRoom(id) {
  if (rooms.has(id)) return rooms.get(id);
  const { rows } = await pool.query(`SELECT * FROM live_sessions WHERE id = $1 AND status = 'active'`, [id]);
  if (!rows.length) return null;
  const r = rows[0];
  const st = r.state || {};
  const room = {
    id: String(r.id), companyId: String(r.company_id), tool: r.tool,
    meta: { name: r.name, pdfUrl: r.pdf_url, pdfName: r.pdf_name, hostUserId: r.host_user_id },
    clients: new Map(),
    objects: new Map((st.objects || []).filter(x => x.o && x.o.id).map(x => [x.o.id, { data: x.o, ts: x.ts || 0 }])),
    doc: st.doc || {},
    dirty: false, snapTimer: null,
  };
  rooms.set(room.id, room);
  return room;
}

function applyOps(room, ops) {
  for (const op of ops || []) {
    if (!op || !op.id) continue;
    const ts = Number(op.ts) || Date.now();
    const cur = room.objects.get(op.id);
    if (cur && cur.ts > ts) continue;                 // stale — a newer write won
    if (op.t === 'del') room.objects.set(op.id, { data: null, ts, deleted: true });
    else if (op.t === 'up' && op.o) room.objects.set(op.id, { data: op.o, ts });
  }
  // drop tombstones from the client-facing view but keep ts for LWW
}

/* ------------------------------ REST (gated) ------------------------------ */

// POST /  — start a session on the caller's current project.
// { tool?, name, pdfUrl?, pdfName?, objects?, doc? }
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    const tool = LIVE_SESSION_TOOLS.includes(b.tool) ? b.tool : LIVE_SESSION_TOOL_DEFAULT;
    // Everything here is relayed to teammates' browsers — reject malformed shapes up front.
    const bad = validateSessionObjects(b.objects) || validateSessionDoc(b.doc);
    if (bad) return res.status(400).json({ error: 'invalid session data', detail: bad });
    let pdfUrl = null;
    if (b.pdfUrl) { if (!sessionPdfUrlAllowed(b.pdfUrl, req.user.company_id)) return res.status(400).json({ error: 'bad pdfUrl' }); pdfUrl = String(b.pdfUrl); }
    // CORS-free fallback: the host couldn't PUT straight to R2, so it sent the
    // plan PDF as base64 — store it server-side (same path as shared takeoffs).
    else if (b.pdfBase64) { const up = await uploadBase64(`data:application/pdf;base64,${b.pdfBase64}`, liveSessionFolder(req.user.company_id)); pdfUrl = up.url; }
    const objects = Array.isArray(b.objects) ? b.objects.filter(o => o && o.id) : [];
    const doc = (b.doc && typeof b.doc === 'object') ? b.doc : {};
    const state = { objects: objects.map(o => ({ o, ts: Date.now() })), doc };
    const { rows } = await pool.query(
      `INSERT INTO live_sessions (company_id, tool, host_user_id, name, pdf_url, pdf_name, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [req.user.company_id, tool, req.user.id, String(b.name || 'Live session').slice(0, 200), pdfUrl, b.pdfName || null, JSON.stringify(state)]);
    const id = String(rows[0].id);
    // Arm the idle-session sweep while sessions are live (it disarms once all end, so the
    // DB can idle). Lazy require avoids a circular import — the sweep imports `rooms` here.
    require('../jobs/liveSessionSweep').noteLiveSessionActive();
    rooms.set(id, {
      id, companyId: String(req.user.company_id), tool,
      meta: { name: b.name || 'Live session', pdfUrl, pdfName: b.pdfName || null, hostUserId: req.user.id },
      clients: new Map(),
      objects: new Map(objects.map(o => [o.id, { data: o, ts: Date.now() }])),
      doc, dirty: false, snapTimer: null,
    });
    res.json({ id });
  } catch (err) { req.log && req.log.error({ err }, 'live start'); res.status(500).json({ error: 'server error' }); }
});

// GET /  — active sessions for the company (optionally one tool)
router.get('/', async (req, res) => {
  try {
    const tool = req.query.tool ? String(req.query.tool) : null;
    const { rows } = await pool.query(
      `SELECT s.id, s.tool, s.name, s.pdf_name, s.host_user_id, s.created_at, u.full_name AS host_name
         FROM live_sessions s LEFT JOIN users u ON u.id = s.host_user_id
        WHERE s.company_id = $1 AND s.status = 'active' ${tool ? 'AND s.tool = $2' : ''}
        ORDER BY s.created_at DESC`,
      tool ? [req.user.company_id, tool] : [req.user.company_id]);
    res.json(rows.map(r => ({
      ...r,
      participants: rooms.get(String(r.id)) ? rooms.get(String(r.id)).clients.size : 0,
      // lets the client offer an "End" control so a lingering/abandoned session can
      // be closed straight from the list (same authority as POST /:id/end)
      can_end: String(r.host_user_id) === String(req.user.id) || isAdmin(req),
    })));
  } catch (err) { req.log && req.log.error({ err }, 'live list'); res.status(500).json({ error: 'server error' }); }
});

// GET /:id  — join info: current snapshot + plan-doc reference
router.get('/:id', async (req, res) => {
  try {
    const room = await loadRoom(String(req.params.id));
    if (!room || room.companyId !== String(req.user.company_id)) return res.status(404).json({ error: 'not found' });
    res.json({
      id: room.id, tool: room.tool, name: room.meta.name,
      pdfUrl: room.meta.pdfUrl, pdfName: room.meta.pdfName, hostUserId: room.meta.hostUserId,
      objects: clientObjects(room), doc: room.doc, roster: roster(room),
    });
  } catch (err) { req.log && req.log.error({ err }, 'live join'); res.status(500).json({ error: 'server error' }); }
});

// POST /:id/stream-ticket  { clientId? } — mint a 60s single-use ticket for the SSE
// stream (EventSource can't send the Bearer header). Behind requireAuth +
// requirePlanToolsAddon like the rest of this router.
router.post('/:id/stream-ticket', async (req, res) => {
  try {
    const room = await loadRoom(String(req.params.id));
    if (!room || room.companyId !== String(req.user.company_id)) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    res.set('Cache-Control', 'no-store');
    res.json({ ticket: mintStreamTicket(req.user, room.id, b.clientId), expiresIn: TICKET_TTL_S });
  } catch (err) { req.log && req.log.error({ err }, 'live ticket'); res.status(500).json({ error: 'server error' }); }
});

// GET /:id/pdf  — the session's plan doc, STREAMED from R2 as application/pdf (no
// R2 CORS needed to read; a joiner downloads it once on join). Streaming — not a
// buffered base64 JSON blob — keeps a big plan set from costing ~3.5x its size in
// server memory per concurrent joiner.
router.get('/:id/pdf', async (req, res) => {
  try {
    const room = await loadRoom(String(req.params.id));
    if (!room || room.companyId !== String(req.user.company_id)) return res.status(404).json({ error: 'not found' });
    if (!room.meta.pdfUrl) return res.status(404).json({ error: 'no pdf' });
    if (!sessionPdfUrlAllowed(room.meta.pdfUrl, room.companyId) && !isLegacySessionPdfUrl(room.meta.pdfUrl)) {
      return res.status(404).json({ error: 'no pdf' });
    }
    const obj = await getObjectStreamByUrl(room.meta.pdfUrl);
    if (!obj || !obj.body) return res.status(404).json({ error: 'no pdf' });
    const fname = String(room.meta.pdfName || 'plans.pdf').replace(/[^A-Za-z0-9 ._()-]/g, '_').slice(0, 150) || 'plans.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    if (obj.contentLength) res.setHeader('Content-Length', String(obj.contentLength));
    res.setHeader('Content-Disposition', `inline; filename="${fname}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    obj.body.on('error', err => {
      req.log && req.log.error({ err }, 'live pdf stream');
      if (!res.headersSent) res.status(500).json({ error: 'server error' });
      else res.destroy(err);
    });
    obj.body.pipe(res);
  } catch (err) { req.log && req.log.error({ err }, 'live pdf'); if (!res.headersSent) res.status(500).json({ error: 'server error' }); }
});

// POST /:id/op  — apply markup ops + doc settings, broadcast to others
router.post('/:id/op', async (req, res) => {
  try {
    const room = await loadRoom(String(req.params.id));
    if (!room || room.companyId !== String(req.user.company_id)) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    // Validate BEFORE applying or relaying: ops/doc are rendered by every other
    // participant, so a malformed batch is rejected whole (nothing applied).
    const bad = validateOps(b.ops) || validateSessionDoc(b.doc);
    if (bad) return res.status(400).json({ error: 'invalid ops', detail: bad });
    if (Array.isArray(b.ops) && b.ops.length) applyOps(room, b.ops);
    if (b.doc && typeof b.doc === 'object') {
      const ts = Number(b.docTs) || Date.now();
      if (!room.docTs || ts >= room.docTs) { room.doc = { ...room.doc, ...b.doc }; room.docTs = ts; }
    }
    // relay verbatim to everyone else in the room (stream slots are keyed
    // `<userId>:<clientId>`, so the echo-skip can only ever match the caller's own)
    broadcast(room, { type: 'ops', ops: b.ops || [], doc: b.doc || null, by: req.user.id },
      b.clientId ? `${req.user.id}:${safeClientId(b.clientId)}` : undefined);
    markDirty(room);
    res.json({ ok: true });
  } catch (err) { req.log && req.log.error({ err }, 'live op'); res.status(500).json({ error: 'server error' }); }
});

// POST /:id/end  — host or admin ends it for everyone
router.post('/:id/end', async (req, res) => {
  try {
    const id = String(req.params.id);
    const room = await loadRoom(id);
    if (!room || room.companyId !== String(req.user.company_id)) return res.status(404).json({ error: 'not found' });
    // String-coerce both sides: a rehydrated room's hostUserId comes from the DB
    // (may be a number) while req.user.id comes from the JWT (may be a string), and
    // a bare !== there 403s the real host — so "End for all" silently fails and the
    // session lingers as joinable. (Matches the String() cast used for company_id.)
    if (String(room.meta.hostUserId) !== String(req.user.id) && !isAdmin(req)) return res.status(403).json({ error: 'only the host or an admin can end it' });
    await snapshot(room);
    await pool.query(`UPDATE live_sessions SET status = 'ended', ended_at = now() WHERE id = $1`, [id]);
    broadcast(room, { type: 'ended' });
    for (const c of room.clients.values()) { try { c.res.end(); } catch (_) {} }
    if (room.snapTimer) clearTimeout(room.snapTimer);
    rooms.delete(id);
    res.json({ ok: true });
  } catch (err) { req.log && req.log.error({ err }, 'live end'); res.status(500).json({ error: 'server error' }); }
});

/* ------------------------------ SSE stream (ticket auth) ------------------------------ */

const REVALIDATE_MS = 5 * 60 * 1000; // re-run the revocation checks on long-lived streams

// Resolve who is connecting. Returns { claims, clientKey, legacy } or { status }.
function streamIdentity(req, sessionId) {
  const q = req.query || {};
  if (q.ticket) {
    let t;
    try { t = jwt.verify(String(q.ticket), ticketKey(), { audience: TICKET_AUD, algorithms: ['HS256'] }); }
    catch { return { status: 401 }; }
    if (t.uid == null || !t.jti || !t.cl || String(t.sid) !== sessionId) return { status: 401 };
    if (!String(t.cl).startsWith(`${t.uid}:`)) return { status: 401 };
    if (!burnTicket(String(t.jti), (Number(t.exp) || 0) * 1000 + 1000)) return { status: 401 }; // replay
    return {
      claims: { id: t.uid, company_id: t.cid, tv: t.ttv, imp: t.timp, imp_by: t.timp_by },
      clientKey: String(t.cl), legacy: false,
    };
  }
  // Transitional: an old cached client still sends its full session JWT. Accepted only
  // until the sunset, and only after the same checks requireAuth runs (below).
  if (q.token && Date.now() < LEGACY_STREAM_TOKEN_SUNSET) {
    let p;
    try { p = jwt.verify(String(q.token), process.env.JWT_SECRET); } catch { return { status: 401 }; }
    if (p.tv == null && !p.imp) return { status: 401 }; // mfa/setup challenge tokens never stream
    return {
      claims: { id: p.id, company_id: p.company_id, tv: p.tv, imp: p.imp, imp_by: p.imp_by },
      clientKey: clientKey(p.id, q.client), legacy: true,
    };
  }
  return { status: 401 };
}

// Same gates as the REST router (requireAuth's live checks + requirePlanToolsAddon).
async function streamAllowed(claims) {
  const chk = await checkSessionClaims(claims);
  if (!chk.ok) return chk.status || 401;
  if (!planToolsAllowed(chk.company)) return 403;
  return 0;
}

async function streamHandler(req, res) {
  const id = String(req.params.id);
  const who = streamIdentity(req, id);
  if (who.status) return res.status(who.status).end();
  const { claims, clientKey: clientId } = who;
  const denied = await streamAllowed(claims);
  if (denied) return res.status(denied).end();
  if (who.legacy) {
    const log = req.log || require('../logger');
    log.warn({ userId: claims.id, sessionId: id }, 'live stream: legacy ?token= auth (pre-ticket client) — accepted during transition');
  }

  let room;
  try { room = await loadRoom(id); } catch { return res.status(500).end(); }
  if (!room || room.companyId !== String(claims.company_id)) return res.status(404).end();

  let name = 'Teammate';
  try { const u = await pool.query('SELECT full_name FROM users WHERE id = $1', [claims.id]); if (u.rows[0]) name = u.rows[0].full_name; } catch (_) {}

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  // A reconnect from the SAME user+client replaces its old slot; close the stale one.
  const prev = room.clients.get(clientId);
  if (prev && prev.res !== res) { try { prev.res.end(); } catch (_) {} }
  const entry = { res, userId: claims.id, name };
  room.clients.set(clientId, entry);
  sseWrite(res, { type: 'init', objects: clientObjects(room), doc: room.doc, meta: room.meta, roster: roster(room), you: claims.id });
  broadcastPresence(room);

  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, HEARTBEAT_MS);
  // A stream can stay open for hours; re-run the revocation checks periodically so a
  // deactivated user / changed password / lost add-on drops off without a reconnect.
  const reval = setInterval(async () => {
    let bad = 0;
    try { bad = await streamAllowed(claims); } catch (_) { bad = 0; }
    if (bad === 401 || bad === 403) { try { res.end(); } catch (_) {} }
  }, REVALIDATE_MS);
  if (reval.unref) reval.unref();
  req.on('close', () => {
    clearInterval(hb);
    clearInterval(reval);
    const r = rooms.get(id);
    // only drop the slot if it's still ours (a reconnect may have replaced it)
    if (r && r.clients.get(clientId) === entry) { r.clients.delete(clientId); broadcastPresence(r); }
  });
}

/* ------------------------------ graceful shutdown ------------------------------ */

// Persist every room's pending (debounced, up to SNAPSHOT_MS old) edits, then close
// the open SSE streams so the HTTP server can drain. Called from the SIGTERM handler
// in index.js. Clients reconnect (fresh ticket) to the next instance, which rehydrates
// the room from the snapshot. Never throws.
async function flushAll({ closeStreams = true } = {}) {
  const pending = [];
  for (const room of rooms.values()) {
    if (room.snapTimer) { clearTimeout(room.snapTimer); room.snapTimer = null; }
    if (room.dirty) pending.push(snapshot(room));
  }
  await Promise.allSettled(pending);
  if (closeStreams) {
    for (const room of rooms.values()) {
      for (const c of room.clients.values()) { try { c.res.end(); } catch (_) {} }
    }
  }
  return pending.length;
}

module.exports = { router, streamHandler, rooms, flushAll, mintStreamTicket };
module.exports.flushAll = flushAll;
