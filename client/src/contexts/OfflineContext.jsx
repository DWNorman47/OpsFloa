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
  const [queueCount, setQueueCount] = useState(0);
  const addToast = useToast();
  const t = useT();
  const tRef = useRef(t);
  const { user } = useAuth() || {};
  const userScope = user?.id != null && user?.company_id != null ? `${user.company_id}:${user.id}` : null;
  const listenersRef = useRef([]);

  useEffect(() => { tRef.current = t; }, [t]);

  const sendToSW = useCallback((msg) => {
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage(msg);
    }
  }, []);

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
        setQueueCount(count ?? 0);
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
        addToast(tr.offlineReplayAuthFailed, 'error');
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
    <OfflineContext.Provider value={{ isOffline, queueCount, sendToSW, onSync }}>
      {children}
    </OfflineContext.Provider>
  );
}

export function useOffline() {
  return useContext(OfflineContext);
}
