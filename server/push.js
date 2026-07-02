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

async function sendPushToUser(userId, payload) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  try {
    const subs = await pool.query('SELECT * FROM push_subscriptions WHERE user_id = $1', [userId]);
    for (const sub of subs.rows) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload)
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
  } catch (err) {
    // Bulk push failure (e.g. DB query failed) — log but don't fail caller.
    logger.error({ err }, 'push broadcast failed');
  }
}

async function sendPushToCompanyAdmins(companyId, payload) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  try {
    const subs = await pool.query(
      `SELECT ps.* FROM push_subscriptions ps
       JOIN users u ON ps.user_id = u.id
       WHERE ps.company_id = $1 AND u.role = 'admin' AND u.active = true`,
      [companyId]
    );
    for (const sub of subs.rows) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload)
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
    for (const sub of subs.rows) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload)
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
  } catch (err) {
    // Bulk push failure (e.g. DB query failed) — log but don't fail caller.
    logger.error({ err }, 'push broadcast failed');
  }
}

module.exports = { sendPushToUser, sendPushToCompanyAdmins, sendPushToAllWorkers };
