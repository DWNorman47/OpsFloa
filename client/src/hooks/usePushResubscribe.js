import { useEffect } from 'react';
import { ensurePushSubscription } from '../utils/pushSubscription';
import { safeSession } from '../utils/safeStorage';

// Users whose subscription was already ensured in this page load — one POST per
// session start, not per re-render / cached-user refresh.
const ensuredFor = new Set();

/**
 * App-level push re-subscribe (mounted once, in AuthProvider). Whenever a session
 * becomes active — login, MFA confirm, loginWithToken (sign-up / complete setup) or
 * a page load that restores a session — and the browser has already granted
 * notification permission, make sure this device is subscribed and registered for
 * that user. Logout unsubscribes, so without this pushes stopped silently until the
 * user opened the Account page. Skipped for impersonation tabs (the browser's
 * subscription belongs to the real signed-in account).
 */
// `waitFor` (optional): returns a promise to settle first — AuthContext passes the
// in-flight logout unsubscribe, so a quick logout → login doesn't re-register a
// subscription that is about to be torn down.
export function usePushResubscribe(user, loading, waitFor) {
  const userId = user?.id ?? null;
  useEffect(() => {
    if (loading || userId == null) return;
    if (safeSession.getItem('tc_token')) return; // impersonation tab
    if (ensuredFor.has(userId)) return;
    ensuredFor.add(userId);
    Promise.resolve(waitFor ? waitFor() : null)
      .catch(() => {})
      .then(() => ensurePushSubscription())
      .then(ok => { if (!ok) ensuredFor.delete(userId); });
  }, [userId, loading]);
}

// Logout clears the memo so the next login (same or different user) re-subscribes.
export function resetPushResubscribe() {
  ensuredFor.clear();
}
