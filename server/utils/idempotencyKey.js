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

module.exports = { readIdempotencyKey };
