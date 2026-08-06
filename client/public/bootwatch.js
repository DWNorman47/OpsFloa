/*
 * Boot watchdog — recovers the ONE blank-screen path the in-app recovery can't reach.
 *
 * All of the app's error handling (ErrorBoundary, chunk-load auto-reload, global handlers)
 * ships INSIDE the main entry bundle. If that bundle itself fails to load or execute — the
 * classic case is a stale HTTP-cached index.html after a deploy that points at /assets
 * chunk hashes the server has already purged — React never mounts, none of that recovery
 * code installs, and index.html has already hidden its static fallback the instant JS ran.
 * The result is a genuinely blank white screen that "does nothing".
 *
 * This is a plain (non-module) external script, so it runs even when the module bundle
 * 404s or throws. React clears #root on mount, removing the #prehydrate fallback node, so
 * that node still being present after a grace period means the app never booted. When that
 * happens we reload ONCE (to fetch a fresh shell); if a reload already ran and it's still
 * blank, we reveal the static landing page (with a Log in link) instead of a white screen.
 *
 * CSP: loaded from 'self' (see client/vercel.json script-src) — no inline hash to maintain.
 */
(function () {
  var GRACE_MS = 12000;
  var COOLDOWN_MS = 60000;
  var KEY = 'opsfloa_boot_reload_at';

  function booted() {
    // React removes the #prehydrate fallback from #root when it mounts.
    return !document.getElementById('prehydrate');
  }

  window.setTimeout(function () {
    if (booted()) return;

    var last = 0;
    try { last = parseInt(window.sessionStorage.getItem(KEY), 10) || 0; } catch (e) { /* private mode */ }
    var now = Date.now();

    if (now - last > COOLDOWN_MS) {
      // First failure: grab a fresh index.html (must-revalidate, see vercel.json) and retry.
      try { window.sessionStorage.setItem(KEY, String(now)); } catch (e) { /* ignore */ }
      window.location.reload();
    } else {
      // A reload already happened and it's still blank — stop, and show the fallback
      // content so the user can at least log in instead of staring at white.
      document.documentElement.classList.remove('js');
    }
  }, GRACE_MS);
})();
