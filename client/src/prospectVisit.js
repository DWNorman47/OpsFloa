import { safeSession } from './utils/safeStorage';

const ID_KEY = 'ops_public_visit';
const EXCLUDED_KEY = 'ops_public_visit_excluded';
const baseURL = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';
let pendingVisit;

function visitId(create = false) {
  if (safeSession.getItem(EXCLUDED_KEY)) return null;
  let id = safeSession.getItem(ID_KEY);
  if (!id && create && crypto.randomUUID) {
    id = crypto.randomUUID();
    safeSession.setItem(ID_KEY, id);
    if (safeSession.getItem(ID_KEY) !== id) return null;
  }
  return id;
}

function send(path, payload) {
  return fetch(`${baseURL}/public-visits${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function recordWelcomeVisit() {
  const id = visitId(true);
  if (!id || pendingVisit) return;
  const params = new URLSearchParams(window.location.search);
  let referrer = null;
  try { if (document.referrer) referrer = new URL(document.referrer).origin; } catch { /* no source */ }
  const ua = navigator.userAgent;
  const device = /tablet|ipad/i.test(ua) ? 'tablet' : /mobile|iphone|android/i.test(ua) ? 'mobile' : 'desktop';
  pendingVisit = send('', {
    session_id: id, action: 'visit', landing_path: window.location.pathname,
    referrer, device,
    utm_source: params.get('utm_source'), utm_medium: params.get('utm_medium'),
    utm_campaign: params.get('utm_campaign'),
  }).catch(() => null);
}

export async function recordWelcomeAction(action) {
  const id = visitId();
  if (!id || !['pricing', 'register'].includes(action)) return;
  await pendingVisit;
  if (visitId() === id) send('', { session_id: id, action }).catch(() => {});
}

export async function excludeProspectVisit() {
  const id = safeSession.getItem(ID_KEY);
  safeSession.setItem(EXCLUDED_KEY, '1');
  if (!id) return;
  await pendingVisit;
  try {
    const response = await send('/exclude', { session_id: id });
    if (response.ok) safeSession.removeItem(ID_KEY);
  } catch { /* keep the id so a later authenticated load can retry */ }
}

// The sign-up form was submitted from this visit: flag it registered (kept for
// conversion stats) instead of deleting it, then stop tracking this tab — the
// exclusion that runs once the new user is logged in then has nothing to delete.
export async function markProspectRegistered() {
  const id = safeSession.getItem(ID_KEY);
  safeSession.setItem(EXCLUDED_KEY, '1');
  if (!id) return;
  await pendingVisit;
  try {
    const response = await send('', { session_id: id, action: 'registered' });
    if (response.ok) safeSession.removeItem(ID_KEY);
  } catch { /* best effort */ }
}
