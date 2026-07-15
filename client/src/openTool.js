// Opening a tool-app tab (Plan Room, etc.). Tools open with rel="noopener", so
// the new tab can't reach this tab's sessionStorage. During superadmin login-as
// the ACTIVE token lives in sessionStorage (the impersonation token) while
// localStorage still holds the admin's own token — so without help the tool would
// authenticate as the wrong company. Hand the active token to the tool tab via a
// one-time localStorage entry keyed by a URL nonce (the token never goes in the
// URL). Normal logins need nothing: their token is in localStorage, which the
// tool reads directly.

export function isImpersonating() {
  try { return !!sessionStorage.getItem('tc_token'); } catch { return false; }
}

export function openToolTab(url) {
  let imp = null;
  try { imp = sessionStorage.getItem('tc_token'); } catch { /* storage blocked */ }
  if (!imp) { window.open(url, '_blank', 'noopener,noreferrer'); return; }
  try {
    // purge stale/expired handoffs so abandoned ones don't accumulate
    for (const k of Object.keys(localStorage)) {
      if (!k.startsWith('tc_handoff_')) continue;
      let exp = 0;
      try { exp = (JSON.parse(localStorage.getItem(k)) || {}).exp || 0; } catch { /* bad json */ }
      if (!exp || Date.now() > exp) localStorage.removeItem(k);
    }
  } catch { /* storage blocked */ }
  const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  try { localStorage.setItem(`tc_handoff_${nonce}`, JSON.stringify({ t: imp, exp: Date.now() + 60000 })); } catch { /* storage blocked */ }
  window.open(`${url}${url.includes('#') ? '&' : '#'}h=${nonce}`, '_blank', 'noopener,noreferrer');
}
