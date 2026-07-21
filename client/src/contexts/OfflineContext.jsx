import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { useToast } from './ToastContext';

import { silentError } from '../errorReporter';
import { safeSession, safeLocal } from '../utils/safeStorage';
export const OfflineContext = createContext(null);

export function OfflineProvider({ children }) {
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [queueCount, setQueueCount] = useState(0);
  const addToast = useToast();
  const listenersRef = useRef([]);

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
      sendToSW({ type: 'REPLAY_QUEUE' });
      if ('serviceWorker' in navigator && 'sync' in ServiceWorkerRegistration.prototype) {
        navigator.serviceWorker.ready.then(reg => {
          reg.sync.register('clock-queue-replay').catch(silentError('offlinecontext'));
        });
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

  useEffect(() => {
    const handleMessage = (event) => {
      const { type, count } = event.data || {};
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
        setQueueCount(prev => Math.max(0, prev - (count ?? 0)));
        if (count > 0) {
          addToast(`${count} offline entr${count === 1 ? 'y' : 'ies'} synced`, 'success');
        }
        listenersRef.current.forEach(fn => fn(count ?? 0));
      }
      if (type === 'REPLAY_AUTH_FAILED') {
        addToast('Session expired — log in again. If you clocked out offline, check your status and clock out again if needed.', 'error');
        // Fire sync listeners so views (e.g. ClockInOut) can refresh from
        // the server and reveal any active_clock that didn't get cleared.
        listenersRef.current.forEach(fn => fn(0));
      }
      if (type === 'REPLAY_PARTIAL_FAILURE') {
        addToast('Some offline entries could not be synced. If you clocked out, please verify and clock out again if needed.', 'warning');
        listenersRef.current.forEach(fn => fn(0));
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
