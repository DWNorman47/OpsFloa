/**
 * UpdatePrompt — non-blocking "a new version is ready" banner.
 *
 * Detection is deliberately simple and server-driven: poll a tiny version.json
 * (emitted at build time, never precached) and compare its version to the build
 * running in this tab (__APP_VERSION__). If they differ, a newer deploy is live
 * and a reload will pick it up. The service worker waits instead of taking over
 * a running tab; the reload action explicitly activates a waiting worker.
 *
 * Polls on an interval and whenever the tab regains focus/visibility. Can't get
 * stuck: once you reload onto the new build the versions match and it clears.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useT } from '../hooks/useT';
import { useAuth } from '../contexts/AuthContext';

const CHECK_INTERVAL_MS = 10 * 60 * 1000; // every 10 minutes

export async function activateUpdateAndReload(reload = () => window.location.reload()) {
  if (!('serviceWorker' in navigator)) {
    reload();
    return;
  }

  let registration;
  try {
    registration = await navigator.serviceWorker.getRegistration();
  } catch {
    reload();
    return;
  }

  if (typeof registration?.update === 'function') {
    try { await registration.update(); } catch { /* reload still works without an update check */ }
  }

  let waiting = registration?.waiting;
  const installing = registration?.installing;
  if (!waiting && installing) {
    await new Promise(resolve => {
      let settled = false;
      let timeout;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        installing.removeEventListener('statechange', onStateChange);
        resolve();
      };
      const onStateChange = () => {
        if (['installed', 'activated', 'redundant'].includes(installing.state)) finish();
      };
      installing.addEventListener('statechange', onStateChange);
      onStateChange();
      if (!settled) timeout = setTimeout(finish, 1500);
    });
    waiting = registration.waiting || (installing.state === 'installed' ? installing : null);
  }

  if (!waiting) {
    reload();
    return;
  }

  let finished = false;
  let fallback;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (fallback) clearTimeout(fallback);
    reload();
  };
  const onStateChange = () => {
    if (waiting.state === 'activated') finish();
  };
  waiting.addEventListener('statechange', onStateChange);
  waiting.postMessage({ type: 'SKIP_WAITING' });
  if (!finished) fallback = setTimeout(finish, 2000);
}

export default function UpdatePrompt() {
  const t = useT();
  const { user } = useAuth();
  // eslint-disable-next-line no-undef
  const currentVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null;
  const [newVersion, setNewVersion] = useState(null);
  const [dismissed, setDismissed] = useState(null); // version the user dismissed this session

  const check = useCallback(async () => {
    if (!currentVersion) return; // nothing to compare against
    try {
      const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (data?.version && data.version !== currentVersion) {
        setNewVersion(data.version);
      }
    } catch {
      // Offline or transient — ignore; we'll try again on the next tick/focus.
    }
  }, [currentVersion]);

  useEffect(() => {
    if (!currentVersion) return undefined;
    check();
    const interval = setInterval(check, CHECK_INTERVAL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', check);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', check);
    };
  }, [check, currentVersion]);

  // Show only when there's a newer version the user hasn't dismissed. If an even
  // newer one ships later, newVersion changes and it surfaces again.
  if (!user || !newVersion || newVersion === dismissed) return null;

  return (
    <div style={styles.banner} role="status" aria-live="polite">
      <span style={styles.message}>
        <span style={styles.dot} aria-hidden="true" />
        {t.updateReady}
      </span>
      <a href="/changelog" target="_blank" rel="noopener noreferrer" style={styles.whatsNew}>
        {t.updateWhatsNew}
      </a>
      <button type="button" style={styles.reloadBtn} onClick={() => activateUpdateAndReload()}>
        {t.updateReload}
      </button>
      <button type="button" style={styles.dismissBtn} onClick={() => setDismissed(newVersion)} aria-label={t.updateDismissAria}>
        ✕
      </button>
    </div>
  );
}

const styles = {
  banner: {
    position: 'fixed',
    bottom: 16,
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    background: '#1f2937',
    color: '#fff',
    padding: '10px 14px',
    borderRadius: 10,
    boxShadow: '0 8px 24px rgba(0,0,0,0.22)',
    fontSize: 14,
    zIndex: 2000,
    maxWidth: 'calc(100vw - 32px)',
  },
  message: { display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 500 },
  dot: {
    width: 8, height: 8, borderRadius: '50%',
    background: '#22c55e', display: 'inline-block',
  },
  whatsNew: {
    color: '#93c5fd', textDecoration: 'underline', fontSize: 13, marginRight: 2,
  },
  reloadBtn: {
    background: '#2563eb', color: '#fff', border: 'none',
    padding: '6px 14px', borderRadius: 7, fontSize: 13, fontWeight: 700, cursor: 'pointer',
  },
  dismissBtn: {
    background: 'transparent', color: '#9ca3af', border: 'none',
    fontSize: 16, cursor: 'pointer', padding: '4px 6px',
  },
};
