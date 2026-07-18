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
 * requirePlanToolsAddon; the SSE stream mounts separately with query-token
 * auth (EventSource can't set an Authorization header).
 */

const jwt = require('jsonwebtoken');
const router = require('express').Router();
const pool = require('../db');
const { keyFromPublicUrl, getBytesByUrl, uploadBase64 } = require('../r2');
const { LIVE_SESSION_TOOLS, LIVE_SESSION_TOOL_DEFAULT } = require('../constants/liveSessionEnums');

const rooms = new Map();        // sessionId(string) -> Room
const SNAPSHOT_MS = 4000;       // coalesce DB snapshots
const HEARTBEAT_MS = 20000;     // SSE keep-alive ping
const isAdmin = req => req.user.role === 'admin' || req.user.role === 'super_admin';

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
    let pdfUrl = null;
    if (b.pdfUrl) { if (!keyFromPublicUrl(String(b.pdfUrl))) return res.status(400).json({ error: 'bad pdfUrl' }); pdfUrl = String(b.pdfUrl); }
    // CORS-free fallback: the host couldn't PUT straight to R2, so it sent the
    // plan PDF as base64 — store it server-side (same path as shared takeoffs).
    else if (b.pdfBase64) { const up = await uploadBase64(`data:application/pdf;base64,${b.pdfBase64}`, 'live-sessions'); pdfUrl = up.url; }
    const objects = Array.isArray(b.objects) ? b.objects.filter(o => o && o.id) : [];
    const doc = (b.doc && typeof b.doc === 'object') ? b.doc : {};
    const state = { objects: objects.map(o => ({ o, ts: Date.now() })), doc };
    const { rows } = await pool.query(
      `INSERT INTO live_sessions (company_id, tool, host_user_id, name, pdf_url, pdf_name, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [req.user.company_id, tool, req.user.id, String(b.name || 'Live session').slice(0, 200), pdfUrl, b.pdfName || null, JSON.stringify(state)]);
    const id = String(rows[0].id);
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
    res.json(rows.map(r => ({ ...r, participants: rooms.get(String(r.id)) ? rooms.get(String(r.id)).clients.size : 0 })));
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

// GET /:id/pdf  — the session's plan doc, proxied from R2 as base64 (no R2 CORS
// needed to read; a joiner downloads it once on join)
router.get('/:id/pdf', async (req, res) => {
  try {
    const room = await loadRoom(String(req.params.id));
    if (!room || room.companyId !== String(req.user.company_id)) return res.status(404).json({ error: 'not found' });
    if (!room.meta.pdfUrl) return res.status(404).json({ error: 'no pdf' });
    const bytes = await getBytesByUrl(room.meta.pdfUrl);
    if (!bytes) return res.status(404).json({ error: 'no pdf' });
    res.json({ name: room.meta.pdfName || 'plans.pdf', b64: bytes.toString('base64') });
  } catch (err) { req.log && req.log.error({ err }, 'live pdf'); res.status(500).json({ error: 'server error' }); }
});

// POST /:id/op  — apply markup ops + doc settings, broadcast to others
router.post('/:id/op', async (req, res) => {
  try {
    const room = await loadRoom(String(req.params.id));
    if (!room || room.companyId !== String(req.user.company_id)) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    if (Array.isArray(b.ops) && b.ops.length) applyOps(room, b.ops);
    if (b.doc && typeof b.doc === 'object') {
      const ts = Number(b.docTs) || Date.now();
      if (!room.docTs || ts >= room.docTs) { room.doc = { ...room.doc, ...b.doc }; room.docTs = ts; }
    }
    // relay verbatim to everyone else in the room
    broadcast(room, { type: 'ops', ops: b.ops || [], doc: b.doc || null, by: req.user.id }, b.clientId);
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
    if (room.meta.hostUserId !== req.user.id && !isAdmin(req)) return res.status(403).json({ error: 'only the host or an admin can end it' });
    await snapshot(room);
    await pool.query(`UPDATE live_sessions SET status = 'ended', ended_at = now() WHERE id = $1`, [id]);
    broadcast(room, { type: 'ended' });
    for (const c of room.clients.values()) { try { c.res.end(); } catch (_) {} }
    if (room.snapTimer) clearTimeout(room.snapTimer);
    rooms.delete(id);
    res.json({ ok: true });
  } catch (err) { req.log && req.log.error({ err }, 'live end'); res.status(500).json({ error: 'server error' }); }
});

/* ------------------------------ SSE stream (query-token auth) ------------------------------ */

async function streamHandler(req, res) {
  let payload;
  try { payload = jwt.verify(String(req.query.token || ''), process.env.JWT_SECRET); } catch { return res.status(401).end(); }
  const id = String(req.params.id);
  const clientId = String(req.query.client || '') || (Date.now() + '-' + Math.random().toString(36).slice(2));
  let room;
  try { room = await loadRoom(id); } catch { return res.status(500).end(); }
  if (!room || room.companyId !== String(payload.company_id)) return res.status(404).end();

  let name = 'Teammate';
  try { const u = await pool.query('SELECT full_name FROM users WHERE id = $1', [payload.id]); if (u.rows[0]) name = u.rows[0].full_name; } catch (_) {}

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  room.clients.set(clientId, { res, userId: payload.id, name });
  sseWrite(res, { type: 'init', objects: clientObjects(room), doc: room.doc, meta: room.meta, roster: roster(room), you: payload.id });
  broadcastPresence(room);

  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, HEARTBEAT_MS);
  req.on('close', () => {
    clearInterval(hb);
    const r = rooms.get(id);
    if (r) { r.clients.delete(clientId); broadcastPresence(r); }
  });
}

module.exports = { router, streamHandler, rooms };
