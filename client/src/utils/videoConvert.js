// Hand a video blob to the standalone offline converter tool-app — a separate,
// cross-origin-isolated tab that runs multithreaded ffmpeg.wasm entirely on-device
// (see public/tool-apps/videoconvert/). The blob goes through IndexedDB (same-origin,
// shared with that tab) rather than the URL, so a large video never rides in a query
// string. The converter tab polls for the key on load, so opening the tab first (to
// keep the click gesture, avoiding popup blockers) and writing the blob right after
// is safe.

function putHandoff(key, value) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('opsfloa-convert', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('handoff')) db.createObjectStore('handoff');
    };
    req.onsuccess = e => {
      const db = e.target.result;
      const tx = db.transaction('handoff', 'readwrite');
      tx.objectStore('handoff').put(value, key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
    req.onerror = () => reject(req.error);
  });
}

// Opens the converter in a new tab with the given video preloaded.
// `lang` is the user's language string ('English' | 'Spanish').
export function openVideoConverter({ blob, filename, lang }) {
  const key = `v-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const q = new URLSearchParams({ k: key });
  if (lang === 'Spanish') q.set('lang', 'Spanish');
  // Open synchronously (inside the click handler) so the popup isn't blocked.
  const win = window.open(`/tool-apps/videoconvert/index.html?${q.toString()}`, '_blank');
  // Store the blob right after; the converter tab polls for this key for a few seconds.
  putHandoff(key, { blob, filename: filename || 'video' }).catch(() => {});
  return win;
}
