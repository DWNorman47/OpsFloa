const router = require('express').Router();
const pool = require('../db');
const logger = require('../logger');
const rateLimit = require('express-rate-limit');
const { userOrIpKey } = require('../middleware/rateLimitKey');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { sendPushToUser } = require('../push');
const { canMessage } = require('../utils/messaging');

// 1:1 direct messages. company_chat still owns the shared worker↔admins thread
// (the "Admins" recipient); this is pairwise person-to-person. Who a WORKER may
// message is governed by the worker_dm_admins / worker_dm_workers settings +
// per-user blocks (see server/utils/messaging.js). Mounted at /api/dm.

const dmWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: userOrIpKey,
  message: { error: 'Too many messages. Please slow down and try again shortly.' },
  standardHeaders: true,
  legacyHeaders: false,
});

async function getMsgFlags(companyId) {
  const r = await pool.query(
    `SELECT key, value FROM settings WHERE company_id = $1 AND key IN ('worker_dm_admins', 'worker_dm_workers')`,
    [companyId]
  );
  const m = Object.fromEntries(r.rows.map(x => [x.key, x.value]));
  return { dmAdmins: m.worker_dm_admins === '1', dmWorkers: m.worker_dm_workers === '1' };
}

// GET /api/dm/contacts — people the caller may message, each with unread count +
// last-message preview. Drives the recipient picker + conversation list.
router.get('/contacts', requireAuth, requirePerm('view_company_chat'), async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const meRes = await pool.query(
      `SELECT id, company_id, role, active, messaging_blocked, messaging_blocked_user_ids FROM users WHERE id = $1`,
      [req.user.id]
    );
    const me = meRes.rows[0];
    if (!me) return res.status(404).json({ error: 'User not found' });
    const flags = await getMsgFlags(companyId);

    const [cand, unread, last] = await Promise.all([
      pool.query(`SELECT id, full_name, role FROM users WHERE company_id = $1 AND active = true AND id <> $2`, [companyId, req.user.id]),
      pool.query(`SELECT sender_id, COUNT(*)::int AS n FROM direct_messages WHERE company_id = $1 AND recipient_id = $2 AND read_at IS NULL GROUP BY sender_id`, [companyId, req.user.id]),
      pool.query(
        `SELECT DISTINCT ON (partner) partner, body, created_at FROM (
           SELECT CASE WHEN sender_id = $2 THEN recipient_id ELSE sender_id END AS partner, body, created_at
           FROM direct_messages WHERE company_id = $1 AND $2 IN (sender_id, recipient_id)
         ) t ORDER BY partner, created_at DESC`,
        [companyId, req.user.id]
      ),
    ]);

    const unreadBy = Object.fromEntries(unread.rows.map(r => [r.sender_id, r.n]));
    const lastBy = Object.fromEntries(last.rows.map(r => [r.partner, r]));
    const contacts = cand.rows
      .filter(c => canMessage(me, { id: c.id, role: c.role, active: true, company_id: companyId }, flags).ok)
      .map(c => ({
        id: c.id,
        full_name: c.full_name,
        role: c.role,
        unread: unreadBy[c.id] || 0,
        last_message: lastBy[c.id]?.body || null,
        last_at: lastBy[c.id]?.created_at || null,
      }))
      .sort((a, b) => (new Date(b.last_at || 0) - new Date(a.last_at || 0)) || a.full_name.localeCompare(b.full_name));

    res.json({ contacts });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/dm/:userId — the conversation between the caller and :userId; stamps
// read_at on the messages the caller is now viewing.
router.get('/:userId', requireAuth, requirePerm('view_company_chat'), async (req, res) => {
  const companyId = req.user.company_id;
  const other = parseInt(req.params.userId, 10);
  if (!other) return res.status(400).json({ error: 'user id required' });
  try {
    const chk = await pool.query(`SELECT id, full_name, role FROM users WHERE id = $1 AND company_id = $2`, [other, companyId]);
    if (chk.rowCount === 0) return res.status(404).json({ error: 'User not found' });
    const rows = await pool.query(
      `SELECT m.id, m.sender_id, m.recipient_id, m.body, m.created_at, m.read_at, u.full_name AS sender_name, u.role AS sender_role
       FROM direct_messages m JOIN users u ON m.sender_id = u.id
       WHERE m.company_id = $1
         AND ((m.sender_id = $2 AND m.recipient_id = $3) OR (m.sender_id = $3 AND m.recipient_id = $2))
       ORDER BY m.created_at ASC
       LIMIT 200`,
      [companyId, req.user.id, other]
    );
    await pool.query(
      `UPDATE direct_messages SET read_at = NOW()
       WHERE company_id = $1 AND recipient_id = $2 AND sender_id = $3 AND read_at IS NULL`,
      [companyId, req.user.id, other]
    );
    res.json({ user: chk.rows[0], messages: rows.rows });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/dm/:userId — send a direct message (re-checks permission).
router.post('/:userId', requireAuth, requirePerm('send_company_chat'), dmWriteLimiter, async (req, res) => {
  const companyId = req.user.company_id;
  const other = parseInt(req.params.userId, 10);
  const body = req.body.body?.trim() || '';
  if (!other) return res.status(400).json({ error: 'recipient required' });
  if (!body) return res.status(400).json({ error: 'Message body required' });
  if (body.length > 1000) return res.status(400).json({ error: 'Message must be 1000 characters or fewer' });
  try {
    const [meRes, recRes] = await Promise.all([
      pool.query(`SELECT id, company_id, role, active, messaging_blocked, messaging_blocked_user_ids FROM users WHERE id = $1`, [req.user.id]),
      pool.query(`SELECT id, company_id, role, active FROM users WHERE id = $1 AND company_id = $2`, [other, companyId]),
    ]);
    if (recRes.rowCount === 0) return res.status(404).json({ error: 'User not found' });
    const flags = await getMsgFlags(companyId);
    const verdict = canMessage(meRes.rows[0], recRes.rows[0], flags);
    if (!verdict.ok) return res.status(403).json({ error: 'You are not allowed to message this person.', reason: verdict.reason });

    const ins = await pool.query(
      `INSERT INTO direct_messages (company_id, sender_id, recipient_id, body)
       VALUES ($1, $2, $3, $4)
       RETURNING id, sender_id, recipient_id, body, created_at, read_at`,
      [companyId, req.user.id, other, body]
    );

    // Prune old direct messages by the company's chat_retention_days (mirrors chat.js).
    const s = await pool.query(`SELECT value FROM settings WHERE company_id = $1 AND key = 'chat_retention_days'`, [companyId]);
    const days = s.rowCount > 0 ? parseFloat(s.rows[0].value) : 3;
    await pool.query(
      `DELETE FROM direct_messages WHERE company_id = $1 AND created_at < NOW() - ($2 || ' days')::INTERVAL`,
      [companyId, days]
    );

    sendPushToUser(other, {
      title: `Message from ${req.user.full_name}`,
      body: body.substring(0, 100),
      url: '/timeclock#messages',
      type: 'direct_message',
      from_user_id: req.user.id,
    });

    res.status(201).json({ ...ins.rows[0], sender_name: req.user.full_name, sender_role: req.user.role });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
