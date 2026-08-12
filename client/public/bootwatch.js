/*
 * Boot watchdog — recovers the blank-screen path the in-app recovery can't reach.
 *
 * All of the app's error handling (ErrorBoundary, chunk-load auto-reload, global handlers)
 * ships INSIDE the main entry bundle. If that bundle fails to load or execute — the classic
 * case is a stale cached index.html (or a controlling service worker's precache) pointing
 * at /assets chunk hashes the server has already purged after a deploy — React never mounts,
 * none of that recovery installs, and index.html has already hidden its static fallback the
 * instant JS ran. The result is a blank white screen that "does nothing".
 *
 * This is a plain (non-module) external script, so it runs even when the module bundle 404s
 * or throws. React clears #root on mount, removing the #prehydrate fallback node, so that
 * node still being present after a grace period means the app never booted. When that
 * happens we do what a MANUAL HARD REFRESH does — clear Cache Storage and unregister the
 * service worker, then reload — because a plain reload just re-serves the same stale cache.
 * If even that doesn't help (a genuinely broken deploy), we reveal the static landing page
 * (with a Log in link) instead of leaving a white screen.
 *
 * CSP: loaded from 'self' (see client/vercel.json script-src) — no inline hash to maintain.
 * Not precached (see vite.config.js globIgnores) so the newest logic is always fetched.
 */
(function () {
  // How long to let boot run before assuming it's a stuck blank screen. The boot
  // splash (see index.html) shows a spinner during this window, so a shorter wait
  // still looks intentional. Kept comfortably above a slow-network bundle download
  // so we don't hard-reset a boot that would have succeeded on its own.
  var GRACE_MS = 8000;
  var COOLDOWN_MS = 60000;
  var KEY = 'opsfloa_boot_reset_at';

  function booted() {
    // React removes the #prehydrate fallback from #root when it mounts.
    return !document.getElementById('prehydrate');
  }

  // Do what a MANUAL HARD REFRESH does: drop the SW's caches, unregister the service worker,
  // AND force a fresh copy of the shell past the HTTP disk cache — then reload. A plain
  // location.reload() honors a stale-but-cacheable index.html (an entry cached before the
  // must-revalidate header existed) and re-serves the same broken shell, which is why only a
  // manual hard refresh fixed it. IndexedDB (the offline queue) is left intact.
  function hardResetAndReload() {
    var jobs = [];
    try {
      if (window.caches && caches.keys) {
        jobs.push(caches.keys().then(function (keys) {
          return Promise.all(keys.map(function (k) { return caches.delete(k); }));
        }));
      }
    } catch (e) { /* ignore */ }
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
        jobs.push(navigator.serviceWorker.getRegistrations().then(function (regs) {
          return Promise.all(regs.map(function (r) { return r.unregister(); }));
        }));
      }
    } catch (e) { /* ignore */ }
    // cache:'reload' fetches from the network ignoring the HTTP cache AND overwrites the
    // cached entry — so the following location.reload() serves the FRESH shell.
    try { jobs.push(fetch(window.location.href, { cache: 'reload' }).catch(function () {})); } catch (e) { /* ignore */ }

    var reloaded = false;
    var go = function () { if (reloaded) return; reloaded = true; window.location.reload(); };
    Promise.all(jobs).then(go, go);
    // Don't hang forever if the cache / SW / fetch APIs stall.
    window.setTimeout(go, 4000);
  }

  window.setTimeout(function () {
    if (booted()) return;

    var last = 0;
    try { last = parseInt(window.sessionStorage.getItem(KEY), 10) || 0; } catch (e) { /* private mode */ }
    var now = Date.now();

    if (now - last > COOLDOWN_MS) {
      // First failure: hard-reset (like a manual hard refresh) and retry.
      try { window.sessionStorage.setItem(KEY, String(now)); } catch (e) { /* ignore */ }
      hardResetAndReload();
    } else {
      // Already hard-reset recently and it's still blank — stop, and show the fallback.
      document.documentElement.classList.remove('js');
    }
  }, GRACE_MS);
})();
