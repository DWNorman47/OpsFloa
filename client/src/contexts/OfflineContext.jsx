import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { useToast } from './ToastContext';
import { useAuth } from './AuthContext';
import { useT } from '../hooks/useT';

import { safeSession, safeLocal } from '../utils/safeStorage';
export const OfflineContext = createContext(null);

// While entries are queued and we're online, nudge the SW to retry this often. The SW honors
// each item's backoff on these automatic passes, so this is cheap; it's what gets a queue
// synced after a Render cold start / deploy (5xx) without the user tapping Retry, including on
// iOS where Background Sync doesn't exist.
const AUTO_RETRY_MS = 60 * 1000;

export function OfflineProvider({ children }) {
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  // Raw SW counts: total + per user scope ("company:user"). A shared phone can hold another
  // worker's unsynced items; this user only sees / syncs / clears their own.
  const [queueCounts, setQueueCounts] = useState({ count: 0, byScope: null });
  const addToast = useToast();
  const t = useT();
  const tRef = useRef(t);
  const { user } = useAuth() || {};
  const userScope = user?.id != null && user?.company_id != null ? `${user.company_id}:${user.id}` : null;
  const listenersRef = useRef([]);
  const userScopeRef = useRef(userScope);
  userScopeRef.current = userScope;

  const { queueCount, otherUserQueueCount } = splitQueueCounts(queueCounts, userScope);

  useEffect(() => { tRef.current = t; }, [t]);

  // Replay and clear requests always carry the signed-in user's scope, so the SW only touches
  // that user's queued items (never another worker's on a shared phone).
  const sendToSW = useCallback((msg) => {
    if (navigator.serviceWorker?.controller) {
      const scoped = (msg?.type === 'REPLAY_QUEUE' || msg?.type === 'CLEAR_QUEUE') && !msg.scope && userScopeRef.current
        ? { ...msg, scope: userScopeRef.current }
        : msg;
      navigator.serviceWorker.controller.postMessage(scoped);
    }
  }, []);

  // One-time notice (per signed-in user, per browser session) that the device holds another
  // user's unsynced items — they stay put and sync when that user signs in again.
  useEffect(() => {
    if (!userScope || otherUserQueueCount <= 0) return;
    const key = `tc_other_queue_notice:${userScope}`;
    try { if (safeSession.getItem(key)) return; } catch { /* storage blocked */ }
    try { safeSession.setItem(key, '1'); } catch { /* storage blocked */ }
    addToast((tRef.current.offlineOtherUserQueued || '').replace('{n}', otherUserQueueCount), 'info');
  }, [userScope, otherUserQueueCount, addToast]);

  // Subscribe to QUEUE_REPLAYED events
  const onSync = useCallback((fn) => {
    listenersRef.current.push(fn);
    return () => {
      listenersRef.current = listenersRef.current.filter(f => f !== fn);
    };
  }, []);

  useEffect(() => {
    const handleOnline = () => {
      setIsOffline(false);
      // Fire ONE replay trigger, not both — two triggers used to run the SW replay
      // concurrently (now also guarded by an in-flight lock in the SW). Prefer
      // Background Sync (retries, survives page close); fall back to a direct message
      // where it's unsupported (e.g. iOS Safari) or registration fails.
      if ('serviceWorker' in navigator && 'sync' in ServiceWorkerRegistration.prototype) {
        navigator.serviceWorker.ready
          .then(reg => reg.sync.register('clock-queue-replay'))
          .catch(() => sendToSW({ type: 'REPLAY_QUEUE', auto: true }));
      } else {
        sendToSW({ type: 'REPLAY_QUEUE', auto: true });
      }
    };
    const handleOffline = () => setIsOffline(true);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [sendToSW]);

  // Replay whenever a user is signed in: on app start (a queue left over from a previous
  // session) and right after a (re-)login. A 401 during replay KEEPS the queued items and
  // pauses them until the user re-authenticates — this is what resumes them.
  useEffect(() => {
    if (!userScope || !navigator.onLine) return;
    sendToSW({ type: 'REPLAY_QUEUE', auto: true });
  }, [userScope, sendToSW]);

  useEffect(() => {
    if (!userScope || queueCount <= 0) return undefined;
    const id = setInterval(() => {
      if (navigator.onLine) sendToSW({ type: 'REPLAY_QUEUE', auto: true });
    }, AUTO_RETRY_MS);
    return () => clearInterval(id);
  }, [userScope, queueCount, sendToSW]);

  useEffect(() => {
    const handleMessage = (event) => {
      const { type, count } = event.data || {};
      const tr = tRef.current;
      // SW asks for the user's current auth header before replaying queued
      // requests. Reply via the MessagePort the SW sent so the response
      // reaches the right replay attempt. Reading from sessionStorage first
      // matches api.js so an impersonation tab's token is preferred.
      if (type === 'GET_AUTH' && event.ports && event.ports[0]) {
        const token = safeSession.getItem('tc_token') || safeLocal.getItem('tc_token');
        event.ports[0].postMessage({ auth: token ? `Bearer ${token}` : null });
        return;
      }
      if (type === 'QUEUE_COUNT') {
        setQueueCounts({ count: count ?? 0, byScope: event.data.byScope || null });
      }
      if (type === 'QUEUE_REPLAYED') {
        // The SW broadcasts the authoritative QUEUE_COUNT just before this, so don't
        // subtract again here (that undercounted whenever only part of the queue synced).
        if (count > 0) {
          addToast(count === 1 ? tr.offlineSyncedOne : tr.offlineSyncedMany.replace('{n}', count), 'success');
        }
        listenersRef.current.forEach(fn => fn(count ?? 0));
      }
      if (type === 'REPLAY_AUTH_FAILED') {
        // 403 company_inactive: the items are kept (the company may be restored), but "log in
        // again" wouldn't help — say what actually happened.
        addToast(event.data?.reason === 'company_inactive' ? tr.offlineReplayCompanyInactive : tr.offlineReplayAuthFailed, 'error');
        // Fire sync listeners so views (e.g. ClockInOut) can refresh from
        // the server and reveal any active_clock that didn't get cleared.
        listenersRef.current.forEach(fn => fn(0));
      }
      if (type === 'REPLAY_PARTIAL_FAILURE') {
        addToast(tr.offlineReplayPartialFailure, 'warning');
        listenersRef.current.forEach(fn => fn(0));
      }
      if (type === 'REPLAY_STUCK') {
        addToast(tr.offlineReplayStuck, 'warning');
      }
    };

    navigator.serviceWorker?.addEventListener('message', handleMessage);
    // Request initial count
    sendToSW({ type: 'GET_QUEUE_COUNT' });
    return () => navigator.serviceWorker?.removeEventListener('message', handleMessage);
  }, [sendToSW, addToast]);

  return (
    <OfflineContext.Provider value={{ isOffline, queueCount, otherUserQueueCount, sendToSW, onSync }}>
      {children}
    </OfflineContext.Provider>
  );
}

/**
 * This user's queued-item count vs. everyone else's (exported for tests). Items with no
 * decodable user ('' scope) count as the current user's. An older SW without per-scope counts
 * → everything is "mine", as before.
 */
export function splitQueueCounts({ count = 0, byScope = null } = {}, userScope = null) {
  if (!byScope || !userScope) return { queueCount: count, otherUserQueueCount: 0 };
  const mine = (byScope[userScope] || 0) + (byScope[''] || 0);
  return { queueCount: mine, otherUserQueueCount: Math.max(0, count - mine) };
}

export function useOffline() {
  return useContext(OfflineContext);
}
