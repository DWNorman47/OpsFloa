const pool = require('./db');

const PLAN_LIMITS = {
  free:     500  * 1024 * 1024,         // 500 MB
  starter:  5    * 1024 * 1024 * 1024,  // 5 GB
  business: 25   * 1024 * 1024 * 1024,  // 25 GB
};

// Demo/test tenants are capped well below any plan so the public demo
// login can't be used to dump large amounts into R2. Wiped nightly.
const DEMO_STORAGE_LIMIT = 200 * 1024 * 1024; // 200 MB

function limitForPlan(plan) {
  return PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

async function getStorageInfo(companyId) {
  const { rows } = await pool.query(
    'SELECT storage_bytes_used, plan, is_demo FROM companies WHERE id = $1',
    [companyId]
  );
  const used = parseInt(rows[0]?.storage_bytes_used ?? 0);
  const limit = rows[0]?.is_demo ? DEMO_STORAGE_LIMIT : limitForPlan(rows[0]?.plan ?? 'free');
  return { used, limit, allowed: used <= limit };
}

async function checkStorageLimit(companyId, additionalBytes = 0) {
  const { used, limit } = await getStorageInfo(companyId);
  return { allowed: used + additionalBytes <= limit, used, limit };
}

async function incrementStorage(companyId, bytes) {
  if (!bytes || bytes <= 0) return;
  await pool.query(
    'UPDATE companies SET storage_bytes_used = storage_bytes_used + $2 WHERE id = $1',
    [companyId, bytes]
  );
}

async function decrementStorage(companyId, bytes) {
  if (!bytes || bytes <= 0) return;
  await pool.query(
    'UPDATE companies SET storage_bytes_used = GREATEST(0, storage_bytes_used - $2) WHERE id = $1',
    [companyId, bytes]
  );
}

module.exports = { PLAN_LIMITS, limitForPlan, formatBytes, getStorageInfo, checkStorageLimit, incrementStorage, decrementStorage };
