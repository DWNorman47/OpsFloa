/**
 * engine-store.js — IndexedDB project/file storage for the plan tools.
 *
 * Part of the shared plan-tools engine (see docs/plans/plan-viewer-markup.md).
 * COPY-derived from sitework/app.js — the sitework tool still runs its own
 * monolith ('ebc' DB) and is NOT wired to this module; see shared/PARITY.md.
 *
 * Each tool gets its OWN database via createStore(dbName), with two object
 * stores: 'files' (document bytes keyed by content hash, shared between
 * projects) and 'projects' (one record per project, keyed by record .id).
 */

// Local-first storage bound to one IndexedDB database.
export function createStore(dbName, version = 1) {
  function idb(store, mode, op) {
    return new Promise((resolve, reject) => {
      const rq = indexedDB.open(dbName, version);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects');
      };
      rq.onerror = () => reject(rq.error);
      rq.onsuccess = () => {
        const db = rq.result;
        const tx = db.transaction(store, mode);
        const res = op(tx.objectStore(store));
        tx.oncomplete = () => { db.close(); resolve(res && res.result); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  }
  return {
    filesGet: key => idb('files', 'readonly', s => s.get(key)),
    filesPut: (key, val) => idb('files', 'readwrite', s => s.put(val, key)),
    filesDelete: key => idb('files', 'readwrite', s => s.delete(key)),
    projGet: id => idb('projects', 'readonly', s => s.get(id)),
    projPut: rec => idb('projects', 'readwrite', s => s.put(rec, rec.id)),
    projDelete: id => idb('projects', 'readwrite', s => s.delete(id)),
    projAll: () => idb('projects', 'readonly', s => s.getAll()),
  };
}

// Collision-resistant id for projects/objects.
export const randId = () => (crypto.randomUUID ? crypto.randomUUID()
  : Date.now().toString(36) + Math.random().toString(36).slice(2));

// Content hash for document bytes — dedups the same file across projects.
export async function hashBytes(buf) {
  try {
    const h = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(h)].slice(0, 16)
      .map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (_) {
    return 'f' + buf.byteLength + '-' + Date.now().toString(36); // no dedup, still works
  }
}
