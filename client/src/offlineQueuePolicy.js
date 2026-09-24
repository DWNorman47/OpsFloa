// Pure policy for the service worker's offline request queue (client/src/sw.js).
// Kept free of SW / IndexedDB globals so it can be unit-tested with vitest.

// Header the SW stamps on every queueable request BEFORE the first network attempt; the
// original attempt and any later replay share it, so the server can dedupe a replay whose
// original was saved but whose response was lost. Server side: server/utils/idempotencyKey.js.
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

// A hung connection never rejects, so it would never fall back to the queue. Abort after this.
// This is the budget for a SMALL request (a clock punch); a request with a big body gets extra
// time for the upload itself — see requestTimeoutMs.
export const NETWORK_TIMEOUT_MS = 15000;

// Upload budget for a big body: assume a poor-but-working jobsite uplink of ~16 KB/s. A field
// report with 10 base64 photos (~4 MB) gets minutes instead of 15 s, which used to abort every
// attempt mid-upload, forever.
export const MIN_UPLINK_BYTES_PER_SEC = 16 * 1024;
// Capped well under Chrome's ~5-minute limit on a service-worker event (fetch / message / sync):
// a longer timeout never fires — the browser kills the worker first, the attempt is never
// recorded, and the same megabytes re-upload on every pass forever.
export const MAX_NETWORK_TIMEOUT_MS = 4 * 60 * 1000;
// Wall-clock budget for one replay pass (one SW event). A pass stops starting new requests once
// what's left of it can't fit even a small one; leftover items wait for the next pass.
export const REPLAY_PASS_BUDGET_MS = 4 * 60 * 1000 + 20 * 1000;
// Bodies at/over this size are "large": a timeout on one counts toward backoff / the poison cap
// (a small body timing out means the device is effectively offline — that is not counted).
export const LARGE_QUEUE_BODY_CHARS = 256 * 1024;

/** Fetch timeout for a request whose body is `bodyChars` long (0 / unknown → the base timeout). */
export function requestTimeoutMs(bodyChars = 0) {
  const n = Number(bodyChars) || 0;
  if (n <= 0) return NETWORK_TIMEOUT_MS;
  const uploadMs = Math.ceil((n / MIN_UPLINK_BYTES_PER_SEC) * 1000);
  return Math.min(MAX_NETWORK_TIMEOUT_MS, NETWORK_TIMEOUT_MS + uploadMs);
}

/** True when a fetch rejection was our own timeout abort (vs. a plain network failure). */
export function isAbortTimeout(err) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError';
}

/**
 * Fetch timeout for one replay inside a pass that started `elapsedMs` ago: the size-scaled timeout,
 * clipped to what's left of REPLAY_PASS_BUDGET_MS. Returns 0 when not even a small request fits
 * (the pass should stop and leave the item for the next one).
 */
export function replayTimeoutMs(bodyChars = 0, elapsedMs = 0) {
  const remaining = REPLAY_PASS_BUDGET_MS - Math.max(0, Number(elapsedMs) || 0);
  if (remaining < NETWORK_TIMEOUT_MS) return 0;
  return Math.min(requestTimeoutMs(bodyChars), remaining);
}

/**
 * The item with this attempt recorded BEFORE its fetch starts (large bodies only — a small request
 * can't outlive the SW event). If the browser kills the worker mid-upload, the attempt + backoff
 * are already in IndexedDB, so the item still moves toward the poison cap instead of re-uploading
 * forever. Returns null when no pre-record is needed. Post-fetch bookkeeping keeps using the
 * ORIGINAL item as its base, so a completed attempt is never counted twice.
 */
export function withAttemptStarted(item, { bodyChars = 0, now = Date.now() } = {}) {
  if ((Number(bodyChars) || 0) < LARGE_QUEUE_BODY_CHARS) return null;
  return withFailedAttempt(item, { status: item?.last_status ?? null, now, countAttempt: true });
}

/** Whether a failed replay fetch should count toward backoff / the poison cap. */
export function countsTowardBackoff({ timedOut = false, bodyChars = 0 } = {}) {
  return !!timedOut && (Number(bodyChars) || 0) >= LARGE_QUEUE_BODY_CHARS;
}

// Replay ordering lane. Clock punches and time-entry edits must replay strictly in queue order
// per user (a clock-out must never land before its clock-in), so they share one lane. Field
// module creates (reports, punch items, incidents …) are independent records: each gets its own
// lane, so one slow / oversized photo report can't hold the user's later clock punches hostage.
export function replayLane(item) {
  return item?.type === 'field' ? `field:${item.id}` : 'ordered';
}

function decodeJwtPayload(auth) {
  try {
    const token = String(auth || '').replace(/^Bearer\s+/i, '');
    const part = token.split('.')[1];
    if (!part) return null;
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

/** True when the saved token carries an `exp` that has passed (unknown → false). */
export function isTokenExpired(auth, now = Date.now()) {
  const exp = decodeJwtPayload(auth)?.exp;
  return typeof exp === 'number' && exp * 1000 <= now;
}

// A short fingerprint of a bearer token (its signature tail) — lets the SW remember WHICH token
// a 401 came from without storing another copy of it. A new login mints a new token → new sig.
export function tokenSig(auth) {
  const token = String(auth || '').replace(/^Bearer\s+/i, '');
  return token ? token.slice(-24) : '';
}

// Paused for re-auth: the item already got a 401 with this exact token, so replaying it again
// with the same token is pointless (and re-toasts every minute). A fresh login resumes it.
export function isAuthPaused(item, auth) {
  return !!item?.auth_failed_sig && item.auth_failed_sig === tokenSig(auth);
}

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
//   'auth'  — 401, or 403 `company_inactive` (the company was deactivated — it may be restored):
//             keep the item and pause this user's replay until they log in again.
//   'drop'  — permanent client error (400/403/404/410/413/422 and other 4xx): the request can
//             never succeed, so remove it and report it as a failure.
// `code` is the JSON error code, when known: a 409 `project_frozen` (job closed) is permanent,
// not "already applied", so it is dropped and reported rather than counted as synced.
export function classifyReplayStatus(status, code) {
  if (status >= 200 && status < 300) return 'done';
  if (status === 401) return 'auth';
  if (status === 403 && code === 'company_inactive') return 'auth';
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

// Shared "Clear" action for the offline banners: confirm first (it permanently deletes the
// signed-in user's unsynced punches / reports), then ask the SW to clear. OfflineContext's
// sendToSW stamps the user's scope; `scope` here is a fallback for callers without it.
export async function confirmClearQueue({ confirm, t, count, sendToSW, scope }) {
  if (!sendToSW || !count) return false;
  const ok = await confirm({
    title: t.offlineClearConfirmTitle,
    body: String(t.offlineClearConfirmBody || '').replace('{n}', count),
    confirmLabel: String(t.offlineClearConfirmBtn || '').replace('{n}', count),
    tone: 'danger',
  });
  if (!ok) return false;
  sendToSW(scope ? { type: 'CLEAR_QUEUE', scope } : { type: 'CLEAR_QUEUE' });
  return true;
}
