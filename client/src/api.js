import axios from 'axios';
import { safeSession, safeLocal } from './utils/safeStorage';

const baseURL = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';
const api = axios.create({ baseURL });

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

api.interceptors.request.use(config => {
  // sessionStorage takes precedence so an impersonation tab uses its own
  // tab-scoped token instead of the super admin's localStorage token.
  // Real login tabs only have localStorage set; the fallthrough is normal.
  const token = safeSession.getItem('tc_token') || safeLocal.getItem('tc_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

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
      throttledToast('demo-email', 'This is a demo account — the email was not sent. (It would have been delivered on a live account.)', 'warning');
    }
    return r;
  },
  err => {
    const status = err.response?.status;
    const config = err.config || {};
    // Components can opt out of the global 4xx toast by passing
    // { suppressToast: true } in the axios config. Use this when the caller
    // already renders the error in its own UI (form-level error box, inline
    // warning, etc.) and a toast on top would just duplicate the message.
    const suppressToast = config.suppressToast === true;

    if (status === 401 && !window.location.pathname.startsWith('/login')) {
      // Clear both stores — the bad token might be the impersonation one
      // (sessionStorage) or the persistent one (localStorage).
      safeSession.removeItem('tc_token');
      safeLocal.removeItem('tc_token');
      window.location.href = '/login?session=expired';
    } else if (status === 429) {
      const retryAfter = err.response?.headers?.['retry-after'];
      const suffix = retryAfter ? ` Please wait ${retryAfter}s and try again.` : ' Please wait a moment and try again.';
      throttledToast('429', 'Too many requests.' + suffix, 'warning');
    } else if (status === 503 || status === 502 || status === 504) {
      throttledToast('5xx', 'Service temporarily unavailable. Please try again shortly.', 'warning');
    } else if (!err.response && err.code === 'ERR_NETWORK') {
      // No response at all — network dropped or server unreachable.
      // Skip if the app is offline; OfflineBanner handles that case.
      if (navigator.onLine !== false) {
        throttledToast('network', 'Network error. Please check your connection and try again.', 'error');
      }
    } else if (status >= 400 && status < 500 && status !== 401 && status !== 429 && !suppressToast) {
      // Default 4xx handler: surface the server's error message so silent
      // "button did nothing" bugs become impossible. Components that render
      // the error themselves should pass { suppressToast: true } to avoid
      // double-notifying.
      const msg = err.response?.data?.error
        || (status === 403 ? "You don't have permission to do that." :
            status === 404 ? 'Not found.' :
            status === 409 ? 'Conflict — please refresh and try again.' :
            `Request failed (${status}).`);
      throttledToast(`4xx:${status}:${config.url || ''}`, msg, 'error');
    }
    return Promise.reject(err);
  }
);

export default api;
