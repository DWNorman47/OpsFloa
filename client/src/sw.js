import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';

// Injected by vite-plugin-pwa at build time
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

const QUEUE_DB = 'tc-offline-queue';
const QUEUE_STORE = 'punches';

// ── IndexedDB helpers ──────────────────────────────────────────────────────────

function authScope(auth) {
  try {
    const token = String(auth || '').replace(/^Bearer\s+/i, '');
    const payloadPart = token.split('.')[1];
    if (!payloadPart) return null;
    const normalized = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const payload = JSON.parse(atob(padded));
    if (payload.id == null || payload.company_id == null) return null;
    return `${payload.company_id}:${payload.id}`;
  } catch {
    return null;
  }
}

function openQueueDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(QUEUE_DB, 2);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        db.createObjectStore(QUEUE_STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

async function enqueue(entry) {
  const db = await openQueueDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, 'readwrite');
    const req = tx.objectStore(QUEUE_STORE).add(entry);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAllQueued() {
  const db = await openQueueDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, 'readonly');
    const req = tx.objectStore(QUEUE_STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dequeue(id) {
  const db = await openQueueDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, 'readwrite');
    tx.objectStore(QUEUE_STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function getQueueCount() {
  const db = await openQueueDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, 'readonly');
    const req = tx.objectStore(QUEUE_STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function broadcastQueueCount() {
  const count = await getQueueCount();
  const clients = await self.clients.matchAll();
  clients.forEach(c => c.postMessage({ type: 'QUEUE_COUNT', count }));
}

// ── Offline request handler (clock, time entries, field modules) ───────────────

async function handleOfflineableRequest(event, type) {
  try {
    const response = await fetch(event.request.clone());
    return response;
  } catch {
    const body = await event.request.clone().json().catch(() => ({}));
    const auth = event.request.headers.get('Authorization') || '';
    await enqueue({
      type,
      method: event.request.method,
      url: event.request.url,
      body,
      auth,
      scope: authScope(auth),
      queued_at: new Date().toISOString(),
    });
    await broadcastQueueCount();
    return new Response(
      JSON.stringify({ queued: true, offline: true }),
      { status: 202, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// ── Replay queue ───────────────────────────────────────────────────────────────

function getClientAuth(client) {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 1500);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve(event.data?.auth || null);
    };
    client.postMessage({ type: 'GET_AUTH' }, [channel.port2]);
  });
}

// A browser may have a normal and impersonation tab open at once. Only accept
// a refreshed token for the same company/user that originally queued the item.
async function getFreshAuth(scope) {
  if (!scope) return null;
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  if (clients.length === 0) return null;
  const candidates = await Promise.all(clients.map(getClientAuth));
  return candidates.find(auth => authScope(auth) === scope) || null;
}

async function replayQueue() {
  const items = await getAllQueued();
  let replayed = 0;
  let authFailed = false;
  let partialFailure = false;

  const freshAuthByScope = new Map();

  for (const item of items) {
    try {
      const scope = item.scope || authScope(item.auth);
      if (scope && !freshAuthByScope.has(scope)) {
        freshAuthByScope.set(scope, await getFreshAuth(scope));
      }
      const freshAuth = scope ? freshAuthByScope.get(scope) : null;
      const auth = freshAuth || item.auth;
      if (scope && authScope(auth) !== scope) {
        authFailed = true;
        continue;
      }
      const res = await fetch(item.url, {
        method: item.method || 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(auth ? { Authorization: auth } : {}),
        },
        body: JSON.stringify(item.body),
      });
      if (res.status === 401) {
        // Even the fresh token (or fallback) was rejected. Drop the request
        // rather than retrying forever — at this point the user needs to
        // re-authenticate, and the request body is probably stale anyway.
        await dequeue(item.id);
        authFailed = true;
        continue;
      }
      if (res.ok || res.status === 409) {
        await dequeue(item.id);
        replayed++;
      } else {
        // 400/403 — bad request, remove from queue to avoid loop
        await dequeue(item.id);
        partialFailure = true;
      }
    } catch {
      // Still offline — leave in queue
    }
  }
  await broadcastQueueCount();
  const clients = await self.clients.matchAll();
  if (authFailed) {
    clients.forEach(c => c.postMessage({ type: 'REPLAY_AUTH_FAILED' }));
  }
  if (partialFailure) {
    clients.forEach(c => c.postMessage({ type: 'REPLAY_PARTIAL_FAILURE' }));
  }
  // Always emit QUEUE_REPLAYED so listeners (e.g. ClockInOut) refresh
  // /clock/status, even when nothing succeeded.
  clients.forEach(c => c.postMessage({ type: 'QUEUE_REPLAYED', count: replayed }));
}

// ── Service worker lifecycle ───────────────────────────────────────────────────

// ── Push notifications ─────────────────────────────────────────────────────────

self.addEventListener('push', event => {
  const data = event.data?.json() ?? {};
  const isMessage = data.type === 'message';
  event.waitUntil(
    self.registration.showNotification(data.title || 'OpsFloa', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      // Web push can't set a custom sound file reliably — rely on the OS
      // notification sound plus a vibration pattern for message pushes.
      // tag+renotify groups a thread but still re-alerts on each new message.
      ...(isMessage ? { vibrate: [200, 100, 200], tag: 'chat', renotify: true } : {}),
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(list => {
      for (const c of list) {
        if (c.url && 'focus' in c) return c.focus();
      }
      return clients.openWindow(event.notification.data?.url || '/');
    })
  );
});

// ── Fetch handler ──────────────────────────────────────────────────────────────

self.addEventListener('fetch', event => {
  const url = event.request.url;

  if (event.request.method === 'PATCH') {
    if (url.includes('/api/time-entries/') && !url.includes('/messages') && !url.includes('/sign-off')) {
      event.respondWith(handleOfflineableRequest(event, 'time-entry'));
      return;
    }
  }

  if (event.request.method === 'POST') {
    if (url.includes('/api/clock/in') || url.includes('/api/clock/out') || url.includes('/api/clock/switch')) {
      event.respondWith(handleOfflineableRequest(event, 'clock'));
      return;
    }
    if (url.includes('/api/time-entries') && !url.includes('/messages') && !url.includes('/sign-off')) {
      event.respondWith(handleOfflineableRequest(event, 'time-entry'));
      return;
    }
    if (
      url.includes('/api/field-reports') ||
      url.includes('/api/daily-reports') ||
      url.includes('/api/punchlist') ||
      url.includes('/api/incidents') ||
      url.includes('/api/safety-talks') ||
      url.includes('/api/equipment') ||
      url.includes('/api/rfis') ||
      url.includes('/api/sub-reports') ||
      url.includes('/api/inspections')
    ) {
      event.respondWith(handleOfflineableRequest(event, 'field'));
      return;
    }
  }
});

// ── Message handler (page → SW) ────────────────────────────────────────────────

// Injected by Vite's `define` config. Both the SW and the app bundle pick up
// the SAME version string, so the page can compare them to tell whether a
// just-activated SW is actually newer than the JS already running in the tab.
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown';

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
  }
  if (event.data?.type === 'REPLAY_QUEUE') {
    event.waitUntil(replayQueue());
  }
  if (event.data?.type === 'GET_QUEUE_COUNT') {
    event.waitUntil(broadcastQueueCount());
  }
  if (event.data?.type === 'CLEAR_QUEUE') {
    event.waitUntil((async () => {
      const scope = event.data.scope;
      if (!scope) return;
      const items = await getAllQueued();
      for (const item of items) {
        if ((item.scope || authScope(item.auth)) === scope) await dequeue(item.id);
      }
      await broadcastQueueCount();
    })());
  }
  if (event.data?.type === 'GET_VERSION') {
    event.source?.postMessage({ type: 'SW_VERSION', version: APP_VERSION });
  }
});

// ── Background Sync (Chrome/Edge) ──────────────────────────────────────────────

self.addEventListener('sync', event => {
  if (event.tag === 'clock-queue-replay' || event.tag === 'field-queue-replay') {
    event.waitUntil(replayQueue());
  }
});
