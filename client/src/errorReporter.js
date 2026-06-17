// Sends client-side errors to the server's /api/client-errors endpoint.
// Never throws — reporting must never take down the app.
//
// Kinds:
//   'render'      — caught by React ErrorBoundary (render-phase crash)
//   'unhandled'   — caught by window.onerror (sync uncaught)
//   'rejection'   — caught by unhandledrejection event (async uncaught)
//
// Uses navigator.sendBeacon when available so reports survive a page unload.
// Falls back to fetch. Deduplicates identical reports within a 5-second
// window to avoid flooding when a bug fires in a render loop.

import api from './api';
import * as Sentry from '@sentry/react';

const APP_VERSION = (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown');
const RECENT_WINDOW_MS = 5000;
const recent = new Map(); // key -> last-seen timestamp

// Strip secret tokens out of the reported URL. Public token pages
// (/e/<token>, /co/<token>, /lien-waiver-sign/<token>, /book/manage/<token>)
// and token query params would otherwise land in the client_errors table
// in plaintext — anyone with DB/log access could replay them.
function redactUrl(href) {
  if (!href) return null;
  try {
    const u = new URL(href);
    u.pathname = u.pathname
      .replace(/\/(e|co)\/[^/]+/, '/$1/[redacted]')
      .replace(/\/(lien-waiver-sign|confirm-email|reset-password|accept-invite)\/[^/]+/, '/$1/[redacted]')
      .replace(/\/book\/manage\/[^/]+/, '/book/manage/[redacted]');
    for (const k of ['token', 'reset', 'invite']) {
      if (u.searchParams.has(k)) u.searchParams.set(k, '[redacted]');
    }
    return u.toString();
  } catch {
    return String(href).split('?')[0]; // fallback: at least drop the query string
  }
}

function fingerprint(kind, message, stack) {
  // Collapse line/column numbers inside stacks so "same error, different line offset" still dedupes.
  const s = (stack || '').replace(/:\d+:\d+/g, ':L:C').slice(0, 500);
  return `${kind}|${(message || '').slice(0, 200)}|${s}`;
}

function shouldSend(kind, message, stack) {
  const fp = fingerprint(kind, message, stack);
  const now = Date.now();
  const last = recent.get(fp);
  if (last && now - last < RECENT_WINDOW_MS) return false;
  recent.set(fp, now);
  // Trim the map so it doesn't grow forever on long-lived sessions.
  if (recent.size > 100) {
    for (const [k, t] of recent) {
      if (now - t > RECENT_WINDOW_MS) recent.delete(k);
    }
  }
  return true;
}

export function reportClientError({ kind, message, stack }) {
  try {
    if (!shouldSend(kind, message, stack)) return;
    // Fire-and-forget to Sentry too (no-op when DSN is absent). Sentry gets
    // grouped/symbolicated errors with breadcrumbs; our DB gets the raw firehose.
    if (import.meta.env.VITE_SENTRY_DSN) {
      const err = new Error(String(message || 'unknown'));
      if (stack) err.stack = String(stack);
      Sentry.captureException(err, { tags: { kind } });
    }
    const payload = {
      kind,
      message: String(message || 'unknown'),
      stack: stack ? String(stack) : null,
      url: typeof window !== 'undefined' ? redactUrl(window.location.href) : null,
      app_version: APP_VERSION,
    };
    // Prefer fetch via the api client so the Authorization header is included
    // when the user is logged in — lets the server associate the error with
    // the user + company without extra work.
    api.post('/client-errors', payload, { suppressToast: true }).catch(() => {
      // Absolute last-resort fallback: beacon with no auth header.
      try {
        if (navigator.sendBeacon) {
          const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
          navigator.sendBeacon('/api/client-errors', blob);
        }
      } catch { /* give up */ }
    });
  } catch { /* reporting must never throw */ }
}

/**
 * Build a .catch() handler that reports the error to Sentry + our DB but
 * doesn't surface it in the UI. Use for background fetches where the UX
 * decision is "don't bother the user" but the engineering decision must
 * still be "don't hide bugs from ourselves."
 *
 * Usage (preferred — labels the report):
 *   api.get('/foo').then(r => setFoo(r.data)).catch(silentError('fetch foo'));
 *
 * Two other call styles are common across the codebase and must also report,
 * not silently no-op:
 *   .catch(silentError)              // invoked with the error as the argument
 *   catch (err) { silentError(err) } // invoked with the error directly
 * We detect those (the argument isn't a string label) and report immediately.
 */
export function silentError(context) {
  // Called as the rejection handler itself, or with an error object — report now.
  if (context && typeof context !== 'string') {
    const err = context;
    reportClientError({
      kind: 'unhandled',
      message: err?.message || String(err),
      stack: err?.stack || null,
    });
    return undefined;
  }
  // Called as a factory with a string label — return the handler.
  return err => {
    reportClientError({
      kind: 'unhandled',
      message: `${context}: ${err?.message || err}`,
      stack: err?.stack || null,
    });
  };
}

// Wire global handlers once. Call from main.jsx / App.jsx entrypoint.
let installed = false;
export function installGlobalErrorHandlers() {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', e => {
    // ignore resource-load errors (<img> 404s etc.) — e.error is null for those
    if (!e.error && !e.message) return;
    reportClientError({
      kind: 'unhandled',
      message: e.message || 'unhandled error',
      stack: e.error?.stack || null,
    });
  });

  window.addEventListener('unhandledrejection', e => {
    const reason = e.reason;
    reportClientError({
      kind: 'rejection',
      message: reason?.message || String(reason || 'unhandled rejection'),
      stack: reason?.stack || null,
    });
  });
}
