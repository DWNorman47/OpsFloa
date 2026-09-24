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
// request — it's pruned instead.
async function sendToSub(sub, payload) {
  if (!isAllowedPushEndpoint(sub.endpoint)) {
    try { await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]); } catch (_) { /* next send retries the prune */ }
    logger.warn({ subId: sub.id, userId: sub.user_id }, 'pruned push subscription with disallowed endpoint');
    return;
  }
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { timeout: PUSH_TIMEOUT_MS } // one hung push service mustn't stall the fan-out
    );
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]);
      logger.debug({ subId: sub.id, userId: sub.user_id, statusCode: err.statusCode }, 'pruned stale push subscription');
    } else {
      logger.warn({ err, subId: sub.id, userId: sub.user_id }, 'push send failed');
    }
  }
}

// Fan out with bounded concurrency: a company broadcast to hundreds of devices
// used to go strictly one-at-a-time (each a network round trip to the push
// service). sendToSub never throws, so one failure can't abort the rest.
const PUSH_CONCURRENCY = 5;
async function sendToAll(subs, payload) {
  let next = 0;
  const worker = async () => {
    while (next < subs.length) await sendToSub(subs[next++], payload);
  };
  await Promise.all(Array.from({ length: Math.min(PUSH_CONCURRENCY, subs.length) }, worker));
}

// Coalescing: a burst of messages in one conversation (payload.tag, e.g. dm-<from> /
// chat-<worker>) pushes the same recipient at most once per COALESCE_MS. The device's
// notification is grouped by that tag anyway, and a flurry of "new message" alerts within a few
// seconds is noise. In-memory per process — a best-effort throttle, not a guarantee.
const COALESCE_MS = 30 * 1000;
const lastSentAt = new Map(); // `${userId}|${tag}` → ms
function coalesceSubs(subs, payload, now = Date.now()) {
  const tag = payload && typeof payload.tag === 'string' ? payload.tag : null;
  if (!tag) return subs;
  if (lastSentAt.size > 5000) {
    for (const [k, ts] of lastSentAt) if (now - ts >= COALESCE_MS) lastSentAt.delete(k);
  }
  const allowed = new Set();
  for (const uid of new Set(subs.map(s => s.user_id))) {
    const key = `${uid}|${tag}`;
    const prev = lastSentAt.get(key);
    if (prev != null && now - prev < COALESCE_MS) continue;
    lastSentAt.set(key, now);
    allowed.add(uid);
  }
  return subs.filter(s => allowed.has(s.user_id));
}
function _resetCoalesce() { lastSentAt.clear(); }

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
    await sendToAll(coalesceSubs(subs.rows, payload), payload);
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
    await sendToAll(coalesceSubs(subs.rows, payload), payload);
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
