const router = require('express').Router();
const webpush = require('web-push');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { isAllowedPushEndpoint } = require('../push');

// GET /push/generate-vapid-keys
// One-time setup helper — only works when VAPID keys are NOT yet configured.
// Visit this URL in a browser, copy the two values into your environment variables, then remove or ignore this route.
router.get('/generate-vapid-keys', (req, res) => {
  if (process.env.VAPID_PUBLIC_KEY) {
    return res.json({ message: 'VAPID keys already configured. Remove this endpoint once set up.' });
  }
  const keys = webpush.generateVAPIDKeys();
  res.json({
    instructions: 'Add these two values to your environment variables (Vercel → Settings → Environment Variables), then redeploy.',
    VAPID_PUBLIC_KEY: keys.publicKey,
    VAPID_PRIVATE_KEY: keys.privateKey,
  });
});

// GET /push/vapid-public-key
router.get('/vapid-public-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(503).json({ error: 'Push notifications not configured' });
  res.json({ publicKey: key });
});

// POST /push/subscribe
router.post('/subscribe', requireAuth, async (req, res) => {
  const { endpoint, p256dh, auth } = req.body;
  if (!endpoint || !p256dh || !auth) return res.status(400).json({ error: 'endpoint, p256dh, auth required' });
  // The server later POSTs to this URL — only real browser push services (no SSRF).
  if (!isAllowedPushEndpoint(endpoint)) return res.status(400).json({ error: 'Unsupported push endpoint' });
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || p256dh.length > 256 || auth.length > 256) {
    return res.status(400).json({ error: 'Invalid subscription keys' });
  }
  try {
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, company_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [req.user.id, req.user.company_id, endpoint, p256dh, auth]
    );
    res.json({ ok: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// DELETE /push/subscribe
router.delete('/subscribe', requireAuth, async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  try {
    await pool.query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [req.user.id, endpoint]);
    res.json({ ok: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
