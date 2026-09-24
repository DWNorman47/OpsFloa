// Pure policy for the service worker's offline request queue (client/src/sw.js).
// Kept free of SW / IndexedDB globals so it can be unit-tested with vitest.

// Header the SW stamps on every queueable request BEFORE the first network attempt; the
// original attempt and any later replay share it, so the server can dedupe a replay whose
// original was saved but whose response was lost. Server side: server/utils/idempotencyKey.js.
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

// A hung connection never rejects, so it would never fall back to the queue. Abort after this.
export const NETWORK_TIMEOUT_MS = 15000;

// Poison-item cap. After this many server-side retryable failures (5xx / 429 / 408), or once an
// item that has been tried is older than MAX_QUEUE_AGE_MS, it is flagged "stuck": it is KEPT (never
// silently deleted), reported to the user, and only retried by a manual "Retry" tap.
export const MAX_REPLAY_ATTEMPTS = 10;
export const MAX_QUEUE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const BACKOFF_BASE_MS = 5000;
const BACKOFF_MAX_MS = 10 * 60 * 1000;

// Replay outcome for an HTTP status.
//   'done'  — the server has it (2xx, or 409 = already applied, e.g. "Already clocked in").
//   'retry' — transient: 5xx (Render cold start / deploy), 429, 408, and anything unexpected
//             (3xx / opaque). Keep the item and try again later.
//   'auth'  — 401: keep the item and pause this user's replay until they log in again.
//   'drop'  — permanent client error (400/403/404/410/413/422 and other 4xx): the request can
//             never succeed, so remove it and report it as a failure.
// `code` is the JSON error code, when known: a 409 `project_frozen` (job closed) is permanent,
// not "already applied", so it is dropped and reported rather than counted as synced.
export function classifyReplayStatus(status, code) {
  if (status >= 200 && status < 300) return 'done';
  if (status === 401) return 'auth';
  if (status === 409) return code === 'project_frozen' ? 'drop' : 'done';
  if (status === 408 || status === 429) return 'retry';
  if (status >= 400 && status < 500) return 'drop';
  return 'retry';
}

export function shouldDropOnStatus(status, code) {
  return classifyReplayStatus(status, code) === 'drop';
}

// Exponential backoff after `attempts` failed tries: 5s, 10s, 20s … capped at 10 min.
export function backoffMs(attempts) {
  const n = Math.max(0, (attempts || 1) - 1);
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(n, 20));
}

function queuedAtMs(item) {
  const t = typeof item?.queued_at === 'number' ? item.queued_at : Date.parse(item?.queued_at);
  return Number.isFinite(t) ? t : null;
}

// True once an item has hit the poison cap (see MAX_REPLAY_ATTEMPTS).
export function isStuck(item, now = Date.now()) {
  const attempts = item?.attempts || 0;
  if (attempts >= MAX_REPLAY_ATTEMPTS) return true;
  const queuedAt = queuedAtMs(item);
  return attempts > 0 && queuedAt != null && now - queuedAt > MAX_QUEUE_AGE_MS;
}

// Whether an automatic (non-manual) replay pass should wait on this item for now.
export function isBackingOff(item, now = Date.now()) {
  return !!item?.next_attempt_at && item.next_attempt_at > now;
}

// The item after one more retryable failure. Network errors (device still offline) are not
// counted — only server-side failures move an item toward the poison cap.
export function withFailedAttempt(item, { status = null, now = Date.now(), countAttempt = true } = {}) {
  const attempts = (item.attempts || 0) + (countAttempt ? 1 : 0);
  return {
    ...item,
    attempts,
    last_status: status,
    last_attempt_at: now,
    next_attempt_at: countAttempt ? now + backoffMs(attempts) : item.next_attempt_at || null,
  };
}

export function newIdempotencyKey() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// AbortSignal that fires after `ms` (AbortSignal.timeout where available; older Safari fallback).
export function timeoutSignal(ms = NETWORK_TIMEOUT_MS) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  if (typeof AbortController === 'undefined') return undefined;
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

// Parse a request body for queueing. Returns { ok, body }: empty → {} (as before); JSON → the
// parsed value; anything else (multipart / binary) can't be faithfully replayed from the queue,
// so ok=false and the caller surfaces a network error instead of queueing a blank payload.
export function parseQueueableBody(text) {
  if (text == null || text === '') return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, body: null };
  }
}
