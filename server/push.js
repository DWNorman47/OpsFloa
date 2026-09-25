const webpush = require('web-push');
const pool = require('./db');
const logger = require('./logger');

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    `mailto:${process.env.EMAIL_FROM || 'info@opsfloa.com'}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

const PUSH_TIMEOUT_MS = 10000; // per send; a hung push service can't stall a fan-out

// Web-push endpoints are URLs the SERVER POSTs to, so an unvalidated one is a blind
// SSRF (any user could aim our egress at an internal/arbitrary host). Only accept
// https endpoints on the real browser push services:
//   Chrome / Android / Samsung / Opera / Brave (FCM) — fcm.googleapis.com
//   Firefox (autopush)                               — *.push.services.mozilla.com
//   Edge (WNS)                                       — *.notify.windows.com
//   Safari / iOS web push (APNs)                     — web.push.apple.com, *.push.apple.com
const PUSH_HOST_EXACT = new Set(['fcm.googleapis.com', 'web.push.apple.com']);
const PUSH_HOST_SUFFIXES = ['.push.services.mozilla.com', '.notify.windows.com', '.push.apple.com'];
function isAllowedPushEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return false;
  let u;
  try { u = new URL(endpoint); } catch (_) { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  if (u.port && u.port !== '443') return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOST_EXACT.has(host) || PUSH_HOST_SUFFIXES.some(sfx => host.endsWith(sfx) && host.length > sfx.length);
}

// Send to one stored subscription. Rows written before the endpoint allow-list
// (or by raw SQL) are re-checked here, so a bad row can never trigger an outbound
// request — it's pruned instead. Resolves true when the push service accepted it.
async function sendToSub(sub, payload) {
  if (!isAllowedPushEndpoint(sub.endpoint)) {
    try { await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]); } catch (_) { /* next send retries the prune */ }
    logger.warn({ subId: sub.id, userId: sub.user_id }, 'pruned push subscription with disallowed endpoint');
    return false;
  }
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { timeout: PUSH_TIMEOUT_MS } // one hung push service mustn't stall the fan-out
    );
    return true;
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]);
      logger.debug({ subId: sub.id, userId: sub.user_id, statusCode: err.statusCode }, 'pruned stale push subscription');
    } else {
      logger.warn({ err, subId: sub.id, userId: sub.user_id }, 'push send failed');
    }
    return false;
  }
}

// Fan out with bounded concurrency: a company broadcast to hundreds of devices
// used to go strictly one-at-a-time (each a network round trip to the push
// service). sendToSub never throws, so one failure can't abort the rest.
// Resolves true when at least one device accepted the push.
const PUSH_CONCURRENCY = 5;
async function sendToAll(subs, payload) {
  let next = 0;
  let delivered = false;
  const worker = async () => {
    while (next < subs.length) { if (await sendToSub(subs[next++], payload)) delivered = true; }
  };
  await Promise.all(Array.from({ length: Math.min(PUSH_CONCURRENCY, subs.length) }, worker));
  return delivered;
}

// Coalescing (trailing): a burst of messages in one conversation (payload.tag, e.g. dm-<from> /
// chat-<worker>) pushes the same recipient at most once per COALESCE_MS — but nothing is
// dropped: the first message goes out immediately, later ones in the window are held, and when
// the window closes ONE trailing push goes out ("N new messages · <latest text>"). The window
// only starts after a push was actually accepted (a failed send doesn't mute the thread). The
// device groups a thread by tag (sw.js tag + renotify) anyway. In-memory per process — a
// best-effort throttle, not a guarantee.
const COALESCE_MS = 30 * 1000;
const coalesceState = new Map(); // `${userId}|${tag}` → { lastSentAt, sending, pending, timer }

function pruneCoalesceState(now) {
  if (coalesceState.size <= 5000) return;
  for (const [k, st] of coalesceState) {
    if (!st.sending && !st.pending && !st.timer && (st.lastSentAt == null || now - st.lastSentAt >= COALESCE_MS)) coalesceState.delete(k);
  }
}

function summarizePending(p) {
  if (p.count <= 1) return p.payload;
  const latest = typeof p.payload.body === 'string' ? p.payload.body : '';
  return { ...p.payload, body: `${p.count} new messages${latest ? ` · ${latest}` : ''}`.slice(0, 200), coalesced: p.count };
}

async function sendAndMark(st, subs, payload) {
  st.sending = true;
  let ok = false;
  try { ok = await sendToAll(subs, payload); } finally { st.sending = false; }
  if (ok) st.lastSentAt = Date.now(); // the throttle window starts only on a delivered push
  return ok;
}

function scheduleTrailing(key, st) {
  if (st.timer || st.sending || !st.pending) return;
  const wait = st.lastSentAt != null ? Math.max(0, st.lastSentAt + COALESCE_MS - Date.now()) : 0;
  st.timer = setTimeout(() => { flushTrailing(key).catch(err => logger.error({ err }, 'push trailing send failed')); }, wait);
  if (typeof st.timer.unref === 'function') st.timer.unref();
}

async function flushTrailing(key) {
  const st = coalesceState.get(key);
  if (!st) return;
  st.timer = null;
  const p = st.pending;
  st.pending = null;
  if (!p) return;
  // Re-read the rows: a device may have logged out (row deleted) or the user been deactivated
  // during the window.
  const r = await pool.query(
    `SELECT ps.* FROM push_subscriptions ps
       JOIN users u ON ps.user_id = u.id
      WHERE ps.id = ANY($1::int[]) AND u.active = true`,
    [p.subIds]
  );
  if (r.rows && r.rows.length) await sendAndMark(st, r.rows, summarizePending(p));
  if (st.pending) scheduleTrailing(key, st); // more arrived while this one was sending
}

// Deliver a fan-out, coalescing tagged pushes per recipient. Untagged pushes (shift reminders
// etc.) are never coalesced.
async function deliverCoalesced(subs, payload) {
  const tag = payload && typeof payload.tag === 'string' ? payload.tag : null;
  if (!tag) { await sendToAll(subs, payload); return; }
  const now = Date.now();
  pruneCoalesceState(now);
  const byUser = new Map();
  for (const sub of subs) {
    if (!byUser.has(sub.user_id)) byUser.set(sub.user_id, []);
    byUser.get(sub.user_id).push(sub);
  }
  await Promise.all([...byUser].map(async ([uid, userSubs]) => {
    const key = `${uid}|${tag}`;
    let st = coalesceState.get(key);
    if (!st) { st = { lastSentAt: null, sending: false, pending: null, timer: null }; coalesceState.set(key, st); }
    const inWindow = st.lastSentAt != null && now - st.lastSentAt < COALESCE_MS;
    if (st.sending || inWindow || st.timer) {
      st.pending = { count: (st.pending ? st.pending.count : 0) + 1, payload, subIds: userSubs.map(s => s.id) };
      scheduleTrailing(key, st);
      return;
    }
    await sendAndMark(st, userSubs, payload);
    if (st.pending) scheduleTrailing(key, st);
  }));
}
function _resetCoalesce() {
  for (const st of coalesceState.values()) if (st.timer) clearTimeout(st.timer);
  coalesceState.clear();
}

// Every send path joins users.active: a deactivated user's devices must stop getting pushes.
async function sendPushToUser(userId, payload) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  try {
    const subs = await pool.query(
      `SELECT ps.* FROM push_subscriptions ps
       JOIN users u ON ps.user_id = u.id
       WHERE ps.user_id = $1 AND u.active = true`,
      [userId]
    );
    await deliverCoalesced(subs.rows, payload);
  } catch (err) {
    // Bulk push failure (e.g. DB query failed) — log but don't fail caller.
    logger.error({ err }, 'push broadcast failed');
  }
}

// `opts.workerId`: the push is about that worker (e.g. their company-chat thread), so a partial
// admin restricted to other workers (users.worker_access_ids non-empty and not containing it)
// is skipped — they can't open that thread anyway.
async function sendPushToCompanyAdmins(companyId, payload, opts = {}) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  try {
    const workerId = opts.workerId != null ? Number(opts.workerId) : null;
    const subs = await pool.query(
      `SELECT ps.* FROM push_subscriptions ps
       JOIN users u ON ps.user_id = u.id
       WHERE ps.company_id = $1 AND u.role = 'admin' AND u.active = true
         AND ($2::int IS NULL
              OR u.worker_access_ids IS NULL
              OR cardinality(u.worker_access_ids) = 0
              OR $2::int = ANY(u.worker_access_ids))`,
      [companyId, Number.isFinite(workerId) ? workerId : null]
    );
    await deliverCoalesced(subs.rows, payload);
  } catch (err) {
    // Bulk push failure (e.g. DB query failed) — log but don't fail caller.
    logger.error({ err }, 'push broadcast failed');
  }
}

async function sendPushToAllWorkers(companyId, payload) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  try {
    const subs = await pool.query(
      `SELECT ps.* FROM push_subscriptions ps
       JOIN users u ON ps.user_id = u.id
       WHERE ps.company_id = $1 AND u.role = 'worker' AND u.active = true`,
      [companyId]
    );
    await sendToAll(subs.rows, payload);
  } catch (err) {
    // Bulk push failure (e.g. DB query failed) — log but don't fail caller.
    logger.error({ err }, 'push broadcast failed');
  }
}

module.exports = { isAllowedPushEndpoint, sendPushToUser, sendPushToCompanyAdmins, sendPushToAllWorkers, COALESCE_MS, _resetCoalesce };
