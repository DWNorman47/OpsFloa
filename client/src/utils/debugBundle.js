/**
 * Collects the browser's current client-side state into a single JSON blob
 * and triggers a download. Used from SuperAdmin after impersonating a user
 * to capture the exact client state that session saw — IndexedDB caches,
 * persisted forms, auth token metadata (never the token itself).
 *
 * The output is meant to be attached to a support ticket or dropped into an
 * issue comment; none of it is transmitted automatically.
 */

import { openDB } from 'idb';

async function readIndexedDB() {
  try {
    const db = await openDB('opsfloa-cache', 2);
    const out = {};
    for (const storeName of db.objectStoreNames) {
      try {
        const tx = db.transaction(storeName);
        const keys = await tx.store.getAllKeys();
        const values = await tx.store.getAll();
        out[storeName] = keys.map((k, i) => ({ key: String(k), value: values[i] }));
      } catch (e) {
        out[storeName] = { error: String(e?.message || e) };
      }
    }
    db.close();
    return out;
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

function readStorage(kind) {
  const out = {};
  try {
    // Access the property inside the try — reading window.sessionStorage can
    // itself throw a SecurityError in storage-blocked/partitioned contexts.
    const storage = typeof window !== 'undefined' ? window[kind] : null;
    if (!storage) return out;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key) continue;
      // Never include the auth token itself — flag its presence/length only.
      if (key === 'tc_token') {
        out[key] = { present: true, length: (storage.getItem(key) || '').length };
      } else {
        out[key] = storage.getItem(key);
      }
    }
  } catch (e) {
    return { error: String(e?.message || e) };
  }
  return out;
}

export async function downloadDebugBundle() {
  const bundle = {
    captured_at:     new Date().toISOString(),
    url:             window.location.href,
    user_agent:      navigator.userAgent,
    online:          navigator.onLine,
    localStorage:    readStorage('localStorage'),
    sessionStorage:  readStorage('sessionStorage'),
    indexedDB:       await readIndexedDB(),
    service_worker:  await describeServiceWorker(),
  };

  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `opsfloa-debug-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function describeServiceWorker() {
  try {
    if (!('serviceWorker' in navigator)) return { supported: false };
    const regs = await navigator.serviceWorker.getRegistrations();
    return {
      supported: true,
      registrations: regs.map(r => ({
        scope:  r.scope,
        active: r.active ? { state: r.active.state, script: r.active.scriptURL } : null,
        waiting: r.waiting ? { state: r.waiting.state } : null,
      })),
    };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}
