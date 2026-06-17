/**
 * UpdatePrompt — non-blocking banner that appears when a new service-worker
 * version has activated. The SW updates itself automatically (sw.js calls
 * self.skipWaiting + self.clients.claim), but the currently-loaded JS bundle
 * in the tab is still the previous version until the page reloads. This
 * banner lets the user reload at a moment that won't nuke their work.
 */

import React, { useEffect, useState } from 'react';
import { useT } from '../hooks/useT';
import { useAuth } from '../contexts/AuthContext';

export default function UpdatePrompt() {
  const t = useT();
  const { user } = useAuth();
  const [updateReady, setUpdateReady] = useState(false);
  // TEMPORARY: surface which build the reload will bring. `newVersion` is the
  // incoming worker's version (asked via GET_VERSION); currentVersion is what's
  // running now. Remove the version tag when deploy debugging wraps up.
  const [newVersion, setNewVersion] = useState(null);
  // eslint-disable-next-line no-undef
  const currentVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null;

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    let cancelled = false;
    // eslint-disable-next-line no-undef
    const bundleVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null;

    // A new worker installing isn't proof of a new *version*: a same-commit
    // rebuild can produce a byte-different sw.js (so `updatefound` fires) while
    // the version string is unchanged. So we ask the freshly-installed worker
    // its version and only surface the banner when it actually differs from the
    // build running here. (We query the NEW worker directly — not the current
    // controller — so a stale cached controller can't skew the comparison.)
    const onMessage = evt => {
      if (cancelled) return;
      if (evt.data?.type === 'SW_VERSION' && evt.data.version) {
        setNewVersion(evt.data.version);
        if (!bundleVersion || evt.data.version !== bundleVersion) setUpdateReady(true);
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    const askVersion = worker => { try { worker.postMessage({ type: 'GET_VERSION' }); } catch { /* ignore */ } };

    // Detection uses `updatefound` (not `controllerchange`, which fires on
    // ordinary reloads): a plain reload downloads no new worker, so nothing
    // fires. The version check above then filters out same-version rebuilds.
    // A worker reaching `installed` while one already controls the tab is an
    // update to an already-running app (not the first-ever install). sw.js calls
    // skipWaiting() so it activates immediately, but the tab keeps the old
    // bundle until reload. Ask its version; onMessage decides whether to show.
    // If we can't version-check at all (no bundle version), assume it's real.
    const consider = worker => {
      if (cancelled || !worker) return;
      if (worker.state === 'installed' && navigator.serviceWorker.controller) {
        askVersion(worker);
        if (!bundleVersion) setUpdateReady(true);
      }
    };
    const watch = worker => {
      if (!worker) return;
      const check = () => consider(worker);
      check(); // it may already be 'installed' by the time we attach
      worker.addEventListener('statechange', check);
    };

    navigator.serviceWorker.getRegistration().then(r => {
      if (cancelled || !r) return;
      // An update that finished installing before this component mounted.
      if (r.waiting) consider(r.waiting);
      // One that's mid-install right now…
      watch(r.installing);
      // …or one that starts installing while the tab stays open. The
      // registration is shared across tabs, so this also fires when another
      // tab triggers the update.
      r.addEventListener('updatefound', () => watch(r.installing));
    });

    return () => { cancelled = true; navigator.serviceWorker.removeEventListener('message', onMessage); };
  }, []);

  if (!updateReady || !user) return null;

  const reload = () => {
    try { window.location.reload(); }
    catch { /* ignore */ }
  };

  return (
    <div style={styles.banner} role="status" aria-live="polite">
      <span style={styles.message}>
        <span style={styles.dot} aria-hidden="true" />
        {t.updateReady}
      </span>
      {/* TEMPORARY version tag — remove with the rest of the deploy-debug markers. */}
      {(currentVersion || newVersion) && (
        <span style={styles.versionTag} aria-hidden="true">
          {currentVersion ? `v${currentVersion}` : ''}{newVersion ? ` → v${newVersion}` : ''}
        </span>
      )}
      <a href="/changelog" target="_blank" rel="noopener noreferrer" style={styles.whatsNew}>
        {t.updateWhatsNew}
      </a>
      <button type="button" style={styles.reloadBtn} onClick={reload}>
        {t.updateReload}
      </button>
      <button type="button" style={styles.dismissBtn} onClick={() => setUpdateReady(false)} aria-label={t.updateDismissAria}>
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
  versionTag: {
    fontSize: 11, color: '#9ca3af', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    whiteSpace: 'nowrap',
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
