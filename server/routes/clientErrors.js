const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const logger = require('../logger');

const router = express.Router();

// This sink is unauthenticated, so without a limiter anyone could insert
// unbounded rows to bloat the table / inflate DB cost. Cap per-IP; a real
// client that's crash-looping still gets a handful through per minute.
const reportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  // A flood shouldn't error the user's recovery flow — silently 204.
  handler: (req, res) => res.status(204).end(),
});

// Sanity caps so a buggy client or a malicious caller can't flood the DB.
const MAX_MESSAGE = 2000;
const MAX_STACK = 16000;
const MAX_URL = 1000;
const MAX_UA = 500;
const VALID_KINDS = new Set(['render', 'unhandled', 'rejection', 'console']);

function truncate(s, max) {
  if (typeof s !== 'string') return null;
  return s.length > max ? s.slice(0, max) : s;
}

// POST /api/client-errors — accepts error reports from the browser.
// Unauthenticated on purpose (errors can fire before login), but we try to
// extract user identity from the Authorization header when present.
router.post('/', reportLimiter, async (req, res) => {
  try {
    const { kind, message, stack, url, app_version } = req.body || {};
    if (!VALID_KINDS.has(kind)) return res.status(400).json({ error: 'invalid kind' });
    if (typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'message required' });

    // Best-effort user identity — never trust or reject on bad tokens.
    let company_id = null;
    let user_id = null;
    try {
      const header = req.headers.authorization;
      if (header && header.startsWith('Bearer ')) {
        const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
        company_id = payload.company_id || null;
        user_id = payload.id || null;
      }
    } catch {
      // invalid/expired token — just skip identity
    }

    await pool.query(
      `INSERT INTO client_errors (company_id, user_id, kind, message, stack, url, user_agent, app_version, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        company_id,
        user_id,
        kind,
        truncate(message, MAX_MESSAGE),
        truncate(stack, MAX_STACK),
        truncate(url, MAX_URL),
        truncate(req.headers['user-agent'], MAX_UA),
        truncate(app_version, 64),
        req.ip,
      ]
    );
    // Respond 204 — we don't need to give the client anything back, and a
    // failing reporter should never block the user's crash-recovery flow.
    res.status(204).end();
  } catch (err) {
    logger.error({ err }, 'client-errors insert failed');
    // Swallow — reporting must never fail the caller.
    res.status(204).end();
  }
});

module.exports = router;
