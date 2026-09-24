// Signed-out guard for the static tool-apps (Plan Room, PDF Tools). Loaded as a
// blocking <script src> in <head> — an inline copy is blocked by the enforced CSP
// (script-src has no hash for it), which silently skipped the redirect.
(() => {
  try {
    if (!localStorage.getItem('tc_token') && !sessionStorage.getItem('tc_token')) {
      window.location.replace('/login');
    }
  } catch (_) {
    window.location.replace('/login');
  }
})();
