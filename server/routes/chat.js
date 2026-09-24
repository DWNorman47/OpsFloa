const router = require('express').Router();
const pool = require('../db');
const logger = require('../logger');
const rateLimit = require('express-rate-limit');
const { userOrIpKey } = require('../middleware/rateLimitKey');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { sendPushToUser, sendPushToCompanyAdmins } = require('../push');
const { loadChatRetentionDays } = require('../utils/chatRetention');

// Cap chat writes per user to prevent spam / scripted flooding.
// 60/min is generous for a human typing; anything more is almost certainly
// automated.
const chatWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: userOrIpKey,
  message: { error: 'Too many messages. Please slow down and try again shortly.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// A partial admin restricted to specific workers (users.worker_access_ids) only sees / posts
// in those workers' threads — mirrors admin.js workerInScope. No restriction → full access.
function workerInScope(req, targetId) {
  const ids = req.user.worker_access_ids;
  return !ids || !ids.length || ids.map(Number).includes(Number(targetId));
}
function scopeIds(req) {
  const ids = req.user.worker_access_ids;
  return Array.isArray(ids) && ids.length ? ids.map(Number).filter(Number.isFinite) : null;
}

// Newest PAGE_SIZE messages of a thread, returned oldest-first. `before` (a message id) pages
// back: the PAGE_SIZE messages older than it. (The old ASC LIMIT 100 returned the FIRST 100 ever,
// so a long thread never showed anything new.)
const PAGE_SIZE = 100;
function parseBefore(raw) {
  if (raw == null || raw === '') return { ok: true, before: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return { ok: false };
  return { ok: true, before: n };
}
async function loadThread(companyId, workerId, before) {
  const r = await pool.query(
    `SELECT m.id, m.sender_id, m.body, m.created_at,
            u.full_name as sender_name, u.role as sender_role
     FROM company_chat m
     JOIN users u ON m.sender_id = u.id
     WHERE m.company_id = $1 AND m.worker_id = $2
       AND ($3::int IS NULL OR m.id < $3::int)
     ORDER BY m.id DESC
     LIMIT ${PAGE_SIZE}`,
    [companyId, workerId, before]
  );
  return r.rows.reverse();
}

// Server-side read marker for an admin on a worker's thread (company_chat_reads, 0216): the
// highest message id they've seen. Ids, not client clocks — no skew, and synced across devices.
async function markThreadRead(companyId, adminId, workerId, uptoId = null) {
  try {
    await pool.query(
      `INSERT INTO company_chat_reads (company_id, admin_id, worker_id, last_read_id, read_at)
       SELECT $1, $2, $3, COALESCE($4::int, MAX(id), 0), NOW()
       FROM company_chat WHERE company_id = $1 AND worker_id = $3
       HAVING COUNT(*) > 0
       ON CONFLICT (admin_id, worker_id) DO UPDATE
         SET last_read_id = GREATEST(company_chat_reads.last_read_id, EXCLUDED.last_read_id),
             read_at = NOW()`,
      [companyId, adminId, workerId, uptoId]
    );
  } catch (err) {
    // A read marker is best-effort — never fail the read / send over it.
    logger.warn({ err }, 'company chat read marker failed');
  }
}

// GET /api/chat?worker_id=X[&before=<message id>]
// Workers: always see their own thread
// Admin: must pass worker_id to see that worker's thread (marks it read for this admin);
//        omit worker_id to get a list of workers with recent messages, each with
//        last_sender_id / last_sender_role and `unread` = messages FROM the worker newer than
//        this admin's read marker (own / other admins' replies never count).
// Partial admins (worker_access_ids) only see their workers' threads.
router.get('/', requireAuth, requirePerm('view_company_chat'), async (req, res) => {
  const companyId = req.user.company_id;
  const isAdmin = req.user.role === 'admin';
  const { ok, before } = parseBefore(req.query.before);
  if (!ok) return res.status(400).json({ error: 'Invalid before cursor' });

  try {
    if (!isAdmin) {
      // Worker: fetch their own thread
      return res.json(await loadThread(companyId, req.user.id, before));
    }

    const workerId = req.query.worker_id;
    if (!workerId) {
      // Admin: return list of workers who have messages, with latest message preview
      const result = await pool.query(
        `SELECT sub.*, COALESCE(ur.n, 0)::int AS unread FROM (
           SELECT DISTINCT ON (m.worker_id)
                  m.worker_id, u.full_name as worker_name,
                  m.body as last_message, m.created_at as last_at,
                  m.sender_id as last_sender_id, su.role as last_sender_role
           FROM company_chat m
           JOIN users u ON m.worker_id = u.id
           JOIN users su ON m.sender_id = su.id
           WHERE m.company_id = $1
             AND ($3::int[] IS NULL OR m.worker_id = ANY($3::int[]))
           ORDER BY m.worker_id, m.id DESC
         ) sub
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS n
           FROM company_chat c
           LEFT JOIN company_chat_reads r ON r.admin_id = $2 AND r.worker_id = c.worker_id
           WHERE c.company_id = $1 AND c.worker_id = sub.worker_id
             AND c.sender_id = c.worker_id
             AND c.id > COALESCE(r.last_read_id, 0)
         ) ur ON true
         ORDER BY sub.last_at DESC`,
        [companyId, req.user.id, scopeIds(req)]
      );
      return res.json(result.rows);
    }

    if (!workerInScope(req, workerId)) return res.status(403).json({ error: 'Not authorized for this worker' });

    // Validate worker belongs to this company before fetching their thread
    const workerCheck = await pool.query(
      'SELECT id FROM users WHERE id = $1 AND company_id = $2',
      [workerId, companyId]
    );
    if (workerCheck.rowCount === 0) return res.status(403).json({ error: 'Worker not found' });

    // Admin fetching a specific worker's thread (the newest page marks it read)
    const rows = await loadThread(companyId, workerId, before);
    if (!before) await markThreadRead(companyId, req.user.id, workerId);
    res.json(rows);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/chat/read { worker_id? } — admin: mark one worker's thread (or, with no worker_id,
// every thread in the admin's worker scope) read up to its newest message. Drives the
// messages bell's "Mark all read" + clicking an unread thread.
router.post('/read', requireAuth, requirePerm('view_company_chat'), async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  const companyId = req.user.company_id;
  const workerId = req.body?.worker_id;
  try {
    if (workerId != null && workerId !== '') {
      if (!workerInScope(req, workerId)) return res.status(403).json({ error: 'Not authorized for this worker' });
      await markThreadRead(companyId, req.user.id, workerId);
      return res.json({ ok: true });
    }
    await pool.query(
      `INSERT INTO company_chat_reads (company_id, admin_id, worker_id, last_read_id, read_at)
       SELECT $1, $2, worker_id, MAX(id), NOW()
       FROM company_chat
       WHERE company_id = $1 AND ($3::int[] IS NULL OR worker_id = ANY($3::int[]))
       GROUP BY worker_id
       ON CONFLICT (admin_id, worker_id) DO UPDATE
         SET last_read_id = GREATEST(company_chat_reads.last_read_id, EXCLUDED.last_read_id),
             read_at = NOW()`,
      [companyId, req.user.id, scopeIds(req)]
    );
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/chat
// Workers: send to their own thread (worker_id = self)
// Admin: must provide worker_id in body (and have that worker in scope)
router.post('/', requireAuth, requirePerm('send_company_chat'), chatWriteLimiter, async (req, res) => {
  const { worker_id } = req.body;
  const body = req.body.body?.trim() || '';
  if (!body) return res.status(400).json({ error: 'Message body required' });
  if (body.length > 1000) return res.status(400).json({ error: 'Message must be 1000 characters or fewer' });

  const isAdmin = req.user.role === 'admin';
  const targetWorkerId = isAdmin ? worker_id : req.user.id;
  if (!targetWorkerId) return res.status(400).json({ error: 'worker_id required' });
  if (isAdmin && !workerInScope(req, targetWorkerId)) return res.status(403).json({ error: 'Not authorized for this worker' });

  try {
    // A globally-muted user (users.messaging_blocked) may not send — same rule as DMs
    // (utils/messaging.js canMessage).
    const me = await pool.query('SELECT messaging_blocked FROM users WHERE id = $1', [req.user.id]);
    if (me.rows[0]?.messaging_blocked) {
      return res.status(403).json({ error: 'You are not allowed to send messages.', reason: 'muted' });
    }

    // Validate target worker belongs to this company
    if (isAdmin) {
      const workerCheck = await pool.query(
        'SELECT id FROM users WHERE id = $1 AND company_id = $2',
        [targetWorkerId, req.user.company_id]
      );
      if (workerCheck.rowCount === 0) return res.status(403).json({ error: 'Worker not found' });
    }

    const result = await pool.query(
      `INSERT INTO company_chat (company_id, sender_id, worker_id, body)
       VALUES ($1, $2, $3, $4)
       RETURNING id, sender_id, worker_id, body, created_at`,
      [req.user.company_id, req.user.id, targetWorkerId, body]
    );

    // An admin replying has read the thread up to their own message.
    if (isAdmin) await markThreadRead(req.user.company_id, req.user.id, targetWorkerId, result.rows[0].id);

    // Prune old messages by chat_retention_days — whole days, clamped to >= 1 so a bad stored
    // value can never wipe the thread on every send.
    const retentionDays = await loadChatRetentionDays(pool, req.user.company_id);
    await pool.query(
      `DELETE FROM company_chat WHERE company_id = $1 AND created_at < NOW() - make_interval(days => $2::int)`,
      [req.user.company_id, retentionDays]
    );

    const msg = { ...result.rows[0], sender_name: req.user.full_name, sender_role: req.user.role };

    // Push notification to recipient(s). `tag` = one notification per thread on the device;
    // push.js also coalesces a burst to the same recipient + thread.
    const snippet = body.substring(0, 100);
    const tag = `chat-${targetWorkerId}`;
    if (req.user.role === 'admin') {
      // Admin messaging a worker — notify that worker
      sendPushToUser(targetWorkerId, {
        title: `Message from ${req.user.full_name}`,
        body: snippet,
        url: '/timeclock#messages',
        type: 'message',
        tag,
        worker_id: targetWorkerId,
      });
    } else {
      // Worker sending — notify the company admins whose worker scope includes this worker
      sendPushToCompanyAdmins(req.user.company_id, {
        title: `Message from ${req.user.full_name}`,
        body: snippet,
        url: '/workforce#wf-live',
        type: 'message',
        tag,
        worker_id: targetWorkerId,
      }, { workerId: targetWorkerId });
    }

    res.status(201).json(msg);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
module.exports.PAGE_SIZE = PAGE_SIZE;
