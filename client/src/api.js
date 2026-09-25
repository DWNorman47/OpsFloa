import axios from 'axios';
import { safeSession, safeLocal } from './utils/safeStorage';
import { getT } from './i18n';
import { detectLanguage } from './languageDetect';
import { IDEMPOTENCY_HEADER, requestTimeoutMs } from './offlineQueuePolicy';

const baseURL = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';
const api = axios.create({ baseURL });

// ── Timeouts ─────────────────────────────────────────────────────────────────
// axios has no timeout by default, so a hung request (dead cell signal, stalled
// server) left spinners running forever. Every request gets DEFAULT_TIMEOUT_MS
// unless the caller passes its own `timeout`, or the request looks legitimately
// slow (file download/export, upload, AI call, big base64 body) — those get
// LONG_TIMEOUT_MS instead.
export const DEFAULT_TIMEOUT_MS = 20000;
export const LONG_TIMEOUT_MS = 180000;
// Endpoints known to run long server-side: AI (office tools, recordings, jump-start,
// submittal scanning, daily-report suggestions), exports/imports, uploads, bulk syncs,
// QuickBooks pushes (one Intuit round-trip per bill / expense / journal line), payroll
// runs, and the super-admin mailbox (live IMAP).
const SLOW_URL = /(^|\/)(office|jumpstart|recordings|submittals|mailbox)\/|\/(suggest|minutes|daily-log|retry|plan-pdf|logo|media-zip|upload|bulk|sync-staging)(\/|\?|$)|\/qbo\/(push[a-z-]*|invoices)(\/|\?|$)|\/payroll-run|export|import|overtime-report|wip-report/;
const LARGE_BODY_CHARS = 100000;

// Approximate serialized size of a request body: the sum of its string lengths, walking
// nested arrays / objects (a field report's `photos: [{ url: 'data:…' }, …]` is ~4 MB that
// the old top-level-only scan missed). Stops once `cap` is reached.
export function approxBodyChars(data, cap = Infinity) {
  if (!data) return 0;
  if (typeof data === 'string') return data.length;
  if (typeof FormData !== 'undefined' && data instanceof FormData) return cap;
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.size;
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof data !== 'object') return 0;
  let total = 0;
  let visited = 0;
  const stack = [[data, 0]];
  while (stack.length && total < cap && visited < 5000) {
    const [node, depth] = stack.pop();
    visited++;
    const values = Array.isArray(node) ? node : Object.values(node);
    for (const v of values) {
      if (typeof v === 'string') total += v.length;
      else if (v && typeof v === 'object' && depth < 8) stack.push([v, depth + 1]);
    }
  }
  return total;
}

function hasLargeBody(data) {
  if (!data) return false;
  if (typeof FormData !== 'undefined' && data instanceof FormData) return true;
  if (typeof Blob !== 'undefined' && data instanceof Blob) return true;
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return true;
  return approxBodyChars(data, LARGE_BODY_CHARS + 1) > LARGE_BODY_CHARS;
}

/** Resolve the timeout for a request config (exported for tests). */
export function resolveTimeout(config = {}) {
  if (config.timeout) return config.timeout; // explicit per-request timeout wins
  const rt = config.responseType;
  if (rt === 'blob' || rt === 'arraybuffer') return LONG_TIMEOUT_MS;
  if (hasLargeBody(config.data)) {
    // Big JSON body (base64 photos): budget for the upload on a slow jobsite uplink, and stay
    // longer than the service worker's own size-scaled timeout for the same body, so the SW
    // gets to queue it instead of the page giving up first.
    return Math.max(LONG_TIMEOUT_MS, requestTimeoutMs(approxBodyChars(config.data)) + 30000);
  }
  if (SLOW_URL.test(config.url || '')) return LONG_TIMEOUT_MS;
  return DEFAULT_TIMEOUT_MS;
}

// Creates that carry their own idempotency key in the body (`client_request_id`: field
// reports, punch items, incidents …) also send it as the Idempotency-Key header, so the service
// worker sends / replays under the SAME key the body already uses. (Not `client_id` — on some
// endpoints that is a customer FK, not a request key.)
export function bodyIdempotencyKey(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (typeof FormData !== 'undefined' && data instanceof FormData) return null;
  const k = data.client_request_id;
  return typeof k === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(k) ? k : null;
}

export function isTimeoutError(err) {
  if (!err || err.response) return false;
  if (err.code === 'ETIMEDOUT') return true;
  return err.code === 'ECONNABORTED' && /timeout/i.test(err.message || '');
}

// ── 401 handling ─────────────────────────────────────────────────────────────
// A 401 is NOT always a dead session: the server also answers 401 for a wrong
// *credential* inside a live session (wrong current password on change-password,
// wrong MFA code, wrong password on /mfa/disable). Those must surface as a form
// error — not wipe the tokens and bounce to /login.
//
// Session failures come from requireAuth (server/middleware/auth.js) and the
// /auth/refresh absolute cap; their error texts are listed here. A caller doing a
// credential check passes { skipAuthRedirect: true } — but a genuine session
// failure on that same call still redirects.
const SESSION_FAILURE_ERRORS = new Set([
  'Unauthorized',
  'Invalid token',
  'Account deactivated',
  'Session invalidated, please log in again',
  'Impersonation session ended',
  'Session expired, please log in again',
]);
const CREDENTIAL_ERRORS = new Set([
  'Current password is incorrect',
  'Invalid code. Try again.',
  'Incorrect password',
  'Invalid credentials',
]);

