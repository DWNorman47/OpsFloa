const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const logger = require('../logger');

router.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false }));

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const source = value => typeof value === 'string' && value.length <= 80 && /^[\w .+\-/]{1,80}$/.test(value) ? value : null;

function referrerHost(value) {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.hostname === 'opsfloa.com' || url.hostname.endsWith('.opsfloa.com')) return null;
    return url.hostname.slice(0, 120);
  } catch { return null; }
}

router.post('/', async (req, res) => {
  const { session_id: id, action } = req.body || {};
  if (!uuid.test(id) || !['visit', 'pricing', 'register'].includes(action)) {
    return res.status(400).json({ error: 'Invalid visit' });
  }
  if (/bot|crawler|spider|headless|lighthouse/i.test(req.headers['user-agent'] || '')) return res.sendStatus(204);
  try {
    if (action === 'visit') {
      const { landing_path: path, referrer, utm_source, utm_medium, utm_campaign, device } = req.body;
      if (!['/', '/welcome'].includes(path)) return res.status(400).json({ error: 'Invalid landing path' });
      await pool.query(
        `INSERT INTO public_visits (session_id, landing_path, referrer_host, utm_source, utm_medium, utm_campaign, device)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (session_id) DO UPDATE SET last_seen = NOW()`,
        [id, path, referrerHost(referrer), source(utm_source), source(utm_medium), source(utm_campaign),
          ['mobile', 'tablet', 'desktop'].includes(device) ? device : null]
      );
    } else {
      await pool.query(
        `UPDATE public_visits SET last_seen = NOW(),
           viewed_pricing = viewed_pricing OR $2,
           clicked_register = clicked_register OR $3 WHERE session_id = $1`,
        [id, action === 'pricing', action === 'register']
      );
    }
    return res.sendStatus(204);
  } catch (err) {
    logger.error({ err }, 'public visit record failed');
    return res.status(500).json({ error: 'Server error' });
  }
});

router.post('/exclude', async (req, res) => {
  const id = req.body?.session_id;
  if (!uuid.test(id)) return res.status(400).json({ error: 'Invalid visit' });
  try {
    await pool.query('DELETE FROM public_visits WHERE session_id = $1', [id]);
    return res.sendStatus(204);
  } catch (err) {
    logger.error({ err }, 'public visit exclusion failed');
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
