/**
 * The gate every Claude-backed call goes through: config check, per-company
 * monthly quota, refund-on-failure, and the 503/429/502 error contract.
 *
 * This lived inside routes/officeTools.js until meeting minutes needed it from
 * routes/recordings.js. It belongs to the AI *budget*, not to one route file —
 * the quota is per company across every AI feature, so a second copy would mean
 * two counters disagreeing about the same limit.
 *
 * Usage:
 *   const { runAi } = require('../services/aiGate');
 *   await runAi(req, res, async () => ({ result: await anthropic.generate(...) }));
 *
 * runAi owns the response: it sends JSON on success and the right status on
 * failure. Don't res.json() yourself inside the handler.
 */

const pool = require('../db');
const anthropic = require('./anthropic');

// Monthly per-company ceiling on AI calls. Generous by default; override with
// OFFICE_AI_MONTHLY_LIMIT. Enforced via the office_ai_usage table (0126).
const AI_MONTHLY_LIMIT = Math.max(1, parseInt(process.env.OFFICE_AI_MONTHLY_LIMIT, 10) || 300);

// ~120k chars ≈ 30k tokens: bounds the per-call cost so one huge input can't
// run up a bill. Longer input is clipped (callers should tell the user).
const MAX_INPUT = 120000;

function currentPeriod(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function aiReady(res) {
  if (anthropic.isConfigured()) return true;
  res.status(503).json({ error: 'AI features are not configured yet. Ask an admin to add ANTHROPIC_API_KEY.' });
  return false;
}

/**
 * Claim one call against this month's quota. Atomic upsert-then-check: the
 * increment and the cap test are the same statement, so two concurrent calls
 * can't both slip past the limit. Rolls the increment back when over.
 *
 * Fails OPEN — a DB hiccup should never block the feature over a usage counter.
 */
async function reserveAiCall(companyId) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO office_ai_usage (company_id, period, count, updated_at)
         VALUES ($1, $2, 1, now())
       ON CONFLICT (company_id, period)
         DO UPDATE SET count = office_ai_usage.count + 1, updated_at = now()
       RETURNING count`,
      [companyId, currentPeriod()]
    );
    if (rows[0].count > AI_MONTHLY_LIMIT) {
      await pool.query(
        `UPDATE office_ai_usage SET count = count - 1 WHERE company_id = $1 AND period = $2`,
        [companyId, currentPeriod()]
      );
      return false;
    }
    return true;
  } catch (_) {
    return true;
  }
}

/** Give the call back when the AI request failed — a 502 shouldn't cost them. */
async function refundAiCall(companyId) {
  try {
    await pool.query(
      `UPDATE office_ai_usage SET count = GREATEST(0, count - 1), updated_at = now()
        WHERE company_id = $1 AND period = $2`,
      [companyId, currentPeriod()]
    );
  } catch (_) { /* usage accounting is best-effort */ }
}

function overLimit(res) {
  res.status(429).json({
    error: `You've reached this month's AI limit (${AI_MONTHLY_LIMIT} requests). It resets at the start of next month.`,
  });
}

async function runAi(req, res, handler) {
  if (!aiReady(res)) return;
  if (!(await reserveAiCall(req.user.company_id))) return overLimit(res);
  try {
    res.json(await handler());
  } catch (err) {
    await refundAiCall(req.user.company_id);
    if (req.log && req.log.error) req.log.error({ err }, 'AI request failed');
    res.status(502).json({ error: 'The AI request failed. Please try again in a moment.' });
  }
}

/** Current usage for the badge. Fail-safe: a counter outage reads as 0, not a 500. */
async function usageFor(companyId) {
  try {
    const { rows } = await pool.query(
      `SELECT count FROM office_ai_usage WHERE company_id = $1 AND period = $2`,
      [companyId, currentPeriod()]
    );
    return { count: rows[0] ? rows[0].count : 0, limit: AI_MONTHLY_LIMIT };
  } catch (_) {
    return { count: 0, limit: AI_MONTHLY_LIMIT };
  }
}

module.exports = { runAi, aiReady, reserveAiCall, refundAiCall, overLimit, usageFor, currentPeriod, AI_MONTHLY_LIMIT, MAX_INPUT };
