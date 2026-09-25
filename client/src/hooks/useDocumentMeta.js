import { useEffect } from 'react';

// Canonical URLs always name the production site (dev/stage copies point there too,
// like the static tag in index.html did).
export const CANONICAL_ORIGIN = 'https://opsfloa.com';
// Routes that are the same page as another one (/welcome renders the home landing).
const CANONICAL_ALIASES = { '/welcome': '/' };

/** The canonical URL for a route path: prod origin + path, no query/hash/trailing slash. */
export function canonicalFor(pathname) {
  let path = String(pathname || '/').split(/[?#]/)[0] || '/';
  if (path.length > 1) path = path.replace(/\/+$/, '') || '/';
  path = CANONICAL_ALIASES[path] || path;
  return CANONICAL_ORIGIN + path;
}

/**
 * Set the document title + optional meta description + robots for the current
 * route. Restores whatever was there before on unmount so an SPA route change
 * leaves the HEAD clean.
 *
 * Used on public routes so search snippets and browser tabs show something
 * more specific than the index.html default. Authenticated routes pass
 * robots='noindex' to keep them out of search results if a logged-in user
 * somehow gets crawled (shouldn't happen, but belt-and-suspenders).
 *
 * Canonical: every page using this hook declares ITSELF canonical (index.html's
 * static tag names the home page, which on /privacy, /eula, a public company
 * profile, … told search engines "this is a duplicate of the home page").
 * Pass `canonical` (a full URL or a path) to override; `canonical: false` leaves
 * the tag alone.
 */
export function useDocumentMeta({ title, description, robots, canonical } = {}) {
  useEffect(() => {
    const prevTitle = document.title;

    if (title) document.title = title;

    const descEl = description ? upsertMeta('name', 'description', description) : null;
    const robotsEl = robots ? upsertMeta('name', 'robots', robots) : null;

    let restoreCanonical = null;
    if (canonical !== false) {
      const href = typeof canonical === 'string' && /^https?:\/\//.test(canonical)
        ? canonical
        : canonicalFor(typeof canonical === 'string' ? canonical : window.location.pathname);
      restoreCanonical = setCanonical(href);
    }

    return () => {
      document.title = prevTitle;
      // Only remove what we added; leave pre-existing tags alone
      if (descEl?.dataset.tcManaged) descEl.remove();
      if (robotsEl?.dataset.tcManaged) robotsEl.remove();
      if (restoreCanonical) restoreCanonical();
    };
  }, [title, description, robots, canonical]);
}

function upsertMeta(attr, name, content) {
  let el = document.head.querySelector(`meta[${attr}="${name}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, name);
    el.dataset.tcManaged = 'true'; // so cleanup only removes our own inserts
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
  return el;
}

// Point <link rel="canonical"> at href; returns a function that puts back what was there.
function setCanonical(href) {
  let el = document.head.querySelector('link[rel="canonical"]');
  const created = !el;
  if (!el) {
    el = document.createElement('link');
    el.setAttribute('rel', 'canonical');
    document.head.appendChild(el);
  }
  const prev = el.getAttribute('href');
  el.setAttribute('href', href);
  return () => {
    if (created) el.remove();
    else if (prev != null) el.setAttribute('href', prev);
  };
}