/** True when a 401 means the session itself is dead (exported for tests). */
export function isSessionFailure(err) {
  if (err?.response?.status !== 401) return false;
  const body = err.response.data || {};
  if (body.code === 'session_max') return true;
  if (typeof body.error === 'string' && SESSION_FAILURE_ERRORS.has(body.error)) return true;
  if (err.config?.skipAuthRedirect === true) return false;
  if (typeof body.error === 'string' && CREDENTIAL_ERRORS.has(body.error)) return false;
  // Unknown 401 with no opt-out: treat as an expired session (the old behaviour).
  return true;
}

/**
 * Drop the session the failing token came from, and only that one. An
 * impersonation tab uses a tab-scoped sessionStorage token; its expiry must not
 * log the super admin out of their own (localStorage) session in other tabs.
 */
export function clearFailedSession(tokenSource) {
  const store = tokenSource === 'session' ? safeSession : tokenSource === 'local' ? safeLocal : null;
  if (!store) return;
  store.removeItem('tc_token');
  store.removeItem('tc_user');
}

// The interceptors have no React context, so resolve the language from the
// active session's cached user (falls back to the browser language).
function currentT() {
  let lang = null;
  try {
    const store = safeSession.getItem('tc_token') ? safeSession : safeLocal;
    const raw = store.getItem('tc_user');
    if (raw) lang = JSON.parse(raw)?.language || null;
  } catch { /* ignore */ }
  const t = getT(detectLanguage(lang));
  // getT() can return an empty dictionary if no language chunk has loaded yet
  // (main.jsx normally awaits one before first render) — never toast blank text.
  return new Proxy(t, { get: (d, k) => d[k] ?? PRELOAD_FALLBACK[k] ?? '' });
}
// Only used if the i18n chunk hasn't loaded — the real strings live in i18n.js.
const PRELOAD_FALLBACK = {
  apiRetryAfter: 'Please wait {s}s and try again.',
  apiRetryMoment: 'Please wait a moment and try again.',
  apiTooManyRequests: 'Too many requests.',
  apiServiceUnavailable: 'Service temporarily unavailable. Please try again shortly.',
  apiTimeout: 'The server took too long to respond. Please try again.',
  apiNetworkError: 'Network error. Please check your connection and try again.',
  apiForbidden: "You don't have permission to do that.",
  apiNotFound: 'Not found.',
  apiConflict: 'Conflict — please refresh and try again.',
  apiRequestFailed: 'Request failed ({status}).',
  apiDemoEmailSuppressed: 'This is a demo account — the email was not sent. (It would have been delivered on a live account.)',
  apiPeriodLocked: 'That date is in a locked pay period. An admin with pay-period access must unlock it first.',
  apiEntryApproved: 'This entry is already approved. Unapprove it first.',
  apiReportChanged: 'The payroll data changed since you opened this report. Regenerate it, review it, then sign.',
  apiShiftInLockedPeriod: 'The shift was saved, but its date is in a locked pay period. An admin must unlock the period before it can be approved.',
};

// Server error codes with a translated message (the server's `error` text is English).
const ERROR_CODE_KEYS = {
  period_locked: 'apiPeriodLocked',
  entry_approved: 'apiEntryApproved',
  report_changed: 'apiReportChanged',
};

/** Translated message for a known server error `code`, else null (exported for callers + tests). */
export function errorCodeMessage(err) {
  const key = ERROR_CODE_KEYS[err?.response?.data?.code];
  return key ? currentT()[key] || null : null;
}

// Static tool-apps (e.g. Plan Room) share this origin's
// localStorage but not the Vite build env, so they can't see VITE_API_URL.
// Persist the API origin here so a tool can reach the backend the same way.
try { localStorage.setItem('tc_api_base', import.meta.env.VITE_API_URL || ''); } catch { /* storage may be blocked */ }

// Toast integration — ToastContext calls setApiToastHandler on mount so the
// interceptor can surface user-friendly messages for common status codes.
let toastHandler = null;
export function setApiToastHandler(fn) { toastHandler = fn; }
function toast(msg, type = 'error') {
  try { toastHandler?.(msg, type); } catch { /* toast unavailable */ }
}

// De-duplicate 429/503 toasts so a burst of in-flight requests hitting the
// same ceiling doesn't spam the user with N identical toasts.
const recentToasts = new Map();
function throttledToast(key, msg, type) {
  const now = Date.now();
  const last = recentToasts.get(key);
  if (last && now - last < 3000) return;
  recentToasts.set(key, now);
  toast(msg, type);
}

