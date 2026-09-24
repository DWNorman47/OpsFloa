// chat_retention_days → a safe whole number of days for the company_chat / direct_messages prune.
// The settings route only accepts 1..90, but a legacy / raw-SQL value of 0, a negative, NaN or a
// fraction must never turn the prune into "delete every message" — clamp it here too.
const DEFAULT_CHAT_RETENTION_DAYS = 3;
const MIN_CHAT_RETENTION_DAYS = 1;
const MAX_CHAT_RETENTION_DAYS = 90;

function chatRetentionDays(raw) {
  const n = Math.floor(Number(raw));
  if (raw == null || raw === '' || !Number.isFinite(n)) return DEFAULT_CHAT_RETENTION_DAYS;
  return Math.min(MAX_CHAT_RETENTION_DAYS, Math.max(MIN_CHAT_RETENTION_DAYS, n));
}

async function loadChatRetentionDays(pool, companyId) {
  const r = await pool.query(
    `SELECT value FROM settings WHERE company_id = $1 AND key = 'chat_retention_days'`,
    [companyId]
  );
  return chatRetentionDays(r?.rows?.[0]?.value);
}

module.exports = {
  chatRetentionDays,
  loadChatRetentionDays,
  DEFAULT_CHAT_RETENTION_DAYS,
  MIN_CHAT_RETENTION_DAYS,
  MAX_CHAT_RETENTION_DAYS,
};
