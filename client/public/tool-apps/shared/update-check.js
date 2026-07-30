/* "New version available" prompt for the installed-PWA tool windows.
 *
 * The tool-apps are static pages precached by the root service worker, so an open
 * window keeps running the build it loaded until a reload — unlike the main React
 * app, which polls version.json and shows UpdatePrompt. A tool window had no such
 * signal, so after a deploy it silently stayed on the old version (the takeoff
 * "why didn't my fix show up" case).
 *
 * Because the tool is served FROM the precache, a waiting service worker is the
 * accurate signal that a new tool build is ready. We nudge the browser to check
 * while the window sits open, then let the user activate and reload deliberately.
 * Self-contained, no dependencies. */
(function () {
  if (!('serviceWorker' in navigator)) return;

  var shown = false;
  var registration = null;

  function activateAndReload() {
    var waiting = registration && registration.waiting;
    if (!waiting) {
      try { location.reload(); } catch (e) { /* ignore */ }
      return;
    }
    var done = false;
    var finish = function () {
      if (done) return;
      done = true;
      try { location.reload(); } catch (e) { /* ignore */ }
    };
    waiting.addEventListener('statechange', function () {
      if (waiting.state === 'activated') finish();
    });
    waiting.postMessage({ type: 'SKIP_WAITING' });
    setTimeout(finish, 2000);
  }

  function showBanner() {
    if (shown || !document.body) return;
    shown = true;

    var bar = document.createElement('div');
    bar.setAttribute('role', 'status');
    bar.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);' +
      'z-index:2147483000;display:flex;align-items:center;gap:10px;background:#1f2937;color:#fff;' +
      'padding:10px 14px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.28);' +
      'font:500 14px/1.3 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:calc(100vw - 32px)';

    var dot = document.createElement('span');
    dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#22c55e;flex:0 0 auto';

    var msg = document.createElement('span');
    msg.textContent = 'A new version is available.';

    var reload = document.createElement('button');
    reload.type = 'button';
    reload.textContent = 'Reload';
    reload.style.cssText = 'background:#2563eb;color:#fff;border:none;padding:6px 14px;border-radius:7px;' +
      'font:700 13px system-ui,sans-serif;cursor:pointer';
    reload.addEventListener('click', activateAndReload);

    var dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.textContent = '✕';
    dismiss.style.cssText = 'background:transparent;color:#9ca3af;border:none;font-size:16px;cursor:pointer;padding:2px 6px';
    dismiss.addEventListener('click', function () { bar.remove(); });

    bar.appendChild(dot); bar.appendChild(msg); bar.appendChild(reload); bar.appendChild(dismiss);
    document.body.appendChild(bar);
  }

  // Actively check for a new deploy while the window is open: on load, on an
  // interval, and whenever the tab/window regains focus.
  navigator.serviceWorker.getRegistration().then(function (reg) {
    if (!reg) return;
    registration = reg;
    if (reg.waiting) showBanner();
    reg.addEventListener('updatefound', function () {
      var installing = reg.installing;
      if (!installing) return;
      installing.addEventListener('statechange', function () {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) showBanner();
      });
    });
    var check = function () { try { reg.update(); } catch (e) { /* ignore */ } };
    setInterval(check, 10 * 60 * 1000); // every 10 min
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') check();
    });
    check();
  }).catch(function () { /* no registration / storage blocked — nothing to do */ });
})();