export function requestInterceptor(config) {
  // sessionStorage takes precedence so an impersonation tab uses its own
  // tab-scoped token instead of the super admin's localStorage token.
  // Real login tabs only have localStorage set; the fallthrough is normal.
  const sessionToken = safeSession.getItem('tc_token');
  const token = sessionToken || safeLocal.getItem('tc_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
    // Remember which store the token came from so a 401 clears only that one.
    config._tokenSource = sessionToken ? 'session' : 'local';
  }
  const method = String(config.method || 'get').toLowerCase();
  if (method !== 'get' && config.headers && !config.headers[IDEMPOTENCY_HEADER]) {
    const key = bodyIdempotencyKey(config.data);
    if (key) config.headers[IDEMPOTENCY_HEADER] = key;
  }
  config.timeout = resolveTimeout(config);
  return config;
}
api.interceptors.request.use(requestInterceptor);

export function responseErrorInterceptor(err) {
  const status = err.response?.status;
  const config = err.config || {};
  // Components can opt out of the global 4xx toast by passing
  // { suppressToast: true } in the axios config. Use this when the caller
  // already renders the error in its own UI (form-level error box, inline
  // warning, etc.) and a toast on top would just duplicate the message.
  // A 409 `locked_periods` is never an error to toast: RateHistory's withLockedConfirm
  // turns it into a confirm dialog and resends.
  const suppressToast = config.suppressToast === true
    || (status === 409 && err.response?.data?.code === 'locked_periods');

  if (status === 401) {
    if (isSessionFailure(err) && !window.location.pathname.startsWith('/login')) {
      clearFailedSession(config._tokenSource);
      window.location.href = '/login?session=expired';
    }
    // A credential 401 (wrong password / MFA code) is left to the caller's UI.
  } else if (status === 403 && err.response?.data?.code === 'company_inactive') {
    // requireAuth refuses every request once the company is deactivated; the
    // session is useless, so sign out to a login screen that says why.
    if (!window.location.pathname.startsWith('/login')) {
      clearFailedSession(config._tokenSource);
      window.location.href = '/login?session=inactive';
    }
  } else if (status === 429) {
    const t = currentT();
    const retryAfter = err.response?.headers?.['retry-after'];
    const suffix = retryAfter ? t.apiRetryAfter.replace('{s}', retryAfter) : t.apiRetryMoment;
    throttledToast('429', `${t.apiTooManyRequests} ${suffix}`, 'warning');
  } else if (status === 503 || status === 502 || status === 504) {
    throttledToast('5xx', currentT().apiServiceUnavailable, 'warning');
  } else if (isTimeoutError(err)) {
    if (navigator.onLine !== false) throttledToast('timeout', currentT().apiTimeout, 'warning');
  } else if (!err.response && err.code === 'ERR_NETWORK') {
    // No response at all — network dropped or server unreachable.
    // Skip if the app is offline; OfflineBanner handles that case.
    if (navigator.onLine !== false) {
      throttledToast('network', currentT().apiNetworkError, 'error');
    }
  } else if (status >= 400 && status < 500 && !suppressToast) {
    // Default 4xx handler: surface the server's error message so silent
    // "button did nothing" bugs become impossible. Components that render
    // the error themselves should pass { suppressToast: true } to avoid
    // double-notifying.
    const t = currentT();
    const msg = errorCodeMessage(err)
      || err.response?.data?.error
      || (status === 403 ? t.apiForbidden :
          status === 404 ? t.apiNotFound :
          status === 409 ? t.apiConflict :
          t.apiRequestFailed.replace('{status}', status));
    throttledToast(`4xx:${status}:${config.url || ''}`, msg, 'error');
  }
  return Promise.reject(err);
}

// After a successful write, ask the cache registry which cached collections
// this URL should invalidate and purge them. Keeps the admin's own session
// from serving a stale list; cross-device freshness falls back on the short
// TTL declared alongside each key in cacheRegistry.js.
api.interceptors.response.use(
  r => {
    const method = (r.config?.method || '').toLowerCase();
    if (['post', 'patch', 'put', 'delete'].includes(method)) {
      const url = r.config?.url || '';
      Promise.all([
        import('./cacheRegistry'),
        import('./offlineDb'),
      ]).then(([{ keysInvalidatedByUrl }, { invalidateCache }]) => {
        keysInvalidatedByUrl(url).forEach(invalidateCache);
      }).catch(() => { /* ignore */ });
    }
    // Demo/test tenant: the server suppressed an email that would normally
    // have been sent for this action. Let the user know it didn't go out.
    if (r.data && r.data.demoEmailSuppressed) {
      throttledToast('demo-email', currentT().apiDemoEmailSuppressed, 'warning');
    }
    // Clock-out / switch / mark-day into a LOCKED pay period: the shift is saved but
    // flagged (the server never drops it) — tell the worker it needs an admin.
    if (r.data && (r.data.locked_period || r.data.closed_entry?.locked_period)) {
      throttledToast('locked-period', currentT().apiShiftInLockedPeriod, 'warning');
    }
    return r;
  },
  responseErrorInterceptor
);

export default api;
