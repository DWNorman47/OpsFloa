import { precacheAndRoute, cleanupOutdatedCaches, matchPrecache } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import {
  IDEMPOTENCY_HEADER,
  classifyReplayStatus,
  countsTowardBackoff,
  isAbortTimeout,
  isAuthPaused,
  isBackingOff,
  isStuck,
  isTokenExpired,
  newIdempotencyKey,
  parseQueueableBody,
  replayLane,
  replayTimeoutMs,
  requestTimeoutMs,
  timeoutSignal,
  tokenSig,
  withAttemptStarted,
  withFailedAttempt,
} from './offlineQueuePolicy';

// Injected by vite-plugin-pwa at build time
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Navigations are network-FIRST: always fetch the freshest index.html from the network (it
// references the CURRENT asset hashes), so a new tab or a reload can never boot a stale
// PRECACHED shell — the recurring blank-screen cause. Fall back to the precached shell only
// when the network is unavailable (offline), which keeps offline / deep-link launches
// working. API + version.json are never navigations but are excluded defensively.
registerRoute(new NavigationRoute(async ({ url }) => {
  try {
    return await fetch(url.href, { cache: 'no-cache' }); // revalidate → always the current shell
  } catch (err) {
    return (await matchPrecache('/index.html')) || Response.error();
  }
}, { denylist: [/^\/api\//, /^\/version\.json/, /^\/tool-apps\//] }));

// ── Tools tool-apps (Plan Room, PDF Tools, Video Converter): cache ON DEMAND ─────
// The tool-apps tree is excluded from the shared precache (vite.config globIgnores),
// so nothing here downloads on SW install. These runtime routes fire only when a
// browser actually requests a tool-app file — so its assets (the PDF.js worker,
// pdf-lib, the ~32MB converter engine, etc.) enter the cache ONLY for a user who opens
// that tool. A user who never opens them downloads and stores none of it.
//
// Heavy vendored libs have stable names and effectively never change → cache-first
// (fetch once, reuse forever, offline-capable, no revalidation round-trips). Everything
// else (the tool's html / app.js / css) is network-first so updates still deploy,
// falling back to the cached copy when offline. Registration order matters: the
// lib route is checked before the general one.
const TOOL_APP_LIBS = /\/tool-apps\/.*(pdf\.worker|pdf-lib|pdf\.min|polygon-clipping|ffmpeg-core)/;
registerRoute(
  ({ url }) => TOOL_APP_LIBS.test(url.pathname) || (url.pathname.startsWith('/tool-apps/') && url.pathname.endsWith('.wasm')),
  async ({ request }) => {
    const cache = await caches.open('tool-apps-libs');
    const hit = await cache.match(request);
    if (hit) return hit;
    try {
      const resp = await fetch(request);
      // Caching is best-effort — a put failure (quota, opaque/redirected response) must
      // never break serving the fetched asset.
      if (resp && resp.ok) cache.put(request, resp.clone()).catch(() => {});
      return resp;
    } catch {
      return Response.error(); // offline + not cached — unavoidable
    }
  }
);
registerRoute(
  ({ url }) => url.pathname.startsWith('/tool-apps/'),
  async ({ request }) => {
    const cache = await caches.open('tool-apps-shell');
    try {
      const resp = await fetch(request, { cache: 'no-cache' });
      if (resp && resp.ok) cache.put(request, resp.clone()).catch(() => {}); // best-effort
      return resp;
    } catch {
      return (await cache.match(request)) || Response.error();
    }
  }
);

// Activate a new deploy's worker immediately instead of waiting for a manual update — a
// waiting worker serving the OLD precache across a deploy is what left new tabs / reloads on
// a stale shell. The network-first shell above + the app's chunk-error auto-reload make a
// mid-session asset swap safe; the offline queue in IndexedDB is untouched.
self.addEventListener('install', () => self.skipWaiting());

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

async function updateQueued(item) {
  const db = await openQueueDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, 'readwrite');
    tx.objectStore(QUEUE_STORE).put(item);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
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

// Total + per-user counts. On a shared phone the queue can hold another worker's unsynced items;
// the page shows (and clears) only the signed-in user's, and tells them the others exist.
async function broadcastQueueCount() {
  const items = await getAllQueued();
  const byScope = {};
  for (const it of items) {
    const s = it.scope || authScope(it.auth) || '';
    byScope[s] = (byScope[s] || 0) + 1;
  }
  const clients = await self.clients.matchAll();
  clients.forEach(c => c.postMessage({ type: 'QUEUE_COUNT', count: items.length, byScope }));
}

// ── Offline request handler (clock, time entries, field modules) ───────────────

async function handleOfflineableRequest(event, type) {
  const request = event.request;
  // Idempotency key minted BEFORE the first network attempt, so if the server saves the record
  // but the response is lost (timeout / dropped connection), the queued replay carries the SAME
  // key and the server returns the existing row instead of inserting a duplicate. A key the app
  // already set is kept.
  const idempotencyKey = request.headers.get(IDEMPOTENCY_HEADER) || newIdempotencyKey();
  const bodyText = await request.clone().text().catch(() => '');
  const headers = new Headers(request.headers);
  headers.set(IDEMPOTENCY_HEADER, idempotencyKey);
  try {
    // Timeout: a hung connection never rejects, so without it the request would never fall
    // back to the queue. Scaled to the body size, so a photo report on a slow uplink gets time
    // to actually upload instead of being aborted mid-upload.
    return await fetch(request.url, {
      method: request.method,
      headers,
      body: bodyText === '' ? undefined : bodyText,
      credentials: request.credentials,
      mode: request.mode === 'navigate' ? 'same-origin' : request.mode,
      signal: timeoutSignal(requestTimeoutMs(bodyText.length)),
    });
  } catch {
    const { ok, body } = parseQueueableBody(bodyText);
    // A non-JSON body (multipart / binary) can't be replayed faithfully from the queue — queueing
    // `{}` in its place used to "sync" a blank record. Surface the network error instead.
    if (!ok) return Response.error();
    const auth = request.headers.get('Authorization') || '';
    await enqueue({
      type,
      method: request.method,
      url: request.url,
      body,
      auth,
      scope: authScope(auth),
      idempotency_key: idempotencyKey,
      attempts: 0,
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

// Ask every open page for its current token. A browser may have a normal and an impersonation
// tab open at once, so this is a scope → token map: a queued item only ever replays with a token
// for the same company/user that originally queued it.
async function collectClientAuth() {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  const authByScope = new Map();
  if (clients.length > 0) {
    const candidates = await Promise.all(clients.map(getClientAuth));
    for (const auth of candidates) {
      const scope = authScope(auth);
      if (scope && !authByScope.has(scope)) authByScope.set(scope, auth);
    }
  }
  return { hasClients: clients.length > 0, authByScope };
}

// The queue is replayed from two triggers (a REPLAY_QUEUE message and a Background
// Sync event) and both can fire on one reconnect. Without a lock, two concurrent
// passes read the same items with getAllQueued() and replay each one twice — which,
// for a clock-in, could re-create a shift after it was clocked out. Coalesce concurrent
// replays into a single in-flight pass.
// A manual Retry that arrives while an AUTOMATIC pass is running must not be swallowed (the auto
// pass skips the backing-off / stuck items the user explicitly asked to retry), so it queues ONE
// follow-up manual pass that starts as soon as the current pass finishes.
// Same for a SCOPE the running pass doesn't cover: a pass for user A (shared phone) skips user
// B's items, so B's request queues one follow-up pass for B instead of joining A's and waiting for
// the next automatic tick. A scope-less pass (Background Sync) covers every open page's scope.
let replayInFlight = null;
let inFlightOpts = { manual: false, scope: null };
const replayFollowUps = new Map(); // `${manual}|${scope}` → promise of the follow-up pass
function replayQueue(opts = {}) {
  const manual = !!opts.manual;
  const scope = opts.scope || null;
  if (replayInFlight) {
    const covered = (!manual || inFlightOpts.manual)
      && (inFlightOpts.scope == null || inFlightOpts.scope === scope);
    if (covered) return replayInFlight;
    const key = `${manual ? 'm' : 'a'}|${scope || ''}`;
    if (!replayFollowUps.has(key)) {
      replayFollowUps.set(key, replayInFlight.catch(() => {}).then(() => {
        replayFollowUps.delete(key);
        return replayQueue({ manual, scope });
      }));
    }
    return replayFollowUps.get(key);
  }
  inFlightOpts = { manual, scope };
  replayInFlight = doReplayQueue({ manual, scope }).finally(() => { replayInFlight = null; });
  return replayInFlight;
}

async function errorCode(res) {
  try { return (await res.clone().json())?.code || null; } catch { return null; }
}

// One replay pass. Outcome per item (see offlineQueuePolicy.classifyReplayStatus):
//   done  → dequeue, count as synced
//   drop  → dequeue + report (REPLAY_PARTIAL_FAILURE): a permanent 4xx that can never succeed
//   retry → KEEP, record the attempt + backoff (5xx cold start / deploy, 429, 408, and a timeout
//           on a LARGE body). A network error / timeout on a small body (device still offline)
//           keeps the item without counting it.
//   auth  → KEEP, remember which token was rejected and stay quiet for that user until they log
//           in again (a new token resumes it; OfflineContext re-triggers a replay on sign-in)
// Which items a pass touches: only the signed-in user's (`scope`, sent by the page). On a shared
// phone, worker A's queued items never replay under worker B's session (they used to 401 with
// A's expired token and toast B every minute). A Background Sync pass (no scope) replays the
// scopes of the open pages — or, with no page open, items whose saved token hasn't expired.
// Ordering: clock / time-entry items replay in queue order per user — once one is kept (retry /
// backing off / stuck), that user's later ones wait (a queued clock-out must never land before
// its clock-in). Field creates are independent records (see replayLane) and never block the
// punches. An auth failure pauses the user's whole queue. `manual` (the Retry buttons) ignores
// backoff and retries stuck items; automatic passes skip them.
async function doReplayQueue({ manual = false, scope: requestedScope = null } = {}) {
  const items = (await getAllQueued()).sort((a, b) => a.id - b.id);
  const now = Date.now();
  const passStart = now;
  let replayed = 0;
  let authFailed = false;
  let companyInactive = false;
  let partialFailure = false;
  let retryPending = false;
  let newlyStuck = 0;
  let skippedStuck = 0;

  const { hasClients, authByScope } = await collectClientAuth();
  const blockedScopes = new Set();
  const blockedLanes = new Set();

  const eligible = (scope, item) => {
    if (!scope) return true; // legacy item with no decodable user
    if (requestedScope) return scope === requestedScope;
    if (hasClients) return authByScope.has(scope);
    return !isTokenExpired(item.auth, now);
  };

  for (const item of items) {
    const scope = item.scope || authScope(item.auth);
    const scopeKey = scope || '';
    if (!eligible(scope, item)) continue;
    if (blockedScopes.has(scopeKey)) continue;
    const laneKey = `${scopeKey}|${replayLane(item)}`;
    if (blockedLanes.has(laneKey)) continue;
    if (!manual && isStuck(item, now)) {
      skippedStuck++;
      blockedLanes.add(laneKey);
      continue;
    }
    if (!manual && isBackingOff(item, now)) {
      retryPending = true;
      blockedLanes.add(laneKey);
      continue;
    }
    try {
      const auth = (scope && authByScope.get(scope)) || item.auth;
      if (scope && authScope(auth) !== scope) {
        blockedScopes.add(scopeKey);
        continue;
      }
      // Already rejected with this exact token — wait quietly for a fresh login.
      if (isAuthPaused(item, auth)) {
        blockedScopes.add(scopeKey);
        continue;
      }
      // Items queued by an older worker have no key — mint one and persist it BEFORE sending,
      // so every later retry of this item shares it.
      let current = item;
      if (!current.idempotency_key) {
        current = { ...current, idempotency_key: newIdempotencyKey() };
        await updateQueued(current);
      }
      const bodyText = JSON.stringify(current.body);
      // One pass is one SW event, which the browser kills after ~5 min. Out of budget → leave
      // the rest for the next pass rather than start an upload that can't finish.
      const timeoutMs = replayTimeoutMs(bodyText.length, Date.now() - passStart);
      if (!timeoutMs) {
        retryPending = true;
        break;
      }
      // Large upload: record the attempt (+ backoff) BEFORE sending, so a worker killed
      // mid-upload still counts it. Everything below keeps `current` as the base, so a finished
      // attempt is counted exactly once.
      const started = withAttemptStarted(current, { bodyChars: bodyText.length, now });
      if (started) await updateQueued(started);
      let res;
      try {
        res = await fetch(current.url, {
          method: current.method || 'POST',
          headers: {
            'Content-Type': 'application/json',
            [IDEMPOTENCY_HEADER]: current.idempotency_key,
            ...(auth ? { Authorization: auth } : {}),
          },
          body: bodyText,
          signal: timeoutSignal(timeoutMs),
        });
      } catch (err) {
        // Still offline → keep it, not counted. A TIMEOUT on a large body (slow uplink /
        // oversized report) IS counted, so it backs off and eventually goes stuck instead of
        // re-uploading megabytes every minute forever.
        const countAttempt = countsTowardBackoff({ timedOut: isAbortTimeout(err), bodyChars: bodyText.length });
        const next = withFailedAttempt(current, { now, countAttempt });
        await updateQueued(next);
        if (countAttempt && isStuck(next, now)) newlyStuck++;
        else retryPending = true;
        blockedLanes.add(laneKey);
        continue;
      }
      const outcome = classifyReplayStatus(
        res.status,
        res.status === 409 || res.status === 403 ? await errorCode(res) : null,
      );
      if (outcome === 'done') {
        await dequeue(current.id);
        replayed++;
      } else if (outcome === 'drop') {
        await dequeue(current.id);
        partialFailure = true;
      } else if (outcome === 'auth') {
        // Even the freshest token we have was rejected (401), or the company is deactivated
        // (403 company_inactive — it may be restored). KEEP the request (dropping it lost
        // clock-outs), remember WHICH token failed, and stop this user's pass until they
        // re-authenticate. Reported once: later passes with the same token skip silently.
        await updateQueued({ ...current, auth_failed_sig: tokenSig(auth), last_status: res.status });
        authFailed = true;
        if (res.status === 403) companyInactive = true;
        blockedScopes.add(scopeKey);
      } else {
        const next = withFailedAttempt(current, { status: res.status, now });
        await updateQueued(next);
        if (isStuck(next, now)) newlyStuck++;
        else retryPending = true;
        blockedLanes.add(laneKey);
      }
    } catch {
      // IndexedDB / auth-handshake hiccup — leave the item as it is.
      retryPending = true;
      blockedLanes.add(laneKey);
    }
  }
  await broadcastQueueCount();
  const clients = await self.clients.matchAll();
  if (authFailed) {
    clients.forEach(c => c.postMessage({ type: 'REPLAY_AUTH_FAILED', reason: companyInactive ? 'company_inactive' : 'unauthorized' }));
  }
  if (partialFailure) {
    clients.forEach(c => c.postMessage({ type: 'REPLAY_PARTIAL_FAILURE' }));
  }
  // Stuck (poison-capped) items are KEPT, never deleted. Report when an item hits the cap (or
  // fails again on a manual retry) — automatic passes just skip already-stuck items, so the
  // toast doesn't repeat every minute.
  if (newlyStuck > 0) {
    clients.forEach(c => c.postMessage({ type: 'REPLAY_STUCK', count: newlyStuck }));
  }
  // Always emit QUEUE_REPLAYED so listeners (e.g. ClockInOut) refresh
  // /clock/status, even when nothing succeeded.
  clients.forEach(c => c.postMessage({ type: 'QUEUE_REPLAYED', count: replayed }));
  return { replayed, retryPending, skippedStuck };
}

// ── Service worker lifecycle ───────────────────────────────────────────────────

// Take control of already-open pages as soon as this worker activates, so the offline
// fetch handler (which queues clock / time-entry POSTs when the network is down) works on a
// device's FIRST session and right after an error-recovery hard reset — otherwise the worker
// doesn't control that already-loaded document until the next reload, and an offline punch
// made in that window is lost instead of queued. Paired with skipWaiting on install above,
// a new deploy's worker takes over promptly (the navigations it serves are network-first,
// so it can't pin a stale shell).
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Existing users get their stale precache trimmed automatically: Workbox's precache
    // cleanup drops entries no longer in the manifest (the ~4MB of Plan Room / PDF Tools /
    // converter files we just removed from precache) on this activation. Additionally drop
    // the short-lived runtime caches from the first converter iteration, now superseded by
    // the shared tool-apps-libs / tool-apps-shell caches.
    await Promise.all(['videoconvert-engine', 'videoconvert-shell'].map(n => caches.delete(n).catch(() => {})));
    await self.clients.claim();
  })());
});

// ── Push notifications ─────────────────────────────────────────────────────────

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() ?? {}; } catch { data = { body: event.data?.text?.() || '' }; }
  const isMessage = data.type === 'message' || data.type === 'direct_message';
  // One notification per conversation (dm-<from_user_id> / chat-<worker_id>, set by the server):
  // a new message replaces that thread's previous one and re-alerts (renotify) instead of
  // stacking, and different threads stay separate.
  const tag = typeof data.tag === 'string' && data.tag ? data.tag : (isMessage ? 'chat' : undefined);
  event.waitUntil(
    self.registration.showNotification(data.title || 'OpsFloa', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      // Web push can't set a custom sound file reliably — rely on the OS
      // notification sound plus a vibration pattern for message pushes.
      // tag+renotify groups a thread but still re-alerts on each new message.
      ...(isMessage ? { vibrate: [200, 100, 200] } : {}),
      ...(tag ? { tag, renotify: true } : {}),
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
    // `auto: true` comes from OfflineContext's own triggers (reconnect, login, periodic retry)
    // and honors backoff; anything else (the Retry buttons) is a manual retry.
    // `scope` is the signed-in user's company:user — only their items replay.
    event.waitUntil(replayQueue({ manual: !event.data.auto, scope: event.data.scope || null }));
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
    // Rejecting while retryable items remain asks the browser to re-fire the sync later with
    // its own backoff (e.g. the server was cold-starting / mid-deploy).
    event.waitUntil(replayQueue({ manual: false }).then(result => {
      if (result?.retryPending) throw new Error('offline queue: items pending retry');
    }));
  }
});
