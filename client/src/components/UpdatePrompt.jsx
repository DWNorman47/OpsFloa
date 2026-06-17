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

    // The incoming SW replies to GET_VERSION via event.source → this listener.
    const onMessage = evt => {
      if (cancelled) return;
      if (evt.data?.type === 'SW_VERSION' && evt.data.version) setNewVersion(evt.data.version);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    const askVersion = worker => { try { worker.postMessage({ type: 'GET_VERSION' }); } catch { /* ignore */ } };

    // Show the banner only when a genuinely NEW service worker has finished
    // downloading while an older one is still controlling this tab — that's
    // the only moment the JS running here is actually behind and a reload
    // helps. We intentionally do NOT compare version strings or react to
    // `controllerchange`: both fire on ordinary reloads too, and the version
    // comparison stuck "on" whenever the controlling sw.js and the loaded
    // bundle didn't line up (e.g. a CDN-cached sw.js), which is why the
    // banner showed on the current version and never cleared. A plain reload
    // downloads no new worker, so `updatefound` stays quiet and the banner
    // can't reappear once you're on the latest build.
    const watch = worker => {
      if (!worker) return;
      const check = () => {
        if (cancelled) return;
        // `installed` + an existing controller means this is an update to an
        // already-running app, not the first-ever install. sw.js calls
        // skipWaiting() so it activates immediately, but the tab keeps the
        // old bundle until the user reloads.
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          setUpdateReady(true);
          askVersion(worker);
        }
      };
      check(); // it may already be 'installed' by the time we attach
      worker.addEventListener('statechange', check);
    };

    navigator.serviceWorker.getRegistration().then(r => {
      if (cancelled || !r) return;
      // An update that finished installing before this component mounted.
      if (r.waiting && navigator.serviceWorker.controller) { setUpdateReady(true); askVersion(r.waiting); }
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
