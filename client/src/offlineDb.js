import { openDB } from 'idb';
import { ttlFor } from './cacheRegistry';
import { safeSession, safeLocal } from './utils/safeStorage';

const DB_NAME = 'opsfloa-cache';
const DB_VERSION = 2;
const STORE = 'api-cache';
const SYNC_STORE = 'pending-syncs';

let _db;

function readStoredUser(store) {
  try {
    const raw = store.getItem('tc_user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function currentOfflineScope() {
  const sessionUser = safeSession.getItem('tc_token') ? readStoredUser(safeSession) : null;
  const user = sessionUser || readStoredUser(safeLocal);
  if (!user?.id || !user?.company_id) return 'anonymous';
  return `${user.company_id}:${user.id}`;
}

function scopedCacheKey(key) {
  return `${currentOfflineScope()}::${key}`;
}

async function getDb() {
  if (!_db) {
    _db = await openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
        if (!db.objectStoreNames.contains(SYNC_STORE)) {
          db.createObjectStore(SYNC_STORE, { keyPath: 'id', autoIncrement: true });
        }
      },
    });
  }
  return _db;
}

// Pending sync queue — for offline submissions
export async function enqueuePendingSync(item) {
  try {
    const db = await getDb();
    await db.add(SYNC_STORE, { ...item, scope: currentOfflineScope(), queued_at: Date.now() });
  } catch { /* ignore */ }
}

export async function getPendingSyncs() {
  try {
    const db = await getDb();
    const scope = currentOfflineScope();
    return (await db.getAll(SYNC_STORE)).filter(item => item.scope === scope);
  } catch { return []; }
}

export async function removePendingSync(id) {
  try {
    const db = await getDb();
    const item = await db.get(SYNC_STORE, id);
    if (!item || item.scope !== currentOfflineScope()) return;
    await db.delete(SYNC_STORE, id);
  } catch { /* ignore */ }
}

export async function clearPendingSyncs() {
  const scope = currentOfflineScope();
  try {
    const db = await getDb();
    const records = await db.getAll(SYNC_STORE);
    await Promise.all(records
      .filter(item => item.scope === scope)
      .map(item => db.delete(SYNC_STORE, item.id)));
  } catch { /* ignore */ }
}

export async function getCached(key) {
  try {
    const db = await getDb();
    return await db.get(STORE, scopedCacheKey(key));
  } catch {
    return null;
  }
}

export async function setCached(key, data) {
  try {
    const db = await getDb();
    await db.put(STORE, { data, ts: Date.now() }, scopedCacheKey(key));
  } catch {
    // ignore write failures
  }
}

export function isFresh(record, key) {
  if (!record) return false;
  return Date.now() - record.ts < ttlFor(key);
}

export async function clearCache() {
  const prefix = `${currentOfflineScope()}::`;
  try {
    const db = await getDb();
    const keys = await db.getAllKeys(STORE);
    await Promise.all(keys
      .filter(key => String(key).startsWith(prefix))
      .map(key => db.delete(STORE, key)));
  } catch {
    // ignore
  }
}

export async function invalidateCache(key) {
  try {
    const db = await getDb();
    await db.delete(STORE, scopedCacheKey(key));
  } catch {
    // ignore
  }
}

export async function getOrFetch(key, fetchFn) {
  const cached = await getCached(key);
  if (isFresh(cached, key)) return cached.data;
  try {
    const data = await fetchFn();
    await setCached(key, data);
    return data;
  } catch (err) {
    if (cached) return cached.data;
    if (err?.response) throw err;
    throw new Error('Offline and no cached data');
  }
}
