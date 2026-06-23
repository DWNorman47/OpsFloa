// PDF generation lazily imports @react-pdf/renderer (a big chunk kept out of the
// service-worker precache). After a new deploy, an old cached page can try to
// import a chunk hash that no longer exists -> the dynamic import rejects. The
// PDF handlers had no .catch, so that surfaced as a dead button ("nothing
// happens"). This turns the failure into a one-time recovery reload (fresh
// assets) for that case, or a reported + user-visible error otherwise.

import { reportClientError } from './errorReporter';

export function isChunkLoadError(err) {
  const m = String(err?.message || err || '');
  return /dynamically imported module|Loading chunk|module script failed|Failed to fetch/i.test(m);
}

export function handlePdfError(err, message) {
  reportClientError({
    kind: 'unhandled',
    message: `PDF generation failed: ${err?.message || err}`,
    stack: err?.stack || null,
  });
  // Stale-deploy chunk miss: reload once (guarded so it can't loop) to pull the
  // current assets, after which the import succeeds.
  if (isChunkLoadError(err)) {
    let reloadedAlready = false;
    try {
      reloadedAlready = sessionStorage.getItem('ops-pdf-reloaded') === '1';
      if (!reloadedAlready) sessionStorage.setItem('ops-pdf-reloaded', '1');
    } catch { /* sessionStorage unavailable — fall through to the alert */ }
    if (!reloadedAlready) { window.location.reload(); return; }
  }
  alert(message || 'Could not generate the PDF. Please reload the page and try again.');
}
