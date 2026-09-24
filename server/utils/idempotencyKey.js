// Offline-replay idempotency key for create endpoints.
//
// The client's service worker (client/src/sw.js) stamps every queueable POST with an
// `Idempotency-Key` header before the first network attempt, and replays a queued request
// with the same key. Some callers also send the key in the body (time entries: `client_id`,
// field reports: `client_request_id`) — the body value wins so those keep working unchanged.
// Returns null when no usable key was sent, so requests without one behave exactly as before.
const KEY_RE = /^[A-Za-z0-9_-]+$/;

function validKey(v, maxLen) {
  return typeof v === 'string' && v.length > 0 && v.length <= maxLen && KEY_RE.test(v) ? v : null;
}

function readIdempotencyKey(req, { bodyField, maxLen = 64 } = {}) {
  if (bodyField) {
    const fromBody = req.body?.[bodyField];
    // Preserve the historical body contract exactly: any string within the length cap.
    if (typeof fromBody === 'string' && fromBody.length > 0 && fromBody.length <= maxLen) return fromBody;
  }
  return validKey(req.get?.('Idempotency-Key'), maxLen);
}

// Id of the row an earlier request with this key already created in `table` (keyed on
// company_id + client_request_id, the partial unique index from migrations 0201/0205), or null.
// `table` is always a hard-coded identifier at the call site — never user input.
const TABLE_RE = /^[a-z_]+$/;
async function findIdByRequestKey(db, table, companyId, key) {
  if (!key) return null;
  if (!TABLE_RE.test(table)) throw new Error(`bad table identifier: ${table}`);
  const r = await db.query(
    `SELECT id FROM ${table} WHERE company_id = $1 AND client_request_id = $2`,
    [companyId, key]
  );
  return r.rows[0]?.id ?? null;
}

module.exports = { readIdempotencyKey, findIdByRequestKey };
