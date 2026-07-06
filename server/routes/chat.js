const router = require('express').Router();
const pool = require('../db');
const logger = require('../logger');
const rateLimit = require('express-rate-limit');
const { userOrIpKey } = require('../middleware/rateLimitKey');
const { requireAuth } = require('../middleware/auth');
const { sendPushToUser, sendPushToCompanyAdmins } = require('../push');

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

// GET /api/chat?worker_id=X
// Workers: always see their own thread
// Admin: must pass worker_id to see that worker's thread;
//        omit worker_id to get a list of workers with recent messages
router.get('/', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  const isAdmin = req.user.role === 'admin';

  try {
    if (!isAdmin) {
      // Worker: fetch their own thread
      const result = await pool.query(
        `SELECT m.id, m.sender_id, m.body, m.created_at,
                u.full_name as sender_name, u.role as sender_role
         FROM company_chat m
         JOIN users u ON m.sender_id = u.id
         WHERE m.company_id = $1 AND m.worker_id = $2
         ORDER BY m.created_at ASC
         LIMIT 100`,
        [companyId, req.user.id]
      );
      return res.json(result.rows);
    }

    const workerId = req.query.worker_id;
    if (!workerId) {
      // Admin: return list of workers who have messages, with latest message preview
      const result = await pool.query(
        `SELECT * FROM (
           SELECT DISTINCT ON (m.worker_id)
                  m.worker_id, u.full_name as worker_name,
                  m.body as last_message, m.created_at as last_at
           FROM company_chat m
           JOIN users u ON m.worker_id = u.id
           WHERE m.company_id = $1
           ORDER BY m.worker_id, m.created_at DESC
         ) sub
         ORDER BY last_at DESC`,
        [companyId]
      );
      return res.json(result.rows);
    }

    // Validate worker belongs to this company before fetching their thread
    const workerCheck = await pool.query(
      'SELECT id FROM users WHERE id = $1 AND company_id = $2',
      [workerId, companyId]
    );
    if (workerCheck.rowCount === 0) return res.status(403).json({ error: 'Worker not found' });

    // Admin fetching a specific worker's thread
    const result = await pool.query(
      `SELECT m.id, m.sender_id, m.body, m.created_at,
              u.full_name as sender_name, u.role as sender_role
       FROM company_chat m
       JOIN users u ON m.sender_id = u.id
       WHERE m.company_id = $1 AND m.worker_id = $2
       ORDER BY m.created_at ASC
       LIMIT 100`,
      [companyId, workerId]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/chat
// Workers: send to their own thread (worker_id = self)
// Admin: must provide worker_id in body
router.post('/', requireAuth, chatWriteLimiter, async (req, res) => {
  const { worker_id } = req.body;
  const body = req.body.body?.trim() || '';
  if (!body) return res.status(400).json({ error: 'Message body required' });
  if (body.length > 1000) return res.status(400).json({ error: 'Message must be 1000 characters or fewer' });

  const isAdmin = req.user.role === 'admin';
  const targetWorkerId = isAdmin ? worker_id : req.user.id;
  if (!targetWorkerId) return res.status(400).json({ error: 'worker_id required' });

  try {
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

    // Prune old messages based on chat_retention_days setting
    const settingResult = await pool.query(
      `SELECT value FROM settings WHERE company_id = $1 AND key = 'chat_retention_days'`,
      [req.user.company_id]
    );
    const retentionDays = settingResult.rowCount > 0 ? parseFloat(settingResult.rows[0].value) : 3;
    await pool.query(
      `DELETE FROM company_chat WHERE company_id = $1 AND created_at < NOW() - ($2 || ' days')::INTERVAL`,
      [req.user.company_id, retentionDays]
    );

    const msg = { ...result.rows[0], sender_name: req.user.full_name, sender_role: req.user.role };

    // Push notification to recipient(s)
    const snippet = body.substring(0, 100);
    if (req.user.role === 'admin') {
      // Admin messaging a worker — notify that worker
      sendPushToUser(targetWorkerId, {
        title: `Message from ${req.user.full_name}`,
        body: snippet,
        url: '/timeclock#messages',
        type: 'message',
        worker_id: targetWorkerId,
      });
    } else {
      // Worker sending — notify all company admins
      sendPushToCompanyAdmins(req.user.company_id, {
        title: `Message from ${req.user.full_name}`,
        body: snippet,
        url: '/workforce#wf-live',
        type: 'message',
        worker_id: targetWorkerId,
      });
    }

    res.status(201).json(msg);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
