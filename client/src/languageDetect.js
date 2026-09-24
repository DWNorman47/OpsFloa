// Resolve which app language to render when there is (or isn't) a stored
// preference. The app supports English + Spanish; getT() keys on those exact
// strings.
//
// Resolution order:
//   1. An explicit stored preference ('English' | 'Spanish') — a logged-in
//      user's setting, or a client's language on the public document pages.
//   2. The browser's preferred language (navigator.languages / navigator.language).
//      es* → Spanish; everything else → English. This is the right signal for
//      anonymous visitors — it reflects what they actually prefer, unlike
//      country/IP geolocation (country ≠ language, and it needs a third-party
//      lookup with added latency and privacy cost).
//   3. Default English.

export function detectLanguage(stored) {
  if (stored === 'English' || stored === 'Spanish') return stored;
  if (typeof navigator === 'undefined') return 'English';
  const nav = (navigator.languages?.[0] || navigator.language || '').toLowerCase();
  return nav.startsWith('es') ? 'Spanish' : 'English';
}

// The language to load before the first render: the logged-in user's cached
// language (read the same way AuthContext seeds its user — the impersonation
// tab's sessionStorage first, else localStorage), otherwise the browser's.
export function bootLanguage() {
  try {
    const store = sessionStorage.getItem('tc_token') ? sessionStorage : localStorage;
    if (store.getItem('tc_token')) {
      return detectLanguage(JSON.parse(store.getItem('tc_user') || 'null')?.language);
    }
  } catch { /* storage blocked or bad JSON — fall through */ }
  return detectLanguage();
}
