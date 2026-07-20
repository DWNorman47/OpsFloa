/**
 * Non-throwing wrappers around window.sessionStorage / window.localStorage.
 *
 * Reading `window.sessionStorage` (or localStorage) can THROW a SecurityError —
 * not merely return null — in real browser states we don't control: storage
 * disabled, cookies blocked, a partitioned / in-app-webview context, or strict
 * privacy modes. The property getter itself throws, so even a plain
 * `sessionStorage.getItem(...)` blows up.
 *
 * Unguarded reads at bootstrap took the whole app down: the login page caught a
 * SecurityError in the top-level error boundary and showed "Something went
 * wrong" instead of the form (some users then succeeded on a later retry, once
 * the transient storage-blocked state cleared).
 *
 * These wrappers make every access safe: reads return null, writes and removes
 * are best-effort no-ops. The app degrades to "no persisted session" rather than
 * crashing — exactly what a browser that blocks storage should get anyway.
 */

function makeSafe(kind) {
  // Accessing window[kind] can itself throw — hence this is inside try on every
  // call rather than captured once.
  const store = () => {
    try {
      return typeof window !== 'undefined' ? window[kind] : null;
    } catch {
      return null;
    }
  };
  return {
    getItem(key) {
      try {
        const s = store();
        return s ? s.getItem(key) : null;
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      try {
        const s = store();
        if (s) s.setItem(key, value);
      } catch {
        /* storage blocked or over quota — ignore */
      }
    },
    removeItem(key) {
      try {
        const s = store();
        if (s) s.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}

export const safeSession = makeSafe('sessionStorage');
export const safeLocal = makeSafe('localStorage');
